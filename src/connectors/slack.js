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
  constructor({ auth, account, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    super({ id: 'slack', kind: 'slack', fetchImpl });
    Object.assign(this, { auth, account, now, live: Boolean(account?.id && auth), shadow: true });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Slack authorization'], detail: 'Read direct messages and group direct messages for the connected Slack user.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['slack.direct_messages'] : [], pagination: [], incremental: this.live ? ['slack.direct_messages'] : [], observation: this.live ? 'poll' : 'none' }; }
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
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: null });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 1, unavailable: false };
  }
  async pull({ cursor = null } = {}) {
    if (!this.live) throw new ConnectorError('Slack is disconnected.', { connectorId: this.id });
    const { teamId, userId } = this.#ids();
    if (!/^T[A-Z0-9]{2,32}$/.test(teamId) || !/^U[A-Z0-9]{2,32}$/.test(userId)) throw new ConnectorError('Slack account identity is incomplete. Reconnect this account.', { connectorId: this.id });
    const oldest = /^\d{10,16}$/.test(String(cursor?.oldest || '')) ? String(cursor.oldest) : String(Math.floor((this.now() - WINDOW_MS) / 1000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const listing = await this.#slack('/api/conversations.list', { types: 'im,mpim', limit: '100', exclude_archived: 'true' }, controller.signal);
      if (!Array.isArray(listing.channels)) throw new ConnectorError('Slack returned an invalid conversation listing.', { connectorId: this.id });
      const conversations = listing.channels.filter(item => item && /^[CDG][A-Z0-9]{2,32}$/.test(item.id) && (item.is_im === true || item.is_mpim === true))
        .sort((left, right) => Number(right.updated || 0) - Number(left.updated || 0)).slice(0, 20);
      const names = new Map();
      const records = [];
      const errors = [];
      let partial = false;
      for (const conversation of conversations) {
        let history;
        try { history = await this.#slack('/api/conversations.history', { channel: conversation.id, oldest, limit: '40', inclusive: 'true' }, controller.signal); }
        catch (error) {
          partial = true;
          errors.push({ scope: 'conversations.history', message: error.message, retryable: error.retryable === true });
          if (error.retryable) break;
          continue;
        }
        if (!Array.isArray(history.messages)) {
          partial = true;
          errors.push({ scope: 'conversations.history', message: 'Slack returned an invalid message listing.', retryable: false });
          continue;
        }
        for (const message of history.messages) {
          if (message?.subtype || message?.user === userId || typeof message?.text !== 'string' || !message.text.trim()) continue;
          if (!/^U[A-Z0-9]{2,32}$/.test(message.user || '') || !/^\d{10}(?:\.\d{1,6})?$/.test(message.ts || '')) continue;
          let name = names.get(message.user);
          if (!name && names.size < 30) {
            try {
              const info = await this.#slack('/api/users.info', { user: message.user }, controller.signal);
              name = plain(info.user?.profile?.display_name || info.user?.profile?.real_name || info.user?.real_name, 'Slack');
            } catch { name = 'Slack'; }
            names.set(message.user, name);
          }
          name = name || 'Slack';
          const receivedAt = new Date(Number(message.ts) * 1000).toISOString();
          records.push({ type: 'email.received', providerEventId: `dm:${teamId}:${conversation.id}:${message.ts}`, at: receivedAt,
            payload: { id: `slack:${teamId}:${conversation.id}:${message.ts}`, threadId: `slack:${teamId}:${conversation.id}`,
              from: name, subject: conversation.is_mpim ? `Group message from ${name}` : `Message from ${name}`, body: message.text.slice(0, 8000),
              receivedAt, connectorId: this.id, accountId: this.account.id } });
        }
      }
      const nextOldest = partial ? oldest : String(Math.floor(this.now() / 1000));
      return { events: toNormalizedEvents(this.id, 'slack', records), cursor: { oldest: nextOldest }, partial, errors, hasMore: false };
    } finally { clearTimeout(timer); }
  }
}
