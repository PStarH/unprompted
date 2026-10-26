import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonStore, emptyState } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy, PermissionDeniedError } from '../src/permissions.js';
import { PERMISSION_KEYS } from '../src/calibration.js';
import { GoogleWorkspaceConnector } from '../src/connectors/google.js';
import { GoogleMailAdapter } from '../src/providers.js';
import { ConnectorError, CursorStore } from '../src/connectors/connector.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { normalizeEvent } from '../src/connectors/events.js';
import { buildRuntime } from '../src/connectors/index.js';
import { computeProductMetrics } from '../src/metrics.js';

/**
 * Real-event shadow mode.
 *
 * Provider responses in this file are sanitized fixtures. Nothing here is a
 * live integration test, and nothing contacts Google.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const gmailMessage = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/gmail-message.json'), 'utf8'));
const driveChanges = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/drive-changes.json'), 'utf8'));
const driveExport = fs.readFileSync(path.join(root, 'test/fixtures/drive-export.txt'), 'utf8');
const REQUEST_BODY = 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.';

const tempFiles = [];
const cleanups = [];
test.after(() => {
  for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true });
  for (const cleanup of cleanups) cleanup();
});

const CREDENTIALS = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken' };
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body)
});
const textResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => body
});
const tokenResponse = jsonResponse({ access_token: 'at-shadow', expires_in: 3600 });

function storeIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-shadow-'));
  tempFiles.push(dir);
  return new JsonStore(path.join(dir, 'state.json'));
}

function scriptedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: (options.method || 'GET').toUpperCase(), body: options.body || null });
    for (const [matcher, responder] of routes) {
      if (url.includes(matcher)) return typeof responder === 'function' ? responder(url, options) : responder;
    }
    throw new Error(`Unscripted request: ${url}`);
  };
  return { fetchImpl, calls };
}

function gmailListRoutes(historyId = 'h1') {
  return [
    ['oauth2.googleapis.com/token', tokenResponse],
    ['gmail/v1/users/me/messages/m-shadow-1', jsonResponse(gmailMessage)],
    ['gmail/v1/users/me/profile', jsonResponse({ historyId, emailAddress: 'maya@example.test' })],
    ['gmail/v1/users/me/messages?', jsonResponse({ messages: [{ id: 'm-shadow-1' }] })]
  ];
}

function ingestReady(engine) {
  engine.ingest({
    id: 'e-email', type: 'email.received', source: 'google', connectorId: 'google',
    providerEventId: 'gmail:m1', payload: {
      id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
      body: REQUEST_BODY
    }
  });
  engine.ingest({
    id: 'e-doc', type: 'document.modified', source: 'google', connectorId: 'google',
    providerEventId: 'drive:doc:1', payload: {
      id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
      content: driveExport
    }
  });
}

test('a sanitized Gmail response parses to one normalized email and never writes', async () => {
  const { fetchImpl, calls } = scriptedFetch(gmailListRoutes());
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readDrive: false },
    fetchImpl
  });
  const result = await connector.pull({ cursor: null });
  assert.equal(result.errors?.length || 0, 0);
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.source, 'google');
  assert.equal(event.connectorId, 'google');
  assert.equal(event.type, 'email.received');
  assert.equal(event.providerEventId, 'gmail:m-shadow-1');
  assert.equal(event.payload.id, 'm-shadow-1');
  assert.equal(event.payload.threadId, 't-shadow-1');
  assert.equal(event.payload.from, 'alex@example.test');
  assert.equal(event.payload.subject, 'Northstar proposal — experiment results');
  assert.equal(event.payload.body, REQUEST_BODY);
  assert.equal(event.payload.body.includes('<p>'), false);
  assert.equal(event.payload.providerMessageId, '<m-shadow-1@example.test>');
  assert.equal(calls.some(call => call.url.includes('/messages/send')), false);
});

test('a Gmail sync failure is recorded as a failure and ingests nothing', async () => {
  const store = storeIn();
  const engine = new WorkEngine(store);
  const { fetchImpl } = scriptedFetch([
    ['oauth2.googleapis.com/token', tokenResponse],
    ['gmail/v1/users/me/messages', jsonResponse({ error: 'backend' }, 500)]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readDrive: false },
    fetchImpl
  });
  const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine });
  const result = await sync.run();
  assert.equal(result.results[0].ingested, 0);
  assert.equal(result.results[0].partial, true);
  assert.equal(store.state.events.length, 0);
  assert.equal(store.state.tasks && Object.keys(store.state.tasks).length, 0);
  assert.equal(store.state.connectorStatus.google.ok, false);
  assert.match(store.state.connectorStatus.google.lastError, /500|gmail/i);
  const metrics = engine.publicState().metrics;
  assert.equal(metrics.sync.failures, 1);
  assert.equal(metrics.events.real, 0);
});

test('Gmail sync is incremental and a replay does not create a second discovery', async () => {
  const store = storeIn();
  const engine = new WorkEngine(store);
  const { fetchImpl, calls } = scriptedFetch([
    ...gmailListRoutes('h1'),
    ['gmail/v1/users/me/history', jsonResponse({
      history: [{ messages: [{ id: 'm-shadow-1' }] }],
      historyId: 'h2'
    })]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readDrive: false },
    fetchImpl
  });
  const cursors = new CursorStore(store);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });

  const first = await sync.run();
  assert.equal(first.results[0].ingested, 1);
  assert.equal(first.results[0].duplicates, 0);
  assert.equal(cursors.get('google').gmail.historyId, 'h1');
  assert.equal(Object.keys(store.state.tasks).length, 1);

  const second = await sync.run();
  assert.equal(second.results[0].ingested, 0);
  assert.equal(second.results[0].duplicates, 1);
  assert.equal(cursors.get('google').gmail.historyId, 'h2');
  assert.equal(Object.keys(store.state.tasks).length, 1);
  assert.ok(calls.some(call => call.url.includes('startHistoryId=h1')));
  assert.equal(calls.filter(call => call.url.includes('/messages/send')).length, 0);
});

test('a sanitized Gmail message and Drive export become one evidence-backed discovery', async () => {
  const store = storeIn();
  const engine = new WorkEngine(store);
  const gmail = scriptedFetch(gmailListRoutes());
  const gmailConnector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readDrive: false },
    fetchImpl: gmail.fetchImpl
  });
  const pulled = await gmailConnector.pull({ cursor: null });
  const email = pulled.events[0];
  const discovered = engine.ingest(email);
  assert.equal(discovered.duplicate, false);
  assert.equal(discovered.disposition, 'discovered_request');

  const taskId = 'request:m-shadow-1';
  const waiting = store.state.tasks[taskId];
  assert.ok(waiting, 'the existing pipeline must discover the request');
  assert.equal(waiting.request.source.id, 'm-shadow-1');
  assert.equal(waiting.request.source.kind, 'email');
  assert.notEqual(waiting.assessment?.complete, true);
  assert.ok((waiting.evidence?.unknowns || []).length > 0, 'missing evidence stays explicit');
  const discoveryTrace = (store.state.trace || []).find(entry => entry.stage === 'discovery' && entry.taskId === taskId);
  assert.equal(discoveryTrace.input.source, 'google');
  assert.equal(discoveryTrace.input.messageId, 'm-shadow-1');

  const drive = scriptedFetch([
    ['oauth2.googleapis.com/token', tokenResponse],
    ['drive/v3/changes?', jsonResponse(driveChanges)],
    ['drive/v3/files/doc-shadow-1/export', textResponse(driveExport)],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const driveConnector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readGmail: false },
    fetchImpl: drive.fetchImpl
  });
  const docs = await driveConnector.pull({ cursor: { drive: { pageToken: 'p-shadow-1' } } });
  assert.equal(docs.events.length, 1);
  assert.equal(docs.events[0].source, 'google');
  assert.equal(docs.events[0].payload.externalId, 'doc-shadow-1');
  engine.ingest(docs.events[0]);

  const task = store.state.tasks[taskId];
  const cited = (task.evidence?.criteria || []).flatMap(criterion => criterion.evidence || []);
  assert.ok(cited.some(item => item.source?.id && item.source?.kind), 'evidence cites a real source');
  assert.equal(task.documentId, 'doc-shadow-1');
  assert.match(store.state.documents['doc-shadow-1'].url, /^https:\/\/docs\.google\.com\/document\/d\/doc-shadow-1/);
  assert.equal(engine.publicState().metrics.events.real, 2);
  assert.equal(engine.publicState().metrics.review.discoveries, 1);
  assert.equal(engine.publicState().metrics.review.unreviewed, 1);
  assert.equal(engine.publicState().metrics.review.noise, 0, 'missing or partial evidence is not noise');
});

test('user labels persist, and missing evidence is not counted as noise', () => {
  const metrics = computeProductMetrics({
    tasks: {
      bare: {
        id: 'bare', status: 'waiting_for_information', documentId: null,
        evidence: { plan: { unverifiable: [{ text: 'a signed agreement' }] } }
      }
    },
    events: [{ id: 'e1', source: 'google' }, { id: 'e2', source: 'simulated' }],
    connectorStatus: { google: { ok: false, lastError: 'gmail: denied' } },
    history: [], notifications: [], calibrations: {}, opportunities: {}, trace: [{ stage: 'discovery' }]
  });
  assert.equal(metrics.discovery.unservable, 1, 'the existing proxy is unchanged');
  assert.equal(metrics.review.noise, 0, 'an unreviewed finding is not noise');
  assert.equal(metrics.review.unreviewed, 1);
  assert.equal(metrics.review.reviewed, 0);
  assert.equal(metrics.events.ingested, 2);
  assert.equal(metrics.events.real, 1);
  assert.equal(metrics.sync.failures, 1);
  assert.equal(metrics.resources.events, 2);
  assert.equal(metrics.resources.traceEntries, 1);

  const store = storeIn();
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: true }) });
  ingestReady(engine);
  const taskId = 'request:m1';
  const before = store.state.revision;
  assert.throws(() => engine.labelDiscovery(taskId, 'spam'), /Invalid discovery label/);
  assert.equal(store.state.revision, before);
  assert.equal(store.state.tasks[taskId].feedback, undefined);

  const useful = engine.labelDiscovery(taskId, 'useful');
  assert.equal(useful.feedback.label, 'useful');
  assert.equal(useful.feedback.source, 'user');
  assert.equal(useful.status, 'ready_for_approval', 'a label does not move the task');
  assert.equal(store.state.outbox.length, 0);

  engine.labelDiscovery(taskId, 'awaiting_evidence');
  engine.labelDiscovery(taskId, 'noise');
  const labelled = engine.publicState().metrics.review;
  assert.equal(labelled.reviewed, 1);
  assert.equal(labelled.unreviewed, 0);
  assert.equal(labelled.noise, 1);
  assert.equal(labelled.useful, 0);
  assert.equal(labelled.awaitingEvidence, 0);

  const restored = new JsonStore(store.filename);
  assert.equal(restored.state.tasks[taskId].feedback.label, 'noise');
});

test('a judgement keeps its reason, revision and source, and a miss does not become work', () => {
  const store = storeIn();
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: true }) });
  ingestReady(engine);
  const taskId = 'request:m1';
  const before = store.state.tasks[taskId];
  const snapshot = { status: before.status, documentId: before.documentId, outbox: store.state.outbox.length, tasks: Object.keys(store.state.tasks).length };
  const bare = engine.publicState().metrics.review;
  assert.equal(bare.unevaluated, 1);
  assert.equal(bare.useful, 0);
  assert.equal(bare.notUseful, 0);
  assert.equal(bare.negative, 0);
  assert.equal(bare.unknown.recall, 'unknown');
  assert.equal(bare.unknown.timeSaved, 'unknown');
  assert.notEqual(bare.unevaluated, bare.unknown.recall);

  const judged = engine.labelDiscovery(taskId, { label: 'wrong_association', reason: '  This document is a different project.  ' });
  assert.equal(judged.status, snapshot.status);
  assert.equal(judged.documentId, snapshot.documentId);
  assert.equal(store.state.outbox.length, snapshot.outbox);
  assert.equal(judged.feedback.label, 'wrong_association');
  assert.equal(judged.feedback.reason, 'This document is a different project.');
  assert.equal(judged.feedback.revision, store.state.revision);
  assert.equal(judged.feedback.evidence.eventId, 'e-email');
  assert.equal(judged.feedback.evidence.eventSource, 'google');
  assert.equal(judged.feedback.evidence.documentSource, judged.documentId ? 'google' : null);
  let review = engine.publicState().metrics.review;
  assert.equal(review.unevaluated, 0);
  assert.equal(review.wrongAssociation, 1);
  assert.equal(review.negative, 1);
  assert.equal(review.useful, 0);

  engine.labelDiscovery(taskId, { label: 'not_useful', reason: '   ' });
  assert.equal(store.state.tasks[taskId].feedback.reason, null);
  assert.equal(store.state.tasks[taskId].status, snapshot.status);
  review = engine.publicState().metrics.review;
  assert.equal(review.notUseful, 1);
  assert.equal(review.wrongAssociation, 0);
  assert.equal(review.negative, 1);

  assert.throws(() => engine.recordMiss({ note: '   ' }), /requires a description/);
  const miss = engine.recordMiss({ note: 'The Friday invoice never appeared.', sourceHint: 'bank email' });
  assert.equal(Object.keys(store.state.tasks).length, snapshot.tasks);
  assert.equal(store.state.outbox.length, snapshot.outbox);
  assert.equal(store.state.tasks[taskId].status, snapshot.status);
  assert.equal(miss.revision, store.state.revision);
  assert.equal(engine.publicState().metrics.review.misses, 1);
  assert.equal(engine.publicState().metrics.review.unknown.recall, 'unknown');

  const restored = new JsonStore(store.filename);
  assert.equal(restored.state.tasks[taskId].feedback.label, 'not_useful');
  assert.equal(restored.state.tasks[taskId].feedback.evidence.eventSource, 'google');
  assert.equal(restored.state.tasks[taskId].status, snapshot.status);
  assert.equal(restored.state.misses[0].note, 'The Friday invoice never appeared.');
  assert.equal(restored.state.misses[0].sourceHint, 'bank email');
  assert.equal(restored.state.misses[0].revision, miss.revision);
});

test('shadow mode denies external writes before any provider call, including pre-authorisation', async () => {
  const store = storeIn();
  const calls = [];
  const provider = {
    kind: 'gmail',
    live: true,
    lookup(key) { calls.push(['lookup', key]); return { status: 'not_found' }; },
    send(payload) { calls.push(['send', payload.idempotencyKey]); return { id: 'should-not-exist' }; }
  };
  const engine = new WorkEngine(store, { provider, policy: new PermissionPolicy({ shadow: true }) });
  ingestReady(engine);
  const taskId = 'request:m1';
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');

  assert.throws(() => engine.approve(taskId), PermissionDeniedError);
  assert.deepEqual(calls, []);
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  assert.equal(store.state.tasks[taskId].action, null);
  assert.equal(store.state.outbox.length, 0);
  const refusal = (store.state.trace || []).find(entry => entry.stage === 'policy' && entry.policy?.decision === 'refused');
  assert.ok(refusal, 'the shadow refusal is recorded');
  assert.match(refusal.policy.reason, /read-only|shadow/i);
  assert.equal(refusal.outcome.status, 'not_executed');

  engine.recordCalibration({
    key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Northstar' }
  });
  assert.throws(() => engine.executePreAuthorized(taskId), PermissionDeniedError);
  assert.deepEqual(calls, []);
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 0);

  store.mutate(state => {
    state.tasks[taskId].action = {
      id: 'send:forged', idempotencyKey: 'send:forged', actionClass: 'execute_external',
      permission: 'user_approved', taskId, status: 'executing'
    };
  });
  const revision = store.state.revision;
  assert.throws(() => engine.execute(taskId), PermissionDeniedError);
  assert.deepEqual(calls, []);
  assert.equal(store.state.revision, revision);
});

test('the Gmail send method refuses in shadow mode without calling the network', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    throw new Error(`network must not be contacted: ${url}`);
  };
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true },
    fetchImpl
  });
  const adapter = new GoogleMailAdapter(connector);
  await assert.rejects(
    () => connector.execute({ to: 'maya@example.test', subject: 'Re: Northstar', body: 'no', idempotencyKey: 'send:1' }),
    ConnectorError
  );
  await assert.rejects(() => adapter.send({
    to: 'maya@example.test', subject: 'Re: Northstar', body: 'no', idempotencyKey: 'send:1'
  }), /shadow|read-only/i);
  assert.equal(calls.length, 0);

  const store = storeIn();
  const runtime = buildRuntime({
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REFRESH_TOKEN: 'rtoken',
    GOOGLE_SEND_ENABLED: 'true'
  }, { store });
  assert.equal(runtime.shadow, true);
  assert.equal(runtime.policy.shadow, true);
  assert.equal(runtime.provider.kind, 'gmail');
  assert.equal(runtime.provider.canSend, false);
  assert.equal(runtime.connectors.find(item => item.id === 'google').shadow, true);
});

test('shadow mode leaves cancellation and non-external permissions intact', () => {
  const policy = new PermissionPolicy({ shadow: true });
  assert.equal(policy.authorize({ actionClass: 'observe' }).allowed, true);
  assert.equal(policy.authorize({ actionClass: 'prepare' }).allowed, true);
  assert.throws(() => policy.authorize({ actionClass: 'delete_everything' }), PermissionDeniedError);
  assert.throws(
    () => policy.authorize({ actionClass: 'execute_external', approval: { permission: 'user_approved', taskId: 'request:m1' }, taskId: 'request:m1' }),
    /read-only|shadow/i
  );

  const store = storeIn();
  const engine = new WorkEngine(store, { policy });
  engine.ingest({
    id: 'e-email', type: 'email.received', payload: {
      id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
      body: REQUEST_BODY
    }
  });
  const taskId = 'request:m1';
  assert.equal(store.state.tasks[taskId].status, 'waiting_for_information');
  assert.throws(() => engine.approve(taskId), /not ready/);
  const closed = engine.cancel(taskId);
  assert.equal(closed.status, 'cancelled');
  engine.ingest({
    id: 'e-doc', type: 'document.modified', payload: {
      id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal', content: driveExport
    }
  });
  assert.equal(store.state.tasks[taskId].status, 'cancelled');
  assert.equal(store.state.outbox.length, 0);
});

test('a state holding real events is never run over by the simulation', async () => {
  const seed = emptyState();
  seed.events.push(normalizeEvent({
    connectorId: 'google',
    source: 'google',
    providerEventId: 'seed-real-1',
    type: 'email.received',
    at: '2026-10-16T09:00:00.000Z',
    payload: {
      id: 'seed-real-1',
      threadId: 'seed-thread-1',
      from: 'news@example.test',
      to: 'maya@example.test',
      subject: 'Weekly digest',
      body: 'This week in links. Unsubscribe at the bottom of this mail.',
      receivedAt: '2026-10-16T09:00:00.000Z'
    }
  }));
  const { base, stateFile } = await startServer({}, { seed });

  const runtime = await get(base, '/api/runtime');
  assert.equal(runtime.body.simulationRunning, false);
  const restart = await post(base, '/api/demo/restart');
  assert.equal(restart.status, 409);
  assert.match(restart.body.error, /real events/);

  // The scenario's first event has delay 0; give it time to (fail to) arrive.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(after.events.filter(event => event.source === 'simulated').length, 0);
  assert.equal(after.events.length, 1);
  assert.equal(after.simulation ?? null, null);
  const state = await get(base, '/api/state');
  assert.equal(state.body.events.length, 1);
});

async function startServer(extraEnv = {}, { seed = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-shadow-http-'));
  tempFiles.push(dir);
  const stateFile = path.join(dir, 'state.json');
  if (seed) fs.writeFileSync(stateFile, JSON.stringify(seed, null, 2) + '\n');
  const port = 25000 + (process.pid % 10000) + Math.floor(Math.random() * 500);
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
  const child = spawn(node, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...inheritedEnv,
      PORT: String(port),
      UNPROMPTED_STATE_FILE: stateFile,
      UNPROMPTED_CONFIG_DIR: path.join(dir, 'config'),
      UNPROMPTED_FORCE_SIMULATION: 'true',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        cleanups.push(() => child.kill('SIGKILL'));
        return { base, output: () => output, stateFile };
      }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Server did not start. Output:\n${output}`);
}

const post = async (base, route, body = {}) => {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, body: payload };
};
const get = async (base, route) => {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, body: await response.json() };
};

test('the HTTP boundary refuses a shadowed send and persists a discovery label', async () => {
  const { base } = await startServer();
  const health = await get(base, '/api/health');
  assert.equal(health.body.shadow, true);
  const runtime = await get(base, '/api/runtime');
  assert.equal(runtime.body.shadow, true);

  await post(base, '/api/simulation/events', {
    id: 'shadow-email', type: 'email.received', payload: {
      id: 'm-http', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
      body: REQUEST_BODY
    }
  });
  await post(base, '/api/simulation/events', {
    id: 'shadow-doc', type: 'document.modified', payload: {
      id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal', content: driveExport
    }
  });
  const prepared = await get(base, '/api/state');
  const task = prepared.body.tasks.find(item => item.id === 'request:m-http');
  assert.equal(task.status, 'ready_for_approval');
  assert.equal(prepared.body.outbox.length, 0);

  const denied = await post(base, '/api/tasks/request%3Am-http/approve');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /shadow|read-only/i);
  const trace = await get(base, '/api/trace?taskId=request:m-http');
  const refusal = trace.body.entries.find(entry => entry.stage === 'policy' && entry.policy?.decision === 'refused');
  assert.ok(refusal, 'the HTTP refusal is on the decision trace');
  assert.equal(refusal.outcome.status, 'not_executed');
  const afterDeny = await get(base, '/api/state');
  const still = afterDeny.body.tasks.find(item => item.id === 'request:m-http');
  assert.equal(still.status, 'ready_for_approval');
  assert.equal(still.action, null);
  assert.equal(afterDeny.body.outbox.length, 0);

  const bad = await post(base, '/api/tasks/request%3Am-http/feedback', { label: 'later' });
  assert.equal(bad.status, 400);
  const labelled = await post(base, '/api/tasks/request%3Am-http/feedback', { label: 'awaiting_evidence' });
  assert.equal(labelled.status, 200);
  assert.equal(labelled.body.task.feedback.label, 'awaiting_evidence');
  assert.equal(labelled.body.task.status, 'ready_for_approval');
  const reasoned = await post(base, '/api/tasks/request%3Am-http/feedback', { label: 'not_useful', reason: 'Newsletter, not a request.' });
  assert.equal(reasoned.status, 200);
  assert.equal(reasoned.body.task.status, 'ready_for_approval');
  assert.equal(reasoned.body.task.documentId, still.documentId);
  assert.equal(reasoned.body.task.feedback.reason, 'Newsletter, not a request.');
  assert.equal(reasoned.body.task.feedback.evidence.eventSource, 'simulated');
  assert.equal(reasoned.body.task.feedback.evidence.eventId, 'shadow-email');
  assert.equal(reasoned.body.state.outbox.length, 0);
  const emptyMiss = await post(base, '/api/misses', { note: '  ' });
  assert.equal(emptyMiss.status, 400);
  const miss = await post(base, '/api/misses', { note: 'A renewal I handled myself.', sourceHint: 'bank' });
  assert.equal(miss.status, 200);
  assert.equal(miss.body.state.tasks.length, afterDeny.body.tasks.length);
  assert.equal(miss.body.state.outbox.length, 0);
  assert.equal(miss.body.state.tasks.find(item => item.id === 'request:m-http').status, 'ready_for_approval');
  assert.equal(miss.body.miss.note, 'A renewal I handled myself.');
  const stillDenied = await post(base, '/api/tasks/request%3Am-http/approve');
  assert.equal(stillDenied.status, 403);
  const metrics = await get(base, '/api/metrics');
  assert.ok(metrics.body.review.notUseful >= 1);
  assert.ok(metrics.body.review.negative >= 1);
  assert.equal(metrics.body.review.noise, 0, 'unlabelled discoveries, including ones still missing evidence, are not noise');
  assert.equal(metrics.body.review.unknown.timeSaved, 'unknown');
  assert.equal(metrics.body.review.unreviewed, metrics.body.review.discoveries - metrics.body.review.reviewed);
  assert.ok(metrics.body.review.reviewed >= 1);
});
