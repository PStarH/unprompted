import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';
import { ExperienceService, arbitrateExperiences } from '../src/durable/experience.js';
import { FeatureRegistry, ActivationPolicies } from '../src/durable/context.js';
import { PermissionPolicy } from '../src/permissions.js';

function setup(t) {
  let now = Date.now(); const database = new DurableDatabase(':memory:', { now: () => now });
  const jobs = new DurableJobs(database), tasks = new DurableTasks(database, jobs), experiences = new ExperienceService(database, { jobs });
  const ledger = new ToolExecutionLedger(database, { tasks, jobs, experiences });
  database.atomic(() => database.db.prepare('INSERT INTO source_records(kind,id,created_at) VALUES(\'event\',\'episode\',?)').run(iso(now)));
  t.after(() => database.close());
  return { database, jobs, tasks, experiences, ledger, advance: value => { now += value; } };
}
function candidate(context, extra = {}) { return context.experiences.create({ kind: 'execution_hint', scopeType: 'project', scopeKey: 'A', directiveKey: 'quote.output.format', effect: { type: 'draft_format', format: 'table' }, instruction: 'Use a concise table.', freshnessClass: 'stable', ...extra }, { sources: [{ kind: 'event', id: 'episode' }] }); }
function run(context, id, experienceIds = [], extra = {}, relation = 'planner_declared', request = { subjectEntity: 'A', deliverable: 'report' }) {
  const created = context.tasks.createOrLoad({ candidateKey: id, data: { request } });
  const job = context.jobs.claim('worker'), taskRun = context.tasks.beginRun(job);
  context.tasks.checkpoint(taskRun, job, { expectedInputVersion: 0, plan: {} });
  const step = context.experiences.step({ taskRunId: taskRun.id, logicalStepId: 'draft', stepKind: 'draft_preparation', actionFamily: 'email.send', expectedEffect: { type: 'draft_format', format: 'table' },
    experiences: experienceIds.map(id => ({ id, relation })), ...extra });
  return { taskId: created.taskId, run: taskRun, job, step };
}
// Legal stale lifecycle for an unused candidate: an explicit rejection moves it
// to cooldown, the existing staleness refresh turns the expired cooldown into
// needs_revalidation, and only an explicit user confirmation returns it with a
// clean evidence slate. No direct SQL status edits are involved.
function revalidateAfterCooldown(context, experience) {
  // A different task context keeps the rejection's action suppression scoped
  // to that context, as it would be for a user rejecting one task.
  const rejected = run(context, `stale-${experience.id}`, [experience.id], {}, 'planner_declared', { subjectEntity: 'A', deliverable: 'stale report' });
  context.experiences.feedback({ kind: 'explicit_rejection', planStepId: rejected.step.id });
  assert.equal(context.experiences.get(experience.id).status, 'cooldown');
  context.advance(7 * 86400000 + 1);
  context.experiences.refreshStaleness();
  const stale = context.experiences.get(experience.id);
  assert.equal(stale.status, 'needs_revalidation');
  const revalidated = context.experiences.revalidate(experience.id, { expectedRevision: stale.revision, userRequested: true });
  assert.equal(revalidated.status, 'candidate');
  assert.ok(revalidated.revision > experience.revision, 'revalidation creates a new revision');
  return revalidated;
}
async function supervisedTrial(context, policy, experienceId, key) {
  const current = run(context, key, [experienceId], {}, 'user_confirmed');
  context.experiences.transitionStep(current.step.id, 'proposed', 'approved');
  const input = { ...current, provider: 'fixture', tool: 'send', actionFamily: 'email.send', resourceId: `${key}-mail`, key,
    effect: { type: 'draft_format', format: 'table' }, payload: {}, planStepId: current.step.id };
  assert.throws(() => context.ledger.intent(input), /independent authorization/);
  const intent = context.ledger.intent({ ...input, authorize: () => policy.authorize({ actionClass: 'execute_external', taskId: current.taskId, approval: { permission: 'user_approved', taskId: current.taskId } }) });
  await context.ledger.dispatch(intent, { ...current, send: async () => ({ id: `${key}-receipt` }), verify: async receipt => ({ status: 'found', receipt }) });
  assert.equal(context.ledger.get(intent.execution.id).status, 'verified');
  return { stepId: current.step.id, executionId: intent.execution.id };
}

test('v0.3/11 an omitted required step can receive rejection attribution without any tool execution', t => {
  const context = setup(t), experience = candidate(context, { kind: 'omission_guard' });
  const current = run(context, 'omission', [experience.id], { stepKind: 'legal_review', status: 'skipped', omissionReason: 'Planner followed the advisory omission.' });
  context.experiences.feedback({ kind: 'explicit_rejection', planStepId: current.step.id });
  const cooled = context.experiences.get(experience.id);
  assert.equal(cooled.status, 'cooldown');
  assert.equal(cooled.revision, experience.revision + 1, 'a cooldown transition invalidates the prior revision');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM tool_executions').get().n, 0);
  assert.equal(context.database.db.prepare('SELECT status FROM plan_steps WHERE id=?').get(current.step.id).status, 'rejected');
});

test('feedback is attributed to the revision that influenced the step, not a later revalidation', t => {
  const context = setup(t), experience = candidate(context), current = run(context, 'attribution', [experience.id]);
  context.database.atomic(() => context.database.db.prepare("UPDATE experiences SET status='needs_revalidation' WHERE id=?").run(experience.id));
  const stale = context.experiences.get(experience.id);
  const revalidated = context.experiences.revalidate(experience.id, { expectedRevision: stale.revision, userRequested: true });
  assert.equal(revalidated.revision, experience.revision + 1);
  context.experiences.feedback({ kind: 'explicit_rejection', planStepId: current.step.id });
  const evidence = context.database.db.prepare("SELECT experience_revision FROM experience_evidence WHERE experience_id=? AND evidence_kind='explicit_rejection'").all(experience.id);
  assert.deepEqual(evidence.map(row => row.experience_revision), [experience.revision], 'the rejected step is credited to the revision it used');
  const cooled = context.experiences.get(experience.id);
  assert.equal(cooled.status, 'cooldown');
  assert.equal(cooled.revision, revalidated.revision + 1, 'the current revision is the one that cools');
});

test('v0.3/12 rejecting a proposed plan suppresses its equivalent action before any write', t => {
  const context = setup(t), current = run(context, 'reject');
  context.experiences.feedback({ kind: 'explicit_rejection', planStepId: current.step.id });
  assert.equal(context.experiences.blocked({ taskId: current.taskId, actionFamily: 'email.send', effect: JSON.parse(current.step.expected_effect_json) }), true);
  assert.throws(() => context.ledger.intent({ taskId: current.taskId, run: current.run, job: current.job, provider: 'fixture', tool: 'send', actionFamily: 'email.send', resourceId: 'mail', key: 'blocked',
    effect: JSON.parse(current.step.expected_effect_json), payload: {}, authorize: () => ({ allowed: true }) }), /rejected an equivalent action/);
});

test('v0.3/13 a heavy rewrite followed by verified sending does not reward the original style', async t => {
  const context = setup(t), experience = candidate(context), current = run(context, 'rewrite', [experience.id]);
  const artifact = context.experiences.artifact({ taskId: current.taskId, taskRunId: current.run.id, planStepId: current.step.id, content: 'Original formal wording with a long introduction.' });
  const revised = context.experiences.editedArtifact(artifact.id, { expectedVersion: 1, originalContent: 'Original formal wording with a long introduction.', content: 'Completely different message: revised facts and new structure.' });
  assert.ok(revised.edit_ratio >= 0.7);
  context.experiences.transitionStep(current.step.id, 'proposed', 'approved');
  const intent = context.ledger.intent({ ...current, provider: 'fixture', tool: 'send', actionFamily: 'email.send', resourceId: 'mail', key: 'edited-write', effect: { artifactId: artifact.id }, payload: {}, planStepId: current.step.id, authorize: () => ({ allowed: true }) });
  await context.ledger.dispatch(intent, { ...current, send: async () => ({ id: 'receipt' }), verify: async receipt => ({ status: 'found', receipt }) });
  context.experiences.feedback({ kind: 'verified_consumption', taskId: current.taskId, planStepId: current.step.id, executionId: intent.execution.id, artifactId: artifact.id,
    effectDimension: 'workflow', consumption: { version: revised.visible_version, digest: revised.latest_digest } });
  assert.equal(context.experiences.get(experience.id).positive_evidence_count, 0);
  assert.equal(context.experiences.get(experience.id).status, 'candidate');
});

test('v0.3/14 independent supervised successes can promote a narrow candidate without granting permission', async t => {
  const context = setup(t), experience = candidate(context), policy = new PermissionPolicy();
  for (let index = 0; index < 3; index++) {
    // Production associates supervised evidence through an explicit trial
    // (runtime.js user_confirmed), never through planner_declared.
    const current = run(context, `instance-${index}`, [experience.id], {}, 'user_confirmed');
    context.experiences.transitionStep(current.step.id, 'proposed', 'approved');
    const input = { ...current, provider: 'fixture', tool: 'send', actionFamily: 'email.send', resourceId: `mail-${index}`, key: `approved-${index}`, effect: { type: 'draft_format', format: 'table' }, payload: {}, planStepId: current.step.id };
    assert.throws(() => context.ledger.intent(input), /independent authorization/);
    const intent = context.ledger.intent({ ...input, authorize: () => policy.authorize({ actionClass: 'execute_external', taskId: current.taskId, approval: { permission: 'user_approved', taskId: current.taskId } }) });
    await context.ledger.dispatch(intent, { ...current, send: async () => ({ id: `receipt-${index}` }), verify: async receipt => ({ status: 'found', receipt }) });
    context.experiences.feedback({ kind: 'supervised_success', planStepId: current.step.id, executionId: intent.execution.id });
    context.experiences.feedback({ kind: 'supervised_success', planStepId: current.step.id, executionId: intent.execution.id });
    context.tasks.finish(current.run, current.job); context.jobs.complete(current.job);
  }
  assert.equal(context.experiences.get(experience.id).verified_success_count, 3);
  assert.throws(() => context.experiences.promote(experience.id, { expectedRevision: 1 }), /disabled/);
  assert.equal(context.experiences.promote(experience.id, { expectedRevision: 1, userRequested: true }).status, 'active');
  assert.throws(() => policy.authorize({ actionClass: 'execute_external' }), /requires explicit/);
});

test('v0.3/15 conflicting structured guidance cannot use recency or specificity to override user policy', t => {
  const context = setup(t), first = candidate(context), second = candidate(context, { effect: { type: 'draft_format', format: 'plain' } });
  const records = [first, second].map(record => ({ ...record, status: 'active' }));
  assert.equal(arbitrateExperiences({ experiences: records }).conflicts.length, 1);
  const arbitrated = arbitrateExperiences({ experiences: records.map(record => ({ ...record, priority: 100, specificity: 99 })), policies: [{ id: 'user-policy', directiveKey: first.directive_key, effect: { type: 'draft_format', format: 'markdown' }, priority: 0 }] });
  assert.equal(arbitrated.conflicts.length, 0); assert.equal(arbitrated.decisions[0].record.id, 'user-policy');
});

test('v0.3/16 operational staleness changes eligibility without decaying stable guidance or evidence counts', t => {
  const context = setup(t), stable = candidate(context), operational = candidate(context, { freshnessClass: 'operational' });
  context.database.atomic(() => context.database.db.prepare("UPDATE experiences SET status='active',verified_success_count=7,last_verified_at=?").run(iso(context.database.now())));
  context.advance(31 * 86400000); context.experiences.refreshStaleness();
  assert.equal(context.experiences.get(stable.id).status, 'active');
  assert.equal(context.experiences.get(operational.id).status, 'needs_revalidation');
  assert.equal(context.experiences.get(operational.id).verified_success_count, 7);
});

test('an unused operational candidate is retired after the revalidation window', t => {
  const context = setup(t), stale = candidate(context, { freshnessClass: 'operational' }), stable = candidate(context);
  context.advance(31 * 86400000);
  const scopes = [{ type: 'project', key: 'A' }];
  const retrieved = context.experiences.retrieve({ scopes });
  assert.equal(context.experiences.get(stale.id).status, 'retired');
  assert.equal(retrieved.some(item => item.id === stale.id), false);
  assert.equal(context.experiences.get(stable.id).status, 'candidate');
  assert.ok(retrieved.some(item => item.id === stable.id));
});

test('retrieval excludes an Experience whose provenance is no longer active', t => {
  const context = setup(t), experience = candidate(context);
  const scopes = [{ type: 'project', key: 'A' }];
  assert.ok(context.experiences.retrieve({ scopes }).some(item => item.id === experience.id));
  context.database.atomic(() => context.database.db.prepare("UPDATE source_records SET active=0 WHERE kind='event' AND id='episode'").run());
  assert.equal(context.experiences.retrieve({ scopes }).some(item => item.id === experience.id), false);
});

test('v0.3/17 correction cools only declared relevant influence and synchronously queues later analysis', t => {
  const context = setup(t), relevant = candidate(context), merelyAvailable = candidate(context), other = candidate(context);
  const current = run(context, 'scope', [relevant.id]);
  context.experiences.step({ taskRunId: current.run.id, logicalStepId: 'draft', stepKind: 'draft_preparation', experiences: [{ id: merelyAvailable.id, relation: 'predicate_matched' }] });
  context.experiences.step({ taskRunId: current.run.id, logicalStepId: 'other', stepKind: 'other', experiences: [{ id: other.id, relation: 'planner_declared' }] });
  const result = context.experiences.feedback({ kind: 'explicit_rejection', planStepId: current.step.id });
  assert.deepEqual(result.affectedExperiences, [relevant.id]);
  assert.equal(context.experiences.get(relevant.id).status, 'cooldown');
  assert.equal(context.experiences.get(merelyAvailable.id).status, 'candidate'); assert.equal(context.experiences.get(other.id).status, 'candidate');
  assert.ok(context.jobs.list().some(job => job.job_type === 'compile_experience' && job.state === 'queued'));
});

test('v0.3/18 a weak Experience cannot suppress activation and missing/stale negated features fail closed', t => {
  const context = setup(t), registry = new FeatureRegistry(), policies = new ActivationPolicies(context.database);
  candidate(context, { kind: 'trigger_hint', predicate: { op: 'eq', feature: 'sender.identity', value: 'boss' }, effect: { type: 'notification_behavior', mode: 'silent' }, directiveKey: 'email.notify.behavior' });
  const features = registry.capture({ 'event.actionable': true }, { now: context.database.now(), contextVersion: Number(context.database.get('context_version')) });
  assert.equal(policies.evaluate(features).activate, true);
  assert.equal(registry.evaluate({ op: 'not', arg: { op: 'eq', feature: 'sender.identity', value: 'boss' } }, features, { now: context.database.now() }).matched, false);
  assert.equal(registry.register, undefined);
  assert.throws(() => candidate(context, { permissions: ['send'] }), /cannot change authority/);
});

test('silence produces no positive/negative evidence and no compiler job', t => {
  const context = setup(t), experience = candidate(context), current = run(context, 'quiet', [experience.id]);
  context.experiences.feedback({ kind: 'silence', planStepId: current.step.id });
  const result = context.experiences.get(experience.id);
  assert.equal(result.positive_evidence_count, 0); assert.equal(result.negative_evidence_count, 0);
  assert.equal(context.jobs.list().filter(job => job.queue_name === 'learning').length, 0);
});

test('an explicit user confirmation returns a stale Experience to candidate with a clean evidence slate', t => {
  const context = setup(t), experience = candidate(context);
  context.database.atomic(() => context.database.db.prepare("UPDATE experiences SET status='needs_revalidation',verified_success_count=4,positive_evidence_count=6,negative_evidence_count=2,last_negative_at=? WHERE id=?").run(iso(context.database.now()), experience.id));
  const stale = context.experiences.get(experience.id);
  assert.throws(() => context.experiences.revalidate(experience.id, { expectedRevision: stale.revision }), error => error.code === 'REVALIDATION_CONFIRMATION_REQUIRED');
  const revalidated = context.experiences.revalidate(experience.id, { expectedRevision: stale.revision, userRequested: true });
  assert.equal(revalidated.status, 'candidate');
  assert.equal(revalidated.verified_success_count, 0);
  assert.equal(revalidated.positive_evidence_count, 0);
  assert.equal(revalidated.negative_evidence_count, 0);
  assert.equal(revalidated.last_negative_at, null);
  assert.throws(() => context.experiences.promote(experience.id, { expectedRevision: revalidated.revision, userRequested: true }), error => error.code === 'PROMOTION_INELIGIBLE');
});

test('a retired Experience stays terminal and cannot be revalidated', t => {
  const context = setup(t), experience = candidate(context);
  const retired = context.experiences.retire(experience.id, experience.revision);
  assert.throws(() => context.experiences.revalidate(experience.id, { expectedRevision: retired.revision, userRequested: true }), error => error.code === 'REVALIDATION_INELIGIBLE');
  assert.equal(context.experiences.get(experience.id).status, 'retired');
});

test('late supervised successes from an earlier revision cannot verify or promote the revalidated revision', async t => {
  const context = setup(t), experience = candidate(context), policy = new PermissionPolicy(), oldRevision = experience.revision;
  const oldTrials = [];
  for (let index = 0; index < 3; index++) oldTrials.push(await supervisedTrial(context, policy, experience.id, `revision-r1-${index}`));
  const revalidated = revalidateAfterCooldown(context, experience);
  for (const trial of oldTrials) {
    const result = context.experiences.feedback({ kind: 'supervised_success', planStepId: trial.stepId, executionId: trial.executionId });
    assert.deepEqual(result.affectedExperiences, [experience.id]);
  }
  const evidence = context.database.db.prepare("SELECT experience_revision,verified FROM experience_evidence WHERE experience_id=? AND evidence_kind='supervised_success'").all(experience.id);
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every(row => row.experience_revision === oldRevision && row.verified === 1), 'late evidence belongs to the revision it actually influenced');
  const afterLate = context.experiences.get(experience.id);
  assert.equal(afterLate.revision, revalidated.revision, 'late feedback does not mutate the revalidated revision');
  assert.equal(afterLate.verified_success_count, 0);
  assert.equal(afterLate.positive_evidence_count, 0);
  assert.equal(afterLate.last_verified_at, null, 'late success cannot refresh verification freshness');
  assert.equal(afterLate.status, 'candidate');
  assert.throws(() => context.experiences.promote(experience.id, { expectedRevision: afterLate.revision, userRequested: true }), error => error.code === 'PROMOTION_INELIGIBLE');

  // Genuine supervised successes in the current revision still accumulate on
  // independent tasks and reach the mechanical threshold; promotion remains an
  // explicit user decision and grants no authority.
  for (let index = 0; index < 3; index++) {
    const trial = await supervisedTrial(context, policy, experience.id, `revision-r2-${index}`);
    context.experiences.feedback({ kind: 'supervised_success', planStepId: trial.stepId, executionId: trial.executionId });
  }
  const current = context.experiences.get(experience.id);
  assert.equal(current.verified_success_count, 3);
  assert.equal(current.positive_evidence_count, 3);
  assert.ok(current.last_verified_at);
  assert.equal(current.status, 'candidate');
  assert.throws(() => context.experiences.promote(experience.id, { expectedRevision: current.revision }), /disabled/);
  assert.equal(context.experiences.promote(experience.id, { expectedRevision: current.revision, userRequested: true }).status, 'active');
  assert.throws(() => policy.authorize({ actionClass: 'execute_external' }), /requires explicit/);
});

test('late acceptance and consumption evidence from an earlier revision never raises current positive counts', async t => {
  const context = setup(t), experience = candidate(context), oldRevision = experience.revision;
  const accepted = run(context, 'old-acceptance', [experience.id]);
  context.experiences.transitionStep(accepted.step.id, 'proposed', 'approved');
  const similar = run(context, 'old-similar', [experience.id]);
  const consumed = run(context, 'old-consumption', [experience.id]);
  const artifact = context.experiences.artifact({ taskId: consumed.taskId, taskRunId: consumed.run.id, planStepId: consumed.step.id, content: 'Original guidance output.' });
  context.experiences.transitionStep(consumed.step.id, 'proposed', 'approved');
  const consumedIntent = context.ledger.intent({ ...consumed, provider: 'fixture', tool: 'send', actionFamily: 'email.send', resourceId: 'old-consumption-mail', key: 'old-consumption',
    effect: { artifactId: artifact.id }, payload: {}, planStepId: consumed.step.id, authorize: () => ({ allowed: true }) });
  await context.ledger.dispatch(consumedIntent, { ...consumed, send: async () => ({ id: 'old-consumption-receipt' }), verify: async receipt => ({ status: 'found', receipt }) });

  const revalidated = revalidateAfterCooldown(context, experience);
  context.experiences.feedback({ kind: 'explicit_acceptance', planStepId: accepted.step.id });
  context.experiences.feedback({ kind: 'similar_content_consumption', planStepId: similar.step.id });
  context.experiences.feedback({ kind: 'verified_consumption', planStepId: consumed.step.id, executionId: consumedIntent.execution.id, artifactId: artifact.id,
    effectDimension: 'workflow', consumption: { version: artifact.visible_version, digest: artifact.latest_digest } });

  const current = context.experiences.get(experience.id);
  assert.equal(current.revision, revalidated.revision);
  assert.equal(current.positive_evidence_count, 0, 'old positive evidence stays history, not current validation');
  assert.equal(current.verified_success_count, 0);
  assert.equal(current.last_verified_at, null);
  const revisions = context.database.db.prepare('SELECT DISTINCT experience_revision FROM experience_evidence WHERE experience_id=?').all(experience.id);
  assert.deepEqual(revisions.map(row => row.experience_revision), [oldRevision]);
  assert.throws(() => context.experiences.promote(experience.id, { expectedRevision: current.revision, userRequested: true }), error => error.code === 'PROMOTION_INELIGIBLE');
});

test('late success from an earlier revision cannot indirectly auto-promote the revalidated revision', async t => {
  const context = setup(t), experience = candidate(context), policy = new PermissionPolicy();
  const oldTrial = await supervisedTrial(context, policy, experience.id, 'auto-old');
  revalidateAfterCooldown(context, experience);
  for (let index = 0; index < 3; index++) {
    const trial = await supervisedTrial(context, policy, experience.id, `auto-current-${index}`);
    context.experiences.feedback({ kind: 'supervised_success', planStepId: trial.stepId, executionId: trial.executionId });
  }
  assert.equal(context.experiences.get(experience.id).verified_success_count, 3);
  context.experiences.configurePolicy({ expectedVersion: 1, autoPromote: true });
  context.experiences.feedback({ kind: 'supervised_success', planStepId: oldTrial.stepId, executionId: oldTrial.executionId });
  const still = context.experiences.get(experience.id);
  assert.equal(still.status, 'candidate', 'old success cannot trigger promotion on current evidence');
  assert.equal(still.verified_success_count, 3);
  const fresh = await supervisedTrial(context, policy, experience.id, 'auto-current-fresh');
  context.experiences.feedback({ kind: 'supervised_success', planStepId: fresh.stepId, executionId: fresh.executionId });
  assert.equal(context.experiences.get(experience.id).status, 'active', 'a genuine current success still auto-promotes');
});
