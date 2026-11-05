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
import { mailScopeRemoval } from '../src/connectors/apple-mail.js';
import { NativeAccessError, NativeSourceBridge, nativeAccessMessage } from '../src/native-sources.js';
import { connectedSources } from '../src/connected-sources.js';
import { LocalSetupStore } from '../src/setup.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { GIT_READ_TOOLS, MCP_PRESETS, buildPresetServerConfig, expandImportedServers, scopePaths, validatePresetConfig } from '../src/mcp-presets.js';
import { McpConfigStore, McpManager } from '../src/mcp.js';
import { taskSourceTools } from '../src/task-tools.js';
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
  const wordingOnly = vm.createContext({ ObjC: { import() {} }, Application: () => { throw new Error('Not authorized to send Apple events'); } });
  wordingOnly.Application.currentApplication = () => ({});
  vm.runInContext(fs.readFileSync(new URL('../src/native-source-script.jxa.js', import.meta.url), 'utf8'), wordingOnly);
  wordingOnly.inputJSON = () => ({});
  assert.equal(JSON.parse(wordingOnly.run(['read-calendar'])).code, 'NATIVE_ACCESS_FAILED');
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
  const repoA = fs.mkdtempSync(path.join(directory(t), 'repo-a-'));
  const repoB = fs.mkdtempSync(path.join(directory(t), 'repo-b-'));
  const notes = fs.mkdtempSync(path.join(directory(t), 'notes-'));
  assert.deepEqual(buildPresetServerConfig('git', { repositories: repoA }).args, ['mcp-server-git', '--repository', fs.realpathSync(repoA)]);
  assert.deepEqual(buildPresetServerConfig('git', { repositories: repoA }).readTools, [...GIT_READ_TOOLS]);
  assert.throws(() => buildPresetServerConfig('git', { repositories: `${repoA}\n${repoB}` }), /own server/);
  const expanded = expandImportedServers({ git: { type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', repoA, '--repository', repoB], enabled: true } });
  assert.deepEqual(expanded.git.args, ['mcp-server-git', '--repository', fs.realpathSync(repoA)]);
  assert.deepEqual(expanded['git-2'].args, ['mcp-server-git', '--repository', fs.realpathSync(repoB)]);
  const occupied = expandImportedServers({
    git: { type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', repoA, '--repository', repoB], enabled: true },
    'git-2': { type: 'http', url: 'https://example.com/mcp', enabled: true }
  });
  assert.equal(occupied['git-2'].type, 'http');
  assert.deepEqual(occupied['git-3'].args, ['mcp-server-git', '--repository', fs.realpathSync(repoB)]);
  assert.deepEqual(expanded.git.readTools, [...GIT_READ_TOOLS]);
  assert.ok(!expanded.git.args.includes(repoB) && expanded.git.args.filter(arg => arg === '--repository').length === 1);
  assert.deepEqual(buildPresetServerConfig('filesystem', { directories: `${notes}\n${repoA}` }).args.slice(2), [fs.realpathSync(notes), fs.realpathSync(repoA)]);
  assert.throws(() => scopePaths(`${notes},${repoA}`), /directory/);
  assert.throws(() => buildPresetServerConfig('git', { repositories: 'repo' }), /absolute/);
  assert.throws(() => scopePaths(os.homedir()), /home directory/);
  assert.throws(() => buildPresetServerConfig('filesystem', { directories: path.parse(notes).root }), /root/);
  const filePath = path.join(notes, 'note.txt'); fs.writeFileSync(filePath, 'text');
  assert.throws(() => scopePaths(filePath), /directory/);
  assert.doesNotThrow(() => validatePresetConfig('my-git', { type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', 'relative'] }));
  assert.equal(buildPresetServerConfig('deepwiki').url, 'https://mcp.deepwiki.com/mcp');
  assert.equal(MCP_PRESETS.find(preset => preset.id === 'time').config.args[0], 'mcp-server-time');
  assert.match(MCP_PRESETS.find(preset => preset.id === 'time').config.args.join(' '), /--local-timezone/);
  const manager = new McpManager({ configStore: new McpConfigStore(directory(t)), executableLookup: command => command === 'npx' ? '/usr/bin/npx' : null });
  t.after(() => manager.close());
  const presets = manager.describe().presets;
  assert.equal(presets.find(preset => preset.id === 'git').runtime.available, false);
  assert.match(presets.find(preset => preset.id === 'git').runtime.hintZh, /uvx/);
  assert.equal(presets.find(preset => preset.id === 'filesystem').runtime.available, true);
  assert.equal(presets.find(preset => preset.id === 'deepwiki').connection.url, 'https://mcp.deepwiki.com/mcp');
  const gitServer = { type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', repoA], enabled: true, readTools: [...GIT_READ_TOOLS], writeTools: [] };
  assert.equal(manager.isWrite('git', gitServer, { name: 'git_status' }), false);
  assert.equal(manager.isWrite('git-2', gitServer, { name: 'git_diff_unstaged' }), false);
  assert.equal(manager.isWrite('git', gitServer, { name: 'git_diff_apply' }), true);
  assert.equal(manager.isWrite('git', gitServer, { name: 'git_commit' }), true);
  assert.equal(manager.isWrite('notes', { ...gitServer, command: 'node', args: ['evil.js'] }, { name: 'git_status' }), true);
  assert.equal(manager.allowed('notes', { enabled: true, readTools: ['git_status'], allowDeclaredRead: true, type: 'stdio', command: 'uvx', args: ['mcp-server-git'] }, { name: 'git_diff_apply' }), false);
  const migrated = new McpManager({ configStore: { get: () => ({ fetch: { type: 'stdio', command: '/Users/sampan/.nvm/versions/node/v22.14.0/bin/node', args: ['/Users/sampan/Documents/GitHub/unprompted/src/mcp-fetch-server.js'], enabled: false, allowDeclaredRead: true } }) }, executableLookup: () => null });
  assert.equal(migrated.configs.fetch.command, process.execPath);
  assert.ok(fs.existsSync(migrated.configs.fetch.args[0]));
  assert.ok(migrated.configs.fetch.args[0].endsWith(`${path.sep}mcp-fetch-server.js`));
  assert.ok(!migrated.configs.fetch.command.includes('sampan'));
  assert.ok(!migrated.configs.fetch.args[0].includes('/Users/sampan'));
  await manager.import({ mcpServers: { git: { type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', repoA, '--repository', repoB], enabled: true } } }, { allowDeclaredRead: true });
  assert.equal(manager.configs.git.args.filter(arg => arg === '--repository').length, 1);
  assert.equal(manager.configs['git-2'].args.at(-1), fs.realpathSync(repoB));
  assert.equal(manager.allowed('git', manager.configs.git, { name: 'git_log' }), true);
  assert.equal(manager.allowed('git', manager.configs.git, { name: 'git_commit' }), false);
  assert.equal(manager.allowed('git', manager.configs.git, { name: 'git_reset' }), false);
  assert.equal(manager.allowed('git', manager.configs.git, { name: 'git_diff_apply' }), false);
  const servers = manager.describe().servers;
  assert.equal(servers.find(item => item.id === 'git').status, 'failed');
  assert.match(servers.find(item => item.id === 'git').lastError, /uvx was not found/);
  assert.equal(servers.find(item => item.id === 'git-2').status, 'failed');
  await assert.rejects(manager.import({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'relative'] } } }), /absolute/);
  const page = fs.readFileSync(new URL('../public/mcp.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /DEFAULT_PRESETS|mcp-server-git/);
  const linkParent = directory(t);
  const target = fs.mkdtempSync(path.join(linkParent, 'target-'));
  const link = path.join(linkParent, 'link');
  fs.symlinkSync(target, link);
  const writes = [];
  const missing = path.join(linkParent, 'missing-repo');
  const remembering = new McpManager({ configStore: {
    get: () => ({
      git: { type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', missing], enabled: true },
      filesystem: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', link], enabled: true }
    }),
    write: value => writes.push(JSON.parse(JSON.stringify(value)))
  }, executableLookup: () => null });
  t.after(() => remembering.close());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].git.enabled, true);
  assert.equal(writes[0].git.args.at(-1), missing);
  assert.equal(writes[0].filesystem.enabled, true);
  assert.equal(writes[0].filesystem.args.at(-1), fs.realpathSync(target));
  assert.equal(remembering.configs.git.enabled, false);
  assert.match(remembering.describe().servers.find(item => item.id === 'git').lastError, /directory/);
  assert.equal(remembering.configs.filesystem.enabled, true);
  assert.equal(remembering.configs.filesystem.args.at(-1), fs.realpathSync(target));
});

test('a native read timeout keeps the previous cursor and does not retract evidence', async () => {
  const previous = { documents: { 'apple_calendar:selected-scope:evt': { title: 'Budget review', unavailable: null } } };
  for (const [Connector, method, cursor, code] of [
    [AppleCalendarConnector, 'readCalendar', previous, 'TIMEOUT'],
    [AppleMailConnector, 'readMail', { messages: { 'apple_mail:selected-scope:m': { providerId: '<m>', version: 'v', receivedAt: '2026-11-04T00:00:00.000Z', folderId: 'inbox' } } }, 'TOO_LARGE'],
    [AppleContactsConnector, 'readContacts', { documents: { 'apple_contacts:selected-scope:p': { title: 'Ada', unavailable: null } } }, 'NATIVE_ACCESS_FAILED']
  ]) {
    const folders = Connector === AppleMailConnector ? [mailFolder] : Connector === AppleContactsConnector ? [contactFolder] : [calendarFolder];
    const bridge = { platform: 'darwin', [method]: async () => { throw new NativeAccessError(code); } };
    const result = await new Connector({ scopeId, folders, bridge, now }).pull({ cursor });
    assert.equal(result.cursor, cursor);
    assert.equal(result.partial, true);
    assert.equal(result.events.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /permission_or_access_lost/);
  }
});

test('Mail ranks each message from one date read and scope removal uses the saved grant', () => {
  let reads = 0;
  const messages = [0, 1, 2].map(index => ({
    id: () => `id-${index}`, messageId: () => `<${index}@example.com>`, sender: () => 'Ada <ada@example.com>', subject: () => `S${index}`, content: () => 'Body',
    dateReceived: () => { reads += 1; return new Date(Date.UTC(2026, 10, index + 1)); }, dateSent: () => new Date(Date.UTC(2026, 10, index + 1)),
    toRecipients: () => [], ccRecipients: () => []
  }));
  const mailbox = { id: () => 'inbox', name: () => 'Inbox', mailboxes: () => [], messages: { whose: () => () => messages } };
  const script = loadScript({ Mail: { accounts: () => [{ id: () => 'icloud', name: () => 'iCloud', emailAddresses: () => ['me@example.com'], mailboxes: () => [mailbox] }] } }, { folders: [{ accountId: 'icloud', folderId: 'inbox' }], window: { since: '2026-10-01T00:00:00.000Z' } });
  const read = JSON.parse(script.run(['read-mail']));
  assert.equal(reads, 3);
  assert.deepEqual(read.records.map(item => item.subject), ['S2', 'S1', 'S0']);
  const cursor = { messages: { kept: { providerId: 'kept', folderId: 'inbox', version: 'v' }, dropped: { providerId: 'dropped', folderId: 'archive', version: 'v' } } };
  const kept = mailScopeRemoval({ scopeId, folders: [{ folderId: 'inbox' }] }, cursor);
  assert.equal(kept.events.length, 1); assert.equal(kept.events[0].payload.id, 'dropped');
  assert.equal(kept.cursor.messages.kept.providerId, 'kept');
  const cleared = mailScopeRemoval({ scopeId: null, folders: [{ folderId: 'inbox' }] }, cursor);
  assert.equal(cleared.events.length, 2);
});

test('lookup_contact calls the selected Contacts groups and is absent until Contacts is connected', async () => {
  const connector = { live: true, lookup: async query => ({ query, items: [{ name: 'Ada Lovelace', emails: ['ada@example.com'] }], complete: true }) };
  const runtime = { connectorFor: id => id === 'apple_contacts' ? connector : null, privacy: { permissionRevoked: () => false }, tasks: { get: () => ({ id: 'task-1' }), hasPendingSemantic: () => false }, canRun: () => true, closed: false, suspended: false, activationFor: () => ({ activate: true }) };
  const tool = taskSourceTools(runtime, { taskId: 'task-1', isCurrent: () => true }).find(item => item.name === 'lookup_contact');
  assert.match((await tool.execute('lookup', { query: 'Ada' })).content[0].text, /ada@example.com/);
  assert.equal(taskSourceTools({ ...runtime, connectorFor: () => null }, { taskId: 'task-1', isCurrent: () => true }).some(item => item.name === 'lookup_contact'), false);
});
