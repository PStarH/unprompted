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
function run(context, id, experienceIds = [], extra = {}) {
  const created = context.tasks.createOrLoad({ candidateKey: id, data: { request: { subjectEntity: 'A', deliverable: 'report' } } });
  const job = context.jobs.claim('worker'), taskRun = context.tasks.beginRun(job);
  context.tasks.checkpoint(taskRun, job, { expectedInputVersion: 0, plan: {} });
  const step = context.experiences.step({ taskRunId: taskRun.id, logicalStepId: 'draft', stepKind: 'draft_preparation', actionFamily: 'email.send', expectedEffect: { type: 'draft_format', format: 'table' },
    experiences: experienceIds.map(id => ({ id, relation: 'planner_declared' })), ...extra });
  return { taskId: created.taskId, run: taskRun, job, step };
}

test('v0.3/11 an omitted required step can receive rejection attribution without any tool execution', t => {
  const context = setup(t), experience = candidate(context, { kind: 'omission_guard' });
  const current = run(context, 'omission', [experience.id], { stepKind: 'legal_review', status: 'skipped', omissionReason: 'Planner followed the advisory omission.' });
  context.experiences.feedback({ kind: 'explicit_rejection', planStepId: current.step.id });
  assert.equal(context.experiences.get(experience.id).status, 'cooldown');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM tool_executions').get().n, 0);
  assert.equal(context.database.db.prepare('SELECT status FROM plan_steps WHERE id=?').get(current.step.id).status, 'rejected');
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
    const current = run(context, `instance-${index}`, [experience.id]);
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
