import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_FAULTS,
  LIMITS,
  runSoak,
  planFaults,
  parseArguments,
  privacyViolations,
  entityForSequence,
  entityCapacity,
  proofIdsAgree,
  SyntheticRemote,
  SyntheticMailProvider
} from '../eval/soak.js';

/**
 * These exercise the real runner against the real durable store. Every
 * assertion reads a report the runner produced (or the raw remote fixture);
 * no counter is reimplemented here.
 *
 * Cost is kept deliberate: short focused regressions run first, the one
 * continuous 32-cycle workspace run at the end, and the fault matrix is never
 * replayed in full more than once.
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratch() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-soak-test-'));
  return {
    directory,
    output: path.join(directory, 'report.json'),
    remove: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

const checkFor = (report, id) => report.checks.results.find(check => check.id === id);
const planned = (seed, maxCycles, fault) => planFaults(seed, { maxCycles }).filter(step => step.fault === fault).length;
const PRIVATE_FRAGMENTS = ['@example.test', 'Please update the', 'synthetic:', 'request:', 'send:', 'soak-mail-', 'soak-doc-'];

test('a one-cycle run reports the measured shape and cannot claim the matrix', { timeout: 120000 }, async () => {
  const { output, remove } = scratch();
  try {
    const report = await runSoak({ durationMs: 120000, maxCycles: 1, seed: 11, output });

    assert.equal(report.kind, 'synthetic-soak');
    assert.equal(report.version, 2);
    assert.equal(report.seed, 11);
    assert.equal(report.cycles, 1);
    assert.equal(report.maxCycles, 1);
    assert.equal(report.wallBoundMs, 120000 + LIMITS.maxCycleMs + LIMITS.cleanupTimeoutMs);
    assert.ok(report.elapsedMs > 0);

    // One normal cycle is measured as its own per-task chain, not renamed
    // aggregate totals.
    assert.deepEqual(report.normal, { cycles: 1, prepared: 1, approved: 1, verified: 1, completed: 1 });
    for (const id of ['normal-cycle-prepared', 'normal-cycle-explicitly-approved', 'normal-cycle-executed-and-verified', 'normal-cycle-completed']) {
      assert.equal(checkFor(report, id).passed, true, id);
    }
    assert.equal(report.tasks.completed, 1);
    assert.equal(report.tasks.verified, 1);
    assert.deepEqual(report.tasks.completedWithoutVerifiedAction, []);

    // One cycle covers one scenario. Everything else is uncovered and the run
    // is not successful, however green the single scenario is.
    assert.equal(report.coverage.complete, false);
    assert.deepEqual(report.coverage.uncovered, REQUIRED_FAULTS.filter(fault => fault !== 'normal_cycle'));
    assert.equal(checkFor(report, 'fault-matrix-covered').passed, false);
    assert.equal(report.success, false);
    assert.ok(report.checks.failed > 0);

    // Required sections, all measured from the run.
    for (const key of ['events', 'tasks', 'verification', 'provider', 'faults', 'scenarios', 'recoveries', 'restarts', 'normal', 'duplicate', 'burst', 'timeout', 'rateLimit', 'unknownWrite', 'oauth', 'identities', 'drain', 'cleanup', 'memory', 'latency', 'notifications', 'model', 'tokenUsage', 'durable', 'coverage', 'checks']) {
      assert.ok(report[key] && typeof report[key] === 'object', `missing report section: ${key}`);
    }
    assert.equal(report.provider.kind, 'synthetic');
    assert.equal(report.provider.nativeIdempotent, true);
    assert.equal(report.provider.accepted, 1);
    assert.equal(report.provider.effects, 1);
    assert.equal(report.provider.duplicateAfterAccept, 0);
    assert.equal(report.provider.sendAttempts, report.provider.accepted + report.provider.failedBeforeAccept + report.provider.duplicateAfterAccept);
    assert.equal(report.memory.rssPeakBytes >= report.memory.rssBaselineBytes, true);
    assert.equal(report.cleanup.timedOut, false);
    assert.equal(report.drain.attempted, true);
    assert.equal(report.pendingJobsAtEnd, 0);
    assert.equal(report.drain.passed, true);
    assert.equal(report.drain.queueEmptyAtEnd, true);
    assert.equal(report.scenarios.normal_cycle.tasks.prepared, 1);

    // The privacy gate is a property of the written artefact.
    assert.equal(checkFor(report, 'report-contains-no-private-fields').passed, true);
    const serialised = fs.readFileSync(output, 'utf8');
    for (const fragment of PRIVATE_FRAGMENTS) {
      assert.equal(serialised.includes(fragment), false, `the report leaked ${fragment}`);
    }
  } finally { remove(); }
});

test('the fault plan is a pure function of the seed', () => {
  const first = planFaults(7, { maxCycles: 24 });
  assert.deepEqual(planFaults(7, { maxCycles: 24 }), first, 'the same seed must replay the same plan');
  assert.equal(first.length, 24);
  assert.deepEqual(first.slice(0, REQUIRED_FAULTS.length).map(step => step.fault), [...REQUIRED_FAULTS]);
  assert.notDeepEqual(planFaults(8, { maxCycles: 24 }), first, 'a different seed must produce a different plan');
  assert.deepEqual(planFaults(7, { maxCycles: 1 }).map(step => step.fault), ['normal_cycle']);
});

test('generated entities stay unique and matcher-readable past the 24-item boundary', () => {
  assert.equal(entityCapacity(), 26 ** 4);
  // The largest supported plan generates three burst items per cycle, so the
  // label space must cover 30,000 items, not just 10,000 cycles.
  assert.ok(entityCapacity() >= LIMITS.maxCycles * 3, 'the entity space must cover the maximum generated items');
  const itemCount = 30000;
  const labels = new Set();
  for (let sequence = 0; sequence < itemCount; sequence += 1) labels.add(entityForSequence(sequence));
  assert.equal(labels.size, itemCount);
  assert.match(entityForSequence(24), /^Zx[A-Z][a-z]{3} Ledger$/);
  assert.match(entityForSequence(17575), /^Zx[A-Z][a-z]{3} Ledger$/);
  assert.match(entityForSequence(29999), /^Zx[A-Z][a-z]{3} Ledger$/);
  assert.match(entityForSequence(entityCapacity() - 1), /^Zx[A-Z][a-z]{3} Ledger$/);
  assert.notEqual(entityForSequence(24), entityForSequence(25));
  assert.notEqual(entityForSequence(29999), entityForSequence(30000));
  // Out of range fails instead of wrapping or silently reusing a label.
  assert.throws(() => entityForSequence(entityCapacity()), error => error.code === 'SOAK_IDENTITY_RANGE');
  assert.throws(() => entityForSequence(-1), error => error.code === 'SOAK_IDENTITY_RANGE');
  assert.throws(() => entityForSequence(1.5), error => error.code === 'SOAK_IDENTITY_RANGE');
});

test('repeated deliveries produce no second external effect', { timeout: 120000 }, async () => {
  const { output, remove } = scratch();
  try {
    const report = await runSoak({ durationMs: 120000, maxCycles: 2, seed: 5, output });
    assert.ok(report.duplicate.repeats >= 3, `expected repeated deliveries, saw ${report.duplicate.repeats}`);
    assert.equal(report.duplicate.cycles, 1);
    assert.equal(report.duplicate.oneEffect, 1);
    assert.equal(report.duplicate.verified, 1);
    assert.equal(checkFor(report, 'duplicate-delivery-produces-one-effect').passed, true);
    assert.equal(checkFor(report, 'duplicate-delivery-keeps-the-verified-result').passed, true);
    assert.equal(report.provider.duplicateAfterAccept, 0);
    assert.equal(report.provider.effects, report.provider.accepted);
    // Only two of the eight scenarios ran, so the run is not a success.
    assert.equal(report.coverage.complete, false);
    assert.equal(report.success, false);
  } finally { remove(); }
});

test('a crash with a write in flight reopens the same database and recovers it', { timeout: 300000 }, async () => {
  const { output, remove } = scratch();
  try {
    // Cycles 0..6 include the crash/reopen scenario. It is the shortest run
    // that observes a real dispatched write before abandoning the workspace.
    const report = await runSoak({ durationMs: 300000, maxCycles: 7, seed: 20261112, output });
    assert.equal(report.restarts.count, 1);
    assert.equal(report.restarts.withUnfinishedWork, 1);
    assert.equal(report.restarts.factsLost, 0);
    assert.equal(report.restarts.recovered, 1);
    assert.ok(report.restarts.simulated.leaseExpiries >= 1);
    assert.equal(report.faults.injected.crashHang, 1);
    // The aggregate recovery report must equal the per-scenario facts, not
    // stay at zero while the scenario checks pass.
    assert.equal(report.recoveries.recovered.restart, report.restarts.recovered);
    assert.equal(report.recoveries.recovered.networkTimeout, report.timeout.recovered);
    assert.equal(report.recoveries.recovered.rateLimit, report.rateLimit.recovered);
    assert.equal(report.recoveries.consistent, true);
    assert.equal(checkFor(report, 'crash-observed-unfinished-work').passed, true);
    assert.equal(checkFor(report, 'crash-recovery-sends-no-second-copy').passed, true);
    assert.equal(checkFor(report, 'crash-recovery-verifies-the-interrupted-write').passed, true);
    assert.equal(report.provider.duplicateAfterAccept, 0);
    // The last required scenario has not run yet: incomplete, and not green.
    assert.equal(report.coverage.complete, false);
    assert.equal(report.success, false);
  } finally { remove(); }
});

test('a never-settling crash approval is rejected by the bounded step deadline', { timeout: 120000 }, async () => {
  const { output, remove } = scratch();
  try {
    // Cycles 0..6 reach the crash branch. Its approval settlement promise is
    // replaced by one that never settles; the real step deadline must reject
    // it and the report must fail, not hang.
    const report = await runSoak({ durationMs: 120000, maxCycles: 7, seed: 20261112, output, testHooks: { hangCrashApproval: true } });
    assert.equal(report.timedOut, true);
    assert.equal(report.success, false);
    assert.equal(checkFor(report, 'run-stayed-within-budget').passed, false);
    assert.equal(checkFor(report, 'no-internal-failure').passed, true);
    // The workspace was abandoned, so the final recovery phase did not run and
    // the check must say so rather than describing a phase that never happened.
    assert.equal(report.drain.attempted, false);
    assert.equal(checkFor(report, 'final-queue-drained').passed, false);
    assert.match(checkFor(report, 'final-queue-drained').detail, /not attempted/);
    assert.ok(report.elapsedMs < 60000, `the run took ${report.elapsedMs}ms`);
    assert.equal(fs.existsSync(output), true);
  } finally { remove(); }
});

test('an interrupt inside a cycle and between cycles is not an internal failure', { timeout: 120000 }, async () => {
  // Inside a cycle: runSoak has already suspended inside the first cycle's
  // settle when the abort fires, so SOAK_INTERRUPTED is thrown there.
  const insideScratch = scratch();
  const insideController = new AbortController();
  let inside;
  try {
    const pending = runSoak({ durationMs: 120000, maxCycles: 4, seed: 21, output: insideScratch.output, signal: insideController.signal });
    insideController.abort();
    inside = await pending;
  } finally { insideScratch.remove(); }

  // Between cycles: the abort fires from onProgress, after the first cycle
  // finished and before the between-cycle pause.
  const betweenScratch = scratch();
  const betweenController = new AbortController();
  let between;
  try {
    let aborted = false;
    between = await runSoak({
      durationMs: 120000, maxCycles: 4, seed: 22, output: betweenScratch.output, signal: betweenController.signal,
      onProgress: ({ cycles }) => { if (cycles === 1 && !aborted) { aborted = true; betweenController.abort(); } }
    });
  } finally { betweenScratch.remove(); }

  for (const report of [inside, between]) {
    assert.equal(report.interrupted, true);
    assert.equal(report.interruptReason, 'signal');
    assert.equal(report.success, false);
    // A user interrupt is not an internal failure. This is the L1 gate.
    assert.equal(checkFor(report, 'no-internal-failure').passed, true);
    // The final recovery phase did not run; the check says so and fails.
    assert.equal(report.drain.attempted, false);
    assert.equal(report.drain.passed, false);
    assert.equal(checkFor(report, 'final-queue-drained').passed, false);
    assert.match(checkFor(report, 'final-queue-drained').detail, /not attempted/);
    assert.equal(typeof report.drain.queueEmptyAtEnd, 'boolean');
  }
  // The two interrupt timings exercised different paths.
  assert.equal(inside.cycles, 0);
  assert.equal(between.cycles, 1);
  // The check list is stable: the same ids in the same order for both timings.
  const ids = report => report.checks.results.map(check => check.id);
  assert.deepEqual(ids(inside), ids(between));
  assert.equal(inside.checks.total, 38);
  assert.equal(between.checks.total, 38);
});

test('library-only negative controls drive their named gates non-green', { timeout: 600000 }, async () => {
  const withRun = async (hooks, maxCycles, seed, assertions) => {
    const { output, remove } = scratch();
    try {
      const report = await runSoak({ durationMs: 300000, maxCycles, seed, output, testHooks: hooks });
      return await assertions(report, fs.readFileSync(output, 'utf8'));
    } finally { remove(); }
  };

  // A broken normal preparation must fail the preparation gate itself.
  await withRun({ breakNormalPreparation: true }, 1, 41, report => {
    assert.equal(report.normal.cycles, 1);
    assert.equal(report.normal.prepared, 0);
    assert.equal(checkFor(report, 'normal-cycle-prepared').passed, false);
    assert.equal(report.success, false);
  });

  // A task forged into `completed` without a verified action must be caught by
  // the per-task audit, not hidden by totals.
  await withRun({ forgeCompletedWithoutVerification: true }, 1, 42, report => {
    assert.ok(report.tasks.completedWithoutVerifiedAction.length >= 1);
    assert.equal(checkFor(report, 'no-completion-without-verification').passed, false);
    assert.equal(report.success, false);
  });

  // Two missing idempotency keys must not compare equal and pass the audit:
  // the forged action and the real remote receipt both carry `undefined`.
  await withRun({ forgeUndefinedKeyVerification: true }, 1, 48, report => {
    assert.ok(report.tasks.completedWithoutVerifiedAction.length >= 1);
    assert.equal(checkFor(report, 'no-completion-without-verification').passed, false);
    assert.equal(report.success, false);
  });

  // Re-entering send for an accepted key is a blind resend even though the
  // natively idempotent remote keeps the effect count at one.
  await withRun({ resendAcceptedKey: true }, 1, 43, report => {
    assert.equal(report.provider.duplicateAfterAccept, 1);
    assert.equal(report.provider.effects, 1);
    assert.equal(report.provider.keysWithMoreThanOneEffect, 0);
    assert.equal(checkFor(report, 'no-blind-resend').passed, false);
    assert.equal(report.success, false);
  });

  // A fault active at resend time must not mask the accepted key: the attempt
  // is counted before the timeout branch, while the effect count stays at one
  // because no extra accept is made for detection.
  await withRun({ resendAcceptedKeyUnderFault: true }, 1, 47, report => {
    assert.equal(report.provider.duplicateAfterAccept, 1);
    assert.equal(report.provider.effects, 1);
    assert.equal(report.provider.accepted, 1);
    assert.equal(report.provider.failedBeforeAccept, 0);
    assert.equal(report.provider.sendAttempts, 2);
    assert.equal(report.provider.keysWithMoreThanOneEffect, 0);
    // The fault really fired on the resend (it is reported as an injection,
    // not as an accepted effect).
    assert.equal(report.recoveries.injected.networkTimeout, 1);
    assert.equal(checkFor(report, 'no-blind-resend').passed, false);
    assert.equal(report.success, false);
  });

  // A suppressed usage report is unknown, never a zero-token success.
  await withRun({ suppressUsage: true }, 1, 44, report => {
    assert.equal(report.tokenUsage.known, null);
    assert.equal(report.tokenUsage.unknown, true);
    assert.equal(checkFor(report, 'token-usage-accounted').passed, false);
    assert.equal(report.success, false);
  });

  // The failure path must not leak the bodies, addresses or ids it failed on.
  await withRun({ failWithPrivateError: true }, 1, 45, (report, serialised) => {
    assert.equal(checkFor(report, 'no-cycle-errors').passed, false);
    assert.equal(checkFor(report, 'report-contains-no-private-fields').passed, true);
    assert.equal(report.success, false);
    for (const fragment of PRIVATE_FRAGMENTS) {
      assert.equal(serialised.includes(fragment), false, `the failure report leaked ${fragment}`);
    }
  });

  // If the 401 never fires, the coverage must lose it rather than count the
  // planned scenario as observed.
  await withRun({ skipInjection: 'network_timeout' }, 4, 46, report => {
    assert.equal(report.timeout.injected, 0);
    assert.ok(report.coverage.uncovered.includes('network_timeout'));
    assert.equal(checkFor(report, 'network-timeout-is-not-silence').passed, false);
    assert.equal(report.coverage.complete, false);
    assert.equal(report.success, false);
  });
});

test('receipt-id fallback returns the exact receipt or nothing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-soak-remote-'));
  try {
    const remote = new SyntheticRemote(path.join(directory, 'remote.json'));
    const payload = { to: 'fixture-recipient', subject: 'ZxAaa Ledger', body: 'fixture body' };
    const alpha = remote.accept('send:alpha', payload);
    const beta = remote.accept('send:beta', payload);
    assert.equal(alpha.duplicate, false);
    assert.equal(remote.accept('send:alpha', payload).duplicate, true);
    assert.equal(remote.count(), 2);
    assert.notEqual(beta.receipt.id, alpha.receipt.id);

    // The remote's native idempotency is a remote property. It is reported
    // separately from the no-blind-resend gate.
    assert.equal(remote.find({ id: alpha.receipt.id }).idempotencyKey, 'send:alpha');
    assert.equal(remote.find({ id: alpha.receipt.id, idempotencyKey: 'send:beta' }), null);
    assert.equal(remote.find({ id: 'synthetic-remote-999' }), null);
    assert.equal(remote.find({}), null);

    const provider = new SyntheticMailProvider({ remote });
    assert.equal(provider.nativeIdempotency, true);
    // Key first.
    assert.equal(provider.lookup('send:alpha').status, 'found');
    assert.equal(provider.lookup('send:missing').status, 'not_found');
    // Receipt-id fallback, positive and negative.
    assert.equal(provider.lookup(null, { receiptId: alpha.receipt.id }).receipt.id, alpha.receipt.id);
    assert.equal(provider.lookup('send:missing', { receiptId: alpha.receipt.id }).status, 'not_found');
    assert.equal(provider.lookup(null, { receiptId: 'synthetic-remote-999' }).status, 'not_found');
    // Verification must match both the id and the key.
    assert.equal(provider.verifyReceipt({ id: alpha.receipt.id, idempotencyKey: 'send:alpha' }).status, 'found');
    assert.equal(provider.verifyReceipt({ id: alpha.receipt.id, idempotencyKey: 'send:missing' }).status, 'not_found');
    assert.equal(provider.verifyReceipt({ id: 'synthetic-remote-999', idempotencyKey: 'send:alpha' }).status, 'not_found');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('accepted-effect records, not a literal, back the multi-effect metric', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-soak-effects-'));
  try {
    const payload = { to: 'fixture-recipient', subject: 'ZxAaaa Ledger', body: 'fixture body' };
    const remote = new SyntheticRemote(path.join(directory, 'remote.json'));
    const first = remote.accept('send:alpha', payload);
    const duplicate = remote.accept('send:alpha', payload);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(remote.count(), 1, 'an idempotent duplicate is not a second effect');
    assert.equal(remote.keysWithMoreThanOneEffect(), 0);
    assert.deepEqual([...remote.effectCountsByKey().values()], [1]);

    // A non-idempotent remote is the real negative fixture: the same key
    // actually produces two accepted effect records, and the metric reports
    // it from those records.
    const nonIdempotent = new SyntheticRemote(path.join(directory, 'remote-twice.json'), { idempotent: false });
    nonIdempotent.accept('send:beta', payload);
    nonIdempotent.accept('send:beta', payload);
    assert.equal(nonIdempotent.count(), 2);
    assert.deepEqual([...nonIdempotent.effectCountsByKey().values()], [2]);
    assert.equal(nonIdempotent.keysWithMoreThanOneEffect(), 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('receipt proof requires non-empty, matching action/execution/receipt ids', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-soak-proof-'));
  try {
    const payload = { to: 'fixture-recipient', subject: 'ZxAaaa Ledger', body: 'fixture body' };
    const remote = new SyntheticRemote(path.join(directory, 'remote.json'));
    const receipt = remote.accept('send:alpha', payload).receipt;
    const action = { id: 'send:alpha', idempotencyKey: 'send:alpha', receiptId: receipt.id };
    const execution = { status: 'verified', idempotency_key: 'send:alpha', provider_receipt_id: receipt.id };
    assert.equal(proofIdsAgree({ action, execution, receipt }), true);

    // Every link must name the same operation.
    assert.equal(proofIdsAgree({ action, execution: { ...execution, provider_receipt_id: 'synthetic-remote-999' }, receipt }), false);
    assert.equal(proofIdsAgree({ action, execution: { ...execution, idempotency_key: 'send:other' }, receipt }), false);
    assert.equal(proofIdsAgree({ action, execution: { ...execution, status: 'accepted' }, receipt }), false);
    assert.equal(proofIdsAgree({ action: { ...action, receiptId: 'synthetic-remote-999' }, execution, receipt }), false);
    assert.equal(proofIdsAgree({ action: { ...action, idempotencyKey: 'send:other' }, execution, receipt }), false);
    assert.equal(proofIdsAgree({ action: { ...action, id: 'send:other' }, execution, receipt }), false);
    assert.equal(proofIdsAgree({ action, execution: null, receipt }), false);

    // Two undefined/null/empty keys must not compare equal and pass.
    for (const missing of [undefined, null, '']) {
      const bare = remote.accept(missing, payload).receipt;
      const bareAction = { id: missing, idempotencyKey: missing, receiptId: bare.id };
      const bareExecution = { status: 'verified', idempotency_key: missing, provider_receipt_id: bare.id };
      assert.equal(proofIdsAgree({ action: bareAction, execution: bareExecution, receipt: bare }), false,
        `a proof with key ${String(missing)} must fail`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the privacy detector catches private shapes and generated content', () => {
  assert.deepEqual(privacyViolations(JSON.stringify({ note: 'synthetic providers only' })), []);
  assert.ok(privacyViolations('{"to":"person@example.org"}').includes('email-address'));
  assert.ok(privacyViolations('{"id":"synthetic:soak-mail-3"}').includes('source-id'));
  assert.ok(privacyViolations('{"id":"soak-doc-3"}').includes('source-id'));
  assert.ok(privacyViolations('{"id":"request:abc"}').includes('task-id'));
  assert.ok(privacyViolations('{"key":"send:abc"}').includes('idempotency-key'));
  assert.ok(privacyViolations('{"body":"Experiment results"}', { fragments: ['Experiment results'] }).includes('generated-content'));
  assert.deepEqual(privacyViolations('{"body":"Experiment results"}', { fragments: ['short'] }), []);
});

test('a caller-supplied directory is never deleted or overwritten', { timeout: 180000 }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-soak-owned-'));
  try {
    const nonEmpty = path.join(parent, 'non-empty');
    fs.mkdirSync(nonEmpty);
    fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'user data');
    await assert.rejects(
      () => runSoak({ durationMs: 60000, maxCycles: 1, output: path.join(parent, 'refused.json'), workspaceDirectory: nonEmpty }),
      error => error.code === 'WORKSPACE_NOT_EMPTY'
    );
    assert.equal(fs.readFileSync(path.join(nonEmpty, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(fs.existsSync(path.join(parent, 'refused.json')), false);

    const empty = path.join(parent, 'empty');
    fs.mkdirSync(empty);
    const report = await runSoak({ durationMs: 120000, maxCycles: 1, seed: 9, output: path.join(parent, 'kept.json'), workspaceDirectory: empty });
    assert.equal(report.workspace.callerSupplied, true);
    assert.equal(report.workspace.kept, true);
    assert.equal(fs.existsSync(empty), true);
    assert.ok(fs.readdirSync(empty).includes('state.sqlite'));
    assert.ok(fs.readdirSync(empty).includes('remote.json'));
    assert.equal(fs.existsSync(path.join(parent, 'kept.json')), true);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('a real child process stops on SIGINT with a bounded, parseable report', { timeout: 60000 }, async () => {
  const { output, remove } = scratch();
  let child = null;
  try {
    child = spawn(process.execPath, ['eval/soak.js', '--duration-ms=600000', '--max-cycles=1000', `--output=${output}`], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));

    await new Promise(resolve => setTimeout(resolve, 2500));
    child.kill('SIGINT');
    const status = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`the child did not exit: ${stdout} ${stderr}`)), 30000))
    ]);

    // The CLI owns only its own final exit code; the library does not kill the
    // caller. A handled SIGINT is an ordinary exit with a failed report.
    assert.equal(status.signal, null);
    assert.equal(status.code, 1);
    assert.equal(fs.existsSync(output), true, `no report was written: ${stderr}`);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.interrupted, true);
    assert.equal(report.interruptReason, 'signal');
    assert.equal(report.success, false);
    assert.equal(report.cleanup.timedOut, false);
    assert.equal(report.cycles < 1000, true);
    assert.equal(report.elapsedMs > 0 && report.elapsedMs < 60000, true);
    assert.equal(typeof report.pendingJobsAtEnd, 'number');
    assert.equal(report.coverage.complete, false);
    // A signal before the final recovery phase must not be described as a
    // completed drain, even when the audited queue happened to be empty.
    assert.equal(report.drain.attempted, false);
    assert.equal(report.drain.passed, false);
    assert.equal(checkFor(report, 'final-queue-drained').passed, false);
    assert.match(checkFor(report, 'final-queue-drained').detail, /not attempted/);
    assert.equal(typeof report.drain.queueEmptyAtEnd, 'boolean');
    assert.equal(checkFor(report, 'no-internal-failure').passed, true);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    remove();
  }
});

test('the command line bounds its own inputs', () => {
  assert.ok(parseArguments(['--duration-ms=10']).errors.length > 0);
  assert.ok(parseArguments(['--duration-ms=86400001']).errors.length > 0);
  assert.ok(parseArguments(['--max-cycles=0']).errors.length > 0);
  assert.ok(parseArguments(['--max-cycles=10001']).errors.length > 0);
  assert.ok(parseArguments(['--nonsense']).errors.length > 0);
  const parsed = parseArguments(['--duration-ms=60000', '--max-cycles=5', '--seed=3', '--output=outputs/soak/x.json']);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.options.durationMs, 60000);
  assert.equal(parsed.options.maxCycles, 5);
  assert.equal(parsed.options.seed, 3);
  assert.ok(parsed.options.output.endsWith(path.join('outputs', 'soak', 'x.json')));
});

test('one continuous run crosses the 24-item boundary and drains the real queue', { timeout: 600000 }, async () => {
  const { output, remove } = scratch();
  const seed = 20261112;
  const maxCycles = 32;
  try {
    // One workspace, one database, one runtime for the whole run. The bound is
    // duration + one cycle + cleanup, and the report records the real elapsed
    // time.
    const report = await runSoak({ durationMs: 600000, maxCycles, seed, output });

    assert.equal(report.cycles, maxCycles);
    assert.equal(report.success, true);
    assert.equal(report.coverage.complete, true);
    assert.equal(report.checks.failed, 0);
    assert.equal(report.checks.passed, report.checks.total);
    assert.equal(report.elapsedMs <= report.wallBoundMs, true);

    // The final queue is drained by the real runtime, not hand-marked.
    assert.equal(report.drain.attempted, true);
    assert.equal(report.pendingJobsAtEnd, 0);
    assert.equal(report.drain.passed, true);
    assert.equal(report.drain.queueEmptyAtEnd, true);
    assert.equal(report.verification.unresolvedWriteExecutions, 0);
    assert.deepEqual(report.tasks.completedWithoutVerifiedAction, []);
    assert.equal(report.cleanup.timedOut, false);

    // Every normal cycle ran the full per-task chain; every burst item was
    // verified individually.
    const normalPlanned = planned(seed, maxCycles, 'normal_cycle');
    assert.deepEqual(report.normal, { cycles: normalPlanned, prepared: normalPlanned, approved: normalPlanned, verified: normalPlanned, completed: normalPlanned });
    const burstPlanned = planned(seed, maxCycles, 'burst_delivery');
    assert.equal(report.burst.cycles, burstPlanned);
    assert.equal(report.burst.items, burstPlanned * 3);
    assert.equal(report.burst.verified, report.burst.items);
    assert.equal(report.burst.noNewEffects, burstPlanned);

    // Attempts are attempts; effects are remote facts.
    assert.equal(report.provider.duplicateAfterAccept, 0);
    assert.equal(checkFor(report, 'no-blind-resend').passed, true);
    assert.equal(report.provider.accepted, report.provider.effects);
    assert.equal(report.provider.sendAttempts, report.provider.accepted + report.provider.failedBeforeAccept + report.provider.duplicateAfterAccept);
    assert.equal(report.provider.acceptedResponseLost, report.unknownWrite.injected);
    assert.equal(report.provider.keysObserved, report.provider.effects);
    assert.equal(report.provider.keysWithMoreThanOneEffect, 0);

    // Identities stay unique and correlate to their own document past 24.
    assert.ok(report.identities.generated > 24);
    assert.equal(report.identities.unique, report.identities.generated);
    assert.equal(report.identities.correlated, report.identities.generated);
    assert.equal(report.identities.capacity, entityCapacity());
    assert.ok(report.identities.capacity >= LIMITS.maxCycles * 3);
    assert.equal(report.identities.maxItemsPerCycle, 3);
    assert.ok(report.identities.plannedItems > 0);
    assert.ok(report.identities.plannedItems <= report.identities.capacity);
    const labels = report.identities.items.map(item => item.label);
    assert.equal(new Set(labels).size, labels.length);
    const beyond24 = report.identities.items.filter(item => item.ordinal >= 24);
    assert.ok(beyond24.length >= 8, `only ${beyond24.length} item(s) past ordinal 24`);
    for (const item of beyond24) {
      assert.match(item.label, /^Zx[A-Z][a-z]{3} Ledger$/);
      assert.equal(item.correlated, true, `ordinal ${item.ordinal} (${item.label}) did not correlate to its own document`);
    }

    // OAuth is one continuous log with a persisted cursor, not a per-cycle
    // reset.
    const oauthPlanned = planned(seed, maxCycles, 'oauth_expired');
    assert.ok(oauthPlanned >= 2);
    assert.equal(report.oauth.cycles, oauthPlanned);
    assert.equal(report.oauth.faults, oauthPlanned);
    assert.equal(report.oauth.reauths, oauthPlanned);
    assert.equal(report.oauth.recoveredPulls, oauthPlanned);
    assert.equal(report.oauth.continuous, true);
    assert.equal(report.oauth.cursorOffsets.length, oauthPlanned + 1);
    for (let index = 1; index < report.oauth.cursorOffsets.length; index += 1) {
      assert.ok(report.oauth.cursorOffsets[index] > report.oauth.cursorOffsets[index - 1], 'the cursor must move forward across OAuth cycles');
    }
    assert.equal(report.faults.injected.oauthExpired, oauthPlanned);

    // A crash is observed as unfinished work; the lease expiry is declared
    // simulated, and no remote fact is lost.
    const restartPlanned = planned(seed, maxCycles, 'restart_with_unfinished_work');
    assert.ok(restartPlanned >= 2);
    assert.equal(report.restarts.count, restartPlanned);
    assert.equal(report.restarts.withUnfinishedWork, restartPlanned);
    assert.equal(report.restarts.recovered, restartPlanned);
    assert.equal(report.restarts.factsLost, 0);
    assert.equal(report.faults.injected.crashHang, restartPlanned);
    assert.ok(report.restarts.simulated.leaseExpiries >= restartPlanned);

    // Unknown writes recovered only through a provider lookup.
    const unknownPlanned = planned(seed, maxCycles, 'write_outcome_unknown');
    assert.equal(report.unknownWrite.injected, unknownPlanned);
    assert.equal(report.unknownWrite.recovered, unknownPlanned);
    assert.equal(report.unknownWrite.verifiedViaLookup, unknownPlanned);

    // Coverage comes from an actual trigger, not from the plan.
    for (const fault of REQUIRED_FAULTS) assert.ok(report.faults.observed[fault] > 0, `${fault} was planned but not observed`);
    assert.equal(report.recoveries.consistent, true);
    assert.equal(report.recoveries.injected.oauthExpired, oauthPlanned);
    // The aggregate recovery counters must be the same facts the scenario
    // checks read; zeros here would make the consistency gate vacuous.
    assert.equal(report.recoveries.recovered.networkTimeout, report.timeout.recovered);
    assert.equal(report.recoveries.recovered.rateLimit, report.rateLimit.recovered);
    assert.equal(report.recoveries.recovered.oauthExpired, oauthPlanned);
    assert.equal(report.recoveries.recovered.writeOutcomeUnknown, unknownPlanned);
    assert.equal(report.recoveries.recovered.restart, report.restarts.recovered);

    // One task per work item: every completed one verified, the OAuth-pulled
    // ones truthfully awaiting the user.
    assert.equal(report.tasks.total, report.identities.generated);
    assert.equal(report.tasks.completed, report.identities.generated - report.oauth.cycles);
    assert.equal(report.tasks.verified, report.tasks.completed);
    assert.equal(report.tasks.awaitingUser.oauthRecovery, report.oauth.cycles);
    assert.equal(report.tasks.awaitingUser.total, report.oauth.cycles);

    // Scenario task facts agree with the real per-task facts: prepared is
    // observed before each approval, and the OAuth catch-up tasks are not
    // called prepared/verified/completed.
    const expectedPrepared = {
      normal_cycle: normalPlanned,
      duplicate_delivery: planned(seed, maxCycles, 'duplicate_delivery'),
      burst_delivery: burstPlanned * 3,
      network_timeout: planned(seed, maxCycles, 'network_timeout'),
      rate_limit: planned(seed, maxCycles, 'rate_limit'),
      oauth_expired: 0,
      restart_with_unfinished_work: restartPlanned,
      write_outcome_unknown: unknownPlanned
    };
    for (const [fault, expected] of Object.entries(expectedPrepared)) {
      assert.equal(report.scenarios[fault].tasks.prepared, expected, `${fault} prepared`);
    }
    const scenarioTotal = key => Object.values(report.scenarios)
      .reduce((sum, scenario) => sum + scenario.tasks[key], 0);
    assert.equal(scenarioTotal('prepared'), report.tasks.completed);
    assert.equal(scenarioTotal('verified'), report.tasks.completed);
    assert.equal(scenarioTotal('completed'), report.tasks.completed);
    assert.deepEqual(report.scenarios.oauth_expired.tasks, { prepared: 0, verified: 0, completed: 0 });

    // Token usage is measured, not assumed.
    assert.equal(report.tokenUsage.unknown, false);
    assert.ok(report.tokenUsage.known.calls > 0);
    assert.equal(checkFor(report, 'token-usage-accounted').passed, true);
  } finally { remove(); }
});
