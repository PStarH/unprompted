import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { readinessBlock } from './coordination.js';

export const ATTENTION_DEFAULTS = Object.freeze({ maxInteractivePerHour: 3, minIntervalMs: 10 * 60000, digestWindowMs: 5 * 60000, issueCooldownMs: 60 * 60000, quietHours: null });
export class AttentionBudget {
  constructor(database, options = {}) {
    this.database = database; this.db = database.db; this.options = { ...ATTENTION_DEFAULTS, ...parse(database.get('attention_policy', '{}')), ...options };
    if (this.options.maxInteractivePerHour < 0 || this.options.minIntervalMs < 0) throw durableError('INVALID_ATTENTION_POLICY', 'Invalid attention budget.', 400);
  }
  quiet(now) {
    const quiet = this.options.quietHours; if (!quiet) return false;
    // A zero-length window is not a 24-hour window. Policies stored before the
    // validator rejected start === end read as "no quiet window" instead of
    // silencing every notification forever.
    if (quiet.startHour === quiet.endHour) return false;
    const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone: quiet.timeZone || 'UTC' }).format(new Date(now)));
    return quiet.startHour < quiet.endHour ? hour >= quiet.startHour && hour < quiet.endHour : hour >= quiet.startHour || hour < quiet.endHour;
  }
  activeContext({ now = this.database.now() } = {}) {
    const at = iso(now), hourStart = iso(now - 3600000);
    const critical = this.db.prepare("SELECT id,issue_key,notification_json FROM notification_deliveries WHERE class='critical' AND state='delivered' ORDER BY created_at LIMIT 50").all()
      .map(row => ({ notificationId: row.id, issueKey: row.issue_key, taskId: parse(row.notification_json)?.taskId || null }));
    const deadlines = this.db.prepare("SELECT id,situation_id,data_json FROM tasks WHERE status NOT IN ('completed','cancelled') AND json_extract(data_json,'$.request.deadline.iso') IS NOT NULL ORDER BY json_extract(data_json,'$.request.deadline.iso') LIMIT 100").all().flatMap(row => {
      const deadline = parse(row.data_json)?.request?.deadline;
      if (!deadline?.iso || deadline.ambiguous) return [];
      const due = Date.parse(`${deadline.iso}T23:59:59.999Z`);
      return Number.isFinite(due) && due <= now + 7 * 86400000 ? [{ taskId: row.id, situationId: row.situation_id, date: deadline.iso, overdue: due < now }] : [];
    }).sort((left, right) => left.date.localeCompare(right.date)).slice(0, 50);
    const claims = this.db.prepare("SELECT provider,resource_id,claim_state,lease_until FROM resource_claims WHERE claim_state='unresolved' OR claim_state='held' AND lease_until>? ORDER BY provider,resource_id LIMIT 100").all(at);
    const pending = this.db.prepare("SELECT COUNT(*) n FROM notification_deliveries WHERE state IN ('pending','digest')").get().n;
    const used = this.db.prepare("SELECT COUNT(*) n FROM notification_deliveries WHERE class='interactive' AND delivered_at>=?").get(hourStart).n;
    return { critical, deadlines, claims, notifications: { pending, usedThisHour: used, limitPerHour: this.options.maxInteractivePerHour, quietHours: this.quiet(now) },
      calendarAvailability: 'unavailable', focusAffinity: null };
  }
  offer(notification, { class: notificationClass = 'interactive', criticalConfigured = false, issueKey = notification.dedupeKey || notification.id, candidateId = null } = {}) {
    if (!['critical', 'interactive', 'informational', 'digest'].includes(notificationClass)) throw durableError('INVALID_NOTIFICATION', 'Unknown notification class.', 400);
    return this.database.atomic(() => {
      const now = this.database.now(), at = iso(now), key = notification.dedupeKey || notification.id;
      const existing = this.db.prepare('SELECT * FROM notification_deliveries WHERE dedupe_key=?').get(key);
      if (notificationClass === 'critical' && !criticalConfigured) notificationClass = 'interactive';
      if (existing && existing.state !== 'resolved' && (existing.state === 'delivered' || existing.class === notificationClass)) {
        if (existing.notification_json !== json(notification)) this.db.prepare('UPDATE notification_deliveries SET notification_json=?,class=? WHERE id=?').run(json(notification), notificationClass, existing.id);
        return { ...existing, class: notificationClass, notification_json: json(notification), notification };
      }
      if (notificationClass === 'critical' && !criticalConfigured) notificationClass = 'interactive';
      const critical = notificationClass === 'critical';
      const used = this.db.prepare("SELECT COUNT(*) n FROM notification_deliveries WHERE class='interactive' AND delivered_at>=?").get(iso(now - 3600000)).n;
      const last = this.db.prepare("SELECT MAX(delivered_at) at FROM notification_deliveries WHERE class!='critical'").get().at;
      const repeated = this.db.prepare("SELECT 1 FROM notification_deliveries WHERE issue_key=? AND delivered_at>=? AND state!='resolved'").get(issueKey, iso(now - this.options.issueCooldownMs));
      const activeCritical = this.db.prepare("SELECT 1 FROM notification_deliveries WHERE class='critical' AND state='delivered' LIMIT 1").get();
      // Zero means "interactive delivery is off", not "queue forever". Without
      // this branch `used >= 0` is always true and every non-critical
      // notification stays pending, re-offered by releaseDue() forever.
      const interactiveOff = this.options.maxInteractivePerHour === 0;
      // High priority may skip the spacing between interruptions, but never the
      // hourly ceiling, quiet hours, an unresolved critical notification, or a
      // repeated issue. Priority changes pacing, not the budget itself.
      const highPriority = notification.priority === 'high';
      const deferred = !critical && (interactiveOff || activeCritical || this.quiet(now) || used >= this.options.maxInteractivePerHour || !highPriority && last && now - Date.parse(last) < this.options.minIntervalMs || repeated);
      const state = deferred ? interactiveOff || ['informational', 'digest'].includes(notificationClass) ? 'digest' : 'pending' : 'delivered';
      // A digest row is not waiting for a slot, so it gets no wake-up time;
      // releaseDue() only selects rows whose not_before has arrived.
      const notBefore = deferred && !interactiveOff ? iso(Math.max(now + this.options.digestWindowMs, last ? Date.parse(last) + this.options.minIntervalMs : 0)) : null;
      const id = existing?.id || randomUUID();
      this.db.prepare(`INSERT INTO notification_deliveries VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET
        class=excluded.class,state=excluded.state,notification_json=excluded.notification_json,created_at=excluded.created_at,
        delivered_at=excluded.delivered_at,not_before=excluded.not_before`).run(id, key, issueKey, candidateId, notificationClass, state, json(notification), at, state === 'delivered' ? at : null, notBefore);
      if (candidateId && deferred) this.db.prepare("UPDATE working_candidates SET state='NOTIFICATION_PENDING' WHERE id=?").run(candidateId);
      return { ...this.db.prepare('SELECT * FROM notification_deliveries WHERE id=?').get(id), notification };
    });
  }
  digest() {
    const rows = this.db.prepare("SELECT id,issue_key,notification_json,not_before FROM notification_deliveries WHERE state IN ('pending','digest') ORDER BY created_at").all();
    const groups = new Map();
    for (const row of rows) {
      const group = groups.get(row.issue_key) || { issueKey: row.issue_key, ids: [], taskIds: [], headlines: [], notBefore: row.not_before };
      const taskId = parse(row.notification_json).taskId; if (taskId && !group.taskIds.includes(taskId)) group.taskIds.push(taskId);
      group.ids.push(row.id); group.headlines.push(parse(row.notification_json).headline || parse(row.notification_json).what); groups.set(row.issue_key, group);
    }
    return [...groups.values()];
  }
  releaseDue() {
    const rows = this.db.prepare("SELECT * FROM notification_deliveries WHERE state IN ('pending','digest') AND not_before<=? ORDER BY created_at LIMIT 30").all(iso(this.database.now()));
    const priorityRank = { low: 1, normal: 2, high: 3 };
    rows.sort((left, right) => (priorityRank[parse(right.notification_json)?.priority] || 2) - (priorityRank[parse(left.notification_json)?.priority] || 2)
      || String(left.created_at).localeCompare(String(right.created_at)));
    const released = [];
    const revoked = new Set(parse(this.database.get('revoked_connectors', '[]')) || []);
    for (const row of rows) {
      const notification = parse(row.notification_json);
      const taskRow = notification?.taskId ? this.db.prepare('SELECT id,status,data_json FROM tasks WHERE id=?').get(notification.taskId) : null;
      const task = taskRow && { ...parse(taskRow.data_json), id: taskRow.id, status: taskRow.status };
      const connector = task?.sourceConnectorId || task?.connectorId || task?.request?.source?.connectorId;
      const block = readinessBlock(this.db, task) || (task?.privacyInvalidated ? 'privacy_invalidated' : null) || (connector && revoked.has(connector) ? 'permission_revoked' : null);
      if (block) {
        this.database.atomic(() => this.db.prepare("UPDATE notification_deliveries SET state='pending',not_before=? WHERE id=? AND state IN ('pending','digest')").run(iso(this.database.now() + this.options.digestWindowMs), row.id));
        continue;
      }
      this.database.atomic(() => {
        // Reuse budget calculation without losing the pending decision.
        this.db.prepare("UPDATE notification_deliveries SET state='resolved' WHERE id=?").run(row.id);
        const offered = this.offer(parse(row.notification_json), { class: row.class, issueKey: row.issue_key, candidateId: row.candidate_id });
        if (offered.state === 'delivered') released.push(offered);
      });
    }
    return released;
  }
  resolve(key) { this.db.prepare("UPDATE notification_deliveries SET state='resolved' WHERE dedupe_key=?").run(key); }
  describe() { return { policy: this.options, pending: this.db.prepare("SELECT COUNT(*) n FROM notification_deliveries WHERE state IN ('pending','digest')").get().n, digests: this.digest(), activeContext: this.activeContext() }; }
  configure(options) {
    if (Object.keys(options).some(key => !Object.hasOwn(ATTENTION_DEFAULTS, key))) throw durableError('INVALID_ATTENTION_POLICY', 'Unknown attention setting.', 400);
    const next = { ...this.options, ...options };
    if (!Number.isInteger(next.maxInteractivePerHour) || next.maxInteractivePerHour < 0 || next.maxInteractivePerHour > 100
      || ['minIntervalMs', 'digestWindowMs', 'issueCooldownMs'].some(key => !Number.isFinite(next[key]) || next[key] < 0 || next[key] > 86400000)) throw durableError('INVALID_ATTENTION_POLICY', 'Invalid bounded attention settings.', 400);
    if (next.quietHours) {
      const quiet = next.quietHours;
      if (![quiet.startHour, quiet.endHour].every(value => Number.isInteger(value) && value >= 0 && value < 24)) throw durableError('INVALID_ATTENTION_POLICY', 'Quiet hours need clock hours 0–23.', 400);
      try { new Intl.DateTimeFormat('en', { timeZone: quiet.timeZone || 'UTC' }); } catch { throw durableError('INVALID_ATTENTION_POLICY', 'Unknown quiet-hours time zone.', 400); }
    }
    // A zero-length window is not a 24-hour window, so it is never written. But
    // every save from the settings form resends the stored quietHours, so a
    // policy already stored that way must stay resaveable — otherwise one legacy
    // value would lock every attention setting out of the form for good. The
    // read side treats such a window as "no quiet hours" (see quiet()).
    const supplied = Object.hasOwn(options, 'quietHours') ? options.quietHours : null;
    const stored = this.options.quietHours;
    const sameWindow = (left, right) => Boolean(left && right) && left.startHour === right.startHour
      && left.endHour === right.endHour && (left.timeZone || 'UTC') === (right.timeZone || 'UTC');
    const unchangedLegacyWindow = stored && stored.startHour === stored.endHour && sameWindow(stored, supplied);
    if (supplied && supplied.startHour === supplied.endHour && !unchangedLegacyWindow) throw durableError('INVALID_ATTENTION_POLICY', 'Quiet hours need different start and end hours.', 400);
    this.database.atomic(() => {
      this.database.set('attention_policy', json(next));
      for (const key of ['maxInteractivePerHour', 'minIntervalMs']) if (Object.hasOwn(options, key)) {
        const current = parse(this.database.get(`rsi_config:${key}`, 'null')) || { version: 0 };
        this.database.set(`rsi_config:${key}`, json({ version: current.version + 1, proposalId: null }));
      }
    }); this.options = next; return this.describe();
  }
}
