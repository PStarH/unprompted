import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase } from '../src/durable/database.js';
import { ModelRoutingMetrics } from '../src/durable/model-routing-metrics.js';
function fixture(t) {
  const database = new DurableDatabase(':memory:'); t.after(() => database.close()); let clock = 0;
  const metrics = new ModelRoutingMetrics(database, { clock: () => clock });
  return { database, metrics, advance: ms => { clock += ms; } };
}
const info = { stage: 'planning', routingVersion: 1, routingDigest: `sha256:${'a'.repeat(64)}`, model: 'strong', protocol: 'chat-completions', success: true };
const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
test('local duration, known zero and unknown counts remain distinct', t => {
  const f = fixture(t); let token = f.metrics.start(); f.advance(25); f.metrics.finish(token, { ...info, usage });
  token = f.metrics.start(); f.advance(15); f.metrics.finish(token, { ...info, model: 'zero', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  token = f.metrics.start(); f.advance(40); f.metrics.finish(token, { ...info, model: 'unknown', success: false, failureClass: 'provider', httpStatus: 503 });
  const result = f.metrics.summary(); assert.equal(result.totals.attempts, 3); assert.equal(result.totals.knownTokens, 18);
  const strong = result.groups.find(g => g.model === 'strong'); assert.equal(strong.avgDurationMs, 25); assert.equal(strong.knownTokens, 18);
  const zero = result.groups.find(g => g.model === 'zero'); assert.equal(zero.usageKnownCalls, 1); assert.equal(zero.knownTokens, 0);
  const unknown = result.groups.find(g => g.model === 'unknown'); assert.equal(unknown.usageUnknownCalls, 1); assert.equal(unknown.knownTokens, null);
  const row = f.database.db.prepare("SELECT * FROM model_route_attempts WHERE model='unknown'").get(); assert.equal(row.input_tokens, null); assert.equal(row.total_tokens, null);
});
test('one native start capability records at most once and lookalikes record nothing', t => {
  const f = fixture(t), token = f.metrics.start(); f.metrics.finish(token, { ...info, usage }); f.metrics.finish(token, { ...info, usage }); f.metrics.finish({}, { ...info, usage });
  assert.equal(f.metrics.summary().totals.attempts, 1);
});
test('aggregation totals cover all groups while display truncation is explicit', t => {
  const f = fixture(t);
  for (let version = 1; version <= 105; version++) f.metrics.finish(f.metrics.start(), { ...info, routingVersion: version, usage });
  const result = f.metrics.summary(); assert.equal(result.groups.length, 100); assert.equal(result.truncated, true); assert.equal(result.totals.attempts, 105); assert.equal(result.totals.knownTokens, 1890);
});
test('malformed usage remains unknown rather than coerced or partial zero', t => {
  const f = fixture(t); f.metrics.finish(f.metrics.start(), { ...info, usage: { input: '10', output: 0, cacheRead: 0, cacheWrite: 0 } });
  const result = f.metrics.summary(); assert.equal(result.totals.usageUnknownCalls, 1); assert.equal(result.totals.knownTokens, null);
});
test('advisory SQL write failure is sanitized and observable, then later writes recover', t => {
  const f = fixture(t), atomic = f.database.atomic.bind(f.database); f.database.atomic = () => { throw Object.assign(new Error('PRIVATE-BODY API-KEY must not escape'), { code: 'SQLITE_BUSY' }); };
  assert.equal(f.metrics.finish(f.metrics.start(), { ...info, usage }), null); assert.equal(f.metrics.status().writeFailures, 1); assert.equal(f.metrics.status().lastFailure.code, 'SQLITE_BUSY');
  f.database.atomic = atomic; f.metrics.finish(f.metrics.start(), { ...info, usage }); const result = f.metrics.summary(); assert.equal(result.totals.attempts, 1); assert.equal(result.observationStatus.writeFailures, 1); assert.equal(JSON.stringify(result).includes('PRIVATE-BODY'), false);
});
test('metrics persist across database reopen without prompt or identifier columns', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-metrics-')), file = path.join(dir, 'state.sqlite'); let database = new DurableDatabase(file);
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let metrics = new ModelRoutingMetrics(database); metrics.finish(metrics.start(), { ...info, usage }); database.close(); database = new DurableDatabase(file); metrics = new ModelRoutingMetrics(database);
  assert.equal(metrics.summary().totals.attempts, 1);
  const columns = database.db.pragma('table_info(model_route_attempts)').map(row => row.name); assert.equal(columns.some(name => /prompt|body|key|task_id|request_id/.test(name)), false);
});
