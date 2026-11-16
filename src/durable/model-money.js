import { createHash, createHmac, randomUUID } from 'node:crypto';
import { durableError } from './database.js';
import { MoneyBudgetService } from './money-budget.js';
import { normalizePriceProfile, knownUsageCost, quoteRequestReservation } from '../model-pricing.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = message => durableError('MONEY_PROFILE_REQUIRED', message, 409);

/** Opaque local identity. Credential-derived fingerprints remain private and
 * keyed by the workspace salt; credentials are never persisted here. */
export function modelProviderIdentity(database, { baseUrl, protocol, apiKey = null } = {}) {
  if (typeof baseUrl !== 'string' || typeof protocol !== 'string' || !(apiKey === null || typeof apiKey === 'string')) {
    throw required('A native provider configuration is required.');
  }
  const salt = database.get('privacy_salt');
  if (typeof salt !== 'string' || !salt) throw required('The workspace identity secret is unavailable.');
  const fingerprint = createHmac('sha256', salt).update('unprompted.model-provider/v1\0').update(JSON.stringify({ baseUrl, protocol, apiKey })).digest('hex');
  return database.atomic(() => {
    database.db.exec('CREATE TABLE IF NOT EXISTS model_provider_identities (fingerprint TEXT PRIMARY KEY, provider_id TEXT NOT NULL UNIQUE)');
    const prior = database.db.prepare('SELECT provider_id FROM model_provider_identities WHERE fingerprint=?').get(fingerprint);
    if (prior) return prior.provider_id;
    const id = randomUUID();
    database.db.prepare('INSERT INTO model_provider_identities VALUES(?,?)').run(fingerprint, id);
    return id;
  });
}

/** Trusted, workspace-local pricing participant for the model transport.
 * providerId is a trusted connection identity, never a model-supplied value.
 * This service neither authorizes transactions nor makes network calls. */
export class ModelMoneyService {
  #wakeQueue = null;
  constructor(database, { providerId } = {}) {
    if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 200) throw required('A trusted provider connection identity is required.');
    this.database = database;
    this.providerId = providerId;
    this.budget = new MoneyBudgetService(database, { kind: 'model' });
    database.atomic(() => database.db.exec(`CREATE TABLE IF NOT EXISTS model_price_snapshots (
      provider_id TEXT NOT NULL, model TEXT NOT NULL, protocol TEXT NOT NULL, currency TEXT NOT NULL,
      profile_json TEXT NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY(provider_id,model,protocol,currency))`));
  }
  attachWakeQueue(jobs) {
    if (jobs?.database !== this.database || typeof jobs.startBudgetWake !== 'function') throw required('Money wakes require this workspace job queue.');
    this.#wakeQueue = jobs;
  }
  #capacityReleased(key, taskId = null) {
    this.#wakeQueue?.startBudgetWake({ key: `model-money:${digest(key)}`, kind: 'model', taskId });
  }
  configureLimit(input) {
    return this.database.atomic(() => {
      const result = this.budget.configureLimit(input);
      this.#capacityReleased(['limit', result.scope, result.taskId, result.version], result.taskId);
      return result;
    });
  }
  configureProfile(input, { expectedVersion = 0 } = {}) {
    const profile = normalizePriceProfile(input);
    if (profile.providerId !== this.providerId) throw required('The price belongs to a different provider connection.');
    return this.database.atomic(() => {
      const reference = this.budget.configureProfile({ providerId: profile.providerId, model: profile.model, protocol: profile.protocol,
        currency: profile.currency, profileDigest: profile.digest, revision: profile.revision, expectedVersion });
      this.database.db.prepare(`INSERT INTO model_price_snapshots VALUES(?,?,?,?,?,?)
        ON CONFLICT(provider_id,model,protocol,currency) DO UPDATE SET profile_json=excluded.profile_json,version=excluded.version`)
        .run(profile.providerId, profile.model, profile.protocol, profile.currency, JSON.stringify(profile), reference.version);
      this.#capacityReleased(['profile', profile.providerId, profile.model, profile.protocol, profile.currency, reference.version]);
      return { profile, version: reference.version };
    });
  }
  snapshot({ model, protocol, taskId = null }) {
    const limits = this.database.db.prepare("SELECT scope,scope_id,currency,micros,version FROM money_budget_limits WHERE kind='model' AND (scope='workspace' OR (scope='task' AND scope_id=?)) ORDER BY scope,scope_id").all(taskId || '');
    const active = limits.filter(row => row.micros !== null);
    const currencies = [...new Set(active.map(row => row.currency))];
    if (currencies.length > 1) throw required('Workspace and task money budgets require the same currency.');
    const rows = this.database.db.prepare('SELECT profile_json,version FROM model_price_snapshots WHERE provider_id=? AND model=? AND protocol=? ORDER BY currency').all(this.providerId, model, protocol);
    const candidates = rows.map(row => ({ profile: normalizePriceProfile(JSON.parse(row.profile_json)), version: row.version }))
      .filter(row => !currencies.length || row.profile.currency === currencies[0]);
    if (candidates.length > 1) throw required('Select a money budget currency before using multiple price currencies.');
    const selected = candidates[0] || null;
    if (active.length && !selected) throw required('Confirm complete prices for this connection, model, protocol and budget currency before dispatch.');
    const profile = selected?.profile || null;
    return Object.freeze({ profile, enabled: Boolean(profile || active.length), digest: digest({ providerId: this.providerId, model, protocol, taskId, limits, selected }) });
  }
  reserve(snapshot, { attemptId, scope, taskId, inputTokens, outputTokens }) {
    if (!snapshot.profile) return null;
    const profile = snapshot.profile;
    const quote = quoteRequestReservation(profile, { inputUpperBound: inputTokens, outputCap: outputTokens });
    const spec = { attemptId, scope, taskId, currency: profile.currency, quotedMicros: quote.amountMicro,
      quoteId: randomUUID(), quoteDigest: digest({ attemptId, quote }), quoteExpiresAt: new Date(this.database.now() + 60000).toISOString(),
      profileSnapshot: { providerId: profile.providerId, model: profile.model, protocol: profile.protocol, profileDigest: profile.digest, revision: profile.revision } };
    const reservation = this.budget.reserve(spec);
    return Object.freeze({ profile, spec: Object.freeze(spec), createdAt: reservation.createdAt });
  }
  markDispatched(hold) {
    if (!hold) return;
    const row = this.budget.reserve(hold.spec);
    if (row.state !== 'reserved' || row.createdAt !== hold.createdAt) {
      throw durableError('MONEY_ACCOUNTING_CONFLICT', 'Only the original reserved money hold can issue a fresh dispatch permit.', 409);
    }
    try { this.budget.markDispatched(hold.spec.attemptId); }
    catch (error) {
      if (error?.code !== 'MONEY_BUDGET_STALE') throw error;
      throw Object.assign(durableError('MONEY_ACCOUNTING_STALE', 'The fee quote or limit changed before dispatch; retry with current settings.', 503),
        { definitiveNoEffect: true, retryAt: new Date(Number(this.database.now()) + 1).toISOString() });
    }
  }
  settle(hold, usage) {
    if (!hold) return;
    if (!usage) return this.budget.markUnknown(hold.spec.attemptId);
    const cost = knownUsageCost(hold.profile, usage);
    return this.database.atomic(() => {
      const result = this.budget.settle({ attemptId: hold.spec.attemptId, actualMicros: cost.amountMicro, receiptRef: `model-usage:${hold.spec.attemptId}` });
      if (cost.amountMicro < hold.spec.quotedMicros) this.#capacityReleased(['settle', hold.spec.attemptId]);
      return result;
    });
  }
  fail(hold, dispatched) {
    if (!hold) return;
    return this.database.atomic(() => {
      const result = dispatched ? this.budget.markUnknown(hold.spec.attemptId) : this.budget.cancelBeforeDispatch(hold.spec.attemptId);
      if (!dispatched) this.#capacityReleased(['cancel', hold.spec.attemptId]);
      return result;
    });
  }
}
