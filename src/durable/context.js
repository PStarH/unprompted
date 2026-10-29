import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';

// This registry is runtime code, never a learned or model-editable record.
const DEFINITIONS = Object.freeze({
  'event.provider': Object.freeze({ type: 'string', ttlMs: 30 * 60000 }),
  'event.family': Object.freeze({ type: 'string', ttlMs: 30 * 60000 }),
  'event.actionable': Object.freeze({ type: 'boolean', ttlMs: 30 * 60000 }),
  'sender.identity': Object.freeze({ type: 'string', ttlMs: 30 * 60000 }),
  'project.id': Object.freeze({ type: 'string', ttlMs: 30 * 60000 }),
  'resource.id': Object.freeze({ type: 'string', ttlMs: 30 * 60000 }),
  'task.family': Object.freeze({ type: 'string', ttlMs: 30 * 60000 }),
  'task.priority': Object.freeze({ type: 'number', ttlMs: 30 * 60000 }),
  'task.requires_review': Object.freeze({ type: 'boolean', ttlMs: 30 * 60000 }),
  'task.has_deadline': Object.freeze({ type: 'boolean', ttlMs: 30 * 60000 }),
  'user.present': Object.freeze({ type: 'boolean', ttlMs: 60000 })
});
const UNKNOWN = Symbol('missing-or-stale');

export class FeatureRegistry {
  constructor() { Object.freeze(this); }
  describe() { return structuredClone(DEFINITIONS); }
  validate(ast, depth = 0) {
    if (!ast || typeof ast !== 'object' || Array.isArray(ast) || depth > 8 || json(ast).length > 12000) throw durableError('INVALID_PREDICATE', 'Invalid or unbounded activation predicate.', 400);
    if (['all', 'any'].includes(ast.op)) {
      if (!Array.isArray(ast.args) || ast.args.length < 1 || ast.args.length > 16) throw durableError('INVALID_PREDICATE', 'Predicate groups require 1–16 children.', 400);
      ast.args.forEach(child => this.validate(child, depth + 1)); return ast;
    }
    if (ast.op === 'not') { this.validate(ast.arg, depth + 1); return ast; }
    if (ast.op === 'always' && Object.keys(ast).length === 1) return ast;
    const definition = DEFINITIONS[ast.feature];
    if (!definition || !['eq', 'in', 'gte', 'lte'].includes(ast.op)) throw durableError('UNKNOWN_FEATURE', 'The predicate refers to an unknown feature or operator.', 400);
    const values = ast.op === 'in' ? ast.value : [ast.value];
    if (!Array.isArray(values) || !values.length || values.length > 32 || values.some(value => typeof value !== definition.type || typeof value === 'number' && !Number.isFinite(value))) throw durableError('FEATURE_TYPE', 'Predicate value does not match the registered feature type.', 400);
    if (['gte', 'lte'].includes(ast.op) && definition.type !== 'number') throw durableError('FEATURE_TYPE', 'Ordered predicates require a numeric feature.', 400);
    return ast;
  }
  evaluate(ast, features, { now = Date.now(), contextVersion = null } = {}) {
    this.validate(ast);
    const evaluate = node => {
      if (node.op === 'always') return true;
      if (node.op === 'not') { const value = evaluate(node.arg); return value === UNKNOWN ? UNKNOWN : !value; }
      if (['all', 'any'].includes(node.op)) {
        const values = node.args.map(evaluate);
        if (node.op === 'all') return values.includes(false) ? false : values.includes(UNKNOWN) ? UNKNOWN : true;
        return values.includes(true) ? true : values.includes(UNKNOWN) ? UNKNOWN : false;
      }
      const feature = features?.[node.feature], definition = DEFINITIONS[node.feature];
      const observed = Date.parse(feature?.observedAt);
      if (!feature || feature.valid === false || typeof feature.value !== definition.type || definition.type === 'number' && !Number.isFinite(feature.value) || !Number.isFinite(observed) || observed > now || now - observed >= definition.ttlMs
        || feature.validUntil && (!Number.isFinite(Date.parse(feature.validUntil)) || Date.parse(feature.validUntil) <= now) || contextVersion != null && feature.contextVersion !== contextVersion) return UNKNOWN;
      if (node.op === 'eq') return feature.value === node.value;
      if (node.op === 'in') return node.value.includes(feature.value);
      return node.op === 'gte' ? feature.value >= node.value : feature.value <= node.value;
    };
    const value = evaluate(ast); return { matched: value === true, known: value !== UNKNOWN };
  }
  capture(values, { now = Date.now(), contextVersion = 0 } = {}) {
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => DEFINITIONS[key] && typeof value === DEFINITIONS[key].type).map(([key, value]) => [key, { value, observedAt: iso(now), contextVersion, valid: true }]));
  }
}

const POLICY_EFFECTS = ['suppress', 'priority', 'notification', 'require_review'];
const SCOPES = ['global', 'task_family', 'project', 'entity', 'resource'];
export const scopeMatches = (type, key, scopes) => type === 'global' || scopes.some(scope => scope.type === type && scope.key === key);

export class ActivationPolicies {
  constructor(database, registry = new FeatureRegistry()) { this.database = database; this.db = database.db; this.registry = registry; }
  save({ id = randomUUID(), instruction, predicate, effect, scopeType = 'global', scopeKey = '*', priority = 0, identities = [], expectedVersion = null, confirmed = false }) {
    this.registry.validate(predicate);
    if (!SCOPES.includes(scopeType) || typeof scopeKey !== 'string' || !scopeKey || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000 || !POLICY_EFFECTS.includes(effect?.type)) throw durableError('INVALID_POLICY', 'Invalid explicit activation policy.', 400);
    const allowedEffectKeys = { suppress: ['type'], require_review: ['type'], priority: ['type', 'value'], notification: ['type', 'class'] };
    if (Object.keys(effect).some(key => !allowedEffectKeys[effect.type].includes(key)) || !Number.isInteger(priority) || priority < -100 || priority > 100) throw durableError('INVALID_POLICY', 'Unsupported policy fields or priority.', 400);
    if (effect.type === 'priority' && (!Number.isInteger(effect.value) || effect.value < 0 || effect.value > 100)) throw durableError('INVALID_POLICY', 'Policy priority must be 0–100.', 400);
    if (effect.type === 'notification' && !['critical', 'interactive', 'informational', 'digest'].includes(effect.class)) throw durableError('INVALID_POLICY', 'Invalid notification policy.', 400);
    const senderKeys = [];
    const inspect = node => { if (node.feature === 'sender.identity') senderKeys.push(...(Array.isArray(node.value) ? node.value : [node.value])); (node.args || []).forEach(inspect); if (node.arg) inspect(node.arg); };
    inspect(predicate);
    const unresolved = senderKeys.some(key => !identities.some(identity => identity.providerId === key && identity.confirmedByUser === true && identity.provider));
    if (!unresolved && senderKeys.length) {
      const providers = [...new Set(identities.filter(identity => senderKeys.includes(identity.providerId) && identity.confirmedByUser).map(identity => identity.provider))];
      predicate = { op: 'all', args: [predicate, providers.length === 1 ? { op: 'eq', feature: 'event.provider', value: providers[0] } : { op: 'in', feature: 'event.provider', value: providers }] };
      this.registry.validate(predicate);
    }
    const status = unresolved || effect.class === 'critical' && !confirmed ? 'draft' : 'active';
    return this.database.atomic(() => {
      const existing = this.db.prepare('SELECT version FROM activation_policies WHERE id=?').get(id);
      if (existing && expectedVersion !== existing.version || !existing && expectedVersion != null) throw durableError('POLICY_CHANGED', 'The policy changed before this update.');
      const at = iso(this.database.now());
      this.db.prepare(`INSERT INTO activation_policies(id,status,scope_type,scope_key,predicate_ast_json,effect_signature_json,instruction_text,priority,identity_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,scope_type=excluded.scope_type,scope_key=excluded.scope_key,
        predicate_ast_json=excluded.predicate_ast_json,effect_signature_json=excluded.effect_signature_json,instruction_text=excluded.instruction_text,
        priority=excluded.priority,identity_json=excluded.identity_json,version=activation_policies.version+1,updated_at=excluded.updated_at`).run(id, status, scopeType, scopeKey, json(predicate), json(effect), instruction, priority, json(identities), at, at);
      for (const identity of identities.filter(identity => identity.confirmedByUser && identity.provider && identity.providerId)) {
        this.db.prepare(`INSERT INTO canonical_entities VALUES(?,?,?,?,?,1,?) ON CONFLICT(provider,provider_id) DO UPDATE SET aliases_json=excluded.aliases_json,updated_at=excluded.updated_at`).run(identity.id || randomUUID(), 'person', identity.provider, identity.providerId, json(identity.aliases || []), at);
      }
      for (const identity of identities.filter(item => item.confirmedByUser && item.provider && item.providerId)) {
        const entity = this.db.prepare('SELECT id FROM canonical_entities WHERE provider=? AND provider_id=?').get(identity.provider, identity.providerId);
        this.database.lineage('policy', id, 'canonical_entity', entity.id);
      }
      const version = this.database.bump('context_version');
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'policy\',?,?)').run(id, at);
      this.db.prepare(`INSERT INTO hot_context_items VALUES(?,?,?,?,?,?) ON CONFLICT(origin_kind,origin_id) DO UPDATE SET context_version=excluded.context_version,
        projection_json=excluded.projection_json,updated_at=excluded.updated_at`).run(`policy:${id}`, 'policy', id, version, json({ id, status, predicate, effect, scopeType, scopeKey, instruction }), at);
      return this.get(id);
    });
  }
  get(id) { const row = this.db.prepare('SELECT * FROM activation_policies WHERE id=?').get(id); return row && { ...row, predicate: parse(row.predicate_ast_json), effect: parse(row.effect_signature_json) }; }
  hotContext(expectedVersion = Number(this.database.get('context_version'))) {
    const current = Number(this.database.get('context_version'));
    if (expectedVersion !== current) throw durableError('CONTEXT_CHANGED', 'Hot Context is stale.');
    return { version: current, items: this.db.prepare('SELECT origin_kind,origin_id,projection_json FROM hot_context_items').all().map(row => ({ kind: row.origin_kind, id: row.origin_id, ...parse(row.projection_json) })) };
  }
  list() { return this.db.prepare('SELECT id FROM activation_policies ORDER BY created_at,id').all().map(row => this.get(row.id)); }
  disable(id, expectedVersion) {
    return this.database.atomic(() => {
      const row = this.get(id); if (!row || row.version !== expectedVersion) throw durableError('POLICY_CHANGED', 'The policy has changed.');
      this.db.prepare("UPDATE activation_policies SET status='disabled',version=version+1,updated_at=? WHERE id=? AND version=?").run(iso(this.database.now()), id, expectedVersion);
      this.db.prepare('DELETE FROM hot_context_items WHERE origin_kind=\'policy\' AND origin_id=?').run(id);
      this.database.bump('context_version'); return this.get(id);
    });
  }
  evaluate(features, scopes = [], expectedContextVersion = Number(this.database.get('context_version'))) {
    const version = Number(this.database.get('context_version'));
    if (expectedContextVersion !== version) throw durableError('CONTEXT_CHANGED', 'Hot Context is stale.');
    const evaluated = this.list().filter(policy => policy.status === 'active' && scopeMatches(policy.scope_type, policy.scope_key, scopes)).map(policy => ({ policy, match: this.registry.evaluate(policy.predicate, features, { now: this.database.now(), contextVersion: version }) }));
    const applicable = evaluated.filter(item => item.match.matched).map(item => item.policy);
    const unresolved = evaluated.filter(item => !item.match.known && ['suppress', 'require_review'].includes(item.policy.effect.type)).map(item => item.policy);
    // Learned Experiences are intentionally absent from this authorization path.
    const suppressed = applicable.some(policy => policy.effect.type === 'suppress');
    const priority = applicable.filter(policy => policy.effect.type === 'priority').sort((a, b) => b.priority - a.priority);
    const notifications = applicable.filter(policy => policy.effect.type === 'notification').sort((a, b) => b.priority - a.priority);
    const notificationConflict = notifications.length > 1 && notifications[0].priority === notifications[1].priority && notifications[0].effect.class !== notifications[1].effect.class;
    return { activate: !suppressed, priority: priority[0]?.effect.value ?? 0, notificationClass: notificationConflict ? 'interactive' : notifications[0]?.effect.class || null,
      unresolvedPolicyIds: unresolved.map(policy => policy.id), requiresReview: unresolved.length > 0 || notificationConflict || applicable.some(policy => policy.effect.type === 'require_review'), policyIds: applicable.map(policy => policy.id), contextVersion: version };
  }
}

export const WORKING_CONTEXT_DEFAULTS = Object.freeze({ maxEvents: 12, maxAssociations: 3, windowMs: 30 * 60000, scoreThreshold: 1.5, salienceWindowMs: 7 * 86400000, maxCandidates: 2000 });
const generic = new Set(['topic:meeting', 'topic:budget', 'topic:urgent', 'person:boss', 'meeting', 'budget', 'urgent']);
const compatible = (left, right) => left === right || new Set([left, right]).size === 2 && [left, right].every(family => ['supplier_quote', 'supplier_quote_update'].includes(family));

export class WorkingContextIndex {
  constructor(database, options = {}) { this.database = database; this.db = database.db; this.options = { ...WORKING_CONTEXT_DEFAULTS, ...parse(database.get('working_context_policy', '{}')), ...options }; this.stopList = new Set([...generic, ...(options.stopList || [])]); }
  configure(options) {
    if (Object.keys(options).some(key => !Object.hasOwn(WORKING_CONTEXT_DEFAULTS, key))) throw durableError('INVALID_CONTEXT_POLICY', 'Unknown context setting.', 400);
    const next = { ...this.options, ...options };
    if (![next.maxEvents, next.maxAssociations, next.maxCandidates].every(Number.isInteger) || next.maxEvents < 1 || next.maxEvents > 100 || next.maxAssociations < 1 || next.maxAssociations > 3 || next.maxCandidates < 1 || next.maxCandidates > 10000 || !Number.isFinite(next.scoreThreshold) || next.scoreThreshold < 1 || next.scoreThreshold > 20 || ![next.windowMs, next.salienceWindowMs].every(value => Number.isFinite(value) && value > 0 && value <= 90 * 86400000)) throw durableError('INVALID_CONTEXT_POLICY', 'Invalid bounded context settings.', 400);
    this.database.atomic(() => this.database.set('working_context_policy', json(next))); this.options = next; return next;
  }
  salience(entity) {
    const since = iso(this.database.now() - this.options.salienceWindowMs);
    const total = this.db.prepare('SELECT COUNT(DISTINCT event_id) n FROM entity_events WHERE observed_at>=?').get(since).n;
    const containing = this.db.prepare('SELECT COUNT(DISTINCT event_id) n FROM entity_events WHERE entity_key=? AND observed_at>=?').get(entity, since).n;
    return Math.log((1 + total) / (1 + containing));
  }
  associate({ eventId, provider, family, anchors = [], entities = [], dimensions = [], deadlineAt = null }) {
    if (!family || !eventId || anchors.length > 16 || entities.length > 32 || dimensions.length > 16) throw durableError('INVALID_CONTEXT', 'Invalid bounded context association.', 400);
    const strong = anchors.filter(anchor => ['thread', 'resource', 'project', 'task', 'meeting', 'canonical_entity'].includes(anchor.kind) && anchor.id && (anchor.kind !== 'canonical_entity' || anchor.confirmedByUser === true && ['project', 'resource', 'task', 'meeting'].includes(anchor.entityType)))
      .map(anchor => `${anchor.kind}:${anchor.kind === 'thread' || anchor.kind === 'resource' ? `${anchor.provider || provider}:` : ''}${anchor.id}`);
    const useful = [...new Set(entities.filter(entity => typeof entity === 'string' && !this.stopList.has(entity) && !/^(email|organization):/.test(entity)))];
    return this.database.atomic(() => {
      const at = iso(this.database.now());
      if (!this.db.prepare('SELECT 1 FROM durable_inbox WHERE id=?').get(eventId)) throw durableError('MISSING_EVENT', 'Context must reference a durable inbox event.', 400);
      const existing = this.db.prepare('SELECT candidate_id FROM candidate_events WHERE event_id=?').all(eventId);
      if (existing.length) return { candidateIds: existing.map(row => row.candidate_id), created: false, split: false };
      for (const entity of useful) this.db.prepare('INSERT OR IGNORE INTO entity_events VALUES(?,?,?)').run(entity, eventId, at);
      const recent = this.db.prepare(`SELECT * FROM working_candidates WHERE state!='CLOSED' AND
        (last_event_at>=? OR deadline_at IS NOT NULL AND deadline_at>=?) ORDER BY last_event_at DESC LIMIT ?`).all(iso(this.database.now() - this.options.windowMs), at, this.options.maxCandidates);
      const ranked = recent.filter(candidate => compatible(candidate.family, family)).map(candidate => {
        const candidateAnchors = parse(candidate.anchors_json), candidateEntities = parse(candidate.entities_json);
        const sharedStrong = strong.filter(anchor => candidateAnchors.includes(anchor));
        const sharedEntities = useful.filter(entity => candidateEntities.keys.includes(entity));
        const independent = [...new Set(dimensions.filter(value => candidateEntities.dimensions.includes(value)).map(value => value.split(':')[0]))];
        const projectSpecific = sharedEntities.some(value => /^(project|resource):/.test(value));
        const evidence = sharedStrong.length > 0 || independent.length >= 2 && projectSpecific;
        const count = this.db.prepare('SELECT COUNT(*) n FROM candidate_events WHERE candidate_id=?').get(candidate.id).n;
        const score = sharedStrong.length * 2 + sharedEntities.reduce((sum, entity) => sum + this.salience(entity), 0) + independent.length * 0.5;
        return { candidate, count, evidence, score };
      }).filter(entry => entry.evidence && entry.score >= this.options.scoreThreshold).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
      const allowed = ranked.filter(entry => entry.count < this.options.maxEvents).slice(0, this.options.maxAssociations);
      if (!allowed.length) {
        const id = randomUUID();
        this.db.prepare("INSERT INTO working_candidates VALUES(?,?,'ACCUMULATE',?,?,?, ?,?,?)").run(id, family, json(strong), json({ keys: useful, dimensions: [...new Set(dimensions)] }), '[]', deadlineAt, at, at);
        this.db.prepare('INSERT INTO candidate_events VALUES(?,?,?)').run(id, eventId, at);
        this.database.lineage('event', eventId, 'candidate', id);
        return { candidateIds: [id], created: true, split: ranked.some(entry => entry.count >= this.options.maxEvents) };
      }
      for (const { candidate } of allowed) {
        const data = parse(candidate.entities_json);
        this.db.prepare('INSERT INTO candidate_events VALUES(?,?,?)').run(candidate.id, eventId, at);
        this.db.prepare('UPDATE working_candidates SET last_event_at=?,anchors_json=?,entities_json=? WHERE id=?').run(at,
          json([...new Set([...parse(candidate.anchors_json), ...strong])].slice(0, 32)), json({ keys: [...new Set([...data.keys, ...useful])].slice(0, 64), dimensions: [...new Set([...data.dimensions, ...dimensions])].slice(0, 32) }), candidate.id);
        this.database.lineage('event', eventId, 'candidate', candidate.id);
      }
      return { candidateIds: allowed.map(entry => entry.candidate.id), created: false, split: false };
    });
  }
}
