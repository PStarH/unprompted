import { createHash } from 'node:crypto';
import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { providerJSON } from './http.js';

const ORIGIN = 'https://slack.com';
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const KNOWN_ERRORS = {
  invalid_auth: 'Reconnect this Slack account.',
  token_revoked: 'Reconnect this Slack account.',
  account_inactive: 'Reconnect this Slack account.',
  not_authed: 'Reconnect this Slack account.',
  missing_scope: 'Slack is missing permission to read direct messages. Reconnect and allow that access.',
  ratelimited: 'Slack is rate limited. Try again later.'
};

function assertSlackOk(data, connectorId) {
  if (data?.ok === true) return data;
  const code = typeof data?.error === 'string' ? data.error : '';
  throw new ConnectorError(KNOWN_ERRORS[code] || 'Slack returned an unexpected response.', {
    connectorId, retryable: code === 'ratelimited', status: code === 'ratelimited' ? 429 : 401
  });
}

function plain(value, fallback, max = 120) {
  const text = String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
  return text || fallback;
}

export class SlackConnector extends Connector {
  constructor({ auth, account, fetchImpl = globalThis.fetch, now = Date.now, scopes = [] } = {}) {
    super({ id: 'slack', kind: 'slack', fetchImpl });
    Object.assign(this, { auth, account, scopes: [...scopes], now, live: Boolean(account?.id && auth), shadow: true });
  }
  get channelsEnabled() { return this.scopes.includes('channels:history') || this.scopes.includes('groups:history'); }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Slack authorization'], detail: 'Read direct messages and group direct messages for the connected Slack user.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['slack.direct_messages', 'slack.threads', ...(this.channelsEnabled ? ['slack.joined_channels'] : [])] : [], pagination: this.live ? ['slack.conversations', 'slack.history', 'slack.replies'] : [], incremental: this.live ? ['slack.direct_messages'] : [], observation: this.live ? 'poll' : 'none' }; }
  #ids() {
    const teamId = this.account.teamId || String(this.account.id || '').split(':')[0];
    const userId = this.account.userId || String(this.account.id || '').split(':')[1];
    return { teamId, userId };
  }
  async #slack(path, query, signal) {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const data = await providerJSON(url.href, { provider: this.id, origin: ORIGIN, fetchImpl: this.fetchImpl, signal,
      headers: { authorization: `Bearer ${await this.auth.accessToken()}` } });
    return assertSlackOk(data, this.id);
  }
  /** Re-read one source message before an action that depends on it. */
  async sourceMessageState(id, { threadTs = null } = {}) {
    const match = typeof id === 'string' && id.match(/^slack:([^:]+):([CDG][A-Z0-9]{2,32}):(\d{10}(?:\.\d{1,6})?)$/);
    if (!this.live || !match || match[1] !== this.#ids().teamId) return { status: 'unknown' };
    const reply = typeof threadTs === 'string' && /^\d{10}(?:\.\d{1,6})?$/.test(threadTs) && threadTs !== match[3];
    const found = await this.#slack(reply ? '/api/conversations.replies' : '/api/conversations.history', { ...(reply ? { ts: threadTs } : {}), channel: match[2], latest: match[3], oldest: match[3], inclusive: 'true', limit: '1' });
    if (!Array.isArray(found.messages)) return { status: 'unknown' };
    return found.messages.some(message => message?.ts === match[3] && message.subtype !== 'tombstone') ? { status: 'present' } : { status: 'missing', reason: 'deleted' };
  }
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: null });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 1, unavailable: false };
  }
  async pull({ cursor = null, signal } = {}) {
    if (!this.live) throw new ConnectorError('Slack is disconnected.', { connectorId: this.id });
    const { teamId, userId } = this.#ids();
    if (!/^T[A-Z0-9]{2,32}$/.test(teamId) || !/^U[A-Z0-9]{2,32}$/.test(userId)) throw new ConnectorError('Slack account identity is incomplete.', { connectorId: this.id });
    const oldest = /^\d{10,16}$/.test(String(cursor?.oldest || '')) ? String(cursor.oldest) : String(Math.floor((this.now() - WINDOW_MS) / 1000));
    const scan = cursor?.scan ? structuredClone(cursor.scan) : { oldest, latest: String(Math.floor(this.now() / 1000)), listCursor: null, conversations: null, index: 0, historyCursor: null, replies: [], replyCursor: null };
    const threads = { ...(cursor?.threads || {}) };
    if (!scan.followups) scan.followups = Object.entries(threads).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([key]) => key);
    const seenNow = new Set();
    const known = { ...(cursor?.messages || {}) }, records = [], errors = [], names = new Map();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const emit = async (message, conversation) => {
      if (message?.subtype && message.subtype !== 'thread_broadcast' || message?.user === userId || typeof message?.text !== 'string' || !message.text.trim()) return;
      if (!/^U[A-Z0-9]{2,32}$/.test(message.user || '') || !/^\d{10}(?:\.\d{1,6})?$/.test(message.ts || '')) return;
      let name = names.get(message.user);
      if (!name && names.size < 30) {
        try { const info = await this.#slack('/api/users.info', { user: message.user }, combined); name = plain(info.user?.profile?.display_name || info.user?.profile?.real_name || info.user?.real_name, 'Slack'); }
        catch { name = 'Slack'; }
        names.set(message.user, name);
      }
      name ||= 'Slack';
      const receivedAt = new Date(Number(message.ts) * 1000).toISOString();
      const updatedAt = message.edited?.ts ? new Date(Number(message.edited.ts) * 1000).toISOString() : receivedAt;
      const key = `${conversation.id}:${message.ts}`;
      const threadTs = message.thread_ts || (message.reply_count > 0 ? message.ts : null);
      seenNow.add(key);
      known[key] = { at: Date.parse(receivedAt), thread: threadTs };
      const revision = message.edited?.ts || createHash('sha256').update(message.text).digest('hex');
      records.push({ type: 'email.received', providerEventId: `dm:${teamId}:${key}`, providerRevision: revision, at: updatedAt,
        meta: { ...(conversation.is_im ? {} : { principalRole: message.text.includes(`<@${userId}>`) ? 'DIRECT_ACTOR' : 'SHARED_GROUP', roleEvidence: { basis: message.text.includes(`<@${userId}>`) ? 'provider_mention' : 'shared_group_membership' } }) },
        payload: { id: `slack:${teamId}:${key}`, threadId: `slack:${teamId}:${conversation.id}${threadTs ? ':' + threadTs : ''}`,
          from: name, subject: conversation.is_im ? `Message from ${name}` : conversation.is_mpim ? `Group message from ${name}` : `#${plain(conversation.name, conversation.id)} · ${name}`,
          body: message.text.slice(0, 8000), slackThreadTs: threadTs, receivedAt, updatedAt, connectorId: this.id, accountId: this.account.id,
          sourceUrl: `https://app.slack.com/client/${teamId}/${conversation.id}/thread/${conversation.id}-${message.thread_ts || message.ts}` } });
    };
    const nextToken = (data, previous) => {
      const next = data.response_metadata?.next_cursor || null;
      if (data.has_more && !next || next && (typeof next !== 'string' || next === previous)) throw new ConnectorError('Slack pagination did not advance.', { connectorId: this.id, retryable: true });
      return next;
    };
    let complete = false;
    try {
      // Each returned page is acknowledged independently. A frozen upper bound
      // prevents new messages from shifting a pending history window.
      for (let work = 0; work < 20; work++) {
        if (!scan.conversations) {
          const listing = await this.#slack('/api/conversations.list', { types: this.channelsEnabled ? 'im,mpim,public_channel,private_channel' : 'im,mpim', limit: '100', exclude_archived: 'true', ...(scan.listCursor ? { cursor: scan.listCursor } : {}) }, combined);
          if (!Array.isArray(listing.channels)) throw new ConnectorError('Slack returned an invalid conversation listing.', { connectorId: this.id });
          scan.conversations = listing.channels.filter(item => /^[CDG][A-Z0-9]{2,32}$/.test(item?.id || '') && (item.is_im || item.is_mpim || this.channelsEnabled && item.is_member === true));
          scan.listCursor = nextToken(listing, scan.listCursor); scan.index = 0;
        }
        if (scan.index >= scan.conversations.length) {
          if (scan.listCursor) { scan.conversations = null; continue; }
          if (scan.followups.length) {
            const key = scan.followups[0], [channel, ts] = key.split(':');
            const data = await this.#slack('/api/conversations.replies', { channel, ts, oldest: scan.oldest, latest: scan.latest, inclusive: 'true', limit: '100', ...(scan.followupCursor ? { cursor: scan.followupCursor } : {}) }, combined);
            if (!Array.isArray(data.messages)) throw new ConnectorError('Slack returned invalid followed thread replies.', { connectorId: this.id });
            for (const message of data.messages) await emit(message, { id: channel, is_im: channel.startsWith('D'), is_mpim: channel.startsWith('G') });
            scan.followupCursor = nextToken(data, scan.followupCursor);
            if (!scan.followupCursor) scan.followups.shift();
            continue;
          }
          complete = true; break;
        }
        const conversation = scan.conversations[scan.index];
        if (scan.replies?.length) {
          const ts = scan.replies[0];
          const data = await this.#slack('/api/conversations.replies', { channel: conversation.id, ts, oldest: scan.oldest, latest: scan.latest, inclusive: 'true', limit: '100', ...(scan.replyCursor ? { cursor: scan.replyCursor } : {}) }, combined);
          if (!Array.isArray(data.messages)) throw new ConnectorError('Slack returned invalid replies.', { connectorId: this.id });
          for (const message of data.messages) await emit(message, conversation);
          scan.replyCursor = nextToken(data, scan.replyCursor);
          if (!scan.replyCursor) scan.replies.shift();
          if (!scan.replies.length && scan.historyDone) { scan.index++; scan.historyDone = false; }
          continue;
        }
        const history = await this.#slack('/api/conversations.history', { channel: conversation.id, oldest: scan.oldest, latest: scan.latest, inclusive: 'true', limit: '100', ...(scan.historyCursor ? { cursor: scan.historyCursor } : {}) }, combined);
        if (!Array.isArray(history.messages)) throw new ConnectorError('Slack returned an invalid message listing.', { connectorId: this.id });
        for (const message of history.messages) {
          await emit(message, conversation);
          if (message.reply_count > 0 && typeof message.ts === 'string') { scan.replies.push(message.ts); threads[`${conversation.id}:${message.ts}`] = this.now(); }
        }
        scan.historyCursor = nextToken(history, scan.historyCursor);
        scan.historyDone = !scan.historyCursor;
        if (scan.historyDone && !scan.replies.length) { scan.index++; scan.historyDone = false; }
      }
    } catch (error) {
      errors.push({ scope: 'slack.window', message: error.message, retryable: error.retryable === true });
    }
    try {
      const tracked = Object.entries(known).filter(([key]) => !seenNow.has(key)).sort((a, b) => (b[1]?.at ?? b[1]) - (a[1]?.at ?? a[1])).slice(0, 200);
      const start = tracked.length ? Number(cursor?.recheck || 0) % tracked.length : 0;
      if (complete && !errors.length) for (let index = 0; index < Math.min(10, tracked.length); index++) {
        const [key, value] = tracked[(start + index) % tracked.length], [channel, ts] = key.split(':');
        const root = value?.thread;
        const data = await this.#slack(root && root !== ts ? '/api/conversations.replies' : '/api/conversations.history', { channel, ...(root && root !== ts ? { ts: root } : {}), latest: ts, oldest: ts, inclusive: 'true', limit: '1' }, combined);
        if (!Array.isArray(data.messages)) throw new ConnectorError('Slack returned an invalid source recheck.', { connectorId: this.id });
        const message = data.messages.find(item => item.ts === ts && item.subtype !== 'tombstone');
        if (message) await emit(message, { id: channel, is_im: channel.startsWith('D'), is_mpim: channel.startsWith('G') });
        else {
          delete known[key];
          records.push({ type: 'email.unavailable', providerEventId: `dm-removed:${teamId}:${key}`, providerRevision: String(value?.at ?? value), operation: 'delete', at: new Date(this.now()).toISOString(), payload: { id: `slack:${teamId}:${key}`, reason: 'deleted' } });
        }
      }
      const partial = errors.length > 0;
      const messages = Object.fromEntries(Object.entries(known).sort((a, b) => (b[1]?.at ?? b[1]) - (a[1]?.at ?? a[1])).slice(0, 200));
      return { events: [...new Map(toNormalizedEvents(this.id, 'slack', records).map(event => [event.id, event])).values()], cursor: { threads: Object.fromEntries(Object.entries(threads).sort((a, b) => b[1] - a[1]).slice(0, 100)), oldest: complete && !partial ? scan.latest : oldest, messages, recheck: tracked.length ? (start + 10) % tracked.length : 0, ...(!complete || partial ? { scan } : {}) }, partial, errors, hasMore: !complete && !partial };
    } catch (error) {
      return { events: [...new Map(toNormalizedEvents(this.id, 'slack', records).map(event => [event.id, event])).values()], cursor: { ...(cursor || { oldest }), messages: known, threads }, partial: true, errors: [...errors, { scope: 'recheck', message: error.message, retryable: true }], hasMore: false };
    } finally { clearTimeout(timer); }
  }
}
