import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { DurableDatabase, iso, json } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ExperienceService, arbitrateExperiences, archiveAuthorization } from '../src/durable/experience.js';
import { ExperienceTrialService, runFixtureSuite } from '../src/durable/experience-trials.js';
import { ForgetService } from '../src/durable/privacy.js';
import { ArtifactActions } from '../src/durable/artifact-actions.js';
import { draftReviewToken } from '../src/draft-review.js';
import {
  TRIAL_FIXTURE_VERSION, TRIAL_MAX_BEHAVIOR_CASES, TRIAL_MAX_CASES, TRIAL_MAX_DIFFERENCE_CHARS, TRIAL_MAX_DIFFERENCES_CHARS,
  TRIAL_PASS_TTL_MS, TRIAL_POLICY_DIGEST, TRIAL_POLICY_VERSION
} from '../src/durable/experience-trial-fixtures.js';

function setup(t) {
  let now = Date.now();
  const database = new DurableDatabase(':memory:', { now: () => now });
  const jobs = new DurableJobs(database), tasks = new DurableTasks(database, jobs);
  const experiences = new ExperienceService(database, { jobs });
  const trials = new ExperienceTrialService(database, { experiences });
  database.atomic(() => database.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('event','episode',?)").run(iso(now)));
  t.after(() => database.close());
  return { database, jobs, tasks, experiences, trials, now: () => now, advance: value => { now += value; }, scopes: [{ type: 'project', key: 'A' }] };
}
let sequence = 0;
function create(context, effect, extra = {}) {
  const directiveKey = extra.directiveKey || `trial.effect_${++sequence}`;
  return context.experiences.create({ kind: extra.kind || 'planning_hint', scopeType: extra.scopeType || 'project', scopeKey: extra.scopeKey || 'A',
    directiveKey: effect.type === 'advisory' ? undefined : directiveKey, effect, instruction: extra.instruction || 'Apply the configured behavior.',
    freshnessClass: extra.freshnessClass || 'stable', ...extra }, { sources: extra.sources || [{ kind: 'event', id: 'episode' }] });
}
let caseSequence = 0;
function literalCase(experience, effect, extra = {}) {
  const expected = extra.expected || { applies: true, winner: 'candidate', effect };
  return { id: extra.id || `case-${++caseSequence}`,
    scope: extra.scope || [{ type: experience.scope_type, key: experience.scope_key }],
    features: extra.features || {}, expected,
    ...(extra.userEffect ? { userEffect: extra.userEffect } : {}),
    ...(extra.source ? { source: extra.source } : {}) };
}
function saveCases(context, experience, cases) {
  const currentExperience = context.experiences.get(experience.id) || experience;
  const current = context.trials.caseSet(experience.id);
  return context.trials.saveCases(experience.id, { expectedRevision: currentExperience.revision, expectedCaseSetVersion: current.version, cases, userRequested: true });
}
function passingCase(context, experience, effect = experience.effect) {
  saveCases(context, experience, [literalCase(experience, effect)]);
  return context.trials.evaluate(experience.id, { expectedRevision: experience.revision });
}
function evidenceCounts(database) {
  return Object.fromEntries(['experience_evidence', 'experience_trials', 'tool_executions', 'plan_steps', 'action_suppressions',
    'experience_content_versions', 'experience_trial_case_sets'].map(table => [table, database.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
}
/** Produce one genuine supervised success through the public feedback path:
 * an approved attributed plan step and a verified execution row. Only the
 * execution fixture is inserted directly; the success counter itself is
 * incremented by ExperienceService.feedback. */
function supervisedSuccess(context, experience, index) {
  const created = context.tasks.createOrLoad({ candidateKey: `trial-success-${index}-${randomUUID()}`,
    data: { request: { subjectEntity: 'A', deliverable: 'report' }, sourceConnectorId: 'simulated' } });
  const queued = context.database.db.prepare("SELECT id FROM jobs WHERE task_id=? AND queue_name='tasks' AND state='queued' ORDER BY created_at DESC LIMIT 1").get(created.taskId);
  const job = context.jobs.claim(`worker-${index}-${randomUUID()}`, { queue: 'tasks', id: queued.id }), run = context.tasks.beginRun(job);
  const step = context.experiences.step({ taskRunId: run.id, logicalStepId: `draft-${index}`, stepKind: 'draft_preparation',
    actionFamily: 'email.send', expectedEffect: { type: 'email_reply' }, experiences: [{ id: experience.id, relation: 'planner_declared' }] });
  context.experiences.transitionStep(step.id, 'proposed', 'approved');
  const executionId = randomUUID(), at = iso((context.now || context.database.now)());
  context.database.atomic(() => context.database.db.prepare(`INSERT INTO tool_executions(id,task_id,task_run_id,plan_step_id,provider,tool,action_family,
    resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES(?,?,?,?,'simulated','draft','email.send',?,?,?,'verified',1,0,0,0,?,?)`)
    .run(executionId, created.taskId, run.id, step.id, `resource-${index}`, `success-${executionId}`, json({ type: 'email_reply' }), at, at));
  context.experiences.feedback({ kind: 'supervised_success', taskId: created.taskId, planStepId: step.id, executionId });
  return context.tasks.get(created.taskId);
}

test('independent behavior cases: strict unknown without them, literal user data passes, and no weaker oracle', async t => {
  const context = setup(t);
  const experience = create(context, { type: 'notification_behavior', mode: 'digest' });
  const before = evidenceCounts(context.database);

  const untested = context.trials.evaluate(experience.id, { expectedRevision: 1 });
  assert.equal(untested.state, 'unknown', 'guards alone must not stand in for candidate behaviour');
  assert.equal(untested.categories.guard.total > 0, true);
  assert.equal(untested.categories.behavior.total, 0);
  assert.ok(context.trials.list(experience.id, { includeDifferences: true })[0].differences.some(difference => difference.reason === 'no_independent_behavior_case'));
  assert.throws(() => context.experiences.adopt(experience.id, { expectedRevision: 1, userRequested: true }), error => error.code === 'ADOPTION_UNTESTED');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(experience.id)), false);
  const strictAfter = evidenceCounts(context.database);
  for (const table of ['experience_evidence', 'tool_executions', 'plan_steps', 'action_suppressions', 'experience_content_versions', 'experience_trial_case_sets']) {
    assert.equal(strictAfter[table], before[table], `${table} must not change during a strict unknown evaluation`);
  }

  assert.throws(() => context.trials.saveCases(experience.id, { expectedRevision: 1, expectedCaseSetVersion: 0, cases: [] }),
    error => error.code === 'CASE_SET_CONFIRMATION_REQUIRED');
  const unsafe = [
    [literalCase(experience, experience.effect, { expected: { applies: true, winner: 'candidate', effect: experience.effect, passed: true } })],
    [{ ...literalCase(experience, experience.effect), javascript: 'process.exit()' }],
    [literalCase(experience, experience.effect, { features: { 'unknown.feature': true } })],
    [literalCase(experience, experience.effect, { features: { 'task.priority': 'high' } })],
    [literalCase(experience, experience.effect, { expected: { applies: true, winner: 'none' } })],
    [literalCase(experience, experience.effect, { source: { kind: 'event', id: 'not-linked' } })],
    Array.from({ length: TRIAL_MAX_BEHAVIOR_CASES + 1 }, (_, index) => literalCase(experience, experience.effect, { id: `too-many-${index}` }))
  ];
  for (const cases of unsafe) assert.throws(() => saveCases(context, experience, cases), error => error.code === 'INVALID_TRIAL_CASE');

  const saved = saveCases(context, experience, [literalCase(experience, experience.effect, { source: { kind: 'event', id: 'episode' } })]);
  assert.equal(saved.version, 1);
  assert.equal(saved.digest.length, 64);
  assert.equal(context.experiences.caseSetState(experience.id).version, 1);
  const trial = context.trials.evaluate(experience.id, { expectedRevision: 1 });
  assert.equal(trial.state, 'passed');
  assert.equal(trial.categories.behavior.total, 1);
  assert.equal(trial.categories.behavior.applicable, 1);
  assert.equal(trial.categories.behavior.passed, 1);
  assert.equal(trial.caseSetVersion, 1);
  assert.equal(trial.counts.passed, trial.counts.total);
  assert.equal(trial.counts.failed, 0);
  assert.equal(trial.counts.unknown, 0);
  assert.equal(trial.fixtureVersion, TRIAL_FIXTURE_VERSION);
  assert.equal(trial.policyDigest, TRIAL_POLICY_DIGEST);
  const expiry = Date.parse(trial.expiresAt);
  assert.ok(expiry > context.now() && expiry <= context.now() + TRIAL_PASS_TTL_MS);
  assert.equal(context.experiences.validTrialPass(context.experiences.get(experience.id)), true);
  const admitted = context.experiences.retrieve({ scopes: context.scopes, purpose: 'supervised_trial', allowedExperienceId: experience.id });
  assert.equal(admitted.length, 1);
  assert.equal(evidenceCounts(context.database).experience_evidence, before.experience_evidence, 'evaluation never creates evidence');

  const adopted = context.experiences.adopt(experience.id, { expectedRevision: 1, userRequested: true });
  assert.equal(adopted.status, 'active');
  assert.equal(context.trials.latest(experience.id).effectiveState, 'passed');
  assert.equal(context.trials.latest(experience.id).adoptedRevision, 2);

  // A changed case set invalidates every earlier pass and attestation at once.
  const second = saveCases(context, experience, [literalCase(experience, experience.effect)]);
  assert.equal(second.version, 2);
  assert.equal(context.trials.latest(experience.id).state, 'expired');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(experience.id)), false);
  assert.equal(context.trials.evaluate(experience.id, { expectedRevision: 2 }).state, 'passed');

  // A false predicate plus only a negative case cannot pass.
  const falsePredicate = create(context, { type: 'review_requirements', required: true }, { predicate: { op: 'eq', feature: 'event.provider', value: 'nowhere' } });
  saveCases(context, falsePredicate, [literalCase(falsePredicate, falsePredicate.effect, { expected: { applies: false, winner: 'none' } })]);
  const negativeOnly = context.trials.evaluate(falsePredicate.id, { expectedRevision: 1 });
  assert.equal(negativeOnly.state, 'unknown');
  assert.ok(context.trials.list(falsePredicate.id, { includeDifferences: true })[0].differences.some(difference => difference.reason === 'no_applicable_positive_case'));
  saveCases(context, falsePredicate, [literalCase(falsePredicate, falsePredicate.effect, { expected: { applies: false, winner: 'none' } }),
    literalCase(falsePredicate, falsePredicate.effect)]);
  assert.equal(context.trials.evaluate(falsePredicate.id, { expectedRevision: 1 }).state, 'failed', 'a positive case for a false predicate must fail');

  // The literal expected effect is compared; it is never read back from the candidate.
  const mismatched = create(context, { type: 'notification_behavior', mode: 'silent' });
  saveCases(context, mismatched, [literalCase(mismatched, { type: 'notification_behavior', mode: 'interactive' })]);
  assert.equal(context.trials.evaluate(mismatched.id, { expectedRevision: 1 }).state, 'failed');

  // A user-override case proves precedence, not candidate behaviour. It stays
  // useful supporting evidence but cannot make the suite pass on its own.
  const precedence = create(context, { type: 'review_requirements', required: true });
  const overrideReview = () => ({ id: 'override-review', scope: [{ type: 'project', key: 'A' }], features: {},
    expected: { applies: true, winner: 'user' }, userEffect: { type: 'review_requirements', required: false } });
  saveCases(context, precedence, [overrideReview()]);
  const overrideOnly = context.trials.evaluate(precedence.id, { expectedRevision: 1 });
  assert.equal(overrideOnly.state, 'unknown', 'user precedence alone is not candidate behaviour evidence');
  assert.equal(overrideOnly.categories.behavior.applicable, 1);
  assert.equal(overrideOnly.categories.behavior.positive, 0);
  assert.equal(overrideOnly.counts.failed, 0);
  assert.ok(context.trials.list(precedence.id, { includeDifferences: true })[0].differences
    .some(difference => difference.reason === 'no_applicable_positive_candidate_case'));
  assert.equal(context.experiences.validTrialPass(context.experiences.get(precedence.id)), false);
  assert.throws(() => context.experiences.adopt(precedence.id, { expectedRevision: 1, userRequested: true }),
    error => error.code === 'ADOPTION_UNTESTED');
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' })
    .some(item => item.id === precedence.id), false);

  const interactive = create(context, { type: 'notification_behavior', mode: 'interactive' });
  saveCases(context, interactive, [{ id: 'interactive-override', scope: [{ type: 'project', key: 'A' }], features: {},
    expected: { applies: true, winner: 'user' }, userEffect: { type: 'notification_behavior', mode: 'silent' } }]);
  const interactiveOverride = context.trials.evaluate(interactive.id, { expectedRevision: 1 });
  assert.equal(interactiveOverride.state, 'unknown');
  assert.equal(interactiveOverride.categories.behavior.positive, 0);
  assert.throws(() => context.experiences.adopt(interactive.id, { expectedRevision: 1, userRequested: true }),
    error => error.code === 'ADOPTION_UNTESTED');
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' })
    .some(item => item.id === interactive.id), false);

  const arbitraryStep = create(context, { type: 'step_behavior', stepKind: 'unreviewed-arbitrary-step', operation: 'include' });
  saveCases(context, arbitraryStep, [{ id: 'step-override', scope: [{ type: 'project', key: 'A' }], features: {},
    expected: { applies: true, winner: 'user' },
    userEffect: { type: 'step_behavior', stepKind: 'trial_probe_step', operation: 'omit' } }]);
  const stepOverride = context.trials.evaluate(arbitraryStep.id, { expectedRevision: 1 });
  assert.equal(stepOverride.state, 'unknown');
  assert.equal(stepOverride.categories.behavior.applicable, 1);
  assert.equal(stepOverride.categories.behavior.positive, 0);
  assert.throws(() => context.experiences.adopt(arbitraryStep.id, { expectedRevision: 1, userRequested: true }),
    error => error.code === 'ADOPTION_UNTESTED');

  // A genuine literal positive plus the supporting override passes and can be
  // adopted; the override alone never substituted for the literal assertion.
  saveCases(context, precedence, [overrideReview(), literalCase(precedence, { type: 'review_requirements', required: true }, { id: 'review-positive' })]);
  const mixed = context.trials.evaluate(precedence.id, { expectedRevision: 1 });
  assert.equal(mixed.state, 'passed');
  assert.equal(mixed.categories.behavior.applicable, 2);
  assert.equal(mixed.categories.behavior.positive, 1);
  assert.equal(context.experiences.adopt(precedence.id, { expectedRevision: 1, userRequested: true }).status, 'active');
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' })
    .some(item => item.id === precedence.id), true);

  // A positive expectation for a different scope is a real failure, not a pass.
  const outOfScope = create(context, { type: 'notification_behavior', mode: 'digest' });
  saveCases(context, outOfScope, [literalCase(outOfScope, { type: 'notification_behavior', mode: 'digest' },
    { id: 'out-of-scope', scope: [{ type: 'project', key: 'B' }] })]);
  const scopeMismatch = context.trials.evaluate(outOfScope.id, { expectedRevision: 1 });
  assert.equal(scopeMismatch.state, 'failed');
  assert.equal(scopeMismatch.categories.behavior.positive, 0);

  // A real failed counterexample still fails even when a positive case passes.
  const counterexample = create(context, { type: 'notification_behavior', mode: 'digest' });
  saveCases(context, counterexample, [
    literalCase(counterexample, { type: 'notification_behavior', mode: 'digest' }, { id: 'counter-positive' }),
    literalCase(counterexample, { type: 'notification_behavior', mode: 'digest' }, { id: 'counter-negative',
      expected: { applies: false, winner: 'none' } })
  ]);
  const failedMixed = context.trials.evaluate(counterexample.id, { expectedRevision: 1 });
  assert.equal(failedMixed.state, 'failed');
  assert.equal(failedMixed.categories.behavior.positive, 1);
  assert.ok(failedMixed.categories.behavior.failed >= 1);
});

test('an earlier-policy pass cannot survive; a fresh independent positive retest can', async t => {
  const context = setup(t);
  const experience = create(context, { type: 'notification_behavior', mode: 'interactive' });
  saveCases(context, experience, [literalCase(experience, { type: 'notification_behavior', mode: 'interactive' })]);
  const passed = context.trials.evaluate(experience.id, { expectedRevision: 1 });
  assert.equal(passed.state, 'passed');
  assert.equal(passed.categories.behavior.positive, 1);
  assert.equal(passed.policyDigest, TRIAL_POLICY_DIGEST);
  assert.equal(TRIAL_POLICY_VERSION, 'experience-trial-policy-2026-11-13.2');
  assert.equal(context.trials.describe().policyVersion, TRIAL_POLICY_VERSION);
  assert.equal(context.trials.describe().positiveCandidateEvidence, 'required');
  const retainedHistory = context.database.db.prepare('SELECT COUNT(*) n FROM experience_trials').get().n;

  // Simulate the stored pass the earlier policy produced: same content and
  // case set, old policy digest, and an override-only count with no positive
  // candidate assertion.
  context.database.atomic(() => context.database.db.prepare(`UPDATE experience_trials SET policy_digest=?,categories_json=? WHERE id=?`)
    .run('experience-trial-policy-2026-11-13.1', json({ guard: { passed: 17, failed: 0, unknown: 0, total: 17 },
      behavior: { passed: 1, failed: 0, unknown: 0, total: 1, applicable: 1, positive: 0 },
      authorization: { required: false, status: 'not_required', passed: 0, failed: 0, unknown: 0, total: 0 } }), passed.id));
  const retained = context.trials.latest(experience.id);
  assert.equal(retained.state, 'passed', 'history is retained');
  assert.equal(retained.effectiveState, 'superseded');
  assert.equal(retained.effectiveReason, 'fixture_or_policy_changed');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(experience.id)), false);
  assert.throws(() => context.experiences.adopt(experience.id, { expectedRevision: 1, userRequested: true }),
    error => error.code === 'ADOPTION_UNTESTED');
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' })
    .some(item => item.id === experience.id), false);

  context.experiences.refreshStaleness();
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_trials').get().n, retainedHistory, 'invalidation does not delete history');
  assert.equal(context.trials.caseSet(experience.id).count, 1, 'invalidation does not delete the saved case set');
  assert.ok(context.experiences.contentVersions(experience.id).length > 0, 'invalidation does not delete content history');
  const expired = context.trials.latest(experience.id);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.effectiveState, 'expired');
  assert.equal(expired.effectiveReason, 'stored_expired');

  // Even a crafted current-policy row with no positive assertion is not a pass.
  context.database.atomic(() => context.database.db.prepare(`UPDATE experience_trials SET state='passed',policy_digest=? WHERE id=?`)
    .run(TRIAL_POLICY_DIGEST, passed.id));
  const weakCurrent = context.trials.latest(experience.id);
  assert.equal(weakCurrent.effectiveState, 'superseded');
  assert.equal(weakCurrent.effectiveReason, 'positive_candidate_evidence_missing');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(experience.id)), false);

  // The user retests the saved literal positive case under the new policy.
  const retested = context.trials.evaluate(experience.id, { expectedRevision: 1 });
  assert.equal(retested.state, 'passed');
  assert.equal(retested.categories.behavior.positive, 1);
  assert.equal(retested.policyDigest, TRIAL_POLICY_DIGEST);
  assert.notEqual(retested.policyDigest, 'experience-trial-policy-2026-11-13.1');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(experience.id)), true);
  assert.equal(context.experiences.adopt(experience.id, { expectedRevision: 1, userRequested: true }).status, 'active');
});

test('archive authorization is a real, read-only current grant check and arbitrary targets never pass', async t => {
  const context = setup(t);
  const connection = { accountId: 'acct', connector: { id: 'notion', live: true } };
  const artifacts = new ArtifactActions({ engine: { policy: { shadow: false } }, database: context.database, privacy: { permissionRevoked: () => false } },
    { connectionFor: id => id === 'notion' ? connection : null });
  const target = 'a'.repeat(32), folder = target.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const grant = extra => ({ id: randomUUID(), version: 1, status: 'active', connectorId: 'notion', family: 'notion.page.create',
    accountId: 'acct', targetId: target, taskId: null, project: 'A', automatic: true, createdBy: 'user', confirmedAt: iso(context.now()), ...extra });
  const setGrants = grants => context.database.atomic(() => context.database.set('artifact_grants', json(grants)));
  const archive = create(context, { type: 'archive_destination', provider: 'notion', resourceId: folder });
  context.experiences.bindAuthorizationCheck(experience => archiveAuthorization(experience, artifacts));
  saveCases(context, archive, [literalCase(archive, archive.effect)]);

  setGrants([]);
  assert.deepEqual(archiveAuthorization(archive, artifacts), { required: true, status: 'unknown', reason: 'no_matching_user_grant' });
  const unknown = context.trials.evaluate(archive.id, { expectedRevision: 1 });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.categories.authorization.required, true);
  assert.equal(unknown.categories.authorization.status, 'unknown');
  assert.throws(() => context.experiences.adopt(archive.id, { expectedRevision: 1, userRequested: true }), error => error.code === 'TARGET_UNAUTHORIZED');

  const arbitrary = create(context, { type: 'archive_destination', provider: 'notion', resourceId: 'some-unverified-folder' });
  saveCases(context, arbitrary, [literalCase(arbitrary, arbitrary.effect)]);
  setGrants([grant({})]);
  assert.equal(context.trials.evaluate(arbitrary.id, { expectedRevision: 1 }).state, 'unknown');
  assert.throws(() => context.experiences.adopt(arbitrary.id, { expectedRevision: 1, userRequested: true }), error => error.code === 'TARGET_UNAUTHORIZED');

  setGrants([grant({})]);
  assert.equal(archiveAuthorization(archive, artifacts).status, 'authorized');
  const passed = context.trials.evaluate(archive.id, { expectedRevision: 1 });
  assert.equal(passed.state, 'passed');
  assert.equal(passed.categories.authorization.status, 'authorized');
  const adopted = context.experiences.adopt(archive.id, { expectedRevision: 1, userRequested: true });
  assert.equal(adopted.status, 'active');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_evidence').get().n, 0, 'authorization is not evidence');

  for (const [variant, reason] of [[{ status: 'revoked' }, 'grant_revoked'], [{ createdBy: 'system' }, 'grant_unconfirmed'],
    [{ confirmedAt: null }, 'grant_unconfirmed'], [{ project: 'B' }, 'scope_mismatch'], [{ accountId: 'other' }, 'account_or_permission_unavailable']]) {
    setGrants([grant(variant)]);
    const result = archiveAuthorization(archive, artifacts);
    assert.equal(result.status, 'denied', `${reason} must be denied`);
    assert.equal(result.reason, reason);
    const failed = context.trials.evaluate(archive.id, { expectedRevision: 2 });
    assert.equal(failed.state, 'failed');
  }
  setGrants([grant({ connectorId: 'google', family: 'email.draft' })]);
  assert.equal(archiveAuthorization(archive, artifacts).reason, 'no_matching_user_grant');
  setGrants([grant({})]);
  context.advance(8 * 86400000);
  context.experiences.refreshStaleness();
  assert.equal(context.trials.list(archive.id).some(row => row.state === 'passed'), false);
  assert.equal(context.trials.list(archive.id).find(row => row.revision === 1 && row.expiresAt)?.state, 'expired');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(archive.id)), false);

  const nonArchive = create(context, { type: 'notification_behavior', mode: 'digest' });
  assert.deepEqual(archiveAuthorization(nonArchive, null), { required: false, status: 'not_required', reason: 'no_external_target' });
  saveCases(context, nonArchive, [literalCase(nonArchive, nonArchive.effect)]);
  const noAuthorizationCase = context.trials.evaluate(nonArchive.id, { expectedRevision: 1 });
  assert.equal(noAuthorizationCase.state, 'passed');
  assert.equal(noAuthorizationCase.categories.authorization.required, false);
});

test('promotion snapshots the new revision and carries only a compatible same-content pass', async t => {
  const context = setup(t);
  const makeFormat = () => create(context, { type: 'draft_format', format: 'markdown' }, { kind: 'execution_hint' });
  const promote = experience => {
    for (let index = 0; index < 3; index++) supervisedSuccess(context, experience, `${sequence}-${index}`);
    return context.experiences.get(experience.id);
  };

  const carried = makeFormat(1);
  saveCases(context, carried, [literalCase(carried, carried.effect)]);
  assert.equal(context.trials.evaluate(carried.id, { expectedRevision: 1 }).state, 'passed');
  const eligible = promote(carried);
  assert.equal(eligible.verified_success_count, 3);
  const promoted = context.experiences.promote(carried.id, { expectedRevision: eligible.revision, userRequested: true });
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.revision, 2);
  const version = context.experiences.latestContentVersion(carried.id);
  assert.equal(version.revision, 2);
  assert.equal(version.change_kind, 'promote');
  assert.equal(version.parent_revision, 1);
  const attestation = context.trials.latest(carried.id);
  assert.equal(attestation.adoptedRevision, 2);
  assert.equal(attestation.testedRevision, 1);
  assert.equal(attestation.attestationOf !== null, true);
  assert.equal(attestation.caseSetVersion, 1);
  assert.equal(attestation.effectiveState, 'passed');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(carried.id)), true);
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' }).some(item => item.id === carried.id), true);

  const untested = makeFormat(2);
  saveCases(context, untested, [literalCase(untested, untested.effect)]);
  const untestedEligible = promote(untested);
  const promotedUntested = context.experiences.promote(untested.id, { expectedRevision: untestedEligible.revision, userRequested: true });
  assert.equal(promotedUntested.status, 'active');
  assert.equal(promotedUntested.revision, 2);
  assert.equal(context.experiences.latestContentVersion(untested.id).change_kind, 'promote');
  assert.equal(context.trials.latest(untested.id), null, 'promotion must not invent a pass');
  assert.equal(context.experiences.validTrialPass(promotedUntested), false);
  assert.throws(() => context.experiences.adopt(untested.id, { expectedRevision: 2, userRequested: true }), error => error.code === 'ADOPTION_INELIGIBLE');
  assert.equal(context.trials.evaluate(untested.id, { expectedRevision: 2 }).state, 'passed', 'the promoted revision is immediately evaluable');

  const expired = makeFormat(3);
  saveCases(context, expired, [literalCase(expired, expired.effect)]);
  assert.equal(context.trials.evaluate(expired.id, { expectedRevision: 1 }).state, 'passed');
  context.advance(8 * 86400000);
  assert.equal(context.trials.latest(expired.id).effectiveState, 'expired');
  assert.equal(context.trials.latest(expired.id).effectiveReason, 'pass_expired');
  context.experiences.refreshStaleness();
  assert.equal(context.trials.latest(expired.id).state, 'expired');
  assert.equal(context.trials.latest(expired.id).effectiveReason, 'stored_expired');
  const expiredEligible = promote(expired);
  const promotedExpired = context.experiences.promote(expired.id, { expectedRevision: expiredEligible.revision, userRequested: true });
  assert.equal(promotedExpired.status, 'active');
  assert.equal(context.experiences.validTrialPass(promotedExpired), false);
  assert.equal(context.trials.latest(expired.id).state, 'expired');
  assert.equal(context.trials.evaluate(expired.id, { expectedRevision: 2 }).state, 'passed');

  const mismatched = makeFormat(4);
  saveCases(context, mismatched, [literalCase(mismatched, mismatched.effect)]);
  assert.equal(context.trials.evaluate(mismatched.id, { expectedRevision: 1 }).state, 'passed');
  saveCases(context, mismatched, [literalCase(mismatched, mismatched.effect)]);
  const mismatchedEligible = promote(mismatched);
  const promotedMismatched = context.experiences.promote(mismatched.id, { expectedRevision: mismatchedEligible.revision, userRequested: true });
  assert.equal(promotedMismatched.status, 'active');
  assert.equal(context.experiences.validTrialPass(promotedMismatched), false);
  assert.equal(context.trials.latest(mismatched.id).effectiveState, 'expired');

  // Promote re-checks current provenance, not only the stored pass row. An
  // out-of-band stored parent-experience edge that overflows the bounded
  // resolver cannot be copied into a new attestation.
  const overflowed = makeFormat(5);
  saveCases(context, overflowed, [literalCase(overflowed, { type: 'draft_format', format: 'markdown' })]);
  assert.equal(context.trials.evaluate(overflowed.id, { expectedRevision: 1 }).state, 'passed');
  let parentSource = { kind: 'event', id: 'episode' };
  for (let index = 0; index < 5; index++) {
    const node = create(context, { type: 'notification_behavior', mode: 'silent' }, { sources: [parentSource] });
    parentSource = { kind: 'experience', id: node.id };
  }
  context.database.atomic(() => context.database.lineage('experience', parentSource.id, 'experience', overflowed.id));
  const overflowEligible = promote(overflowed);
  const promotedOverflow = context.experiences.promote(overflowed.id, { expectedRevision: overflowEligible.revision, userRequested: true });
  assert.equal(promotedOverflow.status, 'active');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_trials WHERE experience_id=? AND revision=2').get(overflowed.id).n, 0,
    'an unavailable provenance cannot be copied into an attestation');
  assert.equal(context.trials.latest(overflowed.id).adoptedRevision, null);
  assert.equal(context.trials.latest(overflowed.id).attestationOf, null);
  assert.equal(context.experiences.validTrialPass(promotedOverflow), false);
});

test('rollback, revalidation and legacy baselines stay explicit and never inherit a pass', async t => {
  const context = setup(t);
  const experience = create(context, { type: 'notification_behavior', mode: 'digest' });
  assert.equal(passingCase(context, experience).state, 'passed');
  const adopted = context.experiences.adopt(experience.id, { expectedRevision: 1, userRequested: true });
  assert.equal(adopted.status, 'active');
  assert.throws(() => context.experiences.rollback(experience.id, { expectedRevision: 2, targetRevision: 1 }), error => error.code === 'ROLLBACK_CONFIRMATION_REQUIRED');
  assert.throws(() => context.experiences.rollback(experience.id, { expectedRevision: 2, targetRevision: 2, userRequested: true }), error => error.code === 'ROLLBACK_TARGET_INVALID');
  const rolled = context.experiences.rollback(experience.id, { expectedRevision: 2, targetRevision: 1, userRequested: true });
  assert.equal(rolled.status, 'candidate');
  assert.equal(rolled.revision, 3);
  assert.equal(context.experiences.validTrialPass(rolled), false);
  assert.equal(context.trials.latest(experience.id).revision, 2);
  assert.equal(context.trials.evaluate(experience.id, { expectedRevision: 3 }).state, 'passed', 'unchanged saved cases make the rolled-back revision evaluable');
  const versions = context.experiences.contentVersions(experience.id);
  assert.deepEqual(versions.map(row => row.changeKind), ['rollback', 'adopt', 'create']);
  assert.equal(versions[0].contentDigest, versions[2].contentDigest);

  // Reach needs_revalidation through the public cooldown lifecycle.
  const stale = create(context, { type: 'review_requirements', required: false });
  const task = context.tasks.createOrLoad({ candidateKey: 'reject-trial', data: { request: { subjectEntity: 'A', deliverable: 'report' } } });
  const job = context.jobs.claim('worker'), run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  const step = context.experiences.step({ taskRunId: run.id, logicalStepId: 'draft', stepKind: 'draft_preparation',
    experiences: [{ id: stale.id, relation: 'planner_declared' }] });
  context.experiences.feedback({ kind: 'explicit_rejection', taskId: task.taskId, planStepId: step.id });
  assert.equal(context.experiences.get(stale.id).status, 'cooldown');
  context.advance(7 * 86400000 + 1);
  context.experiences.refreshStaleness();
  const waiting = context.experiences.get(stale.id);
  assert.equal(waiting.status, 'needs_revalidation');
  const back = context.experiences.revalidate(stale.id, { expectedRevision: waiting.revision, userRequested: true });
  assert.equal(back.status, 'candidate');
  const staleVersions = context.experiences.contentVersions(stale.id);
  assert.deepEqual(staleVersions.map(row => row.changeKind), ['revalidate', 'create']);
  assert.equal(staleVersions[0].contentDigest, staleVersions[1].contentDigest);
  passingCase(context, back);
  assert.equal(context.trials.evaluate(stale.id, { expectedRevision: back.revision }).state, 'passed');

  // Simulate a database upgraded from before content versions existed.
  const legacy = create(context, { type: 'review_requirements', required: true });
  context.database.atomic(() => context.database.db.prepare('DELETE FROM experience_content_versions WHERE experience_id=?').run(legacy.id));
  const reloaded = new ExperienceService(context.database, { jobs: context.jobs });
  assert.deepEqual(reloaded.contentVersions(legacy.id).map(version => [version.revision, version.changeKind]), [[1, 'baseline']]);
  const again = new ExperienceService(context.database, { jobs: context.jobs });
  assert.equal(again.contentVersions(legacy.id).length, 1);
});

test('the evaluator remains bounded, uses the actual arbiter, and treats failure as unknown', async t => {
  const context = setup(t);
  const experience = create(context, { type: 'notification_behavior', mode: 'digest' });
  saveCases(context, experience, [literalCase(experience, experience.effect)]);
  let calls = 0;
  const wrapped = runFixtureSuite({ experience, contextVersion: 0, behaviorCases: [literalCase(experience, experience.effect)],
    arbitrate: input => { calls++; return arbitrateExperiences(input); } });
  assert.ok(calls > 0);
  assert.equal(wrapped.state, 'passed');
  const empty = runFixtureSuite({ experience, contextVersion: 0, behaviorCases: [literalCase(experience, experience.effect)],
    arbitrate: () => ({ decisions: [], conflicts: [], advisory: [], authorizationRequired: true }) });
  assert.equal(empty.state, 'failed');
  const thrown = runFixtureSuite({ experience, contextVersion: 0, behaviorCases: [literalCase(experience, experience.effect)],
    arbitrate: () => { throw new Error('arbiter failed'); } });
  assert.equal(thrown.state, 'unknown');
  assert.ok(thrown.differences.some(difference => difference.reason === 'evaluation_error'));

  const huge = runFixtureSuite({
    experience: { ...experience, effect: { type: 'notification_behavior', mode: 'x'.repeat(5000) } }, contextVersion: 0,
    arbitrate: ({ experiences = [] }) => ({ decisions: experiences.map(record => ({ directiveKey: record.directiveKey,
      record: { id: record.id }, effect: { type: 'notification_behavior', mode: 'y'.repeat(5000) } })), conflicts: [], advisory: [], authorizationRequired: true })
  });
  assert.equal(huge.state, 'failed');
  assert.ok(huge.differences.length <= TRIAL_MAX_CASES);
  assert.ok(JSON.stringify(huge.differences).length <= TRIAL_MAX_DIFFERENCES_CHARS);
  for (const difference of huge.differences) assert.ok(JSON.stringify(difference).length <= TRIAL_MAX_DIFFERENCE_CHARS);

  const limited = context.trials.evaluate(experience.id, { expectedRevision: 1, deadline: 0, monotonic: () => 1 });
  assert.equal(limited.state, 'unknown');
  assert.ok(context.trials.list(experience.id, { includeDifferences: true })[0].differences.some(difference => difference.reason === 'deadline_exceeded'));
  const archiveShape = { ...experience, effect: { type: 'archive_destination', provider: 'notion', resourceId: 'target' } };
  const archiveDeadline = runFixtureSuite({ experience: archiveShape, contextVersion: 0, deadline: 0, monotonic: () => 1 });
  assert.equal(archiveDeadline.state, 'unknown');
  assert.equal(archiveDeadline.categories.authorization.status, 'unknown');
  assert.equal(archiveDeadline.differences.find(difference => difference.caseId === 'archive-target')?.actual?.reason, 'deadline_exceeded');
  const archiveAbort = new AbortController(); archiveAbort.abort();
  const archiveCancelled = runFixtureSuite({ experience: archiveShape, contextVersion: 0, signal: archiveAbort.signal });
  assert.equal(archiveCancelled.state, 'unknown');
  assert.equal(archiveCancelled.differences.find(difference => difference.caseId === 'archive-target')?.actual?.reason, 'cancelled');
  assert.throws(() => context.trials.evaluate(experience.id, { expectedRevision: 99 }), error => error.code === 'EXPERIENCE_CHANGED');
  assert.equal(context.trials.evaluate(experience.id, { expectedRevision: 1 }).state, 'passed');
  const controller = new AbortController(); controller.abort();
  const cancelled = context.trials.evaluate(experience.id, { expectedRevision: 1, signal: controller.signal });
  assert.equal(cancelled.state, 'unknown');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(experience.id)), true, 'the cancelled row must not displace the earlier pass');

  const advisory = create(context, { type: 'advisory' });
  const advisoryTrial = context.trials.evaluate(advisory.id, { expectedRevision: 1 });
  assert.equal(advisoryTrial.state, 'unknown');
  assert.throws(() => context.experiences.adopt(advisory.id, { expectedRevision: 1, userRequested: true }), error => error.code === 'ADOPTION_UNSUPPORTED');

  context.database.atomic(() => context.database.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('event','episode-2',?)").run(iso(context.now())));
  const unavailable = create(context, { type: 'notification_behavior', mode: 'digest' }, { sources: [{ kind: 'event', id: 'episode-2' }] });
  context.database.atomic(() => context.database.db.prepare("UPDATE source_records SET active=0 WHERE kind='event' AND id='episode-2'").run());
  assert.equal(context.trials.evaluate(unavailable.id, { expectedRevision: 1 }).state, 'unknown');
});

test('indirect provenance revocation expires passes and Forget purges scenarios, trials and versions', async t => {
  const context = setup(t);
  const privacy = new ForgetService(context.database, { jobs: context.jobs, experiences: context.experiences });
  const task = context.tasks.createOrLoad({ candidateKey: 'indirect-revoke', data: { sourceConnectorId: 'google',
    request: { subjectEntity: 'A', deliverable: 'report', source: { connectorId: 'google' } } } });
  const feedback = context.experiences.feedback({ kind: 'explicit_acceptance', taskId: task.taskId });
  const experience = create(context, { type: 'notification_behavior', mode: 'digest' }, { sources: [{ kind: 'feedback', id: feedback.id }] });
  saveCases(context, experience, [literalCase(experience, experience.effect)]);
  assert.equal(context.trials.evaluate(experience.id, { expectedRevision: 1 }).state, 'passed');
  assert.equal(context.experiences.provenanceConnectors(experience.id).includes('google'), true);
  assert.equal(context.experiences.sourceRevoked(experience.id), false);
  const unrelated = create(context, { type: 'review_requirements', required: false });
  saveCases(context, unrelated, [literalCase(unrelated, unrelated.effect)]);
  assert.equal(context.trials.evaluate(unrelated.id, { expectedRevision: 1 }).state, 'passed');

  await privacy.revokePermission({ connectorId: 'google' });
  const revoked = context.experiences.get(experience.id);
  assert.equal(revoked.status, 'needs_revalidation');
  assert.equal(context.experiences.sourceRevoked(experience.id), true);
  assert.equal(context.experiences.validTrialPass(revoked), false);
  assert.equal(context.trials.latest(experience.id).state, 'expired');
  assert.throws(() => context.trials.evaluate(experience.id, { expectedRevision: revoked.revision }), error => error.code === 'EXPERIENCE_UNAVAILABLE');
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' }).some(item => item.id === experience.id), false);
  assert.equal(context.experiences.get(unrelated.id).status, 'candidate');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(unrelated.id)), true, 'an unaffected Experience keeps its pass');

  privacy.restorePermission('google');
  const restored = context.experiences.revalidate(experience.id, { expectedRevision: context.experiences.get(experience.id).revision, userRequested: true });
  assert.equal(context.trials.evaluate(experience.id, { expectedRevision: restored.revision }).state, 'passed');

  const beforeForget = evidenceCounts(context.database);
  await privacy.forget({ kind: 'feedback', id: feedback.id });
  assert.equal(context.experiences.get(experience.id), undefined);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_trials WHERE experience_id=?').get(experience.id).n, 0);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_trial_case_sets WHERE experience_id=?').get(experience.id).n, 0);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_content_versions WHERE experience_id=?').get(experience.id).n, 0);
  assert.ok(evidenceCounts(context.database).experience_trials < beforeForget.experience_trials);
  assert.equal(context.database.db.prepare("SELECT active FROM source_records WHERE kind='experience' AND id=?").get(experience.id).active, 0);

  const purgeTask = context.tasks.createOrLoad({ candidateKey: 'purge-revoke', data: { sourceConnectorId: 'microsoft',
    request: { subjectEntity: 'A', deliverable: 'report', source: { connectorId: 'microsoft' } } } });
  const purgeFeedback = context.experiences.feedback({ kind: 'explicit_acceptance', taskId: purgeTask.taskId });
  const purged = create(context, { type: 'step_behavior', stepKind: 'trial_step', operation: 'omit' }, { sources: [{ kind: 'feedback', id: purgeFeedback.id }] });
  saveCases(context, purged, [literalCase(purged, purged.effect)]);
  assert.equal(context.trials.evaluate(purged.id, { expectedRevision: 1 }).state, 'passed');
  await privacy.revokePermission({ connectorId: 'microsoft', purgeLocal: true });
  assert.equal(context.experiences.get(purged.id), undefined);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_trials WHERE experience_id=?').get(purged.id).n, 0);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM experience_trial_case_sets WHERE experience_id=?').get(purged.id).n, 0);
});

test('stored parent-experience provenance recurses with bounds and fails closed', async t => {
  const context = setup(t);
  const privacy = new ForgetService(context.database, { jobs: context.jobs, experiences: context.experiences });
  const task = context.tasks.createOrLoad({ candidateKey: 'parent-lineage', data: { sourceConnectorId: 'google',
    request: { subjectEntity: 'A', deliverable: 'report', source: { connectorId: 'google' } } } });
  const feedback = context.experiences.feedback({ kind: 'explicit_acceptance', taskId: task.taskId });
  const parent = create(context, { type: 'notification_behavior', mode: 'digest' }, { sources: [{ kind: 'feedback', id: feedback.id }] });
  const child = create(context, { type: 'review_requirements', required: true }, { sources: [{ kind: 'experience', id: parent.id }] });
  const unrelated = create(context, { type: 'notification_behavior', mode: 'silent' });
  for (const [experience, effect] of [
    [parent, { type: 'notification_behavior', mode: 'digest' }],
    [child, { type: 'review_requirements', required: true }],
    [unrelated, { type: 'notification_behavior', mode: 'silent' }]
  ]) {
    saveCases(context, experience, [literalCase(experience, effect)]);
    assert.equal(context.trials.evaluate(experience.id, { expectedRevision: 1 }).state, 'passed');
  }
  assert.equal(context.experiences.provenanceConnectors(child.id).includes('google'), true);
  context.experiences.adopt(unrelated.id, { expectedRevision: 1, userRequested: true });
  await privacy.revokePermission({ connectorId: 'google' });
  assert.equal(context.experiences.get(parent.id).status, 'needs_revalidation');
  assert.equal(context.experiences.get(child.id).status, 'needs_revalidation');
  assert.equal(context.experiences.get(unrelated.id).status, 'active');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(child.id)), false);
  assert.equal(context.experiences.validTrialPass(context.experiences.get(unrelated.id)), true, 'an unrelated scope keeps its pass');
  assert.equal(context.trials.list(child.id).every(row => row.state !== 'passed'), true);
  assert.ok(context.experiences.contentVersions(child.id).length > 0, 'soft revocation keeps immutable history');
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' }).some(item => item.id === child.id), false);
  assert.equal(context.experiences.retrieve({ scopes: context.scopes, purpose: 'automatic' }).some(item => item.id === unrelated.id), true);

  // A stored cycle must fail closed instead of walking forever or treating the
  // parent edge as a valid root.
  const cycleA = create(context, { type: 'notification_behavior', mode: 'silent' });
  const cycleB = create(context, { type: 'notification_behavior', mode: 'silent' });
  context.database.atomic(() => {
    context.database.lineage('experience', cycleA.id, 'experience', cycleB.id);
    context.database.lineage('experience', cycleB.id, 'experience', cycleA.id);
  });
  assert.equal(context.experiences.sourceUnavailable(cycleA.id), true, 'a provenance cycle fails closed');

  // A missing parent Experience, or an over-deep chain, is unavailable.
  const missing = create(context, { type: 'notification_behavior', mode: 'silent' });
  context.database.atomic(() => context.database.lineage('experience', 'missing-parent', 'experience', missing.id));
  assert.equal(context.experiences.sourceUnavailable(missing.id), true, 'a missing parent fails closed');
  let chainSource = { kind: 'event', id: 'episode' };
  for (let index = 0; index < 5; index++) {
    const node = create(context, { type: 'notification_behavior', mode: 'silent' }, { sources: [chainSource] });
    chainSource = { kind: 'experience', id: node.id };
  }
  const deep = create(context, { type: 'notification_behavior', mode: 'silent' }, { sources: [chainSource] });
  assert.equal(context.experiences.sourceUnavailable(deep.id), true, 'depth overflow fails closed');

  // A parent status is not itself a source revocation: a retired parent whose
  // real source is still active must not make the child unavailable.
  const retiredParent = create(context, { type: 'notification_behavior', mode: 'silent' });
  context.experiences.retire(retiredParent.id, retiredParent.revision);
  const statusChild = create(context, { type: 'review_requirements', required: false }, { sources: [{ kind: 'experience', id: retiredParent.id }] });
  assert.equal(context.experiences.sourceUnavailable(statusChild.id), false, 'parent status alone does not hide an available source');
  assert.equal(context.experiences.sourceRevoked(statusChild.id), false);

  // A stored parent edge introduced after a pass invalidates the pass.
  const tested = create(context, { type: 'notification_behavior', mode: 'digest' });
  saveCases(context, tested, [literalCase(tested, { type: 'notification_behavior', mode: 'digest' })]);
  assert.equal(context.trials.evaluate(tested.id, { expectedRevision: 1 }).state, 'passed');
  assert.equal(context.experiences.validTrialPass(context.experiences.get(tested.id)), true);
  context.database.atomic(() => context.database.lineage('experience', cycleA.id, 'experience', tested.id));
  assert.equal(context.experiences.validTrialPass(context.experiences.get(tested.id)), false);
});

test('the real runtime automatic gate admits only an evaluated current revision', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-trial-runtime-'));
  const store = new SqliteStore(path.join(directory, 'state.json')), engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const created = runtime.tasks.createOrLoad({ candidateKey: 'trial-gate', data: { request: { subjectEntity: 'Cedar', deliverable: 'proposal', text: 'Update the proposal.' } } });
  const job = runtime.jobs.claim('worker'), run = runtime.tasks.beginRun(job), task = runtime.tasks.get(created.taskId);
  const experience = runtime.experiences.create({
    kind: 'planning_hint', scopeType: 'project', scopeKey: 'Cedar', directiveKey: 'trial.gate_notification',
    effect: { type: 'notification_behavior', mode: 'digest' }, instruction: 'Use a digest in the automatic plan.', freshnessClass: 'stable'
  }, { sources: [{ kind: 'task', id: created.taskId }] });
  const automatic = () => runtime.buildContext(task, run);
  assert.equal(runtime.trials.evaluate(experience.id, { expectedRevision: experience.revision }).state, 'unknown');
  assert.equal(automatic().arbitration.decisions.some(decision => decision.directiveKey === 'trial.gate_notification'), false);
  const caseSet = runtime.trials.caseSet(experience.id);
  runtime.trials.saveCases(experience.id, { expectedRevision: experience.revision, expectedCaseSetVersion: caseSet.version,
    cases: [literalCase(experience, experience.effect)], userRequested: true });
  assert.equal(runtime.trials.evaluate(experience.id, { expectedRevision: experience.revision }).state, 'passed');
  assert.equal(automatic().arbitration.decisions.some(decision => decision.directiveKey === 'trial.gate_notification'), false, 'a candidate pass alone stays out of automatic planning');
  runtime.experiences.adopt(experience.id, { expectedRevision: experience.revision, userRequested: true });
  const admitted = automatic();
  assert.ok(admitted.experiences.some(item => item.id === experience.id));
  assert.ok(admitted.arbitration.decisions.some(decision => decision.directiveKey === 'trial.gate_notification'));
});

test('a selected supervised trial is fenced by its current pass expiry before any send', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-trial-fence-'));
  let now = Date.now();
  const store = new SqliteStore(path.join(directory, 'state.json')), engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  runtime.database.now = () => now;
  const experience = runtime.experiences.create({ kind: 'execution_hint', scopeType: 'project', scopeKey: 'Cedar',
    directiveKey: 'trial.fence_format', effect: { type: 'draft_format', format: 'markdown' }, instruction: 'Format drafts as markdown.',
    freshnessClass: 'stable' }, { sources: [{ kind: 'task', id: runtime.tasks.createOrLoad({ candidateKey: 'fence-source',
      data: { request: { subjectEntity: 'Cedar', deliverable: 'proposal' } } }).taskId }] });
  for (let index = 0; index < 3; index++) supervisedSuccess(runtime, experience, `fence-${index}`);
  const cases = runtime.trials.caseSet(experience.id);
  runtime.trials.saveCases(experience.id, { expectedRevision: experience.revision, expectedCaseSetVersion: cases.version,
    cases: [literalCase(experience, experience.effect)], userRequested: true });
  assert.equal(runtime.trials.evaluate(experience.id, { expectedRevision: experience.revision }).state, 'passed');
  const current = runtime.experiences.get(experience.id);
  const promoted = runtime.experiences.promote(experience.id, { expectedRevision: current.revision, userRequested: true });
  assert.equal(promoted.status, 'active');
  assert.equal(runtime.experiences.validTrialPass(promoted), true);

  const prepared = runtime.tasks.createOrLoad({ candidateKey: 'fence-draft', data: { request: { subjectEntity: 'Cedar', deliverable: 'proposal', text: 'Draft the proposal.' } } });
  runtime.store.mutate(state => { state.tasks[prepared.taskId].draft = { subject: 'Proposal', body: 'Original body', to: 'client@example.test' }; });
  const reviewToken = draftReviewToken(runtime.tasks.get(prepared.taskId));
  // Run the prepared trial job directly. The production worker also enqueues a
  // task_continue job; this test keeps it queued so the reviewed draft (and its
  // fence) stay in flight while the clock crosses the selected pass expiry.
  const runSelectedTrial = async token => {
    const job = runtime.jobs.enqueue({ type: 'experience_trial', taskId: prepared.taskId, key: `fence-trial:${randomUUID()}`,
      payload: { taskId: prepared.taskId, experienceId: experience.id, reviewToken: token } });
    const claimed = runtime.jobs.claim(`fence-worker:${randomUUID()}`, { queue: 'tasks', id: job.id });
    await runtime.runTrial(claimed);
  };
  await runSelectedTrial(reviewToken);
  const selected = runtime.tasks.get(prepared.taskId).draft.experienceTrial;
  assert.equal(selected.experienceId, experience.id);
  assert.equal(selected.passExpiresAt, runtime.trials.latest(experience.id).expiresAt);
  const fence = runtime.capture(prepared.taskId);
  assert.equal(fence.experienceTrial.experienceId, experience.id);
  assert.equal(runtime.isCurrent(prepared.taskId, fence), true);
  const executionsBefore = runtime.db.prepare('SELECT COUNT(*) n FROM tool_executions').get().n;

  now = Date.parse(selected.passExpiresAt) + 1;
  assert.equal(runtime.isCurrent(prepared.taskId, fence), false, 'the selected pass expiry is checked against the database clock');
  await assert.rejects(runtime.external(runtime.tasks.get(prepared.taskId), {}), error => error.code === 'EXPERIENCE_TRIAL_STALE');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM tool_executions').get().n, executionsBefore, 'a stale trial creates no intent');

  assert.equal(runtime.trials.evaluate(experience.id, { expectedRevision: promoted.revision }).state, 'passed');
  await runSelectedTrial(draftReviewToken(runtime.tasks.get(prepared.taskId)));
  const refreshed = runtime.capture(prepared.taskId);
  assert.equal(runtime.isCurrent(prepared.taskId, refreshed), true);
  await assert.rejects(runtime.external(runtime.tasks.get(prepared.taskId), {}), error => error.code !== 'EXPERIENCE_TRIAL_STALE');
});
