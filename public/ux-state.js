import { needsUserAttention } from './workspace-model.js';

// Device-local presentation preferences. These never grant execution permission.
export function readLocal(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function workspaceKey(state) {
  return `unprompted:view:${state.mode || 'unknown'}:${state.runtime?.workspaceId || state.simulation?.startedAt || 'workspace'}`;
}

export function workspaceSnapshot(state, now = Date.now()) {
  return {
    at: now,
    tasks: Object.fromEntries((state.tasks || []).map(task => [task.id, task.status])),
    facts: Object.fromEntries((state.tasks || []).map(task => [task.id, evidenceFacts(task)]))
  };
}

// Store statuses and versions only; excerpts and document contents stay in the engine.
export function evidenceFacts(task) {
  return {
    version: task.assessment?.documentVersion ?? task.draft?.documentVersion ?? null,
    criteria: Object.fromEntries((task.evidence?.criteria || []).map(item => [item.id, item.status])),
    freshness: task.evidence?.freshness?.status ?? null,
    conflicts: (task.evidence?.conflicts || []).length
  };
}

export function evidenceDelta(task, before) {
  if (!before?.criteria || typeof before.criteria !== 'object' || Array.isArray(before.criteria)) return null;
  const after = evidenceFacts(task);
  const changed = Object.keys(after.criteria).filter(id => before.criteria[id] !== after.criteria[id]);
  const removed = Object.keys(before.criteria).filter(id => !Object.hasOwn(after.criteria, id));
  const gained = changed.filter(id => after.criteria[id] === 'satisfied');
  const lost = changed.filter(id => before.criteria[id] === 'satisfied' && after.criteria[id] !== 'satisfied');
  const versionChanged = before.version !== after.version;
  const freshnessChanged = before.freshness !== after.freshness;
  const conflictsChanged = before.conflicts !== after.conflicts;
  return { changed, removed, gained, lost, versionChanged, freshnessChanged, conflictsChanged,
    hasChanges: Boolean(changed.length || removed.length || versionChanged || freshnessChanged || conflictsChanged),
    fromVersion: before.version, toVersion: after.version };
}

export function decisionQueue(tasks, notices = [], context = {}) {
  const admitted = new Set(tasks.filter(task => needsUserAttention(task, context)).map(task => task.id));
  const items = [
    ...tasks.filter(task => admitted.has(task.id))
      .map(task => ({ key: `task:${task.id}`, kind: 'task', value: task })),
    ...notices.filter(notice => {
      if (['pending', 'digest'].includes(notice.deliveryState)) return false;
      if (notice.kind === 'blocker' && notice.taskId && tasks.some(task => task.id === notice.taskId) && !admitted.has(notice.taskId)) return false;
      return true;
    }).map(notice => ({ key: `notice:${notice.id}`, kind: 'notice', value: notice }))
  ];
  const rank = item => item.kind === 'task' ? (item.value.status === 'blocked' ? 0 : 1) : (item.value.priority === 'high' ? 0 : 2);
  const score = item => item.kind === 'task' ? Number(item.value.management?.priority?.score) || 0 : item.value.priority === 'high' ? 100 : 0;
  return items.map((item, index) => ({ item, index })).sort((a, b) =>
    rank(a.item) - rank(b.item) || score(b.item) - score(a.item) || a.index - b.index
  ).map(entry => entry.item);
}

/** Deduplicate weak stalled prompts when the same open requirement is answered once for several tasks. */
export function visibleAttentionItems(state) {
  const tasks = state.tasks || [];
  const sharedWaitingTaskIds = new Set();
  for (const task of tasks) {
    for (const dependency of task.management?.dependencies || []) {
      if (dependency.status === 'open' && (dependency.taskIds || []).length > 1) {
        for (const taskId of dependency.taskIds) sharedWaitingTaskIds.add(taskId);
      }
    }
  }
  return (state.notifications || []).filter(item => {
    if (['pending', 'digest'].includes(item.deliveryState)) return false;
    const task = tasks.find(candidate => candidate.id === item.taskId);
    if (item.kind === 'blocker' && task && !needsUserAttention(task, state)) return false;
    if (item.kind === 'blocker' && task?.status === 'blocked' && task.action && needsUserAttention(task, state)) return false;
    // Stalled prompts are normal-priority reminders. Keep deadline, risk and
    // uncertain-execution notices intact; those use their own notification IDs.
    if (String(item.dedupeKey || '').startsWith('stalled:') && sharedWaitingTaskIds.has(item.taskId)) return false;
    return true;
  });
}

export function decisionCursor(queue, selectedKey, previousIndex = 0) {
  if (!queue.length) return null;
  return queue.find(item => item.key === selectedKey)?.key || queue[Math.max(0, Math.min(previousIndex, queue.length - 1))].key;
}

export function changesSince(state, previous) {
  if (!previous?.tasks || typeof previous.tasks !== 'object') return null;
  let discovered = 0, completed = 0, ready = 0;
  for (const task of state.tasks || []) {
    const before = previous.tasks[task.id];
    if (!before) discovered++;
    if (task.status === 'completed' && before !== 'completed') completed++;
    if (task.status === 'ready_for_approval' && before !== 'ready_for_approval') ready++;
  }
  return { discovered, completed, ready };
}

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) =>
    (Number(b.management?.priority?.score) || 0) - (Number(a.management?.priority?.score) || 0)
    || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    || String(a.id).localeCompare(String(b.id))
  );
}

// Rank the first view, then keep familiar positions while live state changes.
export function stableTaskOrder(tasks, previousIds = []) {
  const remaining = new Map(tasks.map(task => [task.id, task]));
  const result = [];
  for (const id of previousIds) {
    if (!remaining.has(id)) continue;
    result.push(remaining.get(id));
    remaining.delete(id);
  }
  return [...result, ...sortTasks([...remaining.values()])];
}

export function matchesTask(task, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  return [task.subject, task.sender, task.request?.subjectEntity, task.request?.deliverable].some(value => String(value || '').toLocaleLowerCase().includes(needle));
}
