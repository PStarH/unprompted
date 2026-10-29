import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './browser/fixture-server.mjs';

const get = async (fixture, route) => (await fetch(fixture.base + route)).json();
async function post(fixture, route, body, origin = null) {
  const response = await fetch(fixture.base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('persistent HTTP workspace exposes real SQLite, explicit policies, version conflicts and verifiable Forget', async t => {
  const fixture = await startFixtureServer({ ruleDemo: false }); t.after(fixture.close);
  const durable = await get(fixture, '/api/durable');
  assert.deepEqual(await get(fixture, '/api/situations'), { situations: [], available: true });
  assert.equal(durable.storage.sqliteVersion, '3.53.2'); assert.equal(durable.storage.synchronous, 'FULL');
  assert.equal(durable.activationContract, '1.5.0'); assert.equal(durable.activityTelemetry, 'unavailable');
  assert.equal(durable.learning.autoPromote, false); assert.equal(durable.memory.semantic, false);
  assert.ok(fs.existsSync(path.join(fixture.directory, 'state.sqlite')));
  const instruction = await post(fixture, '/api/instructions', { kind: 'fact', text: 'Weekly notes begin with results.' });
  assert.equal(instruction.status, 200); assert.ok(instruction.body.state.groundedMemories.length);
  const memory = instruction.body.memory;
  let response = await post(fixture, '/api/policies', { instruction: 'Prioritize Alex', predicate: { op: 'eq', feature: 'sender.identity', value: 'alex@example.test' }, effect: { type: 'priority', value: 90 } });
  assert.equal(response.status, 200); assert.equal(response.body.policy.status, 'draft');
  const draft = response.body.policy;
  response = await post(fixture, '/api/policies', { id: draft.id, expectedVersion: draft.version, instruction: 'Prioritize Alex', predicate: { op: 'all', args: [{ op: 'eq', feature: 'event.provider', value: 'google' }, { op: 'eq', feature: 'sender.identity', value: 'alex@example.test' }] }, effect: { type: 'priority', value: 90 }, identities: [{ provider: 'google', providerId: 'alex@example.test', confirmedByUser: true }] });
  assert.equal(response.body.policy.status, 'active');
  assert.equal((await post(fixture, `/api/policies/${draft.id}/disable`, { expectedVersion: draft.version })).status, 409);
  assert.equal((await post(fixture, '/api/policies', { id: draft.id, instruction: 'Stale overwrite', predicate: { op: 'always' }, effect: { type: 'suppress' } })).status, 409);
  assert.equal((await post(fixture, '/api/privacy/forget', { kind: 'memory', id: memory.id }, 'https://foreign.test')).status, 403);
  const preview = await post(fixture, '/api/privacy/preview', { kind: 'memory', id: memory.id }); assert.equal(preview.body.counts.memory, 1);
  const forgotten = await post(fixture, '/api/privacy/forget', { kind: 'memory', id: memory.id });
  assert.equal(forgotten.status, 200); assert.equal(forgotten.body.deletion.state, 'completed');
  assert.equal(forgotten.body.state.groundedMemories.length, 0);
  const status = await get(fixture, `/api/privacy/requests/${forgotten.body.deletion.id}`); assert.equal(status.state, 'completed');
  assert.equal((await post(fixture, '/api/privacy/forget', { kind: 'memory', id: 'absent' })).status, 404);
  assert.equal((await get(fixture, '/api/state')).outbox.length, 0);
  const created = await post(fixture, '/api/standing-intents', { confirmed: true, description: 'Watch the lobby', desiredOutcome: 'Note lobby noise', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN'], tokens: ['lobby'] }, prohibited: ['external_write'], budget: { maxMatches: 1, windowMs: 86400000 } });
  assert.equal(created.status, 200); assert.equal(created.body.intent.confirmation, 'user_confirmed');
  assert.equal((await post(fixture, '/api/standing-intents', { confirmed: false, description: 'Watch the lobby', desiredOutcome: 'Note lobby noise', prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN'] } })).status, 403);
  assert.equal((await post(fixture, `/api/standing-intents/${created.body.intent.id}/pause`, { expectedVersion: created.body.intent.version })).body.intent.status, 'paused');
  assert.equal((await post(fixture, '/api/activation/flags', { standingIntents: false })).body.flags.standingIntents, false);
  const metrics = await get(fixture, '/api/activation/metrics');
  assert.equal(metrics.usefulTaskPrecision.value, 'unknown');
  assert.equal(metrics.forgetScope.physicalErasure, 'not_claimed');
  assert.equal((await get(fixture, '/api/state')).outbox.length, 0);
});

test('offline tuning endpoints retain metrics without queries, source content or external execution', async t => {
  const fixture = await startFixtureServer({ ruleDemo: false }); t.after(fixture.close);
  const saved = await post(fixture, '/api/instructions', { text: 'Cedar weekly results and risks.' });
  const replay = await post(fixture, '/api/experiences/replay', { cases: [{ query: 'Cedar weekly results', relevantIds: [saved.body.memory.id] }] });
  assert.equal(replay.status, 200); assert.equal(replay.body.metrics.recall, 1);
  assert.equal((await post(fixture, '/api/experiences/context-policy', { maxEvents: 8, windowMs: 600000 })).status, 200);
  assert.equal((await post(fixture, '/api/experiences/context-policy', { maxAssociations: 4 })).status, 400);
  assert.equal((await post(fixture, '/api/experiences/attention-policy', { quietHours: { startHour: 22, endHour: 8, timeZone: 'Asia/Shanghai' } })).status, 200);
  assert.equal((await get(fixture, '/api/state')).outbox.length, 0);
});
