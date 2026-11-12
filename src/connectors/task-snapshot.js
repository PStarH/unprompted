import { createHash } from 'node:crypto';
import { toNormalizedEvents } from './connector.js';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Explicit provider tasks; disappearance is applied only after a complete scan. */
export function taskSnapshot({ connectorId, accountId, items, cursor = null, complete, seen = [], now = Date.now, baseUrl = '' }) {
  const known = { ...(cursor?.items || {}) }, records = [], observed = new Set(seen);
  const at = new Date(now()).toISOString();
  const emit = item => {
    const id = `${connectorId}:${accountId}:${item.id}`, previous = known[item.id];
    const fingerprint = digest(item);
    observed.add(item.id);
    if (previous?.fingerprint === fingerprint) return;
    const revision = (previous?.revision || 0) + 1;
    const documentId = `${connectorId}:${accountId}:document:${item.id}`;
    const url = item.url || `${baseUrl}/api/local-sources/documents/${encodeURIComponent(documentId)}`;
    const payload = { id, title: item.title, state: item.state, accountId, documentId, documentTitle: item.list || connectorId,
      line: 1, sourceObservationRevision: revision, updatedAt: item.updatedAt || at, url, dueAt: item.dueAt || null, connectorId };
    records.push({ type: item.state === 'unavailable' ? 'document.unavailable' : 'document.modified', providerEventId: `document:${id}`, providerRevision: `${revision}:${fingerprint}`, at,
      payload: { id: documentId, title: item.title, content: `${item.title}\n${item.body || ''}`, kind: 'document', modifiedAt: item.updatedAt || at, sourceObservationRevision: revision, url, externalId: item.id, reason: item.state === 'unavailable' ? 'removed_or_completed' : undefined } });
    records.push({ type: 'task.observed', providerEventId: `task:${id}`, providerRevision: `${revision}:${fingerprint}`, at, payload });
    known[item.id] = { ...item, fingerprint, revision };
  };
  for (const item of items) emit(item);
  if (complete) for (const [id, item] of Object.entries(known)) if (!observed.has(id) && item.state !== 'unavailable') emit({ ...item, id, fingerprint: undefined, revision: undefined, state: 'unavailable', updatedAt: at });
  return { events: toNormalizedEvents(connectorId, connectorId, records), cursor: { items: known }, partial: !complete, errors: [] };
}
