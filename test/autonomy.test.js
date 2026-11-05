import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';
import { NullReasoner } from '../src/reasoning.js';

function fixture(t, { durable = false, shadow = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-yolo-'));
  const filename = path.join(root, 'state.json');
  const store = new (durable ? SqliteStore : JsonStore)(filename);
  const engine = new WorkEngine(store, { reasoner: new NullReasoner(), policy: new PermissionPolicy({ shadow }) });
  const runtime = durable ? new DurableRuntime(engine, { tickMs: 100000 }) : null;
  let now = Date.now();
  engine.autonomy.now = () => now;
  t.after(async () => { await engine.whenSettled(); await runtime?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { engine, store, filename, advance: ms => { now += ms; } };
}
const email = (id = 'm1', project = 'Northstar') => ({ id: `email:${id}`, type: 'email.received', payload: {
  id, from: 'alex@example.test', subject: `${project} proposal — experiment results`,
  body: `Please update the ${project} project proposal with the latest experiment results and send the revised proposal by Friday.`
} });
const doc = (project = 'Northstar') => ({ id: `doc:${project}`, type: 'document.modified', payload: {
  id: `${project.toLowerCase()}-proposal`, kind: 'proposal', title: `${project} project proposal`,
  content: `# ${project} project proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n`
} });
async function ready(engine) { engine.ingest(email()); engine.ingest(doc()); await engine.whenSettled(); }

test('task YOLO executes only that task and expires on completion', async t => {
  const { engine, store } = fixture(t);
  await ready(engine);
  engine.ingest(email('m2', 'Cedar')); engine.ingest(doc('Cedar'));
  const grant = engine.autonomy.create({ mode: 'task', taskId: 'request:m1' });
  await engine.whenSettled();
  assert.equal(store.state.tasks['request:m1'].status, 'completed');
  assert.equal(store.state.tasks['request:m1'].action.permission, 'temporary_yolo');
  assert.equal(store.state.tasks['request:m1'].action.grantId, grant.id);
  assert.equal(store.state.tasks['request:m2'].status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 1);
  assert.equal(engine.autonomy.describe().grants.length, 0);
  assert.equal(engine.autonomy.forTask('request:m1'), null);
});

test('workspace time YOLO covers new tasks until its exact deadline', async t => {
  const { engine, store, advance } = fixture(t);
  engine.autonomy.create({ mode: 'time', durationMinutes: 30 });
  await ready(engine);
  assert.equal(store.state.outbox.length, 1);
  advance(30 * 60000);
  engine.ingest(email('m2', 'Cedar')); engine.ingest(doc('Cedar'));
  await engine.whenSettled();
  assert.equal(store.state.tasks['request:m2'].status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 1);
  assert.equal(engine.publicState().autonomy.grants.length, 0);
});

for (const event of ['expiry', 'revocation']) test(`YOLO ${event} while provider lookup is pending prevents dispatch`, async t => {
  const { engine, store, advance } = fixture(t);
  await ready(engine);
  let release;
  engine.provider.lookup = () => new Promise(resolve => { release = resolve; });
  const grant = engine.autonomy.create({ mode: 'time', durationMinutes: 1 });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  if (event === 'expiry') advance(60000); else engine.autonomy.revoke(grant.id);
  release({ status: 'not_found' });
  await engine.whenSettled();
  assert.equal(store.state.outbox.length, 0);
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  assert.equal(store.state.tasks['request:m1'].action, null);
});

test('cancelled task lease stays revoked after reopening', async t => {
  const { engine } = fixture(t);
  engine.ingest(email());
  engine.autonomy.create({ mode: 'task', taskId: 'request:m1' });
  engine.cancel('request:m1'); engine.reopen('request:m1');
  assert.equal(engine.autonomy.forTask('request:m1'), null);
});

test('lease validation refuses invalid scopes, durations, shadow writes and forged grants', async t => {
  const { engine } = fixture(t);
  for (const input of [null, [], { mode: 'forever' }, { mode: 'task', taskId: 'absent' }, { mode: 'task', taskId: '__proto__' },
    ...[0, -1, NaN, Infinity, 1441, '30'].map(durationMinutes => ({ mode: 'time', durationMinutes })),
    { mode: 'time', durationMinutes: 30, taskId: 'request:m1' }]) {
    assert.throws(() => engine.autonomy.create(input), { code: 'INVALID_AUTONOMY' });
  }
  assert.throws(() => engine.policy.authorize({ actionClass: 'execute_external', taskId: 'request:m1',
    approval: { permission: 'temporary_yolo', taskId: 'request:m1', grantId: 'invented' } }), /YOLO authorization/);
  const shadow = fixture(t, { shadow: true });
  assert.throws(() => shadow.engine.autonomy.create({ mode: 'time', durationMinutes: 30 }), /write mode/);
});

test('an active lease survives JSON restart with its original deadline', async t => {
  const { engine, store, filename } = fixture(t);
  const grant = engine.autonomy.create({ mode: 'time', durationMinutes: 30 });
  await engine.whenSettled(); store.close();
  const reopened = new JsonStore(filename);
  t.after(() => reopened.close());
  const next = new WorkEngine(reopened, { reasoner: new NullReasoner() });
  assert.deepEqual(next.autonomy.describe().grants, [grant]);
  await next.whenSettled();
});

test('durable workspace dispatches YOLO through the execution ledger and persists the lease', async t => {
  const { engine, store } = fixture(t, { durable: true });
  await ready(engine);
  const grant = engine.autonomy.create({ mode: 'time', durationMinutes: 30 });
  await engine.whenSettled();
  assert.equal(store.state.tasks['request:m1'].status, 'completed');
  assert.equal(store.state.outbox.length, 1);
  assert.equal(engine.durableRuntime.ledger.list({ taskId: 'request:m1' })[0].status, 'verified');
  store.refresh();
  assert.equal(engine.autonomy.describe().grants[0].id, grant.id);
});

for (const durable of [false, true]) test(`task YOLO applies a source-backed patch (${durable ? 'SQLite' : 'JSON'})`, async t => {
  const { engine, store } = fixture(t, { durable });
  engine.ingest(email());
  engine.ingest({ ...doc(), payload: { ...doc().payload, content: '# Northstar project proposal\n## Experiment results\n' } });
  await engine.whenSettled();
  store.mutate(state => { state.inbox[0].body += '\nPilot result: 12.5%'; });
  const patch = await engine.taskServices.prepareDocumentPatch('request:m1', { provider: 'local', changes: [
    { type: 'append', text: 'Pilot result: 12.5%', source: { kind: 'email', id: 'm1', quote: 'Pilot result: 12.5%' } }
  ] });
  assert.equal(patch.status, 'prepared');
  engine.autonomy.create({ mode: 'task', taskId: 'request:m1' });
  await engine.whenSettled();
  assert.equal(store.state.documentPatches[patch.id].status, 'applied');
  assert.equal(store.state.documentPatches[patch.id].authorization.kind, 'temporary_yolo');
  assert.match(store.state.documents['northstar-proposal'].content, /Pilot result: 12.5%/);
});
