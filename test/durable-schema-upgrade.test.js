import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DurableDatabase, SQLITE_RUNTIME } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3');
const fixture = fs.readFileSync(new URL('./fixtures/schema-0.4.0-v7.sql', import.meta.url), 'utf8');

const tempDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-schema-upgrade-'));
const budgetColumns = ['budget_deferrals', 'budget_metadata_json', 'budget_wake_epoch', 'budget_claim_epoch'];

function createV7Workspace(filename, at) {
  const database = new BetterSqlite3(filename);
  database.pragma('journal_mode=WAL');
  database.exec(fixture);
  database.pragma('user_version=7');
  database.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('state_revision', '41');
  database.prepare('INSERT INTO tasks(id,candidate_key,data_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('kept-task', 'candidate-kept', JSON.stringify({ id: 'kept-task', title: 'preserve me' }), 'open', at, at);
  database.prepare('INSERT INTO user_memories(id,scope_type,scope_key,content,source_kind,source_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('kept-memory', 'global', '*', 'Keep this fact.', 'user_instruction', 'kept-memory', at, at);
  // A real chain so the experience_revision backfill can be asserted without
  // dangling foreign keys (better-sqlite3 enables foreign keys by default).
  database.prepare('INSERT INTO task_runs(id,task_id,job_id,job_lease_token,input_version,run_generation,privacy_epoch,status,plan_version,checkpoint_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('kept-run', 'kept-task', null, 1, 0, 0, 0, 'completed', 1, null, at, at);
  database.prepare('INSERT INTO plan_steps(id,task_run_id,logical_step_id,plan_version,step_kind,action_family,expected_effect_json,omission_reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('kept-step', 'kept-run', 'step-1', 1, 'tool', null, '{}', null, 'completed', at, at);
  database.prepare('INSERT INTO experiences(id,user_id,kind,status,scope_type,scope_key,action_family,directive_key,predicate_ast_json,effect_signature_json,instruction_text,priority,specificity,verified_success_count,positive_evidence_count,negative_evidence_count,freshness_class,last_verified_at,last_negative_at,valid_until,cooldown_until,revision,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('kept-experience', 'local', 'execution_hint', 'active', 'global', '*', null, null, '{}', '{}', 'Keep this hint.', 0, 0, 0, 0, 0, 'stable', null, null, null, null, 7, 1, at, at);
  database.prepare('INSERT INTO plan_step_experiences(plan_step_id,experience_id,relation_kind,created_at) VALUES(?,?,?,?)')
    .run('kept-step', 'kept-experience', 'planner_declared', at);
  database.close();
}

test('a real 0.4.0 schema 7 workspace upgrades to schema 10 without losing rows', t => {
  const directory = tempDirectory();
  const filename = path.join(directory, 'workspace.sqlite');
  const at = new Date().toISOString();
  createV7Workspace(filename, at);

  const database = new DurableDatabase(filename);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(database.db.pragma('user_version', { simple: true }), SQLITE_RUNTIME.schemaVersion);
  assert.equal(SQLITE_RUNTIME.schemaVersion, 10);
  assert.deepEqual(database.db.prepare('SELECT id,data_json,status FROM tasks WHERE id=?').get('kept-task'), {
    id: 'kept-task',
    data_json: JSON.stringify({ id: 'kept-task', title: 'preserve me' }),
    status: 'open'
  });
  assert.equal(database.db.prepare('SELECT content FROM user_memories WHERE id=?').get('kept-memory').content, 'Keep this fact.');
  assert.ok(Number(database.db.prepare('SELECT value FROM metadata WHERE key=?').get('state_revision').value) >= 41);
  for (const table of ['github_webhook_receipts', 'model_usage', 'memory_versions', 'memory_relations']) {
    assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
  assert.ok(database.db.pragma('table_info(plan_step_experiences)').some(column => column.name === 'experience_revision'));
  assert.equal(database.db.prepare('SELECT experience_revision FROM plan_step_experiences WHERE experience_id=?').get('kept-experience').experience_revision, 7);
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_active_task_dedup'").get(), 'uq_active_task_dedup');
  // Preservation check only: the v7 fixture already has these task columns.
  const taskColumns = new Set(database.db.pragma('table_info(tasks)').map(column => column.name));
  assert.ok(taskColumns.has('situation_id') && taskColumns.has('dedup_task_key'));

  new DurableJobs(database);
  const jobColumns = new Set(database.db.pragma('table_info(jobs)').map(column => column.name));
  for (const column of budgetColumns) assert.ok(jobColumns.has(column), column);
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_budget_wakes'").get(), 'job_budget_wakes');
  assert.ok(database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_budget_wakes_pending'").get(), 'idx_budget_wakes_pending');

  for (const key of ['context_version', 'privacy_epoch', 'privacy_salt', 'learning_auto_promote', 'promotion_policy_version']) {
    assert.ok(database.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(key), key);
  }
});

test('reopening an upgraded 0.4.0 workspace is idempotent', t => {
  const directory = tempDirectory();
  const filename = path.join(directory, 'workspace.sqlite');
  createV7Workspace(filename, new Date().toISOString());

  let database = new DurableDatabase(filename);
  const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const indexes = database.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const columns = database.db.pragma('table_info(plan_step_experiences)');
  database.close();

  database = new DurableDatabase(filename);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(database.db.pragma('user_version', { simple: true }), SQLITE_RUNTIME.schemaVersion);
  assert.deepEqual(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables);
  assert.deepEqual(database.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), indexes);
  assert.deepEqual(database.db.pragma('table_info(plan_step_experiences)'), columns);
  assert.equal(database.db.prepare('SELECT count(*) n FROM tasks').get().n, 1);
  assert.equal(database.db.prepare('SELECT count(*) n FROM user_memories').get().n, 1);
});

test('a failed migration leaves the 0.4.0 workspace unchanged', t => {
  const directory = tempDirectory();
  const filename = path.join(directory, 'workspace.sqlite');
  createV7Workspace(filename, new Date().toISOString());

  const original = DurableDatabase.prototype.migrateMemorySpace;
  DurableDatabase.prototype.migrateMemorySpace = function () {
    assert.equal(this.db.inTransaction, true, 'migration must run inside the schema transaction');
    throw new Error('injected migration failure');
  };
  try {
    assert.throws(() => new DurableDatabase(filename), /injected migration failure/);
  } finally {
    DurableDatabase.prototype.migrateMemorySpace = original;
  }

  const database = new BetterSqlite3(filename);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(database.pragma('user_version', { simple: true }), 7);
  assert.equal(database.prepare("SELECT count(*) n FROM sqlite_master WHERE name='github_webhook_receipts'").get().n, 0);
  assert.equal(database.prepare('SELECT count(*) n FROM tasks WHERE id=?').get('kept-task').n, 1);
  assert.equal(database.prepare('SELECT count(*) n FROM user_memories WHERE id=?').get('kept-memory').n, 1);
});

test('a read-only v7 workspace is refused instead of running on a stale schema', t => {
  const directory = tempDirectory();
  const filename = path.join(directory, 'workspace.sqlite');
  createV7Workspace(filename, new Date().toISOString());
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => new DurableDatabase(filename, { readonly: true }), error => error.code === 'SQLITE_SCHEMA');
});

test('a read-only upgraded workspace opens', t => {
  const directory = tempDirectory();
  const filename = path.join(directory, 'workspace.sqlite');
  createV7Workspace(filename, new Date().toISOString());
  const writer = new DurableDatabase(filename);
  const reader = new DurableDatabase(filename, { readonly: true });
  t.after(() => {
    reader.close();
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(reader.readonly, true);
  assert.equal(reader.db.pragma('user_version', { simple: true }), SQLITE_RUNTIME.schemaVersion);
});
