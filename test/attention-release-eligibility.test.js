import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { AttentionBudget } from '../src/durable/attention.js';
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-eligibility-')); let now = Date.parse('2026-11-14T04:00:00Z');
  const database = new DurableDatabase(path.join(dir, 'state.sqlite'), { now: () => now });
  const other = new DurableDatabase(path.join(dir, 'state.sqlite'), { now: () => now });
  const attention = new AttentionBudget(database, { maxInteractivePerHour: 1, minIntervalMs: 0, digestWindowMs: 0, issueCooldownMs: 0, ...options });
  t.after(() => { other.close(); database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const offer = (id, extra = {}, issueKey = id) => attention.offer({ id, dedupeKey: id, headline: id, ...extra }, { issueKey });
  const row = id => database.db.prepare('SELECT * FROM notification_deliveries WHERE dedupe_key=?').get(id);
  const task = data => database.db.prepare('INSERT INTO tasks(id,data_json,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('task', JSON.stringify(data), 'waiting_for_information', iso(now), iso(now));
  const changeTask = data => other.atomic(() => other.db.prepare('UPDATE tasks SET data_json=? WHERE id=?').run(JSON.stringify(data), 'task'));
  return { database, other, attention, offer, row, task, changeTask, advance: ms => { now += ms; }, now: () => now };
}
for (const change of ['yield', 'revoked']) test(`release rechecks ${change} committed by another connection immediately before BEGIN`, t => {
  const f = fixture(t); f.task({ sourceConnectorId: 'google' });
  f.offer('seed'); f.offer('waiting', { taskId: 'task' }); f.advance(3600001);
  const atomic = f.database.atomic.bind(f.database); let injected = false;
  f.database.atomic = callback => {
    if (!injected) {
      injected = true;
      if (change === 'yield') f.changeTask({ sourceConnectorId: 'google', yieldState: 'YIELDED_TO_USER' });
      else f.other.atomic(() => f.other.set('revoked_connectors', JSON.stringify(['google'])));
    }
    return atomic(callback);
  };
  const released = f.attention.releaseDue();
  assert.equal(injected, true); assert.deepEqual(released, []);
  assert.equal(f.row('waiting').state, 'pending'); assert.equal(f.row('waiting').delivered_at, null);
});

test('issue cooldown independently blocks a repeated issue and releases it after expiry', t => {
  const f = fixture(t, { maxInteractivePerHour: 100, issueCooldownMs: 10000 });
  assert.equal(f.offer('first', {}, 'same-issue').state, 'delivered');
  assert.equal(f.offer('second', {}, 'same-issue').state, 'pending');
  assert.equal(f.offer('different', {}, 'different-issue').state, 'delivered');
  f.advance(5000); assert.deepEqual(f.attention.releaseDue(), []);
  f.advance(6000); assert.deepEqual(f.attention.releaseDue().map(row => row.dedupe_key), ['second']);
});

test('refreshing an actually queued dedupe retains its original age and updates its content', t => {
  const f = fixture(t); f.offer('seed'); f.offer('waiting', { priority: 'low' });
  const created = f.row('waiting').created_at; f.advance(1800000);
  assert.equal(f.offer('waiting', { priority: 'low', headline: 'updated headline' }).state, 'pending');
  assert.equal(f.row('waiting').created_at, created);
  assert.equal(JSON.parse(f.row('waiting').notification_json).headline, 'updated headline');
});

test('release-first ordering includes actual contention and gives the old low the next available slot', t => {
  const f = fixture(t); f.task({}); f.offer('seed'); f.offer('low', { taskId: 'task', priority: 'low' });
  f.advance(7200001); f.changeTask({ yieldState: 'YIELDED_TO_USER' });
  assert.equal(f.offer('current-window', { priority: 'high' }).state, 'delivered');
  f.changeTask({}); assert.deepEqual(f.attention.releaseDue(), []);
  assert.equal(f.offer('fresh-high', { priority: 'high' }).state, 'pending');
  f.advance(3600001);
  assert.deepEqual(f.attention.releaseDue().map(row => row.dedupe_key), ['low']);
  assert.equal(f.row('fresh-high').state, 'pending');
});

test('an aged low currently blocked by dynamic spacing cannot reserve a high-priority slot', t => {
  const f = fixture(t, { minIntervalMs: 600000 }); f.task({});
  f.offer('seed'); f.offer('low', { taskId: 'task', priority: 'low' });
  f.advance(7200001); f.changeTask({ yieldState: 'YIELDED_TO_USER' });
  assert.equal(f.offer('recent', { priority: 'high' }).state, 'delivered');
  f.attention.configure({ maxInteractivePerHour: 5 }); f.changeTask({});
  assert.equal(f.offer('fresh-high', { priority: 'high' }).state, 'delivered');
  assert.equal(f.row('low').state, 'pending');
});

test('a legitimately queued high keeps its spacing exemption when older high is released', t => {
  const f = fixture(t, { minIntervalMs: 600000 }); f.task({});
  f.offer('seed'); f.offer('old-high', { taskId: 'task', priority: 'high' });
  f.advance(7200001); f.changeTask({ yieldState: 'YIELDED_TO_USER' });
  assert.equal(f.offer('recent', { priority: 'high' }).state, 'delivered');
  f.attention.configure({ maxInteractivePerHour: 3 }); f.changeTask({});
  assert.equal(f.offer('fresh-high', { priority: 'high' }).state, 'pending');
  assert.deepEqual(f.attention.releaseDue().map(row => row.dedupe_key), ['old-high', 'fresh-high']);
});
