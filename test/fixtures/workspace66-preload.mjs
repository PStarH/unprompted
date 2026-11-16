import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// Test-only preload for the workspace rebuild fault probes. It is loaded with
// `node --import` by the real-server test child; production code has no fault
// switch and never imports this file.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = relative => pathToFileURL(path.join(ROOT, relative)).href;

const { GitHubWebhookService } = await import(moduleUrl('src/github-webhooks.js'));
const { SqliteStore } = await import(moduleUrl('src/durable/store.js'));
const { LocalSetupStore } = await import(moduleUrl('src/setup.js'));
const { ConnectorSync } = await import(moduleUrl('src/connectors/sync.js'));
const { MonitoringService } = await import(moduleUrl('src/monitoring.js'));

const faults = { mutate: false, mutateFilename: null, closeFilename: null, closeRemaining: 0,
  runtimeEnv: false, monitoringGet: false, monitoringSet: false, mark: false, sync: false, webhookStart: false };
const stored = {
  stores: new Set(), storeRecords: new WeakMap(), storeCount: 0,
  services: new WeakMap(), serviceRecords: [], serviceCount: 0,
  lastStateRead: null, lastClose: null, lastMutate: null, lastMutateCallsite: null,
  runtimeEnvFaultHits: 0, runtimeEnvFilename: null, lastRuntimeEnvCallsite: null,
  closeFaultHits: 0, mutateFaultHits: 0, monitoringFaultHits: 0, monitoringSetFaultHits: 0,
  markFaultHits: 0, syncFaultHits: 0, webhookStartFaultHits: 0,
  fetchCalls: [], blockedFetch: [], engines: new Set()
};

const storeRecord = resource => {
  let record = stored.storeRecords.get(resource);
  if (!record) {
    record = { id: stored.storeCount += 1, closes: 0, closeFailures: 0, mutates: 0 };
    stored.storeRecords.set(resource, record);
    stored.stores.add(resource);
  }
  return record;
};

const stateDescriptor = Object.getOwnPropertyDescriptor(SqliteStore.prototype, 'state');
Object.defineProperty(SqliteStore.prototype, 'state', {
  configurable: true,
  enumerable: stateDescriptor.enumerable,
  get() { stored.lastStateRead = this; return stateDescriptor.get.call(this); },
  set(value) { stateDescriptor.set.call(this, value); }
});

const refresh = SqliteStore.prototype.refresh;
SqliteStore.prototype.refresh = function (...args) { storeRecord(this); return refresh.apply(this, args); };

const close = SqliteStore.prototype.close;
SqliteStore.prototype.close = function (...args) {
  const record = storeRecord(this);
  stored.lastClose = this;
  record.closes += 1;
  if (faults.closeFilename && this.filename === faults.closeFilename && faults.closeRemaining > 0) {
    faults.closeRemaining -= 1;
    if (faults.closeRemaining === 0) faults.closeFilename = null;
    stored.closeFaultHits += 1;
    record.closeFailures += 1;
    send({ type: 'close-attempt', filename: this.filename, ok: false });
    throw new Error('INJECTED_PREVIOUS_STORE_CLOSE');
  }
  try {
    const result = close.apply(this, args);
    send({ type: 'close-attempt', filename: this.filename, ok: true });
    return result;
  } catch (error) {
    record.closeFailures += 1;
    send({ type: 'close-attempt', filename: this.filename, ok: false });
    throw error;
  }
};

const mutateIfChanged = SqliteStore.prototype.mutateIfChanged;
SqliteStore.prototype.mutateIfChanged = function (...args) {
  const record = storeRecord(this);
  stored.lastMutate = this;
  record.mutates += 1;
  const callsite = (new Error().stack || '').split('\n').slice(2, 6).join(' | ');
  stored.lastMutateCallsite = callsite;
  const targeted = !faults.mutateFilename || this.filename === faults.mutateFilename;
  if (faults.mutate && targeted) {
    faults.mutate = false;
    faults.mutateFilename = null;
    stored.mutateFaultHits += 1;
    throw new Error('INJECTED_POST_ASSIGNMENT_MUTATE');
  }
  return mutateIfChanged.apply(this, args);
};

const get = LocalSetupStore.prototype.get;
LocalSetupStore.prototype.get = function (...args) {
  if (faults.monitoringGet && (new Error().stack || '').includes('new MonitoringService')) {
    faults.monitoringGet = false;
    stored.monitoringFaultHits += 1;
    throw new Error('INJECTED_MONITORING_CONSTRUCTION');
  }
  return get.apply(this, args);
};

// The initial server construction also calls runtimeEnv. Arm only a call that
// comes from the activation lifecycle, never startup or another setup read.
const runtimeEnv = LocalSetupStore.prototype.runtimeEnv;
LocalSetupStore.prototype.runtimeEnv = function (...args) {
  if (faults.runtimeEnv && (new Error().stack || '').includes('activateGoogleWorkspace')) {
    faults.runtimeEnv = false;
    stored.runtimeEnvFaultHits += 1;
    stored.runtimeEnvFilename = this.filePath;
    stored.lastRuntimeEnvCallsite = (new Error().stack || '').split('\n').slice(2, 6).join(' | ');
    throw new Error('INJECTED_PRE_CANDIDATE_ENV');
  }
  return runtimeEnv.apply(this, args);
};

const setSettings = MonitoringService.prototype.setSettings;
MonitoringService.prototype.setSettings = function (...args) {
  if (faults.monitoringSet) {
    faults.monitoringSet = false;
    stored.monitoringSetFaultHits += 1;
    throw new Error('INJECTED_POST_COMMIT_MONITORING');
  }
  return setSettings.apply(this, args);
};

const markGoogleRuntimeActive = LocalSetupStore.prototype.markGoogleRuntimeActive;
LocalSetupStore.prototype.markGoogleRuntimeActive = function (...args) {
  if (faults.mark) {
    faults.mark = false;
    stored.markFaultHits += 1;
    throw new Error('INJECTED_MARK_RUNTIME_ACTIVE');
  }
  return markGoogleRuntimeActive.apply(this, args);
};

const syncEngines = new WeakMap();
Object.defineProperty(ConnectorSync.prototype, 'engine', {
  configurable: true,
  get() { return syncEngines.get(this); },
  set(value) {
    syncEngines.set(this, value);
    if (value) stored.engines.add(value);
    if (faults.sync) {
      faults.sync = false;
      stored.syncFaultHits += 1;
      throw new Error('INJECTED_SYNC_CONSTRUCTION');
    }
  }
});

const serviceRecord = service => {
  let record = stored.services.get(service);
  if (!record) {
    record = { id: stored.serviceCount += 1, starts: 0, stops: 0 };
    stored.services.set(service, record);
    stored.serviceRecords.push(record);
  }
  return record;
};
const start = GitHubWebhookService.prototype.start;
GitHubWebhookService.prototype.start = function (...args) {
  if (faults.webhookStart) {
    faults.webhookStart = false;
    stored.webhookStartFaultHits += 1;
    throw new Error('INJECTED_RECEIVER_START');
  }
  serviceRecord(this).starts += 1;
  return start.apply(this, args);
};
const stop = GitHubWebhookService.prototype.stop;
GitHubWebhookService.prototype.stop = function (...args) {
  serviceRecord(this).stops += 1;
  return stop.apply(this, args);
};

// Provider calls in a child are synthetic only. GitHub gets the shapes the
// connector expects; every other origin is blocked and recorded.
globalThis.fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'api.github.com') {
    stored.fetchCalls.push(url.pathname + url.search);
    const value = url.pathname === '/search/issues' ? { total_count: 0, incomplete_results: false, items: [] }
      : url.pathname === '/user' ? { id: Number(process.env.WS66_ACCOUNT_ID), login: process.env.WS66_LOGIN }
        : [];
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  stored.blockedFetch.push(url.href);
  throw new Error(`BLOCKED_EXTERNAL_FETCH ${url.origin}`);
};

const snapshot = () => {
  const services = stored.serviceRecords.map(record => ({ ...record }));
  const current = stored.lastStateRead;
  let storage = null;
  if (current?.db) {
    try {
      storage = {
        receipts: current.db.prepare('SELECT state, COUNT(*) n FROM github_webhook_receipts GROUP BY state').all(),
        jobs: current.db.prepare('SELECT state, COUNT(*) n FROM jobs GROUP BY state').all()
      };
    } catch (error) { storage = { error: error.message }; }
  }
  return {
    stores: [...stored.stores].map(store => {
      const record = storeRecord(store);
      return { filename: store.filename, closed: store.closed === true,
        closes: record.closes, closeFailures: record.closeFailures, mutates: record.mutates };
    }),
    currentStore: current ? { filename: current.filename, closed: current.closed === true } : null,
    lastClose: stored.lastClose ? { filename: stored.lastClose.filename, closed: stored.lastClose.closed === true } : null,
    lastMutate: stored.lastMutate ? { filename: stored.lastMutate.filename, closed: stored.lastMutate.closed === true,
      callsite: stored.lastMutateCallsite } : null,
    modelOwners: [...stored.engines].map(engine => ({
      filename: engine.store.filename, closed: engine.store.closed === true, model: engine.reasoner?.model || null,
      tokenOwned: Boolean(engine.reasoner?.tokenBudget && engine.reasoner.tokenBudget.database === engine.store.database),
      privateOwned: Boolean(engine.reasoner?.reasoningSessions && engine.reasoner.reasoningSessions.database === engine.store.database)
    })),
    services,
    startedNotStopped: services.filter(record => record.starts > 0 && record.stops === 0).length,
    closeFaultHits: stored.closeFaultHits,
    mutateFaultHits: stored.mutateFaultHits,
    runtimeEnvFaultHits: stored.runtimeEnvFaultHits,
    runtimeEnvFilename: stored.runtimeEnvFilename,
    lastRuntimeEnvCallsite: stored.lastRuntimeEnvCallsite,
    monitoringFaultHits: stored.monitoringFaultHits,
    monitoringSetFaultHits: stored.monitoringSetFaultHits,
    markFaultHits: stored.markFaultHits,
    syncFaultHits: stored.syncFaultHits,
    webhookStartFaultHits: stored.webhookStartFaultHits,
    shadows: [...stored.engines].map(engine => ({
      policy: engine?.policy?.shadow,
      task: engine?.taskServices?.policy?.shadow,
      document: engine?.documentProvider?.shadow,
      google: engine?.documentProvider?.connector?.shadow
    })),
    fetchCalls: [...stored.fetchCalls],
    blockedFetch: [...stored.blockedFetch],
    storage,
    timeouts: process.getActiveResourcesInfo().filter(item => item === 'Timeout').length
  };
};

const send = message => {
  if (typeof process.send !== 'function' || !process.connected) return;
  try { process.send(message); } catch { /* the harness may already have disconnected */ }
};
// A close during shutdown can race the harness detaching IPC. That test-only
// EPIPE must not crash the server under test.
process.on('error', error => { if (error?.code !== 'EPIPE') throw error; });

process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'arm') {
    if (message.fault === 'mutate') {
      faults.mutate = true;
      faults.mutateFilename = message.filename || null;
    }
    if (message.fault === 'close') {
      faults.closeFilename = message.filename;
      faults.closeRemaining = Number.isInteger(message.times) ? message.times : 1;
    }
    if (message.fault === 'runtimeEnv') faults.runtimeEnv = true;
    if (message.fault === 'monitoring-get') faults.monitoringGet = true;
    if (message.fault === 'monitoring-set') faults.monitoringSet = true;
    if (message.fault === 'mark') faults.mark = true;
    if (message.fault === 'sync') faults.sync = true;
    if (message.fault === 'webhook-start') faults.webhookStart = true;
    send({ type: 'armed', fault: message.fault });
  }
  if (message.type === 'diag') send({ type: 'diag', id: message.id, snapshot: snapshot() });
});
send({ type: 'preload-ready' });
