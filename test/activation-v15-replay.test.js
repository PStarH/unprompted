import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openActivationReplay, storeActivationReport, ACTIVATION_REPLAY_VERSION } from '../src/durable/activation-replay.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { DurableDatabase, iso } from '../src/durable/database.js';

const workerPath = fileURLToPath(new URL('./fixtures/durable-worker.mjs', import.meta.url));
const related = ({ events }) => ({ outcome: 'RELATED_WAIT', summary: 'Waiting for delivery terms.', missingEvidence: ['Delivery date'],
  reevaluationCondition: 'When delivery terms arrive.', confidence: 0.8, evidence: events.map(event => ({ eventId: event.id, field: 'body', quote: event.body })) });
const unrelated = () => ({ outcome: 'UNRELATED', summary: null, missingEvidence: [], reevaluationCondition: null, evidence: [], confidence: 0.9 });
const delta = (polarity, quote, patch = {}) => ({ associated: true, polarity, confidence: 0.95, evidenceRefs: [{ field: 'body', quote }],
  stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [], ...patch } });

function mail(id, body, extra = {}) {
  const payload = { id, threadId: extra.threadId || 'supplier-thread', from: extra.from || 'supplier@example.test', to: extra.to ?? 'reader@example.test', subject: extra.subject || 'Supplier quotation', body };
  for (const key of ['receivedAt', 'projectId', 'responsibility', 'accountId', 'accountEmail', 'cc', 'assignedAccount', 'mentionedAccounts', 'groupMemberIds', 'deadlineAt']) if (extra[key] != null) payload[key] = extra[key];
  return { id: `event:${id}`, type: 'email.received', ...(extra.at ? { at: extra.at } : {}), ...(extra.source ? { source: extra.source } : {}), ...(extra.connectorId ? { connectorId: extra.connectorId } : {}), ...(extra.meta ? { meta: extra.meta } : {}), payload };
}
function open(t, scripts = {}) {
  const env = openActivationReplay({ scripts });
  t.after(() => env.close());
  return env;
}
const request = (id, subject, body = 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.') => mail(id, body, {
  from: 'alex@example.test', subject, threadId: 'work-thread', meta: { principalRole: 'DIRECT_ACTOR', roleEvidence: { basis: 'sole_to_recipient' } }, at: '2026-10-28T12:00:00.000Z', receivedAt: '2026-10-28T12:00:00.000Z'
});

test('activation v1.5 replay matrix', async t => {
  const results = [];
  const pass = (id) => results.push({ id, passed: true, boundary: true });

  await t.test('two weak events crystallize without an action', async t => {
    const env = open(t, { pair: related });
    env.engine.ingest(mail('one', 'The quotation includes a price.'));
    env.engine.ingest(mail('two', 'Delivery terms remain open.'));
    await env.settle();
    const situation = env.runtime.tasks.situations.listActive()[0];
    assert.equal(situation.lifecycle_state, 'OBSERVING');
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    assert.equal(env.store.state.outbox.length, 0);
    assert.equal(env.calls.length, 0);
    pass('01-weak-events');
  });

  await t.test('a shared entity without a compatible responsibility does not merge', async t => {
    let calls = 0;
    const env = open(t, { pair: input => { calls += 1; return unrelated(input); } });
    const note = id => mail(id, 'The lobby was noisy yesterday.', { threadId: `thread-${id}`, projectId: 'cedarwood', subject: 'Cedarwood lobby note', responsibility: id === 'billing' ? 'billing' : 'legal', accountId: 'reader' });
    env.engine.ingest(note('billing')); env.engine.ingest(note('legal')); await env.settle();
    assert.equal(calls, 0);
    assert.equal(env.runtime.tasks.situations.listActive().length, 0);
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    const compatible = open(t, { pair: input => { calls += 1; return unrelated(input); } });
    const same = id => mail(id, 'The lobby was noisy yesterday.', { threadId: `same-${id}`, projectId: 'cedarwood', subject: 'Cedarwood lobby note', responsibility: 'billing', accountId: 'reader' });
    compatible.engine.ingest(same('left')); compatible.engine.ingest(same('right')); await compatible.settle();
    assert.equal(calls, 1);
    assert.equal(compatible.runtime.tasks.situations.listActive().length, 0);
    assert.equal(Object.keys(compatible.store.state.tasks).length, 0);
    pass('02-shared-entity');
  });

  await t.test('RELATED_WAIT keeps the link, the gap, and the reevaluation condition', async t => {
    const env = open(t, { pair: related });
    env.engine.ingest(mail('one', 'The quotation includes a price.'));
    env.engine.ingest(mail('two', 'Delivery terms remain open.'));
    await env.settle();
    const situation = env.runtime.tasks.situations.listActive()[0];
    assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(situation.id).n, 2);
    assert.deepEqual(situation.closureCondition.missingEvidence, ['Delivery date']);
    assert.equal(situation.closureCondition.reevaluationCondition, 'When delivery terms arrive.');
    assert.equal(env.store.state.outbox.length, 0);
    pass('03-related-wait');
  });

  await t.test('a negative pair is not reevaluated and a third event still pairs', async t => {
    const calls = [];
    const env = open(t, { pair: async ({ events }) => { calls.push(events.map(event => event.id).sort().join()); return unrelated(); } });
    env.engine.ingest(mail('one', 'The quotation includes a price.'));
    env.engine.ingest(mail('two', 'Delivery terms remain open.'));
    await env.settle();
    env.runtime.scheduleUnattachedPairs('event:two'); await env.settle();
    assert.equal(calls.length, 1);
    env.engine.ingest(mail('three', 'The quotation has an attachment.')); await env.settle();
    assert.ok(calls.length > 1);
    assert.equal(env.runtime.tasks.situations.listActive().length, 0);
    pass('04-negative-pair');
  });

  await t.test('a substantive reply updates the deadline only after grounded association', async t => {
    const env = open(t, { pair: related, delta: () => delta('ADVANCE', 'by 2026-11-18', { deadlineUpdates: [{ field: 'body', quote: 'by 2026-11-18' }] }) });
    env.engine.ingest(mail('one', 'The quotation includes a price.', { at: '2026-10-28T12:00:00.000Z', receivedAt: '2026-10-28T12:00:00.000Z' }));
    env.engine.ingest(mail('two', 'Delivery terms remain open.', { at: '2026-10-28T12:05:00.000Z', receivedAt: '2026-10-28T12:05:00.000Z' }));
    await env.settle();
    env.engine.ingest(mail('reply', 'The revised deadline is by 2026-11-18.', { at: '2026-10-28T15:00:00.000Z', receivedAt: '2026-10-28T15:00:00.000Z' }));
    await env.settle();
    const situation = env.runtime.tasks.situations.listActive()[0];
    assert.equal(situation.closureCondition.deadlineUpdates[0].iso, '2026-11-18');
    assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, 'ADVANCE');
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    assert.equal(env.store.state.outbox.length, 0);
    pass('05-grounded-delta');
  });

  await t.test('scoped cancellation and supersession leave the other task alone', async t => {
    const env = open(t, { delta: () => delta('CANCEL', 'Cedar proposal') });
    env.engine.ingest(request('cedar', 'Cedar proposal')); await env.settle();
    const original = env.store.tasks.get('request:cedar');
    const other = env.runtime.tasks.createOrLoad({ candidateKey: 'harbor', situationId: original.situationId, dedupTaskKey: 'harbor', data: { status: 'waiting_for_information', subject: 'Harbor budget', request: { text: 'Review the Harbor budget.', subjectEntity: 'Harbor' } } });
    env.engine.ingest(mail('cancel', 'Please cancel the Cedar proposal.', { from: 'alex@example.test', subject: 'Cedar proposal', threadId: 'work-thread', at: '2026-10-28T13:00:00.000Z', receivedAt: '2026-10-28T13:00:00.000Z' }));
    await env.settle();
    assert.equal(env.runtime.tasks.get(original.id).status, 'cancelled');
    assert.notEqual(env.runtime.tasks.get(other.taskId).status, 'cancelled');
    assert.equal(env.runtime.tasks.situations.get(original.situationId).lifecycle_state, 'OPEN');
    assert.equal(env.store.state.outbox.length, 0);
    const stale = open(t, { delta: () => delta('CANCEL', 'Cedar proposal') });
    stale.engine.ingest(request('cedar', 'Cedar proposal')); await stale.settle();
    const kept = stale.store.tasks.get('request:cedar');
    stale.runtime.tasks.createOrLoad({ candidateKey: 'harbor', situationId: kept.situationId, dedupTaskKey: 'harbor', data: { status: 'waiting_for_information', subject: 'Harbor budget', request: { text: 'Review the Harbor budget.', subjectEntity: 'Harbor' } } });
    stale.engine.ingest(mail('old', 'Please cancel the Cedar proposal.', { from: 'alex@example.test', subject: 'Cedar proposal', threadId: 'work-thread', at: '2020-01-01T00:00:00.000Z', receivedAt: '2020-01-01T00:00:00.000Z' }));
    await stale.settle();
    assert.notEqual(stale.runtime.tasks.get(kept.id).status, 'cancelled');
    assert.notEqual(stale.runtime.tasks.situations.get(kept.situationId).lifecycle_state, 'CANCELLED');
    const replaced = open(t, { delta: () => delta('SUPERSEDE', 'Cedar proposal') });
    replaced.engine.ingest(request('cedar', 'Cedar proposal')); await replaced.settle();
    const target = replaced.store.tasks.get('request:cedar');
    const survivor = replaced.runtime.tasks.createOrLoad({ candidateKey: 'harbor', situationId: target.situationId, dedupTaskKey: 'harbor', data: { status: 'waiting_for_information', subject: 'Harbor budget', request: { text: 'Review the Harbor budget.', subjectEntity: 'Harbor' } } });
    replaced.engine.ingest(mail('next', 'The Cedar proposal is replaced by the revised scope.', { from: 'alex@example.test', subject: 'Cedar proposal', threadId: 'work-thread', at: '2026-10-28T13:00:00.000Z', receivedAt: '2026-10-28T13:00:00.000Z' }));
    await replaced.settle();
    assert.equal(replaced.runtime.tasks.get(target.id).control.pauseReason, 'scoped_supersession');
    assert.equal(replaced.runtime.tasks.get(target.id).supersededByEventId, 'event:next');
    assert.notEqual(replaced.runtime.tasks.get(survivor.taskId).status, 'cancelled');
    assert.ok(replaced.store.db.prepare("SELECT 1 FROM lineage WHERE source_kind='event' AND source_id='event:next' AND derived_kind='task' AND derived_id=?").get(target.id));
    assert.equal(replaced.store.state.outbox.length, 0);
    pass('06-scoped-control');
  });

  await t.test('CC wording does not activate and a provider assignment still reaches policy', async t => {
    const env = open(t);
    env.engine.ingest(mail('cc', 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.', {
      subject: 'Cedar proposal', meta: { principalRole: 'PASSIVE_OBSERVER', roleEvidence: { basis: 'cc_recipient' } }
    }));
    await env.settle();
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    env.engine.ingest(mail('assigned', 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.', {
      subject: 'Assigned proposal', threadId: 'assigned-thread', from: 'alex@example.test', to: ['other@example.test'], cc: ['reader@example.test'], accountEmail: 'reader@example.test', assignedAccount: 'reader@example.test'
    }));
    await env.settle();
    assert.equal(Object.keys(env.store.state.tasks).length, 1);
    assert.equal(env.store.state.events.find(event => event.id === 'event:assigned').meta.principalRole, 'DIRECT_ACTOR');
    assert.equal(env.store.state.outbox.length, 0);
    pass('07-responsibility');
  });

  await t.test('a natural-language standing intent matches only inside its prefilter and budget', async t => {
    let semantic = 0;
    const env = open(t, { intent: () => { semantic += 1; return { matched: true, quote: 'lobby was noisy', confidence: 0.9 }; } });
    const spec = { description: 'Watch the lobby', desiredOutcome: 'Note lobby noise', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN'], tokens: ['lobby'] }, prohibited: ['external_write'], budget: { maxMatches: 1, windowMs: 86400000 } };
    assert.throws(() => env.runtime.intents.create(spec, { actor: 'external', confirmed: true }), { code: 'INTENT_CONFIRMATION_REQUIRED' });
    const proposed = env.runtime.intents.propose(spec);
    assert.equal(proposed.status, 'proposed');
    const intent = env.runtime.intents.create({ ...spec, predicate: 'The message is about lobby noise.' }, { actor: 'user', confirmed: true });
    env.engine.ingest(mail('other', 'The quotation includes a price.')); await env.settle();
    assert.equal(semantic, 0);
    env.engine.ingest(mail('lobby', 'The lobby was noisy yesterday.', { threadId: 'lobby-thread', subject: 'Lobby' })); await env.settle();
    assert.equal(semantic, 1);
    assert.equal(env.runtime.tasks.situations.listActive().filter(item => item.kind === 'standing_intent').length, 1);
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    env.engine.ingest(mail('again', 'The lobby was noisy yesterday.', { threadId: 'lobby-again', subject: 'Lobby again' })); await env.settle();
    assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='standing_intent' AND event_a='event:again'").get().outcome, 'DEFERRED');
    const paused = env.runtime.intents.transition(intent.id, intent.version, 'paused');
    assert.throws(() => env.runtime.intents.transition(intent.id, intent.version, 'disabled'), { code: 'INTENT_CHANGED' });
    const disabled = env.runtime.intents.transition(paused.id, paused.version, 'disabled');
    assert.throws(() => env.runtime.intents.transition(disabled.id, disabled.version, 'active'), { code: 'INTENT_DISABLED' });
    env.runtime.setFlags({ standingIntents: false });
    env.engine.ingest(mail('flagged', 'The lobby was noisy yesterday.', { threadId: 'flagged', subject: 'Flagged lobby' })); await env.settle();
    assert.equal(env.runtime.jobs.list().filter(job => job.job_type === 'standing_intent_match' && job.idempotency_key.includes('event:flagged')).length, 0);
    assert.equal(env.store.state.outbox.length, 0);
    pass('08-standing-intent');
  });

  await t.test('a timer reevaluates without a model call', async t => {
    let calls = 0;
    const env = open(t, { pair: () => { calls += 1; return null; }, delta: () => { calls += 1; return null; } });
    env.engine.ingest(mail('one', 'The quotation includes a price.')); await env.settle();
    const situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Supplier quotation', lifecycleState: 'OBSERVING', closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: ['Delivery date'] }, sourceEventIds: ['event:one'] });
    env.runtime.scheduleSituation(situation.id, new Date(Date.parse(env.at()) + 60000).toISOString());
    await env.settle();
    assert.equal(env.runtime.tasks.situations.get(situation.id).next_eval_at == null, false);
    env.advance(60000); env.runtime.kick(); await env.settle();
    assert.equal(calls, 0);
    assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='situation_timer'").get().outcome, 'WAIT');
    assert.equal(env.calls.length, 0);
    pass('09-timer');
  });

  await t.test('an incomplete or unknown probe does not prove absence', async t => {
    const env = open(t);
    const at = env.at();
    env.engine.ingest(mail('seed', 'The quotation is under discussion.', { source: 'google', connectorId: 'google', at, receivedAt: at, threadId: 'thread-1', subject: 'Quotation' }));
    await env.settle();
    const situation = env.runtime.tasks.situations.create({ kind: 'supplier', summary: 'Awaiting supplier reply', sourceEventIds: ['event:seed'], closureCondition: { kind: 'AWAIT_EVIDENCE' } });
    let job = env.runtime.configureSituationProbe(situation.id, { sourceEventId: 'event:seed', scheduledAt: new Date(Date.parse(at) - 1000).toISOString() });
    await env.settle();
    assert.equal(env.runtime.tasks.situations.get(situation.id).closureCondition.probeObservation.status, 'PROBE_INCOMPLETE');
    assert.equal(env.calls.length, 0);
    env.connector.live = true;
    delete env.connector.probeExpectedReply;
    env.store.mutate(state => { state.connectorStatus.google = { ok: true, lastSyncAt: at }; state.cursors.google = { gmail: { historyId: 'h1' } }; });
    job = env.runtime.configureSituationProbe(situation.id, { sourceEventId: 'event:seed', scheduledAt: new Date(Date.parse(at) - 1000).toISOString() });
    await env.settle();
    assert.equal(env.runtime.jobs.get(job.id).state, 'completed');
    assert.equal(env.runtime.tasks.situations.get(situation.id).closureCondition.probeObservation.status, 'UNKNOWN');
    env.connector.probeExpectedReply = async () => { throw new Error('socket'); };
    env.runtime.configureSituationProbe(situation.id, { sourceEventId: 'event:seed', scheduledAt: new Date(Date.parse(at) - 500).toISOString() });
    await env.settle();
    assert.equal(env.runtime.tasks.situations.get(situation.id).closureCondition.probeObservation.status, 'PROBE_INCOMPLETE');
    assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='active_probe' AND outcome='EXPECTED_EVENT_ABSENT'").get().n, 0);
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    pass('10-probe');
  });

  await t.test('one situation runs distinct tasks and dedupes identical active work', async t => {
    const env = open(t);
    env.engine.ingest(mail('one', 'The quotation includes a price.')); await env.settle();
    const situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Supplier quotation', lifecycleState: 'OPEN', sourceEventIds: ['event:one'], closureCondition: { kind: 'UNSPECIFIED' } });
    const first = env.runtime.tasks.createOrLoad({ candidateKey: 'analysis-1', situationId: situation.id, dedupTaskKey: 'analysis', data: { status: 'waiting_for_information', subject: 'Analysis' } });
    const duplicate = env.runtime.tasks.createOrLoad({ candidateKey: 'analysis-2', situationId: situation.id, dedupTaskKey: 'analysis', data: { status: 'waiting_for_information', subject: 'Analysis' } });
    const independent = env.runtime.tasks.createOrLoad({ candidateKey: 'legal', situationId: situation.id, dedupTaskKey: 'legal', data: { status: 'waiting_for_information', subject: 'Legal' } });
    assert.equal(first.taskId, duplicate.taskId);
    assert.notEqual(independent.taskId, first.taskId);
    env.runtime.tasks.update(first.taskId, env.runtime.tasks.get(first.taskId).stateVersion, data => { data.status = 'completed'; });
    assert.equal(env.runtime.tasks.situations.get(situation.id).lifecycle_state, 'OPEN');
    const children = [1, 2].map(() => fork(workerPath, ['dedup', env.runtime.database.filename, situation.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    t.after(() => children.forEach(child => { if (child.exitCode == null) child.kill('SIGKILL'); }));
    const raced = await Promise.all(children.map(child => once(child, 'message')));
    assert.equal(new Set(raced.map(([message]) => message.taskId)).size, 1);
    assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE situation_id=? AND dedup_task_key='same-work' AND status NOT IN ('completed','cancelled')").get(situation.id).n, 1);
    pass('11-multi-task');
  });

  await t.test('evidence arriving during a run is consumed at the checkpoint', async t => {
    const env = open(t);
    const created = env.runtime.tasks.createOrLoad({ candidateKey: 'evidence', data: { status: 'investigating', subject: 'Evidence' } });
    const job = env.runtime.jobs.claim('evidence-owner');
    const run = env.runtime.tasks.beginRun(job, { advanceGeneration: false });
    env.runtime.database.atomic(() => {
      env.runtime.db.prepare('INSERT INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)').run('event:extra', 'fixture', 'extra', '{}', 'extra', iso(env.runtime.database.now()));
      env.runtime.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('event',?,?)").run('event:extra', iso(env.runtime.database.now()));
    });
    env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: { note: 'before' }, sources: [] });
    const associated = env.runtime.tasks.associate(created.taskId, 'event:extra');
    assert.equal(associated.added, true);
    assert.equal(env.runtime.db.prepare("SELECT status FROM task_signals WHERE task_id=? AND signal_type='EVIDENCE_CHANGED'").get(created.taskId).status, 'PENDING');
    const current = env.runtime.tasks.get(created.taskId);
    env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: current.inputVersion, plan: { note: 'after' }, sources: [{ kind: 'event', id: 'event:extra' }] });
    assert.equal(env.runtime.tasks.acknowledgeEvidence(run, job), 1);
    assert.equal(env.runtime.db.prepare("SELECT status FROM task_signals WHERE task_id=? AND signal_type='EVIDENCE_CHANGED'").get(created.taskId).status, 'CONSUMED');
    assert.equal(env.runtime.tasks.associate(created.taskId, 'event:extra').added, false);
    assert.equal(env.runtime.db.prepare("SELECT COUNT(*) n FROM task_signals WHERE task_id=? AND signal_type='EVIDENCE_CHANGED'").get(created.taskId).n, 1);
    pass('12-evidence-signal');
  });

  await t.test('resource and time claims block only the contested scope', async t => {
    const env = open(t);
    env.engine.ingest(mail('one', 'The quotation includes a price.')); await env.settle();
    const source = 'event:one';
    const left = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Left', lifecycleState: 'OPEN', sourceEventIds: [source], closureCondition: { kind: 'UNSPECIFIED' } });
    const right = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Right', lifecycleState: 'OPEN', sourceEventIds: [source], closureCondition: { kind: 'UNSPECIFIED' } });
    env.runtime.coordination.claim({ kind: 'time', scopeKey: '2026-10-29T15:00Z', situationId: left.id });
    const blocked = env.runtime.coordination.claim({ kind: 'time', scopeKey: '2026-10-29T15:00Z', situationId: right.id });
    const otherSlot = env.runtime.coordination.claim({ kind: 'time', scopeKey: '2026-10-29T16:00Z', situationId: right.id });
    assert.equal(blocked.blocked, true);
    assert.equal(otherSlot.blocked, false);
    const holder = env.runtime.tasks.createOrLoad({ candidateKey: 'holder', situationId: left.id, dedupTaskKey: 'holder', data: { status: 'ready_for_approval', subject: 'Holder' } });
    const contender = env.runtime.tasks.createOrLoad({ candidateKey: 'contender', situationId: right.id, dedupTaskKey: 'contender', data: { status: 'ready_for_approval', subject: 'Contender' } });
    env.runtime.coordination.claim({ kind: 'resource', scopeKey: 'gmail:shared-doc', situationId: left.id, taskId: holder.taskId });
    let sends = 0;
    const write = taskId => env.runtime.external(env.runtime.tasks.get(taskId), { provider: { kind: 'gmail', id: 'gmail' }, tool: 'send', actionFamily: 'email.send', resourceId: 'shared-doc', key: `write:${taskId}`, effect: { type: 'note' }, payload: {}, send: async () => { sends += 1; return { id: 'sent' }; } });
    await assert.rejects(write(contender.taskId), { code: 'RESOURCE_CONTENTION' });
    assert.equal(sends, 0);
    let unrelated = null;
    try { await env.runtime.external(env.runtime.tasks.get(contender.taskId), { provider: { kind: 'gmail', id: 'gmail' }, tool: 'send', actionFamily: 'email.send', resourceId: 'other-doc', key: 'write:other', effect: { type: 'note' }, payload: {}, send: async () => { sends += 1; return { id: 'sent' }; } }); }
    catch (error) { unrelated = error.code; }
    assert.notEqual(unrelated, 'RESOURCE_CONTENTION');
    pass('13-coordination');
  });

  await t.test('an automated reply can join evidence without starting a write', async t => {
    const env = open(t);
    env.engine.ingest(mail('human', 'The quotation includes a price.')); await env.settle();
    const situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Supplier quotation', sourceEventIds: ['event:human'], closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: ['Delivery date'] } });
    env.engine.ingest(mail('auto', 'This is an automated acknowledgement.', { meta: { originClass: 'AUTOMATION', principalRole: 'UNKNOWN' } }));
    await env.settle();
    assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(situation.id).n, 2);
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    assert.equal(env.store.state.outbox.length, 0);
    assert.equal(env.store.state.events.find(event => event.id === 'event:auto').disposition, 'context_only');
    pass('14-automation');
  });

  await t.test('a user edit yields and a cooldown does not resume it', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-yield-'));
    const store = new SqliteStore(path.join(directory, 'state.json'));
    const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
    const runtime = new DurableRuntime(engine, { tickMs: 100000 });
    t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    engine.ingest({ id: 'email:m1', type: 'email.received', payload: { id: 'm1', threadId: 'thread:m1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
    engine.ingest({ id: 'doc:1', type: 'document.modified', payload: { id: 'cedar-proposal', kind: 'proposal', title: 'Cedar project proposal', content: '# Cedar project proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.\n' } });
    await engine.whenSettled();
    const ready = engine.publicState().tasks.find(task => task.id === 'request:m1');
    const body = 'I am handling this personally and will follow up after reviewing the evidence.';
    runtime.editDraft(ready.id, { body, reviewToken: ready.reviewToken });
    assert.equal(runtime.scheduleTask(ready.id, 'cooldown'), false);
    runtime.kick(); await runtime.whenIdle();
    assert.equal(store.tasks.get(ready.id).draft.body, body);
    assert.equal(store.tasks.get(ready.id).yieldState, 'YIELDED_TO_USER');
    const noted = runtime.noteUnobservedActivity(ready.id);
    assert.equal(noted.telemetry, 'unavailable');
    assert.equal(noted.draftPreserved, body);
    assert.equal(store.tasks.get(ready.id).draft.body, body);
    store.mutate(state => { state.notifications.push({ id: 'ready-notice', taskId: ready.id, dedupeKey: 'ready-notice', what: 'Ready to send' }); });
    assert.equal(store.state.notifications.find(notice => notice.id === 'ready-notice').deliveryBlocked, 'yielded_to_user');
    assert.equal(store.state.outbox.length, 0);
    pass('15-yield');
  });

  await t.test('stale or unfinished synthesis does not claim ready', async t => {
    const env = open(t);
    env.engine.ingest(mail('one', 'The quotation includes a price.')); await env.settle();
    const waiting = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Supplier quotation', sourceEventIds: ['event:one'], closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: ['Delivery date'] } });
    const before = env.store.state.notifications?.length || 0;
    const missing = env.runtime.notifyReady(waiting.id);
    assert.equal(missing.ready, false); assert.equal(missing.reason, 'missing_evidence');
    assert.equal(env.store.state.notifications?.length || 0, before);
    const at = iso(env.runtime.database.now());
    env.runtime.database.atomic(() => env.runtime.db.prepare('INSERT INTO artifacts(id,generated_version,visible_version,status,generated_digest,latest_digest,situation_id,situation_version,stale,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('artifact:stale', 1, 1, 'draft', 'digest', 'digest', waiting.id, 1, 1, at, at));
    env.runtime.tasks.situations.create({ id: 'unused', kind: 'related_observations', summary: 'Unused', sourceEventIds: ['event:one'], closureCondition: { kind: 'UNSPECIFIED', missingEvidence: [] } });
    const fresh = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Fresh synthesis', lifecycleState: 'OPEN', sourceEventIds: ['event:one'], closureCondition: { kind: 'UNSPECIFIED', missingEvidence: [] } });
    env.runtime.database.atomic(() => env.runtime.db.prepare('INSERT INTO artifacts(id,generated_version,visible_version,status,generated_digest,latest_digest,situation_id,situation_version,stale,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('artifact:fresh-stale', 1, 1, 'draft', 'digest', 'digest', fresh.id, fresh.version, 1, at, at));
    const blocked = env.runtime.notifyReady(fresh.id);
    assert.equal(blocked.ready, false); assert.equal(blocked.reason, 'artifact_stale');
    assert.equal(env.store.state.outbox.length, 0);
    pass('16-freshness');
  });

  await t.test('duplicate events and concurrent admission create one active task', async t => {
    const env = open(t);
    const message = request('once', 'Cedar proposal');
    env.engine.ingest(message); env.engine.ingest(message); await env.settle();
    assert.equal(Object.keys(env.store.state.tasks).length, 1);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM durable_inbox WHERE provider_event_id=?').get(message.providerEventId || message.id).n, 1);
    pass('17-duplicate-admission');
  });

  await t.test('forgetting a task source keeps a control signal and fences the execution', async t => {
    const env = open(t);
    env.engine.ingest(request('seed', 'Cedar proposal')); await env.settle();
    const task = env.store.tasks.get('request:seed');
    const enqueued = env.runtime.jobs.enqueue({ type: 'task_continue', key: `forget:${task.id}`, taskId: task.id, payload: { taskId: task.id } });
    const job = env.runtime.jobs.claim('forget-owner', { id: enqueued.id });
    const run = env.runtime.tasks.beginRun(job, { advanceGeneration: false });
    env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: run.input_version, plan: {}, sources: [{ kind: 'event', id: 'event:seed' }] });
    const intent = env.runtime.ledger.intent({ taskId: task.id, run, job, provider: 'gmail', tool: 'send', actionFamily: 'email.send', resourceId: 'thread', key: 'forget-write', effect: { type: 'email' }, payload: {}, authorize: () => ({ allowed: true }) });
    env.runtime.db.prepare("UPDATE tool_executions SET status='dispatched',dispatched_at=? WHERE id=?").run(iso(env.runtime.database.now()), intent.execution.id);
    const at = iso(env.runtime.database.now());
    env.runtime.database.atomic(() => {
      env.runtime.db.prepare('INSERT INTO artifacts(id,task_id,generated_version,visible_version,status,generated_digest,latest_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('artifact:derived', task.id, 1, 1, 'draft', 'digest', 'digest', at, at);
      env.runtime.database.lineage('task', task.id, 'artifact', 'artifact:derived');
    });
    env.runtime.tasks.applyControl(task.id, 'CANCELLATION', 'event:seed', data => { data.control = { ...(data.control || {}), pauseReason: 'scoped_cancellation' }; });
    await env.runtime.privacy.forget({ kind: 'event', id: 'event:seed' });
    assert.ok(env.runtime.db.prepare("SELECT 1 FROM task_signals WHERE task_id=? AND signal_type='SYSTEM_REVOKE_SIGNAL'").get(task.id));
    assert.equal(env.runtime.ledger.get(intent.execution.id).status, 'unknown');
    assert.equal(env.runtime.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get('artifact:derived'), undefined);
    assert.equal(env.store.state.outbox.length, 0);
    pass('18-forget');
  });

  await t.test('permission revocation stops dependent work and blocks reimport', async t => {
    const env = open(t);
    const message = mail('cached', 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.', {
      source: 'google', connectorId: 'google', subject: 'Cedar proposal', from: 'alex@example.test', meta: { principalRole: 'DIRECT_ACTOR', roleEvidence: { basis: 'sole_to_recipient' } }
    });
    env.engine.ingest(message); await env.settle();
    const task = env.store.tasks.get('request:cached');
    assert.equal(task.sourceConnectorId, 'google');
    const at = iso(env.runtime.database.now());
    env.runtime.db.prepare('INSERT INTO artifacts(id,task_id,generated_version,visible_version,status,generated_digest,latest_digest,stale,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('artifact:cached', task.id, 1, 1, 'draft', 'digest', 'digest', 0, at, at);
    await env.runtime.privacy.revokePermission({ connectorId: 'google', purgeLocal: false });
    assert.equal(env.runtime.tasks.get(task.id).status, 'waiting_for_information');
    assert.equal(env.runtime.tasks.get(task.id).control.pauseReason, 'permission_revoked');
    assert.equal(env.runtime.db.prepare('SELECT stale FROM artifacts WHERE id=?').get('artifact:cached').stale, 1);
    const blocked = env.engine.ingest(mail('later', 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.', { source: 'google', connectorId: 'google', subject: 'Later', threadId: 'later', from: 'alex@example.test' }));
    assert.equal(blocked.disposition, 'permission_revoked');
    assert.equal((await env.runtime.backfill('google')).blocked, true);
    env.runtime.privacy.restorePermission('google');
    await env.runtime.privacy.revokePermission({ connectorId: 'google', purgeLocal: true });
    env.runtime.privacy.restorePermission('google');
    const replayed = env.engine.ingest(message);
    assert.equal(replayed.disposition, 'forgotten');
    assert.equal((await env.runtime.backfill('google')).networkCalls, 0);
    assert.equal(env.store.state.outbox.length, 0);
    pass('19-revocation');
  });

  await t.test('an unknown external write is reconciled remotely before any retry', async t => {
    const env = openActivationReplay();
    let restarted = null;
    t.after(async () => {
      if (restarted) { await restarted.runtime.close(); await restarted.engine.whenSettled(); restarted.store.close(); }
      if (!env.store.closed) { await env.runtime.close(); env.store.close(); }
      fs.rmSync(env.directory, { recursive: true, force: true });
    });
    let sends = 0;
    const created = env.runtime.tasks.createOrLoad({ candidateKey: 'dispatch', data: { status: 'ready_for_approval', subject: 'Dispatch' } });
    const job = env.runtime.jobs.claim('dispatch-owner');
    const run = env.runtime.tasks.beginRun(job, { advanceGeneration: false });
    env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {}, sources: [] });
    const intent = env.runtime.ledger.intent({ taskId: created.taskId, run, job, provider: 'gmail', tool: 'send', actionFamily: 'email.send', resourceId: 'thread', key: 'unknown-write', effect: { type: 'email' }, payload: {}, authorize: () => ({ allowed: true }) });
    await assert.rejects(env.runtime.ledger.dispatch(intent, { run, job, send: async (_signal, beforeDispatch) => { beforeDispatch(); sends += 1; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } }), { code: 'ETIMEDOUT' });
    assert.equal(env.runtime.ledger.get(intent.execution.id).status, 'unknown');
    assert.equal(sends, 1);
    await env.runtime.close(); env.store.close();
    const database = new DurableDatabase(path.join(env.directory, 'workspace.sqlite'));
    const store = new SqliteStore(path.join(env.directory, 'state.json'), { database });
    const engine = new WorkEngine(store);
    const runtime = new DurableRuntime(engine, { tickMs: 100000 });
    restarted = { store, engine, runtime };
    assert.equal(runtime.ledger.byKey('unknown-write').status, 'unknown');
    const reconciled = await runtime.ledger.reconcile(runtime.ledger.byKey('unknown-write').id, { lookup: async () => ({ status: 'found', receipt: { id: 'remote-1' } }) });
    assert.equal(reconciled.status, 'found');
    assert.equal(runtime.ledger.byKey('unknown-write').status, 'verified');
    assert.equal(sends, 1);
    pass('20-unknown-write');
  });

  await t.test('invalid model output, quiet hours, and a revoked probe stay conservative', async t => {
    const env = open(t, { pair: () => ({ outcome: 'NOT_A_REAL_OUTCOME' }) });
    env.engine.ingest(mail('one', 'The quotation includes a price.'));
    env.engine.ingest(mail('two', 'Delivery terms remain open.'));
    await env.settle();
    assert.equal(env.runtime.tasks.situations.listActive().length, 0);
    assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='pair_association'").get().outcome, 'INVALID');
    env.store.attention.configure({ quietHours: { startHour: 7, endHour: 9, timeZone: 'America/New_York' } });
    const delivery = env.store.attention.offer({ id: 'quiet', dedupeKey: 'quiet', what: 'Review' }, { class: 'interactive' });
    assert.equal(delivery.state, 'pending');
    pass('extra-conservative');
  });

  assert.equal(results.length, 21);
  const reportEnv = open(t);
  reportEnv.engine.ingest(mail('cited', 'The quotation includes a price.'));
  await reportEnv.settle();
  const scenarios = results.filter(item => item.id !== 'extra-conservative');
  assert.equal(scenarios.length, 20);
  const stored = storeActivationReport(reportEnv.runtime.database, { scenarios, sourceEventIds: ['event:cited'] });
  assert.equal(stored.metrics.configurationVersion, ACTIVATION_REPLAY_VERSION);
  assert.equal(stored.metrics.externalActions, 0);
  assert.equal(stored.metrics.networkCalls, 0);
  assert.equal(JSON.stringify(stored.metrics).includes('quotation'), false);
  assert.equal(reportEnv.runtime.database.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(reportEnv.runtime.database.db.pragma('user_version', { simple: true }), 5);
  await reportEnv.runtime.privacy.forget({ kind: 'event', id: 'event:cited' });
  assert.equal(reportEnv.runtime.db.prepare('SELECT COUNT(*) n FROM replay_results').get().n, 0);
});

test('bounded RSI applies only allowlisted parameters and rolls them back', t => {
  const env = open(t);
  assert.throws(() => env.runtime.rsi.propose({ parameter: 'authorizeSend', value: 1, evidence: { useful: 1 }, replayId: 'replay' }), { code: 'RSI_FORBIDDEN' });
  env.runtime.database.atomic(() => env.runtime.db.prepare('INSERT INTO replay_results VALUES(?,?,?,?,?)').run('replay:1', 'activation_v15', 1, JSON.stringify({ scenarios: [{ id: '1', passed: true }], externalActions: 0, networkCalls: 0 }), env.at()));
  const proposal = env.runtime.rsi.propose({ parameter: 'maxPairCandidates', value: 4, evidence: { compared: 2 }, replayId: 'replay:1' });
  assert.equal(env.runtime.rsi.noteFeedback('silence').neutral, true);
  const approved = env.runtime.applyRsi(proposal.id, proposal.version);
  assert.equal(env.runtime.maxPairCandidates, 4);
  const rolled = env.runtime.rollbackRsi(approved.id, approved.version);
  assert.equal(rolled.status, 'rolled_back');
  assert.equal(env.runtime.maxPairCandidates, proposal.previous);
  const metrics = env.runtime.activationMetrics({ labeled: { useful: 1, activated: 2, truePositives: 1, labeledPositives: 3 }, costs: { total: 4, currency: 'USD' } });
  assert.equal(metrics.usefulTaskPrecision.value, 0.5);
  assert.equal(metrics.forgetScope.physicalErasure, 'not_claimed');
  assert.equal(env.runtime.activationMetrics().usefulTaskPrecision.reason, 'unlabeled');
});
