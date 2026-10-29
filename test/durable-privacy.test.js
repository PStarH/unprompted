import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ExperienceService } from '../src/durable/experience.js';
import { HybridMemory } from '../src/durable/memory.js';
import { ForgetService } from '../src/durable/privacy.js';
import { SqliteStore } from '../src/durable/store.js';
import { emptyState } from '../src/store.js';

const secret = 'private-caldera-review-instruction';
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-privacy-'));
  const database = new DurableDatabase(path.join(directory, 'workspace.sqlite'));
  const jobs = new DurableJobs(database), tasks = new DurableTasks(database, jobs), memory = new HybridMemory(database), experiences = new ExperienceService(database, { jobs });
  const privacy = new ForgetService(database, { jobs, memory });
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, database, jobs, tasks, memory, experiences, privacy };
}
function withMemory(context) { return context.memory.put({ id: 'fact', content: secret }); }
function dependentRun(context) {
  const created = context.tasks.createOrLoad({ candidateKey: 'dependent', data: { subject: secret, status: 'waiting_for_information' } });
  const job = context.jobs.claim('worker'), run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: { instruction: secret }, sources: [{ kind: 'memory', id: 'fact' }] });
  return { taskId: created.taskId, job, run };
}

test('v0.3/25 Forget cancels pending compiler jobs and rejects a compiler returning after deletion', async t => {
  const context = setup(t); withMemory(context);
  const queued = context.jobs.enqueue({ queue: 'learning', type: 'compile_experience', key: 'compile-forgotten', payload: { sourceKind: 'memory', sourceId: 'fact', privacyEpoch: 0 } });
  context.database.atomic(() => context.database.lineage('memory', 'fact', 'job', queued.id));
  const job = context.jobs.claim('compiler', { queue: 'learning' }); let finish;
  const pending = context.experiences.compile(job, () => new Promise(resolve => { finish = resolve; }), { assertOwned: () => context.jobs.assert(job) });
  await context.privacy.forget({ kind: 'memory', id: 'fact' });
  finish([{ kind: 'planning_hint', scopeType: 'project', scopeKey: 'A', instruction: secret, effect: { type: 'advisory' } }]);
  await assert.rejects(pending, /no longer owns|Privacy changed|available/);
  assert.equal(context.jobs.get(job.id).state, 'cancelled'); assert.deepEqual(context.experiences.list(), []);
});

test('v0.3/26 a privacy-invalidated running worker cannot commit a checkpoint or local task transition', async t => {
  const context = setup(t); withMemory(context); const current = dependentRun(context), before = context.tasks.get(current.taskId);
  await context.privacy.forget({ kind: 'memory', id: 'fact' });
  const after = context.tasks.get(current.taskId);
  assert.ok(after.privacyEpoch > before.privacyEpoch); assert.ok(after.runGeneration > before.runGeneration);
  assert.equal(after.status, 'cancelled');
  assert.throws(() => context.tasks.checkpoint(current.run, current.job, { expectedInputVersion: 0, plan: { instruction: secret } }), /no longer owns|no longer current/);
  assert.throws(() => context.tasks.update(current.taskId, before.stateVersion, data => { data.subject = secret; }), /state version changed/);
});

test('v0.3/27 secure Forget removes FTS entries, embeddings and cache results and truncates WAL', async t => {
  const context = setup(t); withMemory(context);
  assert.equal(context.memory.search('caldera')[0].id, 'fact');
  assert.equal(context.database.db.prepare("SELECT v FROM memory_fts_config WHERE k='secure-delete'").get().v, 1);
  const result = await context.privacy.forget({ kind: 'memory', id: 'fact' });
  assert.equal(result.state, 'completed'); assert.equal(result.status.wal, 'truncated');
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM memory_fts WHERE memory_fts MATCH 'caldera'").get().n, 0);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM memory_embeddings').get().n, 0);
  assert.deepEqual(context.memory.search('caldera'), []);
  assert.ok(!fs.readFileSync(context.database.filename).includes(Buffer.from(secret)));
});

test('v0.3/28 waiting tasks cannot resume from forgotten checkpoints', async t => {
  const context = setup(t); withMemory(context); const current = dependentRun(context);
  context.tasks.finish(current.run, current.job, 'waiting'); context.jobs.complete(current.job);
  await context.privacy.forget({ kind: 'memory', id: 'fact' });
  const row = context.database.db.prepare('SELECT status,checkpoint_json FROM task_runs WHERE id=?').get(current.run.id);
  assert.equal(row.status, 'cancelled'); assert.equal(row.checkpoint_json, null);
  context.jobs.enqueue({ type: 'task_continue', key: 'manual-resume', taskId: current.taskId, payload: { taskId: current.taskId } });
  const resumed = context.jobs.claim('resumer');
  assert.throws(() => context.tasks.beginRun(resumed), /paused or closed/);
});

test('v0.3/29 migration backups and external payloads obey declared deletion retention', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-migration-'));
  const filename = path.join(directory, 'state.json'), state = emptyState();
  state.events = [{ id: 'mail-event', type: 'email.received', connectorId: 'fixture', source: 'fixture', payload: { id: 'mail', body: secret }, at: iso() }];
  state.inbox = [{ id: 'mail', body: secret }];
  state.tasks = { task: { id: 'task', sourceEmailId: 'mail', subject: secret, status: 'waiting_for_information', request: { subjectEntity: 'A', deliverable: 'report' } } };
  fs.writeFileSync(filename, JSON.stringify(state), { mode: 0o600 });
  const store = new SqliteStore(filename);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.migrated, true); assert.equal(fs.existsSync(filename + '.migration-backup'), true);
  const privacy = new ForgetService(store.database, { jobs: store.jobs, memory: store.memory, store });
  const result = await privacy.forget({ kind: 'event', id: 'mail-event' });
  assert.equal(result.status.backupsRemoved, 1);
  assert.equal(fs.existsSync(filename + '.migration-backup'), false);
  assert.equal(store.state.inbox.length, 0);
  assert.ok(!JSON.stringify(store.state).includes(secret));
  assert.match(result.status.externalRetention, /outside local deletion/);
});

test('v0.3/30 Forget retains only opaque invalidation identifiers, never semantic tombstones', async t => {
  const context = setup(t); withMemory(context); dependentRun(context);
  const experience = context.experiences.create({ kind: 'planning_hint', scopeType: 'project', scopeKey: 'A', instruction: secret, effect: { type: 'advisory' } }, { sources: [{ kind: 'memory', id: 'fact' }] });
  await context.privacy.forget({ kind: 'memory', id: 'fact' });
  assert.equal(context.experiences.get(experience.id), undefined);
  assert.ok(context.database.db.prepare('SELECT * FROM forgotten_sources').all().every(row => /^[a-f0-9]{64}$/.test(row.id_digest)));
  assert.equal(context.database.db.prepare('SELECT checkpoint_json FROM task_runs').all().every(row => row.checkpoint_json == null), true);
  assert.ok(!JSON.stringify(context.database.db.prepare('SELECT * FROM tasks').all()).includes(secret));
  assert.throws(() => withMemory(context), /forgotten/);
  assert.deepEqual(context.memory.search('caldera'), []);
});

test('an outstanding reader makes deletion retention pending until WAL truncation is possible', async t => {
  const context = setup(t); withMemory(context);
  const reader = new DurableDatabase(context.database.filename, { readonly: true });
  reader.db.exec('BEGIN'); reader.db.prepare('SELECT * FROM user_memories').all();
  context.database.db.pragma('busy_timeout=0');
  const result = await context.privacy.forget({ kind: 'memory', id: 'fact' });
  assert.equal(result.state, 'pending'); assert.equal(result.status.wal, 'waiting_for_readers');
  reader.db.exec('COMMIT'); reader.close();
  const finished = await context.privacy.finish(result.id);
  assert.equal(finished.state, 'completed'); assert.equal(finished.status.wal, 'truncated');
});
