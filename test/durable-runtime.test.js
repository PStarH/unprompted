import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { emptyState } from '../src/store.js';
import { McpManager, McpConfigStore } from '../src/mcp.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { fileURLToPath } from 'node:url';
import { iso } from '../src/durable/database.js';

const email = (id = 'm1') => ({ id: `email:${id}`, type: 'email.received', payload: { id, threadId: `thread:${id}`, from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
const document = () => ({ id: 'doc:1', type: 'document.modified', payload: { id: 'cedar-proposal', kind: 'proposal', title: 'Cedar project proposal', content: '# Cedar project proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.\n' } });
function fixture(t, { seed = null, providerFactory = null, engineOptions = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-runtime-'));
  const filename = path.join(directory, 'state.json');
  if (seed) fs.writeFileSync(filename, JSON.stringify(seed));
  const store = new SqliteStore(filename), provider = providerFactory?.(store) || new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider, ...engineOptions }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, provider, engine, runtime, filename };
}
async function ready(context) {
  context.engine.ingest(email()); context.engine.ingest(document());
  await context.engine.whenSettled();
  assert.equal(context.store.state.tasks['request:m1'].status, 'ready_for_approval');
  return context.engine.publicState().tasks.find(task => task.id === 'request:m1');
}

test('real engine uses SQLite jobs, fresh checkpoints, durable send intents and independent verification', async t => {
  const context = fixture(t), task = await ready(context);
  assert.equal(task.inputVersion, task.processedInputVersion);
  assert.ok(context.store.database.db.prepare('SELECT COUNT(*) n FROM plan_steps').get().n > 0);
  assert.ok(context.store.database.db.prepare("SELECT 1 FROM lineage WHERE source_kind='task_run' AND derived_kind='artifact'").get());
  const send = context.provider.send.bind(context.provider);
  context.provider.send = (...args) => {
    assert.equal(context.store.db.inTransaction, false, 'provider I/O starts after preparation commits');
    assert.equal(context.runtime.ledger.byKey(args[0].idempotencyKey).status, 'intent', 'intent commits before guarded dispatch');
    return send(...args);
  };
  await context.engine.approve(task.id, { reviewToken: task.reviewToken });
  await context.engine.whenSettled();
  assert.equal(context.store.state.tasks[task.id].status, 'completed');
  const executions = context.runtime.ledger.list({ taskId: task.id });
  assert.equal(executions.length, 1); assert.equal(executions[0].status, 'verified');
  assert.equal(context.store.state.outbox.length, 1);
  assert.equal(context.store.database.db.prepare('SELECT claim_state FROM resource_claims').get().claim_state, 'free');
});

test('explicit suppression persists before activation and learning cannot grant a write', async t => {
  const context = fixture(t);
  context.runtime.policies.save({ instruction: 'Do not activate this sender', predicate: { op: 'eq', feature: 'sender.identity', value: 'alex@example.test' }, effect: { type: 'suppress' }, identities: [{ provider: 'simulated', providerId: 'alex@example.test', confirmedByUser: true }] });
  const result = context.engine.ingest(email()); await context.engine.whenSettled();
  assert.equal(result.disposition, 'suppressed_by_user_policy');
  assert.equal(Object.keys(context.store.state.tasks).length, 0);
  assert.equal(context.store.state.outbox.length, 0);
  assert.throws(() => context.runtime.policies.save({ instruction: 'Unsafe', predicate: { op: 'always' }, effect: { type: 'suppress', grant: 'all' } }), { code: 'INVALID_POLICY' });
});

test('a trusted withdrawal is applied before a new matching suppression policy', async t => {
  const context = fixture(t);
  context.engine.ingest(email());
  const task = context.store.state.tasks['request:m1'];
  assert.ok(task);
  context.runtime.policies.save({ instruction: 'Suppress this sender', predicate: { op: 'eq', feature: 'sender.identity', value: 'alex@example.test' }, effect: { type: 'suppress' }, identities: [{ provider: 'simulated', providerId: 'alex@example.test', confirmedByUser: true }] });
  const cancel = { ...email('m2'), payload: { ...email('m2').payload, threadId: 'thread:m1', body: 'Please cancel the Cedar proposal request.' } };
  assert.equal(context.engine.ingest(cancel).disposition, 'request_withdrawn');
  assert.equal(context.store.state.tasks[task.id].status, 'cancelled');
  assert.equal(context.engine.ingest(email('m3')).disposition, 'suppressed_by_user_policy');
});

test('a Gmail provider receipt suppresses its own echo without suppressing other messages', async t => {
  const context = fixture(t), db = context.store.db, at = iso();
  context.store.database.atomic(() => db.prepare(`INSERT INTO tool_executions(id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,provider_receipt_id,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES('known-write','gmail','send','email.send','thread','known-key','{}','verified',1,'provider-message',0,0,0,?,?)`).run(at, at));
  const echoed = { ...email('provider-message'), source: 'google', connectorId: 'google', providerEventId: 'gmail:provider-message' };
  assert.equal(context.engine.ingest(echoed).disposition, 'self_echo');
  assert.equal(Object.keys(context.store.state.tasks).length, 0);
  assert.equal(context.store.state.events[0].meta.originClass, 'AGENT_SELF');
  const unrelated = { ...email('different-message'), source: 'google', connectorId: 'google', providerEventId: 'gmail:different-message' };
  assert.equal(context.engine.ingest(unrelated).disposition, 'discovered_request');
});

test('provider-native closure bypasses suppression to invalidate an existing assignment', async t => {
  const context = fixture(t);
  const issue = { id: 'issue-1', title: 'Review Cedar', repository: 'team/project', number: 1, assigned: true, state: 'open', updatedAt: '2026-10-26T10:00:00Z', url: 'https://github.com/team/project/issues/1' };
  context.engine.ingest({ id: 'issue-open', type: 'issue.updated', source: 'github', connectorId: 'github', payload: issue });
  context.runtime.policies.save({ instruction: 'Suppress new activation', predicate: { op: 'always' }, effect: { type: 'suppress' } });
  context.engine.ingest({ id: 'issue-closed', type: 'issue.updated', source: 'github', connectorId: 'github', payload: { ...issue, state: 'closed', updatedAt: '2026-10-26T11:00:00Z' } });
  assert.equal(context.store.state.tasks['issue:issue-1'].status, 'cancelled');
  assert.equal(context.store.state.events.find(event => event.id === 'issue-closed').disposition, 'request_withdrawn');
});

test('a candidate can be tried on a real draft and earns only attributable verified supervised evidence', async t => {
  const context = fixture(t), task = await ready(context);
  const experience = context.runtime.experiences.create({ kind: 'execution_hint', scopeType: 'project', scopeKey: 'Cedar', instruction: 'Use Markdown for Cedar replies.', directiveKey: 'email.draft.format', effect: { type: 'draft_format', format: 'markdown' } }, { sources: [{ kind: 'event', id: 'email:m1' }] });
  await context.runtime.trial(experience.id, { taskId: task.id, reviewToken: task.reviewToken });
  const reviewed = context.engine.publicState().tasks.find(row => row.id === task.id);
  assert.match(reviewed.draft.body, /^## /);
  assert.equal(context.store.state.outbox.length, 0);
  assert.equal(context.runtime.experiences.get(experience.id).verified_success_count, 0);
  await context.engine.approve(task.id, { reviewToken: reviewed.reviewToken }); await context.engine.whenSettled();
  assert.equal(context.runtime.experiences.get(experience.id).verified_success_count, 1);
  assert.equal(context.runtime.experiences.get(experience.id).status, 'candidate');
});

test('Forget cancels an actual ready task and removes its source, checkpoint, history and candidate', async t => {
  const context = fixture(t), task = await ready(context);
  const result = await context.runtime.privacy.forget({ kind: 'event', id: 'email:m1' });
  assert.equal(result.state, 'completed');
  assert.equal(context.engine.publicState().tasks.length, 0);
  assert.equal(context.store.state.inbox.length, 0);
  const signal = context.store.database.db.prepare("SELECT * FROM task_signals WHERE task_id=? AND signal_type='SYSTEM_REVOKE_SIGNAL'").get(task.id);
  assert.ok(signal);
  assert.notEqual(signal.source_event_id, 'email:m1');
  assert.equal(signal.status, 'PENDING');
  assert.equal(context.store.database.db.prepare('SELECT COUNT(*) n FROM task_runs WHERE checkpoint_json IS NOT NULL').get().n, 0);
  assert.equal(context.store.state.history.filter(row => row.taskId === task.id).length, 0);
  assert.equal(context.engine.ingest(email()).disposition, 'forgotten');
  assert.equal((await context.runtime.privacy.forget({ kind: 'event', id: 'email:m1' })).id, result.id);
});

test('startup imports an interrupted old action into an unresolved ledger without resending', async t => {
  const state = emptyState();
  state.tasks.legacy = { id: 'legacy', status: 'blocked', subject: 'Legacy work', request: { subjectEntity: 'Cedar', deliverable: 'proposal' }, draft: { to: 'alex@example.test', subject: 'Cedar proposal', body: 'Existing draft' }, action: { idempotencyKey: 'legacy-write', status: 'uncertain' } };
  const context = fixture(t, { seed: state, providerFactory: store => { const provider = new SimulatedMailProvider(store); provider.live = true; provider.lookup = async () => ({ status: 'unknown' }); provider.send = () => { throw new Error('Must not resend'); }; return provider; } });
  context.runtime.start(); await context.runtime.whenIdle();
  assert.equal(context.runtime.ledger.byKey('legacy-write').status, 'unknown');
  assert.equal(context.store.database.db.prepare('SELECT claim_state FROM resource_claims').get().claim_state, 'unresolved');
  assert.equal(context.store.state.outbox.length, 0);
  assert.equal(fs.existsSync(context.filename + '.migration-backup'), true);
});

test('received durable inbox events resume through their own job after interruption', async t => {
  const context = fixture(t), event = { ...email(), connectorId: 'simulated', source: 'simulated', at: new Date().toISOString() };
  const db = context.store.database;
  db.atomic(() => { db.db.prepare('INSERT INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)').run(event.id, event.connectorId, event.id, JSON.stringify(event), 'pending', iso()); });
  context.runtime.start(); await context.engine.whenSettled();
  assert.ok(context.store.state.tasks['request:m1']);
  assert.equal(db.db.prepare('SELECT state FROM durable_inbox WHERE id=?').get(event.id).state, 'processed');
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM jobs WHERE queue_name='inbox' AND state='completed'").get().n, 1);
});

test('durable document patches bind exact reviewed changes and persist independent readback', async t => {
  const context = fixture(t), task = await ready(context);
  const patch = await context.engine.taskServices.prepareDocumentPatch(task.id, { provider: 'local', changes: [{ type: 'append', text: 'latest experiment results', source: { kind: 'email', id: 'm1', quote: 'latest experiment results' } }] });
  assert.equal(patch.status, 'prepared');
  const result = await context.engine.taskServices.applyDocumentPatch(task.id, { patchId: patch.id, authorization: { kind: 'explicit', taskId: task.id, patchId: patch.id, baseDocumentVersion: patch.baseDocument.version, confirmed: true } });
  assert.equal(result.patch.status, 'applied');
  const execution = context.runtime.ledger.list().find(row => row.action_family === 'document.patch');
  assert.equal(execution.status, 'verified');
  assert.match(context.store.state.documents[task.documentId].content, /latest experiment results/);
});

test('a user draft edit invalidates its old approval and a verified send records adoption without endorsing heavily rewritten style', async t => {
  const context = fixture(t), original = await ready(context);
  const experience = context.runtime.experiences.create({ kind: 'execution_hint', scopeType: 'project', scopeKey: 'Cedar', instruction: 'Use Markdown.', directiveKey: 'email.draft.format', effect: { type: 'draft_format', format: 'markdown' } }, { sources: [{ kind: 'event', id: 'email:m1' }] });
  await context.runtime.trial(experience.id, { taskId: original.id, reviewToken: original.reviewToken });
  const trial = context.engine.publicState().tasks.find(task => task.id === original.id);
  context.runtime.editDraft(trial.id, { body: 'I have reviewed the available information and will follow up personally.', reviewToken: trial.reviewToken });
  assert.throws(() => context.engine.approve(trial.id, { reviewToken: trial.reviewToken }), { code: 'REVIEW_CHANGED' });
  const edited = context.engine.publicState().tasks.find(task => task.id === trial.id);
  await context.engine.approve(edited.id, { reviewToken: edited.reviewToken }); await context.engine.whenSettled();
  const learned = context.runtime.experiences.get(experience.id);
  assert.equal(learned.positive_evidence_count, 0); assert.equal(learned.negative_evidence_count, 0);
  assert.equal(learned.verified_success_count, 0);
  assert.ok(context.store.database.db.prepare("SELECT 1 FROM feedback_events WHERE kind='implicit_override'").get());
  assert.ok(context.store.database.db.prepare("SELECT 1 FROM feedback_events WHERE kind='verified_consumption'").get());
  assert.equal(context.store.state.tasks[edited.id].status, 'completed');
});

test('a user-edited draft is preserved when its source changes and requires explicit review', async t => {
  const context = fixture(t), original = await ready(context);
  const body = 'I am handling this personally and will follow up after reviewing the evidence.';
  context.runtime.editDraft(original.id, { body, reviewToken: original.reviewToken });
  const changed = document(); changed.id = 'doc:2'; changed.payload.content += '\nA new source note.\n';
  context.engine.ingest(changed); await context.engine.whenSettled();
  let task = context.engine.publicState().tasks.find(row => row.id === original.id);
  assert.equal(task.draft.body, body);
  assert.equal(task.yieldState, 'YIELDED_TO_USER');
  assert.equal(task.userDraftStale, true);
  assert.equal(task.status, 'waiting_for_information');
  assert.throws(() => context.engine.approve(task.id, { reviewToken: task.reviewToken }), /not ready/i);
  assert.equal(context.store.state.outbox.length, 0);
  context.runtime.editDraft(task.id, { body, reviewToken: task.reviewToken });
  task = context.engine.publicState().tasks.find(row => row.id === original.id);
  assert.equal(task.draft.body, body); assert.equal(task.userDraftStale, false); assert.equal(task.status, 'ready_for_approval');
  await context.engine.approve(task.id, { reviewToken: task.reviewToken }); await context.engine.whenSettled();
  assert.equal(context.store.state.outbox[0].body, body);
});

test('request revision and cancellation preserve a user-edited draft without sending it', async t => {
  const context = fixture(t), original = await ready(context);
  const body = 'I will take care of this personally.';
  context.runtime.editDraft(original.id, { body, reviewToken: original.reviewToken });
  const revision = email('revision'); revision.at = new Date(Date.now() + 1000).toISOString();
  revision.payload = { ...revision.payload, threadId: 'thread:m1', body: 'The deadline moved to 2026-11-18.' };
  context.engine.ingest(revision); await context.engine.whenSettled();
  assert.equal(context.store.tasks.get(original.id).draft.body, body);
  const cancellation = email('cancel'); cancellation.at = new Date(Date.now() + 2000).toISOString();
  cancellation.payload = { ...cancellation.payload, threadId: 'thread:m1', body: 'Please cancel the Cedar proposal request.' };
  context.engine.ingest(cancellation); await context.engine.whenSettled();
  const task = context.store.tasks.get(original.id);
  assert.equal(task.status, 'cancelled'); assert.equal(task.draft.body, body);
  assert.equal(context.store.state.outbox.length, 0);
});

test('the shipped durable harness performs a real MCP tool loop with a task-owned read ledger', async t => {
  let manager;
  const context = fixture(t, { engineOptions: { externalTools: scope => manager?.tools(scope) || [] } });
  manager = new McpManager({ configStore: new McpConfigStore(path.dirname(context.filename)), timeoutMs: 3000 });
  t.after(() => manager.close());
  await manager.import({ mcpServers: { local: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--stdio'] } } }, { allowDeclaredRead: true });
  const tools = manager.tools({ isCurrent: () => true }), requests = [];
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://model.test/v1', model: 'fixture', fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const message = request.messages.some(item => item.role === 'tool') ? { content: '{"nextStep":"Check the source budget context."}' } : { content: null, tool_calls: [{ type: 'function', id: 'owned-call', function: { name: tools.find(tool => tool.label.endsWith('lookup')).name, arguments: '{"query":"Cedar"}' } }] };
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  } });
  context.engine.replaceReasoner(reasoner);
  context.engine.ingest({ id: 'issue:1', type: 'issue.updated', connectorId: 'github', source: 'github', payload: { id: 'assigned-one', title: 'Review Cedar budget', body: 'Check the source.', repository: 'team/work', number: 1, assigned: true, state: 'open', updatedAt: new Date().toISOString(), url: 'https://github.com/team/work/issues/1', assignee: 'reader', author: 'teammate' } });
  await context.engine.whenSettled();
  const task = Object.values(context.store.state.tasks)[0];
  assert.equal(task.mcpCalls?.length, 1); assert.equal(requests.length, 2);
  assert.equal(task.mcpInvestigation.nextStep, 'Check the source budget context.');
  const read = context.runtime.ledger.list({ taskId: task.id }).find(row => row.provider === 'mcp');
  assert.equal(read.status, 'verified'); assert.equal(read.is_write, 0);
  assert.equal(context.store.state.outbox.length, 0); assert.notEqual(task.status, 'completed');
});

test('Forget during async patch preparation prevents a late patch from restoring forgotten content', async t => {
  const context = fixture(t), task = await ready(context);
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  context.engine.taskServices.localDocumentProvider.prepareBase = async document => { started(); return new Promise(resolve => { release = () => resolve({ content: document.content, simulated: true }); }); };
  const preparing = context.engine.taskServices.prepareDocumentPatch(task.id, { provider: 'local', changes: [{ type: 'append', text: 'latest experiment results', source: { kind: 'email', id: 'm1', quote: 'latest experiment results' } }] });
  await waiting;
  await context.runtime.privacy.forget({ kind: 'task', id: task.id }); release();
  await assert.rejects(preparing, { code: 'RUN_INVALIDATED' });
  assert.equal(Object.keys(context.store.state.documentPatches || {}).length, 0);
  assert.equal(context.engine.publicState().tasks.length, 0);
});

test('Forget clears old scoped permissions, linked questions and untraceable calibration summaries', async t => {
  const context = fixture(t), task = await ready(context);
  context.engine.recordCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: 'Cedar', deliverable: 'proposal' } });
  context.store.mutate(state => {
    state.clarifications.push({ id: 'old-question', scope: { entity: 'Cedar' }, question: 'Private project detail', status: 'answered' });
    state.notifications.push({ id: 'old-notice', clarificationId: 'old-question', what: 'Private project detail' });
  });
  await context.runtime.privacy.forget({ kind: 'task', id: task.id });
  const state = context.store.state;
  assert.equal(Object.keys(state.calibrations).length, 0);
  assert.equal(state.clarifications.length, 0);
  assert.equal(state.notifications.some(notice => notice.clarificationId === 'old-question'), false);
  assert.equal(state.history.some(row => ['calibration', 'correction'].includes(row.kind)), false);
  assert.doesNotMatch(context.store.database.db.prepare('SELECT state_json FROM workspace_state').get().state_json, /Private project detail/);
});

test('an explicit review policy overrides an old standing grant while exact manual approval still works', async t => {
  const context = fixture(t);
  context.engine.recordCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: 'Cedar', deliverable: 'proposal' } });
  context.runtime.policies.save({ instruction: 'Review every action first', predicate: { op: 'always' }, effect: { type: 'require_review' } });
  const task = await ready(context);
  assert.equal(context.store.state.outbox.length, 0);
  assert.throws(() => context.engine.executePreAuthorized(task.id), { code: 'REVIEW_REQUIRED' });
  await context.engine.approve(task.id, { reviewToken: task.reviewToken }); await context.engine.whenSettled();
  assert.equal(context.store.state.tasks[task.id].status, 'completed'); assert.equal(context.store.state.outbox.length, 1);
});
