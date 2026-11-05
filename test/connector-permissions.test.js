import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connector } from '../src/connectors/connector.js';
import { AppleRemindersConnector } from '../src/connectors/apple-reminders.js';
import { platformRequest } from '../src/connectors/platform-api.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { OpenAiCompatibleReasoner, PiReasoner } from '../src/reasoning.js';
import { piSupported } from '../src/pi-runtime.js';
import { PermissionPolicy } from '../src/permissions.js';
import { fitToolCatalog } from '../src/tool-catalog.js';
import { oauthScopes, withOAuthScopes } from '../src/oauth-scopes.js';
const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
function connector(fetchImpl) {
  const c = new Connector({ id: 'github', kind: 'code', fetchImpl });
  c.live = true; c.account = { id: 'account-1' }; c.auth = { accessToken: async () => 'private-token' }; return c;
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-permissions-'));
  const store = new SqliteStore(path.join(dir, 'state.json'));
  const writes = []; let record = { id: 42, title: 'Before' };
  const c = connector(async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer private-token');
    assert.equal(options.redirect, 'error');
    if (options.method !== 'GET') { writes.push(options); record = { ...record, ...JSON.parse(options.body || '{}') }; }
    return response(record);
  });
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: false }) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => id === c.id ? c : null });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  engine.ingest({ id: 'email:m1', type: 'email.received', payload: { id: 'm1', threadId: 't1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
  await engine.whenSettled();
  const taskId = 'request:m1'; assert.ok(runtime.tasks.get(taskId));
  return { runtime, engine, store, c, writes, taskId };
}
const input = context => ({ connectorId: 'github', request: { method: 'PATCH', path: '/repos/owner/repo/issues/42', body: { title: 'After' } }, confirmed: true, inputVersion: context.runtime.tasks.get(context.taskId).inputVersion });

test('Reminders changes and deletion need selected-list grants, a current revision and verified readback', async t => {
  const context = await fixture(t);
  const folder = { accountId: 'account', folderId: 'list', label: 'Work' };
  let item = { id: 'x-apple-reminder://fixture', accountId: folder.accountId, folderId: folder.folderId, title: 'Call Cedar', body: 'Discuss next steps', state: 'open', updatedAt: '2026-01-01T00:00:00.000Z' };
  let writes = 0;
  const bridge = { platform: 'darwin', async readReminders() { return { records: item ? [item] : [], complete: true, errors: [] }; },
    async changeReminder(_folder, id, changes, expected) {
      assert.equal(id, item.id); assert.equal(expected, item.updatedAt); writes++;
      item = { ...item, state: changes.completed ? 'closed' : 'open', updatedAt: '2026-01-01T00:00:01.000Z' };
    },
    async deleteReminder(_folder, id, expected) { assert.equal(id, item.id); assert.equal(expected, item.updatedAt); writes++; item = null; } };
  const reminder = new AppleRemindersConnector({ scopeId: 'scope', folders: [folder], bridge });
  context.runtime.connectorFor = id => id === reminder.id ? reminder : null;
  const listId = (await reminder.requestApi({ path: '/lists' })).body.lists[0].id;
  const listPath = `/lists/${listId}/reminders`;
  const record = (await reminder.requestApi({ path: listPath })).body.reminders[0];
  const itemPath = `${listPath}/${record.id}`;
  const change = { connectorId: 'apple_reminders', request: { method: 'PATCH', path: itemPath, body: { expectedUpdatedAt: record.updatedAt, completed: true } },
    verification: { request: { path: itemPath }, matches: [{ pointer: '/completed', value: true }] }, confirmed: true, inputVersion: context.runtime.tasks.get(context.taskId).inputVersion };
  await assert.rejects(context.runtime.connectorActions.request(context.taskId, change, { actor: 'user' }), /Allow actions/);
  context.runtime.connectorActions.createGrant({ connectorId: 'apple_reminders', methods: ['PATCH'], pathPrefix: `/lists/${listId}`, confirmed: true });
  const result = await context.runtime.connectorActions.request(context.taskId, change, { actor: 'user' });
  assert.equal(result.state, 'verified'); assert.equal(writes, 1);
  assert.equal((await context.runtime.connectorActions.request(context.taskId, change, { actor: 'user' })).alreadyDispatched, true);
  const remove = { ...change, request: { method: 'DELETE', path: itemPath, body: { expectedUpdatedAt: item.updatedAt } }, verification: { request: { path: itemPath }, status: 404 } };
  await assert.rejects(context.runtime.connectorActions.request(context.taskId, remove, { actor: 'user' }), /Allow actions/);
  context.runtime.connectorActions.createGrant({ connectorId: 'apple_reminders', methods: ['DELETE'], pathPrefix: `/lists/${listId}`, confirmed: true });
  assert.equal((await context.runtime.connectorActions.request(context.taskId, remove, { actor: 'user' })).state, 'verified');
  assert.equal(writes, 2); assert.equal(item, null);
});

test('API transport accepts all methods, official Google origins, forms and binary bodies without exposing credentials', async () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(platformRequest('github', { method, path: '/repos/x/y/issues' }).method, method);
  assert.equal(platformRequest('google', { origin: 'https://calendar.googleapis.com', path: '/calendar/v3/calendars/primary/events', method: 'POST', body: {} }).write, true);
  assert.equal(platformRequest('slack', { path: '/api/chat.postMessage' }).write, true);
  assert.equal(platformRequest('slack', { path: '/api/conversations.history' }).write, false);
  const c = connector(async (_url, options) => { assert.equal(options.body, 'title=Hello+world'); return new Response('hello'); });
  assert.equal((await c.requestApi({ method: 'POST', path: '/x', bodyEncoding: 'form', body: { title: 'Hello world' }, responseType: 'text' })).body, 'hello');
  const binary = platformRequest('github', { path: '/x', method: 'PUT', bodyEncoding: 'base64', body: 'AQI=' });
  assert.deepEqual([...binary.body], [1, 2]);
});

test('API transport rejects credential replacement, foreign hosts and redirect paths', () => {
  for (const request of [{ origin: 'https://evil.test', path: '/' }, { path: '//evil.test' }, { path: '/x', headers: { Authorization: 'secret' } }, { path: '/x', headers: { cookie: 'secret' } }, { path: '/x', headers: { Host: 'evil.test' } }, { path: '/x', body: {} }]) assert.throws(() => platformRequest('github', request));
  for (const origin of ['https://googleapis.com.evil.test', 'https://www.googleapis.com:9443', 'http://www.googleapis.com']) assert.throws(() => platformRequest('google', { origin, path: '/' }));
  assert.throws(() => platformRequest('notion', { path: '/v1/../outside' }));
});

test('provider rejection is definitive and dispatched writes are never retried by the transport', async () => {
  let calls = 0; const c = connector(async () => { calls++; return response({}, 403); });
  await assert.rejects(c.requestApi({ method: 'DELETE', path: '/repos/x/y' }), error => error.status === 403 && error.definitiveNoEffect);
  assert.equal(calls, 1);
  c.fetchImpl = async () => { calls++; throw new Error('connection lost'); };
  await assert.rejects(c.requestApi({ method: 'POST', path: '/repos/x/y/issues', body: {} }), /connection lost/);
  assert.equal(calls, 2);
});

test('late token refresh cannot dispatch after account revocation', async () => {
  let dispatches = 0;
  const c = connector(async () => { dispatches++; return response({}); });
  c.auth.accessToken = async () => { c.auth.disabled = true; return 'token'; };
  await assert.rejects(c.requestApi({ method: 'POST', path: '/x' }), /disconnected/);
  assert.equal(dispatches, 0);
});

test('encoded slashes and dots cannot widen a platform path prefix', async t => {
  assert.throws(() => platformRequest('github', { method: 'PATCH', path: '/repos/owner/repo%2Fadmin' }), /Encoded slashes or dots/);
  assert.throws(() => platformRequest('github', { method: 'GET', path: '/repos/owner/%2e%2E/other' }), /Encoded slashes or dots/);
  const context = await fixture(t);
  context.runtime.connectorActions.createGrant({ connectorId: 'github', pathPrefix: '/repos/owner', methods: ['PATCH'], confirmed: true });
  const grant = context.runtime.connectorActions.grants().find(item => item.pathPrefix === '/repos/owner');
  const task = context.runtime.tasks.get(context.taskId);
  assert.equal(context.runtime.connectorActions.covers(grant, task, { path: '/repos/owner/repo%2Fadmin', method: 'PATCH', connectorId: 'github' }, 'account-1'), false);
  assert.equal(context.runtime.connectorActions.covers(grant, task, { path: '/repos/owner/repo/issues/42', method: 'PATCH', connectorId: 'github' }, 'account-1'), true);
});

test('OAuth supports arbitrary platform scopes while rejecting malformed scope injection', () => {
  assert.deepEqual(withOAuthScopes(['read'], 'write admin write'), ['read', 'write', 'admin']);
  assert.deepEqual(oauthScopes('Mail.Send,Mail.ReadWrite'), ['Mail.Send', 'Mail.ReadWrite']);
  assert.throws(() => oauthScopes(['write\nread']));
});

test('native API writes require a user grant, independently verify and deduplicate through SQLite ledger', async t => {
  const c = await fixture(t), action = input(c);
  await assert.rejects(c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' }), /Allow actions/);
  assert.equal(c.writes.length, 0);
  c.runtime.connectorActions.createGrant({ connectorId: 'github', pathPrefix: '/repos/owner/repo', methods: ['PATCH'], confirmed: true });
  action.verification = { request: { path: '/repos/owner/repo/issues/42' }, matches: [{ pointer: '/title', value: 'After' }] };
  const result = await c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' });
  assert.equal(result.state, 'verified', JSON.stringify(result));
  assert.equal(c.writes.length, 1);
  const again = await c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' });
  assert.equal(again.alreadyDispatched, true); assert.equal(c.writes.length, 1);
  assert.notEqual(c.runtime.tasks.get(c.taskId).status, 'completed');
});

test('API acceptance remains accepted without readback; scope and revocation are enforced', async t => {
  const c = await fixture(t), action = input(c);
  const grant = c.runtime.connectorActions.createGrant({ connectorId: 'github', pathPrefix: '/repos/owner/repo', methods: ['PATCH'], confirmed: true });
  await assert.rejects(c.runtime.connectorActions.request(c.taskId, { ...action, request: { ...action.request, path: '/repos/owner/repo-other/issues/42' } }, { actor: 'user' }), /Allow actions/);
  const result = await c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' });
  assert.equal(result.state, 'accepted'); assert.equal(result.verified, false);
  c.runtime.connectorActions.revoke(grant.id);
  await assert.rejects(c.runtime.connectorActions.request(c.taskId, { ...action, operationId: 'new' }, { actor: 'user' }), /Allow actions/);
  assert.equal(c.writes.length, 1);
});

test('a grant revoked during asynchronous authentication blocks dispatch', async t => {
  const c = await fixture(t), action = input(c);
  const grant = c.runtime.connectorActions.createGrant({ connectorId: 'github', confirmed: true });
  c.c.auth.accessToken = async () => { c.runtime.connectorActions.revoke(grant.id); return 'private-token'; };
  await assert.rejects(c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' }), /revoked|authorization|permission|checkpoint/i);
  assert.equal(c.writes.length, 0);
});

test('ambiguous write outcome persists and the same operation cannot dispatch twice', async t => {
  const c = await fixture(t), action = input(c); let calls = 0;
  c.runtime.connectorActions.createGrant({ connectorId: 'github', confirmed: true });
  c.c.fetchImpl = async () => { calls++; throw new Error('lost after remote acceptance'); };
  await assert.rejects(c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' }), /lost after remote acceptance/);
  const retry = await c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' });
  assert.equal(retry.state, 'unknown'); assert.equal(retry.alreadyDispatched, true); assert.equal(calls, 1);
});

test('MCP actions use the execution ledger, deduplicate and cannot outlive their user permission', async t => {
  const c = await fixture(t); let calls = 0, allowed = true;
  const action = { taskId: c.taskId, serverId: 'fixture', tool: 'write_item', args: { title: 'After' }, isCurrent: () => true, check: () => allowed,
    invoke: async () => { calls++; return { content: [{ type: 'text', text: 'accepted' }] }; } };
  const result = await c.runtime.connectorActions.mcpWrite(action);
  assert.equal(result.state, 'accepted'); assert.equal(calls, 1);
  assert.equal((await c.runtime.connectorActions.mcpWrite(action)).alreadyDispatched, true); assert.equal(calls, 1);
  allowed = false;
  await assert.rejects(c.runtime.connectorActions.mcpWrite({ ...action, args: { title: 'Different' } }), /authorized/);
  assert.equal(calls, 1);
});

test('the live task tool catalog retains platform API capability alongside memory and source tools', async t => {
  const c = await fixture(t);
  const catalog = fitToolCatalog(c.runtime.tools({ taskId: c.taskId, isCurrent: () => true }));
  assert.ok(catalog.tools.some(tool => tool.name === 'platform_api'));
  assert.ok(catalog.tools.some(tool => tool.name === 'read_task_source'));
});

test('concurrent duplicate requests retain the first dispatch guard and send once', async t => {
  const c = await fixture(t), action = input(c);
  c.runtime.connectorActions.createGrant({ connectorId: 'github', confirmed: true });
  const results = await Promise.all([c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' }), c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' })]);
  assert.equal(c.writes.length, 1); assert.ok(results.some(result => result.state === 'accepted'));
  assert.ok(results.some(result => result.alreadyDispatched));
});

for (const harness of ['standard', 'pi']) {
  test(`${harness} harness executes an authorized platform update through its actual model loop`, { skip: harness === 'pi' && !piSupported() }, async t => {
    const c = await fixture(t); c.runtime.connectorActions.createGrant({ connectorId: 'github', confirmed: true });
    const args = { connectorId: 'github', request: input(c).request, verification: { request: { path: '/repos/owner/repo/issues/42' }, matches: [{ pointer: '/title', value: 'After' }] } };
    let calls = 0, reasoner;
    const answer = { nextStep: 'The provider update was verified.', probes: [] };
    if (harness === 'standard') {
      reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://model.invalid/v1', model: 'fixture', fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); calls++;
        if (calls === 1) { assert.ok(body.tools.some(tool => tool.function.name === 'platform_api')); return response({ choices: [{ message: { content: null, tool_calls: [{ id: 'update-1', type: 'function', function: { name: 'platform_api', arguments: JSON.stringify(args) } }] } }] }); }
        assert.equal(JSON.parse(body.messages.find(message => message.role === 'tool').content).state, 'verified');
        return response({ choices: [{ message: { content: JSON.stringify(answer) } }] });
      } });
    } else {
      const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
      reasoner = new PiReasoner({ baseUrl: 'https://model.invalid/v1', model: 'fixture', runtimeOptions: { streamFn: async (model, context) => {
        calls++; if (calls > 1) assert.match(JSON.stringify(context.messages.find(message => message.role === 'toolResult').content), /verified/);
        const content = calls === 1 ? [{ type: 'toolCall', id: 'update-1', name: 'platform_api', arguments: args }] : [{ type: 'text', text: JSON.stringify(answer) }];
        const stream = createAssistantMessageEventStream(), message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: calls === 1 ? 'toolUse' : 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
      } } });
    }
    c.engine.reasoner = reasoner;
    c.engine.externalTools = scope => c.runtime.wrapReadTools(c.runtime.tools(scope), scope.taskId);
    c.runtime.scheduleTask(c.taskId, `platform-${harness}`); c.runtime.kick(); await c.engine.whenSettled();
    assert.equal(calls, 2, JSON.stringify({ error: reasoner.lastError, task: c.runtime.tasks.get(c.taskId).reasoningWork }));
    assert.equal(c.writes.length, 1);
    assert.ok(c.runtime.ledger.list().some(item => item.action_family === 'connector.request' && item.status === 'verified'));
    assert.notEqual(c.runtime.tasks.get(c.taskId).status, 'completed');
  });
}

test('missing provider fields never satisfy an expected null readback assertion', async t => {
  const c = await fixture(t), action = input(c);
  c.runtime.connectorActions.createGrant({ connectorId: 'github', confirmed: true });
  action.verification = { request: { path: '/repos/owner/repo/issues/42' }, matches: [{ pointer: '/missing', value: null }] };
  try { const result = await c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' }); assert.notEqual(result.state, 'verified'); }
  catch { assert.ok(c.runtime.ledger.list().every(item => item.status !== 'verified')); }
  assert.equal(c.writes.length, 1);
});

test('JSON property order cannot bypass duplicate action detection', async t => {
  const c = await fixture(t), action = input(c); c.runtime.connectorActions.createGrant({ connectorId: 'github', confirmed: true });
  await c.runtime.connectorActions.request(c.taskId, action, { actor: 'user' });
  const result = await c.runtime.connectorActions.request(c.taskId, { ...action, request: { body: action.request.body, path: action.request.path, method: action.request.method } }, { actor: 'user' });
  assert.equal(result.alreadyDispatched, true); assert.equal(c.writes.length, 1);
});
