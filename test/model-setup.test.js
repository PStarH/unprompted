import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeModelSettings, validateModelSettings } from '../src/model-setup.js';
import { LocalSetupStore } from '../src/setup.js';
import { WorkEngine } from '../src/engine.js';
import { JsonStore } from '../src/store.js';
import { buildScenario } from '../src/connectors/simulated.js';

const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
const reading = { deliverable: 'proposal', subjectEntity: 'Cedar', intent: 'update_and_send', requiredContent: [{ text: 'sample size', sourceQuote: 'sample size', sourceField: 'body' }] };

test('model setup preserves a key only for the same endpoint and never accepts credentials in URLs', () => {
  const prior = { baseUrl: 'https://provider.example/v1', apiKey: 'private-fixture-key' };
  assert.equal(normalizeModelSettings({ baseUrl: prior.baseUrl + '/chat/completions', model: 'model' }, prior).apiKey, prior.apiKey);
  assert.equal(normalizeModelSettings({ baseUrl: 'https://another.example/v1', model: 'model' }, prior).apiKey, null);
  assert.throws(() => normalizeModelSettings({ baseUrl: 'https://user:password@provider.example/v1', model: 'model' }), /without credentials/);
  assert.throws(() => normalizeModelSettings({ baseUrl: 'https://provider.example/v1?key=private', model: 'model' }));
  assert.equal(normalizeModelSettings({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' }).apiKey, null);
});

test('connection verification requires a provider response, uses only invented content, and activates primary reasoning', async () => {
  const requests = [];
  const settings = normalizeModelSettings({ baseUrl: 'https://provider.example/v1', model: 'fixture', apiKey: 'private-fixture-key' });
  const checked = await validateModelSettings(settings, { fetchImpl: async (url, options) => {
    requests.push({ url, options }); return response(reading);
  } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://provider.example/v1/chat/completions');
  assert.equal(requests[0].options.headers.authorization, 'Bearer private-fixture-key');
  assert.match(requests[0].options.body, /Cedar/);
  assert.equal(checked.validation.status, 'verified');
  assert.equal(checked.reasoner.preferModelInterpretation, true);
  assert.equal(checked.reasoner.calls, 1);
});

test('auth failures, unreachable providers and ungrounded responses cannot become verified connections', async () => {
  const settings = normalizeModelSettings({ baseUrl: 'https://provider.example/v1', model: 'fixture', apiKey: 'private-fixture-key' });
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401, headers: new Headers() }),
    async () => { throw new Error('connection refused private-fixture-key'); },
    async () => response({ deliverable: 'invented', subjectEntity: 'Somewhere' })
  ]) await assert.rejects(validateModelSettings(settings, { fetchImpl }), error => {
    assert.doesNotMatch(error.message, /private-fixture-key/); return true;
  });
});

test('saved model settings survive restart, do not expose keys, and do not grant external writes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-model-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'setup.json');
  const setup = new LocalSetupStore({ filePath });
  setup.saveModel(normalizeModelSettings({ baseUrl: 'https://provider.example/v1', model: 'fixture', apiKey: 'private-fixture-key' }), { status: 'verified' });
  const reopened = new LocalSetupStore({ filePath });
  assert.equal(reopened.runtimeEnv({}).UNPROMPTED_MODEL_API_KEY, 'private-fixture-key');
  assert.equal(reopened.runtimeEnv({}).UNPROMPTED_MODEL_ROLE, 'primary');
  assert.equal(reopened.get().permissions.allowExternalWrites, false);
  assert.doesNotMatch(JSON.stringify(reopened.publicStatus()), /private-fixture-key/);
  assert.equal(reopened.publicStatus().model.hasApiKey, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  reopened.clearModel(); assert.equal(reopened.runtimeEnv({}).UNPROMPTED_MODEL_API_KEY, undefined);
});

function setupEngine(t, interpretRequest) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-primary-model-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const reasoner = { id: 'fixture-model', preferModelInterpretation: true, available: () => true, interpretRequest };
  const engine = new WorkEngine(store, { reasoner });
  const events = buildScenario(Date.now());
  for (const { event } of events) engine.ingest(event);
  return { engine, store, task: () => Object.values(store.state.tasks)[0] };
}
const northstar = { deliverable: 'proposal', subjectEntity: 'Northstar', intent: 'update_and_send', requiredContent: [{ text: 'sample size', sourceQuote: 'sample size', sourceField: 'body' }] };

test('primary reasoning must finish before a rule-covered request can be approved or automatically sent', async t => {
  let resolve, calls = 0;
  const deferred = new Promise(done => { resolve = done; });
  const { engine, store, task } = setupEngine(t, async () => { calls++; return deferred; });
  assert.equal(calls, 1);
  assert.notEqual(task().status, 'ready_for_approval');
  assert.throws(() => engine.approve(task().id), /Model interpretation/);
  assert.throws(() => engine.executePreAuthorized(task().id), /Model interpretation/);
  assert.equal(store.state.outbox.length, 0);
  resolve(northstar); await engine.whenSettled();
  assert.equal(task().modelReview.status, 'verified');
  assert.equal(task().status, 'ready_for_approval');
  await engine.approve(task().id);
  assert.equal(task().action.status, 'verified_simulated');
  assert.equal(store.state.outbox.length, 1);
});

test('a failed or empty primary model response never silently falls back to a ready rule-based reply', async t => {
  for (const response of [null, new Error('model unavailable')]) {
    const { engine, store, task } = setupEngine(t, async () => { if (response instanceof Error) throw response; return response; });
    await engine.whenSettled();
    assert.notEqual(task().status, 'ready_for_approval');
    assert.equal(task().draft, null);
    assert.equal(task().reasoningWork.status, 'failed');
    assert.equal(store.state.outbox.length, 0);
  }
});

test('a primary model cannot remove an original verifiable requirement', async t => {
  const { engine, task } = setupEngine(t, async () => northstar);
  await engine.whenSettled();
  assert.ok(task().request.requiredContent.some(item => /conclusion/i.test(item.text)));
  const document = engine.store.state.documents[task().documentId];
  engine.ingest({ id: 'missing-conclusion-event', type: 'document.modified', source: 'simulated',
    payload: { id: document.id, title: document.title, kind: document.kind, content: document.content.replace(/Conclusion:[^\n]*/g, ''), modifiedAt: new Date(Date.now() + 60_000).toISOString() } });
  assert.notEqual(task().status, 'ready_for_approval');
  assert.equal(task().draft, null);
});

test('the persistent source launcher starts unconfigured without playing the rule demo or removing state', { timeout: 20_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-source-launch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
  const child = spawn(process.execPath, ['scripts/start.mjs', '--no-open'], { cwd: root,
    env: { ...env, UNPROMPTED_CONFIG_DIR: path.join(directory, 'config'), UNPROMPTED_STATE_FILE: path.join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  try {
    const deadline = Date.now() + 12_000;
    while (!output.includes('Ready →') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const base = output.match(/Ready → (http:\/\/127\.0\.0\.1:\d+)\//)?.[1];
    assert.ok(base, output);
    const runtime = await (await fetch(base + '/api/runtime')).json();
    assert.equal(runtime.reasoner.available, false);
    assert.equal(runtime.simulationRunning, false);
    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.events.length, 0);
    const setup = await (await fetch(base + '/api/setup')).json();
    assert.equal(setup.model.hasApiKey, false);
  } finally {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    assert.equal(await exited, 0); clearTimeout(timeout);
  }
  assert.equal(fs.existsSync(path.join(directory, 'state.json')), true);
});

test('a keyless saved model never inherits an orphaned environment key for another provider', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-key-isolation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  setup.saveModel(normalizeModelSettings({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' }), { status: 'verified' });
  const env = setup.runtimeEnv({ UNPROMPTED_MODEL_API_KEY: 'orphaned-private-fixture-key' });
  assert.equal(env.UNPROMPTED_MODEL_API_KEY, undefined);
  assert.equal(env.UNPROMPTED_MODEL_BASE_URL, 'http://127.0.0.1:11434/v1');
});

test('connecting through the interface retains launch-budget limits without inheriting endpoint credentials', async () => {
  let authorization;
  const settings = normalizeModelSettings({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' });
  const checked = await validateModelSettings(settings, {
    budgetEnv: { UNPROMPTED_MODEL_API_KEY: 'orphaned-private-fixture-key', UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE: '3' },
    fetchImpl: async (url, options) => { authorization = options.headers.authorization; return response(reading); }
  });
  assert.equal(authorization, undefined);
  assert.equal(checked.reasoner.budget.limits.maxCallsPerMinute, 3);
});
