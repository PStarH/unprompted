import test from 'node:test';
import assert from 'node:assert/strict';
import { openActivationReplay } from '../src/durable/activation-replay.js';
import { preparedWorkReviewToken } from '../src/draft-review.js';

const mail = (env, id = 'source', body = 'The lobby was noisy.', extra = {}) => ({ id: `event:${id}`, type: 'email.received', at: env.at(), source: 'simulated', connectorId: 'simulated', payload: { id, threadId: 'shared-thread', from: 'alex@example.test', to: 'reader@example.test', subject: 'Lobby', body, receivedAt: env.at(), ...extra } });
const intent = env => env.runtime.intents.create({ description: 'Watch the lobby', desiredOutcome: 'Prepare a note about lobby noise', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN'], tokens: ['lobby'] }, autonomy: { maxAutonomy: 'prepare' }, prohibited: ['external_write'] }, { confirmed: true });
function open(t, scripts) { const env = openActivationReplay({ scripts }); t.after(() => env.close()); return env; }

async function readInRun(env, data, eventId, action) {
  env.runtime.suspended = true;
  const created = env.runtime.tasks.createOrLoad({ candidateKey: 'reader', eventId, data });
  const queued = env.runtime.jobs.enqueue({ queue: 'test', type: 'source_read', key: 'reader', taskId: created.taskId });
  const job = env.runtime.jobs.claim('source-reader', { queue: 'test', id: queued.id });
  const run = env.runtime.tasks.beginRun(job), task = env.runtime.tasks.get(created.taskId), context = env.runtime.buildContext(task, run);
  env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: task.inputVersion, contextVersion: context.version, sources: context.sources, plan: {} });
  env.runtime.suspended = false;
  await env.runtime.scope.run({ taskId: task.id, job, run, context }, async () => {
    const tools = env.runtime.tools({ taskId: task.id, isCurrent: () => true });
    await action(tools.find(tool => tool.name === 'read_task_source'), task);
    env.runtime.tasks.finish(run, job); env.runtime.jobs.complete(job);
  });
}

test('standing goals obey current explicit suppression before activation', async t => {
  const env = open(t); intent(env);
  env.runtime.policies.save({ instruction: 'Do not activate this source', predicate: { op: 'always' }, effect: { type: 'suppress' } });
  env.engine.ingest(mail(env)); await env.settle();
  assert.equal(env.runtime.tasks.situations.listActive().filter(item => item.kind === 'standing_intent').length, 0);
  assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE job_type='standing_intent_match'").get().n, 0);
});

test('an update of an existing situation still reaches independently configured standing goals', async t => {
  const env = open(t, { delta: () => ({ associated: true, polarity: 'NEUTRAL', confidence: 0.95, evidenceRefs: [{ field: 'body', quote: 'lobby' }], stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [] } }) });
  env.engine.ingest(mail(env, 'first')); await env.settle();
  env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Lobby', sourceEventIds: ['event:first'] });
  intent(env);
  env.engine.ingest(mail(env, 'second')); await env.settle();
  assert.ok(env.store.db.prepare("SELECT 1 FROM activation_decisions WHERE stage='standing_intent' AND event_a='event:second' AND outcome='MATCHED'").get());
});

test('an existing preparation visibly holds under suppression and resumes after the rule is disabled', async t => {
  const env = open(t); intent(env);
  env.engine.ingest(mail(env)); await env.settle();
  const task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent'), token = preparedWorkReviewToken(task);
  const policy = env.runtime.policies.save({ instruction: 'Stop preparing for now', predicate: { op: 'always' }, effect: { type: 'suppress' } });
  env.runtime.contextChanged(); await env.settle();
  const held = env.runtime.tasks.get(task.id);
  assert.ok(held.activationHold); assert.equal(held.reasoning.status, 'held');
  assert.throws(() => env.runtime.acceptPreparedWork(task.id, { reviewToken: token }), { code: 'REVIEW_CHANGED' });
  env.runtime.policies.disable(policy.id, policy.version); env.runtime.contextChanged(); await env.settle();
  const resumed = env.runtime.tasks.get(task.id);
  assert.equal(resumed.activationHold, undefined);
  assert.equal(resumed.reasoning.status, 'ok');
  env.runtime.acceptPreparedWork(task.id, { reviewToken: preparedWorkReviewToken(resumed) });
  assert.equal(env.runtime.tasks.get(task.id).status, 'completed');
});

test('durable engines supply shared workspace tools without bespoke server wiring', t => {
  const env = open(t);
  const names = env.engine.externalTools?.({ isCurrent: () => false }).map(tool => tool.name) || [];
  assert.ok(names.includes('read_task_source'));
  assert.ok(names.includes('read_context_item'));
  assert.equal(names.length, new Set(names).size);
});

test('source tools read an explicitly linked message rather than relabeling the task goal as source', async t => {
  const env = open(t); env.runtime.suspended = true;
  env.engine.ingest(mail(env, 'source', 'The lobby was noisy. Keep both emergency exits clear.'));
  await readInRun(env, { status: 'waiting_for_information', subject: 'Prepare a note', sourceConnectorId: 'simulated', request: { text: 'Summarize the incident', source: { id: 'source', eventId: 'event:source', connectorId: 'simulated' } } }, 'event:source', async tool => {
    const read = JSON.parse((await tool.execute('read', {})).content[0].text);
    assert.match(read.content, /Keep both emergency exits clear/);
    assert.equal(read.sourceId, 'source');
    assert.equal(read.eventId, 'event:source');
  });
});

test('document-backed standing goals expose the actual linked document text', async t => {
  const env = open(t); env.runtime.suspended = true;
  env.engine.ingest({ id: 'event:doc', type: 'document.modified', source: 'simulated', connectorId: 'simulated', at: env.at(), payload: { id: 'doc', title: 'Lobby procedure', content: 'Keep both emergency exits clear.', version: 1 } });
  await readInRun(env, { status: 'waiting_for_information', subject: 'Review procedure', sourceConnectorId: 'simulated', request: { text: 'Summarize risks', source: { id: 'doc', eventId: 'event:doc', connectorId: 'simulated' } } }, 'event:doc', async tool => {
    const read = JSON.parse((await tool.execute('read', {})).content[0].text);
    assert.match(read.content, /Keep both emergency exits clear/);
    assert.equal(read.documentId, 'doc');
    env.store.mutate(state => { state.documents.doc.available = false; });
    await assert.rejects(tool.execute('unavailable', {}));
  });
});

test('an observed source with an empty body stays empty rather than becoming the user goal', async t => {
  const env = open(t); env.runtime.suspended = true;
  env.engine.ingest({ id: 'event:empty', type: 'document.modified', source: 'simulated', connectorId: 'simulated', at: env.at(), payload: { id: 'empty', title: 'Lobby', content: '', version: 1 } });
  await readInRun(env, { status: 'waiting_for_information', subject: 'Inspect source', sourceConnectorId: 'simulated', request: { text: 'Invented goal is not source content', source: { id: 'empty', eventId: 'event:empty', connectorId: 'simulated' } } }, 'event:empty', async tool => {
    const read = JSON.parse((await tool.execute('empty-read', {})).content[0].text);
    assert.equal(read.content, '');
    assert.equal(read.title, 'Lobby');
  });
});

test('provider reconciliation remains serviceable while a model job is blocked', async t => {
  const env = open(t);
  let release, entered, serviced;
  const started = new Promise(resolve => { entered = resolve; });
  const received = new Promise(resolve => { serviced = resolve; });
  env.runtime.worker.handlers.audit_slow = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  env.runtime.effectsWorker.handlers.audit_receipt = async () => { serviced(); };
  env.runtime.jobs.enqueue({ type: 'audit_slow', key: 'slow' }); env.runtime.kick(); await started;
  let timer;
  try {
    env.runtime.jobs.enqueue({ queue: 'effects', type: 'audit_receipt', key: 'receipt' }); env.runtime.kick();
    const timely = await Promise.race([received.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 200); })]);
    assert.equal(timely, true);
  } finally { clearTimeout(timer); release(); await env.settle(); }
});

test('local preparation acceptance pins the reviewed version and records one explicit outcome', async t => {
  const env = open(t); intent(env);
  env.engine.ingest(mail(env)); await env.settle();
  let task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  const oldToken = preparedWorkReviewToken(task);
  env.engine.directTask(task.id, { text: 'Preserve unresolved safety risks', scope: 'task' }); await env.settle();
  assert.throws(() => env.runtime.acceptPreparedWork(task.id, { reviewToken: oldToken }), { code: 'REVIEW_CHANGED' });
  task = env.runtime.tasks.get(task.id);
  const token = preparedWorkReviewToken(task);
  env.runtime.acceptPreparedWork(task.id, { reviewToken: token });
  env.runtime.acceptPreparedWork(task.id, { reviewToken: token });
  assert.equal(env.runtime.tasks.get(task.id).completion.external, false);
  assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM feedback_events WHERE task_id=? AND kind='explicit_acceptance'").get(task.id).n, 1);
  assert.equal(env.store.state.outbox.length, 0);
});

test('pausing during model preparation discards its late draft', async t => {
  const env = open(t); intent(env);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  env.engine.reasoner.prepareTask = async () => { entered(); return new Promise(resolve => { release = () => resolve({ title: 'Lobby note', body: 'The lobby was noisy.', evidenceRefs: [{ eventId: 'event:source', quote: 'The lobby was noisy.' }] }); }); };
  env.engine.ingest(mail(env)); await started;
  const task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  try { env.engine.setTaskPaused(task.id, true); }
  finally { release(); await env.settle(); }
  assert.equal(env.runtime.tasks.get(task.id).preparedWork, undefined);
  assert.equal(env.runtime.tasks.get(task.id).control.paused, true);
});

test('local review refuses a preparation after its model or planning context changes', async t => {
  for (const version of ['model_version', 'context_version']) {
    const env = open(t); intent(env);
    env.engine.ingest(mail(env)); await env.settle();
    const task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
    const token = preparedWorkReviewToken(task);
    env.store.database.bump(version);
    assert.throws(() => env.runtime.acceptPreparedWork(task.id, { reviewToken: token }), { code: 'REVIEW_CHANGED' });
    assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM feedback_events WHERE task_id=? AND kind='explicit_acceptance'").get(task.id).n, 0);
  }
});

test('a model draft with invented source quotations never reaches user review', async t => {
  const env = open(t); intent(env);
  env.engine.reasoner.prepareTask = async () => ({ title: 'Unsupported note', body: 'The risk has been resolved.', evidenceRefs: [{ eventId: 'event:source', quote: 'The risk has been resolved.' }] });
  env.engine.ingest(mail(env)); await env.settle();
  const task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  assert.equal(task.preparedWork, undefined);
  assert.equal(task.reasoning.status, 'failed');
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 0);
});

test('switching models during preparation discards the old model result and runs the new model', async t => {
  const env = open(t); intent(env);
  let release, entered, newCalls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const draft = title => ({ title, body: title, evidenceRefs: [{ eventId: 'event:source', quote: 'The lobby was noisy.' }] });
  env.engine.reasoner.prepareTask = async () => { entered(); await new Promise(resolve => { release = resolve; }); return draft('Old model draft'); };
  env.engine.ingest(mail(env)); await started;
  try { env.engine.replaceReasoner({ available: () => true, prepareTask: async () => { newCalls++; return draft('Current model draft'); } }); }
  finally { release(); await env.settle(); }
  const task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  assert.equal(task.preparedWork.body, 'Current model draft');
  assert.equal(task.preparedWork.modelVersion, env.store.database.get('model_version', '0'));
  assert.equal(newCalls, 1);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE task_id=?').get(task.id).n, 1);
});

test('disabling standing activation during preparation leaves no late draft or permanently running state', async t => {
  const env = open(t); intent(env);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  env.engine.reasoner.prepareTask = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { title: 'Late draft', body: 'Late draft', evidenceRefs: [{ eventId: 'event:source', quote: 'The lobby was noisy.' }] }; };
  env.engine.ingest(mail(env)); await started;
  try { env.runtime.setFlags({ standingIntents: false }); }
  finally { release(); await env.settle(); }
  const task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  assert.equal(task.preparedWork, undefined);
  assert.equal(task.reasoning.status, 'failed');
  assert.throws(() => env.runtime.retryPreparedWork(task.id, { inputVersion: task.inputVersion }), { code: 'PREPARATION_CHANGED' });
});

test('a failed preparation can be retried with a fresh model request without changing its source', async t => {
  const env = open(t); intent(env);
  const requests = [];
  env.engine.reasoner.prepareTask = async (_input, requestId) => {
    requests.push(requestId);
    return { title: 'Lobby note', body: 'Keep the lobby safe.', evidenceRefs: [{ eventId: 'event:source', quote: requests.length === 1 ? 'Invented source.' : 'The lobby was noisy.' }] };
  };
  env.engine.ingest(mail(env)); await env.settle();
  const failed = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  assert.equal(failed.reasoning.status, 'failed');
  assert.throws(() => env.runtime.retryPreparedWork(failed.id, { inputVersion: failed.inputVersion - 1 }), { code: 'PREPARATION_CHANGED' });
  env.runtime.retryPreparedWork(failed.id, { inputVersion: failed.inputVersion }); await env.settle();
  const prepared = env.runtime.tasks.get(failed.id);
  assert.equal(prepared.inputVersion, failed.inputVersion);
  assert.equal(prepared.preparedWork.kind, 'draft');
  assert.equal(prepared.reasoning.status, 'ok');
  assert.equal(requests.length, 2); assert.notEqual(requests[0], requests[1]);
  env.runtime.acceptPreparedWork(prepared.id, { reviewToken: preparedWorkReviewToken(prepared) });
  assert.equal(env.runtime.tasks.get(prepared.id).completion.external, false);
});

test('document revisions replace the prepared draft in the same task and invalidate its old review', async t => {
  const env = open(t);
  env.runtime.intents.create({ description: 'Watch lobby procedures', desiredOutcome: 'Prepare a safety note', prefilter: { connectorIds: ['simulated'], eventTypes: ['document.modified'], roles: ['UNKNOWN'], tokens: ['lobby'] }, autonomy: { maxAutonomy: 'prepare' }, prohibited: ['external_write'] }, { confirmed: true });
  for (const revision of [1, 2]) {
    env.engine.ingest({ id: `document-event:${revision}`, type: 'document.modified', source: 'simulated', connectorId: 'simulated', at: env.at(), payload: { id: 'procedure', title: 'Lobby procedure', content: `Keep ${revision} emergency exits clear.`, version: revision } });
    await env.settle();
    const tasks = Object.values(env.store.state.tasks).filter(task => task.kind === 'standing_intent');
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.match(task.preparedWork.body, new RegExp(`Keep ${revision} emergency exits clear`));
    if (revision === 1) { env.oldTaskId = task.id; env.oldReview = preparedWorkReviewToken(task); }
    else {
      assert.equal(task.id, env.oldTaskId);
      assert.doesNotMatch(task.preparedWork.body, /Keep 1 emergency exits clear/);
      assert.throws(() => env.runtime.acceptPreparedWork(task.id, { reviewToken: env.oldReview }), { code: 'REVIEW_CHANGED' });
      await readInRun(env, task, 'document-event:2', async tool => {
        const read = JSON.parse((await tool.execute('latest-document', {})).content[0].text);
        assert.equal(read.eventId, 'document-event:2');
        assert.equal(read.content, 'Keep 2 emergency exits clear.');
      });
    }
  }
});

test('a document draft citing only a superseded revision cannot reach review', async t => {
  const env = open(t);
  env.runtime.intents.create({ description: 'Watch lobby procedures', desiredOutcome: 'Prepare a safety note', prefilter: { connectorIds: ['simulated'], eventTypes: ['document.modified'], roles: ['UNKNOWN'], tokens: ['lobby'] }, autonomy: { maxAutonomy: 'prepare' }, prohibited: ['external_write'] }, { confirmed: true });
  env.engine.reasoner.prepareTask = async () => ({ title: 'Old procedure', body: 'Keep 1 emergency exit clear.', evidenceRefs: [{ eventId: 'document-event:1', quote: 'Keep 1 emergency exit clear.' }] });
  for (const revision of [1, 2]) {
    env.engine.ingest({ id: `document-event:${revision}`, type: 'document.modified', source: 'simulated', connectorId: 'simulated', at: env.at(), payload: { id: 'procedure', title: 'Lobby procedure', content: `Keep ${revision} emergency exit clear.`, version: revision } });
    await env.settle();
  }
  const task = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  assert.equal(task.preparedWork, undefined);
  assert.equal(task.reasoning.status, 'failed');
});

test('JSON-heavy source chunks preserve valid envelopes and exact pagination', async t => {
  const env = open(t); env.runtime.suspended = true;
  const body = `The lobby was noisy. ${'"\\\n'.repeat(2000)}`;
  env.engine.ingest(mail(env, 'source', body));
  await readInRun(env, { status: 'waiting_for_information', subject: 'Inspect source', sourceConnectorId: 'simulated', request: { text: 'Review safely', source: { id: 'source', eventId: 'event:source', connectorId: 'simulated' } } }, 'event:source', async tool => {
    let offset = 0, received = '';
    do {
      const result = await tool.execute(`chunk:${offset}`, { offset });
      assert.ok(result.content[0].text.length <= 5800);
      const chunk = JSON.parse(result.content[0].text);
      received += chunk.content; offset = chunk.nextOffset;
    } while (offset !== null);
    assert.equal(received, body);
  });
});

test('repeated updates of a standing goal reuse one responsibility and refresh its source identity', async t => {
  const env = open(t); intent(env);
  env.engine.ingest(mail(env, 'first')); await env.settle();
  const original = Object.values(env.store.state.tasks).find(task => task.kind === 'standing_intent');
  env.engine.ingest(mail(env, 'second', 'The lobby now has an unresolved safety risk.')); await env.settle();
  const tasks = Object.values(env.store.state.tasks).filter(task => task.kind === 'standing_intent');
  assert.equal(tasks.length, 1); assert.equal(tasks[0].id, original.id);
  assert.equal(tasks[0].request.source.eventId, 'event:second');
  assert.match(tasks[0].preparedWork.body, /unresolved safety risk/);
  const fields = env.runtime.taskFeatures(tasks[0]);
  assert.equal(fields['sender.identity'].value, 'alex@example.test');
});
