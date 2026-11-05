import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { publicClientConfiguration } from '../src/connection-catalog.js';
import { keyRpc } from '../src/mcp-key-server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeEvent } from '../src/connectors/events.js';
import { acknowledgedCursor, CursorStore } from '../src/connectors/connector.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { GoogleWorkspaceConnector } from '../src/connectors/google.js';
import { SlackConnector } from '../src/connectors/slack.js';
import { OutlookConnector } from '../src/connectors/outlook.js';
import { NotionConnector } from '../src/connectors/notion.js';
import { GitHubConnector } from '../src/connectors/github.js';
import { TodoistConnector, todoistIdentity } from '../src/connectors/todoist.js';
import { AppleRemindersConnector } from '../src/connectors/apple-reminders.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { LocalSetupStore } from '../src/setup.js';
import { connectedSources } from '../src/connected-sources.js';
import { MCP_PRESETS, McpManager, stdioEnvironment } from '../src/mcp.js';
import { publicAddress, rpc, pageText, readPublicPage } from '../src/mcp-fetch-server.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const auth = { accessToken: async () => 'fixture-private-token' };
const now = () => Date.parse('2026-11-01T00:00:00Z');
function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new JsonStore(path.join(dir, 'state.json'));
}
const email = (revision, body = 'Please update the Northstar project proposal by Friday.') => normalizeEvent({ connectorId: 'slack', source: 'slack', providerEventId: 'message-1', providerRevision: revision,
  type: 'email.received', at: `2026-10-${revision === 'r1' ? '28' : '29'}T12:00:00Z`, payload: { id: 'message-1', from: 'alex@example.test', to: 'maya@example.test', subject: 'Northstar project proposal', body,
    threadId: 'thread-1', updatedAt: `2026-10-${revision === 'r1' ? '28' : '29'}T12:00:00Z`, receivedAt: '2026-10-28T12:00:00Z' } });
const google = (fetchImpl, config = {}) => new GoogleWorkspaceConnector({ auth: { configured: () => true, headers: async () => ({ authorization: 'Bearer fixture' }) }, config: { readGmail: false, readDrive: false, maxRetries: 0, ...config }, fetchImpl });

test('connected cloud sources expose current granted scopes and never inherit a replacement account', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-scope-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  for (const id of ['microsoft', 'slack']) {
    setup.saveConnectionAuthorization(id, { clientId: 'registered-client', accessToken: 'token', account: { id: 'account-a', label: 'Account A' }, scopes: ['read', 'write', ...(id === 'slack' ? ['channels:history'] : [])] });
  }
  const connectors = connectedSources(setup, { nativeBridge: { platform: 'linux' } });
  for (const id of ['microsoft', 'slack']) {
    const connector = connectors.find(item => item.id === id);
    assert.deepEqual(connector.scopes, ['read', 'write', ...(id === 'slack' ? ['channels:history'] : [])]);
    if (id === 'slack') assert.equal(connector.channelsEnabled, true);
    setup.saveConnectionAuthorization(id, { ...setup.getConnection(id), scopes: ['read'] });
    assert.deepEqual(connector.scopes, ['read']);
    if (id === 'slack') assert.equal(connector.channelsEnabled, false);
    setup.saveConnectionAuthorization(id, { ...setup.getConnection(id), account: { id: 'account-b', label: 'Account B' }, scopes: ['admin'] });
    assert.deepEqual(connector.scopes, []);
  }
});

test('event identity separates opaque provider revisions and etags from record identity', t => {
  const first = email('r1'), edited = email('r2', 'Please update the Northstar project proposal with sample size by Monday.');
  assert.equal(first.payload.id, edited.payload.id); assert.notEqual(first.id, edited.id); assert.equal(email('r1').id, first.id);
  const state = store(t), engine = new WorkEngine(state);
  engine.ingest(first); engine.ingest(edited);
  assert.equal(engine.ingest(edited).duplicate, true);
  assert.equal(state.state.inbox.length, 1); assert.equal(state.state.inbox[0].body, edited.payload.body);
  assert.equal(state.state.events[0].operation, 'create'); assert.equal(state.state.events[1].operation, 'update');
  const tasks = Object.values(state.state.tasks); assert.equal(tasks.length, 1); assert.ok(tasks[0].commitment.revision >= 2);
  const before = state.state.inbox[0].body;
  engine.ingest({ ...first, id: first.id + ':late' }); assert.equal(state.state.inbox[0].body, before);
  assert.equal(state.state.events.at(-1).disposition, 'stale_change');
  const opaque = value => normalizeEvent({ connectorId: 'google', source: 'google', providerEventId: 'file', providerEtag: value, type: 'document.modified', payload: { id: 'file', title: 'File', content: '' } });
  assert.notEqual(opaque('W/"v1"').id, opaque('W/"v2"').id);
});

test('failed scope retains its checkpoint; a successful scope acknowledges only after ingestion', async t => {
  assert.deepEqual(acknowledgedCursor({ drive: { page: 1 } }, { scopes: { drive: { status: 'failed', cursor: { page: 9 } }, gmail: { status: 'complete', cursor: { historyId: 'h2' } } } }), { drive: { page: 1 }, gmail: { historyId: 'h2' } });
  const state = store(t), cursors = new CursorStore(state); cursors.set('mixed', { drive: 'old', gmail: 'h1' });
  const connector = { id: 'mixed', live: true, pull: async () => ({ events: [email('r1')], partial: true, errors: [{ scope: 'drive', message: '503' }], scopes: { drive: { status: 'failed' }, gmail: { status: 'complete', cursor: 'h2' } } }) };
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine: { ingest() { throw new Error('disk full'); } } });
  assert.equal((await sync.run()).results[0].failed, true); assert.deepEqual(cursors.get('mixed'), { drive: 'old', gmail: 'h1' });
  sync.engine = { ingest: () => ({ duplicate: true }) }; await sync.run(); assert.deepEqual(cursors.get('mixed'), { drive: 'old', gmail: 'h2' }); assert.equal(cursors.observation('mixed').complete, false);
});

for (const status of [400, 410]) test(`Drive ${status} resets before enumeration and retains the old checkpoint if recovery fails`, async () => {
  const calls = [], fetchImpl = async value => {
    const url = new URL(value); calls.push(url.pathname);
    if (url.pathname.endsWith('/changes')) return json({}, status);
    if (url.pathname.endsWith('/startPageToken')) return json({ startPageToken: 'new-baseline' });
    if (url.pathname.endsWith('/files')) return json({ files: [] });
    throw new Error('unexpected');
  };
  const connector = google(fetchImpl, { readDrive: true });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'expired', filesModifiedAfter: '2026-10-01T00:00:00Z' } } });
  assert.equal(result.partial, false); assert.equal(result.cursor.drive.pageToken, 'new-baseline');
  assert.deepEqual(calls.slice(0, 3), ['/drive/v3/changes', '/drive/v3/changes/startPageToken', '/drive/v3/files']);
  connector.fetchImpl = async value => new URL(value).pathname.endsWith('/changes') ? json({}, status) : json({}, 503);
  const failed = await connector.pull({ cursor: { drive: { pageToken: 'expired' } } });
  assert.equal(failed.partial, true); assert.equal(failed.cursor.drive.pageToken, 'expired');
});

test('Drive exports Sheets as CSV and Slides as text, preserves every page, and versions edits', async () => {
  let revision = 1; const calls = [];
  const connector = google(async value => {
    const url = new URL(value); calls.push(url);
    if (url.pathname.endsWith('/startPageToken')) return json({ startPageToken: 'start' });
    if (url.pathname.endsWith('/changes')) return json({ changes: [], newStartPageToken: 'next' });
    if (url.pathname.endsWith('/files')) return json({ files: [{ id: 'sheet', name: 'Numbers', mimeType: 'application/vnd.google-apps.spreadsheet', version: String(revision), modifiedTime: `2026-10-${revision + 27}T00:00:00Z` }, { id: 'slides', name: 'Deck', mimeType: 'application/vnd.google-apps.presentation', version: String(revision), modifiedTime: `2026-10-${revision + 27}T00:00:00Z` }] });
    return new Response(`Body ${revision}`);
  }, { readDrive: true, documentListLimit: 2 });
  const first = await connector.pull(); revision++; const next = await connector.pull({ cursor: first.cursor });
  assert.equal(first.events.length, 2); assert.notEqual(first.events[0].id, next.events[0].id);
  assert.ok(calls.some(url => url.pathname.includes('/sheet/export') && url.searchParams.get('mimeType') === 'text/csv'));
  assert.ok(calls.some(url => url.pathname.includes('/slides/export') && url.searchParams.get('mimeType') === 'text/plain'));
  assert.ok(calls.some(url => url.pathname.endsWith('/files') && url.searchParams.get('pageSize') === '2'));
});

test('Gmail query filters incremental additions and excludes sent messages', async () => {
  const calls = [], connector = google(async value => {
    const url = new URL(value); calls.push(url);
    if (url.pathname.endsWith('/history')) return json({ historyId: 'h2', history: [{ messagesAdded: [{ message: { id: 'match' } }, { message: { id: 'outside' } }, { message: { id: 'sent' } }] }] });
    if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'match' }, { id: 'sent' }] });
    return json({ id: url.pathname.split('/').at(-1), labelIds: url.pathname.endsWith('/sent') ? ['SENT'] : ['INBOX'], payload: { headers: [{ name: 'From', value: 'sender@example.test' }, { name: 'Subject', value: 'Request' }], mimeType: 'text/plain', body: { data: Buffer.from('Please review').toString('base64url') } } });
  }, { readGmail: true, gmailQuery: 'label:work' });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1', query: 'label:work' } } });
  assert.deepEqual(result.events.map(event => event.payload.id), ['match']);
  assert.equal(result.cursor.gmail.historyId, 'h2'); assert.ok(calls.some(url => url.searchParams.get('q') === 'label:work'));
  assert.ok(!calls.some(url => url.pathname.endsWith('/outside')));
});

test('Outlook recovering starts without the bootstrap age limit; updates use etags', async () => {
  let revision = 1; const calls = [];
  const connector = new OutlookConnector({ auth, account: { id: 'user', label: 'user@example.test' }, now, fetchImpl: async value => {
    const url = new URL(value); calls.push(url);
    return json({ value: [{ id: 'mail', '@odata.etag': `v${revision}`, subject: 'Request', from: { emailAddress: { address: 'alex@example.test' } }, body: { contentType: 'text', content: `Revision ${revision}` }, receivedDateTime: '2026-10-20T00:00:00Z', lastModifiedDateTime: `2026-10-${27 + revision}T00:00:00Z` }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next' });
  } });
  const first = await connector.pull({ cursor: { recovering: true } }); revision++; const next = await connector.pull({ cursor: first.cursor });
  assert.equal(calls[0].searchParams.has('$filter'), false); assert.notEqual(first.events[0].id, next.events[0].id); assert.equal(first.events[0].payload.id, next.events[0].payload.id);
});

test('Slack resumes a busy history window and conversation listing, then re-observes edits', async () => {
  let revision = 1;
  const connector = new SlackConnector({ auth, account: { id: 'T123:U123' }, now, fetchImpl: async value => {
    const url = new URL(value), p = url.searchParams;
    if (url.pathname.endsWith('/conversations.list')) return json({ ok: true, channels: [{ id: 'D123', is_im: true }] });
    if (url.pathname.endsWith('/users.info')) return json({ ok: true, user: { real_name: 'Alex' } });
    const page = Number(p.get('cursor') || 0);
    if (p.get('latest') === p.get('oldest')) return json({ ok: true, messages: [{ user: 'U456', ts: p.get('oldest'), text: `Edited ${revision}`, edited: { ts: revision === 1 ? '1793400001.000001' : '1793400002.000001' } }] });
    return json({ ok: true, messages: [{ user: 'U456', ts: `17934000${String(page).padStart(2, '0')}.000001`, text: `Request ${page}` }], ...(page < 24 ? { has_more: true, response_metadata: { next_cursor: String(page + 1) } } : {}) });
  } });
  const first = await connector.pull(); assert.equal(first.hasMore, true); assert.ok(first.cursor.scan.historyCursor); assert.equal(first.cursor.oldest, String((now() - 3 * 86400_000) / 1000));
  const second = await connector.pull({ cursor: first.cursor }); assert.equal(second.partial, false); assert.equal(second.hasMore, false); assert.equal(Object.keys(second.cursor.messages).length, 25);
  revision++; const third = await connector.pull({ cursor: second.cursor }); assert.ok(third.events.some(event => event.payload.body === 'Edited 2'));
});

test('Slack channel membership and thread replies are included only with granted channel scopes', async () => {
  const paths = [];
  const connector = new SlackConnector({ auth, account: { id: 'T123:U123' }, scopes: ['channels:history'], now, fetchImpl: async value => {
    const url = new URL(value); paths.push(url.pathname);
    if (url.pathname.endsWith('/conversations.list')) return json({ ok: true, channels: [{ id: 'C123', is_channel: true, is_member: true, name: 'work' }, { id: 'C999', is_channel: true, is_member: false }] });
    if (url.pathname.endsWith('/users.info')) return json({ ok: true, user: { real_name: 'Alex' } });
    if (url.pathname.endsWith('/conversations.replies')) return json({ ok: true, messages: [{ user: 'U456', ts: '1793400001.000001', thread_ts: '1793400000.000001', text: '<@U123> Please review the proposal' }] });
    assert.equal(url.searchParams.get('channel'), 'C123');
    return json({ ok: true, messages: [{ user: 'U456', ts: '1793400000.000001', text: 'A thread', reply_count: 1 }] });
  } });
  const result = await connector.pull(); assert.equal(result.partial, false); assert.equal(result.events.length, 2);
  const reply = result.events.find(event => event.payload.slackThreadTs && event.payload.id.endsWith(':1793400001.000001')); assert.ok(reply.payload.threadId.endsWith(':1793400000.000001')); assert.equal(reply.meta.principalRole, 'DIRECT_ACTOR');
  assert.equal((await connector.sourceMessageState(reply.payload.id, { threadTs: reply.payload.slackThreadTs })).status, 'present');
  assert.equal(paths.filter(value => value.endsWith('/conversations.replies')).length, 2);
});

test('Notion partial body read retains the page checkpoint and an expired page token restarts the same watermark', async () => {
  let fail = true; const calls = [], page = { object: 'page', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', last_edited_time: '2026-10-29T00:00:00Z', properties: {} };
  const connector = new NotionConnector({ auth, account: { id: 'workspace:user' }, now, fetchImpl: async (value, options) => {
    const url = new URL(value);
    if (url.pathname.endsWith('/search')) { const body = JSON.parse(options.body); calls.push(body); if (body.start_cursor === 'expired') return json({}, 400); return json({ results: [page], has_more: false }); }
    if (fail) return json({}, 503);
    return json({ results: [] });
  } });
  const cursor = { since: '2026-10-28T00:00:00Z', startCursor: 'expired' };
  const partial = await connector.pull({ cursor }); assert.equal(partial.partial, true); assert.deepEqual(partial.cursor, cursor);
  fail = false; const recovered = await connector.pull({ cursor }); assert.equal(recovered.partial, false); assert.equal(recovered.events.length, 1); assert.ok(calls.some(body => !body.start_cursor));
});

test('GitHub mentions have independent pagination and PR search/pulls IDs cannot split one review task', async t => {
  let withdrawn = false;
  const issue = { id: 9, number: 3, title: 'Please update the Northstar project proposal', body: 'Please update the Northstar project proposal by Friday.', updated_at: '2026-10-29T00:00:00Z', state: 'open', assignees: [], user: { login: 'alex' }, repository_url: 'https://api.github.com/repos/team/work' };
  const connector = new GitHubConnector({ auth, account: { id: 'user', login: 'sam' }, now, fetchImpl: async value => {
    const url = new URL(value);
    if (url.pathname === '/issues') return json(url.searchParams.get('filter') === 'mentioned' ? [issue] : []);
    if (url.pathname === '/search/issues') return json({ items: !withdrawn && url.search.includes('review-requested') ? [{ ...issue, id: 900 }] : [] });
    if (url.pathname === '/user/repos') return json([]);
    return json({ ...issue, id: 88, state: 'closed', merged: true });
  } });
  const first = await connector.pull(), state = store(t), engine = new WorkEngine(state);
  assert.ok(first.events.some(event => event.type === 'email.received')); first.events.forEach(event => engine.ingest(event));
  withdrawn = true; const second = await connector.pull({ cursor: first.cursor }); second.events.forEach(event => engine.ingest(event));
  const reviews = Object.values(state.state.tasks).filter(task => task.kind === 'external_review'); assert.equal(reviews.length, 1); assert.equal(reviews[0].status, 'cancelled');
});

for (const status of [400, 410]) test(`Calendar ${status} recovery preserves evidence until full enumeration and processes cancellations`, async () => {
  let page = 0; const calls = [];
  const connector = google(async value => {
    const url = new URL(value); calls.push(url);
    if (url.searchParams.get('syncToken') === 'expired') return json({}, status);
    page++;
    if (page === 1) return json({ items: [{ id: 'meeting', summary: 'Launch', updated: '2026-10-30T00:00:00Z', etag: 'v1', start: { date: '2026-11-01' } }], nextPageToken: 'page2' });
    return json({ items: [{ id: 'meeting', status: 'cancelled', etag: 'v2', updated: '2026-10-31T00:00:00Z' }], nextSyncToken: 'new' });
  }, { readCalendar: true });
  const first = await connector.pull({ cursor: { calendar: { syncToken: 'expired', known: { stale: { title: 'Old meeting' } } } } });
  assert.equal(first.hasMore, true); assert.equal(first.cursor.calendar.recovering, true); assert.ok(first.cursor.calendar.known.stale);
  const second = await connector.pull({ cursor: first.cursor }); assert.equal(second.partial, false); assert.equal(second.hasMore, false); assert.equal(second.cursor.calendar.syncToken, 'new');
  assert.ok(second.events.some(event => event.payload.id.endsWith(':stale') && event.type === 'document.unavailable'));
  assert.ok(second.events.some(event => event.payload.id.endsWith(':meeting') && event.payload.reason === 'cancelled'));
  assert.ok(calls[1].searchParams.has('timeMin')); assert.equal(calls[1].searchParams.has('syncToken'), false);
});

test('Calendar requires selected and granted access; existing Google users keep their previous scopes', t => {
  const state = store(t), setup = new LocalSetupStore({ filePath: path.join(path.dirname(state.filename), 'contract-setup.json') });
  t.after(() => { try { fs.unlinkSync(setup.filePath); } catch {} });
  setup.saveDesktopClientJson(JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture-client-secret', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token' } }));
  assert.equal(setup.get().google.scopes.readCalendar, false);
  setup.setGoogleScopes({ readCalendar: true }); assert.equal(setup.get().google.scopes.readCalendar, true);
  // No saved authorization means selecting a scope cannot grant runtime access.
  assert.notEqual(setup.runtimeEnv({}).GOOGLE_READ_CALENDAR, 'true');
});

test('Todoist paginated snapshots do not infer completion from an unfinished page and stable IDs survive title edits', async t => {
  let mode = 'initial'; const account = { id: 'user', label: 'sam@example.test' };
  const connector = new TodoistConnector({ auth, account, now, fetchImpl: async value => {
    const url = new URL(value);
    if (mode === 'failed') return json({}, 503);
    if (mode === 'initial' && !url.searchParams.get('cursor')) return json({ results: [{ id: 'a', content: 'Prepare report', added_at: '2026-10-28T00:00:00Z' }], next_cursor: 'p2' });
    return json({ results: mode === 'initial' ? [{ id: 'b', content: 'Review contract', added_at: '2026-10-28T00:00:00Z' }] : [{ id: 'a', content: 'Prepare updated report', updated_at: '2026-10-29T00:00:00Z' }], next_cursor: null });
  } });
  const first = await connector.pull(); assert.equal(first.hasMore, true); assert.equal(first.events.filter(event => event.type === 'task.observed').length, 1);
  const second = await connector.pull({ cursor: first.cursor }); assert.equal(second.events.some(event => event.payload.state === 'unavailable'), false);
  mode = 'failed'; await assert.rejects(connector.pull({ cursor: second.cursor }));
  mode = 'edited'; const edited = await connector.pull({ cursor: second.cursor });
  const state = store(t), engine = new WorkEngine(state); [...first.events, ...second.events, ...edited.events].forEach(event => engine.ingest(event));
  const tasks = Object.values(state.state.tasks); assert.equal(tasks.length, 2); assert.equal(tasks.find(task => task.externalSource.id.endsWith(':a')).subject, 'Prepare updated report');
  assert.equal(tasks.find(task => task.externalSource.id.endsWith(':b')).status, 'cancelled'); assert.equal(state.state.outbox.length, 0);
  const identity = await todoistIdentity('personal_fixture_token', { fetchImpl: async () => json(account) }).catch(() => null);
  assert.equal(identity, null, 'an account-shaped payload without provider identity email is rejected');
});

test('Reminders reads only selected lists; partial reads never withdraw other reminders', async t => {
  let complete = true, title = 'Prepare report';
  const bridge = { platform: 'darwin', readReminders: async () => ({ records: [{ id: 'reminder', title, body: 'Details', state: 'open', updatedAt: '2026-10-29T00:00:00Z', accountId: 'icloud', folderId: 'work' }], errors: [], complete }) };
  const connector = new AppleRemindersConnector({ scopeId: 'selected-scope', folders: [{ accountId: 'icloud', folderId: 'work' }], bridge, now });
  const first = await connector.pull(), state = store(t), engine = new WorkEngine(state); first.events.forEach(event => engine.ingest(event));
  complete = false; title = 'Prepare revised report'; const second = await connector.pull({ cursor: first.cursor }); second.events.forEach(event => engine.ingest(event));
  assert.equal(second.partial, true); assert.equal(Object.values(state.state.tasks).length, 1); assert.equal(Object.values(state.state.tasks)[0].subject, title);
  assert.equal(state.state.outbox.length, 0);
  bridge.readReminders = async () => ({ records: [{ id: 'other', title: 'Private', state: 'open', updatedAt: '2026-10-29T00:00:00Z', accountId: 'icloud', folderId: 'unselected' }], errors: [], complete: true });
  await assert.rejects(connector.pull({ cursor: second.cursor }), /outside selected/);
});

test('bundled Fetch starts with app Node and advertises a real read-only MCP tool', async () => {
  const preset = MCP_PRESETS.find(item => item.id === 'fetch'); assert.equal(preset.config.command, process.execPath); assert.ok(fs.existsSync(preset.config.args[0]));
  const { Client } = await import('@modelcontextprotocol/client'); const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'fixture', version: '1' });
  try { await client.connect(new StdioClientTransport({ ...preset.config, env: { PATH: '/usr/bin:/bin' }, stderr: 'ignore' })); const tools = await client.listTools(); assert.equal(tools.tools[0].name, 'fetch'); assert.equal(tools.tools[0].annotations.readOnlyHint, true); }
  finally { await client.close(); }
  assert.ok(stdioEnvironment({ PATH: '/usr/bin' }).PATH.includes(path.dirname(process.execPath)));
  assert.equal(stdioEnvironment({}, { PATH: '/explicit' }).PATH, '/explicit');
  const manager = new McpManager({ configStore: { get: () => ({ fetch: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], enabled: false, allowDeclaredRead: true } }) } });
  assert.equal(manager.configs.fetch.command, process.execPath);
  assert.equal((await rpc({ method: 'tools/list' })).tools[0].name, 'fetch');
  assert.equal(pageText('<script>bad()</script><p>Hello &amp; goodbye</p>'), 'Hello & goodbye');
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  await assert.rejects(readPublicPage('http://example.test', { lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }] }), /Private/);
});


test('API-key MCP presets run with bundled Node and send keys only to their fixed provider origins', async () => {
  for (const provider of ['brave-search', 'firecrawl']) {
    const preset = MCP_PRESETS.find(item => item.id === provider);
    assert.equal(preset.config.command, process.execPath); assert.ok(fs.existsSync(preset.config.args[0]));
    const tool = (await keyRpc(provider, { method: 'tools/list' })).tools[0];
    const calls = [];
    const result = await keyRpc(provider, { method: 'tools/call', params: { name: tool.name, arguments: provider === 'brave-search' ? { query: 'connector fixture' } : { url: 'https://example.com/page' } } }, {
      env: { BRAVE_API_KEY: 'private-brave-key', FIRECRAWL_API_KEY: 'private-firecrawl-key' }, fetchImpl: async (value, options) => {
        const url = new URL(value); calls.push({ url, options });
        return json(provider === 'brave-search' ? { web: { results: [{ title: 'Result', url: 'https://example.com', description: 'Evidence' }] } } : { success: true, data: { markdown: '# Read content' } });
      }
    });
    assert.equal(result.isError, undefined); assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, provider === 'brave-search' ? 'https://api.search.brave.com' : 'https://api.firecrawl.dev');
    assert.doesNotMatch(JSON.stringify(result), /private-.*-key/);
  }
});

test('personal-token and Reminders selections survive setup reload and bind actual observers', t => {
  const state = store(t), filePath = path.join(path.dirname(state.filename), 'setup.json');
  const setup = new LocalSetupStore({ filePath });
  setup.saveConnectionAuthorization('todoist', { accessToken: 'personal_fixture_token', account: { id: 'user', label: 'sam@example.test' } });
  setup.saveNativeSource('apple_reminders', { scopeId: 'selected-scope', folders: [{ accountId: 'icloud', folderId: 'work', label: 'Work' }] });
  const restored = new LocalSetupStore({ filePath });
  const connectors = connectedSources(restored, { nativeBridge: { platform: 'darwin' } });
  assert.ok(connectors.some(connector => connector instanceof TodoistConnector && connector.live));
  assert.ok(connectors.some(connector => connector instanceof AppleRemindersConnector && connector.live));
  restored.clearConnection('todoist'); assert.equal(connectedSources(restored, { nativeBridge: { platform: 'linux' } }).length, 0);
});


test('Notion consumes every block page and nested text before acknowledging its search watermark', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', child = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  const calls = [];
  const connector = new NotionConnector({ auth, account: { id: 'workspace:user' }, now, fetchImpl: async (value) => {
    const url = new URL(value); calls.push(url);
    if (url.pathname.endsWith('/search')) return json({ results: [{ object: 'page', id, last_edited_time: '2026-10-30T00:00:00Z', properties: {} }], has_more: false });
    const text = url.pathname.includes(child) ? 'Nested text' : url.searchParams.get('start_cursor') ? 'Second page' : 'First page';
    return json({ results: [{ id: url.pathname.includes(child) ? id : child, type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] }, has_children: text === 'First page' }], ...(text === 'First page' ? { has_more: true, next_cursor: 'blocks2' } : { has_more: false }) });
  } });
  const result = await connector.pull(); assert.equal(result.partial, false);
  assert.match(result.events[0].payload.content, /First page[\s\S]*Second page[\s\S]*Nested text/);
  assert.ok(calls.some(url => url.searchParams.get('start_cursor') === 'blocks2'));
});

test('Slack follows a new reply whose old root is outside the next history window', async () => {
  let second = false, replyCalls = 0;
  const connector = new SlackConnector({ auth, account: { id: 'T123:U123' }, now: () => now() + (second ? 60000 : 0), fetchImpl: async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('/conversations.list')) return json({ ok: true, channels: [{ id: 'D123', is_im: true }] });
    if (url.pathname.endsWith('/users.info')) return json({ ok: true, user: { real_name: 'Alex' } });
    if (url.pathname.endsWith('/conversations.replies')) { replyCalls++; return json({ ok: true, messages: second ? [{ user: 'U456', ts: '1793491201.000001', thread_ts: '1793400000.000001', text: 'A new thread reply' }] : [] }); }
    if (url.searchParams.get('latest') === url.searchParams.get('oldest')) return json({ ok: true, messages: [{ user: 'U456', ts: url.searchParams.get('oldest'), text: 'Original root', reply_count: 1 }] });
    return json({ ok: true, messages: second ? [] : [{ user: 'U456', ts: '1793400000.000001', text: 'Original root', reply_count: 1 }] });
  } });
  const first = await connector.pull(); second = true;
  const next = await connector.pull({ cursor: first.cursor }); assert.equal(next.partial, false); assert.equal(replyCalls, 2);
  assert.ok(next.events.some(event => event.payload.body === 'A new thread reply'));
});

test('editing away the grounded request blocks the previously prepared action without claiming cancellation', t => {
  const state = store(t), engine = new WorkEngine(state); engine.ingest(email('r1'));
  const task = Object.values(state.state.tasks)[0]; task.draft = { body: 'Old draft' };
  engine.ingest(email('r2', 'For information only: previous notes.'));
  assert.equal(state.state.inbox.length, 1); assert.ok(task.sourceUnavailable); assert.equal(task.draft, null); assert.notEqual(task.status, 'completed');
});


test('Slack distribution metadata accepts no secret but rejects a pasted user token in the optional secret field', () => {
  assert.deepEqual(publicClientConfiguration({ slack: { clientId: '12345.67890' } }), { slack: { clientId: '12345.67890' } });
  assert.throws(() => publicClientConfiguration({ slack: { clientId: '12345.67890', clientSecret: 'xoxp-private-user-token' } }), /Secret/);
});


test('SQLite ingests distinct revisions, replays idempotently after restart, and keeps forgotten deliveries forgotten', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-revision-sqlite-'));
  let state, engine, runtime;
  const open = () => { state = new SqliteStore(path.join(directory, 'state.json')); engine = new WorkEngine(state); runtime = new DurableRuntime(engine, { tickMs: 100000 }); };
  const close = async () => { await runtime.close(); await engine.whenSettled(); state.close(); };
  t.after(async () => { if (!state.closed) await close(); fs.rmSync(directory, { recursive: true, force: true }); });
  open();
  const first = email('r1', 'A plain context observation.'), edited = email('r2', 'A revised plain context observation.');
  engine.ingest(first); const updated = engine.ingest(edited); await engine.whenSettled();
  assert.equal(updated.duplicate, false); assert.equal(state.state.inbox.length, 1); assert.equal(state.state.inbox[0].body, edited.payload.body);
  assert.equal(state.db.prepare('SELECT COUNT(*) count FROM durable_inbox WHERE provider=?').get('slack').count, 2);
  const rows = state.db.prepare('SELECT event_json FROM durable_inbox ORDER BY received_at,id').all();
  assert.deepEqual(new Set(rows.map(row => JSON.parse(row.event_json).providerRevision)), new Set(['r1', 'r2']));
  await close(); open(); assert.equal(engine.ingest(edited).duplicate, true);
  const third = email('r3', 'The third context revision.'); assert.equal(engine.ingest(third).duplicate, false); await engine.whenSettled();
  assert.equal(state.state.inbox[0].body, third.payload.body);
  await runtime.privacy.forget({ kind: 'event', id: third.id });
  assert.equal(engine.ingest(third).disposition, 'forgotten');
});
