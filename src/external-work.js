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
