import { randomUUID } from 'node:crypto';
import { analyseRequest, extractRequiredContent } from './requests.js';
import { isSourceFollowTask } from './external-work.js';
import { memoryConsumable, memoryLifecycle, validMemoryDate } from './memory-lifecycle.js';

const normal = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const clone = value => value == null ? null : structuredClone(value);
const terminal = task => ['completed', 'cancelled'].includes(task.status) || task.userDismissed;

export function matchingTaskMemories(task, state) {
  const entity = normal(task.request?.subjectEntity), deliverable = normal(task.request?.deliverable);
  if (!entity || !deliverable) return [];
  return Object.values(state.taskMemories || {}).filter(item => memoryConsumable(item) &&
    normal(item.scope?.entity) === entity && normal(item.scope?.deliverable) === deliverable);
}

// Directions revise grounded requirements; they never change recipients, source
// identity, permissions, or mark an existing action as undone.
export function effectiveTaskRequest(task, state) {
  const request = task.request;
  if (!request) return request;
  // A task-local correction wins over shared preferences. Original request
  // requirements remain in place; memory is still available to other tasks.
  const directions = task.guidance ? [task.guidance] : matchingTaskMemories(task, state);
  if (!directions.length) return request;
  const replacing = task.guidance?.operation === 'replace';
  const text = [...(replacing ? [] : [request.text || '']), ...directions.map(item => `User direction: ${item.text}`)].join('\n\n');
  const requiredContent = replacing ? [] : [...(request.requiredContent || [])];
  for (const direction of directions) {
    const extracted = extractRequiredContent(direction.text, { deliverable: request.deliverable });
    const requirements = extracted.length ? extracted : [{ text: direction.text }];
    for (const item of requirements) if (!requiredContent.some(existing => normal(existing.text) === normal(item.text))) {
      requiredContent.push({ ...item, sourceQuote: item.text, sourceField: 'body', grounding: 'user_stated' });
    }
  }
  const effective = { ...request, text, requiredContent };
  effective.analysis = analyseRequest(effective);
  effective.qualifiers = effective.analysis.qualifiers;
  return effective;
}

function requireEditable(engine, taskId) {
  const task = engine.store.state.tasks[taskId];
  if (!task) throw new Error('Unknown task');
  if (task.status === 'verifying' || task.action) {
    throw new Error('An action has already started. Verify its result before changing this task.');
  }
  if (terminal(task)) throw new Error('A closed task must be restored before changing its direction.');
  return task;
}

function invalidate(task, at) {
  if (task.draft?.userEdited) task.userDraftStale = true;
  else task.draft = null;
  task.evidence = null;
  task.assessment = null;
  task.reasoningPlan = null;
  task.reasoningAttemptedFor = null;
  task.reasoningWork = null;
  task.reasoning = null;
  delete task.preparedWork;
  delete task.contextManifest;
  task.updatedAt = at;
  task.guidanceReviewRequired = true;
  task.guidanceRevision = (Number(task.guidanceRevision) || 0) + 1;
  if (!isSourceFollowTask(task)) task.status = 'waiting_for_information';
}

function history(state, taskId, kind, detail, at) {
  state.history.push({ id: randomUUID(), taskId, kind, text: detail, at });
}

export function pauseTask(engine, taskId, paused) {
  const task = engine.store.state.tasks[taskId];
  if (!task) throw new Error('Unknown task');
  if (terminal(task)) throw new Error('A closed task cannot be paused or resumed.');
  if (Boolean(task.control?.paused) === paused) return task;
  const at = new Date().toISOString();
  engine.store.mutate(state => {
    const target = state.tasks[taskId];
    const { pauseReason: _pauseReason, ...control } = target.control || {};
    target.control = { ...control, paused, updatedAt: at };
    if (!paused && target.reasoningWork?.terminalReason === 'paused_by_user') { target.reasoningWork = null; target.reasoningAttemptedFor = null; }
    target.updatedAt = at;
    if (paused && target.reasoningWork) target.reasoningWork = { ...target.reasoningWork, status: 'superseded', terminalReason: 'paused_by_user' };
    history(state, taskId, paused ? 'task_paused' : 'task_resumed', paused ? 'Paused by the user. Future task checks and actions are stopped.' : 'Resumed by the user. Current evidence will be checked again.', at);
  });
  if (!paused) {
    if (engine.durableRuntime && engine.store.state.tasks[taskId].action) engine.durableRuntime.scheduleTask(taskId, 'resume_reconciliation');
    else engine.recheckTaskGuidance(taskId);
  }
  engine.changed();
  return engine.store.state.tasks[taskId];
}

export function directTask(engine, taskId, { text, scope = 'task', operation = 'append' } = {}) {
  const task = requireEditable(engine, taskId);
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 2000) throw new Error('A direction requires 1–2000 characters.');
  if (!['task', 'similar'].includes(scope)) throw new Error('Invalid memory scope.');
  if (!['append', 'replace'].includes(operation) || operation === 'replace' && scope !== 'task') throw new Error('Replacing requirements is available for this task only.');
  if (scope === 'similar' && (!task.request?.subjectEntity || !task.request?.deliverable)) throw new Error('Similar-task memory requires an identified project and deliverable.');
  const at = new Date().toISOString(), id = randomUUID();
  engine.store.mutate(state => {
    state.taskDirections ||= {};
    state.taskMemories ||= {};
    const target = state.tasks[taskId];
    const memoryId = scope === 'similar' ? randomUUID() : null;
    const direction = { id, text: text.trim(), scope, operation, at, memoryId };
    state.taskDirections[id] = { ...direction, taskId, previous: clone(target.guidance), active: true, executedActionsAffected: false };
    if (memoryId) {
      state.taskMemories[memoryId] = { id: memoryId, text: direction.text, taskId,
        scope: { entity: task.request.subjectEntity, deliverable: task.request.deliverable }, createdAt: at, updatedAt: at, deletedAt: null,
        memoryKind: 'fact', lifecycleState: 'active', validUntil: null, supersededBy: null,
        versions: [{ version: 1, text: direction.text, lifecycleState: 'active', validUntil: null, changeKind: 'created', createdAt: at }] };
      for (const peer of Object.values(state.tasks)) if (peer.id !== taskId && !terminal(peer) && !peer.action && !peer.guidance &&
        normal(peer.request?.subjectEntity) === normal(task.request.subjectEntity) && normal(peer.request?.deliverable) === normal(task.request.deliverable)) invalidate(peer, at);
    }
    target.guidance = direction;
    invalidate(target, at);
    history(state, taskId, 'task_direction', `User updated the task requirements: ${direction.text}`, at);
  });
  engine.recheckTaskGuidance(taskId);
  if (scope === 'similar') for (const peer of Object.values(engine.store.state.tasks)) if (peer.id !== taskId && !terminal(peer) && !peer.action && !peer.guidance &&
    normal(peer.request?.subjectEntity) === normal(task.request.subjectEntity) && normal(peer.request?.deliverable) === normal(task.request.deliverable)) engine.recheckTaskGuidance(peer.id);
  engine.changed();
  return engine.store.state.taskDirections[id];
}

export function undoTaskDirection(engine, taskId, id) {
  const task = requireEditable(engine, taskId);
  const direction = engine.store.state.taskDirections?.[id];
  if (!direction || direction.taskId !== taskId || !direction.active || task.guidance?.id !== id) throw new Error('This direction is no longer current.');
  const memory = direction.memoryId ? engine.store.state.taskMemories?.[direction.memoryId] : null;
  if (memory && memoryLifecycle(memory) !== 'deleted' && memory.updatedAt !== direction.at) throw new Error('The linked memory changed. Review or remove it before undoing this direction.');
  const at = new Date().toISOString();
  engine.store.mutate(state => {
    const entry = state.taskDirections[id];
    entry.active = false; entry.undoneAt = at;
    if (memory && memoryLifecycle(memory) !== 'deleted') {
      state.taskMemories[entry.memoryId].deletedAt = at;
      state.taskMemories[entry.memoryId].lifecycleState = 'deleted';
      state.taskMemories[entry.memoryId].updatedAt = at;
      for (const peer of Object.values(state.tasks)) if (peer.id !== taskId && !terminal(peer) && !peer.action && !peer.guidance &&
        normal(peer.request?.subjectEntity) === normal(memory.scope.entity) && normal(peer.request?.deliverable) === normal(memory.scope.deliverable)) invalidate(peer, at);
    }
    state.tasks[taskId].guidance = clone(entry.previous);
    invalidate(state.tasks[taskId], at);
    history(state, taskId, 'task_direction_undo', 'User undid the current direction. Previous requirements restored; sent actions are unaffected.', at);
  });
  engine.recheckTaskGuidance(taskId);
  if (memory) for (const peer of Object.values(engine.store.state.tasks)) if (peer.id !== taskId && !terminal(peer) && !peer.action && !peer.guidance &&
    normal(peer.request?.subjectEntity) === normal(memory.scope.entity) && normal(peer.request?.deliverable) === normal(memory.scope.deliverable)) engine.recheckTaskGuidance(peer.id);
  engine.changed();
  return engine.store.state.taskDirections[id];
}

export function updateTaskMemory(engine, id, { operation, text, version, expectedVersion, memoryKind, validUntil, scope, replacement } = {}, { afterSync = null } = {}) {
  const memory = engine.store.state.taskMemories?.[id];
  if (!memory) throw new Error('Unknown memory.');
  const expected = version ?? expectedVersion;
  if (expected !== memory.updatedAt) throw new Error('This memory changed. Review its latest version.');
  const operations = ['edit', 'disable', 'reactivate', 'archive', 'restore', 'delete', 'restore-delete', 'supersede', 'restore-version', 'validity'];
  if (!operations.includes(operation)) throw new Error('Invalid memory operation.');
  const lifecycle = memoryLifecycle(memory);
  const allowed = {
    edit: ['active', 'disabled'], disable: ['active'], reactivate: ['disabled'],
    archive: ['active', 'disabled'], restore: ['archived', 'deleted'], 'restore-delete': ['deleted'],
    delete: ['active', 'disabled', 'archived'], supersede: ['active', 'disabled'],
    'restore-version': ['active', 'disabled'], validity: ['active', 'disabled']
  };
  if (!allowed[operation]?.includes(lifecycle)) throw new Error(`A ${lifecycle} memory cannot be ${operation}d.`);
  if (['edit', 'supersede', 'restore-version'].includes(operation) && (typeof text !== 'string' || !text.trim() || text.trim().length > 2000)) throw new Error('An editable memory requires 1–2000 characters.');
  if (memoryKind != null && !['fact', 'preference'].includes(memoryKind)) throw new Error('Choose a fact or preference.');
  let nextValidity;
  if (['edit', 'reactivate', 'restore', 'restore-delete', 'supersede', 'validity'].includes(operation)) {
    try { nextValidity = validMemoryDate(operation === 'validity' || validUntil !== undefined ? validUntil : memory.validUntil); }
    catch (error) { throw new Error(error.message); }
  }
  const at = new Date(Math.max(Date.now(), Date.parse(memory.updatedAt) + 1)).toISOString();
  let replacementId = null;
  engine.store.mutate(state => {
    const entry = state.taskMemories[id];
    const snapshot = (target, changeKind) => {
      target.versions ||= [];
      target.versions.push({ version: target.versions.length + 1, text: target.text,
        memoryKind: target.memoryKind || 'fact', scope: clone(target.scope), lifecycleState: memoryLifecycle(target),
        validUntil: target.validUntil || null, changeKind, createdAt: at });
      if (target.versions.length > 100) target.versions.splice(0, target.versions.length - 100);
    };
    const transition = (target, changeKind, changes) => {
      Object.assign(target, changes, { updatedAt: at });
      snapshot(target, changeKind);
    };
    if (operation === 'edit' || operation === 'restore-version' || operation === 'validity') {
      transition(entry, operation === 'restore-version' ? 'restore_version' : operation, {
        ...(operation !== 'validity' ? { text: text.trim() } : {}),
        ...(memoryKind ? { memoryKind } : {}),
        ...(scope ? { scope: clone(scope) } : {}),
        ...(nextValidity !== undefined ? { validUntil: nextValidity } : {})
      });
    } else if (operation === 'disable' || operation === 'reactivate' || operation === 'archive') {
      transition(entry, operation, { lifecycleState: operation === 'disable' ? 'disabled' : operation === 'archive' ? 'archived' : 'active', deletedAt: null,
        ...(nextValidity !== undefined ? { validUntil: nextValidity } : {}) });
    } else if (operation === 'delete') {
      transition(entry, operation, { lifecycleState: 'deleted', deletedAt: at });
    } else if (operation === 'restore' || operation === 'restore-delete') {
      if (entry.supersededBy) throw new Error('A superseded memory cannot be restored as current.');
      transition(entry, operation, { lifecycleState: 'active', deletedAt: null, validUntil: nextValidity });
    } else if (operation === 'supersede') {
      replacementId = randomUUID();
      state.taskMemories[replacementId] = {
        ...clone(entry), id: replacementId, text: text.trim(), taskId: entry.taskId || null,
        lifecycleState: 'active', deletedAt: null, validUntil: validMemoryDate(replacement?.validUntil ?? nextValidity),
        supersededBy: null, supersedes: id, createdAt: at, updatedAt: at, versions: []
      };
      snapshot(state.taskMemories[replacementId], 'supersede');
      transition(entry, operation, { lifecycleState: 'superseded', supersededBy: replacementId, deletedAt: null });
      if (entry.taskId) history(state, entry.taskId, 'memory_supersede', `A memory was corrected. The prior version remains available as history.`, at);
    }
    if (operation !== 'supersede') history(state, memory.taskId, `memory_${operation}`, `User changed a memory scoped to ${entry.scope.entity} / ${entry.scope.deliverable} (${operation}).`, at);
    // The origin task keeps its task-local direction. Memory edits apply to
    // other matching tasks, including future tasks, within the stated scope.
    for (const task of Object.values(state.tasks)) if (!terminal(task) && !task.action && !task.guidance &&
      normal(task.request?.subjectEntity) === normal(entry.scope.entity) && normal(task.request?.deliverable) === normal(entry.scope.deliverable)) invalidate(task, at);
  }, { afterSync: afterSync ? () => afterSync(replacementId || id) : null });
  for (const task of Object.values(engine.store.state.tasks)) if (!terminal(task) && !task.action && !task.guidance &&
    normal(task.request?.subjectEntity) === normal(memory.scope.entity) && normal(task.request?.deliverable) === normal(memory.scope.deliverable)) engine.recheckTaskGuidance(task.id);
  engine.changed();
  return engine.store.state.taskMemories[replacementId || id];
}
