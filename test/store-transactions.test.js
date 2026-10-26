import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-store-transaction-'));
  const file = path.join(directory, 'state.json');
  const stores = [];
  const open = () => { const store = new JsonStore(file); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, open };
}

test('a closed store cannot overwrite a replacement writer, including through save or no-op mutation', t => {
  const f = fixture(t);
  const closed = f.open(); closed.close();
  const current = f.open(); current.mutate(state => { state.mode = 'live'; });
  const bytes = fs.readFileSync(f.file, 'utf8');
  let called = false;
  for (const operation of [() => closed.save(), () => closed.mutate(() => { called = true; }), () => closed.mutateIfChanged(() => { called = true; })]) {
    assert.throws(operation, error => error.code === 'STORE_CLOSED');
  }
  assert.equal(called, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
});

test('a throwing mutation rolls back memory and cannot leak into the next committed transition', t => {
  const f = fixture(t); const store = f.open();
  const before = structuredClone(store.state);
  assert.throws(() => store.mutate(state => { state.inbox.push({ id: 'uncommitted' }); throw new Error('callback failed'); }), /callback failed/);
  assert.deepEqual(store.state, before);
  store.mutate(state => { state.mode = 'live'; });
  const persisted = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(persisted.inbox, []);
  assert.equal(persisted.revision, before.revision + 1);
});

test('a rejected asynchronous mutation cannot publish its early or delayed state changes', async t => {
  const f = fixture(t); const store = f.open();
  let resume;
  const barrier = new Promise(resolve => { resume = resolve; });
  assert.throws(() => store.mutate(async state => {
    state.mode = 'live';
    await barrier;
    state.inbox.push({ id: 'too-late' });
    throw new Error('late rejection');
  }), /synchronous/i);
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.state.mode, 'simulation');
  assert.deepEqual(store.state.inbox, []);
  assert.equal(store.state.revision, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).revision, 0);
});

test('nested mutation or closing during a transaction cannot partially commit or release the writer lock', t => {
  const f = fixture(t); const store = f.open();
  for (const operation of [() => store.mutate(() => {}), () => store.save(), () => store.close()]) {
    assert.throws(() => store.mutate(state => { state.inbox.push({ id: 'partial' }); operation(); }), /transaction|mutation/i);
    assert.deepEqual(store.state.inbox, []);
    assert.equal(store.state.revision, 0);
    assert.equal(store.closed, false);
    assert.ok(fs.existsSync(`${f.file}.lock`));
  }
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).revision, 0);
});

test('same-process reopened stores cannot silently replace newer committed work', t => {
  const f = fixture(t); const first = f.open(); const second = f.open();
  first.mutate(state => { state.inbox.push({ id: 'first-commit' }); });
  let called = false;
  assert.throws(() => second.mutate(state => { called = true; state.mode = 'live'; }), error => error.code === 'STORE_CONFLICT');
  assert.equal(called, false);
  const fresh = f.open();
  fresh.mutate(state => { state.mode = 'live'; });
  const persisted = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(persisted.inbox, [{ id: 'first-commit' }]);
  assert.equal(persisted.mode, 'live');
});

test('a nested transaction through another handle cannot escape a rollback', t => {
  const f = fixture(t); const first = f.open(); const second = f.open();
  assert.throws(() => first.mutate(state => {
    state.mode = 'live';
    second.mutate(other => { other.inbox.push({ id: 'nested-commit' }); });
  }), error => error.code === 'STORE_TRANSACTION_ACTIVE');
  assert.equal(first.state.mode, 'simulation');
  assert.equal(second.state.revision, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).inbox, []);
});

test('unserializable transaction data rolls back without advancing the writer generation', t => {
  const f = fixture(t); const store = f.open(); const sameGeneration = f.open();
  assert.throws(() => store.mutate(state => { state.invalid = 1n; }), /BigInt/);
  assert.equal('invalid' in store.state, false);
  sameGeneration.mutate(state => { state.mode = 'live'; });
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).mode, 'live');
});

test('an atomic replace failure leaves the committed file and memory intact and cleans its temporary file', t => {
  const f = fixture(t); const store = f.open();
  const bytes = fs.readFileSync(f.file, 'utf8');
  const before = structuredClone(store.state);
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (args[1] === store.filename) throw Object.assign(new Error('simulated replace failure'), { code: 'EACCES' });
    return rename(...args);
  };
  try { assert.throws(() => store.mutate(state => { state.inbox.push({ id: 'not-committed' }); }), /replace failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  assert.deepEqual(store.state, before);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['state.json', 'state.json.lock']);
  store.mutate(state => { state.mode = 'live'; });
  assert.deepEqual(store.state.inbox, []);
});

test('mutateIfChanged rolls back failed callbacks and leaves unchanged transactions byte-identical', t => {
  const f = fixture(t); const store = f.open();
  const bytes = fs.readFileSync(f.file, 'utf8');
  const result = store.mutateIfChanged(() => 'unchanged');
  assert.deepEqual(result, { changed: false, result: 'unchanged' });
  assert.throws(() => store.mutateIfChanged(state => { state.mode = 'live'; throw new Error('no commit'); }), /no commit/);
  assert.equal(store.state.mode, 'simulation');
  assert.equal(store.state.revision, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
});
