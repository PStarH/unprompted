import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ExperienceService } from '../src/durable/experience.js';
import { HybridMemory } from '../src/durable/memory.js';
import { ExperienceTrialService } from '../src/durable/experience-trials.js';

const effect = { type: 'review_requirements', required: true };
const scopes = [{ type: 'project', key: 'A' }];
function fixture(t) {
  const clock = { now: Date.now() };
  const database = new DurableDatabase(':memory:', { now: () => clock.now }); t.after(() => database.close());
  const jobs = new DurableJobs(database), tasks = new DurableTasks(database, jobs);
  const experiences = new ExperienceService(database, { jobs }), trials = new ExperienceTrialService(database, { experiences });
  return { database, jobs, tasks, experiences, trials, advance: ms => { clock.now += ms; }, now: () => clock.now };
}
function candidate(f, kind, id) {
  f.database.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(?,?,?)').run(kind, id, iso());
  const e = f.experiences.create({ kind: 'planning_hint', scopeType: 'project', scopeKey: 'A', directiveKey: 'review.required',
    effect, instruction: 'Require review.', freshnessClass: 'stable' }, { sources: [{ kind, id }] });
  f.trials.saveCases(e.id, { expectedRevision: e.revision, expectedCaseSetVersion: 0, userRequested: true,
    cases: [{ id: 'independent', scope: scopes, features: {}, expected: { applies: true, winner: 'candidate', effect: { type: 'review_requirements', required: true } } }] });
  return e;
}
for (const kind of ['task_run', 'plan_step', 'feedback', 'memory', 'task_memory']) {
  test(`a missing ${kind} row cannot provide passing provenance through its surviving registry entry`, t => {
    const f = fixture(t), e = candidate(f, kind, 'missing');
    assert.equal(f.experiences.sourceUnavailable(e.id), true);
    assert.equal(f.trials.evaluate(e.id, { expectedRevision: 1 }).state, 'unknown');
    assert.equal(f.experiences.validTrialPass(e), false);
    assert.throws(() => f.experiences.adopt(e.id, { expectedRevision: 1, userRequested: true }), { code: 'SOURCE_UNAVAILABLE' });
  });
}
for (const kind of ['task_run', 'plan_step']) {
  test(`removing a real ${kind} invalidates existing trial evidence and automatic use without erasing history`, t => {
    const f = fixture(t);
    const created = f.tasks.createOrLoad({ candidateKey: 'real-episode', data: { request: { subjectEntity: 'A', deliverable: 'report' }, sourceConnectorId: 'simulated' } });
    const queued = f.database.db.prepare("SELECT id FROM jobs WHERE task_id=? AND state='queued' LIMIT 1").get(created.taskId);
    const job = f.jobs.claim('worker', { id: queued.id }), run = f.tasks.beginRun(job);
    const step = f.experiences.step({ taskRunId: run.id, logicalStepId: 'prepare', stepKind: 'draft_preparation', expectedEffect: { type: 'email_reply' } });
    const id = kind === 'task_run' ? run.id : step.id, e = candidate(f, kind, id);
    assert.equal(f.experiences.sourceUnavailable(e.id), false);
    assert.equal(f.trials.evaluate(e.id, { expectedRevision: 1 }).state, 'passed');
    const active = f.experiences.adopt(e.id, { expectedRevision: 1, userRequested: true });
    assert.equal(f.experiences.validTrialPass(active), true);
    assert.equal(f.experiences.retrieve({ scopes, purpose: 'automatic' }).length, 1);
    f.database.db.prepare(`DELETE FROM ${kind === 'task_run' ? 'task_runs' : 'plan_steps'} WHERE id=?`).run(id);
    assert.equal(f.database.db.prepare('SELECT active FROM source_records WHERE kind=? AND id=?').get(kind, id).active, 1);
    assert.equal(f.experiences.sourceUnavailable(e.id), true);
    assert.equal(f.experiences.validTrialPass(f.experiences.get(e.id)), false);
    assert.deepEqual(f.experiences.retrieve({ scopes, purpose: 'automatic' }), []);
    assert.ok(f.database.db.prepare('SELECT COUNT(*) n FROM experience_trials WHERE experience_id=?').get(e.id).n >= 2);
  });
}

test('a registered opaque event root remains valid without retaining its source body', t => {
  const f = fixture(t), e = candidate(f, 'event', 'opaque-event');
  assert.equal(f.experiences.sourceUnavailable(e.id), false);
  assert.equal(f.trials.evaluate(e.id, { expectedRevision: 1 }).state, 'passed');
});


test('native task-memory projection follows its real task lineage without mistaking the alias for a cycle', t => {
  const f = fixture(t);
  const created = f.tasks.createOrLoad({ candidateKey: 'legacy-memory', data: { request: { subjectEntity: 'A' }, sourceConnectorId: 'simulated' } });
  const id = 'task-memory';
  f.database.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('task_memory',?,?)").run(id, iso());
  f.database.lineage('task', created.taskId, 'task_memory', id);
  new HybridMemory(f.database).put({ id, content: 'Review Cedar work.', sourceKind: 'task_memory', sourceId: id });
  const e = candidate(f, 'memory', id);
  assert.equal(f.experiences.sourceUnavailable(e.id), false);
  assert.deepEqual(f.experiences.provenanceConnectors(e.id), ['simulated']);
  assert.equal(f.trials.evaluate(e.id, { expectedRevision: 1 }).state, 'passed');
  f.database.set('revoked_connectors', JSON.stringify(['simulated']));
  assert.equal(f.experiences.sourceRevoked(e.id), true);
  assert.equal(f.experiences.validTrialPass(e), false);
});


for (const change of ['disabled', 'archived', 'superseded', 'deleted', 'expired']) {
  test(`memory source becoming ${change} invalidates adopted experience through the native retrieval eligibility contract`, t => {
    const f = fixture(t), memory = new HybridMemory(f.database);
    const input = { id: 'real-memory', content: 'Require review.', validUntil: new Date(f.now() + 1000).toISOString() };
    memory.put(input);
    const e = candidate(f, 'memory', input.id);
    assert.equal(f.trials.evaluate(e.id, { expectedRevision: 1 }).state, 'passed');
    const active = f.experiences.adopt(e.id, { expectedRevision: 1, userRequested: true });
    assert.equal(f.experiences.validTrialPass(active), true);
    if (change === 'expired') f.advance(2000);
    else memory.put({ ...input, lifecycleState: change });
    assert.equal(f.experiences.sourceUnavailable(e.id), true);
    assert.equal(f.experiences.validTrialPass(active), false);
    assert.deepEqual(f.experiences.retrieve({ scopes, purpose: 'automatic' }), []);
    assert.ok(f.database.db.prepare('SELECT COUNT(*) n FROM experience_trials WHERE experience_id=?').get(e.id).n >= 2);
  });
}
