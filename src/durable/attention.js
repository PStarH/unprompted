import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { readinessBlock } from './coordination.js';

export const ATTENTION_DEFAULTS = Object.freeze({ maxInteractivePerHour: 3, minIntervalMs: 10 * 60000, digestWindowMs: 5 * 60000, issueCooldownMs: 60 * 60000, quietHours: null });
const PRIORITY_RANK = Object.freeze({ low: 1, normal: 2, high: 3 });
const RELEASE_BATCH = 30;
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
  #revoked() { return new Set(parse(this.database.get('revoked_connectors', '[]')) || []); }
  #priorityRank(notification) { return PRIORITY_RANK[notification?.priority] || 2; }
  /**
   * Effective selection rank, not the stored user priority. Waiting one full
   * hour raises one level (low -> normal -> high); the cap equals high, so a
   * two-hour-old low competes with a fresh high and wins the tie on queuedAt.
   * The stored notification payload is never rewritten.
   */
  #effectiveRank(notification, createdAt, now) {
    const queued = Date.parse(createdAt);
    // Whole seconds match SQLite's unixepoch() ranking exactly, so admission
    // and release cannot disagree about an hour boundary.
    const age = Number.isFinite(queued) ? Math.max(0, Math.floor(now / 1000) - Math.floor(queued / 1000)) : 0;
    return Math.min(3, this.#priorityRank(notification) + Math.floor(age / 3600));
  }
  /** One eligibility rule for both admission and release, so a new offer and a
   * queued release cannot disagree about whether an old row can use a slot. */
  #blockedReason(notification, revoked) {
    const taskRow = notification?.taskId ? this.db.prepare('SELECT id,status,data_json FROM tasks WHERE id=?').get(notification.taskId) : null;
    const task = taskRow && { ...parse(taskRow.data_json), id: taskRow.id, status: taskRow.status };
    const connector = task?.sourceConnectorId || task?.connectorId || task?.request?.source?.connectorId;
    return readinessBlock(this.db, task) || (task?.privacyInvalidated ? 'privacy_invalidated' : null) || (connector && revoked.has(connector) ? 'permission_revoked' : null);
  }
  /**
   * A bounded page of due pending rows in effective-priority order. The rank is
   * computed in SQL from the persisted created_at and priority so the ordering
   * is identical across service instances and survives a restart. Only this
   * page (at most 30 rows) is materialised in JavaScript.
   */
  #duePage(now, { interactiveOnly = false, cursor = null, excludeId = null } = {}) {
    const filters = ["d.state IN ('pending','digest')", 'd.not_before<=?'];
    const parameters = [iso(now), iso(now)];
    if (interactiveOnly) filters.push("d.class='interactive'");
    if (excludeId) { filters.push('d.id<>?'); parameters.push(excludeId); }
    let after = '';
    if (cursor) {
      after = 'WHERE effective_rank<? OR (effective_rank=? AND (created_at>? OR (created_at=? AND id>?)))';
      parameters.push(cursor.rank, cursor.rank, cursor.created_at, cursor.created_at, cursor.id);
    }
    parameters.push(RELEASE_BATCH);
    return this.db.prepare(`WITH due AS (
      SELECT d.*, MIN(3, CASE json_extract(d.notification_json,'$.priority') WHEN 'low' THEN 1 WHEN 'high' THEN 3 ELSE 2 END
        + MAX(0, CAST((unixepoch(?) - unixepoch(d.created_at)) / 3600 AS INTEGER))) AS effective_rank
      FROM notification_deliveries d WHERE ${filters.join(' AND ')}
    ) SELECT * FROM due ${after} ORDER BY effective_rank DESC, created_at ASC, id ASC LIMIT ?`).all(...parameters);
  }
  /** True when an older, currently deliverable queued interaction belongs in
   * the slot this new offer would otherwise take. Blocked, forgotten, revoked
   * and not-yet-due rows are skipped so they cannot park unrelated resources. */
  #hasDeliverableInteractionAhead(rank, now, excludeId) {
    const revoked = this.#revoked();
    let cursor = null;
    for (;;) {
      const rows = this.#duePage(now, { interactiveOnly: true, cursor, excludeId });
      for (const row of rows) {
        if (Number(row.effective_rank) < rank) return false;
        const notification = parse(row.notification_json) || {};
        if (!this.#blockedReason(notification, revoked)
          && this.#evaluate(notification, row.class, row.issue_key, now).state === 'delivered') return true;
      }
      if (rows.length < RELEASE_BATCH) return false;
      const last = rows[rows.length - 1];
      cursor = { rank: last.effective_rank, created_at: last.created_at, id: last.id };
    }
  }
  #evaluate(notification, notificationClass, issueKey, now) {
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
    return { deferred, state, notBefore, last, interactiveOff };
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
      const decision = this.#evaluate(notification, notificationClass, issueKey, now);
      // A real user resolution starts a new queue life; a dedupe refresh or a
      // denied release keeps the original queue age.
      const queuedAt = existing && existing.state !== 'resolved' ? existing.created_at : at;
      let state = decision.state, notBefore = decision.notBefore;
      if (!decision.deferred && notificationClass === 'interactive'
        && this.#hasDeliverableInteractionAhead(this.#effectiveRank(notification, queuedAt, now), now, existing?.id || null)) {
        // The slot belongs to an older deliverable interaction at the same or a
        // higher effective rank. Queue this one for the unified release rather
        // than letting a fresh high-priority offer bypass the queue ordering.
        state = 'pending';
        const spacing = this.#priorityRank(notification) === 3 ? 0
          : decision.last ? Date.parse(decision.last) + this.options.minIntervalMs : 0;
        notBefore = iso(Math.max(now + this.options.digestWindowMs, spacing));
      }
      const id = existing?.id || randomUUID();
      this.db.prepare(`INSERT INTO notification_deliveries VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET
        class=excluded.class,state=excluded.state,notification_json=excluded.notification_json,created_at=excluded.created_at,
        delivered_at=excluded.delivered_at,not_before=excluded.not_before`).run(id, key, issueKey, candidateId, notificationClass, state, json(notification), queuedAt, state === 'delivered' ? at : null, notBefore);
      if (candidateId && state !== 'delivered') this.db.prepare("UPDATE working_candidates SET state='NOTIFICATION_PENDING' WHERE id=?").run(candidateId);
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
    const now = this.database.now(), released = [];
    let cursor = null;
    for (;;) {
      const rows = this.#duePage(now, { cursor });
      for (const row of rows) {
        // This is the module-controlled re-offer path: it keeps the original
        // queuedAt, re-checks budget/quiet/critical inside the transaction and
        // bypasses the new-offer admission check that could otherwise make two
        // queued rows defer to each other forever.
        const offered = this.database.atomic(() => {
          const current = this.db.prepare("SELECT * FROM notification_deliveries WHERE id=? AND state IN ('pending','digest')").get(row.id);
          if (!current) return null;
          const currentNotification = parse(current.notification_json) || {}, atNow = this.database.now();
          // Eligibility can change after page selection. Observe it under the
          // same write lock as the decision, including newly revoked scopes.
          if (this.#blockedReason(currentNotification, this.#revoked())) {
            this.db.prepare("UPDATE notification_deliveries SET state='pending',not_before=? WHERE id=?")
              .run(iso(atNow + this.options.digestWindowMs), current.id);
            return null;
          }
          const decision = this.#evaluate(currentNotification, current.class, current.issue_key, atNow);
          const changed = this.db.prepare("UPDATE notification_deliveries SET state=?,delivered_at=?,not_before=? WHERE id=? AND state IN ('pending','digest')")
            .run(decision.state, decision.state === 'delivered' ? iso(atNow) : null, decision.notBefore, current.id).changes;
          if (!changed) return null;
          if (decision.state === 'pending' && current.candidate_id) this.db.prepare("UPDATE working_candidates SET state='NOTIFICATION_PENDING' WHERE id=?").run(current.candidate_id);
          return this.db.prepare('SELECT * FROM notification_deliveries WHERE id=?').get(current.id);
        });
        if (offered?.state === 'delivered') released.push(offered);
      }
      if (rows.length < RELEASE_BATCH) break;
      const last = rows[rows.length - 1];
      cursor = { rank: last.effective_rank, created_at: last.created_at, id: last.id };
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
