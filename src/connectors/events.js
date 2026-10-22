/**
 * Normalized event envelope.
 *
 * Everything entering the engine — simulated or live — takes this shape, so the
 * reasoning layer never depends on a provider's payload format. Provider
 * identifiers and timestamps are preserved so evidence can cite them later.
 */

export const EVENT_TYPES = ['email.received', 'document.modified', 'document.unavailable', 'record.published', 'experiment.run.completed'];

/** Registry publications: the generalized name plus the original experiment-only one. */
export const REGISTRY_EVENT_TYPES = ['record.published', 'experiment.run.completed'];

export const SOURCES = ['simulated', 'google'];

export class EventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventValidationError';
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
  if (event.type === 'email.received') return validateEmailPayload(event.payload);
  if (event.type === 'document.modified') return validateDocumentPayload(event.payload);
  if (event.type === 'document.unavailable') return validateDocumentUnavailablePayload(event.payload);
  if (REGISTRY_EVENT_TYPES.includes(event.type)) return validateRunPayload(event.payload);
  throw new EventValidationError(`Unsupported event type: ${event.type}`);
}

export const eventsApi = { EVENT_TYPES, REGISTRY_EVENT_TYPES, SOURCES, normalizeEvent, validateEventPayload, EventValidationError };
