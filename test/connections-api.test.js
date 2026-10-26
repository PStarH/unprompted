import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnectedFixture } from './fixtures/connected-workspace.mjs';
import { waitFor } from './fixtures/google-workspace.mjs';
const get = (base, path) => fetch(base + path).then(response => response.json());
const post = (base, path, data = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

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
