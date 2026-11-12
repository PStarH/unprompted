import { durableError, iso } from './database.js';

/**
 * Token budget core ledger.
 *
 * This service stores daily token limits, reservations and settlements. It is
 * deliberately not wired into model dispatch yet: constructing it does not
 * enforce a budget on any product path. The next integration step owns the
 * transport hooks (`markDispatched`, `settle`, `markUnknown`,
 * `cancelBeforeDispatch`) and the public schema migration.
 *
 * Accounting rules:
 * - One fixed UTC day window per reservation, taken from `database.now()`.
 * - A reservation checks the workspace limit and, when a `taskId` is given,
 *   that task's limit in the same write transaction.
 * - Pending and unknown reservations count against the day they were reserved
 *   on, even if they settle on a later day.
 * - Cancelled reservations release their hold; dispatched, settled and unknown
 *   reservations never do.
 * - `settle` accepts only complete, trusted usage: `input` and `output` must be
 *   own properties with non-negative safe integers; cache fields may be
 *   omitted and default to 0. Missing, empty or partial usage throws
 *   "INVALID_TOKEN_BUDGET" and changes nothing. Use `markUnknown` when the
 *   provider did not report usable usage. An explicit `{input: 0, output: 0}`
 *   is a trusted zero and is recorded.
 * - A zero-token reservation is admitted even under a zero or exhausted limit
 *   because it spends nothing at reservation time. Transport code must never
 *   use 0 as an unknown estimate; unknown usage belongs to `markUnknown`.
 * - A reservation that was never dispatched cannot be dispatched on a later
 *   UTC day; the caller must start a new attempt. Already-dispatched attempts
 *   may settle on a later day and keep their original reservation day.
 * - Reservations and settlements that would push a day's accumulated usage or
 *   a requested/settled token total beyond Number.MAX_SAFE_INTEGER are rejected
 *   with "TOKEN_BUDGET_OVERFLOW", preserving existing holds and never rounding
 *   or clamping real usage. If real usage cannot be represented, keep the
 *   reservation hold by calling `markUnknown`; the overflow error is
 *   observable. Stored data that is already unsafe makes `describe` fail
 *   loudly instead of returning a rounded number.
 * - `describe` reads limits, usage and pending rows inside one read-only
 *   transaction (or reuses an active transaction), so it reports one snapshot
 *   without taking a write lock.
 * - No prompt, message body or secret is stored. Rows hold only identifiers,
 *   token counts, states and timestamps.
 */

const MAX_TOKENS = Number.MAX_SAFE_INTEGER;
const DAY_MS = 86400000;
const MAX_ID_LENGTH = 200;
const PENDING_LIST_LIMIT = 200;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/;

const invalid = message => durableError('INVALID_TOKEN_BUDGET', message, 400);
const conflict = message => durableError('TOKEN_BUDGET_CONFLICT', message, 409);
const notFound = attemptId => durableError('TOKEN_BUDGET_NOT_FOUND', `No token reservation exists for attempt "${attemptId}".`, 404);

function overflow(message, detail = {}) {
  const error = durableError('TOKEN_BUDGET_OVERFLOW', message, 409);
  error.detail = detail;
  return error;
}

function identifier(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw invalid(`${field} is required.`);
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || !value.trim()) {
    throw invalid(`${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters.`);
  }
  return value;
}

function tokenCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a non-negative safe integer.`);
  return value;
}

function sumTokens(values, field, detail) {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) throw overflow(`${field} exceeds the safe integer range.`, detail);
  }
  return sum;
}

function addSafe(left, right, detail) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) throw overflow('Aggregated token usage exceeds the safe integer range.', detail);
  return sum;
}

function dayFromTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid('date is not a valid UTC calendar day.');
  let isoValue;
  try { isoValue = date.toISOString(); }
  catch { throw invalid('date is outside the supported range.'); }
  const day = isoValue.slice(0, 10);
  if (!DAY_PATTERN.test(day)) throw invalid('date is outside the supported four-digit-year range.');
  return day;
}

function utcDay(value) {
  if (value instanceof Date) return dayFromTimestamp(value.getTime());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('date is not a valid UTC calendar day.');
    return dayFromTimestamp(value);
  }
  if (typeof value === 'string') {
    if (DAY_PATTERN.test(value)) {
      const parsed = Date.parse(`${value}T00:00:00.000Z`);
      if (Number.isNaN(parsed) || dayFromTimestamp(parsed) !== value) throw invalid(`date "${value}" is not a valid UTC calendar day.`);
      return value;
    }
    if (ISO_DATETIME_PATTERN.test(value)) {
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) throw invalid(`date "${value}" is not a valid ISO datetime.`);
      return dayFromTimestamp(parsed);
    }
    throw invalid('date must be YYYY-MM-DD, a Date, a timestamp, or an ISO datetime with an explicit timezone (Z or offset).');
  }
  throw invalid('date must be YYYY-MM-DD, a Date, a timestamp, or an ISO datetime with an explicit timezone (Z or offset).');
}

function nextReset(day) {
  const reset = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
  if (Number.isNaN(reset.getTime())) throw invalid('The reset time for the requested day is outside the supported range.');
  return reset.toISOString();
}

const project = row => row && ({
  attemptId: row.attempt_id,
  taskId: row.task_id,
  day: row.day,
  state: row.state,
  reserved: { input: row.reserved_input, output: row.reserved_output, total: row.reserved_total },
  actual: row.actual_total == null ? null : {
    input: row.actual_input,
    output: row.actual_output,
    cacheRead: row.actual_cache_read,
    cacheWrite: row.actual_cache_write,
    total: row.actual_total
  },
  overrun: { tokens: row.overrun_tokens, exceeded: row.overrun_tokens > 0 },
  consumed: row.state === 'settled' ? row.actual_total : ['reserved', 'dispatched', 'unknown'].includes(row.state) ? row.reserved_total : 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  dispatchedAt: row.dispatched_at,
  settledAt: row.settled_at
});

function scopeState(limit, usage, requested, prospective) {
  return {
    limit,
    used: usage.used,
    available: limit == null ? null : Math.max(0, limit - usage.used),
    overage: limit == null ? 0 : Math.max(0, usage.used - limit),
    requested,
    wouldExceed: limit != null && prospective > limit
  };
}

function summarize(limit, usage) {
  return {
    limit,
    settled: usage.settled,
    pending: usage.pending,
    unknown: usage.unknown,
    used: usage.used,
    available: limit == null ? null : Math.max(0, limit - usage.used),
    overage: limit == null ? 0 : Math.max(0, usage.used - limit),
    exhausted: limit != null && usage.used >= limit,
    attempts: { settled: usage.settledCount, pending: usage.pendingCount, unknown: usage.unknownCount }
  };
}

export class TokenBudgetService {
  constructor(database) {
    if (!database?.db) throw new TypeError('TokenBudgetService requires a DurableDatabase.');
    this.database = database;
    this.db = database.db;
    // Creation must also work when the caller already holds a transaction;
    // in that case run the DDL inline instead of nesting a write coordinator.
    const initialize = () => this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_budget_limits (
        scope TEXT NOT NULL CHECK(scope IN ('workspace','task')),
        scope_id TEXT NOT NULL,
        tokens INTEGER CHECK(tokens IS NULL OR (tokens >= 0 AND tokens <= ${MAX_TOKENS})),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, scope_id)
      );
      CREATE TABLE IF NOT EXISTS token_budget_reservations (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT,
        day TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','cancelled','unknown')),
        reserved_input INTEGER NOT NULL CHECK(reserved_input >= 0),
        reserved_output INTEGER NOT NULL CHECK(reserved_output >= 0),
        reserved_total INTEGER NOT NULL CHECK(reserved_total >= 0),
        actual_input INTEGER,
        actual_output INTEGER,
        actual_cache_read INTEGER,
        actual_cache_write INTEGER,
        actual_total INTEGER CHECK(actual_total IS NULL OR actual_total >= 0),
        overrun_tokens INTEGER NOT NULL DEFAULT 0 CHECK(overrun_tokens >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatched_at TEXT,
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_token_budget_reservations_day
        ON token_budget_reservations(day, task_id, state);
    `);
    if (this.db.inTransaction) initialize();
    else database.atomic(initialize);
  }

  /** Set or clear one limit. `null` means unlimited; `0` forbids new spend. */
  setLimit({ scope, taskId = null, tokens } = {}) {
    if (scope !== 'workspace' && scope !== 'task') throw invalid("scope must be 'workspace' or 'task'.");
    if (scope === 'workspace' && taskId != null) throw invalid('Workspace limits do not take a taskId.');
    if (tokens === undefined) throw invalid('tokens is required; pass null for an unlimited scope.');
    const task = scope === 'task' ? identifier(taskId, 'taskId') : null;
    const limit = tokens === null ? null : tokenCount(tokens, 'tokens');
    const at = iso(this.database.now());
    this.database.atomic(() => {
      this.db.prepare(`INSERT INTO token_budget_limits(scope,scope_id,tokens,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(scope,scope_id) DO UPDATE SET tokens=excluded.tokens,updated_at=excluded.updated_at`)
        .run(scope, task ?? '', limit, at);
    });
    return { scope, taskId: task, limit, updatedAt: at };
  }

  /**
   * Reserve an estimated token total for one attempt. The attempt id is the
   * global idempotency key: an identical replay returns the original row, any
   * other reuse is rejected. Limits and the safe-integer accumulator are
   * checked and the row inserted in one transaction, so two service instances
   * cannot both spend the last tokens.
   *
   * A replay of a `reserved` row from an earlier UTC day is still returned,
   * but `markDispatched` rejects it; start a new attempt for the new day.
   */
  reserve({ attemptId, taskId = null, inputTokens, outputTokens } = {}) {
    const attempt = identifier(attemptId, 'attemptId');
    const task = identifier(taskId, 'taskId', { optional: true });
    const input = tokenCount(inputTokens, 'inputTokens');
    const output = tokenCount(outputTokens, 'outputTokens');
    const requested = sumTokens([input, output], 'Requested token total', { attemptId: attempt, action: 'reserve' });

    return this.database.atomic(() => {
      const existing = this._row(attempt);
      if (existing) {
        const same = existing.task_id === task && existing.reserved_input === input && existing.reserved_output === output;
        if (!same) throw conflict(`Attempt "${attempt}" already has a different token reservation.`);
        return project(existing);
      }

      const day = utcDay(this.database.now());
      const workspaceUsage = this._usage(day, null);
      const taskUsage = task == null ? null : this._usage(day, task);
      const workspaceLimit = this._limit('workspace', null);
      const taskLimit = task == null ? null : this._limit('task', task);
      // Zero is a valid estimate that admits no spend; it is not an unknown
      // estimate. The transport contract must use markUnknown for that case.
      const workspaceProspective = addSafe(workspaceUsage.used, requested, {
        scope: 'workspace', day, attemptId: attempt, used: workspaceUsage.used, requested
      });
      const taskProspective = task == null ? null : addSafe(taskUsage.used, requested, {
        scope: 'task', day, taskId: task, attemptId: attempt, used: taskUsage.used, requested
      });
      const blocked = [];
      if (workspaceLimit != null && workspaceProspective > workspaceLimit) blocked.push('workspace');
      if (task != null && taskLimit != null && taskProspective > taskLimit) blocked.push('task');
      if (blocked.length) {
        const resetsAt = nextReset(day);
        const error = durableError('TOKEN_BUDGET_EXHAUSTED', `The ${blocked.join(' and ')} token budget is exhausted for ${day}.`, 429);
        error.retryAt = resetsAt;
        error.detail = {
          day,
          requested,
          blockedScopes: blocked,
          resetsAt,
          workspace: scopeState(workspaceLimit, workspaceUsage, requested, workspaceProspective),
          task: task == null ? null : { taskId: task, ...scopeState(taskLimit, taskUsage, requested, taskProspective) }
        };
        throw error;
      }

      const at = iso(this.database.now());
      this.db.prepare(`INSERT INTO token_budget_reservations
        (attempt_id,task_id,day,state,reserved_input,reserved_output,reserved_total,overrun_tokens,created_at,updated_at)
        VALUES(?,?,?,'reserved',?,?,?,0,?,?)`)
        .run(attempt, task, day, input, output, requested, at, at);
      return project(this._row(attempt));
    });
  }

  /**
   * Mark the attempt as handed to the transport. Idempotent while dispatched.
   * A reservation created on an earlier UTC day cannot be dispatched; that
   * attempt must be reserved again for the current day.
   */
  markDispatched(attemptId) {
    const attempt = identifier(attemptId, 'attemptId');
    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'dispatched') return project(row);
      if (row.state !== 'reserved') throw conflict(`Attempt "${attempt}" is ${row.state} and cannot be marked dispatched.`);
      const currentDay = utcDay(this.database.now());
      if (row.day !== currentDay) {
        const error = durableError('TOKEN_BUDGET_STALE_RESERVATION', `Attempt "${attempt}" was reserved on ${row.day} and cannot be dispatched on ${currentDay}; start a new attempt.`, 409);
        error.detail = { attemptId: attempt, reservedDay: row.day, currentDay };
        throw error;
      }
      const at = iso(this.database.now());
      this.db.prepare("UPDATE token_budget_reservations SET state='dispatched',dispatched_at=?,updated_at=? WHERE attempt_id=?")
        .run(at, at, attempt);
      return project(this._row(attempt));
    });
  }

  /**
   * Release a reservation that was never dispatched. A dispatched attempt keeps
   * its full hold even when the transport later reports a failure, because the
   * provider may already have processed it.
   */
  cancelBeforeDispatch(attemptId) {
    const attempt = identifier(attemptId, 'attemptId');
    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'cancelled') return project(row);
      if (row.state === 'dispatched') {
        const error = durableError('TOKEN_BUDGET_ALREADY_DISPATCHED', `Attempt "${attempt}" was already dispatched and cannot be refunded.`, 409);
        error.attemptId = attempt;
        error.state = row.state;
        throw error;
      }
      if (row.state !== 'reserved') throw conflict(`Attempt "${attempt}" is ${row.state} and cannot be cancelled.`);
      const at = iso(this.database.now());
      this.db.prepare("UPDATE token_budget_reservations SET state='cancelled',updated_at=? WHERE attempt_id=?")
        .run(at, attempt);
      return project(this._row(attempt));
    });
  }

  /**
   * Settle trusted usage. `input` and `output` must be own properties with
   * non-negative safe integers; cache fields are optional and default to 0.
   * Missing, empty or partial usage throws "INVALID_TOKEN_BUDGET" and leaves
   * the reservation untouched; use `markUnknown` for missing/untrusted usage.
   * An explicit `{input: 0, output: 0}` is recorded as a trusted zero.
   *
   * Repeating the identical settlement is idempotent; different usage for the
   * same attempt is rejected. Usage above the reservation is recorded
   * truthfully and marked as overrun. A settlement that would push the day's
   * accumulated usage past Number.MAX_SAFE_INTEGER is rejected with
   * "TOKEN_BUDGET_OVERFLOW" and the hold is retained.
   */
  settle(attemptId, usage) {
    const attempt = identifier(attemptId, 'attemptId');
    if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) {
      throw invalid('usage must be an object with own input and output fields; use markUnknown when usage is missing.');
    }
    if (!Object.hasOwn(usage, 'input') || !Object.hasOwn(usage, 'output')) {
      throw invalid('usage.input and usage.output are required; use markUnknown when usage is missing.');
    }
    const input = tokenCount(usage.input, 'usage.input');
    const output = tokenCount(usage.output, 'usage.output');
    const cacheRead = usage.cacheRead === undefined ? 0 : tokenCount(usage.cacheRead, 'usage.cacheRead');
    const cacheWrite = usage.cacheWrite === undefined ? 0 : tokenCount(usage.cacheWrite, 'usage.cacheWrite');
    const actualTotal = sumTokens([input, output, cacheRead, cacheWrite], 'Settled token total', {
      attemptId: attempt, action: 'settle', retainedReservation: true, requiresMarkUnknown: true
    });

    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'settled') {
        if (row.actual_input === input && row.actual_output === output && row.actual_cache_read === cacheRead && row.actual_cache_write === cacheWrite) return project(row);
        throw conflict(`Attempt "${attempt}" was already settled with different usage.`);
      }
      if (row.state === 'cancelled') throw conflict(`Attempt "${attempt}" was cancelled before dispatch and cannot be settled.`);
      if (row.state === 'unknown') throw conflict(`Attempt "${attempt}" was already marked unknown and cannot be settled.`);

      const delta = actualTotal - row.reserved_total;
      const workspaceUsage = this._usage(row.day, null);
      addSafe(workspaceUsage.used, delta, {
        action: 'settle', scope: 'workspace', day: row.day, attemptId: attempt, used: workspaceUsage.used,
        reservedTotal: row.reserved_total, actualTotal, delta, retainedReservation: true, requiresMarkUnknown: true
      });
      if (row.task_id != null) {
        const taskUsage = this._usage(row.day, row.task_id);
        addSafe(taskUsage.used, delta, {
          action: 'settle', scope: 'task', day: row.day, taskId: row.task_id, attemptId: attempt, used: taskUsage.used,
          reservedTotal: row.reserved_total, actualTotal, delta, retainedReservation: true, requiresMarkUnknown: true
        });
      }
      const overrun = Math.max(0, actualTotal - row.reserved_total);
      const at = iso(this.database.now());
      this.db.prepare(`UPDATE token_budget_reservations SET state='settled',actual_input=?,actual_output=?,actual_cache_read=?,
        actual_cache_write=?,actual_total=?,overrun_tokens=?,settled_at=?,updated_at=? WHERE attempt_id=?`)
        .run(input, output, cacheRead, cacheWrite, actualTotal, overrun, at, at, attempt);
      return project(this._row(attempt));
    });
  }

  /** Keep the whole reservation when the provider usage is missing or unusable. */
  markUnknown(attemptId) {
    const attempt = identifier(attemptId, 'attemptId');
    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'unknown') return project(row);
      if (row.state !== 'reserved' && row.state !== 'dispatched') throw conflict(`Attempt "${attempt}" is ${row.state} and cannot be marked unknown.`);
      const at = iso(this.database.now());
      this.db.prepare("UPDATE token_budget_reservations SET state='unknown',updated_at=? WHERE attempt_id=?")
        .run(at, attempt);
      return project(this._row(attempt));
    });
  }

  /**
   * Report limits, settled tokens, still-pending holds, availability and
   * overage for one UTC day. All reads share one snapshot, using a read-only
   * transaction or an active transaction, never a new write lock.
   *
   * `date` accepts a valid `YYYY-MM-DD`, a `Date`, a millisecond timestamp, or
   * an ISO datetime with an explicit `Z`/offset. Ambiguous local datetimes,
   * five-digit years and out-of-range values throw "INVALID_TOKEN_BUDGET".
   *
   * Availability is clamped at zero for display, but `overage` exposes how far
   * the day is past its limit instead of hiding it. If stored totals are
   * already outside the safe integer range, this throws
   * "TOKEN_BUDGET_OVERFLOW" rather than returning a rounded number.
   */
  describe({ taskId = null, date = null } = {}) {
    const task = identifier(taskId, 'taskId', { optional: true });
    const day = utcDay(date === null || date === undefined ? this.database.now() : date);
    return this._snapshot(() => {
      const workspace = summarize(this._limit('workspace', null), this._usage(day, null));
      const taskState = task == null ? null : { taskId: task, ...summarize(this._limit('task', task), this._usage(day, task)) };
      return {
        date: day,
        resetsAt: nextReset(day),
        workspace,
        task: taskState,
        pendingReservations: this._pending(day, task)
      };
    });
  }

  _snapshot(callback) {
    if (this.db.inTransaction) return callback();
    this.db.exec('BEGIN');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _row(attemptId) {
    return this.db.prepare('SELECT * FROM token_budget_reservations WHERE attempt_id=?').get(attemptId) ?? null;
  }

  _requireRow(attemptId) {
    const row = this._row(attemptId);
    if (!row) throw notFound(attemptId);
    return row;
  }

  _limit(scope, taskId) {
    const row = this.db.prepare('SELECT tokens FROM token_budget_limits WHERE scope=? AND scope_id=?').get(scope, taskId ?? '');
    return row?.tokens ?? null;
  }

  _usage(day, taskId) {
    const clause = taskId == null ? '' : ' AND task_id=?';
    const parameters = taskId == null ? [day] : [day, taskId];
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state='settled' THEN actual_total ELSE 0 END),0) settled,
      COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched') THEN reserved_total ELSE 0 END),0) pending,
      COALESCE(SUM(CASE WHEN state='unknown' THEN reserved_total ELSE 0 END),0) unknown,
      COALESCE(SUM(CASE WHEN state='settled' THEN 1 ELSE 0 END),0) settledCount,
      COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched') THEN 1 ELSE 0 END),0) pendingCount,
      COALESCE(SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) unknownCount
      FROM token_budget_reservations WHERE day=?${clause}`).get(...parameters);
    const detail = { day, taskId: taskId ?? null };
    for (const field of ['settled', 'pending', 'unknown', 'settledCount', 'pendingCount', 'unknownCount']) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 0) throw overflow('Stored token usage is outside the safe integer range.', { ...detail, field, value: row[field] });
    }
    const used = addSafe(addSafe(row.settled, row.pending, detail), row.unknown, detail);
    return {
      settled: row.settled,
      pending: row.pending,
      unknown: row.unknown,
      used,
      settledCount: row.settledCount,
      pendingCount: row.pendingCount,
      unknownCount: row.unknownCount
    };
  }

  _pending(day, taskId) {
    const clause = taskId == null ? '' : ' AND task_id=?';
    const parameters = taskId == null ? [day, PENDING_LIST_LIMIT] : [day, taskId, PENDING_LIST_LIMIT];
    return this.db.prepare(`SELECT attempt_id,task_id,state,reserved_input,reserved_output,reserved_total,created_at,dispatched_at
      FROM token_budget_reservations WHERE day=? AND state IN ('reserved','dispatched')${clause}
      ORDER BY created_at,attempt_id LIMIT ?`).all(...parameters).map(row => ({
      attemptId: row.attempt_id,
      taskId: row.task_id,
      state: row.state,
      reserved: { input: row.reserved_input, output: row.reserved_output, total: row.reserved_total },
      createdAt: row.created_at,
      dispatchedAt: row.dispatched_at
    }));
  }
}
