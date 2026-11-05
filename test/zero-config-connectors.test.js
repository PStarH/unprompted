import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppleCalendarConnector } from '../src/connectors/apple-calendar.js';
import { AppleMailConnector } from '../src/connectors/apple-mail.js';
import { AppleContactsConnector } from '../src/connectors/apple-contacts.js';
import { NativeAccessError, NativeSourceBridge, nativeAccessMessage } from '../src/native-sources.js';
import { connectedSources } from '../src/connected-sources.js';
import { LocalSetupStore } from '../src/setup.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { MCP_PRESETS, buildPresetServerConfig } from '../src/mcp-presets.js';
import { McpConfigStore, McpManager } from '../src/mcp.js';
import { visibleConnectionIds } from '../public/source-offers.js';

const scopeId = 'selected-scope';
const calendarFolder = { accountId: 'calendar', folderId: 'cal-1', accountLabel: 'Calendar', label: 'Work' };
const mailFolder = { accountId: 'icloud', folderId: 'inbox', accountLabel: 'iCloud', label: 'Inbox', accountEmail: 'me@example.com' };
const contactFolder = { accountId: 'contacts', folderId: 'group-1', accountLabel: 'Contacts', label: 'Team' };
const now = () => Date.parse('2026-11-05T12:00:00.000Z');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-zero-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function loadScript(apps, input = {}, chooseFromList = labels => [labels[0]]) {
  const application = name => {
    if (!Object.hasOwn(apps, name)) { const error = new Error('Not authorized to send Apple events'); error.errorNumber = -1743; throw error; }
    return apps[name];
  };
  application.currentApplication = () => ({ chooseFromList });
  const sandbox = vm.createContext({ ObjC: { import() {} }, Application: application });
  vm.runInContext(fs.readFileSync(new URL('../src/native-source-script.jxa.js', import.meta.url), 'utf8'), sandbox);
  sandbox.inputJSON = () => input;
  return sandbox;
}
function bridgeResponding(payload, platform = 'darwin') {
  return new NativeSourceBridge({ platform, spawnImpl: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('finish', () => { child.stdout.write(JSON.stringify(payload)); child.emit('close', payload.ok === false ? 1 : 0); });
    return child;
  } });
}

test('Calendar, Mail, and Contacts scripts stay inside the selection and report Automation denial', () => {
  const event = { uid: () => 'evt-1', id: () => 'evt-1', summary: () => 'Budget review', description: () => 'Bring the draft', location: () => 'Room 2', startDate: () => new Date('2026-11-06T15:00:00.000Z'), endDate: () => new Date('2026-11-06T16:00:00.000Z'), modificationDate: () => new Date('2026-11-01T00:00:00.000Z'), alldayEvent: () => false, status: () => 'confirmed' };
  const calendar = { id: () => 'cal-1', name: () => 'Work', events: { whose: () => () => [event] } };
  const calendarScript = loadScript({ Calendar: { calendars: () => [calendar] } });
  const chosen = JSON.parse(calendarScript.run(['choose-calendar']));
  assert.equal(chosen.ok, true); assert.equal(chosen.folders[0].folderId, 'cal-1'); assert.equal(chosen.folders[0].target, undefined);
  calendarScript.inputJSON = () => ({ folders: chosen.folders, window: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' } });
  const read = JSON.parse(calendarScript.run(['read-calendar']));
  assert.equal(read.records[0].title, 'Budget review'); assert.equal(read.records[0].status, 'confirmed'); assert.equal(read.records[0].folderId, 'cal-1');

  const message = { id: () => 'm-1', messageId: () => '<m-1@example.com>', sender: () => 'Ada <ada@example.com>', subject: () => 'Notes', content: () => 'See you then', dateReceived: () => new Date('2026-11-04T00:00:00.000Z'), dateSent: () => new Date('2026-11-04T00:00:00.000Z'), toRecipients: () => [{ address: () => 'me@example.com' }], ccRecipients: () => [] };
  const mailbox = { id: () => 'inbox', name: () => 'Inbox', mailboxes: () => [], messages: { whose: () => () => [message] } };
  const mailScript = loadScript({ Mail: { accounts: () => [{ id: () => 'icloud', name: () => 'iCloud', emailAddresses: () => ['me@example.com'], mailboxes: () => [mailbox] }] } });
  const mailboxes = JSON.parse(mailScript.run(['choose-mail'])).folders;
  assert.equal(mailboxes[0].accountEmail, 'me@example.com');
  mailScript.inputJSON = () => ({ folders: mailboxes, window: { since: '2026-11-01T00:00:00.000Z' } });
  const mail = JSON.parse(mailScript.run(['read-mail']));
  assert.equal(mail.records[0].from, 'Ada <ada@example.com>'); assert.deepEqual(mail.records[0].to, ['me@example.com']); assert.equal(mail.records[0].folderId, 'inbox');

  const person = { id: () => 'person-1', name: () => 'Ada Lovelace', organization: () => 'Analytical', emails: () => [{ value: () => 'ada@example.com' }], phones: () => [{ value: () => '+1-555' }], note: () => 'Project lead', modificationDate: () => new Date('2026-11-01T00:00:00.000Z') };
  const group = { id: () => 'group-1', name: () => 'Team', people: () => [person] };
  const contactsScript = loadScript({ Contacts: { groups: () => [group], people: () => [person] } }, {}, labels => labels);
  const groups = JSON.parse(contactsScript.run(['choose-contacts'])).folders;
  assert.ok(groups.some(item => item.folderId === 'group-1')); assert.ok(groups.some(item => item.folderId === 'all'));
  contactsScript.inputJSON = () => ({ folders: [{ accountId: 'contacts', folderId: 'group-1' }], query: 'ada@example.com' });
  const found = JSON.parse(contactsScript.run(['lookup-contacts']));
  assert.equal(found.records.length, 1); assert.equal(found.records[0].name, 'Ada Lovelace'); assert.deepEqual(found.records[0].emails, ['ada@example.com']);
  contactsScript.inputJSON = () => ({ folders: [{ accountId: 'contacts', folderId: 'group-1' }], query: 'missing-person' });
  assert.equal(JSON.parse(contactsScript.run(['lookup-contacts'])).records.length, 0);

  const denied = loadScript({});
  assert.equal(JSON.parse(denied.run(['read-calendar'])).code, 'AUTOMATION_DENIED');
  assert.equal(JSON.parse(denied.run(['read-mail'])).code, 'AUTOMATION_DENIED');
  assert.equal(JSON.parse(denied.run(['read-contacts'])).code, 'AUTOMATION_DENIED');
  const cancelled = loadScript({ Calendar: { calendars: () => [calendar] } }, {}, () => false);
  assert.equal(JSON.parse(cancelled.run(['choose-calendar'])).code, 'CANCELLED');
});

test('native bridge names the Apple app when Automation is denied and does not run off macOS', async () => {
  const denied = await bridgeResponding({ ok: false, code: 'AUTOMATION_DENIED' }).readCalendar([calendarFolder], { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' }).catch(error => error);
  assert.equal(denied.code, 'AUTOMATION_DENIED');
  assert.match(denied.message, /Calendar/); assert.match(denied.message, /Privacy & Security → Automation/);
  assert.match(nativeAccessMessage('AUTOMATION_DENIED', 'read-mail'), /Mail/);
  assert.match(nativeAccessMessage('AUTOMATION_DENIED', 'lookup-contacts'), /Contacts/);
  let spawned = false;
  await assert.rejects(new NativeSourceBridge({ platform: 'linux', spawnImpl: () => { spawned = true; } }).chooseMail(), { code: 'UNSUPPORTED' });
  assert.equal(spawned, false);
});

test('Calendar observes selected upcoming events and changes without creating work or writes', async t => {
  const event = { id: 'evt-1', title: 'Budget review', description: 'Bring the draft', location: 'Room 2', start: '2026-11-06T15:00:00.000Z', end: '2026-11-06T16:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', allDay: false, status: 'confirmed', accountId: 'calendar', folderId: 'cal-1' };
  let records = [event], complete = true, failed = null;
  const bridge = { platform: 'darwin', readCalendar: async folders => { assert.deepEqual(folders, [calendarFolder]); if (failed) throw failed; return { records, errors: [], complete }; } };
  const connector = new AppleCalendarConnector({ scopeId, folders: [calendarFolder], bridge, now });
  assert.deepEqual(connector.capabilities().write, []); assert.equal(connector.capabilities().read[0], 'calendar.selected');
  const first = await connector.pull();
  const state = new JsonStore(path.join(directory(t), 'state.json')); t.after(() => state.close());
  const engine = new WorkEngine(state); first.events.forEach(item => engine.ingest(item));
  assert.equal(first.events[0].type, 'document.modified'); assert.equal(first.events[0].payload.kind, 'calendar_event');
  assert.equal(Object.keys(state.state.tasks).length, 0); assert.equal(state.state.outbox.length, 0);
  assert.equal((await connector.pull({ cursor: first.cursor })).events.length, 0);
  records = [{ ...event, title: 'Budget review moved', updatedAt: '2026-11-02T00:00:00.000Z' }];
  const changed = await connector.pull({ cursor: first.cursor });
  assert.equal(changed.events[0].payload.title, 'Budget review moved');
  records = []; complete = true;
  const removed = await connector.pull({ cursor: changed.cursor });
  assert.equal(removed.events[0].payload.reason, 'removed_or_cancelled');
  records = [{ ...event, folderId: 'other' }];
  await assert.rejects(connector.pull(), /outside the selected/);
  failed = new NativeAccessError('AUTOMATION_DENIED', nativeAccessMessage('AUTOMATION_DENIED', 'read-calendar'));
  const denied = await connector.pull({ cursor: changed.cursor });
  assert.equal(denied.partial, true); assert.match(denied.errors[0].message, /Calendar/);
  assert.ok(denied.events.some(item => item.payload.reason === 'permission_or_access_lost'));
});

test('Mail reads a bounded selected window and does not treat aged mail as deleted', async t => {
  const fresh = { id: '<m-1@example.com>', from: 'Ada <ada@example.com>', to: ['me@example.com'], cc: [], subject: 'Notes', body: 'See you then', receivedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', accountId: 'icloud', folderId: 'inbox' };
  const old = { ...fresh, id: '<old@example.com>', receivedAt: '2026-10-01T00:00:00.000Z', subject: 'Old' };
  let records = [fresh, old];
  const bridge = { platform: 'darwin', readMail: async () => ({ records, errors: [], complete: true }) };
  const connector = new AppleMailConnector({ scopeId, folders: [mailFolder], bridge, now });
  assert.deepEqual(connector.capabilities().write, []);
  const first = await connector.pull();
  assert.equal(first.events.length, 1); assert.equal(first.events[0].source, 'apple_mail');
  assert.equal(first.events[0].meta.principalRole, 'DIRECT_ACTOR');
  const state = new JsonStore(path.join(directory(t), 'state.json')); t.after(() => state.close());
  const engine = new WorkEngine(state); first.events.forEach(item => engine.ingest(item));
  assert.equal(state.state.inbox.length, 1); assert.equal(state.state.outbox.length, 0);
  records = [];
  const aged = await connector.pull({ cursor: first.cursor });
  assert.equal(aged.events.length, 1); assert.equal(aged.events[0].payload.reason, 'removed');
  const keptOld = { messages: { 'apple_mail:selected-scope:old': { providerId: '<old@example.com>', folderId: 'inbox', accountId: 'icloud', version: 'v1', receivedAt: '2026-10-01T00:00:00.000Z', subject: 'Old', connectorId: 'apple_mail' } } };
  const quiet = await connector.pull({ cursor: keptOld });
  assert.equal(quiet.events.length, 0); assert.equal(quiet.cursor.messages['apple_mail:selected-scope:old'], undefined);
  records = [{ ...fresh, folderId: 'archive', accountId: 'icloud' }];
  await assert.rejects(connector.pull(), /outside the selected/);
  bridge.readMail = async () => { throw new NativeAccessError('AUTOMATION_DENIED', nativeAccessMessage('AUTOMATION_DENIED', 'read-mail')); };
  const denied = await connector.pull({ cursor: first.cursor });
  assert.match(denied.errors[0].message, /Mail/); assert.equal(denied.events[0].payload.reason, 'permission_or_access_lost');
});

test('Contacts lookup stays inside selected groups and does not modify the address book', async t => {
  const person = { id: 'person-1', name: 'Ada Lovelace', organization: 'Analytical', emails: ['ada@example.com'], phones: ['+1-555'], note: 'Project lead', updatedAt: '2026-11-01T00:00:00.000Z', accountId: 'contacts', folderId: 'group-1' };
  const bridge = { platform: 'darwin', readContacts: async () => ({ records: [person], errors: [], complete: true }), lookupContacts: async (_folders, query) => ({ records: query.toLowerCase().includes('ada') ? [person] : [], errors: [], complete: true }) };
  const connector = new AppleContactsConnector({ scopeId, folders: [contactFolder], bridge, now });
  assert.deepEqual(connector.capabilities().write, []); assert.deepEqual(connector.capabilities().search, ['contacts.lookup']);
  const first = await connector.pull();
  const state = new JsonStore(path.join(directory(t), 'state.json')); t.after(() => state.close());
  const engine = new WorkEngine(state); first.events.forEach(item => engine.ingest(item));
  assert.equal(first.events[0].payload.kind, 'contact'); assert.match(first.events[0].payload.content, /ada@example.com/);
  assert.equal(Object.keys(state.state.tasks).length, 0);
  const found = await connector.lookup('Ada');
  assert.equal(found.items[0].emails[0], 'ada@example.com'); assert.equal((await connector.search({ query: 'nobody' })).items.length, 0);
  bridge.readContacts = async () => ({ records: [{ ...person, folderId: 'other' }], errors: [], complete: true });
  await assert.rejects(connector.pull(), /outside the selected/);
  bridge.lookupContacts = async () => { throw new NativeAccessError('AUTOMATION_DENIED', nativeAccessMessage('AUTOMATION_DENIED', 'lookup-contacts')); };
  await assert.rejects(connector.lookup('Ada'), /Contacts/);
});

test('macOS connections include the read-only Apple sources and other systems hide them', t => {
  const filePath = path.join(directory(t), 'setup.json');
  const setup = new LocalSetupStore({ filePath });
  setup.saveNativeSource('apple_calendar', { scopeId, folders: [calendarFolder] });
  setup.saveNativeSource('apple_mail', { scopeId, folders: [mailFolder] });
  setup.saveNativeSource('apple_contacts', { scopeId, folders: [contactFolder] });
  const restored = new LocalSetupStore({ filePath });
  assert.equal(restored.getNativeSource('apple_mail').folders[0].accountEmail, 'me@example.com');
  const darwin = connectedSources(restored, { nativeBridge: { platform: 'darwin' } });
  for (const id of ['apple_calendar', 'apple_mail', 'apple_contacts']) assert.equal(darwin.find(connector => connector.id === id)?.live, true);
  assert.equal(connectedSources(restored, { nativeBridge: { platform: 'linux' } }).some(connector => connector.id.startsWith('apple_')), false);
  const visible = visibleConnectionIds({ apple_calendar: { available: true }, apple_mail: { available: true }, apple_contacts: { available: true } });
  for (const id of ['apple_calendar', 'apple_mail', 'apple_contacts']) assert.ok(visible.includes(id));
  assert.equal(visibleConnectionIds({}).includes('apple_calendar'), false);
  const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(page, /Apple Calendar/); assert.match(page, /Apple Mail/); assert.match(page, /Apple Contacts/);
  assert.match(page, /修改关闭/); assert.match(page, /Modify off/); assert.match(page, /读取 开/); assert.match(page, /Read on/);
});

test('zero-config MCP presets need no keys and explain a missing uvx or npx', async t => {
  const source = fs.readFileSync(new URL('../src/mcp-presets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/Users\/sampan|\.nvm|Documents\/GitHub/);
  const fetchPreset = MCP_PRESETS.find(preset => preset.id === 'fetch');
  assert.equal(fetchPreset.config.command, process.execPath); assert.equal(fetchPreset.requiresAuth, false);
  for (const id of ['git', 'filesystem', 'time', 'deepwiki']) {
    const preset = MCP_PRESETS.find(item => item.id === id);
    assert.equal(preset.auth, 'none'); assert.equal(preset.requiresAuth, false); assert.equal(preset.fields.some(field => field.type === 'password'), false);
  }
  assert.deepEqual(buildPresetServerConfig('git', { repositories: '/tmp/repo\n/tmp/other' }).args, ['mcp-server-git', '--repository', '/tmp/repo', '--repository', '/tmp/other']);
  assert.deepEqual(buildPresetServerConfig('filesystem', { directories: '/tmp/notes' }).args.slice(0, 3), ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/notes']);
  assert.throws(() => buildPresetServerConfig('git', { repositories: 'repo' }), /absolute/);
  assert.throws(() => buildPresetServerConfig('filesystem', { directories: path.parse('/tmp').root }), /root/);
  assert.equal(buildPresetServerConfig('deepwiki').url, 'https://mcp.deepwiki.com/mcp');
  assert.equal(MCP_PRESETS.find(preset => preset.id === 'time').config.args[0], 'mcp-server-time');
  const manager = new McpManager({ configStore: new McpConfigStore(directory(t)), executableLookup: command => command === 'npx' ? '/usr/bin/npx' : null });
  t.after(() => manager.close());
  const presets = manager.describe().presets;
  assert.equal(presets.find(preset => preset.id === 'git').runtime.available, false);
  assert.match(presets.find(preset => preset.id === 'git').runtime.hintZh, /uvx/);
  assert.equal(presets.find(preset => preset.id === 'filesystem').runtime.available, true);
  assert.equal(presets.find(preset => preset.id === 'deepwiki').connection.url, 'https://mcp.deepwiki.com/mcp');
  const migrated = new McpManager({ configStore: { get: () => ({ fetch: { type: 'stdio', command: '/Users/sampan/.nvm/versions/node/v22.14.0/bin/node', args: ['/Users/sampan/Documents/GitHub/unprompted/src/mcp-fetch-server.js'], enabled: false, allowDeclaredRead: true } }) }, executableLookup: () => null });
  assert.equal(migrated.configs.fetch.command, process.execPath);
  assert.ok(migrated.configs.fetch.args[0].endsWith(`${path.sep}mcp-fetch-server.js`));
  assert.ok(!migrated.configs.fetch.args[0].includes('sampan'));
  await manager.import({ mcpServers: { git: { ...buildPresetServerConfig('git', { repositories: '/tmp/repo' }), enabled: true } } }, { allowDeclaredRead: true });
  const server = manager.describe().servers.find(item => item.id === 'git');
  assert.equal(server.status, 'failed'); assert.match(server.lastError, /uvx was not found/);
  await assert.rejects(manager.import({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'relative'] } } }), /absolute/);
});
