import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLifecycle } from '../eval/lifecycle.js';

test('whole-work harness trajectories preserve outcomes across edits, delivery, failures and restart', async () => {
  const report = await evaluateLifecycle();
  assert.equal(report.total, 5);
  assert.equal(report.passed, report.total, JSON.stringify(report.checks.filter(item => !item.passed)));
});
