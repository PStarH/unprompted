import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emailPrincipalRole, simpleMailboxList, structuredPrincipalRole } from '../src/connectors/principal-role.js';
import { OutlookConnector } from '../src/connectors/outlook.js';
import { GoogleWorkspaceConnector } from '../src/connectors/google.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { JsonStore } from '../src/store.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const recipient = address => ({ emailAddress: { address } });
const body = 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.';

test('recipient attribution is conservative about groups, aliases and incomplete metadata', () => {
  const role = (to, cc) => emailPrincipalRole('Reader@example.test', to, cc).principalRole;
  assert.equal(role(['reader@example.test'], []), 'DIRECT_ACTOR');
  assert.equal(role(['other@example.test'], ['reader@example.test']), 'PASSIVE_OBSERVER');
  assert.equal(role(['reader@example.test', 'other@example.test'], []), 'SHARED_GROUP');
  assert.equal(role(['alias@example.test'], []), 'UNKNOWN');
  assert.equal(role(['reader@example.test'], null), 'UNKNOWN');
  assert.equal(role(simpleMailboxList('Reader <reader@example.test>, "Doe, Jane" <jane@example.test>'), []), 'UNKNOWN');
});

test('structured provider assignment and mention can name a direct role, and group membership does not override one', () => {
  const account = 'reader@example.test';
  const assigned = structuredPrincipalRole({ account, to: ['other@example.test'], cc: [account], assignedAccount: account });
  assert.equal(assigned.principalRole, 'DIRECT_ACTOR');
  assert.equal(assigned.roleEvidence.basis, 'provider_assignment');
  assert.equal(structuredPrincipalRole({ account, to: ['other@example.test'], cc: [account], mentionedAccounts: [account] }).roleEvidence.basis, 'provider_mention');
  assert.equal(structuredPrincipalRole({ account, to: [account], cc: [], groupMemberIds: [account] }).principalRole, 'DIRECT_ACTOR');
  assert.equal(structuredPrincipalRole({ account, to: ['other@example.test'], cc: [account], groupMemberIds: [account] }).principalRole, 'SHARED_GROUP');
  assert.equal(structuredPrincipalRole({ account, to: ['other@example.test'], cc: [account] }).principalRole, 'PASSIVE_OBSERVER');
});

test('Outlook recipients control new task discovery and remain durable across restart', async t => {
  const records = [
    { id: 'cc', toRecipients: [recipient('other@example.test')], ccRecipients: [recipient('reader@example.test')] },
    { id: 'group', toRecipients: [recipient('reader@example.test'), recipient('other@example.test')], ccRecipients: [] },
    { id: 'direct', toRecipients: [recipient('reader@example.test')], ccRecipients: [] }
  ].map(item => ({ ...item, conversationId: item.id, subject: 'Cedar proposal', from: recipient('alex@example.test'), receivedDateTime: '2026-10-26T10:00:00Z', body: { contentType: 'text', content: body } }));
  const connector = new OutlookConnector({ auth: { accessToken: async () => 'token' }, account: { id: 'reader', label: 'reader@example.test' }, fetchImpl: async () => json({ value: records, '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?token=fixture' }) });
  const { events } = await connector.pull();
  assert.deepEqual(events.map(event => event.meta.principalRole), ['PASSIVE_OBSERVER', 'SHARED_GROUP', 'DIRECT_ACTOR']);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'principal-role-'));
  const filename = path.join(directory, 'state.json');
  let store = new SqliteStore(filename), engine = new WorkEngine(store), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  for (const event of events) engine.ingest(event);
  await engine.whenSettled();
  assert.equal(Object.keys(store.state.tasks).length, 1);
  assert.equal(store.state.events[0].rejection.code, 'responsibility_not_established');
  assert.equal(engine.retryPendingReasoning().discoveries, 0);
  await runtime.close(); await engine.whenSettled(); store.close();
  store = new SqliteStore(filename); engine = new WorkEngine(store); runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.state.events[0].meta.principalRole, 'PASSIVE_OBSERVER');
  assert.equal(JSON.parse(store.db.prepare('SELECT event_json FROM durable_inbox WHERE id=?').get(events[0].id).event_json).meta.roleEvidence.basis, 'cc_recipient');
  assert.equal(Object.keys(store.state.tasks).length, 1);
});

test('trusted withdrawal is processed before the passive-recipient discovery gate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'principal-cancel-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const engine = new WorkEngine(store);
  const message = { threadId: 'thread', from: 'alex@example.test', subject: 'Cedar proposal', body, to: 'reader@example.test', cc: 'other@example.test', receivedAt: '2026-10-26T10:00:00Z' };
  engine.ingest({ id: 'initial', type: 'email.received', payload: { ...message, id: 'initial' }, meta: { principalRole: 'DIRECT_ACTOR' } });
  const result = engine.ingest({ id: 'withdrawal', type: 'email.received', payload: { ...message, id: 'withdrawal', to: 'other@example.test', cc: 'reader@example.test', body: 'Please cancel the Cedar proposal request.', receivedAt: '2026-10-26T11:00:00Z' }, meta: { principalRole: 'PASSIVE_OBSERVER' } });
  assert.equal(result.disposition, 'request_withdrawn');
  assert.equal(Object.values(store.state.tasks)[0].status, 'cancelled');
});

test('an unknown recipient role cannot use preauthorization without individual approval', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'principal-unknown-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const engine = new WorkEngine(store);
  engine.ingest({ id: 'unknown', type: 'email.received', payload: { id: 'unknown', from: 'alex@example.test', subject: 'Cedar proposal', body }, meta: { principalRole: 'UNKNOWN' } });
  const task = Object.values(store.state.tasks)[0];
  assert.ok(task);
  assert.throws(() => engine.executePreAuthorized(task.id), { code: 'REVIEW_REQUIRED' });
});

test('Gmail preserves CC and derives its role from the configured account', async () => {
  const fetchImpl = async url => {
    if (url.includes('/history?')) return json({ history: [{ messages: [{ id: 'm1' }] }], historyId: 'h2' });
    if (url.includes('/messages/m1?')) return json({ id: 'm1', threadId: 't1', payload: { headers: [
      { name: 'From', value: 'alex@example.test' }, { name: 'To', value: 'other@example.test' },
      { name: 'Cc', value: 'reader@example.test' }, { name: 'Subject', value: 'Cedar proposal' }, { name: 'Auto-Submitted', value: 'auto-replied' }
    ], mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const connector = new GoogleWorkspaceConnector({ auth: { headers: async () => ({ authorization: 'Bearer token' }) }, config: { accountEmail: 'reader@example.test', readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.events[0].payload.cc, 'reader@example.test');
  assert.equal(result.events[0].meta.principalRole, 'PASSIVE_OBSERVER');
  assert.equal(result.events[0].meta.originClass, 'AUTOMATION');
});

test('an automated response cannot create a task even when addressed directly to the user', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'principal-automation-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const engine = new WorkEngine(store);
  const result = engine.ingest({ id: 'auto', type: 'email.received', payload: { id: 'auto', from: 'alex@example.test', subject: 'Cedar proposal', body }, meta: { principalRole: 'DIRECT_ACTOR', originClass: 'AUTOMATION' } });
  assert.equal(result.disposition, 'context_only');
  assert.equal(store.state.events[0].rejection.code, 'automated_response');
  assert.equal(Object.keys(store.state.tasks).length, 0);
});
