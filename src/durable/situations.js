import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { entityKeys } from './candidates.js';

const OPEN_STATES = new Set(['OBSERVING', 'OPEN']);
const project = row => row && ({ ...row, closureCondition: parse(row.closure_condition_json), closureEvidence: parse(row.closure_evidence_json),
  scope: parse(row.scope_json), sourceWatermark: parse(row.source_watermark_json) });

/** Situations describe matters, independently of their executable tasks. */
export class Situations {
  constructor(database) { this.database = database; this.db = database.db; }
  get(id) { return project(this.db.prepare('SELECT * FROM situations WHERE id=?').get(id)); }
  bump(id) {
    const at = iso(this.database.now());
    this.db.prepare('UPDATE situations SET version=version+1,updated_at=? WHERE id=?').run(at, id);
    this.db.prepare(`UPDATE artifacts SET stale=1,updated_at=? WHERE situation_id=? AND stale=0 AND situation_version IS NOT NULL
      AND situation_version < (SELECT version FROM situations WHERE id=?)`).run(at, id, id);
  }
  expireDue() {
    return this.database.atomic(() => {
      const at = iso(this.database.now());
      return this.db.prepare(`UPDATE situations SET lifecycle_state='EXPIRED',closure_status='CONFIRMED',updated_at=?,version=version+1
        WHERE lifecycle_state IN ('OPEN','OBSERVING') AND expires_at IS NOT NULL AND expires_at<=?`).run(at, at).changes;
    });
  }
  listActive({ limit = 200 } = {}) {
    return this.db.prepare("SELECT * FROM situations WHERE lifecycle_state IN ('OBSERVING','OPEN') ORDER BY updated_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(1000, Math.trunc(limit) || 200))).map(project);
  }
  create({ id = randomUUID(), kind, summary, lifecycleState = 'OBSERVING', closureCondition = { kind: 'UNSPECIFIED' }, scope = {}, sourceEventIds, associationMethod = 'task_source', standingIntentId = null, expiresAt = null }) {
    if (typeof kind !== 'string' || !kind || kind.length > 100 || typeof summary !== 'string' || !summary.trim() || summary.length > 1000
      || !OPEN_STATES.has(lifecycleState) || !closureCondition || typeof closureCondition !== 'object' || Array.isArray(closureCondition)
      || !scope || typeof scope !== 'object' || Array.isArray(scope) || !Array.isArray(sourceEventIds) || !sourceEventIds.length || sourceEventIds.length > 64
      || json(closureCondition).length > 8000 || json(scope).length > 8000
      || expiresAt != null && !Number.isFinite(Date.parse(expiresAt))) throw durableError('INVALID_SITUATION', 'A Situation needs a bounded purpose and existing source evidence.', 400);
    return this.database.atomic(() => {
      const at = iso(this.database.now());
      if (standingIntentId && !this.db.prepare("SELECT 1 FROM standing_intents WHERE id=? AND status='active' AND confirmation='user_confirmed'").get(standingIntentId)) throw durableError('MISSING_STANDING_INTENT', 'An active confirmed StandingIntent is required.');
      for (const eventId of sourceEventIds) if (!this.db.prepare("SELECT 1 FROM durable_inbox e JOIN source_records s ON s.kind='event' AND s.id=e.id AND s.active=1 WHERE e.id=? AND e.state!='forgotten'").get(eventId)) throw durableError('SOURCE_FORGOTTEN', 'A Situation source is unavailable.');
      this.db.prepare(`INSERT INTO situations(id,kind,lifecycle_state,summary,closure_condition_json,created_at,updated_at,scope_json,standing_intent_id,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, kind, lifecycleState, summary.trim(), json(closureCondition), at, at, json(scope), standingIntentId, expiresAt ? iso(Date.parse(expiresAt)) : null);
      this.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('situation',?,?)").run(id, at);
      for (const eventId of [...new Set(sourceEventIds)]) this.linkEvent(id, eventId, associationMethod);
      return this.get(id);
    });
  }
  linkEvent(situationId, eventId, method = 'task_source') {
    if (!['task_source', 'structural', 'semantic', 'user', 'standing_intent'].includes(method)) throw durableError('INVALID_ASSOCIATION', 'Unknown Situation association method.', 400);
    return this.database.atomic(() => {
      const situation = this.get(situationId);
      if (!situation || !this.db.prepare("SELECT 1 FROM durable_inbox e JOIN source_records s ON s.kind='event' AND s.id=e.id AND s.active=1 WHERE e.id=? AND e.state!='forgotten'").get(eventId)) throw durableError('SOURCE_FORGOTTEN', 'Situation evidence is unavailable.');
      const at = iso(this.database.now());
      const inserted = this.db.prepare('INSERT OR IGNORE INTO event_situation_links VALUES(?,?,?,?)').run(eventId, situationId, method, at).changes;
      if (inserted) {
        this.db.prepare('UPDATE situations SET last_evidence_at=?,updated_at=?,version=version+1 WHERE id=?').run(at, at, situationId);
        this.database.lineage('event', eventId, 'situation', situationId);
        const stored = parse(this.db.prepare('SELECT event_json FROM durable_inbox WHERE id=?').get(eventId)?.event_json);
        for (const entity of entityKeys(stored || {})) this.db.prepare('INSERT OR IGNORE INTO situation_entities VALUES(?,?,?,?)').run(situationId, entity.key, entity.role, eventId);
        this.db.prepare(`UPDATE artifacts SET stale=1,updated_at=? WHERE situation_id=? AND stale=0 AND situation_version IS NOT NULL`).run(at, situationId);
      }
      return Boolean(inserted);
    });
  }
  attachTask(situationId, taskId, dedupTaskKey) {
    if (typeof dedupTaskKey !== 'string' || !dedupTaskKey || dedupTaskKey.length > 500) throw durableError('INVALID_TASK_KEY', 'A bounded logical task key is required.', 400);
    return this.database.atomic(() => {
      const situation = this.get(situationId), task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (!situation || !OPEN_STATES.has(situation.lifecycle_state) || !task) throw durableError('MISSING_SITUATION', 'An active Situation and existing task are required.');
      if (task.situation_id && task.situation_id !== situationId) throw durableError('TASK_ALREADY_ATTACHED', 'The task already belongs to another Situation.');
      const conflict = this.db.prepare("SELECT id FROM tasks WHERE situation_id=? AND dedup_task_key=? AND status NOT IN ('completed','cancelled') AND id!=?").get(situationId, dedupTaskKey, taskId);
      if (conflict) throw durableError('TASK_DUPLICATE', 'Identical active work already exists for this Situation.');
      this.db.prepare('UPDATE tasks SET situation_id=?,dedup_task_key=? WHERE id=?').run(situationId, dedupTaskKey, taskId);
      if (task.situation_id !== situationId || task.dedup_task_key !== dedupTaskKey) this.bump(situationId);
      for (const event of this.db.prepare('SELECT event_id FROM task_events WHERE task_id=?').all(taskId)) this.linkEvent(situationId, event.event_id);
      return this.get(situationId);
    });
  }
  fromLegacyTask(task, eventIds) {
    if (!task?.request || task.privacyInvalidated || ['completed', 'cancelled'].includes(task.status) || !eventIds.length) return null;
    const existing = this.db.prepare('SELECT situation_id FROM tasks WHERE id=?').get(task.id)?.situation_id;
    if (existing) return this.get(existing);
    return this.database.atomic(() => {
      const kind = typeof task.kind === 'string' && task.kind.trim() ? task.kind.trim().slice(0, 100) : 'work_request';
      const summary = String(task.subject || task.request.subjectEntity || '').trim().slice(0, 1000) || 'Work request';
      const situation = this.create({ kind, summary,
        lifecycleState: 'OPEN', scope: {}, sourceEventIds: eventIds.slice(0, 64) });
      this.attachTask(situation.id, task.id, `legacy:${task.id}`);
      return situation;
    });
  }
  withdrawSoleTask(situationId, eventId) {
    return this.database.atomic(() => {
      const situation = this.get(situationId);
      if (!situation || !OPEN_STATES.has(situation.lifecycle_state)) return false;
      const count = this.db.prepare('SELECT COUNT(*) n FROM tasks WHERE situation_id=?').get(situationId).n;
      if (count !== 1 || !this.db.prepare('SELECT 1 FROM event_situation_links WHERE situation_id=? AND event_id=?').get(situationId, eventId)) return false;
      const at = iso(this.database.now());
      this.db.prepare("UPDATE situations SET lifecycle_state='CANCELLED',closure_status='CONFIRMED',closure_evidence_json=?,updated_at=?,version=version+1 WHERE id=?").run(json([{ kind: 'event', id: eventId }]), at, situationId);
      return true;
    });
  }
}
