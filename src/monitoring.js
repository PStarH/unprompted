import { setupConstants } from './setup.js';

const { DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS } = setupConstants;
const iso = now => new Date(now()).toISOString();

function summarizeErrors(outcome) {
  const failures = (outcome?.results || []).filter(result => result.failed || result.partial);
  return failures.map(result => {
    const error = result.error || (result.errors || []).map(item => `${item.scope}: ${item.message}`).join(' | ');
    return `${result.connector}: ${error || 'partial sync'}`;
  }).join(' · ');
}

/**
 * Persistent, non-overlapping connector observation. Settings survive a
 * process restart; timers do not. A restart with the switch on performs an
 * immediate pull and then schedules the next pull after each completed pass.
 */
export class MonitoringService {
  constructor({ sync, setup, connectors = sync?.connectors || [], now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.sync = sync;
    this.setup = setup;
    this.connectors = connectors;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.currentRun = Promise.resolve(null);
    this.stopped = false;
    this.settings = setup.get().monitoring;
  }

  get hasLiveConnector() {
    return this.connectors.some(connector => connector.live && (
      connector.id !== 'google' || connector.config?.readGmail !== false || connector.config?.readDrive !== false
    ));
  }

  start() {
    this.stopped = false;
    this.settings = this.setup.get().monitoring;
    if (this.settings.enabled && this.hasLiveConnector) return this.#runAndSchedule();
    return Promise.resolve(this.describe());
  }

  async setSettings({ enabled, intervalMs } = {}) {
    if (enabled != null && typeof enabled !== 'boolean') throw new Error('enabled must be a boolean.');
    let interval = this.settings.intervalMs || DEFAULT_INTERVAL_MS;
    if (intervalMs != null) {
      const parsed = Number(intervalMs);
      if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS || parsed > MAX_INTERVAL_MS) {
        throw new Error(`intervalMs must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}.`);
      }
      interval = Math.round(parsed);
    }
    const nextEnabled = enabled == null ? this.settings.enabled === true : enabled;
    if (nextEnabled && !this.hasLiveConnector) throw new Error('Connect and authorize a source before enabling automatic observation.');
    this.setup.setMonitoring({ enabled: nextEnabled, intervalMs: interval, userConfigured: true });
    this.settings = this.setup.get().monitoring;
    this.stopped = false;
    this.#clearTimer();
    if (nextEnabled) {
      // The first pull begins immediately; the next one is scheduled only when
      // this pass ends, so slow connectors cannot create overlapping polls.
      void this.#runAndSchedule();
    }
    return this.describe();
  }

  async runNow() {
    if (this.running) return { skipped: 'A sync is already running.', results: [] };
    this.currentRun = this.#run();
    const outcome = await this.currentRun;
    if (this.settings.enabled && !this.stopped) this.#schedule();
    return outcome;
  }

  #clearTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  #schedule() {
    this.#clearTimer();
    if (this.stopped || !this.settings.enabled || !this.hasLiveConnector || this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.#runAndSchedule();
    }, this.settings.intervalMs);
    this.timer?.unref?.();
  }

  async #runAndSchedule() {
    if (this.running) return this.currentRun;
    this.currentRun = this.#run();
    const outcome = await this.currentRun;
    if (this.settings.enabled && !this.stopped) this.#schedule();
    return outcome;
  }

  async #run() {
    if (this.running) return { skipped: 'A sync is already running.', results: [] };
    if (!this.hasLiveConnector) return { skipped: 'No live connector is configured.', results: [] };
    this.running = true;
    const lastRunAt = iso(this.now);
    this.setup.setMonitoring({ lastRunAt });
    this.settings = this.setup.get().monitoring;
    try {
      const outcome = await this.sync.run();
      if (outcome?.skipped) return outcome;
      if (!outcome.results?.length) {
        this.setup.setMonitoring({ lastFailureAt: iso(this.now), lastOutcome: 'failure', lastError: 'No live connector returned a sync result.' });
        this.settings = this.setup.get().monitoring;
        return outcome;
      }
      const error = summarizeErrors(outcome);
      if (error) {
        this.setup.setMonitoring({ lastFailureAt: iso(this.now), lastOutcome: 'failure', lastError: error });
        this.settings = this.setup.get().monitoring;
      } else {
        this.setup.setMonitoring({ lastSuccessAt: iso(this.now), lastOutcome: 'success', lastError: null, expiredFor: null });
        this.settings = this.setup.get().monitoring;
      }
      return outcome;
    } catch (error) {
      // Keep provider detail for the local status screen, but never print it to
      // the terminal or include any OAuth request body in logs.
      this.setup.setMonitoring({ lastFailureAt: iso(this.now), lastOutcome: 'failure', lastError: String(error?.message || 'Sync failed').slice(0, 1000) });
      this.settings = this.setup.get().monitoring;
      return { results: [], failed: true, error: this.settings.lastError };
    } finally {
      this.running = false;
    }
  }

  describe() {
    this.settings = this.setup.get().monitoring;
    const intervalMs = Number(this.settings.intervalMs) || DEFAULT_INTERVAL_MS;
    const lastSuccess = this.settings.lastSuccessAt ? Date.parse(this.settings.lastSuccessAt) : null;
    const expiryMs = Math.max(5 * 60_000, intervalMs * 3);
    const expired = lastSuccess != null && Number.isFinite(lastSuccess) && this.now() - lastSuccess > expiryMs;
    if (expired && this.settings.expiredFor !== this.settings.lastSuccessAt) {
      this.setup.setMonitoring({ lastExpiredAt: iso(this.now), expiredFor: this.settings.lastSuccessAt });
      this.settings = this.setup.get().monitoring;
    }
    // Outcome is the authoritative ordering signal: ISO timestamps only have
    // millisecond precision, so a success and failure in one millisecond can
    // otherwise compare equal. Fall back to the error field for old setup files.
    const failedAfterSuccess = this.settings.lastOutcome
      ? this.settings.lastOutcome === 'failure'
      : Boolean(this.settings.lastFailureAt && this.settings.lastError &&
        (!this.settings.lastSuccessAt || Date.parse(this.settings.lastFailureAt) >= Date.parse(this.settings.lastSuccessAt)));
    const status = !this.settings.enabled ? 'off'
      : !this.hasLiveConnector ? 'needs_connection'
        : this.running ? 'syncing'
          : failedAfterSuccess ? 'failed'
            : !this.settings.lastSuccessAt ? 'starting'
              : expired ? 'expired' : 'watching';
    return {
      enabled: this.settings.enabled === true,
      intervalMs,
      minimumIntervalMs: MIN_INTERVAL_MS,
      status,
      running: this.running,
      configured: this.hasLiveConnector,
      lastRunAt: this.settings.lastRunAt || null,
      lastSuccessAt: this.settings.lastSuccessAt || null,
      lastFailureAt: this.settings.lastFailureAt || null,
      lastOutcome: this.settings.lastOutcome || null,
      lastExpiredAt: this.settings.lastExpiredAt || null,
      expired,
      expiresAfterMs: expiryMs,
      lastError: this.settings.lastError || null,
      restartBehavior: 'enabled settings persist; each process restart performs an immediate sync before resuming the interval'
    };
  }

  async whenIdle() {
    if (this.running) await this.currentRun;
  }

  stop() {
    this.stopped = true;
    this.#clearTimer();
    // Do not clear the persisted switch; re-launching the process restores it.
  }
}

export const monitoringConstants = { DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS };
