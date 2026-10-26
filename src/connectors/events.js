/**
 * Normalized event envelope.
 *
 * Everything entering the engine — simulated or live — takes this shape, so the
 * reasoning layer never depends on a provider's payload format. Provider
 * identifiers and timestamps are preserved so evidence can cite them later.
 */

export const EVENT_TYPES = ['email.received', 'issue.updated', 'document.modified', 'document.unavailable', 'record.published', 'experiment.run.completed'];

/** Registry publications: the generalized name plus the original experiment-only one. */
export const REGISTRY_EVENT_TYPES = ['record.published', 'experiment.run.completed'];

export const SOURCES = ['simulated', 'google', 'github', 'microsoft'];

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

export function validateRunPayload(payload) {
  const missing = ['id', 'completedAt'].filter(field => !payload?.[field]);
  if (missing.length) throw new EventValidationError(`Run record payload is missing: ${missing.join(', ')}`);
  return true;
}

export function validateEventPayload(event) {
  validateRecordId(event.payload?.id);
  if (event.type === 'issue.updated') {
    const issue = event.payload;
    if (!issue?.id || typeof issue.title !== 'string' || !issue.repository || !Number.isSafeInteger(issue.number)
      || typeof issue.assigned !== 'boolean' || !['open', 'closed', 'unavailable'].includes(issue.state)
      || !Number.isFinite(Date.parse(issue.updatedAt)) || typeof issue.url !== 'string') throw new EventValidationError('Issue payload is incomplete or invalid.');
    const url = new URL(issue.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) throw new EventValidationError('Issue source URL is invalid.');
    return true;
  }
  if (event.type === 'email.received') return validateEmailPayload(event.payload);
  if (event.type === 'document.modified') return validateDocumentPayload(event.payload);
  if (event.type === 'document.unavailable') return validateDocumentUnavailablePayload(event.payload);
  if (REGISTRY_EVENT_TYPES.includes(event.type)) return validateRunPayload(event.payload);
  throw new EventValidationError(`Unsupported event type: ${event.type}`);
}

export const eventsApi = { EVENT_TYPES, REGISTRY_EVENT_TYPES, SOURCES, normalizeEvent, validateEventPayload, EventValidationError };
