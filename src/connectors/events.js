/**
 * Normalized event envelope.
 *
 * Everything entering the engine — simulated or live — takes this shape, so the
 * reasoning layer never depends on a provider's payload format. Provider
 * identifiers and timestamps are preserved so evidence can cite them later.
 */

export const EVENT_TYPES = ['email.received', 'issue.updated', 'pull_request.updated', 'content.changed', 'workflow.updated', 'task.observed', 'document.modified', 'document.unavailable', 'record.published', 'experiment.run.completed', 'timer.due'];

/** Registry publications: the generalized name plus the original experiment-only one. */
export const REGISTRY_EVENT_TYPES = ['record.published', 'experiment.run.completed'];

export const SOURCES = ['simulated', 'google', 'github', 'microsoft', 'slack', 'notion', 'local_files', 'apple_notes', 'internal'];

export class EventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventValidationError';
  }
}

export function validateRecordId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 2048
    || value === '__proto__' || value === 'constructor' || value === 'prototype') {
    throw new EventValidationError('Payload id must be a non-reserved record identifier.');
  }
}

/**
 * Build a normalized event. The id is namespaced by connector so two providers
 * cannot collide, and re-delivery of the same provider event is detectable.
 */
export function normalizeEvent({ connectorId = 'local', providerEventId, type, at, payload, source = 'simulated', meta = {} }) {
  if (!providerEventId) throw new EventValidationError('A normalized event requires a provider event id');
  if (!EVENT_TYPES.includes(type)) throw new EventValidationError(`Unsupported event type: ${type}`);
  if (!SOURCES.includes(source)) throw new EventValidationError(`Unsupported event source: ${source}`);
  if (!payload || typeof payload !== 'object') throw new EventValidationError('A normalized event requires a payload');
  return {
    id: `${connectorId}:${providerEventId}`,
    providerEventId,
    connectorId,
    type,
    at: at || new Date().toISOString(),
    source,
    payload,
    meta
  };
}

export function validateEmailPayload(payload) {
  const missing = ['id', 'from', 'subject', 'body'].filter(field => !payload?.[field]);
  if (missing.length) throw new EventValidationError(`Email payload is missing: ${missing.join(', ')}`);
  return true;
}

export function validateDocumentPayload(payload) {
  const missing = ['id', 'title'].filter(field => !payload?.[field]);
  if (missing.length) throw new EventValidationError(`Document payload is missing: ${missing.join(', ')}`);
  if (typeof payload.content !== 'string') throw new EventValidationError('Document payload requires text content');
  return true;
}

/**
 * A document that was removed, trashed, or lost access. The id is enough to
 * invalidate local evidence; title and reason are advisory context for the
 * audit trail. This event never carries content and never asserts a new version.
 */
export function validateDocumentUnavailablePayload(payload) {
  if (!payload?.id) throw new EventValidationError('Document unavailable payload is missing: id');
  return true;
}

function validateGitHubWork(event) {
  const work = event.payload;
  let url;
  try { url = new URL(work?.url); }
  catch { throw new EventValidationError('GitHub work payload is incomplete or invalid.'); }
  const common = work?.id && typeof work.title === 'string' && work.repository && typeof work.active === 'boolean'
    && ['open', 'closed', 'unavailable'].includes(work.state) && Number.isFinite(Date.parse(work.updatedAt))
    && url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password;
  if (!common) throw new EventValidationError('GitHub work payload is incomplete or invalid.');
  if (event.type === 'pull_request.updated' && (!Number.isSafeInteger(work.number) || !['review_requested', 'changes_requested'].includes(work.work))) throw new EventValidationError('Pull request payload is incomplete or invalid.');
  if (event.type === 'content.changed' && (typeof work.sha !== 'string' || !/^[a-f0-9]{40}$/.test(work.sha) || !Array.isArray(work.files))) throw new EventValidationError('Repository change payload is incomplete or invalid.');
  if (event.type === 'workflow.updated' && !Number.isSafeInteger(work.runId)) throw new EventValidationError('Actions payload is incomplete or invalid.');
  return true;
}

export function validateRunPayload(payload) {
  const missing = ['id', 'completedAt'].filter(field => !payload?.[field]);
  if (missing.length) throw new EventValidationError(`Run record payload is missing: ${missing.join(', ')}`);
  return true;
}

export function validateEventPayload(event) {
  validateRecordId(event.payload?.id);
  if (event.type === 'timer.due') {
    if (event.source !== 'internal' || event.connectorId !== 'scheduler' || typeof event.payload.situationId !== 'string' || !event.payload.situationId
      || !Number.isFinite(Date.parse(event.payload.scheduledAt))) throw new EventValidationError('Situation timer payload is invalid.');
    return true;
  }
  if (event.type === 'task.observed') {
    const item = event.payload;
    if (!['local_files', 'apple_notes'].includes(event.connectorId) || event.source !== event.connectorId
      || typeof item.id !== 'string' || !item.id.startsWith(`${event.connectorId}:${item.accountId}:`) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500
      || !['open', 'closed', 'unavailable'].includes(item.state) || typeof item.documentId !== 'string' || !item.documentId.startsWith(`${event.connectorId}:`)
      || typeof item.accountId !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))
      || !Number.isSafeInteger(item.sourceObservationRevision) || item.sourceObservationRevision < 1
      || typeof item.url !== 'string' || !Number.isSafeInteger(item.line) || item.line < 1) throw new EventValidationError('Local task payload is invalid or outside its native source.');
    const url = new URL(item.url, 'http://127.0.0.1');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password
      || url.pathname !== `/api/local-sources/documents/${encodeURIComponent(item.documentId)}` || url.search || url.hash) throw new EventValidationError('Local source URL is invalid.');
    return true;
  }
  if (event.type === 'issue.updated') {
    const issue = event.payload;
    if (!issue?.id || typeof issue.title !== 'string' || !issue.repository || !Number.isSafeInteger(issue.number)
      || typeof issue.assigned !== 'boolean' || !['open', 'closed', 'unavailable'].includes(issue.state)
      || !Number.isFinite(Date.parse(issue.updatedAt)) || typeof issue.url !== 'string') throw new EventValidationError('Issue payload is incomplete or invalid.');
    const url = new URL(issue.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) throw new EventValidationError('Issue source URL is invalid.');
    return true;
  }
  if (event.type === 'pull_request.updated' || event.type === 'content.changed' || event.type === 'workflow.updated') return validateGitHubWork(event);
  if (event.type === 'email.received') return validateEmailPayload(event.payload);
  if (event.type === 'document.modified') return validateDocumentPayload(event.payload);
  if (event.type === 'document.unavailable') return validateDocumentUnavailablePayload(event.payload);
  if (REGISTRY_EVENT_TYPES.includes(event.type)) return validateRunPayload(event.payload);
  throw new EventValidationError(`Unsupported event type: ${event.type}`);
}

export const eventsApi = { EVENT_TYPES, REGISTRY_EVENT_TYPES, SOURCES, normalizeEvent, validateEventPayload, EventValidationError };
