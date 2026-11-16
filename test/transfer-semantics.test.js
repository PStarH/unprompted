import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connector } from '../src/connectors/connector.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';

const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
function connector(fetchImpl) {
  const c = new Connector({ id: 'github', kind: 'code', fetchImpl });
  c.live = true; c.account = { id: 'account-1' }; c.auth = { accessToken: async () => 'private-token' }; return c;
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-semantics-'));
  const store = new SqliteStore(path.join(dir, 'state.json'));
  const writes = []; let record = { id: 42, title: 'Before' };
  const c = connector(async (_url, options) => {
    if (options.method !== 'GET') { writes.push(options); record = { ...record, ...JSON.parse(options.body || '{}') }; }
    return response(record);
  });
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: false }) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => id === c.id ? c : null });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  engine.ingest({ id: 'email:m1', type: 'email.received', payload: { id: 'm1', threadId: 't1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
  await engine.whenSettled();
  const taskId = 'request:m1'; assert.ok(runtime.tasks.get(taskId));
  return { runtime, engine, store, c, writes, taskId };
}
const input = context => ({ connectorId: 'github', request: { method: 'PATCH', path: '/repos/owner/repo/issues/42', body: { title: 'After' } }, confirmed: true, inputVersion: context.runtime.tasks.get(context.taskId).inputVersion });
const scopedGrant = { connectorId: 'github', pathPrefix: '/repos/owner/repo', methods: ['PATCH'], confirmed: true };
const model = () => ({ actor: 'model', isCurrent: () => true });

test('grants default to unknown transfer semantics, validate the declaration and keep it in the duplicate identity', async t => {
  const c = await fixture(t), actions = c.runtime.connectorActions;
  const grant = actions.createGrant(scopedGrant);
  assert.equal(grant.transfer, 'unknown');
  assert.equal(actions.describe().grants.find(item => item.id === grant.id).transfer, 'unknown');
  assert.throws(() => actions.createGrant({ ...scopedGrant, transfer: 'paid' }), error => error.code === 'INVALID_CONNECTOR_GRANT' && error.status === 400);
  assert.throws(() => actions.createGrant({ ...scopedGrant, transfer: null }), error => error.code === 'INVALID_CONNECTOR_GRANT' && error.status === 400);
  assert.throws(() => actions.createGrant({ ...scopedGrant, transfer: 'nonfinancial' }, { actor: 'model' }), /Confirm which connected account/);
  const other = actions.createGrant({ ...scopedGrant, transfer: 'nonfinancial' });
  assert.notEqual(other.id, grant.id); assert.equal(other.transfer, 'nonfinancial');
  assert.equal(actions.createGrant({ ...scopedGrant, transfer: 'nonfinancial' }).id, other.id);
  assert.equal(actions.createGrant(scopedGrant).id, grant.id);
});

test('model writes under an unknown grant are denied before any dispatch or ledger intent', async t => {
  const c = await fixture(t), actions = c.runtime.connectorActions;
  actions.createGrant(scopedGrant);
  c.runtime.contextReady = () => true;
  await assert.rejects(actions.request(c.taskId, input(c), model()), error => error.code === 'TRANSFER_REVIEW_REQUIRED' && error.status === 403 && /needs explicit user review/.test(error.message));
  assert.equal(c.writes.length, 0);
  assert.equal(c.runtime.ledger.list().filter(item => item.action_family === 'connector.request').length, 0);
  assert.equal((c.runtime.tasks.get(c.taskId).platformRequests || []).length, 0);
});

test('model writes under a nonfinancial grant dispatch once and stay deduplicated', async t => {
  const c = await fixture(t), actions = c.runtime.connectorActions;
  actions.createGrant({ ...scopedGrant, transfer: 'nonfinancial' });
  c.runtime.contextReady = () => true;
  const result = await actions.request(c.taskId, input(c), model());
  assert.equal(result.state, 'accepted'); assert.equal(c.writes.length, 1);
  const records = c.runtime.tasks.get(c.taskId).platformRequests;
  assert.equal(records.length, 1); assert.equal(records[0].transferSemantics, 'nonfinancial');
  const again = await actions.request(c.taskId, input(c), model());
  assert.equal(again.alreadyDispatched, true); assert.equal(c.writes.length, 1);
});

test('explicit user writes under unknown semantics proceed with a null-amount disclosure', async t => {
  const c = await fixture(t), actions = c.runtime.connectorActions;
  actions.createGrant(scopedGrant);
  const result = await actions.request(c.taskId, input(c), { actor: 'user' });
  assert.equal(result.state, 'accepted'); assert.equal(c.writes.length, 1);
  assert.deepEqual(result.transfer, { semantics: 'unknown', amount: null });
  const record = c.runtime.tasks.get(c.taskId).platformRequests[0];
  assert.equal(record.transferSemantics, 'unknown'); assert.equal(record.explicit, true);
});

test('a grant replaced with unknown semantics before dispatch denies the model write', async t => {
  const c = await fixture(t), actions = c.runtime.connectorActions;
  const grant = actions.createGrant({ ...scopedGrant, transfer: 'nonfinancial' });
  c.runtime.contextReady = () => true;
  let replaced = false;
  c.c.auth.accessToken = async () => {
    const grants = actions.grants(), current = grants.find(item => item.id === grant.id);
    current.transfer = 'unknown'; c.runtime.database.set('connector_action_grants', JSON.stringify(grants)); replaced = true;
    return 'private-token';
  };
  await assert.rejects(actions.request(c.taskId, input(c), model()), error => error.code === 'TRANSFER_REVIEW_REQUIRED');
  assert.equal(replaced, true); assert.equal(c.writes.length, 0);
});

test('request payloads cannot declare transfer semantics', async t => {
  const c = await fixture(t), actions = c.runtime.connectorActions;
  actions.createGrant(scopedGrant);
  await assert.rejects(actions.request(c.taskId, { ...input(c), transfer: 'nonfinancial' }, { actor: 'user' }), error => error.code === 'INVALID_PLATFORM_ACTION' && error.status === 400);
  assert.equal(c.writes.length, 0);
});
