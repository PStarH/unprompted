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

test('high priority skips the spacing between interruptions but not the hourly ceiling', t => {
  const context = setup(t), attention = new AttentionBudget(context.database, { minIntervalMs: 60000, maxInteractivePerHour: 2, digestWindowMs: 0 });
  assert.equal(attention.offer({ id: 'first', dedupeKey: 'first' }).state, 'delivered');
  assert.equal(attention.offer({ id: 'normal', dedupeKey: 'normal' }).state, 'pending', 'normal still waits for the interval');
  assert.equal(attention.offer({ id: 'high', dedupeKey: 'high', priority: 'high' }).state, 'delivered', 'high may interrupt inside the interval');
  assert.equal(attention.offer({ id: 'high-2', dedupeKey: 'high-2', priority: 'high' }).state, 'pending', 'high cannot exceed the hourly budget');
});

test('high priority still yields to an unresolved critical notification', t => {
  const context = setup(t), attention = new AttentionBudget(context.database, { minIntervalMs: 0, digestWindowMs: 0 });
  assert.equal(attention.offer({ id: 'critical', dedupeKey: 'critical' }, { class: 'critical', criticalConfigured: true }).state, 'delivered');
  assert.equal(attention.offer({ id: 'high', dedupeKey: 'high', priority: 'high' }).state, 'pending');
});

test('released notifications prefer high priority without starving low priority', t => {
  const context = setup(t), attention = new AttentionBudget(context.database, { minIntervalMs: 60000, maxInteractivePerHour: 1, digestWindowMs: 0 });
  assert.equal(attention.offer({ id: 'slot', dedupeKey: 'slot' }).state, 'delivered');
  assert.equal(attention.offer({ id: 'low', dedupeKey: 'low', priority: 'low' }).state, 'pending');
  assert.equal(attention.offer({ id: 'high', dedupeKey: 'high', priority: 'high' }).state, 'pending');
  context.advance(3700000);
  assert.deepEqual(attention.releaseDue().map(row => row.dedupe_key), ['high'], 'the freed slot goes to the higher priority');
  context.advance(3700001);
  assert.deepEqual(attention.releaseDue().map(row => row.dedupe_key), ['low'], 'low priority still gets a later slot');
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

test('a zero-length quiet window is rejected on write and read as no window', t => {
  const rejected = setup(t), strict = new AttentionBudget(rejected.database);
  assert.throws(() => strict.configure({ quietHours: { startHour: 9, endHour: 9 } }), error => error.code === 'INVALID_ATTENTION_POLICY');

  const context = setup(t);
  context.database.set('attention_policy', JSON.stringify({ quietHours: { startHour: 9, endHour: 9, timeZone: 'UTC' } }));
  const attention = new AttentionBudget(context.database);
  assert.equal(attention.quiet(context.database.now()), false, 'a stored start === end must not silence every hour');
  attention.configure({ maxInteractivePerHour: 7 });
  assert.equal(attention.quiet(context.database.now()), false);
  assert.equal(attention.describe().policy.maxInteractivePerHour, 7, 'an unrelated setting must still be editable');
});

test('a zero interactive budget sends notifications to the digest instead of waiting forever', t => {
  const context = setup(t), attention = new AttentionBudget(context.database, { maxInteractivePerHour: 0 });
  const offered = attention.offer({ id: 'quiet-1', dedupeKey: 'quiet-1', headline: 'Approval required', taskId: 'quiet-1' });
  assert.equal(offered.state, 'digest');
  assert.equal(offered.not_before, null);
  assert.equal(attention.offer({ id: 'downgraded', dedupeKey: 'downgraded' }, { class: 'critical' }).state, 'digest', 'an unconfigured critical is downgraded before the budget applies');
  assert.equal(attention.offer({ id: 'urgent', dedupeKey: 'urgent' }, { class: 'critical', criticalConfigured: true }).state, 'delivered');
  context.advance(60 * 60_000);
  assert.deepEqual(attention.releaseDue(), []);
  assert.equal(context.database.db.prepare("SELECT state FROM notification_deliveries WHERE dedupe_key='quiet-1'").get().state, 'digest');
  assert.ok(attention.digest().flatMap(group => group.ids).includes(context.database.db.prepare("SELECT id FROM notification_deliveries WHERE dedupe_key='quiet-1'").get().id), 'the undeliverable decision must still be listed in the digest');
});

test('a legacy zero-length quiet window stays resaveable so the settings form is not locked out', t => {
  const context = setup(t);
  context.database.set('attention_policy', JSON.stringify({ quietHours: { startHour: 9, endHour: 9, timeZone: 'UTC' } }));
  const attention = new AttentionBudget(context.database);
  // The settings form always resends the stored quietHours; resaving the value
  // that is already inert must succeed or the user can never change a limit.
  const saved = attention.configure({ maxInteractivePerHour: 5, minIntervalMs: 60000, quietHours: { startHour: 9, endHour: 9, timeZone: 'UTC' } });
  assert.equal(saved.policy.maxInteractivePerHour, 5);
  assert.equal(saved.policy.minIntervalMs, 60000);
  assert.equal(attention.quiet(context.database.now()), false);
  // Introducing a different zero-length window is still refused.
  assert.throws(() => attention.configure({ quietHours: { startHour: 10, endHour: 10 } }), error => error.code === 'INVALID_ATTENTION_POLICY');
  // Moving the same zero-length window to another time zone is a new window, not a resave.
  assert.throws(() => attention.configure({ quietHours: { startHour: 9, endHour: 9, timeZone: 'Asia/Tokyo' } }), error => error.code === 'INVALID_ATTENTION_POLICY');
});

test('a prepared draft waiting for approval is eventually raised instead of waiting forever', async t => {
  const { WorkEngine } = await import('../src/engine.js');
  const { JsonStore } = await import('../src/store.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-approval-reminder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, { stallAfterMs: 3 * 86400000 });
  store.mutate(state => {
    state.tasks['request:awaiting'] = {
      id: 'request:awaiting', status: 'ready_for_approval', createdAt: '2026-01-01T00:00:00.000Z',
      request: { subjectEntity: 'Vega', deliverable: 'status report' },
      assessment: { complete: true, missing: [] },
      progress: { at: '2026-01-01T00:00:00.000Z' }
    };
  });
  // Not yet stale: six hours of waiting is well inside the approval window.
  engine.sweepAttention(new Date('2026-01-01T06:00:00.000Z'));
  assert.equal(store.state.notifications.filter(item => item.dedupeKey === 'stalled:request:awaiting').length, 0);
  // Past the window: the approval becomes a real decision.
  engine.sweepAttention(new Date('2026-01-06T00:00:00.000Z'));
  const raised = store.state.notifications.find(item => item.dedupeKey === 'stalled:request:awaiting');
  assert.ok(raised, 'a stale pending approval must be raised');
  assert.match(raised.headline, /ready for your approval/i);
  assert.match(raised.decision, /Approve/i);
  assert.deepEqual(raised.options.map(option => option.value), ['approve', 'close']);
});
