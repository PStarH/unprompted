import test from 'node:test';
import assert from 'node:assert/strict';
import { openActivationReplay } from '../src/durable/activation-replay.js';

const request = id => ({ id: `event:${id}`, type: 'email.received', source: 'google', connectorId: 'google', at: '2026-10-28T12:00:00.000Z',
  meta: { principalRole: 'DIRECT_ACTOR', roleEvidence: { basis: 'sole_to_recipient' } },
  payload: { id, threadId: `thread-${id}`, from: 'alex@example.test', to: 'reader@example.test', subject: 'Cedar proposal', receivedAt: '2026-10-28T12:00:00.000Z',
    body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });

function open(t, state) {
  const env = openActivationReplay();
  t.after(() => env.close());
  env.connector.live = true;
  env.connector.sourceMessageState = async id => { env.calls.push({ tool: 'source', id }); return state(id); };
  return env;
}

test('a source message the provider confirms is gone stops the send and invalidates the task', async t => {
  const env = open(t, () => ({ status: 'missing', reason: 'trashed' }));
  env.engine.ingest(request('m1')); await env.settle();
  const task = env.runtime.tasks.get('request:m1');
  await assert.rejects(env.runtime.recheckSourceMessage(task), error => error.code === 'SOURCE_UNAVAILABLE' && error.definitiveNoEffect === true);
  assert.deepEqual(env.calls.filter(call => call.tool === 'source').map(call => call.id), ['m1']);
  assert.equal(env.store.state.tasks['request:m1'].sourceUnavailable.reason, 'trashed');
  assert.equal(env.store.state.inbox.find(item => item.id === 'm1').available, false);
  assert.equal(env.store.state.outbox.length, 0);
});

test('a present, unknown or failed recheck leaves the send alone, and an offline connector is not called', async t => {
  let state = () => ({ status: 'present' });
  const env = open(t, id => state(id));
  env.engine.ingest(request('m2')); await env.settle();
  const task = () => env.runtime.tasks.get('request:m2');
  for (const next of [() => ({ status: 'present' }), () => ({ status: 'unknown' }), () => { throw new Error('network down'); }]) {
    state = next;
    assert.notEqual((await env.runtime.recheckSourceMessage(task())).status, 'missing');
  }
  assert.equal(env.store.state.tasks['request:m2'].sourceUnavailable, undefined);
  const calls = env.calls.filter(call => call.tool === 'source').length;
  state = () => ({ status: 'missing' });
  env.connector.live = false;
  assert.equal((await env.runtime.recheckSourceMessage(task())).status, 'unknown');
  assert.equal(env.calls.filter(call => call.tool === 'source').length, calls, 'no provider call while offline');
  assert.equal(env.store.state.tasks['request:m2'].sourceUnavailable, undefined);
});
