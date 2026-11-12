import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConnectedFixture } from './fixtures/connected-workspace.mjs';
import { waitFor } from './fixtures/google-workspace.mjs';
const get = (base, path) => fetch(base + path).then(response => response.json());
const post = (base, path, data = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
async function connectMicrosoft(fixture, options = {}) {
  const response = await post(fixture.base, '/api/setup/connections/microsoft/authorize', options);
  assert.equal(response.status, 200);
  const pending = await response.json();
  const authorize = new URL(pending.oauth.authorizeUrl);
  fixture.controls.microsoftAuthorized = true;
  fixture.controls.microsoftDrafts = authorize.searchParams.get('scope').split(/\s+/).includes('Mail.ReadWrite');
  const callback = new URL(authorize.searchParams.get('redirect_uri'));
  callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', authorize.searchParams.get('state'));
  assert.equal((await fetch(callback)).status, 200);
}

test('artifact grants require provider write consent and an explicit destination, enable only creation, and revoke immediately', { timeout: 25000 }, async t => {
  const fixture = await startConnectedFixture(); t.after(fixture.close);
  const { base } = fixture;
  const input = { connectorId: 'microsoft', targetId: 'drafts', confirmed: true };
  assert.equal((await post(base, '/api/artifact-grants', input)).status, 403);
  await connectMicrosoft(fixture);
  await waitFor(() => get(base, '/api/setup'), value => value.connections.microsoft.connected && !value.monitoring.running, 12000);
  assert.equal((await post(base, '/api/artifact-grants', input)).status, 403);
  await connectMicrosoft(fixture, { drafts: true });
  await waitFor(() => get(base, '/api/setup'), value => value.connections.microsoft.oauth.phase === 'connected' && value.artifacts.targets.some(target => target.connectorId === 'microsoft' && target.available), 12000);
  assert.equal((await post(base, '/api/artifact-grants', { ...input, confirmed: false })).status, 403);
  const response = await post(base, '/api/artifact-grants', input);
  assert.equal(response.status, 200, await response.clone().text());
  const granted = await response.json();
  assert.equal(granted.grant.accountId, 'ms-a');
  assert.equal(granted.setup.artifacts.enabled, true);
  assert.equal(granted.setup.connections.microsoft.readOnly, false);
  assert.equal(granted.setup.google.allowExternalWrites, false);
  assert.equal((await get(base, '/api/artifact-grants')).grants[0].id, granted.grant.id);
  assert.equal((await post(base, `/api/artifact-grants/${granted.grant.id}/revoke`)).status, 200);
  const after = await get(base, '/api/setup');
  assert.equal(after.connections.microsoft.readOnly, true);
  assert.equal(after.artifacts.grants[0].status, 'revoked');
  assert.equal(fixture.calls.some(call => /\/send$/.test(call.path)), false);
});

test('a real selected local folder works without cloud credentials and revoking it removes current evidence', { timeout: 20_000 }, async t => {
  const fixture = await startConnectedFixture(); t.after(fixture.close);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-local-api-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selected = path.join(dir, 'Work'); fs.mkdirSync(selected); fs.writeFileSync(path.join(selected, 'plan.md'), '- [ ] Call the supplier\nActual local context');
  const connect = await post(fixture.base, '/api/setup/local-sources/local_files/select', { path: selected, observe: true });
  assert.equal(connect.status, 200, await connect.clone().text());
  const setup = await waitFor(() => get(fixture.base, '/api/setup'), value => value.localSources.local_files.counts.tasks === 1 && !value.monitoring.running, 8000);
  assert.equal(setup.localSources.local_files.connected, true); assert.equal(setup.localSources.local_files.counts.documents, 1);
  assert.equal(setup.localSources.local_files.scopes[0].label, 'Work'); assert.doesNotMatch(JSON.stringify(setup), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const state = await get(fixture.base, '/api/state'), task = state.tasks.find(item => item.kind === 'observed_task');
  assert.equal(task.subject, 'Call the supplier'); assert.equal(state.inbox.length, 0); assert.equal(state.outbox.length, 0);
  const original = await fetch(task.externalSource.url); assert.equal(original.status, 200); assert.match(original.headers.get('content-type'), /text\/plain/); assert.match(await original.text(), /Actual local context/);
  fs.writeFileSync(path.join(selected, 'plan.md'), '- [x] Call the supplier\nActual local context');
  const sync = await post(fixture.base, '/api/connectors/sync'); assert.equal(sync.status, 200);
  const closed = await get(fixture.base, '/api/state'); assert.equal(closed.tasks.find(item => item.id === task.id).status, 'cancelled'); assert.equal(closed.tasks.filter(item => item.status === 'completed').length, 0);
  const removed = await post(fixture.base, '/api/setup/local-sources/local_files/remove-scope', { index: 0 }); assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await get(fixture.base, '/api/setup')).localSources.local_files.connected, false);
  assert.equal((await get(fixture.base, '/api/state')).documents.find(item => item.id === task.documentId).available, false);
  assert.equal((await fetch(task.externalSource.url)).status, 404);
});

test('GitHub and Outlook authorization activate together, preserve read-only routing, and disconnect independently', { timeout: 25_000 }, async t => {
  const fixture = await startConnectedFixture(); t.after(fixture.close);
  const { base } = fixture;
  const processId = (await get(base, '/api/health')).processId;
  const model = await post(base, '/api/setup/model', { baseUrl: fixture.endpoint + '/model/v1', model: 'scripted-fixture' });
  assert.equal(model.status, 200, await model.text());
  const response = await post(base, '/api/setup/connections/github/authorize'); assert.equal(response.status, 200);
  const pending = await response.json(); assert.ok(pending.oauth.userCode); assert.doesNotMatch(JSON.stringify(pending), /PRIVATE_/);
  fixture.controls.githubAuthorized = true;
  await connectMicrosoft(fixture);
  const setup = await waitFor(() => get(base, '/api/setup'), value => value.connections.github.connected && value.connections.microsoft.connected
    && !value.monitoring.running && !value.workspace.reasoning.pending && value.connections.microsoft.counts.tasks === 1, 15_000);
  assert.equal(setup.workspace.ready, true); assert.equal(setup.google.configuredThisRun, false);
  assert.equal(setup.connections.github.counts.issues, 1); assert.equal(setup.connections.microsoft.counts.messages, 1);
  const state = await get(base, '/api/state');
  assert.equal(state.tasks.length, 2); assert.ok(state.tasks.some(task => task.kind === 'external_issue'));
  assert.ok(state.tasks.some(task => task.sourceConnectorId === 'microsoft'));
  assert.equal(state.outbox.length, 0); assert.equal((await get(base, '/api/health')).processId, processId);
  assert.doesNotMatch(JSON.stringify({ setup, state }), /PRIVATE_|accessToken|refreshToken/);
  const forgotten = await post(base, '/api/setup/connections/github/forget'); assert.equal(forgotten.status, 200);
  const after = await get(base, '/api/setup');
  assert.equal(after.connections.github.connected, false); assert.equal(after.connections.github.authorized, false);
  assert.equal(after.connections.github.configured, true); assert.equal(after.connections.microsoft.connected, true);
  assert.equal(after.monitoring.enabled, true, 'disconnecting GitHub keeps Outlook observation running');
  assert.equal((await get(base, '/api/state')).tasks.find(task => task.kind === 'external_issue').status, 'cancelled');
});

test('a local source update is delivered through the workspace event stream', { timeout: 20000 }, async t => {
  const fixture = await startConnectedFixture(); t.after(fixture.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-stream-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const selected = fs.realpathSync(directory), file = path.join(selected, 'notes.md');
  fs.writeFileSync(file, 'A note without a task.');
  assert.equal((await post(fixture.base, '/api/setup/local-sources/local_files/select', { path: selected, observe: false })).status, 200);
  await waitFor(() => get(fixture.base, '/api/setup'), value => !value.monitoring.running && value.monitoring.lastOutcome, 8000);
  const response = await fetch(fixture.base + '/api/stream');
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  try {
    await reader.read();
    fs.writeFileSync(file, '- [ ] Follow up with the supplier');
    assert.equal((await post(fixture.base, '/api/connectors/sync')).status, 200);
    let buffer = '', found = false;
    for (let i = 0; i < 15 && !found; i++) {
      const chunk = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('No source update in the stream.')), 3000))]);
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: true });
      const frames = buffer.split('\n\n'); buffer = frames.pop();
      for (const frame of frames) {
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data && JSON.parse(data.slice(6)).tasks?.some(task => task.subject === 'Follow up with the supplier')) found = true;
      }
    }
    assert.equal(found, true);
  } finally { await reader.cancel(); }
});


test('Todoist personal token connects the native observer, stays private and disconnects independently', { timeout: 30000 }, async t => {
  const fixture = await startConnectedFixture(); t.after(fixture.close);
  const response = await post(fixture.base, '/api/setup/connections/todoist/authorize', { token: 'personal_fixture_token', observe: false });
  assert.equal(response.status, 200, await response.clone().text());
  const setup = await waitFor(() => get(fixture.base, '/api/setup'), value => value.connections.todoist.connected && value.connections.todoist.counts.tasks === 1, 8000);
  assert.equal(setup.connections.todoist.account.label, 'todoist@example.test');
  assert.doesNotMatch(JSON.stringify(setup), /personal_fixture_token/);
  const state = await get(fixture.base, '/api/state');
  const task = state.tasks.find(item => item.sourceConnectorId === 'todoist' && item.subject === 'Inspect retry policy');
  assert.ok(task);
  const document = state.documents.find(item => item.id === task.documentId);
  assert.equal(document.sourceObservationRevision, 1);
  assert.equal(state.outbox.length, 0);
  fixture.controls.todoistContent = 'Inspect retry policy again';
  fixture.controls.todoistUpdatedAt = '2026-10-26T10:00:00.000Z';
  assert.equal((await post(fixture.base, '/api/connectors/sync')).status, 200);
  const changed = await waitFor(() => get(fixture.base, '/api/state'), value => value.tasks.find(item => item.id === task.id)?.externalSource?.sourceObservationRevision === 2, 8000);
  const changedDocument = changed.documents.find(item => item.id === task.documentId);
  assert.equal(changed.tasks.find(item => item.id === task.id).subject, 'Inspect retry policy again');
  assert.equal(changedDocument.sourceObservationRevision, 2);
  const revoke = await post(fixture.base, '/api/privacy/revoke', { connectorId: 'todoist' });
  assert.equal(revoke.status, 200, await revoke.clone().text());
  const held = await get(fixture.base, '/api/state');
  const heldTask = held.tasks.find(item => item.id === task.id);
  assert.equal(heldTask.control?.pauseReason, 'permission_revoked');
  assert.equal(heldTask.externalSource.sourceObservationRevision, 2);
  const resumedResponse = await post(fixture.base, '/api/setup/connections/todoist/authorize', { token: 'personal_fixture_token', observe: false });
  assert.equal(resumedResponse.status, 200, await resumedResponse.clone().text());
  const resumed = await waitFor(() => get(fixture.base, '/api/state'), value => {
    const current = value.tasks.find(item => item.id === task.id);
    const mirrored = value.documents.find(item => item.id === task.documentId);
    return current?.externalSource?.sourceObservationRevision === 1 && mirrored?.sourceObservationRevision === 1 && mirrored.version > changedDocument.version;
  }, 8000);
  const resumedDocuments = resumed.events.filter(event => event.summary === 'Document changed · Inspect retry policy again' || String(event.summary || '').startsWith('Stale revision of Inspect retry policy again'));
  assert.equal(resumedDocuments.at(-1).summary, 'Document changed · Inspect retry policy again');
  assert.notEqual(resumedDocuments.at(-1).disposition, 'stale_change');
  assert.notEqual(resumed.events.filter(event => event.summary === 'Explicit local to-do · Inspect retry policy again').at(-1).disposition, 'stale_change');
  assert.notEqual(resumed.tasks.find(item => item.id === task.id).control?.pauseReason, 'permission_revoked');
  assert.equal((await post(fixture.base, '/api/setup/connections/todoist/forget')).status, 200);
  assert.equal((await get(fixture.base, '/api/setup')).connections.todoist.connected, false);
  const again = await post(fixture.base, '/api/setup/connections/todoist/authorize', { token: 'personal_fixture_token', observe: false });
  assert.equal(again.status, 200, await again.clone().text());
  const restored = await waitFor(() => get(fixture.base, '/api/setup'), value => value.connections.todoist.connected && value.connections.todoist.counts.tasks === 1, 8000);
  assert.equal(restored.connections.todoist.account.label, 'todoist@example.test');
  assert.doesNotMatch(JSON.stringify(restored), /personal_fixture_token/);
  const after = await get(fixture.base, '/api/state');
  const restoredTask = after.tasks.find(item => item.id === task.id);
  assert.ok(restoredTask);
  assert.equal(restoredTask.subject, 'Inspect retry policy again');
  assert.notEqual(restoredTask.status, 'cancelled');
  assert.notEqual(restoredTask.control?.pauseReason, 'permission_revoked');
  assert.ok(restoredTask.externalSource.sourceObservationRevision <= 1);
  assert.ok(after.documents.find(item => item.id === task.documentId).sourceObservationRevision <= 1);
  assert.equal(after.outbox.length, 0);
});
