import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { GoogleWorkspaceConnector } from '../src/connectors/google.js';

async function fixture(t, probe = async () => ({ status: 'NOT_FOUND', complete: true })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-probe-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const connector = { id: 'google', live: true, config: { readGmail: true }, probeExpectedReply: probe };
  const engine = new WorkEngine(store), runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => id === 'google' ? connector : null });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = new Date(Date.now() - 60000).toISOString();
  engine.ingest({ id: 'google:seed', providerEventId: 'gmail:seed', source: 'google', connectorId: 'google', type: 'email.received', at,
    payload: { id: 'seed', threadId: 'thread-1', from: 'supplier@example.test', to: 'reader@example.test', subject: 'Quotation', body: 'The quotation is under discussion.', receivedAt: at } });
  await engine.whenSettled();
  const situation = store.tasks.situations.create({ kind: 'supplier', summary: 'Awaiting supplier reply', sourceEventIds: ['google:seed'], closureCondition: { kind: 'AWAIT_EVIDENCE' } });
  return { store, engine, runtime, connector, situation, at };
}
function healthy(store) {
  store.mutate(state => { state.connectorStatus.google = { ok: true, lastSyncAt: new Date().toISOString() }; state.cursors.google = { gmail: { historyId: 'h1' } }; });
}
async function runProbe(f) {
  const job = f.runtime.configureSituationProbe(f.situation.id, { sourceEventId: 'google:seed', scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await f.runtime.whenIdle();
  assert.equal(f.runtime.jobs.get(job.id).state, 'completed');
  return f.store.tasks.situations.get(f.situation.id).closureCondition.probeObservation.status;
}

test('a missing synchronization watermark makes a reply probe incomplete without a connector request', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { status: 'NOT_FOUND', complete: true }; });
  assert.equal(await runProbe(f), 'PROBE_INCOMPLETE');
  assert.equal(calls, 0);
});

test('only a complete, healthy thread observation supports absence', async t => {
  const f = await fixture(t, async () => ({ status: 'NOT_FOUND', complete: false }));
  healthy(f.store);
  assert.equal(await runProbe(f), 'PROBE_INCOMPLETE');
  f.connector.probeExpectedReply = async () => ({ status: 'NOT_FOUND', complete: true });
  assert.equal(await runProbe(f), 'EXPECTED_EVENT_ABSENT');
});

test('a changed sync watermark invalidates an in-flight absence', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return { status: 'NOT_FOUND', complete: true }; });
  healthy(f.store);
  const job = f.runtime.configureSituationProbe(f.situation.id, { sourceEventId: 'google:seed', scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await started;
  f.store.mutate(state => { state.cursors.google.gmail.historyId = 'h2'; });
  release(); await f.runtime.whenIdle();
  assert.equal(f.runtime.jobs.get(job.id).state, 'completed');
  assert.equal(f.store.tasks.situations.get(f.situation.id).closureCondition.probeObservation.status, 'PROBE_INCOMPLETE');
});

test('a found reply is persisted as a new Event for normal evaluation', async t => {
  const f = await fixture(t, async () => ({ status: 'FOUND', messageId: 'reply' }));
  healthy(f.store);
  const at = new Date().toISOString();
  f.connector.fetchProbedMessage = async () => ({ id: 'google:reply', providerEventId: 'gmail:reply', source: 'google', connectorId: 'google', type: 'email.received', at,
    payload: { id: 'reply', threadId: 'thread-1', from: 'supplier@example.test', to: 'reader@example.test', subject: 'Quotation', body: 'The updated quotation is ready.', receivedAt: at } });
  assert.equal(await runProbe(f), 'EXPECTED_EVENT_PRESENT');
  assert.ok(f.store.db.prepare('SELECT 1 FROM durable_inbox WHERE id=?').get('google:reply'));
});

test('a source outside the Situation cannot authorize a probe', async t => {
  const f = await fixture(t);
  assert.throws(() => f.runtime.configureSituationProbe(f.situation.id, { sourceEventId: 'other', scheduledAt: new Date().toISOString() }), /selected source/);
});

test('Forget while a probe is running discards its result', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return { status: 'NOT_FOUND', complete: true }; });
  healthy(f.store);
  f.runtime.configureSituationProbe(f.situation.id, { sourceEventId: 'google:seed', scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await started;
  await f.runtime.privacy.forget({ kind: 'event', id: 'google:seed' });
  release(); await f.runtime.whenIdle();
  assert.equal(f.store.tasks.situations.get(f.situation.id), undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='active_probe'").get().n, 0);
});

test('revoking Gmail read access while a probe is running discards its result', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return { status: 'NOT_FOUND', complete: true }; });
  healthy(f.store);
  f.runtime.configureSituationProbe(f.situation.id, { sourceEventId: 'google:seed', scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await started;
  f.connector.config.readGmail = false;
  release(); await f.runtime.whenIdle();
  assert.equal(f.store.tasks.situations.get(f.situation.id).closureCondition.probeObservation, undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='active_probe'").get().n, 0);
});

test('Gmail metadata probe treats incomplete threads conservatively and ignores automated messages', async () => {
  const afterAt = new Date(Date.now() - 60000).toISOString();
  const seed = { id: 'seed', internalDate: String(Date.now() - 60000), payload: { headers: [{ name: 'From', value: 'supplier@example.test' }] } };
  const reply = { id: 'reply', internalDate: String(Date.now()), payload: { headers: [{ name: 'From', value: 'supplier@example.test' }] } };
  let messages = [seed];
  const connector = new GoogleWorkspaceConnector({ config: { readGmail: true, maxRetries: 0 }, auth: { headers: async () => ({}) },
    fetchImpl: async () => new Response(JSON.stringify({ id: 'thread-1', messages }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  const request = { threadId: 'thread-1', sourceMessageId: 'seed', expectedSender: 'supplier@example.test', afterAt };
  assert.deepEqual(await connector.probeExpectedReply(request), { status: 'NOT_FOUND', complete: true });
  messages = [seed, { ...reply, payload: { headers: [] } }];
  assert.deepEqual(await connector.probeExpectedReply(request), { status: 'UNKNOWN' });
  messages = [seed, { ...reply, payload: { headers: [...reply.payload.headers, { name: 'Auto-Submitted', value: 'auto-replied' }] } }];
  assert.deepEqual(await connector.probeExpectedReply(request), { status: 'NOT_FOUND', complete: true });
  messages = [seed, reply];
  assert.deepEqual(await connector.probeExpectedReply(request), { status: 'FOUND', messageId: 'reply' });
  messages = [reply];
  assert.deepEqual(await connector.probeExpectedReply(request), { status: 'UNKNOWN' });
});
