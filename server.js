import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, hasRealEvents } from './src/store.js';
import { WorkEngine } from './src/engine.js';
import { SimulationController } from './src/simulation.js';
import { buildRuntime } from './src/connectors/index.js';
import { ConnectorSync } from './src/connectors/sync.js';
import { createReasoner } from './src/reasoning.js';
import { PermissionDeniedError } from './src/permissions.js';
import { normaliseDateLocale } from './src/requests.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';
// Numeric dates follow only an explicitly configured reading; an unknown
// value counts as "not configured", and an unconfigured ambiguous `10/11`
// stays ambiguous instead of being guessed.
const dateLocale = normaliseDateLocale(process.env.UNPROMPTED_DATE_LOCALE);
let store;
try {
  store = new JsonStore(process.env.UNPROMPTED_STATE_FILE || path.join(root, 'data', 'state.json'), { dateLocale });
} catch (error) {
  if (error.code === 'STATE_LOCKED') {
    console.error('The state file is already in use by another Unprompted process.');
    console.error(error.message);
    console.error('Run one instance per state file, or stop the other process before starting this one.');
    process.exit(1);
  }
  throw error;
}

const runtime = buildRuntime(process.env, { store });
const clients = new Set();

const engine = new WorkEngine(store, {
  baseUrl: `http://${host}:${port}`,
  provider: runtime.provider,
  policy: runtime.policy,
  reasoner: createReasoner(process.env),
  mode: runtime.mode,
  dateLocale,
  // How long a waiting request may go without observable progress before
  // the decision reaches the user. Default 24h; 0 raises it at the next sweep.
  stallAfterMs: process.env.UNPROMPTED_STALL_AFTER_MS != null ? Number(process.env.UNPROMPTED_STALL_AFTER_MS) : undefined,
  onChange(state) {
    const message = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) {
      try { client.write(message); } catch { clients.delete(client); }
    }
  }
});

// Record what this process is actually running so the interface can be honest
// about live versus simulated data. A restart whose report is unchanged must
// not rewrite the file or move the revision; only a genuinely different report
// is persisted, so a no-op restart stays invisible to every observer.
store.mutateIfChanged(state => { state.runtime = { ...runtime.report, dateLocale: dateLocale || null }; });

const simulation = new SimulationController(store, engine);
const forceSimulation = process.env.UNPROMPTED_FORCE_SIMULATION === 'true';
// A live workspace must never have simulated events injected into it, and a
// state that holds real recorded events is never run over by the simulation
// either: it is the user's only record of what was actually observed.
const stateHoldsRealEvents = hasRealEvents(store.state);
const runSimulation = (runtime.mode === 'simulation' || forceSimulation) && !stateHoldsRealEvents;
// Why the simulation entry points are refused, when they are.
const simulationDisabledReason = runtime.mode !== 'live' || forceSimulation
  ? 'Simulation is disabled for a state that holds real events.'
  : 'Simulation is disabled in live mode.';

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const escapeHtml = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

/**
 * Pull new events from configured connectors.
 *
 * Incremental and cursor-based, never a full re-read. The runner records
 * failures and surfaces them; a failed sync never produces synthetic events and
 * never marks the connector healthy.
 */
const syncTimeoutSetting = Number(process.env.UNPROMPTED_SYNC_TIMEOUT_MS ?? 0);
const syncTimeoutMs = Number.isFinite(syncTimeoutSetting) && syncTimeoutSetting > 0 ? syncTimeoutSetting : null;
const sync = new ConnectorSync({
  connectors: runtime.connectors,
  cursors: runtime.cursors,
  engine,
  ...(syncTimeoutMs ? { timeoutMs: syncTimeoutMs } : {})
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        mode: runtime.mode,
        shadow: runtime.shadow,
        revision: store.state.revision,
        schemaVersion: store.state.schemaVersion,
        mailProvider: runtime.provider.kind,
        eventSource: runtime.live ? 'google' : 'simulated',
        reasoner: engine.reasoner.status ? engine.reasoner.status() : { id: 'none' }
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, engine.publicState());
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
        simulationRunning: runSimulation,
        scenarios: simulation.describe(),
        connectors: runtime.connectors.map(connector => connector.describe()),
        sync: sync.describe(),
        ...runtime.cursors.describe()
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`data: ${JSON.stringify(engine.publicState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
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
      const body = await readJson(req);

      if (url.pathname === '/api/connectors/sync') return json(res, 200, await sync.run());
      if (url.pathname === '/api/simulation/events') {
        if (!runSimulation) return json(res, 409, { error: simulationDisabledReason });
        return json(res, 200, engine.ingest({ ...body, source: 'simulated', connectorId: 'simulated' }));
      }
      if (url.pathname === '/api/demo/restart') {
        if (!runSimulation) return json(res, 409, { error: simulationDisabledReason });
        const scenario = simulation.reset(body?.scenario || null);
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
      const feedbackRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/feedback$/);
      if (feedbackRoute) {
        const task = engine.labelDiscovery(decodeURIComponent(feedbackRoute[1]), { label: body?.label, reason: body?.reason });
        return json(res, 200, { task, state: engine.publicState() });
      }
      if (url.pathname === '/api/misses') {
        const miss = engine.recordMiss({ note: body?.note, sourceHint: body?.sourceHint });
        return json(res, 200, { miss, state: engine.publicState() });
      }
      const route = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|reject|reconcile|retry|cancel)$/);
      if (route) {
        const id = decodeURIComponent(route[1]);
        const operation = route[2];
        // The engine re-checks the permission policy on every one of these paths,
        // so a direct API call cannot bypass the approval boundary.
        if (operation === 'approve') return json(res, 200, await engine.approve(id));
        if (operation === 'reject') return json(res, 200, engine.reject(id));
        if (operation === 'reconcile') return json(res, 200, await engine.reconcile(id));
        if (operation === 'retry') return json(res, 200, await engine.retry(id));
        if (operation === 'cancel') return json(res, 200, engine.cancel(id));
      }
      return json(res, 404, { error: 'Endpoint not found' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || ['/app.js', '/styles.css'].includes(url.pathname))) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(path.join(root, 'public', file)).pipe(res);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return json(res, 403, { error: error.message });
    const status = error instanceof SyntaxError || /Invalid|Incomplete|requires|ready|waiting|closed|changed|no longer current|approval|document|provider|Expected|large|confirmed|event|Unknown task|clarification|opportunity|pre-authoris|pre_authoris/i.test(error.message) ? 400 : 500;
    console.error('Request failed:', error.message);
    return json(res, status, { error: error.message });
  }
});

// Automatic connector pulling. A positive value sets the interval in ms and is
// clamped to ≥15s; absent or 0 leaves it off (README: "0 disables"), so a live
// read-only session fetches nothing until `POST /api/connectors/sync` is asked
// for. Showing the stored state alone never touches Google.
const syncSetting = Number(process.env.UNPROMPTED_SYNC_INTERVAL_MS ?? 0);
const syncInterval = Number.isFinite(syncSetting) && syncSetting > 0 ? Math.max(15000, syncSetting) : 0;
let syncTimer = null;

// A stall must reach the user without a new event, so attention is swept
// on a timer. The sweep is read-only until a stall is actually due, so this is
// cheap; it runs regardless of connector configuration.
const sweepInterval = Math.max(15000, Number(process.env.UNPROMPTED_ATTENTION_SWEEP_MS || 60000));
const sweepTimer = setInterval(() => {
  try { engine.sweepAttention(); } catch (error) { console.error('Attention sweep failed:', error.message); }
}, sweepInterval);

server.listen(port, host, async () => {
  await engine.whenSettled();
  console.log(`Unprompted listening at http://${host}:${port} (mode: ${runtime.mode}, mail provider: ${runtime.provider.kind})`);
  console.log(runtime.report.note);
  if (runtime.report.pendingConfiguration.length) console.log(`Missing configuration: ${runtime.report.pendingConfiguration.join(', ')}`);
  if (runSimulation) simulation.start();
  if (syncInterval && runtime.live) {
    syncTimer = setInterval(() => { sync.run().catch(error => console.error('Sync failed:', error.message)); }, syncInterval);
  }
});

function shutdown() {
  simulation.stop();
  if (syncTimer) clearInterval(syncTimer);
  clearInterval(sweepTimer);
  server.close();
  store.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
