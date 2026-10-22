import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { emptyState } from '../src/store.js';

/**
 * Integration tests against the real HTTP server.
 *
 * These verify the guarantees that only exist at the boundary: the approval
 * step cannot be skipped through the API, live mode refuses simulated events,
 * and the runtime report tells the truth about what is connected.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const cleanups = [];
test.after(() => { for (const cleanup of cleanups) cleanup(); });

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-api-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(node, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      UNPROMPTED_STATE_FILE: path.join(dir, 'state.json'),
      // The shipped server defaults to read-only shadow mode. These tests keep
      // the frozen approval path by opting out; shadow denial is covered in
      // test/shadow.test.js.
      UNPROMPTED_SHADOW_MODE: 'false',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before listening: ${output}`);
    if (!output.includes(`Unprompted listening at ${base}`)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        cleanups.push(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
        return { base, child, output: () => output };
      }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  child.kill('SIGKILL');
  throw new Error(`Server did not start. Output:\n${output}`);
}

const post = async (base, path, body = {}, headers = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, body: payload };
};
const get = async (base, path) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
};

const API_EMAIL = {
  id: 'api-email-1', type: 'email.received', payload: {
    id: 'api-mail-1', from: 'alex@example.test', subject: 'Apitest proposal — experiment results',
    body: 'Please update the Apitest project proposal with the latest experiment results and send the revised proposal by Friday.'
  }
};
const API_DOC = {
  id: 'api-doc-1', type: 'document.modified', payload: {
    id: 'apitest-proposal', kind: 'proposal', title: 'Apitest project proposal',
    content: '# Apitest project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 500\nControl: 4.0% conversion\nTreatment: 6.0% conversion\nConclusion: Treatment improved conversion.\n'
  }
};

test('the API cannot execute an external action without an approved draft', async () => {
  const { base } = await startServer();

  const health = await get(base, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.mode, 'simulation');
  assert.equal(health.body.schemaVersion, 4);
  assert.equal(health.body.eventSource, 'simulated');
  assert.equal(health.body.mailProvider, 'simulated');

  const runtime = await get(base, '/api/runtime');
  assert.equal(runtime.body.mode, 'simulation');
  assert.equal(runtime.body.mailProvider, 'simulated');
  assert.deepEqual(runtime.body.pendingConfiguration.sort(), ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);

  // An unknown task cannot be acted on at all.
  const unknown = await post(base, '/api/tasks/request:api-mail-1/approve');
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown task/);

  const discovered = await post(base, '/api/simulation/events', API_EMAIL);
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.disposition, 'discovered_request');

  // Approving before the document is observed must fail, and must not send anything.
  const premature = await post(base, '/api/tasks/request:api-mail-1/approve');
  assert.equal(premature.status, 400);
  assert.match(premature.body.error, /not ready/);

  const changed = await post(base, '/api/simulation/events', API_DOC);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.disposition, 'related_change');

  const prepared = await get(base, '/api/state');
  const task = prepared.body.tasks.find(item => item.id === 'request:api-mail-1');
  assert.equal(task.status, 'ready_for_approval');
  assert.equal(prepared.body.outbox.length, 0, 'preparation must not send anything');

  // Retry without a prior approved and confirmed-absent action must be refused.
  const badRetry = await post(base, '/api/tasks/request:api-mail-1/retry');
  assert.equal(badRetry.status, 400);
  assert.match(badRetry.body.error, /confirmed absence/);

  const approved = await post(base, '/api/tasks/request:api-mail-1/approve');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'completed');
  assert.equal(approved.body.action.permission, 'user_approved');

  const after = await get(base, '/api/state');
  assert.equal(after.body.outbox.length, 1);
  assert.equal(after.body.outbox[0].status, 'accepted_simulation');

  const duplicate = await post(base, '/api/tasks/request:api-mail-1/approve');
  assert.equal(duplicate.status, 400);
  const final = await get(base, '/api/state');
  assert.equal(final.body.outbox.length, 1, 'a second approval must not send a second message');

  const missing = await post(base, '/api/nope');
  assert.equal(missing.status, 404);
});

test('revocation through the calibration API stops automatic execution at once', async () => {
  const { base } = await startServer();
  await post(base, '/api/calibrations', {
    key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: 'Apitest' }
  });

  await post(base, '/api/simulation/events', API_EMAIL);
  await post(base, '/api/simulation/events', API_DOC);
  let state = await get(base, '/api/state');
  assert.equal(state.body.tasks.find(item => item.id === 'request:api-mail-1').status, 'completed', 'the pre-authorised flow runs without a fresh click');
  assert.equal(state.body.outbox.length, 1);

  const revoked = await post(base, '/api/calibrations', {
    key: 'permission:send_automation', kind: 'permission', value: 'never', scope: { entity: 'Apitest' }, instruction: 'correct'
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.calibration.value, 'never');

  const second = { ...API_EMAIL, id: 'api-email-2', payload: { ...API_EMAIL.payload, id: 'api-mail-2' } };
  await post(base, '/api/simulation/events', second);
  state = await get(base, '/api/state');
  const task = state.body.tasks.find(item => item.id === 'request:api-mail-2');
  assert.equal(task.status, 'ready_for_approval', 'nothing runs automatically after revocation');
  assert.equal(state.body.outbox.length, 1, 'the revoked scope sent nothing further');

  const approved = await post(base, '/api/tasks/request%3Aapi-mail-2/approve');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'completed', 'revocation removes the automation, not the capability');
  state = await get(base, '/api/state');
  assert.equal(state.body.outbox.length, 2);
});

test('a stalled request reaches the user once and can be closed through the API', async () => {
  const { base } = await startServer({ UNPROMPTED_STALL_AFTER_MS: '0' });
  // This exercises stagnation, without a calendar-dependent stronger deadline.
  const stalledEmail = { ...API_EMAIL, payload: { ...API_EMAIL.payload, body: API_EMAIL.payload.body.replace(' by Friday', '') } };
  await post(base, '/api/simulation/events', stalledEmail);

  let state = await get(base, '/api/state');
  assert.equal(state.body.tasks.find(item => item.id === 'request:api-mail-1').status, 'waiting_for_information');
  const blocker = state.body.notifications.find(item => item.kind === 'blocker' && !item.resolvedAt);
  assert.ok(blocker, 'stagnation is raised as a decision');
  assert.deepEqual(blocker.options.map(option => option.value), ['close', 'acknowledge']);

  const closed = await post(base, '/api/tasks/request%3Aapi-mail-1/cancel');
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'cancelled');

  const again = await post(base, '/api/tasks/request%3Aapi-mail-1/cancel');
  assert.equal(again.status, 400, 'a closed request cannot be closed twice');

  const approveAfterClose = await post(base, '/api/tasks/request%3Aapi-mail-1/approve');
  assert.equal(approveAfterClose.status, 400, 'a closed request cannot be approved');

  state = await get(base, '/api/state');
  assert.equal(state.body.outbox.length, 0, 'closing sends nothing');
  assert.equal(state.body.notifications.filter(item => item.kind === 'blocker' && !item.resolvedAt).length, 0, 'the decision is withdrawn when the request closes');
});

test('illegal calls are refused at the HTTP boundary with no side effects', async () => {
  const { base } = await startServer();
  const cases = [
    [await post(base, '/api/tasks/request:nope/cancel'), /Unknown task/],
    [await post(base, '/api/opportunities/opportunity:nope/accept'), /Unknown opportunity/],
    [await post(base, '/api/opportunities/opportunity:nope/dismiss'), /Unknown opportunity/],
    [await post(base, '/api/clarifications/clarification:nope/answer', { value: 'allow' }), /Unknown clarification/],
    [await post(base, '/api/calibrations', { value: 'allow' }), /requires a key/]
  ];
  for (const [response, pattern] of cases) {
    assert.equal(response.status, 400);
    assert.match(response.body.error, pattern);
  }
  const state = await get(base, '/api/state');
  assert.equal(state.body.tasks.length, 0, 'a refused call created no work');
  assert.equal(state.body.outbox.length, 0, 'a refused call sent nothing');
  assert.equal(state.body.notifications.length, 0);
});

test('the frozen route set is reachable: metrics, trace and connector sync included', async () => {
  const { base } = await startServer();
  await post(base, '/api/simulation/events', API_EMAIL);

  const state = await get(base, '/api/state');
  const metrics = await get(base, '/api/metrics');
  assert.equal(metrics.status, 200);
  const { at: metricsAt, ...metricsRest } = metrics.body;
  const { at: stateAt, ...stateMetricsRest } = state.body.metrics;
  assert.deepEqual(metricsRest, stateMetricsRest, 'the metrics route returns the same metrics as the state');
  assert.ok(metricsAt && stateAt, 'both carry a measurement timestamp');

  const trace = await get(base, '/api/trace');
  assert.equal(trace.status, 200);
  assert.ok(Array.isArray(trace.body.entries) && trace.body.entries.length > 0, 'the trace route returns entries');
  assert.ok(trace.body.entries.every(entry => typeof entry.stage === 'string'));

  const taskTrace = await get(base, '/api/trace?taskId=request%3Aapi-mail-1');
  assert.equal(taskTrace.status, 200);
  assert.ok(Array.isArray(taskTrace.body.entries), 'a per-task trace answers for a known task');

  const sync = await post(base, '/api/connectors/sync');
  assert.equal(sync.status, 200);
  assert.ok(Array.isArray(sync.body.results), 'a simulated sync lists its (empty) results');
  const after = await get(base, '/api/state');
  assert.equal(after.body.events.length, state.body.events.length, 'a simulated sync pulls nothing and changes nothing');
  assert.equal(after.body.outbox.length, 0);
});

test('cross-origin POSTs are rejected', async () => {
  const { base } = await startServer();
  const blocked = await post(base, '/api/simulation/events', API_EMAIL, { origin: 'https://evil.example.test' });
  assert.equal(blocked.status, 403);
});

test('live mode refuses simulated events so a real workspace cannot be polluted', async () => {
  const { base } = await startServer({
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REFRESH_TOKEN: 'rtoken'
  });
  const runtime = await get(base, '/api/runtime');
  assert.equal(runtime.body.mode, 'live');
  assert.equal(runtime.body.simulationRunning, false);
  assert.equal(runtime.body.mailProvider, 'simulated', 'read-only live mode must not claim send capability');
  assert.equal(runtime.body.eventSource, 'google', 'live mode reads Google even when outbound mail stays simulated');

  const injected = await post(base, '/api/simulation/events', API_EMAIL);
  assert.equal(injected.status, 409);
  assert.match(injected.body.error, /disabled in live mode/);

  const restart = await post(base, '/api/demo/restart');
  assert.equal(restart.status, 409);
});

test('the state endpoint does not expose raw event payloads', async () => {
  const { base } = await startServer();
  await post(base, '/api/simulation/events', API_EMAIL);
  const state = await get(base, '/api/state');
  const event = state.body.events.find(item => item.id === 'api-email-1');
  assert.ok(event, 'the event should be listed');
  assert.equal('payload' in event, false, 'payloads are kept server-side');
  assert.ok(state.body.inbox.some(item => item.id === 'api-mail-1'), 'message context is available for the interface');
});

test('an unchanged boot does not rewrite the state file, and a changed runtime report still lands', async () => {
  // A1 regression: the boot-time runtime report may only be persisted when it
  // actually differs. Restarting with the same environment must not bump the
  // revision or rewrite a byte-identical file, while a genuinely different
  // report (a different configured numeric-date reading) must still be saved.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-boot-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const seeded = emptyState();
  // A recorded real (non-simulated) event keeps the simulation from injecting
  // its scenario while these boots run.
  seeded.events.push({
    id: 'boot-test:real-1', type: 'email.received', at: '2026-10-01T00:00:00.000Z',
    source: 'google', connectorId: 'google', providerEventId: 'boot-test:real-1',
    summary: '', relations: [], disposition: '', payload: {}
  });
  fs.writeFileSync(stateFile, JSON.stringify(seeded, null, 2) + '\n');
  const sha = () => createHash('sha256').update(fs.readFileSync(stateFile)).digest('hex');

  const boot = async (extraEnv = {}) => {
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(node, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), UNPROMPTED_STATE_FILE: stateFile, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) return { base, child, health: await response.json() };
      } catch { /* not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    child.kill('SIGKILL');
    throw new Error(`Server did not start. Output:\n${output}`);
  };

  const first = await boot();
  first.child.kill('SIGKILL');
  assert.equal(first.health.revision, 1, 'the first boot records its runtime report');
  const firstHash = sha();

  const second = await boot();
  second.child.kill('SIGKILL');
  assert.equal(second.health.revision, 1, 'an unchanged boot must not bump the revision');
  assert.equal(sha(), firstHash, 'an unchanged boot must not rewrite the file');

  const third = await boot({ UNPROMPTED_DATE_LOCALE: 'DD/MM' });
  third.child.kill('SIGKILL');
  assert.ok(third.health.revision > second.health.revision, 'a changed runtime report must still be recorded');
  assert.notEqual(sha(), firstHash, 'a changed runtime report rewrites the file');
});
