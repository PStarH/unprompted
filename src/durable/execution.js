import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { validReceipt } from '../tool-gateway.js';
import { effectDigest } from './experience.js';

const unresolved = ['intent', 'dispatched', 'accepted', 'unknown'];
export class ResourceClaims {
  constructor(database, { leaseMs = 30000 } = {}) { this.database = database; this.db = database.db; this.leaseMs = leaseMs; }
  acquire({ provider, resourceId, runId, owner, executionId, userId = 'local' }) {
    return this.database.atomic(() => {
      const row = this.db.prepare('SELECT * FROM resource_claims WHERE user_id=? AND provider=? AND resource_id=?').get(userId, provider, resourceId);
      // A timed-out or expired unresolved claim is retained. No lease clock
      // can prove that a remote request has stopped executing.
      if (row && row.claim_state !== 'free' && row.current_execution_id !== executionId) throw durableError('RESOURCE_UNRESOLVED', 'Another execution owns this resource; reconcile it before another write.');
      const token = (row?.lease_token || 0) + 1;
      this.db.prepare(`INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,'held') ON CONFLICT(user_id,provider,resource_id) DO UPDATE SET
        owner_task_run_id=excluded.owner_task_run_id,lease_owner=excluded.lease_owner,lease_token=excluded.lease_token,
        lease_until=excluded.lease_until,current_execution_id=excluded.current_execution_id,claim_state='held'`)
        .run(userId, provider, resourceId, runId, owner, token, iso(this.database.now() + this.leaseMs), executionId);
      return { userId, provider, resourceId, owner, token, executionId };
    });
  }
  owns(claim) {
    return Boolean(this.db.prepare(`SELECT 1 FROM resource_claims WHERE user_id=? AND provider=? AND resource_id=? AND lease_owner=?
      AND lease_token=? AND current_execution_id=? AND claim_state='held' AND lease_until>?`).get(claim.userId, claim.provider, claim.resourceId, claim.owner, claim.token, claim.executionId, iso(this.database.now())));
  }
  renew(claim) {
    return this.database.atomic(() => this.db.prepare(`UPDATE resource_claims SET lease_until=? WHERE user_id=? AND provider=? AND resource_id=? AND lease_owner=?
      AND lease_token=? AND current_execution_id=? AND claim_state='held' AND lease_until>?`).run(iso(this.database.now() + this.leaseMs), claim.userId, claim.provider, claim.resourceId, claim.owner, claim.token, claim.executionId, iso(this.database.now())).changes === 1);
  }
  unresolved(claim) { this.db.prepare("UPDATE resource_claims SET claim_state='unresolved' WHERE user_id=? AND provider=? AND resource_id=? AND lease_token=? AND current_execution_id=?").run(claim.userId, claim.provider, claim.resourceId, claim.token, claim.executionId); }
  release(claim) {
    const execution = this.db.prepare('SELECT status FROM tool_executions WHERE id=?').get(claim.executionId);
    if (execution && unresolved.includes(execution.status)) throw durableError('RESOURCE_UNRESOLVED', 'An unresolved external execution cannot release its resource claim.');
    return this.db.prepare(`UPDATE resource_claims SET claim_state='free',lease_owner=NULL,lease_until=NULL,owner_task_run_id=NULL,current_execution_id=NULL
      WHERE user_id=? AND provider=? AND resource_id=? AND lease_token=? AND current_execution_id=?`).run(claim.userId, claim.provider, claim.resourceId, claim.token, claim.executionId).changes === 1;
  }
}

export class ToolExecutionLedger {
  constructor(database, { tasks, jobs, experiences = null, timeoutMs = 20000, leaseMs = 30000 } = {}) {
    this.database = database; this.db = database.db; this.tasks = tasks; this.jobs = jobs; this.experiences = experiences;
    this.timeoutMs = timeoutMs; this.claims = new ResourceClaims(database, { leaseMs });
  }
  get(id) { return this.db.prepare('SELECT * FROM tool_executions WHERE id=?').get(id); }
  byKey(key) { return this.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key=?').get(key); }
  list({ taskId = null, limit = 100 } = {}) { return this.db.prepare('SELECT id,task_id,provider,tool,action_family,status,is_write,provider_receipt_id,created_at,updated_at FROM tool_executions WHERE (? IS NULL OR task_id=?) ORDER BY created_at DESC LIMIT ?').all(taskId, taskId, Math.min(200, limit)); }
  intent({ taskId, run, job, provider, tool, actionFamily, resourceId, key, effect, payload, isWrite = true, providerIdempotent = false, conditionalVersion = null, planStepId = null, expectedInputVersion = run.input_version, authorize }) {
    if (!provider || !resourceId || !key || !tool || !actionFamily || json(payload).length > 256000) throw durableError('INVALID_EXECUTION', 'Invalid bounded tool execution.', 400);
    return this.database.atomic(() => {
      const task = this.tasks.assertRun(run, { job });
      if (task.id !== taskId || task.inputVersion !== expectedInputVersion || task.processedInputVersion !== task.inputVersion) throw durableError('TASK_DIRTY', 'Refresh the task checkpoint before dispatch.');
      if (isWrite && typeof authorize !== 'function') throw durableError('AUTHORIZATION_REQUIRED', 'External writes require an independent authorization decision.', 403);
      if (isWrite) {
        const decision = authorize();
        if (decision?.then || decision?.allowed !== true) throw durableError('AUTHORIZATION_REQUIRED', 'The policy engine did not authorize this write.', 403);
        if (this.experiences?.blocked({ taskId, actionFamily, effect })) throw durableError('ACTION_SUPPRESSED', 'The user rejected an equivalent action in this context.');
      }
      const existing = this.byKey(key);
      if (existing) {
        if (existing.task_id !== taskId || existing.provider !== provider || existing.resource_id !== resourceId || effectDigest(parse(existing.effect_signature_json)) !== effectDigest(effect)) throw durableError('IDEMPOTENCY_CONFLICT', 'An idempotency key cannot be reused for a different task, resource or effect.');
        if (existing.status === 'verified') return { execution: existing, claim: null, duplicate: true };
        const safe = !existing.privacy_redacted && (existing.status === 'cancelled' && (!existing.dispatched_at || existing.last_error_class === 'confirmed_no_effect') || existing.status === 'failed' && existing.last_error_class === 'confirmed_absent');
        if (!safe) throw durableError('RECONCILIATION_REQUIRED', 'The existing intent must be reconciled before another dispatch.');
        const at = iso(this.database.now());
        this.db.prepare(`UPDATE tool_executions SET task_run_id=?,job_id=?,plan_step_id=?,status='intent',payload_json=?,result_json=NULL,provider_receipt_id=NULL,
          input_version=?,run_generation=?,privacy_epoch=?,dispatched_at=NULL,last_error_class=NULL,updated_at=? WHERE id=? AND status=?`)
          .run(run.id, job.id, planStepId, json(payload), task.inputVersion, task.runGeneration, task.privacyEpoch, at, existing.id, existing.status);
        const claim = isWrite ? this.claims.acquire({ provider, resourceId, runId: run.id, owner: job.lease_owner, executionId: existing.id }) : null;
        if (claim) this.db.prepare('UPDATE tool_executions SET lease_owner=?,lease_token=? WHERE id=?').run(claim.owner, claim.token, existing.id);
        const number = this.db.prepare('SELECT COALESCE(MAX(attempt_number),0)+1 n FROM execution_attempts WHERE execution_id=?').get(existing.id).n;
        this.db.prepare('INSERT INTO execution_attempts VALUES(?,?,?,?,\'intent\',?,?)').run(existing.id, number, job.id, job.lease_token, at, at);
        return { execution: this.get(existing.id), claim, duplicate: false, authorize };
      }
      const id = randomUUID(), at = iso(this.database.now());
      this.db.prepare(`INSERT INTO tool_executions(id,task_id,task_run_id,job_id,plan_step_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,payload_json,
        conditional_version,provider_idempotent,input_version,run_generation,privacy_epoch,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'intent',?,?,?,?,?,?,?,?,?)`).run(id, taskId, run.id, job.id, planStepId, provider, tool, actionFamily, resourceId, key, json(effect), Number(isWrite), json(payload), conditionalVersion == null ? null : String(conditionalVersion), Number(providerIdempotent), task.inputVersion, task.runGeneration, task.privacyEpoch, at, at);
      const claim = isWrite ? this.claims.acquire({ provider, resourceId, runId: run.id, owner: job.lease_owner, executionId: id }) : null;
      if (claim) this.db.prepare('UPDATE tool_executions SET lease_owner=?,lease_token=? WHERE id=?').run(claim.owner, claim.token, id);
      this.db.prepare('INSERT INTO execution_attempts VALUES(?,1,?,?,\'intent\',?,?)').run(id, job.id, job.lease_token, at, at);
      this.database.lineage('task_run', run.id, 'execution', id);
      if (planStepId) this.database.lineage('plan_step', planStepId, 'execution', id);
      return { execution: this.get(id), claim, duplicate: false, authorize };
    });
  }
  async dispatch(intent, { run, job, send, verify = null, signal = null, deferDispatch = false }) {
    if (intent.duplicate) return parse(intent.execution.result_json);
    const { execution, claim } = intent;
    let dispatched = false;
    const beforeDispatch = () => this.database.atomic(() => {
      controller.signal.throwIfAborted(); signal?.throwIfAborted();
      this.tasks.preResume(run, job); this.tasks.assertRun(run, { job });
      if (claim && !this.claims.owns(claim)) throw durableError('LEASE_LOST', 'The resource claim expired before dispatch.');
      if (intent.authorize && intent.authorize().allowed !== true) throw durableError('AUTHORIZATION_REQUIRED', 'Authorization changed before dispatch.', 403);
      if (execution.is_write && this.experiences?.blocked({ taskId: execution.task_id, actionFamily: execution.action_family, effect: parse(execution.effect_signature_json) })) throw durableError('ACTION_SUPPRESSED', 'This action was stopped by user feedback.');
      if (dispatched) return;
      const changed = this.db.prepare("UPDATE tool_executions SET status='dispatched',dispatched_at=?,updated_at=? WHERE id=? AND status='intent'").run(iso(this.database.now()), iso(this.database.now()), execution.id).changes;
      if (!changed) throw durableError('EXECUTION_CHANGED', 'This intent was already dispatched.');
      this.db.prepare("UPDATE execution_attempts SET state='dispatched',updated_at=? WHERE execution_id=? AND job_id=? AND lease_token=?").run(iso(this.database.now()), execution.id, job.id, job.lease_token);
      dispatched = true;
    });
    const controller = new AbortController();
    let timer;
    const heartbeat = claim ? setInterval(() => { try { if (!this.jobs.heartbeat(job) || !this.claims.renew(claim)) controller.abort(durableError('LEASE_LOST', 'Execution ownership was lost.')); } catch { controller.abort(durableError('LEASE_LOST', 'Execution renewal could not be persisted.')); } }, Math.max(10, Math.floor(this.claims.leaseMs / 3))) : null;
    try {
      if (!deferDispatch) beforeDispatch();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(durableError(execution.is_write ? 'OUTCOME_UNKNOWN' : 'TOOL_READ_TIMEOUT', execution.is_write ? 'The external outcome is unknown after a timeout. Reconcile before retrying.' : 'The read tool timed out.', execution.is_write ? 409 : 504)); }, this.timeoutMs); });
      const result = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); signal?.throwIfAborted(); return send(AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), beforeDispatch); }), deadline]);
      if (!dispatched) throw durableError('DISPATCH_GUARD_REQUIRED', 'The provider did not enter its guarded dispatch boundary.');
      this.tasks.assertRun(run, { job, allowDirty: true });
      if (claim && !this.claims.owns(claim)) throw durableError('LEASE_LOST', 'Execution ownership was lost before recording the result.');
      this.database.atomic(() => {
        this.tasks.assertRun(run, { job, allowDirty: true });
        this.db.prepare('UPDATE tool_executions SET status=?,result_json=?,provider_receipt_id=?,updated_at=? WHERE id=? AND status=\'dispatched\'')
          .run(execution.is_write ? 'accepted' : 'verified', json(result), result?.id || result?.receiptId || null, iso(this.database.now()), execution.id);
        this.db.prepare('UPDATE execution_attempts SET state=?,updated_at=? WHERE execution_id=? AND job_id=? AND lease_token=?').run(execution.is_write ? 'accepted' : 'verified', iso(this.database.now()), execution.id, job.id, job.lease_token);
      });
      if (verify) {
        const verification = await Promise.race([Promise.resolve().then(() => verify(result)), deadline]);
        if ((verification?.status !== 'found' && verification?.verified !== true) || !validReceipt(verification.receipt || result, { key: execution.idempotency_key })) throw durableError('OUTCOME_UNKNOWN', 'Provider acceptance could not be verified.');
        this.verified(execution.id, verification.receipt || result, { run, job, claim });
      }
      return result;
    } catch (error) {
      // Fenced-out workers cannot record a result, even if their remote call
      // completed. A new recovery owner must reconcile that execution.
      if (this.jobs.owns(job) && (!claim || this.claims.owns(claim))) {
        const current = this.get(execution.id);
        if (current && unresolved.includes(current.status)) this.database.atomic(() => {
          const knownNotDispatched = current.status === 'intent';
          const knownNoEffect = knownNotDispatched || current.status === 'dispatched' && error.definitiveNoEffect === true;
          const status = knownNoEffect ? 'cancelled' : execution.is_write ? 'unknown' : 'failed';
          this.db.prepare('UPDATE tool_executions SET status=?,last_error_class=?,updated_at=? WHERE id=?').run(status, knownNoEffect ? 'confirmed_no_effect' : error.code || 'external_failure', iso(this.database.now()), execution.id);
          this.db.prepare('UPDATE execution_attempts SET state=?,updated_at=? WHERE execution_id=? AND job_id=? AND lease_token=?').run(status, iso(this.database.now()), execution.id, job.id, job.lease_token);
          if (claim) knownNoEffect ? this.claims.release(claim) : this.claims.unresolved(claim);
        });
      }
      error.ambiguous = execution.is_write === 1 && this.get(execution.id)?.status !== 'cancelled'; throw error;
    } finally { clearTimeout(timer); if (heartbeat) clearInterval(heartbeat); }
  }
  verified(id, result, { run = null, job = null, claim = null } = {}) {
    return this.database.atomic(() => {
      if (run) this.tasks.assertRun(run, { job, allowDirty: true });
      if (claim && !this.claims.owns(claim)) throw durableError('LEASE_LOST', 'The resource claim expired before recording verification.');
      const current = this.get(id); if (!current) throw durableError('MISSING_EXECUTION', 'Execution no longer exists.');
      if (!validReceipt(result, { key: current.idempotency_key, receiptId: current.provider_receipt_id })) throw durableError('INVALID_RECEIPT', 'The provider receipt is missing or belongs to another operation.');
      if (current.privacy_redacted) result = { id: result?.id || result?.receiptId || null, provider: current.provider, status: 'verified' };
      this.db.prepare("UPDATE tool_executions SET status='verified',result_json=?,provider_receipt_id=COALESCE(?,provider_receipt_id),verified_at=?,updated_at=? WHERE id=?")
        .run(json(result), result?.id || result?.receiptId || null, iso(this.database.now()), iso(this.database.now()), id);
      this.db.prepare("UPDATE execution_attempts SET state='verified',updated_at=? WHERE execution_id=? AND job_id=?").run(iso(this.database.now()), id, current.job_id);
      const storedClaim = this.db.prepare('SELECT * FROM resource_claims WHERE current_execution_id=?').get(id);
      if (storedClaim) this.claims.release(claim || { userId: storedClaim.user_id, provider: storedClaim.provider, resourceId: storedClaim.resource_id, owner: storedClaim.lease_owner, token: storedClaim.lease_token, executionId: id });
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'outcome\',?,?)').run(id, iso(this.database.now()));
      this.database.lineage('execution', id, 'outcome', id); return this.get(id);
    });
  }
  async reconcile(id, provider, { assertOwned = () => {} } = {}) {
    const execution = this.get(id); if (!execution) throw durableError('MISSING_EXECUTION', 'Unknown execution.', 404);
    if (execution.status === 'verified') return { status: 'found', receipt: parse(execution.result_json) };
    if (!provider?.lookup) return { status: 'unknown', manual: true };
    const controller = new AbortController(); let timer, result;
    try {
      result = await Promise.race([provider.lookup(execution.idempotency_key, { receiptId: execution.provider_receipt_id, conditionalVersion: execution.conditional_version, signal: controller.signal }), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'unknown' }); }, this.timeoutMs); })]);
    } finally { clearTimeout(timer); }
    assertOwned();
    return this.database.atomic(() => {
      const current = this.get(id);
      if (!current || !unresolved.includes(current.status)) return { status: current?.status || 'unknown' };
      if (result?.status === 'found' && validReceipt(result.receipt, { key: execution.idempotency_key, receiptId: execution.provider_receipt_id })) { this.verified(id, result.receipt); return result; }
      if (result?.status === 'not_found' && (execution.provider_idempotent || provider.reliableAbsence === true)) {
        this.db.prepare("UPDATE tool_executions SET status='failed',last_error_class='confirmed_absent',updated_at=? WHERE id=?").run(iso(this.database.now()), id);
        const claim = this.db.prepare('SELECT * FROM resource_claims WHERE current_execution_id=?').get(id);
        if (claim) this.claims.release({ userId: claim.user_id, provider: claim.provider, resourceId: claim.resource_id, owner: claim.lease_owner, token: claim.lease_token, executionId: id });
        return { status: 'not_found', safeToRetry: true };
      }
      this.db.prepare("UPDATE tool_executions SET status='unknown',last_error_class='reconciliation_inconclusive',updated_at=? WHERE id=?").run(iso(this.database.now()), id);
      return { status: 'unknown', manual: true, detail: 'The provider cannot establish safe absence. No retry was authorized.' };
    });
  }
  recoverUnfinished() {
    return this.database.atomic(() => this.db.prepare("UPDATE tool_executions SET status='unknown',last_error_class='process_interrupted',updated_at=? WHERE is_write=1 AND status IN ('dispatched','accepted')").run(iso(this.database.now())).changes);
  }
}
