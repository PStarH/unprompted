import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGoogleFixture, connectGoogle, waitFor } from './fixtures/google-workspace.mjs';
import { googleWorkspacePath } from '../src/setup.js';

const get = (base, route) => fetch(base + route).then(response => response.json());
const post = (base, route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function connectModel(fixture) {
  const response = await post(fixture.base, '/api/setup/model', { baseUrl: fixture.endpoint + '/model/v1', model: 'scripted-model', apiKey: 'PRIVATE_MODEL_KEY' });
  assert.equal(response.status, 200, await response.text());
}
async function settled(fixture) {
  return waitFor(() => get(fixture.base, '/api/setup'), value => !value.google.activating && !value.monitoring.running && !value.workspace.reasoning.pending && value.monitoring.lastOutcome);
}

test('real first use connects without restart, reads existing evidence immediately and never starts a sample', { timeout: 25_000 }, async t => {
  const fixture = await startGoogleFixture(); t.after(fixture.close);
  const processId = (await get(fixture.base, '/api/health')).processId;
  assert.equal((await get(fixture.base, '/api/runtime')).mode, 'setup');
  await connectModel(fixture);
  assert.equal((await get(fixture.base, '/api/state')).events.length, 0, 'connecting a model must not invent work');
  assert.equal((await post(fixture.base, '/api/demo/restart')).status, 409);
  assert.equal((await connectGoogle(fixture.base)).status, 200);
  const setup = await settled(fixture);
  assert.equal(setup.google.restartRequired, false);
  assert.equal(setup.google.accountEmail, 'reader-a@example.test');
  assert.deepEqual(setup.workspace.observed, { emails: 1, documents: 1, tasks: 1 });
  assert.equal(setup.monitoring.enabled, false, 'observe=false still performs exactly one first check');
  assert.equal(setup.google.allowExternalWrites, false);
  assert.equal((await get(fixture.base, '/api/health')).processId, processId);
  const state = await get(fixture.base, '/api/state');
  assert.ok(state.events.every(event => event.source === 'google'));
  assert.equal(state.tasks[0].status, 'ready_for_approval');
  assert.equal(state.tasks[0].modelReview.status, 'verified');
  assert.equal(state.tasks[0].draft.live, true, 'a real workspace must never label its draft as simulated');
  assert.equal(state.tasks[0].draft.providerKind, 'gmail');
  assert.equal((await post(fixture.base, `/api/tasks/${encodeURIComponent(state.tasks[0].id)}/approve`)).status, 403);
  assert.equal((await get(fixture.base, '/api/state')).outbox.length, 0);
  assert.doesNotMatch(JSON.stringify({ setup, state }), /PRIVATE_MODEL_KEY|PRIVATE_DESKTOP_CLIENT|PRIVATE_REFRESH|PRIVATE_ACCESS/);
});

test('account switches isolate work and restart restores the same account workspace', { timeout: 30_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-real-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fixture = await startGoogleFixture({ directory }); t.after(async () => fixture.close());
  await connectModel(fixture); await connectGoogle(fixture.base); await settled(fixture);
  const first = await get(fixture.base, '/api/state');
  await connectGoogle(fixture.base, { account: 'reader-b' }); await settled(fixture);
  const second = await get(fixture.base, '/api/state');
  assert.notEqual(first.runtime.workspaceId, second.runtime.workspaceId);
  assert.ok(second.inbox.every(message => message.id.includes('reader-b')));
  assert.ok(second.documents.every(document => document.id.includes('reader-b')));
  assert.ok(fs.existsSync(googleWorkspacePath(directory, 'reader-a')));
  assert.ok(fs.existsSync(googleWorkspacePath(directory, 'reader-b')));
  assert.equal((await post(fixture.base, '/api/setup/google/forget')).status, 200);
  assert.equal((await get(fixture.base, '/api/setup')).google.hasClient, true, 'reconnecting does not require creating another Cloud client');
  await connectGoogle(fixture.base, { account: 'reader-a' }); await settled(fixture);
  const restored = await get(fixture.base, '/api/state');
  assert.equal(restored.runtime.workspaceId, first.runtime.workspaceId);
  assert.equal(restored.tasks.length, first.tasks.length);
  await fixture.close();
  fixture = await startGoogleFixture({ directory });
  const restarted = await get(fixture.base, '/api/state');
  assert.equal(restarted.runtime.workspaceId, first.runtime.workspaceId);
  assert.equal(restarted.tasks.length, first.tasks.length);
  assert.ok(restarted.inbox.every(message => message.id.includes('reader-a')));
});

test('a failed Google API read shows a recoverable error and retry uses the saved authorization', { timeout: 20_000 }, async t => {
  const fixture = await startGoogleFixture(); t.after(fixture.close);
  await connectModel(fixture); fixture.controls.apiDisabled = true;
  await connectGoogle(fixture.base); let setup = await settled(fixture);
  assert.equal(setup.monitoring.lastOutcome, 'failure');
  assert.equal(setup.google.issue.code, 'GOOGLE_API_DISABLED');
  assert.equal(setup.workspace.observed.emails, 0);
  fixture.controls.apiDisabled = false;
  assert.equal((await post(fixture.base, '/api/connectors/sync')).status, 200);
  setup = await settled(fixture);
  assert.equal(setup.monitoring.lastOutcome, 'success');
  assert.equal(setup.google.issue, null);
  assert.equal(setup.workspace.observed.tasks, 1);
});

test('an unverified Google identity cannot persist a grant or activate a workspace', { timeout: 15_000 }, async t => {
  const fixture = await startGoogleFixture(); t.after(fixture.close);
  fixture.controls.identityVerified = false;
  assert.equal((await connectGoogle(fixture.base)).status, 400);
  const setup = await get(fixture.base, '/api/setup');
  assert.equal(setup.google.hasRefreshToken, false);
  assert.equal(setup.oauth.code, 'GOOGLE_IDENTITY_FAILED');
  assert.equal(setup.workspace.ready, false);
  assert.equal((await get(fixture.base, '/api/state')).events.length, 0);
});

test('Docs-only write authorization cannot turn a real reply into a simulated delivery', { timeout: 20_000 }, async t => {
  const fixture = await startGoogleFixture(); t.after(fixture.close); await connectModel(fixture);
  await connectGoogle(fixture.base, { scopes: { readGmail: true, readDrive: true, docsWrite: true }, allowExternalWrites: true });
  const setup = await settled(fixture);
  assert.equal(setup.google.allowExternalWrites, true);
  const state = await get(fixture.base, '/api/state');
  assert.equal(state.runtime.shadow, false);
  assert.equal(state.runtime.google.sendEnabled, false);
  assert.equal((await post(fixture.base, `/api/tasks/${encodeURIComponent(state.tasks[0].id)}/approve`)).status, 403);
  const after = await get(fixture.base, '/api/state');
  assert.equal(after.tasks[0].action, null);
  assert.equal(after.outbox.length, 0);
});
