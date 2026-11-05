// Regression coverage for cross-layer contracts. Every case owns a temporary database; no external network calls.
import { openActivationReplay, storeActivationReport } from '../src/durable/activation-replay.js';
import { arbitrateExperiences } from '../src/durable/experience.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore } from '../src/connectors/connector.js';
import { effectiveTaskRequest } from '../src/task-guidance.js';

import test from 'node:test';
import assert from 'node:assert/strict';
function check(id, invariant, action) {
  test(`${id}: ${invariant}`, async () => {
    const env = openActivationReplay();
    try { const result = await action(env); assert.equal(result.invariantPassed, true, JSON.stringify(result.observed)); }
    finally { await env.close(); }
  });
}
const report = (env, value = 4, parameter = 'maxPairCandidates') => env.runtime.rsi.evaluate({ parameter, value, datasetVersion: 'audit-v1', cases: [{ rank: value, ageMs: 0, expected: true }] }).id;
const proposal = (env, value, options = {}) => env.runtime.rsi.propose({ parameter: 'maxPairCandidates', value, evidence: { compared: true }, replayId: report(env, value), ...options });
const spec = (options = {}) => ({ description: 'Watch lobby', desiredOutcome: 'Note lobby noise', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN'], tokens: ['lobby'] }, prohibited: ['external_write'], ...options });
const createIntent = (env, options) => env.runtime.intents.create(spec(options), { actor: 'user', confirmed: true });
const mail = (env, id = 'seed') => ({ id: `event:${id}`, type: 'email.received', at: env.at(), source: 'simulated', connectorId: 'simulated', payload: { id, threadId: id, from: 'alex@example.test', to: 'reader@example.test', subject: 'Lobby', body: 'The lobby was noisy.', receivedAt: env.at() } });

check('RSI-01', 'unrelated replay and empty evidence cannot qualify a parameter proposal', async env => {
  const replayId = storeActivationReport(env.store.database, { scenarios: [{ id: 'unrelated', passed: true }] }).id;
  assert.throws(() => env.runtime.rsi.propose({ parameter: 'maxPairCandidates', value: 4, evidence: {}, replayId }), { code: 'RSI_INVALID' });
  assert.throws(() => env.runtime.rsi.propose({ parameter: 'maxPairCandidates', value: 4, evidence: { compared: true }, replayId }), { code: 'RSI_INVALID' });
  const comparison = report(env);
  assert.throws(() => env.runtime.rsi.propose({ parameter: 'maxPairCandidates', value: 5, evidence: { compared: true }, replayId: comparison }), { code: 'RSI_INVALID' });
  return { invariantPassed: true };
});
check('RSI-02', 'old proposals and rollbacks cannot overwrite newer effective configurations', async env => {
  const a = proposal(env, 4), stale = proposal(env, 5);
  const applied = env.runtime.applyRsi(a.id, a.version);
  assert.throws(() => env.runtime.applyRsi(stale.id, stale.version), { code: 'RSI_CHANGED' });
  const b = proposal(env, 5); env.runtime.applyRsi(b.id, b.version);
  assert.throws(() => env.runtime.rollbackRsi(applied.id, applied.version), { code: 'RSI_CHANGED' });
  return { invariantPassed: env.runtime.maxPairCandidates === 5 };
});
check('RSI-03', 'unsupported project scope is rejected', async env => {
  assert.throws(() => proposal(env, 4, { scope: { type: 'project', key: 'A' } }), { code: 'RSI_SCOPE' });
  return { invariantPassed: env.runtime.maxPairCandidates === 3 };
});
check('RSI-04', 'rollback preserves effective user attention settings and rejects intervening edits', async env => {
  env.store.attention.configure({ maxInteractivePerHour: 7, minIntervalMs: 0 });
  const replay = env.runtime.rsi.evaluate({ parameter: 'maxInteractivePerHour', value: 4, datasetVersion: 'pacing-v1', cases: Array.from({ length: 7 }, (_, i) => ({ at: 10000000 + i * 1000, expected: i < 4 })) });
  const value = env.runtime.rsi.propose({ parameter: 'maxInteractivePerHour', value: 4, evidence: { compared: true }, replayId: replay.id });
  assert.equal(value.previous, 7);
  const applied = env.runtime.applyRsi(value.id, value.version);
  env.runtime.rollbackRsi(applied.id, applied.version);
  assert.equal(env.store.attention.options.maxInteractivePerHour, 7);
  const nextReport = env.runtime.rsi.evaluate({ parameter: 'maxInteractivePerHour', value: 4, datasetVersion: 'pacing-v1', cases: Array.from({ length: 7 }, (_, i) => ({ at: 10000000 + i * 1000, expected: i < 4 })) });
  const next = env.runtime.rsi.propose({ parameter: 'maxInteractivePerHour', value: 4, evidence: { compared: true }, replayId: nextReport.id });
  const approved = env.runtime.applyRsi(next.id, next.version);
  env.store.attention.configure({ maxInteractivePerHour: 8 });
  assert.throws(() => env.runtime.rollbackRsi(approved.id, approved.version), { code: 'RSI_CHANGED' });
  // Runtime configuration has a wider valid range than the optimization
  // surface. Rollback must still restore that exact pre-optimization value.
  env.runtime.unattachedWindowMs = env.runtime.rsi.defaults.pairWindowMs = 1800000;
  const windowReport = env.runtime.rsi.evaluate({ parameter: 'pairWindowMs', value: 3600000, datasetVersion: 'window-v1', cases: [{ ageMs: 2700000, rank: 1, expected: true }] });
  const windowProposal = env.runtime.rsi.propose({ parameter: 'pairWindowMs', value: 3600000, evidence: { compared: true }, replayId: windowReport.id });
  const appliedWindow = env.runtime.applyRsi(windowProposal.id, windowProposal.version);
  env.runtime.rollbackRsi(appliedWindow.id, appliedWindow.version);
  assert.equal(env.runtime.unattachedWindowMs, 1800000);
  return { invariantPassed: env.store.attention.options.maxInteractivePerHour === 8 };
});
check('MEM-01', 'Other projects cannot evict an exact scoped match before retrieval', async env => {
  const memory = env.runtime.memory;
  memory.maxVectors = 2;
  memory.put({ id: 'older', content: 'ProjectAlpha contractual deadline', scopeType: 'project', scopeKey: 'A' });
  for (let i = 0; i < 2; i++) { env.advance(1000); memory.put({ id: `new-${i}`, content: 'Other project', scopeType: 'project', scopeKey: 'B' }); }
  const hits = memory.search('ProjectAlpha contractual deadline', { scopes: [{ type: 'project', key: 'A' }] }).map(item => item.id);
  return { invariantPassed: hits.includes('older'), observed: { hits, maxVectors: memory.maxVectors } };
});
check('MEM-02', 'Planning preserves a memory exception rather than silently cutting it off', async env => {
  const content = `${'Prefer concise summaries. '.repeat(15)} EXCEPT: never omit unresolved risks.`;
  const context = { memories: [{ id: 'long', content }], experiences: [], events: [], arbitration: { conflicts: [] } };
  const packed = env.runtime.scope.run({ taskId: 'audit', context }, () => env.runtime.planningContext('audit'));
  return { invariantPassed: packed.memory[0].text.includes('EXCEPT'), observed: { storedLength: content.length, passedLength: packed.memory[0].text.length, exceptionIncluded: packed.memory[0].text.includes('EXCEPT') } };
});
check('CTX-01', 'The planner receives arbitration winners rather than competing overridden instructions', async env => {
  const experiences = [
    { id: 'loser', status: 'candidate', kind: 'execution_hint', directiveKey: 'draft.format', instruction_text: 'Use plain text', effect: { type: 'draft_format', format: 'plain' }, advisoryOnly: true },
    { id: 'winner', status: 'active', kind: 'execution_hint', directiveKey: 'draft.format', instruction_text: 'Use Markdown', effect: { type: 'draft_format', format: 'markdown' }, advisoryOnly: false }
  ];
  const arbitration = arbitrateExperiences({ experiences });
  const packed = env.runtime.scope.run({ taskId: 'audit', context: { memories: [], experiences, events: [], arbitration } }, () => env.runtime.planningContext('audit'));
  const ids = packed.experiences.map(item => item.id);
  return { invariantPassed: !ids.includes('loser'), observed: { winners: arbitration.decisions.map(item => item.record.id), forwarded: ids, conflicts: packed.conflicts } };
});
check('ACT-01', 'Document title/content participate in StandingIntent token matching', async env => {
  const intent = createIntent(env, { prefilter: { connectorIds: ['simulated'], eventTypes: ['document.modified'], roles: ['UNKNOWN'], tokens: ['lobby'] } });
  const matched = env.runtime.intents.matchesPrefilter(intent, { connectorId: 'simulated', type: 'document.modified', payload: { title: 'Lobby', content: 'The lobby was noisy.' } });
  return { invariantPassed: matched, observed: { matched, inputFields: ['title', 'content'] } };
});
check('ACT-02', 'Disabled intents cannot push an active matching intent out of consideration', async env => {
  const active = createIntent(env);
  for (let i = 0; i < 50; i++) { env.advance(1000); const other = createIntent(env); env.runtime.intents.transition(other.id, other.version, 'disabled'); }
  const hits = env.runtime.intents.prefilterHits(mail(env), { limit: 50 });
  return { invariantPassed: hits.some(item => item.id === active.id), observed: { activeMatchesPrefilter: env.runtime.intents.matchesPrefilter(active, mail(env)), hits: hits.length, disabled: 50 } };
});
check('ACT-03', 'Disabling StandingIntent activation stops already queued forward activation', async env => {
  env.runtime.suspended = true;
  createIntent(env);
  env.engine.ingest(mail(env));
  const queued = env.runtime.jobs.list().filter(job => job.job_type === 'standing_intent_match').length;
  env.runtime.setFlags({ standingIntents: false });
  env.runtime.suspended = false;
  env.runtime.kick();
  await env.settle();
  const count = env.store.db.prepare("SELECT COUNT(*) n FROM situations WHERE kind='standing_intent'").get().n;
  return { invariantPassed: count === 0, observed: { queued, enabled: env.runtime.flags().standingIntents, situationsCreated: count } };
});
check('MET-01', 'A task strictly inside the supplied time window is counted', async env => {
  env.runtime.tasks.createOrLoad({ candidateKey: 'metric', data: { status: 'waiting_for_information', subject: 'Window test' } });
  const since = '2026-10-28T11:00:00.000Z', until = '2026-10-28T13:00:00.000Z';
  const metrics = env.runtime.activationMetrics({ since, until });
  const actual = env.store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE created_at>=? AND created_at<=?').get(since, until).n;
  return { invariantPassed: metrics.duplicateTaskRate.denominator === actual, observed: { expectedCount: actual, reportedCount: metrics.duplicateTaskRate.denominator } };
});
check('ACT-04', 'Disabling coverage probes prevents a new provider probe', async env => {
  const connector = env.connector;
  connector.live = true;
  const event = mail(env);
  event.source = event.connectorId = 'google';
  env.engine.ingest(event);
  await env.settle();
  env.store.mutate(state => { state.connectorStatus.google = { ok: true, lastSyncAt: env.at() }; state.cursors.google = { gmail: { historyId: 'h1' } }; });
  const situation = env.runtime.tasks.situations.create({ kind: 'supplier', summary: 'Awaiting reply', sourceEventIds: [event.id], closureCondition: { kind: 'AWAIT_EVIDENCE' } });
  env.runtime.setFlags({ coverageProbes: false });
  assert.throws(() => env.runtime.configureSituationProbe(situation.id, { sourceEventId: event.id, scheduledAt: env.at() }), { code: 'PROBES_DISABLED' });
  await env.settle();
  return { invariantPassed: env.calls.length === 0, observed: { enabled: env.runtime.flags().coverageProbes, providerProbeCalls: env.calls.length } };
});
check('ACT-05', 'StandingIntent desired outcome survives projection into a prepared task', async env => {
  const desiredOutcome = 'Draft a note summarizing lobby noise';
  const intent = createIntent(env, { desiredOutcome, autonomy: { maxAutonomy: 'prepare' } });
  env.engine.ingest(mail(env));
  await env.settle();
  const tasks = env.store.db.prepare('SELECT data_json FROM tasks').all().map(row => JSON.parse(row.data_json));
  const task = tasks.find(item => item.subject === intent.description);
  const situation = env.runtime.tasks.situations.listActive().find(item => item.kind === 'standing_intent');
  assert.equal(task.status, 'ready_for_approval');
  assert.match(task.preparedWork.body, /The lobby was noisy/);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, 1);
  return { invariantPassed: task?.request?.text === desiredOutcome, observed: { taskOutcome: task?.request?.text } };
});
check('ACT-06', 'Budget-deferred StandingIntent work survives multiple deferrals and runs when budget reopens', async env => {
  createIntent(env, { budget: { maxMatches: 1, windowMs: 86400000 } });
  env.engine.ingest(mail(env, 'first')); await env.settle();
  env.engine.ingest(mail(env, 'second')); await env.settle();
  env.advance(3600000); env.runtime.kick(); await env.settle();
  const pendingAfterHour = env.runtime.jobs.list().filter(job => job.job_type === 'standing_intent_match' && ['queued', 'retry_wait'].includes(job.state)).length;
  env.advance(86400000); env.runtime.kick(); await env.settle();
  const decisions = env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='standing_intent' AND event_a='event:second'").all().map(row => row.outcome);
  return { invariantPassed: decisions.includes('MATCHED'), observed: { pendingAfterHour, secondEventDecisions: decisions, elapsedHours: 25 } };
});
check('OBS-01', 'A successful unchanged poll refreshes the health timestamp used by active probes', async env => {
  const connector = env.connector;
  connector.live = true;
  connector.pull = async () => ({ events: [], cursor: { gmail: { historyId: 'h1' } } });
  const event = mail(env);
  event.source = event.connectorId = 'google';
  env.engine.ingest(event);
  await env.settle();
  const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(env.store), engine: env.engine, now: env.at });
  await sync.run();
  const first = env.store.state.connectorStatus.google.lastSyncAt;
  env.advance(11 * 60000);
  const result = await sync.run();
  const health = env.store.state.connectorStatus.google;
  const situation = env.runtime.tasks.situations.create({ kind: 'supplier', summary: 'Awaiting reply', sourceEventIds: [event.id], closureCondition: { kind: 'AWAIT_EVIDENCE' } });
  env.runtime.configureSituationProbe(situation.id, { sourceEventId: event.id, scheduledAt: env.at() });
  await env.settle();
  const observation = env.runtime.tasks.situations.get(situation.id).closureCondition.probeObservation;
  return { invariantPassed: sync.cursors.observation('google').observedAt === env.at() && env.calls.length === 1, observed: { pollFailed: result.results[0].failed, first, current: health.lastSyncAt, now: env.at(), probeFreshnessLimitMs: 600000, probeStatus: observation?.status, connectorProbeCalls: env.calls.length } };
});
check('CON-01', 'A timed-out pull cannot overlap the next pull for the same connector', async env => {
  let active = 0, peak = 0;
  const releases = [];
  const connector = { id: 'audit', live: true, pull: () => { active++; peak = Math.max(active, peak); return new Promise(resolve => releases.push(() => { active--; resolve({ events: [], cursor: null }); })); } };
  const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(env.store), engine: env.engine, timeoutMs: 10 });
  try { await sync.run(); await sync.run(); }
  finally { releases.forEach(release => release()); }
  return { invariantPassed: peak <= 1, observed: { peakConcurrentPulls: peak, fixture: 'non-cooperative custom connector' } };
});

check('MEM-03', 'FTS can retrieve an older scoped memory outside the vector candidate cap', async env => {
  const memory = env.runtime.memory; memory.maxVectors = 1;
  memory.put({ id: 'old', content: 'contractual deadline', scopeType: 'project', scopeKey: 'A' });
  env.advance(1000); memory.put({ id: 'new', content: 'Unrelated newer text', scopeType: 'project', scopeKey: 'A' });
  const hits = memory.search('contractual deadline', { scopes: [{ type: 'project', key: 'A' }] });
  assert.ok(hits.find(item => item.id === 'old').channels.includes('fts5'));
  return { invariantPassed: true };
});

check('CTX-02', 'deferred context can be read completely only through the current task lease', async env => {
  env.runtime.suspended = true;
  env.engine.ingest(mail(env));
  const created = env.runtime.tasks.createOrLoad({ candidateKey: 'context-reader', eventId: 'event:seed', data: { status: 'waiting_for_information', subject: 'contract', sourceConnectorId: 'simulated', request: { text: 'contract' } } });
  env.runtime.memory.put({ id: 'long', content: `${'contract '.repeat(800)}EXCEPT preserve risks` });
  const queued = env.runtime.jobs.list().find(job => job.task_id === created.taskId);
  const job = env.runtime.jobs.claim('test-reader', { id: queued.id });
  const run = env.runtime.tasks.beginRun(job), task = env.runtime.tasks.get(created.taskId);
  const context = env.runtime.buildContext(task, run);
  env.runtime.tasks.checkpoint(run, job, { expectedInputVersion: task.inputVersion, contextVersion: context.version, sources: context.sources, plan: {} });
  env.runtime.suspended = false;
  await env.runtime.scope.run({ taskId: task.id, job, run, context }, async () => {
    assert.equal(env.runtime.contextReady(task.id), false);
    const tool = env.runtime.tools({ taskId: task.id, isCurrent: () => true }).find(tool => tool.name === 'read_context_item');
    await tool.execute('gap', { id: 'long', offset: 4000 });
    assert.equal(env.runtime.contextReady(task.id), false);
    await tool.execute('start', { id: 'long', offset: 0 });
    const result = await tool.execute('end', { id: 'long', offset: 4000 });
    assert.match(result.content[0].text, /EXCEPT/);
    assert.equal(env.runtime.contextReady(task.id), true);
    env.runtime.tasks.finish(run, job); env.runtime.jobs.complete(job);
    await assert.rejects(tool.execute('stale', { id: 'long' }), { code: 'TASK_CONTEXT_UNAVAILABLE' });
  });
  return { invariantPassed: true };
});

check('ACT-07', 'a flag change discards an in-flight semantic match', async env => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  env.engine.reasoner.assessStandingIntent = async () => { entered(); return new Promise(resolve => { release = () => resolve({ matched: true, confidence: 0.95, quote: 'The lobby was noisy.' }); }); };
  createIntent(env, { predicate: 'Lobby noise' });
  env.engine.ingest(mail(env));
  await started; env.runtime.setFlags({ standingIntents: false }); release(); await env.settle();
  assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM situations WHERE kind='standing_intent'").get().n, 0);
  return { invariantPassed: true };
});

check('ACT-08', 'startup restores a legacy standing task outcome from its confirmed source', async env => {
  env.runtime.suspended = true;
  env.engine.ingest(mail(env));
  const intent = createIntent(env);
  const situation = env.runtime.tasks.situations.create({ kind: 'standing_intent', summary: intent.description, standingIntentId: intent.id, sourceEventIds: ['event:seed'], closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: [null] } });
  const created = env.runtime.tasks.createOrLoad({ candidateKey: 'legacy', situationId: situation.id, dedupTaskKey: 'legacy', eventId: 'event:seed', data: { status: 'waiting_for_information', subject: intent.description, request: { deliverable: 'draft' } } });
  env.runtime.suspended = false; env.runtime.start(); await env.settle();
  assert.equal(env.runtime.tasks.get(created.taskId).request.text, intent.desiredOutcome);
  assert.deepEqual(env.runtime.tasks.situations.get(situation.id).closureCondition.missingEvidence, [intent.desiredOutcome]);
  return { invariantPassed: true };
});

check('ACT-09', 'editing and pausing a standing goal invalidates its prepared work without undoing user control', async env => {
  const intent = createIntent(env, { autonomy: { maxAutonomy: 'prepare' } });
  env.engine.ingest(mail(env)); await env.settle();
  const taskId = env.store.db.prepare('SELECT id FROM tasks').get().id;
  const edited = env.runtime.intents.update(intent.id, intent.version, spec({ desiredOutcome: 'Review unresolved noise risks', autonomy: { maxAutonomy: 'prepare' } }));
  env.runtime.syncStandingIntent(edited); await env.settle();
  assert.match(env.runtime.tasks.get(taskId).preparedWork.body, /Review unresolved noise risks/);
  const paused = env.runtime.intents.transition(edited.id, edited.version, 'paused');
  env.runtime.syncStandingIntent(paused); await env.settle();
  assert.equal(env.runtime.tasks.get(taskId).control.paused, true);
  assert.equal(env.runtime.tasks.get(taskId).preparedWork, undefined);
  const resumed = env.runtime.intents.transition(paused.id, paused.version, 'active');
  env.runtime.syncStandingIntent(resumed); await env.settle();
  assert.equal(env.runtime.tasks.get(taskId).control.paused, false);
  assert.match(env.runtime.tasks.get(taskId).preparedWork.body, /Review unresolved noise risks/);
  return { invariantPassed: true };
});

check('DIR-01', 'explicit replacement drops old content requirements while preserving source and recipient identity', async env => {
  const original = { text: 'Include the sample size', requiredContent: [{ text: 'sample size' }], deliverable: 'report', source: { id: 'source', from: 'owner@example.test' } };
  const effective = effectiveTaskRequest({ request: original, guidance: { text: 'Only summarize the open risks', operation: 'replace' } }, env.store.state);
  assert.ok(!effective.text.includes('sample size'));
  assert.ok(!effective.requiredContent.some(item => item.text.includes('sample size')));
  assert.deepEqual(effective.source, original.source);
  return { invariantPassed: true };
});

check('MET-02', 'single-ended windows, resume cohorts and invalid labels have consistent semantics', async env => {
  env.runtime.tasks.createOrLoad({ candidateKey: 'resumed', data: { status: 'waiting_for_information', yieldResumedAt: env.at() } });
  assert.equal(env.runtime.activationMetrics({ since: '2026-10-28T11:00:00Z' }).duplicateTaskRate.denominator, 1);
  assert.equal(env.runtime.activationMetrics({ until: '2026-10-28T13:00:00Z' }).duplicateTaskRate.denominator, 1);
  assert.equal(env.runtime.activationMetrics().yieldResumeRate.value, 1);
  assert.throws(() => env.runtime.activationMetrics({ since: 'invalid' }), { code: 'INVALID_METRIC_WINDOW' });
  assert.throws(() => env.runtime.activationMetrics({ labeled: { useful: 2, activated: 1, truePositives: 1, labeledPositives: 1 } }), { code: 'INVALID_METRIC_LABELS' });
  return { invariantPassed: true };
});
