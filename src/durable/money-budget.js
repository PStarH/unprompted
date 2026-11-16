import { durableError, iso } from './database.js';

/**
 * Money budget core ledger.
 *
 * Two isolated kinds share one DurableDatabase and one durable namespace:
 *
 * - `model` records API/model fee budgets. Every reservation must carry a
 *   complete trusted quote snapshot from the pricing/adapter layer: quote id,
 *   digest, expiry, quoted micros, provider, model, protocol, profile digest and
 *   positive profile revision. The ledger never estimates a price from model
 *   text and never imports or re-derives the pricing core.
 * - `transaction` records real user grant leases. Every reservation must carry
 *   a trusted `grantId` from a configured lease; the lease cap is a cumulative
 *   lifetime amount, not a daily allowance. A transaction reservation is also
 *   subject to the optional daily workspace/task budgets of the transaction
 *   kind.
 *
 * Both kinds additionally meter workspace and optional task budgets per fixed
 * UTC day, taken from `database.now()`, in one explicit currency (USD, CNY or
 * EUR). There is no FX conversion. Amounts are safe-integer micros of the
 * currency's main unit (1 micro = 1e-6). All aggregation is done in BigInt and
 * verified back into the safe integer range; overflow fails closed and is never
 * rounded, saturated or treated as zero.
 *
 * Accounting rules:
 * - The attempt id is the global idempotency key across both kinds. An
 *   identical replay returns the stored reservation; reusing an attempt id
 *   with another kind, scope, task, currency, quote, profile or grant is a
 *   conflict. Two connections or processes cannot insert the same attempt
 *   twice.
 * - `reserved`, `dispatched` and `unknown` states all hold their quoted amount.
 *   Only `cancelBeforeDispatch` releases a hold, and only from `reserved`.
 *   Dispatched, settled and unknown attempts never expire into a refund.
 * - A reservation keeps its original UTC day and, for transactions, its
 *   original grant when it settles later, even after the quote expired, the
 *   lease expired or the lease was revoked. Actual usage above the quote is
 *   recorded truthfully as overrun/debt and is never truncated to the quote or
 *   the lease cap. Later admissions are blocked by the resulting balances.
 * - `markUnknown` keeps the whole hold. A later trusted settlement may move an
 *   unknown attempt to settled; a revoked, expired or forgotten grant never
 *   releases an unknown hold by itself.
 * - `markDispatched` rechecks the UTC day, quote expiry, workspace/task config
 *   versions, pricing profile version and, for transactions, the lease version,
 *   expiry, revocation and scope. It also rechecks that the current balances
 *   still allow the hold. The state update and checks share one write
 *   transaction. The marker is only a ledger fact, never a reusable network
 *   permission: the 49 dispatch wrapper must use one opaque attempt and reject
 *   a repeated dispatch. The ledger does not execute or authorize anything.
 * - Settling requires a trusted non-negative safe-integer actual amount and a
 *   receipt/usage-proof reference. Missing evidence is not zero. A complete
 *   explicit zero is a known zero and is recorded.
 * - Limits are optional. `micros: null` disables a limit without deleting
 *   consumption or unknown holds. `micros: 0` explicitly forbids positive
 *   spend while still admitting an explicit zero quote. Any configuration
 *   change bumps a monotonic version, so an old undispatched reservation must
 *   be cancelled and prepared again.
 * - An enabled budget has exactly one currency. A quote in another currency is
 *   rejected rather than converted or treated as unlimited. Histories in
 *   different currencies are reported separately; a currency change never
 *   clears them.
 * - `detachTask` drops the task association for privacy while keeping the
 *   workspace and lease occupancy. Ledger rows cannot be deleted to reset a
 *   budget through this service.
 * - No prompt, message body, tool argument, payment account, credential or
 *   secret is stored. Rows hold opaque ids, amounts, states and timestamps.
 *
 * This core is not an authority grant and not a payment capability. The real
 * permission check stays with the original dispatcher and the 49 integration.
 * Even with lease balance, no action may happen without that authority. This
 * ledger also cannot promise a supplier's real bank-card hard cap: it enforces
 * trusted quoted and settled micros only.
 */

const KINDS = Object.freeze(['model', 'transaction']);
const KIND_SET = new Set(KINDS);
const CURRENCIES = Object.freeze(['CNY', 'EUR', 'USD']);
const CURRENCY_SET = new Set(CURRENCIES);
const MAX_MICROS = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIGINT = BigInt(MAX_MICROS);
const DAY_MS = 86400000;
const MAX_ID_LENGTH = 200;
const PENDING_LIST_LIMIT = 200;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/;

const invalid = message => durableError('INVALID_MONEY_BUDGET', message, 400);

function detailError(code, message, status, detail, reason) {
  const error = durableError(code, message, status);
  error.detail = detail;
  if (reason !== undefined) error.reason = reason;
  return error;
}

const conflict = (message, detail = {}, reason) =>
  detailError('MONEY_BUDGET_CONFLICT', message, 409, detail, reason);

function overflow(message, detail = {}) {
  return detailError('MONEY_BUDGET_OVERFLOW', message, 409, detail, 'overflow');
}

const notFound = attemptId =>
  durableError('MONEY_BUDGET_NOT_FOUND', `No money reservation exists for attempt "${attemptId}".`, 404);

const quoteRequired = field =>
  detailError('MONEY_QUOTE_REQUIRED', `A complete trusted quote is required: ${field} is missing or unknown.`, 400, { field }, 'quote_required');

const usageRequired = field =>
  detailError('MONEY_USAGE_REQUIRED', `Trusted settled usage is required: ${field} is missing or unknown.`, 400, { field }, 'usage_required');

const leaseRequired = () =>
  detailError('MONEY_LEASE_REQUIRED', 'Transaction reservations require a trusted grantId from a configured lease.', 400, { field: 'grantId' }, 'lease_required');

const leaseNotFound = grantId =>
  durableError('MONEY_LEASE_NOT_FOUND', `No transaction lease exists for grant "${grantId}".`, 404);

function leaseUnavailable(reason, detail) {
  return detailError('MONEY_LEASE_UNAVAILABLE', `The transaction lease is not usable (${reason}).`, 409, { reason, ...detail }, reason);
}

function currencyMismatch(scope, configuredCurrency, requestCurrency, detail = {}) {
  return detailError(
    'MONEY_CURRENCY_MISMATCH',
    `The ${scope} money budget is kept in ${configuredCurrency}; a ${requestCurrency} quote cannot use it, be converted, or be treated as unlimited.`,
    409,
    { scope, configuredCurrency, requestCurrency, ...detail },
    'currency_mismatch'
  );
}

function profileMismatch(reason, detail = {}) {
  return detailError(
    'MONEY_PROFILE_MISMATCH',
    `The model quote does not match the current trusted pricing profile (${reason}).`,
    409,
    { reason, ...detail },
    reason
  );
}

function staleError(attemptId, reason, detail = {}) {
  return detailError(
    'MONEY_BUDGET_STALE',
    `Attempt "${attemptId}" cannot be dispatched (${reason}).`,
    409,
    { attemptId, reason, ...detail },
    reason
  );
}

function quoteExpired(detail = {}) {
  return detailError(
    'MONEY_BUDGET_STALE',
    'The trusted quote has already expired; obtain a fresh quote and prepare a new attempt.',
    409,
    { reason: 'quote_expired', ...detail },
    'quote_expired'
  );
}

/**
 * Build the exhaustion error without promising a recovery that cannot happen.
 * Workspace/task blocks are per fixed UTC day, so a day-only block exposes the
 * next day's reset as `resetsAt` and `retryAt`. A transaction lease cap is
 * cumulative and never resets on a timer: when the lease is one of the blocked
 * scopes the overall `resetsAt` is null and `retryAt` is omitted, because the
 * next UTC day (and lease expiry) would not restore quota. `dayResetsAt` then
 * describes only a day window that is itself blocking; lease capacity needs a
 * trusted lease adjustment or a factual settlement release.
 */
function exhaustedError({ kind, currency, day, quotedMicros, blockedScopes, workspace, task, lease }) {
  const leaseBlocked = blockedScopes.includes('lease');
  const dayBlocked = blockedScopes.some(scope => scope === 'workspace' || scope === 'task');
  const dayResetsAt = dayBlocked ? nextReset(day) : null;
  const resetsAt = leaseBlocked ? null : dayResetsAt;
  const scopes = blockedScopes.join(' and ');
  let message;
  if (leaseBlocked && dayBlocked) {
    message = `The ${scopes} money budgets are exhausted for ${currency}. The day windows reset next at ${dayResetsAt}, but the cumulative lease cap has no timed reset and needs an adjusted grant lease or a trusted settlement.`;
  } else if (leaseBlocked) {
    message = `The lease money budget is exhausted for ${currency}. The lease cap is cumulative and has no timed reset.`;
  } else {
    message = `The ${scopes} money budget is exhausted for ${currency} on ${day}.`;
  }
  const error = detailError(
    'MONEY_BUDGET_EXHAUSTED',
    message,
    429,
    {
      kind,
      currency,
      day,
      requestedMicros: quotedMicros,
      blockedScopes,
      resetsAt,
      dayResetsAt,
      workspace,
      task,
      lease
    },
    'exhausted'
  );
  if (resetsAt !== null) error.retryAt = resetsAt;
  return error;
}

function hasValue(object, name) {
  return Object.hasOwn(object, name) && object[name] !== undefined && object[name] !== null;
}

function plainObject(value, field, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${field} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${field} must be a plain object.`);
  if (Object.getOwnPropertySymbols(value).length) throw invalid(`${field} must not have symbol fields.`);
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!allowed.includes(name)) throw invalid(`${field}.${name} is not a supported field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) throw invalid(`${field}.${name} must be a data property.`);
  }
  return value;
}

function identifier(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || !value.trim()) {
    throw invalid(`${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters.`);
  }
  return value;
}

function microsValue(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be an explicit non-negative safe integer amount in micros.`);
  }
  return value;
}

function positiveSafe(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${field} must be a positive safe integer.`);
  }
  return value;
}

function scopeValue(value) {
  if (value !== 'workspace' && value !== 'task') throw invalid("scope must be 'workspace' or 'task'.");
  return value;
}

function currencyValue(value, field = 'currency') {
  if (typeof value !== 'string' || !CURRENCY_SET.has(value)) {
    throw invalid(`${field} must be one of ${CURRENCIES.join(', ')}.`);
  }
  return value;
}

function optionalTaskId(input, field = 'taskId') {
  if (!Object.hasOwn(input, field) || input[field] === null) return null;
  if (input[field] === undefined) throw invalid(`${field} must not be undefined.`);
  return identifier(input[field], field);
}

function taskForScope(scope, taskId) {
  if (scope === 'workspace') {
    if (taskId !== null) throw invalid('Workspace scopes do not take a taskId.');
    return null;
  }
  if (taskId === null) throw invalid('Task scopes require a taskId.');
  return taskId;
}

function optionalExpectedVersion(input) {
  if (!Object.hasOwn(input, 'expectedVersion') || input.expectedVersion === null) return undefined;
  if (input.expectedVersion === undefined) throw invalid('expectedVersion must not be undefined.');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw invalid('expectedVersion must be a non-negative safe integer; use 0 when no configuration row exists.');
  }
  return input.expectedVersion;
}

function requiredExpectedVersion(input) {
  if (!hasValue(input, 'expectedVersion')) throw invalid('expectedVersion is required; use 0 when no lease row exists.');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw invalid('expectedVersion must be a non-negative safe integer; use 0 when no lease row exists.');
  }
  return input.expectedVersion;
}

function quoteString(input, field) {
  if (!hasValue(input, field)) throw quoteRequired(field);
  return identifier(input[field], field);
}

function quoteMicros(input) {
  if (!hasValue(input, 'quotedMicros')) throw quoteRequired('quotedMicros');
  return microsValue(input.quotedMicros, 'quotedMicros');
}

function profileSnapshotValue(value) {
  plainObject(value, 'profileSnapshot', ['providerId', 'model', 'protocol', 'profileDigest', 'revision']);
  for (const name of ['providerId', 'model', 'protocol', 'profileDigest', 'revision']) {
    if (!hasValue(value, name)) throw invalid(`profileSnapshot.${name} is required.`);
  }
  return {
    providerId: identifier(value.providerId, 'profileSnapshot.providerId'),
    model: identifier(value.model, 'profileSnapshot.model'),
    protocol: identifier(value.protocol, 'profileSnapshot.protocol'),
    profileDigest: identifier(value.profileDigest, 'profileSnapshot.profileDigest'),
    revision: positiveSafe(value.revision, 'profileSnapshot.revision')
  };
}

function utcDay(value) {
  const invalidDay = () => invalid('date must be a valid UTC calendar day: YYYY-MM-DD, a Date, a millisecond timestamp, or an ISO datetime with an explicit timezone (Z or offset).');
  const dayString = typeof value === 'string' && DAY_PATTERN.test(value);
  let milliseconds;
  if (value instanceof Date) milliseconds = value.getTime();
  else if (typeof value === 'number') milliseconds = value;
  else if (typeof value === 'string') {
    if (dayString) {
      milliseconds = Date.parse(`${value}T00:00:00.000Z`);
      if (Number.isNaN(milliseconds)) throw invalidDay();
    } else if (ISO_DATETIME_PATTERN.test(value)) {
      milliseconds = Date.parse(value);
      if (Number.isNaN(milliseconds)) throw invalidDay();
    } else {
      throw invalidDay();
    }
  } else {
    throw invalidDay();
  }
  if (!Number.isFinite(milliseconds)) throw invalidDay();
  let normalized;
  try { normalized = new Date(milliseconds).toISOString(); }
  catch { throw invalidDay(); }
  const day = normalized.slice(0, 10);
  if (!DAY_PATTERN.test(day)) throw invalidDay();
  if (dayString && day !== value) throw invalidDay();
  return day;
}

function utcInstant(value, field) {
  let milliseconds;
  if (typeof value === 'string') {
    if (!ISO_DATETIME_PATTERN.test(value)) throw invalid(`${field} must be an ISO datetime with an explicit timezone (Z or offset).`);
    milliseconds = Date.parse(value);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw invalid(`${field} must be a safe integer millisecond timestamp or an ISO datetime with an explicit timezone.`);
    milliseconds = value;
  } else {
    throw invalid(`${field} must be a safe integer millisecond timestamp or an ISO datetime with an explicit timezone.`);
  }
  if (!Number.isFinite(milliseconds)) throw invalid(`${field} is not a valid timestamp.`);
  let normalized;
  try { normalized = new Date(milliseconds).toISOString(); }
  catch { throw invalid(`${field} is outside the supported timestamp range.`); }
  if (!DAY_PATTERN.test(normalized.slice(0, 10))) throw invalid(`${field} is outside the supported four-digit-year range.`);
  return { ms: milliseconds, iso: normalized };
}

function nextReset(day) {
  const reset = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
  if (Number.isNaN(reset.getTime())) throw invalid('The reset time for the requested day is outside the supported range.');
  return reset.toISOString();
}

function safeBig(value, detail) {
  if (typeof value !== 'bigint') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw overflow('Stored money usage is outside the safe integer range.', { ...detail, value: String(value) });
    }
    return value;
  }
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw overflow('Stored money usage is outside the safe integer range.', { ...detail, value: value.toString() });
  }
  return Number(value);
}

function addSafeBig(values, detail) {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  if (total < 0n || total > MAX_SAFE_BIGINT) {
    throw overflow('Aggregated money usage is outside the safe integer range.', detail);
  }
  return Number(total);
}

function projectRow(row) {
  if (!row) return null;
  const active = ['reserved', 'dispatched', 'unknown'].includes(row.state);
  return {
    attemptId: row.attempt_id,
    kind: row.kind,
    scope: row.scope,
    taskId: row.task_id,
    currency: row.currency,
    state: row.state,
    day: row.day,
    quotedMicros: row.quoted_micros,
    actualMicros: row.actual_micros,
    overrunMicros: row.overrun_micros,
    consumedMicros: row.state === 'settled' ? row.actual_micros : active ? row.quoted_micros : 0,
    quote: {
      id: row.quote_id,
      digest: row.quote_digest,
      expiresAt: row.quote_expires_at
    },
    profile: row.profile_provider_id == null ? null : {
      providerId: row.profile_provider_id,
      model: row.profile_model,
      protocol: row.profile_protocol,
      profileDigest: row.profile_digest,
      revision: row.profile_revision,
      version: row.profile_version
    },
    grant: row.grant_id == null ? null : { grantId: row.grant_id, version: row.grant_version },
    limits: {
      workspaceVersion: row.workspace_limit_version,
      taskVersion: row.task_limit_version
    },
    receiptRef: row.receipt_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    settledAt: row.settled_at
  };
}

function projectLease(row) {
  return {
    kind: row.kind,
    grantId: row.grant_id,
    scope: row.scope,
    taskId: row.scope === 'task' ? row.scope_id : null,
    currency: row.currency,
    capMicros: row.cap_micros,
    expiresAt: row.expires_at,
    revoked: row.revoked === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function summarizeLimit(limitRow, currency) {
  const configured = Boolean(limitRow && limitRow.currency === currency);
  return {
    limitConfigured: configured,
    enabled: configured && limitRow.micros != null,
    limit: configured ? limitRow.micros : null,
    configCurrency: limitRow?.currency ?? null,
    configVersion: limitRow?.version ?? 0
  };
}

function summarizeWindow({ scope, taskId = null, currency, limitRow, usage }) {
  const limit = summarizeLimit(limitRow, currency);
  return {
    scope,
    ...(taskId == null ? {} : { taskId }),
    currency,
    ...limit,
    consumedMicros: usage.consumed,
    reservedMicros: usage.reserved,
    unknownMicros: usage.unknown,
    usedMicros: usage.used,
    remainingMicros: limit.enabled ? Math.max(0, limit.limit - usage.used) : null,
    overrunMicros: limit.enabled ? Math.max(0, usage.used - limit.limit) : 0,
    settledOverrunMicros: usage.settledOverrun,
    exhausted: limit.enabled && usage.used >= limit.limit,
    attempts: usage.attempts
  };
}

function summarizeLease(row, usage, nowMs) {
  return {
    window: 'grant',
    grantId: row.grant_id,
    scope: row.scope,
    taskId: row.scope === 'task' ? row.scope_id : null,
    currency: row.currency,
    capMicros: row.cap_micros,
    version: row.version,
    revoked: row.revoked === 1,
    expiresAt: row.expires_at,
    expired: Date.parse(row.expires_at) <= nowMs,
    consumedMicros: usage.consumed,
    reservedMicros: usage.reserved,
    unknownMicros: usage.unknown,
    usedMicros: usage.used,
    remainingMicros: Math.max(0, row.cap_micros - usage.used),
    overrunMicros: Math.max(0, usage.used - row.cap_micros),
    settledOverrunMicros: usage.settledOverrun,
    exhausted: usage.used >= row.cap_micros,
    attempts: usage.attempts
  };
}

function leaseBlocked(lease, currency, taskId, nowMs) {
  if (lease.currency !== currency) return { reason: 'currency', detail: { grantId: lease.grant_id, leaseCurrency: lease.currency } };
  if (lease.revoked === 1) return { reason: 'revoked', detail: { grantId: lease.grant_id } };
  if (Date.parse(lease.expires_at) <= nowMs) return { reason: 'expired', detail: { grantId: lease.grant_id, expiresAt: lease.expires_at } };
  if (lease.scope === 'task' && lease.scope_id !== taskId) {
    return { reason: 'scope', detail: { grantId: lease.grant_id, leaseTaskId: lease.scope_id, reservationTaskId: taskId } };
  }
  return null;
}

export class MoneyBudgetService {
  constructor(database, { kind } = {}) {
    if (!database?.db) throw new TypeError('MoneyBudgetService requires a DurableDatabase.');
    if (!KIND_SET.has(kind)) throw new TypeError('MoneyBudgetService requires kind "model" or "transaction".');
    this.database = database;
    this.db = database.db;
    this.kind = kind;
    // Creation must also work when the caller already holds a transaction;
    // in that case run the DDL inline instead of nesting a write coordinator.
    const initialize = () => this.db.exec(`
      CREATE TABLE IF NOT EXISTS money_budget_limits (
        kind TEXT NOT NULL CHECK(kind IN ('model','transaction')),
        scope TEXT NOT NULL CHECK(scope IN ('workspace','task')),
        scope_id TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency IN ('USD','CNY','EUR')),
        micros INTEGER CHECK(micros IS NULL OR (micros >= 0 AND micros <= ${MAX_MICROS})),
        version INTEGER NOT NULL CHECK(version >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(kind, scope, scope_id)
      );
      CREATE TABLE IF NOT EXISTS money_budget_profiles (
        kind TEXT NOT NULL CHECK(kind = 'model'),
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        protocol TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency IN ('USD','CNY','EUR')),
        profile_digest TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1 AND revision <= ${MAX_MICROS}),
        version INTEGER NOT NULL CHECK(version >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider_id, model, protocol, currency)
      );
      CREATE TABLE IF NOT EXISTS money_budget_leases (
        kind TEXT NOT NULL CHECK(kind = 'transaction'),
        grant_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('workspace','task')),
        scope_id TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency IN ('USD','CNY','EUR')),
        cap_micros INTEGER NOT NULL CHECK(cap_micros >= 0 AND cap_micros <= ${MAX_MICROS}),
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
        version INTEGER NOT NULL CHECK(version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(kind, grant_id)
      );
      CREATE TABLE IF NOT EXISTS money_budget_reservations (
        attempt_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('model','transaction')),
        scope TEXT NOT NULL CHECK(scope IN ('workspace','task')),
        task_id TEXT,
        currency TEXT NOT NULL CHECK(currency IN ('USD','CNY','EUR')),
        state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','cancelled','unknown')),
        day TEXT NOT NULL,
        quoted_micros INTEGER NOT NULL CHECK(quoted_micros >= 0 AND quoted_micros <= ${MAX_MICROS}),
        actual_micros INTEGER CHECK(actual_micros IS NULL OR (actual_micros >= 0 AND actual_micros <= ${MAX_MICROS})),
        overrun_micros INTEGER NOT NULL DEFAULT 0 CHECK(overrun_micros >= 0 AND overrun_micros <= ${MAX_MICROS}),
        receipt_ref TEXT,
        quote_id TEXT NOT NULL,
        quote_digest TEXT NOT NULL,
        quote_expires_at TEXT NOT NULL,
        profile_provider_id TEXT,
        profile_model TEXT,
        profile_protocol TEXT,
        profile_digest TEXT,
        profile_revision INTEGER CHECK(profile_revision IS NULL OR (profile_revision >= 1 AND profile_revision <= ${MAX_MICROS})),
        profile_version INTEGER NOT NULL DEFAULT 0 CHECK(profile_version >= 0),
        grant_id TEXT,
        grant_version INTEGER NOT NULL DEFAULT 0 CHECK(grant_version >= 0),
        workspace_limit_version INTEGER NOT NULL DEFAULT 0 CHECK(workspace_limit_version >= 0),
        task_limit_version INTEGER NOT NULL DEFAULT 0 CHECK(task_limit_version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatched_at TEXT,
        settled_at TEXT,
        CHECK((scope = 'task' AND task_id IS NOT NULL) OR (scope = 'workspace' AND task_id IS NULL)),
        CHECK((kind = 'model'
            AND profile_provider_id IS NOT NULL AND profile_model IS NOT NULL AND profile_protocol IS NOT NULL
            AND profile_digest IS NOT NULL AND profile_revision IS NOT NULL AND profile_version >= 1
            AND grant_id IS NULL AND grant_version = 0)
          OR (kind = 'transaction'
            AND profile_provider_id IS NULL AND profile_model IS NULL AND profile_protocol IS NULL
            AND profile_digest IS NULL AND profile_revision IS NULL AND profile_version = 0
            AND grant_id IS NOT NULL AND grant_version >= 1)),
        CHECK((state = 'settled' AND actual_micros IS NOT NULL AND receipt_ref IS NOT NULL AND settled_at IS NOT NULL)
          OR (state <> 'settled' AND actual_micros IS NULL AND settled_at IS NULL)),
        CHECK(state = 'settled' OR overrun_micros = 0)
      );
      CREATE INDEX IF NOT EXISTS ix_money_budget_reservations_day
        ON money_budget_reservations(kind, day, currency, state);
      CREATE INDEX IF NOT EXISTS ix_money_budget_reservations_task
        ON money_budget_reservations(kind, day, currency, task_id, state);
      CREATE INDEX IF NOT EXISTS ix_money_budget_reservations_grant
        ON money_budget_reservations(kind, grant_id, state);
    `);
    if (this.db.inTransaction) initialize();
    else database.atomic(initialize);
  }

  /**
   * Set, replace or disable one daily workspace/task limit for this kind.
   *
   * `micros` is an explicit safe integer or `null`. `null` disables the limit
   * without clearing consumption or unknown holds. `0` is a real limit that
   * forbids positive spend. Any accepted call bumps the monotonic version;
   * `expectedVersion` (optional) makes the write conditional. Changing the
   * currency is allowed but never converts or clears existing history.
   */
  configureLimit(input = {}) {
    plainObject(input, 'limit', ['scope', 'taskId', 'currency', 'micros', 'expectedVersion']);
    if (!hasValue(input, 'scope')) throw invalid('limit.scope is required.');
    const scope = scopeValue(input.scope);
    const taskId = taskForScope(scope, optionalTaskId(input));
    if (!hasValue(input, 'currency')) throw invalid('limit.currency is required.');
    const currency = currencyValue(input.currency, 'limit.currency');
    if (!Object.hasOwn(input, 'micros') || input.micros === undefined) {
      throw invalid('limit.micros is required; pass null to disable the limit.');
    }
    const micros = input.micros === null ? null : microsValue(input.micros, 'limit.micros');
    const expectedVersion = optionalExpectedVersion(input);
    const nowMs = this._nowMs();
    const at = iso(nowMs);

    return this.database.atomic(() => {
      const existing = this._limitRow(scope, taskId ?? '');
      const currentVersion = existing?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw conflict(
          `The ${scope} limit version changed; expected ${expectedVersion} but found ${currentVersion}.`,
          { scope, taskId, expectedVersion, currentVersion },
          'version_conflict'
        );
      }
      if (currentVersion >= MAX_MICROS) throw overflow('The limit version cannot advance safely.', { scope, taskId });
      const version = currentVersion + 1;
      this.db.prepare(`INSERT INTO money_budget_limits(kind,scope,scope_id,currency,micros,version,updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(kind,scope,scope_id) DO UPDATE SET
          currency=excluded.currency,micros=excluded.micros,version=excluded.version,updated_at=excluded.updated_at`)
        .run(this.kind, scope, taskId ?? '', currency, micros, version, at);
      return { kind: this.kind, scope, taskId, currency, micros, version, updatedAt: at };
    });
  }

  /**
   * Register or replace the trusted pricing profile for one model key. The
   * pricing core owns the actual rates; this ledger stores only the opaque
   * profile binding so dispatch can prove the quote was prepared against the
   * still-current profile. Only available for the `model` kind.
   */
  configureProfile(input = {}) {
    if (this.kind !== 'model') throw invalid('Only model budgets take a pricing profile.');
    plainObject(input, 'profile', ['providerId', 'model', 'protocol', 'currency', 'profileDigest', 'revision', 'expectedVersion']);
    for (const name of ['providerId', 'model', 'protocol', 'currency', 'profileDigest', 'revision']) {
      if (!hasValue(input, name)) throw invalid(`profile.${name} is required.`);
    }
    const profile = {
      providerId: identifier(input.providerId, 'profile.providerId'),
      model: identifier(input.model, 'profile.model'),
      protocol: identifier(input.protocol, 'profile.protocol'),
      profileDigest: identifier(input.profileDigest, 'profile.profileDigest'),
      revision: positiveSafe(input.revision, 'profile.revision'),
      currency: currencyValue(input.currency, 'profile.currency')
    };
    const expectedVersion = optionalExpectedVersion(input);
    const nowMs = this._nowMs();
    const at = iso(nowMs);

    return this.database.atomic(() => {
      const existing = this._profileRow(profile);
      const currentVersion = existing?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw conflict(
          `The pricing profile version changed; expected ${expectedVersion} but found ${currentVersion}.`,
          { providerId: profile.providerId, model: profile.model, protocol: profile.protocol, currency: profile.currency, expectedVersion, currentVersion },
          'version_conflict'
        );
      }
      if (currentVersion >= MAX_MICROS) throw overflow('The pricing profile version cannot advance safely.', {});
      const version = currentVersion + 1;
      this.db.prepare(`INSERT INTO money_budget_profiles(kind,provider_id,model,protocol,currency,profile_digest,revision,version,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(provider_id,model,protocol,currency) DO UPDATE SET
          profile_digest=excluded.profile_digest,revision=excluded.revision,version=excluded.version,updated_at=excluded.updated_at`)
        .run(this.kind, profile.providerId, profile.model, profile.protocol, profile.currency, profile.profileDigest, profile.revision, version, at);
      return { kind: this.kind, ...profile, version, updatedAt: at };
    });
  }

  /**
   * Create or update a transaction grant lease. The lease stores only the
   * trusted grant id, scope, currency, cumulative cap, expiry and revocation
   * state; it does not create the formal autonomy grant. Creation uses
   * `expectedVersion: 0`; every update requires the current version. Scope,
   * task and currency are immutable; a different grant needs a new grantId.
   * Renewing the cap or expiry bumps the version without resetting spend or
   * holds, and reservations prepared under the old version cannot dispatch.
   * Only available for the `transaction` kind.
   */
  configureLease(input = {}) {
    if (this.kind !== 'transaction') throw invalid('Only transaction budgets take a grant lease.');
    plainObject(input, 'lease', ['grantId', 'scope', 'taskId', 'currency', 'capMicros', 'expiresAt', 'expectedVersion']);
    if (!hasValue(input, 'grantId')) throw invalid('lease.grantId is required.');
    const grantId = identifier(input.grantId, 'lease.grantId');
    if (!hasValue(input, 'scope')) throw invalid('lease.scope is required.');
    const scope = scopeValue(input.scope);
    const taskId = taskForScope(scope, optionalTaskId(input));
    if (!hasValue(input, 'currency')) throw invalid('lease.currency is required.');
    const currency = currencyValue(input.currency, 'lease.currency');
    if (!hasValue(input, 'capMicros')) throw invalid('lease.capMicros is required.');
    const capMicros = microsValue(input.capMicros, 'lease.capMicros');
    if (!hasValue(input, 'expiresAt')) throw invalid('lease.expiresAt is required.');
    const expiresAt = utcInstant(input.expiresAt, 'lease.expiresAt');
    const expectedVersion = requiredExpectedVersion(input);
    const nowMs = this._nowMs();
    const at = iso(nowMs);

    return this.database.atomic(() => {
      const existing = this._leaseRow(grantId);
      if (!existing) {
        if (expectedVersion !== 0) {
          throw conflict(`No lease exists for grant "${grantId}"; creation requires expectedVersion 0.`, { grantId, expectedVersion }, 'version_conflict');
        }
        this.db.prepare(`INSERT INTO money_budget_leases
          (kind,grant_id,scope,scope_id,currency,cap_micros,expires_at,revoked,version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,0,1,?,?)`)
          .run(this.kind, grantId, scope, taskId ?? '', currency, capMicros, expiresAt.iso, at, at);
        return projectLease(this._leaseRow(grantId));
      }
      if (expectedVersion !== existing.version) {
        throw conflict(
          `The lease version changed; expected ${expectedVersion} but found ${existing.version}.`,
          { grantId, expectedVersion, currentVersion: existing.version },
          'version_conflict'
        );
      }
      if (existing.revoked === 1) throw conflict(`Lease "${grantId}" is revoked and cannot be updated.`, { grantId }, 'lease_revoked');
      if (existing.scope !== scope || existing.scope_id !== (taskId ?? '') || existing.currency !== currency) {
        throw conflict(
          `Lease "${grantId}" scope, task and currency are immutable; create a new grant lease instead.`,
          { grantId, scope: existing.scope, taskId: existing.scope_id || null, currency: existing.currency },
          'lease_binding_changed'
        );
      }
      if (existing.version >= MAX_MICROS) throw overflow('The lease version cannot advance safely.', { grantId });
      const version = existing.version + 1;
      this.db.prepare('UPDATE money_budget_leases SET cap_micros=?,expires_at=?,version=?,updated_at=? WHERE kind=? AND grant_id=?')
        .run(capMicros, expiresAt.iso, version, at, this.kind, grantId);
      return projectLease(this._leaseRow(grantId));
    });
  }

  /** Revoke a transaction grant lease. Revocation is final and never releases holds. */
  revokeLease(input = {}) {
    if (this.kind !== 'transaction') throw invalid('Only transaction budgets take a grant lease.');
    plainObject(input, 'revoke', ['grantId', 'expectedVersion']);
    if (!hasValue(input, 'grantId')) throw invalid('revoke.grantId is required.');
    const grantId = identifier(input.grantId, 'revoke.grantId');
    const expectedVersion = requiredExpectedVersion(input);
    const nowMs = this._nowMs();
    const at = iso(nowMs);

    return this.database.atomic(() => {
      const existing = this._leaseRow(grantId);
      if (!existing) throw leaseNotFound(grantId);
      if (expectedVersion !== existing.version) {
        throw conflict(
          `The lease version changed; expected ${expectedVersion} but found ${existing.version}.`,
          { grantId, expectedVersion, currentVersion: existing.version },
          'version_conflict'
        );
      }
      if (existing.revoked === 1) return projectLease(existing);
      if (existing.version >= MAX_MICROS) throw overflow('The lease version cannot advance safely.', { grantId });
      this.db.prepare('UPDATE money_budget_leases SET revoked=1,version=?,updated_at=? WHERE kind=? AND grant_id=?')
        .run(existing.version + 1, at, this.kind, grantId);
      return projectLease(this._leaseRow(grantId));
    });
  }

  /**
   * Reserve one attempt. The caller must supply a complete trusted quote; a
   * missing or unknown quote is never treated as zero. The day and lease
   * admissions are checked and the row inserted in one short write
   * transaction, so two services, connections or processes cannot double
   * spend. An identical replay returns the stored row; any payload change is
   * a conflict.
   */
  reserve(input = {}) {
    const allowed = ['attemptId', 'scope', 'taskId', 'currency', 'quotedMicros', 'quoteId', 'quoteDigest', 'quoteExpiresAt'];
    if (this.kind === 'model') allowed.push('profileSnapshot');
    else allowed.push('grantId');
    plainObject(input, 'reservation', allowed);

    if (!hasValue(input, 'attemptId')) throw invalid('reservation.attemptId is required.');
    const attemptId = identifier(input.attemptId, 'reservation.attemptId');
    if (!hasValue(input, 'scope')) throw invalid('reservation.scope is required.');
    const scope = scopeValue(input.scope);
    const taskId = taskForScope(scope, optionalTaskId(input));
    if (!hasValue(input, 'currency')) throw invalid('reservation.currency is required.');
    const currency = currencyValue(input.currency, 'reservation.currency');
    const quotedMicros = quoteMicros(input);
    const quoteId = quoteString(input, 'quoteId');
    const quoteDigest = quoteString(input, 'quoteDigest');
    if (!hasValue(input, 'quoteExpiresAt')) throw quoteRequired('quoteExpiresAt');
    const quoteExpiresAt = utcInstant(input.quoteExpiresAt, 'quoteExpiresAt');

    let profileSnapshot = null;
    let grantId = null;
    if (this.kind === 'model') {
      if (!hasValue(input, 'profileSnapshot')) throw quoteRequired('profileSnapshot');
      profileSnapshot = profileSnapshotValue(input.profileSnapshot);
    } else {
      if (!hasValue(input, 'grantId')) throw leaseRequired();
      grantId = identifier(input.grantId, 'reservation.grantId');
    }

    return this.database.atomic(() => {
      const existing = this._rowAnyKind(attemptId);
      if (existing) {
        if (existing.kind !== this.kind) {
          throw conflict(
            `Attempt "${attemptId}" is already bound to the ${existing.kind} money namespace.`,
            { attemptId, existingKind: existing.kind, requestedKind: this.kind },
            'kind_conflict'
          );
        }
        this._assertSameReservation(existing, {
          scope, taskId, currency, quotedMicros, quoteId, quoteDigest, quoteExpiresAt, profileSnapshot, grantId
        });
        return projectRow(existing);
      }

      const nowMs = this._nowMs();
      const at = iso(nowMs);
      if (quoteExpiresAt.ms <= nowMs) {
        throw quoteExpired({ attemptId, quoteExpiresAt: quoteExpiresAt.iso, now: at });
      }
      const day = utcDay(nowMs);

      let profileVersion = 0;
      if (this.kind === 'model') {
        const current = this._profileRow({ ...profileSnapshot, currency });
        if (!current) throw profileMismatch('unregistered', { providerId: profileSnapshot.providerId, model: profileSnapshot.model, protocol: profileSnapshot.protocol, currency });
        if (current.profile_digest !== profileSnapshot.profileDigest) {
          throw profileMismatch('digest', { providerId: profileSnapshot.providerId, model: profileSnapshot.model, protocol: profileSnapshot.protocol, currency });
        }
        if (current.revision !== profileSnapshot.revision) {
          throw profileMismatch('revision', { providerId: profileSnapshot.providerId, model: profileSnapshot.model, protocol: profileSnapshot.protocol, currency, revision: profileSnapshot.revision, currentRevision: current.revision });
        }
        profileVersion = current.version;
      }

      const workspaceLimit = this._limitRow('workspace', '');
      const taskLimit = taskId == null ? null : this._limitRow('task', taskId);
      const workspace = this._limitAdmission({
        scope: 'workspace', limitRow: workspaceLimit, day, currency, quotedMicros, attemptId
      });
      const task = taskId == null ? null : this._limitAdmission({
        scope: 'task', taskId, limitRow: taskLimit, day, currency, quotedMicros, attemptId
      });

      let lease = null;
      let leaseAdmission = null;
      if (this.kind === 'transaction') {
        lease = this._leaseRow(grantId);
        if (!lease) throw leaseNotFound(grantId);
        if (lease.currency !== currency) {
          throw currencyMismatch('lease', lease.currency, currency, { grantId, attemptId });
        }
        const blocked = leaseBlocked(lease, currency, taskId, nowMs);
        if (blocked) throw leaseUnavailable(blocked.reason, blocked.detail);
        leaseAdmission = this._leaseAdmission({ lease, currency, quotedMicros, attemptId });
      }

      const blockedScopes = [];
      if (workspace.blocked) blockedScopes.push('workspace');
      if (task?.blocked) blockedScopes.push('task');
      if (leaseAdmission?.blocked) blockedScopes.push('lease');
      if (blockedScopes.length) {
        throw exhaustedError({
          kind: this.kind,
          currency,
          day,
          quotedMicros,
          blockedScopes,
          workspace,
          task,
          lease: leaseAdmission
        });
      }

      this.db.prepare(`INSERT INTO money_budget_reservations
        (attempt_id,kind,scope,task_id,currency,state,day,quoted_micros,overrun_micros,
         quote_id,quote_digest,quote_expires_at,
         profile_provider_id,profile_model,profile_protocol,profile_digest,profile_revision,profile_version,
         grant_id,grant_version,workspace_limit_version,task_limit_version,created_at,updated_at)
        VALUES(?,?,?,?,?,'reserved',?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          attemptId, this.kind, scope, taskId, currency, day, quotedMicros,
          quoteId, quoteDigest, quoteExpiresAt.iso,
          profileSnapshot?.providerId ?? null,
          profileSnapshot?.model ?? null,
          profileSnapshot?.protocol ?? null,
          profileSnapshot?.profileDigest ?? null,
          profileSnapshot?.revision ?? null,
          profileVersion,
          grantId,
          leaseAdmission?.version ?? 0,
          workspace.configVersion,
          task?.configVersion ?? 0,
          at, at
        );
      return projectRow(this._rowAnyKind(attemptId));
    });
  }

  /**
   * Mark a reserved attempt as handed to the transport. The check and update
   * share one transaction. A reservation from an earlier UTC day, an expired
   * quote, a changed workspace/task config, a changed pricing profile, a
   * missing/expired/revoked/changed lease, or balances that no longer fit all
   * block dispatch. The marker is idempotent while dispatched, but it is not a
   * reusable network permission: the 49 wrapper must dispatch one opaque
   * attempt once and reject repeats.
   */
  markDispatched(attemptId) {
    const attempt = identifier(attemptId, 'attemptId');
    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'dispatched') return projectRow(row);
      if (row.state !== 'reserved') {
        throw conflict(`Attempt "${attempt}" is ${row.state} and cannot be marked dispatched.`, { attemptId: attempt, state: row.state }, 'state');
      }

      const nowMs = this._nowMs();
      const at = iso(nowMs);
      const day = utcDay(nowMs);
      if (row.day !== day) {
        throw staleError(attempt, 'stale_day', { reservedDay: row.day, currentDay: day });
      }
      if (Date.parse(row.quote_expires_at) <= nowMs) {
        throw staleError(attempt, 'quote_expired', { quoteExpiresAt: row.quote_expires_at, now: at });
      }

      const workspaceLimit = this._limitRow('workspace', '');
      const workspaceVersion = workspaceLimit?.version ?? 0;
      if (workspaceVersion !== row.workspace_limit_version) {
        throw staleError(attempt, 'workspace_config_changed', {
          storedVersion: row.workspace_limit_version,
          currentVersion: workspaceVersion
        });
      }
      if (row.task_id != null) {
        const taskLimit = this._limitRow('task', row.task_id);
        const taskVersion = taskLimit?.version ?? 0;
        if (taskVersion !== row.task_limit_version) {
          throw staleError(attempt, 'task_config_changed', {
            storedVersion: row.task_limit_version,
            currentVersion: taskVersion
          });
        }
      }

      if (this.kind === 'model') {
        const profile = this._profileRow({
          providerId: row.profile_provider_id,
          model: row.profile_model,
          protocol: row.profile_protocol,
          currency: row.currency
        });
        if (!profile) throw staleError(attempt, 'profile_missing', { providerId: row.profile_provider_id, model: row.profile_model });
        if (profile.version !== row.profile_version) {
          throw staleError(attempt, 'profile_changed', { storedVersion: row.profile_version, currentVersion: profile.version });
        }
        if (profile.profile_digest !== row.profile_digest || profile.revision !== row.profile_revision) {
          throw staleError(attempt, 'profile_changed', { storedDigest: row.profile_digest, storedRevision: row.profile_revision });
        }
      } else {
        const lease = this._leaseRow(row.grant_id);
        if (!lease) throw staleError(attempt, 'lease_missing', { grantId: row.grant_id });
        const blocked = leaseBlocked(lease, row.currency, row.task_id, nowMs);
        if (blocked) throw staleError(attempt, `lease_${blocked.reason}`, blocked.detail);
        if (lease.version !== row.grant_version) {
          throw staleError(attempt, 'lease_changed', { storedVersion: row.grant_version, currentVersion: lease.version });
        }
        const leaseUsage = this._usage({ currency: row.currency, grantId: row.grant_id });
        if (leaseUsage.used > lease.cap_micros) {
          throw staleError(attempt, 'lease_limit_exceeded', {
            usedMicros: leaseUsage.used,
            capMicros: lease.cap_micros,
            overrunMicros: leaseUsage.used - lease.cap_micros
          });
        }
      }

      const workspaceUsage = this._usage({ day, currency: row.currency });
      if (workspaceLimit?.micros != null && workspaceLimit.currency !== row.currency) {
        throw staleError(attempt, 'workspace_currency_changed', {
          storedCurrency: row.currency,
          currentCurrency: workspaceLimit.currency
        });
      }
      if (workspaceLimit?.micros != null && workspaceUsage.used > workspaceLimit.micros) {
        throw staleError(attempt, 'workspace_limit_exceeded', {
          usedMicros: workspaceUsage.used,
          limitMicros: workspaceLimit.micros,
          overrunMicros: workspaceUsage.used - workspaceLimit.micros
        });
      }
      if (row.task_id != null) {
        const taskLimit = this._limitRow('task', row.task_id);
        const taskUsage = this._usage({ day, currency: row.currency, taskId: row.task_id });
        if (taskLimit?.micros != null && taskLimit.currency !== row.currency) {
          throw staleError(attempt, 'task_currency_changed', {
            storedCurrency: row.currency,
            currentCurrency: taskLimit.currency
          });
        }
        if (taskLimit?.micros != null && taskUsage.used > taskLimit.micros) {
          throw staleError(attempt, 'task_limit_exceeded', {
            usedMicros: taskUsage.used,
            limitMicros: taskLimit.micros,
            overrunMicros: taskUsage.used - taskLimit.micros
          });
        }
      }

      this.db.prepare("UPDATE money_budget_reservations SET state='dispatched',dispatched_at=?,updated_at=? WHERE attempt_id=? AND kind=?")
        .run(at, at, attempt, this.kind);
      return projectRow(this._requireRow(attempt));
    });
  }

  /**
   * Release a reservation that was never dispatched. Dispatched, unknown and
   * settled attempts never become refunds. A reservation whose lease expired
   * before dispatch can still be cancelled explicitly.
   */
  cancelBeforeDispatch(attemptId) {
    const attempt = identifier(attemptId, 'attemptId');
    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'cancelled') return projectRow(row);
      if (row.state === 'dispatched') {
        const error = detailError(
          'MONEY_BUDGET_ALREADY_DISPATCHED',
          `Attempt "${attempt}" was already dispatched and cannot be refunded.`,
          409,
          { attemptId: attempt, state: row.state },
          'dispatched'
        );
        error.attemptId = attempt;
        error.state = row.state;
        throw error;
      }
      if (row.state !== 'reserved') {
        throw conflict(`Attempt "${attempt}" is ${row.state} and cannot be cancelled.`, { attemptId: attempt, state: row.state }, 'state');
      }
      const at = iso(this._nowMs());
      this.db.prepare("UPDATE money_budget_reservations SET state='cancelled',updated_at=? WHERE attempt_id=? AND kind=?")
        .run(at, attempt, this.kind);
      return projectRow(this._requireRow(attempt));
    });
  }

  /**
   * Settle trusted actual usage. `actualMicros` and `receiptRef` are required
   * own data; missing evidence is not zero. The original reserve day and grant
   * are kept, so late, cross-day and after-revocation settlements record the
   * real fact. Usage above the quote is stored truthfully as overrun/debt. An
   * unknown attempt may be settled later with trusted verification. Repeating
   * the same amount and receipt is idempotent; any change is a conflict.
   */
  settle(input = {}) {
    plainObject(input, 'settlement', ['attemptId', 'actualMicros', 'receiptRef']);
    if (!hasValue(input, 'attemptId')) throw invalid('settlement.attemptId is required.');
    const attempt = identifier(input.attemptId, 'settlement.attemptId');
    if (!hasValue(input, 'actualMicros')) throw usageRequired('actualMicros');
    const actualMicros = microsValue(input.actualMicros, 'settlement.actualMicros');
    if (!hasValue(input, 'receiptRef')) throw usageRequired('receiptRef');
    const receiptRef = identifier(input.receiptRef, 'settlement.receiptRef');

    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'settled') {
        if (row.actual_micros === actualMicros && row.receipt_ref === receiptRef) return projectRow(row);
        throw conflict(
          `Attempt "${attempt}" was already settled with different evidence.`,
          { attemptId: attempt, settledMicros: row.actual_micros, requestedMicros: actualMicros },
          'settlement_conflict'
        );
      }
      if (row.state === 'cancelled') {
        throw conflict(`Attempt "${attempt}" was cancelled before dispatch and cannot be settled.`, { attemptId: attempt, state: row.state }, 'state');
      }

      const delta = BigInt(actualMicros) - BigInt(row.quoted_micros);
      const retained = { attemptId: attempt, action: 'settle', retainedReservation: true, requiresMarkUnknown: true };
      this._aggregateAfter(row, delta, retained);

      const overrunMicros = Math.max(0, actualMicros - row.quoted_micros);
      const at = iso(this._nowMs());
      this.db.prepare(`UPDATE money_budget_reservations
        SET state='settled',actual_micros=?,overrun_micros=?,receipt_ref=?,settled_at=?,updated_at=?
        WHERE attempt_id=? AND kind=?`)
        .run(actualMicros, overrunMicros, receiptRef, at, at, attempt, this.kind);
      return projectRow(this._requireRow(attempt));
    });
  }

  /**
   * Keep the whole hold when the network outcome or usage is unknown. The hold
   * survives restarts and is never released by lease expiry, revocation or
   * forgetting. A later trusted settle may still resolve it.
   */
  markUnknown(attemptId) {
    const attempt = identifier(attemptId, 'attemptId');
    return this.database.atomic(() => {
      const row = this._requireRow(attempt);
      if (row.state === 'unknown') return projectRow(row);
      if (row.state !== 'reserved' && row.state !== 'dispatched') {
        throw conflict(`Attempt "${attempt}" is ${row.state} and cannot be marked unknown.`, { attemptId: attempt, state: row.state }, 'state');
      }
      const at = iso(this._nowMs());
      this.db.prepare("UPDATE money_budget_reservations SET state='unknown',updated_at=? WHERE attempt_id=? AND kind=?")
        .run(at, attempt, this.kind);
      return projectRow(this._requireRow(attempt));
    });
  }

  /**
   * Detach a forgotten task from this ledger. Reservations that held a task
   * budget become unattributed workspace rows; their workspace and lease
   * occupancy is unchanged. No ledger row or limit is deleted, so forgetting a
   * task cannot reset a budget. Repeating the call is safe.
   */
  detachTask(input = {}) {
    plainObject(input, 'detach', ['taskId']);
    if (!hasValue(input, 'taskId')) throw invalid('detach.taskId is required.');
    const taskId = identifier(input.taskId, 'detach.taskId');
    const at = iso(this._nowMs());
    return this.database.atomic(() => {
      const result = this.db.prepare(`UPDATE money_budget_reservations
        SET scope='workspace',task_id=NULL,updated_at=? WHERE kind=? AND task_id=?`)
        .run(at, this.kind, taskId);
      return { kind: this.kind, taskId, detached: result.changes, updatedAt: at };
    });
  }

  /**
   * Report one coherent read snapshot: per-currency UTC-day workspace/task
   * windows, an optional cumulative lease window, and a bounded active list.
   * `currency` filters the day buckets; when omitted, every currency with a
   * limit or a reservation on that day is returned. `grantId` is only valid
   * for the transaction kind and returns the cumulative lease window. Before
   * dispatch the query uses `date` for day windows and pending rows; a grant
   * query lists pending rows across all days because they all occupy the
   * cumulative cap. Only opaque ids and amount counts are returned.
   */
  describe(input = {}) {
    if (input === undefined) input = {};
    plainObject(input, 'query', ['scope', 'currency', 'taskId', 'date', 'grantId']);
    for (const name of ['scope', 'currency', 'taskId', 'date', 'grantId']) {
      if (Object.hasOwn(input, name) && input[name] === undefined) throw invalid(`query.${name} must not be undefined.`);
    }
    const scope = hasValue(input, 'scope') ? scopeValue(input.scope) : null;
    const currencyFilter = hasValue(input, 'currency') ? currencyValue(input.currency, 'query.currency') : null;
    const taskId = optionalTaskId(input);
    if (scope === 'workspace' && taskId !== null) throw invalid('Workspace descriptions do not take a taskId.');
    if (scope === 'task' && taskId === null) throw invalid('Task descriptions require a taskId.');
    const includeTask = scope === 'task' || (scope === null && taskId !== null);
    const grantId = hasValue(input, 'grantId') ? identifier(input.grantId, 'query.grantId') : null;
    if (grantId !== null && this.kind !== 'transaction') throw invalid('query.grantId is only meaningful for transaction budgets.');
    const nowMs = this._nowMs();
    const day = utcDay(hasValue(input, 'date') ? input.date : nowMs);

    return this._snapshot(() => {
      const workspaceLimit = this._limitRow('workspace', '');
      const taskLimit = includeTask ? this._limitRow('task', taskId) : null;
      const lease = grantId === null ? null : this._leaseRow(grantId);
      if (grantId !== null && !lease) throw leaseNotFound(grantId);

      const currencies = new Set();
      if (currencyFilter !== null) {
        currencies.add(currencyFilter);
      } else {
        if (workspaceLimit) currencies.add(workspaceLimit.currency);
        if (taskLimit) currencies.add(taskLimit.currency);
        const seen = this.db.prepare('SELECT DISTINCT currency FROM money_budget_reservations WHERE kind=? AND day=?')
          .all(this.kind, day);
        for (const row of seen) currencies.add(row.currency);
      }

      const buckets = [...currencies].sort().map(currency => ({
        currency,
        window: 'utc_day',
        workspace: summarizeWindow({
          scope: 'workspace',
          currency,
          limitRow: workspaceLimit,
          usage: this._usage({ day, currency })
        }),
        task: includeTask ? summarizeWindow({
          scope: 'task',
          taskId,
          currency,
          limitRow: taskLimit,
          usage: this._usage({ day, currency, taskId })
        }) : null
      }));

      const pending = this._pending({ day, currency: currencyFilter, taskId, grantId });
      const leaseUsage = lease === null ? null : this._usage({ currency: lease.currency, grantId });

      return {
        kind: this.kind,
        scope,
        window: 'utc_day',
        day,
        nextReset: nextReset(day),
        currency: currencyFilter,
        currencies: buckets,
        lease: lease === null ? null : summarizeLease(lease, leaseUsage, nowMs),
        pendingReservations: pending.rows,
        pendingTruncated: pending.truncated
      };
    });
  }

  _aggregateAfter(row, delta, detail) {
    const checks = [
      ['workspace', this._usage({ day: row.day, currency: row.currency })],
      ...(row.task_id == null ? [] : [['task', this._usage({ day: row.day, currency: row.currency, taskId: row.task_id })]]),
      ...(this.kind === 'transaction' ? [['lease', this._usage({ currency: row.currency, grantId: row.grant_id })]] : [])
    ];
    for (const [scope, usage] of checks) {
      const after = BigInt(usage.used) + delta;
      if (after < 0n || after > MAX_SAFE_BIGINT) {
        throw overflow('Settling this amount would move aggregated money usage outside the safe integer range.', {
          ...detail,
          scope,
          usedMicros: usage.used,
          deltaMicros: Number(delta),
          day: row.day,
          currency: row.currency,
          taskId: row.task_id,
          grantId: row.grant_id
        });
      }
    }
  }

  _limitAdmission({ scope, taskId = null, limitRow, day, currency, quotedMicros, attemptId }) {
    if (limitRow?.micros != null && limitRow.currency !== currency) {
      throw currencyMismatch(scope, limitRow.currency, currency, { taskId, day, attemptId });
    }
    const usage = this._usage({ day, currency, ...(taskId == null ? {} : { taskId }) });
    const prospective = BigInt(usage.used) + BigInt(quotedMicros);
    if (prospective > MAX_SAFE_BIGINT) {
      throw overflow('The requested reservation would move aggregated money usage outside the safe integer range.', {
        attemptId,
        action: 'reserve',
        scope,
        taskId,
        day,
        currency,
        usedMicros: usage.used,
        quotedMicros
      });
    }
    const active = limitRow?.micros != null;
    return {
      scope,
      taskId,
      currency,
      limitConfigured: Boolean(limitRow && limitRow.currency === currency),
      enabled: active,
      limit: active ? limitRow.micros : null,
      configCurrency: limitRow?.currency ?? null,
      configVersion: limitRow?.version ?? 0,
      usedMicros: usage.used,
      prospectiveMicros: Number(prospective),
      remainingMicros: active ? Math.max(0, limitRow.micros - usage.used) : null,
      blocked: active && prospective > BigInt(limitRow.micros)
    };
  }

  _leaseAdmission({ lease, currency, quotedMicros, attemptId }) {
    const usage = this._usage({ currency, grantId: lease.grant_id });
    const prospective = BigInt(usage.used) + BigInt(quotedMicros);
    if (prospective > MAX_SAFE_BIGINT) {
      throw overflow('The requested reservation would move the lease total outside the safe integer range.', {
        attemptId,
        action: 'reserve',
        scope: 'lease',
        grantId: lease.grant_id,
        currency,
        usedMicros: usage.used,
        quotedMicros
      });
    }
    return {
      scope: 'lease',
      grantId: lease.grant_id,
      currency,
      capMicros: lease.cap_micros,
      version: lease.version,
      revoked: lease.revoked === 1,
      expiresAt: lease.expires_at,
      usedMicros: usage.used,
      prospectiveMicros: Number(prospective),
      remainingMicros: Math.max(0, lease.cap_micros - usage.used),
      blocked: prospective > BigInt(lease.cap_micros)
    };
  }

  _assertSameReservation(row, wanted) {
    const differences = [];
    const check = (name, actual, expected) => { if (actual !== expected) differences.push(name); };
    check('scope', row.scope, wanted.scope);
    check('taskId', row.task_id, wanted.taskId);
    check('currency', row.currency, wanted.currency);
    check('quotedMicros', row.quoted_micros, wanted.quotedMicros);
    check('quoteId', row.quote_id, wanted.quoteId);
    check('quoteDigest', row.quote_digest, wanted.quoteDigest);
    check('quoteExpiresAt', row.quote_expires_at, wanted.quoteExpiresAt.iso);
    if (this.kind === 'model') {
      check('profileSnapshot.providerId', row.profile_provider_id, wanted.profileSnapshot.providerId);
      check('profileSnapshot.model', row.profile_model, wanted.profileSnapshot.model);
      check('profileSnapshot.protocol', row.profile_protocol, wanted.profileSnapshot.protocol);
      check('profileSnapshot.profileDigest', row.profile_digest, wanted.profileSnapshot.profileDigest);
      check('profileSnapshot.revision', row.profile_revision, wanted.profileSnapshot.revision);
    } else {
      check('grantId', row.grant_id, wanted.grantId);
    }
    if (differences.length) {
      throw conflict(
        `Attempt "${row.attempt_id}" already has a different money reservation.`,
        { attemptId: row.attempt_id, differingFields: differences },
        'idempotency_conflict'
      );
    }
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

  _nowMs() {
    const value = this.database.now();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalid('The database clock returned an invalid timestamp.');
    }
    return value;
  }

  _rowAnyKind(attemptId) {
    return this.db.prepare('SELECT * FROM money_budget_reservations WHERE attempt_id=?').get(attemptId) ?? null;
  }

  _row(attemptId) {
    const row = this._rowAnyKind(attemptId);
    return row && row.kind === this.kind ? row : null;
  }

  _requireRow(attemptId) {
    const row = this._row(attemptId);
    if (!row) throw notFound(attemptId);
    return row;
  }

  _limitRow(scope, scopeId) {
    return this.db.prepare('SELECT currency,micros,version FROM money_budget_limits WHERE kind=? AND scope=? AND scope_id=?')
      .get(this.kind, scope, scopeId) ?? null;
  }

  _profileRow({ providerId, model, protocol, currency }) {
    return this.db.prepare(`SELECT profile_digest,revision,version FROM money_budget_profiles
      WHERE provider_id=? AND model=? AND protocol=? AND currency=?`)
      .get(providerId, model, protocol, currency) ?? null;
  }

  _leaseRow(grantId) {
    return this.db.prepare('SELECT * FROM money_budget_leases WHERE kind=? AND grant_id=?')
      .get(this.kind, grantId) ?? null;
  }

  _usage({ day = null, currency, taskId = null, grantId = null }) {
    const clauses = ['kind=?', 'currency=?'];
    const parameters = [this.kind, currency];
    if (day !== null) { clauses.push('day=?'); parameters.push(day); }
    if (taskId !== null) { clauses.push('task_id=?'); parameters.push(taskId); }
    if (grantId !== null) { clauses.push('grant_id=?'); parameters.push(grantId); }
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state='settled' THEN actual_micros ELSE 0 END),0) consumed,
      COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched') THEN quoted_micros ELSE 0 END),0) reserved,
      COALESCE(SUM(CASE WHEN state='unknown' THEN quoted_micros ELSE 0 END),0) unknown,
      COALESCE(SUM(CASE WHEN state='settled' THEN overrun_micros ELSE 0 END),0) settled_overrun,
      COALESCE(SUM(CASE WHEN state='settled' THEN 1 ELSE 0 END),0) settled_count,
      COALESCE(SUM(CASE WHEN state='reserved' THEN 1 ELSE 0 END),0) reserved_count,
      COALESCE(SUM(CASE WHEN state='dispatched' THEN 1 ELSE 0 END),0) dispatched_count,
      COALESCE(SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) unknown_count,
      COALESCE(SUM(CASE WHEN state='cancelled' THEN 1 ELSE 0 END),0) cancelled_count
      FROM money_budget_reservations WHERE ${clauses.join(' AND ')}`)
      .safeIntegers(true)
      .get(...parameters);
    const detail = { kind: this.kind, day, currency, taskId, grantId };
    const consumed = safeBig(row.consumed, detail);
    const reserved = safeBig(row.reserved, detail);
    const unknown = safeBig(row.unknown, detail);
    const settledOverrun = safeBig(row.settled_overrun, detail);
    const used = addSafeBig([consumed, reserved, unknown], detail);
    return {
      consumed,
      reserved,
      unknown,
      used,
      settledOverrun,
      attempts: {
        settled: safeBig(row.settled_count, detail),
        reserved: safeBig(row.reserved_count, detail),
        dispatched: safeBig(row.dispatched_count, detail),
        unknown: safeBig(row.unknown_count, detail),
        cancelled: safeBig(row.cancelled_count, detail)
      }
    };
  }

  _pending({ day, currency, taskId, grantId }) {
    const clauses = ["kind=?", "state IN ('reserved','dispatched','unknown')"];
    const parameters = [this.kind];
    if (grantId !== null) {
      clauses.push('grant_id=?');
      parameters.push(grantId);
    } else {
      clauses.push('day=?');
      parameters.push(day);
    }
    if (currency !== null) { clauses.push('currency=?'); parameters.push(currency); }
    if (taskId !== null) { clauses.push('task_id=?'); parameters.push(taskId); }
    const rows = this.db.prepare(`SELECT attempt_id,scope,task_id,currency,state,day,quoted_micros,actual_micros,
      overrun_micros,grant_id,quote_expires_at,created_at,dispatched_at,settled_at
      FROM money_budget_reservations WHERE ${clauses.join(' AND ')}
      ORDER BY created_at,attempt_id LIMIT ?`)
      .all(...parameters, PENDING_LIST_LIMIT + 1);
    return {
      truncated: rows.length > PENDING_LIST_LIMIT,
      rows: rows.slice(0, PENDING_LIST_LIMIT).map(row => ({
        attemptId: row.attempt_id,
        scope: row.scope,
        taskId: row.task_id,
        grantId: row.grant_id,
        currency: row.currency,
        state: row.state,
        day: row.day,
        quotedMicros: row.quoted_micros,
        actualMicros: row.actual_micros,
        overrunMicros: row.overrun_micros,
        quoteExpiresAt: row.quote_expires_at,
        createdAt: row.created_at,
        dispatchedAt: row.dispatched_at,
        settledAt: row.settled_at
      }))
    };
  }
}
