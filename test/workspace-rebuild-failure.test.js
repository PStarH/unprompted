import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { googleWorkspacePath } from '../src/setup.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PRELOAD = path.join(ROOT, 'test/fixtures/workspace66-preload.mjs');
const SECRET = '{{SECRET_5xcnqnx3}}-workspace66';
const GITHUB_TOKEN = 'workspace66-synthetic-github-token-workspace66-token';
const ACCOUNT = 66;
const USER = 'workspace66';
const GOOGLE_CLIENT_ID = 'workspace66.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '{{SECRET_q2n6zzbn}}-workspace66';
const GOOGLE_REFRESH = '{{SECRET_w6o5z2m4}}-workspace66';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-ws66-'));
const workspaceFilename = (directory, account) => path.resolve(googleWorkspacePath(directory, account));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const setupState = ({ account = 'google-a', monitoring = false, external = false } = {}) => ({
  version: 1,
  google: {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH,
    accountId: account,
    accountEmail: `${account}@example.test`,
    scopes: {
      readGmail: false, readDrive: false, readCalendar: false, docsWrite: external,
      gmailSend: false, gmailDrafts: false
    },
    grantedScopes: external ? ['https://www.googleapis.com/auth/documents'] : [],
    authorizationState: 'connected'
  },
  connections: {
    github: {
      account: { id: String(ACCOUNT), label: USER },
      accessToken: GITHUB_TOKEN,
      scopes: ['repo', 'read:user'],
      repositories: []
    }
  },
  nativeSources: {},
  monitoring: { enabled: monitoring, intervalMs: 3_600_000, userConfigured: monitoring },
  permissions: { allowExternalWrites: external, allowArtifactWrites: false }
});

const writeSetup = (directory, state) => {
  const file = path.join(directory, 'setup.json');
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return file;
};

const startServer = (t, { directory, port, setup, extraEnv = {} }) => {
  writeSetup(directory, setup);
  const env = { ...process.env };
  for (const name of [
    'UNPROMPTED_FORCE_SIMULATION', 'UNPROMPTED_RULE_ONLY', 'UNPROMPTED_SHADOW_MODE',
    'UNPROMPTED_DESKTOP_APP', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_ACCOUNT_EMAIL', 'GOOGLE_DRAFTS_ENABLED', 'GOOGLE_DOCS_WRITE_ENABLED',
    'UNPROMPTED_GITHUB_WEBHOOK_SECRET', 'UNPROMPTED_GITHUB_WEBHOOK_ACCOUNT_ID'
  ]) delete env[name];
  Object.assign(env, {
    NODE_ENV: 'test',
    UNPROMPTED_TEST: '1',
    PORT: String(port),
    NODE_OPTIONS: '',
    UNPROMPTED_DATA_DIR: directory,
    UNPROMPTED_STORAGE: 'sqlite',
    UNPROMPTED_SETUP_FILE: path.join(directory, 'setup.json'),
    UNPROMPTED_GITHUB_WEBHOOK_SECRET: SECRET,
    UNPROMPTED_GITHUB_WEBHOOK_ENABLED: 'true',
    UNPROMPTED_GITHUB_WEBHOOK_REPOS: 'workspace66/repo',
    UNPROMPTED_GITHUB_WEBHOOK_ACCOUNT_ID: String(ACCOUNT),
    UNPROMPTED_HTTP_REQUEST_TIMEOUT_MS: '30000',
    WS66_ACCOUNT_ID: String(ACCOUNT),
    WS66_LOGIN: USER
  });

  Object.assign(env, extraEnv);
  let stderr = '';
  let stdout = '';
  const child = spawn(process.execPath, ['--import', PRELOAD, path.join(ROOT, 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const waiters = new Map();
  child.on('message', message => {
    if (message?.type === 'diag' && waiters.has(message.id)) {
      waiters.get(message.id)(message.snapshot);
      waiters.delete(message.id);
    }
  });

  const harness = { child, port, directory, get stderr() { return stderr; }, get stdout() { return stdout; } };

  t.after(async () => {
    let exit;
    if (child.exitCode == null && child.signalCode == null) {
      try { child.disconnect(); } catch {}
      child.kill('SIGTERM');
    }
    exit = await new Promise(resolve => {
      if (child.exitCode != null || child.signalCode != null) {
        return resolve({ code: child.exitCode, signal: child.signalCode, forced: false });
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, signal: 'SIGKILL', forced: true });
      }, 10_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, forced: false });
      });
    });
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(exit.forced, false, `server did not exit cleanly\n${stderr}`);
    assert.equal(exit.code, 0, `server exited ${exit.signal || exit.code}\n${stderr}`);
    assert.doesNotMatch(stderr, /BLOCKED_EXTERNAL_FETCH/);
  });
  return harness;
};

const diagnose = (harness, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const id = `${Date.now()}-${Math.random()}`;
  const timer = setTimeout(() => {
    harness.child.off('message', onMessage);
    reject(new Error(`diagnostics timed out\n${harness.stderr}`));
  }, timeoutMs);
  const onMessage = message => {
    if (message?.type !== 'diag' || message.id !== id) return;
    clearTimeout(timer);
    harness.child.off('message', onMessage);
    resolve(message.snapshot);
  };
  harness.child.on('message', onMessage);
  harness.child.send({ type: 'diag', id });
});

const arm = (harness, fault, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    harness.child.off('message', onMessage);
    reject(new Error(`arm ${fault.fault || fault} timed out\n${harness.stderr}`));
  }, timeoutMs);
  const onMessage = message => {
    if (message?.type !== 'armed' || message.fault !== (fault.fault || fault)) return;
    clearTimeout(timer);
    harness.child.off('message', onMessage);
    resolve();
  };
  harness.child.on('message', onMessage);
  harness.child.send({ type: 'arm', ...(typeof fault === 'string' ? { fault } : fault) });
});

const waitReady = async harness => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (harness.child.exitCode != null) throw new Error(`server exited early\n${harness.stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${harness.port}/api/health`);
      const body = await response.json();
      if (response.ok && body.processId) return body;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server did not become ready\n${harness.stderr}`);
};

const requestJson = async (harness, pathname, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${harness.port}${pathname}`, {
    ...options, signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text };
};

const health = async harness => {
  const response = await fetch(`http://127.0.0.1:${harness.port}/api/health`, { signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.json() };
};

const freshDiagnostics = async harness => {
  const current = await health(harness);
  assert.equal(current.status, 200, harness.stderr);
  return diagnose(harness);
};

const activate = (harness, observe) => requestJson(harness, '/api/setup/google/activate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ observe })
});

const forgetSlack = harness => requestJson(harness, '/api/setup/connections/slack/forget', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
});

const webhookBody = () => JSON.stringify({
  action: 'opened',
  issue: { id: 6601, number: 66, title: 'Workspace rebuild failure', body: 'synthetic', state: 'open', html_url: 'https://github.com/workspace66/repo/issues/66' },
  repository: { id: 6600, full_name: 'workspace66/repo' }
});

const webhook = async harness => {
  const payload = webhookBody();
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
  return requestJson(harness, '/api/webhooks/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': 'issues', 'x-github-delivery': crypto.randomUUID() },
    body: payload
  });
};

const unsignedWebhook = harness => requestJson(harness, '/api/webhooks/github', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': crypto.randomUUID() },
  body: '{}'
});

const assertOneReceiver = diagnostics => {
  const live = diagnostics.services.filter(record => record.starts > 0 && record.stops === 0);
  assert.equal(live.length, 1, JSON.stringify(diagnostics.services));
  assert.equal(diagnostics.startedNotStopped, 1, JSON.stringify(diagnostics.services));
};

const assertPreviousOpen = (diagnostics, filename) => {
  assert.equal(diagnostics.currentStore?.filename, filename);
  assert.equal(diagnostics.currentStore?.closed, false);
};

const assertNoBlockedFetch = diagnostics => assert.deepEqual(diagnostics.blockedFetch, []);

for (const scenario of [
  { fault: 'mutate', hit: 'mutateFaultHits', label: 'candidate post-assignment store save' },
  { fault: 'mark', hit: 'markFaultHits', label: 'pre-commit setup marker' }
]) {
  test(`activation ${scenario.label} failure keeps the previous open workspace and one receiver`, { timeout: 30_000 }, async t => {
    const directory = temporaryDirectory();
    const port = await freePort();
    const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
    await waitReady(harness);
    const before = await freshDiagnostics(harness);
    const previous = before.currentStore.filename;

    writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
    await arm(harness, scenario.fault === 'mutate'
      ? { fault: 'mutate', filename: workspaceFilename(directory, 'google-b') }
      : scenario.fault);
    const response = await activate(harness, false);
    assert.equal(response.status, 409, response.text);
    assert.equal(response.body?.code, 'GOOGLE_ACTIVATION_FAILED');

    const after = await freshDiagnostics(harness);
    assert.equal(after[scenario.hit], 1);
    assertPreviousOpen(after, previous);
    const candidates = after.stores.filter(store => store.filename !== previous);
    assert.equal(candidates.length, 1, JSON.stringify(after.stores));
    assert.equal(candidates[0].closed, true);
    // F6: the fault must have landed on the candidate's own assignment save,
    // not merely on the first mutate of any store.
    assert.equal(after.lastMutate?.filename, candidates[0].filename);
    assert.match(after.lastMutate?.callsite || '', /activateGoogleWorkspace/);
    assert.equal(candidates[0].mutates, 1, JSON.stringify(after.stores));
    assert.equal(after.stores.find(store => store.filename === previous)?.mutates,
      before.stores.find(store => store.filename === previous)?.mutates, JSON.stringify(after.stores));
    assertOneReceiver(after);
    assertNoBlockedFetch(after);

    const signed = await webhook(harness);
    assert.equal(signed.status, 202, signed.text);
    assert.equal(signed.body?.code, 'MONITORING_PAUSED');
    const unsigned = await unsignedWebhook(harness);
    assert.equal(unsigned.status, 401, unsigned.text);
  });
}

test('activation previous-store cleanup failure keeps the committed open workspace and one receiver', { timeout: 30_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;

  writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
  await arm(harness, { fault: 'close', filename: previous });
  const response = await activate(harness, false);
  assert.equal(response.status, 500, response.text);
  assert.equal(response.body?.code, 'GOOGLE_ACTIVATION_CLEANUP_FAILED');
  assert.equal(response.body?.workspaceApplied, true);
  assert.match(response.body?.error || '', /previous workspace could not be closed/i);
  assert.doesNotMatch(response.body?.error || '', /INJECTED/);

  const after = await freshDiagnostics(harness);
  assert.equal(after.closeFaultHits, 1);
  assert.notEqual(after.currentStore?.filename, previous);
  assert.equal(after.currentStore?.closed, false);
  const retired = after.stores.find(store => store.filename === previous);
  assert.equal(retired?.closed, false);
  assert.equal(retired?.closes, 1, JSON.stringify(after.stores));
  assert.equal(retired?.closeFailures, 1, JSON.stringify(after.stores));
  assert.equal(after.stores.find(store => store.filename === after.currentStore?.filename)?.closes, 0, JSON.stringify(after.stores));
  assertOneReceiver(after);
  assertNoBlockedFetch(after);

  const signed = await webhook(harness);
  assert.equal(signed.status, 202, signed.text);
  assert.equal(signed.body?.code, 'MONITORING_PAUSED');
  const unsigned = await unsignedWebhook(harness);
  assert.equal(unsigned.status, 401, unsigned.text);
});

test('same-account retry closes the retired previous store without closing the current store', { timeout: 45_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;

  writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
  await arm(harness, { fault: 'close', filename: previous });
  const failed = await activate(harness, false);
  assert.equal(failed.status, 500, failed.text);
  assert.equal(failed.body?.code, 'GOOGLE_ACTIVATION_CLEANUP_FAILED');
  assert.equal(failed.body?.workspaceApplied, true);

  const committed = await freshDiagnostics(harness);
  const current = committed.currentStore.filename;
  assert.notEqual(current, previous);
  assert.equal(committed.stores.find(store => store.filename === previous)?.closed, false);

  const retried = await activate(harness, false);
  assert.equal(retried.status, 200, retried.text);
  const afterRetry = await freshDiagnostics(harness);
  assert.equal(afterRetry.currentStore?.filename, current);
  assert.equal(afterRetry.currentStore?.closed, false);
  const retired = afterRetry.stores.find(store => store.filename === previous);
  assert.equal(retired?.closed, true);
  assert.equal(retired?.closes, 2, JSON.stringify(afterRetry.stores));
  assert.equal(retired?.closeFailures, 1, JSON.stringify(afterRetry.stores));
  const currentRecords = afterRetry.stores.filter(store => store.filename === current);
  assert.equal(currentRecords.length, 1, JSON.stringify(afterRetry.stores));
  assert.equal(currentRecords[0].closes, 0, JSON.stringify(afterRetry.stores));
  assert.equal(currentRecords[0].closed, false);
  assertOneReceiver(afterRetry);
  assertNoBlockedFetch(afterRetry);
});

test('rejected candidate close failure is retained and retried before the next allocation', { timeout: 45_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;
  const candidateFilename = workspaceFilename(directory, 'google-b');

  writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
  await arm(harness, { fault: 'mutate', filename: candidateFilename });
  await arm(harness, { fault: 'close', filename: candidateFilename });
  const failed = await activate(harness, false);
  assert.equal(failed.status, 409, failed.text);
  assert.equal(failed.body?.code, 'GOOGLE_ACTIVATION_FAILED');

  const afterFailure = await freshDiagnostics(harness);
  assert.equal(afterFailure.currentStore?.filename, previous);
  assert.equal(afterFailure.currentStore?.closed, false);
  const retained = afterFailure.stores.filter(store => store.filename === candidateFilename);
  assert.equal(retained.length, 1, JSON.stringify(afterFailure.stores));
  assert.equal(retained[0].closed, false);
  assert.equal(retained[0].closeFailures, 1, JSON.stringify(afterFailure.stores));

  const retried = await activate(harness, false);
  assert.equal(retried.status, 200, retried.text);
  const afterRetry = await freshDiagnostics(harness);
  assert.equal(afterRetry.currentStore?.filename, candidateFilename);
  assert.equal(afterRetry.currentStore?.closed, false);
  const candidateRecords = afterRetry.stores.filter(store => store.filename === candidateFilename);
  assert.equal(candidateRecords.length, 2, JSON.stringify(afterRetry.stores));
  const retired = candidateRecords.find(store => store.closes > 0);
  assert.equal(retired?.closed, true);
  assert.equal(retired?.closes, 2, JSON.stringify(candidateRecords));
  assert.equal(retired?.closeFailures, 1, JSON.stringify(candidateRecords));
  const currentRecord = candidateRecords.find(store => store.closes === 0);
  assert.equal(currentRecord?.closed, false);
  assert.equal(afterRetry.stores.find(store => store.filename === previous)?.closed, true);
  assertOneReceiver(afterRetry);
  assertNoBlockedFetch(afterRetry);
});

test('an unpublished store allocated before candidate construction is closed on activation failure', { timeout: 30_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;

  writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
  await arm(harness, 'runtimeEnv');
  const response = await activate(harness, false);
  assert.equal(response.status, 409, response.text);
  assert.equal(response.body?.code, 'GOOGLE_ACTIVATION_FAILED');
  assert.doesNotMatch(response.body?.error || '', /INJECTED/);

  const after = await freshDiagnostics(harness);
  assert.equal(after.runtimeEnvFaultHits, 1);
  // The fault must land in the activation's own runtimeEnv call, not on the
  // startup call or a generic first read of setup state.
  assert.equal(after.runtimeEnvFilename, path.join(directory, 'setup.json'));
  assert.match(after.lastRuntimeEnvCallsite || '', /activateGoogleWorkspace/);
  assertPreviousOpen(after, previous);
  const candidates = after.stores.filter(store => store.filename !== previous);
  assert.equal(candidates.length, 1, JSON.stringify(after.stores));
  assert.equal(candidates[0].filename, workspaceFilename(directory, 'google-b'));
  assert.equal(candidates[0].closed, true, 'pre-candidate allocation must not lose its store owner');
  assertOneReceiver(after);
  assertNoBlockedFetch(after);
});

test('pre-candidate allocation close failure is retained and retried before the next allocation', { timeout: 45_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;
  const candidateFilename = workspaceFilename(directory, 'google-b');

  writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
  await arm(harness, 'runtimeEnv');
  await arm(harness, { fault: 'close', filename: candidateFilename });
  const failed = await activate(harness, false);
  assert.equal(failed.status, 409, failed.text);
  assert.equal(failed.body?.code, 'GOOGLE_ACTIVATION_FAILED');

  const afterFailure = await freshDiagnostics(harness);
  assert.equal(afterFailure.runtimeEnvFaultHits, 1);
  assertPreviousOpen(afterFailure, previous);
  const retained = afterFailure.stores.filter(store => store.filename === candidateFilename);
  assert.equal(retained.length, 1, JSON.stringify(afterFailure.stores));
  assert.equal(retained[0].closed, false);
  assert.equal(retained[0].closeFailures, 1, JSON.stringify(afterFailure.stores));
  assertOneReceiver(afterFailure);

  const retried = await activate(harness, false);
  assert.equal(retried.status, 200, retried.text);
  const afterRetry = await freshDiagnostics(harness);
  assert.equal(afterRetry.currentStore?.filename, candidateFilename);
  assert.equal(afterRetry.currentStore?.closed, false);
  const candidateRecords = afterRetry.stores.filter(store => store.filename === candidateFilename);
  assert.equal(candidateRecords.length, 2, JSON.stringify(afterRetry.stores));
  const retired = candidateRecords.find(store => store.closes > 0);
  assert.equal(retired?.closed, true);
  assert.equal(retired?.closes, 2, JSON.stringify(candidateRecords));
  assert.equal(retired?.closeFailures, 1, JSON.stringify(candidateRecords));
  const currentRecord = candidateRecords.find(store => store.closes === 0);
  assert.equal(currentRecord?.closed, false);
  assert.equal(afterRetry.stores.find(store => store.filename === previous)?.closed, true);
  assertOneReceiver(afterRetry);
  assertNoBlockedFetch(afterRetry);
});

test('persistent retired cleanup blocks new allocation and keeps the previous workspace fail closed', { timeout: 45_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;
  const candidateFilename = workspaceFilename(directory, 'google-b');

  writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
  await arm(harness, { fault: 'mutate', filename: candidateFilename });
  await arm(harness, { fault: 'close', filename: candidateFilename, times: 2 });
  const failed = await activate(harness, false);
  assert.equal(failed.status, 409, failed.text);
  const afterFailure = await freshDiagnostics(harness);
  assert.equal(afterFailure.stores.filter(store => store.filename === candidateFilename).length, 1);

  const blocked = await activate(harness, false);
  assert.equal(blocked.status, 500, blocked.text);
  assert.equal(blocked.body?.code, 'GOOGLE_ACTIVATION_CLEANUP_REQUIRED');
  assert.equal(blocked.body?.workspaceApplied, false);
  assert.match(blocked.body?.error || '', /previous workspace is still open/i);
  assert.doesNotMatch(blocked.body?.error || '', /INJECTED/);

  const afterBlocked = await freshDiagnostics(harness);
  assert.equal(afterBlocked.currentStore?.filename, previous);
  assert.equal(afterBlocked.currentStore?.closed, false);
  const retained = afterBlocked.stores.filter(store => store.filename === candidateFilename);
  assert.equal(retained.length, 1, JSON.stringify(afterBlocked.stores));
  assert.equal(retained[0].closed, false);
  assert.equal(retained[0].closes, 2, JSON.stringify(afterBlocked.stores));
  assert.equal(retained[0].closeFailures, 2, JSON.stringify(afterBlocked.stores));
  assert.equal(afterBlocked.shadows.length, afterFailure.shadows.length, JSON.stringify(afterBlocked.shadows));
  assert.ok(afterBlocked.shadows.some(shadow => shadow.policy === true && shadow.task === true), JSON.stringify(afterBlocked.shadows));
  assertOneReceiver(afterBlocked);
  assertNoBlockedFetch(afterBlocked);
});

test('post-publication monitoring failure reports a committed workspace and the retry recovers', { timeout: 45_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;
  const candidateFilename = workspaceFilename(directory, 'google-b');

  writeSetup(directory, setupState({ account: 'google-b', monitoring: false }));
  await arm(harness, 'monitoring-set');
  const failed = await activate(harness, false);
  assert.equal(failed.status, 500, failed.text);
  assert.equal(failed.body?.code, 'GOOGLE_ACTIVATION_RECOVERY_REQUIRED');
  assert.equal(failed.body?.workspaceApplied, true);
  assert.match(failed.body?.error || '', /workspace was switched/i);
  assert.doesNotMatch(failed.body?.error || '', /INJECTED|could not be applied/i);

  const committed = await freshDiagnostics(harness);
  assert.equal(committed.monitoringSetFaultHits, 1);
  assert.equal(committed.currentStore?.filename, candidateFilename);
  assert.equal(committed.currentStore?.closed, false);
  assert.equal(committed.stores.find(store => store.filename === previous)?.closed, true);
  assertOneReceiver(committed);
  assertNoBlockedFetch(committed);

  const retried = await activate(harness, false);
  assert.equal(retried.status, 200, retried.text);
  const recovered = await freshDiagnostics(harness);
  assert.equal(recovered.currentStore?.filename, candidateFilename);
  assert.equal(recovered.currentStore?.closed, false);
  assertOneReceiver(recovered);
  assertNoBlockedFetch(recovered);
});

for (const scenario of [
  { fault: 'sync', hit: 'syncFaultHits', label: 'connector sync construction' },
  { fault: 'monitoring-get', hit: 'monitoringFaultHits', label: 'monitoring construction' },
  { fault: 'webhook-start', hit: 'webhookStartFaultHits', label: 'candidate receiver start' }
]) {
  test(`source refresh ${scenario.label} failure keeps the previous open workspace and one receiver`, { timeout: 30_000 }, async t => {
    const directory = temporaryDirectory();
    const port = await freePort();
    const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
    await waitReady(harness);
    const before = await freshDiagnostics(harness);
    const previous = before.currentStore.filename;

    await arm(harness, scenario.fault);
    const response = await forgetSlack(harness);
    assert.equal(response.status, 500, response.text);

    const after = await freshDiagnostics(harness);
    assert.equal(after[scenario.hit], 1);
    assertPreviousOpen(after, previous);
    assertOneReceiver(after);
    assertNoBlockedFetch(after);

    const signed = await webhook(harness);
    assert.equal(signed.status, 202, signed.text);
    assert.equal(signed.body?.code, 'MONITORING_PAUSED');
    const unsigned = await unsignedWebhook(harness);
    assert.equal(unsigned.status, 401, unsigned.text);
  });
}

test('source refresh failure after the candidate receiver starts rolls it back leaving one receiver', { timeout: 45_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;

  await arm(harness, { fault: 'mutate', filename: previous });
  const response = await forgetSlack(harness);
  assert.equal(response.status, 500, response.text);

  const after = await freshDiagnostics(harness);
  assert.equal(after.mutateFaultHits, 1);
  assert.equal(after.lastMutate?.filename, previous);
  assert.match(after.lastMutate?.callsite || '', /applyConnectedSources/);
  // The real receiver start ran before the injected later mutation; the
  // pre-start injection was deliberately not used for this probe.
  assert.equal(after.webhookStartFaultHits, 0);
  const added = after.services.slice(before.services.length);
  assert.equal(added.length, 2, JSON.stringify(after.services));
  assert.equal(added[0].starts, 1, JSON.stringify(added));
  assert.equal(added[0].stops, 1, JSON.stringify(added));
  assert.equal(added[1].starts, 1, JSON.stringify(added));
  assert.equal(added[1].stops, 0, JSON.stringify(added));
  assertPreviousOpen(after, previous);
  assertOneReceiver(after);
  assertNoBlockedFetch(after);
});

test('narrowing failure stays fail closed instead of restoring public writes', { timeout: 30_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false, external: true }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  assert.ok(before.shadows.length > 0, JSON.stringify(before.shadows));
  for (const shadow of before.shadows) {
    assert.equal(shadow.policy, false, JSON.stringify(before.shadows));
    assert.equal(shadow.task, false, JSON.stringify(before.shadows));
    assert.equal(shadow.document, false, JSON.stringify(before.shadows));
    assert.equal(shadow.google, false, JSON.stringify(before.shadows));
  }

  await arm(harness, 'monitoring-get');
  const response = await forgetSlack(harness);
  assert.equal(response.status, 500, response.text);

  const after = await freshDiagnostics(harness);
  assert.equal(after.monitoringFaultHits, 1);
  assert.ok(after.shadows.length > 0, JSON.stringify(after.shadows));
  for (const shadow of after.shadows) {
    assert.equal(shadow.policy, true, JSON.stringify(after.shadows));
    assert.equal(shadow.task, true, JSON.stringify(after.shadows));
    assert.equal(shadow.document, true, JSON.stringify(after.shadows));
    assert.equal(shadow.google, true, JSON.stringify(after.shadows));
  }
  assertOneReceiver(after);
  assertNoBlockedFetch(after);

  const signed = await webhook(harness);
  assert.equal(signed.status, 202, signed.text);
  assert.equal(signed.body?.code, 'MONITORING_PAUSED');
  const unsigned = await unsignedWebhook(harness);
  assert.equal(unsigned.status, 401, unsigned.text);
});

const storageCount = (diagnostics, table) => {
  const rows = diagnostics.storage?.[table] || [];
  return Object.fromEntries(rows.map(row => [row.state, row.n]));
};

test('retry after a failed activation replaces the previous workspace and drains the receiver', { timeout: 45_000 }, async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }) });
  await waitReady(harness);
  const before = await freshDiagnostics(harness);
  const previous = before.currentStore.filename;

  writeSetup(directory, setupState({ account: 'google-b', monitoring: true }));
  await arm(harness, 'mutate');
  const failed = await activate(harness, true);
  assert.equal(failed.status, 409, failed.text);
  const afterFailure = await freshDiagnostics(harness);
  assertPreviousOpen(afterFailure, previous);
  assertOneReceiver(afterFailure);

  const retried = await activate(harness, true);
  assert.equal(retried.status, 200, retried.text);
  const afterRetry = await freshDiagnostics(harness);
  assert.equal(afterRetry.currentStore?.closed, false);
  assert.notEqual(afterRetry.currentStore?.filename, previous);
  assert.equal(afterRetry.stores.find(store => store.filename === previous)?.closed, true);
  assertOneReceiver(afterRetry);
  assertNoBlockedFetch(afterRetry);

  const signed = await webhook(harness);
  assert.equal(signed.status, 202, signed.text);
  assert.equal(signed.body?.accepted, true, signed.text);
  assert.equal(signed.body?.duplicate, false, signed.text);

  const deadline = Date.now() + 20_000;
  let drained = null;
  while (Date.now() < deadline) {
    drained = await freshDiagnostics(harness);
    const receipts = storageCount(drained, 'receipts');
    const jobs = storageCount(drained, 'jobs');
    if ((receipts.completed || 0) > 0 && !receipts.queued && !receipts.received && !receipts.processing && (jobs.completed || 0) > 0) {
      break;
    }
    await sleep(200);
  }
  assert.ok(drained, 'no diagnostics');
  const receipts = storageCount(drained, 'receipts');
  const jobs = storageCount(drained, 'jobs');
  assert.ok((receipts.completed || 0) > 0, JSON.stringify(receipts));
  assert.equal(receipts.queued || 0, 0, JSON.stringify(receipts));
  assert.equal(receipts.received || 0, 0, JSON.stringify(receipts));
  assert.equal(receipts.processing || 0, 0, JSON.stringify(receipts));
  assert.ok((jobs.completed || 0) > 0, JSON.stringify(jobs));
  assert.equal(drained.currentStore?.closed, false);
  assert.notEqual(drained.currentStore?.filename, previous);
  assert.equal(drained.stores.find(store => store.filename === previous)?.closed, true);
  assertOneReceiver(drained);
  assert.ok(drained.fetchCalls.length > 0, JSON.stringify(drained.fetchCalls));
  assert.deepEqual(drained.storage?.error, undefined);
  assertNoBlockedFetch(drained);
});


test('native model workspace replacement forks queues and binds token/private services to the new database', { timeout: 30000 }, async t => {
  const directory = temporaryDirectory(), port = await freePort();
  const harness = startServer(t, { directory, port, setup: setupState({ account: 'google-a', monitoring: false }), extraEnv: {
    UNPROMPTED_MODEL_BASE_URL: 'https://model.fixture.invalid/v1', UNPROMPTED_MODEL_NAME: 'workspace103-native',
    UNPROMPTED_MODEL_API_KEY: '', UNPROMPTED_MODEL_ROLE: 'primary', UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE: '0'
  } });
  await waitReady(harness); const before = await freshDiagnostics(harness);
  const first = before.modelOwners.find(owner => owner.filename === before.currentStore.filename && !owner.closed);
  assert.equal(first?.model, 'workspace103-native'); assert.equal(first.tokenOwned, true); assert.equal(first.privateOwned, true);
  writeSetup(directory, setupState({ account: 'google-b', monitoring: false })); const response = await activate(harness, false);
  assert.equal(response.status, 200, response.text); const after = await freshDiagnostics(harness);
  assert.notEqual(after.currentStore.filename, before.currentStore.filename); assert.equal(after.currentStore.closed, false);
  const current = after.modelOwners.find(owner => owner.filename === after.currentStore.filename && !owner.closed);
  assert.equal(current?.model, 'workspace103-native'); assert.equal(current.tokenOwned, true); assert.equal(current.privateOwned, true);
  assertOneReceiver(after); assertNoBlockedFetch(after);
});
