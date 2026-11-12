import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './browser/fixture-server.mjs';

test('web installation reads a selected folder, restores it after restart and disconnects without deleting originals', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-web-install-'));
  const selected = path.join(directory, 'Selected work');
  fs.mkdirSync(selected);
  const original = path.join(selected, 'work.md');
  fs.writeFileSync(original, 'Project context for the local web installation.');
  let server;
  t.after(async () => {
    if (server) await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const start = async () => {
    server = await startFixtureServer({ ruleDemo: false, directory });
    assert.equal((await fetch(server.base + '/api/health')).status, 200);
    const html = await (await fetch(server.base)).text();
    assert.match(html, /id="taskContent"/);
    assert.doesNotMatch(html, /realtime-panel/);
  };
  const post = async (route, data) => {
    const response = await fetch(server.base + route, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(data)
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  await start();
  assert.equal((await (await fetch(server.base + '/api/state')).json()).tasks.length, 0);
  await post('/api/setup/local-sources/local_files/select', { path: selected, observe: false });
  let setup = await (await fetch(server.base + '/api/setup')).json();
  assert.equal(setup.localSources.local_files.connected, true);
  assert.equal(setup.monitoring.enabled, false);
  const state = await (await fetch(server.base + '/api/state')).json();
  assert.ok(state.documents.some(document => document.content.includes('Project context')));
  await server.close(); server = null;
  await start();
  setup = await (await fetch(server.base + '/api/setup')).json();
  assert.equal(setup.localSources.local_files.connected, true);
  assert.equal(setup.monitoring.enabled, false);
  await post('/api/setup/local-sources/local_files/forget', { purgeLocal: true });
  assert.equal((await (await fetch(server.base + '/api/setup')).json()).localSources.local_files.connected, false);
  assert.equal(fs.readFileSync(original, 'utf8'), 'Project context for the local web installation.');
});
