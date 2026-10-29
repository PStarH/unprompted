import { normalizeEvent, validateEventPayload } from './events.js';

/** Native provider identifiers and filesystem metadata stay in private cursors. */
export function publicSourceCursors(cursors = {}) {
  return Object.fromEntries(Object.entries(cursors).map(([id, cursor]) => [id,
    ['local_files', 'apple_notes'].includes(id) && cursor ? { documentsObserved: Object.keys(cursor.documents || {}).length, counts: cursor.counts || {} }
      : cursor ? { checkpointStored: true, ...(cursor.recovering === true ? { recovering: true } : {}) } : null]));
}

/**
 * Connector boundary.
 *
 * A connector turns one provider's world into normalized events and, where the
 * provider supports it, performs and verifies consequential actions. Core task
 * reasoning never imports provider code.
 *
 * Contract:
 *   validate()                      -> { ok, missing[], detail }
 *   pull({ cursor })                -> { events[], cursor, partial }
 *   execute(payload, ctx)           -> { receiptId, provider }
 *   verify(idempotencyKey)          -> { status: 'found'|'not_found'|'unknown', receipt }
 *
 * Failures must surface as errors. A connector must never return an empty event
 * list to mask an error, because that would look like "nothing happened" and
 * would quietly downgrade live data to a simulated success.
 */

export class ConnectorError extends Error {
  constructor(message, { connectorId = null, status = null, retryable = false, timeout = false } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.connectorId = connectorId;
    this.status = status;
    this.retryable = retryable;
    this.timeout = timeout;
  }
}

export class Connector {
  constructor({ id, kind, fetchImpl = globalThis.fetch }) {
    this.id = id;
    this.kind = kind;
    this.fetchImpl = fetchImpl;
    this.live = false;
  }

  validate() { return { ok: true, missing: [], detail: 'No configuration required.' }; }

  // eslint-disable-next-line no-unused-vars
  async pull({ cursor = null } = {}) { throw new ConnectorError(`${this.id} does not implement pull()`); }

  async prepare() { return { prepared: false, detail: 'Preparation is handled by the engine.' }; }

  async execute() { throw new ConnectorError(`${this.id} cannot execute external actions`); }

  async verify() { return { status: 'unknown', receipt: null }; }

  /** Bounded history discovery. The default is honest unavailability, not an empty mailbox. */
  async listHistoricalEvents() { return { events: [], networkCalls: 0, unavailable: true }; }

  // Enabled operations for this configured instance, never provider marketing
  // capabilities or evidence that a remote grant is still valid.
  capabilities() { return { read: [], search: [], pagination: [], incremental: [], observation: 'none', providerPush: false, write: [], verify: [] }; }

  describe() {
    return { id: this.id, kind: this.kind, live: this.live, shadow: Boolean(this.shadow), ...this.validate(), capabilities: this.capabilities() };
  }
}

/**
 * Cursor store. Incremental sync state lives in the persisted application state,
 * so a restart resumes from the last acknowledged position instead of
 * re-reading the whole mailbox or drive.
 */
export class CursorStore {
  constructor(store) {
    this.store = store;
  }

  get(connectorId) {
    return this.store.state.cursors?.[connectorId] || null;
  }

  set(connectorId, cursor) {
    this.store.mutate(state => {
      state.cursors = state.cursors || {};
      state.cursors[connectorId] = cursor;
    });
  }

  status(connectorId, patch) {
    this.store.mutate(state => {
      state.connectorStatus = state.connectorStatus || {};
      state.connectorStatus[connectorId] = {
        ...(state.connectorStatus[connectorId] || {}),
        ...patch,
        updatedAt: new Date().toISOString()
      };
    });
  }

  describe() {
    return {
      cursors: publicSourceCursors(this.store.state.cursors),
      status: this.store.state.connectorStatus || {}
    };
  }
}

/** Shared helper: build normalized events from provider records. */
export function toNormalizedEvents(connectorId, source, records) {
  return records.map(record => {
    const event = normalizeEvent({ connectorId, source, ...record });
    validateEventPayload(event);
    return event;
  });
}

export const connectorApi = { Connector, ConnectorError, CursorStore, toNormalizedEvents };
