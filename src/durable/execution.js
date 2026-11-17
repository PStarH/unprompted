import { TransactionMoneyService } from './transaction-money.js';
import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { isAuthorityCredential } from '../authority-credential.js';
import { validReceipt } from '../tool-gateway.js';
import { effectDigest } from './experience.js';
import { linkOperation, operationContext, updateOperationExecution } from './reasoning-sessions.js';

const unresolved = ['intent', 'dispatched', 'accepted', 'unknown'];
// Dispatch permits are opaque capabilities. Everything dispatch needs lives in
// this module-private map, keyed by the frozen object returned from intent().
// A clone, JSON round-trip, spread or foreign lookalike has no entry and can
// never reach an external send. Only frozen snapshots are exposed; the mutable
// persisted row is never handed out, so changing `execution.is_write` on a
// permit cannot downgrade a write into an unverified read. Dispatch re-reads
// the current row for every decision and rejects any drift.
const permits = new WeakMap();
const PERMIT_FIELDS = Object.freeze(['id', 'task_id', 'task_run_id', 'job_id', 'plan_step_id', 'provider', 'tool', 'action_family',
  'resource_id', 'idempotency_key', 'status', 'is_write', 'conditional_version', 'provider_idempotent', 'input_version',
  'run_generation', 'privacy_epoch', 'dispatched_at', 'created_at', 'updated_at']);
const executionView = row => Object.freeze(Object.fromEntries(PERMIT_FIELDS.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
const claimView = claim => claim == null ? null : Object.freeze({ ...claim });
function issuePermit(ledger, { execution, claim, duplicate, authorize, taskId, runId, jobId, key, digest, transfer = null, hold = null, moneyBinding = null, moneyAttemptId = null }) {
  const snapshot = executionView(execution);
  const frozenClaim = claimView(claim);
  const state = {
    ledger, snapshot, claim: frozenClaim, duplicate, duplicateResult: duplicate ? parse(execution.result_json) : null,
    authorize, taskId, runId, jobId, key, digest,
    executionId: snapshot.id, isWrite: snapshot.is_write === 1, transfer, hold, moneyBinding, moneyAttemptId,
    consumed: false, dispatching: false, markerActive: false, markerCommitted: false
  };
  const permit = {};
  for (const field of ['execution', 'claim', 'duplicate']) Object.defineProperty(permit, field, { enumerable: true, get: () => field === 'execution' ? state.snapshot : field === 'claim' ? state.claim : state.duplicate, set: () => {} });
  permits.set(permit, state);
  return Object.freeze(permit);
}
function permitState(permit, ledger) {
  const state = permit !== null && typeof permit === 'object' ? permits.get(permit) : null;
  if (!state || state.ledger !== ledger) throw durableError('PERMIT_INVALID', 'This dispatch permit was not issued by this execution ledger.', 403);
  return state;
}
function synchronousDecision(decision) {
  if (decision?.then) throw durableError('AUTHORIZATION_REQUIRED', 'Authorization must be a synchronous local decision.', 403);
  return decision;
}
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
  constructor(database, { tasks, jobs, experiences = null, transfers = null, timeoutMs = 20000, leaseMs = 30000 } = {}) {
    if (transfers != null && (!(transfers instanceof TransactionMoneyService) || transfers.database !== database || transfers.db !== database.db)) {
      throw durableError('TRANSACTION_PARTICIPANT_INVALID', 'Tool and transaction money ledgers must share the same native workspace database.', 409);
    }
    this.database = database; this.db = database.db; this.tasks = tasks; this.jobs = jobs; this.experiences = experiences;
    this.transfers = transfers;
    this.timeoutMs = timeoutMs; this.claims = new ResourceClaims(database, { leaseMs });
    this.database.atomic(() => this.db.exec(`CREATE TABLE IF NOT EXISTS execution_money_bindings (
      execution_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1),
      money_attempt_id TEXT NOT NULL UNIQUE,
      quote_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(execution_id,attempt_number))`));
  }
  get(id) { return this.db.prepare('SELECT * FROM tool_executions WHERE id=?').get(id); }
  byKey(key) { return this.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key=?').get(key); }
  list({ taskId = null, limit = 100 } = {}) { return this.db.prepare('SELECT id,task_id,provider,tool,action_family,status,is_write,provider_receipt_id,created_at,updated_at FROM tool_executions WHERE (? IS NULL OR task_id=?) ORDER BY created_at DESC LIMIT ?').all(taskId, taskId, Math.min(200, limit)); }
  #moneyAttempt(executionId, attemptNumber = null) {
    const row = attemptNumber == null
      ? this.db.prepare('SELECT * FROM execution_money_bindings WHERE execution_id=? ORDER BY attempt_number DESC LIMIT 1').get(executionId)
      : this.db.prepare('SELECT * FROM execution_money_bindings WHERE execution_id=? AND attempt_number=?').get(executionId, attemptNumber);
    return row || null;
  }
  #moneyBinding({ provider, tool, actionFamily, taskId, inputVersion, privacyEpoch, resourceId, payload, effect, decision }) {
    const extra = decision?.transferBinding;
    return { provider, tool, actionFamily, taskId, inputVersion, privacyEpoch: String(privacyEpoch), resourceId, payload, effect,
      mcpSchemaId: extra?.mcpSchemaId ?? null, mcpConnectionId: extra?.mcpConnectionId ?? null };
  }
  #reserveTransfer(decision, { execution, number, binding }) {
    const quote = decision?.transfer ?? null;
    if (quote == null) return { hold: null, moneyAttemptId: null };
    if (!this.transfers || typeof this.transfers.isNativeQuote !== 'function' || !this.transfers.isNativeQuote(quote)) {
      throw durableError('TRANSFER_QUOTE_UNTRUSTED', 'A transaction transfer requires the exact native quote issued by this workspace.', 403);
    }
    const moneyAttemptId = `${execution.id}:a${number}`;
    const hold = this.transfers.reserve(quote, { attemptId: moneyAttemptId, binding });
    this.db.prepare('INSERT INTO execution_money_bindings VALUES(?,?,?,?,?)').run(execution.id, number, moneyAttemptId, hold.quoteId, iso(this.database.now()));
    return { hold, moneyAttemptId };
  }
  intent({ taskId, run, job, provider, tool, actionFamily, resourceId, key, effect, payload, isWrite = true, providerIdempotent = false, conditionalVersion = null, planStepId = null, expectedInputVersion = run.input_version, authorize }) {
    const operation = operationContext();
    const correlate = executionId => { if (operation?.sessionId) linkOperation(this.database, { ...operation, executionId, status: 'executing' }); };
    if (!provider || !resourceId || !key || !tool || !actionFamily || json(payload).length > 256000) throw durableError('INVALID_EXECUTION', 'Invalid bounded tool execution.', 400);
    const digest = effectDigest(effect);
    return this.database.atomic(() => {
      const task = this.tasks.assertRun(run, { job });
      if (task.id !== taskId || task.inputVersion !== expectedInputVersion || task.processedInputVersion !== task.inputVersion) throw durableError('TASK_DIRTY', 'Refresh the task checkpoint before dispatch.');
      const existing = this.byKey(key);
      if (existing && (existing.task_id !== taskId || existing.provider !== provider || existing.resource_id !== resourceId || effectDigest(parse(existing.effect_signature_json)) !== digest)) throw durableError('IDEMPOTENCY_CONFLICT', 'An idempotency key cannot be reused for a different task, resource or effect.');
      if (existing?.status === 'verified') { correlate(existing.id); return issuePermit(this, { execution: existing, claim: null, duplicate: true, authorize, taskId, runId: run.id, jobId: job.id, key, digest }); }
      if (isWrite && typeof authorize !== 'function') throw durableError('AUTHORIZATION_REQUIRED', 'External writes require an independent authorization decision.', 403);
      let decision = null, authority = null;
      if (isWrite) {
        // One synchronous decision serves both sides: it must name a sealed
        // authority credential, which is persisted on the intent row, and it
        // may carry the exact native money quote reserved below.
        decision = synchronousDecision(authorize({ phase: 'intent' }));
        authority = this.#authority(decision);
        if (decision.transfer != null && (!this.transfers || typeof this.transfers.isNativeQuote !== 'function' || !this.transfers.isNativeQuote(decision.transfer))) {
          throw durableError('TRANSFER_QUOTE_UNTRUSTED', 'A transaction transfer requires the exact native quote issued by this workspace.', 403);
        }
        if (this.experiences?.blocked({ taskId, actionFamily, effect })) throw durableError('ACTION_SUPPRESSED', 'The user rejected an equivalent action in this context.');
      }
      if (existing) {
        // A key that reached the provider is never POSTed again, including a
        // cancelled row whose error class says confirmed_no_effect. Reuse is
        // limited to rows that provably never dispatched, or a trusted
        // readback that established absence for a non-live/idempotent provider.
        const reusable = !existing.privacy_redacted && (
          existing.status === 'cancelled' && !existing.dispatched_at
          || existing.status === 'failed' && existing.last_error_class === 'confirmed_absent');
        if (!reusable) throw durableError('RECONCILIATION_REQUIRED', 'The existing intent must be reconciled before another dispatch.');
        const at = iso(this.database.now());
        this.db.prepare(`UPDATE tool_executions SET task_run_id=?,job_id=?,plan_step_id=?,status='intent',payload_json=?,result_json=NULL,provider_receipt_id=NULL,
          authority_json=?,input_version=?,run_generation=?,privacy_epoch=?,dispatched_at=NULL,last_error_class=NULL,updated_at=? WHERE id=? AND status=?`)
          .run(run.id, job.id, planStepId, json(payload), json(authority), task.inputVersion, task.runGeneration, task.privacyEpoch, at, existing.id, existing.status);
        const claim = isWrite ? this.claims.acquire({ provider, resourceId, runId: run.id, owner: job.lease_owner, executionId: existing.id }) : null;
        if (claim) this.db.prepare('UPDATE tool_executions SET lease_owner=?,lease_token=? WHERE id=?').run(claim.owner, claim.token, existing.id);
        const number = this.db.prepare('SELECT COALESCE(MAX(attempt_number),0)+1 n FROM execution_attempts WHERE execution_id=?').get(existing.id).n;
        this.db.prepare('INSERT INTO execution_attempts VALUES(?,?,?,?,\'intent\',?,?)').run(existing.id, number, job.id, job.lease_token, at, at);
        correlate(existing.id);
        const money = this.#reserveTransfer(decision, { execution: this.get(existing.id), number, binding: this.#moneyBinding({ provider, tool, actionFamily, taskId, inputVersion: task.inputVersion, privacyEpoch: task.privacyEpoch, resourceId, payload, effect, decision }) });
        return issuePermit(this, { execution: this.get(existing.id), claim, duplicate: false, authorize, taskId, runId: run.id, jobId: job.id, key, digest,
          transfer: decision?.transfer ?? null, hold: money.hold, moneyAttemptId: money.moneyAttemptId,
          moneyBinding: this.#moneyBinding({ provider, tool, actionFamily, taskId, inputVersion: task.inputVersion, privacyEpoch: task.privacyEpoch, resourceId, payload, effect, decision }) });
      }
      const id = randomUUID(), at = iso(this.database.now());
      this.db.prepare(`INSERT INTO tool_executions(id,task_id,task_run_id,job_id,plan_step_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,payload_json,
        conditional_version,provider_idempotent,authority_json,input_version,run_generation,privacy_epoch,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'intent',?,?,?,?,?,?,?,?,?,?)`).run(id, taskId, run.id, job.id, planStepId, provider, tool, actionFamily, resourceId, key, json(effect), Number(isWrite), json(payload), conditionalVersion == null ? null : String(conditionalVersion), Number(providerIdempotent), authority ? json(authority) : null, task.inputVersion, task.runGeneration, task.privacyEpoch, at, at);
      const claim = isWrite ? this.claims.acquire({ provider, resourceId, runId: run.id, owner: job.lease_owner, executionId: id }) : null;
      if (claim) this.db.prepare('UPDATE tool_executions SET lease_owner=?,lease_token=? WHERE id=?').run(claim.owner, claim.token, id);
      this.db.prepare('INSERT INTO execution_attempts VALUES(?,1,?,?,\'intent\',?,?)').run(id, job.id, job.lease_token, at, at);
      this.database.lineage('task_run', run.id, 'execution', id);
      if (planStepId) this.database.lineage('plan_step', planStepId, 'execution', id);
      correlate(id);
      const moneyBinding = this.#moneyBinding({ provider, tool, actionFamily, taskId, inputVersion: task.inputVersion, privacyEpoch: task.privacyEpoch, resourceId, payload, effect, decision });
      const money = this.#reserveTransfer(decision, { execution: this.get(id), number: 1, binding: moneyBinding });
      return issuePermit(this, { execution: this.get(id), claim, duplicate: false, authorize, taskId, runId: run.id, jobId: job.id, key, digest,
        transfer: decision?.transfer ?? null, hold: money.hold, moneyAttemptId: money.moneyAttemptId, moneyBinding });
    });
  }
  #requireFresh(state) {
    const row = this.get(state.executionId);
    if (!row || row.idempotency_key !== state.key || effectDigest(parse(row.effect_signature_json)) !== state.digest
      || row.task_id !== state.snapshot.task_id || row.provider !== state.snapshot.provider || row.resource_id !== state.snapshot.resource_id
      || row.is_write !== state.snapshot.is_write) {
      throw durableError('PERMIT_INVALID', 'This dispatch permit no longer matches its persisted execution record.', 403);
    }
    return row;
  }
  #authority(decision) {
    if (decision?.then || decision?.allowed !== true || !isAuthorityCredential(decision.credential)) throw durableError('AUTHORIZATION_REQUIRED', 'The policy engine did not authorize this write.', 403);
    return { kind: decision.credential.kind, id: decision.credential.id, version: Number(decision.credential.version) || 1 };
  }
  async dispatch(permit, { run, job, send, verify = null, signal = null, deferDispatch = false, live = false }) {
    const state = permitState(permit, this);
    if (state.duplicate) return state.duplicateResult;
    // A permit is bound to the run and job that obtained it; it cannot be
    // carried into another run's dispatch.
    if (run?.id !== state.runId || job?.id !== state.jobId) throw durableError('PERMIT_INVALID', 'This dispatch permit belongs to another run.', 403);
    if (state.dispatching || state.consumed) throw durableError('PERMIT_CONSUMED', 'This dispatch permit was already dispatched.', 409);
    const persistedRun = this.db.prepare('SELECT * FROM task_runs WHERE id=?').get(state.runId);
    if (!persistedRun || persistedRun.task_id !== state.taskId || persistedRun.job_id !== state.jobId
      || ['task_id', 'job_id', 'job_lease_token', 'input_version', 'run_generation', 'privacy_epoch'].some(field => persistedRun[field] !== run[field])
      || job.task_id !== state.taskId || job.lease_token !== persistedRun.job_lease_token) {
      throw durableError('PERMIT_INVALID', 'This permit requires its persisted task run and job lease.', 403);
    }
    const snapshot = state.snapshot, claim = state.claim;
    const opening = this.#requireFresh(state);
    if (opening.status !== 'intent') {
      if (opening.status === 'verified') return parse(opening.result_json);
      throw durableError('RECONCILIATION_REQUIRED', 'This execution was already dispatched or must be reconciled before another dispatch.', 409);
    }
    // The dispatching flag is set synchronously, so a concurrent second call
    // fails before the first one yields and can never reach the provider.
    if (state.dispatching || state.consumed) throw durableError('PERMIT_CONSUMED', 'This dispatch permit was already dispatched.', 409);
    state.dispatching = true;
    let markerCommitted = false;
    const beforeDispatch = () => {
      // A provider may cross or repeat its guarded boundary more than once.
      // After the first committed marker, later callback invocations must do
      // nothing at all: no fresh authorization decision and no second effect.
      if (markerCommitted) throw durableError('PERMIT_CONSUMED', 'This dispatch boundary was already crossed.', 409);
      if (state.markerActive) throw durableError('EXECUTION_CHANGED', 'The dispatch boundary is already being crossed.');
      state.markerActive = true;
      try {
        this.database.atomic(() => {
          controller.signal.throwIfAborted(); signal?.throwIfAborted();
          this.tasks.preResume(run, job); this.tasks.assertRun(run, { job });
          const current = this.#requireFresh(state);
          if (current.status !== 'intent') throw durableError('EXECUTION_CHANGED', 'This intent was already dispatched or changed.');
          if (claim && !this.claims.owns(claim)) throw durableError('LEASE_LOST', 'The resource claim expired before dispatch.');
          if (this.experiences?.blocked({ taskId: current.task_id, actionFamily: current.action_family, effect: parse(current.effect_signature_json) })) throw durableError('ACTION_SUPPRESSED', 'This action was stopped by user feedback.');
          if (current.is_write === 1) {
            if (typeof state.authorize !== 'function') throw durableError('AUTHORIZATION_REQUIRED', 'External writes require an independent authorization decision.', 403);
            // The intent stores the credential it was authorized by. Dispatch
            // re-decides with the beforeDispatch phase and refuses any drift,
            // so a revoked, replaced or spent approval cannot reach the provider.
            const stored = parse(current.authority_json);
            if (!stored) throw durableError('AUTHORIZATION_REQUIRED', 'An intent without a stored authorization cannot be dispatched.', 403);
            const decision = synchronousDecision(state.authorize({ phase: 'beforeDispatch' }));
            const authority = this.#authority(decision);
            if (authority.kind !== stored.kind || authority.id !== stored.id || Number(stored.version) !== authority.version || stored.spent === true) {
              throw durableError('AUTHORIZATION_REQUIRED', 'Authorization changed before dispatch.', 403);
            }
            if (state.transfer != null) {
              if (decision?.transfer !== state.transfer || !this.transfers?.isNativeQuote(decision.transfer)) throw durableError('AUTHORIZATION_REQUIRED', 'The monetary authority changed before dispatch.', 403);
              if (!state.hold) throw durableError('TRANSFER_QUOTE_UNTRUSTED', 'The transaction reservation is missing.', 403);
              // The money marker rechecks expiry, currency, grant version and
              // balances and refuses a repeated dispatch. It shares this SQL
              // transaction, so a failure here rolls back the tool marker too.
              this.transfers.markDispatched(state.hold, state.moneyBinding);
            }
          }
          // A one-shot approval is spent by the committed marker; it can never
          // start a second provider call.
          const spent = current.is_write === 1 && parse(current.authority_json)?.kind === 'approval';
          const changed = this.db.prepare(`UPDATE tool_executions SET status='dispatched',dispatched_at=?,authority_json=?,updated_at=? WHERE id=? AND status='intent'`)
            .run(iso(this.database.now()), spent ? json({ ...parse(current.authority_json), spent: true }) : current.authority_json, iso(this.database.now()), state.executionId).changes;
          if (!changed) throw durableError('EXECUTION_CHANGED', 'This intent was already dispatched.');
          this.db.prepare("UPDATE execution_attempts SET state='dispatched',updated_at=? WHERE execution_id=? AND job_id=? AND lease_token=?").run(iso(this.database.now()), state.executionId, job.id, job.lease_token);
        });
        // In-memory permit state changes only after the marker transaction has
        // committed. A rollback leaves this permit retryable; a commit makes it
        // single-use before send() can run.
        markerCommitted = true; state.markerCommitted = true; state.consumed = true;
      } finally { state.markerActive = false; }
    };
    const controller = new AbortController();
    let timer;
    const heartbeat = claim ? setInterval(() => { try { if (!this.jobs.heartbeat(job) || !this.claims.renew(claim)) controller.abort(durableError('LEASE_LOST', 'Execution ownership was lost.')); } catch { controller.abort(durableError('LEASE_LOST', 'Execution renewal could not be persisted.')); } }, Math.max(10, Math.floor(this.claims.leaseMs / 3))) : null;
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(durableError(snapshot.is_write ? 'OUTCOME_UNKNOWN' : 'TOOL_READ_TIMEOUT', snapshot.is_write ? 'The external outcome is unknown after a timeout. Reconcile before retrying.' : 'The read tool timed out.', snapshot.is_write ? 409 : 504)); }, this.timeoutMs); });
      const result = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); signal?.throwIfAborted(); if (!deferDispatch) beforeDispatch(); return send(AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), beforeDispatch); }), deadline]);
      if (!markerCommitted) throw durableError('DISPATCH_GUARD_REQUIRED', 'The provider did not enter its guarded dispatch boundary.');
      this.tasks.assertRun(run, { job, allowDirty: true });
      if (claim && !this.claims.owns(claim)) throw durableError('LEASE_LOST', 'Execution ownership was lost before recording the result.');
      const current = this.#requireFresh(state);
      if (current.status !== 'dispatched') throw durableError('EXECUTION_CHANGED', 'The execution changed while the provider call was running.');
      // The persisted is_write flag decides receipt verification and unknown
      // classification. The permit's exposed snapshot is only an assertion,
      // never authority to downgrade a write to a read.
      const isWrite = current.is_write === 1;
      this.database.atomic(() => {
        this.tasks.assertRun(run, { job, allowDirty: true });
        const changed = this.db.prepare('UPDATE tool_executions SET status=?,result_json=?,provider_receipt_id=?,updated_at=? WHERE id=? AND status=\'dispatched\'')
          .run(isWrite ? 'accepted' : 'verified', json(result), result?.id || result?.receiptId || null, iso(this.database.now()), state.executionId).changes;
        if (!changed) throw durableError('EXECUTION_CHANGED', 'The execution changed while recording its result.');
        this.db.prepare('UPDATE execution_attempts SET state=?,updated_at=? WHERE execution_id=? AND job_id=? AND lease_token=?').run(isWrite ? 'accepted' : 'verified', iso(this.database.now()), state.executionId, job.id, job.lease_token);
        updateOperationExecution(this.database, state.executionId, isWrite ? 'accepted' : 'verified');
      });
      if (isWrite && verify) {
        // Read-back gets its own bounded budget so a slow provider call cannot
        // consume the verification window. A miss stays OUTCOME_UNKNOWN.
        let verifyTimer;
        const verifyDeadline = new Promise((_, reject) => { verifyTimer = setTimeout(() => { controller.abort(); reject(durableError('OUTCOME_UNKNOWN', 'The read-back outcome is unknown after a timeout. Reconcile before retrying.', 409)); }, this.timeoutMs); });
        try {
          const verification = await Promise.race([Promise.resolve().then(() => verify(result)), verifyDeadline]);
          const receipt = verification?.receipt || result;
          if (verification?.status !== 'found' || !this.#receiptMatches(current, receipt, live)) throw durableError('OUTCOME_UNKNOWN', 'Provider acceptance could not be verified.');
          this.verified(state.executionId, receipt, { run, job, claim, fromPredicate: true, live, evidence: verification });
        } finally { clearTimeout(verifyTimer); }
      }
      return result;
    } catch (error) {
      // Fenced-out workers cannot record a result, even if their remote call
      // completed. A new recovery owner must reconcile that execution.
      if (this.jobs.owns(job) && (!claim || this.claims.owns(claim))) {
        const current = this.get(state.executionId);
        if (current && unresolved.includes(current.status)) this.database.atomic(() => {
          const isWrite = current.is_write === 1;
          const knownNotDispatched = current.status === 'intent' && !current.dispatched_at;
          // A provider that documents "no message created" proves absence even
          // after the marker, but only a non-live attempt may be cancelled from
          // a bare definitiveNoEffect: a live send that left would duplicate.
          const documentedAbsence = current.status === 'dispatched' && current.dispatched_at && error.noMessageCreated === true;
          const safeCancel = knownNotDispatched || current.status === 'dispatched' && error.definitiveNoEffect === true && live !== true && error.noMessageCreated !== true;
          const status = documentedAbsence ? 'failed' : safeCancel ? 'cancelled' : isWrite ? 'unknown' : 'failed';
          const errorClass = documentedAbsence ? 'confirmed_absent' : safeCancel ? 'confirmed_no_effect' : error.code || 'external_failure';
          this.db.prepare('UPDATE tool_executions SET status=?,last_error_class=?,updated_at=? WHERE id=? AND status!=\'verified\'').run(status, errorClass, iso(this.database.now()), state.executionId);
          this.db.prepare('UPDATE execution_attempts SET state=?,updated_at=? WHERE execution_id=? AND job_id=? AND lease_token=?').run(status, iso(this.database.now()), state.executionId, job.id, job.lease_token);
          updateOperationExecution(this.database, state.executionId, status, { errorClass });
          if (claim) (documentedAbsence || safeCancel) ? this.claims.release(claim) : this.claims.unresolved(claim);
        });
        this.#settleFailedTransfer(state, error);
      }
      const latest = this.get(state.executionId);
      // A proven absence is no longer ambiguous; anything else that may have
      // touched the provider keeps the task in reconciliation.
      error.ambiguous = latest?.is_write === 1 && latest?.status !== 'cancelled'
        && !(latest?.status === 'failed' && latest.last_error_class === 'confirmed_absent'); throw error;
    } finally { state.dispatching = false; clearTimeout(timer); if (heartbeat) clearInterval(heartbeat); }
  }
  #settleFailedTransfer(state, error) {
    if (!state.hold || !this.transfers) return;
    const binding = this.#moneyAttempt(state.executionId);
    if (!binding) return;
    try {
      const info = this.transfers.attemptInfo(binding.money_attempt_id);
      if (info?.state === 'reserved') {
        // Nothing reached the provider, so the hold is released only through
        // the core's proven predispatch cancellation.
        this.transfers.cancelAttempt(binding.money_attempt_id);
      } else if (error.definitiveNoEffect === true) {
        // The marker was committed but the provider proved it applied nothing.
        this.transfers.settleAttempt(binding.money_attempt_id, { actualMicros: 0, receiptRef: `no-effect:${state.executionId}` });
      } else {
        // A dispatched or accepted transfer with no settled value keeps the
        // whole hold. Only trusted reconciliation may settle it later.
        this.transfers.markUnknownAttempt(binding.money_attempt_id);
      }
    } catch (moneyError) {
      try { error.moneyError = moneyError?.code || 'MONEY_RECONCILIATION_REQUIRED'; } catch { /* frozen error */ }
    }
  }
  #receiptMatches(execution, result, live = false) {
    if (!validReceipt(result, { key: execution.idempotency_key, receiptId: execution.provider_receipt_id })) return false;
    if (live && execution.action_family === 'email.send' && result?.idempotencyKey !== execution.idempotency_key) return false;
    return true;
  }
  #evidence(execution, result, status) {
    const receiptId = result?.id || result?.receiptId || result?.receipt?.id || null;
    if (execution.privacy_redacted) return { status, receiptId };
    const detail = result?.detail || result?.receipt?.detail;
    return { status, via: result?.via || null, messageId: result?.messageId || result?.receipt?.messageId || null, receiptId, checkedAt: iso(this.database.now()), detail: typeof detail === 'string' ? detail.slice(0, 500) : null };
  }
  verified(id, result, { run = null, job = null, claim = null, fromPredicate = false, live = false, evidence = null } = {}) {
    return this.database.atomic(() => {
      if (run) this.tasks.assertRun(run, { job, allowDirty: true });
      const current = this.get(id); if (!current) throw durableError('MISSING_EXECUTION', 'Execution no longer exists.');
      if (current.status === 'verified') return current;
      if (!fromPredicate) throw durableError('INVALID_RECEIPT', 'Verification requires the read-back predicate for this execution.');
      if (claim && !this.claims.owns(claim)) throw durableError('LEASE_LOST', 'The resource claim expired before recording verification.');
      if (!this.#receiptMatches(current, result, live)) throw durableError('INVALID_RECEIPT', 'The provider receipt is missing or belongs to another operation.');
      const stored = current.privacy_redacted ? { id: result?.id || result?.receiptId || null, provider: current.provider, status: 'verified' } : result;
      const record = this.#evidence(current, evidence || result, 'found');
      this.db.prepare("UPDATE tool_executions SET status='verified',result_json=?,evidence_json=?,provider_receipt_id=COALESCE(?,provider_receipt_id),verified_at=?,updated_at=? WHERE id=? AND status!='verified'")
        .run(json(stored), json(record), result?.id || result?.receiptId || null, iso(this.database.now()), iso(this.database.now()), id);
      this.db.prepare("UPDATE execution_attempts SET state='verified',updated_at=? WHERE execution_id=? AND job_id=?").run(iso(this.database.now()), id, current.job_id);
      updateOperationExecution(this.database, id, 'verified');
      const storedClaim = this.db.prepare('SELECT * FROM resource_claims WHERE current_execution_id=?').get(id);
      if (storedClaim) this.claims.release(claim || { userId: storedClaim.user_id, provider: storedClaim.provider, resourceId: storedClaim.resource_id, owner: storedClaim.lease_owner, token: storedClaim.lease_token, executionId: id });
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'outcome\',?,?)').run(id, iso(this.database.now()));
      this.database.lineage('execution', id, 'outcome', id); return this.get(id);
    });
  }
  async reconcile(id, provider, { assertOwned = () => {} } = {}) {
    const execution = this.get(id); if (!execution) throw durableError('MISSING_EXECUTION', 'Unknown execution.', 404);
    if (execution.status === 'verified') return { status: 'found', receipt: parse(execution.result_json), evidence: parse(execution.evidence_json) };
    if (!provider?.lookup) return { status: 'unknown', manual: true };
    const controller = new AbortController(); let timer, result;
    try {
      result = await Promise.race([provider.lookup(execution.idempotency_key, { receiptId: execution.provider_receipt_id, conditionalVersion: execution.conditional_version, signal: controller.signal }), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'unknown' }); }, this.timeoutMs); })]);
    } finally { clearTimeout(timer); }
    assertOwned();
    return this.database.atomic(() => {
      const current = this.get(id);
      if (!current) return { status: 'unknown' };
      if (current.status === 'verified') return { status: 'found', receipt: parse(current.result_json), evidence: parse(current.evidence_json) };
      if (!unresolved.includes(current.status)) return { status: current.status || 'unknown' };
      const money = this.#moneyAttempt(id);
      if (result?.status === 'found' && this.#receiptMatches(current, result.receipt, provider.live === true)) {
        this.verified(id, result.receipt, { fromPredicate: true, live: provider.live === true, evidence: result });
        if (money) {
          const info = this.transfers?.attemptInfo(money.money_attempt_id);
          if (info && info.state !== 'settled' && info.state !== 'cancelled') {
            // Trusted readback may carry an explicit actual amount. A receipt
            // alone never proves the settled value, so the hold stays unknown
            // rather than being collapsed to the quote or to zero.
            if (Number.isSafeInteger(result.actualMicros) && result.actualMicros >= 0) {
              this.transfers.settleAttempt(money.money_attempt_id, { actualMicros: result.actualMicros, receiptRef: result.receiptRef || result.receipt?.id || `readback:${id}` });
            } else {
              this.transfers.markUnknownAttempt(money.money_attempt_id);
            }
          }
        }
        return result;
      }
      if (result?.status === 'not_found' && provider.live !== true && (execution.provider_idempotent || provider.reliableAbsence === true)) {
        this.db.prepare("UPDATE tool_executions SET status='failed',last_error_class='confirmed_absent',evidence_json=?,updated_at=? WHERE id=? AND status!='verified'").run(json(this.#evidence(current, result, 'not_found')), iso(this.database.now()), id);
        const claim = this.db.prepare('SELECT * FROM resource_claims WHERE current_execution_id=?').get(id);
        if (claim) this.claims.release({ userId: claim.user_id, provider: claim.provider, resourceId: claim.resource_id, owner: claim.lease_owner, token: claim.lease_token, executionId: id });
        updateOperationExecution(this.database, id, 'failed', { errorClass: 'confirmed_absent' });
        if (money) {
          const info = this.transfers?.attemptInfo(money.money_attempt_id);
          if (info && info.state !== 'settled' && info.state !== 'cancelled') {
            if (info.state === 'reserved') this.transfers.cancelAttempt(money.money_attempt_id);
            // A confirmed absence after the dispatch boundary is a trusted
            // zero settlement with a receipt; it is never a silent refund.
            else this.transfers.settleAttempt(money.money_attempt_id, { actualMicros: 0, receiptRef: `absence:${id}` });
          }
        }
        return { status: 'not_found', safeToRetry: true };
      }
      this.db.prepare("UPDATE tool_executions SET status='unknown',last_error_class='reconciliation_inconclusive',evidence_json=?,updated_at=? WHERE id=? AND status!='verified'").run(json(this.#evidence(current, result, 'unknown')), iso(this.database.now()), id);
      updateOperationExecution(this.database, id, 'unknown', { errorClass: 'reconciliation_inconclusive' });
      if (money) {
        const info = this.transfers?.attemptInfo(money.money_attempt_id);
        if (info && (info.state === 'reserved' || info.state === 'dispatched')) this.transfers.markUnknownAttempt(money.money_attempt_id);
      }
      return { status: 'unknown', manual: true, detail: 'The provider cannot establish safe absence. No retry was authorized.' };
    });
  }
  markInconclusive(id) {
    return this.database.atomic(() => {
      const current = this.get(id);
      if (!current || current.status === 'verified') return current || null;
      this.db.prepare("UPDATE tool_executions SET status='unknown',last_error_class='reconciliation_inconclusive',updated_at=? WHERE id=? AND status!='verified'").run(iso(this.database.now()), id);
      return this.get(id);
    });
  }
  attestAbsent(id) {
    return this.database.atomic(() => {
      const current = this.get(id);
      if (!current) throw durableError('MISSING_EXECUTION', 'Unknown execution.', 404);
      if (current.status === 'verified') throw durableError('RECONCILIATION_REQUIRED', 'A verified send cannot be attested absent.');
      this.db.prepare("UPDATE tool_executions SET status='failed',last_error_class='user_attested_absent',updated_at=? WHERE id=? AND status!='verified'").run(iso(this.database.now()), id);
      const claim = this.db.prepare('SELECT * FROM resource_claims WHERE current_execution_id=?').get(id);
      if (claim) this.claims.release({ userId: claim.user_id, provider: claim.provider, resourceId: claim.resource_id, owner: claim.lease_owner, token: claim.lease_token, executionId: id });
      return this.get(id);
    });
  }
  #releaseClaim(executionId) {
    const claim = this.db.prepare('SELECT * FROM resource_claims WHERE current_execution_id=?').get(executionId);
    if (!claim) return;
    this.claims.release({ userId: claim.user_id, provider: claim.provider, resourceId: claim.resource_id, owner: claim.lease_owner, token: claim.lease_token, executionId });
  }
  #withholdDraft(row, state) {
    const task = state?.tasks?.[row.task_id];
    if (!task?.action || task.action.idempotencyKey !== row.idempotency_key) return;
    task.actionHistory = [...(task.actionHistory || []), { ...task.action, status: 'withheld_before_dispatch' }].slice(-50);
    task.action = null;
    if (!['completed', 'cancelled'].includes(task.status)) task.status = 'ready_for_approval';
    task.guidanceReviewRequired = true;
    task.reason = 'Nothing was sent. Approval or YOLO is no longer active.';
  }
  cancelUndispatched({ kind = null, id = null, taskId = null, idPrefix = null, state = null } = {}) {
    const run = () => {
      const rows = this.db.prepare("SELECT * FROM tool_executions WHERE status='intent' AND dispatched_at IS NULL AND is_write=1").all().filter(row => {
        if (taskId && row.task_id !== taskId) return false;
        if (!kind && !id && !idPrefix) return Boolean(taskId);
        const authority = parse(row.authority_json);
        if (!authority) return false;
        if (kind && authority.kind !== kind) return false;
        if (id && authority.id !== id) return false;
        if (idPrefix && !String(authority.id || '').startsWith(idPrefix)) return false;
        return true;
      });
      const at = iso(this.database.now());
      for (const row of rows) {
        const changed = this.db.prepare("UPDATE tool_executions SET status='cancelled',last_error_class='confirmed_no_effect',updated_at=? WHERE id=? AND status='intent' AND dispatched_at IS NULL").run(at, row.id).changes;
        if (!changed) continue;
        this.#releaseClaim(row.id);
        if (state) this.#withholdDraft(row, state);
        else this.#withholdDraftRow(row);
      }
      return rows.length;
    };
    return this.database.atomic(run);
  }
  #withholdDraftRow(row) {
    const task = this.db.prepare('SELECT data_json,version,status FROM tasks WHERE id=?').get(row.task_id);
    if (!task) return;
    const data = parse(task.data_json);
    if (!data?.action || data.action.idempotencyKey !== row.idempotency_key) return;
    data.actionHistory = [...(data.actionHistory || []), { ...data.action, status: 'withheld_before_dispatch' }].slice(-50);
    data.action = null;
    if (!['completed', 'cancelled'].includes(data.status)) data.status = 'ready_for_approval';
    data.guidanceReviewRequired = true;
    data.reason = 'Nothing was sent. Approval or YOLO is no longer active.';
    this.db.prepare('UPDATE tasks SET data_json=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(json(data), data.status, iso(this.database.now()), row.task_id, task.version);
  }
  cancelMissingAuthority() {
    return this.database.atomic(() => {
      const rows = this.db.prepare("SELECT id FROM tool_executions WHERE status='intent' AND dispatched_at IS NULL AND is_write=1 AND authority_json IS NULL").all();
      const at = iso(this.database.now());
      for (const row of rows) {
        this.db.prepare("UPDATE tool_executions SET status='cancelled',last_error_class='confirmed_no_effect',updated_at=? WHERE id=? AND status='intent'").run(at, row.id);
        this.#releaseClaim(row.id);
      }
      return rows.length;
    });
  }
  recoverUnfinished() {
    return this.database.atomic(() => {
      const at = iso(this.database.now());
      const rows = this.db.prepare("SELECT id,task_id FROM tool_executions WHERE is_write=1 AND status IN ('dispatched','accepted')").all();
      const changed = this.db.prepare("UPDATE tool_executions SET status='unknown',last_error_class='process_interrupted',updated_at=? WHERE is_write=1 AND status IN ('dispatched','accepted')").run(at).changes;
      for (const row of rows) {
        updateOperationExecution(this.database, row.id, 'unknown', { errorClass: 'process_interrupted' });
        // A restart cannot prove a dispatched transfer stopped or settled.
        // Keep the whole hold unknown across the process boundary.
        const money = this.#moneyAttempt(row.id);
        if (money) {
          const info = this.transfers?.attemptInfo(money.money_attempt_id);
          if (info && (info.state === 'reserved' || info.state === 'dispatched')) this.transfers.markUnknownAttempt(money.money_attempt_id);
        }
      }
      // Restart recovery must leave every accepted write with a way to
      // converge. Importing a legacy action creates this job, but an execution
      // that already had a ledger row is intentionally skipped by that import.
      for (const row of rows) {
        const existing = this.db.prepare("SELECT 1 FROM jobs WHERE queue_name='reconcile' AND job_type='reconcile_execution' AND state IN ('queued','retry_wait','running','recovery_required') AND json_extract(payload_json,'$.executionId')=?").get(row.id);
        if (!existing) this.jobs.enqueue({ queue: 'reconcile', type: 'reconcile_execution', key: `recover:${row.id}`, taskId: row.task_id, payload: { executionId: row.id } });
      }
      return changed;
    });
  }
}
