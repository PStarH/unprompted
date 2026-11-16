import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnectedFixture } from './fixtures/connected-workspace.mjs';
import { waitFor } from './fixtures/google-workspace.mjs';
import { publicSourceHealth } from '../src/connectors/source-health.js';
import { sourceRepairMarkup } from '../public/source-health.js';
const post = (base, path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) });
const setup = base => fetch(base + '/api/setup').then(r => r.json());

test('public health is allowlisted, redacts legacy errors and clears stale health on disconnect', () => {
  const record = { ok: true, complete: true, repair: { code: 'SOURCE_RECONNECT', action: 'reauthorize', secret: 'private' }, rawBody: 'private', lastError: 'account_id=secret-user Authorization: Bearer ' + 'private-value' };
  assert.deepEqual(publicSourceHealth(null, { connected:true }), { healthy:null, repair:null, retryAt:null, lastError:null });
  const view = publicSourceHealth(record, { connected: true });
  assert.deepEqual(view.repair, { code: 'SOURCE_RECONNECT', action: 'reauthorize' });
  assert.doesNotMatch(JSON.stringify(view), /private-value|secret-user|rawBody/);
  assert.deepEqual(publicSourceHealth(record), { healthy: null, repair: null, retryAt: null, lastError: null });
});
test('repair markup offers existing consent routes, treats API setup and throttling separately', () => {
  const reconnect = sourceRepairMarkup('todoist', { connected: true, repair: { code: 'SOURCE_RECONNECT', action:'reauthorize' } }, { language:'en' });
  assert.match(reconnect, /data-select-connection="todoist"/);
  assert.match(reconnect, /Reauthorize/);
  const wait = sourceRepairMarkup('google', { connected: true, repair: { code:'SOURCE_RATE_LIMITED', action:'wait' } }, { language:'zh' });
  assert.match(wait, /稍后会自动重试/); assert.doesNotMatch(wait, /<button/);
  const disabled = sourceRepairMarkup('google', { connected:true, repair:{code:'SOURCE_API_DISABLED',action:'retry'} }, { language:'en' });
  assert.match(disabled, /provider console/); assert.doesNotMatch(disabled, /data-google-reconnect/);
  assert.equal(sourceRepairMarkup('todoist', { connected:false, repair:{code:'SOURCE_RECONNECT',action:'reauthorize'} }), '');
});
test('actual provider 401/429/recovery/disconnect project truthful repair state through setup API', { timeout: 30000 }, async t => {
  const f = await startConnectedFixture(); t.after(f.close);
  assert.equal((await post(f.base, '/api/setup/connections/todoist/authorize', { token:'personal_fixture_token', observe:false })).status, 200);
  await waitFor(() => setup(f.base), value => value.connections.todoist.connected && !value.monitoring.running, 8000);
  for (const [status, code] of [[401,'SOURCE_RECONNECT'], [429,'SOURCE_RATE_LIMITED']]) {
    f.controls.todoistFailure = { status, retryAfter:2, message:'Scripted authorization observation failure' };
    assert.equal((await post(f.base, '/api/connectors/sync')).status, 200);
    const value = await setup(f.base), source = value.connections.todoist;
    assert.equal(source.connected, true); assert.equal(source.healthy, false);
    assert.equal(source.repair.code, code);
    assert.doesNotMatch(JSON.stringify(value), /personal_fixture_token/);
  }
  f.controls.todoistFailure = null;
  await post(f.base, '/api/connectors/sync');
  const restored = (await setup(f.base)).connections.todoist;
  assert.equal(restored.healthy, true); assert.equal(restored.repair, null);
  await post(f.base, '/api/setup/connections/todoist/forget');
  const disconnected = (await setup(f.base)).connections.todoist;
  assert.equal(disconnected.connected, false); assert.equal(disconnected.healthy, null); assert.equal(disconnected.repair, null);
});
