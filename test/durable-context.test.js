import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { FeatureRegistry, ActivationPolicies, WorkingContextIndex } from '../src/durable/context.js';
import { AttentionBudget } from '../src/durable/attention.js';
import { HybridMemory } from '../src/durable/memory.js';

function setup(t, options = {}) {
  let now = Date.now(); const database = new DurableDatabase(':memory:', { now: () => now });
  const context = new WorkingContextIndex(database, options); t.after(() => database.close());
  const add = id => database.atomic(() => database.db.prepare('INSERT INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)').run(id, 'fixture', id, '{}', id, iso(now)));
  return { database, context, add, advance: value => { now += value; } };
}
test('v0.3/19 generic people and topics never create transitive context super-clusters', t => {
  const context = setup(t), results = [];
  for (let index = 0; index < 5; index++) {
    const eventId = `unrelated-${index}`; context.add(eventId);
    results.push(context.context.associate({ eventId, provider: 'fixture', family: 'work', entities: ['person:boss', 'topic:meeting'], dimensions: ['person:boss', 'topic:meeting'] }));
  }
  assert.equal(new Set(results.flatMap(result => result.candidateIds)).size, 5);
});
test('v0.3/20 independent explicit anchors associate compatible cross-provider work', t => {
  const context = setup(t), anchors = [{ kind: 'project', id: 'project-42' }, { kind: 'canonical_entity', id: 'confirmed-resource', entityType: 'resource', confirmedByUser: true }];
  context.add('google'); context.add('github');
  const first = context.context.associate({ eventId: 'google', provider: 'google', family: 'supplier_quote', anchors });
  const second = context.context.associate({ eventId: 'github', provider: 'github', family: 'supplier_quote_update', anchors });
  assert.deepEqual(first.candidateIds, second.candidateIds); assert.equal(second.created, false);
});
test('v0.3/21 candidate overflow splits and per-event association limits hold', t => {
  const context = setup(t); let last;
  for (let index = 0; index < 13; index++) {
    const eventId = `burst-${index}`; context.add(eventId);
    last = context.context.associate({ eventId, provider: 'fixture', family: 'work', anchors: [{ kind: 'project', id: 'project' }] });
  }
  assert.equal(last.split, true);
  assert.equal(context.database.db.prepare('SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM candidate_events GROUP BY candidate_id)').get().n, 12);
});
test('v0.3/22 exhausted notification budgets create digests while preserving decisions and deadlines', t => {
  const context = setup(t), attention = new AttentionBudget(context.database);
  const notification = id => ({ id, dedupeKey: id, headline: 'Approval required', taskId: id, deadline: '2026-11-01', decision: 'Review this action' });
  assert.equal(attention.offer(notification('first')).state, 'delivered');
  for (const id of ['second', 'third', 'fourth']) attention.offer(notification(id), { class: 'informational', issueKey: 'shared-dependency' });
  const digest = attention.digest(); assert.equal(digest.length, 1); assert.equal(digest[0].ids.length, 3);
  const stored = JSON.parse(context.database.db.prepare("SELECT notification_json FROM notification_deliveries WHERE dedupe_key='second'").get().notification_json);
  assert.equal(stored.deadline, '2026-11-01'); assert.equal(stored.decision, 'Review this action');
  assert.equal(attention.offer(notification('configured-critical'), { class: 'critical', criticalConfigured: true }).state, 'delivered');
});

test('an unresolved critical notification defers unrelated interruptions until it resolves', t => {
  const context = setup(t), attention = new AttentionBudget(context.database, { minIntervalMs: 0, digestWindowMs: 0 });
  assert.equal(attention.offer({ id: 'urgent', dedupeKey: 'urgent' }, { class: 'critical', criticalConfigured: true }).state, 'delivered');
  assert.equal(attention.offer({ id: 'routine', dedupeKey: 'routine' }).state, 'pending');
  assert.equal(attention.releaseDue().length, 0);
  attention.resolve('urgent');
  assert.equal(attention.releaseDue().length, 1);
});

test('the portfolio view derives deadlines, critical attention and current claims without writing', t => {
  const { database } = setup(t), attention = new AttentionBudget(database);
  const now = database.now(), at = iso(now), date = at.slice(0, 10);
  database.atomic(() => {
    database.db.prepare('INSERT INTO tasks(id,data_json,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('due-task', JSON.stringify({ request: { deadline: { iso: date } } }), 'waiting_for_information', at, at);
    database.db.prepare("INSERT INTO resource_claims(user_id,provider,resource_id,lease_until,claim_state) VALUES('local','calendar','slot-a',?,'held')").run(iso(now + 60000));
  });
  attention.offer({ id: 'urgent', taskId: 'due-task' }, { class: 'critical', criticalConfigured: true });
  attention.offer({ id: 'routine', taskId: 'other' });
  const serial = database.commitSerial, summary = attention.activeContext();
  assert.equal(database.commitSerial, serial);
  assert.equal(summary.critical[0].taskId, 'due-task');
  assert.equal(summary.deadlines[0].taskId, 'due-task');
  assert.equal(summary.claims[0].resource_id, 'slot-a');
  assert.equal(summary.notifications.pending, 1);
  assert.equal(summary.calendarAvailability, 'unavailable');
  assert.equal(summary.focusAffinity, null);
});
test('v0.3/23 resolved explicit policy and Hot Context commit together before activation', t => {
  const context = setup(t), policies = new ActivationPolicies(context.database), registry = new FeatureRegistry();
  const draft = policies.save({ instruction: 'Prioritize emails from Li.', predicate: { op: 'eq', feature: 'sender.identity', value: 'li@example.test' }, effect: { type: 'priority', value: 99 } });
  assert.equal(draft.status, 'draft');
  const saved = policies.save({ id: draft.id, expectedVersion: draft.version, instruction: 'Prioritize this exact mailbox.', predicate: draft.predicate, effect: draft.effect,
    identities: [{ provider: 'google', providerId: 'li@example.test', confirmedByUser: true }] });
  const version = Number(context.database.get('context_version'));
  const hot = context.database.db.prepare('SELECT * FROM hot_context_items WHERE origin_id=?').get(saved.id);
  assert.equal(hot.context_version, version); assert.equal(JSON.parse(hot.projection_json).status, 'active');
  const features = registry.capture({ 'event.provider': 'google', 'sender.identity': 'li@example.test' }, { now: context.database.now(), contextVersion: version });
  assert.equal(policies.evaluate(features, [], version).priority, 99);
  const other = registry.capture({ 'event.provider': 'github', 'sender.identity': 'li@example.test' }, { now: context.database.now(), contextVersion: version });
  assert.equal(policies.evaluate(other, [], version).priority, 0, 'an identity rule is provider-bound');
});
test('v0.3/24 stale retrieval and feature-cache versions are rejected, including under not', t => {
  const context = setup(t), memory = new HybridMemory(context.database), registry = new FeatureRegistry();
  memory.put({ id: 'memory', content: 'Project report deadline and supplier quotes.' });
  const version = memory.version(); assert.equal(memory.search('report')[0].id, 'memory');
  const features = registry.capture({ 'task.requires_review': false }, { now: context.database.now(), contextVersion: version });
  new ActivationPolicies(context.database).save({ instruction: 'Require review.', predicate: { op: 'always' }, effect: { type: 'require_review' } });
  assert.throws(() => memory.search('report', { expectedContextVersion: version }), /stale/);
  assert.equal(registry.evaluate({ op: 'not', arg: { op: 'eq', feature: 'task.requires_review', value: true } }, features, { now: context.database.now(), contextVersion: memory.version() }).matched, false);
  context.advance(31 * 60000);
  assert.equal(registry.evaluate({ op: 'eq', feature: 'task.requires_review', value: false }, features, { now: context.database.now() }).matched, false);
});

test('unknown restrictive policy conditions stay unmatched and cannot silently relax existing write authorization', t => {
  const context = setup(t), policies = new ActivationPolicies(context.database);
  const policy = policies.save({ instruction: 'Review actions while I am away.', predicate: { op: 'eq', feature: 'user.present', value: false }, effect: { type: 'require_review' } });
  const decision = policies.evaluate({});
  assert.deepEqual(decision.policyIds, []); assert.deepEqual(decision.unresolvedPolicyIds, [policy.id]);
  assert.equal(decision.requiresReview, true); assert.equal(decision.activate, true, 'unknown restrictions can permit preparation, never unattended writes');
});
