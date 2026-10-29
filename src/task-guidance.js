import { randomUUID } from 'node:crypto';
import { analyseRequest, extractRequiredContent } from './requests.js';
import { isSourceFollowTask } from './external-work.js';

const normal = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const clone = value => value == null ? null : structuredClone(value);
const terminal = task => ['completed', 'cancelled'].includes(task.status) || task.userDismissed;

export function matchingTaskMemories(task, state) {
  const entity = normal(task.request?.subjectEntity), deliverable = normal(task.request?.deliverable);
  if (!entity || !deliverable) return [];
  return Object.values(state.taskMemories || {}).filter(item => !item.deletedAt &&
    normal(item.scope?.entity) === entity && normal(item.scope?.deliverable) === deliverable);
}

// Directions add grounded requirements; they never change recipients, source
// identity, permissions, or mark an existing action as undone.
export function effectiveTaskRequest(task, state) {
  const request = task.request;
  if (!request) return request;
  // A task-local correction wins over shared preferences. Original request
  // requirements remain in place; memory is still available to other tasks.
  const directions = task.guidance ? [task.guidance] : matchingTaskMemories(task, state);
  if (!directions.length) return request;
  const text = [request.text || '', ...directions.map(item => `User direction: ${item.text}`)].join('\n\n');
  const requiredContent = [...(request.requiredContent || [])];
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

export function directTask(engine, taskId, { text, scope = 'task' } = {}) {
  const task = requireEditable(engine, taskId);
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 2000) throw new Error('A direction requires 1–2000 characters.');
  if (!['task', 'similar'].includes(scope)) throw new Error('Invalid memory scope.');
  if (scope === 'similar' && (!task.request?.subjectEntity || !task.request?.deliverable)) throw new Error('Similar-task memory requires an identified project and deliverable.');
  const at = new Date().toISOString(), id = randomUUID();
  engine.store.mutate(state => {
    state.taskDirections ||= {};
    state.taskMemories ||= {};
    const target = state.tasks[taskId];
    const memoryId = scope === 'similar' ? randomUUID() : null;
    const direction = { id, text: text.trim(), scope, at, memoryId };
    state.taskDirections[id] = { ...direction, taskId, previous: clone(target.guidance), active: true, executedActionsAffected: false };
    if (memoryId) {
      state.taskMemories[memoryId] = { id: memoryId, text: direction.text, taskId,
        scope: { entity: task.request.subjectEntity, deliverable: task.request.deliverable }, createdAt: at, updatedAt: at, deletedAt: null };
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
  if (memory && !memory.deletedAt && memory.updatedAt !== direction.at) throw new Error('The linked memory changed. Review or remove it before undoing this direction.');
  const at = new Date().toISOString();
  engine.store.mutate(state => {
    const entry = state.taskDirections[id];
    entry.active = false; entry.undoneAt = at;
    if (memory && !memory.deletedAt) {
      state.taskMemories[entry.memoryId].deletedAt = at;
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

export function updateTaskMemory(engine, id, { operation, text, version } = {}) {
  const memory = engine.store.state.taskMemories?.[id];
  if (!memory) throw new Error('Unknown memory.');
  if (version !== memory.updatedAt) throw new Error('This memory changed. Review its latest version.');
  if (!['edit', 'delete', 'restore'].includes(operation)) throw new Error('Invalid memory operation.');
  if (operation === 'edit' && (memory.deletedAt || typeof text !== 'string' || !text.trim() || text.trim().length > 2000)) throw new Error('An active memory requires 1–2000 characters.');
  const at = new Date(Math.max(Date.now(), Date.parse(memory.updatedAt) + 1)).toISOString();
  engine.store.mutate(state => {
    const entry = state.taskMemories[id];
    if (operation === 'edit') entry.text = text.trim();
    if (operation === 'delete') entry.deletedAt = at;
    if (operation === 'restore') entry.deletedAt = null;
    entry.updatedAt = at;
    history(state, memory.taskId, `memory_${operation}`, `User ${operation}d a memory scoped to ${entry.scope.entity} / ${entry.scope.deliverable}.`, at);
    // The origin task keeps its task-local direction. Memory edits apply to
    // other matching tasks, including future tasks, within the stated scope.
    for (const task of Object.values(state.tasks)) if (!terminal(task) && !task.action && !task.guidance &&
      normal(task.request?.subjectEntity) === normal(entry.scope.entity) && normal(task.request?.deliverable) === normal(entry.scope.deliverable)) invalidate(task, at);
  });
  for (const task of Object.values(engine.store.state.tasks)) if (!terminal(task) && !task.action && !task.guidance &&
    normal(task.request?.subjectEntity) === normal(memory.scope.entity) && normal(task.request?.deliverable) === normal(memory.scope.deliverable)) engine.recheckTaskGuidance(task.id);
  engine.changed();
  return engine.store.state.taskMemories[id];
}
