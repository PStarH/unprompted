import { createHash, randomUUID } from 'node:crypto';
import { durableError, iso } from './database.js';
import { MoneyBudgetService } from './money-budget.js';

/**
 * Native transaction money quotes.
 *
 * This component sits above the trusted transaction `MoneyBudgetService`
 * ledger. It does not keep a second ledger and it does not price, execute,
 * authorize a provider action, or grant task permission. It binds one native
 * opaque quote to the exact action context and turns it into at most one
 * ledger attempt, using the core lease, cumulative cap, UTC-day limits,
 * currency, expiry, unknown-hold and settlement rules unchanged.
 *
 * A quote exists only as an exact object instance in this service's private
 * WeakMap. A spread, `JSON.parse(JSON.stringify(...))` round-trip, plain field
 * object, cloned hold or quote issued by another TransactionMoneyService has
 * no private entry and is rejected before any database access. Nothing the
 * model or an untrusted tool argument can serialize can mint a quote or hold.
 *
 * Issuance requires a native synchronous `isCurrent` callback and the same
 * callback must return exactly `true` at every later validation, reservation
 * and dispatch. The callback is captured at issue time. It may not return a
 * promise; a throw, a missing callback, a thenable or any value other than
 * `true` denies the operation. Actor names, task ids or other strings never
 * substitute for the callback.
 *
 * Every quote binds: grant id and current grant version, currency, exact
 * non-negative integer micros, provider, tool, action family, task id, task
 * input version, privacy epoch, resource id, canonical payload digest,
 * canonical effect digest, optional MCP schema/connection identity, issue
 * time and a finite expiry not later than the lease expiry. A different value
 * for any bound field is rejected at validate, reserve and dispatch.
 *
 * The quote row is persisted so quote reuse and quote-to-attempt uniqueness
 * survive restarts and are enforced with the same SQLite transaction as the
 * core reservation. A quote may be bound to exactly one attempt id. An
 * identical replay for that same attempt returns the stored reservation; it
 * never creates a second reservation. A second attempt id is rejected, and so
 * is a second quote for an attempt id that is already bound.
 *
 * `markDispatched` is deliberately not idempotent at this layer: once the
 * attempt is dispatched, repeating the marker fails closed so a success value
 * can never be mistaken for permission to repeat an external effect. The core
 * ledger marker itself remains idempotent for its own callers; this wrapper
 * refuses to re-issue the native permission.
 *
 * Cancellation is allowed only before dispatch. `markUnknown` keeps the full
 * hold, including across restarts, lease expiry and revocation. Only trusted
 * native reconciliation may `settle` with an explicit actual amount and
 * receipt reference; a missing amount is never zero, and an accepted receipt
 * never implies a settled value by itself.
 */

const CURRENCIES = Object.freeze(['CNY', 'EUR', 'USD']);
const CURRENCY_SET = new Set(CURRENCIES);
const MAX_MICROS = Number.MAX_SAFE_INTEGER;
const MAX_ID_LENGTH = 200;
const MAX_PAYLOAD_LENGTH = 256000;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const QUOTE_SPEC_FIELDS = Object.freeze([
  'provider', 'tool', 'actionFamily', 'grantId', 'taskId', 'currency', 'amountMicros',
  'resourceId', 'inputVersion', 'privacyEpoch', 'payload', 'effect', 'quoteExpiresAt',
  'mcpSchemaId', 'mcpConnectionId'
]);
const BINDING_FIELDS = Object.freeze([
  'provider', 'tool', 'actionFamily', 'taskId', 'inputVersion', 'privacyEpoch',
  'resourceId', 'payload', 'effect', 'mcpSchemaId', 'mcpConnectionId'
]);
const QUOTE_FIELDS = Object.freeze([
  'quoteId', 'quoteDigest', 'grantId', 'grantVersion', 'provider', 'tool', 'actionFamily',
  'taskId', 'inputVersion', 'privacyEpoch', 'resourceId', 'currency', 'amountMicros',
  'payloadDigest', 'effectDigest', 'mcpSchemaId', 'mcpConnectionId', 'expiresAt', 'issuedAt'
]);
const HOLD_FIELDS = Object.freeze([
  'attemptId', 'quoteId', 'quoteDigest', 'state', 'currency', 'amountMicros',
  'actualMicros', 'overrunMicros', 'receiptRef', 'grantId', 'grantVersion', 'expiresAt'
]);
const QUOTE_STATES = new Set(['issued', 'reserved', 'dispatched', 'unknown', 'settled', 'cancelled']);
const RESERVATION_STATES = new Set(['reserved', 'dispatched', 'settled', 'cancelled', 'unknown']);

const invalid = message => durableError('INVALID_TRANSACTION_QUOTE', message, 400);

function detailError(code, message, status, detail, reason) {
  const error = durableError(code, message, status);
  error.detail = detail;
  if (reason !== undefined) error.reason = reason;
  return error;
}

const untrustedQuote = (reason, detail = {}) => detailError(
  'TRANSACTION_QUOTE_UNTRUSTED',
  'The transaction quote is not the exact native instance issued by this service; clones, serialized fields and foreign instances grant nothing.',
  403,
  { reason, ...detail },
  reason
);

const untrustedHold = (reason, detail = {}) => detailError(
  'TRANSACTION_HOLD_UNTRUSTED',
  'The transaction hold is not the exact native instance issued by this service.',
  403,
  { reason, ...detail },
  reason
);

const unauthorized = (reason, detail = {}) => detailError(
  'TRANSACTION_QUOTE_UNAUTHORIZED',
  `The native authority-current callback did not allow this operation (${reason}).`,
  403,
  { reason, ...detail },
  reason
);

const mismatch = (field, quoteId) => detailError(
  'TRANSACTION_QUOTE_MISMATCH',
  `The action context does not match the issued quote (${field}).`,
  409,
  { field, quoteId, reason: 'binding_mismatch' },
  'binding_mismatch'
);

const quoteExpired = detail => detailError(
  'TRANSACTION_QUOTE_EXPIRED',
  'The transaction quote has expired; issue a fresh quote for a new attempt.',
  409,
  { reason: 'quote_expired', ...detail },
  'quote_expired'
);

const quoteStale = (reason, detail = {}) => detailError(
  'TRANSACTION_QUOTE_STALE',
  `The transaction quote cannot be used (${reason}).`,
  409,
  { reason, ...detail },
  reason
);

const quoteReused = (reason, detail = {}) => detailError(
  'TRANSACTION_QUOTE_REUSED',
  'This transaction quote is already bound to another attempt and cannot be reused.',
  409,
  { reason, ...detail },
  reason
);

const holdConflict = (reason, detail = {}) => detailError(
  'TRANSACTION_HOLD_CONFLICT',
  `The transaction hold cannot perform this operation (${reason}).`,
  409,
  { reason, ...detail },
  reason
);

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

function optionalIdentifier(value, field) {
  if (value === undefined || value === null) return null;
  return identifier(value, field);
}

function microsValue(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be an explicit non-negative safe integer amount in micros; missing, null and unknown are never zero.`);
  }
  return value;
}

function nonNegativeSafe(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be an explicit non-negative safe integer.`);
  }
  return value;
}

function currencyValue(value) {
  if (typeof value !== 'string' || !CURRENCY_SET.has(value)) {
    throw invalid(`quote.currency must be one of ${CURRENCIES.join(', ')}; it is never converted or treated as unlimited.`);
  }
  return value;
}

function epochValue(value, field) {
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && value.trim()) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw invalid(`${field} must be a non-empty string or a non-negative safe integer.`);
}

function optionalTaskId(value) {
  if (value === undefined) throw invalid('quote.taskId must not be undefined; omit it or pass null.');
  if (value === null) return null;
  return identifier(value, 'quote.taskId');
}

function instantValue(value, field) {
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
  if (!Number.isFinite(milliseconds)) throw invalid(`${field} is not a finite timestamp.`);
  let normalized;
  try { normalized = new Date(milliseconds).toISOString(); }
  catch { throw invalid(`${field} is outside the supported timestamp range.`); }
  if (!DAY_PATTERN.test(normalized.slice(0, 10))) throw invalid(`${field} is outside the supported four-digit-year range.`);
  return { ms: milliseconds, iso: normalized };
}

/** Deterministic JSON encoding: object keys are sorted, cycles and non-JSON
 * values fail closed, and no raw payload is persisted. */
function canonicalJson(value, path, seen) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${path} must not contain non-finite numbers.`);
    return JSON.stringify(value);
  }
  if (type !== 'object') throw invalid(`${path} must contain only JSON data.`);
  if (seen.has(value)) throw invalid(`${path} must not contain cycles.`);
  seen.add(value);
  let encoded;
  if (Array.isArray(value)) {
    const entries = [];
    for (let index = 0; index < value.length; index += 1) entries.push(canonicalJson(value[index], `${path}[${index}]`, seen));
    encoded = `[${entries.join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid(`${path} must contain only plain objects.`);
    if (Object.getOwnPropertySymbols(value).length) throw invalid(`${path} must not contain symbol fields.`);
    const entries = Object.getOwnPropertyNames(value).sort().map(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor)) throw invalid(`${path}.${name} must be a data property.`);
      return `${JSON.stringify(name)}:${canonicalJson(descriptor.value, `${path}.${name}`, seen)}`;
    });
    encoded = `{${entries.join(',')}}`;
  }
  seen.delete(value);
  return encoded;
}

function payloadDigest(value, field) {
  const encoded = canonicalJson(value, field, new Set());
  if (encoded.length > MAX_PAYLOAD_LENGTH) throw invalid(`${field} is too large to bind.`);
  return createHash('sha256').update(encoded).digest('hex');
}

function bindingDigest(fields) {
  return createHash('sha256').update(canonicalJson({
    grantId: fields.grantId,
    grantVersion: fields.grantVersion,
    currency: fields.currency,
    amountMicros: fields.amountMicros,
    provider: fields.provider,
    tool: fields.tool,
    actionFamily: fields.actionFamily,
    taskId: fields.taskId,
    inputVersion: fields.inputVersion,
    privacyEpoch: fields.privacyEpoch,
    resourceId: fields.resourceId,
    payloadDigest: fields.payloadDigest,
    effectDigest: fields.effectDigest,
    mcpSchemaId: fields.mcpSchemaId,
    mcpConnectionId: fields.mcpConnectionId,
    expiresAt: fields.expiresAt
  }, 'quote', new Set())).digest('hex');
}

function frozenView(fields, values) {
  const view = {};
  for (const field of fields) Object.defineProperty(view, field, {
    enumerable: true,
    get: () => values[field],
    set: () => {}
  });
  return Object.freeze(view);
}

export class TransactionMoneyService {
  #quotes = new WeakMap();
  #holds = new WeakMap();

  constructor(database) {
    if (!database?.db) throw new TypeError('TransactionMoneyService requires a DurableDatabase.');
    this.database = database;
    this.db = database.db;
    // The trusted core owns reservations, leases, limits and aggregation.
    this.core = new MoneyBudgetService(database, { kind: 'transaction' });
    const initialize = () => this.db.exec(`
      CREATE TABLE IF NOT EXISTS transaction_money_quotes (
        quote_id TEXT PRIMARY KEY,
        quote_digest TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        grant_version INTEGER NOT NULL CHECK(grant_version >= 1 AND grant_version <= ${MAX_MICROS}),
        currency TEXT NOT NULL CHECK(currency IN ('USD','CNY','EUR')),
        amount_micros INTEGER NOT NULL CHECK(amount_micros >= 0 AND amount_micros <= ${MAX_MICROS}),
        provider TEXT NOT NULL,
        tool TEXT NOT NULL,
        action_family TEXT NOT NULL,
        task_id TEXT,
        input_version INTEGER NOT NULL CHECK(input_version >= 0 AND input_version <= ${MAX_MICROS}),
        privacy_epoch TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        effect_digest TEXT NOT NULL,
        mcp_schema_id TEXT,
        mcp_connection_id TEXT,
        expires_at TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        attempt_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('issued','reserved','dispatched','unknown','settled','cancelled')),
        bound_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK((state = 'issued' AND attempt_id IS NULL AND bound_at IS NULL)
          OR (state <> 'issued' AND attempt_id IS NOT NULL AND bound_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS ix_transaction_money_quotes_grant
        ON transaction_money_quotes(grant_id, state);
    `);
    if (this.db.inTransaction) initialize();
    else database.atomic(initialize);
  }

  /** True only for the exact native quote instance this service issued. */
  isNativeQuote(quote) { return quote !== null && typeof quote === 'object' && this.#quotes.has(quote); }

  /** Trusted configuration surface. Actor permission is enforced by the
   * caller; this service never derives a grant from model text. */
  configureLease(input) { return this.core.configureLease(input); }
  revokeLease(input) { return this.core.revokeLease(input); }

  /** Cumulative spending storage is distinct from the replaceable user lease.
   * Only native Autonomy creation calls this inside its workspace transaction. */
  configureAutonomyBudget({ grantId, autonomyGrantId, scope, taskId, currency, capMicros, expiresAt }) {
    identifier(autonomyGrantId, 'autonomyGrantId');
    return this.database.atomic(() => {
      const previous = this._leaseRow(grantId);
      const configured = this.core.configureLease({ grantId, scope, ...(scope === 'task' ? {taskId} : {}), currency, capMicros, expiresAt, expectedVersion:previous?.version || 0 });
      this.database.set(`autonomy_money_authority:${grantId}`, JSON.stringify({autonomyGrantId}));
      return configured;
    });
  }
  autonomyBudgetInfo(grantId) { return this.core.describe({grantId}).lease; }
  _assertAutonomyAuthority(grantId, taskId, nowMs) {
    const encoded = this.database.get(`autonomy_money_authority:${grantId}`, null);
    if (encoded == null) return;
    let link, state;
    try {
      link = JSON.parse(encoded);
      state = JSON.parse(this.db.prepare('SELECT state_json FROM workspace_state WHERE id=1').get()?.state_json || 'null');
    } catch { throw quoteStale('autonomy_authority_unavailable', {grantId}); }
    const grant = state?.autonomyGrants?.find(item => item.id === link?.autonomyGrantId);
    if (!grant || grant.source !== 'user' || grant.status !== 'active' || grant.moneyBudget?.grantId !== grantId
      || Date.parse(grant.moneyBudget.expiresAt) <= nowMs || !Number.isFinite(Date.parse(grant.moneyBudget.expiresAt))
      || grant.mode === 'time' && !(Date.parse(grant.expiresAt) > nowMs)
      || grant.mode === 'task' && grant.taskId !== taskId || !['time','task'].includes(grant.mode)) {
      throw quoteStale('autonomy_authority_inactive', {grantId});
    }
    const lease = this._leaseRow(grantId);
    if (!lease || lease.version !== grant.moneyBudget.version || lease.currency !== grant.moneyBudget.currency
      || lease.cap_micros !== grant.moneyBudget.capMicros || lease.expires_at !== grant.moneyBudget.expiresAt) {
      throw quoteStale('autonomy_budget_changed', {grantId});
    }
    const task = taskId && this.db.prepare('SELECT status,data_json FROM tasks WHERE id=?').get(taskId);
    const data = task && JSON.parse(task.data_json);
    if (!task || ['completed','cancelled'].includes(task.status) || data.privacyInvalidated || data.userDismissed || data.control?.paused) {
      throw quoteStale('autonomy_task_inactive', {grantId});
    }
  }

  /** Read-only lease snapshot for trusted contract validation. */
  leaseInfo(grantId) {
    const id = identifier(grantId, 'grantId');
    const lease = this._leaseRow(id);
    if (!lease) return null;
    return Object.freeze({ grantId: lease.grant_id, scope: lease.scope, taskId: lease.scope_id || null, currency: lease.currency,
      capMicros: lease.cap_micros, expiresAt: lease.expires_at, revoked: lease.revoked === 1, version: lease.version });
  }

  #attemptRow(attemptId) {
    const attempt = identifier(attemptId, 'attemptId');
    const row = this.db.prepare('SELECT * FROM transaction_money_quotes WHERE attempt_id=?').get(attempt);
    if (!row) throw untrustedQuote('attempt_missing', { attemptId: attempt });
    if (bindingDigest(this._rowFields(row)) !== row.quote_digest) throw untrustedQuote('quote_digest_mismatch', { attemptId: attempt });
    return row;
  }

  _rowFields(row) {
    return { grantId: row.grant_id, grantVersion: row.grant_version, currency: row.currency, amountMicros: row.amount_micros,
      provider: row.provider, tool: row.tool, actionFamily: row.action_family, taskId: row.task_id,
      inputVersion: row.input_version, privacyEpoch: row.privacy_epoch, resourceId: row.resource_id,
      payloadDigest: row.payload_digest, effectDigest: row.effect_digest, mcpSchemaId: row.mcp_schema_id,
      mcpConnectionId: row.mcp_connection_id, expiresAt: row.expires_at };
  }

  /** Crash/reconciliation read of the persisted attempt. */
  attemptInfo(attemptId) {
    const row = this.#attemptRow(attemptId);
    const reservation = this._reservationRow(row.attempt_id);
    return Object.freeze({ attemptId: row.attempt_id, quoteId: row.quote_id, state: row.state, currency: row.currency,
      amountMicros: row.amount_micros, grantId: row.grant_id, taskId: row.task_id, expiresAt: row.expires_at,
      actualMicros: reservation?.actual_micros ?? null, receiptRef: reservation?.receipt_ref ?? null });
  }

  /** Trusted restart/reconciliation transitions. They validate the persisted
   * native quote row and delegate to the core ledger; none of them can mint a
   * new permission or release a dispatched hold. */
  cancelAttempt(attemptId) {
    return this.database.atomic(() => {
      const row = this.#attemptRow(attemptId);
      if (row.state === 'cancelled') return this.attemptInfo(row.attempt_id);
      if (row.state !== 'reserved') throw holdConflict('state', { attemptId: row.attempt_id, state: row.state });
      this.core.cancelBeforeDispatch(row.attempt_id);
      this.db.prepare("UPDATE transaction_money_quotes SET state='cancelled',updated_at=? WHERE quote_id=? AND attempt_id=? AND state='reserved'").run(iso(this._nowMs()), row.quote_id, row.attempt_id);
      return this.attemptInfo(row.attempt_id);
    });
  }

  markUnknownAttempt(attemptId) {
    return this.database.atomic(() => {
      const row = this.#attemptRow(attemptId);
      if (row.state === 'unknown') return this.attemptInfo(row.attempt_id);
      if (row.state !== 'reserved' && row.state !== 'dispatched') throw holdConflict('state', { attemptId: row.attempt_id, state: row.state });
      this.core.markUnknown(row.attempt_id);
      this.db.prepare("UPDATE transaction_money_quotes SET state='unknown',updated_at=? WHERE quote_id=? AND attempt_id=? AND state IN ('reserved','dispatched')").run(iso(this._nowMs()), row.quote_id, row.attempt_id);
      return this.attemptInfo(row.attempt_id);
    });
  }

  settleAttempt(attemptId, evidence = {}) {
    plainObject(evidence, 'settlement', ['actualMicros', 'receiptRef']);
    if (!hasValue(evidence, 'actualMicros')) throw invalid('settlement.actualMicros is required; missing or null is never zero.');
    const actualMicros = microsValue(evidence.actualMicros, 'settlement.actualMicros');
    if (!hasValue(evidence, 'receiptRef')) throw invalid('settlement.receiptRef is required.');
    const receiptRef = identifier(evidence.receiptRef, 'settlement.receiptRef');
    return this.database.atomic(() => {
      const row = this.#attemptRow(attemptId);
      if (row.state === 'settled') return this.attemptInfo(row.attempt_id);
      if (row.state !== 'reserved' && row.state !== 'dispatched' && row.state !== 'unknown') throw holdConflict('state', { attemptId: row.attempt_id, state: row.state });
      this.core.settle({ attemptId: row.attempt_id, actualMicros, receiptRef });
      this.db.prepare("UPDATE transaction_money_quotes SET state='settled',updated_at=? WHERE quote_id=? AND attempt_id=? AND state IN ('reserved','dispatched','unknown')").run(iso(this._nowMs()), row.quote_id, row.attempt_id);
      return this.attemptInfo(row.attempt_id);
    });
  }

  /**
   * Issue one opaque quote. `spec` is the complete trusted action context;
   * `authority.isCurrent` is a native synchronous callback and is mandatory.
   * The service generates the quote id and a digest over every bound field.
   * No raw payload or effect is stored.
   */
  issueQuote(spec = {}, authority = {}) {
    plainObject(spec, 'quote', QUOTE_SPEC_FIELDS);
    plainObject(authority, 'authority', ['isCurrent']);
    if (typeof authority.isCurrent !== 'function') throw unauthorized('callback_required');

    for (const name of ['provider', 'tool', 'actionFamily', 'grantId', 'currency', 'resourceId', 'inputVersion', 'privacyEpoch', 'quoteExpiresAt']) {
      if (!hasValue(spec, name)) throw invalid(`quote.${name} is required; missing or null is never a trusted default.`);
    }
    if (!hasValue(spec, 'amountMicros')) throw invalid('quote.amountMicros is required; missing or null is never zero.');
    if (!Object.hasOwn(spec, 'payload') || spec.payload === undefined) throw invalid('quote.payload is required.');
    if (!Object.hasOwn(spec, 'effect') || spec.effect === undefined) throw invalid('quote.effect is required.');

    const provider = identifier(spec.provider, 'quote.provider');
    const tool = identifier(spec.tool, 'quote.tool');
    const actionFamily = identifier(spec.actionFamily, 'quote.actionFamily');
    const grantId = identifier(spec.grantId, 'quote.grantId');
    const taskId = optionalTaskId(spec.taskId);
    const currency = currencyValue(spec.currency);
    const amountMicros = microsValue(spec.amountMicros, 'quote.amountMicros');
    const resourceId = identifier(spec.resourceId, 'quote.resourceId');
    const inputVersion = nonNegativeSafe(spec.inputVersion, 'quote.inputVersion');
    const privacyEpoch = epochValue(spec.privacyEpoch, 'quote.privacyEpoch');
    const mcpSchemaId = optionalIdentifier(spec.mcpSchemaId, 'quote.mcpSchemaId');
    const mcpConnectionId = optionalIdentifier(spec.mcpConnectionId, 'quote.mcpConnectionId');
    const expiresAt = instantValue(spec.quoteExpiresAt, 'quote.quoteExpiresAt');
    const payloadHash = payloadDigest(spec.payload, 'quote.payload');
    const effectHash = payloadDigest(spec.effect, 'quote.effect');

    return this.database.atomic(() => {
      const nowMs = this._nowMs();
      const at = iso(nowMs);
      if (expiresAt.ms <= nowMs) throw quoteExpired({ quoteExpiresAt: expiresAt.iso, now: at });

      this._assertAutonomyAuthority(grantId, taskId, nowMs);
      const lease = this._leaseRow(grantId);
      if (!lease) {
        throw detailError('TRANSACTION_QUOTE_GRANT_NOT_FOUND', `No transaction grant lease exists for "${grantId}".`, 404, { grantId }, 'grant_missing');
      }
      if (lease.revoked === 1) throw quoteStale('grant_revoked', { grantId });
      if (Date.parse(lease.expires_at) <= nowMs) throw quoteStale('grant_expired', { grantId, expiresAt: lease.expires_at });
      if (lease.currency !== currency) throw quoteStale('grant_currency_changed', { grantId, grantCurrency: lease.currency, quoteCurrency: currency });
      if (lease.scope === 'task' && taskId !== lease.scope_id) {
        throw quoteStale('grant_task_changed', { grantId, grantTaskId: lease.scope_id, quoteTaskId: taskId });
      }
      if (expiresAt.ms > Date.parse(lease.expires_at)) {
        throw invalid('quote.quoteExpiresAt must not be later than the grant lease expiry.');
      }

      const fields = {
        grantId, grantVersion: lease.version, currency, amountMicros, provider, tool, actionFamily,
        taskId, inputVersion, privacyEpoch, resourceId, payloadDigest: payloadHash,
        effectDigest: effectHash, mcpSchemaId, mcpConnectionId, expiresAt: expiresAt.iso
      };
      this._assertCurrent(authority.isCurrent, { ...fields, quoteId: null, attemptId: null, phase: 'issue', now: at });

      const quoteId = `txq_${randomUUID()}`;
      const quoteDigest = bindingDigest(fields);
      this.db.prepare(`INSERT INTO transaction_money_quotes
        (quote_id,quote_digest,grant_id,grant_version,currency,amount_micros,provider,tool,action_family,
         task_id,input_version,privacy_epoch,resource_id,payload_digest,effect_digest,mcp_schema_id,mcp_connection_id,
         expires_at,issued_at,attempt_id,state,bound_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'issued',NULL,?)`)
        .run(
          quoteId, quoteDigest, grantId, lease.version, currency, amountMicros, provider, tool, actionFamily,
          taskId, inputVersion, privacyEpoch, resourceId, payloadHash, effectHash, mcpSchemaId, mcpConnectionId,
          expiresAt.iso, at, at
        );
      return this.#makeQuote(this._requireQuoteRow(quoteId), authority.isCurrent);
    });
  }

  /**
   * Read-only preflight for a quote that is issued or already reserved.
   * Returns a frozen summary, never a permission to dispatch. Reserve and
   * markDispatched perform their own checks in their own write transaction.
   */
  validate(quote, binding) {
    const brand = this.#quoteBrand(quote);
    const context = this._binding(binding);
    return this.database.atomic(() => {
      const row = this._requireQuoteRow(brand.quoteId);
      this._verifyQuoteRow(row, brand);
      if (row.state !== 'issued' && row.state !== 'reserved') {
        throw holdConflict('state', { quoteId: row.quote_id, state: row.state });
      }
      this._assertBinding(row, context);
      const nowMs = this._nowMs();
      this._assertGrantCurrent(row, nowMs);
      this._assertCurrent(brand.isCurrent, this._authorityContext(row, 'validate', nowMs));
      return Object.freeze({
        valid: true,
        quoteId: row.quote_id,
        attemptId: row.attempt_id,
        grantId: row.grant_id,
        grantVersion: row.grant_version,
        currency: row.currency,
        amountMicros: row.amount_micros,
        state: row.state,
        expiresAt: row.expires_at
      });
    });
  }

  /**
   * Bind the quote to one attempt and reserve in the trusted core ledger.
   * The quote claim, the core reservation and every check share one SQLite
   * transaction. A failed core admission rolls the claim back, so the same
   * quote and attempt can be retried after the blocking condition is fixed.
   */
  reserve(quote, options = {}) {
    const brand = this.#quoteBrand(quote);
    plainObject(options, 'reserve', ['attemptId', 'binding']);
    if (!hasValue(options, 'attemptId')) throw invalid('reserve.attemptId is required.');
    const attemptId = identifier(options.attemptId, 'reserve.attemptId');
    if (!hasValue(options, 'binding')) throw invalid('reserve.binding is required.');
    const context = this._binding(options.binding);

    return this.database.atomic(() => {
      const row = this._requireQuoteRow(brand.quoteId);
      this._verifyQuoteRow(row, brand);
      const nowMs = this._nowMs();
      const at = iso(nowMs);

      if (row.attempt_id !== null) {
        if (row.attempt_id !== attemptId) {
          throw quoteReused('quote_bound_to_other_attempt', { quoteId: row.quote_id, boundAttemptId: row.attempt_id, attemptId });
        }
        const existing = this._reservationRow(attemptId);
        if (!existing) throw untrustedQuote('reservation_missing', { quoteId: row.quote_id, attemptId });
        this._assertReservationMatches(row, existing);
        this._assertBinding(row, context);
        this._assertGrantCurrent(row, nowMs);
        this._assertCurrent(brand.isCurrent, this._authorityContext(row, 'reserve', nowMs));
        const reservation = this.core.reserve(this._coreReservation(row, attemptId));
        return this.#makeHold(row, reservation, brand.isCurrent);
      }

      if (row.state !== 'issued') throw holdConflict('state', { quoteId: row.quote_id, state: row.state });
      const occupant = this._reservationRow(attemptId);
      if (occupant) throw quoteReused('attempt_bound_to_other_quote', { attemptId, boundQuoteId: occupant.quote_id });
      const boundQuote = this.db.prepare('SELECT quote_id FROM transaction_money_quotes WHERE attempt_id=?').get(attemptId);
      if (boundQuote) throw quoteReused('attempt_bound_to_other_quote', { attemptId, boundQuoteId: boundQuote.quote_id });
      this._assertBinding(row, context);
      this._assertGrantCurrent(row, nowMs);
      this._assertCurrent(brand.isCurrent, this._authorityContext(row, 'reserve', nowMs));

      const claimed = this.db.prepare(`UPDATE transaction_money_quotes
        SET attempt_id=?,state='reserved',bound_at=?,updated_at=?
        WHERE quote_id=? AND attempt_id IS NULL AND state='issued'`)
        .run(attemptId, at, at, row.quote_id);
      if (claimed.changes !== 1) throw quoteReused('claim_lost', { quoteId: row.quote_id, attemptId });

      const reservation = this.core.reserve(this._coreReservation(row, attemptId));
      return this.#makeHold(this._requireQuoteRow(row.quote_id), reservation, brand.isCurrent);
    });
  }

  /**
   * Record the single dispatch marker after rechecking binding, callback,
   * quote expiry and the current grant version/revocation/expiry. Repeating
   * the call fails closed; the returned hold is a new opaque instance.
   */
  markDispatched(hold, binding) {
    const brand = this.#holdBrand(hold);
    const context = this._binding(binding);
    return this.database.atomic(() => {
      const row = this._requireQuoteRow(brand.quoteId);
      this._verifyQuoteRow(row, brand);
      this._assertHoldRow(row, brand);
      if (row.state === 'dispatched') throw holdConflict('already_dispatched', { attemptId: row.attempt_id, quoteId: row.quote_id });
      if (row.state !== 'reserved') throw holdConflict('state', { attemptId: row.attempt_id, state: row.state });
      this._assertBinding(row, context);
      const nowMs = this._nowMs();
      this._assertGrantCurrent(row, nowMs);
      this._assertCurrent(brand.isCurrent, this._authorityContext(row, 'dispatch', nowMs));

      const reservation = this.core.markDispatched(row.attempt_id);
      const updated = this.db.prepare(`UPDATE transaction_money_quotes SET state='dispatched',updated_at=?
        WHERE quote_id=? AND attempt_id=? AND state='reserved'`)
        .run(iso(nowMs), row.quote_id, row.attempt_id);
      if (updated.changes !== 1) throw holdConflict('state', { attemptId: row.attempt_id });
      return this.#makeHold(this._requireQuoteRow(row.quote_id), reservation, brand.isCurrent);
    });
  }

  /** Cancel a reservation that was never dispatched. Repeats are safe. */
  cancelBeforeDispatch(hold) {
    const brand = this.#holdBrand(hold);
    return this.database.atomic(() => {
      const row = this._requireQuoteRow(brand.quoteId);
      this._verifyQuoteRow(row, brand);
      this._assertHoldRow(row, brand);
      if (row.state === 'cancelled') {
        const existing = this._reservationRow(row.attempt_id);
        if (!existing) throw untrustedQuote('reservation_missing', { quoteId: row.quote_id, attemptId: row.attempt_id });
        return this.#makeHold(row, this._projectRow(existing), brand.isCurrent);
      }
      if (row.state !== 'reserved') throw holdConflict('state', { attemptId: row.attempt_id, state: row.state });
      const reservation = this.core.cancelBeforeDispatch(row.attempt_id);
      const updated = this.db.prepare(`UPDATE transaction_money_quotes SET state='cancelled',updated_at=?
        WHERE quote_id=? AND attempt_id=? AND state='reserved'`)
        .run(iso(this._nowMs()), row.quote_id, row.attempt_id);
      if (updated.changes !== 1) throw holdConflict('state', { attemptId: row.attempt_id });
      return this.#makeHold(this._requireQuoteRow(row.quote_id), reservation, brand.isCurrent);
    });
  }

  /**
   * Keep the full hold when the transport outcome is unknown. Revocation,
   * lease expiry, restart and forgetting never release it. A later trusted
   * settlement may still resolve the value.
   */
  markUnknown(hold) {
    const brand = this.#holdBrand(hold);
    return this.database.atomic(() => {
      const row = this._requireQuoteRow(brand.quoteId);
      this._verifyQuoteRow(row, brand);
      this._assertHoldRow(row, brand);
      if (row.state === 'unknown') {
        const existing = this._reservationRow(row.attempt_id);
        if (!existing) throw untrustedQuote('reservation_missing', { quoteId: row.quote_id, attemptId: row.attempt_id });
        return this.#makeHold(row, this._projectRow(existing), brand.isCurrent);
      }
      if (row.state !== 'reserved' && row.state !== 'dispatched') throw holdConflict('state', { attemptId: row.attempt_id, state: row.state });
      const reservation = this.core.markUnknown(row.attempt_id);
      const updated = this.db.prepare(`UPDATE transaction_money_quotes SET state='unknown',updated_at=?
        WHERE quote_id=? AND attempt_id=? AND state IN ('reserved','dispatched')`)
        .run(iso(this._nowMs()), row.quote_id, row.attempt_id);
      if (updated.changes !== 1) throw holdConflict('state', { attemptId: row.attempt_id });
      return this.#makeHold(this._requireQuoteRow(row.quote_id), reservation, brand.isCurrent);
    });
  }

  /**
   * Trusted native reconciliation only. `actualMicros` and `receiptRef` are
   * explicit own evidence; a missing amount is never zero and an accepted
   * receipt alone never proves a settled value. The core records overruns
   * truthfully and keeps the original day and grant.
   */
  settle(hold, evidence = {}) {
    const brand = this.#holdBrand(hold);
    plainObject(evidence, 'settlement', ['actualMicros', 'receiptRef']);
    if (!hasValue(evidence, 'actualMicros')) throw invalid('settlement.actualMicros is required; missing or null is never zero.');
    const actualMicros = microsValue(evidence.actualMicros, 'settlement.actualMicros');
    if (!hasValue(evidence, 'receiptRef')) throw invalid('settlement.receiptRef is required.');
    const receiptRef = identifier(evidence.receiptRef, 'settlement.receiptRef');

    return this.database.atomic(() => {
      const row = this._requireQuoteRow(brand.quoteId);
      this._verifyQuoteRow(row, brand);
      this._assertHoldRow(row, brand);
      if (row.state === 'cancelled') throw holdConflict('cancelled', { attemptId: row.attempt_id });
      if (row.state === 'settled') {
        const reservation = this.core.settle({ attemptId: row.attempt_id, actualMicros, receiptRef });
        return this.#makeHold(row, reservation, brand.isCurrent);
      }
      if (row.state !== 'reserved' && row.state !== 'dispatched' && row.state !== 'unknown') {
        throw holdConflict('state', { attemptId: row.attempt_id, state: row.state });
      }
      const reservation = this.core.settle({ attemptId: row.attempt_id, actualMicros, receiptRef });
      const updated = this.db.prepare(`UPDATE transaction_money_quotes SET state='settled',updated_at=?
        WHERE quote_id=? AND attempt_id=? AND state IN ('reserved','dispatched','unknown')`)
        .run(iso(this._nowMs()), row.quote_id, row.attempt_id);
      if (updated.changes !== 1) throw holdConflict('state', { attemptId: row.attempt_id });
      return this.#makeHold(this._requireQuoteRow(row.quote_id), reservation, brand.isCurrent);
    });
  }

  #quoteBrand(quote) {
    if (quote === null || typeof quote !== 'object') throw untrustedQuote('not_an_object');
    const brand = this.#quotes.get(quote);
    if (!brand) throw untrustedQuote('unbranded_quote');
    return brand;
  }

  #holdBrand(hold) {
    if (hold === null || typeof hold !== 'object') throw untrustedHold('not_an_object');
    const brand = this.#holds.get(hold);
    if (!brand) throw untrustedHold('unbranded_hold');
    return brand;
  }

  #makeQuote(row, isCurrent) {
    const values = Object.freeze({
      quoteId: row.quote_id,
      quoteDigest: row.quote_digest,
      grantId: row.grant_id,
      grantVersion: row.grant_version,
      provider: row.provider,
      tool: row.tool,
      actionFamily: row.action_family,
      taskId: row.task_id,
      inputVersion: row.input_version,
      privacyEpoch: row.privacy_epoch,
      resourceId: row.resource_id,
      currency: row.currency,
      amountMicros: row.amount_micros,
      payloadDigest: row.payload_digest,
      effectDigest: row.effect_digest,
      mcpSchemaId: row.mcp_schema_id,
      mcpConnectionId: row.mcp_connection_id,
      expiresAt: row.expires_at,
      issuedAt: row.issued_at
    });
    const quote = frozenView(QUOTE_FIELDS, values);
    this.#quotes.set(quote, Object.freeze({ ...values, isCurrent }));
    return quote;
  }

  #makeHold(row, reservation, isCurrent) {
    if (!reservation || !RESERVATION_STATES.has(reservation.state)) throw holdConflict('state_unknown', { attemptId: row.attempt_id });
    const values = Object.freeze({
      attemptId: row.attempt_id,
      quoteId: row.quote_id,
      quoteDigest: row.quote_digest,
      state: reservation.state,
      currency: row.currency,
      amountMicros: row.amount_micros,
      actualMicros: reservation.actualMicros,
      overrunMicros: reservation.overrunMicros,
      receiptRef: reservation.receiptRef,
      grantId: row.grant_id,
      grantVersion: row.grant_version,
      expiresAt: row.expires_at
    });
    const hold = frozenView(HOLD_FIELDS, values);
    this.#holds.set(hold, Object.freeze({ ...values, isCurrent }));
    return hold;
  }

  _assertHoldRow(row, brand) {
    if (row.attempt_id !== brand.attemptId || row.quote_digest !== brand.quoteDigest) {
      throw untrustedHold('quote_mismatch', { quoteId: brand.quoteId });
    }
  }

  _binding(input) {
    plainObject(input, 'binding', BINDING_FIELDS);
    for (const name of ['provider', 'tool', 'actionFamily', 'resourceId', 'inputVersion', 'privacyEpoch']) {
      if (!hasValue(input, name)) throw invalid(`binding.${name} is required; missing or null is never a trusted default.`);
    }
    if (!Object.hasOwn(input, 'payload') || input.payload === undefined) throw invalid('binding.payload is required.');
    if (!Object.hasOwn(input, 'effect') || input.effect === undefined) throw invalid('binding.effect is required.');
    return {
      provider: identifier(input.provider, 'binding.provider'),
      tool: identifier(input.tool, 'binding.tool'),
      actionFamily: identifier(input.actionFamily, 'binding.actionFamily'),
      taskId: optionalTaskId(input.taskId),
      inputVersion: nonNegativeSafe(input.inputVersion, 'binding.inputVersion'),
      privacyEpoch: epochValue(input.privacyEpoch, 'binding.privacyEpoch'),
      resourceId: identifier(input.resourceId, 'binding.resourceId'),
      payloadDigest: payloadDigest(input.payload, 'binding.payload'),
      effectDigest: payloadDigest(input.effect, 'binding.effect'),
      mcpSchemaId: optionalIdentifier(input.mcpSchemaId, 'binding.mcpSchemaId'),
      mcpConnectionId: optionalIdentifier(input.mcpConnectionId, 'binding.mcpConnectionId')
    };
  }

  _assertBinding(row, binding) {
    const checks = [
      ['provider', row.provider, binding.provider],
      ['tool', row.tool, binding.tool],
      ['actionFamily', row.action_family, binding.actionFamily],
      ['taskId', row.task_id, binding.taskId],
      ['inputVersion', row.input_version, binding.inputVersion],
      ['privacyEpoch', row.privacy_epoch, binding.privacyEpoch],
      ['resourceId', row.resource_id, binding.resourceId],
      ['payload', row.payload_digest, binding.payloadDigest],
      ['effect', row.effect_digest, binding.effectDigest],
      ['mcpSchemaId', row.mcp_schema_id, binding.mcpSchemaId],
      ['mcpConnectionId', row.mcp_connection_id, binding.mcpConnectionId]
    ];
    for (const [field, stored, supplied] of checks) {
      if (stored !== supplied) throw mismatch(field, row.quote_id);
    }
  }

  _assertGrantCurrent(row, nowMs) {
    this._assertAutonomyAuthority(row.grant_id, row.task_id, nowMs);
    if (Date.parse(row.expires_at) <= nowMs) throw quoteExpired({ quoteId: row.quote_id, quoteExpiresAt: row.expires_at, now: iso(nowMs) });
    const lease = this._leaseRow(row.grant_id);
    if (!lease) throw quoteStale('grant_missing', { quoteId: row.quote_id, grantId: row.grant_id });
    if (lease.revoked === 1) throw quoteStale('grant_revoked', { quoteId: row.quote_id, grantId: row.grant_id });
    if (Date.parse(lease.expires_at) <= nowMs) {
      throw quoteStale('grant_expired', { quoteId: row.quote_id, grantId: row.grant_id, expiresAt: lease.expires_at });
    }
    if (lease.version !== row.grant_version) {
      throw quoteStale('grant_version_changed', { quoteId: row.quote_id, grantId: row.grant_id, boundVersion: row.grant_version, currentVersion: lease.version });
    }
    if (lease.currency !== row.currency) {
      throw quoteStale('grant_currency_changed', { quoteId: row.quote_id, grantId: row.grant_id });
    }
    if (lease.scope === 'task' && lease.scope_id !== row.task_id) {
      throw quoteStale('grant_task_changed', { quoteId: row.quote_id, grantId: row.grant_id });
    }
    if (Date.parse(row.expires_at) > Date.parse(lease.expires_at)) {
      throw quoteStale('quote_exceeds_grant', { quoteId: row.quote_id, grantId: row.grant_id });
    }
  }

  _assertCurrent(isCurrent, context) {
    let result;
    try {
      result = isCurrent(Object.freeze({ ...context }));
    } catch {
      throw unauthorized('callback_threw', { phase: context.phase });
    }
    if (result && typeof result.then === 'function') throw unauthorized('callback_async', { phase: context.phase });
    if (result !== true) throw unauthorized('callback_denied', { phase: context.phase });
  }

  _authorityContext(row, phase, nowMs) {
    return {
      phase,
      quoteId: row.quote_id,
      attemptId: row.attempt_id,
      provider: row.provider,
      tool: row.tool,
      actionFamily: row.action_family,
      taskId: row.task_id,
      inputVersion: row.input_version,
      privacyEpoch: row.privacy_epoch,
      resourceId: row.resource_id,
      payloadDigest: row.payload_digest,
      effectDigest: row.effect_digest,
      mcpSchemaId: row.mcp_schema_id,
      mcpConnectionId: row.mcp_connection_id,
      grantId: row.grant_id,
      grantVersion: row.grant_version,
      currency: row.currency,
      amountMicros: row.amount_micros,
      expiresAt: row.expires_at,
      now: iso(nowMs)
    };
  }

  _coreReservation(row, attemptId) {
    const taskId = row.task_id;
    return {
      attemptId,
      scope: taskId === null ? 'workspace' : 'task',
      taskId,
      currency: row.currency,
      quotedMicros: row.amount_micros,
      quoteId: row.quote_id,
      quoteDigest: row.quote_digest,
      quoteExpiresAt: row.expires_at,
      grantId: row.grant_id
    };
  }

  _assertReservationMatches(row, reservation) {
    const differing = [];
    if (reservation.kind !== 'transaction') differing.push('kind');
    if (reservation.grant_id !== row.grant_id) differing.push('grantId');
    if (reservation.currency !== row.currency) differing.push('currency');
    if (reservation.quoted_micros !== row.amount_micros) differing.push('amountMicros');
    if (reservation.quote_id !== row.quote_id) differing.push('quoteId');
    if (reservation.quote_digest !== row.quote_digest) differing.push('quoteDigest');
    if (reservation.quote_expires_at !== row.expires_at) differing.push('quoteExpiresAt');
    if (reservation.task_id !== row.task_id) differing.push('taskId');
    if (differing.length) throw quoteStale('reservation_mismatch', { quoteId: row.quote_id, attemptId: row.attempt_id, differing });
  }

  _verifyQuoteRow(row, brand) {
    if (row.quote_id !== brand.quoteId) throw untrustedQuote('quote_id_mismatch');
    const expected = bindingDigest({
      grantId: row.grant_id,
      grantVersion: row.grant_version,
      currency: row.currency,
      amountMicros: row.amount_micros,
      provider: row.provider,
      tool: row.tool,
      actionFamily: row.action_family,
      taskId: row.task_id,
      inputVersion: row.input_version,
      privacyEpoch: row.privacy_epoch,
      resourceId: row.resource_id,
      payloadDigest: row.payload_digest,
      effectDigest: row.effect_digest,
      mcpSchemaId: row.mcp_schema_id,
      mcpConnectionId: row.mcp_connection_id,
      expiresAt: row.expires_at
    });
    if (expected !== row.quote_digest || row.quote_digest !== brand.quoteDigest) {
      throw untrustedQuote('quote_digest_mismatch', { quoteId: brand.quoteId });
    }
  }

  _requireQuoteRow(quoteId) {
    const row = this.db.prepare('SELECT * FROM transaction_money_quotes WHERE quote_id=?').get(quoteId);
    if (!row) throw untrustedQuote('quote_missing', { quoteId });
    return row;
  }

  _leaseRow(grantId) {
    return this.db.prepare("SELECT * FROM money_budget_leases WHERE kind='transaction' AND grant_id=?").get(grantId) ?? null;
  }

  _reservationRow(attemptId) {
    return this.db.prepare("SELECT * FROM money_budget_reservations WHERE attempt_id=? AND kind='transaction'").get(attemptId) ?? null;
  }

  _projectRow(row) {
    const active = ['reserved', 'dispatched', 'unknown'].includes(row.state);
    return {
      state: row.state,
      actualMicros: row.actual_micros,
      overrunMicros: row.overrun_micros,
      receiptRef: row.receipt_ref,
      consumedMicros: row.state === 'settled' ? row.actual_micros : active ? row.quoted_micros : 0
    };
  }

  _nowMs() {
    const value = this.database.now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('The database clock returned an invalid timestamp.');
    return value;
  }
}
