import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';

const ROLES = ['DIRECT_ACTOR', 'SHARED_GROUP', 'PASSIVE_OBSERVER', 'UNKNOWN'];
const STATUSES = ['proposed', 'active', 'paused', 'disabled', 'expired'];
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value, max, itemMax) => Array.isArray(value) && value.length <= max && value.every(item => text(item, itemMax));

export function validateStandingIntent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const prefilter = input.prefilter;
  if (!prefilter || typeof prefilter !== 'object' || Array.isArray(prefilter)) return null;
  if (!text(input.description, 500) || !text(input.desiredOutcome, 300)) return null;
  if (!list(prefilter.connectorIds || [], 8, 80) || !list(prefilter.accountIds || [], 8, 200) || !list(prefilter.eventTypes || [], 8, 80)) return null;
  if (!Array.isArray(prefilter.roles) || !prefilter.roles.length || prefilter.roles.some(role => !ROLES.includes(role))) return null;
  if (prefilter.tokens && (!list(prefilter.tokens, 8, 40) || prefilter.tokens.some(token => token.trim().length < 2))) return null;
  if (!(prefilter.connectorIds || []).length || !(prefilter.eventTypes || []).length) return null;
  const scope = input.scope || {};
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || json(scope).length > 4000) return null;
  const autonomy = input.autonomy || { maxAutonomy: 'observe' };
  if (!['observe', 'prepare'].includes(autonomy.maxAutonomy)) return null;
  const prohibited = Array.isArray(input.prohibited) ? input.prohibited : ['external_write'];
  if (!list(prohibited, 12, 80) || !prohibited.includes('external_write')) return null;
  const budget = input.budget || { maxMatches: 20, windowMs: 86400000 };
  if (!Number.isInteger(budget.maxMatches) || budget.maxMatches < 1 || budget.maxMatches > 100) return null;
  if (!Number.isInteger(budget.windowMs) || budget.windowMs < 60000 || budget.windowMs > 90 * 86400000) return null;
  if (input.predicate != null && !text(input.predicate, 300)) return null;
  if (input.expiresAt != null && !Number.isFinite(Date.parse(input.expiresAt))) return null;
  return {
    description: input.description.trim(),
    prefilter: { connectorIds: prefilter.connectorIds || [], accountIds: prefilter.accountIds || [], eventTypes: prefilter.eventTypes, roles: prefilter.roles, tokens: (prefilter.tokens || []).map(token => token.toLowerCase()) },
    predicate: input.predicate?.trim() || null,
    scope, desiredOutcome: input.desiredOutcome.trim(), autonomy, prohibited,
    probePolicy: input.probePolicy && typeof input.probePolicy === 'object' ? input.probePolicy : {},
    budget, expiresAt: input.expiresAt || null
  };
}

const project = row => row && ({ ...row, prefilter: parse(row.prefilter_json), predicate: row.predicate_json, scope: parse(row.scope_json),
  autonomy: parse(row.autonomy_json), prohibited: parse(row.prohibited_json), probePolicy: parse(row.probe_policy_json), budget: parse(row.budget_json) });

/** Explicit user delegation. External content can only file a proposal. */
export class StandingIntents {
  constructor(database) { this.database = database; this.db = database.db; }
  get(id) { return project(this.db.prepare('SELECT * FROM standing_intents WHERE id=?').get(id)); }
  list({ limit = 50 } = {}) { return this.db.prepare('SELECT * FROM standing_intents ORDER BY updated_at DESC LIMIT ?').all(Math.min(100, limit)).map(project); }
  create(input, { actor = 'user', confirmed = false } = {}) {
    const spec = validateStandingIntent(input);
    if (!spec) throw durableError('INVALID_STANDING_INTENT', 'A StandingIntent needs a bounded prefilter, scope, and prohibited external writes.', 400);
    if (actor !== 'user' || confirmed !== true) throw durableError('INTENT_CONFIRMATION_REQUIRED', 'Only an explicit user confirmation can create a StandingIntent. External content cannot authorize one.', 403);
    const id = randomUUID(), at = iso(this.database.now());
    this.database.atomic(() => {
      this.db.prepare(`INSERT INTO standing_intents(id,status,description,prefilter_json,predicate_json,scope_json,desired_outcome,autonomy_json,prohibited_json,probe_policy_json,budget_json,created_by,confirmation,created_at,updated_at,expires_at)
        VALUES(?,'active',?,?,?,?,?,?,?,?,?,'user','user_confirmed',?,?,?)`).run(id, spec.description, json(spec.prefilter), spec.predicate, json(spec.scope), spec.desiredOutcome, json(spec.autonomy), json(spec.prohibited), json(spec.probePolicy), json(spec.budget), at, at, spec.expiresAt);
      this.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('standing_intent',?,?)").run(id, at);
    });
    return this.get(id);
  }
  propose(input, { eventId = null } = {}) {
    const spec = validateStandingIntent(input);
    if (!spec) throw durableError('INVALID_STANDING_INTENT', 'The proposal is not a valid StandingIntent.', 400);
    const id = randomUUID(), at = iso(this.database.now());
    this.database.atomic(() => {
      this.db.prepare(`INSERT INTO standing_intents(id,status,description,prefilter_json,predicate_json,scope_json,desired_outcome,autonomy_json,prohibited_json,probe_policy_json,budget_json,created_by,confirmation,created_at,updated_at,expires_at)
        VALUES(?,'proposed',?,?,?,?,?,?,?,?,?,'external','proposed_only',?,?,?)`).run(id, spec.description, json(spec.prefilter), spec.predicate, json(spec.scope), spec.desiredOutcome, json(spec.autonomy), json(spec.prohibited), json(spec.probePolicy), json(spec.budget), at, at, spec.expiresAt);
      this.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('standing_intent',?,?)").run(id, at);
      if (eventId) this.database.lineage('event', eventId, 'standing_intent', id);
    });
    return this.get(id);
  }
  transition(id, expectedVersion, status) {
    if (!STATUSES.includes(status) || status === 'proposed') throw durableError('INVALID_INTENT_TRANSITION', 'Unsupported StandingIntent transition.', 400);
    return this.database.atomic(() => {
      const current = this.get(id);
      if (!current || current.version !== expectedVersion) throw durableError('INTENT_CHANGED', 'The StandingIntent version changed.');
      if (current.confirmation !== 'user_confirmed' && status === 'active') throw durableError('INTENT_CONFIRMATION_REQUIRED', 'An unconfirmed proposal cannot become active.', 403);
      if (current.status === 'disabled' && status !== 'disabled') throw durableError('INTENT_DISABLED', 'A disabled StandingIntent stays disabled.');
      const at = iso(this.database.now());
      const changed = this.db.prepare('UPDATE standing_intents SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, at, id, expectedVersion).changes;
      if (!changed) throw durableError('INTENT_CHANGED', 'The StandingIntent version changed.');
      return this.get(id);
    });
  }
  matchesPrefilter(intent, event) {
    if (!intent || intent.status !== 'active' || intent.confirmation !== 'user_confirmed') return false;
    if (intent.expires_at && Date.parse(intent.expires_at) <= this.database.now()) return false;
    const filter = intent.prefilter;
    if (filter.connectorIds.length && !filter.connectorIds.includes(event.connectorId)) return false;
    if (filter.accountIds.length && !filter.accountIds.includes(event.payload?.accountId || '')) return false;
    if (!filter.eventTypes.includes(event.type)) return false;
    const role = event.meta?.principalRole || 'UNKNOWN';
    if (!filter.roles.includes(role)) return false;
    if (filter.tokens?.length) {
      const haystack = `${event.payload?.subject || ''}\n${event.payload?.body || ''}`.toLowerCase();
      if (!filter.tokens.every(token => haystack.includes(token))) return false;
    }
    return true;
  }
  prefilterHits(event, { limit = 3 } = {}) {
    return this.list({ limit: 50 }).filter(intent => this.matchesPrefilter(intent, event)).slice(0, limit);
  }
  budgetOpen(intent) {
    const since = iso(this.database.now() - intent.budget.windowMs);
    const used = this.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='standing_intent' AND outcome IN ('MATCHED','UNRELATED','INVALID') AND evaluator_version=? AND created_at>=?").get(intent.id, since).n;
    return used < intent.budget.maxMatches;
  }
  record(intentId, eventId, outcome, reason, situationId = null) {
    this.db.prepare('INSERT INTO activation_decisions VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), eventId, null, situationId, 'standing_intent', outcome, reason, intentId, iso(this.database.now()));
    if (outcome === 'MATCHED') this.db.prepare('UPDATE standing_intents SET matches_used=matches_used+1,updated_at=? WHERE id=?').run(iso(this.database.now()), intentId);
  }
}
