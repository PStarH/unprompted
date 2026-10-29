import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { emptyState, migrate, normaliseTasks, normaliseDeadlines, stateFileLock } from '../store.js';
import { readRegularFile } from '../local-files.js';
import { DurableDatabase, durableError, iso, json, parse } from './database.js';
import { DurableJobs } from './jobs.js';
import { DurableTasks, taskProjection } from './tasks.js';
import { HybridMemory } from './memory.js';
import { AttentionBudget } from './attention.js';
import { effectDigest } from './experience.js';
import { activationFlags } from './flags.js';
import { readinessBlock } from './coordination.js';

const closed = task => ['completed', 'cancelled'].includes(task.status) || task.userDismissed;
const metaKeys = ['stateVersion', 'inputVersion', 'processedInputVersion', 'runGeneration', 'privacyEpoch', 'dirty', 'situationId', 'dedupTaskKey'];
const taskData = task => Object.fromEntries(Object.entries(task).filter(([key]) => !metaKeys.includes(key)));
export const sqliteWorkspacePath = filename => /\.(sqlite|sqlite3|db)$/i.test(filename) ? path.resolve(filename) : path.resolve(filename).replace(/\.json$/i, '') + '.sqlite';

/** The legacy object view is a compatibility projection. Normalized task rows,
 * input versions, jobs, claims and execution intents are in the same database.
 * Snapshot commits and per-task updates both use optimistic versions. */
export class SqliteStore {
  #state;
  #mutating = false;
  constructor(filename, { dateLocale = null, database = null } = {}) {
    this.filename = path.resolve(filename); this.databaseFilename = sqliteWorkspacePath(filename);
    this.closed = false; this.migrated = false; this.dateLocale = dateLocale;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    stateFileLock.acquire(this.filename);
    try {
      this.database = database || new DurableDatabase(this.databaseFilename);
      this.durable = this.database;
      this.db = this.database.db; this.jobs = new DurableJobs(this.database); this.tasks = new DurableTasks(this.database, this.jobs);
      this.memory = new HybridMemory(this.database); this.attention = new AttentionBudget(this.database);
      const saved = this.db.prepare('SELECT * FROM workspace_state WHERE id=1').get();
      if (!saved) {
        let state = emptyState(), imported = null;
        if (this.filename !== this.databaseFilename && fs.existsSync(this.filename)) {
          const source = readRegularFile(this.filename, { maxBytes: 64 * 1024 * 1024, mode: 0o600 });
          state = migrate(JSON.parse(source)); normaliseTasks(state, { dateLocale }); normaliseDeadlines(state, { dateLocale });
          imported = createHash('sha256').update(source).digest('hex');
        }
        this.#state = state;
        this.database.atomic(() => {
          this.db.prepare('INSERT INTO workspace_state VALUES(1,0,?)').run(json(state));
          this.#sync(emptyState(), state, { migration: Boolean(imported) });
          this.db.prepare('UPDATE workspace_state SET state_json=? WHERE id=1').run(json(state));
          if (imported) { this.database.set('legacy_import_sha256', imported); this.database.set('legacy_import_complete', 'true'); }
        });
        this.migrated = Boolean(imported);
      }
      // Backfill only evidence-backed active legacy tasks. A completed task is
      // not evidence that its underlying Situation has been resolved.
      this.database.atomic(() => {
        for (const row of this.db.prepare("SELECT * FROM tasks WHERE situation_id IS NULL AND status NOT IN ('completed','cancelled')").all()) {
          const eventIds = this.db.prepare('SELECT event_id FROM task_events WHERE task_id=? ORDER BY associated_at DESC LIMIT 64').all(row.id).map(event => event.event_id);
          this.tasks.situations.fromLegacyTask(taskProjection(row), eventIds);
        }
      });
      this.refresh();
      // Only after the committed SQLite snapshot passes integrity and semantic
      // comparison is the original JSON retired. It is registered for Forget.
      if (this.filename !== this.databaseFilename && fs.existsSync(this.filename)) {
        if (this.db.pragma('integrity_check', { simple: true }) !== 'ok' || this.database.get('legacy_import_complete') !== 'true') throw durableError('MIGRATION_VERIFY', 'The JSON migration could not be verified. The original file was retained.');
        const original = readRegularFile(this.filename, { maxBytes: 64 * 1024 * 1024, mode: 0o600 });
        if (createHash('sha256').update(original).digest('hex') !== this.database.get('legacy_import_sha256')) throw durableError('MIGRATION_CHANGED', 'The legacy JSON changed after migration. It was retained for review.');
        const backup = `${this.filename}.migration-backup`;
        if (fs.existsSync(backup)) throw durableError('MIGRATION_BACKUP_EXISTS', 'A migration backup already exists. No file was overwritten.');
        fs.renameSync(this.filename, backup); fs.chmodSync(backup, 0o600);
        this.database.atomic(() => this.db.prepare('INSERT INTO retained_files VALUES(?,?,?,?,?,?,?)').run(effectDigest(backup), backup, 'legacy_migration_backup', null, null, 1, iso(this.database.now())));
        this.refresh();
      }
    } catch (error) { this.database?.close(); stateFileLock.release(this.filename); this.closed = true; throw error; }
  }
  get state() {
    if (!this.#mutating && !this.closed && !this.db.inTransaction && (this.loadedSerial !== this.database.commitSerial || this.loadedRevision !== Number(this.database.get('state_revision', '0')))) this.refresh();
    return this.#state;
  }
  set state(value) { this.#state = value; }
  refresh() {
    if (this.#mutating) return this.#state;
    const row = this.db.prepare('SELECT * FROM workspace_state WHERE id=1').get();
    this.snapshotVersion = row.version; this.#state = parse(row.state_json);
    this.#state.tasks = Object.fromEntries(this.db.prepare('SELECT * FROM tasks').all().map(task => [task.id, taskProjection(task)]));
    this.#state.revision = Number(this.database.get('state_revision', '0'));
    this.loadedSerial = this.database.commitSerial; this.loadedRevision = this.#state.revision;
    this.baseline = structuredClone(this.#state); return this.#state;
  }
  #assert() {
    if (this.closed) throw durableError('STORE_CLOSED', 'The state store is closed.');
    if (this.#mutating || this.db.inTransaction) throw durableError('STORE_TRANSACTION_ACTIVE', 'A store mutation transaction is already active.');
  }
  #sync(before, state, { migration = false } = {}) {
    const at = iso(this.database.now());
    const previousEvents = new Set((before.events || []).map(event => event.id));
    const addedEvents = (state.events || []).filter(event => !previousEvents.has(event.id));
    for (const event of addedEvents) {
      this.db.prepare(`INSERT OR IGNORE INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at)
        VALUES(?,?,?,?,?,?)`).run(event.id, event.connectorId || event.source || 'local', event.providerEventId || event.id, json(event), effectDigest([event.type, event.payload]), event.at || at);
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'event\',?,?)').run(event.id, at);
      this.db.prepare("UPDATE durable_inbox SET state='processed',processed_at=COALESCE(processed_at,?) WHERE id=? AND state!='forgotten'").run(at, event.id);
    }
    for (const [id, task] of Object.entries(state.tasks || {})) {
      const row = this.tasks.row(id), previous = before.tasks?.[id];
      const data = taskData(task);
      if (!row) {
        this.db.prepare('INSERT INTO tasks(id,candidate_key,data_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, `legacy:${id}`, json(data), task.status, task.createdAt || at, at);
        this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'task\',?,?)').run(id, at);
        if (!closed(task) && !migration) this.jobs.enqueue({ type: 'task_initial', key: `initial:${id}`, taskId: id, payload: { taskId: id } });
      } else if (json(taskData(previous || {})) !== json(data)) {
        if (parse(row.data_json).privacyInvalidated) throw durableError('RUN_INVALIDATED', 'Forgotten task data cannot be restored by a stale writer.');
        if (previous && previous.stateVersion !== row.version) throw durableError('STORE_CONFLICT', 'A newer task version was committed. Refresh before retrying.');
        const directionChanged = previous && (previous.guidanceRevision || 0) !== (task.guidanceRevision || 0);
        const pauseChanged = previous && Boolean(previous.control?.paused) !== Boolean(task.control?.paused);
        const result = this.db.prepare(`UPDATE tasks SET data_json=?,status=?,version=version+1,input_version=input_version+?,dirty=CASE WHEN ?=1 THEN 1 ELSE dirty END,
          run_generation=run_generation+?,updated_at=? WHERE id=? AND version=?`).run(json(data), task.status, Number(Boolean(directionChanged)), Number(Boolean(directionChanged)), Number(Boolean(pauseChanged)), at, id, row.version);
        if (!result.changes) throw durableError('STORE_CONFLICT', 'The task version changed.');
        if (row.situation_id && task.status !== row.status) this.tasks.situations.bump(row.situation_id);
        if (directionChanged && !closed(task) && !task.control?.paused) {
          const current = this.tasks.row(id);
          this.jobs.enqueue({ type: 'task_continue', key: `continue:${id}:${current.input_version}`, taskId: id, payload: { taskId: id, inputVersion: current.input_version } });
        }
      }
      const knownSources = [task.sourceEmailId, task.request?.source?.id, task.externalSource?.documentId].filter(Boolean);
      // Model-backed discovery can create a task after its Event was already
      // committed. Attach that original Event in the same task transaction.
      const priorSource = !row && task.sourceEmailId && state.events.find(event => event.type === 'email.received' && event.payload?.id === task.sourceEmailId);
      const eventsToAttach = priorSource && !addedEvents.some(event => event.id === priorSource.id) ? [...addedEvents, priorSource] : addedEvents;
      const associated = eventsToAttach.filter(event => event.disposition !== 'stale_change' && (event.relations?.includes(id) || event.situationTaskIds?.includes(id) || knownSources.includes(event.payload?.id)
        || ['document.modified', 'document.unavailable'].includes(event.type) && (task.documentId === event.payload?.id || task.evidence?.documents?.some(document => document.documentId === event.payload?.id))));
      const interpreted = !row && associated.find(event => event.interpretedSituationId && event.relations?.includes(id));
      if (interpreted && !this.tasks.row(id).situation_id) this.tasks.situations.attachTask(interpreted.interpretedSituationId, id, `legacy:${id}`);
      if (!this.tasks.row(id).situation_id && associated.length) this.tasks.situations.fromLegacyTask(task, associated.map(event => event.id));
      for (const event of eventsToAttach) {
        const referenced = event.relations?.includes(id) || event.situationTaskIds?.includes(id) || knownSources.includes(event.payload?.id)
          || ['document.modified', 'document.unavailable'].includes(event.type) && (task.documentId === event.payload?.id || task.evidence?.documents?.some(document => document.documentId === event.payload?.id));
        if (referenced && event.disposition !== 'stale_change') this.tasks.associate(id, event.id, null, { initial: !row || migration, withdrawal: event.disposition === 'request_withdrawn' });
        if (referenced && event.activation) {
          const current = this.tasks.get(id);
          current.activation = event.activation;
          this.tasks.update(id, current.stateVersion, data => { data.activation = event.activation; });
        }
      }
      state.tasks[id] = this.tasks.get(id);
    }
    for (const id of Object.keys(before.tasks || {})) if (!state.tasks[id]) this.db.prepare('DELETE FROM tasks WHERE id=? AND version=?').run(id, before.tasks[id].stateVersion);
    for (const [id, memory] of Object.entries(state.taskMemories || {})) {
      if (this.database.forgotten('task_memory', id) || this.database.forgotten('memory', id)) throw durableError('SOURCE_FORGOTTEN', 'This memory has been forgotten.');
      const source = this.db.prepare('SELECT * FROM source_records WHERE kind=\'task_memory\' AND id=?').get(id);
      if (!source) this.db.prepare('INSERT INTO source_records(kind,id,created_at) VALUES(\'task_memory\',?,?)').run(id, at);
      if (memory.taskId) this.database.lineage('task', memory.taskId, 'task_memory', id);
      if (memory.deletedAt) {
        this.db.prepare("UPDATE source_records SET active=0 WHERE kind='task_memory' AND id=?").run(id);
        this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id); this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?').run(id);
        this.db.prepare('DELETE FROM hot_context_items WHERE origin_kind=\'memory\' AND origin_id=?').run(id);
        if (!before.taskMemories?.[id]?.deletedAt) { this.database.bump('context_version'); this.memory.invalidate(); }
      } else {
        this.db.prepare("UPDATE source_records SET active=1 WHERE kind='task_memory' AND id=?").run(id);
        this.memory.put({ id, content: memory.text, scopeType: 'project', scopeKey: json([memory.scope?.entity?.toLowerCase(), memory.scope?.deliverable?.toLowerCase()]), sourceKind: 'task_memory', sourceId: id });
        for (const task of Object.values(state.tasks)) if (task.guidance?.memoryId === id || !task.guidance && task.request?.subjectEntity?.toLowerCase() === memory.scope?.entity?.toLowerCase() && task.request?.deliverable?.toLowerCase() === memory.scope?.deliverable?.toLowerCase()) this.database.lineage('task_memory', id, 'task', task.id);
      }
    }
    for (const [id, direction] of Object.entries(state.taskDirections || {})) {
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'task_direction\',?,?)').run(id, at);
      if (direction.taskId) this.database.lineage('task', direction.taskId, 'task_direction', id);
      if (direction.memoryId) this.database.lineage('task_direction', id, 'task_memory', direction.memoryId);
      for (const task of Object.values(state.tasks)) if (task.guidance?.id === id) this.database.lineage('task_direction', id, 'task', task.id);
    }
    for (const notice of state.notifications || []) {
      const key = notice.dedupeKey || notice.id;
      if (notice.resolvedAt) this.attention.resolve(key);
      else {
        const task = notice.taskId ? state.tasks[notice.taskId] : null;
        const situationId = task?.situationId || (notice.taskId ? this.db.prepare('SELECT situation_id FROM tasks WHERE id=?').get(notice.taskId)?.situation_id : null);
        if (task && situationId && task.status === 'ready_for_approval' && task.draft?.body && activationFlags(this.database).stagedReadiness) {
          const version = this.db.prepare('SELECT version FROM situations WHERE id=?').get(situationId)?.version;
          const digest = effectDigest(task.draft.body);
          if (version && !this.db.prepare('SELECT 1 FROM artifacts WHERE task_id=? AND situation_id=? AND situation_version=? AND latest_digest=? AND stale=0').get(task.id, situationId, version, digest)) {
            const at = iso(this.database.now()), id = randomUUID();
            this.db.prepare(`INSERT INTO artifacts(id,task_id,task_run_id,plan_step_id,generated_version,visible_version,status,generated_digest,latest_digest,situation_id,situation_version,stale,created_at,updated_at)
              VALUES(?,?,NULL,NULL,1,1,'generated',?,?,?,?,0,?,?)`).run(id, task.id, digest, digest, situationId, version, at, at);
          }
        }
        let block = activationFlags(this.database).stagedReadiness ? readinessBlock(this.db, task) : null;
        if (!block && situationId && task?.status === 'ready_for_approval' && activationFlags(this.database).stagedReadiness) {
          const version = this.db.prepare('SELECT version FROM situations WHERE id=?').get(situationId)?.version;
          if (!version || !this.db.prepare('SELECT 1 FROM artifacts WHERE situation_id=? AND situation_version=? AND stale=0').get(situationId, version)) block = 'not_synthesized';
        }
        if (!block && task?.situationId && activationFlags(this.database).stagedReadiness) {
          const closure = parse(this.db.prepare('SELECT closure_condition_json FROM situations WHERE id=?').get(task.situationId)?.closure_condition_json);
          const missing = Array.isArray(closure?.missingEvidence) ? closure.missingEvidence : [];
          const fresh = this.db.prepare('SELECT 1 FROM artifacts WHERE situation_id=? AND stale=0 AND situation_version IS NOT NULL LIMIT 1').get(task.situationId);
          const stale = this.db.prepare('SELECT 1 FROM artifacts WHERE situation_id=? AND stale=1 LIMIT 1').get(task.situationId);
          if (missing.length) block = 'missing_evidence';
          else if (stale && !fresh) block = 'artifact_stale';
        }
        if (block) {
          notice.deliveryState = 'pending'; notice.deliveryBlocked = block; notice.deliveryClass = notice.deliveryClass || 'interactive';
          continue;
        }
        const activation = task?.activation;
        const delivery = this.attention.offer(notice, { class: activation?.notificationClass || notice.deliveryClass || 'interactive', criticalConfigured: activation?.notificationClass === 'critical', issueKey: notice.opportunityId || notice.clarificationId || key });
        notice.deliveryState = delivery.state; notice.deliveryClass = delivery.class; notice.notBefore = delivery.not_before;
      }
    }
  }
  mutate(callback) { return this.#transaction(callback, false).result; }
  mutateIfChanged(callback) { return this.#transaction(callback, true); }
  #transaction(callback, onlyIfChanged) {
    this.#assert(); const state = this.state, before = structuredClone(state), snapshotVersion = this.snapshotVersion;
    this.#mutating = true;
    try {
      let result, changed = true;
      this.database.atomic(() => {
        const current = this.db.prepare('SELECT version FROM workspace_state WHERE id=1').get();
        if (current.version !== snapshotVersion) throw durableError('STORE_CONFLICT', 'The workspace snapshot changed. Refresh before retrying.');
        result = callback(state);
        if (result?.then) { Promise.resolve(result).catch(() => {}); throw new TypeError('Store mutation callbacks must be synchronous.'); }
        if (onlyIfChanged && json(state) === json(before)) { changed = false; return; }
        this.#sync(before, state);
        const commit = this.db.prepare('UPDATE workspace_state SET version=version+1,state_json=? WHERE id=1 AND version=?').run(json(state), snapshotVersion);
        if (!commit.changes) throw durableError('STORE_CONFLICT', 'The workspace snapshot changed.');
      });
      this.#mutating = false;
      if (changed) this.refresh(); return { result, changed };
    } catch (error) { this.#state = before; throw error; }
    finally { this.#mutating = false; }
  }
  save() {
    this.#assert(); const current = structuredClone(this.#state); this.#state = structuredClone(this.baseline);
    this.mutate(state => { Object.assign(state, current); });
  }
  close() { if (this.closed) return; this.#assert(); this.database.close(); stateFileLock.release(this.filename); this.closed = true; }
}
