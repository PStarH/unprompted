import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSetupStore } from '../src/setup.js';
import { DeviceOAuth } from '../src/device-oauth.js';

test('Microsoft device login accepts its current verification host but rejects lookalikes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-ms-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const setup = new LocalSetupStore({ filePath: path.join(dir, 'setup.json') });
  const responseFor = verification_uri => new Response(JSON.stringify({ device_code: 'private', user_code: 'ABCD1234', verification_uri, expires_in: 900, interval: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });
  const good = new DeviceOAuth(setup, { fetchImpl: async () => responseFor('https://login.microsoft.com/device') });
  t.after(() => good.close());
  const state = await good.start('microsoft', { clientId: 'registered-client' });
  assert.equal(state.authorizeUrl, 'https://login.microsoft.com/device');
  const bad = new DeviceOAuth(setup, { fetchImpl: async () => responseFor('https://login.microsoft.com.example.org/device') });
  t.after(() => bad.close());
  await assert.rejects(bad.start('microsoft', { clientId: 'registered-client' }));
});
