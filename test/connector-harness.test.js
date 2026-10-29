import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { OpenAiCompatibleReasoner, PiReasoner } from '../src/reasoning.js';
import { piSupported } from '../src/pi-runtime.js';
import { GoogleWorkspaceConnector } from '../src/connectors/google.js';
import { GitHubConnector } from '../src/connectors/github.js';
import { OutlookConnector } from '../src/connectors/outlook.js';
import { SlackConnector } from '../src/connectors/slack.js';
import { NotionConnector } from '../src/connectors/notion.js';
import { LocalFilesConnector } from '../src/connectors/local-files.js';
import { AppleNotesConnector } from '../src/connectors/apple-notes.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore } from '../src/connectors/connector.js';
import { bindConnectionAccount } from '../src/external-work.js';

const at = '2026-10-28T09:00:00.000Z';
const now = () => Date.parse(at);
const parent = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const pageId = 'cccccccc-1111-2222-3333-dddddddddddd';
const detail = 'Evidence detail: keep the monitored Cedar rollout at ten percent.';
const content = `# Cedar project proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.\n${detail}\n`;
const requestBody = 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.';
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const auth = { configured: () => true, accessToken: async () => 'PRIVATE_FIXTURE_TOKEN', headers: async () => ({ authorization: 'Bearer PRIVATE_FIXTURE_TOKEN' }) };
const sources = ['google', 'microsoft', 'slack', 'notion', 'local_files', 'apple_notes', 'github', 'github_review', 'github_change', 'github_check'];

function notionFixture() {
  const written = new Map();
  const connector = new NotionConnector({ auth, account: { id: 'notion-account', label: 'Cedar notes' }, now, fetchImpl: async (url, options) => {
    const target = new URL(url);
    if (target.pathname === '/v1/search') return response({ results: [{ object: 'page', id: pageId, last_edited_time: at,
      properties: { title: { type: 'title', title: [{ plain_text: 'Cedar project proposal' }] } } }], has_more: false });
    if (target.pathname === `/v1/blocks/${pageId}/children`) return response({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: content }] } }], has_more: false });
    if (target.pathname === '/v1/pages' && options.method === 'POST') {
      const id = `bbbbbbbb-1111-2222-3333-${String(written.size + 1).padStart(12, '0')}`;
      written.set(id, JSON.parse(options.body)); return response({ id });
    }
    const id = target.pathname.split('/').at(-1);
    if (target.pathname.endsWith('/children')) return response({ results: written.get(target.pathname.split('/').at(-2)).children, has_more: false });
    return response({ object: 'page', id, ...(written.get(id) || {}) });
  } });
  return { connector, accountId: 'notion-account', scopes: [], written };
}

function googleFixture({ drive = true } = {}) {
  return new GoogleWorkspaceConnector({ auth, config: { accountEmail: 'reader@example.test', shadow: true, readGmail: true, readDrive: drive, maxRetries: 0 }, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname.endsWith('/profile')) return response({ historyId: '100', emailAddress: 'reader@example.test' });
    if (target.pathname.endsWith('/messages')) return response({ messages: [{ id: 'mail-1' }] });
    if (target.pathname.endsWith('/messages/mail-1')) return response({ id: 'mail-1', threadId: 'thread-1', payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'alex@example.test' }, { name: 'To', value: 'reader@example.test' }, { name: 'Subject', value: 'Cedar proposal' }, { name: 'Date', value: at }
    ], body: { data: Buffer.from(requestBody).toString('base64url') } } });
    if (target.pathname.endsWith('/changes/startPageToken')) return response({ startPageToken: 'drive-1' });
    if (target.pathname.endsWith('/drive/v3/files')) return response({ files: [{ id: 'cedar-doc', name: 'Cedar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: at, version: '1' }] });
    if (target.pathname.endsWith('/files/cedar-doc/export')) return new Response(content);
    throw new Error(`Unexpected Google fixture path: ${target.pathname}`);
  } });
}

function githubFixture(kind) {
  const sha = 'a'.repeat(40), repository = 'team/cedar';
  return new GitHubConnector({ auth, account: { id: '123', login: 'reader' }, now, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname === '/issues') return response(kind === 'github' ? [{ id: 15, number: 7, title: 'Review Cedar rollout', body: detail,
      user: { login: 'teammate' }, assignees: [{ id: 123, login: 'reader' }], state: 'open', updated_at: at, repository: { full_name: repository } }] : []);
    if (target.pathname === '/search/issues') return response({ items: kind === 'github_review' && target.searchParams.get('q').includes('review-requested:')
      ? [{ id: 90, number: 3, title: 'Review Cedar rollout', body: detail, state: 'open', updated_at: at, user: { login: 'author' }, repository_url: `https://api.github.com/repos/${repository}` }] : [] });
    if (target.pathname === '/user/repos') return response(['github_change', 'github_check'].includes(kind) ? [{ full_name: repository, default_branch: 'main', pushed_at: at }] : []);
    if (target.pathname.endsWith('/commits')) return response(kind === 'github_change' ? [{ sha, commit: { message: detail, author: { date: at } }, author: { login: 'author' } }] : []);
    if (target.pathname.endsWith(`/commits/${sha}`)) return response({ sha, commit: { message: detail, author: { date: at } }, author: { login: 'author' }, files: [{ filename: 'src/cedar.js' }] });
    if (target.pathname.endsWith('/actions/runs')) return response({ workflow_runs: kind === 'github_check' ? [{ id: 55, name: 'Cedar rollout', status: 'completed', conclusion: 'failure', updated_at: at, head_branch: 'main', event: 'push', triggering_actor: { login: 'author' } }] : [] });
    throw new Error(`Unexpected GitHub fixture path: ${target.pathname}`);
  } });
}

function sourceFixtures(id, directory, notion) {
  if (id === 'google') return [googleFixture()];
  if (id === 'notion') return [googleFixture({ drive: false }), notion.connector];
  if (id.startsWith('github')) return [githubFixture(id)];
  if (id === 'microsoft') return [new OutlookConnector({ auth, account: { id: 'ms-account', label: 'reader@example.test' }, now, fetchImpl: async () => response({ value: [{
    id: 'mail-1', conversationId: 'thread-1', subject: 'Cedar proposal', from: { emailAddress: { address: 'alex@example.test' } },
    toRecipients: [{ emailAddress: { address: 'reader@example.test' } }], receivedDateTime: at, body: { contentType: 'text', content: requestBody }
  }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next' }) }), notion.connector];
  if (id === 'slack') return [new SlackConnector({ auth, account: { id: 'T123ABC:U123ABC', userId: 'U123ABC', teamId: 'T123ABC' }, now, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname.endsWith('/conversations.list')) return response({ ok: true, channels: [{ id: 'D111AAAAA', is_im: true }] });
    if (target.pathname.endsWith('/users.info')) return response({ ok: true, user: { real_name: 'Alex' } });
    return response({ ok: true, messages: [{ type: 'message', user: 'UOTHER123', ts: String(Math.floor(now() / 1000)), text: requestBody }] });
  } }), notion.connector];
  if (id === 'local_files') {
    const root = path.join(directory, 'selected'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'Cedar.md'), `${content}\nTODO: Review the Cedar rollout\n`);
    return [new LocalFilesConnector({ scopeId: 'local-account', roots: [{ id: 'root', path: fs.realpathSync(root), label: 'Cedar' }], now })];
  }
  const folders = [{ accountId: 'notes-account', folderId: 'folder', label: 'Cedar' }];
  return [new AppleNotesConnector({ scopeId: 'notes-scope', folders, now, bridge: { readNotes: async () => ({ records: [{ providerId: 'note-1', ...folders[0],
    title: 'Cedar notes', content: `${content}\nTODO: Review the Cedar rollout\n`, stamp: 'stamp-1', modifiedAt: at }], errors: [], complete: true }) } })];
}

async function fixture(t, sourceId, { policy = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-connector-harness-'));
  const store = new SqliteStore(path.join(directory, 'state.json')), notion = notionFixture();
  let runtime;
  const engine = new WorkEngine(store, { externalTools: scope => runtime?.tools(scope) || [] });
  const connectors = sourceFixtures(sourceId, directory, notion);
  runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => connectors.find(connector => connector.id === id), artifactConnectionFor: id => id === 'notion' ? notion : null });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const connector of connectors) if (connector.account?.id) bindConnectionAccount(store, connector.id, connector.account.id);
  const grant = await runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent }, { confirmed: true });
  if (policy) runtime.policies.save({ instruction: `${policy} this source`, predicate: { op: 'eq', feature: 'event.provider', value: sourceId.startsWith('github') ? 'github' : sourceId }, effect: { type: policy } });
  const sync = new ConnectorSync({ connectors, cursors: new CursorStore(store), engine });
  const synced = await sync.run();
  assert.ok(synced.results.every(result => !result.failed && !result.partial), JSON.stringify(synced));
  await engine.whenSettled();
  return { directory, store, engine, runtime, notion, grant, sync };
}

async function scriptedReasoner(harness, respond) {
  if (harness === 'standard') return new OpenAiCompatibleReasoner({ baseUrl: 'https://scripted.invalid/v1', model: 'scripted', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body), reply = respond(request.messages, request.tools?.map(tool => tool.function.name) || []);
    return response({ choices: [{ message: reply.tool ? { content: null, tool_calls: [{ type: 'function', id: reply.id, function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { content: JSON.stringify(reply) } }] });
  } });
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  return new PiReasoner({ baseUrl: 'https://scripted.invalid/v1', model: 'scripted', runtimeOptions: { streamFn: async (model, modelContext) => {
    const names = modelContext.messages.find(message => message.role === 'system')?.toolsAdded?.map(tool => tool.name) || [];
    const reply = respond(modelContext.messages, names), stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: reply.tool ? [{ type: 'toolCall', id: reply.id, name: reply.tool, arguments: reply.args }] : [{ type: 'text', text: JSON.stringify(reply) }],
      api: model.api, provider: model.provider, model: model.id, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reply.tool ? 'toolUse' : 'stop', timestamp: Date.now() };
    stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
  } } });
}

for (const harness of ['standard', 'pi']) for (const sourceId of sources) {
  test(`${sourceId} -> activation -> ${harness} reads source evidence -> verified Notion creation`, { skip: harness === 'pi' && !piSupported(), timeout: 20000 }, async t => {
    const context = await fixture(t, sourceId);
    const task = Object.values(context.store.state.tasks)[0];
    assert.ok(task, JSON.stringify(context.store.state.events));
    assert.equal(context.runtime.activationFor(task).activate, true);
    const document = context.engine.documentsForTask(task.id)[0];
    let turns = 0;
    const reasoner = await scriptedReasoner(harness, (messages, names) => {
      turns++;
      assert.equal(new Set(names).size, names.length);
      const toolResults = messages.filter(message => ['tool', 'toolResult'].includes(message.role));
      const result = toolResults.at(-1);
      const readResult = result && JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text);
      if (turns === 1) return { tool: 'read_task_source', id: 'source', args: {} };
      if (turns === 2) {
        assert.equal(readResult.taskId, task.id);
        assert.equal(readResult.provider, task.sourceConnectorId);
        assert.ok(readResult.content);
        if (document) return { tool: 'read_document', id: 'document', args: { id: document.id } };
      }
      if (turns === 3 && document) assert.match(readResult.content, /Evidence detail:/);
      if (turns === (document ? 3 : 2)) return { tool: 'create_work_artifact', id: 'create', args: { grantId: context.grant.id, title: 'Cedar source findings', body: detail } };
      assert.equal(readResult.status, 'queued');
      return { probes: [], nextStep: 'Wait for the queued page to be verified.' };
    });
    context.engine.replaceReasoner(reasoner);
    context.runtime.scheduleTask(task.id, `matrix:${sourceId}:${harness}`); context.runtime.kick();
    await context.engine.whenSettled();
    const finished = context.runtime.tasks.get(task.id);
    assert.equal(turns, document ? 4 : 3, JSON.stringify({ reasoning: finished.reasoningWork, error: reasoner.lastError, jobs: context.runtime.jobs.list() }));
    assert.equal(finished.artifactRequests?.[0]?.status, 'verified', JSON.stringify(finished.artifactRequests));
    assert.equal(context.notion.written.size, 1);
    assert.notEqual(finished.status, 'completed');
    assert.equal(finished.action, null);
    const reads = context.runtime.ledger.list({ taskId: task.id }).filter(execution => execution.action_family === 'context.read');
    assert.equal(reads.length, document ? 3 : 2);
    assert.ok(reads.every(execution => execution.status === 'verified'));
    assert.ok(reads.some(execution => execution.provider === 'workspace' && execution.tool === 'read_task_source'));
    assert.equal(context.store.state.outbox.length, 0);
  });
}

for (const sourceId of ['google', 'microsoft', 'slack', 'github', 'local_files', 'apple_notes']) {
  test(`${sourceId} suppression prevents source activation and all provider writes`, async t => {
    const context = await fixture(t, sourceId, { policy: 'suppress' });
    assert.equal(Object.keys(context.store.state.tasks).length, 0);
    assert.equal(context.notion.written.size, 0);
    assert.ok(context.store.state.events.some(event => event.disposition === 'suppressed_by_user_policy'));
  });
}

test('Notion suppression excludes its pages from task context while preserving independently authorized mail', async t => {
  const context = await fixture(t, 'notion', { policy: 'suppress' });
  const task = Object.values(context.store.state.tasks)[0];
  assert.ok(task);
  assert.equal(context.engine.documentsForTask(task.id).length, 0);
  assert.ok(context.store.state.events.some(event => event.connectorId === 'notion' && event.disposition === 'suppressed_by_user_policy'));
  assert.equal(context.notion.written.size, 0);
});

for (const sourceId of ['google', 'microsoft', 'slack', 'notion', 'github', 'local_files', 'apple_notes']) {
  test(`${sourceId} revocation invalidates already captured source and document tools`, async t => {
    const context = await fixture(t, sourceId);
    const task = Object.values(context.store.state.tasks)[0];
    const pending = context.runtime.jobs.enqueue({ queue: 'test', type: 'source_read', taskId: task.id, key: `read:${sourceId}`, payload: {} });
    const job = context.runtime.jobs.claim('source-reader', { queue: 'test', id: pending.id });
    const run = context.runtime.tasks.beginRun(job), planning = context.runtime.buildContext(context.runtime.tasks.get(task.id), run);
    context.runtime.tasks.checkpoint(run, job, { expectedInputVersion: task.inputVersion, contextVersion: planning.version, sources: planning.sources, plan: {} });
    await context.runtime.scope.run({ taskId: task.id, run, job }, async () => {
      const fence = context.runtime.capture(task.id);
      const tools = context.engine.externalTools({ taskId: task.id, isCurrent: () => context.runtime.isCurrent(task.id, fence) });
      const source = tools.find(tool => tool.name === 'read_task_source');
      assert.equal(JSON.parse((await source.execute('before', {})).content[0].text).taskId, task.id);
      const document = context.engine.documentsForTask(task.id)[0];
      const read = tools.find(tool => tool.name === 'read_document');
      if (document) assert.match((await read.execute('document-before', { id: document.id })).content[0].text, /Evidence detail:/);
      await context.runtime.privacy.revokePermission({ connectorId: sourceId === 'notion' ? 'notion' : task.sourceConnectorId });
      await assert.rejects(source.execute('after', {}));
      if (document) await assert.rejects(read.execute('document-after', { id: document.id }));
    });
    assert.equal(context.notion.written.size, 0);
  });
}

for (const harness of ['standard', 'pi']) for (const sourceId of ['google', 'microsoft', 'slack', 'github', 'local_files', 'apple_notes']) {
  test(`${sourceId} require-review permits ${harness} investigation while blocking automatic writes`, { skip: harness === 'pi' && !piSupported() }, async t => {
    const context = await fixture(t, sourceId, { policy: 'require_review' });
    const task = Object.values(context.store.state.tasks)[0];
    assert.equal(context.runtime.activationFor(task).requiresReview, true);
    let attempted = false;
    const reasoner = await scriptedReasoner(harness, messages => {
      const result = messages.find(message => ['tool', 'toolResult'].includes(message.role));
      if (!result) { attempted = true; return { tool: 'create_work_artifact', id: 'review-blocked', args: { grantId: context.grant.id, title: 'Cedar', body: detail } }; }
      assert.match(typeof result.content === 'string' ? result.content : JSON.stringify(result.content), /error|revoked|failed/i);
      return { probes: [], nextStep: 'Ask the user to review this creation.' };
    });
    context.engine.replaceReasoner(reasoner);
    context.runtime.scheduleTask(task.id, `review:${harness}`); context.runtime.kick();
    await context.engine.whenSettled();
    assert.equal(attempted, true);
    assert.equal(context.runtime.tasks.get(task.id).artifactRequests?.length || 0, 0);
    assert.equal(context.notion.written.size, 0);
  });
}

for (const sourceId of ['github_change', 'github_check']) {
  test(`${sourceId} withdrawal invalidates existing work even after activation is suppressed`, async t => {
    const context = await fixture(t, sourceId);
    const task = Object.values(context.store.state.tasks)[0];
    const original = context.store.state.events.find(event => event.type === (sourceId === 'github_change' ? 'content.changed' : 'workflow.updated'));
    context.runtime.policies.save({ instruction: 'Suppress new GitHub work', predicate: { op: 'always' }, effect: { type: 'suppress' } });
    context.engine.ingest({ ...original, id: `${original.id}:withdrawn`, providerEventId: `${original.providerEventId}:withdrawn`, payload: { ...original.payload, active: false, state: 'unavailable', updatedAt: '2026-10-28T10:00:00.000Z' } });
    await context.engine.whenSettled();
    assert.equal(context.runtime.tasks.get(task.id).status, 'cancelled');
    assert.equal(context.notion.written.size, 0);
  });
}

for (const harness of ['standard', 'pi']) {
  test(`${harness} discovers a newly authorized destination on an already prepared task without repeating prior writes`, { skip: harness === 'pi' && !piSupported() }, async t => {
    const context = await fixture(t, 'google');
    const task = Object.values(context.store.state.tasks)[0];
    assert.equal(task.status, 'ready_for_approval');
    let selected = context.grant.id, calls = 0;
    const reasoner = await scriptedReasoner(harness, messages => {
      calls++;
      const result = messages.find(message => ['tool', 'toolResult'].includes(message.role));
      if (!result) return { tool: 'create_work_artifact', id: `create:${selected}`, args: { grantId: selected, title: 'Cedar summary', body: detail } };
      assert.match(typeof result.content === 'string' ? result.content : JSON.stringify(result.content), /queued/);
      return { probes: [], nextStep: 'Wait for verification.' };
    });
    context.engine.replaceReasoner(reasoner); context.engine.investigateWithTools();
    await context.engine.whenSettled();
    assert.equal(context.notion.written.size, 1);
    const next = await context.runtime.artifacts.createGrant({ connectorId: 'notion', targetId: 'dddddddd-1111-2222-3333-eeeeeeeeeeee' }, { confirmed: true });
    selected = next.id;
    context.engine.investigateWithTools();
    await context.engine.whenSettled();
    const updated = context.runtime.tasks.get(task.id);
    assert.equal(updated.artifactRequests.length, 2);
    assert.ok(updated.artifactRequests.every(request => request.status === 'verified'));
    assert.equal(context.notion.written.size, 2);
    const settledCalls = calls;
    context.engine.investigateWithTools();
    await context.engine.whenSettled();
    assert.equal(calls, settledCalls);
    assert.equal(context.notion.written.size, 2);
  });
}
