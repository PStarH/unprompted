export const WORKSPACE_MODES = ['field', 'index', 'lanes', 'spotlight', 'pulse'];
export const isFinished = task => ['completed', 'cancelled'].includes(task.status) || task.userDismissed === true || task.status === 'blocked' && !task.action;
export function workspaceConnections(setup) {
  return { ...setup?.connections, ...setup?.localSources,
    ...(setup?.google ? { google: { connected: setup.google.configuredThisRun === true && !setup.google.runtimeDisabled } } : {}) };
}

// Presentation states are derived from recorded work, never from a timer or a
// decorative animation. Provider uncertainty remains distinct from failure.
export function taskState(task, connections = {}) {
  if (task.status === 'completed') return task.completion?.kind === 'user_accepted_preparation' ? 'user_accepted' : 'verified';
  if (task.status === 'cancelled' || task.userDismissed || task.status === 'blocked' && !task.action) return 'closed';
  if (task.control?.paused) return 'paused_by_user';
  if (task.status === 'verifying' || ['uncertain', 'executing', 'accepted_live'].includes(task.action?.status)) return 'result_unverified';
  if (task.activationHold) return 'paused_by_policy';
  if (task.kind === 'standing_intent' && ['pending', 'running'].includes(task.reasoning?.status)) return 'working';
  if (task.reasoning?.status === 'failed' || task.action?.status === 'failed') return 'failed';
  const provider = task.sourceConnectorId || task.externalSource?.provider;
  if (provider && connections[provider]?.connected === false) return 'source_disconnected';
  if (task.status === 'ready_for_approval' || task.status === 'blocked') return 'needs_user';
  if (task.reasoningWork?.status === 'running') return 'working';
  if (['external_issue', 'external_review', 'external_change', 'external_check', 'observed_task'].includes(task.kind)) return 'observing';
  if (task.status === 'waiting_for_information') return 'waiting_external';
  if (['newly_discovered', 'investigating'].includes(task.status)) return 'working';
  return 'unknown';
}

export function stateGroup(state) {
  if (['needs_user', 'failed', 'source_disconnected', 'result_unverified', 'unknown'].includes(state)) return 'attention';
  if (state === 'working') return 'working';
  if (state === 'waiting_external') return 'waiting';
  return 'quiet';
}

export function taskSources(task, state) {
  const sources = [];
  const push = source => { if (source && !sources.some(item => item.id === source.id)) sources.push(source); };
  const message = state?.inbox?.find(item => item.id === (task.sourceEmailId || task.request?.source?.id));
  if (message) push({ id: message.id, label: message.subject || task.subject, provider: message.connectorId === 'microsoft' ? 'Outlook' : message.source === 'simulated' || state.mode === 'simulation' ? 'Simulation' : 'Gmail', url: message.url || null });
  if (task.externalSource) push({ id: task.externalSource.externalId || task.id, label: task.subject, provider: ['external_issue', 'external_review', 'external_change', 'external_check'].includes(task.kind) ? 'GitHub' : task.sourceConnectorId === 'apple_notes' ? 'Apple Notes' : task.sourceConnectorId === 'apple_reminders' ? 'Apple Reminders' : task.sourceConnectorId === 'todoist' ? 'Todoist' : 'Local files', url: task.externalSource.url });
  const directDocument = state?.documents?.find(item => item.id === task.documentId || task.request?.source?.kind === 'document' && item.id === task.request.source.id);
  if (directDocument) push({ id: directDocument.id, label: directDocument.title, provider: directDocument.source || task.sourceConnectorId || 'Document', url: directDocument.url });
  for (const document of task.evidence?.documents || []) push({ id: document.documentId, label: document.title, provider: document.source === 'google' ? 'Drive' : document.source === 'apple_notes' ? 'Apple Notes' : document.source === 'local_files' ? 'Local files' : document.source === 'simulated' ? 'Simulation' : document.source || 'Document', url: document.url });
  return sources;
}

export function taskSteps(task) {
  if (task.completion?.kind === 'user_accepted_preparation') return [{ key: 'source', status: 'done' }, { key: 'prepare', status: 'done' }, { key: 'reviewed', status: 'done' }];
  if (task.preparedWork?.requiresReview) return [{ key: 'source', status: 'done' }, { key: 'prepare', status: 'done' }, { key: 'review', status: 'current' }];
  const sourceKnown = Boolean(task.sourceEmailId || task.externalSource || task.request?.source);
  if (['external_issue', 'external_review', 'external_change', 'external_check', 'observed_task'].includes(task.kind)) return [
    { key: 'source', status: 'done' }, { key: 'observe', status: isFinished(task) ? 'done' : 'current' }, { key: 'source_change', status: 'next' }
  ];
  const checked = Boolean(task.evidence || task.assessment);
  const complete = task.status === 'completed';
  const prepared = Boolean(task.draft || task.action);
  return [
    { key: 'source', status: sourceKnown ? 'done' : 'current' },
    { key: 'evidence', status: prepared || complete ? 'done' : sourceKnown ? 'current' : 'next', checked },
    { key: complete ? 'verified' : task.action ? 'verify' : 'prepare', status: complete ? 'done' : prepared ? 'current' : 'next' }
  ];
}

export function activityEntries(state) {
  const seen = new Set();
  return (state.history || []).filter(item => {
    if (!item.taskId || !state.tasks.some(task => task.id === item.taskId)) return false;
    const repetitive = ['assessment', 'observation', 'reasoning', 'reasoning_started'].includes(item.kind);
    const key = `${item.taskId}:${item.kind}:${repetitive ? '' : item.text || item.detail || ''}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 50);
}

// Prefer the item that followed the one just handled. If none of those remain,
// wrap to the first item that is still pending. The finished id is excluded
// even if another task was just removed from the queue.
export function nextQueueId(before, after, finishedId) {
  const pending = (after || []).filter(id => id && id !== finishedId);
  const start = (before || []).indexOf(finishedId);
  if (start >= 0) {
    const later = before.slice(start + 1).find(id => pending.includes(id));
    if (later) return later;
  }
  return pending[0] || null;
}

export function recommendedMode(tasks) {
  const active = tasks.filter(task => !isFinished(task) && !task.control?.paused);
  return active.length >= 3 && active.some(task => task.management?.dependencies?.some(item => item.taskIds?.length > 1)) ? 'lanes' : null;
}
