export const WORKSPACE_MODES = ['field', 'index', 'lanes', 'spotlight', 'pulse'];
export const isFinished = task => ['completed', 'cancelled'].includes(task.status) || task.userDismissed === true || task.status === 'blocked' && !task.action;
export function workspaceConnections(setup) {
  return { ...setup?.connections, ...setup?.localSources,
    ...(setup?.google ? { google: { connected: setup.google.configuredThisRun === true && !setup.google.runtimeDisabled } } : {}) };
}

const OBSERVING_KINDS = new Set(['external_issue', 'external_review', 'external_change', 'external_check', 'observed_task']);
const IN_FLIGHT_ACTION = new Set(['executing', 'accepted_live', 'uncertain', 'unknown']);
const TERMINAL_CLOSES = new Set(['reconciliation_inconclusive', 'attestation_request', 'user_attestation_request']);

function pack(needsUser, state) {
  return { needsUser, state, group: groupForState(state) };
}

function groupForState(state) {
  if (['needs_user', 'failed', 'source_disconnected'].includes(state)) return 'attention';
  if (state === 'working' || state === 'result_unverified') return 'working';
  if (state === 'waiting_external') return 'waiting';
  return 'quiet';
}

function contextConnections(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  if (context.connections && typeof context.connections === 'object') return context.connections;
  const values = Object.values(context);
  if (values.length && values.every(value => value && typeof value === 'object' && !Array.isArray(value) && ('connected' in value || 'configuredThisRun' in value))) return context;
  return {};
}

function recordedWait(task, context = {}) {
  if (task.wait?.status) return task.wait;
  const waits = context.taskWaits || context.state?.taskWaits;
  if (Array.isArray(waits)) {
    const match = waits.find(item => item?.taskId === task.id);
    if (match?.status) return match;
  } else if (waits && typeof waits === 'object' && waits[task.id]?.status) return waits[task.id];
  const wake = task.management?.wake;
  if (wake?.waitId && wake.status) return { id: wake.waitId, status: wake.status, kind: wake.kind, condition: { label: wake.condition } };
  return null;
}

/** Explicit send close. `unknown` / `uncertain` alone is not a close. */
export function terminalAttentionClose(task = {}) {
  if (task.reconciliation_inconclusive === true) return 'reconciliation_inconclusive';
  if (task.attestationRequest === true || task.attestation_request === true) return 'attestation_request';
  const candidates = [task.close, task.action?.close, task.action?.lastErrorClass, task.action?.last_error_class, task.lastErrorClass, task.last_error_class];
  return candidates.find(value => TERMINAL_CLOSES.has(value)) || null;
}

function sourceDisconnected(task, context) {
  const provider = task.sourceConnectorId || task.externalSource?.provider;
  if (!provider) return false;
  return contextConnections(context)[provider]?.connected === false;
}

function inFlight(task) {
  if (terminalAttentionClose(task)) return false;
  if (task.status === 'verifying') return true;
  return IN_FLIGHT_ACTION.has(task.action?.status);
}

function reasoningStillRunning(task) {
  const work = task.reasoningWork;
  if (work && ['pending', 'running'].includes(work.status)) return true;
  if (['pending', 'running'].includes(task.reasoning?.status)) return true;
  return false;
}

function reasoningWillRetry(task) {
  const work = task.reasoningWork;
  if (!work || work.status === 'running' || work.status === 'pending') return false;
  if (work.retryable === false || work.terminalReason || work.budgetExhausted || task.reasoning?.budgetExhausted) return false;
  if (task.reasoning?.status !== 'failed' && work.status !== 'failed') return false;
  return Boolean(work.retryAt && Number.isFinite(Date.parse(work.retryAt)) && Date.parse(work.retryAt) > Date.now());
}

function failedNeedsUser(task) {
  const reasoningFailed = task.reasoning?.status === 'failed' || task.reasoningWork?.status === 'failed';
  const actionFailed = task.action?.status === 'failed';
  if (!reasoningFailed && !actionFailed) return false;
  if (reasoningFailed && !actionFailed && (reasoningStillRunning(task) || reasoningWillRetry(task))) return false;
  return true;
}

function reviewReady(task) {
  return task.status === 'ready_for_approval' || Boolean(task.preparedWork?.requiresReview && !task.preparedWork.acceptedAt);
}

function ledgerOnlyUnverifiable(task) {
  const action = task.action;
  const actionIsWrite = action?.ledgerOnlyUnverified === true || action?.family === 'mcp.tool' || action?.family === 'connector.request';
  const requests = task.platformRequests || [];
  const requestIsWrite = requests.some(item => !item?.verification && item?.verified !== true && (item.ledgerOnlyUnverified === true || item.family === 'mcp.tool' || item.family === 'connector.request'));
  if (task.ledgerOnlyUnverified !== true && !actionIsWrite && !requestIsWrite) return false;
  if (reviewReady(task) && !actionIsWrite) return false;
  if (terminalAttentionClose(task) && !actionIsWrite) return false;
  if (action?.status === 'failed' && !actionIsWrite) return false;
  if (action && !actionIsWrite && action.family !== 'mcp.tool' && action.family !== 'connector.request' && action.ledgerOnlyUnverified !== true) return false;
  return true;
}

function sharedHumanDependency(task) {
  return (task.management?.dependencies || []).find(item => {
    if ((item?.taskIds || []).length < 2) return false;
    if (item.status === 'open' || item.status === 'failed_unresolved' || item.status === 'dismissed_unresolved') return true;
    if (item.status === 'deferred') return !(item.wake || item.decision?.wake || item.decision?.until);
    return false;
  }) || null;
}

function nextKind(task, context) {
  const recorded = task.management?.nextAction?.kind;
  if (recorded) return recorded;
  const wait = recordedWait(task, context);
  if (wait?.status === 'active') return 'wait';
  if (wait?.status === 'interrupted') return 'decide';
  if (task.status === 'ready_for_approval') return 'approve';
  if (task.preparedWork?.requiresReview && !task.preparedWork.acceptedAt) return 'approve';
  if (task.action?.status === 'confirmed_absent') return 'decide';
  if (task.status === 'waiting_for_information') return 'provide_information';
  if (['newly_discovered', 'investigating', 'verifying'].includes(task.status)) return 'assess';
  return null;
}

function coveredBySharedBand(task, context) {
  if (!sharedHumanDependency(task)) return false;
  if (reviewReady(task) || terminalAttentionClose(task) || failedNeedsUser(task)) return false;
  if (task.action?.status === 'confirmed_absent') return false;
  const kind = nextKind(task, context);
  return ['resolve_dependency', 'decide', 'provide_information'].includes(kind);
}

function blockingConflict(task) {
  if (reasoningStillRunning(task)) return false;
  const incomplete = task.assessment?.complete === false || task.evidence?.completion?.complete === false || task.assessment?.complete == null;
  if (!incomplete && task.assessment?.complete === true) return false;
  return (task.evidence?.conflicts || []).some(item => String(item?.id || '').startsWith('conflicting:'));
}

function agentOwnsNext(task, context) {
  const kind = nextKind(task, context);
  if (['assess', 'recheck', 'reassess', 'verify', 'wait'].includes(kind)) return true;
  if (['provide_information', 'resolve_dependency', 'decide', 'approve'].includes(kind)) return false;
  return reasoningStillRunning(task) || ['newly_discovered', 'investigating', 'verifying'].includes(task.status);
}

/**
 * One admission decision for Field zones, the decision queue, and J/K.
 * Presentation state is derived from this result; it is not a second list.
 */
export function classifyTask(task, context = {}) {
  if (!task || typeof task !== 'object') return pack(false, 'unknown');
  if (task.status === 'completed') return pack(false, task.completion?.kind === 'user_accepted_preparation' ? 'user_accepted' : 'verified');
  if (task.status === 'cancelled' || task.userDismissed || (task.status === 'blocked' && !task.action)) return pack(false, 'closed');
  if (task.control?.paused) return pack(false, 'paused_by_user');
  if (task.activationHold) return pack(false, 'paused_by_policy');
  if (ledgerOnlyUnverifiable(task)) {
    return pack(false, ['newly_discovered', 'investigating'].includes(task.status) || reasoningStillRunning(task) ? 'working' : 'result_unverified');
  }
  const observing = OBSERVING_KINDS.has(task.kind);
  const close = terminalAttentionClose(task);
  const failed = failedNeedsUser(task);
  const disconnected = sourceDisconnected(task, context);
  const flight = inFlight(task);
  const ready = reviewReady(task);
  const wait = recordedWait(task, context);
  const activeWait = wait?.status === 'active';
  if (observing && !ready && !close && !failed && !(disconnected && flight)) return pack(false, 'observing');
  if (close || failed || (disconnected && (ready || flight || (!observing && !activeWait)))) {
    if (disconnected && !close) return pack(true, 'source_disconnected');
    if (failed && !close) return pack(true, 'failed');
    return pack(true, 'needs_user');
  }
  if (flight) return pack(false, 'result_unverified');
  if (ready) return pack(true, 'needs_user');
  if (reasoningStillRunning(task)) return pack(false, 'working');
  if (reasoningWillRetry(task)) return pack(false, 'working');
  if (wait?.status === 'interrupted') return pack(true, 'needs_user');
  if (coveredBySharedBand(task, context)) return pack(false, 'waiting_external');
  if (activeWait) return pack(false, 'waiting_external');
  if (blockingConflict(task)) return pack(true, 'needs_user');
  if (task.action?.status === 'confirmed_absent') return pack(true, 'needs_user');
  const kind = nextKind(task, context);
  if (kind === 'decide' || kind === 'provide_information' || kind === 'resolve_dependency') return pack(true, 'needs_user');
  if (['newly_discovered', 'investigating'].includes(task.status) || task.reasoningWork?.status === 'running') return pack(false, 'working');
  if (observing) return pack(false, 'observing');
  if (activeWait) return pack(false, 'waiting_external');
  if (agentOwnsNext(task, context)) return pack(false, 'working');
  return pack(false, 'unknown');
}

export function needsUserAttention(task, context = {}) {
  return classifyTask(task, context).needsUser;
}

// Presentation states are derived from the admission predicate, never from a
// timer or a decorative animation. In-flight uncertainty stays in motion.
export function taskState(task, context = {}) {
  return classifyTask(task, context).state;
}

export function stateGroup(state) {
  if (state && typeof state === 'object') return classifyTask(state).group;
  return groupForState(state);
}

export function taskSources(task, state) {
  const sources = [];
  const push = source => { if (source && !sources.some(item => item.id === source.id)) sources.push(source); };
  const message = state?.inbox?.find(item => item.id === (task.sourceEmailId || task.request?.source?.id));
  if (message) push({ id: message.id, label: message.subject || task.subject, provider: message.connectorId === 'microsoft' ? 'Outlook' : message.connectorId === 'apple_mail' ? 'Apple Mail' : message.source === 'simulated' || state.mode === 'simulation' ? 'Simulation' : 'Gmail', url: message.url || null });
  if (task.externalSource) push({ id: task.externalSource.externalId || task.id, label: task.subject, provider: ['external_issue', 'external_review', 'external_change', 'external_check'].includes(task.kind) ? 'GitHub' : task.sourceConnectorId === 'apple_notes' ? 'Apple Notes' : task.sourceConnectorId === 'apple_reminders' ? 'Apple Reminders' : task.sourceConnectorId === 'todoist' ? 'Todoist' : 'Local files', url: task.externalSource.url });
  const directDocument = state?.documents?.find(item => item.id === task.documentId || task.request?.source?.kind === 'document' && item.id === task.request.source.id);
  if (directDocument) push({ id: directDocument.id, label: directDocument.title, provider: directDocument.source || task.sourceConnectorId || 'Document', url: directDocument.url });
  for (const document of task.evidence?.documents || []) push({ id: document.documentId, label: document.title, provider: document.source === 'google' ? 'Drive' : document.source === 'apple_notes' ? 'Apple Notes' : document.source === 'apple_calendar' ? 'Apple Calendar' : document.source === 'apple_contacts' ? 'Apple Contacts' : document.source === 'local_files' ? 'Local files' : document.source === 'simulated' ? 'Simulation' : document.source || 'Document', url: document.url });
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
