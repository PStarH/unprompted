import { Connector, ConnectorError } from './connector.js';
import { digest, nativeSnapshot } from './local-snapshot.js';
import { NativeSourceBridge } from '../native-sources.js';

export class AppleNotesConnector extends Connector {
  constructor({ scopeId, folders = [], bridge = new NativeSourceBridge(), baseUrl = '', now = Date.now } = {}) {
    super({ id: 'apple_notes', kind: 'apple_notes' });
    Object.assign(this, { scopeId, folders, bridge, baseUrl, now, live: Boolean(scopeId && folders.length), shadow: true,
      account: { id: scopeId, label: 'Selected Apple Notes folders' } });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Selected Notes folder'], detail: 'Read only selected Notes folders through macOS Automation. Locked notes and attachments are not read.' }; }
  async pull({ cursor = null } = {}) {
    if (!this.live) throw new ConnectorError('No Notes folder is connected.', { connectorId: this.id });
    const previous = cursor?.documents || {}, known = Object.fromEntries(Object.values(previous).map(doc => [`$${doc.providerId}`, { stamp: doc.stamp, folderId: doc.folderId, unavailable: doc.unavailable }]));
    let result;
    try { result = await this.bridge.readNotes(this.folders, known); }
    catch (error) {
      return nativeSnapshot({ connectorId: this.id, scopeId: this.scopeId, cursor, complete: false, now: this.now,
        unavailable: Object.keys(previous).map(id => ({ id, reason: 'permission_or_access_lost' })),
        errors: [{ scope: 'notes', message: error.message, retryable: true }], baseUrl: this.baseUrl });
    }
    if (!Array.isArray(result.records) || !Array.isArray(result.errors) || typeof result.complete !== 'boolean') throw new ConnectorError('Notes did not return a valid complete read result.', { connectorId: this.id });
    const documents = [], unavailable = [], allowed = new Map(this.folders.map(folder => [folder.folderId, folder]));
    for (const item of result.records) {
      const folder = allowed.get(item.folderId);
      if (!folder || item.accountId !== folder.accountId || typeof item.providerId !== 'string' || !item.providerId || item.providerId.length > 4096) throw new ConnectorError('Notes returned a record outside the selected folders.', { connectorId: this.id });
      const id = `apple_notes:${this.scopeId}:${digest(item.providerId)}`;
      if (item.unavailable) { unavailable.push({ id, reason: item.unavailable === 'locked' ? 'locked' : 'too_large' }); continue; }
      if (typeof item.title !== 'string' || !item.title || item.title.length > 1000 || !Number.isFinite(Date.parse(item.modifiedAt)) || (!item.unchanged && (typeof item.content !== 'string' || item.content.length > 512 * 1024))) throw new ConnectorError('Notes returned incomplete text or metadata.', { connectorId: this.id });
      documents.push({ ...item, id });
    }
    for (const [id, doc] of Object.entries(previous)) if (!allowed.has(doc.folderId) || result.errors.some(error => error.folderId === doc.folderId && error.code === 'FOLDER_UNAVAILABLE')) unavailable.push({ id, reason: 'folder_unavailable_or_unshared' });
    return nativeSnapshot({ connectorId: this.id, scopeId: this.scopeId, documents, unavailable, cursor,
      complete: result.complete, now: this.now, baseUrl: this.baseUrl,
      errors: result.errors.map(() => ({ scope: 'notes', message: 'Some selected Notes folders could not be completely read. Check access or select a smaller folder.', retryable: true })),
      counts: { documents: documents.length, lockedOrUnavailable: unavailable.length } });
  }
}
