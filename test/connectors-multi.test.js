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

test('reserved external record identifiers cannot mutate record prototypes or advance state', t => {
  const state = store(t), engine = new WorkEngine(state), revision = state.state.revision;
  for (const type of ['document.modified', 'document.unavailable', 'record.published']) {
    for (const id of ['__proto__', 'constructor', 'prototype', { nested: 'id' }]) {
      assert.throws(() => engine.ingest({ id: `invalid-${type}-${JSON.stringify(id)}`, type,
        payload: { id, title: 'Untrusted source', content: 'Actual text', completedAt: '2026-10-26T10:00:00Z' } }), /record identifier/);
    }
  }
  assert.equal(state.state.revision, revision);
  assert.deepEqual(state.state.documents, {});
  assert.deepEqual(state.state.runRecords, {});
  assert.equal(Object.getPrototypeOf(state.state.documents), Object.prototype);
  engine.ingest({ id: 'valid-inherited-name', type: 'document.modified', payload: { id: 'toString', title: 'Provider identifier', content: 'Source text' } });
  assert.equal(Object.hasOwn(state.state.documents, 'toString'), true);
  assert.equal(state.state.documents.toString.content, 'Source text');
  assert.equal(Object.getPrototypeOf(state.state.documents), Object.prototype);
});

test('Outlook HTML fallback extracts source text with quoted tags, comments, raw text and entities', async () => {
  const connector = new OutlookConnector({ auth, account: { id: 'ms', label: 'reader@example.test' }, fetchImpl: async () => json({
    value: [{ id: 'mail', subject: 'Plan', from: { emailAddress: { address: 'sender@example.test' } }, receivedDateTime: '2026-10-26T10:00:00Z',
      body: { contentType: 'html', content: '<style>hidden</style><p title="1 > 0">Send the plan &amp; costs.</p><!-- secret > --><script>bad()</script><div>&lt;literal&gt; &#x96EA; &#38634; &#x110000;</div>' } }],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?token=fixture'
  }) });
  const result = await connector.pull(), body = result.events[0].payload.body;
  assert.match(body, /Send the plan & costs\./);
  assert.match(body, /<literal> 雪 雪 &#x110000;/);
  assert.doesNotMatch(body, /hidden|secret|bad\(\)|title=/);
});

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

test('Outlook resets an expired delta cursor without losing the outage window or trusting Location', async () => {
  const calls = [];
  const connector = new OutlookConnector({ auth, account: { id: 'ms-user', label: 'reader@example.test' }, fetchImpl: async url => {
    calls.push(url);
    if (calls.length === 1) return new Response(JSON.stringify({ error: { code: 'syncStateNotFound', message: 'private' } }), { status: 410, headers: { location: 'https://attacker.test/steal' } });
    return json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=next' });
  } });
  const result = await connector.pull({ cursor: { resumeUrl: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired' } });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).origin, 'https://graph.microsoft.com');
  assert.equal(new URL(calls[1]).searchParams.has('$filter'), false);
  assert.equal(result.cursor.recovering, true);
  assert.match(result.cursor.resumeUrl, /skiptoken=next/);
});

test('Outlook preserves the old checkpoint on failed recovery and does not reset permission failures', async () => {
  let calls = 0;
  const connector = new OutlookConnector({ auth, account: { id: 'ms-user', label: 'reader@example.test' }, fetchImpl: async () => {
    calls++;
    return new Response('{}', { status: calls === 1 ? 410 : 503 });
  } });
  const cursor = { resumeUrl: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired' };
  await assert.rejects(connector.pull({ cursor }), error => error.status === 503);
  assert.equal(calls, 2);
  calls = 0;
  connector.fetchImpl = async () => { calls++; return new Response('{}', { status: 403 }); };
  await assert.rejects(connector.pull({ cursor }), error => error.status === 403);
  assert.equal(calls, 1);
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

test('GitHub pull request reviews, repository commits and Actions runs become native work without copying file patches', async t => {
  const sha = 'a'.repeat(40);
  const pull = { id: 90, number: 3, title: 'Review the retry policy', body: 'Please review the change.', state: 'open', updated_at: '2026-10-26T12:00:00Z',
    user: { login: 'author' }, repository_url: 'https://api.github.com/repos/team/project', html_url: 'https://github.com/team/project/pull/3' };
  const commit = { sha, html_url: `https://github.com/team/project/commit/${sha}`, commit: { message: 'Adjust the retry boundary\n\nMore context', author: { date: '2026-10-26T12:05:00Z' } },
    author: { login: 'author' }, files: [{ filename: 'src/retry.js', patch: 'SECRET_PATCH_DO_NOT_STORE' }] };
  const run = { id: 55, name: 'CI', status: 'completed', conclusion: 'failure', updated_at: '2026-10-26T12:06:00Z', head_branch: 'main', event: 'push',
    triggering_actor: { login: 'author' }, html_url: 'https://github.com/team/project/actions/runs/55' };
  const connector = new GitHubConnector({ auth, account, now: () => Date.parse('2026-10-26T13:00:00Z'), fetchImpl: async url => {
    if (url.includes('/search/issues')) return json(url.includes('review-requested') ? { items: [pull] } : { items: [] });
    if (url.includes('/user/repos')) return json([{ full_name: 'team/project', default_branch: 'main', pushed_at: '2026-10-26T12:05:00Z' }]);
    if (url.includes(`/commits/${sha}`)) return json(commit);
    if (url.includes('/commits?')) return json([commit]);
    if (url.includes('/actions/runs')) return json({ workflow_runs: [run] });
    if (url.includes('/issues?')) return json([]);
    return json(pull);
  } });
  const result = await connector.pull();
  const kinds = Object.fromEntries(result.events.map(event => [event.type, event]));
  assert.equal(kinds['pull_request.updated'].payload.work, 'review_requested');
  assert.equal(kinds['content.changed'].payload.files[0], 'src/retry.js');
  assert.equal(kinds['workflow.updated'].payload.conclusion, 'failure');
  assert.doesNotMatch(JSON.stringify(result.events), /SECRET_PATCH_DO_NOT_STORE/);
  const state = store(t); bindConnectionAccount(state, 'github', '123'); const engine = new WorkEngine(state);
  for (const event of result.events) engine.ingest(event);
  const tasks = Object.values(state.state.tasks);
  assert.deepEqual(tasks.map(task => task.kind).sort(), ['external_change', 'external_check', 'external_review']);
  assert.equal(tasks.every(task => task.status === 'waiting_for_information' && task.action == null), true);
  assert.equal(state.state.outbox.length, 0);
  connector.fetchImpl = async url => {
    if (url.includes('/search/issues') || url.includes('/user/repos')) return json(url.includes('/search/') ? { items: [] } : []);
    if (url.includes('/issues?')) return json([]);
    return json({ ...pull, state: 'closed', merged: true, updated_at: '2026-10-26T12:30:00Z', requested_reviewers: [] });
  };
  const withdrawn = await connector.pull({ cursor: result.cursor });
  engine.ingest(withdrawn.events.find(event => event.type === 'pull_request.updated'));
  assert.equal(state.state.tasks['review:github:123:pr:90'].status, 'cancelled');
  assert.equal(state.state.tasks['change:github:123:commit:' + sha].status, 'waiting_for_information');
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
