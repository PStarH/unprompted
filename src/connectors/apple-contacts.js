import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { digest } from './local-snapshot.js';
import { NativeAccessError, NativeSourceBridge } from '../native-sources.js';

export const CONTACTS_LIMITS = Object.freeze({ maxPeople: 400, maxNote: 8000, lookup: 20 });
const text = (value, max) => typeof value === 'string' && value.length <= max;
const list = (value, max) => Array.isArray(value) && value.length <= 12 && value.every(item => text(item, 320));

export function contactContent(item) {
  return [item.name, item.organization ? `Organization: ${item.organization}` : '', item.emails?.length ? `Email: ${item.emails.join(', ')}` : '', item.phones?.length ? `Phone: ${item.phones.join(', ')}` : '', item.note || ''].filter(Boolean).join('\n').slice(0, 32000);
}

export function contactSnapshot({ scopeId, records, cursor = null, complete = true, now = Date.now, baseUrl = '', errors = [], lossReason = null }) {
  const previous = { ...(cursor?.documents || {}) }, next = { ...previous }, seen = new Set(), produced = [];
  const at = new Date(now()).toISOString();
  for (const item of records) {
    const id = `apple_contacts:${scopeId}:${digest(item.id)}`;
    seen.add(id);
    const content = contactContent(item);
    const version = digest(`${item.name}\0${content}\0${item.updatedAt}\0${item.folderId}`);
    const known = previous[id];
    if (known?.version === version && !known.unavailable) { next[id] = known; continue; }
    const revision = (known?.observationRevision || 0) + 1;
    const url = `${baseUrl}/api/local-sources/documents/${encodeURIComponent(id)}`;
    produced.push({ type: 'document.modified', providerEventId: `contact:${id}`, providerRevision: `${revision}:${version}`, at: item.updatedAt || at,
      payload: { id, title: item.name, content, kind: 'contact', modifiedAt: item.updatedAt || at, sourceObservationRevision: revision, externalId: id, url } });
    next[id] = { providerId: item.id, folderId: item.folderId, accountId: item.accountId, title: item.name, version, observationRevision: revision, unavailable: null, connectorId: 'apple_contacts' };
  }
  if (complete) for (const [id, known] of Object.entries(previous)) {
    if (seen.has(id) || known.unavailable) continue;
    const revision = (known.observationRevision || 0) + 1;
    const reason = lossReason || 'removed_or_unshared';
    produced.push({ type: 'document.unavailable', providerEventId: `contact:${id}`, providerRevision: `${revision}:${reason}`, operation: 'delete', at,
      payload: { id, title: known.title, reason, modifiedAt: at, sourceObservationRevision: revision } });
    next[id] = { ...known, unavailable: reason, observationRevision: revision };
  }
  return { events: toNormalizedEvents('apple_contacts', 'apple_contacts', produced), cursor: { documents: next, counts: { documents: Object.keys(next).length } }, partial: !complete || errors.length > 0, errors };
}

export function normalizeContactMatch(scopeId, item) {
  return { id: `apple_contacts:${scopeId}:${digest(item.id)}`, name: item.name, organization: item.organization || '', emails: item.emails || [], phones: item.phones || [], updatedAt: item.updatedAt };
}

export class AppleContactsConnector extends Connector {
  constructor({ scopeId, folders = [], bridge = new NativeSourceBridge(), baseUrl = '', now = Date.now } = {}) {
    super({ id: 'apple_contacts', kind: 'apple_contacts' });
    Object.assign(this, { scopeId, folders, bridge, baseUrl, now, live: Boolean(scopeId && folders.length && bridge.platform === 'darwin'), shadow: true,
      account: { id: scopeId, label: 'Selected Apple Contacts groups' } });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Selected contact group'], detail: 'Read selected contact groups for evidence and entity lookup. The address book is not modified.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['contacts.selected_groups'] : [], search: this.live ? ['contacts.lookup'] : [], observation: this.live ? 'poll' : 'none', write: [] }; }
  #accept(item, folder) {
    if (!folder || item.accountId !== folder.accountId || !text(item.id, 4096) || !item.id || !text(item.name, 250) || !item.name || !text(item.organization || '', 250) || !list(item.emails || [], 12) || !list(item.phones || [], 12) || !text(item.note || '', CONTACTS_LIMITS.maxNote) || !Number.isFinite(Date.parse(item.updatedAt))) throw new ConnectorError('Contacts returned a person outside the selected groups or with incomplete metadata.', { connectorId: this.id });
  }
  /** Live lookup for entity resolution. Task tools call this as lookup_contact; observation still uses pull(). */
  async lookup(query, { signal } = {}) {
    if (!this.live) throw new ConnectorError('Contacts is not connected.', { connectorId: this.id, status: 403 });
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) throw new ConnectorError('Enter a name, email, or phone number to look up.', { connectorId: this.id, status: 400 });
    let result;
    try { result = await this.bridge.lookupContacts(this.folders, query.trim(), { signal }); }
    catch (error) { throw new ConnectorError(error instanceof NativeAccessError ? error.message : 'Contacts could not be searched. Check Automation access and try again.', { connectorId: this.id, retryable: true }); }
    if (!Array.isArray(result.records)) throw new ConnectorError('Contacts returned an invalid lookup.', { connectorId: this.id });
    const allowed = new Map(this.folders.map(folder => [folder.folderId, folder]));
    const items = [];
    for (const item of result.records) {
      const folder = allowed.get(item.folderId);
      this.#accept(item, folder);
      if (items.length >= CONTACTS_LIMITS.lookup) break;
      items.push(normalizeContactMatch(this.scopeId, item));
    }
    return { query: query.trim(), items, complete: result.complete !== false && result.records.length <= CONTACTS_LIMITS.lookup };
  }
  search(input, context) { return this.lookup(input?.query, context); }
  async pull({ cursor = null, signal } = {}) {
    if (!this.live) throw new ConnectorError('No contact group is connected.', { connectorId: this.id });
    let result;
    try { result = await this.bridge.readContacts(this.folders, { signal }); }
    catch (error) {
      const message = error instanceof NativeAccessError ? error.message : 'Contacts could not be read. Check Automation access and try again.';
      const errors = [{ scope: 'contacts', message, retryable: true }];
      if (!(error instanceof NativeAccessError) || error.code !== 'AUTOMATION_DENIED') return { events: [], cursor, partial: true, errors };
      if (!Object.keys(cursor?.documents || {}).length) return { events: [], cursor, partial: true, errors };
      return contactSnapshot({ scopeId: this.scopeId, records: [], cursor, complete: true, now: this.now, baseUrl: this.baseUrl, lossReason: 'permission_or_access_lost', errors });
    }
    if (!Array.isArray(result.records) || !Array.isArray(result.errors) || typeof result.complete !== 'boolean') throw new ConnectorError('Contacts did not return a valid read result.', { connectorId: this.id });
    const allowed = new Map(this.folders.map(folder => [folder.folderId, folder]));
    const records = [];
    for (const item of result.records) { this.#accept(item, allowed.get(item.folderId)); records.push(item); }
    let complete = result.complete;
    if (records.length > CONTACTS_LIMITS.maxPeople) { records.length = CONTACTS_LIMITS.maxPeople; complete = false; }
    return contactSnapshot({ scopeId: this.scopeId, records, cursor, complete, now: this.now, baseUrl: this.baseUrl,
      errors: result.errors.map(() => ({ scope: 'contacts', message: 'Some selected contact groups could not be read completely. Check access or choose a smaller group.', retryable: true })) });
  }
}
