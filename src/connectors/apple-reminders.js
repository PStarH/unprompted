import { Connector, ConnectorError } from './connector.js';
import { taskSnapshot } from './task-snapshot.js';
import { NativeSourceBridge } from '../native-sources.js';
import { createHash, randomBytes } from 'node:crypto';
import { platformRequest } from './platform-api.js';

export const reminderListId = folder => createHash('sha256').update(`${folder.accountId}\0${folder.folderId}`).digest('hex');
const fail = (message, status = 400) => Object.assign(new ConnectorError(message, { connectorId: 'apple_reminders', status }), { status, definitiveNoEffect: true });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validText = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const validTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export class AppleRemindersConnector extends Connector {
  constructor({ scopeId, folders = [], bridge = new NativeSourceBridge(), baseUrl = '', now = Date.now } = {}) {
    super({ id: 'apple_reminders', kind: 'apple_reminders' });
    Object.assign(this, { scopeId, folders, bridge, baseUrl, now, live: Boolean(scopeId && folders.length && bridge.platform === 'darwin'), shadow: true,
      account: { id: scopeId, label: 'Selected Reminders lists' } });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Selected Reminders list'], detail: 'Read reminders in selected macOS lists; writes require separate user authorization.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['reminders.selected_lists'] : [], observation: this.live ? 'poll' : 'none' }; }
  platformCapabilities() {
    return { available: this.live, origin: 'native:apple_reminders', methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      authorization: 'Selected Reminders lists and explicit local action grant', scopeEnforcedBy: 'selected_lists', writesRequireUserGrant: true,
      guide: 'GET /lists; GET /lists/{listId}/reminders; GET /lists/{listId}/reminders/{id}; POST to the reminders collection with {title,body}; PATCH or DELETE an item with {expectedUpdatedAt,...changes}. PATCH changes: title, body, completed, dueAt. IDs and updatedAt come from GET. dueAt is an ISO timestamp.' };
  }
  async requestApi(input, { signal, beforeDispatch = () => {} } = {}) {
    const request = platformRequest(this.id, input);
    if (!this.live) throw fail('Reminders is disconnected.', 403);
    signal?.throwIfAborted();
    const parts = request.path.split('/').filter(Boolean);
    if (request.method === 'GET' && parts.length === 1) {
      beforeDispatch();
      return { status: 200, body: { lists: this.folders.map(folder => ({ id: reminderListId(folder), label: folder.label })) }, responseType: 'json' };
    }
    const folder = this.folders.find(item => reminderListId(item) === parts[1]);
    if (!folder || parts[2] !== 'reminders') throw fail('Choose a selected Reminders list.', 404);
    let reminderId = null;
    if (parts[3]) {
      try {
        reminderId = Buffer.from(parts[3], 'base64url').toString('utf8');
        if (!reminderId || reminderId.length > 4096 || Buffer.from(reminderId).toString('base64url') !== parts[3]) throw new Error();
      } catch { throw fail('Invalid reminder identity.'); }
    }
    const row = item => ({ id: Buffer.from(item.id).toString('base64url'), listId: parts[1], title: item.title, body: item.body,
      completed: item.state === 'closed', dueAt: item.dueAt || null, updatedAt: item.updatedAt });
    if (request.method === 'GET') {
      beforeDispatch();
      const result = await this.bridge.readReminders([folder], { signal });
      if (!result.complete || !Array.isArray(result.records)) throw fail('The selected list could not be read completely.', 503);
      const records = result.records.filter(item => item.accountId === folder.accountId && item.folderId === folder.folderId);
      if (!reminderId) return { status: 200, body: { reminders: records.map(row) }, responseType: 'json' };
      const item = records.find(item => item.id === reminderId);
      if (!item) throw fail('The reminder is unavailable in the selected list.', 404);
      return { status: 200, body: row(item), responseType: 'json' };
    }
    if (!object(request.body)) throw fail('A Reminders action needs an object body.');
    if (request.method === 'POST' && !reminderId) {
      const { title, body } = request.body;
      if (Object.keys(request.body).some(key => !['title', 'body'].includes(key)) || !validText(title, 500) || !title.trim() || /[\r\n]/.test(title) || !validText(body, 64000) || !body.trim()) throw fail('Supply a title and body for the reminder.');
      signal?.throwIfAborted(); beforeDispatch();
      const result = await this.bridge.createReminder(folder, { title, body, marker: `unprompted-artifact:${randomBytes(32).toString('hex')}` }, { signal });
      if (!validText(result?.id, 4096) || !result.id) throw new Error('Reminders did not return an identity; reconcile before retrying.');
      return { status: 201, body: { id: Buffer.from(result.id).toString('base64url'), listId: parts[1] }, responseType: 'json' };
    }
    if (!reminderId || !['PATCH', 'DELETE'].includes(request.method)) throw fail('Choose a supported Reminders action.');
    const { expectedUpdatedAt, ...changes } = request.body;
    if (!validTimestamp(expectedUpdatedAt)) throw fail('Read the reminder first and supply its exact updatedAt value.');
    if (request.method === 'DELETE' && Object.keys(changes).length) throw fail('Deletion only accepts expectedUpdatedAt.');
    if (request.method === 'PATCH' && (!Object.keys(changes).length || Object.keys(changes).some(key => !['title', 'body', 'completed', 'dueAt'].includes(key))
      || Object.hasOwn(changes, 'title') && (!validText(changes.title, 500) || !changes.title.trim() || /[\r\n]/.test(changes.title))
      || Object.hasOwn(changes, 'body') && !validText(changes.body, 64000)
      || Object.hasOwn(changes, 'completed') && typeof changes.completed !== 'boolean'
      || Object.hasOwn(changes, 'dueAt') && !validTimestamp(changes.dueAt))) throw fail('Choose valid reminder changes.');
    signal?.throwIfAborted(); beforeDispatch();
    if (request.method === 'DELETE') await this.bridge.deleteReminder(folder, reminderId, expectedUpdatedAt, { signal });
    else await this.bridge.changeReminder(folder, reminderId, changes, expectedUpdatedAt, { signal });
    return { status: 200, body: { id: parts[3], listId: parts[1] }, responseType: 'json' };
  }
  async pull({ cursor = null, signal } = {}) {
    if (!this.live) throw new ConnectorError('No Reminders list is connected.', { connectorId: this.id });
    const result = await this.bridge.readReminders(this.folders, { signal });
    if (!Array.isArray(result.records) || !Array.isArray(result.errors) || typeof result.complete !== 'boolean') throw new ConnectorError('Reminders returned an invalid read result.', { connectorId: this.id });
    const items = result.records.map(item => {
      if (!this.folders.some(folder => folder.folderId === item.folderId && folder.accountId === item.accountId) || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || !item.title.trim() || !Number.isFinite(Date.parse(item.updatedAt)) || !['open', 'closed'].includes(item.state)) throw new ConnectorError('Reminders returned a record outside selected lists or incomplete metadata.', { connectorId: this.id });
      return { ...item, title: item.title.slice(0, 500), body: String(item.body || '').slice(0, 8000) };
    });
    return { ...taskSnapshot({ connectorId: this.id, accountId: this.scopeId, items, cursor, complete: result.complete, baseUrl: this.baseUrl, now: this.now }), errors: result.errors.map(() => ({ scope: 'reminders', message: 'Some selected Reminders lists could not be read completely.', retryable: true })) };
  }
}
