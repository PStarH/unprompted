import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractions } from '../public/interactions.js';

// The interaction module only needs the browser surface it touches during
// prepare: local storage plus event listener registration. Keep the stub small
// and remove every global again so other test files in this process stay clean.
function installBrowserStubs() {
  const storage = new Map();
  const events = new Map();
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    location: globalThis.location
  };
  const element = () => ({
    hidden: true,
    style: {},
    textContent: '',
    contains: () => false,
    focus: () => {},
    setAttribute: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
  });
  globalThis.localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    clear: () => storage.clear()
  };
  globalThis.document = {
    getElementById: element,
    addEventListener: (type, listener) => events.set(type, [...(events.get(type) || []), listener]),
    querySelectorAll: () => []
  };
  globalThis.window = { addEventListener: () => {} };
  globalThis.location = { origin: 'http://candidate.test' };
  return {
    storage,
    restore() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    }
  };
}

function task(id, status) {
  return {
    id,
    subject: `Task ${id}`,
    evidence: { criteria: [{ id: 'criterion-1', status }] }
  };
}

function interactionsFor(getState) {
  return createInteractions({
    context: () => ({ state: getState(), workspace: getState().workspace, visitBaseline: null }),
    update: () => {},
    refresh: () => {},
    escape: value => String(value),
    title: task => task.subject,
    sourceLabel: value => String(value)
  });
}

test('first prepare establishes an evidence baseline instead of throwing on undeclared interaction state', t => {
  const stubs = installBrowserStubs();
  t.after(() => stubs.restore());
  const state = { workspace: 'workspace-a', tasks: [task('task-1', 'unmet')] };
  const interactions = interactionsFor(() => state);

  assert.doesNotThrow(() => interactions.prepare());
  const baseline = interactions.delta(state.tasks[0]);
  assert.notEqual(baseline, null, 'prepare must seed the reviewed baseline for the current task');
  assert.equal(baseline.hasChanges, false);

  // Same workspace: the original baseline is retained, and new evidence is
  // reported as a delta from it even though prepare runs again.
  state.tasks[0].evidence.criteria[0].status = 'satisfied';
  assert.deepEqual(interactions.delta(state.tasks[0]).changed, ['criterion-1']);
  assert.doesNotThrow(() => interactions.prepare());
  assert.deepEqual(interactions.delta(state.tasks[0]).changed, ['criterion-1']);
});

test('switching workspace does not inherit another workspace baseline for the same task id', t => {
  const stubs = installBrowserStubs();
  t.after(() => stubs.restore());
  const state = { workspace: 'workspace-a', tasks: [task('task-1', 'unmet')] };
  const interactions = interactionsFor(() => state);

  assert.doesNotThrow(() => interactions.prepare());
  state.tasks[0].evidence.criteria[0].status = 'satisfied';
  assert.equal(interactions.delta(state.tasks[0]).hasChanges, true);

  // workspace-b has no stored baseline. The same task id must start from its
  // current facts, not from workspace-a's unmet baseline.
  state.workspace = 'workspace-b';
  assert.doesNotThrow(() => interactions.prepare());
  const fresh = interactions.delta(state.tasks[0]);
  assert.notEqual(fresh, null, 'prepare must seed a fresh baseline in the new workspace');
  assert.equal(fresh.hasChanges, false, 'the same task id must not inherit workspace-a reviewed facts');
  assert.deepEqual(interactions.delta(state.tasks[0]).changed, []);
});
