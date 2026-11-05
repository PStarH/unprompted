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

// memory_versions and memory_relations are owned by the integrated memory
// migration. If a checkout lacks them, install an equivalent fixture rather
// than skipping the cleanup contract; when they exist, insert only into the
// columns they provide.
function graphTables(context) { return new Set(context.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)); }
function ensureMemoryGraph(context) {
  const names = graphTables(context);
  if (!names.has('memory_versions')) context.database.db.exec(`CREATE TABLE memory_versions (
    id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES user_memories(id),
    version INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
    privacy_epoch INTEGER NOT NULL DEFAULT 0)`);
  if (!names.has('memory_relations')) context.database.db.exec(`CREATE TABLE memory_relations (
    id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL REFERENCES user_memories(id),
    to_memory_id TEXT NOT NULL REFERENCES user_memories(id), relation_type TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
}
function graphColumns(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all(); }
function endpointColumns(db, table) {
  const foreign = db.prepare(`PRAGMA foreign_key_list(${table})`).all().filter(row => row.table === 'user_memories').map(row => row.from);
  const endpoint = /^(?:memory_id|memory_[a-z]+_id|(?:from|to|source|target|left|right|related)_memory(?:_id)?)$/;
  const fallback = graphColumns(db, table).map(column => column.name).filter(name => endpoint.test(name)
    || (table === 'memory_relations' && ['from_id', 'to_id', 'source_id', 'target_id', 'left_id', 'right_id', 'related_id'].includes(name)));
  return [...new Set(foreign.length ? foreign : fallback)];
}
function contentColumn(db, table) {
  const endpoints = endpointColumns(db, table);
  const candidates = graphColumns(db, table).map(column => column.name)
    .filter(name => !endpoints.includes(name) && !/^(id|version|privacy_epoch|created_at|updated_at|.*_at)$/.test(name));
  return candidates.find(name => /content|text|body|value|snapshot|json/i.test(name)) || candidates[0];
}
function insertFlexible(db, table, values) {
  const columns = graphColumns(db, table), names = [], args = [];
  const singleIntegerKey = columns.filter(column => column.pk).length === 1 && columns.some(column => column.pk && /INT/i.test(column.type));
  for (const column of columns) {
    if (Object.hasOwn(values, column.name)) { names.push(column.name); args.push(values[column.name]); continue; }
    if (column.pk && singleIntegerKey) continue;
    if (column.dflt_value != null || (!column.notnull && !column.pk)) continue;
    names.push(column.name);
    args.push(/BLOB/i.test(column.type) ? Buffer.alloc(0) : /INT|REAL|FLOAT|DOUBLE|NUM/i.test(column.type) ? 0 : '');
  }
  // Replace rather than insert because ordinary memory writes already create a
  // baseline version under the integrated schema.
  db.prepare(`INSERT OR REPLACE INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`).run(...args);
}
function seedVersion(db, { id, memoryId, version, content, at = iso() }) {
  insertFlexible(db, 'memory_versions', {
    id, version, created_at: at, updated_at: at, privacy_epoch: 0, memory_kind: 'fact', lifecycle_state: 'active',
    scope_type: 'global', scope_key: '*', valid_until: null,
    [endpointColumns(db, 'memory_versions')[0]]: memoryId, [contentColumn(db, 'memory_versions')]: content
  });
}
function seedRelation(db, { id, from, to, type = 'derived_from', at = iso() }) {
  const [fromColumn, toColumn] = endpointColumns(db, 'memory_relations');
  insertFlexible(db, 'memory_relations', {
    id, relation_kind: type, relation_type: type, status: 'established', evidence_kind: 'direct_correction', evidence_ref: id,
    created_at: at, updated_at: at, [fromColumn]: from, [toColumn]: to
  });
}
function countIncident(db, table, memoryIds) {
  const columns = endpointColumns(db, table), placeholders = memoryIds.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${columns.map(name => `"${name}" IN (${placeholders})`).join(' OR ')}`).get(...columns.flatMap(() => memoryIds)).n;
}
function versionRows(db, memoryIds) {
  const endpoint = endpointColumns(db, 'memory_versions')[0];
  return db.prepare(`SELECT * FROM memory_versions WHERE "${endpoint}" IN (${memoryIds.map(() => '?').join(',')})`).all(...memoryIds);
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

test('Forget permanently removes incident relations in both directions and version history but keeps neighbors', async t => {
  const context = setup(t); withMemory(context); ensureMemoryGraph(context);
  context.memory.put({ id: 'neighbor-a', content: 'neighbor alpha planning note' });
  context.memory.put({ id: 'neighbor-b', content: 'neighbor beta planning note' });
  const db = context.database.db;
  seedVersion(db, { id: 'fact-v1', memoryId: 'fact', version: 1, content: secret });
  seedVersion(db, { id: 'fact-v2', memoryId: 'fact', version: 2, content: 'archived caldera history' });
  seedVersion(db, { id: 'neighbor-v1', memoryId: 'neighbor-a', version: 1, content: 'neighbor alpha history' });
  seedRelation(db, { id: 'fact-to-a', from: 'fact', to: 'neighbor-a', type: 'derived_from' });
  seedRelation(db, { id: 'b-to-fact', from: 'neighbor-b', to: 'fact', type: 'derived_from' });
  seedRelation(db, { id: 'a-to-b', from: 'neighbor-a', to: 'neighbor-b', type: 'derived_from' });

  const preview = context.privacy.preview('memory', 'fact');
  assert.equal(preview.counts.memory, 1);
  assert.equal(preview.counts.memory_version, 2);
  assert.equal(preview.counts.memory_relation, 2, 'only relations incident to the forgotten memory are counted');
  assert.ok(!preview.records.some(record => ['neighbor-a', 'neighbor-b'].includes(record.id)), 'relations must not widen Forget traversal');
  assert.ok(preview.roots.every(root => root.id === 'fact'), 'relations must not add Forget roots');

  const result = await context.privacy.forget({ kind: 'memory', id: 'fact' });
  assert.equal(result.state, 'completed');
  assert.equal(countIncident(db, 'memory_versions', ['fact']), 0);
  assert.equal(countIncident(db, 'memory_relations', ['fact']), 0);
  assert.equal(versionRows(db, ['fact']).length, 0);
  assert.ok(!JSON.stringify(versionRows(db, ['fact'])).includes(secret));
  assert.ok(!fs.readFileSync(context.database.filename).includes(Buffer.from(secret)));
  assert.ok(!fs.readFileSync(context.database.filename).includes(Buffer.from('archived caldera history')));

  // Neighbors and their history survive; only edges incident to the forgotten
  // id are removed. The unrelated neighbor-to-neighbor edge remains.
  assert.ok(db.prepare("SELECT 1 FROM user_memories WHERE id='neighbor-a'").get());
  assert.ok(db.prepare("SELECT 1 FROM user_memories WHERE id='neighbor-b'").get());
  assert.equal(countIncident(db, 'memory_versions', ['neighbor-a']), 1);
  assert.equal(countIncident(db, 'memory_relations', ['neighbor-a', 'neighbor-b']), 1);
  assert.deepEqual(context.memory.search('neighbor').map(row => row.id).sort(), ['neighbor-a', 'neighbor-b']);

  // Ordinary memory writes cannot resurrect a forgotten identifier.
  assert.throws(() => context.memory.put({ id: 'fact', content: secret }), /forgotten|SOURCE_FORGOTTEN/i);
  assert.throws(() => context.memory.put({ id: 'fact', content: 'fresh content' }), /forgotten|SOURCE_FORGOTTEN/i);
  assert.ok(!db.prepare("SELECT 1 FROM user_memories WHERE id='fact'").get());
});

test('permission revocation with local purge removes grounded memory history and incident relations only', async t => {
  const context = setup(t); ensureMemoryGraph(context);
  const task = context.tasks.createOrLoad({ candidateKey: 'revoked', data: { sourceConnectorId: 'fixture', subject: 'Revoked', status: 'waiting_for_information' } });
  context.memory.put({ id: 'grounded', content: 'grounded fixture secret', sourceKind: 'task', sourceId: task.taskId });
  context.memory.put({ id: 'keep-a', content: 'keep alpha planning note' });
  context.memory.put({ id: 'keep-b', content: 'keep beta planning note' });
  const db = context.database.db;
  seedVersion(db, { id: 'grounded-v1', memoryId: 'grounded', version: 1, content: 'grounded fixture secret' });
  seedVersion(db, { id: 'keep-v1', memoryId: 'keep-a', version: 1, content: 'keep alpha history' });
  seedRelation(db, { id: 'grounded-to-a', from: 'grounded', to: 'keep-a', type: 'derived_from' });
  seedRelation(db, { id: 'b-to-grounded', from: 'keep-b', to: 'grounded', type: 'derived_from' });
  seedRelation(db, { id: 'a-to-b', from: 'keep-a', to: 'keep-b', type: 'derived_from' });

  await context.privacy.revokePermission({ connectorId: 'fixture', purgeLocal: true });

  assert.ok(!db.prepare("SELECT 1 FROM user_memories WHERE id='grounded'").get());
  assert.equal(countIncident(db, 'memory_versions', ['grounded']), 0);
  assert.equal(countIncident(db, 'memory_relations', ['grounded']), 0);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM memory_versions').all()).includes('grounded fixture secret'));
  assert.ok(db.prepare("SELECT 1 FROM user_memories WHERE id='keep-a'").get());
  assert.ok(db.prepare("SELECT 1 FROM user_memories WHERE id='keep-b'").get());
  assert.equal(countIncident(db, 'memory_versions', ['keep-a']), 1);
  assert.equal(countIncident(db, 'memory_relations', ['keep-a', 'keep-b']), 1);
  assert.deepEqual(context.memory.search('keep').map(row => row.id).sort(), ['keep-a', 'keep-b']);
});

test('ordinary memory write and lifecycle restore APIs reject a forgotten identifier', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-forgotten-restore-'));
  const store = new SqliteStore(path.join(directory, 'workspace.sqlite'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const privacy = new ForgetService(store.database, { jobs: store.jobs, memory: store.memory, store });
  store.memory.put({ id: 'fact', content: secret });
  await privacy.forget({ kind: 'memory', id: 'fact' });
  // Direct embedding and the store's lifecycle-restore path both fail closed.
  assert.throws(() => store.memory.put({ id: 'fact', content: secret }), /forgotten|SOURCE_FORGOTTEN/i);
  assert.throws(() => store.mutate(state => {
    state.taskMemories = { ...(state.taskMemories || {}), fact: { id: 'fact', taskId: 'task', text: secret, scope: { entity: 'A', deliverable: 'report' }, createdAt: iso(), updatedAt: iso(), lifecycleState: 'active', deletedAt: null } };
  }), /forgotten|SOURCE_FORGOTTEN/i);
  assert.ok(!store.state.taskMemories?.fact);
});
