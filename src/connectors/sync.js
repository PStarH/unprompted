import { acknowledgedCursor } from './connector.js';
import { publicFailureText, rateLimitDelay, repairForResult, sourceRepair } from './source-health.js';
/**
 * Connector sync runner.
 *
 * Pulls new events from live connectors and hands them to the engine. It lives
 * outside the HTTP layer so the behaviour that matters can be tested directly:
 *
 *   - cursor advancement is per-connector and per-scope, and only ever reflects
 *     what the provider actually acknowledged
 *   - a failure is recorded as a failure. It never produces synthetic events and
 *     never marks a connector healthy, because that would silently downgrade
 *     live data to a simulated success
 *   - a partial pull keeps the healthy scope's cursor and leaves the failed
 *     scope where it was, so the next run retries only the gap
 *   - runs never overlap
 *
 * Nothing here decides *what* work matters. It only moves events.
 */

const inFlightPulls = new WeakMap();

export class ConnectorSync {
  constructor({ connectors, cursors, engine, now = () => new Date().toISOString(), timeoutMs = null }) {
    this.connectors = connectors || [];
    this.cursors = cursors;
    this.engine = engine;
    this.now = now;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
    this.running = false;
    this.lastRunAt = null;
    this.pendingConnectors = new Map();
  }

  #revoked(connector) {
    return this.engine.durableRuntime?.privacy?.permissionRevoked?.(connector.id) === true;
  }

  /**
   * A hard ceiling for one connector pull.
   *
   * Connectors already bound their own requests, but a custom or misbehaving
   * connector must not hold the single `running` flag forever. A timed-out pull
   * has not returned a cursor, so nothing is committed and the next run retries
   * the same window.
   */
  async #pullWithTimeout(connector, cursor, signal) {
    if (inFlightPulls.has(connector)) throw new Error('The previous connector pull is still in flight.');
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener?.('abort', forwardAbort, { once: true });
    const pull = Promise.resolve().then(() => connector.pull({ cursor, signal: controller.signal }));
    inFlightPulls.set(connector, pull);
    const clear = () => {
      if (inFlightPulls.get(connector) === pull) inFlightPulls.delete(connector);
      signal?.removeEventListener?.('abort', forwardAbort);
    };
    pull.then(clear, clear);
    if (!this.timeoutMs) return pull;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => { controller.abort(); reject(new Error(`Connector pull timed out after ${this.timeoutMs}ms`)); },
        this.timeoutMs
      );
    });
    return Promise.race([pull, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * Run one sync pass over every live connector.
   * A concurrent call is skipped rather than queued, so a slow provider cannot
   * build up a backlog of overlapping passes.
   */
  async run({ excludeIds = [] } = {}) {
    if (this.running) return { skipped: 'A sync is already running.', results: [] };
    this.running = true;
    this.lastRunAt = this.now();
    const results = [];
    try {
      for (const connector of this.connectors) {
        if (!connector.live || excludeIds.includes(connector.id)) continue;
        const result = await this.runConnector(connector.id);
        if (!result.skipped) results.push(result);
      }
      return { results };
    } finally {
      this.running = false;
    }
  }

  /**
   * A trusted, synchronous authorization fence. Webhook-style callers pass a
   * callback that re-reads the current account, observation, revocation and
   * lifecycle state; ordinary polling and direct calls omit it and behave
   * exactly as before. A callback that throws is treated as no longer current.
   */
  #current(isCurrent) {
    if (!isCurrent) return true;
    try { return isCurrent() !== false; }
    catch { return false; }
  }

  #halted(signal, isCurrent) {
    return Boolean(signal?.aborted) || !this.#current(isCurrent);
  }

  /** Independent sources can progress concurrently; one source never overlaps itself. */
  runConnector(id, { afterCurrent = false, signal, isCurrent = null } = {}) {
    const guard = typeof isCurrent === 'function' ? isCurrent : null;
    if (this.#halted(signal, guard)) return Promise.resolve(this.#aborted(id));
    if (this.pendingConnectors.has(id)) {
      const pending = this.pendingConnectors.get(id);
      return afterCurrent ? pending.then(() => this.runConnector(id, { signal, isCurrent: guard })) : pending;
    }
    const connector = this.connectors.find(item => item.id === id);
    if (!connector?.live || this.#revoked(connector)) return Promise.resolve({ connector: id, skipped: 'Source unavailable.' });
    const pending = this.#syncOne(connector, signal, guard).finally(() => this.pendingConnectors.delete(id));
    this.pendingConnectors.set(id, pending);
    return pending;
  }

  #aborted(connectorId) {
    return { connector: connectorId, ingested: 0, duplicates: 0, failed: true, aborted: true, error: 'Observation stopped.' };
  }

  async #syncOne(connector, signal, isCurrent) {
    // A single observation can finish a small multi-page backlog promptly. Each
    // page commits only after its events are ingested, and the cap keeps one
    // large source from monopolising the observation loop.
    // Health is snapshotted before the pass. If the observation is stopped, a
    // page that already committed must not leave the source looking currently
    // healthy: the cursor stays (its events were ingested), the health record
    // returns to what it was before this pass began.
    const healthBefore = this.cursors.snapshotStatus?.(connector.id) ?? null;
    const observationBefore = this.cursors.observation?.(connector.id) ?? null;
    const pages = [], started = Date.now();
    for (let index = 0; index < 5; index++) {
      if (this.#halted(signal, isCurrent)) { pages.push(this.#aborted(connector.id)); break; }
      const result = await this.#syncPage(connector, signal, isCurrent);
      pages.push(result);
      if (result.failed || result.partial || !result.hasMore || this.#halted(signal, isCurrent) || Date.now() - started >= 30000) break;
    }
    const last = pages.at(-1);
    const aborted = pages.some(page => page.aborted);
    const summary = { ...last, ingested: pages.reduce((count, page) => count + (page.ingested || 0), 0),
      duplicates: pages.reduce((count, page) => count + (page.duplicates || 0), 0), pages: pages.length,
      ...(aborted ? { failed: true, aborted: true, error: 'Observation stopped.' } : {}) };
    // History discovery is a separate connector method and a second provider
    // entry in this run. The same trusted callback and abort signal reach it,
    // and the fence is checked again when it returns: an abandoned history
    // result is a failed observation, not a successful one with a warning.
    if (!summary.failed && !aborted && !this.#halted(signal, isCurrent) && this.engine.durableRuntime?.backfill) {
      try {
        const history = await this.engine.durableRuntime.backfill(connector.id, { once: true, signal, isCurrent });
        summary.history = history;
        if (history?.aborted || history?.blocked || this.#halted(signal, isCurrent)) {
          summary.failed = true;
          summary.aborted = true;
          summary.error = 'Observation stopped.';
        }
      } catch (error) {
        // An ordinary provider history failure keeps its previous semantics:
        // it is reported without marking the source unhealthy. A stopped or
        // unauthorized run must not be reported as a completed pull.
        if (this.#halted(signal, isCurrent)) {
          summary.failed = true;
          summary.aborted = true;
          summary.error = 'Observation stopped.';
        } else {
          summary.historyError = publicFailureText(error) || 'History backfill failed.';
        }
      }
    }
    // A stopped pass proves nothing about the source, even if an earlier page
    // in the same pass was acknowledged. Restore the health and observation
    // records captured before the pass; the cursor keeps the acknowledged page
    // because its events were already ingested.
    if (aborted) {
      this.cursors.restoreStatus?.(connector.id, healthBefore);
      this.cursors.observe?.(connector.id, observationBefore);
    }
    return summary;
  }

  async #syncPage(connector, signal, isCurrent) {
    const cursor = this.cursors.get(connector.id);
    if (this.#halted(signal, isCurrent)) return this.#aborted(connector.id);
    let pulled;
    try {
      pulled = await this.#pullWithTimeout(connector, cursor, signal);
      pulled.cursor = acknowledgedCursor(cursor, pulled);
      if (this.#halted(signal, isCurrent)) throw Object.assign(new Error('Observation stopped.'), { name: 'AbortError' });
      if (!connector.live || this.#revoked(connector)) throw new Error('The connector was disabled during synchronization.');
      if (!pulled || !Array.isArray(pulled.events) || (pulled.errors != null && !Array.isArray(pulled.errors))) {
        throw new Error('Connector returned an invalid pull result; the cursor was not advanced.');
      }
    } catch (error) {
      // An aborted observation proves nothing about provider health, and the
      // abandoned result must never advance the cursor or ingest events.
      if (this.#halted(signal, isCurrent)) return this.#aborted(connector.id);
      // The pull itself failed. Record it and ingest nothing. The stored
      // message is the public, redacted form; provider bodies, query strings,
      // account identifiers and credentials never enter the status record.
      const failure = {
        connector: connector.id,
        ingested: 0,
        duplicates: 0,
        failed: true,
        error: publicFailureText(error) || 'Connector pull failed.',
        status: Number.isFinite(Number(error.status)) ? Number(error.status) : null,
        retryable: error.retryable === true,
        rateLimited: error.rateLimited === true || Number(error.status) === 429,
        retryAfterMs: error.retryAfterMs ?? null, retryAfter: error.retryAfter ?? null
      };
      failure.retryAfterMs = rateLimitDelay({ results: [failure] }) || null;
      failure.repair = repairForResult(failure);
      this.cursors.status(connector.id, {
        ok: false,
        complete: false,
        lastError: failure.error,
        repair: failure.repair,
        rateLimited: failure.rateLimited,
        retryAfterMs: failure.retryAfterMs,
        eventsIngested: 0,
        lastSyncAt: this.now()
      });
      return failure;
    }

    // The page arrived while the facts were current, but the trusted fence is
    // checked again before any event enters the workspace.
    if (this.#halted(signal, isCurrent)) return this.#aborted(connector.id);
    const events = pulled.events;
    const cursorChanged = Boolean(pulled?.cursor) && JSON.stringify(cursor ?? null) !== JSON.stringify(pulled.cursor);
    if (pulled.hasMore === true && !cursorChanged) {
      const message = 'Connector pagination did not advance; the cursor was not changed.';
      const repair = sourceRepair({ message });
      this.cursors.status(connector.id, { ok: false, complete: false, lastError: message, repair, eventsIngested: 0, lastSyncAt: this.now() });
      return { connector: connector.id, ingested: 0, duplicates: 0, failed: true, error: message, repair };
    }
    let ingested = 0;
    let duplicates = 0;
    try { for (const event of events) {
      // Ingest is synchronous and idempotent; a replayed provider event is
      // counted rather than reprocessed.
      const outcome = this.engine.ingest(event);
      if (outcome?.disposition === 'permission_revoked') throw new Error('The connector was disabled during synchronization.');
      if (outcome?.duplicate) duplicates += 1;
      else ingested += 1;
    } } catch {
      const message = 'Connector event ingestion failed; the cursor was not advanced. The next sync will replay the batch.';
      const repair = sourceRepair({ message });
      this.cursors.status(connector.id, { ok: false, complete: false, lastError: message, repair, eventsIngested: ingested, eventsDuplicate: duplicates, lastSyncAt: this.now() });
      return { connector: connector.id, ingested, duplicates, failed: true, error: message, repair };
    }

    // The connector returns the cursor it is willing to commit to. A failed
    // scope keeps its previous value, so committing is always safe.
    const errors = Array.isArray(pulled?.errors) ? pulled.errors : [];
    const partial = Boolean(pulled?.partial) || errors.length > 0;
    // ... and once more before the provider position is committed. An abandoned
    // page must never advance the cursor; a replay of already ingested events
    // stays idempotent.
    if (this.#halted(signal, isCurrent)) return this.#aborted(connector.id);
    if (cursorChanged) this.cursors.set(connector.id, pulled.cursor);
    const complete = !partial && !pulled.hasMore
      && !Object.values(pulled.scopes || {}).some(scope => scope.status === 'recovering')
      && pulled.cursor?.recovering !== true;
    this.cursors.observe?.(connector.id, { complete, observedAt: this.now(), watermark: pulled.cursor?.gmail?.historyId || cursor?.gmail?.historyId || null });

    // Scope failures are stored in the same bounded, public form as a whole
    // pull failure. A rate limit inside one scope still has to reach the
    // scheduler, which backs off on the provider's requested delay.
    const errorText = errors.length
      ? errors.map(item => publicFailureText(`${item?.scope || 'source'}: ${item?.message || 'provider error'}`) || 'source: provider error').join(' | ')
      : null;
    const rateLimited = pulled?.rateLimited === true
      || errors.some(item => item?.rateLimited === true || Number(item?.status) === 429);
    const retryAfterMs = rateLimitDelay({ results: [{ errors, rateLimited, retryAfterMs: pulled?.retryAfterMs ?? null, retryAfter: pulled?.retryAfter ?? null }] }) || null;
    // A partial pull has a repair action. A complete page clears it. A page
    // that merely has more work leaves the prior repair untouched until a
    // current, complete observation proves the source healthy again.
    const repair = partial ? repairForResult({ errors, partial: true, rateLimited, retryAfterMs }) : complete ? null : undefined;
    const statusPatch = {
      ok: !partial,
      complete,
      lastError: errorText,
      eventsIngested: ingested,
      eventsDuplicate: duplicates,
      ...(repair !== undefined ? { repair } : {}),
      ...(partial ? { rateLimited, retryAfterMs } : complete ? { rateLimited: false, retryAfterMs: null } : {})
    };
    const previous = this.cursors.describe().status?.[connector.id] || null;
    const statusChanged = !previous
      || previous.ok !== statusPatch.ok
      || previous.complete !== statusPatch.complete
      || (previous.lastError || null) !== statusPatch.lastError
      || previous.eventsIngested !== statusPatch.eventsIngested
      || previous.eventsDuplicate !== statusPatch.eventsDuplicate
      || JSON.stringify(previous.repair ?? null) !== JSON.stringify(statusPatch.repair ?? previous.repair ?? null)
      || (statusPatch.rateLimited !== undefined && previous.rateLimited !== statusPatch.rateLimited)
      || (statusPatch.retryAfterMs !== undefined && (previous.retryAfterMs ?? null) !== statusPatch.retryAfterMs);
    // An empty poll that repeats the same cursor and outcome must not rewrite
    // the state file. The document bodies live in that file.
    if (cursorChanged || statusChanged) {
      this.cursors.status(connector.id, {
        ...statusPatch,
        // A capped (hasMore) page is still a current successful observation;
        // completeness is reported separately by `complete`.
        ...(!partial ? { lastSuccessAt: this.now() } : {}),
        lastSyncAt: this.now()
      });
    }

    const publicErrors = errors.map(error => ({
      scope: publicFailureText(String(error?.scope || 'source'), { max: 80 }) || 'source',
      message: publicFailureText(String(error?.message || 'Provider observation failed.')) || 'Provider observation failed.',
      ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
      ...(error?.rateLimited === true ? { rateLimited: true } : {}),
      ...(error?.retryable === true ? { retryable: true } : {}),
      ...(typeof error?.retryAfterMs === 'number' ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error?.retryAfter != null ? { retryAfterMs: rateLimitDelay({ results: [{ ...error, rateLimited: true }] }) } : {})
    }));
    return { connector: connector.id, ingested, duplicates, partial, errors: publicErrors, failed: false,
      hasMore: pulled.hasMore === true, ...(repair !== undefined ? { repair } : {}),
      ...(partial ? { rateLimited, retryAfterMs } : {}) };
  }

  describe() {
    return { running: this.running, lastRunAt: this.lastRunAt, connectors: this.connectors.map(connector => connector.id) };
  }
}

export const syncApi = { ConnectorSync };
