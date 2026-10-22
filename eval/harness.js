import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { NullReasoner } from '../src/reasoning.js';

/**
 * Evaluation harness.
 *
 * Runs a scenario fixture against a real engine with a fresh store, then reports
 * what the system actually did — not what it was supposed to do. Fixtures are
 * plain data, so the same suite drives both the CLI report and the test file.
 */

export function emailEvent({ id, from = 'alex@example.test', to = 'maya@example.test', subject, body, at }) {
  return {
    id: `eval-email-${id}`, type: 'email.received', at,
    payload: { id, from, to, subject, body, receivedAt: at }
  };
}

export function documentEvent({ eventId, id, title, content, kind = 'document', at }) {
  return {
    id: `eval-doc-${eventId}`, type: 'document.modified', at,
    payload: { id, title, content, kind, modifiedAt: at }
  };
}

export function recordEvent({ eventId, id, label, subjectEntity, completedAt, at }) {
  return {
    id: `eval-record-${eventId}`, type: 'record.published', at,
    payload: { id, label, subjectEntity, completedAt, source: { kind: 'run_registry', id: 'eval-registry' } }
  };
}

/**
 * A deterministic stand-in for a reasoning model.
 *
 * `probes` are returned as-is, which is the point: the harness can hand the
 * planner a well-formed proposal, an invented justification, or nothing at all,
 * and observe exactly which of them the system accepts.
 */
export function scriptedReasoner({ probes = null, interpretation = null, fail = null, available = true } = {}) {
  return {
    id: 'scripted',
    available: () => available,
    status: () => ({
      id: 'scripted', configured: true, available,
      lastError: fail ? fail.message : null, calls: available && !fail ? 1 : 0
    }),
    async proposeProbes() { if (fail) throw fail; return probes; },
    async interpretRequest() { if (fail) throw fail; return interpretation; }
  };
}

/** Everything worth asserting about, read back from persisted state. */
export function observe(store, requestText = '') {
  const tasks = Object.values(store.state.tasks);
  const task = tasks[0] || null;
  const criteria = task?.evidence?.criteria || [];
  const specs = task?.evidence?.plan?.specs || [];
  const haystack = String(requestText).toLowerCase();
  return {
    requestFound: tasks.length > 0,
    taskCount: tasks.length,
    entity: task?.request.subjectEntity ?? null,
    deliverable: task?.request.deliverable ?? null,
    intent: task?.request.intent ?? null,
    deadline: task?.request.deadline?.text ?? null,
    interpretation: task?.request.interpretedBy ?? null,
    criteria: criteria.map(item => ({
      id: item.id, status: item.status, origin: item.probe?.origin || null, strength: item.strength || null
    })),
    criterionIds: criteria.map(item => item.id),
    satisfied: criteria.filter(item => item.status === 'satisfied').map(item => item.id),
    unsatisfied: criteria.filter(item => item.required !== false && item.status !== 'satisfied').map(item => item.id),
    directEvidenceCount: criteria.filter(item => item.status === 'satisfied' && item.strength === 'direct').length,
    documentId: task?.documentId ?? null,
    specs: specs.map(spec => ({
      criterionId: spec.criterionId, origin: spec.origin, provider: spec.provider,
      justification: spec.justification ?? null
    })),
    specCount: specs.length,
    // Every justification must be a genuine substring of the request.
    justificationsVerbatim: specs.every(spec => !spec.justification || haystack.includes(spec.justification.toLowerCase())),
    modelSpecs: specs.filter(spec => spec.origin === 'model').map(spec => spec.criterionId),
    rejectedProposals: (task?.evidence?.plan?.rejected || []).map(item => item.reason),
    anyRejectedBecauseNotVerbatim: (task?.evidence?.plan?.rejected || [])
      .some(item => /not a quotation/.test(item.reason || '')),
    complete: Boolean(task?.assessment?.complete),
    status: task?.status ?? null,
    freshness: task?.assessment?.freshness?.status ?? null,
    withheldClaims: (task?.draft?.withheldClaims || []).map(item => item.id),
    draftPresent: Boolean(task?.draft),
    draftBody: task?.draft?.body ?? null,
    draftMentionsLatest: /\blatest\b/i.test(task?.draft?.body || ''),
    unknowns: (task?.evidence?.unknowns || []).map(item => item.id),
    conflicts: (task?.evidence?.conflicts || []).map(item => item.id),
    conflictingCriteria: criteria.filter(item => item.status === 'conflicting').map(item => item.id),
    // Verification depth and the checks that actually ran, so a fixture can
    // assert "more checking happened, and this is what it found" — not just a
    // status.
    verificationDepth: task?.verification?.depth ?? null,
    verificationPerformed: (task?.verification?.performed || []).map(item => `${item.documentId}:${item.criterionId}:${item.outcome}`),
    verificationBasis: (task?.verification?.basis || []).map(item => item.code),
    // Which decisions are open, by kind. Read from persisted notifications, so a
    // fixture can assert both that an interruption happened and that it did not.
    openNotificationKinds: (store.state.notifications || []).filter(item => !item.resolvedAt).map(item => item.kind),
    // An array expectation is checked by inclusion, so "nothing is open" needs
    // its own count.
    openNotificationCount: (store.state.notifications || []).filter(item => !item.resolvedAt).length,
    completionReason: task?.assessment?.completion?.reason ?? null,
    completionBlockers: (task?.assessment?.completion?.blockers || []).map(item => item.id),
    reasoningStatus: task?.reasoning?.status ?? null,
    reasoningFailure: task?.evidence?.reasoning?.status === 'failed' ? task.evidence.reasoning.detail : null,
    outboxCount: store.state.outbox.length,
    unrelatedCount: store.state.events.filter(event => event.disposition === 'unrelated_change').length,
    dispositions: store.state.events.map(event => event.disposition),
    historyKinds: store.state.history.map(item => item.kind)
  };
}

/**
 * Run a fixture. Either a single pass (`events` + `expect`) or a sequence of
 * phases (`phases: [{ events, expect }]`) when the point is how state changes
 * over time, such as a draft being withdrawn.
 */
export async function runFixture(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-eval-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, {
    provider: new SimulatedMailProvider(store),
    reasoner: fixture.reasoner ? scriptedReasoner(fixture.reasoner) : new NullReasoner('evaluation: no model configured'),
    // Some framework properties (the stall window) are only observable on a
    // time scale a fixture cannot wait for, so a fixture may configure the
    // engine itself. Defaults apply when it does not.
    ...(fixture.engineOptions || {})
  });

  const phases = fixture.phases || [{ events: fixture.events, expect: fixture.expect }];
  const requestText = phases.flatMap(phase => phase.events)
    .filter(event => event.type === 'email.received')
    .map(event => `${event.payload.subject}\n${event.payload.body}`)
    .join('\n');

  const observations = [];
  for (const phase of phases) {
    for (const event of phase.events) engine.ingest(event);
    await engine.whenSettled();
    observations.push({ label: phase.label || null, expect: phase.expect, observed: observe(store, requestText) });
  }

  const final = observations[observations.length - 1].observed;

  // Read before the approval pass. Approving resolves opportunities whose
  // condition the completed work removed, so post-approval metrics count
  // `proposed 0` even when the fixture raised one; this snapshot keeps the
  // proposal side of the story reportable (D6).
  const metricsBeforeApproval = engine.publicState().metrics;

  // When a fixture asks for it, carry every prepared action through the
  // approval boundary so the full loop — not just discovery — is measured. This
  // never bypasses the policy: it calls the same approve() the API calls.
  if (fixture.approve) {
    for (const task of Object.values(store.state.tasks)) {
      if (task.status !== 'ready_for_approval') continue;
      try { await engine.approve(task.id); } catch { /* stays ready for approval */ }
      await engine.whenSettled();
    }
  }

  // Product-value metrics are read from the engine's own
  // records, so the evaluation measures what the system actually did rather than
  // what a fixture hoped it would do.
  const metrics = engine.publicState().metrics;
  // The end state *after* any approval pass, so "did it finish" is read from the
  // finished run rather than from the moment before approval.
  const settled = Object.values(store.state.tasks || {});
  const outcome = {
    tasks: settled.length,
    statuses: settled.map(task => task.status),
    completed: settled.filter(task => task.status === 'completed').length,
    verifiedComplete: settled.filter(task => task.status === 'completed' && Boolean(task.action?.status?.startsWith?.('verified'))).length,
    readyForApproval: settled.filter(task => task.status === 'ready_for_approval').length,
    // Post-approval external actions. Anything here was permitted by the user's
    // approval and must have been verified; anything before it must not exist.
    executedActions: store.state.outbox.length
  };
  // Independently of src/metrics.js: a completion is verified only when the
  // outbox carries a receipt for its action's idempotency key. The evaluator's
  // gate reads these counts (D8), so a corrupted metrics predicate cannot
  // silence it.
  const receipts = new Set((store.state.outbox || []).map(item => item.idempotencyKey));
  outcome.verifiedByReceipt = settled.filter(task =>
    task.status === 'completed' && task.action && receipts.has(task.action.idempotencyKey)).length;
  outcome.unverifiedByReceipt = settled.filter(task =>
    task.status === 'completed' && !(task.action && receipts.has(task.action.idempotencyKey))).length;
  // What the run cost. Counted from persisted state rather than instrumented
  // counters, so a number here cannot drift from what actually happened.
  const resources = {
    events: store.state.events.length,
    documents: Object.keys(store.state.documents || {}).length,
    probes: Object.values(store.state.tasks || {})
      .reduce((total, task) => total + (task.evidence?.criteria?.length || 0), 0),
    modelCalls: engine.reasoner?.status?.()?.calls ?? 0,
    notifications: (store.state.notifications || []).length,
    openNotifications: (store.state.notifications || []).filter(item => !item.resolvedAt).length,
    traceEntries: (store.state.trace || []).length
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return { observations, final, requestText, metrics, metricsBeforeApproval, resources, outcome };
}

/**
 * Compare an expectation against an observation.
 * Returns a list of human-readable mismatches; empty means the fixture passed.
 */
export function checkExpectation(expect = {}, observed = {}) {
  const failures = [];
  for (const [key, wanted] of Object.entries(expect)) {
    const actual = observed[key];
    if (Array.isArray(wanted)) {
      for (const item of wanted) {
        if (!Array.isArray(actual) || !actual.includes(item)) failures.push(`${key} should include ${JSON.stringify(item)} (got ${JSON.stringify(actual)})`);
      }
      continue;
    }
    if (actual !== wanted) failures.push(`${key} should be ${JSON.stringify(wanted)} (got ${JSON.stringify(actual)})`);
  }
  return failures;
}

export const harnessApi = { emailEvent, documentEvent, recordEvent, scriptedReasoner, observe, runFixture, checkExpectation };
