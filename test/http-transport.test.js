import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HttpRequestError, readJsonBody, SseHub } from '../src/http-transport.js';

class FakeRequest extends EventEmitter {
  constructor() { super(); this.complete = true; }
}

class FakeResponse extends EventEmitter {
  constructor({ highWaterMark = 1 } = {}) {
    super();
    this.highWaterMark = highWaterMark;
    this.frames = [];
    this.callbacks = [];
    this.writableLength = 0;
    this.statusCode = null;
    this.destroyed = false;
    this.ended = false;
  }

  writeHead(status, headers) { this.statusCode = status; this.headers = headers; }
  flushHeaders() {}
  write(frame, callback = () => {}) {
    const buffer = Buffer.from(frame);
    this.frames.push(buffer);
    this.callbacks.push({ callback, size: buffer.byteLength });
    this.writableLength += buffer.byteLength;
    return this.writableLength < this.highWaterMark;
  }
  flush() {
    const callbacks = this.callbacks.splice(0);
    this.writableLength = 0;
    for (const { callback } of callbacks) callback();
    this.emit('drain');
  }
  end(value = '') { this.ended = true; this.body = value; this.emit('finish'); this.emit('close'); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
}

function makeHub(options = {}) {
  const timerCallbacks = [];
  const hub = new SseHub({
    heartbeatMs: 1000,
    setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timerCallbacks.push(timer); return timer; },
    clearIntervalFn() {},
    ...options
  });
  return { hub, timerCallbacks };
}

test('a blocked SSE client retains one latest snapshot instead of every full-state update', () => {
  const { hub } = makeHub({ maxFrameBytes: 1024, maxBufferedBytes: 2048, maxTotalBufferedBytes: 4096 });
  const req = new FakeRequest();
  const res = new FakeResponse({ highWaterMark: 1 });
  assert.equal(hub.add(req, res, { version: 0 }), true);
  assert.equal(hub.stats().blockedClients, 1);

  for (let version = 1; version <= 100; version += 1) hub.publish({ version, payload: 'snapshot'.repeat(20) });
  const blocked = hub.stats();
  assert.equal(blocked.clients, 1);
  assert.equal(blocked.pendingBytes > 0, true);
  assert.ok(blocked.bufferedBytes <= 2048, 'the per-client accounting stays within its configured bound');
  assert.ok(blocked.bufferedBytes <= blocked.maxTotalBufferedBytes);
  assert.equal(res.frames.length, 1, 'updates are coalesced while the socket is blocked');

  res.flush();
  assert.equal(res.frames.length, 2, 'drain sends one replacement snapshot');
  assert.match(res.frames[1].toString(), /"version":100/);
  assert.doesNotMatch(res.frames[1].toString(), /"version":50/);
  assert.equal(hub.stats().pendingBytes, 0);
  hub.close();
});

test('SSE limits connections and oversized frames without retaining a client', () => {
  const { hub } = makeHub({ maxClients: 1, maxFrameBytes: 1024, maxBufferedBytes: 2048, maxTotalBufferedBytes: 4096 });
  const first = new FakeResponse();
  assert.equal(hub.add(new FakeRequest(), first, { ok: true }), true);
  const second = new FakeResponse();
  assert.equal(hub.add(new FakeRequest(), second, { ok: true }), false);
  assert.equal(second.statusCode, 503);
  assert.equal(second.ended, true);
  assert.equal(hub.stats().clients, 1);

  hub.publish({ large: 'x'.repeat(1500) });
  assert.equal(first.destroyed, true, 'a client is closed before an oversized frame can enter its socket buffer');
  assert.deepEqual(hub.stats(), {
    clients: 0, bufferedBytes: 0, pendingBytes: 0, blockedClients: 0,
    maxClients: 1, maxBufferedBytes: 2048, maxTotalBufferedBytes: 4096
  });
  hub.close();
});

test('SSE enforces one aggregate buffered-byte budget across slow clients', () => {
  const { hub } = makeHub({ maxClients: 4, maxFrameBytes: 1024, maxBufferedBytes: 1024, maxTotalBufferedBytes: 1024 });
  const clients = [new FakeResponse({ highWaterMark: 1 }), new FakeResponse({ highWaterMark: 1 })];
  for (const res of clients) assert.equal(hub.add(new FakeRequest(), res, { initial: true }), true);
  hub.publish({ payload: 'x'.repeat(800) });
  const state = hub.stats();
  assert.ok(state.bufferedBytes <= state.maxTotalBufferedBytes);
  assert.ok(state.pendingBytes <= state.maxTotalBufferedBytes);
  assert.equal(state.clients, 1, 'a slow connection that would exceed the shared budget is dropped');
  assert.equal(clients.filter(res => res.destroyed).length, 1);
  hub.close();
});

test('initial SSE snapshots reserve aggregate bytes before accepting a connection', () => {
  const { hub } = makeHub({ maxClients: 4, maxFrameBytes: 1024, maxBufferedBytes: 1024, maxTotalBufferedBytes: 1024 });
  const largeState = { payload: 'x'.repeat(600) };
  const first = new FakeResponse({ highWaterMark: 1 });
  assert.equal(hub.add(new FakeRequest(), first, largeState), true);
  const firstFrameBytes = first.frames[0].byteLength;
  assert.equal(hub.stats().bufferedBytes, firstFrameBytes, 'a blocked initial snapshot is charged to the shared budget');

  const second = new FakeResponse({ highWaterMark: 1 });
  assert.equal(hub.add(new FakeRequest(), second, largeState), false);
  assert.equal(second.statusCode, 503, 'the second large snapshot is rejected before 200 headers are sent');
  assert.equal(hub.stats().clients, 1);
  assert.equal(hub.stats().bufferedBytes, firstFrameBytes);

  hub.publish({ version: 1 });
  const pendingBytes = hub.stats().pendingBytes;
  assert.ok(pendingBytes > 0);
  first.flush();
  assert.equal(hub.stats().bufferedBytes, first.frames[1].byteLength,
    'the initial frame callback releases only initial bytes and leaves the pending replacement accounted');
  assert.equal(hub.stats().bufferedBytes, pendingBytes);
  hub.close();
});

test('SSE disconnect, error, shutdown and late write callbacks clean up once', () => {
  const { hub } = makeHub();
  const req = new FakeRequest();
  const res = new FakeResponse({ highWaterMark: 1 });
  hub.add(req, res, { first: true });
  hub.publish({ newer: true });
  const lateCallback = res.callbacks[0].callback;
  assert.ok(hub.stats().bufferedBytes > 0);

  res.emit('close');
  assert.equal(hub.stats().clients, 0);
  assert.equal(hub.stats().bufferedBytes, 0);
  assert.doesNotThrow(() => res.emit('error', new Error('late socket error')));
  hub.close();
  lateCallback(new Error('late callback after cleanup'));
  assert.equal(hub.stats().bufferedBytes, 0);

  const otherHub = makeHub().hub;
  const other = new FakeResponse({ highWaterMark: 1 });
  otherHub.add(new FakeRequest(), other, { connected: true });
  otherHub.close();
  assert.equal(other.destroyed, true);
  assert.equal(otherHub.stats().clients, 0);
});

test('SSE heartbeats keep only active, unblocked connections warm', () => {
  const { hub, timerCallbacks } = makeHub();
  const res = new FakeResponse({ highWaterMark: 10_000 });
  hub.add(new FakeRequest(), res, { ready: true });
  assert.equal(timerCallbacks[0].delay, 1000);
  timerCallbacks[0].callback();
  assert.equal(res.frames.some(frame => frame.toString() === ': keep-alive\n\n'), true);

  const blocked = new FakeResponse({ highWaterMark: 1 });
  hub.add(new FakeRequest(), blocked, { ready: false });
  timerCallbacks[0].callback();
  assert.equal(blocked.frames.length, 1, 'a blocked stream does not accumulate heartbeat frames');
  hub.close();
});

test('JSON body parsing bounds declared and streamed size and reports the right status', async () => {
  const oversizedHeader = new PassThrough();
  oversizedHeader.headers = { 'content-type': 'application/json', 'content-length': '99' };
  oversizedHeader.complete = false;
  await assert.rejects(readJsonBody(oversizedHeader, { maxBytes: 8 }), error => {
    assert.ok(error instanceof HttpRequestError);
    assert.equal(error.status, 413);
    assert.equal(error.closeConnection, true);
    return true;
  });

  const streamed = new PassThrough();
  streamed.headers = { 'content-type': 'application/json' };
  streamed.complete = false;
  const result = readJsonBody(streamed, { maxBytes: 8, timeoutMs: 500, idleTimeoutMs: 200 });
  streamed.write(Buffer.from('{"a":'));
  streamed.write(Buffer.from('"long"}'));
  await assert.rejects(result, error => error.status === 413 && error.closeConnection === true);
  streamed.destroy();
});

test('JSON body parsing times out stalled bodies and accepts normal JSON and empty actions', async () => {
  const stalled = new PassThrough();
  stalled.headers = { 'content-type': 'application/json' };
  stalled.complete = false;
  const timed = readJsonBody(stalled, { maxBytes: 1024, timeoutMs: 100, idleTimeoutMs: 20 });
  await assert.rejects(timed, error => error.status === 408 && error.closeConnection === true);
  stalled.destroy();

  const trickle = new PassThrough();
  trickle.headers = { 'content-type': 'application/json' };
  trickle.complete = false;
  const overallDeadline = readJsonBody(trickle, { maxBytes: 1024, timeoutMs: 40, idleTimeoutMs: 20 });
  const drip = setInterval(() => trickle.write(' '), 5);
  await assert.rejects(overallDeadline, error => error.status === 408 && /time limit/.test(error.message));
  clearInterval(drip);
  trickle.destroy();

  const body = new PassThrough();
  body.headers = { 'content-type': 'application/json' };
  body.complete = true;
  const parsed = readJsonBody(body);
  body.end('{"ok":true}');
  assert.deepEqual(await parsed, { ok: true });

  const empty = new PassThrough();
  empty.headers = { 'content-type': 'application/json' };
  empty.complete = true;
  const noContent = readJsonBody(empty);
  empty.end();
  assert.deepEqual(await noContent, {});
});
