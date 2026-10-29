/**
 * Decision notifications.
 *
 * Two rules drive this module:
 *
 *   Default quiet. Most transitions — an event observed, a document
 *        correlated, work prepared, work verified — must NOT interrupt anyone.
 *        The engine keeps those in the history, which is a log, not a notification.
 *        A notification is only created when a decision is genuinely needed.
 *
 *   Decision support. A notification carries what happened, why
 *        it matters, what the system already checked or did, the evidence it has,
 *        what is still uncertain, and what the user has to decide. A notification
 *        that cannot state those is rejected at construction, so "I found an
 *        opportunity" with no context cannot be emitted at all.
 *
 * The qualifying cases are:
 *
 *   risk       - important risk or a likely serious omission (contradictory evidence)
 *   deadline   - a key deadline is close and the work is still not complete
 *   calibration- a reading or preference is unclear and the answer changes a
 *                decision (for example an ambiguous 10/11 that could be two days)
 *   opportunity- a valuable improvement worth a user decision
 *   permission - continuing needs a new permission or explicit authorisation
 *   blocker    - an execution failure, unknown outcome, or other unresolvable block
 */

export const NOTIFICATION_KINDS = ['risk', 'deadline', 'calibration', 'opportunity', 'permission', 'blocker'];

export const PRIORITY_RANK = { low: 1, normal: 2, high: 3 };

let counter = 0;
const nextId = () => `n-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

/**
 * Construct a decision-supporting notification.
 *
 * `what`, `why`, `decision` and at least one `checked` entry are required: a
 * notification that cannot explain itself is a defect, not a message.
 */
export function notification({
  id = null,
  kind,
  priority = 'normal',
  headline = null,
  what,
  why,
  checked,
  evidence = [],
  uncertainty = [],
  decision,
  nextStep = null,
  options = [],
  taskId = null,
  opportunityId = null,
  clarificationId = null,
  dedupeKey = null,
  at = new Date().toISOString()
}) {
  if (!NOTIFICATION_KINDS.includes(kind)) throw new Error(`Unknown notification kind: ${kind}`);
  if (!PRIORITY_RANK[priority]) throw new Error(`Unknown notification priority: ${priority}`);
  const required = { what, why, decision };
  for (const [field, value] of Object.entries(required)) {
    if (!value || !String(value).trim()) throw new Error(`A notification must state ${field}; it cannot be sent without context.`);
  }
  if (!Array.isArray(checked) || !checked.length) {
    throw new Error('A notification must state what the system already checked or completed.');
  }
  return {
    id: id || nextId(),
    kind,
    priority,
    headline: headline || kind,
    what,
    why,
    checked,
    evidence,
    uncertainty,
    decision,
    nextStep,
    options,
    taskId,
    opportunityId,
    clarificationId,
    dedupeKey,
    at,
    readAt: null,
    resolvedAt: null
  };
}

/**
 * The single guarding detail that keeps notifications quiet: the same decision is
 * never sent twice. A resolved notification is revived — rather than duplicated —
 * if the same condition genuinely recurs.
 */
export function emitNotification(notifications, entry) {
  if (entry.dedupeKey) {
    const existing = notifications.find(item => item.dedupeKey === entry.dedupeKey);
    if (existing) {
      if (existing.resolvedAt) {
        existing.resolvedAt = null;
        existing.at = entry.at;
        // A revived decision is a new interruption. It must not inherit the
        // read state of its previous life, or the interface would count it as
        // already seen the moment it comes back.
        existing.readAt = null;
      }
      // Keep the text current even when the condition persists.
      existing.what = entry.what;
      existing.why = entry.why;
      existing.checked = entry.checked;
      existing.evidence = entry.evidence;
      existing.uncertainty = entry.uncertainty;
      existing.decision = entry.decision;
      existing.nextStep = entry.nextStep;
      existing.options = entry.options;
      existing.clarificationId = entry.clarificationId ?? existing.clarificationId;
      existing.opportunityId = entry.opportunityId ?? existing.opportunityId;
      existing.priority = entry.priority;
      return existing;
    }
  }
  notifications.push(entry);
  return entry;
}

/** Mark matching open notifications resolved, so a cleared condition stops showing. */
export function resolveNotifications(notifications, predicate, at = new Date().toISOString()) {
  let resolved = 0;
  for (const item of notifications) {
    if (item.resolvedAt) continue;
    if (predicate(item)) { item.resolvedAt = at; resolved += 1; }
  }
  return resolved;
}

export function markRead(notifications, ids = null, at = new Date().toISOString()) {
  let marked = 0;
  for (const item of notifications) {
    if (ids && !ids.includes(item.id)) continue;
    // A notification that already resolved itself is no longer actionable; only
    // open notifications carry an unread state that means anything.
    if (item.resolvedAt || item.readAt) continue;
    item.readAt = at;
    marked += 1;
  }
  return marked;
}

/** Open (unresolved) notifications, newest and most important first. */
export function openNotifications(notifications) {
  return notifications
    .filter(item => !item.resolvedAt && !['pending', 'digest'].includes(item.deliveryState))
    .slice()
    .sort((a, b) => (PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]) || String(b.at).localeCompare(String(a.at)));
}

export function summarise(notifications) {
  const open = notifications.filter(item => !item.resolvedAt);
  const byKind = {};
  for (const item of open) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  return {
    total: notifications.length,
    open: open.length,
    unread: open.filter(item => !item.readAt).length,
    byKind
  };
}

/**
 * Deadline risk — a key date is approaching while work remains incomplete.
 *
 * Compares a calendar day (`deadline.iso`) to `now`. Relative phrases are
 * resolved earlier by `extractDeadline` against the request time; this helper
 * never invents a day from bare text.
 */
export function deadlineRisk({ deadline, now = new Date(), withinDays = 3 } = {}) {
  if (!deadline?.iso) return null;
  // An ambiguous (`10/11` without a format) or invalid (Feb 30) date is not a
  // deadline. It must never drive a notification or an action.
  if (deadline.ambiguous || deadline.kind === 'ambiguous' || deadline.kind === 'invalid') return null;
  const due = new Date(`${deadline.iso}T23:59:59.000Z`);
  if (Number.isNaN(due.getTime())) return null;
  const days = (due.getTime() - now.getTime()) / 86400000;
  if (days > withinDays) return null;
  return {
    iso: deadline.iso,
    text: deadline.text || deadline.iso,
    days: Math.round(days * 10) / 10,
    overdue: days < 0
  };
}

export function describeNotification(item) {
  return `[${item.kind}/${item.priority}] ${item.what}`;
}

export const notificationsApi = {
  NOTIFICATION_KINDS, PRIORITY_RANK, notification, emitNotification, resolveNotifications,
  markRead, openNotifications, summarise, deadlineRisk, describeNotification
};
