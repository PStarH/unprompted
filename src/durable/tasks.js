import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { effectDigest } from './experience.js';
import { Situations } from './situations.js';

export const taskProjection = row => {
  if (!row) return row;
  const { situationId: _situationId, dedupTaskKey: _dedupTaskKey, ...data } = parse(row.data_json);
  return { ...data, id: row.id, status: row.status, stateVersion: row.version,
    inputVersion: row.input_version, processedInputVersion: row.processed_input_version, runGeneration: row.run_generation, privacyEpoch: row.privacy_epoch, dirty: row.dirty === 1,
    ...(row.situation_id ? { situationId: row.situation_id, dedupTaskKey: row.dedup_task_key } : {}) };
};

export class DurableTasks {
  constructor(database, jobs) { this.database = database; this.db = database.db; this.jobs = jobs; this.situations = new Situations(database); }
  row(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  get(id) { return taskProjection(this.row(id)); }
  hasPendingSemantic(taskId, excludeEventId = null) { return Boolean(this.db.prepare("SELECT 1 FROM task_signals WHERE task_id=? AND signal_type='SEMANTIC_UPDATE_PENDING' AND status='PENDING' AND (? IS NULL OR source_event_id<>?) LIMIT 1").get(taskId, excludeEventId, excludeEventId)); }
  holdForSemantic(situationId, eventId) {
    return this.database.atomic(() => {
      const tasks = this.db.prepare("SELECT * FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId);
      for (const task of tasks) {
        const next = task.input_version + 1, at = iso(this.database.now());
        const added = this.db.prepare("INSERT OR IGNORE INTO task_signals(id,task_id,signal_type,source_event_id,input_version,created_at) VALUES(?,?,'SEMANTIC_UPDATE_PENDING',?,?,?)").run(randomUUID(), task.id, eventId, next, at).changes;
        if (added) {
          this.db.prepare('UPDATE tasks SET input_version=?,dirty=1,version=version+1,updated_at=? WHERE id=? AND version=?').run(next, at, task.id, task.version);
          this.database.lineage('event', eventId, 'task', task.id);
        }
      }
      return tasks.map(task => task.id);
    });
  }
  applyControl(taskId, signalType, idempotencyKey, mutate) {
    if (!['CANCELLATION', 'SUPERSESSION', 'YIELD', 'PERMISSION_REVOKED'].includes(signalType)) throw durableError('INVALID_SIGNAL', 'Unknown control signal.', 400);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200 || typeof mutate !== 'function') throw durableError('INVALID_SIGNAL', 'A control signal needs a stable idempotency key.', 400);
    return this.database.atomic(() => {
      const row = this.row(taskId);
      if (!row) return false;
      const at = iso(this.database.now()), next = row.input_version + 1;
      const added = this.db.prepare("INSERT OR IGNORE INTO task_signals(id,task_id,signal_type,source_event_id,input_version,created_at) VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), taskId, signalType, idempotencyKey, next, at).changes;
      if (!added) return false;
      const data = taskProjection(row);
      mutate(data);
      if (data?.then) throw new TypeError('Control signals must not await I/O.');
      this.db.prepare('UPDATE tasks SET data_json=?,status=?,input_version=?,dirty=1,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(json(data), data.status || row.status, next, at, taskId, row.version);
      if (row.situation_id && data.status !== row.status) this.situations.bump(row.situation_id);
      return true;
    });
  }
  releaseSemantic(eventId) {
    return this.database.atomic(() => {
      const tasks = this.db.prepare("SELECT task_id FROM task_signals WHERE source_event_id=? AND signal_type='SEMANTIC_UPDATE_PENDING' AND status='PENDING'").all(eventId).map(row => row.task_id);
      this.db.prepare("UPDATE task_signals SET status='CONSUMED',consumed_at=? WHERE source_event_id=? AND signal_type='SEMANTIC_UPDATE_PENDING' AND status='PENDING'").run(iso(this.database.now()), eventId);
      return tasks;
    });
  }
  createOrLoad({ id = randomUUID(), candidateKey, data = {}, eventId = null, material = null, situationId = null, dedupTaskKey = null }) {
    if (!candidateKey) throw durableError('INVALID_CANDIDATE', 'Task creation requires a stable candidate identity.', 400);
    if (situationId && (typeof dedupTaskKey !== 'string' || !dedupTaskKey || dedupTaskKey.length > 500) || !situationId && dedupTaskKey) throw durableError('INVALID_TASK_KEY', 'A Situation task requires a logical task key.', 400);
    if (situationId && ['completed', 'cancelled'].includes(data.status)) throw durableError('INVALID_TASK', 'New Situation work must be active.', 400);
    return this.database.atomic(() => {
      const at = iso(this.database.now());
      if (situationId && !['OPEN', 'OBSERVING'].includes(this.situations.get(situationId)?.lifecycle_state)) throw durableError('MISSING_SITUATION', 'An active Situation is required.');
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO tasks(id,candidate_key,data_json,status,created_at,updated_at,situation_id,dedup_task_key) VALUES(?,?,?,?,?,?,?,?)`)
        .run(id, situationId ? null : candidateKey, json({ ...data, id }), data.status || 'newly_discovered', at, at, situationId, dedupTaskKey).changes;
      const row = situationId ? this.db.prepare("SELECT * FROM tasks WHERE situation_id=? AND dedup_task_key=? AND status NOT IN ('completed','cancelled')").get(situationId, dedupTaskKey)
        : this.db.prepare('SELECT * FROM tasks WHERE candidate_key=?').get(candidateKey);
      if (!row) throw durableError('TASK_ID_CONFLICT', 'The task ID already belongs to another candidate.');
      if (situationId && (row.situation_id !== situationId || row.dedup_task_key !== dedupTaskKey)) throw durableError('TASK_ID_CONFLICT', 'The candidate belongs to different work.');
      if (inserted) {
        this.jobs.enqueue({ type: 'task_initial', key: `initial:${row.id}`, taskId: row.id, payload: { taskId: row.id } });
        this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'task\',?,?)').run(row.id, at);
      }
      if (eventId) this.associate(row.id, eventId, material, { initial: Boolean(inserted) });
      return { taskId: row.id, createdNew: Boolean(inserted), inputVersion: this.row(row.id).input_version };
    });
  }
  associate(taskId, eventId, material = null, { initial = false, withdrawal = false } = {}) {
    return this.database.atomic(() => {
      const task = this.row(taskId), event = this.db.prepare('SELECT * FROM durable_inbox WHERE id=?').get(eventId);
      if (!task || !event) throw durableError('MISSING_ASSOCIATION', 'Task association requires an existing task and durable event.', 400);
      const signature = material ? effectDigest(material) : event.material_signature;
      const added = this.db.prepare('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?)').run(taskId, eventId, signature, iso(this.database.now())).changes;
      this.database.lineage('event', eventId, 'task', taskId);
      if (task.situation_id) {
        this.situations.linkEvent(task.situation_id, eventId);
        if (withdrawal) this.situations.withdrawSoleTask(task.situation_id, eventId);
      }
      if (!added) return { taskId, added: false, material: false, inputVersion: task.input_version };
      const nextVersion = task.input_version + 1;
      this.db.prepare('UPDATE tasks SET input_version=?,dirty=1,version=version+1,updated_at=? WHERE id=? AND version=?').run(nextVersion, iso(this.database.now()), taskId, task.version);
      if (!initial) this.db.prepare("INSERT OR IGNORE INTO task_signals(id,task_id,signal_type,source_event_id,input_version,created_at) VALUES(?,?,'EVIDENCE_CHANGED',?,?,?)")
        .run(randomUUID(), taskId, eventId, nextVersion, iso(this.database.now()));
      const active = this.db.prepare("SELECT 1 FROM task_runs WHERE task_id=? AND status='running'").get(taskId);
      const data = parse(task.data_json);
      if (!initial && !active && !data.control?.paused && !['completed', 'cancelled'].includes(task.status)) this.jobs.enqueue({ type: 'task_continue', key: `continue:${taskId}:${nextVersion}`, taskId, payload: { taskId, inputVersion: nextVersion } });
      return { taskId, added: true, material: true, inputVersion: nextVersion };
    });
  }
  update(id, expectedVersion, callback, { job = null, run = null } = {}) {
    return this.database.atomic(() => {
      const row = this.row(id); if (!row || row.version !== expectedVersion) throw durableError('TASK_CHANGED', 'The task state version changed.');
      if (job) this.jobs.assert(job); if (run) this.assertRun(run, { job });
      const data = taskProjection(row), result = callback(data);
      if (result?.then) throw new TypeError('Task transitions must not await I/O.');
      const changed = this.db.prepare('UPDATE tasks SET data_json=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(json(data), data.status, iso(this.database.now()), id, expectedVersion).changes;
      if (!changed) throw durableError('TASK_CHANGED', 'The task state version changed.');
      if (row.situation_id && data.status !== row.status) this.situations.bump(row.situation_id);
      return this.get(id);
    });
  }
  beginRun(job, { advanceGeneration = true } = {}) {
    return this.database.atomic(() => {
      this.jobs.assert(job);
      const row = this.row(job.task_id || job.payload.taskId), data = row && parse(row.data_json);
      if (!row || data.control?.paused || ['completed', 'cancelled'].includes(row.status)) throw durableError('TASK_INACTIVE', 'The task is paused or closed.');
      if (advanceGeneration) this.db.prepare('UPDATE tasks SET run_generation=run_generation+1,version=version+1,updated_at=? WHERE id=? AND version=?').run(iso(this.database.now()), row.id, row.version);
      const current = this.row(row.id), at = iso(this.database.now()), id = randomUUID();
      this.db.prepare(`INSERT INTO task_runs(id,task_id,job_id,job_lease_token,input_version,run_generation,privacy_epoch,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'running',?,?)`).run(id, row.id, job.id, job.lease_token, current.input_version, current.run_generation, current.privacy_epoch, at, at);
      this.database.lineage('task', row.id, 'task_run', id); this.database.lineage('task_run', id, 'job', job.id);
      return this.db.prepare('SELECT * FROM task_runs WHERE id=?').get(id);
    });
  }
  assertRun(run, { job = null, allowDirty = false } = {}) {
    if (job) this.jobs.assert(job);
    const task = this.row(run.task_id), current = this.db.prepare('SELECT * FROM task_runs WHERE id=?').get(run.id);
    if (!task || !current || current.status !== 'running' || task.run_generation !== run.run_generation || task.privacy_epoch !== run.privacy_epoch
      || parse(task.data_json).control?.paused || task.status === 'cancelled') throw durableError('RUN_INVALIDATED', 'The task run or privacy generation is no longer current.');
    if (!allowDirty && task.input_version !== run.input_version) throw durableError('TASK_DIRTY', 'New task context must be incorporated at a safe checkpoint.');
    return taskProjection(task);
  }
  checkpoint(run, job, { expectedInputVersion, plan, contextVersion = Number(this.database.get('context_version')), sources = [] }) {
    if (json(plan).length > 256000 || sources.length > 64) throw durableError('CHECKPOINT_LIMIT', 'The checkpoint exceeds its bounded task context.', 400);
    return this.database.atomic(() => {
      const task = this.assertRun(run, { job, allowDirty: true }), row = this.row(run.task_id);
      if (task.inputVersion !== expectedInputVersion || contextVersion !== Number(this.database.get('context_version'))) throw durableError('CONTEXT_CHANGED', 'The checkpoint was planned against stale context.');
      for (const source of sources) if (!this.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=? AND active=1').get(source.kind, source.id)) throw durableError('SOURCE_FORGOTTEN', 'A checkpoint source is unavailable.');
      const checkpoint = { plan, inputVersion: expectedInputVersion, runGeneration: run.run_generation, privacyEpoch: run.privacy_epoch, contextVersion, sources };
      this.db.prepare('UPDATE task_runs SET input_version=?,checkpoint_json=?,updated_at=? WHERE id=? AND status=\'running\' AND run_generation=? AND privacy_epoch=?')
        .run(expectedInputVersion, json(checkpoint), iso(this.database.now()), run.id, run.run_generation, run.privacy_epoch);
      this.db.prepare('UPDATE tasks SET processed_input_version=?,dirty=0,version=version+1,updated_at=? WHERE id=? AND version=?').run(expectedInputVersion, iso(this.database.now()), task.id, row.version);
      for (const source of sources) this.database.lineage(source.kind, source.id, 'task_run', run.id);
      run.input_version = expectedInputVersion;
      return checkpoint;
    });
  }
  acknowledgeEvidence(run, job) {
    return this.database.atomic(() => {
      const checkpoint = this.preResume(run, job);
      let consumed = 0;
      for (const source of checkpoint.sources.filter(source => source.kind === 'event')) consumed += this.db.prepare("UPDATE task_signals SET status='CONSUMED',consumed_at=? WHERE task_id=? AND signal_type='EVIDENCE_CHANGED' AND status='PENDING' AND source_event_id=? AND input_version<=?")
        .run(iso(this.database.now()), run.task_id, source.id, checkpoint.inputVersion).changes;
      consumed += this.db.prepare("UPDATE task_signals SET status='CONSUMED',consumed_at=? WHERE task_id=? AND signal_type IN ('SYSTEM_REVOKE_SIGNAL','CANCELLATION','SUPERSESSION','YIELD','PERMISSION_REVOKED') AND status='PENDING' AND input_version IS NOT NULL AND input_version<=?")
        .run(iso(this.database.now()), run.task_id, checkpoint.inputVersion).changes;
      return consumed;
    });
  }
  preResume(run, job) {
    const task = this.assertRun(run, { job }), current = this.db.prepare('SELECT checkpoint_json FROM task_runs WHERE id=?').get(run.id), checkpoint = parse(current.checkpoint_json);
    if (!checkpoint || checkpoint.privacyEpoch !== task.privacyEpoch || checkpoint.runGeneration !== task.runGeneration || checkpoint.inputVersion !== task.inputVersion
      || checkpoint.contextVersion !== Number(this.database.get('context_version'))) throw durableError('CHECKPOINT_INVALID', 'The saved checkpoint must be rebuilt before resume.');
    for (const source of checkpoint.sources) if (!this.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=? AND active=1').get(source.kind, source.id)) throw durableError('CHECKPOINT_FORGOTTEN', 'The checkpoint depends on forgotten data.');
    return checkpoint;
  }
  finish(run, job, status = 'completed') {
    return this.database.atomic(() => {
      this.assertRun(run, { job, allowDirty: true });
      this.db.prepare('UPDATE task_runs SET status=?,updated_at=? WHERE id=? AND status=\'running\' AND job_lease_token=?').run(status, iso(this.database.now()), run.id, job.lease_token);
      const task = this.row(run.task_id);
      if (task.dirty && !['cancelled', 'completed'].includes(task.status) && !parse(task.data_json).control?.paused) this.jobs.enqueue({ type: 'task_continue', key: `continue:${task.id}:${task.input_version}`, taskId: task.id, payload: { taskId: task.id, inputVersion: task.input_version } });
    });
  }
}
