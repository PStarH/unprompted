import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';

export function classifyFailure(error) {
  if (error?.ambiguous || error?.writeOutcomeUnknown || /OUTCOME_UNKNOWN|LEASE_LOST/.test(error?.code || '')) return 'ambiguous';
  const status = Number(error?.status);
  if (status === 429 || /RATE_LIMIT/.test(error?.code || '')) return 'rate_limit';
  if (/^SQLITE_(BUSY|LOCKED)/.test(error?.code || '') || ['AbortError', 'TimeoutError'].includes(error?.name) || /ETIMEDOUT|ECONN|EAI_AGAIN/.test(error?.code || '') || [408, 425].includes(status) || status >= 500) return 'retryable';
  return 'permanent';
}
const project = row => row && ({ ...row, payload: parse(row.payload_json) });

export class DurableJobs {
  constructor(database, { leaseMs = 30000, random = Math.random } = {}) { this.database = database; this.db = database.db; this.leaseMs = leaseMs; this.random = random; }
  enqueue({ id = randomUUID(), queue = 'tasks', type, payload = {}, key, taskId = null, priority = 0, maxAttempts = 8, availableAt = iso(this.database.now()) }) {
    if (!type || !key || maxAttempts < 1 || maxAttempts > 100 || json(payload).length > 256000) throw durableError('INVALID_JOB', 'Invalid durable job.', 400);
    return this.database.atomic(() => {
      const at = iso(this.database.now());
      this.db.prepare(`INSERT OR IGNORE INTO jobs(id,queue_name,job_type,payload_json,idempotency_key,task_id,state,priority,max_attempts,available_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)`).run(id, queue, type, json(payload), key, taskId, priority, maxAttempts, availableAt, at, at);
      return project(this.db.prepare('SELECT * FROM jobs WHERE queue_name=? AND idempotency_key=?').get(queue, key));
    });
  }
  get(id) { return project(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }
  list({ taskId = null, limit = 100 } = {}) { return this.db.prepare('SELECT * FROM jobs WHERE (? IS NULL OR task_id=?) ORDER BY created_at DESC LIMIT ?').all(taskId, taskId, Math.min(200, Math.max(1, limit))).map(project); }
  claim(worker, { queue = 'tasks', id = null, now = this.database.now() } = {}) {
    if (!worker) throw durableError('INVALID_WORKER', 'Worker identity is required.', 400);
    return this.database.atomic(() => {
      const at = iso(now);
      const row = this.db.prepare(`SELECT * FROM jobs WHERE queue_name=? AND state IN ('queued','retry_wait') AND available_at<=?
        AND attempts<max_attempts AND (? IS NULL OR id=?) ORDER BY priority DESC,available_at,id LIMIT 1`).get(queue, at, id, id);
      if (!row) return null;
      this.db.prepare(`UPDATE jobs SET state='running', attempts=attempts+1,lease_token=lease_token+1,lease_owner=?,lease_until=?,heartbeat_at=?,updated_at=?
        WHERE id=? AND lease_token=? AND state IN ('queued','retry_wait')`).run(worker, iso(Number(now) + this.leaseMs), at, at, row.id, row.lease_token);
      return this.get(row.id);
    });
  }
  owns(job, now = this.database.now()) {
    return Boolean(this.db.prepare(`SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_token=? AND lease_until>?`).get(job.id, job.lease_owner, job.lease_token, iso(now)));
  }
  assert(job) { if (!this.owns(job)) throw durableError('LEASE_LOST', 'The worker no longer owns this job.'); }
  heartbeat(job, now = this.database.now()) {
    return this.database.atomic(() => this.db.prepare(`UPDATE jobs SET lease_until=?,heartbeat_at=?,updated_at=? WHERE id=? AND state='running'
      AND lease_owner=? AND lease_token=? AND lease_until>?`).run(iso(Number(now) + this.leaseMs), iso(now), iso(now), job.id, job.lease_owner, job.lease_token, iso(now)).changes === 1);
  }
  complete(job) {
    return this.database.atomic(() => { this.assert(job); this.db.prepare(`UPDATE jobs SET state='completed',lease_until=NULL,updated_at=?
      WHERE id=? AND state='running' AND lease_owner=? AND lease_token=?`).run(iso(this.database.now()), job.id, job.lease_owner, job.lease_token);
      this.db.prepare("UPDATE task_runs SET status='waiting',updated_at=? WHERE job_id=? AND job_lease_token=? AND status='running'").run(iso(this.database.now()), job.id, job.lease_token);
      return this.get(job.id); });
  }
  fail(job, error) {
    return this.database.atomic(() => {
      this.assert(job);
      const kind = classifyFailure(error), exhausted = job.attempts >= job.max_attempts;
      const state = kind === 'ambiguous' ? 'recovery_required' : kind === 'permanent' || exhausted ? 'dead' : 'retry_wait';
      const delay = Math.max(Math.min(300000, 1000 * 2 ** Math.min(12, job.attempts - 1)) * (0.5 + this.random()), Number(error.retryAfterMs) || 0);
      this.db.prepare(`UPDATE jobs SET state=?,last_error_class=?,dead_letter_reason=?,available_at=?,lease_until=NULL,updated_at=?
        WHERE id=? AND state='running' AND lease_owner=? AND lease_token=?`).run(state, kind, exhausted ? 'attempts_exhausted' : kind === 'permanent' ? 'permanent_failure' : null, iso(this.database.now() + delay), iso(this.database.now()), job.id, job.lease_owner, job.lease_token);
      this.db.prepare("UPDATE task_runs SET status=?,updated_at=? WHERE job_id=? AND job_lease_token=? AND status='running'").run(state === 'recovery_required' ? 'recovery_required' : 'failed', iso(this.database.now()), job.id, job.lease_token);
      const changedInputs = this.db.prepare(`SELECT DISTINCT t.id,t.input_version,t.data_json FROM tasks t JOIN task_runs r ON r.task_id=t.id
        WHERE r.job_id=? AND r.job_lease_token=? AND t.dirty=1 AND t.input_version>r.input_version AND t.status NOT IN ('cancelled','completed')`).all(job.id, job.lease_token);
      for (const task of changedInputs) if (!parse(task.data_json).control?.paused) this.enqueue({ type: 'task_continue', taskId: task.id, key: `continue:${task.id}:${task.input_version}`, payload: { taskId: task.id, inputVersion: task.input_version } });
      return this.get(job.id);
    });
  }
  expire(now = this.database.now()) {
    return this.database.atomic(() => {
      const rows = this.db.prepare("SELECT * FROM jobs WHERE state='running' AND lease_until<=?").all(iso(now));
      for (const row of rows) {
        this.db.prepare("UPDATE jobs SET state='recovery_required',last_error_class='lease_expired',updated_at=? WHERE id=? AND state='running' AND lease_token=?").run(iso(now), row.id, row.lease_token);
        this.db.prepare("UPDATE task_runs SET status='recovery_required',updated_at=? WHERE job_id=? AND status='running'").run(iso(now), row.id);
      }
      return rows.map(project);
    });
  }
  recover(id, inspect) {
    // The inspector is synchronous, read-only and runs under the same short
    // transaction. Recovery cannot race a new dispatch or an unfenced result.
    return this.database.atomic(() => {
      const job = this.get(id);
      if (job?.state !== 'recovery_required') throw durableError('INVALID_RECOVERY', 'Only an inspected expired or ambiguous job can recover.');
      const unresolved = this.db.prepare("SELECT id FROM tool_executions WHERE (job_id=? OR task_run_id IN (SELECT id FROM task_runs WHERE job_id=?)) AND is_write=1 AND status IN ('intent','dispatched','accepted','unknown')").all(id, id);
      const decision = inspect({ job, unresolved });
      if (decision?.then) throw new TypeError('Recovery inspection must not await external operations. Reconcile first.');
      if (unresolved.length && decision?.state !== 'cancelled') return { ...job, reconciliationRequired: true };
      if (!['queued', 'completed', 'cancelled', 'dead'].includes(decision?.state)) throw durableError('INVALID_RECOVERY', 'Recovery must explicitly confirm a safe next state.');
      if (decision.state === 'queued' && !decision.safeToRepeat) throw durableError('INVALID_RECOVERY', 'Recovery has not confirmed safe re-execution.');
      const nextState = decision.state === 'queued' && job.attempts >= job.max_attempts ? 'dead' : decision.state;
      if (nextState === 'dead' && decision.state === 'queued') this.db.prepare("UPDATE jobs SET dead_letter_reason='attempts_exhausted' WHERE id=? AND lease_token=?").run(id, job.lease_token);
      this.db.prepare('UPDATE jobs SET state=?,lease_owner=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=? AND state=\'recovery_required\' AND lease_token=?').run(nextState, iso(this.database.now()), iso(this.database.now()), id, job.lease_token);
      return this.get(id);
    });
  }
  deferRecovery(id, leaseToken, delayMs = 30000) { return this.database.atomic(() => this.db.prepare("UPDATE jobs SET available_at=?,updated_at=? WHERE id=? AND state='recovery_required' AND lease_token=?").run(iso(this.database.now() + Math.max(1000, delayMs)), iso(this.database.now()), id, leaseToken).changes); }
  cancelTask(taskId) { return this.db.prepare("UPDATE jobs SET state='cancelled',payload_json='{}',lease_until=NULL,updated_at=? WHERE task_id=? AND state NOT IN ('completed','dead','cancelled')").run(iso(this.database.now()), taskId).changes; }
}

export class DurableWorker {
  constructor({ jobs, handlers = {}, recovery = null, id = randomUUID(), queue = 'tasks' }) { this.jobs = jobs; this.handlers = handlers; this.recovery = recovery; this.id = id; this.queue = queue; this.stopping = false; this.running = null; }
  async tick() {
    if (this.stopping || this.running) return false;
    const pending = Promise.resolve().then(() => this.performTick()); this.running = pending;
    try { return await pending; } finally { if (this.running === pending) this.running = null; }
  }
  async performTick() {
    this.jobs.expire();
    const expired = this.jobs.db.prepare("SELECT * FROM jobs WHERE queue_name=? AND state='recovery_required' AND available_at<=? ORDER BY updated_at LIMIT 2").all(this.queue, iso(this.jobs.database.now())).map(project);
    for (const job of expired) if (this.recovery) { try { await this.recovery(job); } catch { this.jobs.deferRecovery(job.id, job.lease_token); } }
    if (this.stopping) return false;
    const job = this.jobs.claim(this.id, { queue: this.queue }); if (!job) return false;
    const heartbeat = setInterval(() => { try { if (!this.jobs.heartbeat(job)) controller.abort(); } catch { controller.abort(); } }, Math.max(10, Math.floor(this.jobs.leaseMs / 3)));
    const controller = new AbortController();
    await Promise.resolve().then(async () => {
      try {
        const handler = this.handlers[job.job_type];
        if (!handler) throw durableError('UNKNOWN_JOB', 'No handler is registered for this job type.', 400);
        await handler(job, { signal: controller.signal, assertOwned: () => this.jobs.assert(job) });
        if (this.jobs.owns(job)) this.jobs.complete(job);
      } catch (error) { if (this.jobs.owns(job)) this.jobs.fail(job, error); }
      finally { clearInterval(heartbeat); }
    });
    return true;
  }
  async drain({ maxJobs = 100 } = {}) { let count = 0; while (count < maxJobs && await this.tick()) count++; return count; }
  async close() { this.stopping = true; await this.running; }
}
