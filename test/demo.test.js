import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('one-command demo ignores credentials and saved state, then verifies only a simulated action', { timeout: 30000 }, async () => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-demo-test-'));
  const state = path.join(dir, 'existing-state.json');
  fs.writeFileSync(state, 'existing workspace must not be read or changed');
  const child = spawn(process.execPath, ['scripts/demo.mjs', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, GOOGLE_CLIENT_ID: 'demo-test-client', GOOGLE_CLIENT_SECRET: 'demo-test-secret', GOOGLE_REFRESH_TOKEN: 'demo-test-refresh', GOOGLE_SEND_ENABLED: 'true', UNPROMPTED_MODEL_BASE_URL: 'http://127.0.0.1:1', UNPROMPTED_MODEL_API_KEY: 'demo-test-key', UNPROMPTED_MODEL_NAME: 'demo-test', UNPROMPTED_STATE_FILE: state },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      if (output.includes(`Unprompted listening at ${base}`)) { health = await (await fetch(`${base}/api/health`)).json(); break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(health, output);
    assert.equal(health.mode, 'simulation');
    assert.equal(health.mailProvider, 'simulated');
    assert.equal(health.shadow, false);
    const runtime = await (await fetch(`${base}/api/runtime`)).json();
    assert.equal(runtime.google.sendEnabled, false);
    assert.equal(runtime.demo.enabled, true);
    const beforeViewing = await (await fetch(`${base}/api/state`)).json();
    assert.equal(beforeViewing.events.length, 0);
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { signal: controller.signal });
    await stream.body.getReader().read();
    controller.abort();
    let ready;
    for (let i = 0; i < 90; i++) {
      ready = await (await fetch(`${base}/api/state`)).json();
      if (ready.tasks.some(task => task.status === 'ready_for_approval')) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(ready.tasks.length, 1);
    assert.equal(ready.outbox.length, 0);
    assert.equal(ready.tasks[0].status, 'ready_for_approval');
    const response = await fetch(`${base}/api/tasks/${encodeURIComponent(ready.tasks[0].id)}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const completed = await (await fetch(`${base}/api/state`)).json();
    assert.equal(completed.tasks[0].action.status, 'verified_simulated');
    assert.equal(completed.outbox.length, 1);
    assert.equal(fs.readFileSync(state, 'utf8'), 'existing workspace must not be read or changed');
    assert.ok(!output.includes('demo-test-secret'));
  } finally {
    child.kill('SIGTERM');
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
