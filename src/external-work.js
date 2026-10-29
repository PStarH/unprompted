export const GITHUB_WORK_KINDS = Object.freeze(['external_issue', 'external_review', 'external_change', 'external_check']);
export const isSourceFollowTask = task => task?.kind === 'observed_task' || GITHUB_WORK_KINDS.includes(task?.kind);

const GITHUB_WORK = {
  'pull_request.updated': { kind: 'external_review', prefix: 'review', deliverable: 'pull_request',
    summary: work => `GitHub pull request · ${work.repository} #${work.number} · ${work.title}`,
    open: 'Following a pull request that asks the connected account to review it or to address review comments.',
    closed: 'The pull request is closed, merged, or no longer asks this account to act. No agent action was executed.',
    found: work => `Discovered a GitHub pull request: ${work.repository} #${work.number}.`,
    changed: work => `Updated a GitHub pull request: ${work.repository} #${work.number}.`,
    withdrew: 'The GitHub source withdrew this pull request. No completion or external action was claimed.' },
  'content.changed': { kind: 'external_change', prefix: 'change', deliverable: 'repository_change',
    summary: work => `GitHub commit · ${work.repository} · ${work.marker} · ${work.title}`,
    open: 'Following a commit that changed repository content.',
    closed: 'This repository change is no longer available. No agent action was executed.',
    found: work => `Discovered a repository change: ${work.repository} ${work.marker}.`,
    changed: work => `Updated a repository change: ${work.repository} ${work.marker}.`,
    withdrew: 'The GitHub source withdrew this repository change. No completion or external action was claimed.' },
  'workflow.updated': { kind: 'external_check', prefix: 'check', deliverable: 'workflow_run',
    summary: work => `GitHub Actions · ${work.repository} · ${work.marker} · ${work.title}`,
    open: 'Following a GitHub Actions run that changed and needs attention.',
    closed: 'This Actions run is no longer available. No agent action was executed.',
    found: work => `Discovered a GitHub Actions run: ${work.repository} ${work.marker}.`,
    changed: work => `Updated a GitHub Actions run: ${work.repository} ${work.marker}.`,
    withdrew: 'The GitHub source withdrew this Actions run. No completion or external action was claimed.' }
};

/** Track provider facts as native work; external closure is never agent success. */
export function ingestGitHubWork(store, event) {
  const spec = GITHUB_WORK[event.type];
  const work = event.payload, id = `${spec.prefix}:${work.id}`;
  let created = false;
  store.mutate(state => {
    state.events.push(event);
    const existing = state.tasks[id];
    event.summary = spec.summary(work);
    const active = work.active === true && work.state === 'open';
    event.relations = existing || active ? [id] : [];
    if (existing && existing.externalSource.state !== 'unavailable' && work.state !== 'unavailable'
      && Date.parse(existing.externalSource.updatedAt) > Date.parse(work.updatedAt)) { event.disposition = 'stale_change'; return; }
    if (!existing && !active) { event.disposition = 'observed'; return; }
    created = !existing;
    const closed = !active;
    const dismissed = existing?.userDismissed === true;
    const at = new Date().toISOString();
    const request = { id, intent: 'follow_up', subjectEntity: work.repository, deliverable: spec.deliverable,
      requiredContent: [], deadline: null, interpretedBy: 'provider_assignment',
      source: { kind: spec.deliverable, id: work.id, url: work.url, connectorId: 'github', from: work.author, to: work.accountId } };
    state.tasks[id] = { ...(existing || {}), id, kind: spec.kind, sourceConnectorId: 'github',
      subject: work.title, sender: work.author || 'GitHub', request,
      status: closed || dismissed ? 'cancelled' : 'waiting_for_information',
      externalSource: { ...work }, owner: { id: work.accountId || 'user', label: work.accountId || 'You', source: 'provider_assignment' },
      createdAt: existing?.createdAt || at, updatedAt: at, documentId: null, draft: null, action: null,
      evidence: { criteria: [], claims: [], unknowns: [], source: { kind: spec.deliverable, id: work.id, url: work.url, timestamp: work.updatedAt } },
      assessment: null, actionVersion: 0, reasoningWork: null,
      reason: closed ? spec.closed : dismissed ? existing.reason : spec.open };
    event.disposition = created ? 'discovered_request' : closed ? 'request_withdrawn' : 'related_change';
    state.history.push({ id: `h-${state.history.length + 1}`, at, kind: created ? 'discovery' : 'source_update',
      text: closed ? spec.withdrew : created ? spec.found(work) : spec.changed(work), taskId: id, eventId: event.id });
  });
  return { taskId: id, discovered: created };
}

/** Track provider facts as native work; external closure is never agent success. */
export function ingestAssignedIssue(store, event) {
  const issue = event.payload, id = `issue:${issue.id}`;
  let created = false;
  store.mutate(state => {
    state.events.push(event);
    const existing = state.tasks[id];
    event.summary = `GitHub issue · ${issue.repository} #${issue.number} · ${issue.title}`;
    event.relations = existing || issue.assigned && issue.state === 'open' ? [id] : [];
    if (existing && existing.externalSource.state !== 'unavailable' && issue.state !== 'unavailable'
      && Date.parse(existing.externalSource.updatedAt) > Date.parse(issue.updatedAt)) { event.disposition = 'stale_change'; return; }
    if (!existing && (!issue.assigned || issue.state !== 'open')) { event.disposition = 'observed'; return; }
    created = !existing;
    const closed = !issue.assigned || issue.state !== 'open';
    const dismissed = existing?.userDismissed === true;
    const at = new Date().toISOString();
    const request = { id, intent: 'follow_up', subjectEntity: issue.repository, deliverable: 'issue',
      requiredContent: [], deadline: null, interpretedBy: 'provider_assignment',
      source: { kind: 'github_issue', id: issue.id, url: issue.url, connectorId: 'github', from: issue.author, to: issue.assignee } };
    state.tasks[id] = { ...(existing || {}), id, kind: 'external_issue', sourceConnectorId: 'github',
      subject: issue.title, sender: issue.author || 'GitHub', request,
      status: closed || dismissed ? 'cancelled' : 'waiting_for_information',
      externalSource: { ...issue }, owner: { id: issue.assignee || 'user', label: issue.assignee || 'You', source: 'provider_assignment' },
      createdAt: existing?.createdAt || at, updatedAt: at, documentId: null, draft: null, action: null,
      evidence: { criteria: [], claims: [], unknowns: [], source: { kind: 'github_issue', id: issue.id, url: issue.url, timestamp: issue.updatedAt } },
      assessment: null, actionVersion: 0, reasoningWork: null,
      reason: closed ? 'The source issue is closed, unavailable, or no longer assigned to this account. No agent action was executed.'
        : dismissed ? existing.reason : 'Following an open issue assigned to the connected GitHub account.' };
    event.disposition = created ? 'discovered_request' : closed ? 'request_withdrawn' : 'related_change';
    state.history.push({ id: `h-${state.history.length + 1}`, at, kind: created ? 'discovery' : 'source_update',
      text: closed ? 'The GitHub source withdrew this active assignment. No completion or external action was claimed.'
        : `${created ? 'Discovered' : 'Updated'} an assigned GitHub issue: ${issue.repository} #${issue.number}.`, taskId: id, eventId: event.id });
  });
  return { taskId: id, discovered: created };
}

/** Retire one source account while preserving its historical local record. */
export function ingestObservedTask(store, event) {
  const observed = event.payload, id = `observed:${observed.id}`;
  let created = false;
  store.mutate(state => {
    state.events.push(event);
    const previous = state.tasks[id];
    event.summary = `Explicit local to-do · ${observed.title}`;
    event.relations = previous || observed.state === 'open' ? [id] : [];
    if (previous && previous.externalSource.sourceObservationRevision >= observed.sourceObservationRevision) { event.disposition = 'stale_change'; return; }
    if (!previous && observed.state !== 'open') { event.disposition = 'observed'; return; }
    created = !previous;
    const dismissed = previous?.userDismissed === true, closed = observed.state !== 'open', at = new Date().toISOString();
    const request = { id, intent: 'follow_up', subjectEntity: observed.documentTitle, deliverable: 'local_task', requiredContent: [], deadline: null,
      interpretedBy: 'explicit_source_todo', text: observed.title, source: { kind: event.connectorId, id: observed.documentId,
        url: observed.url, connectorId: event.connectorId, locator: `line:${observed.line}` } };
    state.tasks[id] = { ...(previous || {}), id, kind: 'observed_task', sourceConnectorId: event.connectorId,
      subject: observed.title, sender: observed.documentTitle, request, externalSource: { ...observed },
      owner: { id: 'user', label: 'You', source: 'explicit_source_todo' },
      status: closed || dismissed ? 'cancelled' : 'waiting_for_information', userDismissed: dismissed,
      createdAt: previous?.createdAt || at, updatedAt: at, documentId: observed.documentId,
      draft: null, action: null, actionVersion: 0, assessment: null, reasoningWork: null,
      evidence: { criteria: [], claims: [], unknowns: [], source: { ...request.source, timestamp: observed.updatedAt } },
      reason: closed ? 'The source to-do was checked off, removed, or became unavailable. This is not an agent completion.'
        : dismissed ? previous.reason : 'Following an explicit to-do in a selected local source.' };
    event.disposition = created ? 'discovered_request' : closed ? 'request_withdrawn' : 'related_change';
    state.history.push({ id: `h-${state.history.length + 1}`, at, kind: created ? 'discovery' : 'source_update', taskId: id, eventId: event.id,
      text: closed ? 'This source to-do is no longer actively followed. No agent completion was claimed.' : `Following the explicit source to-do: ${observed.title}` });
  });
  return { taskId: id, discovered: created };
}

export function bindConnectionAccount(store, connectorId, accountId) {
  const previous = store.state.connectionAccounts?.[connectorId];
  if (previous === accountId) return false;
  store.mutate(state => {
    if (previous) {
      for (const task of Object.values(state.tasks)) {
        if (task.sourceConnectorId !== connectorId || task.status === 'completed' || task.action) continue;
        task.status = 'cancelled'; task.userDismissed = true; task.draft = null;
        task.reason = 'This source account was disconnected or changed. Its historical work is no longer actively observed.';
        task.updatedAt = new Date().toISOString();
        if (task.reasoningWork) { task.reasoningWork.status = 'cancelled'; task.reasoningWork.nextAttemptAt = null; }
      }
      delete state.cursors?.[connectorId]; delete state.connectorStatus?.[connectorId];
      for (const notice of state.notifications || []) {
        if (notice.taskId && state.tasks[notice.taskId]?.sourceConnectorId === connectorId && !notice.resolvedAt) notice.resolvedAt = new Date().toISOString();
      }
    }
    state.connectionAccounts = { ...(state.connectionAccounts || {}), [connectorId]: accountId || null };
  });
  return Boolean(previous);
}
