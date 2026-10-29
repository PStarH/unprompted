import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { JsonStore, hasRealEvents } from './src/store.js';
import { WorkEngine } from './src/engine.js';
import { SimulationController } from './src/simulation.js';
import { seedDemoMemories } from './src/demo-memories.js';
import { buildRuntime } from './src/connectors/index.js';
import { ConnectorSync } from './src/connectors/sync.js';
import { createReasoner } from './src/reasoning.js';
import { PermissionDeniedError } from './src/permissions.js';
import { normaliseDateLocale } from './src/requests.js';
import { GoogleAuth } from './src/connectors/google.js';
import { GoogleDocsWriteProvider } from './src/document-delivery.js';
import { LocalSetupStore, GoogleOAuthSetup, googleWorkspacePath } from './src/setup.js';
import { MonitoringService } from './src/monitoring.js';
import { HttpRequestError, readJsonBody, SseHub } from './src/http-transport.js';
import { ModelSetupError, normalizeModelSettings, validateModelSettings } from './src/model-setup.js';
import { googleConnectionIssue } from './src/google-connection.js';
import { CONNECTION_PROVIDERS, connectionProvider, publicClientConfiguration } from './src/connection-catalog.js';
import { DeviceOAuth } from './src/device-oauth.js';
import { CodeOAuth } from './src/code-oauth.js';
import { connectedSources, sourceCounts, sourceAccountBindings } from './src/connected-sources.js';
import { NativeSourceBridge, NativeAccessError } from './src/native-sources.js';
import { canonicalLocalRoot, mergeLocalRoots, readScopedText } from './src/connectors/local-files.js';
import { nativeSnapshot } from './src/connectors/local-snapshot.js';
import { bindConnectionAccount } from './src/external-work.js';
import { readRegularFile } from './src/local-files.js';
import { McpManager, McpConfigStore } from './src/mcp.js';
import { SqliteStore } from './src/durable/store.js';
import { DurableRuntime } from './src/durable/runtime.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';
const httpLimit = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback;
};
const httpBodyLimits = {
  maxBytes: httpLimit('UNPROMPTED_HTTP_MAX_BODY_BYTES', 1024 * 1024, 1024, 16 * 1024 * 1024),
  timeoutMs: httpLimit('UNPROMPTED_HTTP_BODY_TIMEOUT_MS', 30_000, 1000, 10 * 60_000),
  idleTimeoutMs: httpLimit('UNPROMPTED_HTTP_BODY_IDLE_TIMEOUT_MS', 10_000, 500, 10 * 60_000)
};
const requestTimeoutMs = httpLimit('UNPROMPTED_HTTP_REQUEST_TIMEOUT_MS', 35_000, 1000, 10 * 60_000);
const localSetup = new LocalSetupStore({ filePath: process.env.UNPROMPTED_SETUP_FILE || null });
const mcp = new McpManager({ configStore: new McpConfigStore(localSetup.directory) });
const nativeBridge = new NativeSourceBridge();
const currentSources = () => connectedSources(localSetup, { nativeBridge, baseUrl: `http://${host}:${port}` });
const artifactConnectionFor = id => {
  const connector = runtime.connectors.find(item => item.id === id && item.live);
  if (!connector || workspaceChanging || shutdownPromise) return null;
  if (id === 'google') {
    const saved = localSetup.get().google;
    return { connector, accountId: process.env.GOOGLE_REFRESH_TOKEN ? runtimeEnv.GOOGLE_ACCOUNT_EMAIL : saved.accountId,
      accountLabel: process.env.GOOGLE_REFRESH_TOKEN ? runtimeEnv.GOOGLE_ACCOUNT_EMAIL : saved.accountEmail, scopes: process.env.GOOGLE_REFRESH_TOKEN
        ? (runtimeEnv.GOOGLE_DRAFTS_ENABLED === 'true' ? ['https://www.googleapis.com/auth/gmail.compose'] : []) : saved.grantedScopes };
  }
  if (id === 'apple_notes') return { connector, accountId: connector.scopeId, accountLabel: 'Apple Notes', scopes: [] };
  const saved = localSetup.getConnection(id);
  return { connector, accountId: saved.account?.id, accountLabel: saved.account?.label, scopes: saved.scopes || [] };
};
const publicScopeId = item => item.id || createHash('sha256').update(`${item.accountId}\0${item.folderId}`).digest('hex').slice(0, 24);
let nativeSelectionBusy = false;
let setupState = localSetup.get();
const connectionClientFile = process.env.UNPROMPTED_CONNECTOR_CLIENTS_FILE || path.join(root, 'connector-clients.json');
let provisionedConnections = {};
try { provisionedConnections = publicClientConfiguration(JSON.parse(readRegularFile(connectionClientFile, { maxBytes: 64 * 1024 }))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const provider of Object.values(CONNECTION_PROVIDERS)) {
  const saved = localSetup.getConnection(provider.id);
  const fromFile = provisionedConnections[provider.id] || {};
  const fromEnvId = process.env[provider.clientEnv];
  const fromEnvSecret = provider.secretEnv ? process.env[provider.secretEnv] : null;
  if (provider.flow === 'code') {
    const paired = Boolean(fromEnvId && fromEnvSecret);
    const clientId = paired ? fromEnvId : fromFile.clientId;
    const clientSecret = paired ? fromEnvSecret : fromFile.clientSecret;
    if (clientId && clientSecret && !(saved.clientId && saved.clientSecret)) localSetup.saveConnectionCredentials(provider.id, { clientId, clientSecret });
  } else {
    const clientId = fromEnvId || fromFile.clientId;
    if (clientId && !saved.clientId) localSetup.saveConnectionClient(provider.id, clientId);
  }
}
const provisionedClientFile = process.env.UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE || path.join(root, 'google-oauth-client.json');
if (!setupState.google.clientId && fs.existsSync(provisionedClientFile)) {
  localSetup.saveDesktopClientJson(fs.readFileSync(provisionedClientFile, 'utf8'));
  setupState = localSetup.get();
}
// A distribution may provision its registered Desktop client once. End users
// then use Google's consent screen directly; no per-user Cloud project is needed.
const provisionedClientId = process.env.UNPROMPTED_GOOGLE_DESKTOP_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const provisionedClientSecret = process.env.UNPROMPTED_GOOGLE_DESKTOP_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
if (!setupState.google.clientId && provisionedClientId && provisionedClientSecret) {
  localSetup.saveDesktopClientJson(JSON.stringify({ installed: { client_id: provisionedClientId, client_secret: provisionedClientSecret } }));
  setupState = localSetup.get();
}
const legacySyncSetting = Number(process.env.UNPROMPTED_SYNC_INTERVAL_MS ?? 0);
if (!setupState.monitoring.userConfigured && Number.isFinite(legacySyncSetting) && legacySyncSetting > 0) {
  localSetup.setMonitoring({ enabled: true, intervalMs: Math.max(15000, legacySyncSetting) });
  setupState = localSetup.get();
}
const localGoogleSaved = Boolean(setupState.google.clientId && setupState.google.clientSecret && setupState.google.refreshToken);
const usingLocalGoogle = localGoogleSaved && !process.env.GOOGLE_REFRESH_TOKEN;
const explicitSimulation = process.env.UNPROMPTED_FORCE_SIMULATION === 'true' || process.env.UNPROMPTED_RULE_ONLY === 'true';
const createWorkspaceStore = (filename, options) => explicitSimulation && process.env.UNPROMPTED_STORAGE !== 'sqlite'
  ? new JsonStore(filename, options) : new SqliteStore(filename, options);
const workspaceDirectory = process.env.UNPROMPTED_STATE_FILE ? path.dirname(path.resolve(process.env.UNPROMPTED_STATE_FILE)) : localSetup.directory;
const defaultStateFile = usingLocalGoogle ? googleWorkspacePath(workspaceDirectory, setupState.google.accountId)
  : process.env.GOOGLE_REFRESH_TOKEN ? path.join(localSetup.directory, `environment-${createHash('sha256').update(process.env.GOOGLE_REFRESH_TOKEN).digest('hex').slice(0, 24)}-state.json`)
  : path.join(localSetup.directory, explicitSimulation ? 'simulation-state.json' : 'workspace-state.json');
let runtimeEnv = localSetup.runtimeEnv(process.env);
// Numeric dates follow only an explicitly configured reading; an unknown
// value counts as "not configured", and an unconfigured ambiguous `10/11`
// stays ambiguous instead of being guessed.
const dateLocale = normaliseDateLocale(process.env.UNPROMPTED_DATE_LOCALE);
let store;
try {
  store = createWorkspaceStore(usingLocalGoogle && setupState.google.accountId ? defaultStateFile : process.env.UNPROMPTED_STATE_FILE || defaultStateFile, { dateLocale });
} catch (error) {
  if (error.code === 'STATE_LOCKED') {
    console.error('The state file is already in use by another Unprompted process.');
    console.error(error.message);
    console.error('Run one instance per state file, or stop the other process before starting this one.');
    process.exit(1);
  }
  throw error;
}

for (const [id, account] of Object.entries(sourceAccountBindings(localSetup))) if (account || store.state.connectionAccounts?.[id]) bindConnectionAccount(store, id, account);
let runtime = buildRuntime(runtimeEnv, { store, extraConnectors: currentSources(), allowSimulation: explicitSimulation, allowSimulatedActions: explicitSimulation && process.env.UNPROMPTED_DESKTOP_APP === '1' });
if (runtime.live && usingLocalGoogle && setupState.google.accountId) runtime.report.workspaceId = `google:${createHash('sha256').update(setupState.google.accountId).digest('hex').slice(0, 24)}`;
if (runtime.live && !usingLocalGoogle) runtime.report.workspaceId = `environment:${createHash('sha256').update(store.filename).digest('hex').slice(0, 24)}`;
if (usingLocalGoogle && runtime.report.google.ok) localSetup.markGoogleRuntimeActive();
else if (setupState.restartRequired) localSetup.clearRestartRequired();
const sseHub = new SseHub({
  maxClients: httpLimit('UNPROMPTED_HTTP_MAX_SSE_CLIENTS', 32, 1, 1024),
  maxFrameBytes: httpLimit('UNPROMPTED_HTTP_SSE_MAX_FRAME_BYTES', 8 * 1024 * 1024, 1024, 64 * 1024 * 1024),
  maxBufferedBytes: httpLimit('UNPROMPTED_HTTP_SSE_MAX_CLIENT_BUFFER_BYTES', 10 * 1024 * 1024, 1024, 128 * 1024 * 1024),
  maxTotalBufferedBytes: httpLimit('UNPROMPTED_HTTP_SSE_MAX_TOTAL_BUFFER_BYTES', 64 * 1024 * 1024, 1024, 512 * 1024 * 1024),
  heartbeatMs: httpLimit('UNPROMPTED_HTTP_SSE_HEARTBEAT_MS', 20_000, 1000, 10 * 60_000),
  onError: () => console.error('SSE transport error; an affected client was disconnected.')
});
let googleConnector = runtime.connectors.find(connector => connector.id === 'google') || null;
let googleDisconnectedThisRun = false;
let googleValidationThisRun = null;
let documentProvider = googleConnector ? new GoogleDocsWriteProvider({
  connector: googleConnector,
  enabled: runtimeEnv.GOOGLE_DOCS_WRITE_ENABLED === 'true',
  shadow: runtime.shadow
}) : null;
const productReasoner = createReasoner(runtimeEnv);
if (!productReasoner.available() && process.env.UNPROMPTED_FORCE_SIMULATION !== 'true' && process.env.UNPROMPTED_RULE_ONLY !== 'true') {
  productReasoner.preferModelInterpretation = true;
}

let engine = new WorkEngine(store, {
  baseUrl: `http://${host}:${port}`,
  provider: runtime.provider,
  policy: runtime.policy,
  reasoner: productReasoner,
  externalTools: scope => [...mcp.tools(scope), ...(engine?.durableRuntime?.tools(scope) || [])],
  documentProvider,
  mode: runtime.mode,
  dateLocale,
  // How long a waiting request may go without observable progress before
  // the decision reaches the user. Default 24h; 0 raises it at the next sweep.
  stallAfterMs: process.env.UNPROMPTED_STALL_AFTER_MS != null ? Number(process.env.UNPROMPTED_STALL_AFTER_MS) : undefined,
  onChange(state) {
    sseHub.publish(state);
  }
});
let durableRuntime = store.durable ? new DurableRuntime(engine, { connectorFor: id => runtime.connectors.find(connector => connector.id === id) || null, artifactConnectionFor }) : null;
durableRuntime?.start();

// Record what this process is actually running so the interface can be honest
// about live versus simulated data. A restart whose report is unchanged must
// not rewrite the file or move the revision; only a genuinely different report
// is persisted, so a no-op restart stays invisible to every observer.
store.mutateIfChanged(state => { state.runtime = { ...runtime.report, dateLocale: dateLocale || null }; });

let simulation = new SimulationController(store, engine);
// A live workspace must never have simulated events injected into it, and a
// state that holds real recorded events is never run over by the simulation
// either: it is the user's only record of what was actually observed.
let stateHoldsRealEvents = hasRealEvents(store.state);
// The override is a demo/test opt-in, never a way to inject simulated events
// into a process configured for a live provider. Live and simulated workspaces
// stay distinct even when an inherited environment variable is present.
let runSimulation = runtime.mode === 'simulation' && !stateHoldsRealEvents;
// The disposable first-run demo waits for a viewer. Health probes and time
// spent reading the terminal must not consume its story before it is visible.
const demoMode = runSimulation && process.env.UNPROMPTED_FORCE_SIMULATION === 'true' && process.env.UNPROMPTED_DEMO_MODE === 'true';
const demoMemoryCount = Number(process.env.UNPROMPTED_DEMO_MEMORY_COUNT || 0);
if (seedDemoMemories(store, { count: demoMemoryCount, demo: demoMode })) engine.changed();
const guidedSimulation = runSimulation && (demoMode || process.env.UNPROMPTED_DESKTOP_APP === '1');
let demoStarted = false;
let modelSetupBusy = false;
const ruleDemoEnabled = process.env.UNPROMPTED_FORCE_SIMULATION === 'true';
const simulationCanStart = () => runSimulation && explicitSimulation;
const hasGuidedSimulation = () => guidedSimulation;
// Why the simulation entry points are refused, when they are.
const simulationDisabledReason = stateHoldsRealEvents
  ? 'Simulation is disabled for a state that holds real events.'
  : 'Simulation is disabled in live mode.';

const json = (res, status, value) => {
  if (res.destroyed || res.writableEnded || res.headersSent) return false;
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
    return true;
  } catch {
    if (!res.destroyed) res.destroy();
    return false;
  }
};
const escapeHtml = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

/**
 * Pull new events from configured connectors.
 *
 * Incremental and cursor-based, never a full re-read. The runner records
 * failures and surfaces them; a failed sync never produces synthetic events and
 * never marks the connector healthy.
 */
const syncTimeoutSetting = Number(process.env.UNPROMPTED_SYNC_TIMEOUT_MS ?? 0);
const syncTimeoutMs = Number.isFinite(syncTimeoutSetting) && syncTimeoutSetting > 0 ? syncTimeoutSetting : null;
let sync = new ConnectorSync({
  connectors: runtime.connectors,
  cursors: runtime.cursors,
  engine,
  ...(syncTimeoutMs ? { timeoutMs: syncTimeoutMs } : {})
});
let monitoring = new MonitoringService({ sync, setup: localSetup, connectors: runtime.connectors });
let workspaceChanging = false;
const googleOAuth = new GoogleOAuthSetup(localSetup, { onAuthorized: options => activateGoogleWorkspace(options) });
let connectionActivationQueue = Promise.resolve();
const onConnectionAuthorized = (id, options) => {
  const activation = connectionActivationQueue.catch(() => {}).then(() => applyConnectedSources({ ...options, refreshSource: id }));
  connectionActivationQueue = activation; return activation;
};
const deviceOAuth = new DeviceOAuth(localSetup, { onConnected: onConnectionAuthorized });
const codeOAuth = new CodeOAuth(localSetup, { onConnected: onConnectionAuthorized });
const connectionOAuth = id => connectionProvider(id).flow === 'code' ? codeOAuth : deviceOAuth;
const publicSetupStatus = () => {
  const status = localSetup.publicStatus({
    runtime,
    monitoring: monitoring.describe(),
    connectorStatus: store.state.connectorStatus?.google || null
  });
  const modelRuntime = engine.reasoner.status();
  status.model = { ...status.model, active: modelRuntime.available === true,
    runtime: modelRuntime, externallyConfigured: Boolean(process.env.UNPROMPTED_MODEL_BASE_URL || process.env.UNPROMPTED_MODEL_NAME) };
  status.mcp = mcp.describe();
  status.artifacts = durableRuntime?.artifacts.describe() || { available: false, grants: [], targets: [] };
  const canCreateArtifact = id => status.artifacts.enabled && status.artifacts.grants.some(grant => grant.connectorId === id && grant.status === 'active' && grant.available);
  if (durableRuntime) status.durable = durableRuntime.describe();
  status.connections = Object.fromEntries(Object.values(CONNECTION_PROVIDERS).map(provider => {
    const saved = localSetup.getConnection(provider.id), connector = runtime.connectors.find(connector => connector.id === provider.id && connector.live);
    const recorded = store.state.connectorStatus?.[provider.id];
    return [provider.id, { id: provider.id, name: provider.name, flow: provider.flow, clientId: saved.pendingClientId || saved.clientId || null,
      configured: provider.flow === 'code' ? Boolean(saved.clientId && saved.clientSecret) : Boolean(saved.clientId),
      authorized: Boolean(saved.accessToken), connected: Boolean(connector && connector.account?.id === saved.account?.id),
      account: saved.account ? { label: saved.account.label } : null, readOnly: !canCreateArtifact(provider.id), capabilities: connector?.capabilities() || null,
      oauth: connectionOAuth(provider.id).describe(provider.id), lastSyncAt: recorded?.lastSyncAt || null,
      lastError: recorded?.lastError || null, healthy: recorded ? recorded.ok === true : null,
      counts: sourceCounts(store.state, provider.id) }];
  }));
  status.localSources = Object.fromEntries(['local_files', 'apple_notes'].map(id => {
    const saved = localSetup.getNativeSource(id), entries = id === 'local_files' ? saved.roots : saved.folders;
    const recorded = store.state.connectorStatus?.[id];
    return [id, { id, available: id === 'local_files' || nativeBridge.platform === 'darwin', nativePicker: nativeBridge.platform === 'darwin',
      connected: runtime.connectors.some(connector => connector.id === id && connector.live), readOnly: !canCreateArtifact(id),
      capabilities: runtime.connectors.find(connector => connector.id === id && connector.live)?.capabilities() || null,
      scopes: entries.map((item, index) => ({ id: publicScopeId(item), index, label: item.label, ...(item.accountLabel ? { account: item.accountLabel } : {}) })),
      healthy: recorded ? recorded.ok === true : null, lastSyncAt: recorded?.lastSyncAt || null, lastError: recorded?.lastError || null,
      counts: sourceCounts(store.state, id) }];
  }));
  status.google.configuredThisRun = Boolean(runtime.connectors.some(connector => connector.id === 'google' && connector.live));
  status.google.capabilities = runtime.connectors.find(connector => connector.id === 'google' && connector.live)?.capabilities() || null;
  status.google.credentialsConfiguredExternally = Boolean(process.env.GOOGLE_REFRESH_TOKEN);
  if (status.google.credentialsConfiguredExternally) {
    status.google.accountEmail = runtimeEnv.GOOGLE_ACCOUNT_EMAIL || null;
    status.google.hasClient = Boolean(runtimeEnv.GOOGLE_CLIENT_ID && runtimeEnv.GOOGLE_CLIENT_SECRET);
    status.google.hasRefreshToken = Boolean(runtimeEnv.GOOGLE_REFRESH_TOKEN);
    status.google.restartRequired = false;
    status.google.requestedScopes = { readGmail: runtimeEnv.GOOGLE_READ_GMAIL !== 'false', readDrive: runtimeEnv.GOOGLE_READ_DRIVE !== 'false',
      docsWrite: runtimeEnv.GOOGLE_DOCS_WRITE_ENABLED === 'true', gmailSend: runtimeEnv.GOOGLE_SEND_ENABLED === 'true', gmailDrafts: runtimeEnv.GOOGLE_DRAFTS_ENABLED === 'true' };
    status.google.lastValidationStatus = googleValidationThisRun?.status || null;
    status.google.lastValidationError = googleValidationThisRun?.error || null;
    status.google.connectionStatus = store.state.connectorStatus?.google?.lastError ? 'sync_failed'
      : store.state.connectorStatus?.google?.ok ? 'sync_ok' : 'configured_unverified';
  }
  status.google.activating = workspaceChanging;
  status.google.issue = googleConnectionIssue(status.monitoring.lastError || status.google.lastValidationError);
  status.workspace = { mode: runtime.mode, id: runtime.report.workspaceId || runtime.mode, ready: runtime.connectors.some(connector => connector.live),
    observation: monitoring.describe(),
    observed: { emails: store.state.inbox.length, documents: Object.keys(store.state.documents).length,
      tasks: Object.keys(store.state.tasks).length },
    reasoning: { pending: engine.pendingReasoning.size + engine.pendingDiscovery.size,
      failed: Object.values(store.state.tasks).filter(task => task.reasoningWork?.status === 'failed').length } };
  if (googleDisconnectedThisRun) {
    status.google.runtimeDisabled = true;
    status.google.authorizationState = 'disconnected_this_run';
    status.google.connectionStatus = 'disconnected_this_run';
    status.google.configuredThisRun = false;
    status.google.hasRefreshToken = false;
    status.google.allowExternalWrites = false;
    status.google.issue = null;
    status.google.credentialsConfiguredExternally = runtime.report.google.credentialsConfiguredExternally;
  }
  return status;
};

async function activateGoogleWorkspace({ observe = localSetup.get().monitoring.enabled, allowExternalWrites = null, request = null } = {}) {
  if (workspaceChanging || modelSetupBusy) throw new Error('A connection update is already running.');
  if (process.env.GOOGLE_REFRESH_TOKEN) throw new Error('The launch environment controls the Google connection.');
  const credentials = localSetup.get().google;
  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken || !credentials.accountId) throw new Error('Authorize your Google account first.');
  workspaceChanging = true;
  const previous = { store, engine, monitoring, durable: durableRuntime, shadow: runtime.policy.shadow };
  let nextStore = null, applied = false;
  try {
    simulation.stop();
    previous.monitoring.stop();
    previous.engine.policy.shadow = true;
    // New mutations are refused below while the old requests, sync and model
    // calls drain. Nothing may write into a closed or different account store.
    await Promise.allSettled([...activeHttpHandlers].filter(handler => handler !== request?.workspaceHandler));
    await previous.monitoring.whenIdle();
    await previous.engine.whenSettled();
    await previous.durable?.close();
    if (shutdownPromise) throw new Error('The application is shutting down.');
    if (allowExternalWrites != null) localSetup.setExternalWrites(allowExternalWrites);
    const filename = googleWorkspacePath(workspaceDirectory, credentials.accountId);
    nextStore = path.resolve(filename) === path.resolve(previous.store.filename) ? previous.store : createWorkspaceStore(filename, { dateLocale });
    const nextEnv = localSetup.runtimeEnv(process.env);
    for (const [id, account] of Object.entries(sourceAccountBindings(localSetup))) bindConnectionAccount(nextStore, id, account);
    const nextRuntime = buildRuntime(nextEnv, { store: nextStore, allowSimulation: false, extraConnectors: currentSources() });
    if (!nextRuntime.report.google.ok) throw new Error('The Google connection is incomplete.');
    nextRuntime.report.workspaceId = `google:${createHash('sha256').update(credentials.accountId).digest('hex').slice(0, 24)}`;
    const nextGoogle = nextRuntime.connectors.find(connector => connector.id === 'google');
    const nextDocumentProvider = new GoogleDocsWriteProvider({ connector: nextGoogle,
      enabled: nextEnv.GOOGLE_DOCS_WRITE_ENABLED === 'true', shadow: nextRuntime.shadow });
    const nextEngine = new WorkEngine(nextStore, {
      baseUrl: `http://${host}:${port}`, provider: nextRuntime.provider, policy: nextRuntime.policy,
      reasoner: previous.engine.reasoner, documentProvider: nextDocumentProvider, mode: 'live', dateLocale,
      externalTools: scope => [...mcp.tools(scope), ...(engine?.durableRuntime?.tools(scope) || [])],
      stallAfterMs: previous.engine.stallAfterMs,
      onChange(state) { if (applied) sseHub.publish(state); }
    });
    if (nextStore !== previous.store) localSetup.resetObservationHistory();
    store = nextStore; runtime = nextRuntime; runtimeEnv = nextEnv; engine = nextEngine;
    durableRuntime = store.durable ? new DurableRuntime(engine, { connectorFor: id => runtime.connectors.find(connector => connector.id === id) || null, artifactConnectionFor }) : null;
    googleConnector = nextGoogle; documentProvider = nextDocumentProvider;
    googleDisconnectedThisRun = false; runSimulation = false; stateHoldsRealEvents = hasRealEvents(store.state);
    simulation = new SimulationController(store, engine);
    sync = new ConnectorSync({ connectors: runtime.connectors, cursors: runtime.cursors, engine, ...(syncTimeoutMs ? { timeoutMs: syncTimeoutMs } : {}) });
    monitoring = new MonitoringService({ sync, setup: localSetup, connectors: runtime.connectors });
    store.mutateIfChanged(state => { state.runtime = { ...runtime.report, dateLocale: dateLocale || null }; });
    localSetup.markGoogleRuntimeActive();
    if (nextStore !== previous.store) previous.store.close();
    applied = true;
    durableRuntime?.start();
    sseHub.publish(engine.publicState());
    await monitoring.setSettings({ enabled: observe === true });
    if (!observe) void monitoring.runNow();
    return publicSetupStatus();
  } catch (error) {
    if (!applied && nextStore && nextStore !== previous.store) nextStore.close();
    if (!applied && previous.durable?.closed) { durableRuntime = new DurableRuntime(previous.engine, { connectorFor: id => runtime.connectors.find(connector => connector.id === id) || null, artifactConnectionFor }); durableRuntime.start(); }
    // Keep the old workspace paused if a newly saved account could not be
    // applied. A retry uses that saved authorization; it never mixes accounts.
    throw error;
  } finally { workspaceChanging = false; }
}

async function applyConnectedSources({ observe = localSetup.get().monitoring.enabled, request = null, disconnected = null, initialRead = true, refreshSource = null } = {}) {
  if (workspaceChanging || modelSetupBusy) throw new Error('A connection update is already running.');
  workspaceChanging = true;
  if (durableRuntime) durableRuntime.suspended = true;
  try {
    monitoring.stop(); simulation.stop(); engine.policy.shadow = true;
    await Promise.allSettled([...activeHttpHandlers].filter(handler => handler !== request?.workspaceHandler));
    await monitoring.whenIdle(); await engine.whenSettled();
    if (shutdownPromise) throw new Error('The application is shutting down.');
    // Remove revoked local evidence before rebuilding the active sources.
    for (const id of ['local_files', 'apple_notes']) {
      const saved = localSetup.getNativeSource(id), cursor = store.state.cursors?.[id];
      if (!cursor) continue;
      const allowed = new Set((id === 'local_files' ? saved.roots : saved.folders).map(item => item.id || item.folderId));
      const unavailable = Object.entries(cursor.documents || {}).filter(([, doc]) => !saved.scopeId || !allowed.has(doc.rootId || doc.folderId)).map(([documentId]) => ({ id: documentId, reason: 'scope_removed' }));
      if (!unavailable.length) continue;
      const result = nativeSnapshot({ connectorId: id, scopeId: store.state.connectionAccounts?.[id], cursor, unavailable, complete: false, baseUrl: `http://${host}:${port}` });
      for (const event of result.events) engine.ingest(event);
      store.mutate(state => { state.cursors[id] = result.cursor; });
    }
    for (const [id, account] of Object.entries(sourceAccountBindings(localSetup))) if (account || store.state.connectionAccounts?.[id]) bindConnectionAccount(store, id, account);
    if (refreshSource) store.mutate(state => {
      const previous = state.cursors?.[refreshSource];
      if (refreshSource === 'github' && previous?.tracked) state.cursors[refreshSource] = { tracked: previous.tracked };
      else delete state.cursors?.[refreshSource];
      delete state.connectorStatus?.[refreshSource];
    });
    const nextEnv = localSetup.runtimeEnv(process.env);
    if (googleDisconnectedThisRun) for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) delete nextEnv[key];
    const next = buildRuntime(nextEnv, { store, allowSimulation: false, extraConnectors: currentSources() });
    next.report.workspaceId = runtime.report.workspaceId || `workspace:${createHash('sha256').update(store.filename).digest('hex').slice(0, 24)}`;
    if (googleDisconnectedThisRun) next.report.google.disconnectedThisRun = true;
    runtime = next; runtimeEnv = nextEnv;
    googleConnector = runtime.connectors.find(connector => connector.id === 'google') || null;
    documentProvider = googleConnector ? new GoogleDocsWriteProvider({ connector: googleConnector,
      enabled: nextEnv.GOOGLE_DOCS_WRITE_ENABLED === 'true', shadow: runtime.shadow }) : null;
    engine.provider = runtime.provider; engine.policy = runtime.policy; engine.mode = runtime.mode;
    engine.documentProvider = documentProvider; engine.taskServices.documentProvider = documentProvider;
    runSimulation = false;
    sync = new ConnectorSync({ connectors: runtime.connectors, cursors: runtime.cursors, engine, ...(syncTimeoutMs ? { timeoutMs: syncTimeoutMs } : {}) });
    monitoring = new MonitoringService({ sync, setup: localSetup, connectors: runtime.connectors });
    store.mutateIfChanged(state => { state.runtime = { ...runtime.report, dateLocale: dateLocale || null }; });
    for (const task of Object.values(store.state.tasks)) if (!task.action && !['completed', 'cancelled'].includes(task.status)) engine.assess(task.id, null, { force: true, allowAutomation: false });
    engine.changed();
    if (runtime.live) {
      await monitoring.setSettings({ enabled: observe === true });
      if (!observe && initialRead) void monitoring.runNow();
    } else await monitoring.setSettings({ enabled: false });
    return publicSetupStatus();
  } finally { workspaceChanging = false; if (durableRuntime) { durableRuntime.suspended = false; durableRuntime.kick(); } }
}

function disconnectGoogleForThisRun() {
  googleDisconnectedThisRun = true;
  // The engine and both Google write paths share this policy/connector. Make
  // every future operation fail closed before awaiting an in-flight sync.
  runtime.live = false;
  runtime.shadow = true;
  runtime.policy.shadow = true;
  engine.policy.shadow = true;
  if (googleConnector) {
    googleConnector.live = false;
    googleConnector.config.readGmail = false;
    googleConnector.config.readDrive = false;
    googleConnector.config.sendEnabled = false;
    googleConnector.sendEnabled = false;
    googleConnector.shadow = true;
    if (googleConnector.auth) {
      googleConnector.auth.clientId = null;
      googleConnector.auth.clientSecret = null;
      googleConnector.auth.refreshToken = null;
      googleConnector.auth.cached = null;
    }
  }
  if (documentProvider) {
    documentProvider.enabled = false;
    documentProvider.shadow = true;
    if (documentProvider.connector?.auth) {
      documentProvider.connector.auth.clientId = null;
      documentProvider.connector.auth.clientSecret = null;
      documentProvider.connector.auth.refreshToken = null;
      documentProvider.connector.auth.cached = null;
    }
  }
  runtime.report.shadow = true;
  runtime.report.eventSource = 'disconnected';
  runtime.report.note = 'Google is disconnected. Reconnect your account in the interface to resume; existing work records are retained.';
  runtime.report.mailProvider = 'disabled';
  runtime.report.google = {
    ...runtime.report.google,
    ok: false,
    disconnectedThisRun: true,
    detail: runtime.report.note,
    readGmail: false,
    readDrive: false,
    sendEnabled: false,
    credentialsConfiguredExternally: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN)
  };
  store.mutateIfChanged(state => { state.runtime = { ...runtime.report, dateLocale: dateLocale || null }; });
}

const activeHttpHandlers = new Set();
const server = http.createServer((req, res) => {
  const handler = handleHttpRequest(req, res);
  req.workspaceHandler = handler;
  activeHttpHandlers.add(handler);
  handler.then(() => activeHttpHandlers.delete(handler), () => activeHttpHandlers.delete(handler));
});
server.requestTimeout = requestTimeoutMs;
server.headersTimeout = Math.min(15_000, requestTimeoutMs);
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
let shutdownPromise = null;

async function handleHttpRequest(req, res) {
  let url;
  try { url = new URL(req.url, `http://${host}:${port}`); }
  catch { return json(res, 400, { error: 'Invalid request target.' }); }
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        processId: process.pid,
        mode: runtime.mode,
        shadow: runtime.shadow,
        revision: store.state.revision,
        schemaVersion: store.state.schemaVersion,
        mailProvider: googleDisconnectedThisRun ? 'disabled' : runtime.provider.kind,
        eventSource: googleDisconnectedThisRun ? 'disconnected' : runtime.report.eventSource,
        googleRuntimeDisabled: googleDisconnectedThisRun,
        reasoner: engine.reasoner.status ? engine.reasoner.status() : { id: 'none' }
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/setup') {
      return json(res, 200, {
        ...publicSetupStatus(),
        oauth: googleOAuth.describe(),
        desktopApp: process.env.UNPROMPTED_DESKTOP_APP === '1'
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/mcp') return json(res, 200, mcp.describe());
    if (req.method === 'GET' && url.pathname === '/api/artifact-grants') return json(res, 200, durableRuntime?.artifacts.describe() || { available: false, grants: [], targets: [] });
    if (req.method === 'GET' && url.pathname === '/api/durable') return json(res, 200, durableRuntime?.describe() || { version: 'legacy-demo', available: false });
    if (req.method === 'GET' && url.pathname === '/api/situations') return json(res, 200, { situations: durableRuntime?.tasks.situations.listActive() || [], available: Boolean(durableRuntime) });
    if (req.method === 'GET' && url.pathname === '/api/standing-intents') return json(res, 200, { intents: durableRuntime?.intents.list() || [], available: Boolean(durableRuntime) });
    if (req.method === 'GET' && url.pathname === '/api/activation/metrics') return json(res, 200, durableRuntime ? durableRuntime.activationMetrics() : { available: false });
    if (req.method === 'GET' && url.pathname === '/api/experiences') return json(res, 200, { experiences: durableRuntime?.experiences.list() || [] });
    if (req.method === 'GET' && url.pathname === '/api/policies') return json(res, 200, { policies: durableRuntime?.policies.list() || [] });
    const privacyStatus = url.pathname.match(/^\/api\/privacy\/requests\/([^/]+)$/);
    if (req.method === 'GET' && privacyStatus) {
      const result = durableRuntime?.privacy.get(decodeURIComponent(privacyStatus[1]));
      return json(res, result ? 200 : 404, result || { error: 'Deletion request not found.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, engine.publicState());
    const localDocumentRoute = url.pathname.match(/^\/api\/local-sources\/documents\/([^/]+)$/);
    if (req.method === 'GET' && localDocumentRoute) {
      if (workspaceChanging) return json(res, 409, { error: 'The workspace connection is being updated.' });
      const id = decodeURIComponent(localDocumentRoute[1]), doc = store.state.documents[id];
      const source = doc?.source;
      if (!['local_files', 'apple_notes'].includes(source) || doc.available === false) return json(res, 404, { error: 'This local document is no longer available.' });
      const grant = localSetup.getNativeSource(source), known = store.state.cursors?.[source]?.documents?.[id];
      if (!grant.scopeId || !id.startsWith(`${source}:${grant.scopeId}:`) || !known) return json(res, 404, { error: 'This local document is outside the connected scope.' });
      try {
        let content;
        if (source === 'local_files') {
          const selected = grant.roots.find(item => item.id === known.rootId);
          if (!selected || canonicalLocalRoot(selected.path) !== selected.path) throw new Error('Unavailable');
          content = readScopedText(selected.path, known.relative);
        } else {
          const selected = grant.folders.find(item => item.folderId === known.folderId && item.accountId === known.accountId);
          if (!selected) throw new Error('Unavailable');
          const result = await nativeBridge.readNotes([selected], {});
          const record = result.records?.find(item => item.providerId === known.providerId && item.folderId === selected.folderId && item.accountId === selected.accountId);
          if (!record || record.unavailable || typeof record.content !== 'string') throw new Error('Unavailable');
          content = record.content;
        }
        // Recheck after a native read: disconnecting while it ran revokes delivery.
        if (workspaceChanging || localSetup.getNativeSource(source).scopeId !== grant.scopeId || !runtime.connectors.some(item => item.id === source && item.live)) throw new Error('Unavailable');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
        return res.end(content);
      } catch { return json(res, 409, { error: 'The selected document could not be read. Check its current access and observe again.', code: 'LOCAL_DOCUMENT_UNAVAILABLE' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/metrics') return json(res, 200, engine.publicState().metrics);
    if (req.method === 'GET' && url.pathname === '/api/trace') {
      // One task's whole decision chain, or the most recent entries overall.
      const taskId = url.searchParams.get('taskId');
      if (taskId) return json(res, 200, engine.decisionTrace(taskId));
      return json(res, 200, { entries: (store.state.trace || []).slice(-100) });
    }
    if (req.method === 'GET' && url.pathname === '/api/runtime') {
      return json(res, 200, {
        ...runtime.report,
        simulationRunning: simulationCanStart(),
        demo: { enabled: hasGuidedSimulation() && simulationCanStart(), disposable: demoMode, startsOnConnection: hasGuidedSimulation(), ruleBased: (ruleDemoEnabled || process.env.UNPROMPTED_RULE_ONLY === 'true') && !engine.reasoner.available() },
        reasoner: engine.reasoner.status(),
        googleRuntimeDisabled: googleDisconnectedThisRun,
        scenarios: simulation.describe(),
        connectors: runtime.connectors.map(connector => connector.describe()),
        artifacts: durableRuntime?.artifacts.describe() || { available: false, targets: [], grants: [] },
        monitoring: monitoring.describe(),
        sync: sync.describe(),
        ...runtime.cursors.describe()
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const accepted = sseHub.add(req, res, engine.publicState());
      if (accepted && hasGuidedSimulation() && simulationCanStart() && !demoStarted) {
        demoStarted = true;
        simulation.start();
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      // Browsers request this automatically. Answer it so the console stays clean
      // and a real failure is not hidden behind expected noise.
      res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      return res.end();
    }
    if (req.method === 'GET' && /^\/documents\/[a-z0-9-]+$/i.test(url.pathname)) {
      const id = url.pathname.split('/')[2];
      const doc = store.state.documents[id];
      if (!doc) return json(res, 404, { error: 'Document not found' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.title)} · simulated document</title><style>body{max-width:780px;margin:60px auto;padding:0 24px;background:#f7f7f3;color:#192528;font:16px/1.7 ui-sans-serif,system-ui}a{color:#146b66}header{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#657878}pre{white-space:pre-wrap;font:inherit;background:white;border:1px solid #e3e6e0;border-radius:16px;padding:35px}small{color:#657878}</style><header>Local simulation · document version ${doc.version}</header><p><a href="/">← Back to Unprompted</a></p><pre>${escapeHtml(doc.content)}</pre><small>This is a locally simulated document. It is not a shared cloud document.</small></html>`);
    }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: 'Cross-origin requests are not allowed' });
      const body = await readJsonBody(req, httpBodyLimits);
      if (workspaceChanging) return json(res, 409, { error: 'Your workspace connection is being updated. Try again shortly.', code: 'WORKSPACE_CONNECTING' });

      if (url.pathname === '/api/connectors/google/search') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['source', 'query', 'limit', 'pageToken'].includes(key))) return json(res, 400, { error: 'Choose a valid source, search query and page.', code: 'SEARCH_FAILED' });
        const connector = googleConnector, activeEngine = engine;
        if (!connector?.live || !runtime.connectors.includes(connector)) return json(res, 409, { error: 'Connect Google before searching.', code: 'CONNECTOR_UNAVAILABLE' });
        const guard = () => {
          if (workspaceChanging || engine !== activeEngine || googleConnector !== connector || !connector.live)
            throw Object.assign(new Error('The connection changed during search.'), { code: 'AUTHORIZATION_REQUIRED', status: 403 });
          activeEngine.toolGateway.authorizeRead();
        };
        try {
          guard();
          const result = await activeEngine.toolGateway.read(signal => connector.search(body, { signal, beforeRequest: guard }));
          guard();
          return json(res, 200, result);
        } catch (error) {
          const status = [400, 401, 403, 429, 504].includes(Number(error.status)) ? Number(error.status) : 502;
          return json(res, status, { error: status === 400 ? 'Choose a valid source, search query and page.' : 'Search could not complete. Check the connection and try again.', code: status === 403 ? 'SEARCH_NOT_AUTHORIZED' : 'SEARCH_FAILED' });
        }
      }

      if (/^\/api\/artifact-grants(?:\/|$)/.test(url.pathname) || /^\/api\/tasks\/[^/]+\/artifacts$/.test(url.pathname)) {
        if (!durableRuntime || demoMode) return json(res, 409, { error: 'Open the persistent workspace to authorize artifact creation.', code: 'DURABLE_WORKSPACE_REQUIRED' });
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid artifact request.' });
        if (url.pathname === '/api/artifact-grants') {
          if (process.env.UNPROMPTED_SHADOW_MODE === 'true') return json(res, 403, { error: 'The launch environment explicitly requires read-only mode.', code: 'SHADOW_MODE' });
          const grant = await durableRuntime.artifacts.createGrant(body, { actor: 'user', confirmed: body.confirmed === true });
          localSetup.setArtifactWrites(true);
          await applyConnectedSources({ request: req, initialRead: false });
          engine.investigateWithTools();
          for (const task of Object.values(store.state.tasks)) durableRuntime.artifacts.schedulePrepared(task);
          return json(res, 200, { grant, setup: publicSetupStatus(), state: engine.publicState() });
        }
        const revoke = url.pathname.match(/^\/api\/artifact-grants\/([^/]+)\/revoke$/);
        if (revoke) {
          durableRuntime.artifacts.revoke(decodeURIComponent(revoke[1]));
          return json(res, 200, { setup: publicSetupStatus(), state: engine.publicState() });
        }
        const taskArtifact = url.pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts$/);
        if (taskArtifact) {
          if (Object.keys(body).some(key => !['grantId', 'title', 'body', 'reviewToken'].includes(key))) return json(res, 400, { error: 'Invalid artifact request.' });
          const { reviewToken, ...input } = body;
          const artifact = durableRuntime.artifacts.request(decodeURIComponent(taskArtifact[1]), input, { actor: 'user', reviewToken });
          return json(res, 202, { artifact, state: engine.publicState() });
        }
        return json(res, 404, { error: 'Unknown artifact operation.' });
      }

      if (/^\/api\/(privacy|policies|instructions|experiences|executions|standing-intents|activation)(?:\/|$)/.test(url.pathname) || /^\/api\/tasks\/[^/]+\/(?:draft|resume-yield)$/.test(url.pathname) || /^\/api\/situations\/[^/]+\/probe$/.test(url.pathname)) {
        if (!durableRuntime) return json(res, 409, { error: 'Open the persistent SQLite workspace for this operation.', code: 'DURABLE_WORKSPACE_REQUIRED' });
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid request body.' });
        const situationProbe = url.pathname.match(/^\/api\/situations\/([^/]+)\/probe$/);
        if (situationProbe) {
          if (Object.keys(body).some(key => !['sourceEventId', 'scheduledAt'].includes(key))) return json(res, 400, { error: 'Invalid probe configuration.', code: 'INVALID_PROBE' });
          const job = durableRuntime.configureSituationProbe(decodeURIComponent(situationProbe[1]), body);
          return json(res, 200, { jobId: job.id, situation: durableRuntime.tasks.situations.get(decodeURIComponent(situationProbe[1])) });
        }
        if (url.pathname === '/api/standing-intents') {
          if (body.confirmed !== true) return json(res, 403, { error: 'An explicit confirmation is required.', code: 'INTENT_CONFIRMATION_REQUIRED' });
          return json(res, 200, { intent: durableRuntime.intents.create(body, { actor: 'user', confirmed: true }) });
        }
        const intentTransition = url.pathname.match(/^\/api\/standing-intents\/([^/]+)\/(pause|resume|disable)$/);
        if (intentTransition) {
          const status = intentTransition[2] === 'resume' ? 'active' : intentTransition[2] === 'pause' ? 'paused' : 'disabled';
          return json(res, 200, { intent: durableRuntime.intents.transition(decodeURIComponent(intentTransition[1]), body.expectedVersion, status) });
        }
        if (url.pathname === '/api/activation/flags') return json(res, 200, { flags: durableRuntime.setFlags(body) });
        if (url.pathname === '/api/privacy/revoke') {
          const revocation = await durableRuntime.privacy.revokePermission({ connectorId: body.connectorId, purgeLocal: body.purgeLocal === true });
          engine.changed();
          return json(res, 200, revocation);
        }
        const resumeYield = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume-yield$/);
        if (resumeYield) {
          durableRuntime.resumeYield(decodeURIComponent(resumeYield[1]), body.expectedVersion);
          return json(res, 200, { state: engine.publicState() });
        }
        if (url.pathname === '/api/privacy/preview') {
          const preview = durableRuntime.privacy.preview(body.kind, body.id);
          return json(res, 200, { counts: preview.counts });
        }
        const retryDeletion = url.pathname.match(/^\/api\/privacy\/requests\/([^/]+)\/retry$/);
        if (retryDeletion) { const deletion = await durableRuntime.privacy.finish(decodeURIComponent(retryDeletion[1])); if (!deletion) return json(res, 404, { error: 'Deletion request not found.' }); engine.changed(); return json(res, 200, { deletion, state: engine.publicState() }); }
        if (url.pathname === '/api/privacy/forget') {
          const result = await durableRuntime.privacy.forget(body);
          return json(res, 200, { deletion: result, state: engine.publicState() });
        }
        if (url.pathname === '/api/policies') {
          const policy = durableRuntime.policies.save(body); durableRuntime.contextChanged(); engine.changed();
          return json(res, 200, { policy, state: engine.publicState() });
        }
        const policyDisable = url.pathname.match(/^\/api\/policies\/([^/]+)\/disable$/);
        if (policyDisable) { const policy = durableRuntime.policies.disable(decodeURIComponent(policyDisable[1]), body.expectedVersion); durableRuntime.contextChanged(); engine.changed(); return json(res, 200, { policy, state: engine.publicState() }); }
        if (url.pathname === '/api/experiences/policy') { const policy = durableRuntime.experiences.configurePolicy(body); engine.changed(); return json(res, 200, { policy }); }
        if (url.pathname === '/api/experiences/context-policy') return json(res, 200, { policy: durableRuntime.context.configure(body) });
        if (url.pathname === '/api/experiences/replay') return json(res, 200, durableRuntime.replay.retrieval(body.cases, body.options));
        if (url.pathname === '/api/experiences/retrieval-policy') { const policy = durableRuntime.memory.configure(body); durableRuntime.contextChanged(); return json(res, 200, { policy }); }
        if (url.pathname === '/api/experiences/attention-policy') { const attention = store.attention.configure(body); engine.changed(); return json(res, 200, { attention }); }
        const editDraft = url.pathname.match(/^\/api\/tasks\/([^/]+)\/draft$/);
        if (editDraft) { durableRuntime.editDraft(decodeURIComponent(editDraft[1]), body); return json(res, 200, { state: engine.publicState() }); }
        const promote = url.pathname.match(/^\/api\/experiences\/([^/]+)\/promote$/);
        if (promote) { const experience = durableRuntime.experiences.promote(decodeURIComponent(promote[1]), { expectedRevision: body.expectedRevision, userRequested: true }); durableRuntime.contextChanged(); engine.changed(); return json(res, 200, { experience }); }
        const retire = url.pathname.match(/^\/api\/experiences\/([^/]+)\/retire$/);
        if (retire) { const experience = durableRuntime.experiences.retire(decodeURIComponent(retire[1]), body.expectedRevision); durableRuntime.contextChanged(); engine.changed(); return json(res, 200, { experience }); }
        const trial = url.pathname.match(/^\/api\/experiences\/([^/]+)\/trial$/);
        if (trial) { const result = await durableRuntime.trial(decodeURIComponent(trial[1]), body); return json(res, 200, { ...result, state: engine.publicState() }); }
        const reconcileExecution = url.pathname.match(/^\/api\/executions\/([^/]+)\/reconcile$/);
        if (reconcileExecution) { await durableRuntime.reconcileExecution(decodeURIComponent(reconcileExecution[1])); return json(res, 200, { state: engine.publicState() }); }
        if (url.pathname === '/api/instructions') { const result = durableRuntime.ingestInstruction(body); engine.changed(); return json(res, 200, { ...result, state: engine.publicState() }); }
      }

      if (url.pathname === '/api/mcp/import' || /^\/api\/mcp\/servers\/[^/]+$/.test(url.pathname)) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid MCP request body.' });
        if (demoMode) return json(res, 409, { error: 'Open your persistent workspace to connect MCP services.', code: 'DISPOSABLE_DEMO' });
        const result = url.pathname === '/api/mcp/import'
          ? await mcp.import(body.config, { allowDeclaredRead: body.allowDeclaredRead === true })
          : await mcp.update(decodeURIComponent(url.pathname.split('/').pop()), body);
        engine.investigateWithTools();
        return json(res, 200, { mcp: result, setup: publicSetupStatus() });
      }

      const nativeRoute = url.pathname.match(/^\/api\/setup\/local-sources\/(local_files|apple_notes)\/(select|forget|remove-scope)$/);
      if (nativeRoute) {
        const [, id, operation] = nativeRoute;
        if (demoMode) return json(res, 409, { error: 'Open your persistent workspace to connect local sources.', code: 'DISPOSABLE_DEMO' });
        if (nativeSelectionBusy || modelSetupBusy) return json(res, 409, { error: 'A source selection or model update is already open.', code: 'SOURCE_BUSY' });
        if (id === 'apple_notes' && nativeBridge.platform !== 'darwin') return json(res, 400, { error: 'Apple Notes requires macOS.', code: 'UNSUPPORTED' });
        const controller = new AbortController();
        const abandon = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', abandon); nativeSelectionBusy = true;
        try {
          const saved = localSetup.getNativeSource(id);
          if (operation === 'forget') {
            localSetup.clearNativeSource(id);
            if (body?.purgeLocal === true) await monitoring.whenIdle();
            if (durableRuntime) await durableRuntime.privacy.revokePermission({ connectorId: id, purgeLocal: body?.purgeLocal === true });
          } else if (operation === 'remove-scope') {
            const key = id === 'local_files' ? 'roots' : 'folders';
            const index = typeof body?.id === 'string' ? saved[key].findIndex(item => publicScopeId(item) === body.id) : body?.index;
            if (!Number.isInteger(index) || index < 0 || index >= saved[key].length) return json(res, 400, { error: 'This folder is no longer connected. Refresh and select a current folder.' });
            saved[key].splice(index, 1);
            if (saved[key].length) localSetup.saveNativeSource(id, saved); else localSetup.clearNativeSource(id);
          } else {
            let selection;
            if (id === 'local_files') {
              const paths = typeof body?.path === 'string' ? [body.path] : (await nativeBridge.chooseFiles({ locale: body?.locale, signal: controller.signal })).paths;
              if (!Array.isArray(paths) || !paths.length || paths.length > 10) return json(res, 400, { error: 'Select up to 10 specific local folders.' });
              let roots;
              try { roots = mergeLocalRoots(saved.roots, paths, randomUUID); }
              catch { return json(res, 400, { error: 'Select up to 10 accessible folders using their absolute paths.', code: 'FOLDER_UNAVAILABLE' }); }
              selection = { ...saved, scopeId: saved.scopeId || randomUUID(), roots };
            } else {
              const picked = await nativeBridge.chooseNotes({ locale: body?.locale, signal: controller.signal });
              if (!Array.isArray(picked.folders) || !picked.folders.length) throw new NativeAccessError('NO_FOLDERS');
              const folders = [...saved.folders];
              for (const folder of picked.folders) if (!folders.some(item => item.folderId === folder.folderId && item.accountId === folder.accountId)) folders.push(folder);
              if (folders.length > 20) return json(res, 400, { error: 'Select up to 20 Notes folders.' });
              selection = { ...saved, scopeId: saved.scopeId || randomUUID(), folders };
            }
            if (controller.signal.aborted) return;
            if (workspaceChanging || modelSetupBusy) return json(res, 409, { error: 'The workspace changed while the picker was open. Select the folder again.', code: 'WORKSPACE_CONNECTING' });
            localSetup.saveNativeSource(id, selection);
          }
          await applyConnectedSources({ request: req, initialRead: operation === 'select', observe: operation === 'select' ? body?.observe !== false : localSetup.get().monitoring.enabled });
          return json(res, 200, { setup: publicSetupStatus(), state: engine.publicState() });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof NativeAccessError) return json(res, error.code === 'CANCELLED' ? 200 : 400, { cancelled: error.code === 'CANCELLED', error: error.code === 'CANCELLED' ? undefined : error.message, code: error.code, setup: publicSetupStatus() });
          return json(res, 500, { error: 'The local source could not be applied. Check its connection and retry.', code: 'LOCAL_SOURCE_FAILED' });
        } finally { nativeSelectionBusy = false; res.off('close', abandon); }
      }

      const connectionRoute = url.pathname.match(/^\/api\/setup\/connections\/(github|microsoft|slack|notion)\/(authorize|cancel|activate|forget)$/);
      if (connectionRoute) {
        const [, id, operation] = connectionRoute;
        const oauth = connectionOAuth(id);
        if (demoMode) return json(res, 409, { error: 'Open your persistent workspace with npm start to connect accounts.', code: 'DISPOSABLE_DEMO' });
        if (operation === 'authorize') {
          try {
            const started = connectionProvider(id).flow === 'code'
              ? await codeOAuth.start(id, { clientId: body?.clientId, clientSecret: body?.clientSecret, observe: body?.observe !== false })
              : await deviceOAuth.start(id, { clientId: body?.clientId, observe: body?.observe !== false, drafts: body?.drafts === true });
            return json(res, 200, { oauth: started });
          }
          catch (error) { return json(res, 400, { error: error.message, code: 'AUTH_START_FAILED' }); }
        }
        if (operation === 'cancel') { oauth.cancel(id); return json(res, 200, { setup: publicSetupStatus() }); }
        if (operation === 'forget') {
          oauth.cancel(id);
          const connector = runtime.connectors.find(connector => connector.id === id);
          if (connector) { connector.live = false; if (connector.auth) connector.auth.disabled = true; }
          localSetup.clearConnection(id);
          if (body?.purgeLocal === true) await monitoring.whenIdle();
          if (durableRuntime) await durableRuntime.privacy.revokePermission({ connectorId: id, purgeLocal: body?.purgeLocal === true });
          await applyConnectedSources({ request: req, disconnected: id, initialRead: false });
          return json(res, 200, { setup: publicSetupStatus(), state: engine.publicState() });
        }
        if (!localSetup.getConnection(id).accessToken) return json(res, 409, { error: 'Authorize this account first.' });
        await applyConnectedSources({ request: req, observe: body?.observe !== false });
        return json(res, 200, { setup: publicSetupStatus(), state: engine.publicState() });
      }

      if (url.pathname === '/api/setup/model') {
        if (demoMode) return json(res, 409, { error: 'Start your persistent workspace with npm start before connecting a model.', code: 'DISPOSABLE_DEMO' });
        if (modelSetupBusy || engine.pendingReasoning.size || engine.pendingDiscovery.size) return json(res, 409, { error: 'Model reasoning is running. Wait for it to finish before changing the connection.', code: 'MODEL_BUSY' });
        if (process.env.UNPROMPTED_MODEL_BASE_URL || process.env.UNPROMPTED_MODEL_NAME) return json(res, 409, { error: 'The model is configured by the launch environment. Update those settings and restart, or remove them to use the interface.', code: 'MODEL_ENV_CONFIGURED' });
        modelSetupBusy = true;
        try {
          const settings = normalizeModelSettings(body, localSetup.get().model);
          const checked = await validateModelSettings(settings, { budgetEnv: process.env });
          if (engine.pendingReasoning.size || engine.pendingDiscovery.size) throw new ModelSetupError('MODEL_BUSY', 'Model reasoning started during the check. Wait for it to finish and try again.', 409);
          localSetup.saveModel(settings, checked.validation);
          engine.replaceReasoner(checked.reasoner);
          if (runSimulation && !runtime.live && !stateHoldsRealEvents) {
            runtime.shadow = false; runtime.policy.shadow = false; runtime.report.shadow = false;
            runtime.report.note = 'Model-connected sample workspace. Context and delivery are simulated; no real external writes are enabled.';
            store.mutateIfChanged(state => { state.runtime = { ...runtime.report, dateLocale: dateLocale || null }; });
          }
          if (simulationCanStart() && !demoStarted && !runtime.live) { demoStarted = true; simulation.start(); }
          return json(res, 200, { ok: true, setup: publicSetupStatus(), state: engine.publicState() });
        } catch (error) {
          if (error instanceof ModelSetupError) return json(res, error.status, { error: error.message, code: error.code });
          return json(res, 500, { error: 'The model settings could not be fully applied. Reload to check the current connection before retrying.', code: 'MODEL_SAVE_FAILED' });
        } finally { modelSetupBusy = false; }
      }
      if (url.pathname === '/api/setup/model/forget') {
        if (modelSetupBusy || engine.pendingReasoning.size || engine.pendingDiscovery.size) return json(res, 409, { error: 'Wait for current model reasoning to finish before disconnecting.', code: 'MODEL_BUSY' });
        if (process.env.UNPROMPTED_MODEL_BASE_URL || process.env.UNPROMPTED_MODEL_NAME) return json(res, 409, { error: 'Remove the model configuration from the launch environment to disconnect it.', code: 'MODEL_ENV_CONFIGURED' });
        localSetup.clearModel();
        const disconnected = createReasoner({});
        disconnected.preferModelInterpretation = !ruleDemoEnabled && process.env.UNPROMPTED_RULE_ONLY !== 'true';
        engine.replaceReasoner(disconnected);
        if (!ruleDemoEnabled) { simulation.stop(); demoStarted = false; }
        return json(res, 200, { setup: publicSetupStatus(), state: engine.publicState() });
      }

      if (url.pathname === '/api/setup/monitoring') {
        const state = await monitoring.setSettings({ enabled: body?.enabled, intervalMs: body?.intervalMs });
        return json(res, 200, { monitoring: state });
      }
      if (url.pathname === '/api/setup/google/client') {
        if (process.env.GOOGLE_REFRESH_TOKEN) return json(res, 409, { error: 'The launch environment controls this Google connection.', code: 'GOOGLE_ENV_CONFIGURED' });
        googleOAuth.cancel();
        const client = localSetup.saveDesktopClientJson(body?.clientJson);
        return json(res, 200, { setup: publicSetupStatus(), saved: Boolean(client.google.clientId) });
      }
      if (url.pathname === '/api/setup/google/authorize') {
        if (process.env.GOOGLE_REFRESH_TOKEN) return json(res, 409, { error: 'The launch environment controls this Google connection.', code: 'GOOGLE_ENV_CONFIGURED' });
        if (demoMode) return json(res, 409, { error: 'Start your persistent workspace with npm start to connect your account.', code: 'DISPOSABLE_DEMO' });
        const result = await googleOAuth.start({ scopes: body?.scopes, observe: body?.observe !== false,
          allowExternalWrites: body?.allowExternalWrites === true, locale: body?.locale, returnUrl: `http://${host}:${port}/` });
        return json(res, 200, { ...result, oauth: googleOAuth.describe() });
      }
      if (url.pathname === '/api/setup/google/cancel') {
        googleOAuth.cancel();
        return json(res, 200, { oauth: googleOAuth.describe(), setup: publicSetupStatus() });
      }
      if (url.pathname === '/api/setup/google/activate') {
        try { await activateGoogleWorkspace({ observe: body?.observe !== false, request: req }); }
        catch { return json(res, 409, { error: 'Your saved Google authorization could not be applied. Check the connection and retry.', code: 'GOOGLE_ACTIVATION_FAILED' }); }
        return json(res, 200, { setup: publicSetupStatus(), state: engine.publicState() });
      }
      if (url.pathname === '/api/setup/google/permissions') {
        if (process.env.GOOGLE_REFRESH_TOKEN) return json(res, 409, { error: 'The launch environment controls this Google connection.', code: 'GOOGLE_ENV_CONFIGURED' });
        const result = localSetup.setExternalWrites(body?.allowExternalWrites);
        await activateGoogleWorkspace({ request: req });
        return json(res, 200, { setup: publicSetupStatus(), allowExternalWrites: result.permissions.allowExternalWrites, restartRequired: false });
      }
      if (url.pathname === '/api/setup/google/validate') {
        if (googleDisconnectedThisRun) return json(res, 409, { error: 'Google is disconnected. Reconnect before validating the account.' });
        const credentials = process.env.GOOGLE_REFRESH_TOKEN ? { clientId: runtimeEnv.GOOGLE_CLIENT_ID,
          clientSecret: runtimeEnv.GOOGLE_CLIENT_SECRET, refreshToken: runtimeEnv.GOOGLE_REFRESH_TOKEN,
          accountEmail: runtimeEnv.GOOGLE_ACCOUNT_EMAIL } : localSetup.get().google;
        if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
          return json(res, 409, { error: 'Complete Google Desktop OAuth authorization first.' });
        }
        try {
          const auth = new GoogleAuth({
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            refreshToken: credentials.refreshToken,
            timeoutMs: 15000
          });
          await auth.accessToken();
          if (process.env.GOOGLE_REFRESH_TOKEN) googleValidationThisRun = { status: 'validated', error: null };
          else localSetup.setGoogleValidation({ ok: true });
          return json(res, 200, { ok: true, accountEmail: credentials.accountEmail || null, status: runtime.live ? 'Google token refresh succeeded. Workspace data has not been synced by this check.' : 'Google token refresh succeeded. Apply the saved connection to activate your workspace.' });
        } catch {
          if (process.env.GOOGLE_REFRESH_TOKEN) googleValidationThisRun = { status: 'failed', error: 'Google authorization could not be validated. Reauthorize the account and try again.' };
          else localSetup.setGoogleValidation({ ok: false, error: 'Google authorization could not be validated. Reauthorize the account and try again.' });
          return json(res, 400, { error: 'Google could not validate this authorization. Reauthorize the account and try again.' });
        }
      }
      if (url.pathname === '/api/setup/google/forget') {
        const purgeLocal = body?.purgeLocal === true;
        const previousObservation = localSetup.get().monitoring.enabled;
        googleOAuth.cancel();
        localSetup.clearGoogle({ keepClient: true });
        localSetup.clearRestartRequired();
        await monitoring.setSettings({ enabled: false });
        monitoring.stop();
        disconnectGoogleForThisRun();
        if (purgeLocal) await monitoring.whenIdle();
        if (durableRuntime) await durableRuntime.privacy.revokePermission({ connectorId: 'google', purgeLocal });
        // A clear waits for the sync that was already running, deletes what it wrote,
        // then waits once more so that sync cannot append after the deletion.
        await monitoring.whenIdle();
        if (runtime.connectors.some(connector => connector.id !== 'google' && connector.live)) await applyConnectedSources({ request: req, observe: previousObservation });
        return json(res, 200, { setup: publicSetupStatus(), restartRequired: false, runtimeDisabled: true });
      }
      if (url.pathname === '/api/setup/restart') {
        if (process.env.UNPROMPTED_DESKTOP_APP !== '1') return json(res, 409, { error: 'Restart the local service with the same state file to apply saved Google credentials.' });
        json(res, 200, { restarting: true });
        setTimeout(() => { void shutdown(75); }, 100);
        return;
      }

      if (url.pathname === '/api/connectors/sync') {
        if (googleDisconnectedThisRun && !runtime.connectors.some(connector => connector.live)) return json(res, 409, { error: 'Connect an account before checking for changes.' });
        return json(res, 200, await monitoring.runNow());
      }
      if (url.pathname === '/api/reasoning/retry') {
        if (body?.taskId != null && (typeof body.taskId !== 'string' || !store.state.tasks[body.taskId])) return json(res, 400, { error: 'Unknown task' });
        engine.retryPendingReasoning(body?.taskId || null, { dueOnly: false });
        return json(res, 200, { state: engine.publicState() });
      }
      if (url.pathname === '/api/simulation/events') {
        if (!runSimulation) return json(res, 409, { error: simulationDisabledReason });
        return json(res, 200, engine.ingest({ ...body, source: 'simulated', connectorId: 'simulated' }));
      }
      if (url.pathname === '/api/demo/restart') {
        if (!runSimulation) return json(res, 409, { error: simulationDisabledReason });
        const scenario = simulation.reset(body?.scenario || null);
        if (seedDemoMemories(store, { count: demoMemoryCount, demo: demoMode })) engine.changed();
        return json(res, 200, { scenario, state: engine.publicState() });
      }
      // Calibration records what the user stated, or corrects the system's
      // understanding of it. Both are explicit user actions.
      if (url.pathname === '/api/calibrations') {
        const { key, kind, value, scope, instruction } = body || {};
        if (!key || value == null) return json(res, 400, { error: 'A calibration requires a key and a value' });
        const entry = instruction === 'correct'
          ? engine.correctCalibration({ key, kind, value, scope })
          : engine.recordCalibration({ key, kind, value, scope });
        return json(res, 200, { calibration: entry, state: engine.publicState() });
      }
      const clarificationRoute = url.pathname.match(/^\/api\/clarifications\/([^/]+)\/answer$/);
      if (clarificationRoute) {
        const value = body?.value;
        if (value == null) return json(res, 400, { error: 'An answer requires a value' });
        const entry = engine.answerClarification(decodeURIComponent(clarificationRoute[1]), value);
        return json(res, 200, { calibration: entry, state: engine.publicState() });
      }
      // Accepting an opportunity records a decision only; it never
      // starts a project or commits a resource.
      const opportunityRoute = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/(accept|dismiss)$/);
      if (opportunityRoute) {
        const id = decodeURIComponent(opportunityRoute[1]);
        const opportunity = opportunityRoute[2] === 'accept'
          ? engine.acceptOpportunity(id)
          : engine.dismissOpportunity(id, body?.note || null);
        return json(res, 200, { opportunity, state: engine.publicState() });
      }
      if (url.pathname === '/api/notifications/read') {
        const marked = engine.markNotificationsRead(body?.ids || null);
        return json(res, 200, { marked, state: engine.publicState() });
      }
      const taskControlRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|direction|undo-direction)$/);
      if (taskControlRoute) {
        const id = decodeURIComponent(taskControlRoute[1]), operation = taskControlRoute[2];
        const result = operation === 'pause' || operation === 'resume'
          ? engine.setTaskPaused(id, operation === 'pause')
          : operation === 'direction' ? engine.directTask(id, body) : engine.undoTaskDirection(id, body?.id);
        return json(res, 200, { result, state: engine.publicState() });
      }
      const memoryRoute = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
      if (memoryRoute) return json(res, 200, { memory: engine.updateTaskMemory(decodeURIComponent(memoryRoute[1]), body), state: engine.publicState() });
      const feedbackRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/feedback$/);
      if (feedbackRoute) {
        const taskId = decodeURIComponent(feedbackRoute[1]);
        const corrections = ['not_mine', 'duplicate', 'already_handled', 'wrong_association'];
        if (corrections.includes(body?.label)) {
          const feedback = engine.recordTaskFeedback(taskId, {
            label: body.label,
            scope: body.scope,
            relatedTaskId: body.relatedTaskId,
            reason: body.reason
          });
          return json(res, 200, { feedback, task: store.state.tasks[taskId], state: engine.publicState() });
        }
        const task = engine.labelDiscovery(taskId, { label: body?.label, reason: body?.reason });
        return json(res, 200, { task, state: engine.publicState() });
      }
      const feedbackUndoRoute = url.pathname.match(/^\/api\/feedback\/([^/]+)\/undo$/);
      if (feedbackUndoRoute) {
        const feedback = engine.undoTaskFeedback(decodeURIComponent(feedbackUndoRoute[1]));
        return json(res, 200, { feedback, state: engine.publicState() });
      }
      const waitRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/wait$/);
      if (waitRoute) {
        const wait = engine.waitForTask(decodeURIComponent(waitRoute[1]), body);
        return json(res, 200, { wait, state: engine.publicState() });
      }
      const patchPrepareRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/patch\/prepare$/);
      if (patchPrepareRoute) {
        const patch = await engine.prepareDocumentPatch(decodeURIComponent(patchPrepareRoute[1]), body);
        return json(res, 200, { patch, state: engine.publicState() });
      }
      const patchApplyRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/patch\/apply$/);
      if (patchApplyRoute) {
        const result = await engine.applyDocumentPatch(decodeURIComponent(patchApplyRoute[1]), body);
        return json(res, 200, { ...result, state: engine.publicState() });
      }
      const dependencyRoute = url.pathname.match(/^\/api\/dependencies\/([^/]+)\/resolve$/);
      if (dependencyRoute) {
        const dependency = engine.resolveDependency(decodeURIComponent(dependencyRoute[1]), body);
        return json(res, 200, { dependency, state: engine.publicState() });
      }
      if (url.pathname === '/api/misses') {
        const miss = engine.recordMiss({ note: body?.note, sourceHint: body?.sourceHint });
        return json(res, 200, { miss, state: engine.publicState() });
      }
      const route = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|reject|reconcile|retry|cancel|reopen)$/);
      if (route) {
        const id = decodeURIComponent(route[1]);
        const operation = route[2];
        // The engine re-checks the permission policy on every one of these paths,
        // so a direct API call cannot bypass the approval boundary.
        if (operation === 'approve') return json(res, 200, await engine.approve(id,
          Object.hasOwn(body || {}, 'reviewToken') ? { reviewToken: body.reviewToken } : {}));
        if (operation === 'reject') return json(res, 200, engine.reject(id));
        if (operation === 'reconcile') return json(res, 200, await engine.reconcile(id));
        if (operation === 'retry') return json(res, 200, await engine.retry(id));
        if (operation === 'cancel') return json(res, 200, engine.cancel(id));
        if (operation === 'reopen') return json(res, 200, engine.reopen(id));
      }
      return json(res, 404, { error: 'Endpoint not found' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || ['/app.js', '/i18n.js', '/ux-state.js', '/dom-state.js', '/interactions.js', '/workspace.js', '/workspace-model.js', '/appearance.js', '/appearance-model.js', '/mcp.js', '/durable.js', '/artifacts.js', '/styles.css', '/interactions.css', '/workspace.css', '/mcp.css', '/durable.css', '/redesign.css', '/workbench.css'].includes(url.pathname))) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const stream = fs.createReadStream(path.join(root, 'public', file));
      stream.once('error', () => { if (!res.destroyed) res.destroy(); });
      res.once('close', () => stream.destroy());
      return stream.pipe(res);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    if (error instanceof HttpRequestError) {
      if (error.closeConnection) {
        res.setHeader('connection', 'close');
        res.once('finish', () => {
          if (!req.socket?.destroyed) req.socket?.destroy();
        });
      }
      return json(res, error.status, { error: error.message });
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof PermissionDeniedError) return json(res, 403, { error: error.message });
    if (error.code && Number.isInteger(error.status)) return json(res, error.status, { error: error.message, code: error.code });
    if (error.code === 'MCP_ERROR') return json(res, error.status || 400, { error: error.message, code: error.code });
    if (error.code === 'REVIEW_CHANGED') return json(res, 409, { error: error.message, code: error.code });
    const status = error instanceof SyntaxError || /Invalid|Incomplete|requires|ready|waiting|closed|changed|no longer current|approval|document|provider|Expected|large|confirmed|event|Unknown task|clarification|opportunity|pre-authoris|pre_authoris/i.test(error.message) ? 400 : 500;
    console.error('Request failed:', error.message);
    return json(res, status, { error: error.message });
  }
}

// A stall must reach the user without a new event, so attention is swept
// on a timer. The sweep is read-only until a stall is actually due, so this is
// cheap; it runs regardless of connector configuration.
const sweepInterval = httpLimit('UNPROMPTED_ATTENTION_SWEEP_MS', 60_000, 15_000, 86_400_000);
const sweepTimer = setInterval(() => {
  if (workspaceChanging) return;
  try {
    engine.retryPendingReasoning(null, { dueOnly: true });
    engine.sweepAttention();
  } catch (error) { console.error('Work maintenance failed:', error.message); }
}, sweepInterval);

server.listen(port, host, async () => {
  await engine.whenSettled();
  if (shutdownPromise) return;
  console.log(`Unprompted listening at http://${host}:${port} (mode: ${runtime.mode}, mail provider: ${runtime.provider.kind})`);
  console.log(runtime.report.note);
  if (!demoMode) void mcp.start().then(() => { if (!shutdownPromise) engine.investigateWithTools(); }).catch(() => console.error('MCP connections could not start. Review Connections.'));
  if (runtime.report.pendingConfiguration.length) console.log(`Missing configuration: ${runtime.report.pendingConfiguration.join(', ')}`);
  if (simulationCanStart() && !hasGuidedSimulation()) simulation.start();
  void monitoring.start().catch(() => console.error('Automatic observation could not start. Review local setup status.'));
});

async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
  simulation.stop();
  monitoring.stop();
  sseHub.close();
  googleOAuth.cancel('shutdown');
  deviceOAuth.close();
  codeOAuth.close();
  clearInterval(sweepTimer);
  workspaceChanging = true;
  await mcp.close();
  await durableRuntime?.close();
  const closed = new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  await Promise.allSettled([monitoring.whenIdle(), closed]);
  while (activeHttpHandlers.size) await Promise.allSettled([...activeHttpHandlers]);
  // A sync can ingest new work while it settles. Drain the engine after that
  // pass completes so no late reasoning task can write after the state closes.
  await engine.whenSettled();
  store.close();
  process.exitCode = exitCode;
  })();
  return shutdownPromise;
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

// Fail with an actionable message instead of a stack trace.
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Another Unprompted instance may be running, or another program owns the port.`);
    console.error('One instance per state file is supported. Stop the other process, or start this one with a different PORT and UNPROMPTED_STATE_FILE, e.g. PORT=4174 UNPROMPTED_STATE_FILE=./data/state-4174.json node server.js');
  } else {
    console.error(`Server error: ${error.message}`);
  }
  process.exit(1);
});
