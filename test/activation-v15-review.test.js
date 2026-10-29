import test from 'node:test';
import assert from 'node:assert/strict';
import { openActivationReplay, storeActivationReport } from '../src/durable/activation-replay.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { iso } from '../src/durable/database.js';

const secret = 'SECRET-PURGE-TOKEN-8841';
function open(t, scripts = {}) {
  const env = openActivationReplay({ scripts });
  t.after(() => env.close());
  return env;
}
const mail = (id, body, extra = {}) => ({
  id: `event:${id}`, type: 'email.received', at: '2026-10-28T12:00:00.000Z', source: extra.source || 'simulated', connectorId: extra.connectorId || 'simulated',
  payload: { id, threadId: extra.threadId || 'thread', from: 'alex@example.test', to: 'reader@example.test', subject: extra.subject || 'Update', body, projectId: extra.projectId, responsibility: extra.responsibility, receivedAt: '2026-10-28T12:00:00.000Z' }
});

test('purging a revoked connector removes source text and blocks the in-flight intent', async t => {
  let release;
  const entered = new Promise(resolve => { t.releaseStarted = resolve; });
  const env = open(t, { intent: () => new Promise(resolve => { release = () => resolve({ matched: true, quote: 'lobby was noisy', confidence: 0.9 }); entered.then?.(); t.releaseStarted(); }) });
  env.engine.ingest(mail('secret', `Please keep ${secret} private.`, { source: 'google', connectorId: 'google', threadId: 'secret-thread' }));
  await env.settle();
  const intent = env.runtime.intents.create({ description: 'Watch the lobby', desiredOutcome: 'Note lobby noise', predicate: 'The message is about lobby noise.', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN', 'DIRECT_ACTOR'], tokens: ['lobby'] }, prohibited: ['external_write'], budget: { maxMatches: 5, windowMs: 86400000 } }, { actor: 'user', confirmed: true });
  assert.ok(intent.id);
  const epoch = Number(env.runtime.database.get('privacy_epoch'));
  env.engine.ingest(mail('lobby', 'The lobby was noisy yesterday.', { threadId: 'lobby', subject: 'Lobby' }));
  await entered;
  await env.runtime.privacy.revokePermission({ connectorId: 'google', purgeLocal: true });
  await env.runtime.privacy.revokePermission({ connectorId: 'simulated', purgeLocal: false });
  release();
  await env.settle();
  const stored = env.runtime.db.prepare("SELECT event_json FROM durable_inbox WHERE provider='google'").all().map(row => row.event_json).join('\n');
  const snapshot = env.runtime.db.prepare('SELECT state_json FROM workspace_state WHERE id=1').get().state_json;
  assert.equal(stored.includes(secret), false);
  assert.equal(snapshot.includes(secret), false);
  assert.equal(env.runtime.tasks.situations.listActive().filter(item => item.kind === 'standing_intent').length, 0);
  assert.ok(Number(env.runtime.database.get('privacy_epoch')) > epoch);
  assert.equal((await env.runtime.backfill('calendar')).historyDiscovery, 'unavailable');
  assert.equal((await env.runtime.backfill('calendar')).networkCalls, 0);
  assert.equal((await env.runtime.backfill('google')).blocked, true);
});

test('a yielded pending notice is not released and an unsynthesized Situation is not ready', async t => {
  const env = open(t);
  env.engine.ingest(mail('seed', 'The quotation includes a price.'));
  await env.settle();
  const situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Quotation', lifecycleState: 'OBSERVING', sourceEventIds: ['event:seed'], closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: [] } });
  assert.equal(env.runtime.notifyReady(situation.id).reason, 'not_synthesized');
  const task = env.runtime.tasks.createOrLoad({ candidateKey: 'notice', data: { status: 'ready_for_approval', subject: 'Review', yieldState: 'YIELDED_TO_USER' } });
  const at = iso(env.runtime.database.now() - 1000);
  env.runtime.database.atomic(() => env.runtime.db.prepare('INSERT INTO notification_deliveries VALUES(?,?,?,?,?,?,?,?,?,?)').run('notice-1', 'notice-1', 'notice-1', null, 'interactive', 'pending', JSON.stringify({ id: 'notice-1', dedupeKey: 'notice-1', taskId: task.taskId, what: 'Review' }), at, null, at));
  assert.equal(env.runtime.store.attention.releaseDue().length, 0);
  assert.equal(env.runtime.db.prepare("SELECT state FROM notification_deliveries WHERE id='notice-1'").get().state, 'pending');
});

test('prepare autonomy admits a task without an external write, and a shared entity reaches the existing Situation', async t => {
  let calls = 0;
  const env = open(t, {
    intent: () => ({ matched: true, quote: 'lobby was noisy', confidence: 0.9 }),
    delta: () => ({ associated: true, polarity: 'NEUTRAL', confidence: 0.95, evidenceRefs: [{ field: 'body', quote: 'shared project' }], stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [] } })
  });
  env.runtime.intents.create({ description: 'Prepare the lobby note', desiredOutcome: 'Draft a note', predicate: 'The message is about lobby noise.', autonomy: { maxAutonomy: 'prepare' }, prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN', 'DIRECT_ACTOR'], tokens: ['lobby'] }, prohibited: ['external_write'], budget: { maxMatches: 2, windowMs: 86400000 } }, { actor: 'user', confirmed: true });
  env.engine.ingest(mail('lobby', 'The lobby was noisy yesterday.', { threadId: 'lobby', subject: 'Lobby' }));
  await env.settle();
  assert.equal(env.runtime.tasks.situations.listActive().some(item => item.kind === 'standing_intent'), true);
  assert.equal(Object.keys(env.store.state.tasks).length > 0 || env.runtime.db.prepare('SELECT COUNT(*) n FROM tasks').get().n > 0, true);
  assert.equal(env.store.state.outbox.length, 0);
  env.engine.ingest(mail('origin', 'The shared project is waiting.', { threadId: 'origin', projectId: 'cedar-plant', subject: 'Origin' }));
  await env.settle();
  const situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Cedar plant', lifecycleState: 'OPEN', scope: { responsibility: 'shipping' }, sourceEventIds: ['event:origin'], closureCondition: { kind: 'UNSPECIFIED' } });
  env.engine.ingest(mail('other-thread', 'The shared project moved ahead.', { threadId: 'other', projectId: 'cedar-plant', responsibility: 'shipping', subject: 'Other' }));
  await env.settle();
  assert.equal(env.runtime.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(situation.id).n, 2);
  env.runtime.intents.create({ description: 'Budget', desiredOutcome: 'Count calls', predicate: 'Anything.', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN', 'DIRECT_ACTOR'], tokens: ['budgettoken'] }, prohibited: ['external_write'], budget: { maxMatches: 1, windowMs: 86400000 } }, { actor: 'user', confirmed: true });
  env.runtime.engine = env.engine;
  const reasoner = env.engine.reasoner;
  const original = reasoner.assessStandingIntent;
  reasoner.assessStandingIntent = async () => { calls += 1; return { matched: false, quote: null, confidence: 0.1 }; };
  env.engine.ingest(mail('budget-one', 'The budgettoken appeared once.', { threadId: 'b1', subject: 'Budget' }));
  await env.settle();
  env.engine.ingest(mail('budget-two', 'The budgettoken appeared twice.', { threadId: 'b2', subject: 'Budget two' }));
  await env.settle();
  assert.equal(calls, 1);
  assert.equal(original === reasoner.assessStandingIntent || calls === 1, true);
  assert.equal(typeof OpenAiCompatibleReasoner.prototype.assessStandingIntent, 'function');
});

test('RSI rejects a fractional value and a missing replay before approval', t => {
  const env = open(t);
  assert.throws(() => env.runtime.rsi.propose({ parameter: 'maxPairCandidates', value: 4.5, evidence: { useful: 1 }, replayId: 'missing-replay' }), { code: 'RSI_INVALID' });
  assert.equal(env.runtime.db.prepare("SELECT COUNT(*) n FROM rsi_proposals WHERE status='approved'").get().n, 0);
  assert.equal(env.runtime.maxPairCandidates, 3);
});

test('a distinctive lexical update reaches an existing Situation, and a ready notice needs synthesis', async t => {
  const env = open(t, { delta: () => ({ associated: true, polarity: 'NEUTRAL', confidence: 0.95, evidenceRefs: [{ field: 'body', quote: 'cedarplanttoken' }], stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [] } }) });
  env.engine.ingest(mail('origin', 'The cedarplanttoken is waiting.'));
  await env.settle();
  const situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Plant', lifecycleState: 'OPEN', sourceEventIds: ['event:origin'], closureCondition: { kind: 'UNSPECIFIED' } });
  env.engine.ingest(mail('later', 'The cedarplanttoken moved ahead.', { threadId: 'other-thread' }));
  await env.settle();
  assert.equal(env.runtime.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(situation.id).n, 2);
  const task = env.runtime.tasks.createOrLoad({ candidateKey: 'bare', situationId: situation.id, dedupTaskKey: 'bare', data: { status: 'ready_for_approval', subject: 'Bare' } });
  env.store.mutate(state => { state.notifications = [...(state.notifications || []), { id: 'bare-notice', dedupeKey: 'bare-notice', taskId: task.taskId, what: 'Review' }]; });
  const notice = env.store.state.notifications.find(item => item.id === 'bare-notice');
  assert.equal(notice.deliveryBlocked, 'not_synthesized');
});

test('history discovery, budget retry, rollback and observed report counts stay consistent', async t => {
  const env = open(t, { intent: () => ({ matched: false, quote: null, confidence: 0.2 }) });
  env.connector.listHistoricalEvents = async () => ({ events: [mail('historic', 'Older mail arrives from the connector.', { threadId: 'old' })], networkCalls: 1, unavailable: false });
  const discovered = await env.runtime.backfill('google');
  assert.equal(discovered.historyDiscovery, 'available');
  assert.equal(discovered.networkCalls, 1);
  assert.equal(env.runtime.db.prepare("SELECT COUNT(*) n FROM durable_inbox WHERE id='event:historic'").get().n, 1);
  const intent = env.runtime.intents.create({ description: 'Budget', desiredOutcome: 'Count', predicate: 'Anything.', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN', 'DIRECT_ACTOR'], tokens: ['budgettoken'] }, prohibited: ['external_write'], budget: { maxMatches: 1, windowMs: 60000 } }, { actor: 'user', confirmed: true });
  assert.ok(intent.id);
  env.engine.ingest(mail('budget-one', 'The budgettoken appeared once.', { threadId: 'b1' }));
  await env.settle();
  env.engine.ingest(mail('budget-two', 'The budgettoken appeared twice.', { threadId: 'b2' }));
  await env.settle();
  assert.equal(env.runtime.db.prepare("SELECT COUNT(*) n FROM jobs WHERE idempotency_key LIKE 'intent-budget:%:a%'").get().n > 0, true);
  env.runtime.database.atomic(() => env.runtime.db.prepare('INSERT INTO rsi_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('bad-rollback', 'approved', 'maxPairCandidates', '4.5', '4', '{}', '{}', 'replay:missing', null, 1, env.at(), env.at()));
  assert.throws(() => env.runtime.rollbackRsi('bad-rollback', 1), { code: 'RSI_INVALID' });
  assert.equal(env.runtime.rsi.get('bad-rollback').status, 'approved');
  env.runtime.noteObservation('network');
  assert.throws(() => storeActivationReport(env.runtime.database, { scenarios: [{ id: '1', passed: true, boundary: true }], networkCalls: 0 }), /match recorded observations/);
  const stored = storeActivationReport(env.runtime.database, { scenarios: [{ id: '1', passed: true, boundary: true }] });
  assert.equal(stored.metrics.networkCalls >= 1, true);
});

test('an external effect names a time slot before it can be sent', async t => {
  const env = open(t);
  env.engine.ingest(mail('seed', 'The quotation includes a price.'));
  await env.settle();
  const situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Slot', lifecycleState: 'OPEN', sourceEventIds: ['event:seed'], closureCondition: { kind: 'UNSPECIFIED' } });
  const other = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Other', lifecycleState: 'OPEN', sourceEventIds: ['event:seed'], closureCondition: { kind: 'UNSPECIFIED' } });
  env.runtime.coordination.claim({ kind: 'time', scopeKey: '2026-11-02T15:00Z/2026-11-02T16:00Z', situationId: other.id });
  const task = env.runtime.tasks.createOrLoad({ candidateKey: 'slot', situationId: situation.id, dedupTaskKey: 'slot', data: { status: 'ready_for_approval', subject: 'Slot', request: { deadline: { iso: '2026-11-02', ambiguous: false } } } });
  env.runtime.coordination.claim({ kind: 'time', scopeKey: 'deadline:2026-11-02:room', situationId: other.id });
  let sends = 0;
  await assert.rejects(env.runtime.external(env.runtime.tasks.get(task.taskId), {
    provider: { kind: 'calendar', id: 'calendar' }, tool: 'create', actionFamily: 'calendar.create', resourceId: 'room', key: 'time-write',
    effect: { type: 'event', startsAt: '2026-11-02T15:00Z', endsAt: '2026-11-02T16:00Z' }, payload: {}, send: async () => { sends += 1; return { id: 'sent' }; }
  }), { code: 'RESOURCE_CONTENTION' });
  await assert.rejects(env.runtime.external(env.runtime.tasks.get(task.taskId), {
    provider: { kind: 'calendar', id: 'calendar' }, tool: 'create', actionFamily: 'calendar.create', resourceId: 'room', key: 'deadline-write',
    effect: { type: 'event' }, payload: {}, send: async () => { sends += 1; return { id: 'sent' }; }
  }), { code: 'RESOURCE_CONTENTION' });
  assert.equal(sends, 0);
});

test('disconnect and clear removes the local copy and rejects a late checkpoint', async t => {
  const clearSecret = 'SECRET-CLEAR-COPY-2291';
  const env = open(t);
  env.engine.ingest(mail('clear-mail', `Body ${clearSecret}`, { source: 'google', connectorId: 'google', threadId: 'clear', subject: `Subject ${clearSecret}` }));
  env.engine.ingest({
    id: 'event:clear-doc', providerEventId: 'clear-doc', type: 'document.modified', at: '2026-10-28T12:00:00.000Z', source: 'google', connectorId: 'google',
    payload: { id: 'doc-clear', title: 'Notes', content: `Document ${clearSecret}`, modifiedAt: '2026-10-28T12:00:00.000Z' }
  });
  await env.settle();
  const storedEvent = env.runtime.db.prepare('SELECT id FROM durable_inbox WHERE provider=? AND event_json LIKE ?').get('google', `%${clearSecret}%`);
  assert.ok(storedEvent);
  const at = iso(env.runtime.database.now());
  const done = env.runtime.tasks.createOrLoad({ candidateKey: 'clear-done', data: { status: 'completed', subject: `Done ${clearSecret}`, sourceConnectorId: 'google', request: { text: clearSecret, source: { connectorId: 'google' } } } });
  const active = env.runtime.tasks.createOrLoad({ candidateKey: 'clear-active', data: { status: 'waiting_for_information', subject: 'Active', sourceConnectorId: 'google', request: { text: clearSecret } } });
  const enqueued = env.runtime.jobs.enqueue({ type: 'task_continue', key: `clear:${active.taskId}`, taskId: active.taskId, payload: { taskId: active.taskId, note: clearSecret } });
  const job = env.runtime.jobs.claim('clear-owner', { id: enqueued.id });
  assert.ok(job);
  const run = env.runtime.tasks.beginRun(job, { advanceGeneration: false });
  env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: run.input_version, plan: { note: clearSecret }, sources: [] });
  env.runtime.ledger.intent({ taskId: active.taskId, run, job, provider: 'gmail', tool: 'send', actionFamily: 'email.send', resourceId: 'thread', key: 'clear-write', effect: { type: 'email', body: clearSecret }, payload: { body: clearSecret }, authorize: () => ({ allowed: true }) });
  env.runtime.db.prepare('INSERT INTO user_memories(id,user_id,scope_type,scope_key,content,source_kind,source_id,version,privacy_epoch,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('mem-clear', 'local', 'global', 'clear', clearSecret, 'event', storedEvent.id, 1, 0, at, at);
  env.runtime.db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run('mem-clear', clearSecret);
  env.runtime.db.prepare('INSERT INTO notification_deliveries(id,dedupe_key,issue_key,candidate_id,class,state,notification_json,created_at,delivered_at,not_before) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('notice-clear', 'notice-clear', 'notice-clear', null, 'interactive', 'pending', JSON.stringify({ taskId: active.taskId, what: clearSecret }), at, null, null);
  assert.equal(env.runtime.db.prepare('SELECT checkpoint_json FROM task_runs WHERE id=?').get(run.id).checkpoint_json.includes(clearSecret), true);
  const epoch = Number(env.runtime.tasks.get(active.taskId).privacyEpoch);

  await env.runtime.privacy.revokePermission({ connectorId: 'google', purgeLocal: true });
  await env.settle();
  const text = [
    ...env.runtime.db.prepare('SELECT event_json AS value FROM durable_inbox').all(),
    ...env.runtime.db.prepare('SELECT data_json AS value FROM tasks').all(),
    ...env.runtime.db.prepare("SELECT COALESCE(checkpoint_json,'') AS value FROM task_runs").all(),
    ...env.runtime.db.prepare("SELECT COALESCE(payload_json,'') || COALESCE(result_json,'') || effect_signature_json AS value FROM tool_executions").all(),
    ...env.runtime.db.prepare("SELECT expected_effect_json || COALESCE(omission_reason,'') AS value FROM plan_steps").all(),
    ...env.runtime.db.prepare('SELECT content AS value FROM user_memories').all(),
    ...env.runtime.db.prepare('SELECT content AS value FROM memory_fts').all(),
    ...env.runtime.db.prepare('SELECT notification_json AS value FROM notification_deliveries').all(),
    ...env.runtime.db.prepare('SELECT summary || closure_evidence_json || scope_json AS value FROM situations').all(),
    ...env.runtime.db.prepare('SELECT projection_json AS value FROM hot_context_items').all(),
    ...env.runtime.db.prepare('SELECT state_json AS value FROM workspace_state').all()
  ].map(row => row.value).join('\n');
  if (text.includes(clearSecret)) {
    const index = text.indexOf(clearSecret);
    assert.fail(text.slice(Math.max(0, index - 160), index + clearSecret.length + 160));
  }
  assert.equal(env.runtime.db.prepare('SELECT status FROM tasks WHERE id=?').get(done.taskId).status, 'completed');
  assert.equal(env.runtime.tasks.get(active.taskId).privacyInvalidated, true);
  assert.ok(Number(env.runtime.tasks.get(active.taskId).privacyEpoch) > epoch);
  assert.throws(() => env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: run.input_version, plan: { note: clearSecret }, sources: [] }));
  await env.settle();
  assert.equal(env.runtime.db.prepare("SELECT COALESCE(checkpoint_json,'') AS value FROM task_runs").all().some(row => row.value.includes(clearSecret)), false);
  assert.equal(env.runtime.db.prepare('SELECT state_json AS value FROM workspace_state').get().value.includes(clearSecret), false);
});
