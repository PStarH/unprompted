import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { providerJSON } from './http.js';

const ORIGIN = 'https://graph.microsoft.com';
const DELTA = '/v1.0/me/mailFolders/inbox/messages/delta';
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
  constructor({ auth, account, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    super({ id: 'microsoft', kind: 'outlook', fetchImpl });
    Object.assign(this, { auth, account, now, live: Boolean(account?.id && auth), shadow: true });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Microsoft authorization'], detail: 'Read Outlook inbox messages using Microsoft Graph delta sync.' }; }
  async pull({ cursor = null } = {}) {
    if (!this.live) throw new ConnectorError('Microsoft Outlook is disconnected.', { connectorId: this.id });
    let url;
    if (cursor?.resumeUrl) {
      url = new URL(cursor.resumeUrl);
      if (url.origin !== ORIGIN || url.pathname.toLowerCase() !== DELTA.toLowerCase()) throw new ConnectorError('Outlook continuation URL is invalid.', { connectorId: this.id });
    } else {
      url = new URL(DELTA, ORIGIN);
      url.searchParams.set('$select', 'id,conversationId,subject,body,from,toRecipients,receivedDateTime,lastModifiedDateTime,webLink');
      url.searchParams.set('$filter', `receivedDateTime ge ${new Date(this.now() - 3 * 86400_000).toISOString()}`);
      url.searchParams.set('changeType', 'created');
    }
    const data = await providerJSON(url.href, { provider: this.id, origin: ORIGIN, fetchImpl: this.fetchImpl,
      headers: { authorization: `Bearer ${await this.auth.accessToken()}`, Prefer: 'outlook.body-content-type="text", IdType="ImmutableId", odata.maxpagesize=50' } });
    if (!Array.isArray(data.value)) throw new ConnectorError('Outlook returned an invalid message listing.', { connectorId: this.id });
    const records = [];
    for (const message of data.value) {
      if (message['@removed']) continue;
      const from = message.from?.emailAddress?.address;
      const body = textBody(message.body);
      if (!message.id || typeof from !== 'string' || !from || !Number.isFinite(Date.parse(message.receivedDateTime))) throw new ConnectorError('Outlook returned an incomplete message. The cursor was not advanced.', { connectorId: this.id });
      if (!body.trim()) continue;
      let sourceUrl = null;
      try { const link = new URL(message.webLink); if (link.protocol === 'https:' && ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'].includes(link.hostname)) sourceUrl = link.href; } catch { /* no clickable provider URL */ }
      records.push({ type: 'email.received', providerEventId: `mail:${this.account.id}:${message.id}`, at: new Date(message.receivedDateTime).toISOString(),
        payload: { id: `microsoft:${this.account.id}:${message.id}`, threadId: `microsoft:${this.account.id}:${message.conversationId || message.id}`,
          from, to: this.account.label, subject: String(message.subject || '(no subject)'), body,
          receivedAt: new Date(message.receivedDateTime).toISOString(), connectorId: this.id, accountId: this.account.id,
          sourceUrl, providerMessageId: message.id } });
    }
    const resumeUrl = data['@odata.nextLink'] || data['@odata.deltaLink'];
    if (typeof resumeUrl !== 'string') throw new ConnectorError('Outlook did not return a delta checkpoint.', { connectorId: this.id });
    const next = new URL(resumeUrl);
    if (next.origin !== ORIGIN || next.pathname.toLowerCase() !== DELTA.toLowerCase()) throw new ConnectorError('Outlook returned an invalid continuation URL.', { connectorId: this.id });
    return { events: toNormalizedEvents(this.id, 'microsoft', records), cursor: { resumeUrl }, partial: false, errors: [] };
  }
}
