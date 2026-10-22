import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore, Connector } from '../src/connectors/connector.js';
import { normalizeEvent } from '../src/connectors/events.js';

/**
 * The sync runner is the only path by which live provider data enters the
 * engine, so its failure behaviour is a safety property, not a detail.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-sync-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  const store = new JsonStore(filename);
  const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  const cursors = new CursorStore(store);
  return { filename, store, engine, cursors };
}

/** A live connector driven by a scripted sequence of pull results. */
class ScriptedConnector extends Connector {
  constructor(id, pulls) {
    super({ id, kind: 'scripted' });
    this.live = true;
    this.pulls = [...pulls];
    this.calls = [];
  }
  async pull({ cursor }) {
    this.calls.push(cursor);
    if (!this.pulls.length) throw new Error('no scripted pull remaining');
    const next = this.pulls.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

const liveEmail = (id, subject = 'Northstar proposal — experiment results') => normalizeEvent({
  connectorId: 'google', source: 'google', providerEventId: `gmail:${id}`, type: 'email.received',
  payload: {
    id, from: 'alex@example.test', subject,
    body: 'Please update the Northstar project proposal with the latest experiment results and send it by Friday.'
  }
});

test('a pull that never returns times out, commits no cursor, and allows the next run', async () => {
  const { store, engine, cursors } = setup();
  let calls = 0;
  const connector = new ScriptedConnector('google', []);
  connector.pull = async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {});
    return {
      events: [liveEmail('m-1')],
      cursor: { gmail: { historyId: 'h9' } },
      errors: [],
      partial: false
    };
  };
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine, timeoutMs: 20 });

  const first = await sync.run();
  assert.equal(first.results[0].failed, true);
  assert.match(first.results[0].error, /timed out/);
  assert.equal(store.state.connectorStatus.google.ok, false);
  assert.equal(cursors.get('google'), null, 'a timed-out pull must not commit anything');
  assert.equal(sync.running, false, 'the next run must be allowed to start');

  const second = await sync.run();
  assert.equal(second.results[0].failed, false);
  assert.equal(second.results[0].ingested, 1);
  assert.equal(cursors.get('google').gmail.historyId, 'h9');
});

test('a successful sync ingests events and commits the cursor the provider acknowledged', async () => {
  const { store, engine, cursors } = setup();
  const connector = new ScriptedConnector('google', [{
    events: [liveEmail('m-1'), liveEmail('m-2', 'Northstar proposal — second request')],
    cursor: { gmail: { historyId: 'h2' } },
    errors: [],
    partial: false
  }]);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });

  const outcome = await sync.run();
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].ingested, 2);
  assert.equal(outcome.results[0].duplicates, 0);
  assert.equal(outcome.results[0].partial, false);
  assert.equal(cursors.get('google').gmail.historyId, 'h2');
  assert.equal(store.state.connectorStatus.google.ok, true);
  assert.equal(store.state.connectorStatus.google.eventsIngested, 2);
  assert.equal(store.state.events.length, 2);
  assert.ok(store.state.events.every(event => event.source === 'google'), 'events keep their real source');
  assert.equal(store.state.outbox.length, 0);
});

test('a replayed provider event is counted as a duplicate and creates no second task', async () => {
  const { store, engine, cursors } = setup();
  const connector = new ScriptedConnector('google', [
    { events: [liveEmail('m-1')], cursor: { gmail: { historyId: 'h2' } }, errors: [], partial: false },
    { events: [liveEmail('m-1')], cursor: { gmail: { historyId: 'h3' } }, errors: [], partial: false }
  ]);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });

  await sync.run();
  const second = await sync.run();
  assert.equal(second.results[0].ingested, 0);
  assert.equal(second.results[0].duplicates, 1);
  assert.equal(Object.keys(store.state.tasks).length, 1);
  assert.equal(store.state.events.length, 1);
  assert.equal(cursors.get('google').gmail.historyId, 'h3', 'the cursor still advances past the replayed event');
});

test('a partial pull keeps the healthy scope cursor and reports the failure', async () => {
  const { store, engine, cursors } = setup();
  const connector = new ScriptedConnector('google', [{
    events: [liveEmail('m-1')],
    // The connector only advances the scope it actually completed.
    cursor: { gmail: { historyId: 'h-old' }, drive: { pageToken: 'p-2' } },
    errors: [{ scope: 'gmail', message: 'Google rejected the access token (401).', retryable: false }],
    partial: true
  }]);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });

  const outcome = await sync.run();
  assert.equal(outcome.results[0].partial, true);
  assert.equal(outcome.results[0].ingested, 1, 'what did succeed is still ingested');
  assert.equal(store.state.connectorStatus.google.ok, false, 'a partial pull is not healthy');
  assert.match(store.state.connectorStatus.google.lastError, /401/);
  assert.equal(cursors.get('google').drive.pageToken, 'p-2', 'the healthy scope advances');
  assert.equal(cursors.get('google').gmail.historyId, 'h-old', 'the failed scope does not');
});

test('a failing connector ingests nothing and never becomes a simulated success', async () => {
  const { store, engine, cursors } = setup();
  const connector = new ScriptedConnector('google', [new Error('network down')]);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });

  const outcome = await sync.run();
  assert.equal(outcome.results[0].failed, true);
  assert.equal(outcome.results[0].ingested, 0);
  assert.match(outcome.results[0].error, /network down/);
  assert.equal(store.state.connectorStatus.google.ok, false);
  assert.match(store.state.connectorStatus.google.lastError, /network down/);
  assert.equal(store.state.events.length, 0, 'no synthetic event may be invented');
  assert.equal(Object.keys(store.state.tasks).length, 0);
  assert.equal(store.state.outbox.length, 0, 'the simulated outbox must stay empty');
  assert.equal(cursors.get('google'), null, 'a failed pull must not advance a cursor');
});

test('an empty poll that repeats the same cursor does not rewrite state', async () => {
  const { store, engine, cursors } = setup();
  const quiet = { events: [], cursor: { gmail: { historyId: 'h2' } }, errors: [], partial: false };
  const connector = new ScriptedConnector('google', [quiet, { ...quiet, cursor: { gmail: { historyId: 'h2' } } }]);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });

  await sync.run();
  const revision = store.state.revision;
  const syncedAt = store.state.connectorStatus.google.lastSyncAt;
  const second = await sync.run();
  assert.equal(second.results[0].ingested, 0);
  assert.equal(store.state.revision, revision);
  assert.equal(store.state.connectorStatus.google.lastSyncAt, syncedAt);
  assert.equal(cursors.get('google').gmail.historyId, 'h2');
});

test('simulated connectors are skipped by the sync runner', async () => {
  const { store, engine, cursors } = setup();
  const simulated = new ScriptedConnector('simulated', [{ events: [liveEmail('m-1')], cursor: {}, errors: [] }]);
  simulated.live = false;
  const sync = new ConnectorSync({ connectors: [simulated], cursors, engine });

  const outcome = await sync.run();
  assert.deepEqual(outcome.results, []);
  assert.equal(simulated.calls.length, 0, 'the scenario scheduler owns simulated timing, not the sync loop');
  assert.equal(store.state.events.length, 0);
});

test('overlapping sync passes are skipped rather than queued', async () => {
  const { engine, cursors } = setup();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const connector = new Connector({ id: 'google', kind: 'gated' });
  connector.live = true;
  connector.pull = async () => { await gate; return { events: [], cursor: { gmail: { historyId: 'h1' } }, errors: [] }; };
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });

  const first = sync.run();
  const second = await sync.run();
  assert.match(second.skipped, /already running/);
  release();
  await first;
  assert.equal(sync.describe().running, false, 'the guard is released after the pass');
});

test('connector status and cursors survive a restart', async () => {
  const { filename, store, engine, cursors } = setup();
  const connector = new ScriptedConnector('google', [{
    events: [liveEmail('m-1')], cursor: { gmail: { historyId: 'h7' } }, errors: [], partial: false
  }]);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });
  await sync.run();

  const restored = new JsonStore(filename);
  assert.equal(restored.state.cursors.google.gmail.historyId, 'h7');
  assert.equal(restored.state.connectorStatus.google.ok, true);
  assert.equal(restored.state.events.length, 1);

  // A restarted engine resumes from the persisted cursor rather than resyncing.
  const resumed = new WorkEngine(restored, { provider: new SimulatedMailProvider(restored) });
  const nextConnector = new ScriptedConnector('google', [{ events: [], cursor: { gmail: { historyId: 'h8' } }, errors: [] }]);
  await new ConnectorSync({ connectors: [nextConnector], cursors: new CursorStore(restored), engine: resumed }).run();
  assert.deepEqual(nextConnector.calls, [{ gmail: { historyId: 'h7' } }]);
  assert.equal(store.state.events.length, 1);
});
