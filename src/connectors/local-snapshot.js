import { createHash } from 'node:crypto';
import { toNormalizedEvents } from './connector.js';

export const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

/** Only explicit textual to-dos are facts. Ordinary prose is never invented work. */
export function explicitTasks(content) {
  const occurrences = new Map();
  let fenced = false;
  return String(content).split(/\r?\n/).flatMap((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; return []; }
    if (fenced) return [];
    const checkbox = line.match(/^\s*(?:[-*+]\s*)?\[([ xX])\]\s+(.+)$/);
    const unicode = line.match(/^\s*([☐☑☒])\s*(.+)$/);
    const todo = line.match(/^\s*(TODO|DONE|待办|已完成)\s*[:：]\s*(.+)$/i);
    if (!checkbox && !unicode && !todo) return [];
    const title = (checkbox?.[2] || unicode?.[2] || todo?.[2]).trim();
    if (!title || title.length > 500) return [];
    const count = occurrences.get(title) || 0; occurrences.set(title, count + 1);
    return [{ key: digest(`${title}\0${count}`), title, line: index + 1,
      state: checkbox ? checkbox[1] === ' ' ? 'open' : 'closed' : unicode ? unicode[1] === '☐' ? 'open' : 'closed'
        : /^(?:DONE|已完成)$/i.test(todo[1]) ? 'closed' : 'open' }];
  });
}

export function nativeSnapshot({ connectorId, scopeId, documents = [], unavailable = [], cursor = null, complete = true,
  baseUrl = '', now = Date.now, errors = [], counts = {} }) {
  const previous = cursor?.documents || {}, next = new Map(Object.entries(previous)), records = [], seen = new Set();
  const at = new Date(now()).toISOString();
  const reportTaskLimit = title => errors.push({ scope: title, message: 'Only the first 100 explicit to-dos in this document are followed. Split a large list into smaller documents.', retryable: false });
  const pushTask = (doc, task, state = task.state, epoch = null) => {
    const payload = { id: `${doc.id}:todo:${task.key}`, title: task.title, state, documentId: doc.id,
      documentTitle: doc.title, line: task.line, accountId: scopeId, updatedAt: doc.modifiedAt || at,
      sourceObservationRevision: doc.sourceObservationRevision,
      url: `${baseUrl}/api/local-sources/documents/${encodeURIComponent(doc.id)}`, connectorId };
    records.push({ type: 'task.observed', providerEventId: `todo:${payload.id}:${digest(JSON.stringify(payload))}${epoch ? `:restored:${digest(epoch)}` : ''}`, at: payload.updatedAt, payload });
  };
  const lose = (id, known, reason) => {
    if (known.unavailable === reason) return;
    const unavailableAt = new Date(Math.max(now(), Date.parse(known.modifiedAt) + 1 || 0)).toISOString();
    const availabilityRevision = (known.availabilityRevision || 0) + 1;
    const observationRevision = (known.observationRevision || 0) + 1;
    records.push({ type: 'document.unavailable', providerEventId: `unavailable:${id}:${reason}:${availabilityRevision}:${unavailableAt}`, at,
      payload: { id, title: known.title, reason, modifiedAt: unavailableAt, sourceObservationRevision: observationRevision } });
    for (const task of known.tasks || []) pushTask({ id, title: known.title, modifiedAt: unavailableAt, sourceObservationRevision: observationRevision }, task, 'unavailable', `lost:${availabilityRevision}`);
    next.set(id, { ...known, unavailable: reason, unavailableAt, availabilityRevision, observationRevision });
  };
  for (const doc of documents) {
    seen.add(doc.id);
    const known = previous[doc.id];
    if (doc.unchanged && known && !known.unavailable) { if (known.taskLimitExceeded) reportTaskLimit(doc.title); continue; }
    if (typeof doc.content !== 'string') throw new Error('Local source did not return complete text.');
    const version = digest(`${doc.title}\0${doc.content}\0${doc.modifiedAt}\0${doc.folderId || doc.rootId || ''}`);
    if (known?.version === version && !known.unavailable) { if (known.taskLimitExceeded) reportTaskLimit(doc.title); continue; }
    const parsedTasks = explicitTasks(doc.content);
    // Bound the projection and disclose incomplete coverage on every observation.
    const tasks = parsedTasks.slice(0, 100);
    const taskLimitExceeded = parsedTasks.length > tasks.length;
    if (taskLimitExceeded) reportTaskLimit(doc.title);
    const observationRevision = (known?.observationRevision || 0) + 1;
    const epoch = `observation:${observationRevision}`;
    records.push({ type: 'document.modified', providerEventId: `document:${doc.id}:${version}${epoch ? `:restored:${digest(epoch)}` : ''}`,
      at: doc.modifiedAt, payload: { id: doc.id, title: doc.title, content: doc.content,
        kind: 'document', modifiedAt: doc.modifiedAt, sourceObservationRevision: observationRevision, url: `${baseUrl}/api/local-sources/documents/${encodeURIComponent(doc.id)}`,
        externalId: doc.id } });
    const observedDoc = { ...doc, sourceObservationRevision: observationRevision };
    for (const task of tasks) pushTask(observedDoc, task, task.state, epoch);
    for (const task of known?.tasks || []) if (!tasks.some(candidate => candidate.key === task.key)) pushTask(observedDoc, task, 'unavailable', epoch);
    const { content, unchanged, ...metadata } = doc;
    next.set(doc.id, { ...metadata, version, tasks, taskLimitExceeded, observationRevision, unavailable: null, unavailableAt: null, availabilityRevision: known?.availabilityRevision || 0 });
  }
  for (const item of unavailable) {
    seen.add(item.id);
    const known = previous[item.id];
    if (known) lose(item.id, known, item.reason || 'unavailable');
  }
  if (complete) for (const [id, known] of Object.entries(previous)) if (!seen.has(id)) lose(id, known, 'removed_or_unshared');
  return { events: toNormalizedEvents(connectorId, connectorId, records),
    cursor: { documents: Object.fromEntries(next), counts }, partial: !complete || errors.length > 0, errors };
}
