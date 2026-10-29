import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createHmac } from 'node:crypto';

export const SQLITE_RUNTIME = Object.freeze({ package: 'better-sqlite3', packageVersion: '12.11.1', sqliteVersion: '3.53.2', schemaVersion: 5 });
export const durableError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
export const iso = value => new Date(value ?? Date.now()).toISOString();
export const parse = value => value == null ? null : JSON.parse(value);
export const json = value => JSON.stringify(value ?? null);
export const isBusy = error => /^SQLITE_(BUSY|LOCKED)/.test(error?.code || '');
const require = createRequire(import.meta.url);

/** One coordinator per writable connection. Callbacks are synchronous, short
 * database operations; I/O is awaited outside it. Async callers get bounded
 * SQLITE_BUSY retries, each starting only after a complete rollback. */
export class WriteCoordinator {
  constructor(db, { attempts = 6, baseDelayMs = 15, random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.db = db; this.attempts = attempts; this.baseDelayMs = baseDelayMs;
    this.random = random; this.sleep = sleep; this.tail = Promise.resolve(); this.active = false; this.closed = false;
    this.onCommit = () => {};
  }
  sync(callback, { immediate = true } = {}) {
    if (this.closed) throw durableError('STORE_CLOSED', 'The database writer is closed.');
    if (this.active || this.db.inTransaction) throw durableError('STORE_TRANSACTION_ACTIVE', 'A database transaction is already active.');
    this.active = true;
    try {
      this.db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
      const changes = this.db.prepare('SELECT total_changes() n').get().n;
      const result = callback(this.db);
      if (result?.then) { Promise.resolve(result).catch(() => {}); throw new TypeError('Database transactions must not await I/O.'); }
      const changed = this.db.prepare('SELECT total_changes() n').get().n > changes;
      if (changed && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()) this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='state_revision'").run();
      this.db.exec('COMMIT'); this.onCommit(changed); return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally { this.active = false; }
  }
  write(callback, options) {
    const run = this.tail.catch(() => {}).then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { return this.sync(callback, options); }
        catch (error) {
          if (!isBusy(error) || attempt + 1 >= this.attempts) throw error;
          await this.sleep(Math.min(500, this.baseDelayMs * 2 ** attempt) * (0.5 + this.random()));
        }
      }
    });
    this.tail = run; return run;
  }
  async idle() { await this.tail.catch(() => {}); }
}

export class DurableDatabase {
  constructor(filename, { readonly = false, busyTimeoutMs = 5000, now = () => Date.now(), coordinator = {} } = {}) {
    let Database;
    try { Database = require('better-sqlite3'); }
    catch { throw durableError('SQLITE_UNAVAILABLE', 'SQLite is unavailable. Run npm ci, then restart Unprompted.', 503); }
    this.filename = filename === ':memory:' ? filename : path.resolve(filename);
    this.now = now; this.closed = false; this.readonly = readonly;
    this.commitSerial = 0;
    if (this.filename !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      try { if (!fs.lstatSync(this.filename).isFile()) throw durableError('INVALID_DATABASE', 'The database must be a regular file.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.db = new Database(this.filename, { readonly, timeout: busyTimeoutMs });
    try {
      const version = this.db.prepare('SELECT sqlite_version() version').get().version;
      if (version !== SQLITE_RUNTIME.sqliteVersion) throw durableError('SQLITE_VERSION', `Expected the pinned SQLite ${SQLITE_RUNTIME.sqliteVersion}; found ${version}. Reinstall from the lockfile.`, 503);
      this.db.pragma('foreign_keys=ON'); this.db.pragma(`busy_timeout=${Math.max(0, Math.min(5000, Math.trunc(busyTimeoutMs)))}`);
      this.db.pragma('synchronous=FULL'); this.db.pragma('secure_delete=ON');
      if (!readonly) this.db.pragma('journal_mode=WAL');
      const journal = this.db.pragma('journal_mode', { simple: true });
      if (this.filename !== ':memory:' && journal !== 'wal') throw durableError('SQLITE_WAL', 'The workspace database must use WAL mode.', 503);
      if (this.db.pragma('foreign_keys', { simple: true }) !== 1 || this.db.pragma('synchronous', { simple: true }) !== 2 || this.db.pragma('secure_delete', { simple: true }) !== 1) throw durableError('SQLITE_CONFIGURATION', 'SQLite durability settings did not take effect.', 503);
      this.writes = new WriteCoordinator(this.db, coordinator);
      this.writes.onCommit = () => { this.commitSerial++; };
      if (!readonly) this.atomic(() => {
        const schema = Number(this.db.pragma('user_version', { simple: true }));
        if (schema > SQLITE_RUNTIME.schemaVersion) throw durableError('SQLITE_SCHEMA', 'This workspace was created by a newer application.');
        if (schema < SQLITE_RUNTIME.schemaVersion) {
          this.db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
          const columns = new Set(this.db.pragma('table_info(tasks)').map(column => column.name));
          if (!columns.has('situation_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN situation_id TEXT REFERENCES situations(id) ON DELETE SET NULL');
          if (!columns.has('dedup_task_key')) this.db.exec('ALTER TABLE tasks ADD COLUMN dedup_task_key TEXT');
          this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_task_dedup ON tasks(situation_id,dedup_task_key)
            WHERE situation_id IS NOT NULL AND dedup_task_key IS NOT NULL AND status NOT IN ('completed','cancelled')`);
          const artifacts = new Set(this.db.pragma('table_info(artifacts)').map(column => column.name));
          if (!artifacts.has('situation_id')) this.db.exec('ALTER TABLE artifacts ADD COLUMN situation_id TEXT');
          if (!artifacts.has('situation_version')) this.db.exec('ALTER TABLE artifacts ADD COLUMN situation_version INTEGER');
          if (!artifacts.has('stale')) this.db.exec('ALTER TABLE artifacts ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
          this.db.pragma(`user_version=${SQLITE_RUNTIME.schemaVersion}`);
        }
        if (this.db.prepare("SELECT v FROM memory_fts_config WHERE k='secure-delete'").get()?.v !== 1) throw durableError('FTS_CONFIGURATION', 'FTS secure deletion is not enabled.', 503);
        for (const [key, value] of [['state_revision', '0'], ['context_version', '0'], ['privacy_epoch', '0'], ['privacy_salt', randomBytes(32).toString('hex')], ['learning_auto_promote', 'false'], ['promotion_policy_version', '1']]) this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run(key, value);
      });
      if (!readonly && this.filename !== ':memory:') for (const suffix of ['', '-wal', '-shm']) {
        try { fs.chmodSync(this.filename + suffix, 0o600); } catch (error) { if (error.code !== 'ENOENT' && process.platform !== 'win32') throw error; }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  atomic(callback) { return this.db.inTransaction ? callback(this.db) : this.writes.sync(callback); }
  write(callback) { return this.writes.write(callback); }
  get(key, fallback = null) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? fallback; }
  set(key, value) { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  bump(key) { const value = Number(this.get(key, '0')) + 1; this.set(key, value); return value; }
  forgotten(kind, id) { const digest = createHmac('sha256', this.get('privacy_salt')).update(`${kind}\0${id}`).digest('hex'); return Boolean(this.db.prepare('SELECT 1 FROM forgotten_sources WHERE kind=? AND id_digest=?').get(kind, digest)); }
  lineage(sourceKind, sourceId, derivedKind, derivedId) {
    this.db.prepare('INSERT OR IGNORE INTO lineage VALUES(?,?,?,?,?)').run(sourceKind, sourceId, derivedKind, derivedId, iso(this.now()));
  }
  descendants(kind, id) {
    return this.db.prepare(`WITH RECURSIVE dependencies(kind,id) AS (
      VALUES(?,?) UNION SELECT l.derived_kind,l.derived_id FROM lineage l JOIN dependencies d ON l.source_kind=d.kind AND l.source_id=d.id
    ) SELECT kind,id FROM dependencies LIMIT 10001`).all(kind, id);
  }
  describe() { return { ...SQLITE_RUNTIME, journalMode: this.db.pragma('journal_mode', { simple: true }), synchronous: 'FULL', foreignKeys: true, secureDelete: true, ftsSecureDelete: true }; }
  checkpoint() { return this.db.pragma('wal_checkpoint(TRUNCATE)')[0]; }
  close() { if (this.closed) return; if (this.db.inTransaction) throw durableError('STORE_TRANSACTION_ACTIVE', 'Cannot close during a database transaction.'); this.writes.closed = true; this.db.close(); this.closed = true; }
}
