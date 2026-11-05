import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { artifactState, reversibility, taskArtifactLifecycle } from '../src/durable/artifact-lifecycle.js';

function setup(t) {
  const database = new DurableDatabase(':memory:');
  const tasks = new DurableTasks(database, new DurableJobs(database));
  t.after(() => database.close());
  const { taskId } = tasks.createOrLoad({ candidateKey: 'lifecycle', data: { request: { subjectEntity: 'A', deliverable: 'report' } } });
  const at = offset => iso(Date.parse('2026-10-29T00:00:00Z') + offset);
  const artifact = (id, offset, extra = {}) => database.atomic(() => database.db.prepare(`INSERT INTO artifacts(id,task_id,generated_version,visible_version,status,generated_digest,latest_digest,stale,created_at,updated_at)
    VALUES(?,?,1,?,?,?,?,?,?,?)`).run(id, taskId, extra.visible || 1, extra.status || 'generated', 'g', extra.latest || 'g', extra.stale ? 1 : 0, at(offset), at(offset)));
  const execution = (id, artifactId, status, family = 'email.send') => database.atomic(() => database.db.prepare(`INSERT INTO tool_executions(id,task_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES(?,?,'gmail','send',?,'mail',?,?,?,1,0,0,0,?,?)`).run(id, taskId, family, `key:${id}`, JSON.stringify({ artifactId }), status, at(0), at(0)));
  return { database, tasks, taskId, artifact, execution };
}

test('artifact state follows review, edit, approval, delivery, staleness and replacement', () => {
  const open = { status: 'ready_for_approval' };
  const row = { status: 'generated', stale: 0 };
  assert.equal(artifactState(row, { task: { status: 'investigating' } }), 'draft');
  assert.equal(artifactState(row, { task: open }), 'pending_review');
  assert.equal(artifactState({ ...row, status: 'edited' }, { task: open }), 'edited');
  assert.equal(artifactState(row, { task: open, executions: [{ status: 'dispatched' }] }), 'approved');
  assert.equal(artifactState(row, { task: open, executions: [{ status: 'unknown' }] }), 'uncertain');
  assert.equal(artifactState(row, { task: open, executions: [{ status: 'verified' }] }), 'sent');
  assert.equal(artifactState({ ...row, stale: 1 }, { task: open }), 'expired');
  assert.equal(artifactState(row, { task: open, newer: true }), 'superseded');
  assert.equal(artifactState(row, { task: { status: 'cancelled' } }), 'discarded');
  assert.equal(artifactState({ ...row, stale: 1 }, { task: open, executions: [{ status: 'verified' }] }), 'sent', 'a delivered artifact stays sent when its source later changes');
});

test('every write family declares whether it can be undone or only compensated', () => {
  assert.equal(reversibility('email.send').kind, 'irreversible');
  assert.equal(reversibility('email.draft').kind, 'reversible');
  assert.equal(reversibility('notion.page.create').kind, 'reversible');
  assert.equal(reversibility('document.patch').kind, 'compensating');
  assert.equal(reversibility('some.future.write').kind, 'irreversible', 'unknown actions are treated as permanent');
});

test('task artifact history links versions, user edits and the execution that consumed them', t => {
  const context = setup(t);
  context.artifact('draft-1', 0);
  context.artifact('draft-2', 1000, { status: 'edited', visible: 2, latest: 'user-edit' });
  context.execution('send-2', 'draft-2', 'verified');
  const history = taskArtifactLifecycle(context.database.db, context.taskId, { ...context.tasks.get(context.taskId), status: 'completed' });
  assert.deepEqual(history.artifacts.map(item => [item.id, item.state]), [['draft-2', 'sent'], ['draft-1', 'superseded']]);
  assert.equal(history.artifacts[0].editedByUser, true);
  assert.equal(history.artifacts[0].visibleVersion, 2);
  assert.equal(history.artifacts[1].supersededBy, 'draft-2');
  assert.deepEqual(history.artifacts[0].executions.map(item => [item.id, item.status, item.reversibility.kind]), [['send-2', 'verified', 'irreversible']]);
});
