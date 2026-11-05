import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGoogleFixture, connectGoogle, waitFor } from './fixtures/google-workspace.mjs';

const post = (base, path, data = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
const get = (base, path) => fetch(base + path).then(async response => ({ status: response.status, body: await response.json() }));

test('a destination grant takes effect immediately and does not cancel a prepared draft', { timeout: 40_000 }, async t => {
  const fixture = await startGoogleFixture({ provisioned: true });
  t.after(() => fixture.close());
  fixture.controls.extraGrantedScopes = ['https://www.googleapis.com/auth/gmail.compose'];
  const model = await post(fixture.base, '/api/setup/model', { baseUrl: `${fixture.endpoint}/model/v1`, model: 'scripted-model' });
  assert.equal(model.status, 200, await model.clone().text());
  const callback = await connectGoogle(fixture.base, {
    observe: false,
    allowExternalWrites: true,
    scopes: { readGmail: true, readDrive: true, docsWrite: true, gmailDrafts: true, gmailSend: true }
  });
  assert.equal(callback.status, 200, await callback.clone().text());
  const ready = await waitFor(() => get(fixture.base, '/api/state'), value => {
    const task = value.body.tasks?.find(item => item.status === 'ready_for_approval' && item.draft?.to);
    return Boolean(task && value.body.documents?.some(document => document.source === 'google' && document.available !== false));
  }, 20_000).catch(async error => {
    const state = await get(fixture.base, '/api/state');
    const setup = await get(fixture.base, '/api/setup');
    throw new Error(`${error.message}\n${JSON.stringify({ tasks: state.body.tasks?.map(task => ({ id: task.id, status: task.status, reason: task.reason, documentId: task.documentId })), google: setup.body.google, log: fixture.log?.().slice(-2000) }, null, 2)}`);
  });
  const state = ready.body;
  const task = state.tasks.find(item => item.status === 'ready_for_approval' && item.draft?.to);
  const message = state.inbox.find(item => item.id === task.sourceEmailId);
  assert.match(task.draft.to, /alex@example\.test/i);
  assert.match(task.draft.to, /</, 'the prepared recipient keeps the display name from the source');
  const healthBefore = await get(fixture.base, '/api/health');
  assert.equal(healthBefore.body.shadow, false);
  const changes = ['sample size', 'conclusion'].map(quote => ({
    type: 'append', text: quote, source: { kind: 'email', id: message.id, quote }
  }));
  const prepared = await post(fixture.base, `/api/tasks/${encodeURIComponent(task.id)}/patch/prepare`, { provider: 'google', changes });
  const preparedBody = await prepared.json();
  assert.equal(prepared.status, 200, JSON.stringify(preparedBody));
  assert.equal(preparedBody.patch.status, 'prepared', preparedBody.patch.blockers?.join(' '));
  const grant = await post(fixture.base, '/api/artifact-grants', { connectorId: 'google', targetId: 'drafts', confirmed: true });
  const grantBody = await grant.json();
  assert.equal(grant.status, 200, JSON.stringify(grantBody));
  assert.equal(grantBody.setup.google.readOnly, false);
  assert.equal((await get(fixture.base, '/api/health')).body.shadow, false);
  const drafted = await waitFor(() => get(fixture.base, '/api/state'), value => {
    const current = value.body.tasks.find(item => item.id === task.id);
    const latest = current?.artifactRequests?.at(-1);
    return latest && !['queued', 'executing'].includes(latest.status);
  }, 15_000);
  const requests = drafted.body.tasks.find(item => item.id === task.id).artifactRequests;
  assert.equal(requests.at(-1).status, 'verified', JSON.stringify(requests));
  assert.equal(requests.some(request => request.status === 'blocked'), false, JSON.stringify(requests));
  const applied = await post(fixture.base, `/api/tasks/${encodeURIComponent(task.id)}/patch/apply`, {
    patchId: preparedBody.patch.id,
    authorization: { kind: 'explicit', confirmed: true, taskId: task.id, patchId: preparedBody.patch.id, baseDocumentVersion: preparedBody.patch.baseDocument.version }
  });
  const appliedBody = await applied.json();
  assert.equal(applied.status, 200, JSON.stringify(appliedBody));
  assert.equal(appliedBody.patch.status, 'applied');
  assert.doesNotMatch(JSON.stringify(appliedBody), /Shadow mode is read-only/);
  const content = appliedBody.state.documents.find(document => document.id === task.documentId).content;
  assert.ok(content.indexOf('sample size') < content.indexOf('conclusion'), content);
});

test('a source removal rejects an in-flight Google Docs write', { timeout: 40_000 }, async t => {
  const fixture = await startGoogleFixture({ provisioned: true });
  t.after(() => fixture.close());
  fixture.controls.expiresIn = 1;
  const model = await post(fixture.base, '/api/setup/model', { baseUrl: `${fixture.endpoint}/model/v1`, model: 'scripted-model' });
  assert.equal(model.status, 200, await model.clone().text());
  const callback = await connectGoogle(fixture.base, {
    observe: false, allowExternalWrites: true,
    scopes: { readGmail: true, readDrive: true, docsWrite: true, gmailSend: true }
  });
  assert.equal(callback.status, 200, await callback.clone().text());
  const ready = await waitFor(() => get(fixture.base, '/api/state'), value => value.body.tasks?.some(item => item.status === 'ready_for_approval' && item.documentId), 20_000);
  const task = ready.body.tasks.find(item => item.status === 'ready_for_approval' && item.documentId);
  const message = ready.body.inbox.find(item => item.id === task.sourceEmailId);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-disconnect-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const selected = await post(fixture.base, '/api/setup/local-sources/local_files/select', { path: folder, observe: false });
  assert.equal(selected.status, 200, await selected.clone().text());
  const prepared = await post(fixture.base, `/api/tasks/${encodeURIComponent(task.id)}/patch/prepare`, {
    provider: 'google', changes: [{ type: 'append', text: 'sample size', source: { kind: 'email', id: message.id, quote: 'sample size' } }]
  });
  const preparedBody = await prepared.json();
  assert.equal(preparedBody.patch.status, 'prepared', JSON.stringify(preparedBody));
  let releaseToken;
  fixture.controls.holdToken = new Promise(resolve => { releaseToken = resolve; });
  const tokens = () => fixture.calls.filter(call => call.path.includes('/token')).length;
  const before = tokens();
  const applying = post(fixture.base, `/api/tasks/${encodeURIComponent(task.id)}/patch/apply`, {
    patchId: preparedBody.patch.id,
    authorization: { kind: 'explicit', confirmed: true, taskId: task.id, patchId: preparedBody.patch.id, baseDocumentVersion: preparedBody.patch.baseDocument.version }
  });
  await waitFor(() => tokens(), count => count > before);
  const removing = post(fixture.base, '/api/setup/local-sources/local_files/remove-scope', { index: 0 });
  await waitFor(() => post(fixture.base, '/api/notifications/read', {}).then(response => response.status), status => status === 409);
  releaseToken();
  const applied = await applying;
  const appliedBody = await applied.json();
  assert.notEqual(applied.status, 200, JSON.stringify(appliedBody));
  assert.match(appliedBody.error, /read-only|Shadow mode|no longer authorized/);
  assert.equal(fixture.calls.some(call => call.path.includes(':batchUpdate')), false);
  const removed = await removing;
  assert.equal(removed.status, 200, await removed.clone().text());
});
