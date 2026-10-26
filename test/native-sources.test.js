import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LocalFilesConnector, canonicalLocalRoot, mergeLocalRoots, readScopedText } from '../src/connectors/local-files.js';
import { AppleNotesConnector } from '../src/connectors/apple-notes.js';
import { explicitTasks, nativeSnapshot } from '../src/connectors/local-snapshot.js';
import { NativeSourceBridge, NativeAccessError } from '../src/native-sources.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { bindConnectionAccount } from '../src/external-work.js';
import { LocalSetupStore } from '../src/setup.js';
import { CursorStore } from '../src/connectors/connector.js';
import { buildScenario } from '../src/connectors/simulated.js';

function directory(t) { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-native-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const scopeId = 'selected-scope';
const document = (content, extra = {}) => ({ id: `local_files:${scopeId}:document`, title: '工作.md', content, rootId: 'root-one', modifiedAt: '2026-10-26T10:00:00.000Z', ...extra });
const snapshot = options => nativeSnapshot({ connectorId: 'local_files', scopeId, ...options });

test('local sources follow explicit text only, ignore fenced examples, and retain stable duplicate identities', () => {
  const tasks = explicitTasks('ordinary prose\n- [ ] 发报价\n- [x] 对合同\n```md\n- [ ] example\n```\nTODO: Call Sam\n☐ Check report\n- [ ] 发报价');
  assert.deepEqual(tasks.map(item => [item.title, item.state, item.line]), [['发报价', 'open', 2], ['对合同', 'closed', 3], ['Call Sam', 'open', 7], ['Check report', 'open', 8], ['发报价', 'open', 9]]);
  assert.notEqual(tasks[0].key, tasks[4].key);
  assert.equal(explicitTasks('- [x] 发报价')[0].key, tasks[0].key);
});

test('selected folders read real text incrementally and reject hidden, symlink, binary and escaped reads', async t => {
  const dir = directory(t), selected = path.join(dir, 'selected'), outside = path.join(dir, 'outside.txt'); fs.mkdirSync(selected);
  fs.writeFileSync(outside, 'PRIVATE_OUTSIDE'); fs.writeFileSync(path.join(selected, 'work.md'), '- [ ] Follow the quote\nPlain context');
  fs.writeFileSync(path.join(selected, '.hidden.txt'), 'PRIVATE_HIDDEN'); fs.writeFileSync(path.join(selected, 'binary.txt'), Buffer.from([0, 255]));
  fs.writeFileSync(path.join(selected, 'large.txt'), Buffer.alloc(512 * 1024 + 1)); fs.symlinkSync(outside, path.join(selected, 'link.txt'));
  assert.equal(canonicalLocalRoot(selected), selected); assert.throws(() => canonicalLocalRoot(path.parse(dir).root));
  for (const relative of ['../outside.txt', '.hidden.txt', 'link.txt', 'binary.txt', 'large.txt']) assert.throws(() => readScopedText(selected, relative));
  const connector = new LocalFilesConnector({ scopeId, roots: [{ id: 'root-one', path: selected }] });
  const first = await connector.pull(); assert.equal(first.events.filter(event => event.type === 'document.modified').length, 1);
  assert.equal(first.events.filter(event => event.type === 'task.observed').length, 1); assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  const second = await connector.pull({ cursor: first.cursor }); assert.equal(second.events.length, 0);
  fs.unlinkSync(path.join(selected, 'work.md'));
  const third = await connector.pull({ cursor: second.cursor });
  assert.ok(third.events.some(event => event.type === 'document.unavailable'));
  assert.ok(third.events.some(event => event.type === 'task.observed' && event.payload.state === 'unavailable'));
});

test('overlapping folder selections cover each file once and preserve an existing parent grant', t => {
  const dir = directory(t), child = path.join(dir, 'child'); fs.mkdirSync(child);
  const narrow = mergeLocalRoots([], [child], () => 'child-id');
  const merged = mergeLocalRoots(narrow, [dir, child], () => 'parent-id');
  assert.equal(merged.length, 1); assert.equal(merged[0].path, dir);
  assert.deepEqual(mergeLocalRoots(merged, [child, dir], () => assert.fail('reuse existing grant')), merged);
});

test('source checkbox closure, restoration and repeated loss never invent completion or revive dismissed work', t => {
  const dir = directory(t), state = new JsonStore(path.join(dir, 'state.json')); t.after(() => state.close());
  bindConnectionAccount(state, 'local_files', scopeId); const engine = new WorkEngine(state); let cursor;
  const ingest = documents => { const result = snapshot({ documents, cursor, now: () => Date.parse('2026-10-26T11:00:00Z') }); cursor = result.cursor; for (const event of result.events) engine.ingest(event); return result; };
  ingest([document('- [ ] Follow quote')]); const id = Object.keys(state.state.tasks)[0];
  assert.equal(state.state.tasks[id].kind, 'observed_task'); assert.equal(state.state.inbox.length, 0);
  ingest([document('- [x] Follow quote')]); assert.equal(state.state.tasks[id].status, 'cancelled'); assert.equal(state.state.tasks[id].action, null);
  // Same provider modification timestamp and content recurring must still restore.
  ingest([document('- [ ] Follow quote')]); assert.equal(state.state.tasks[id].status, 'waiting_for_information');
  ingest([document('- [x] Follow quote', { modifiedAt: '2026-10-25T10:00:00Z' })]); assert.equal(state.state.tasks[id].status, 'cancelled');
  assert.equal(state.state.documents[document('').id].content, '- [x] Follow quote', 'restored older file timestamps must reflect the text currently on disk');
  ingest([document('- [ ] Follow quote')]);
  for (let index = 0; index < 2; index++) {
    ingest([]); assert.equal(state.state.documents[document('').id].available, false); assert.equal(state.state.tasks[id].status, 'cancelled');
    ingest([document('- [ ] Follow quote')]); assert.equal(state.state.documents[document('').id].available, true); assert.equal(state.state.tasks[id].status, 'waiting_for_information');
  }
  engine.cancel(id); ingest([document('- [ ] Follow quote\nupdated context')]); assert.equal(state.state.tasks[id].status, 'cancelled');
  engine.reopen(id); assert.equal(state.state.tasks[id].status, 'waiting_for_information');
  bindConnectionAccount(state, 'local_files', null); assert.throws(() => engine.reopen(id));
  assert.equal(state.state.outbox.length, 0); assert.equal(Object.values(state.state.tasks).filter(task => task.status === 'completed').length, 0);
});

test('incomplete folder scans preserve unseen documents and oversized to-do lists disclose limits', () => {
  const first = snapshot({ documents: [document('- [ ] Work')] });
  assert.equal(snapshot({ cursor: first.cursor, documents: [], complete: false }).events.length, 0);
  const many = snapshot({ documents: [document(Array.from({ length: 101 }, (_, i) => `- [ ] Work ${i}`).join('\n'))] });
  assert.equal(many.events.filter(event => event.type === 'task.observed').length, 100); assert.equal(many.partial, true); assert.match(many.errors[0].message, /100/);
  const unchanged = snapshot({ documents: [{ ...document(''), content: undefined, unchanged: true }], cursor: many.cursor });
  assert.equal(unchanged.events.length, 0); assert.equal(unchanged.partial, true); assert.match(unchanged.errors[0].message, /100/);
});

test('Notes stays inside selected folders and permission loss invalidates old evidence', async () => {
  let result = { records: [{ providerId: 'note-one', accountId: 'account', folderId: 'folder', title: 'Plan', content: 'TODO: Check budget', stamp: 'v1', modifiedAt: '2026-10-26T10:00:00Z' }], errors: [], complete: true };
  const bridge = { readNotes: async folders => { assert.deepEqual(folders, [{ accountId: 'account', folderId: 'folder' }]); if (result instanceof Error) throw result; return result; } };
  const connector = new AppleNotesConnector({ scopeId, folders: [{ accountId: 'account', folderId: 'folder' }], bridge });
  const first = await connector.pull(); assert.equal(first.events.length, 2); assert.equal(first.events[0].source, 'apple_notes');
  result = { records: [{ providerId: 'note-one', accountId: 'account', folderId: 'folder', unavailable: 'locked' }], errors: [], complete: true };
  const locked = await connector.pull({ cursor: first.cursor }); assert.ok(locked.events.some(event => event.payload.reason === 'locked'));
  result = new NativeAccessError('AUTOMATION_DENIED'); const denied = await connector.pull({ cursor: first.cursor });
  assert.equal(denied.partial, true); assert.ok(denied.events.some(event => event.type === 'document.unavailable'));
  result = { records: [{ providerId: 'foreign', accountId: 'account', folderId: 'other' }], errors: [], complete: true };
  await assert.rejects(connector.pull(), /outside the selected/);
});

test('native bridge preserves split Chinese UTF-8 and keeps source identifiers out of process arguments', async () => {
  let command, argumentsUsed, input = '';
  const bridge = new NativeSourceBridge({ platform: 'darwin', spawnImpl: (executable, args) => {
    command = executable; argumentsUsed = args;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => { const output = Buffer.from(JSON.stringify({ ok: true, folders: ['备忘录'] })); for (const byte of output) child.stdout.write(Buffer.from([byte])); child.emit('close', 0); }); return child;
  } });
  const result = await bridge.run('read-notes', { privateId: 'PRIVATE_SOURCE_ID' });
  assert.equal(result.folders[0], '备忘录'); assert.equal(command, '/usr/bin/osascript'); assert.doesNotMatch(argumentsUsed.join(' '), /PRIVATE_SOURCE_ID/); assert.match(input, /PRIVATE_SOURCE_ID/);
  await assert.rejects(new NativeSourceBridge({ platform: 'linux', spawnImpl: () => assert.fail('must not spawn') }).chooseNotes(), { code: 'UNSUPPORTED' });
});

test('cancelling a native picker kills it and never returns a late selection', async () => {
  let child, killed = false; const controller = new AbortController();
  const bridge = new NativeSourceBridge({ platform: 'darwin', spawnImpl: () => { child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => { killed = true; }; return child; } });
  const pending = bridge.chooseFiles({ signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(killed, true);
  child.stdout.write(JSON.stringify({ ok: true, paths: ['/private/late'] })); child.emit('close', 0);
});

test('native grants survive setup reload and never enter generic public settings', t => {
  const dir = directory(t), filePath = path.join(dir, 'setup.json'), setup = new LocalSetupStore({ filePath });
  setup.saveNativeSource('local_files', { scopeId, roots: [{ id: 'root-one', path: path.join(dir, 'PRIVATE_PATH'), label: 'Work' }] });
  assert.equal(new LocalSetupStore({ filePath }).getNativeSource('local_files').roots.length, 1);
  assert.doesNotMatch(JSON.stringify(setup.publicStatus()), /PRIVATE_PATH|selected-scope/);
  setup.clearNativeSource('local_files'); assert.equal(setup.getNativeSource('local_files').roots.length, 0);
});

test('public state and runtime cursor descriptions omit native provider IDs and private metadata', t => {
  const dir = directory(t), store = new JsonStore(path.join(dir, 'state.json')); t.after(() => store.close());
  store.mutate(state => { state.cursors.apple_notes = { documents: { 'apple_notes:public': { providerId: 'PRIVATE_NOTE_ID', accountId: 'PRIVATE_ACCOUNT_ID', folderId: 'PRIVATE_FOLDER_ID', stamp: 'private' } }, counts: { documents: 1 } }; });
  assert.doesNotMatch(JSON.stringify(new WorkEngine(store).publicState()), /PRIVATE_|"stamp"/);
  assert.doesNotMatch(JSON.stringify(new CursorStore(store).describe()), /PRIVATE_|"stamp"/);
  assert.equal(new CursorStore(store).get('apple_notes').documents['apple_notes:public'].providerId, 'PRIVATE_NOTE_ID');
});

test('local documents can supply evidence but never become an externally delivered loopback link', t => {
  for (const source of ['local_files', 'apple_notes']) {
    const dir = directory(t), store = new JsonStore(path.join(dir, 'state.json')); t.after(() => store.close());
    const engine = new WorkEngine(store);
    for (const { event } of buildScenario(Date.now())) engine.ingest(event.type === 'document.modified' ? { ...event, source, connectorId: source,
      payload: { ...event.payload, url: `http://127.0.0.1:4173/api/local-sources/documents/${encodeURIComponent(event.payload.id)}` } } : event);
    const task = Object.values(store.state.tasks)[0];
    assert.equal(task.status, 'waiting_for_information'); assert.equal(task.draft, null);
    assert.ok(task.evidence.completion.blockers.some(item => item.id === 'local_document_not_shared'));
    assert.throws(() => engine.approve(task.id)); assert.equal(store.state.outbox.length, 0);
  }
});
