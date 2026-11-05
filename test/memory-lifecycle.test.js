import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, SQLITE_RUNTIME, iso } from '../src/durable/database.js';
import { HybridMemory } from '../src/durable/memory.js';
import { ActivationPolicies } from '../src/durable/context.js';

const tempDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-memory-lifecycle-'));

function open(t, options = {}) {
  let now = Date.now();
  const directory = tempDirectory();
  let database = new DurableDatabase(path.join(directory, 'workspace.sqlite'), { now: () => now, ...options.database });
  const memory = new HybridMemory(database, options.memory);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, memory,
    get database() { return database; },
    reopen() { database.close(); database = new DurableDatabase(path.join(directory, 'workspace.sqlite'), { now: () => now, ...options.database }); return database; },
    advance: value => { now += value; }
  };
}

// Simulate the v5 shape by removing the new columns and tables from a fresh
// database, then reopening so the real migration runs.
function downgradeToV5(database) {
  database.atomic(() => {
    database.db.exec(`CREATE TABLE legacy_user_memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local', scope_type TEXT NOT NULL, scope_key TEXT NOT NULL,
      content TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, privacy_epoch INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    database.db.exec('INSERT INTO legacy_user_memories SELECT id,user_id,scope_type,scope_key,content,source_kind,source_id,version,privacy_epoch,created_at,updated_at FROM user_memories');
    database.db.exec('DROP TABLE memory_versions; DROP TABLE memory_relations');
    database.db.exec('DROP TABLE user_memories');
    database.db.exec('ALTER TABLE legacy_user_memories RENAME TO user_memories');
    database.db.pragma('user_version=5');
  });
}

test('v5 workspaces gain Memory Space columns and tables additively without losing rows', async t => {
  const context = open(t);
  context.database.atomic(() => {
    context.database.db.prepare('INSERT INTO user_memories(id,scope_type,scope_key,content,source_kind,source_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('kept', 'global', '*', 'Weekly notes start with results.', 'user_instruction', 'kept', iso(context.database.now()), iso(context.database.now()));
  });
  downgradeToV5(context.database);
  context.reopen();
  assert.equal(context.database.db.pragma('user_version', { simple: true }), SQLITE_RUNTIME.schemaVersion);
  assert.equal(SQLITE_RUNTIME.schemaVersion, 7);
  const columns = new Map(context.database.db.pragma('table_info(user_memories)').map(column => [column.name, column]));
  assert.equal(columns.get('memory_kind').dflt_value, "'fact'");
  assert.equal(columns.get('lifecycle_state').dflt_value, "'active'");
  assert.ok(columns.has('valid_until')); assert.ok(columns.has('lifecycle_updated_at'));
  const row = context.database.db.prepare('SELECT * FROM user_memories WHERE id=?').get('kept');
  assert.equal(row.content, 'Weekly notes start with results.'); assert.equal(row.memory_kind, 'fact'); assert.equal(row.lifecycle_state, 'active');
  assert.ok(context.database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_versions'").get());
  assert.ok(context.database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_relations'").get());
  const snapshot = context.database.db.prepare("SELECT * FROM memory_versions WHERE memory_id='kept'").all();
  assert.equal(snapshot.length, 1); assert.equal(snapshot[0].change_kind, 'current_snapshot'); assert.equal(snapshot[0].version, row.version);
});

test('inactive task_memory rows migrate to deleted while active and user facts stay active', async t => {
  const context = open(t);
  const at = iso(context.database.now());
  context.database.atomic(() => {
    for (const [id, active] of [['live-task-memory', 1], ['dead-task-memory', 0]]) {
      context.database.db.prepare('INSERT INTO source_records(kind,id,active,created_at) VALUES(?,?,?,?)').run('task_memory', id, active, at);
      context.database.db.prepare('INSERT INTO user_memories(id,scope_type,scope_key,content,source_kind,source_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, 'project', 'A', `content ${id}`, 'task_memory', id, at, at);
    }
    context.database.db.prepare('INSERT INTO user_memories(id,scope_type,scope_key,content,source_kind,source_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('user-fact', 'global', '*', 'A user preference', 'user_instruction', 'user-fact', at, at);
  });
  downgradeToV5(context.database);
  context.reopen();
  const state = id => context.database.db.prepare('SELECT lifecycle_state,lifecycle_updated_at FROM user_memories WHERE id=?').get(id);
  assert.equal(state('dead-task-memory').lifecycle_state, 'deleted');
  assert.ok(state('dead-task-memory').lifecycle_updated_at);
  assert.equal(state('live-task-memory').lifecycle_state, 'active');
  assert.equal(state('user-fact').lifecycle_state, 'active');
  assert.equal(state('user-fact').lifecycle_updated_at, null);
  // Backfill is one baseline row per memory, labelled as a snapshot, not history.
  const versions = context.database.db.prepare('SELECT memory_id,change_kind FROM memory_versions ORDER BY memory_id').all();
  assert.equal(versions.length, 3);
  assert.ok(versions.every(row => row.change_kind === 'current_snapshot'));
});

test('reopening at the current schema is idempotent and does not add snapshots', async t => {
  const context = open(t);
  context.memory.put({ id: 'stable', content: 'Cedar uses concise summaries.' });
  const before = context.database.db.prepare('SELECT * FROM memory_versions ORDER BY memory_id,version').all();
  const hotBefore = context.database.db.prepare("SELECT origin_id,context_version FROM hot_context_items WHERE origin_kind='memory'").all();
  context.reopen();
  assert.equal(context.database.db.pragma('user_version', { simple: true }), SQLITE_RUNTIME.schemaVersion);
  assert.deepEqual(context.database.db.prepare('SELECT * FROM memory_versions ORDER BY memory_id,version').all(), before);
  assert.deepEqual(context.database.db.prepare("SELECT origin_id,context_version FROM hot_context_items WHERE origin_kind='memory'").all(), hotBefore);
});

test('put stays backward compatible and records a snapshot for every committed version', async t => {
  const context = open(t);
  const first = context.memory.put({ id: 'fact', content: 'Cedar weekly notes start with results.' });
  assert.equal(first.memory_kind, 'fact'); assert.equal(first.lifecycle_state, 'active'); assert.equal(first.valid_until, null); assert.equal(first.version, 1);
  const second = context.memory.put({ id: 'fact', content: 'Cedar weekly notes start with results.', memoryKind: 'preference', changeKind: 'reclassified' });
  assert.equal(second.version, 2); assert.equal(second.memory_kind, 'preference');
  context.memory.put({ id: 'fact', content: 'Cedar weekly notes start with results.', memoryKind: 'preference', validUntil: iso(context.database.now() + 60000) });
  const versions = context.database.db.prepare('SELECT version,change_kind,memory_kind,valid_until FROM memory_versions WHERE memory_id=? ORDER BY version').all('fact');
  assert.deepEqual(versions.map(row => row.change_kind), ['created', 'reclassified', 'update']);
  assert.deepEqual(versions.map(row => row.version), [1, 2, 3]);
  assert.equal(versions[2].memory_kind, 'preference'); assert.ok(versions[2].valid_until);
});

test('an identical put is idempotent across every mutable field', async t => {
  const context = open(t);
  context.memory.put({ id: 'same', content: 'Cedar prefers short updates.', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar', validUntil: '2030-01-01T00:00:00.000Z' });
  const versions = () => context.database.db.prepare('SELECT COUNT(*) n FROM memory_versions WHERE memory_id=?').get('same').n;
  const contextVersion = () => Number(context.database.get('context_version'));
  const before = { versions: versions(), contextVersion: contextVersion() };
  const repeat = context.memory.put({ id: 'same', content: 'Cedar prefers short updates.', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar', validUntil: '2030-01-01T00:00:00.000Z' });
  assert.equal(repeat.version, 1); assert.equal(versions(), before.versions); assert.equal(contextVersion(), before.contextVersion);
  // Changing source_id is a mutable-field change even when content is identical.
  const changed = context.memory.put({ id: 'same', content: 'Cedar prefers short updates.', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar', validUntil: '2030-01-01T00:00:00.000Z', sourceId: 'other' });
  assert.equal(changed.version, 2); assert.equal(versions(), before.versions + 1);
});

test('only content changes rebuild FTS and vector rows; lifecycle changes bump the context version', async t => {
  const context = open(t);
  context.memory.put({ id: 'gap', content: 'Cedar prefers weekly summaries.' });
  const embedding = () => context.database.db.prepare('SELECT vector,model_id FROM memory_embeddings WHERE memory_id=?').get('gap');
  const fts = () => context.database.db.prepare('SELECT content FROM memory_fts WHERE id=?').get('gap');
  const startEmbedding = embedding(), startFts = fts();
  let before = Number(context.database.get('context_version'));
  context.memory.put({ id: 'gap', content: 'Cedar prefers weekly summaries.', memoryKind: 'preference', lifecycleState: 'disabled' });
  assert.deepEqual(embedding(), startEmbedding, 'the embedding blob is preserved when content is unchanged');
  assert.deepEqual(fts(), startFts, 'the FTS row is preserved when content is unchanged');
  assert.ok(Number(context.database.get('context_version')) > before);
  before = Number(context.database.get('context_version'));
  context.memory.put({ id: 'gap', content: 'Cedar prefers monthly summaries.', memoryKind: 'preference', lifecycleState: 'disabled' });
  assert.notDeepEqual(embedding(), startEmbedding, 'content changes rebuild the vector');
  assert.equal(fts().content, 'Cedar prefers monthly summaries.');
  assert.ok(Number(context.database.get('context_version')) > before, 'a content change also bumps the context version');
});

test('retrieval, hot context and cached results share one eligibility rule', async t => {
  const context = open(t);
  const future = () => iso(context.database.now() + 60000);
  context.memory.put({ id: 'active-fact', content: 'Cedar alpha report' });
  context.memory.put({ id: 'disabled', content: 'Cedar beta report', lifecycleState: 'disabled' });
  context.memory.put({ id: 'archived', content: 'Cedar gamma report', lifecycleState: 'archived' });
  context.memory.put({ id: 'superseded-row', content: 'Cedar delta report', lifecycleState: 'superseded' });
  context.memory.put({ id: 'expiring', content: 'Cedar epsilon report', validUntil: future() });
  context.memory.put({ id: 'expired', content: 'Cedar zeta report', validUntil: iso(context.database.now() - 60000) });
  const ids = () => context.memory.search('Cedar').map(row => row.id).sort();
  assert.deepEqual(ids(), ['active-fact', 'expiring']);
  const hot = new Set(context.database.db.prepare("SELECT origin_id FROM hot_context_items WHERE origin_kind='memory'").all().map(row => row.origin_id));
  assert.deepEqual([...hot].sort(), ['active-fact', 'expiring']);
});

test('a validity expiry invalidates a cached retrieval result without a write', async t => {
  const context = open(t);
  context.memory.put({ id: 'temporary', content: 'Cedar temporary instruction', validUntil: iso(context.database.now() + 1000) });
  assert.deepEqual(context.memory.search('Cedar temporary').map(row => row.id), ['temporary']);
  // Cache hit before expiry: still eligible.
  assert.deepEqual(context.memory.search('Cedar temporary').map(row => row.id), ['temporary']);
  context.advance(5000);
  assert.deepEqual(context.memory.search('Cedar temporary'), [], 'time-based expiry applies to cached results');
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM hot_context_items WHERE origin_kind='memory' AND origin_id='temporary'").get().n, 1);
});

test('established supersedes relations remove the target from retrieval', async t => {
  const context = open(t);
  context.memory.put({ id: 'old', content: 'Cedar deadline is Friday.' });
  context.memory.put({ id: 'new', content: 'Cedar deadline moved to Monday.' });
  context.database.atomic(() => context.database.db.prepare(
    'INSERT INTO memory_relations(id,source_memory_id,target_memory_id,relation_kind,status,evidence_kind,evidence_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run('rel', 'new', 'old', 'supersedes', 'suggested', 'user_instruction', 'new', iso(context.database.now()), iso(context.database.now())));
  assert.ok(context.memory.search('Cedar Friday').some(row => row.id === 'old'), 'suggested relations do not hide a memory');
  context.database.atomic(() => context.database.db.prepare("UPDATE memory_relations SET status='established' WHERE id='rel'").run());
  // The cached result from before the relation changed is filtered on read.
  assert.deepEqual(context.memory.search('Cedar Friday').map(row => row.id).filter(id => id === 'old'), []);
  assert.deepEqual(context.memory.search('Cedar Monday').map(row => row.id), ['new']);
});

test('memory_relations enforces canonical endpoints and never cascades deletes', async t => {
  const context = open(t);
  context.memory.put({ id: 'a', content: 'Cedar alpha' });
  context.memory.put({ id: 'b', content: 'Cedar beta' });
  const insert = (id, source, target, kind, status = 'established') => context.database.atomic(() => context.database.db.prepare(
    'INSERT INTO memory_relations(id,source_memory_id,target_memory_id,relation_kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id, source, target, kind, status, iso(context.database.now()), iso(context.database.now())));
  assert.throws(() => insert('reverse', 'b', 'a', 'related_to'), /CHECK/);
  assert.throws(() => insert('self', 'a', 'a', 'related_to'), /CHECK/);
  assert.throws(() => insert('bad-kind', 'a', 'b', 'unknown_relation'), /CHECK/);
  insert('forward', 'a', 'b', 'related_to');
  assert.throws(() => insert('duplicate', 'a', 'b', 'related_to'), /UNIQUE/);
  // Directed relations are not canonicalised, so both orders are valid.
  insert('mentions', 'b', 'a', 'mentions');
  assert.throws(() => context.database.atomic(() => context.database.db.prepare('DELETE FROM user_memories WHERE id=?').run('a')), /FOREIGN KEY/);
});


test('v6 correction links are repaired once without rewriting content or provenance', t => {
  const context = open(t);
  const old = context.memory.put({ id: 'old-correction', content: 'Cedar deadline Friday.', lifecycleState: 'superseded' });
  context.memory.put({ id: 'new-correction', content: 'Cedar deadline Monday.' });
  const at = iso(context.database.now());
  context.database.atomic(() => {
    context.database.db.prepare(`INSERT INTO memory_relations
      (id,source_memory_id,target_memory_id,relation_kind,status,evidence_kind,evidence_ref,created_at,updated_at)
      VALUES(?,?,?,'supersedes','established','direct_correction',?,?,?)`)
      .run('reversed', old.id, 'new-correction', old.id, at, at);
    context.database.db.pragma('user_version=6');
  });
  context.reopen();
  const edge = context.database.db.prepare("SELECT * FROM memory_relations WHERE id='reversed'").get();
  assert.equal(edge.source_memory_id, 'new-correction');
  assert.equal(edge.target_memory_id, old.id);
  assert.equal(edge.evidence_ref, old.id);
  assert.equal(edge.created_at, at);
  const memory = new HybridMemory(context.database);
  assert.deepEqual([...memory.eligible(['old-correction', 'new-correction'])], ['new-correction']);
  const snapshots = context.database.db.prepare('SELECT COUNT(*) n FROM memory_versions').get().n;
  context.reopen();
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM memory_versions').get().n, snapshots);
  assert.equal(context.database.db.prepare("SELECT source_memory_id FROM memory_relations WHERE id='reversed'").get().source_memory_id, 'new-correction');
});


test('Hot Context rechecks expiry and source eligibility even without a projection write', t => {
  const context = open(t);
  const policies = new ActivationPolicies(context.database);
  context.memory.put({ id: 'temporary-hot', content: 'Temporary fact.', validUntil: iso(context.database.now() + 1000) });
  context.memory.put({ id: 'revoked-hot', content: 'A source that will be revoked.' });
  assert.equal(policies.hotContext().items.filter(item => item.kind === 'memory').length, 2);
  context.advance(5000);
  context.database.atomic(() => context.database.db.prepare("UPDATE source_records SET active=0 WHERE id='revoked-hot'").run());
  assert.equal(policies.hotContext().items.filter(item => item.kind === 'memory').length, 0);
});
