import crypto from 'node:crypto';

const ACTIVE = new Set(['newly_discovered', 'waiting_for_information', 'ready_for_approval', 'verifying', 'blocked']);
const norm = value => String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const words = value => norm(value).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'unknown';
const dateMs = value => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

function criterionDependency(task, criterion) {
  const entity = norm(task.request?.subjectEntity);
  const deliverable = norm(task.request?.deliverable);
  const deadline = task.request?.deadline?.iso || 'no-deadline';
  const provider = criterion.probe?.provider;
  const blocked = criterion.status === 'blocked';
  const citedDocument = criterion.evidence?.[0]?.source?.id || task.documentId || null;
  const requestScope = task.request?.explicitDocumentUrl || task.request?.source?.threadId || task.sourceEmailId || 'unknown-source';
  const kind = blocked && provider ? `provider:${provider}` : `criterion:${criterion.id || words(criterion.label)}`;
  // Aggregate only when the target, requirement, source scope, and time window
  // agree. A shared project name alone is not enough to ask once for different
  // documents or deliverables.
  const scope = blocked && provider
    ? [entity, deliverable, deadline].join(':')
    : [entity, deliverable, citedDocument || requestScope, deadline].join(':');
  const key = `${kind}:${scope}`;
  const id = `dependency:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  return {
    id,
    key,
    label: blocked && provider
      ? `Evidence source “${provider}” for ${criterion.label || 'this requirement'}`
      : `${task.request?.subjectEntity ? `${task.request.subjectEntity}: ` : ''}${criterion.label || 'Requested information'}`,
    criterionId: criterion.id || null,
    entity: task.request?.subjectEntity || null,
    status: 'open',
    source: criterion.evidence?.[0]?.source ? { ...criterion.evidence[0].source } : null,
    taskIds: []
  };
}

/** Aggregate matching unmet requirements across live tasks under one stable dependency key. */
export function aggregateTaskDependencies(state, now = new Date().toISOString()) {
  const groups = new Map();
  const taskIdsByGroup = new Map();
  const criterionIdsByGroup = new Map();
  const decisions = state.dependencyDecisions || {};
  for (const task of Object.values(state.tasks || {})) {
    if (!ACTIVE.has(task.status) || task.status === 'cancelled' || task.status === 'completed' || task.userDismissed) continue;
    for (const criterion of task.evidence?.criteria || []) {
      if (criterion.required === false || criterion.status === 'satisfied') continue;
      const dependency = criterionDependency(task, criterion);
      let group = groups.get(dependency.id);
      if (!group) {
        group = { ...dependency, taskIds: [], criterionIds: [], openedAt: now };
        groups.set(dependency.id, group);
        taskIdsByGroup.set(dependency.id, new Set());
        criterionIdsByGroup.set(dependency.id, new Set());
      }
      const taskIds = taskIdsByGroup.get(dependency.id);
      if (!taskIds.has(task.id)) {
        taskIds.add(task.id);
        group.taskIds.push(task.id);
      }
      const criterionIds = criterionIdsByGroup.get(dependency.id);
      if (dependency.criterionId && !criterionIds.has(dependency.criterionId)) {
        criterionIds.add(dependency.criterionId);
        group.criterionIds.push(dependency.criterionId);
      }
      group.openedAt = [group.openedAt, task.progress?.at, task.createdAt].filter(Boolean).sort()[0] || now;
    }
  }
  return [...groups.values()].map(group => {
    const decision = decisions[group.id];
    return {
      ...group,
      taskIds: group.taskIds.sort(),
      criterionIds: group.criterionIds.sort(),
      decision: decision ? {
        ...decision,
        ...(Array.isArray(decision.taskIds) ? { taskIds: [...decision.taskIds] } : {}),
        ...(Array.isArray(decision.criterionIds) ? { criterionIds: [...decision.criterionIds] } : {})
      } : null,
      status: !decision ? 'open' : decision.decision === 'provided' ? 'answered_needs_recheck'
        : decision.decision === 'defer' ? 'deferred'
          : decision.decision === 'failed' ? 'failed_unresolved' : 'dismissed_unresolved'
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function ownerFor(task, state) {
  const explicit = task.management?.owner || task.followUp?.owner || task.owner;
  if (explicit?.id && explicit?.label) return { id: explicit.id, label: explicit.label, source: explicit.source || 'user_stated' };
  const wait = task.wait || (state.taskWaits || {})[task.id];
  if (wait?.status === 'active') {
    return { id: 'agent', label: 'Unprompted', source: 'persistent_wait' };
  }
  if (wait?.status === 'interrupted') return { id: 'user', label: 'You', source: 'risk_interruption' };
  if (task.status === 'ready_for_approval') {
    return { id: 'user', label: 'You', source: 'workflow_state' };
  }
  if (task.status === 'verifying') return { id: 'agent', label: 'Unprompted', source: 'workflow_state' };
  if (task.status === 'newly_discovered') return { id: 'agent', label: 'Unprompted', source: 'workflow_state' };
  return { id: 'unknown', label: 'Owner not identified', source: 'unknown' };
}

function nextActionFor(task, dependencies, owner, state) {
  if (task.status === 'completed' || task.followUp?.status === 'completed') {
    return { kind: 'done', label: 'Review the verified result', owner: owner.id, reason: 'The recorded outcome is complete.' };
  }
  if (task.status === 'cancelled' || task.userDismissed) {
    return { kind: 'closed', label: 'No further action', owner: owner.id, reason: task.reason || 'The user closed this work.' };
  }
  if (task.kind === 'external_issue') return { kind: 'review_source', label: 'Review the assigned GitHub issue',
    owner: owner.id, url: task.externalSource?.url, reason: 'The source assigns this open issue to the connected account; no agent completion is claimed.' };
  const wait = task.wait || (state.taskWaits || {})[task.id];
  if (wait?.status === 'active') {
    return { kind: 'wait', label: `Wait for ${wait.condition?.label || wait.kind}`, owner: 'agent', reason: 'Unprompted is watching this persisted event or time condition.' };
  }
  if (wait?.status === 'resolved') {
    return { kind: 'reassess', label: 'Recheck the task after its wait condition occurred', owner: 'agent', reason: 'The event or time condition occurred; the existing evidence still needs assessment.' };
  }
  if (task.status === 'ready_for_approval') {
    return { kind: 'approve', label: 'Review and approve the prepared result', owner: 'user', reason: 'The evidence check is complete; an external action still needs approval.' };
  }
  if (task.status === 'verifying' || ['executing', 'uncertain'].includes(task.action?.status)) {
    return { kind: 'verify', label: 'Confirm the provider result', owner: 'agent', reason: 'A provider action is in progress or its outcome needs reconciliation.' };
  }
  if (wait?.status === 'interrupted') {
    return { kind: 'decide', label: 'Review the interruption and choose what happens next', owner: 'user', reason: wait.interruption?.reason || 'A deadline or evidence risk interrupted the wait.' };
  }
  if (dependencies.length) {
    const unresolved = dependencies.filter(item => item.status === 'open');
    const first = unresolved[0] || dependencies.find(item => item.status !== 'answered_needs_recheck') || dependencies[0];
    if (!unresolved.length && first.status === 'deferred') {
      return { kind: 'decide', label: `Choose when to resume ${first.label}`, owner: 'user', reason: 'The shared dependency was deferred, but no wake condition has been set.' };
    }
    if (!unresolved.length && ['failed_unresolved', 'dismissed_unresolved'].includes(first.status)) {
      return { kind: 'decide', label: `Choose another source or close work blocked by ${first.label}`, owner: 'user', reason: 'The shared requirement remains unmet; dismissing its question did not verify the work.' };
    }
    return {
      kind: unresolved.length ? 'resolve_dependency' : 'recheck',
      label: unresolved.length ? `Resolve ${first.label}` : `Recheck ${first.label}`,
      owner: unresolved.length ? 'user' : 'agent',
      reason: unresolved.length
        ? `${first.taskIds.length} active task(s) share this unmet requirement.`
        : 'A shared answer was recorded, but it is not evidence that the deliverable is complete.'
    };
  }
  if (task.wait?.status === 'active') {
    return { kind: 'wait', label: `Wait for ${task.wait.condition?.label || task.wait.kind}`, owner: task.wait.owner?.id || 'external', reason: 'The wait condition is persisted and has not occurred yet.' };
  }
  if (task.status === 'waiting_for_information') {
    const missing = (task.assessment?.missing || []).join('; ');
    return { kind: 'provide_information', label: 'Provide the missing information or source', owner: owner.id, reason: missing || 'The current evidence does not satisfy the request.' };
  }
  return { kind: 'assess', label: 'Check current source documents against the request', owner: 'agent', reason: 'The task has not yet completed its evidence assessment.' };
}

function wakeFor(task, state, now) {
  const wait = task.wait || (state.taskWaits || {})[task.id] || null;
  if (wait) {
    return {
      kind: wait.status === 'interrupted' ? 'interruption' : wait.kind,
      condition: wait.interruption?.reason || wait.condition?.label || wait.condition?.description || wait.kind,
      at: wait.until || null,
      status: wait.status,
      waitId: wait.id
    };
  }
  const deadline = task.request?.deadline;
  if (deadline?.iso) {
    return { kind: 'time', condition: `Recheck before the ${deadline.iso} deadline`, at: deadline.iso, status: 'scheduled' };
  }
  const document = state.documents?.[task.documentId];
  if (task.status === 'waiting_for_information' && task.documentId) {
    return { kind: 'document', condition: `When document “${document.title || document.id}” changes`, at: null, status: 'waiting' };
  }
  return { kind: 'event', condition: 'When related evidence or a reply arrives', at: null, status: 'waiting' };
}

function priorityFor(task, now, state) {
  if (task.status === 'completed' || task.status === 'cancelled' || task.userDismissed) {
    return { level: 'low', score: 0, reasons: ['The task is closed.'] };
  }
  const reasons = [];
  let score = 30;
  const deadline = task.request?.deadline;
  const deadlineAt = deadline?.iso ? dateMs(`${deadline.iso}T23:59:59.999Z`) : null;
  if (deadlineAt != null && !deadline?.ambiguous) {
    const days = Math.ceil((deadlineAt - Date.parse(now)) / 86_400_000);
    if (days < 0) { score += 65; reasons.push(`Deadline passed ${Math.abs(days)} day(s) ago (${deadline.iso}).`); }
    else if (days <= 1) { score += 60; reasons.push(`Deadline is within 1 day (${deadline.iso}).`); }
    else if (days <= 3) { score += 45; reasons.push(`Deadline is within 3 days (${deadline.iso}).`); }
    else if (days <= 7) { score += 25; reasons.push(`Deadline is within 7 days (${deadline.iso}).`); }
    else reasons.push(`Deadline is ${days} days away (${deadline.iso}).`);
  } else if (deadline?.ambiguous) {
    score += 20;
    reasons.push('The written deadline is ambiguous and needs a reading decision.');
  }
  if (task.evidence?.conflicts?.length) { score += 25; reasons.push(`${task.evidence.conflicts.length} evidence conflict(s) need review.`); }
  if (task.action?.status === 'uncertain') { score += 30; reasons.push('The external result is uncertain and needs reconciliation.'); }
  if ((task.wait || (state.taskWaits || {})[task.id])?.status === 'interrupted') { score += 25; reasons.push('A risk interrupted the current wait.'); }
  if (task.status === 'ready_for_approval') { score += 10; reasons.push('A prepared result is waiting for a user decision.'); }
  const since = dateMs(task.progress?.at || task.createdAt);
  if (task.status === 'waiting_for_information' && since != null) {
    const daysWaiting = Math.floor(Math.max(0, Date.parse(now) - since) / 86_400_000);
    if (daysWaiting >= 1) {
      const ageScore = Math.min(15, Math.floor(daysWaiting / 2) * 3);
      score += ageScore;
      reasons.push(`The evidence has not changed for ${daysWaiting} day(s).`);
    }
  }
  score = Math.max(0, Math.min(100, score));
  const level = score >= 80 ? 'high' : score >= 55 ? 'medium' : 'normal';
  if (!reasons.length) reasons.push('No urgent deadline or unresolved execution risk is recorded.');
  return { level, score, reasons };
}

function projectTaskManagementWithDependencies(task, state, now, dependencies) {
  const owner = ownerFor(task, state);
  return {
    owner,
    nextAction: nextActionFor(task, dependencies, owner, state),
    dependencies,
    wake: wakeFor(task, state, now),
    priority: priorityFor(task, now, state)
  };
}

/** Pure, explainable single-task projection. It never writes back to task or state. */
export function projectTaskManagement(task, state = {}, now = new Date().toISOString()) {
  const dependencies = aggregateTaskDependencies(state, now).filter(item => item.taskIds.includes(task.id));
  return projectTaskManagementWithDependencies(task, state, now, dependencies);
}

/**
 * Project every task in one workspace from one dependency aggregation pass.
 * The Map is keyed by task ID and each value has the same public shape as
 * projectTaskManagement. No result is cached across workspace revisions.
 */
export function projectWorkspaceTaskManagement(tasks, state = {}, now = new Date().toISOString()) {
  const dependencies = aggregateTaskDependencies(state, now);
  const dependenciesByTask = new Map();
  for (const dependency of dependencies) {
    for (const taskId of dependency.taskIds) {
      const list = dependenciesByTask.get(taskId) || [];
      list.push(dependency);
      dependenciesByTask.set(taskId, list);
    }
  }
  const projected = new Map();
  for (const task of tasks) {
    projected.set(task.id, projectTaskManagementWithDependencies(
      task, state, now, dependenciesByTask.get(task.id) || []
    ));
  }
  return projected;
}

export const taskManagementApi = { aggregateTaskDependencies, projectTaskManagement, projectWorkspaceTaskManagement };
