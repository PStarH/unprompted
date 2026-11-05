import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { digest } from './local-snapshot.js';
import { emailPrincipalRole } from './principal-role.js';
import { NativeAccessError, NativeSourceBridge } from '../native-sources.js';

export const MAIL_WINDOW = Object.freeze({ pastDays: 7, perMailbox: 40, maxMessages: 200, maxBody: 24000 });
const text = (value, max) => typeof value === 'string' && value.length <= max;
const addresses = value => value == null ? null : Array.isArray(value) && value.every(item => text(item, 320)) ? value : undefined;

function messageEvent(scopeId, item, version) {
  const id = `apple_mail:${scopeId}:${digest(item.id)}`;
  const to = Array.isArray(item.to) ? item.to : [];
  const cc = Array.isArray(item.cc) ? item.cc : [];
  return { type: 'email.received', providerEventId: `mail:${scopeId}:${digest(item.id)}`, providerRevision: version, at: item.receivedAt,
    meta: emailPrincipalRole(item.accountEmail || '', Array.isArray(item.to) ? item.to : null, Array.isArray(item.cc) ? item.cc : null),
    payload: { id, threadId: `apple_mail:${scopeId}:${digest(item.threadId || item.id)}`, from: item.from, to: to.join(', '), cc: cc.join(', '),
      subject: item.subject, body: item.body, receivedAt: item.receivedAt, updatedAt: item.updatedAt || item.receivedAt, connectorId: 'apple_mail', accountId: scopeId } };
}

/** Messages that leave a selected mailbox while still inside the window are withdrawn. Mail that merely ages out stays in history. */
export function mailSnapshot({ scopeId, records, cursor = null, complete = true, windowStart, now = Date.now, errors = [], lossReason = null }) {
  const previous = { ...(cursor?.messages || {}) }, next = { ...previous }, seen = new Set(), produced = [];
  for (const item of records) {
    const id = `apple_mail:${scopeId}:${digest(item.id)}`;
    seen.add(id);
    const version = digest([item.subject, item.body, item.from, item.receivedAt, item.updatedAt, item.folderId]);
    const known = previous[id];
    next[id] = { providerId: item.id, folderId: item.folderId, accountId: item.accountId, version, receivedAt: item.receivedAt, subject: item.subject, connectorId: 'apple_mail' };
    if (known?.version === version) continue;
    produced.push(messageEvent(scopeId, item, version));
  }
  const windowMs = Date.parse(windowStart);
  if (complete) for (const [id, known] of Object.entries(previous)) {
    if (seen.has(id)) continue;
    const received = Date.parse(known.receivedAt);
    delete next[id];
    if (!lossReason && Number.isFinite(windowMs) && Number.isFinite(received) && received < windowMs) continue;
    produced.push({ type: 'email.unavailable', providerEventId: `mail-removed:${scopeId}:${digest(known.providerId)}`, providerRevision: `removed:${known.version}`, operation: 'delete', at: new Date(now()).toISOString(), payload: { id, reason: lossReason || 'removed' } });
  }
  return { events: toNormalizedEvents('apple_mail', 'apple_mail', produced), cursor: { messages: next, counts: { messages: Object.keys(next).length } }, partial: !complete || errors.length > 0, errors };
}

export function removedMailEvents({ scopeId, cursor, allowed, now = Date.now }) {
  const messages = { ...(cursor?.messages || {}) }, removed = [];
  for (const [id, known] of Object.entries(messages)) {
    if (scopeId && allowed.has(known.folderId)) continue;
    delete messages[id];
    removed.push({ type: 'email.unavailable', providerEventId: `mail-removed:${scopeId || 'disconnected'}:${digest(known.providerId)}`, providerRevision: `scope:${known.version}`, operation: 'delete', at: new Date(now()).toISOString(), payload: { id, reason: 'scope_removed' } });
  }
  if (!removed.length) return { events: [], cursor };
  return { events: toNormalizedEvents('apple_mail', 'apple_mail', removed), cursor: { ...cursor, messages, counts: { messages: Object.keys(messages).length } } };
}

export class AppleMailConnector extends Connector {
  constructor({ scopeId, folders = [], bridge = new NativeSourceBridge(), baseUrl = '', now = Date.now } = {}) {
    super({ id: 'apple_mail', kind: 'apple_mail' });
    Object.assign(this, { scopeId, folders, bridge, baseUrl, now, live: Boolean(scopeId && folders.length && bridge.platform === 'darwin'), shadow: true,
      account: { id: scopeId, label: 'Selected Apple Mail mailboxes' } });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Selected mailbox'], detail: 'Read a bounded window of messages in selected mailboxes. Sending, deleting, and editing stay off.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['mail.selected_mailboxes'] : [], observation: this.live ? 'poll' : 'none', write: [] }; }
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: null });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 0, unavailable: false };
  }
  #since() { return new Date(this.now() - MAIL_WINDOW.pastDays * 86400_000).toISOString(); }
  async pull({ cursor = null, signal } = {}) {
    if (!this.live) throw new ConnectorError('No mailbox is connected.', { connectorId: this.id });
    const since = this.#since();
    let result;
    try { result = await this.bridge.readMail(this.folders, { since }, { signal }); }
    catch (error) {
      const message = error instanceof NativeAccessError ? error.message : 'Mail could not be read. Check Automation access and try again.';
      const failure = [{ scope: 'mail', message, retryable: true }];
      const previous = cursor?.messages || {};
      if (!Object.keys(previous).length) return { events: [], cursor, partial: true, errors: failure };
      return mailSnapshot({ scopeId: this.scopeId, records: [], cursor, complete: true, windowStart: since, now: this.now, lossReason: 'permission_or_access_lost', errors: failure });
    }
    if (!Array.isArray(result.records) || !Array.isArray(result.errors) || typeof result.complete !== 'boolean') throw new ConnectorError('Mail did not return a valid read result.', { connectorId: this.id });
    const allowed = new Map(this.folders.map(folder => [`${folder.accountId}\0${folder.folderId}`, folder]));
    const records = [];
    for (const item of result.records) {
      const folder = allowed.get(`${item.accountId}\0${item.folderId}`);
      const to = addresses(item.to), cc = addresses(item.cc);
      if (!folder || !text(item.id, 4096) || !item.id || !text(item.from, 500) || !item.from || !text(item.subject, 500) || !item.subject || !text(item.body, MAIL_WINDOW.maxBody) || !item.body || !Number.isFinite(Date.parse(item.receivedAt)) || to === undefined || cc === undefined) throw new ConnectorError('Mail returned a message outside the selected mailboxes or with incomplete metadata.', { connectorId: this.id });
      if (Date.parse(item.receivedAt) < Date.parse(since)) continue;
      records.push({ ...item, accountEmail: folder.accountEmail || item.accountEmail || '' });
    }
    let complete = result.complete;
    if (records.length > MAIL_WINDOW.maxMessages) { records.length = MAIL_WINDOW.maxMessages; complete = false; }
    return mailSnapshot({ scopeId: this.scopeId, records, cursor, complete, windowStart: since, now: this.now,
      errors: result.errors.map(() => ({ scope: 'mail', message: 'Some selected mailboxes could not be read completely. Check access or choose fewer mailboxes.', retryable: true })) });
  }
}
