import { bindModelFetchBoundary } from '../model-fetch-boundary.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';

/**
 * Private durable state for one semantic reasoning session.
 *
 * This service owns the conversation, per-call intent and final-answer window.
 * It is deliberately separate from the public task record: prompts, tool
 * arguments, tool results and a not-yet-committed final answer never enter
 * task.reasoningWork, publicState, an API response or an SSE event.
 *
 * The content identity of a session is a fingerprint of stable inputs. A job
 * attempt, lease token, run id or run generation is an ownership fence, never a
 * conversation identity: a budget-deferred turn can resume under a new run or
 * job without replaying completed tool work.
 *
 * Ownership is checked again in the same short transaction as every write:
 *   - a task session names a real running job with its current lease token;
 *   - a workspace session names an opaque owner and short renewable lease.
 * An expired owner can be replaced. Its late writes then fail the fence.
 *
 * The AsyncLocalStorage operation context only *correlates* a tool execution
 * with an operation id. It never grants authority; every tool still checks the
 * real task, policy, grant and current-run state.
 */

export const SESSION_LIMITS = Object.freeze({
  maxActive: 64,
  conversationChars: 32000,
  turns: 4,
  calls: 8,
  ttlMs: 24 * 60 * 60 * 1000,
  workspaceLeaseMs: 30000,
  rejectFinalLimit: 2,
  finalChars: 32000,
  sourceRefs: 32,
  operationChars: 16000,
  toolResultChars: 6000
});

const STAGES = Object.freeze(['interpret', 'discovery', 'planning', 'verification', 'general']);
const SCOPES = Object.freeze(['workspace', 'task']);
const TERMINAL_OPERATION = Object.freeze(['completed', 'unknown', 'reconciliation_required']);

const sessionError = (code, message, status = 409) => durableError(code, message, status);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export const stableDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

function boundedJson(value, max, code, message) {
  let encoded;
  try { encoded = json(value); } catch { throw sessionError(code, message, 400); }
  if (encoded.length > max) throw sessionError(code, message, 400);
  return encoded;
}

function validateSourceRefs(sourceRefs, now) {
  if (sourceRefs == null) return [];
  if (!Array.isArray(sourceRefs) || sourceRefs.length > SESSION_LIMITS.sourceRefs) {
    throw sessionError('INVALID_SESSION', 'Session source references must be a bounded array.', 400);
  }
  return sourceRefs.map(reference => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || !text(reference.kind, 80) || !text(reference.id, 200)
      || reference.validUntil != null && (typeof reference.validUntil !== 'string' || Number.isNaN(Date.parse(reference.validUntil)))) {
      throw sessionError('INVALID_SESSION', 'Each session source reference needs a kind, id and optional validUntil.', 400);
    }
    if (reference.validUntil && Date.parse(reference.validUntil) <= now) {
      throw sessionError('SESSION_SOURCE_EXPIRED', 'The bounded source validity ended before this session could start.', 409);
    }
    return { kind: reference.kind, id: reference.id, ...(reference.validUntil ? { validUntil: reference.validUntil } : {}) };
  });
}

function validateBindings(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw sessionError('INVALID_SESSION', 'A session requires stable bindings for its content identity.', 400);
  }
  for (const key of ['authorityVersion', 'privacyEpoch', 'contextVersion', 'inputVersion', 'catalogVersion']) {
    const value = bindings[key];
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw sessionError('INVALID_SESSION', `Session bindings must include ${key}.`, 400);
    }
  }
  let encoded;
  try { encoded = canonical(bindings); } catch { throw sessionError('INVALID_SESSION', 'Session bindings must be JSON-encodable.', 400); }
  if (encoded.length > 16000) throw sessionError('INVALID_SESSION', 'Session bindings are too large.', 400);
  return encoded;
}

function normalizeOwner(owner, { workspaceLeaseMs, now }) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw sessionError('INVALID_SESSION_OWNER', 'A session needs a trusted job or workspace owner.', 400);
  }
  if (owner.kind === 'job') {
    const job = owner.job;
    if (!job || typeof job !== 'object' || !text(job.id, 200) || !text(job.lease_owner, 200)
      || !Number.isSafeInteger(job.lease_token)) {
      throw sessionError('INVALID_SESSION_OWNER', 'A job-owned session needs the current running job and lease token.', 400);
    }
    return { kind: 'job', id: job.id, token: String(job.lease_token), label: job.lease_owner, job };
  }
  if (owner.kind === 'workspace') {
    if (!text(owner.ownerId, 200)) throw sessionError('INVALID_SESSION_OWNER', 'A workspace session needs an opaque owner id.', 400);
    return {
      kind: 'workspace',
      id: owner.ownerId,
      token: text(owner.token, 200) ? owner.token : randomUUID(),
      label: owner.ownerId,
      until: iso(now + workspaceLeaseMs)
    };
  }
  throw sessionError('INVALID_SESSION_OWNER', "Session owner kind must be 'job' or 'workspace'.", 400);
}

/** Correlation context for tool execution. It carries no authority. */
const operationStorage = new AsyncLocalStorage();

export function operationContext() { return operationStorage.getStore() || null; }

export function runWithOperation(operation, callback) { return operationStorage.run(operation, callback); }

export function addOperationSources(sources) {
  const store = operationContext();
  if (!store || !Array.isArray(sources)) return store;
  const current = Array.isArray(store.sourceRefs) ? store.sourceRefs : [];
  const merged = [...current];
  for (const source of sources) {
    if (!source || !text(source.kind, 80) || !text(source.id, 200)) continue;
    if (!merged.some(item => item.kind === source.kind && item.id === source.id)) merged.push({ kind: source.kind, id: source.id });
  }
  store.sourceRefs = merged.slice(0, SESSION_LIMITS.sourceRefs);
  return store;
}

const knownTables = new WeakMap();
function hasTable(db, table) {
  let known = knownTables.get(db);
  if (!known) { known = new Map(); knownTables.set(db, known); }
  if (known.has(table)) return known.get(table);
  const found = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  known.set(table, found);
  return found;
}

/**
 * Associate an already-authenticated tool operation with its real execution
 * or local durable record. Callers invoke this inside the same database
 * transaction that writes the execution/receipt.
 */
export function linkOperation(database, {
  sessionId, operationId, turn = 0, callIndex = 0, tool = 'tool', effect = 'write',
  argsDigest = null, args = null, status = 'executing', executionId = null, localRef = null,
  sourceRefs = null
} = {}) {
  if (!database?.db || !sessionId || !operationId) return false;
  const db = database.db;
  if (!hasTable(db, 'reasoning_session_operations') || !hasTable(db, 'reasoning_sessions')) return false;
  if (!db.prepare('SELECT 1 FROM reasoning_sessions WHERE id=?').get(sessionId)) return false;
  const at = iso(database.now());
  const existing = db.prepare('SELECT status FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(sessionId, operationId);
  if (existing && TERMINAL_OPERATION.includes(existing.status) && status !== existing.status) return false;
  const argsJson = args === undefined ? null : boundedJson(args, SESSION_LIMITS.operationChars, 'INVALID_SESSION', 'Tool arguments are too large.');
  const refs = Array.isArray(sourceRefs) ? sourceRefs.filter(item => item && text(item.kind, 80) && text(item.id, 200)).slice(0, SESSION_LIMITS.sourceRefs) : null;
  db.prepare(`INSERT INTO reasoning_session_operations
    (session_id,operation_id,turn,call_index,tool,effect,args_digest,args_json,status,execution_id,local_ref,source_refs_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id,operation_id) DO UPDATE SET
      execution_id=COALESCE(excluded.execution_id,reasoning_session_operations.execution_id),
      local_ref=COALESCE(excluded.local_ref,reasoning_session_operations.local_ref),
      source_refs_json=COALESCE(excluded.source_refs_json,reasoning_session_operations.source_refs_json),
      status=CASE WHEN reasoning_session_operations.status IN ('completed','unknown','reconciliation_required')
        THEN reasoning_session_operations.status ELSE excluded.status END,
      updated_at=excluded.updated_at`)
    .run(sessionId, operationId, Math.max(0, Number(turn) || 0), Math.max(0, Number(callIndex) || 0), tool, effect,
      argsDigest, argsJson, status, executionId, localRef, refs ? json(refs) : null, at, at);
  return true;
}

/** Mirror a real execution outcome onto any correlated private operation. */
export function updateOperationExecution(database, executionId, status, { errorClass = null } = {}) {
  if (!database?.db || !executionId) return 0;
  const db = database.db;
  if (!hasTable(db, 'reasoning_session_operations') || !hasTable(db, 'reasoning_sessions')) return 0;
  const mapped = status === 'verified' ? 'completed'
    : status === 'unknown' ? 'unknown'
      : status === 'cancelled' || status === 'failed' ? 'failed'
        : status === 'accepted' || status === 'dispatched' ? 'executing' : null;
  if (!mapped) return 0;
  return db.prepare('UPDATE reasoning_session_operations SET status=?,error_class=COALESCE(?,error_class),updated_at=? WHERE execution_id=?')
    .run(mapped, errorClass == null ? null : String(errorClass).slice(0, 80), iso(database.now()), executionId).changes;
}

export class DurableReasoningSessions {
  #contextObservers = new WeakMap();

  watchContext(spec, observer) {
    if (!spec || typeof spec !== 'object' || typeof observer !== 'function' || this.#contextObservers.has(spec)) {
      throw sessionError('INVALID_SESSION', 'A context needs one native observer.', 400);
    }
    this.#contextObservers.set(spec, { observer, started: false });
  }

  startObservedContext(spec) {
    const entry = this.#contextObservers.get(spec);
    if (!entry) return;
    if (entry.started) throw sessionError('INVALID_SESSION', 'Create a new context for each model invocation.', 409);
    entry.started = true;
  }

  captureContextTurn(spec, turn) {
    const entry = this.#contextObservers.get(spec);
    if (!entry) return;
    if (!entry.started) throw sessionError('INVALID_SESSION', 'The context invocation has not started.', 409);
    this.assertOwner({ id: turn.id, owner: turn.owner, claimId: turn.claimId, isCurrent: turn.isCurrent });
    const result = entry.observer(turn);
    if (result?.then) {
      Promise.resolve(result).catch(() => {});
      throw sessionError('INVALID_SESSION', 'A context observer must be synchronous.', 400);
    }
  }

  constructor(database, { ttlMs = SESSION_LIMITS.ttlMs, workspaceLeaseMs = SESSION_LIMITS.workspaceLeaseMs, claimLeaseMs = 60000, now = null } = {}) {
    if (!database?.db) throw new TypeError('DurableReasoningSessions requires a DurableDatabase.');
    this.database = database;
    this.db = database.db;
    this.now = typeof now === 'function' ? now : () => database.now();
    this.ttlMs = Math.max(1000, Math.min(SESSION_LIMITS.ttlMs, Number.isFinite(ttlMs) ? Math.floor(ttlMs) : SESSION_LIMITS.ttlMs));
    this.workspaceLeaseMs = Math.max(1000, Math.min(SESSION_LIMITS.ttlMs, Number.isFinite(workspaceLeaseMs) ? Math.floor(workspaceLeaseMs) : SESSION_LIMITS.workspaceLeaseMs));
    this.claimLeaseMs = Math.max(1000, Math.min(SESSION_LIMITS.ttlMs, Number.isFinite(claimLeaseMs) ? Math.floor(claimLeaseMs) : 60000));
    this.classicStorage = new AsyncLocalStorage();
    const initialize = () => {
      // This table is unreleased. An earlier unshipped draft used
      // UNIQUE(scope,logical_key), which cannot isolate two tasks that happen to
      // share a logical key. Refuse that local draft instead of deleting rows or
      // silently weakening the namespace.
      const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reasoning_sessions'").get();
      if (existing) {
        const columns = new Set(this.db.pragma('table_info(reasoning_sessions)').map(column => column.name));
        const draftConstraint = /UNIQUE\s*\(\s*scope\s*,\s*logical_key\s*\)/i.test(existing.sql || '');
        if (draftConstraint || !['claim_id', 'claim_until', 'claim_epoch'].every(column => columns.has(column))) {
          throw durableError('INCOMPATIBLE_SESSION_SCHEMA', 'This reasoning session table was created by an unreleased draft with an unsafe unique key. Its data was retained; use a fresh workspace or the formal migration in C8.', 409);
        }
      }
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_sessions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('workspace','task')),
        task_id TEXT,
        logical_key TEXT NOT NULL,
        semantic_stage TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        bindings_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','deferred','awaiting_commit','blocked','completed','invalidated','expired')),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('job','workspace')),
        owner_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        owner_label TEXT,
        owner_until TEXT,
        claim_id TEXT,
        claim_until TEXT,
        claim_epoch INTEGER NOT NULL DEFAULT 0,
        conversation_json TEXT,
        pending_json TEXT,
        final_json TEXT,
        final_digest TEXT,
        deferred_json TEXT,
        last_error TEXT,
        rejections INTEGER NOT NULL DEFAULT 0,
        turn INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        protocol TEXT,
        privacy_epoch INTEGER NOT NULL DEFAULT 0,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_reasoning_sessions_active ON reasoning_sessions(status,expires_at);
      CREATE INDEX IF NOT EXISTS ix_reasoning_sessions_task ON reasoning_sessions(task_id,status);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_reasoning_sessions_workspace_key ON reasoning_sessions(logical_key) WHERE scope='workspace';
      CREATE UNIQUE INDEX IF NOT EXISTS ux_reasoning_sessions_task_key ON reasoning_sessions(task_id,logical_key) WHERE scope='task';
      CREATE TABLE IF NOT EXISTS reasoning_session_operations (
        session_id TEXT NOT NULL REFERENCES reasoning_sessions(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        turn INTEGER NOT NULL DEFAULT 0,
        call_index INTEGER NOT NULL DEFAULT 0,
        tool TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('read','write')),
        args_digest TEXT,
        args_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('intent','executing','completed','failed','unknown','reconciliation_required')),
        execution_id TEXT,
        local_ref TEXT,
        source_refs_json TEXT,
        result_json TEXT,
        receipt_json TEXT,
        error_class TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,operation_id)
      );
      CREATE INDEX IF NOT EXISTS ix_reasoning_operations_execution ON reasoning_session_operations(execution_id);
    `);
    };
    if (this.db.inTransaction) initialize();
    else database.atomic(initialize);
  }

  #at() { return iso(this.now()); }

  #rowById(id) { return this.db.prepare('SELECT * FROM reasoning_sessions WHERE id=?').get(id); }

  #rowByKey(scope, logicalKey, taskId = null) {
    if (scope === 'task') {
      return this.db.prepare("SELECT * FROM reasoning_sessions WHERE scope='task' AND task_id=? AND logical_key=?").get(taskId, logicalKey);
    }
    return this.db.prepare("SELECT * FROM reasoning_sessions WHERE scope='workspace' AND logical_key=?").get(logicalKey);
  }

  #activeCount(at) {
    return this.db.prepare("SELECT COUNT(*) n FROM reasoning_sessions WHERE status IN ('active','deferred','awaiting_commit','blocked') AND expires_at>?").get(at).n;
  }

  #expiresAt(now, requestedTtl, sourceRefs, bindings) {
    let expiry = now + Math.min(this.ttlMs, Number.isFinite(requestedTtl) ? Math.max(1000, Math.floor(requestedTtl)) : this.ttlMs);
    for (const reference of sourceRefs) if (reference.validUntil) expiry = Math.min(expiry, Date.parse(reference.validUntil));
    if (bindings && typeof bindings.validUntil === 'string' && !Number.isNaN(Date.parse(bindings.validUntil))) expiry = Math.min(expiry, Date.parse(bindings.validUntil));
    if (expiry <= now) throw sessionError('SESSION_SOURCE_EXPIRED', 'The session would expire before it could be used.', 409);
    return iso(expiry);
  }

  #validateJob(owner, now, { scope, taskId = null } = {}) {
    const row = this.db.prepare('SELECT id,state,task_id,lease_owner,lease_token,lease_until FROM jobs WHERE id=?').get(owner.id);
    if (!row || row.state !== 'running' || row.lease_owner !== owner.label || String(row.lease_token) !== owner.token || row.lease_until <= iso(now)) {
      throw sessionError('SESSION_OWNER_LOST', 'The current job lease does not own this reasoning session.', 409);
    }
    // The caller-supplied job object is never the authority for task identity:
    // the stored task_id decides whether this job may hold a task or workspace
    // session.
    if (scope === 'task') {
      if (String(row.task_id ?? '') !== String(taskId ?? '')) throw sessionError('SESSION_OWNER_LOST', 'This job does not own the requested task.', 409);
    } else if (row.task_id != null) {
      throw sessionError('SESSION_OWNER_LOST', 'A task job cannot claim a workspace reasoning session.', 409);
    }
    return row.lease_until;
  }

  #assertTask(taskId, bindings = null, owner = null) {
    const row = this.db.prepare('SELECT id,status,privacy_epoch,data_json FROM tasks WHERE id=?').get(taskId);
    if (!row) throw sessionError('SESSION_TASK_MISSING', 'A task-owned session needs a real task.', 404);
    const data = parse(row.data_json) || {};
    const learning = owner?.kind === 'job' && bindings?.purpose === 'experience_compile'
      && bindings.catalogVersion === 'experience-compile/no-tools/v1'
      && this.db.prepare(`SELECT 1 FROM jobs j JOIN feedback_events f ON f.id=json_extract(j.payload_json,'$.sourceId')
        JOIN source_records s ON s.kind='feedback' AND s.id=f.id AND s.active=1
        WHERE j.id=? AND j.queue_name='learning' AND j.job_type='compile_experience' AND j.task_id=? AND f.task_id=?
          AND json_extract(j.payload_json,'$.sourceKind')='feedback' AND f.id=? AND f.kind!='silence'
          AND length(json_extract(j.payload_json,'$.compilationInputDigest'))=64
          AND json_extract(j.payload_json,'$.compilationInputDigest')=?`)
        .get(owner.id, taskId, taskId, bindings.compilationSourceId, bindings.compilationInputDigest);
    if (['completed', 'cancelled'].includes(row.status) && !learning || data.privacyInvalidated || data.userDismissed || data.control?.paused) {
      throw sessionError('SESSION_TASK_INACTIVE', 'The task is closed, paused or privacy-invalidated.', 409);
    }
    if (bindings && Number(bindings.privacyEpoch) !== Number(row.privacy_epoch)) {
      throw sessionError('SESSION_STALE', 'The task privacy generation changed; start a new reasoning plan.', 409);
    }
    return row;
  }

  #ownerValid(row, now) {
    const at = iso(now);
    if (row.owner_kind === 'job') {
      const job = this.db.prepare('SELECT state,task_id,lease_owner,lease_token,lease_until FROM jobs WHERE id=?').get(row.owner_id);
      if (!job || job.state !== 'running' || job.lease_owner !== row.owner_label || String(job.lease_token) !== String(row.owner_token) || job.lease_until <= at) return false;
      if (row.scope === 'task') return String(job.task_id ?? '') === String(row.task_id ?? '');
      return job.task_id == null;
    }
    if (row.scope === 'task') return false;
    return typeof row.owner_until === 'string' && row.owner_until > at;
  }

  #view(row, owner, { resumed = undefined } = {}) {
    const cached = row.status === 'awaiting_commit' && row.final_json ? parse(row.final_json) : null;
    const pending = row.pending_json ? parse(row.pending_json) : null;
    const conversation = row.conversation_json ? parse(row.conversation_json) : null;
    return {
      id: row.id,
      scope: row.scope,
      taskId: row.task_id,
      logicalKey: row.logical_key,
      semanticStage: row.semantic_stage,
      status: row.status,
      turn: row.turn,
      calls: row.calls,
      rejections: row.rejections,
      model: row.model,
      protocol: row.protocol,
      sourceRefs: parse(row.source_refs_json) || [],
      conversation,
      pending,
      cachedFinal: row.status === 'awaiting_commit' && row.final_json ? cached : null,
      deferred: row.deferred_json ? parse(row.deferred_json) : null,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      version: row.version,
      claimId: row.claim_id,
      claimExpiresAt: row.claim_until,
      owner: {
        kind: row.owner_kind,
        ownerId: row.owner_id,
        ...(row.owner_kind === 'job' ? { job: owner?.job } : {}),
        ...(row.owner_kind === 'workspace' ? { token: owner?.kind === 'workspace' && owner.id === row.owner_id ? owner.token : row.owner_token, until: row.owner_until } : {})
      },
      ...(resumed === undefined ? {} : { resumed })
    };
  }

  /** Safe status only: no prompt, conversation, arguments, results or final. */
  read({ id = null, scope = null, logicalKey = null, taskId = null } = {}) {
    if (id) return this.#readRow(this.#rowById(id));
    if (!scope || !logicalKey) return null;
    if (!SCOPES.includes(scope)) throw sessionError('INVALID_SESSION', "Session scope must be 'workspace' or 'task'.", 400);
    if (scope === 'task') {
      // A task-scoped lookup may never return another task's private row; the
      // caller must supply the real task id or use the opaque id.
      if (!text(taskId, 200)) throw sessionError('INVALID_SESSION', 'A task session lookup needs its taskId.', 400);
    } else if (taskId != null) {
      throw sessionError('INVALID_SESSION', 'A workspace session lookup does not accept a taskId.', 400);
    }
    return this.#readRow(this.#rowByKey(scope, logicalKey, taskId));
  }

  #readRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      scope: row.scope,
      taskId: row.task_id,
      logicalKey: row.logical_key,
      semanticStage: row.semantic_stage,
      status: row.status,
      turn: row.turn,
      calls: row.calls,
      hasConversation: Boolean(row.conversation_json),
      hasPending: Boolean(row.pending_json),
      hasFinal: Boolean(row.final_json),
      sourceRefs: parse(row.source_refs_json) || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      version: row.version
    };
  }

  describe() {
    const at = this.#at();
    const rows = this.db.prepare("SELECT status,COUNT(*) n FROM reasoning_sessions WHERE expires_at>? GROUP BY status").all(at);
    return { limits: SESSION_LIMITS, active: this.#activeCount(at), byStatus: Object.fromEntries(rows.map(row => [row.status, row.n])) };
  }

  /**
   * Atomically claim or resume the one session for (scope, logicalKey).
   * A different stable fingerprint is never silently reused: the caller must
   * open a new plan. Attempt/run/lease changes are not part of the fingerprint.
   */
  begin({
    logicalKey, scope = 'workspace', taskId = null, semanticStage = 'general', bindings,
    owner, isCurrent, sourceRefs = [], conversation = null, pending = null,
    turn = 0, calls = 0, ttlMs = null
  } = {}) {
    if (!text(logicalKey, 200)) throw sessionError('INVALID_SESSION', 'A session needs a stable logical key.', 400);
    if (!SCOPES.includes(scope)) throw sessionError('INVALID_SESSION', "Session scope must be 'workspace' or 'task'.", 400);
    if (scope === 'workspace' && taskId != null) throw sessionError('INVALID_SESSION', 'A workspace session does not accept a taskId.', 400);
    if (scope === 'task' && !text(taskId, 200)) throw sessionError('INVALID_SESSION', 'A task session needs a trusted taskId.', 400);
    if (scope === 'task' && owner?.kind !== 'job') throw sessionError('INVALID_SESSION_OWNER', 'A task session requires the current job as its owner.', 400);
    if (!STAGES.includes(semanticStage)) throw sessionError('INVALID_SESSION', 'Unknown semantic stage.', 400);
    if (!Number.isSafeInteger(turn) || turn < 0 || turn > SESSION_LIMITS.turns) throw sessionError('INVALID_SESSION', 'Invalid session turn.', 400);
    if (!Number.isSafeInteger(calls) || calls < 0 || calls > SESSION_LIMITS.calls) throw sessionError('INVALID_SESSION', 'Invalid session call count.', 400);
    if (typeof isCurrent !== 'function') throw sessionError('INVALID_SESSION', 'An explicit private session needs its current-run check.', 400);
    if (isCurrent() !== true) throw sessionError('SESSION_NOT_CURRENT', 'The task run is no longer current.', 409);
    const now = this.now(), at = iso(now);
    const bindingsJson = validateBindings(bindings);
    // Identity is the real scope/task pair, never a user-supplied bindings field.
    const fingerprint = stableDigest({ scope, taskId: scope === 'task' ? taskId : null, bindings });
    const refs = validateSourceRefs(sourceRefs, now);
    const expiresAt = this.#expiresAt(now, ttlMs, refs, bindings);
    const ownerInfo = normalizeOwner(owner, { workspaceLeaseMs: this.workspaceLeaseMs, now });
    if (ownerInfo.kind === 'job') ownerInfo.until = this.#validateJob(ownerInfo, now, { scope, taskId });
    if (scope === 'task') this.#assertTask(taskId, bindings, ownerInfo);
    const conversationJson = conversation == null ? null
      : boundedJson(conversation, SESSION_LIMITS.conversationChars, 'SESSION_CONVERSATION_LIMIT', 'The bounded private conversation exceeds its window.');
    const pendingJson = pending == null ? null
      : boundedJson(pending, SESSION_LIMITS.conversationChars, 'SESSION_CONVERSATION_LIMIT', 'The pending model turn exceeds its window.');
    const claimId = randomUUID(), claimUntil = iso(now + this.claimLeaseMs);
    const transaction = () => {
      this.#sweepTx(now);
      let existing = this.#rowByKey(scope, logicalKey, taskId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw sessionError('SESSION_STALE', 'The model, prompt, tools, context or authority changed; start a new reasoning plan.', 409);
        if (existing.status === 'completed') throw sessionError('SESSION_ACKED', 'This reasoning session was committed and cleared; start a new logical key.', 409);
        if (existing.status === 'invalidated' || existing.status === 'expired') throw sessionError('SESSION_INVALIDATED', 'This reasoning session was invalidated; start a new plan.', 409);
        if (existing.status === 'blocked') throw sessionError('SESSION_RECONCILIATION_REQUIRED', 'An earlier write outcome must be reconciled before this session can continue.', 409);
        if (existing.expires_at <= at) { this.#clearPrivate(existing.id, 'expired', at); return { __expired: true }; }
        const liveClaim = Boolean(existing.claim_id && existing.claim_until > at && this.#ownerValid(existing, now));
        // One invocation owns the one model fetch capability. Awaiting-commit
        // is the safe exception: its cached final can be served without a fetch.
        if (liveClaim && existing.status !== 'awaiting_commit') {
          throw sessionError('SESSION_BUSY', 'Another live invocation owns this reasoning session.', 409);
        }
        const mergedRefs = [...(parse(existing.source_refs_json) || [])];
        for (const ref of refs) if (!mergedRefs.some(item => item.kind === ref.kind && item.id === ref.id)) mergedRefs.push(ref);
        if (mergedRefs.length > SESSION_LIMITS.sourceRefs) throw sessionError('INVALID_SESSION', 'Too many session source references.', 400);
        // Resuming never extends the original 24h/source-validity ceiling.
        const boundedExpiry = expiresAt < existing.expires_at ? expiresAt : existing.expires_at;
        const changed = this.db.prepare(`UPDATE reasoning_sessions SET owner_kind=?,owner_id=?,owner_token=?,owner_label=?,owner_until=?,
          claim_id=?,claim_until=?,claim_epoch=claim_epoch+1,source_refs_json=?,
          expires_at=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
          .run(ownerInfo.kind, ownerInfo.id, ownerInfo.token, ownerInfo.label || null,
            ownerInfo.kind === 'workspace' ? ownerInfo.until : ownerInfo.until || null,
            claimId, claimUntil, json(mergedRefs), boundedExpiry, at, existing.id, existing.version).changes;
        if (changed !== 1) throw sessionError('SESSION_BUSY', 'Another worker claimed this reasoning session.', 409);
        existing = this.#rowById(existing.id);
        return this.#view(existing, ownerInfo, { resumed: true });
      }
      if (this.#activeCount(at) >= SESSION_LIMITS.maxActive) throw sessionError('SESSION_LIMIT', 'At most 64 reasoning sessions can be active.', 429);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO reasoning_sessions
        (id,scope,task_id,logical_key,semantic_stage,fingerprint,bindings_json,status,owner_kind,owner_id,owner_token,owner_label,owner_until,
         claim_id,claim_until,claim_epoch,conversation_json,pending_json,turn,calls,privacy_epoch,source_refs_json,created_at,updated_at,expires_at)
        VALUES(?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`)
        .run(id, scope, scope === 'task' ? taskId : null, logicalKey, semanticStage, fingerprint, bindingsJson,
          ownerInfo.kind, ownerInfo.id, ownerInfo.token, ownerInfo.label || null,
          ownerInfo.kind === 'workspace' ? ownerInfo.until : ownerInfo.until || null,
          claimId, claimUntil, conversationJson, pendingJson, turn, calls, Number(bindings.privacyEpoch) || 0, json(refs), at, at, expiresAt);
      return this.#view(this.#rowById(id), ownerInfo, { resumed: false });
    };
    let outcome;
    for (let attempt = 0; ; attempt++) {
      try { outcome = this.database.atomic(transaction); break; }
      catch (error) {
        // Two processes may both observe no row and race the partial unique
        // index. The loser re-reads and receives SESSION_BUSY from the claim.
        if (attempt === 0 && /SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)/.test(String(error?.code || ''))) continue;
        throw error;
      }
    }
    if (outcome?.__expired) throw sessionError('SESSION_EXPIRED', 'This reasoning session expired.', 409);
    return outcome;
  }

  #assertWritable(row, { owner, isCurrent = null, claimId = null, requireClaim = true, requireLive = true, now = this.now() } = {}) {
    if (!row) throw sessionError('SESSION_NOT_FOUND', 'Unknown reasoning session.', 404);
    if (typeof isCurrent !== 'function') throw sessionError('INVALID_SESSION', 'An owner write needs its current-run check.', 400);
    if (isCurrent() !== true) throw sessionError('SESSION_NOT_CURRENT', 'The task run is no longer current.', 409);
    if (row.status === 'completed') throw sessionError('SESSION_ACKED', 'This reasoning session was committed and cleared.', 409);
    if (row.status === 'invalidated') throw sessionError('SESSION_INVALIDATED', 'This reasoning session was invalidated.', 409);
    if (row.status === 'expired' || row.expires_at <= iso(now)) throw sessionError('SESSION_EXPIRED', 'This reasoning session expired.', 409);
    if (row.owner_kind === 'workspace' && (!row.owner_until || row.owner_until <= iso(now))) {
      throw sessionError('SESSION_OWNER_LOST', 'The workspace session lease expired.', 409);
    }
    const ownerInfo = normalizeOwner(owner, { workspaceLeaseMs: this.workspaceLeaseMs, now });
    if (ownerInfo.kind === 'job') this.#validateJob(ownerInfo, now, { scope: row.scope, taskId: row.task_id });
    if (row.scope === 'task') this.#assertTask(row.task_id, parse(row.bindings_json), ownerInfo);
    if (row.owner_kind !== ownerInfo.kind || row.owner_id !== ownerInfo.id || String(row.owner_token) !== String(ownerInfo.token)) {
      throw sessionError('SESSION_OWNER_LOST', 'Another worker now owns this reasoning session.', 409);
    }
    if (requireClaim) {
      if (!claimId || row.claim_id !== claimId) throw sessionError('SESSION_OWNER_LOST', 'This invocation no longer owns the reasoning session claim.', 409);
      if (requireLive && !(row.claim_until > iso(now))) throw sessionError('SESSION_CLAIM_EXPIRED', 'The reasoning session invocation claim expired.', 409);
    }
    if (isCurrent && isCurrent() !== true) throw sessionError('SESSION_NOT_CURRENT', 'The task run is no longer current.', 409);
    return ownerInfo;
  }

  #write(id, { owner, isCurrent = null, claimId = null, requireLive = true, requireClaim = true, expectedVersion = null, status = null, values = {}, clear = [] } = {}) {
    const now = this.now(), at = iso(now);
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      this.#assertWritable(row, { owner, isCurrent, claimId, requireLive, requireClaim, now });
      if (expectedVersion != null && row.version !== expectedVersion) throw sessionError('SESSION_CONFLICT', 'The reasoning session changed; re-read it before writing.', 409);
      const assignments = ['version=version+1', 'updated_at=?'];
      const parameters = [at];
      for (const [column, value] of Object.entries(values)) { assignments.push(`${column}=?`); parameters.push(value); }
      for (const column of clear) assignments.push(`${column}=NULL`);
      if (status) { assignments.push('status=?'); parameters.push(status); }
      parameters.push(id, row.version);
      const changed = this.db.prepare(`UPDATE reasoning_sessions SET ${assignments.join(',')} WHERE id=? AND version=?`).run(...parameters).changes;
      if (changed !== 1) throw sessionError('SESSION_CONFLICT', 'The reasoning session changed concurrently.', 409);
      return this.#rowById(id);
    });
  }

  assertOwner({ id, owner, isCurrent = null, claimId = null } = {}) {
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      this.#assertWritable(row, { owner, isCurrent, claimId });
      return true;
    });
  }

  /** Extend a live invocation claim immediately before a model fetch. */
  renewClaim({ id, owner, isCurrent = null, claimId = null } = {}) {
    const now = this.now();
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      this.#assertWritable(row, { owner, isCurrent, claimId, now });
      const changed = this.db.prepare('UPDATE reasoning_sessions SET claim_until=?,updated_at=? WHERE id=? AND claim_id=? AND version=?')
        .run(iso(now + this.claimLeaseMs), iso(now), id, claimId, row.version).changes;
      if (changed !== 1) throw sessionError('SESSION_CONFLICT', 'The reasoning session claim changed concurrently.', 409);
      return true;
    });
  }

  saveConversation({ id, owner, conversation, turn = null, calls = null, model = null, protocol = null, isCurrent = null, claimId = null, status = null } = {}) {
    const values = {
      conversation_json: boundedJson(conversation, SESSION_LIMITS.conversationChars, 'SESSION_CONVERSATION_LIMIT', 'The bounded private conversation exceeds its window.')
    };
    if (turn != null) {
      if (!Number.isSafeInteger(turn) || turn < 0 || turn > SESSION_LIMITS.turns) throw sessionError('SESSION_TURN_LIMIT', 'The session turn limit was reached.', 409);
      values.turn = turn;
    }
    if (calls != null) {
      if (!Number.isSafeInteger(calls) || calls < 0 || calls > SESSION_LIMITS.calls) throw sessionError('SESSION_CALL_LIMIT', 'The session tool-call limit was reached.', 409);
      values.calls = calls;
    }
    if (model != null) values.model = String(model).slice(0, 200);
    if (protocol != null) values.protocol = String(protocol).slice(0, 40);
    return this.#write(id, { owner, isCurrent, claimId, status, values });
  }

  savePending({ id, owner, pending, turn = null, calls = null, isCurrent = null, claimId = null } = {}) {
    const values = {
      pending_json: pending == null ? null : boundedJson(pending, SESSION_LIMITS.conversationChars, 'SESSION_CONVERSATION_LIMIT', 'The pending model turn exceeds its window.')
    };
    if (turn != null) values.turn = turn;
    if (calls != null) values.calls = calls;
    return this.#write(id, { owner, isCurrent, claimId, values });
  }

  /** Persist one completed model turn and its pending tool calls together. */
  checkpoint({ id, owner, conversation, pending, turn = null, calls = null, model = null, protocol = null, isCurrent = null, claimId = null } = {}) {
    return this.database.atomic(() => {
      if (pending != null) this.savePending({ id, owner, pending, turn, calls, isCurrent, claimId });
      return this.saveConversation({ id, owner, conversation, turn, calls, model, protocol, isCurrent, claimId });
    });
  }

  saveProgress({ id, owner, conversation, turn, calls, isCurrent = null, claimId = null } = {}) {
    if (!Number.isSafeInteger(turn) || turn < 0 || turn > SESSION_LIMITS.turns) throw sessionError('SESSION_TURN_LIMIT', 'The session turn limit was reached.', 409);
    if (!Number.isSafeInteger(calls) || calls < 0 || calls > SESSION_LIMITS.calls) throw sessionError('SESSION_CALL_LIMIT', 'The session tool-call limit was reached.', 409);
    return this.#write(id, { owner, isCurrent, claimId, values: {
      conversation_json: boundedJson(conversation, SESSION_LIMITS.conversationChars, 'SESSION_CONVERSATION_LIMIT', 'The bounded private conversation exceeds its window.'),
      turn, calls
    }, clear: ['pending_json'] });
  }

  noteModel({ id, owner, model, protocol, isCurrent = null, claimId = null } = {}) {
    return this.#write(id, { owner, isCurrent, claimId, values: { model: String(model || '').slice(0, 200) || null, protocol: String(protocol || '').slice(0, 40) || null } });
  }

  defer({ id, owner, code = 'budget_deferred', reason = null, retryAt = null, isCurrent = null, claimId = null } = {}) {
    const detail = { code: String(code).slice(0, 80), reason: reason == null ? null : String(reason).slice(0, 300), retryAt: retryAt || null, at: this.#at() };
    try {
      return this.#write(id, { owner, isCurrent, claimId, status: 'deferred',
        values: { deferred_json: json(detail), last_error: detail.code, claim_id: null, claim_until: null } });
    } catch (error) {
      // A worker that lost its lease cannot change the session. The original
      // budget error is still the error the caller observes. A turn that has
      // already deferred or been superseded must not fail a second deferral.
      if (['SESSION_OWNER_LOST', 'SESSION_NOT_CURRENT', 'SESSION_EXPIRED', 'SESSION_CLAIM_EXPIRED'].includes(error.code)) return null;
      throw error;
    }
  }

  awaitCommit({ id, owner, final, turn = null, calls = null, conversation = null, isCurrent = null, claimId = null } = {}) {
    if (!final || typeof final !== 'object') throw sessionError('INVALID_SESSION_FINAL', 'Only a parsed JSON final answer can await commit.', 400);
    const finalJson = boundedJson(final, SESSION_LIMITS.finalChars, 'SESSION_FINAL_LIMIT', 'The cached final answer is too large.');
    const values = {
      final_json: finalJson,
      final_digest: stableDigest(final),
      status: 'awaiting_commit',
      last_error: null
    };
    if (turn != null) values.turn = turn;
    if (calls != null) values.calls = calls;
    if (conversation != null) values.conversation_json = boundedJson(conversation, SESSION_LIMITS.conversationChars, 'SESSION_CONVERSATION_LIMIT', 'The bounded private conversation exceeds its window.');
    return this.#write(id, { owner, isCurrent, claimId, values });
  }

  /** Caller committed the real task/checkpoint: erase private bodies, keep counters. */
  ack({ id, owner, isCurrent = null, claimId = null } = {}) {
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      if (!row) throw sessionError('SESSION_NOT_FOUND', 'Unknown reasoning session.', 404);
      if (row.status === 'completed') return this.read({ id });
      this.#assertWritable(row, { owner, isCurrent, claimId, requireLive: false });
      this.#clearPrivate(id, 'completed', this.#at());
      return this.read({ id });
    });
  }

  /**
   * Semantic/grounding rejection of the cached final. The completed tool work
   * stays available; the next attempt re-fetches from the current model turn.
   */
  rejectFinal({ id, owner, reason = null, isCurrent = null, claimId = null } = {}) {
    const outcome = this.database.atomic(() => {
      const row = this.#rowById(id);
      if (!row) throw sessionError('SESSION_NOT_FOUND', 'Unknown reasoning session.', 404);
      this.#assertWritable(row, { owner, isCurrent, claimId, requireLive: false });
      if (row.status !== 'awaiting_commit') throw sessionError('SESSION_NO_FINAL', 'There is no cached final answer to reject.', 409);
      if (row.rejections >= SESSION_LIMITS.rejectFinalLimit) {
        this.#clearPrivate(id, 'blocked', this.#at());
        this.db.prepare("UPDATE reasoning_sessions SET last_error='final_rejected' WHERE id=?").run(id);
        return null;
      }
      const at = this.#at();
      const changed = this.db.prepare(`UPDATE reasoning_sessions SET status='active',final_json=NULL,final_digest=NULL,rejections=rejections+1,
        claim_id=NULL,claim_until=NULL,last_error=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='awaiting_commit'`)
        .run(reason == null ? 'final_rejected' : String(reason).slice(0, 200), at, id, row.version).changes;
      if (changed !== 1) throw sessionError('SESSION_CONFLICT', 'The cached final answer changed concurrently.', 409);
      return this.#view(this.#rowById(id), null);
    });
    if (outcome === null) throw sessionError('SESSION_FINAL_REJECTED', 'The final answer was rejected repeatedly; a new plan is required.', 409);
    return outcome;
  }

  block({ id, owner = null, code = 'reconciliation_required', isCurrent = null, claimId = null } = {}) {
    if (owner) {
      return this.#write(id, { owner, isCurrent, claimId, requireLive: false, status: 'blocked',
        values: { last_error: code, claim_id: null, claim_until: null } });
    }
    return this.database.atomic(() => {
      this.db.prepare("UPDATE reasoning_sessions SET status='blocked',last_error=?,claim_id=NULL,claim_until=NULL,version=version+1,updated_at=? WHERE id=? AND status IN ('active','deferred')")
        .run(code, this.#at(), id);
      return this.read({ id });
    });
  }

  invalidate({ id, reason = 'invalidated' } = {}) {
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      if (!row) return null;
      this.#clearPrivate(id, 'invalidated', this.#at());
      this.db.prepare('UPDATE reasoning_sessions SET last_error=? WHERE id=?').run(String(reason).slice(0, 200), id);
      return this.read({ id });
    });
  }

  purge({ id, reason = 'purged' } = {}) { return this.invalidate({ id, reason }); }

  /** Privacy traversal: clear every session bound to these tasks or sources. */
  purgeBy({ taskIds = [], sources = [], reason = 'privacy' } = {}) {
    return this.database.atomic(() => {
      const ids = new Set();
      const taskList = [...new Set(taskIds.filter(id => typeof id === 'string' && id))];
      if (taskList.length) {
        const placeholders = taskList.map(() => '?').join(',');
        for (const row of this.db.prepare(`SELECT id FROM reasoning_sessions WHERE task_id IN (${placeholders})`).all(...taskList)) ids.add(row.id);
        for (const source of taskList) for (const row of this.#rowsForSource({ kind: 'task', id: source })) ids.add(row.id);
      }
      for (const source of sources) if (source && typeof source.kind === 'string' && typeof source.id === 'string') {
        for (const row of this.#rowsForSource(source)) ids.add(row.id);
      }
      const at = this.#at();
      for (const id of ids) {
        this.#clearPrivate(id, 'invalidated', at);
        this.db.prepare('UPDATE reasoning_sessions SET last_error=? WHERE id=?').run(String(reason).slice(0, 200), id);
      }
      return { cleared: ids.size, ids: [...ids] };
    });
  }

  #rowsForSource({ kind, id }) {
    if (!hasTable(this.db, 'reasoning_sessions')) return [];
    return this.db.prepare(`SELECT id FROM reasoning_sessions s
      WHERE EXISTS (SELECT 1 FROM json_each(s.source_refs_json) WHERE json_extract(value,'$.kind')=? AND json_extract(value,'$.id')=?)`)
      .all(kind, id);
  }

  #clearPrivate(id, status, at) {
    this.db.prepare(`UPDATE reasoning_sessions SET status=?,conversation_json=NULL,pending_json=NULL,final_json=NULL,final_digest=NULL,deferred_json=NULL,
      claim_id=NULL,claim_until=NULL,version=version+1,updated_at=? WHERE id=?`).run(status, at, id);
    this.db.prepare(`UPDATE reasoning_session_operations SET args_json=NULL,result_json=NULL,receipt_json=NULL,updated_at=? WHERE session_id=?`).run(at, id);
  }

  sweep() {
    const now = this.now();
    return this.database.atomic(() => this.#sweepTx(now));
  }

  #sweepTx(now) {
    const at = iso(now);
    const rows = this.db.prepare("SELECT id FROM reasoning_sessions WHERE status IN ('active','deferred','awaiting_commit','blocked') AND expires_at<=?").all(at);
    for (const row of rows) this.#clearPrivate(row.id, 'expired', at);
    return rows.length;
  }

  // ---------------------------------------------------------------- operations

  toolIntent({
    id, owner, turn, callIndex, tool, effect, args, operationId = null,
    sourceRefs = [], isCurrent = null, claimId = null
  } = {}) {
    if (!text(tool, 200)) throw sessionError('INVALID_SESSION_OPERATION', 'A tool intent needs a tool name.', 400);
    if (!['read', 'write'].includes(effect)) throw sessionError('INVALID_SESSION_OPERATION', 'A tool intent needs a trusted effect.', 400);
    if (!Number.isSafeInteger(turn) || turn < 0 || turn >= SESSION_LIMITS.turns
      || !Number.isSafeInteger(callIndex) || callIndex < 0 || callIndex >= SESSION_LIMITS.calls) {
      throw sessionError('SESSION_CALL_LIMIT', 'The tool intent is outside the bounded turn/call window.', 409);
    }
    const argsJson = boundedJson(args ?? {}, SESSION_LIMITS.operationChars, 'INVALID_SESSION_OPERATION', 'Tool arguments are too large.');
    const operation = operationId || stableDigest({ id, turn, callIndex, tool });
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      this.#assertWritable(row, { owner, isCurrent, claimId });
      const existing = this.db.prepare('SELECT * FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(id, operation);
      if (existing) return existing;
      const at = this.#at();
      const refs = sourceRefs.filter(item => item && text(item.kind, 80) && text(item.id, 200)).slice(0, SESSION_LIMITS.sourceRefs);
      this.db.prepare(`INSERT INTO reasoning_session_operations
        (session_id,operation_id,turn,call_index,tool,effect,args_digest,args_json,status,source_refs_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'intent',?,?,?)`)
        .run(id, operation, turn, callIndex, tool, effect, stableDigest(args ?? {}), argsJson, json(refs), at, at);
      this.db.prepare('UPDATE reasoning_sessions SET version=version+1,updated_at=? WHERE id=? AND version=?').run(at, id, row.version);
      if (refs.length) this.#mergeSources(id, refs);
      return this.db.prepare('SELECT * FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(id, operation);
    });
  }

  toolResult({ id, owner, operationId, text: resultText = null, result = undefined, receipt = null, executionId = null, isCurrent = null, claimId = null, sources = [] } = {}) {
    if (!text(operationId, 200)) throw sessionError('INVALID_SESSION_OPERATION', 'A tool result needs its operation id.', 400);
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      this.#assertWritable(row, { owner, isCurrent, claimId });
      const operation = this.db.prepare('SELECT * FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(id, operationId);
      if (!operation) throw sessionError('SESSION_OPERATION_MISSING', 'No persisted intent exists for this tool result.', 409);
      // A completed step whose result checkpoint was lost may still be filled
      // from its verified durable mapping. Other terminal outcomes are final.
      if (TERMINAL_OPERATION.includes(operation.status)
        && !(operation.status === 'completed' && operation.result_json == null)) return operation;
      const stored = result !== undefined
        ? boundedJson(result, SESSION_LIMITS.operationChars, 'INVALID_SESSION_OPERATION', 'The tool result is too large.')
        : (resultText == null ? null : String(resultText).slice(0, SESSION_LIMITS.toolResultChars));
      const receiptJson = receipt == null ? null : boundedJson(receipt, 4000, 'INVALID_SESSION_OPERATION', 'The receipt is too large.');
      const refs = sources.filter(item => item && text(item.kind, 80) && text(item.id, 200)).slice(0, SESSION_LIMITS.sourceRefs);
      const at = this.#at();
      this.db.prepare(`UPDATE reasoning_session_operations SET status='completed',result_json=?,receipt_json=?,execution_id=COALESCE(?,execution_id),
        source_refs_json=COALESCE(?,source_refs_json),updated_at=? WHERE session_id=? AND operation_id=?`)
        .run(stored, receiptJson, executionId, refs.length ? json(refs) : null, at, id, operationId);
      this.db.prepare('UPDATE reasoning_sessions SET version=version+1,updated_at=? WHERE id=? AND version=?').run(at, id, row.version);
      if (refs.length) this.#mergeSources(id, refs);
      return this.db.prepare('SELECT * FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(id, operationId);
    });
  }

  toolFailure({ id, owner, operationId, status = 'failed', errorClass = null, isCurrent = null, claimId = null } = {}) {
    if (!['failed', 'unknown', 'reconciliation_required'].includes(status)) throw sessionError('INVALID_SESSION_OPERATION', 'Invalid tool failure state.', 400);
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      this.#assertWritable(row, { owner, isCurrent, claimId });
      const at = this.#at();
      this.db.prepare('UPDATE reasoning_session_operations SET status=?,error_class=?,updated_at=? WHERE session_id=? AND operation_id=?')
        .run(status, errorClass == null ? null : String(errorClass).slice(0, 80), at, id, operationId);
      this.db.prepare('UPDATE reasoning_sessions SET version=version+1,updated_at=? WHERE id=? AND version=?').run(at, id, row.version);
      if (status === 'unknown' || status === 'reconciliation_required') {
        this.db.prepare("UPDATE reasoning_sessions SET status='blocked',last_error=? WHERE id=?").run(status === 'unknown' ? 'unknown_effect' : 'reconciliation_required', id);
      }
      return this.db.prepare('SELECT * FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(id, operationId);
    });
  }

  operation({ id, operationId }) {
    return this.db.prepare('SELECT * FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(id, operationId) || null;
  }

  operations(id) {
    return this.db.prepare('SELECT * FROM reasoning_session_operations WHERE session_id=? ORDER BY turn,call_index').all(id);
  }

  noteSources({ id, owner, operationId = null, sources = [], isCurrent = null, claimId = null } = {}) {
    if (!Array.isArray(sources) || !sources.length) return this.read({ id });
    return this.database.atomic(() => {
      const row = this.#rowById(id);
      this.#assertWritable(row, { owner, isCurrent, claimId });
      const refs = sources.filter(item => item && text(item.kind, 80) && text(item.id, 200)).slice(0, SESSION_LIMITS.sourceRefs);
      if (operationId) {
        const operation = this.db.prepare('SELECT source_refs_json FROM reasoning_session_operations WHERE session_id=? AND operation_id=?').get(id, operationId);
        if (operation) {
          const merged = [...(parse(operation.source_refs_json) || [])];
          for (const ref of refs) if (!merged.some(item => item.kind === ref.kind && item.id === ref.id)) merged.push(ref);
          this.db.prepare('UPDATE reasoning_session_operations SET source_refs_json=?,updated_at=? WHERE session_id=? AND operation_id=?')
            .run(json(merged.slice(0, SESSION_LIMITS.sourceRefs)), this.#at(), id, operationId);
        }
      }
      this.#mergeSources(id, refs);
      return this.read({ id });
    });
  }

  #mergeSources(id, refs) {
    const row = this.#rowById(id);
    const merged = [...(parse(row.source_refs_json) || [])];
    for (const ref of refs) if (!merged.some(item => item.kind === ref.kind && item.id === ref.id)) merged.push(ref);
    this.db.prepare('UPDATE reasoning_sessions SET source_refs_json=? WHERE id=?').run(json(merged.slice(0, SESSION_LIMITS.sourceRefs)), id);
  }

  // ------------------------------------------------------- classic single call

  /**
   * Called at the top of the classic model boundary. Returns null when the
   * caller did not explicitly request a private session, so default behaviour
   * is byte-for-byte unchanged.
   */
  classicTurn({ reasoner, requestId, system, user, documents = [], externalTools = [], wrapReadTools = null, context = null } = {}) {
    const spec = context?.session;
    if (!spec) return null;
    if (reasoner?.runtime || reasoner?.id === 'pi') {
      throw sessionError('SESSION_UNSUPPORTED_HARNESS', 'The Pi harness cannot persist a turn-by-turn private reasoning session; use the classic harness.', 409);
    }
    if (typeof context.scope !== 'string') throw sessionError('INVALID_SESSION', 'A session needs the trusted accounting scope.', 400);
    if (typeof spec.isCurrent !== 'function') throw sessionError('INVALID_SESSION', 'An explicit private session needs its current-run check.', 400);
    this.startObservedContext(spec);
    const tools = (externalTools || []).map(tool => ({
      name: String(tool.name || '').slice(0, 200),
      description: String(tool.description || '').slice(0, 500),
      parameters: tool.parameters ?? null
    }));
    if (spec.bindings?.purpose === 'experience_compile' && tools.length) throw sessionError('SESSION_UNSUPPORTED_HARNESS', 'Feedback compilation cannot execute tools.', 409);
    const toolLoop = tools.length > 0;
    const promptHash = stableDigest({ requestId: null, system, user, documents, tools, wrapReadTools: Boolean(wrapReadTools), model: reasoner?.model || null, protocol: reasoner?.protocol || null });
    const bindings = {
      ...spec.bindings,
      model: reasoner?.model || null,
      protocol: reasoner?.protocol || null,
      initialPromptHash: promptHash,
      prompt: null
    };
    // The tool loop owns the exact provider conversation (it adds its own tool
    // instructions). A classic single call stores its one completed turn here.
    const conversation = toolLoop ? null : {
      kind: 'classic', stage: spec.semanticStage || 'general',
      system, user, documents, tools,
      model: reasoner?.model || null, protocol: reasoner?.protocol || null
    };
    const session = this.begin({
      logicalKey: spec.logicalKey, scope: context.scope, taskId: context.taskId ?? null,
      semanticStage: spec.semanticStage || 'general', bindings, owner: spec.owner,
      isCurrent: spec.isCurrent, sourceRefs: spec.sourceRefs || [], conversation,
      turn: toolLoop ? 0 : 1, calls: 0, ttlMs: spec.ttlMs ?? null
    });
    const turn = { session, id: session.id, owner: session.owner, claimId: session.claimId, requestId, isCurrent: spec.isCurrent,
      baseFetch: reasoner?.fetchImpl, toolLoop, context };
    if (session.cachedFinal != null) turn.cached = session.cachedFinal;
    this.captureContextTurn(spec, turn);
    return turn;
  }

  unsupportedHarness() {
    return sessionError('SESSION_UNSUPPORTED_HARNESS', 'The Pi harness cannot persist a turn-by-turn private reasoning session; use the classic harness.', 409);
  }

  classicActive() { return Boolean(this.classicStorage.getStore()); }

  /** The trusted turn handle for the current classic/tool-loop invocation. */
  classicTurnHandle() { return this.classicStorage.getStore() || null; }

  /** Run the original model body under the private turn context. */
  runClassic(turn, callback) {
    return this.classicStorage.run({ service: this, ...turn, baseFetch: turn.baseFetch || globalThis.fetch }, callback);
  }

  /**
   * Fetch wrapper for one classic model call. Reads only the private ALS turn.
   * It renews and verifies the invocation claim immediately before dispatch so
   * a deferred or superseded invocation cannot reach the provider.
   */
  sessionFetch(reasoner, requestId) {
    const store = this.classicStorage.getStore();
    if (!store || store.service !== this || store.requestId !== requestId) return null;
    const service = this;
    const dispatch = (url, init, onProviderFetch = null) => {
      service.renewClaim({ id: store.id, owner: store.owner, isCurrent: store.isCurrent, claimId: store.claimId });
      let payload = null;
      try { payload = JSON.parse(init?.body); } catch { /* the transport rejects malformed payloads itself */ }
      if (payload?.model) service.noteModel({ id: store.id, owner: store.owner, model: payload.model,
        protocol: payload.protocol || reasoner?.protocol, isCurrent: store.isCurrent, claimId: store.claimId });
      onProviderFetch?.();
      return store.baseFetch(url, init);
    };
    return bindModelFetchBoundary(async (url, init) => dispatch(url, init), dispatch);
  }

  completeClassic(turn, result) {
    // A tool-loop turn persists its own pending/final state inside
    // completeWithTools under the same invocation claim.
    if (turn.toolLoop) return result;
    if (result == null || typeof result !== 'object' || Array.isArray(result)) {
      this.saveConversation({ id: turn.id, owner: turn.owner, conversation: turn.session.conversation,
        turn: 1, calls: 0, isCurrent: turn.isCurrent, claimId: turn.claimId, status: 'active' });
      return result;
    }
    this.awaitCommit({ id: turn.id, owner: turn.owner, final: result, turn: 1, calls: 0, isCurrent: turn.isCurrent, claimId: turn.claimId });
    return result;
  }

  failClassic(turn, error) {
    try {
      if (['TOKEN_BUDGET_EXHAUSTED', 'MONEY_BUDGET_EXHAUSTED', 'MONEY_PROFILE_REQUIRED'].includes(error?.code)) {
        this.defer({ id: turn.id, owner: turn.owner, claimId: turn.claimId, code: 'budget_deferred', reason: error.message,
          retryAt: error.retryAt || error.detail?.resetsAt || null, isCurrent: turn.isCurrent });
      } else if (!String(error?.code || '').startsWith('SESSION_')) {
        this.defer({ id: turn.id, owner: turn.owner, claimId: turn.claimId, code: error?.code || 'reasoning_failed', reason: error?.message, isCurrent: turn.isCurrent });
      }
    } catch { /* the original model error remains the caller's error */ }
  }
}

export const reasoningSessionsApi = { SESSION_LIMITS, DurableReasoningSessions, operationContext, runWithOperation, addOperationSources, linkOperation, stableDigest };
