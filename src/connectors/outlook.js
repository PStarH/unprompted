import { createHash } from 'node:crypto';
import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { providerJSON } from './http.js';
import { emailPrincipalRole } from './principal-role.js';

const ORIGIN = 'https://graph.microsoft.com';
const DELTA = '/v1.0/me/mailFolders/inbox/messages/delta';
const INBOX_DELTA = /^\/v1\.0\/me\/mailfolders\/inbox\/messages\/delta$/i;
const QUOTED_DELTA = /^\/v1\.0\/me\/mailfolders\('([^']*)'\)\/messages\/delta$/i;
const PLAIN_DELTA = /^\/v1\.0\/me\/mailfolders\/([^/]+)\/messages\/delta$/i;

/** Graph rewrites the inbox delta onto the folder id. Only that folder, or the well-known inbox name, may be followed. */
function outlookDeltaTarget(url) {
  if (!(url instanceof URL) || url.origin !== ORIGIN || url.username || url.password || url.hash) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (pathname.includes('\\') || pathname.includes('..')) return null;
  if (INBOX_DELTA.test(pathname)) return { kind: 'inbox' };
  const quoted = pathname.match(QUOTED_DELTA);
  const plain = pathname.match(PLAIN_DELTA);
  if (quoted && quoted[1].toLowerCase() === 'inbox') return { kind: 'inbox' };
  const id = quoted ? quoted[1] : plain && plain[1].toLowerCase() !== 'inbox' ? plain[1] : null;
  if (!id) return null;
  return { kind: 'id', id };
}
function textBody(body) {
  const content = String(body?.content || '');
  if (String(body?.contentType).toLowerCase() !== 'html') return content;
  // Extract text rather than attempting to sanitize HTML. This result is still
  // untrusted source text and must be escaped by every HTML renderer.
  let text = '', offset = 0, ignored = null;
  while (offset < content.length) {
    if (content.startsWith('<!--', offset)) {
      const end = content.indexOf('-->', offset + 4);
      offset = end < 0 ? content.length : end + 3;
      continue;
    }
    if (content[offset] !== '<') {
      if (!ignored) text += content[offset];
      offset++;
      continue;
    }
    let end = offset + 1, quote = null;
    for (; end < content.length; end++) {
      const character = content[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === content.length) { if (!ignored) text += content.slice(offset); break; }
    const tag = content.slice(offset + 1, end).trim();
    const match = tag.match(/^(\/?)\s*([a-z][a-z0-9:-]*)/i);
    const closing = match?.[1] === '/', name = match?.[2]?.toLowerCase();
    if (ignored) { if (closing && name === ignored) ignored = null; }
    else if (!closing && (name === 'script' || name === 'style')) ignored = name;
    else if (name === 'br' || closing && ['p', 'div', 'li'].includes(name)) text += '\n';
    offset = end + 1;
  }
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity, name) => {
    const key = name.toLowerCase();
    if (key[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key];
    const point = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : entity;
  });
}

export class OutlookConnector extends Connector {
  constructor({ auth, account, scopes = [], fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    super({ id: 'microsoft', kind: 'outlook', fetchImpl });
    Object.assign(this, { auth, account, scopes: [...scopes], now, live: Boolean(account?.id && auth), shadow: true });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Microsoft authorization'], detail: 'Read Outlook inbox messages using Microsoft Graph delta sync.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['outlook.inbox'] : [], pagination: this.live ? ['outlook.delta'] : [], incremental: this.live ? ['outlook.created_messages'] : [], observation: this.live ? 'poll' : 'none' }; }
  #initialUrl({ recovery = false } = {}) {
    const url = new URL(DELTA, ORIGIN);
    url.searchParams.set('$select', 'id,conversationId,subject,body,from,toRecipients,ccRecipients,receivedDateTime,lastModifiedDateTime,webLink');
    // A reset must cover the outage, including mail older than three days.
    if (!recovery) url.searchParams.set('$filter', `receivedDateTime ge ${new Date(this.now() - 3 * 86400_000).toISOString()}`);
    return url;
  }
  /** Re-read one source message before an action that depends on it. A message in Deleted Items counts as deleted. */
  async sourceMessageState(id) {
    const prefix = `microsoft:${this.account?.id}:`;
    if (!this.live || typeof id !== 'string' || !id.startsWith(prefix) || id.length === prefix.length) return { status: 'unknown' };
    const token = await this.auth.accessToken();
    const read = target => providerJSON(new URL(target, ORIGIN).href, { provider: this.id, origin: ORIGIN, fetchImpl: this.fetchImpl,
      headers: { authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' } });
    let message;
    try { message = await read(`/v1.0/me/messages/${encodeURIComponent(id.slice(prefix.length))}?$select=id,parentFolderId`); }
    catch (error) { if (error.status === 404) return { status: 'missing', reason: 'deleted' }; throw error; }
    const deleted = await read('/v1.0/me/mailFolders/deleteditems?$select=id');
    return message?.parentFolderId && message.parentFolderId === deleted?.id ? { status: 'missing', reason: 'deleted' } : { status: 'present' };
  }
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: { recovering: true } });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 1, unavailable: false };
  }
  async #inboxFolderId(token) {
    if (this.inboxFolderId) return this.inboxFolderId;
    const data = await providerJSON(new URL('/v1.0/me/mailFolders/inbox?$select=id', ORIGIN).href, { provider: this.id, origin: ORIGIN, fetchImpl: this.fetchImpl,
      headers: { authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' } });
    if (typeof data?.id !== 'string' || !data.id) throw new ConnectorError('Outlook inbox folder could not be confirmed.', { connectorId: this.id });
    this.inboxFolderId = data.id;
    return data.id;
  }
  async #continuationAllowed(url, token) {
    const target = outlookDeltaTarget(url);
    if (!target) return false;
    if (target.kind === 'inbox') return true;
    return target.id === await this.#inboxFolderId(token);
  }
  async pull({ cursor = null } = {}) {
    if (!this.live) throw new ConnectorError('Microsoft Outlook is disconnected.', { connectorId: this.id });
    const token = await this.auth.accessToken();
    let url;
    if (cursor?.resumeUrl) {
      url = new URL(cursor.resumeUrl);
      if (!await this.#continuationAllowed(url, token)) throw new ConnectorError('Outlook continuation URL is invalid.', { connectorId: this.id });
    } else {
      url = this.#initialUrl({ recovery: cursor?.recovering === true });
    }
    const request = target => providerJSON(target.href, { provider: this.id, origin: ORIGIN, fetchImpl: this.fetchImpl,
      headers: { authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text", IdType="ImmutableId", odata.maxpagesize=50' } });
    let data, recovering = cursor?.recovering === true;
    try { data = await request(url); }
    catch (error) {
      if (!cursor?.resumeUrl || !(error.status === 410 || error.providerCode === 'syncStateNotFound')) throw error;
      // Ignore the provider's Location header and rebuild a fixed-origin query.
      // Existing event IDs make replay safe. A failed reset never commits a cursor.
      recovering = true;
      data = await request(this.#initialUrl({ recovery: true }));
    }
    if (!Array.isArray(data.value)) throw new ConnectorError('Outlook returned an invalid message listing.', { connectorId: this.id });
    const records = [];
    for (const message of data.value) {
      if (message['@removed']) {
        // Graph reports deletes and moves out of the inbox as a tombstone with
        // only the id. Pass it on so local work stops relying on the message.
        if (typeof message.id !== 'string' || !message.id) throw new ConnectorError('Outlook returned an incomplete removal. The cursor was not advanced.', { connectorId: this.id });
        records.push({ type: 'email.unavailable', providerEventId: `mail-removed:${this.account.id}:${message.id}`, providerRevision: createHash('sha256').update(url.href).digest('hex'), operation: 'delete', at: new Date(this.now()).toISOString(),
          payload: { id: `microsoft:${this.account.id}:${message.id}`, reason: String(message['@removed'].reason || 'removed').slice(0, 80) } });
        continue;
      }
      const from = message.from?.emailAddress?.address;
      const body = textBody(message.body);
      if (!message.id || typeof from !== 'string' || !from || !Number.isFinite(Date.parse(message.receivedDateTime))) throw new ConnectorError('Outlook returned an incomplete message. The cursor was not advanced.', { connectorId: this.id });
      if (!body.trim()) continue;
      let sourceUrl = null;
      try { const link = new URL(message.webLink); if (link.protocol === 'https:' && ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'].includes(link.hostname)) sourceUrl = link.href; } catch { /* no clickable provider URL */ }
      const to = Array.isArray(message.toRecipients) ? message.toRecipients.map(item => item?.emailAddress?.address) : null;
      const cc = Array.isArray(message.ccRecipients) ? message.ccRecipients.map(item => item?.emailAddress?.address) : null;
      records.push({ type: 'email.received', providerEventId: `mail:${this.account.id}:${message.id}`, providerRevision: message['@odata.etag'] || message.lastModifiedDateTime || null, at: new Date(message.receivedDateTime).toISOString(),
        meta: emailPrincipalRole(this.account.label, to, cc),
        payload: { id: `microsoft:${this.account.id}:${message.id}`, threadId: `microsoft:${this.account.id}:${message.conversationId || message.id}`,
          from, to: to ? to.filter(Boolean).join(', ') : '', cc: cc ? cc.filter(Boolean).join(', ') : '', subject: String(message.subject || '(no subject)'), body,
          updatedAt: message.lastModifiedDateTime || message.receivedDateTime,
          receivedAt: new Date(message.receivedDateTime).toISOString(), connectorId: this.id, accountId: this.account.id,
          sourceUrl, providerMessageId: message.id } });
    }
    const resumeUrl = data['@odata.nextLink'] || data['@odata.deltaLink'];
    if (typeof resumeUrl !== 'string') throw new ConnectorError('Outlook did not return a delta checkpoint.', { connectorId: this.id });
    const next = new URL(resumeUrl);
    if (!await this.#continuationAllowed(next, token)) throw new ConnectorError('Outlook returned an invalid continuation URL.', { connectorId: this.id });
    if (data['@odata.nextLink'] && next.href === url.href) throw new ConnectorError('Outlook returned a non-advancing continuation.', { connectorId: this.id, retryable: true });
    return { events: toNormalizedEvents(this.id, 'microsoft', records), cursor: { resumeUrl, ...(recovering && data['@odata.nextLink'] ? { recovering: true } : {}) }, partial: false, errors: [], hasMore: Boolean(data['@odata.nextLink']) };
  }
}
