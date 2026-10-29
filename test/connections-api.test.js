import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConnectedFixture } from './fixtures/connected-workspace.mjs';
import { waitFor } from './fixtures/google-workspace.mjs';
const get = (base, path) => fetch(base + path).then(response => response.json());
const post = (base, path, data = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

test('artifact grants require provider write consent and an explicit destination, enable only creation, and revoke immediately', { timeout: 25000 }, async t => {
  const fixture = await startConnectedFixture(); t.after(fixture.close);
  const { base } = fixture;
  const input = { connectorId: 'microsoft', targetId: 'drafts', confirmed: true };
  assert.equal((await post(base, '/api/artifact-grants', input)).status, 403);
  fixture.controls.microsoftAuthorized = true;
  assert.equal((await post(base, '/api/setup/connections/microsoft/authorize')).status, 200);
  await waitFor(() => get(base, '/api/setup'), value => value.connections.microsoft.connected && !value.monitoring.running, 12000);
  assert.equal((await post(base, '/api/artifact-grants', input)).status, 403);
  assert.equal((await post(base, '/api/setup/connections/microsoft/authorize', { drafts: true })).status, 200);
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

test('official device flows activate GitHub and Outlook together, preserve read-only routing, and disconnect independently', { timeout: 25_000 }, async t => {
  const fixture = await startConnectedFixture(); t.after(fixture.close);
  const { base } = fixture;
  const processId = (await get(base, '/api/health')).processId;
  const model = await post(base, '/api/setup/model', { baseUrl: fixture.endpoint + '/model/v1', model: 'scripted-fixture' });
  assert.equal(model.status, 200, await model.text());
  for (const id of ['github', 'microsoft']) {
    const response = await post(base, `/api/setup/connections/${id}/authorize`); assert.equal(response.status, 200);
    const pending = await response.json(); assert.ok(pending.oauth.userCode); assert.doesNotMatch(JSON.stringify(pending), /PRIVATE_/);
  }
  fixture.controls.githubAuthorized = true; fixture.controls.microsoftAuthorized = true;
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
