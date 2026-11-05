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
import { reminderListId } from '../src/connectors/apple-reminders.js';
import { parseMailbox } from '../src/connectors/google.js';

const parent = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const scopes = { google: ['https://www.googleapis.com/auth/gmail.compose'], microsoft: ['Mail.ReadWrite'] };
function connectionFor(id) {
  const writes = [], records = new Map(), removals = [], deleted = new Set();
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
      if (options.method === 'DELETE') { removals.push(target.pathname); records.delete(remoteId); deleted.add(remoteId); return new Response(null, { status: 204 }); }
      if (options.method === 'PATCH') { removals.push(target.pathname); Object.assign(record, JSON.parse(options.body)); return json({ id: remoteId, ...record }); }
      if (deleted.has(remoteId)) return new Response('{}', { status: 404 });
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
      },
      async createReminder(folder, content, { signal }) {
        signal?.throwIfAborted();
        const id = `native-${writes.length + 1}`; writes.push({ folder, content }); records.set(id, content); return { id };
      },
      async readReminders(folders) {
        return { records: [...records].map(([id, content]) => ({ id, accountId: folders[0].accountId, folderId: folders[0].folderId,
          title: content.title, body: `${content.body}\n${content.marker}`, state: 'open' })), errors: [], complete: true };
      }
    }
  };
  return { connector, accountId: `${id}-account`, scopes: scopes[id] || [], writes, records, removals };
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
  const targetId = id === 'notion' ? parent : id === 'apple_reminders' ? reminderListId(connection.connector.folders[0]) : id === 'apple_notes' ? 'notes-folder' : 'drafts';
  const grant = await runtime.artifacts.createGrant({ connectorId: id, targetId }, { confirmed: true });
  return { directory, store, engine, runtime, connection, grant, taskId };
}
function request(context) {
  const task = context.runtime.tasks.get(context.taskId);
  return context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id,
    ...(context.grant.family === 'email.draft' ? {} : { title: 'Cedar 工作进展', body: 'Project findings\nA source-backed summary.' }) }, { actor: 'user', reviewToken: draftReviewToken(task) });
}

for (const id of ['google', 'microsoft', 'notion', 'apple_notes', 'apple_reminders']) {
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
  assert.equal(new ArtifactProvider(connectionFor('apple_reminders'), 'unselected-list').available(), false);
  for (const id of ['google', 'microsoft']) {
    const connection = connectionFor(id); connection.scopes = [];
    assert.equal(new ArtifactProvider(connection, 'drafts').available(), false);
  }
});

test('a changed or completed reminder is not verified as the original creation', async () => {
  const connection = connectionFor('apple_reminders');
  const provider = new ArtifactProvider(connection, reminderListId(connection.connector.folders[0]));
  const payload = { title: 'Call Cedar', body: 'Discuss next steps', idempotencyKey: 'one-operation' };
  const receipt = await provider.create(payload, { beforeDispatch() {} });
  assert.equal((await provider.lookup(payload.idempotencyKey, { receiptId: receipt.id, payload })).status, 'found');
  connection.records.get(receipt.id).body = 'Changed by the user';
  assert.equal((await provider.lookup(payload.idempotencyKey, { receiptId: receipt.id, payload })).status, 'unknown');
});

test('Reminders artifact destinations distinguish equal list IDs in different accounts', async () => {
  const connection = connectionFor('apple_reminders');
  connection.connector.folders.push({ accountId: 'other-account', folderId: 'notes-folder', label: 'Other Work' });
  const provider = new ArtifactProvider(connection, reminderListId(connection.connector.folders[1]));
  await provider.create({ title: 'Follow up', body: 'Check the result', idempotencyKey: 'second-account' }, { beforeDispatch() {} });
  assert.equal(connection.writes[0].folder.accountId, 'other-account');
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

test('native Reminders script creates only in the chosen account and list, preserving text as data', () => {
  const written = [];
  const list = { id: () => 'list', name: () => 'Work', reminders: { push: item => written.push(item) } };
  const account = { id: () => 'account', name: () => 'Personal', lists: () => [list] };
  const reminders = { accounts: () => [account], Reminder: content => ({ ...content, id: () => 'reminder-id' }) };
  const application = name => { assert.equal(name, 'Reminders'); return reminders; };
  application.currentApplication = () => ({});
  const sandbox = vm.createContext({ ObjC: { import: () => {} }, Application: application });
  vm.runInContext(fs.readFileSync(new URL('../src/native-source-script.jxa.js', import.meta.url), 'utf8'), sandbox);
  const input = { folder: { accountId: 'account', folderId: 'list' }, title: 'Call <Cedar>', body: 'Review\n<script>text</script>', marker: `unprompted-artifact:${'a'.repeat(64)}` };
  sandbox.inputJSON = () => input;
  const result = JSON.parse(sandbox.run(['create-reminder']));
  assert.equal(result.ok, true); assert.equal(result.id, 'reminder-id');
  assert.equal(written.length, 1); assert.equal(written[0].name, input.title);
  assert.equal(written[0].body, `${input.body}\n${input.marker}`);
  input.folder.accountId = 'different-account';
  assert.equal(JSON.parse(sandbox.run(['create-reminder'])).ok, false);
  assert.equal(written.length, 1);
});

test('native Reminders changes and deletion check the chosen list and exact last modification', () => {
  let deleted = false;
  const reminder = { id: () => 'reminder-id', modificationDate: () => new Date('2026-01-01T00:00:00.000Z'), delete() { deleted = true; } };
  const list = { id: () => 'list', name: () => 'Work', reminders: () => [reminder] };
  const account = { id: () => 'account', name: () => 'Personal', lists: () => [list] };
  const application = name => { assert.equal(name, 'Reminders'); return { accounts: () => [account] }; };
  application.currentApplication = () => ({});
  const sandbox = vm.createContext({ ObjC: { import: () => {} }, Application: application });
  vm.runInContext(fs.readFileSync(new URL('../src/native-source-script.jxa.js', import.meta.url), 'utf8'), sandbox);
  const input = { folder: { accountId: 'account', folderId: 'list' }, reminderId: 'reminder-id', expectedUpdatedAt: '2025-01-01T00:00:00.000Z', changes: { completed: true } };
  sandbox.inputJSON = () => input;
  assert.equal(JSON.parse(sandbox.run(['change-reminder'])).ok, false);
  assert.equal(reminder.completed, undefined);
  input.expectedUpdatedAt = '2026-01-01T00:00:00.000Z';
  assert.equal(JSON.parse(sandbox.run(['change-reminder'])).ok, true);
  assert.equal(reminder.completed, true);
  input.folder.folderId = 'other-list';
  assert.equal(JSON.parse(sandbox.run(['delete-reminder'])).ok, false); assert.equal(deleted, false);
  input.folder.folderId = 'list';
  assert.equal(JSON.parse(sandbox.run(['delete-reminder'])).ok, true); assert.equal(deleted, true);
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

for (const id of ['google', 'microsoft', 'notion']) {
  test(`${id} undo removes an unchanged artifact, confirms the removal and records undo feedback`, async t => {
    const context = await fixture(t, id);
    request(context); await context.engine.whenSettled();
    const created = context.runtime.tasks.get(context.taskId).artifactRequests[0];
    assert.equal(created.status, 'verified');
    await assert.rejects(context.runtime.artifacts.undo(context.taskId, created.id, { actor: 'activation' }), error => error.code === 'UNDO_NOT_AUTHORIZED');
    const undone = await context.runtime.artifacts.undo(context.taskId, created.id);
    assert.equal(undone.status, 'undone');
    assert.equal(undone.undo.status, 'verified');
    assert.equal(context.connection.removals.length, 1);
    assert.equal(context.runtime.db.prepare("SELECT COUNT(*) n FROM feedback_events WHERE kind='undo'").get().n, 1);
    assert.equal((await context.runtime.artifacts.undo(context.taskId, created.id)).status, 'undone', 'a repeated undo is a no-op');
    assert.equal(context.connection.removals.length, 1);
    const lifecycle = context.runtime.artifactLifecycle(context.taskId);
    assert.equal(lifecycle.published[0].status, 'undone');
    assert.equal(lifecycle.published[0].reversibility.kind, 'reversible');
  });
}

test('undo leaves an artifact the user changed and refuses targets without automatic removal', async t => {
  const context = await fixture(t, 'microsoft');
  request(context); await context.engine.whenSettled();
  const created = context.runtime.tasks.get(context.taskId).artifactRequests[0];
  const [remoteId, record] = [...context.connection.records][0];
  context.connection.records.set(remoteId, { ...record, subject: 'Edited by the user' });
  await assert.rejects(context.runtime.artifacts.undo(context.taskId, created.id), error => error.code === 'UNDO_CHANGED');
  assert.equal(context.connection.removals.length, 0, 'an edited draft is never removed');
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests[0].undo.status, 'refused');

  const notes = await fixture(t, 'apple_notes');
  request(notes); await notes.engine.whenSettled();
  const note = notes.runtime.tasks.get(notes.taskId).artifactRequests[0];
  await assert.rejects(notes.runtime.artifacts.undo(notes.taskId, note.id), error => error.code === 'UNDO_UNSUPPORTED');
});

test('mail drafts accept a display name and reject header injection', async t => {
  for (const [id, recipient, header] of [
    ['google', 'Alex <alex@example.com>', /^To: Alex <alex@example.com>/m],
    ['google', '"Alex Chen" <alex@example.com>', /^To: Alex Chen <alex@example.com>/m],
    ['google', 'Ann; <alex@example.com>', /^To: "Ann;" <alex@example.com>/m],
    ['google', '=?UTF-8?B?hi?= <alex@example.com>', /^To: =\?UTF-8\?B\?/m],
    ['google', '陈 <alex@example.com>', null],
    ['microsoft', 'Ann: Bob <alex@example.com>', null],
    ['microsoft', '陈 <alex@example.com>', null]
  ]) {
    const context = await fixture(t, id);
    context.store.mutate(state => { state.tasks[context.taskId].draft.to = recipient; });
    const task = context.runtime.tasks.get(context.taskId);
    context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id }, { actor: 'user', reviewToken: draftReviewToken(task) });
    await context.engine.whenSettled();
    const artifact = context.runtime.tasks.get(context.taskId).artifactRequests[0];
    assert.equal(artifact.status, 'verified', `${id} ${recipient}`);
    if (id === 'google') {
      const raw = Buffer.from(context.connection.writes.at(-1).body.message.raw, 'base64url').toString('utf8');
      if (header) assert.match(raw, header);
      else assert.match(raw, /=\?UTF-8\?B\?/);
      assert.doesNotMatch(raw, /\r\nBcc:/);
    } else {
      const posted = context.connection.writes.at(-1).body.toRecipients[0].emailAddress;
      assert.equal(posted.address, 'alex@example.com');
      assert.equal(posted.name, parseMailbox(recipient).displayName);
    }
  }
  const context = await fixture(t, 'google');
  const provider = new ArtifactProvider(context.connection, 'drafts');
  await assert.rejects(provider.create({ title: 'Cedar', body: 'Hello', to: 'Alex <alex@example.com>\r\nBcc: evil@example.com', idempotencyKey: 'inject' }, { beforeDispatch() {} }), /Invalid draft recipient/);
  await assert.rejects(provider.create({ title: 'Cedar\nBcc: evil@example.com', body: 'Hello', to: 'alex@example.com', idempotencyKey: 'inject-subject' }, { beforeDispatch() {} }), /Invalid draft recipient/);
  assert.equal(context.connection.writes.length, 0);
});

test('a new destination grant does not cancel a queued non-mail artifact', async t => {
  const context = await fixture(t, 'notion');
  let releaseToken;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let paused = false;
  const originalToken = context.connection.connector.auth.accessToken;
  context.connection.connector.auth.accessToken = async () => {
    if (!paused) { paused = true; markStarted(); await new Promise(resolve => { releaseToken = resolve; }); }
    return originalToken();
  };
  const task = context.runtime.tasks.get(context.taskId);
  context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id, title: 'Cedar notes', body: 'A source-backed page.' }, { actor: 'user', reviewToken: draftReviewToken(task) });
  await started;
  const version = Number(context.runtime.database.get('context_version'));
  await context.runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent, project: 'Cedar' }, { confirmed: true });
  assert.equal(Number(context.runtime.database.get('context_version')), version + 1);
  releaseToken();
  await context.engine.whenSettled();
  const requests = context.runtime.tasks.get(context.taskId).artifactRequests;
  assert.equal(requests.some(item => item.status === 'verified'), true, JSON.stringify(requests));
  assert.equal(context.connection.writes.length, 1);
});

test('a changed reply is not retried as an approved draft', async t => {
  const context = await fixture(t, 'google');
  let releaseToken;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let paused = false;
  const originalToken = context.connection.connector.auth.accessToken;
  context.connection.connector.auth.accessToken = async () => {
    if (!paused) { paused = true; markStarted(); await new Promise(resolve => { releaseToken = resolve; }); }
    return originalToken();
  };
  const task = context.runtime.tasks.get(context.taskId);
  const approved = task.draft.body;
  context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id }, { actor: 'user', reviewToken: draftReviewToken(task) });
  await started;
  context.store.mutate(state => { state.tasks[context.taskId].draft.body = `${approved}\nUnapproved edit`; });
  await context.runtime.artifacts.createGrant({ connectorId: 'google', targetId: 'drafts', project: 'Cedar' }, { confirmed: true });
  releaseToken();
  await context.engine.whenSettled();
  const requests = context.runtime.tasks.get(context.taskId).artifactRequests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'blocked');
  assert.match(requests[0].error, /Review it before trying again/);
  assert.equal(context.connection.writes.length, 0);
});

test('a context retry happens once and does not chain', async t => {
  const context = await fixture(t, 'notion');
  let releaseFirst;
  let releaseSecond;
  let markStarted;
  let markSecond;
  const started = new Promise(resolve => { markStarted = resolve; });
  const second = new Promise(resolve => { markSecond = resolve; });
  let phase = 'first';
  const originalToken = context.connection.connector.auth.accessToken;
  context.connection.connector.auth.accessToken = async () => {
    if (phase === 'first') { phase = 'between'; markStarted(); await new Promise(resolve => { releaseFirst = resolve; }); phase = 'retry'; }
    else if (phase === 'retry') { phase = 'second-wait'; markSecond(); await new Promise(resolve => { releaseSecond = resolve; }); phase = 'done'; }
    return originalToken();
  };
  const task = context.runtime.tasks.get(context.taskId);
  context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id, title: 'Cedar notes', body: 'A source-backed page.' }, { actor: 'user', reviewToken: draftReviewToken(task) });
  await started;
  await context.runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent, project: 'Cedar' }, { confirmed: true });
  releaseFirst();
  await second;
  await context.runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent, project: 'Other' }, { confirmed: true });
  releaseSecond();
  await context.engine.whenSettled();
  const requests = context.runtime.tasks.get(context.taskId).artifactRequests;
  assert.equal(requests.length, 2);
  assert.equal(requests.every(item => item.status === 'blocked'), true, JSON.stringify(requests));
  assert.equal(context.connection.writes.length, 0);
});

test('an automatic draft retry stays non-explicit', async t => {
  const context = await fixture(t, 'google');
  const approvals = [];
  const authorize = context.engine.policy.authorize.bind(context.engine.policy);
  context.engine.policy.authorize = input => {
    if (input.actionClass === 'execute_external') approvals.push(input.approval?.permission);
    return authorize(input);
  };
  let releaseToken;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let paused = false;
  const originalToken = context.connection.connector.auth.accessToken;
  context.connection.connector.auth.accessToken = async () => {
    if (!paused) { paused = true; markStarted(); await new Promise(resolve => { releaseToken = resolve; }); }
    return originalToken();
  };
  context.runtime.artifacts.schedulePrepared(context.runtime.tasks.get(context.taskId));
  await started;
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests[0].explicit, false);
  await context.runtime.artifacts.createGrant({ connectorId: 'google', targetId: 'drafts', project: 'Cedar' }, { confirmed: true });
  releaseToken();
  await context.engine.whenSettled();
  const requests = context.runtime.tasks.get(context.taskId).artifactRequests;
  assert.equal(requests.length, 2, JSON.stringify(requests));
  assert.equal(requests[0].status, 'blocked');
  assert.equal(requests[1].explicit, false);
  assert.equal(requests[1].status, 'verified');
  assert.deepEqual([...new Set(approvals)], ['pre_authorized']);
  assert.equal(context.connection.writes.length, 1);
});

test('a changed review token blocks a non-mail retry', async t => {
  const context = await fixture(t, 'notion');
  let releaseToken;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let paused = false;
  const originalToken = context.connection.connector.auth.accessToken;
  context.connection.connector.auth.accessToken = async () => {
    if (!paused) { paused = true; markStarted(); await new Promise(resolve => { releaseToken = resolve; }); }
    return originalToken();
  };
  const task = context.runtime.tasks.get(context.taskId);
  const approved = draftReviewToken(task);
  context.runtime.artifacts.request(context.taskId, { grantId: context.grant.id, title: 'Cedar notes', body: 'A source-backed page.' }, { actor: 'user', reviewToken: approved });
  await started;
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests[0].reviewToken, approved);
  context.store.mutate(state => { state.tasks[context.taskId].draft.body = `${state.tasks[context.taskId].draft.body}\nUnreviewed edit`; });
  await context.runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent, project: 'Cedar' }, { confirmed: true });
  releaseToken();
  await context.engine.whenSettled();
  const requests = context.runtime.tasks.get(context.taskId).artifactRequests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'blocked');
  assert.equal(requests[0].reviewToken, approved);
  assert.match(requests[0].error, /Review it before trying again/);
  assert.equal(context.connection.writes.length, 0);
});

test('a permission refresh retries a draft that was cancelled before dispatch', async t => {
  const context = await fixture(t, 'google');
  context.runtime.artifacts.schedulePrepared(context.runtime.tasks.get(context.taskId));
  await context.engine.whenSettled();
  const task = context.runtime.tasks.get(context.taskId);
  assert.equal(task.artifactRequests[0].status, 'verified');
  context.store.mutate(state => { state.tasks[context.taskId].artifactRequests[0].status = 'blocked'; });
  context.store.db.prepare("UPDATE tool_executions SET status='cancelled', last_error_class='confirmed_no_effect' WHERE idempotency_key=?").run(task.artifactRequests[0].key);
  context.runtime.artifacts.schedulePrepared(context.runtime.tasks.get(context.taskId));
  assert.equal(context.runtime.tasks.get(context.taskId).artifactRequests.length, 1, 'an ordinary reassessment does not repeat a blocked draft');
  context.runtime.artifacts.schedulePrepared(context.runtime.tasks.get(context.taskId), { retryInterrupted: true });
  await context.engine.whenSettled();
  const requests = context.runtime.tasks.get(context.taskId).artifactRequests;
  assert.equal(requests.length, 2);
  assert.equal(requests[1].status, 'verified');
});
