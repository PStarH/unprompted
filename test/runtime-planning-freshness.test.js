import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { NullReasoner, OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { authorizeForTests } from '../src/authority-credential.js';

function fixture(t, reasoner = new NullReasoner('fixture')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-freshness-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  let clock = Date.now(); store.database.now = () => clock;
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime, now: () => clock, advance: ms => { clock += ms; } };
}
function sourceExperience(f) {
  const memory = f.runtime.memory.put({ content: 'Cedar proposal requires careful review.', scopeType: 'project',
    scopeKey: JSON.stringify(['cedar', 'proposal']), validUntil: new Date(f.now() + 1000).toISOString() });
  const experience = f.runtime.experiences.create({ kind: 'planning_hint', scopeType: 'project', scopeKey: 'Cedar',
    directiveKey: 'review.required', effect: { type: 'review_requirements', required: true }, instruction: 'Require review.', freshnessClass: 'stable' },
  { sources: [{ kind: 'memory', id: memory.id }] });
  f.runtime.trials.saveCases(experience.id, { expectedRevision: 1, expectedCaseSetVersion: 0, userRequested: true,
    cases: [{ id: 'independent', scope: [{ type: 'project', key: 'Cedar' }], features: {},
      expected: { applies: true, winner: 'candidate', effect: { type: 'review_requirements', required: true } } }] });
  assert.equal(f.runtime.trials.evaluate(experience.id, { expectedRevision: 1 }).state, 'passed');
  return { memory, experience: f.runtime.experiences.adopt(experience.id, { expectedRevision: 1, userRequested: true }) };
}
function taskWithManifest(f, refs, project = 'Cedar') {
  const created = f.store.tasks.createOrLoad({ candidateKey: `task-${project}`, data: { subject: `${project} proposal`,
    request: { text: `Update the ${project} proposal.`, subjectEntity: project, deliverable: 'proposal' } } });
  f.store.refresh();
  f.store.mutate(state => { state.tasks[created.taskId].contextManifest = { selected: refs, deferred: [], overridden: [] }; });
  return created.taskId;
}
for (const kind of ['memory', 'experience']) test(`held ${kind} context expires by database clock without a version event; unrelated task remains current`, t => {
  const f = fixture(t), { memory, experience } = sourceExperience(f);
  const id = kind === 'memory' ? memory.id : experience.id;
  const a = taskWithManifest(f, [{ id, kind, ...(kind === 'memory' ? { version: memory.version } : {}) }]);
  const b = taskWithManifest(f, [], 'Birch');
  const aFence = f.runtime.capture(a), bFence = f.runtime.capture(b);
  assert.equal(f.runtime.isCurrent(a, aFence), true); assert.equal(f.runtime.contextReady(a), true);
  const version = f.store.database.get('context_version'); f.advance(1500);
  assert.equal(f.store.database.get('context_version'), version, 'clock expiry does not require a settings write');
  assert.equal(f.runtime.isCurrent(a, aFence), false);
  assert.equal(f.runtime.contextReady(a), false);
  assert.equal(f.runtime.isCurrent(b, bFence), true); assert.equal(f.runtime.contextReady(b), true);
});

test('an overridden experience was not used and its expiry does not invalidate the task', t => {
  const f = fixture(t), { experience } = sourceExperience(f), taskId = taskWithManifest(f, []);
  f.store.mutate(state => { state.tasks[taskId].contextManifest.overridden = [{ kind: 'experience', id: experience.id }]; });
  const fence = f.runtime.capture(taskId); f.advance(1500);
  assert.equal(f.runtime.isCurrent(taskId, fence), true);
});

test('native model answer crossing source TTL is discarded; the same job rebuilds context before accepting a new answer', async t => {
  let f, release, announce;
  const firstStarted = new Promise(resolve => { announce = resolve; });
  const firstReply = new Promise(resolve => { release = resolve; });
  const observations = [];
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 },
    fetchImpl: async (_url, init) => {
      const interpreting = JSON.parse(init.body).messages[0].content.startsWith('You extract structured facts');
      const task = f.store.state.tasks['request:clock-message'];
      observations.push({ jobId: f.runtime.current()?.job.id, review: task.modelReview?.status,
        selected: (task.contextManifest?.selected || []).map(item => item.id), key: task.reasoningWork?.key });
      if (observations.length === 1) { announce(); await firstReply; }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(interpreting ? {
        deliverable: 'proposal', subjectEntity: 'Cedar', intent: 'update', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results', sourceField: 'body' }]
      } : { probes: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    } });
  reasoner.preferModelInterpretation = true; f = fixture(t, reasoner);
  t.after(() => release()); const { experience } = sourceExperience(f);
  f.engine.ingest({ id: 'clock-event', type: 'email.received', payload: { id: 'clock-message', threadId: 'clock-thread', from: 'person@example.test',
    subject: 'Cedar proposal', body: 'Please update the Cedar proposal with experiment results.' } });
  await firstStarted; f.advance(1500); release();
  await f.engine.whenSettled(); await f.runtime.whenIdle(); await f.engine.whenSettled();
  assert.ok(observations[0].selected.includes(experience.id));
  assert.ok(observations.length >= 2);
  assert.equal(observations[1].jobId, observations[0].jobId);
  assert.notEqual(observations[1].review, 'verified', 'the expired first answer must not verify the request');
  assert.ok(!observations[1].selected.includes(experience.id));
  assert.notEqual(observations[1].key, observations[0].key);
  assert.equal(f.store.jobs.get(observations[0].jobId).state, 'completed');
  assert.equal(f.store.state.tasks['request:clock-message'].modelReview.status, 'verified');
  assert.equal(f.store.state.outbox.length, 0);
});

test('a stale manifest blocks a new external intent with confirmed no effect', async t => {
  const f = fixture(t), { experience } = sourceExperience(f), taskId = taskWithManifest(f, [{ kind: 'experience', id: experience.id }]);
  f.advance(1500); let sends = 0;
  await assert.rejects(() => f.runtime.external(f.store.tasks.get(taskId), { provider: { kind: 'fixture', live: false }, tool: 'patch',
    actionFamily: 'document.patch', resourceId: 'doc', key: 'expired-new-action', effect: { type: 'document_patch' }, payload: {}, send: async () => { sends++; return {}; } }),
  error => error.code === 'CONTEXT_CHANGED' && error.definitiveNoEffect === true);
  assert.equal(sends, 0); assert.equal(f.runtime.ledger.byKey('expired-new-action'), undefined);
});

test('expiry during authorization is rechecked at the real dispatch boundary and cancels the undispatched intent', async t => {
  const f = fixture(t), { experience } = sourceExperience(f), taskId = taskWithManifest(f, [{ kind: 'experience', id: experience.id }]);
  let sends = 0, authorizations = 0;
  f.engine.toolGateway.decide = () => { if (++authorizations === 1) f.advance(1500); return authorizeForTests(); };
  await assert.rejects(() => f.runtime.external(f.store.tasks.get(taskId), { provider: { kind: 'fixture', live: false }, tool: 'patch',
    actionFamily: 'document.patch', resourceId: 'doc', key: 'expired-at-dispatch', effect: { type: 'document_patch' }, payload: {}, send: async () => { sends++; return {}; } }),
  error => error.code === 'CONTEXT_CHANGED' && error.definitiveNoEffect === true && !error.ambiguous);
  assert.equal(sends, 0); assert.equal(authorizations, 1);
  assert.equal(f.runtime.ledger.byKey('expired-at-dispatch').status, 'cancelled');
});


test('an old captured fence cannot become current again after a local planning rebuild', t => {
  const f = fixture(t), { experience } = sourceExperience(f), taskId = taskWithManifest(f, [{ kind: 'experience', id: experience.id }]);
  const fence = f.runtime.capture(taskId); f.advance(1500);
  assert.equal(f.runtime.isCurrent(taskId, fence), false);
  f.store.mutate(state => { state.tasks[taskId].contextManifest.selected = []; state.tasks[taskId].planningContextRevision = 1; });
  assert.equal(f.runtime.isCurrent(taskId, fence), false);
  assert.equal(f.runtime.isCurrent(taskId, f.runtime.capture(taskId)), true);
});

test('a queued context refresh preserves user-edited draft text and marks it stale', async t => {
  const f = fixture(t); sourceExperience(f);
  f.engine.ingest({ id: 'user-clock-event', type: 'email.received', payload: { id: 'user-clock-message', threadId: 'user-clock-thread', from: 'person@example.test',
    subject: 'Cedar proposal', body: 'Please update the Cedar proposal with experiment results.' } });
  await f.engine.whenSettled(); await f.runtime.whenIdle();
  const taskId = 'request:user-clock-message';
  f.store.mutate(state => { state.tasks[taskId].draft = { body: 'USER-AUTHORED-TEXT', userEdited: true }; });
  f.advance(1500); f.runtime.scheduleTask(taskId, 'user_resume:context-refresh');
  await f.runtime.whenIdle(); await f.engine.whenSettled();
  const task = f.store.tasks.get(taskId);
  assert.equal(task.draft.body, 'USER-AUTHORED-TEXT'); assert.equal(task.draft.userEdited, true);
  assert.equal(task.userDraftStale, true); assert.equal(task.planningContextRevision, 1);
});

test('expiry after dispatch preserves the real verified receipt and idempotent replay never sends twice', async t => {
  const f = fixture(t), { experience } = sourceExperience(f), taskId = taskWithManifest(f, [{ kind: 'experience', id: experience.id }]);
  f.engine.toolGateway.decide = () => authorizeForTests(); let sends = 0;
  const receipt = { id: 'actual-fixture-receipt', idempotencyKey: 'verified-before-expiry' };
  const options = { provider: { kind: 'fixture', live: false }, tool: 'patch', actionFamily: 'document.patch', resourceId: 'doc',
    key: 'verified-before-expiry', effect: { type: 'document_patch' }, payload: {},
    send: async () => { sends++; f.advance(1500); return receipt; }, verify: async result => ({ status: 'found', receipt: result }) };
  const task = f.store.tasks.get(taskId);
  assert.deepEqual(await f.runtime.external(task, options), receipt);
  assert.equal(f.runtime.ledger.byKey(options.key).status, 'verified');
  assert.deepEqual(await f.runtime.external(f.store.tasks.get(taskId), options), receipt);
  assert.equal(sends, 1);
});


test('legacy memory planning checks its timestamp token and projection version independently', t => {
  const f = fixture(t), taskId = taskWithManifest(f, []), id = 'legacy-planning-version';
  f.store.mutate(state => {
    state.taskMemories ||= {};
    state.taskMemories[id] = { id, taskId, text: 'Cedar proposal uses approved amounts.', scope: { entity: 'Cedar', deliverable: 'proposal' },
      memoryKind: 'fact', lifecycleState: 'active', createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', versions: [] };
  });
  const setRef = memory => f.store.mutate(state => { state.tasks[taskId].contextManifest.selected = [{ id, kind: 'memory', version: memory.version, expectedVersion: memory.expectedVersion }]; });
  const original = f.runtime.memorySpace.get(id).memory; setRef(original);
  assert.equal(typeof original.version, 'number'); assert.equal(typeof original.expectedVersion, 'string');
  assert.equal(f.runtime.planningContextCurrent(taskId), true);
  f.store.mutate(state => { state.taskMemories[id].text = 'Cedar proposal uses corrected amounts.'; state.taskMemories[id].updatedAt = '2026-10-02T09:00:00.000Z'; });
  assert.equal(f.runtime.planningContextCurrent(taskId), false);
  const changed = f.runtime.memorySpace.get(id).memory; setRef(changed);
  assert.equal(f.runtime.planningContextCurrent(taskId), true);
  setRef({ ...changed, expectedVersion: changed.version });
  assert.equal(f.runtime.planningContextCurrent(taskId), false, 'numeric projection cannot stand in for the legacy token');
  setRef({ ...changed, version: original.version });
  assert.equal(f.runtime.planningContextCurrent(taskId), false, 'legacy token cannot conceal a stale projection');
});
