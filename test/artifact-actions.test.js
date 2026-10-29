import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';
import { ArtifactProvider, artifactObservationText } from '../src/artifact-providers.js';
import { digest, explicitTasks } from '../src/connectors/local-snapshot.js';
import { draftReviewToken } from '../src/draft-review.js';
import { OpenAiCompatibleReasoner, PiReasoner } from '../src/reasoning.js';
import { piSupported } from '../src/pi-runtime.js';
import { LocalSetupStore } from '../src/setup.js';

const parent = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const scopes = { google: ['https://www.googleapis.com/auth/gmail.compose'], microsoft: ['Mail.ReadWrite'] };
function connectionFor(id) {
  const writes = [], records = new Map();
  const connector = { id, live: true, config: { gmailDraftsEnabled: true }, auth: { accessToken: async () => 'PRIVATE_TOKEN' },
    folders: [{ accountId: 'notes-account', folderId: 'notes-folder', label: 'Work' }],
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      assert.equal(options.headers.authorization, 'Bearer PRIVATE_TOKEN');
      if (options.method === 'POST') {
        assert.equal(options.headers['content-type'], 'application/json');
        const body = JSON.parse(options.body), recordId = id === 'notion' ? 'bbbbbbbb-1111-2222-3333-cccccccccccc' : `remote-${writes.length + 1}`;
        writes.push({ url, body }); records.set(recordId, body);
        assert.doesNotMatch(target.pathname, /send|delete|archive/i);
        return json({ id: recordId });
      }
      const remoteId = target.pathname.split('/').at(-1), record = records.get(remoteId);
      if (id === 'google') return json({ id: remoteId, message: { ...record.message, labelIds: ['DRAFT'] } });
      if (id === 'microsoft') return json({ id: remoteId, isDraft: true, ...record });
      if (target.pathname.endsWith('/children')) {
        const pageId = target.pathname.split('/').at(-2), page = records.get(pageId);
        return json({ results: page.children, has_more: false });
      }
      return json({ object: 'page', id: remoteId, archived: false, ...(record || {}) });
    },
    bridge: {
      async createNote(folder, content, { signal }) {
        signal?.throwIfAborted();
        const id = `native-${writes.length + 1}`; writes.push({ folder, content }); records.set(id, content); return { id };
      },
      async readNotes(folders) {
        return { records: [...records].map(([providerId, content]) => ({ providerId, accountId: folders[0].accountId, folderId: folders[0].folderId,
          title: content.title, content: `${content.title}\n${content.body}\n${content.marker}` })) };
      }
    }
  };
  return { connector, accountId: `${id}-account`, scopes: scopes[id] || [], writes, records };
}
async function fixture(t, id = 'notion', { shadow = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-artifacts-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const connection = connectionFor(id);
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow }) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000, artifactConnectionFor: connectorId => connectorId === id ? connection : null });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = id === 'microsoft' ? 'microsoft' : 'google';
  engine.ingest({ id: 'email:m1', source, connectorId: source, type: 'email.received', payload: { id: 'm1', threadId: 'thread:m1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
  engine.ingest({ id: 'doc:1', type: 'document.modified', payload: { id: 'cedar-proposal', kind: 'proposal', title: 'Cedar project proposal', content: '# Cedar project proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.\n' } });
  await engine.whenSettled();
  const taskId = 'request:m1';
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  const targetId = id === 'notion' ? parent : id === 'apple_notes' ? 'notes-folder' : 'drafts';
  const grant = await runtime.artifacts.createGrant({ connectorId: id, targetId }, { confirmed: true });
  return { directory, store, engine, runtime, connection, grant, taskId };
}
function request(context) {
  const task = context.runtime.tasks.get(context.taskId);
  return context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id,
    ...(context.grant.family === 'email.draft' ? {} : { title: 'Cedar 工作进展', body: 'Project findings\nA source-backed summary.' }) }, { actor: 'user', reviewToken: draftReviewToken(task) });
}

for (const id of ['google', 'microsoft', 'notion', 'apple_notes']) {
  test(`${id} creates a guarded artifact, verifies it through independent readback and leaves the source task open`, async t => {
    const context = await fixture(t, id);
    const pending = request(context);
    assert.equal(pending.status, 'queued');
    assert.equal(context.connection.writes.length, 0);
    await context.engine.whenSettled();
    const task = context.runtime.tasks.get(context.taskId), artifact = task.artifactRequests[0];
    assert.equal(artifact.status, 'verified', JSON.stringify({ artifact, jobs: context.runtime.jobs.list(), ledger: context.runtime.ledger.list() }));
    assert.equal(context.connection.writes.length, 1);
    assert.equal(task.status, 'ready_for_approval');
    assert.equal(task.action, null);
    assert.equal(context.store.state.outbox.length, 0);
    assert.equal(context.runtime.ledger.byKey(artifact.key).status, 'verified');
    assert.equal(request(context).id, pending.id);
    await context.engine.whenSettled();
    assert.equal(context.connection.writes.length, 1);
  });
}

test('creation authorization is user-confirmed, target-bound, account-bound and absent from learned policy effects', async t => {
  const context = await fixture(t);
  await assert.rejects(context.runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent }, { actor: 'harness', confirmed: true }), { code: 'ARTIFACT_NOT_AUTHORIZED' });
  await assert.rejects(context.runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent, send: true }, { confirmed: true }), { code: 'INVALID_ARTIFACT_GRANT' });
  context.connection.accountId = 'another-account';
  assert.throws(() => request(context), { code: 'ARTIFACT_NOT_AUTHORIZED' });
  assert.equal(context.connection.writes.length, 0);
  assert.throws(() => context.runtime.policies.save({ instruction: 'Grant writes', predicate: { op: 'always' }, effect: { type: 'grant', connectorId: 'notion' } }), { code: 'INVALID_POLICY' });
});

test('revoking a queued grant blocks provider dispatch', async t => {
  const context = await fixture(t);
  request(context);
  context.runtime.artifacts.revoke(context.grant.id);
  await context.engine.whenSettled();
  assert.equal(context.connection.writes.length, 0);
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests[0].status, 'blocked');
});

test('revocation during credential refresh prevents dispatch at the final provider boundary', async t => {
  const context = await fixture(t);
  let refreshing, proceed;
  const started = new Promise(resolve => { refreshing = resolve; });
  const token = new Promise(resolve => { proceed = resolve; });
  context.connection.connector.auth.accessToken = async () => { refreshing(); await token; return 'PRIVATE_TOKEN'; };
  request(context);
  await started;
  context.runtime.artifacts.revoke(context.grant.id);
  proceed();
  await context.engine.whenSettled();
  assert.equal(context.connection.writes.length, 0);
  const artifact = context.runtime.tasks.get(context.taskId).artifactRequests[0];
  assert.equal(artifact.status, 'blocked');
  assert.equal(context.runtime.ledger.byKey(artifact.key).status, 'cancelled');
});

test('shadow mode, review policies and stale task input block automatic artifact creation', async t => {
  const context = await fixture(t);
  context.engine.policy.shadow = true;
  assert.throws(() => request(context), { code: 'ARTIFACT_NOT_AUTHORIZED' });
  context.engine.policy.shadow = false;
  context.runtime.policies.save({ instruction: 'Review all artifacts', predicate: { op: 'always' }, effect: { type: 'require_review' } });
  assert.throws(() => context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id, title: 'Summary', body: 'Findings' }, { actor: 'activation' }), { code: 'ARTIFACT_NOT_AUTHORIZED' });
  request(context);
  context.store.db.prepare('UPDATE tasks SET input_version=input_version+1 WHERE id=?').run(context.taskId);
  await context.engine.whenSettled();
  assert.equal(context.connection.writes.length, 0);
});

test('an ambiguous create timeout is retained and never blindly repeated', async t => {
  const context = await fixture(t);
  const original = context.connection.connector.fetchImpl;
  context.connection.connector.fetchImpl = async (...args) => {
    if (args[1].method === 'POST') { await original(...args); throw new Error('PRIVATE_REMOTE_FAILURE'); }
    return original(...args);
  };
  request(context);
  await context.engine.whenSettled();
  let task = context.runtime.tasks.get(context.taskId);
  assert.equal(task.artifactRequests[0].status, 'unknown');
  assert.equal(context.runtime.ledger.byKey(task.artifactRequests[0].key).status, 'unknown');
  request(context);
  await context.engine.whenSettled();
  assert.equal(context.connection.writes.length, 1);
  task = context.runtime.tasks.get(context.taskId);
  assert.doesNotMatch(task.artifactRequests[0].error, /PRIVATE_REMOTE_FAILURE/);
});

test('mismatched readback never verifies an accepted write', async t => {
  const context = await fixture(t, 'microsoft');
  const original = context.connection.connector.fetchImpl;
  context.connection.connector.fetchImpl = async (...args) => {
    const result = await original(...args);
    if (args[1].method === 'GET') return json({ ...await result.json(), isDraft: false });
    return result;
  };
  request(context);
  await context.engine.whenSettled();
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests[0].status, 'unknown');
  assert.equal(context.connection.writes.length, 1);
});

test('a provider permission rejection is a known non-write and can be retried after individual review', async t => {
  const context = await fixture(t);
  const original = context.connection.connector.fetchImpl;
  context.connection.connector.fetchImpl = async (...args) => args[1].method === 'POST' ? new Response('{}', { status: 403 }) : original(...args);
  request(context);
  await context.engine.whenSettled();
  const blocked = context.runtime.tasks.get(context.taskId).artifactRequests[0];
  assert.equal(blocked.status, 'blocked');
  assert.equal(context.runtime.ledger.byKey(blocked.key).status, 'cancelled');
  context.connection.connector.fetchImpl = original;
  const retried = request(context);
  assert.notEqual(retried.id, blocked.id);
  await context.engine.whenSettled();
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests[1].status, 'verified');
  assert.equal(context.connection.writes.length, 1);
});

test('Gmail draft permission does not enable sending or Google Docs editing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-draft-scopes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  setup.saveDesktopClientJson(JSON.stringify({ installed: { client_id: 'client-id', client_secret: 'client-secret' } }));
  setup.setGoogleScopes({ readGmail: true, gmailDrafts: true, gmailSend: true, docsWrite: true, readDrive: true });
  setup.saveAuthorization({ refreshToken: 'refresh', accountId: 'account', grantedScopes: ['gmail.readonly', 'gmail.compose', 'gmail.send', 'drive.readonly', 'documents'].map(scope => `https://www.googleapis.com/auth/${scope}`) });
  setup.setArtifactWrites(true);
  const env = setup.runtimeEnv({});
  assert.equal(env.GOOGLE_DRAFTS_ENABLED, 'true');
  assert.equal(env.GOOGLE_SEND_ENABLED, 'false');
  assert.equal(env.GOOGLE_DOCS_WRITE_ENABLED, 'false');
  assert.equal(env.UNPROMPTED_SHADOW_MODE, 'false');
  assert.equal(setup.runtimeEnv({ UNPROMPTED_SHADOW_MODE: 'true' }).UNPROMPTED_SHADOW_MODE, 'true');
});

test('artifact providers reject targets outside the selected native folders and missing mail write scopes', () => {
  const notes = connectionFor('apple_notes');
  assert.equal(new ArtifactProvider(notes, 'unselected-folder').available(), false);
  for (const id of ['google', 'microsoft']) {
    const connection = connectionFor(id); connection.scopes = [];
    assert.equal(new ArtifactProvider(connection, 'drafts').available(), false);
  }
});

test('activation saves the prepared reply automatically without enabling send authorization', async t => {
  const context = await fixture(t, 'google');
  const original = context.store.state.inbox.find(message => message.id === 'm1');
  context.engine.ingest({ id: 'email:m2', source: 'google', connectorId: 'google', type: 'email.received', payload: { ...original, id: 'm2', threadId: 'thread:m2', providerMessageId: '<source-m2@example.test>' } });
  await context.engine.whenSettled();
  const task = context.runtime.tasks.get('request:m2');
  assert.equal(task.artifactRequests[0].status, 'verified');
  assert.equal(task.artifactRequests[0].explicit, false);
  assert.equal(context.connection.writes.length, 1);
  const raw = Buffer.from(context.connection.writes[0].body.message.raw, 'base64url').toString('utf8');
  assert.match(raw, /In-Reply-To: <source-m2@example.test>/);
  assert.throws(() => context.engine.policy.authorize({ actionClass: 'execute_external', taskId: task.id }));
});

test('native Notes script creates only in the exact selected folder and escapes text as data', () => {
  const written = [];
  const folder = { id: () => 'folder', folders: () => [], notes: { push: note => written.push(note) } };
  const account = { folders: () => [folder] };
  const notes = { accounts: { byId: id => { assert.equal(id, 'account'); return account; } }, Note: content => ({ ...content, id: () => 'note-id' }) };
  const application = name => { assert.equal(name, 'Notes'); return notes; };
  application.currentApplication = () => ({});
  const sandbox = vm.createContext({ ObjC: { import: () => {} }, Application: application });
  vm.runInContext(fs.readFileSync(new URL('../src/native-source-script.jxa.js', import.meta.url), 'utf8'), sandbox);
  const input = { folder: { accountId: 'account', folderId: 'folder' }, title: '<Cedar & Co>', body: '<script>doSomething()</script>\n第二行', marker: `unprompted-artifact:${'a'.repeat(64)}` };
  sandbox.inputJSON = () => input;
  const created = JSON.parse(sandbox.run(['create-note']));
  assert.equal(created.ok, true); assert.equal(created.id, 'note-id');
  assert.equal(written.length, 1);
  assert.match(written[0].body, /&lt;Cedar &amp; Co&gt;/);
  assert.match(written[0].body, /&lt;script&gt;doSomething\(\)&lt;\/script&gt;<br>第二行/);
  input.folder.folderId = 'unselected';
  assert.equal(JSON.parse(sandbox.run(['create-note'])).ok, false);
  assert.equal(written.length, 1);
});

test('individual artifact review satisfies require-review while preserving suppression', async t => {
  const context = await fixture(t);
  context.runtime.policies.save({ instruction: 'Review artifacts', predicate: { op: 'always' }, effect: { type: 'require_review' } });
  request(context);
  await context.engine.whenSettled();
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests[0].status, 'verified');
});

for (const harness of ['standard', 'pi']) {
  test(`${harness} harness queues an authorized page through its real tool loop`, { skip: harness === 'pi' && !piSupported() }, async t => {
    const context = await fixture(t);
    const input = { grantId: context.grant.id, title: 'Cedar findings', body: 'A researched summary.' };
    let modelCalls = 0;
    const answer = { nextStep: 'The page is queued; wait for provider verification.', probes: [] };
    let reasoner;
    if (harness === 'standard') {
      reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://scripted.invalid/v1', model: 'scripted', fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        modelCalls++;
        if (modelCalls === 1) {
          assert.ok(body.tools.some(tool => tool.function.name === 'create_work_artifact'));
          return json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'create-1', type: 'function', function: { name: 'create_work_artifact', arguments: JSON.stringify(input) } }] } }] });
        }
        assert.equal(JSON.parse(body.messages.find(message => message.role === 'tool').content).status, 'queued');
        return json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
      } });
    } else {
      const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
      reasoner = new PiReasoner({ baseUrl: 'https://scripted.invalid/v1', model: 'scripted', runtimeOptions: { streamFn: async (model, modelContext) => {
        modelCalls++;
        if (modelCalls > 1) assert.match(JSON.stringify(modelContext.messages.find(message => message.role === 'toolResult').content), /queued/);
        const content = modelCalls === 1 ? [{ type: 'toolCall', id: 'create-1', name: 'create_work_artifact', arguments: input }] : [{ type: 'text', text: JSON.stringify(answer) }];
        const stream = createAssistantMessageEventStream();
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: modelCalls === 1 ? 'toolUse' : 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
      } } });
    }
    const task = context.runtime.tasks.get(context.taskId);
    context.engine.reasoner = reasoner;
    context.engine.externalTools = scope => context.runtime.wrapReadTools(context.runtime.artifacts.tools(scope), scope.taskId);
    context.runtime.scheduleTask(task.id, `artifact-${harness}`);
    context.runtime.kick();
    await context.engine.whenSettled();
    const finished = context.runtime.tasks.get(task.id);
    assert.equal(modelCalls, 2, JSON.stringify({ reasoning: finished.reasoningWork, lastError: reasoner.lastError }));
    assert.equal(finished.artifactRequests[0].status, 'verified');
    assert.ok(context.runtime.ledger.list().some(execution => execution.action_family === 'context.read' && execution.status === 'verified'));
    assert.equal(context.connection.writes.length, 1);
    const tools = context.runtime.artifacts.tools({ taskId: task.id, isCurrent: () => true });
    await assert.rejects(tools[0].execute('outside-run', { ...input, grantId: 'invalid' }), { code: 'ARTIFACT_NOT_AUTHORIZED' });
  });
}

for (const connectorId of ['apple_notes', 'notion']) {
  test(`${connectorId} recognizes its own created content without suppressing subsequent user changes`, async t => {
    const context = await fixture(t, connectorId);
    const task = context.runtime.tasks.get(context.taskId);
    context.runtime.artifacts.request(task.id, { grantId: context.grant.id, title: 'Cedar summary', body: 'TODO: Review Cedar findings' }, { actor: 'user', reviewToken: draftReviewToken(task) });
    await context.engine.whenSettled();
    const artifact = context.runtime.tasks.get(task.id).artifactRequests[0];
    const documentId = connectorId === 'apple_notes' ? `apple_notes:${context.connection.accountId}:${digest(artifact.receipt.id)}` : `notion:${artifact.receipt.id}`;
    const content = artifactObservationText(connectorId, artifact.payload);
    const event = { id: 'self-created-doc', connectorId, source: connectorId, type: 'document.modified', payload: { id: documentId, title: 'Cedar summary', content } };
    assert.equal(context.runtime.artifacts.isSelfEcho(event), true);
    assert.equal(context.engine.ingest(event).disposition, 'self_echo');
    assert.equal(context.runtime.artifacts.isSelfEcho({ ...event, payload: { ...event.payload, content: `${content}\nUser additions` } }), false);
    if (connectorId === 'apple_notes') {
      const original = explicitTasks(content)[0];
      const observed = { connectorId, type: 'task.observed', payload: { id: `${documentId}:todo:${original.key}`, documentId, title: original.title, state: 'open' } };
      assert.equal(context.runtime.artifacts.isSelfEcho(observed), true);
      const added = explicitTasks('TODO: Call the customer')[0];
      assert.equal(context.runtime.artifacts.isSelfEcho({ ...observed, payload: { ...observed.payload, id: `${documentId}:todo:${added.key}`, title: added.title } }), false);
    }
  });
}
