import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitHubConnector } from '../src/connectors/github.js';
import { OutlookConnector } from '../src/connectors/outlook.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { bindConnectionAccount } from '../src/external-work.js';
import { SourceDeliveryRouter, ReadOnlyDeliveryProvider } from '../src/providers.js';
import { PermissionPolicy } from '../src/permissions.js';
import { buildScenario } from '../src/connectors/simulated.js';

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const auth = { accessToken: async () => 'PRIVATE_ACCOUNT_TOKEN' };
const account = { id: '123', login: 'reader', label: 'reader' };
const issue = (patch = {}) => ({ id: 4, number: 7, title: 'Investigate retry behavior', body: 'A real assigned issue.', repository: { full_name: 'team/project' },
  updated_at: '2026-10-26T10:00:00Z', state: 'open', user: { login: 'reporter' }, assignees: [{ id: 123, login: 'reader' }], ...patch });
function store(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-multi-source-')); const result = new JsonStore(path.join(directory, 'state.json'));
  t.after(() => { result.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return result; }

test('GitHub creates native assigned-issue events and follows reassignment without inventing mail or completion', async t => {
  let reassign = false;
  const connector = new GitHubConnector({ auth, account, fetchImpl: async url => url.includes('/issues?')
    ? json(reassign ? [] : [issue()]) : json(issue({ assignees: [], updated_at: '2026-10-26T10:01:00Z' })) });
  const first = await connector.pull(); assert.equal(first.events[0].type, 'issue.updated'); assert.equal(first.events[0].source, 'github');
  const state = store(t); bindConnectionAccount(state, 'github', '123');
  const engine = new WorkEngine(state); engine.ingest(first.events[0]);
  const task = Object.values(state.state.tasks)[0]; assert.equal(task.kind, 'external_issue'); assert.equal(state.state.inbox.length, 0);
  assert.equal(task.status, 'waiting_for_information'); assert.equal(task.draft, null);
  assert.equal(engine.ingest(first.events[0]).duplicate, true);
  reassign = true; const second = await connector.pull({ cursor: first.cursor }); engine.ingest(second.events[0]);
  assert.equal(task.id, Object.values(state.state.tasks)[0].id);
  assert.equal(state.state.tasks[task.id].status, 'cancelled'); assert.equal(state.state.tasks[task.id].action, null);
  assert.equal(state.state.outbox.length, 0); assert.equal(state.state.tasks[task.id].externalSource.assigned, false);
});

test('GitHub pagination keeps the original observation boundary and a failed pull cannot advance its cursor', async () => {
  const items = Array.from({ length: 100 }, (_, index) => issue({ id: index + 1, number: index + 1 }));
  const connector = new GitHubConnector({ auth, account, fetchImpl: async () => json(items), now: () => Date.parse('2026-10-26T11:00:00Z') });
  const first = await connector.pull(); assert.equal(first.cursor.page, 2); assert.equal(first.cursor.since, null);
  assert.equal(first.cursor.window, '2026-10-26T11:00:00.000Z');
  connector.fetchImpl = async () => { throw new Error('private transport diagnostic'); };
  await assert.rejects(connector.pull({ cursor: first.cursor }), error => !error.message.includes('private transport diagnostic'));
});

test('a local dismissal survives a new issue revision and source closure is not a verified agent result', async t => {
  const connector = new GitHubConnector({ auth, account, fetchImpl: async () => json([issue()]) });
  const state = store(t); bindConnectionAccount(state, 'github', '123'); const engine = new WorkEngine(state);
  const first = await connector.pull(); engine.ingest(first.events[0]); const id = Object.keys(state.state.tasks)[0];
  engine.cancel(id);
  connector.fetchImpl = async () => json([issue({ title: 'Updated title', updated_at: '2026-10-26T10:02:00Z' })]);
  engine.ingest((await connector.pull()).events[0]); assert.equal(state.state.tasks[id].status, 'cancelled');
  engine.reopen(id); assert.equal(state.state.tasks[id].status, 'waiting_for_information');
  connector.fetchImpl = async () => json([issue({ state: 'closed', updated_at: '2026-10-26T10:03:00Z' })]);
  engine.ingest((await connector.pull()).events[0]);
  assert.equal(state.state.tasks[id].status, 'cancelled'); assert.equal(state.state.tasks[id].action, null);
});

test('Outlook consumes Graph delta links with account-namespaced IDs and refuses foreign continuations', async () => {
  const calls = [];
  const connector = new OutlookConnector({ auth, account: { id: 'ms-user', label: 'reader@example.test' }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json({ value: [{ id: 'mail-1', conversationId: 'thread', subject: 'Cedar proposal',
      from: { emailAddress: { address: 'alex@example.test' } }, receivedDateTime: '2026-10-26T10:00:00Z',
      body: { contentType: 'text', content: 'Please update the Cedar proposal to include sample size and conclusion and send it back.' } }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=checkpoint' });
  } });
  const result = await connector.pull(); assert.equal(result.events[0].source, 'microsoft');
  assert.equal(result.events[0].payload.id, 'microsoft:ms-user:mail-1'); assert.match(calls[0].options.headers.Prefer, /ImmutableId/);
  await assert.rejects(connector.pull({ cursor: { resumeUrl: 'https://evil.example.test/stolen' } }), /invalid/);
  assert.equal(calls.length, 1, 'an untrusted continuation must never receive the bearer token');
});

test('an Outlook request cannot be delivered through a writable Gmail adapter', t => {
  const state = store(t); let gmailWrites = 0;
  const gmail = { kind: 'gmail', live: true, canSend: true, send() { gmailWrites++; }, lookup: () => ({ status: 'not_found' }) };
  const provider = new SourceDeliveryRouter({ google: gmail, microsoft: new ReadOnlyDeliveryProvider('outlook') });
  const engine = new WorkEngine(state, { provider, policy: new PermissionPolicy({ shadow: false }), reasoner: { available: () => false } });
  for (const { event } of buildScenario(Date.now())) engine.ingest(event.type === 'email.received'
    ? { ...event, source: 'microsoft', connectorId: 'microsoft' } : event);
  const task = Object.values(state.state.tasks)[0]; assert.equal(task.status, 'ready_for_approval'); assert.equal(task.draft.providerKind, 'outlook');
  assert.equal(task.draft.canSend, false); assert.throws(() => engine.approve(task.id), /not enabled for this source/);
  assert.equal(gmailWrites, 0); assert.equal(task.action, null);
});

test('temporarily unavailable GitHub issues are rechecked and restored even when the provider revision did not change', async t => {
  let mode = 'initial';
  const connector = new GitHubConnector({ auth, account, fetchImpl: async url => {
    if (url.includes('/issues?')) return json(mode === 'initial' ? [issue()] : []);
    return mode === 'unavailable' ? new Response('{}', { status: 404 }) : json(issue());
  } });
  const state = store(t); bindConnectionAccount(state, 'github', '123'); const engine = new WorkEngine(state);
  const first = await connector.pull(); engine.ingest(first.events[0]); const id = Object.keys(state.state.tasks)[0];
  mode = 'unavailable'; const missing = await connector.pull({ cursor: first.cursor }); engine.ingest(missing.events[0]);
  assert.equal(state.state.tasks[id].status, 'cancelled'); assert.equal(Object.keys(missing.cursor.tracked).length, 1);
  mode = 'restored'; const restored = await connector.pull({ cursor: missing.cursor }); engine.ingest(restored.events[0]);
  assert.equal(state.state.tasks[id].status, 'waiting_for_information'); assert.equal(state.state.tasks[id].externalSource.state, 'open');
});
