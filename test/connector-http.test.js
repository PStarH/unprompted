import test from 'node:test';
import assert from 'node:assert/strict';
import { providerJSON } from '../src/connectors/http.js';

test('provider transport labels JSON and form bodies without overriding an explicit content type', async () => {
  for (const example of [
    { options: { body: { query: 'test' } }, type: 'application/json', body: '{"query":"test"}' },
    { options: { form: { query: 'test value' } }, type: 'application/x-www-form-urlencoded', body: 'query=test+value' },
    { options: { body: { query: 'test' }, headers: { 'Content-Type': 'application/custom+json' } }, type: 'application/custom+json', body: '{"query":"test"}' }
  ]) {
    await providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', method: 'POST', ...example.options,
      fetchImpl: async (_url, options) => {
        assert.equal(new Headers(options.headers).get('content-type'), example.type);
        assert.equal(options.body, example.body);
        return new Response('{}');
      } });
  }
});

test('non-JSON provider error pages retain rate-limit classification without leaking body', async () => {
  await assert.rejects(providerJSON('/items', { provider: 'fixture', origin: 'https://example.test',
    fetchImpl: async () => new Response('private error content', { status: 429, headers: { 'retry-after': '30' } }) }), error => {
    assert.equal(error.status, 429);
    assert.equal(error.rateLimited, true);
    assert.equal(error.retryAfter, '30');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /private error content/);
    return true;
  });
});

test('provider transport bounds a fetch and a response body that ignore abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) })]) {
    await assert.rejects(providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', fetchImpl, timeoutMs: 20 }), error => error.timeout === true && error.retryable === true);
  }
});

test('provider transport keeps local error codes and only rewrites transport failures', async () => {
  const local = Object.assign(new Error('The task run is no longer current.'), { code: 'RUN_INVALIDATED' });
  await assert.rejects(providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', fetchImpl: async () => { throw local; } }), error => error === local);
  const other = Object.assign(new Error('permission'), { code: 'EPERM' });
  await assert.rejects(providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', fetchImpl: async () => { throw other; } }), error => error === other);
  await assert.rejects(providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', fetchImpl: async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); } }), /could not be reached/);
  await assert.rejects(providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', fetchImpl: async () => { throw Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }); } }), /could not be reached/);
  await assert.rejects(providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', fetchImpl: async () => { throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }); } }), /could not be reached/);
});

test('provider transport stops immediately when access is cancelled, even if fetch ignores abort', async () => {
  const controller = new AbortController();
  const pending = providerJSON('/items', { provider: 'fixture', origin: 'https://example.test', fetchImpl: () => new Promise(() => {}), timeoutMs: 10000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
});
