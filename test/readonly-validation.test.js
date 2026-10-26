import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readonlyValidationEnv, snapshotSource, sourceUnchanged } from '../src/readonly-validation.js';
import { runLiveReadonlyCheck } from '../scripts/live-readonly-check.mjs';

const credentials = { GOOGLE_CLIENT_ID: 'test-only-client', GOOGLE_CLIENT_SECRET: 'test-only-secret', GOOGLE_REFRESH_TOKEN: 'test-only-token' };

test('a validation subprocess cannot inherit write permissions, saved setup or remote reasoning', () => {
  const env = readonlyValidationEnv({ ...credentials, UNPROMPTED_SHADOW_MODE: 'false', GOOGLE_SEND_ENABLED: 'true',
    GOOGLE_DOCS_WRITE_ENABLED: 'true', UNPROMPTED_SETUP_FILE: 'personal-setup.json', UNPROMPTED_MODEL_BASE_URL: 'https://model.invalid',
    UNPROMPTED_CONFIG_DIR: 'personal-config', UNPROMPTED_FORCE_SIMULATION: 'true', UNPROMPTED_SYNC_INTERVAL_MS: '1' },
  { port: 12345, stateFile: 'isolated-state', setupDirectory: 'isolated-setup' });
  assert.equal(env.UNPROMPTED_SHADOW_MODE, 'true');
  assert.equal(env.GOOGLE_SEND_ENABLED, 'false');
  assert.equal(env.GOOGLE_DOCS_WRITE_ENABLED, 'false');
  assert.equal(env.UNPROMPTED_CONFIG_DIR, 'isolated-setup');
  assert.equal(env.UNPROMPTED_SETUP_FILE, undefined);
  assert.equal(env.UNPROMPTED_MODEL_BASE_URL, undefined);
  assert.equal(env.UNPROMPTED_FORCE_SIMULATION, 'false');
  assert.equal(env.UNPROMPTED_SYNC_INTERVAL_MS, '0');
});

test('source validation detects actual mutations and disappearance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-readonly-source-'));
  const filename = path.join(root, 'state.json');
  try {
    fs.writeFileSync(filename, 'original'); const before = snapshotSource(filename);
    assert.equal(sourceUnchanged(filename, before), true);
    fs.writeFileSync(filename, 'modified');
    assert.equal(sourceUnchanged(filename, before), false);
    fs.unlinkSync(filename);
    assert.equal(sourceUnchanged(filename, before), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const serverFixture = `
import http from 'node:http'; import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.env.UNPROMPTED_STATE_FILE, 'utf8'));
const requests = []; const mode = process.env.TEST_CHECK_MODE;
const server = http.createServer((req, res) => {
  requests.push(req.url); fs.writeFileSync('requests.json', JSON.stringify(requests));
  let body;
  if (req.url === '/api/health') body = { ok: true, mode: 'live', shadow: mode !== 'unsafe', reasoner: { id: 'none' } };
  if (req.url === '/api/runtime') body = { mode: 'live', shadow: true, google: { ok: true, readGmail: true, sendEnabled: false }, mailProvider: 'simulated', simulationRunning: false, monitoring: { enabled: false } };
  if (req.url === '/api/state') body = state;
  if (req.url === '/api/connectors/sync') {
    state.events.push({ privateData: 'PRIVATE_PROVIDER_CONTENT' });
    if (mode === 'outbox') state.outbox.push({ body: 'PRIVATE_MESSAGE_BODY' });
    if (mode === 'source') fs.writeFileSync(process.env.TEST_SOURCE_FILE, 'changed by fixture');
    body = { results: [{ connector: 'google', failed: false, partial: false, privateDetail: 'PRIVATE_PROVIDER_CONTENT' }] };
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

for (const mode of ['normal', 'unsafe', 'source', 'outbox']) {
  test(`isolated read check: ${mode}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-readonly-process-'));
    const source = path.join(root, 'original.json'), serverPath = path.join(root, 'server.mjs');
    const original = JSON.stringify({ events: [], tasks: {}, outbox: [], privateText: 'PRIVATE_WORKSPACE_CONTENT' });
    fs.writeFileSync(source, original); fs.writeFileSync(serverPath, serverFixture);
    try {
      const result = await runLiveReadonlyCheck({ root, source, serverPath, env: { ...process.env, ...credentials, TEST_CHECK_MODE: mode, TEST_SOURCE_FILE: source } });
      assert.equal(result.status, mode === 'normal' ? 'passed' : 'failed');
      const requests = JSON.parse(fs.readFileSync(path.join(root, 'requests.json'), 'utf8'));
      assert.equal(requests.filter(url => url === '/api/connectors/sync').length, mode === 'unsafe' ? 0 : 1);
      assert.equal(result.originalFileUntouched, mode !== 'source');
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|test-only-secret|test-only-token/);
      if (mode !== 'source') assert.equal(fs.readFileSync(source, 'utf8'), original);
      if (mode === 'normal') assert.equal(result.realUserValue, 'not_measured');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('without explicitly supplied credentials, validation skips before launching anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-readonly-skip-'));
  const source = path.join(root, 'state.json'); fs.writeFileSync(source, '{}');
  try {
    const result = await runLiveReadonlyCheck({ root, source, env: {} });
    assert.equal(result.status, 'skipped');
    assert.equal(fs.readdirSync(root).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
