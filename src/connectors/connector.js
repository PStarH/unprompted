import { PLATFORM_APIS, API_METHODS, performPlatformRequest } from './platform-api.js';
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
  platformCapabilities() { const api = PLATFORM_APIS[this.id]; return api ? { available: this.live, origin: api.origin, methods: API_METHODS, authorization: api.authorization, scopeEnforcedBy: 'provider', writesRequireUserGrant: true } : null; }

  requestApi(input, context) { return performPlatformRequest(this, input, context); }

  capabilities() { return { read: [], search: [], pagination: [], incremental: [], observation: 'none', providerPush: false, write: [], verify: [] }; }

  describe() {
    return { id: this.id, kind: this.kind, live: this.live, shadow: Boolean(this.shadow), ...this.validate(), capabilities: this.capabilities(), platformApi: this.platformCapabilities() };
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

  observe(connectorId, observation) {
    // A small durable heartbeat, separate from the large content snapshot.
    if (this.store.database) this.store.database.atomic(() => this.store.database.set(`connector_observation:${connectorId}`, JSON.stringify(observation)));
    else { this.observations ||= new Map(); this.observations.set(connectorId, observation); }
  }

  observation(connectorId) {
    return this.store.database ? JSON.parse(this.store.database.get(`connector_observation:${connectorId}`, 'null')) : this.observations?.get(connectorId) || null;
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

/**
 * Checkpoints acknowledge ingested provider pages, never wall-clock success.
 * complete: acknowledge cursor; partial: acknowledge successful scopes/pages only;
 * failed: retain checkpoint; expired: re-enumerate before establishing a baseline.
 * `recovering`/`hasMore` prevent a recovery page from claiming complete coverage.
 */
export function acknowledgedCursor(previous, pulled) {
  const outcomes = pulled.scopes;
  if (!outcomes) return pulled.cursor ?? previous;
  const next = { ...(previous || {}) };
  for (const [scope, result] of Object.entries(outcomes)) {
    if (!['complete', 'partial', 'failed', 'recovering'].includes(result?.status)) throw new ConnectorError('Invalid scope checkpoint outcome.');
    if (result.status === 'failed') continue;
    if (!Object.hasOwn(result, 'cursor')) throw new ConnectorError('An acknowledged scope requires its checkpoint.');
    next[scope] = result.cursor;
  }
  return next;
}
