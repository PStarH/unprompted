export const WORKSPACE_MODES = ['field', 'index', 'lanes', 'spotlight', 'pulse'];
export const isFinished = task => ['completed', 'cancelled'].includes(task.status) || task.userDismissed === true || task.status === 'blocked' && !task.action;
export function workspaceConnections(setup) {
  return { ...setup?.connections, ...setup?.localSources,
    ...(setup?.google ? { google: { connected: setup.google.configuredThisRun === true && !setup.google.runtimeDisabled } } : {}) };
}

// Presentation states are derived from recorded work, never from a timer or a
// decorative animation. Provider uncertainty remains distinct from failure.
export function taskState(task, connections = {}) {
  if (task.status === 'completed') return 'verified';
  if (task.status === 'cancelled' || task.userDismissed || task.status === 'blocked' && !task.action) return 'closed';
  if (task.control?.paused) return 'paused_by_user';
  if (task.status === 'verifying' || ['uncertain', 'executing', 'accepted_live'].includes(task.action?.status)) return 'result_unverified';
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
  const message = state?.inbox?.find(item => item.id === task.sourceEmailId);
  if (message) push({ id: message.id, label: message.subject || task.subject, provider: message.connectorId === 'microsoft' ? 'Outlook' : message.source === 'simulated' || state.mode === 'simulation' ? 'Simulation' : 'Gmail', url: message.url || null });
  if (task.externalSource) push({ id: task.externalSource.externalId || task.id, label: task.subject, provider: ['external_issue', 'external_review', 'external_change', 'external_check'].includes(task.kind) ? 'GitHub' : task.sourceConnectorId === 'apple_notes' ? 'Apple Notes' : 'Local files', url: task.externalSource.url });
  for (const document of task.evidence?.documents || []) push({ id: document.documentId, label: document.title, provider: document.source === 'google' ? 'Drive' : document.source === 'apple_notes' ? 'Apple Notes' : document.source === 'local_files' ? 'Local files' : document.source === 'simulated' ? 'Simulation' : document.source || 'Document', url: document.url });
  return sources;
}

export function taskSteps(task) {
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

export function recommendedMode(tasks) {
  const active = tasks.filter(task => !isFinished(task) && !task.control?.paused);
  return active.length >= 3 && active.some(task => task.management?.dependencies?.some(item => item.taskIds?.length > 1)) ? 'lanes' : null;
}
