import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableDatabase, iso, json } from './database.js';
import { SqliteStore } from './store.js';
import { DurableRuntime } from './runtime.js';
import { WorkEngine } from '../engine.js';
import { NullReasoner } from '../reasoning.js';

export const ACTIVATION_REPLAY_VERSION = 1;

/** Isolated clock, scripted model, and a connector that records calls. Replay
 * never opens a network socket. External actions are the recorded list. */
export function openActivationReplay({ at = '2026-10-28T12:00:00.000Z', scripts = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-activation-replay-'));
  let now = Date.parse(at);
  const database = new DurableDatabase(path.join(directory, 'workspace.sqlite'), { now: () => now });
  const store = new SqliteStore(path.join(directory, 'state.json'), { database });
  const calls = [];
  const connector = {
    id: 'google', live: false, config: { readGmail: true },
    probeExpectedReply: async target => { calls.push({ tool: 'probe', target: { threadId: target.threadId } }); return scripts.probe?.() || { status: 'UNKNOWN' }; },
    fetchProbedMessage: async () => null
  };
  const reasoner = Object.assign(new NullReasoner(), {
    available: () => true,
    assessSituationPair: async input => scripts.pair?.(input) ?? null,
    extractSituationDelta: async input => scripts.delta?.(input) ?? null,
    assessStandingIntent: async input => scripts.intent?.(input) ?? null
  });
  const engine = new WorkEngine(store, { reasoner });
  const runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => id === 'google' ? connector : null });
  return {
    directory, store, engine, runtime, connector, calls,
    at: () => iso(now),
    advance(ms) { now += ms; },
    set(isoTime) { now = Date.parse(isoTime); },
    async settle() { await engine.whenSettled(); await runtime.whenIdle(); },
    async close() { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

export function storeActivationReport(database, report) {
  if (!report || !Array.isArray(report.scenarios) || report.scenarios.length < 1 || report.scenarios.length > 40) throw new Error('Activation replay report is out of bounds.');
  const externalActions = Number(database.get('activation_external_actions', '0'));
  const networkCalls = Number(database.get('activation_network_calls', '0'));
  if (!Number.isInteger(externalActions) || !Number.isInteger(networkCalls) || externalActions < 0 || networkCalls < 0) throw new Error('Activation observations are not usable.');
  if (report.externalActions != null && report.externalActions !== externalActions || report.networkCalls != null && report.networkCalls !== networkCalls) throw new Error('Activation report counts must match recorded observations.');
  const metrics = {
    contract: 'activation-v1.5',
    scenarios: report.scenarios.map(item => ({ id: item.id, passed: item.passed === true, boundary: item.boundary === true })),
    externalActions, networkCalls,
    configurationVersion: ACTIVATION_REPLAY_VERSION
  };
  const id = randomUUID();
  database.atomic(() => {
    database.db.prepare('INSERT INTO replay_results VALUES(?,?,?,?,?)').run(id, 'activation_v15', ACTIVATION_REPLAY_VERSION, json(metrics), iso(database.now()));
    database.db.prepare("INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES('replay',?,?)").run(id, iso(database.now()));
    for (const sourceId of report.sourceEventIds || []) database.lineage('event', sourceId, 'replay', id);
  });
  return { id, metrics };
}
