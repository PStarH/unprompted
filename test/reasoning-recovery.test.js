import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningFailure, reasoningMayResume, retryAfterMs } from '../src/reasoning-recovery.js';

const work = { attempts: 1, maxAttempts: 2 };

test('only transient read failures receive automatic retries', () => {
  const examples = [
    [Object.assign(new Error('Network request'), { code: 'ECONNRESET' }), true],
    [Object.assign(new Error('Upstream unavailable'), { status: 503 }), true],
    [Object.assign(new Error('Reasoning skipped: queue is full'), { code: 'REASONING_BUDGET' }), true],
    [Object.assign(new Error('Reasoning skipped: budget exhausted for this request'), { code: 'REASONING_BUDGET' }), false],
    [new SyntaxError('Invalid JSON near "timeout"'), false],
    [Object.assign(new Error('The network endpoint requires authorization'), { status: 401 }), false],
    [new Error('The document is outside this task scope.'), false]
  ];
  for (const [error, retryable] of examples) {
    const policy = reasoningFailure(error, work, 1000);
    assert.equal(policy.retryable, retryable, error.message);
    assert.equal(Boolean(policy.retryAt), retryable, error.message);
  }
});

test('rate-limited reads wait for the rate window and never bypass the saved attempt ceiling', () => {
  const error = Object.assign(new Error('Rate limited'), { status: 429 });
  const policy = reasoningFailure(error, work, 1000);
  assert.equal(Date.parse(policy.retryAt), 61_000);
  assert.equal(reasoningMayResume({ ...work, ...policy, status: 'failed' }, 60_999, { automatic: true }), false);
  assert.equal(reasoningMayResume({ ...work, ...policy, status: 'failed' }, 61_000, { automatic: true }), true);
  const exhausted = reasoningFailure(error, { attempts: 2, maxAttempts: 2 }, 1000);
  assert.equal(exhausted.retryAt, null);
  assert.equal(exhausted.terminalReason, 'attempts_exhausted');
  assert.equal(reasoningMayResume({ attempts: 2, maxAttempts: 2, ...exhausted, status: 'failed' }, 999_999), false);
  const advised = reasoningFailure(Object.assign(error, { retryAfterMs: 180_000 }), work, 1000);
  assert.equal(Date.parse(advised.retryAt), 181_000, 'a longer provider delay is never shortened to the local backoff');
  const tooLong = reasoningFailure(Object.assign(error, { retryAfterMs: 172_800_000 }), work, 1000);
  assert.equal(tooLong.retryAt, null, 'a provider pause outside the automatic window stops instead of retrying early');
  assert.equal(tooLong.terminalReason, 'provider_delay_exceeds_window');
  assert.equal(retryAfterMs('180'), 180_000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:03:00 GMT', 1000), 179_000);
  assert.equal(retryAfterMs('invalid'), null);
});

test('automatic maintenance does not invent retries for legacy failures or terminal work', () => {
  const legacy = { ...work, status: 'failed' };
  assert.equal(reasoningMayResume(legacy, 1000, { automatic: true }), false);
  assert.equal(reasoningMayResume(legacy, 1000), true, 'legacy startup/manual recovery retains its bounded behavior');
  for (const status of ['complete', 'no_proposal', 'superseded']) assert.equal(reasoningMayResume({ ...work, status }, 1000), false);
  assert.equal(reasoningMayResume({ ...work, status: 'running' }, 1000, { automatic: true }), true);
  assert.equal(reasoningMayResume({ ...work, status: 'failed', retryable: true, retryAt: 'invalid' }, 1000), false);
});
