import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';

export function classifyFailure(error) {
  if (error?.ambiguous || error?.writeOutcomeUnknown || /OUTCOME_UNKNOWN|LEASE_LOST|SESSION_RECONCILIATION_REQUIRED/.test(error?.code || '')) return 'ambiguous';
  if (['TOKEN_BUDGET_EXHAUSTED', 'MONEY_BUDGET_EXHAUSTED', 'MONEY_PROFILE_REQUIRED', 'TOKEN_ACCOUNTING_STALE', 'MONEY_ACCOUNTING_STALE'].includes(error?.code)) return 'budget';
  const status = Number(error?.status);
  if (status === 429 || /RATE_LIMIT/.test(error?.code || '')) return 'rate_limit';
  if (/^SQLITE_(BUSY|LOCKED)/.test(error?.code || '') || ['AbortError', 'TimeoutError'].includes(error?.name) || /ETIMEDOUT|ECONN|EAI_AGAIN/.test(error?.code || '') || [408, 425].includes(status) || status >= 500) return 'retryable';
  return 'permanent';
}
const project = row => row && ({ ...row, payload: parse(row.payload_json) });

// Claims and fencing tokens never go backwards. Only confirmed budget waits
// are excluded from the ordinary failure allowance.
export const effectiveJobAttempts = job => job.attempts - (job.budget_deferrals ?? 0);
const PARKED_BUDGET_AT = '9999-12-31T23:59:59.999Z';
const budgetKinds = new Set(['token', 'model', 'transaction']);
// Scope IDs follow the token ledger's bounded identifier domain. They are
// bound SQL values, never display text or authorization facts.
const budgetScopeId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && Boolean(value.trim());
const budgetId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function budgetMetadata(error, now) {
  const detail = error.detail || {};
  const blockedScopes = [...new Set((Array.isArray(detail.blockedScopes) ? detail.blockedScopes : [])
    .filter(scope => ['workspace', 'task', 'lease'].includes(scope)))];
  const candidate = error.retryAt;
  // A mixed daily + cumulative lease block cannot recover at midnight.
  const timed = !blockedScopes.includes('lease') && typeof candidate === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
    && Number.isFinite(Date.parse(candidate)) && Date.parse(candidate) > now
    && iso(Date.parse(candidate)) === candidate;
  return {
    code: error.code, kind: error.code?.startsWith('TOKEN_') ? 'token'
      : detail.kind === 'transaction' ? 'transaction' : 'model',
    reason: ['TOKEN_ACCOUNTING_STALE', 'MONEY_ACCOUNTING_STALE'].includes(error.code) ? 'configuration_changed' : error.code === 'MONEY_PROFILE_REQUIRED' ? 'configuration_required' : 'exhausted', blockedScopes,
    day: typeof detail.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(detail.day) ? detail.day : null,
    resetsAt: timed ? candidate : null,
    grantId: budgetId(detail.lease?.grantId) ? detail.lease.grantId : null
  };
}

/**
 * Upper bounds for one handler invocation, per job type.
 *
 * These are failure guards, not expected durations. Every value is far above
 * the model and execution timeouts (20s) and the worker lease (30s), so normal
 * work never reaches them.
 */
export const JOB_DEADLINES = Object.freeze({
  task_initial: 15 * 60000,
  task_continue: 15 * 60000,
  discovery: 10 * 60000,
  experience_trial: 10 * 60000,
  situation_timer: 5 * 60000,
  situation_pair: 2 * 60000,
  situation_delta: 5 * 60000,
  standing_intent_match: 5 * 60000,
  ingest_event: 2 * 60000,
  compile_experience: 10 * 60000,
  artifact_publish: 10 * 60000,
  external_dispatch: 5 * 60000,
  reconcile_execution: 5 * 60000,
  privacy_reconcile: 10 * 60000,
  finish_forget: 10 * 60000
});
export const DEFAULT_JOB_DEADLINE_MS = 10 * 60000;
export const DEFAULT_RECOVERY_DEADLINE_MS = 2 * 60000;

const TIMED_OUT = Symbol('job timeout');
const SETTLED = Symbol('job settled');

export class DurableJobs {
  constructor(database, { leaseMs = 30000, random = Math.random } = {}) {
    this.database = database; this.db = database.db; this.leaseMs = leaseMs; this.random = random;
    // Serialize the check and additive upgrade so simultaneous openers cannot
    // both attempt the same ALTER. Final release schema consolidation is separate.
    const upgrade = () => {
      const columns = new Set(this.db.pragma('table_info(jobs)').map(column => column.name));
      const missing = ['budget_deferrals', 'budget_metadata_json', 'budget_wake_epoch', 'budget_claim_epoch'].filter(name => !columns.has(name));
      if (database.readonly && missing.length) throw durableError('SQLITE_SCHEMA', 'This job queue needs a writable budget-schema upgrade.');
      if (!columns.has('budget_deferrals')) this.db.exec('ALTER TABLE jobs ADD COLUMN budget_deferrals INTEGER NOT NULL DEFAULT 0 CHECK(budget_deferrals>=0 AND budget_deferrals<=attempts)');
      if (!columns.has('budget_metadata_json')) this.db.exec('ALTER TABLE jobs ADD COLUMN budget_metadata_json TEXT');
      if (!columns.has('budget_wake_epoch')) this.db.exec('ALTER TABLE jobs ADD COLUMN budget_wake_epoch INTEGER NOT NULL DEFAULT 0 CHECK(budget_wake_epoch>=0)');
      if (!columns.has('budget_claim_epoch')) this.db.exec('ALTER TABLE jobs ADD COLUMN budget_claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK(budget_claim_epoch>=0)');
      if (!database.readonly) this.db.exec(`CREATE TABLE IF NOT EXISTS job_budget_wakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, wake_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('token','model','transaction')),
        task_id TEXT, grant_id TEXT, created_at TEXT NOT NULL
      )`);
      else if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_budget_wakes'").get()) {
        throw durableError('SQLITE_SCHEMA', 'This job queue needs a writable wake-schema upgrade.');
      }
      const wakeColumns = new Set(this.db.pragma('table_info(job_budget_wakes)').map(column => column.name));
      if (!wakeColumns.has('drained_at')) {
        if (database.readonly) throw durableError('SQLITE_SCHEMA', 'This job queue needs a writable wake-dispatch upgrade.');
        this.db.exec('ALTER TABLE job_budget_wakes ADD COLUMN drained_at TEXT');
      }
      if (!database.readonly) this.db.exec('CREATE INDEX IF NOT EXISTS idx_budget_wakes_pending ON job_budget_wakes(drained_at,id)');
    };
    if (database.readonly) upgrade(); else database.atomic(upgrade);
  }
  // Jobs run in availability order. The legacy jobs.priority column is retained
  // for storage compatibility but is not part of the queue contract.
  enqueue({ id = randomUUID(), queue = 'tasks', type, payload = {}, key, taskId = null, maxAttempts = 8, availableAt = iso(this.database.now()) }) {
    if (!type || !key || maxAttempts < 1 || maxAttempts > 100 || json(payload).length > 256000) throw durableError('INVALID_JOB', 'Invalid durable job.', 400);
    return this.database.atomic(() => {
      const at = iso(this.database.now());
      this.db.prepare(`INSERT OR IGNORE INTO jobs(id,queue_name,job_type,payload_json,idempotency_key,task_id,state,max_attempts,available_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?,?,?)`).run(id, queue, type, json(payload), key, taskId, maxAttempts, availableAt, at, at);
      return project(this.db.prepare('SELECT * FROM jobs WHERE queue_name=? AND idempotency_key=?').get(queue, key));
    });
  }
  get(id) { return project(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }
  /**
   * Writes whose external outcome is still open for this job. A handler that
   * times out while one exists has not proven failure: the PRD requires those
   * to enter recovery instead of being retried.
   */
  unresolvedWrites(id) {
    return this.db.prepare(`SELECT id,status FROM tool_executions
      WHERE (job_id=? OR task_run_id IN (SELECT id FROM task_runs WHERE job_id=?))
      AND is_write=1 AND status IN ('intent','dispatched','accepted','unknown')`).all(id, id);
  }
  list({ taskId = null, limit = 100 } = {}) { return this.db.prepare('SELECT * FROM jobs WHERE (? IS NULL OR task_id=?) ORDER BY created_at DESC LIMIT ?').all(taskId, taskId, Math.min(200, Math.max(1, limit))).map(project); }
  /** Internal scheduling facts only: neither this event nor a woken job is an
   * authorization, refund or dispatch permit. Callers supply committed facts. */
  startBudgetWake({ key, kind, taskId = null, grantId = null } = {}) {
    if (!budgetId(key) || !budgetKinds.has(kind) || taskId !== null && !budgetScopeId(taskId)
      || grantId !== null && (!budgetId(grantId) || kind !== 'transaction')) {
      throw durableError('INVALID_BUDGET_WAKE', 'A bounded budget wake identity and scope are required.', 400);
    }
    return this.database.atomic(() => {
      this.db.prepare(`INSERT OR IGNORE INTO job_budget_wakes(wake_key,kind,task_id,grant_id,created_at) VALUES(?,?,?,?,?)`)
        .run(key, kind, taskId, grantId, iso(this.database.now()));
      const event = this.db.prepare('SELECT * FROM job_budget_wakes WHERE wake_key=?').get(key);
      if (event.kind !== kind || event.task_id !== taskId || event.grant_id !== grantId) {
        throw durableError('BUDGET_WAKE_CONFLICT', 'This wake fact is already bound to another scope.');
      }
      return event;
    });
  }
  pendingBudgetWakes({ limit = 4 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw durableError('INVALID_BUDGET_WAKE', 'A bounded pending-event batch is required.', 400);
    return this.db.prepare('SELECT * FROM job_budget_wakes WHERE drained_at IS NULL ORDER BY id LIMIT ?').all(limit);
  }
  wakeBudgetDeferred({ eventId, limit = 50 } = {}) {
    if (!Number.isSafeInteger(eventId) || eventId < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw durableError('INVALID_BUDGET_WAKE', 'A persisted event and batch size from 1 to 100 are required.', 400);
    }
    return this.database.atomic(() => {
      const event = this.db.prepare('SELECT * FROM job_budget_wakes WHERE id=?').get(eventId);
      if (!event) throw durableError('BUDGET_WAKE_MISSING', 'The budget wake event does not exist.');
      const eligible = `FROM jobs j WHERE j.state='retry_wait' AND j.last_error_class='budget'
        AND j.budget_wake_epoch<? AND json_extract(j.budget_metadata_json,'$.kind')=?
        AND (? IS NULL OR j.task_id=?) AND (? IS NULL OR json_extract(j.budget_metadata_json,'$.grantId')=?)
        AND (j.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id=j.task_id
          AND (t.status NOT IN ('completed','cancelled') OR (j.queue_name='learning' AND j.job_type='compile_experience'
            AND json_extract(j.payload_json,'$.sourceKind')='feedback' AND length(json_extract(j.payload_json,'$.compilationInputDigest'))=64 AND EXISTS (
              SELECT 1 FROM feedback_events f JOIN source_records s ON s.kind='feedback' AND s.id=f.id AND s.active=1
              WHERE f.id=json_extract(j.payload_json,'$.sourceId') AND f.task_id=t.id AND f.kind!='silence')))
          AND COALESCE(json_extract(t.data_json,'$.userDismissed'),0)=0
          AND COALESCE(json_extract(t.data_json,'$.control.paused'),0)=0
          AND COALESCE(json_extract(t.data_json,'$.privacyInvalidated'),0)=0))`;
      const args = [event.id, event.kind, event.task_id, event.task_id, event.grant_id, event.grant_id];
      const rows = this.db.prepare(`SELECT j.id ${eligible} ORDER BY j.available_at,j.id LIMIT ?`).all(...args, limit);
      const at = iso(this.database.now());
      for (const row of rows) this.db.prepare('UPDATE jobs SET available_at=?,budget_wake_epoch=?,updated_at=? WHERE id=?')
        .run(at, event.id, at, row.id);
      const hasMore = Boolean(this.db.prepare(`SELECT 1 ${eligible} LIMIT 1`).get(...args));
      if (!hasMore) this.db.prepare('UPDATE job_budget_wakes SET drained_at=? WHERE id=? AND drained_at IS NULL').run(at, event.id);
      return { eventId: event.id, woken: rows.map(row => row.id), hasMore };
    });
  }
  claim(worker, { queue = 'tasks', id = null, now = this.database.now() } = {}) {
    if (!worker) throw durableError('INVALID_WORKER', 'Worker identity is required.', 400);
    return this.database.atomic(() => {
      const at = iso(now);
      const row = this.db.prepare(`SELECT * FROM jobs WHERE queue_name=? AND state IN ('queued','retry_wait') AND available_at<=?
        AND attempts-budget_deferrals<max_attempts AND (? IS NULL OR id=?) ORDER BY available_at,id LIMIT 1`).get(queue, at, id, id);
      if (!row) return null;
      this.db.prepare(`UPDATE jobs SET state='running', attempts=attempts+1,lease_token=lease_token+1,
        budget_claim_epoch=(SELECT COALESCE(MAX(id),0) FROM job_budget_wakes),lease_owner=?,lease_until=?,heartbeat_at=?,updated_at=?
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
    return this.database.atomic(() => { this.assert(job); this.db.prepare(`UPDATE jobs SET state='completed',lease_until=NULL,budget_metadata_json=NULL,
      last_error_class=CASE WHEN last_error_class='budget' THEN NULL ELSE last_error_class END,updated_at=?
      WHERE id=? AND state='running' AND lease_owner=? AND lease_token=?`).run(iso(this.database.now()), job.id, job.lease_owner, job.lease_token);
      this.db.prepare("UPDATE task_runs SET status='waiting',updated_at=? WHERE job_id=? AND job_lease_token=? AND status='running'").run(iso(this.database.now()), job.id, job.lease_token);
      return this.get(job.id); });
  }
  fail(job, error, { reasoningTerminal = false } = {}) {
    return this.database.atomic(() => {
      this.assert(job);
      // Caller snapshots may be stale or altered; counters come from SQLite.
      job = this.get(job.id);
      let kind = classifyFailure(error);
      if ((kind === 'budget' || reasoningTerminal) && this.unresolvedWrites(job.id).length) kind = 'ambiguous';
      // Only the native reasoning checkpoint supplies this option after its
      // bounded retry policy is exhausted. Provider fields cannot set it.
      if (reasoningTerminal === true && ['retryable', 'rate_limit'].includes(kind)) kind = 'permanent';
      if (kind === 'budget') {
        const now = this.database.now(), metadata = budgetMetadata(error, now);
        // A release can commit after the failed admission but before this
        // checkpoint, even after its wake batch finished. Recheck once locally
        // rather than losing that wake until midnight. The next claim captures
        // the new epoch, so the same event cannot create a polling loop.
        const racedWake = this.db.prepare(`SELECT 1 FROM job_budget_wakes w WHERE w.id>? AND w.kind=?
          AND (w.task_id IS NULL OR w.task_id=?) AND (w.grant_id IS NULL OR w.grant_id=?) LIMIT 1`)
          .get(job.budget_claim_epoch, metadata.kind, job.task_id, metadata.grantId);
        this.db.prepare(`UPDATE jobs SET state='retry_wait',last_error_class='budget',dead_letter_reason=NULL,
          budget_deferrals=budget_deferrals+1,budget_metadata_json=?,
          budget_wake_epoch=(SELECT COALESCE(MAX(id),0) FROM job_budget_wakes),available_at=?,lease_until=NULL,updated_at=?
          WHERE id=? AND state='running' AND lease_owner=? AND lease_token=?`)
          .run(json(metadata), racedWake ? iso(now) : metadata.resetsAt || PARKED_BUDGET_AT, iso(now), job.id, job.lease_owner, job.lease_token);
        this.db.prepare("UPDATE task_runs SET status='waiting',updated_at=? WHERE job_id=? AND job_lease_token=? AND status='running'")
          .run(iso(now), job.id, job.lease_token);
        return this.get(job.id);
      }
      const exhausted = effectiveJobAttempts(job) >= job.max_attempts;
      const state = kind === 'ambiguous' ? 'recovery_required' : kind === 'permanent' || exhausted ? 'dead' : 'retry_wait';
      const delay = Math.max(Math.min(300000, 1000 * 2 ** Math.min(12, effectiveJobAttempts(job) - 1)) * (0.5 + this.random()), Number(error.retryAfterMs) || 0);
      this.db.prepare(`UPDATE jobs SET state=?,last_error_class=?,dead_letter_reason=?,budget_metadata_json=NULL,available_at=?,lease_until=NULL,updated_at=?
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
      const nextState = decision.state === 'queued' && effectiveJobAttempts(job) >= job.max_attempts ? 'dead' : decision.state;
      if (nextState === 'dead' && decision.state === 'queued') this.db.prepare("UPDATE jobs SET dead_letter_reason='attempts_exhausted' WHERE id=? AND lease_token=?").run(id, job.lease_token);
      this.db.prepare('UPDATE jobs SET state=?,lease_owner=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE id=? AND state=\'recovery_required\' AND lease_token=?').run(nextState, iso(this.database.now()), iso(this.database.now()), id, job.lease_token);
      return this.get(id);
    });
  }
  /**
   * Move a recovery_required job back into the queue, or escalate it.
   *
   * Recovery attempts count against `attempts`: a job that keeps returning an
   * unknown external outcome must reach a terminal state instead of polling a
   * provider forever. Only a job that is currently due can be deferred, so a
   * duplicate call from the same recovery cycle is a no-op.
   */
  deferRecovery(id, leaseToken, delayMs = 30000) {
    return this.database.atomic(() => {
      const now = this.database.now(), at = iso(now), job = this.get(id);
      if (!job || job.state !== 'recovery_required' || job.lease_token !== leaseToken || job.available_at > at) return { state: 'unchanged', changes: 0, job };
      const attempts = job.attempts + 1;
      const effectiveAttempts = attempts - job.budget_deferrals;
      if (effectiveAttempts >= job.max_attempts) {
        this.db.prepare(`UPDATE jobs SET state='dead',attempts=?,dead_letter_reason='recovery_unresolved',available_at=?,lease_owner=NULL,lease_until=NULL,updated_at=?
          WHERE id=? AND state='recovery_required' AND lease_token=?`).run(attempts, at, at, id, leaseToken);
        this.db.prepare("UPDATE task_runs SET status='failed',updated_at=? WHERE job_id=? AND job_lease_token=? AND status='recovery_required'").run(at, id, leaseToken);
        return { state: 'dead', changes: 1, job: this.get(id) };
      }
      const backoff = Math.min(300000, Math.max(5000, delayMs) * 2 ** (effectiveAttempts - 1));
      const changes = this.db.prepare("UPDATE jobs SET attempts=?,available_at=?,updated_at=? WHERE id=? AND state='recovery_required' AND lease_token=?")
        .run(attempts, iso(now + backoff), at, id, leaseToken).changes;
      return { state: changes ? 'recovery_required' : 'unchanged', changes, job: this.get(id) };
    });
  }
  cancelTask(taskId) { return this.db.prepare("UPDATE jobs SET state='cancelled',payload_json='{}',lease_until=NULL,updated_at=? WHERE task_id=? AND state NOT IN ('completed','dead','cancelled')").run(iso(this.database.now()), taskId).changes; }
}

export class DurableWorker {
  constructor({ jobs, handlers = {}, recovery = null, id = randomUUID(), queue = 'tasks',
    deadlineMs = DEFAULT_JOB_DEADLINE_MS, recoveryDeadlineMs = DEFAULT_RECOVERY_DEADLINE_MS, deadlines = {}, onDead = null }) {
    const positive = value => Number.isFinite(value) && value > 0;
    if (!positive(deadlineMs) || !positive(recoveryDeadlineMs) || Object.values(deadlines).some(value => !positive(value))) {
      throw durableError('INVALID_WORKER_DEADLINE', 'Worker deadlines must be positive milliseconds.', 400);
    }
    this.jobs = jobs; this.handlers = handlers; this.recovery = recovery; this.id = id; this.queue = queue;
    this.deadlineMs = deadlineMs; this.recoveryDeadlineMs = recoveryDeadlineMs; this.deadlines = { ...JOB_DEADLINES, ...deadlines };
    this.onDead = onDead; this.stopping = false; this.running = null;
  }
  deadlineFor(type) { return this.deadlines[type] ?? this.deadlineMs; }
  /**
   * Run one unit of work with a hard deadline. The timer is always cleared and
   * the abandoned promise is made rejection-safe, so a hung handler can neither
   * keep the process alive nor surface an unhandled rejection.
   */
  async #bounded(run, deadlineMs) {
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs); });
    try {
      return await Promise.race([
        Promise.resolve().then(run).then(() => SETTLED, error => ({ error })),
        deadline
      ]);
    } finally { clearTimeout(timer); }
  }
  async #dead(job, error) {
    if (!this.onDead) return;
    // A dead job must not break the worker loop even if the hook fails.
    try { await this.onDead(job, error); } catch { /* the dead state is already persisted */ }
  }
  async #deferRecovery(job, error) {
    const current = this.jobs.get(job.id);
    if (current?.state !== 'recovery_required' || current.lease_token !== job.lease_token) return;
    if (current.available_at > iso(this.jobs.database.now())) return;
    const result = this.jobs.deferRecovery(job.id, job.lease_token);
    if (result.state === 'dead') await this.#dead(job, error);
  }
  async tick() {
    if (this.stopping || this.running) return false;
    const pending = Promise.resolve().then(() => this.performTick()); this.running = pending;
    try { return await pending; } finally { if (this.running === pending) this.running = null; }
  }
  async performTick() {
    this.jobs.expire();
    const expired = this.jobs.db.prepare("SELECT * FROM jobs WHERE queue_name=? AND state='recovery_required' AND available_at<=? ORDER BY updated_at LIMIT 2").all(this.queue, iso(this.jobs.database.now())).map(project);
    for (const job of expired) if (this.recovery) {
      const outcome = await this.#bounded(() => this.recovery(job), this.recoveryDeadlineMs);
      if (outcome === TIMED_OUT) await this.#deferRecovery(job, durableError('JOB_TIMEOUT', 'Recovery exceeded its deadline.', 504));
      else if (outcome?.error) await this.#deferRecovery(job, outcome.error);
    }
    if (this.stopping) return false;
    const job = this.jobs.claim(this.id, { queue: this.queue }); if (!job) return false;
    const controller = new AbortController();
    const deadlineMs = this.deadlineFor(job.job_type);
    const heartbeat = setInterval(() => { try { if (!this.jobs.heartbeat(job)) controller.abort(); } catch { controller.abort(); } }, Math.max(10, Math.floor(this.jobs.leaseMs / 3)));
    let outcome;
    try {
      outcome = await this.#bounded(async () => {
        const handler = this.handlers[job.job_type];
        if (!handler) throw durableError('UNKNOWN_JOB', 'No handler is registered for this job type.', 400);
        await handler(job, { signal: controller.signal, assertOwned: () => this.jobs.assert(job) });
      }, deadlineMs);
    } finally { clearInterval(heartbeat); }
    if (outcome === TIMED_OUT) {
      // Abort first so a cooperative handler stops, then record the failure. A
      // timeout proves nothing about an external write that was in flight.
      const error = durableError('JOB_TIMEOUT', `The ${job.job_type} handler exceeded its ${Math.round(deadlineMs / 1000)}s deadline.`, 504);
      controller.abort(error);
      if (this.jobs.unresolvedWrites(job.id).length) error.ambiguous = true;
      try { if (this.jobs.fail(job, error).state === 'dead') await this.#dead(job, error); } catch { /* ownership was already lost */ }
      return true;
    }
    if (outcome === SETTLED) { try { if (this.jobs.owns(job)) this.jobs.complete(job); } catch { /* ownership was already lost */ } }
    else { try { if (this.jobs.owns(job) && this.jobs.fail(job, outcome.error).state === 'dead') await this.#dead(job, outcome.error); } catch { /* ownership was already lost */ } }
    return true;
  }
  async drain({ maxJobs = 100 } = {}) { let count = 0; while (count < maxJobs && await this.tick()) count++; return count; }
  async close() { this.stopping = true; await this.running; }
}
