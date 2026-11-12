import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackConnector } from '../src/connectors/slack.js';
import { NotionConnector } from '../src/connectors/notion.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const auth = { accessToken: async () => 'PRIVATE_ACCOUNT_TOKEN' };
const slackAccount = { id: 'T123ABC:U123ABC', userId: 'U123ABC', teamId: 'T123ABC', label: 'ada · Work' };
const now = () => Date.parse('2026-10-28T00:00:00.000Z');

test('Slack reads direct messages, skips the user and subtypes, and keeps the cursor when a conversation fails', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const target = new URL(url);
    calls.push(target.pathname);
    if (target.pathname === '/api/conversations.list') return json({ ok: true, channels: [
      { id: 'D111AAAAA', is_im: true, updated: 200 },
      { id: 'G222BBBBB', is_mpim: true, updated: 100 },
      { id: 'C333CCCCC', is_channel: true, updated: 300 }
    ] });
    if (target.pathname === '/api/conversations.history' && target.searchParams.get('channel') === 'G222BBBBB') return json({ ok: false, error: 'ratelimited' });
    if (target.pathname === '/api/conversations.history') return json({ ok: true, messages: [
      { type: 'message', user: 'UOTHER123', text: 'Please review the notes', ts: '1710000000.000100' },
      { type: 'message', user: 'U123ABC', text: 'my own note', ts: '1710000001.000100' },
      { type: 'message', subtype: 'bot_message', text: 'bot', ts: '1710000002.000100' },
      { type: 'message', user: 'UOTHER123', text: '   ', ts: '1710000003.000100' }
    ] });
    if (target.pathname === '/api/users.info') return json({ ok: true, user: { profile: { display_name: 'Ada Lovelace' } } });
    throw new Error(target.pathname);
  };
  const connector = new SlackConnector({ auth, account: slackAccount, fetchImpl, now });
  const page = await connector.pull();
  assert.equal(page.partial, true);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].type, 'email.received');
  assert.equal(page.events[0].source, 'slack');
  assert.equal(page.events[0].payload.from, 'Ada Lovelace');
  assert.equal(page.events[0].payload.subject, 'Message from Ada Lovelace');
  assert.equal(page.cursor.oldest, String(Math.floor((now() - 3 * 24 * 60 * 60 * 1000) / 1000)));
  assert.equal(calls.filter(path => path === '/api/users.info').length, 1);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_ACCOUNT_TOKEN/);
  const healthy = new SlackConnector({ auth, account: slackAccount, now, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname === '/api/conversations.list') return json({ ok: true, channels: [{ id: 'D111AAAAA', is_im: true, updated: 1 }] });
    if (target.pathname === '/api/users.info') return json({ ok: true, user: { real_name: 'Grace' } });
    return json({ ok: true, messages: [{ type: 'message', user: 'UOTHER123', text: 'Ship the notes', ts: '1710000000.000100' }] });
  } });
  const done = await healthy.pull();
  assert.equal(done.partial, false);
  assert.equal(done.cursor.oldest, String(Math.floor(now() / 1000)));
  assert.equal(done.events[0].payload.id, 'slack:T123ABC:D111AAAAA:1710000000.000100');
});

test('Notion reads selected pages as documents and does not advance past a failed page body', async () => {
  const page = { object: 'page', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'https://www.notion.so/Launch-plan-aaaabbbbccccddddeeeeeeeeeeee', last_edited_time: '2026-10-27T12:00:00.000Z',
    properties: { Name: { type: 'title', title: [{ plain_text: 'Launch plan' }] } } };
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    if (target.pathname === '/v1/search') {
      assert.equal(options.headers['Notion-Version'], '2022-06-28');
      assert.equal(options.headers.authorization, 'Bearer PRIVATE_ACCOUNT_TOKEN');
      assert.equal(options.headers['content-type'], 'application/json');
      return json({ results: [page], has_more: true, next_cursor: 'cursor-1' });
    }
    assert.equal(target.pathname, '/v1/blocks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/children');
    return json({ results: [
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Ship the notes' }] } },
      { type: 'to_do', to_do: { checked: false, rich_text: [{ plain_text: 'Confirm the date' }] } }
    ] });
  };
  const connector = new NotionConnector({ auth, account: { id: 'workspace:user', label: 'Ada · Notes' }, fetchImpl, now });
  const result = await connector.pull();
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor.startCursor, 'cursor-1');
  assert.equal(result.events[0].type, 'document.modified');
  assert.equal(result.events[0].source, 'notion');
  assert.equal(result.events[0].payload.title, 'Launch plan');
  assert.match(result.events[0].payload.content, /Ship the notes/);
  assert.match(result.events[0].payload.content, /\[ \] Confirm the date/);
  assert.equal(result.events[0].payload.url.startsWith('https://www.notion.so/'), true);
  const stalled = new NotionConnector({ auth, account: { id: 'workspace:user', label: 'Ada · Notes' }, now, fetchImpl: async url => new URL(url).pathname === '/v1/search'
    ? json({ results: [page], has_more: false, next_cursor: null }) : new Response('secret body', { status: 500 }) });
  const cursor = { since: '2026-10-01T00:00:00.000Z' };
  const failed = await stalled.pull({ cursor });
  assert.equal(failed.partial, true);
  assert.equal(failed.events.length, 0);
  assert.equal(failed.cursor.since, cursor.since);
  assert.doesNotMatch(JSON.stringify(failed), /secret body/);
});

test('Slack follows history pages and reports a deleted direct message as email.unavailable', async () => {
  let clock = Date.parse('2026-10-28T00:00:00.000Z');
  const deleted = new Set();
  const fetchImpl = async url => {
    const target = new URL(url), p = target.searchParams;
    if (target.pathname === '/api/conversations.list') return json({ ok: true, channels: [{ id: 'D111AAAAA', is_im: true, updated: 1 }] });
    if (target.pathname === '/api/users.info') return json({ ok: true, user: { real_name: 'Grace' } });
    if (p.get('latest') === p.get('oldest')) return json({ ok: true, messages: deleted.has(p.get('latest')) ? [] : [{ type: 'message', user: 'UOTHER123', text: 'x', ts: p.get('latest') }] });
    const after = message => Number(message.ts) >= Number(p.get('oldest'));
    if (p.get('cursor') === 'page-2') return json({ ok: true, messages: [{ type: 'message', user: 'UOTHER123', text: 'Older request', ts: '1793130000.000100' }].filter(after), has_more: false });
    const newer = [{ type: 'message', user: 'UOTHER123', text: 'Newer request', ts: '1793140000.000100' }].filter(after);
    return json({ ok: true, messages: newer, ...(newer.length ? { has_more: true, response_metadata: { next_cursor: 'page-2' } } : {}) });
  };
  const connector = new SlackConnector({ auth, account: slackAccount, fetchImpl, now: () => clock });
  const first = await connector.pull();
  assert.equal(first.partial, false);
  assert.equal(first.events.length, 2, 'both history pages were read');
  assert.equal(Object.keys(first.cursor.messages).length, 2);
  deleted.add('1793130000.000100');
  clock += 60_000;
  const second = await connector.pull({ cursor: first.cursor });
  const removed = second.events.filter(event => event.type === 'email.unavailable');
  assert.deepEqual(removed.map(event => event.payload.id), ['slack:T123ABC:D111AAAAA:1793130000.000100']);
  assert.equal(Object.keys(second.cursor.messages).length, 1);
});

test('Notion reports archived pages and pages that stop being shared as document.unavailable', async () => {
  const pageA = { object: 'page', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', last_edited_time: '2026-10-27T12:00:00.000Z', properties: { Name: { type: 'title', title: [{ plain_text: 'Plan A' }] } } };
  const pageB = { object: 'page', id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', last_edited_time: '2026-10-27T11:00:00.000Z', properties: { Name: { type: 'title', title: [{ plain_text: 'Plan B' }] } } };
  let results = [pageA, pageB];
  const fetchImpl = async url => {
    const target = new URL(url);
    if (target.pathname === '/v1/search') return json({ results, has_more: false, next_cursor: null });
    if (target.pathname === `/v1/pages/${pageB.id}`) return json({ object: 'error', code: 'object_not_found' }, 404);
    return json({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Body' }] } }] });
  };
  const connector = new NotionConnector({ auth, account: { id: 'workspace:user', label: 'Ada · Notes' }, fetchImpl, now });
  const first = await connector.pull();
  assert.deepEqual(Object.keys(first.cursor.pages).sort(), [pageA.id, pageB.id]);
  results = [{ ...pageA, archived: true, last_edited_time: '2026-10-27T13:00:00.000Z' }];
  const second = await connector.pull({ cursor: { ...first.cursor, since: '2026-10-27T00:00:00.000Z' } });
  assert.deepEqual(second.events.map(event => [event.type, event.payload.id, event.payload.reason]).sort(), [
    ['document.unavailable', `notion:${pageA.id}`, 'archived'],
    ['document.unavailable', `notion:${pageB.id}`, 'removed_or_unshared']
  ]);
  assert.deepEqual(second.cursor.pages, {});
});
