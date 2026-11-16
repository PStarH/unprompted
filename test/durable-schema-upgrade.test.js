import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DurableDatabase, SQLITE_RUNTIME } from '../src/durable/database.js';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3');
const fixture = fs.readFileSync(new URL('./fixtures/schema-0.4.0-v7.sql', import.meta.url), 'utf8');

const tempDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-schema-upgrade-'));

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
  database.close();
}

test('a real 0.4.0 schema 7 workspace upgrades to schema 10 without losing rows', t => {
  const directory = tempDirectory();
  const filename = path.join(directory, 'workspace.sqlite');
  const at = new Date().toISOString();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  createV7Workspace(filename, at);

  const database = new DurableDatabase(filename);
  t.after(() => database.close());

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
  for (const key of ['context_version', 'privacy_epoch', 'privacy_salt', 'learning_auto_promote', 'promotion_policy_version']) {
    assert.ok(database.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(key), key);
  }
});

test('reopening an upgraded 0.4.0 workspace is idempotent', t => {
  const directory = tempDirectory();
  const filename = path.join(directory, 'workspace.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  createV7Workspace(filename, new Date().toISOString());

  let database = new DurableDatabase(filename);
  const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const columns = database.db.pragma('table_info(plan_step_experiences)');
  database.close();

  database = new DurableDatabase(filename);
  t.after(() => database.close());
  assert.equal(database.db.pragma('user_version', { simple: true }), SQLITE_RUNTIME.schemaVersion);
  assert.deepEqual(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables);
  assert.deepEqual(database.db.pragma('table_info(plan_step_experiences)'), columns);
  assert.equal(database.db.prepare('SELECT count(*) n FROM tasks').get().n, 1);
  assert.equal(database.db.prepare('SELECT count(*) n FROM user_memories').get().n, 1);
});
