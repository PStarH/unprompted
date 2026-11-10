import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { bindConnectionAccount } from '../src/external-work.js';
import { NullReasoner } from '../src/reasoning.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore, Connector, ConnectorError } from '../src/connectors/connector.js';
import { GoogleWorkspaceConnector } from '../src/connectors/google.js';
import { OutlookConnector } from '../src/connectors/outlook.js';
import { SlackConnector } from '../src/connectors/slack.js';
import { NotionConnector } from '../src/connectors/notion.js';
import { GitHubConnector } from '../src/connectors/github.js';
import { TodoistConnector } from '../src/connectors/todoist.js';
import { LocalFilesConnector } from '../src/connectors/local-files.js';
import { AppleNotesConnector } from '../src/connectors/apple-notes.js';
import { AppleRemindersConnector } from '../src/connectors/apple-reminders.js';
import { AppleMailConnector } from '../src/connectors/apple-mail.js';
import { AppleCalendarConnector } from '../src/connectors/apple-calendar.js';
import { AppleContactsConnector } from '../src/connectors/apple-contacts.js';
import { SimulatedConnector } from '../src/connectors/simulated.js';
import { NativeAccessError } from '../src/native-sources.js';

/**
 * Scripted sync matrix for every shipped first-party connector.
 * Writes stay in the artifact-action, harness, and send-authority companions.
 * Nothing here uses a live account, provider push, or macOS Automation.
 */

const AT = '2026-11-10T15:00:00.000Z';
const NOW = () => Date.parse(AT);
const TOKEN = { accessToken: async () => 'scripted-token' };
const GOOGLE = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken', maxRetries: 0, retryBaseMs: 0, sleep: async () => {} };
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-matrix-'));
  roots.push(root);
  return root;
}

function workspace() {
  const root = directory();
  const store = new SqliteStore(path.join(root, 'state.json'));
  const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store), reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
  return { root, store, engine, cursors: new CursorStore(store) };
}

function httpResponse(status, body, { raw = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => raw ?? (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
    json: async () => body
  };
}

function routed(handler) {
  return async (url, options = {}) => {
    const outcome = await handler(new URL(url), options);
    if (outcome?.hang) return new Promise(() => {});
    return outcome;
  };
}

class SiblingConnector extends Connector {
  constructor() { super({ id: 'sibling', kind: 'scripted' }); this.live = true; }
  async pull() { return { events: [], cursor: { page: 'sibling-1' }, errors: [], partial: false }; }
}

const mailMessage = {
  id: 'm-1', threadId: 't-1', labelIds: ['INBOX'],
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'alex@example.test' },
      { name: 'To', value: 'maya@example.test' },
      { name: 'Subject', value: 'Cedar brief' },
      { name: 'Date', value: 'Tue, 10 Nov 2026 15:00:00 +0000' }
    ],
    body: { data: Buffer.from('Please update the Cedar brief.', 'utf8').toString('base64url') }
  }
};

function googleFetch(mode, connector, routes) {
  return routed(async target => {
    if (mode === 'disconnect') connector.live = false;
    if (mode === 'timeout') { const error = new Error('timed out'); error.code = 'ETIMEDOUT'; throw error; }
    if (target.hostname === 'oauth2.googleapis.com') return httpResponse(200, { access_token: 'at-1', expires_in: 3600 });
    if (mode === 'partial') return httpResponse(400, { error: 'partial page' });
    if (mode === 'unauthorized') return httpResponse(401, {});
    if (mode === 'limited') return httpResponse(429, {});
    if (mode === 'server') return httpResponse(500, {});
    if (mode === 'malformed') return httpResponse(200, null, { raw: 'not-json' });
    return routes(target);
  });
}

function googleConnector(config, mode) {
  let connector;
  const fetchImpl = googleFetch(mode, { get live() { return connector?.live; }, set live(value) { if (connector) connector.live = value; } }, target => config.routes(target));
  connector = new GoogleWorkspaceConnector({ config: { ...GOOGLE, ...config.flags }, fetchImpl });
  if (mode === 'disconnect') connector.live = false;
  return connector;
}

function accountFetch(mode, happy) {
  return routed(async target => {
    if (mode === 'timeout') { const error = new Error('timed out'); error.code = 'ETIMEDOUT'; throw error; }
    if (mode === 'partial') return httpResponse(400, { error: 'partial page' });
    if (mode === 'unauthorized') return httpResponse(401, { ok: false, error: 'invalid_auth' });
    if (mode === 'limited') return httpResponse(429, { ok: false, error: 'ratelimited' });
    if (mode === 'server') return httpResponse(500, {});
    if (mode === 'malformed') return httpResponse(200, null, { raw: 'not-json' });
    return happy(target);
  });
}

const FOLDERS = [{ accountId: 'acct', folderId: 'folder', label: 'Cedar' }];

function nativeBridge(read, mode, happy) {
  return {
    platform: 'darwin',
    [read]: async () => {
      if (mode === 'timeout') throw new NativeAccessError('TIMEOUT');
      if (mode === 'unauthorized' || mode === 'disconnect') throw new NativeAccessError('AUTOMATION_DENIED');
      if (mode === 'limited' || mode === 'server') throw new Error('The native source could not be read.');
      if (mode === 'malformed') return { records: null, errors: [], complete: false };
      if (mode === 'partial') return { records: [], errors: [{ folderId: 'folder', code: 'PARTIAL' }], complete: false };
      return { records: happy, errors: [], complete: true };
    }
  };
}

const matrix = [
  {
    name: 'Google Gmail',
    id: 'google',
    token: true,
    seed: { gmail: { historyId: 'h1' } },
    create(mode) {
      return googleConnector({
        flags: { readDrive: false },
        routes: target => target.pathname.includes('/messages/')
          ? httpResponse(200, mailMessage)
          : httpResponse(200, { history: [{ messages: [{ id: 'm-1' }] }], historyId: 'h2' })
      }, mode);
    }
  },
  {
    name: 'Google Drive / Docs',
    id: 'google',
    token: true,
    create(mode) {
      return googleConnector({
        flags: { readGmail: false },
        routes: target => {
          if (target.pathname.includes('/changes/startPageToken')) return httpResponse(200, { startPageToken: 'p-1' });
          if (target.pathname.includes('/export')) return httpResponse(200, null, { raw: 'Cedar brief text' });
          return httpResponse(200, { files: [{ id: 'doc-1', name: 'Cedar brief', mimeType: 'application/vnd.google-apps.document', modifiedTime: AT, version: '3' }] });
        }
      }, mode);
    }
  },
  {
    name: 'Google Calendar',
    id: 'google',
    token: true,
    create(mode) {
      return googleConnector({
        flags: { readGmail: false, readDrive: false, readCalendar: true },
        routes: () => httpResponse(200, {
          items: [{ id: 'evt-1', status: 'confirmed', summary: 'Cedar review', updated: AT, start: { dateTime: '2026-11-12T15:00:00.000Z' }, end: { dateTime: '2026-11-12T16:00:00.000Z' } }],
          nextSyncToken: 'cal-1'
        })
      }, mode);
    }
  },
  {
    name: 'Microsoft Outlook',
    id: 'microsoft',
    token: true,
    create(mode) {
      const fetchImpl = accountFetch(mode, () => httpResponse(200, {
        value: [{
          id: 'mail-1', conversationId: 'thread-1', subject: 'Cedar brief',
          from: { emailAddress: { address: 'alex@example.test' } },
          toRecipients: [{ emailAddress: { address: 'maya@example.test' } }],
          body: { contentType: 'text', content: 'Please update the Cedar brief.' },
          receivedDateTime: AT
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next'
      }));
      const connector = new OutlookConnector({ auth: TOKEN, account: { id: 'ms-1', label: 'maya@example.test' }, now: NOW, fetchImpl });
      if (mode === 'disconnect') connector.live = false;
      return connector;
    }
  },
  {
    name: 'Slack',
    id: 'slack',
    token: true,
    create(mode) {
      const fetchImpl = accountFetch(mode, target => {
        if (target.pathname.endsWith('/conversations.list')) return httpResponse(200, { ok: true, channels: [{ id: 'D111AAAAA', is_im: true }] });
        if (target.pathname.endsWith('/users.info')) return httpResponse(200, { ok: true, user: { real_name: 'Alex' } });
        return httpResponse(200, { ok: true, messages: [{ type: 'message', user: 'UOTHER123', ts: String(Math.floor(NOW() / 1000)), text: 'Please update the Cedar brief.' }] });
      });
      const connector = new SlackConnector({ auth: TOKEN, account: { id: 'T123ABC:U123ABC', userId: 'U123ABC', teamId: 'T123ABC' }, now: NOW, fetchImpl });
      if (mode === 'disconnect') connector.live = false;
      return connector;
    }
  },
  {
    name: 'Notion',
    id: 'notion',
    token: true,
    create(mode) {
      const page = '11111111-1111-1111-1111-111111111111';
      const fetchImpl = accountFetch(mode, target => {
        if (target.pathname === '/v1/search') return httpResponse(200, {
          results: [{ object: 'page', id: page, last_edited_time: AT, archived: false, properties: { Name: { type: 'title', title: [{ plain_text: 'Cedar' }] } } }],
          has_more: false
        });
        return httpResponse(200, { results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Cedar note' }] } }], has_more: false });
      });
      const connector = new NotionConnector({ auth: TOKEN, account: { id: 'notion-1', label: 'Cedar' }, fetchImpl, now: NOW });
      if (mode === 'disconnect') connector.live = false;
      return connector;
    }
  },
  {
    name: 'GitHub',
    id: 'github',
    token: true,
    kinds: ['issue.updated', 'pull_request.updated', 'content.changed', 'workflow.updated'],
    create(mode) {
      const sha = 'a'.repeat(40);
      const repository = 'acme/cedar';
      const fetchImpl = accountFetch(mode, target => {
        if (target.pathname === '/search/issues') {
          const review = target.searchParams.get('q')?.includes('review-requested:');
          return httpResponse(200, { items: review ? [{
            id: 90, number: 3, title: 'Review the Cedar brief', body: 'Please review the Cedar pull request.',
            state: 'open', updated_at: AT, user: { login: 'author' },
            repository_url: `https://api.github.com/repos/${repository}`
          }] : [] });
        }
        if (target.pathname === '/user/repos') return httpResponse(200, [{ full_name: repository, default_branch: 'main', pushed_at: AT }]);
        if (target.pathname.endsWith(`/commits/${sha}`)) return httpResponse(200, {
          sha, commit: { message: 'Update the Cedar brief', author: { date: AT } }, author: { login: 'author' }, files: [{ filename: 'src/cedar.js' }]
        });
        if (target.pathname.endsWith('/commits')) return httpResponse(200, [{
          sha, commit: { message: 'Update the Cedar brief', author: { date: AT } }, author: { login: 'author' }
        }]);
        if (target.pathname.endsWith('/actions/runs')) return httpResponse(200, { workflow_runs: [{
          id: 55, name: 'Cedar rollout', status: 'completed', conclusion: 'failure', updated_at: AT,
          head_branch: 'main', event: 'push', triggering_actor: { login: 'author' }
        }] });
        if (target.pathname === '/issues') return httpResponse(200, [{
          id: 15, number: 7, title: 'Review the Cedar brief', body: 'Assigned Cedar work.',
          user: { login: 'teammate' }, assignees: [{ id: 123, login: 'reader' }], state: 'open', updated_at: AT,
          repository: { full_name: repository }
        }]);
        return httpResponse(200, []);
      });
      const connector = new GitHubConnector({ auth: TOKEN, account: { id: 123, login: 'reader' }, now: NOW, fetchImpl });
      if (mode === 'disconnect') connector.live = false;
      return connector;
    }
  },
  {
    name: 'Todoist',
    id: 'todoist',
    token: true,
    create(mode) {
      const fetchImpl = accountFetch(mode, () => httpResponse(200, {
        results: [{ id: 'task-1', content: 'Review the Cedar brief', description: 'Vendor quote', updated_at: AT, is_completed: false }],
        next_cursor: null
      }));
      const connector = new TodoistConnector({ auth: TOKEN, account: { id: 'todo-1', label: 'maya@example.test' }, now: NOW, fetchImpl });
      if (mode === 'disconnect') connector.live = false;
      return connector;
    }
  },
  {
    name: 'Local files',
    id: 'local_files',
    create(mode) {
      if (!this.folder) {
        const root = directory();
        const folder = path.join(root, 'selected');
        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, 'Cedar.md'), 'TODO: Review the Cedar brief\n');
        this.folder = fs.realpathSync(folder);
        this.missing = path.join(root, 'missing-selected');
      }
      const target = ['unauthorized', 'server', 'malformed'].includes(mode) ? this.missing : this.folder;
      const connector = new LocalFilesConnector({ scopeId: 'local-1', roots: [{ id: 'root', path: target, label: 'Cedar' }], now: NOW });
      if (mode === 'disconnect') connector.live = false;
      if (mode === 'timeout') connector.pull = async () => { throw new ConnectorError('Local files timed out.', { connectorId: 'local_files', timeout: true, retryable: true }); };
      if (mode === 'limited' || mode === 'partial') {
        const cursor = mode === 'partial' ? { documents: {}, counts: {} } : null;
        connector.pull = async () => ({ events: [], cursor, errors: [{ scope: 'files', message: mode === 'partial' ? 'partial page' : 'rate limited' }], partial: true });
      }
      return connector;
    }
  },
  {
    name: 'Apple Notes',
    id: 'apple_notes',
    create(mode) {
      return new AppleNotesConnector({
        scopeId: 'notes-1', folders: FOLDERS, now: NOW,
        bridge: nativeBridge('readNotes', mode, [{
          providerId: 'note-1', ...FOLDERS[0], title: 'Cedar notes', content: 'TODO: Review the Cedar brief\n',
          stamp: 'stamp-1', modifiedAt: AT
        }])
      });
    }
  },
  {
    name: 'Apple Reminders',
    id: 'apple_reminders',
    create(mode) {
      return new AppleRemindersConnector({
        scopeId: 'reminders-1', folders: FOLDERS, now: NOW,
        bridge: nativeBridge('readReminders', mode, [{
          id: 'rem-1', title: 'Review the Cedar brief', body: 'Vendor quote', updatedAt: AT, state: 'open', ...FOLDERS[0]
        }])
      });
    }
  },
  {
    name: 'Apple Mail',
    id: 'apple_mail',
    create(mode) {
      return new AppleMailConnector({
        scopeId: 'mail-1', folders: [{ ...FOLDERS[0], accountEmail: 'maya@example.test' }], now: NOW,
        bridge: nativeBridge('readMail', mode, [{
          id: 'apple-mail-1', from: 'alex@example.test', to: ['maya@example.test'], cc: [],
          subject: 'Cedar brief', body: 'Please update the Cedar brief.', receivedAt: AT, updatedAt: AT, ...FOLDERS[0]
        }])
      });
    }
  },
  {
    name: 'Apple Calendar',
    id: 'apple_calendar',
    create(mode) {
      return new AppleCalendarConnector({
        scopeId: 'cal-1', folders: FOLDERS, now: NOW,
        bridge: nativeBridge('readCalendar', mode, [{
          id: 'event-1', title: 'Cedar review', start: '2026-11-12T15:00:00.000Z', end: '2026-11-12T16:00:00.000Z',
          updatedAt: AT, status: 'confirmed', ...FOLDERS[0]
        }])
      });
    }
  },
  {
    name: 'Apple Contacts',
    id: 'apple_contacts',
    create(mode) {
      return new AppleContactsConnector({
        scopeId: 'contacts-1', folders: FOLDERS, now: NOW,
        bridge: nativeBridge('readContacts', mode, [{
          id: 'person-1', name: 'Cedar Vendor', organization: 'Acme', emails: ['vendor@example.test'], phones: [],
          note: '', updatedAt: AT, ...FOLDERS[0]
        }])
      });
    }
  },
  {
    name: 'Simulated',
    id: 'simulated',
    create(mode) {
      const connector = new SimulatedConnector('northstar');
      connector.live = true;
      const original = connector.pull.bind(connector);
      connector.pull = async input => {
        const page = await original(input);
        return { ...page, events: (page.events || []).map(item => item.event || item) };
      };
      if (mode === 'happy') return connector;
      if (mode === 'disconnect') { connector.live = false; return connector; }
      connector.pull = async () => {
        if (mode === 'partial') return { events: [], cursor: { scenario: 'northstar' }, errors: [{ scope: 'simulated', message: 'partial' }], partial: true };
        throw new ConnectorError(`Simulated ${mode} failure. This is not a live provider.`, { connectorId: 'simulated', status: mode === 'unauthorized' ? 401 : mode === 'limited' ? 429 : 500, retryable: mode !== 'malformed', timeout: mode === 'timeout' });
      };
      return connector;
    }
  }
];

async function sync(store, engine, cursors, connectors) {
  return new ConnectorSync({ connectors, cursors, engine, now: () => AT }).run();
}

function statusOf(store, id) {
  return store.state.connectorStatus?.[id] || null;
}

async function prove(row) {
  const happy = workspace();
  try {
    if (row.seed) happy.cursors.set(row.id, row.seed);
    const before = JSON.stringify(happy.cursors.get(row.id) ?? null);
    const connector = row.create('happy');
    const outcome = await sync(happy.store, happy.engine, happy.cursors, [connector]);
    const result = outcome.results.find(item => item.connector === row.id);
    assert.ok(result, `${row.name} happy sync ran`);
    assert.equal(result.failed, false, `${row.name} happy pull should succeed`);
    assert.notEqual(result.partial, true, `${row.name} happy pull should be complete`);
    assert.ok(result.ingested > 0, `${row.name} should ingest scripted events`);
    assert.equal(statusOf(happy.store, row.id)?.ok, true, `${row.name} should be marked healthy`);
    assert.notEqual(JSON.stringify(happy.cursors.get(row.id) ?? null), before, `${row.name} cursor advances after ingestion`);
    assert.ok(happy.store.state.events.length > 0, `${row.name} events are stored`);
    assert.equal(happy.store.state.outbox.length, 0, `${row.name} sync does not send`);
    if (row.id === 'simulated') assert.ok(happy.store.state.events.every(event => event.source === 'simulated'));
    if (row.kinds) {
      const types = new Set(happy.store.state.events.map(event => event.type));
      for (const type of row.kinds) assert.ok(types.has(type), `${row.name} ingests ${type}`);
    }
    const ids = happy.store.state.events.map(event => event.id);
    assert.equal(new Set(ids).size, ids.length, `${row.name} event ids are unique`);

    const replay = await sync(happy.store, happy.engine, happy.cursors, [connector]);
    const replayed = replay.results.find(item => item.connector === row.id);
    assert.equal(replayed.ingested, 0, `${row.name} replay does not create new events`);
    if (replayed.duplicates < 1 && happy.store.state.events[0]) {
      assert.equal(happy.engine.ingest(happy.store.state.events[0]).duplicate, true, `${row.name} replaying a stored provider event is idempotent`);
    }
    assert.equal(new Set(happy.store.state.events.map(event => event.id)).size, ids.length);
    const tasks = Object.keys(happy.store.state.tasks).length;
    happy.store.close();

    const restored = new SqliteStore(path.join(happy.root, 'state.json'));
    const resumed = new WorkEngine(restored, { provider: new SimulatedMailProvider(restored), reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
    try {
      const again = await sync(restored, resumed, new CursorStore(restored), [row.create('happy')]);
      const restarted = again.results.find(item => item.connector === row.id);
      assert.equal(restarted.ingested, 0, `${row.name} restart replay creates no new events`);
      assert.equal(Object.keys(restored.state.tasks).length, tasks, `${row.name} restart does not create a second situation task`);
      assert.equal(restored.state.outbox.length, 0);
    } finally { restored.close(); }
  } finally { happy.store.close(); }

  for (const mode of ['unauthorized', 'limited', 'server', 'malformed', 'timeout', 'disconnect', 'partial']) {
    const failed = workspace();
    try {
      if (row.seed) failed.cursors.set(row.id, row.seed);
      const cursorBefore = JSON.stringify(failed.cursors.get(row.id) ?? null);
      const sibling = new SiblingConnector();
      const outcome = await sync(failed.store, failed.engine, failed.cursors, [row.create(mode), sibling]);
      const primary = outcome.results.find(item => item.connector === row.id);
      const other = outcome.results.find(item => item.connector === 'sibling');
      assert.ok(other && other.failed !== true, `${row.name} ${mode} lets a sibling connector proceed`);
      assert.equal(statusOf(failed.store, 'sibling')?.ok, true);
      if (primary) {
        assert.ok(primary.failed === true || primary.partial === true || statusOf(failed.store, row.id)?.ok !== true, `${row.name} ${mode} is not a successful pull`);
        assert.equal(primary.ingested || 0, 0, `${row.name} ${mode} does not ingest invented events`);
      }
      assert.notEqual(statusOf(failed.store, row.id)?.ok, true, `${row.name} ${mode} is not marked healthy`);
      if (row.seed && mode !== 'partial') assert.equal(JSON.stringify(failed.cursors.get(row.id) ?? null), cursorBefore, `${row.name} ${mode} keeps the prior checkpoint`);
      assert.equal(failed.store.state.outbox.length, 0, `${row.name} ${mode} does not send`);
      assert.equal(failed.store.state.events.length, 0, `${row.name} ${mode} invents no events`);
    } finally { failed.store.close(); }
  }

  for (const mode of ['unauthorized', 'limited', 'server', 'timeout']) {
    if (mode === 'unauthorized' && !row.token) continue;
    await recoverAfter(row, mode);
  }
  await reconnect(row);
}

function situationIds(store) {
  const fromTasks = Object.values(store.state.tasks).map(task => task.situationId).filter(Boolean);
  let fromTable = [];
  try { fromTable = store.db.prepare('SELECT id FROM situations').all().map(row => row.id); } catch { /* JSON stores have no situations table */ }
  return [...new Set([...fromTasks, ...fromTable])].sort();
}

/** Failure, then a later successful pull on the same store. Happy-path replay is not this. */
async function recoverAfter(row, mode) {
  const env = workspace();
  try {
    if (row.seed) env.cursors.set(row.id, row.seed);
    const cursorBefore = JSON.stringify(env.cursors.get(row.id) ?? null);
    const failed = await sync(env.store, env.engine, env.cursors, [row.create(mode), new SiblingConnector()]);
    const primary = failed.results.find(item => item.connector === row.id);
    const sibling = failed.results.find(item => item.connector === 'sibling');
    assert.ok(sibling && sibling.failed !== true, `${row.name} ${mode} lets a sibling proceed before recovery`);
    if (primary) assert.equal(primary.ingested || 0, 0, `${row.name} ${mode} ingests nothing to recover`);
    assert.notEqual(statusOf(env.store, row.id)?.ok, true, `${row.name} ${mode} stays unhealthy`);
    assert.equal(env.store.state.events.length, 0, `${row.name} ${mode} invents no events`);
    assert.equal(env.store.state.outbox.length, 0);
    if (row.seed) assert.equal(JSON.stringify(env.cursors.get(row.id) ?? null), cursorBefore, `${row.name} ${mode} keeps the prior checkpoint`);

    const healed = row.create('happy');
    const recovered = await sync(env.store, env.engine, env.cursors, [healed]);
    const ok = recovered.results.find(item => item.connector === row.id);
    assert.ok(ok && ok.failed !== true && ok.ingested > 0, `${row.name} ${mode} recovery ingests the missed items`);
    assert.equal(statusOf(env.store, row.id)?.ok, true, `${row.name} ${mode} recovery marks the connector healthy`);
    const ids = env.store.state.events.map(event => event.id);
    assert.equal(new Set(ids).size, ids.length, `${row.name} ${mode} recovery does not duplicate provider events`);
    const situations = situationIds(env.store);
    const tasks = Object.keys(env.store.state.tasks).length;
    assert.equal(env.store.state.outbox.length, 0);

    const replay = await sync(env.store, env.engine, env.cursors, [healed]);
    assert.equal(replay.results.find(item => item.connector === row.id).ingested, 0, `${row.name} ${mode} replay after recovery adds no events`);
    assert.equal(env.store.state.events.length, ids.length);
    assert.deepEqual(situationIds(env.store), situations, `${row.name} ${mode} recovery does not open a second Situation`);
    env.store.close();

    const restored = new SqliteStore(path.join(env.root, 'state.json'));
    const engine = new WorkEngine(restored, { provider: new SimulatedMailProvider(restored), reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
    try {
      const again = await sync(restored, engine, new CursorStore(restored), [row.create('happy')]);
      const restarted = again.results.find(item => item.connector === row.id);
      assert.equal(restarted.ingested, 0, `${row.name} ${mode} stays idempotent across restart`);
      assert.equal(Object.keys(restored.state.tasks).length, tasks);
      assert.deepEqual(situationIds(restored), situations);
      assert.equal(restored.state.outbox.length, 0);
    } finally { restored.close(); }
  } finally { if (!env.store.closed) env.store.close(); }
}

/** Disconnect, then reconnect on the same store. The same provider identity stays one Situation. */
async function reconnect(row) {
  const env = workspace();
  try {
    if (row.seed) env.cursors.set(row.id, row.seed);
    const first = await sync(env.store, env.engine, env.cursors, [row.create('happy')]);
    assert.ok(first.results.find(item => item.connector === row.id).ingested > 0);
    const ids = env.store.state.events.map(event => event.id);
    const situations = situationIds(env.store);
    const tasks = Object.keys(env.store.state.tasks).length;
    await sync(env.store, env.engine, env.cursors, [row.create('disconnect'), new SiblingConnector()]);
    const withdrawn = env.store.state.events.filter(event => !ids.includes(event.id));
    assert.ok(withdrawn.every(event => event.type.endsWith('unavailable') || event.operation === 'delete' || event.payload?.state && event.payload.state !== 'open'),
      `${row.name} disconnect only withdraws source content, got ${withdrawn.map(event => `${event.type}:${event.payload?.state || ''}`).join(',')}`);
    assert.equal(Object.keys(env.store.state.tasks).length, tasks, `${row.name} disconnect does not open a new task`);
    assert.deepEqual(situationIds(env.store), situations, `${row.name} disconnect does not open a second Situation`);
    assert.equal(env.store.state.outbox.length, 0);
    await sync(env.store, env.engine, env.cursors, [row.create('happy')]);
    assert.equal(Object.keys(env.store.state.tasks).length, tasks, `${row.name} reconnect does not open a second task`);
    assert.deepEqual(situationIds(env.store), situations, `${row.name} reconnect resumes the existing Situation`);
    assert.equal(env.store.state.outbox.length, 0, `${row.name} reconnect does not repeat a write`);
  } finally { env.store.close(); }
}

for (const row of matrix) {
  test(`${row.name} sync: happy, failure, and recovery`, async () => { await prove(row); });
}

test('Google scopes keep a failed Drive checkpoint from advancing while Gmail can still be held', async () => {
  const { store, engine, cursors } = workspace();
  try {
    cursors.set('google', { gmail: { historyId: 'h1' } });
    const connector = googleConnector({
      flags: { readCalendar: false },
      routes: target => {
        if (target.pathname.includes('/messages/')) return httpResponse(200, mailMessage);
        if (target.pathname.includes('/history')) return httpResponse(200, { history: [{ messages: [{ id: 'm-1' }] }], historyId: 'h2' });
        return httpResponse(500, {});
      }
    }, 'happy');
    const outcome = await sync(store, engine, cursors, [connector, new SiblingConnector()]);
    const primary = outcome.results.find(item => item.connector === 'google');
    assert.equal(primary.partial, true);
    assert.equal(statusOf(store, 'google')?.ok, false);
    assert.equal(cursors.get('google')?.gmail?.historyId, 'h2');
    assert.equal(cursors.get('google')?.drive, undefined);
    assert.equal(statusOf(store, 'sibling')?.ok, true);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

const CEDAR_REQUEST = 'Please update the Cedar brief with the vendor quote and send it by 2099-06-01.';
const CEDAR_DOCUMENT = '# Cedar brief\n\n## Vendor quote\nAcme quoted 4200 USD for the Cedar engagement.\n';

function cedarGmail(mode) {
  const message = {
    ...mailMessage,
    payload: {
      ...mailMessage.payload,
      body: { data: Buffer.from(CEDAR_REQUEST, 'utf8').toString('base64url') }
    }
  };
  return googleConnector({
    flags: { readDrive: false },
    routes: target => target.pathname.includes('/messages/')
      ? httpResponse(200, message)
      : httpResponse(200, { history: [{ messages: [{ id: 'm-1' }] }], historyId: 'h2' })
  }, mode);
}

test('Gmail 401 recovery ingests the missed mail once and does not repeat a verified send', async () => {
  const env = workspace();
  try {
    env.cursors.set('google', { gmail: { historyId: 'h1' } });
    const denied = await sync(env.store, env.engine, env.cursors, [cedarGmail('unauthorized'), new SiblingConnector()]);
    assert.equal(denied.results.find(item => item.connector === 'google').ingested, 0);
    assert.notEqual(statusOf(env.store, 'google')?.ok, true);
    assert.equal(env.cursors.get('google').gmail.historyId, 'h1');
    const recovered = await sync(env.store, env.engine, env.cursors, [cedarGmail('happy')]);
    assert.ok(recovered.results.find(item => item.connector === 'google').ingested > 0);
    const taskId = Object.keys(env.store.state.tasks)[0];
    assert.ok(taskId);
    const situationId = env.store.state.tasks[taskId].situationId;
    env.engine.ingest({
      id: 'local:cedar-doc', type: 'document.modified', source: 'simulated', connectorId: 'local',
      providerEventId: 'doc:cedar', at: AT,
      payload: { id: 'cedar-brief', title: 'Cedar brief', kind: 'brief', content: CEDAR_DOCUMENT, modifiedAt: AT }
    });
    const verified = env.engine.approve(taskId);
    assert.equal(verified.status, 'completed');
    assert.equal(verified.followThrough?.closeKind, 'verified');
    assert.equal(env.store.state.outbox.length, 1);
    const replay = await sync(env.store, env.engine, env.cursors, [cedarGmail('happy')]);
    assert.equal(replay.results.find(item => item.connector === 'google').ingested, 0);
    assert.equal(env.store.state.tasks[taskId].situationId, situationId);
    assert.equal(Object.keys(env.store.state.tasks).length, 1);
    assert.equal(env.store.state.outbox.length, 1);
    env.store.close();
    const restored = new SqliteStore(path.join(env.root, 'state.json'));
    const engine = new WorkEngine(restored, { provider: new SimulatedMailProvider(restored), reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
    try {
      const again = await sync(restored, engine, new CursorStore(restored), [cedarGmail('happy')]);
      assert.equal(again.results.find(item => item.connector === 'google').ingested, 0);
      assert.equal(restored.state.outbox.length, 1);
      assert.equal(restored.state.tasks[taskId].situationId, situationId);
    } finally { restored.close(); }
  } finally { if (!env.store.closed) env.store.close(); }
});

test('Notion suppression excludes withdrawn pages from task context and reconnect does not write', async () => {
  const env = workspace();
  const gmail = cedarGmail('happy');
  const notion = matrix.find(row => row.name === 'Notion').create('happy');
  const runtime = new DurableRuntime(env.engine, {
    tickMs: 100000,
    connectorFor: id => [gmail, notion].find(connector => connector.id === id)
  });
  try {
    bindConnectionAccount(env.store, 'google', 'reader');
    bindConnectionAccount(env.store, 'notion', notion.account.id);
    env.cursors.set('google', { gmail: { historyId: 'h1' } });
    const opened = await sync(env.store, env.engine, env.cursors, [gmail, notion]);
    assert.ok(opened.results.every(result => result.failed !== true));
    await env.engine.whenSettled();
    const task = Object.values(env.store.state.tasks).find(item => item.request?.subjectEntity === 'Cedar');
    assert.ok(task);
    const situationId = task.situationId;
    assert.ok(situationId);
    const policy = runtime.policies.save({
      instruction: 'Suppress Notion',
      predicate: { op: 'eq', feature: 'event.provider', value: 'notion' },
      effect: { type: 'suppress' }
    });
    const page = '22222222-2222-2222-2222-222222222222';
    const withdrawn = env.engine.ingest({
      id: 'notion:page:withdrawn', type: 'document.modified', source: 'notion', connectorId: 'notion',
      providerEventId: `page:${page}:${AT}`, at: AT,
      payload: { id: `notion:${page}`, title: 'Withdrawn Cedar page', kind: 'document', content: 'Secret withdrawn source', modifiedAt: AT, externalId: page }
    });
    assert.equal(withdrawn.disposition, 'suppressed_by_user_policy');
    assert.equal(env.engine.documentsForTask(task.id).some(document => String(document.id).includes(page)), false);
    assert.equal(env.store.state.tasks[task.id].situationId, situationId);
    runtime.policies.disable(policy.id, policy.version);
    const restored = env.engine.ingest({
      id: 'google:gmail:m-1', type: 'email.received', source: 'google', connectorId: 'google',
      providerEventId: 'gmail:m-1', at: AT,
      payload: { id: 'm-1', threadId: 't-1', from: 'alex@example.test', to: 'maya@example.test', subject: 'Cedar brief', body: CEDAR_REQUEST, receivedAt: AT }
    });
    assert.equal(restored.duplicate, true);
    assert.equal(Object.values(env.store.state.tasks).filter(item => item.situationId === situationId).length, 1);
    assert.equal(env.store.state.outbox.length, 0);
    await env.engine.whenSettled();
  } finally {
    await runtime.close();
    if (!env.store.closed) env.store.close();
  }
});

test('simulated mail remains labeled simulated and is not a live provider', () => {
  const { store } = workspace();
  try {
    const connector = new SimulatedConnector();
    assert.equal(connector.live, false);
    assert.equal(connector.kind, 'simulated');
    const provider = new SimulatedMailProvider(store);
    assert.equal(provider.kind, 'simulated');
    assert.equal(provider.live, false);
  } finally { store.close(); }
});
