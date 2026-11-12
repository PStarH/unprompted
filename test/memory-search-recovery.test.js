import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemorySpace } from '../public/memory-space.js';

// These tests drive the real Memory Space controller. Only the browser
// boundary is stubbed: a minimal document that forwards events, a fetch that
// returns controlled promises, and Node's mock timers for the 100ms debounce.
// Every global descriptor is restored before the test ends.

const flush = () => new Promise(resolve => setImmediate(resolve));

const queryOf = path => new URL(path, 'http://memory.test').searchParams.get('q');
const parameterOf = (path, name) => new URL(path, 'http://memory.test').searchParams.get(name);

function successBody(query) {
  const label = query || 'recent';
  return {
    records: [{ id: `memory-${label}`, content: `${label} record`, text: `${label} record`, memoryKind: 'fact', status: 'active', createdAt: '2026-11-01T00:00:00.000Z' }],
    total: 1
  };
}

function createHarness({ revision = 7 } = {}) {
  const state = { revision, durable: true };
  const fetches = [];
  const updates = [];
  const listeners = new Map();
  const elements = new Map();
  let timerSequence = 0;

  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: false, clientWidth: 960, textContent: '', innerHTML: '', open: false, isConnected: true,
        addEventListener() {}, removeEventListener() {}, showModal() {}, close() {}, focus() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
        hasAttribute() { return false; }, getAttribute() { return null; }, setAttribute() {}
      });
    }
    return elements.get(id);
  };

  const document = {
    documentElement: { lang: 'en' },
    getElementById: id => element(id),
    addEventListener(type, listener) { const list = listeners.get(type) || []; list.push(listener); listeners.set(type, list); },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    activeElement: null
  };

  const emit = (type, event) => { for (const listener of listeners.get(type) || []) listener(event); };
  const searchTarget = value => ({
    value,
    hasAttribute: attribute => attribute === 'data-memory-search',
    closest: () => null,
    addEventListener() {}
  });

  const fetch = path => {
    const entry = { path: String(path), settled: false };
    entry.promise = new Promise(resolve => { entry.resolve = resolve; });
    fetches.push(entry);
    return entry.promise;
  };

  const respond = (index, body) => {
    const entry = fetches[index];
    assert.ok(entry, `expected fetch ${index} to have started`);
    assert.equal(entry.settled, false, `fetch ${index} settled twice`);
    entry.settled = true;
    entry.resolve({ ok: true, status: 200, json: async () => body });
  };
  const fail = (index, { status = 503, message = 'Memory search is temporarily unavailable.' } = {}) => {
    const entry = fetches[index];
    assert.ok(entry, `expected fetch ${index} to have started`);
    assert.equal(entry.settled, false, `fetch ${index} settled twice`);
    entry.settled = true;
    entry.resolve({ ok: false, status, json: async () => ({ error: message, code: 'UNAVAILABLE' }) });
  };

  const harness = {
    document,
    fetch,
    state,
    fetches,
    updates,
    respond,
    fail,
    queries: () => fetches.map(entry => queryOf(entry.path)),
    parameters: name => fetches.map(entry => parameterOf(entry.path, name)),
    contentUpdates: () => updates.filter(update => update.id === 'memoryContent').map(update => update.html),
    lastUpdate: () => harness.contentUpdates().at(-1) ?? '',
    input(value) { emit('input', { target: searchTarget(value), isComposing: false }); },
    nativeSearch(value) { emit('search', { target: searchTarget(value) }); },
    compositionStart() { emit('compositionstart', { target: searchTarget('') }); },
    compositionEnd(value) { emit('compositionend', { target: searchTarget(value) }); },
    change(attribute, value) {
      emit('change', { target: { value, hasAttribute: name => name === attribute, closest: () => null } });
    },
    clickRetry() {
      const target = { dataset: {}, hasAttribute: attribute => attribute === 'data-memory-retry', closest: () => target };
      emit('click', { target });
    },
    setRevision(value) { state.revision = value; },
    successFor: query => successBody(query),
    async initialise() {
      harness.controller.render();
      assert.deepEqual(harness.queries(), ['']);
      respond(0, successBody(''));
      await flush();
      updates.length = 0;
    },
    async settleAll() {
      for (let pass = 0; pass < 20; pass += 1) {
        let changed = false;
        for (const entry of fetches) {
          if (entry.settled) continue;
          entry.settled = true; changed = true;
          entry.resolve({ ok: true, status: 200, json: async () => successBody(queryOf(entry.path)) });
        }
        await flush();
        if (!changed) break;
      }
    },
    createController() {
      harness.controller = createMemorySpace({
        context: () => ({ state, workspace: 'memory-test-workspace' }),
        update: (id, html) => { updates.push({ id, html, timer: ++timerSequence }); },
        post: async () => { throw new Error('post is not expected in this test'); },
        applyState: () => {},
        notify: () => {},
        go: () => {}
      });
      return harness.controller;
    }
  };
  return harness;
}

async function withHarness(run) {
  const harness = createHarness();
  const saved = [];
  const install = (name, value) => {
    saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('document', harness.document);
  install('window', { addEventListener() {}, removeEventListener() {} });
  install('innerWidth', 1440);
  install('CSS', { escape: value => String(value) });
  install('fetch', harness.fetch);
  try {
    harness.createController();
    await run(harness);
  } finally {
    await harness.settleAll();
    for (const [name, descriptor] of saved.reverse()) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

function withTimers(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  return () => context.mock.timers.reset();
}

test('a stale completion that starts the latest browse load consumes its pending debounce', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.input('nonexistent-delay');
      assert.deepEqual(h.queries(), ['']);
      t.mock.timers.tick(100);
      assert.deepEqual(h.queries(), ['', 'nonexistent-delay']);
      // The held query is superseded while its request is still in flight.
      h.input('studio blue drawer');
      h.updates.length = 0;
      h.respond(1, h.successFor('nonexistent-delay'));
      await flush();
      assert.deepEqual(h.queries(), ['', 'nonexistent-delay', 'studio blue drawer']);
      // Keep the latest request pending so the old input debounce is still live.
      t.mock.timers.tick(100);
      h.respond(2, h.successFor('studio blue drawer'));
      await flush();
      assert.deepEqual(h.queries(), ['', 'nonexistent-delay', 'studio blue drawer']);
      assert.match(h.lastUpdate(), /studio blue drawer record/);
      assert.doesNotMatch(h.lastUpdate(), /nonexistent-delay record/);
      t.mock.timers.tick(500);
      await flush();
      assert.deepEqual(h.queries(), ['', 'nonexistent-delay', 'studio blue drawer']);
    });
  } finally {
    resetTimers();
  }
});

test('a stale failure does not project an error for the newer query', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.input('old-query');
      t.mock.timers.tick(100);
      assert.deepEqual(h.queries(), ['', 'old-query']);
      h.input('new-query');
      h.updates.length = 0;
      h.fail(1, { message: 'stale failure' });
      await flush();
      assert.deepEqual(h.queries(), ['', 'old-query', 'new-query']);
      assert.deepEqual(h.contentUpdates().filter(html => html.includes('memory-load-error')), []);
      h.respond(2, h.successFor('new-query'));
      await flush();
      assert.match(h.lastUpdate(), /new-query record/);
      assert.doesNotMatch(h.lastUpdate(), /memory-load-error/);
    });
  } finally {
    resetTimers();
  }
});

test('a failed latest query shows one error and explicit retry sends exactly one request', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.input('held-query');
      t.mock.timers.tick(100);
      assert.deepEqual(h.queries(), ['', 'held-query']);
      // Search again while the held request is in flight: the pending debounce
      // belongs to retry-this-query.
      h.input('retry-this-query');
      h.respond(1, h.successFor('held-query'));
      await flush();
      assert.deepEqual(h.queries(), ['', 'held-query', 'retry-this-query']);
      h.updates.length = 0;
      h.fail(2);
      await flush();
      assert.match(h.lastUpdate(), /memory-load-error/);
      assert.equal(h.queries().filter(query => query === 'retry-this-query').length, 1);
      t.mock.timers.tick(200);
      await flush();
      assert.equal(h.queries().filter(query => query === 'retry-this-query').length, 1);
      h.clickRetry();
      assert.equal(h.queries().filter(query => query === 'retry-this-query').length, 2);
      h.respond(3, h.successFor('retry-this-query'));
      await flush();
      assert.doesNotMatch(h.lastUpdate(), /memory-load-error/);
      assert.match(h.lastUpdate(), /retry-this-query record/);
      t.mock.timers.tick(500);
      await flush();
      assert.equal(h.queries().filter(query => query === 'retry-this-query').length, 2);
    });
  } finally {
    resetTimers();
  }
});

test('input followed by the native search event for one intent issues one request', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.input('search-intent');
      h.nativeSearch('search-intent');
      assert.deepEqual(h.queries(), ['', 'search-intent']);
      t.mock.timers.tick(100);
      h.respond(1, h.successFor('search-intent'));
      await flush();
      assert.deepEqual(h.queries(), ['', 'search-intent']);
      assert.match(h.lastUpdate(), /search-intent record/);
    });
  } finally {
    resetTimers();
  }
});

test('rapid typing loads only the latest query once', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.input('a'); h.input('ab'); h.input('abc');
      assert.deepEqual(h.queries(), ['']);
      t.mock.timers.tick(100);
      assert.deepEqual(h.queries(), ['', 'abc']);
      h.respond(1, h.successFor('abc'));
      await flush();
      assert.match(h.lastUpdate(), /abc record/);
    });
  } finally {
    resetTimers();
  }
});

test('IME composition defers loading until compositionend and does not duplicate it', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.compositionStart();
      h.input('林');
      t.mock.timers.tick(500);
      assert.deepEqual(h.queries(), ['']);
      h.compositionEnd('林晨');
      assert.deepEqual(h.queries(), ['', '林晨']);
      t.mock.timers.tick(500);
      h.respond(1, h.successFor('林晨'));
      await flush();
      assert.deepEqual(h.queries(), ['', '林晨']);
      assert.match(h.lastUpdate(), /林晨 record/);
    });
  } finally {
    resetTimers();
  }
});

test('filter changes and revision refresh keep the latest query and do not double-load', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.input('filter-query');
      t.mock.timers.tick(100);
      h.respond(1, h.successFor('filter-query'));
      await flush();
      h.change('data-memory-kind', 'preference');
      assert.deepEqual(h.queries(), ['', 'filter-query', 'filter-query']);
      assert.equal(parameterOf(h.fetches[2].path, 'kind'), 'preference');
      h.respond(2, h.successFor('filter-query'));
      await flush();
      h.setRevision(8);
      h.controller.render();
      assert.deepEqual(h.queries(), ['', 'filter-query', 'filter-query', 'filter-query']);
      assert.equal(parameterOf(h.fetches[3].path, 'kind'), 'preference');
      h.respond(3, h.successFor('filter-query'));
      await flush();
      h.controller.render();
      assert.deepEqual(h.queries(), ['', 'filter-query', 'filter-query', 'filter-query']);
    });
  } finally {
    resetTimers();
  }
});

test('a debounce consumed while loading still produces one successor for the latest query', async t => {
  const resetTimers = withTimers(t);
  try {
    await withHarness(async h => {
      await h.initialise();
      h.input('first');
      t.mock.timers.tick(100);
      assert.deepEqual(h.queries(), ['', 'first']);
      h.input('second');
      t.mock.timers.tick(100);
      assert.deepEqual(h.queries(), ['', 'first']);
      h.respond(1, h.successFor('first'));
      await flush();
      assert.deepEqual(h.queries(), ['', 'first', 'second']);
      h.respond(2, h.successFor('second'));
      await flush();
      assert.deepEqual(h.queries(), ['', 'first', 'second']);
      assert.match(h.lastUpdate(), /second record/);
    });
  } finally {
    resetTimers();
  }
});
