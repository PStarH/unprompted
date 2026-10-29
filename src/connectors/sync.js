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

export class ConnectorSync {
  constructor({ connectors, cursors, engine, now = () => new Date().toISOString(), timeoutMs = null }) {
    this.connectors = connectors || [];
    this.cursors = cursors;
    this.engine = engine;
    this.now = now;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
    this.running = false;
    this.lastRunAt = null;
  }

  /**
   * A hard ceiling for one connector pull.
   *
   * Connectors already bound their own requests, but a custom or misbehaving
   * connector must not hold the single `running` flag forever. A timed-out pull
   * has not returned a cursor, so nothing is committed and the next run retries
   * the same window.
   */
  async #pullWithTimeout(connector, cursor) {
    const pull = connector.pull({ cursor });
    if (!this.timeoutMs) return pull;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Connector pull timed out after ${this.timeoutMs}ms`)),
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
  async run() {
    if (this.running) return { skipped: 'A sync is already running.', results: [] };
    this.running = true;
    this.lastRunAt = this.now();
    const results = [];
    try {
      for (const connector of this.connectors) {
        if (!connector.live) continue; // simulated connectors are driven by the scenario scheduler
        results.push(await this.#syncOne(connector));
      }
      return { results };
    } finally {
      this.running = false;
    }
  }

  async #syncOne(connector) {
    // A single observation can finish a small multi-page backlog promptly. Each
    // page commits only after its events are ingested, and the cap keeps one
    // large source from monopolising the observation loop.
    const pages = [], started = Date.now();
    for (let index = 0; index < 5; index++) {
      const result = await this.#syncPage(connector);
      pages.push(result);
      if (result.failed || result.partial || !result.hasMore || Date.now() - started >= 30000) break;
    }
    const last = pages.at(-1);
    return { ...last, ingested: pages.reduce((count, page) => count + (page.ingested || 0), 0),
      duplicates: pages.reduce((count, page) => count + (page.duplicates || 0), 0), pages: pages.length };
  }

  async #syncPage(connector) {
    const cursor = this.cursors.get(connector.id);
    let pulled;
    try {
      pulled = await this.#pullWithTimeout(connector, cursor);
      if (!pulled || !Array.isArray(pulled.events) || (pulled.errors != null && !Array.isArray(pulled.errors))) {
        throw new Error('Connector returned an invalid pull result; the cursor was not advanced.');
      }
    } catch (error) {
      // The pull itself failed. Record it and ingest nothing.
      this.cursors.status(connector.id, {
        ok: false,
        lastError: error.message,
        eventsIngested: 0,
        lastSyncAt: this.now()
      });
      return { connector: connector.id, ingested: 0, duplicates: 0, failed: true, error: error.message };
    }

    const events = pulled.events;
    const cursorChanged = Boolean(pulled?.cursor) && JSON.stringify(cursor ?? null) !== JSON.stringify(pulled.cursor);
    if (pulled.hasMore === true && !cursorChanged) {
      const message = 'Connector pagination did not advance; the cursor was not changed.';
      this.cursors.status(connector.id, { ok: false, lastError: message, eventsIngested: 0, lastSyncAt: this.now() });
      return { connector: connector.id, ingested: 0, duplicates: 0, failed: true, error: message };
    }
    let ingested = 0;
    let duplicates = 0;
    try { for (const event of events) {
      // Ingest is synchronous and idempotent; a replayed provider event is
      // counted rather than reprocessed.
      const outcome = this.engine.ingest(event);
      if (outcome?.duplicate) duplicates += 1;
      else ingested += 1;
    } } catch {
      const message = 'Connector event ingestion failed; the cursor was not advanced. The next sync will replay the batch.';
      this.cursors.status(connector.id, { ok: false, lastError: message, eventsIngested: ingested, eventsDuplicate: duplicates, lastSyncAt: this.now() });
      return { connector: connector.id, ingested, duplicates, failed: true, error: message };
    }

    // The connector returns the cursor it is willing to commit to. A failed
    // scope keeps its previous value, so committing is always safe.
    const errors = Array.isArray(pulled?.errors) ? pulled.errors : [];
    const partial = Boolean(pulled?.partial) || errors.length > 0;
    if (cursorChanged) this.cursors.set(connector.id, pulled.cursor);

    const statusPatch = {
      ok: !partial,
      lastError: errors.length ? errors.map(item => `${item.scope}: ${item.message}`).join(' | ') : null,
      eventsIngested: ingested,
      eventsDuplicate: duplicates
    };
    const previous = this.cursors.describe().status?.[connector.id] || null;
    const statusChanged = !previous
      || previous.ok !== statusPatch.ok
      || (previous.lastError || null) !== statusPatch.lastError
      || previous.eventsIngested !== statusPatch.eventsIngested
      || previous.eventsDuplicate !== statusPatch.eventsDuplicate;
    // An empty poll that repeats the same cursor and outcome must not rewrite
    // the state file. The document bodies live in that file.
    if (cursorChanged || statusChanged) {
      this.cursors.status(connector.id, { ...statusPatch, lastSyncAt: this.now() });
    }

    return { connector: connector.id, ingested, duplicates, partial, errors, failed: false, hasMore: pulled.hasMore === true };
  }

  describe() {
    return { running: this.running, lastRunAt: this.lastRunAt, connectors: this.connectors.map(connector => connector.id) };
  }
}

export const syncApi = { ConnectorSync };
