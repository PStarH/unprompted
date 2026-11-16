import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Connector } from '../src/connectors/connector.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';
import { NullReasoner } from '../src/reasoning.js';

test('stopped backup restores native unknown holds and prevents repeat effects', { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-backup-acceptance-'));
  let writes = 0, first = null, restored = null;
  function open(folder) {
    const store = new SqliteStore(path.join(folder, 'state.json'));
    const connector = new Connector({ id: 'github', kind: 'code', fetchImpl: async (_url, init) => {
      if (init.method !== 'GET') { writes++; throw new Error('Scripted response loss after remote effect'); }
      return new Response(JSON.stringify({}), { status: 200 });
    } });
    connector.live = true; connector.account = { id: 'backup-fixture-account' };
    connector.auth = { accessToken: async () => 'fixture-only' };
    const engine = new WorkEngine(store, { reasoner: new NullReasoner('backup acceptance fixture'), policy: new PermissionPolicy({ shadow: false }) });
    const runtime = new DurableRuntime(engine, { tickMs: 1000000, connectorFor: id => id === 'github' ? connector : null });
    return { store, engine, runtime, folder, closed: false };
  }
  async function close(context) {
    if (!context || context.closed) return;
    await context.runtime.close(); await context.engine.whenSettled(); context.store.close(); context.closed = true;
  }
  const taskId = 'request:backup-acceptance';
  const action = (context, operationId) => ({ connectorId: 'github', request: { method: 'PATCH', path: '/repos/team/project/issues/42', body: { amountMicros: 40, currency: 'USD', title: 'Scripted' } },
    confirmed: true, operationId, inputVersion: context.runtime.tasks.get(taskId).inputVersion });
  try {
    first = open(path.join(directory, 'source'));
    first.engine.ingest({ id: 'email:backup-acceptance', type: 'email.received', payload: { id: 'backup-acceptance', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar proposal with experiment results.' } });
    await first.engine.whenSettled(); assert.ok(first.runtime.tasks.get(taskId));
    const grant = first.engine.autonomy.create({ mode: 'time', durationMinutes: 30, money: { currency: 'USD', capMicros: 100, durationMinutes: 20, confirmed: true } });
    first.runtime.connectorActions.createGrant({ connectorId: 'github', pathPrefix: '/repos/team/project', confirmed: true,
      transfer: 'paid', financialConfirmed: true, monetaryGrantId: grant.moneyBudget.grantId,
      amountMicrosPointer: '/request/body/amountMicros', currencyPointer: '/request/body/currency' });
    first.runtime.memory.put({ id: 'backup-fixture-memory', content: 'Fixture workspace fact survives offline restore.', scopeType: 'project', scopeKey: 'Cedar' });
    fs.mkdirSync(path.join(first.folder, 'config'), { recursive: true });
    fs.writeFileSync(path.join(first.folder, 'config', 'fixture.json'), JSON.stringify({ fixtureOnly: true }), { mode: 0o600 });
    const originalAction = action(first, 'never-repeat');
    await assert.rejects(first.runtime.connectorActions.request(taskId, originalAction, { actor: 'user' }), /response loss/i);
    assert.equal(writes, 1);
    const before = first.runtime.transactionMoney.autonomyBudgetInfo(grant.moneyBudget.grantId);
    assert.equal(before.unknownMicros, 40); assert.equal(before.remainingMicros, 60);
    first.runtime.tokenBudget.reserve({ attemptId: 'backup-unknown-token', taskId, inputTokens: 10, outputTokens: 20 });
    first.runtime.tokenBudget.markDispatched('backup-unknown-token'); first.runtime.tokenBudget.markUnknown('backup-unknown-token');
    const execution = first.runtime.ledger.list().find(row => row.action_family === 'connector.request');
    assert.equal(execution.status, 'unknown');
    await close(first);
    const backup = path.join(directory, 'offline-copy'), destination = path.join(directory, 'restored-at-new-path');
    fs.cpSync(first.folder, backup, { recursive: true }); fs.cpSync(backup, destination, { recursive: true });
    assert.notEqual(destination, first.folder);
    restored = open(destination);
    const after = restored.runtime.transactionMoney.autonomyBudgetInfo(grant.moneyBudget.grantId);
    assert.equal(after.unknownMicros, 40); assert.equal(after.remainingMicros, 60);
    assert.equal(restored.runtime.tokenBudget.describe().workspace.unknown, 30);
    assert.equal(restored.runtime.ledger.get(execution.id).status, 'unknown');
    assert.equal(restored.store.db.prepare('SELECT content FROM user_memories WHERE id=?').get('backup-fixture-memory').content, 'Fixture workspace fact survives offline restore.');
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'config', 'fixture.json'))).fixtureOnly, true);
    const repeated = await restored.runtime.connectorActions.request(taskId, action(restored, 'never-repeat'), { actor: 'user' });
    assert.equal(repeated.state, 'unknown'); assert.equal(writes, 1);
    restored.engine.autonomy.revoke(grant.id);
    const fresh = action(restored, 'fresh-after-revoke'); fresh.request.path = '/repos/team/project/issues/43';
    await assert.rejects(restored.runtime.connectorActions.request(taskId, fresh, { actor: 'user' }), { code: 'TRANSACTION_QUOTE_STALE' });
    assert.equal(writes, 1);
    assert.equal(restored.runtime.transactionMoney.autonomyBudgetInfo(grant.moneyBudget.grantId).unknownMicros, 40);
  } finally {
    await close(restored); await close(first); fs.rmSync(directory, { recursive: true, force: true });
  }
});
