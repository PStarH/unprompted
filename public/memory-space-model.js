// Pure presentation model for the Memory Space.
//
// Every function here is a deterministic function of the records and options
// the caller supplies. There is no DOM access, no timer, no random value, no
// physics simulation and no similarity/embedding inference. The UI controller
// reads records, calls this module, and renders the returned data.
//
// A record may use the existing task-memory shape:
//
//   { id, text, taskId, scope: { entity, deliverable }, createdAt,
//     updatedAt, deletedAt, origin }
//
// It may also carry presentation metadata:
//
//   { content, title, sourceTaskId, sourceTask: { id, title },
//     relatedTerms: ['budget'], evidence: [{ id, title }],
//     relations: [{ targetId, status: 'established' | 'suggested',
//                   kind, label, evidence }],
//     expiresAt, supersededBy, status }
//
// `status`, `searchText`, `scope`, `sourceTask`, `relatedTerms`, `relations`
// and `evidenceRefs` are derived on every normalization; supplied life-cycle
// fields are preserved but the status is always recomputed.

export const MEMORY_LIST_MAX = 500;
export const MEMORY_GRAPH_MAX_NODES = 32;
export const MEMORY_GRAPH_MAX_EDGES = 48;
export const MEMORY_MAX_DEPTH = 2;

export const MEMORY_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded',
  DISABLED: 'disabled',
  ARCHIVED: 'archived',
  DELETED: 'deleted'
});

export const MEMORY_SORTS = Object.freeze(['recent', 'oldest', 'content', 'scope']);

const STATUS_VALUES = new Set(Object.values(MEMORY_STATUS));
const SUGGESTED_RELATION_STATUSES = new Set(['suggested', 'inferred', 'proposed', 'candidate', 'probable', 'uncertain']);
const SORT_VALUES = new Set(MEMORY_SORTS);

const isObject = value => value !== null && typeof value === 'object';
const firstText = (...values) => {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
};
const compareStrings = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const normalizeText = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const queryTokens = query => normalizeText(query).match(/[\p{L}\p{N}]+/gu) || [];
const toTime = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : Number.NaN;
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  return Number.NaN;
};
const round = value => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const clampInteger = (value, maximum, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(1, Math.trunc(number))) : fallback;
};
const clampDepth = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(MEMORY_MAX_DEPTH, Math.max(0, Math.trunc(number))) : 1;
};
const uniqueStrings = values => {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text && !seen.has(text)) { seen.add(text); result.push(text); }
  }
  return result;
};
const humanize = value => {
  const text = String(value ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Related';
};
const excerpt = (value, maximum = 80) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const characters = [...text];
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : text;
};

function evidenceTexts(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(evidenceTexts);
  if (isObject(value)) {
    const text = firstText(value.label, value.title, value.detail, value.summary, value.text, value.id);
    return text ? [text] : [];
  }
  return [];
}

function collectRelatedTerms(record) {
  const values = [];
  const add = value => {
    if (typeof value === 'string') { values.push(value); return; }
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (value instanceof Set) { value.forEach(add); return; }
    if (isObject(value)) { const text = firstText(value.label, value.name, value.value); if (text) values.push(text); }
  };
  const keys = ['relatedTerms', 'terms', 'tags', 'topics', 'keywords', 'entities'];
  for (const key of keys) add(record[key]);
  if (isObject(record.metadata)) for (const key of keys) add(record.metadata[key]);
  return uniqueStrings(values);
}

function collectEvidenceRefs(record) {
  const refs = new Map();
  const add = value => {
    if (typeof value === 'string') {
      const id = value.trim();
      if (id && !refs.has(id)) refs.set(id, id);
      return;
    }
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (!isObject(value)) return;
    const id = firstText(value.id, value.documentId, value.sourceId, value.externalId, value.url);
    if (!id || refs.has(id)) return;
    refs.set(id, firstText(value.title, value.label, value.name, value.url, id));
  };
  for (const key of ['evidence', 'evidenceRefs', 'evidenceIds', 'sourceRefs', 'sources', 'documentIds']) add(record[key]);
  return [...refs.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => compareStrings(left.id, right.id));
}

function relationStatus(value) {
  return SUGGESTED_RELATION_STATUSES.has(normalizeText(value)) ? 'suggested' : 'established';
}

function normalizeRelations(record, recordId) {
  const raw = record.relations ?? record.related ?? record.edges;
  const entries = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? Object.entries(raw).map(([targetId, value]) => isObject(value) ? { targetId, ...value } : { targetId, status: typeof value === 'string' ? value : undefined })
      : [];
  const relations = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const targetId = entry.trim();
      if (targetId && targetId !== recordId) relations.push({ targetId, status: 'established', kind: 'related', label: 'Related memory', evidence: ['Recorded relation'] });
      continue;
    }
    if (!isObject(entry)) continue;
    let target = entry.targetId ?? entry.target ?? entry.to ?? entry.otherId ?? entry.memoryId ?? entry.id;
    if (target == null && entry.from != null && String(entry.from) === recordId) target = entry.to;
    if (isObject(target)) target = firstText(target.id, target.memoryId);
    const targetId = typeof target === 'string' || typeof target === 'number' ? String(target).trim() : '';
    if (!targetId || targetId === recordId) continue;
    const kind = firstText(entry.kind, entry.type, entry.relation) || 'related';
    const evidence = uniqueStrings([entry.evidence, entry.detail, entry.reason, entry.note].flatMap(evidenceTexts));
    relations.push({
      targetId,
      status: relationStatus(entry.status ?? entry.relationStatus),
      kind,
      label: firstText(entry.label, entry.title) || humanize(kind),
      evidence: evidence.length ? evidence : ['Recorded relation']
    });
  }
  return relations;
}

function searchableText(record) {
  const scope = isObject(record.scope) ? record.scope : {};
  const sourceTask = isObject(record.sourceTask) ? record.sourceTask : {};
  const entity = firstText(scope.entity, scope.project, record.entity, record.scopeEntity, typeof record.scope === 'string' ? record.scope : '');
  const deliverable = firstText(scope.deliverable, scope.resource, scope.output, record.deliverable, record.scopeDeliverable);
  const scopeKey = firstText(scope.key, record.scopeKey, [entity, deliverable].filter(Boolean).join(' / '));
  const sourceTaskId = firstText(sourceTask.id, sourceTask.taskId, record.sourceTaskId, record.taskId);
  const sourceTaskTitle = firstText(sourceTask.title, sourceTask.label, sourceTask.subject, record.sourceTaskTitle, record.taskTitle);
  const relatedTerms = collectRelatedTerms(record);
  return normalizeText([
    record.text, record.content, record.instruction, record.summary, record.title, record.label,
    entity, deliverable, scopeKey, sourceTaskId, sourceTaskTitle, ...relatedTerms
  ].join(' '));
}

export function memoryLifecycle(record, { now = null } = {}) {
  if (!isObject(record)) return MEMORY_STATUS.ACTIVE;
  const lifecycle = isObject(record.lifecycle) ? record.lifecycle : {};
  const lifecycleState = normalizeText(record.lifecycleState ?? lifecycle.state ?? lifecycle.status);
  if (record.deletedAt || record.deleted === true || normalizeText(record.status) === MEMORY_STATUS.DELETED || lifecycleState === MEMORY_STATUS.DELETED) {
    return MEMORY_STATUS.DELETED;
  }
  if (record.supersededBy != null || record.supersededById != null || record.replacedBy != null || record.supersededAt
    || normalizeText(record.status) === MEMORY_STATUS.SUPERSEDED || lifecycleState === MEMORY_STATUS.SUPERSEDED) {
    return MEMORY_STATUS.SUPERSEDED;
  }
  if (['disabled', 'archived'].includes(lifecycleState)) return lifecycleState;
  if (record.expired === true || normalizeText(record.status) === MEMORY_STATUS.EXPIRED || lifecycleState === MEMORY_STATUS.EXPIRED) {
    return MEMORY_STATUS.EXPIRED;
  }
  const expiresAt = record.expiresAt ?? record.validUntil ?? record.expiredAt;
  const expiry = toTime(expiresAt);
  const current = toTime(now);
  if (Number.isFinite(expiry) && Number.isFinite(current) && expiry <= current) return MEMORY_STATUS.EXPIRED;
  return MEMORY_STATUS.ACTIVE;
}

export function normalizeMemoryRecord(record, { now = null } = {}) {
  if (!isObject(record)) return null;
  const rawId = record.id ?? record.memoryId ?? record.key;
  if (rawId == null || !String(rawId).trim()) return null;
  const id = String(rawId);
  const scopeObject = isObject(record.scope) ? record.scope : {};
  const entity = firstText(scopeObject.entity, scopeObject.project, record.entity, record.scopeEntity, typeof record.scope === 'string' ? record.scope : '');
  const deliverable = firstText(scopeObject.deliverable, scopeObject.resource, scopeObject.output, record.deliverable, record.scopeDeliverable);
  const scopeKey = firstText(scopeObject.key, record.scopeKey, [entity, deliverable].filter(Boolean).join(' / '));
  const sourceTaskObject = isObject(record.sourceTask) ? record.sourceTask : {};
  const content = firstText(record.text, record.content, record.instruction, record.summary);
  const title = firstText(record.title, record.label, record.name);
  const normalized = {
    ...record,
    id,
    content,
    title,
    scope: { entity, deliverable, key: scopeKey || null },
    sourceTask: {
      id: firstText(sourceTaskObject.id, sourceTaskObject.taskId, record.sourceTaskId, record.taskId) || null,
      title: firstText(sourceTaskObject.title, sourceTaskObject.label, sourceTaskObject.subject, record.sourceTaskTitle, record.taskTitle) || null
    },
    relatedTerms: collectRelatedTerms(record),
    evidenceRefs: collectEvidenceRefs(record),
    relations: normalizeRelations(record, id),
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    status: memoryLifecycle(record, { now })
  };
  normalized.searchText = searchableText(normalized);
  return normalized;
}

export function normalizeMemoryRecords(records, options = {}) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const normalized = [];
  for (const record of records) {
    const item = normalizeMemoryRecord(record, options);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    normalized.push(item);
  }
  return normalized;
}

export function memoryMatchesQuery(record, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const prepared = record && typeof record.searchText === 'string' ? record : normalizeMemoryRecord(record);
  if (!prepared) return false;
  return tokens.every(token => prepared.searchText.includes(token));
}

function memoryTime(record) {
  const updated = toTime(record.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = toTime(record.createdAt);
  return Number.isFinite(created) ? created : 0;
}

function compareScope(left, right) {
  return compareStrings(normalizeText(left.scope.entity), normalizeText(right.scope.entity))
    || compareStrings(normalizeText(left.scope.deliverable), normalizeText(right.scope.deliverable));
}

function sortNormalized(records, sort = 'recent') {
  const selected = SORT_VALUES.has(sort) ? sort : 'recent';
  return [...records].sort((left, right) => {
    let order = 0;
    if (selected === 'recent') order = memoryTime(right) - memoryTime(left);
    else if (selected === 'oldest') order = memoryTime(left) - memoryTime(right);
    else if (selected === 'content') order = compareStrings(normalizeText(left.content), normalizeText(right.content));
    else order = compareScope(left, right);
    return order || compareStrings(left.id, right.id);
  });
}

export function sortMemoryRecords(records, options = {}) {
  return sortNormalized(normalizeMemoryRecords(records, options), options.sort);
}

function statusFilter(value) {
  if (value == null || value === '') return null;
  const values = (Array.isArray(value) ? value : [value]).map(item => normalizeText(item)).filter(Boolean);
  return values.length ? new Set(values) : null;
}

function filterNormalized(records, {
  query = '',
  scope = null,
  entity = null,
  deliverable = null,
  sourceTaskId = null,
  status = null,
  includeDeleted = false,
  sort = 'recent'
} = {}) {
  const statuses = statusFilter(status);
  const scopeValue = normalizeText(typeof scope === 'string' ? scope : '');
  const scopeObject = isObject(scope) ? scope : {};
  const entityValue = normalizeText(entity ?? scopeObject.entity ?? '');
  const deliverableValue = normalizeText(deliverable ?? scopeObject.deliverable ?? '');
  const scopeKeyValue = normalizeText(scopeObject.key ?? '');
  const sourceTaskValue = normalizeText(sourceTaskId ?? '');
  const matches = records.filter(record => {
    if (!includeDeleted && record.status === MEMORY_STATUS.DELETED) return false;
    if (statuses && !statuses.has(record.status)) return false;
    if (entityValue && normalizeText(record.scope.entity) !== entityValue) return false;
    if (deliverableValue && normalizeText(record.scope.deliverable) !== deliverableValue) return false;
    if (scopeKeyValue && normalizeText(record.scope.key) !== scopeKeyValue) return false;
    if (scopeValue && normalizeText(record.scope.entity) !== scopeValue && normalizeText(record.scope.key) !== scopeValue) return false;
    if (sourceTaskValue && normalizeText(record.sourceTask.id) !== sourceTaskValue) return false;
    if (!memoryMatchesQuery(record, query)) return false;
    return true;
  });
  return sortNormalized(matches, sort);
}

export function filterMemoryRecords(records, options = {}) {
  return filterNormalized(normalizeMemoryRecords(records, options), options);
}

export function searchMemoryRecords(records, query, options = {}) {
  return filterMemoryRecords(records, { ...options, query });
}

function statusCounts(records) {
  const counts = { active: 0, expired: 0, superseded: 0, deleted: 0 };
  for (const record of records) if (STATUS_VALUES.has(record.status)) counts[record.status] += 1;
  return counts;
}

function listOverflow(total, shown, limit) {
  return { limit, shown, hidden: Math.max(0, total - shown) };
}

export function buildMemoryList(records, options = {}) {
  const normalized = normalizeMemoryRecords(records, options);
  const matched = filterNormalized(normalized, options);
  const limit = clampInteger(options.limit, MEMORY_LIST_MAX, MEMORY_LIST_MAX);
  const items = matched.slice(0, limit);
  return {
    items,
    total: matched.length,
    limit,
    counts: statusCounts(matched),
    overflow: listOverflow(matched.length, items.length, limit)
  };
}

function pairKey(leftId, rightId) {
  return leftId < rightId ? `${leftId}\u0000${rightId}` : `${rightId}\u0000${leftId}`;
}

function canonicalPair(leftId, rightId) {
  return leftId < rightId ? [leftId, rightId] : [rightId, leftId];
}

function edgeId(from, to) {
  return `edge:${from}::${to}`;
}

function explicitAdjacency(records, ids) {
  const adjacency = new Map(ids.map(id => [id, new Set()]));
  for (const record of records) {
    for (const relation of record.relations) {
      if (!adjacency.has(relation.targetId)) continue;
      adjacency.get(record.id).add(relation.targetId);
      adjacency.get(relation.targetId).add(record.id);
    }
  }
  return adjacency;
}

function evidenceAdjacency(records) {
  const adjacency = new Map(records.map(record => [record.id, new Set()]));
  const groups = new Map();
  const add = (kind, key, id) => {
    if (!key) return;
    const groupKey = `${kind}\u0000${key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, new Set());
    groups.get(groupKey).add(id);
  };
  for (const record of records) {
    if (record.sourceTask.id) add('shared_source_task', record.sourceTask.id, record.id);
    for (const ref of record.evidenceRefs) add('shared_evidence', ref.id, record.id);
    if (record.scope.key && record.scope.key !== '*' && record.scopeType !== 'global') add('shared_scope', record.scope.key, record.id);
  }
  for (const key of [...groups.keys()].sort(compareStrings)) {
    const ids = [...groups.get(key)].sort(compareStrings);
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex++) {
        adjacency.get(ids[leftIndex]).add(ids[rightIndex]);
        adjacency.get(ids[rightIndex]).add(ids[leftIndex]);
      }
    }
  }
  return adjacency;
}

// Selection order is part of the contract: focus, then explicit neighbours of
// the current hop (sorted by id), then evidence-derived neighbours of that hop
// (sorted by id), then the next hop when depth is 2.
function selectNodeIds(records, focusId, depth) {
  const ids = records.map(record => record.id);
  if (!ids.length) return { order: [], hops: null, requestedFocusId: focusId ?? null, focusMissing: false };
  if (focusId == null || focusId === '') return { order: ids, hops: null, requestedFocusId: null, focusMissing: false };
  if (!ids.includes(focusId)) return { order: ids, hops: null, requestedFocusId: focusId, focusMissing: true };
  const explicit = explicitAdjacency(records, ids);
  const evidence = evidenceAdjacency(records);
  const hops = new Map([[focusId, 0]]);
  const order = [focusId];
  let frontier = [focusId];
  const maximumDepth = clampDepth(depth);
  for (let hop = 1; hop <= maximumDepth && frontier.length; hop++) {
    const discovered = [];
    for (const id of [...frontier].sort(compareStrings)) {
      const neighbours = [...explicit.get(id)].filter(neighbour => !hops.has(neighbour)).sort(compareStrings);
      for (const neighbour of neighbours) {
        hops.set(neighbour, hop);
        order.push(neighbour);
        discovered.push(neighbour);
      }
    }
    for (const id of [...frontier].sort(compareStrings)) {
      const neighbours = [...evidence.get(id)].filter(neighbour => !hops.has(neighbour)).sort(compareStrings);
      for (const neighbour of neighbours) {
        hops.set(neighbour, hop);
        order.push(neighbour);
        discovered.push(neighbour);
      }
    }
    frontier = discovered;
  }
  return { order, hops, requestedFocusId: focusId, focusMissing: false };
}

function relationSort(left, right) {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.kind, right.kind)
    || compareStrings(left.status, right.status)
    || compareStrings(left.evidence.join('\u0000'), right.evidence.join('\u0000'));
}

function makeExplicitEdge(record, relation) {
  const [from, to] = canonicalPair(record.id, relation.targetId);
  const evidence = uniqueStrings(relation.evidence).sort(compareStrings);
  return {
    id: edgeId(from, to),
    from,
    to,
    directed: false,
    source: 'explicit',
    status: relation.status,
    statusLabel: relation.status === 'established' ? 'Established' : 'Suggested',
    kind: relation.kind,
    kinds: [relation.kind],
    title: relation.label || humanize(relation.kind),
    detail: evidence[0] || 'A relation recorded for these memories.',
    evidence
  };
}

function mergeExplicitEdge(edge, relation) {
  edge.status = edge.status === 'established' || relation.status === 'established' ? 'established' : 'suggested';
  edge.statusLabel = edge.status === 'established' ? 'Established' : 'Suggested';
  edge.kinds = uniqueStrings([...edge.kinds, relation.kind]).sort(compareStrings);
  edge.evidence = uniqueStrings([...edge.evidence, ...relation.evidence]).sort(compareStrings);
  edge.detail = edge.evidence[0] || edge.detail;
  return edge;
}

function sourceTaskLabel(record) {
  return record.sourceTask.title || record.sourceTask.id || 'an unnamed task';
}

function scopeLabel(record) {
  return record.scope.key || [record.scope.entity, record.scope.deliverable].filter(Boolean).join(' / ') || 'an unnamed scope';
}

function makeSuggestedEdge(left, right) {
  const signals = [];
  if (left.sourceTask.id && left.sourceTask.id === right.sourceTask.id) {
    const label = sourceTaskLabel(left);
    signals.push({
      kind: 'shared_source_task',
      title: 'Same source task',
      detail: `Both memories come from ${label}.`,
      evidence: [`Same source task: ${label}`]
    });
  }
  const rightEvidence = new Set(right.evidenceRefs.map(ref => ref.id));
  const sharedEvidence = left.evidenceRefs.filter(ref => rightEvidence.has(ref.id));
  if (sharedEvidence.length) {
    const labels = sharedEvidence.map(ref => ref.label || ref.id);
    signals.push({
      kind: 'shared_evidence',
      title: 'Shared evidence',
      detail: `Both memories cite ${labels.join(', ')}.`,
      evidence: sharedEvidence.map(ref => `Evidence: ${ref.label || ref.id}`)
    });
  }
  if (left.scope.key && left.scope.key !== '*' && left.scopeType !== 'global' && left.scope.key === right.scope.key) {
    const label = scopeLabel(left);
    signals.push({
      kind: 'shared_scope',
      title: 'Same saved scope',
      detail: `Both memories belong to ${label}.`,
      evidence: [`Scope: ${label}`]
    });
  }
  if (!signals.length) return null;
  const [from, to] = canonicalPair(left.id, right.id);
  const primary = signals[0];
  return {
    id: edgeId(from, to),
    from,
    to,
    directed: false,
    source: 'derived',
    status: 'suggested',
    statusLabel: 'Suggested',
    kind: primary.kind,
    kinds: signals.map(signal => signal.kind),
    title: primary.title,
    detail: signals.map(signal => signal.detail).join(' '),
    evidence: uniqueStrings(signals.flatMap(signal => signal.evidence))
  };
}

function edgeSort(left, right) {
  const sourceRank = edge => edge.source === 'explicit' ? 0 : 1;
  const statusRank = edge => edge.status === 'established' ? 0 : 1;
  return sourceRank(left) - sourceRank(right)
    || statusRank(left) - statusRank(right)
    || compareStrings(left.kind, right.kind)
    || compareStrings(left.from, right.from)
    || compareStrings(left.to, right.to)
    || compareStrings(left.id, right.id);
}

function layoutPositions(ids, edges, { focusId = null, width = 960, height = 640, nodeWidth = 144 } = {}) {
  const positions = new Map();
  if (!ids.length) return positions;
  const canvasWidth = positiveNumber(width, 960);
  const canvasHeight = positiveNumber(height, 640);
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  const radiusX = Math.max(24, canvasWidth / 2 - nodeWidth / 2 - 12);
  const radiusY = Math.max(24, canvasHeight / 2 - 64);
  const sortedIds = [...ids].sort(compareStrings);

  if (focusId && ids.includes(focusId)) {
    const adjacency = new Map(ids.map(id => [id, []]));
    for (const edge of edges) {
      if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
      adjacency.get(edge.from).push(edge.to);
      adjacency.get(edge.to).push(edge.from);
    }
    for (const neighbours of adjacency.values()) neighbours.sort(compareStrings);
    const distances = new Map([[focusId, 0]]);
    const queue = [focusId];
    while (queue.length) {
      const id = queue.shift();
      for (const neighbour of adjacency.get(id)) {
        if (distances.has(neighbour)) continue;
        distances.set(neighbour, distances.get(id) + 1);
        queue.push(neighbour);
      }
    }
    let maximumConnectedRing = 0;
    for (const distance of distances.values()) maximumConnectedRing = Math.max(maximumConnectedRing, distance);
    const outerRing = maximumConnectedRing + 1;
    const rings = new Map();
    for (const id of sortedIds) {
      const ring = distances.has(id) ? distances.get(id) : outerRing;
      if (!rings.has(ring)) rings.set(ring, []);
      rings.get(ring).push(id);
    }
    const maximumRing = Math.max(0, ...rings.keys());
    for (const [ring, ringIds] of [...rings.entries()].sort((left, right) => left[0] - right[0])) {
      if (ring === 0) {
        for (const id of ringIds) positions.set(id, { x: round(centerX), y: round(centerY), ring });
        continue;
      }
      const ringScale = maximumRing === 0 ? 0 : ring / maximumRing;
      const start = ringIds.length === 4 ? -Math.PI / 4 : -Math.PI / 2;
      ringIds.forEach((id, index) => {
        const angle = start + (Math.PI * 2 * index) / ringIds.length;
        positions.set(id, {
          x: round(centerX + radiusX * ringScale * Math.cos(angle)),
          y: round(centerY + radiusY * ringScale * Math.sin(angle)),
          ring
        });
      });
    }
    return positions;
  }

  if (sortedIds.length === 1) {
    positions.set(sortedIds[0], { x: round(centerX), y: round(centerY), ring: 0 });
    return positions;
  }
  const start = -Math.PI / 2;
  sortedIds.forEach((id, index) => {
    const angle = start + (Math.PI * 2 * index) / sortedIds.length;
    positions.set(id, {
      x: round(centerX + radiusX * Math.cos(angle)),
      y: round(centerY + radiusY * Math.sin(angle)),
      ring: 0
    });
  });
  return positions;
}

function graphFromNormalized(records, options = {}) {
  const maxNodes = clampInteger(options.maxNodes, MEMORY_GRAPH_MAX_NODES, MEMORY_GRAPH_MAX_NODES);
  const maxEdges = clampInteger(options.maxEdges, MEMORY_GRAPH_MAX_EDGES, MEMORY_GRAPH_MAX_EDGES);
  const focusId = options.focusId == null || options.focusId === '' ? null : String(options.focusId);
  const depth = clampDepth(options.depth);
  const selection = selectNodeIds(records, focusId, depth);
  const selectedIds = selection.order.slice(0, maxNodes);
  const selected = new Set(selectedIds);
  const byId = new Map(records.map(record => [record.id, record]));

  const explicitPairs = new Map();
  for (const id of [...selectedIds].sort(compareStrings)) {
    const record = byId.get(id);
    for (const relation of [...record.relations].sort(relationSort)) {
      if (!selected.has(relation.targetId)) continue;
      const key = pairKey(id, relation.targetId);
      const existing = explicitPairs.get(key);
      if (existing) mergeExplicitEdge(existing, relation);
      else explicitPairs.set(key, makeExplicitEdge(record, relation));
    }
  }

  const suggested = [];
  const explicitKeys = new Set(explicitPairs.keys());
  const sortedSelected = [...selectedIds].sort(compareStrings);
  for (let leftIndex = 0; leftIndex < sortedSelected.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < sortedSelected.length; rightIndex++) {
      const leftId = sortedSelected[leftIndex];
      const rightId = sortedSelected[rightIndex];
      if (explicitKeys.has(pairKey(leftId, rightId))) continue;
      if (options.quiet && focusId && leftId !== focusId && rightId !== focusId) continue;
      const edge = makeSuggestedEdge(byId.get(leftId), byId.get(rightId));
      if (edge) suggested.push(edge);
    }
  }

  const explicit = [...explicitPairs.values()].filter(edge => !options.quiet || !focusId || edge.from === focusId || edge.to === focusId || !['belongs_to', 'shared_scope'].includes(edge.kind));
  const candidates = [...explicit, ...suggested].sort(edgeSort);
  const edges = candidates.slice(0, maxEdges);
  const degrees = new Map(selectedIds.map(id => [id, 0]));
  for (const edge of edges) {
    degrees.set(edge.from, (degrees.get(edge.from) || 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) || 0) + 1);
  }
  const positions = layoutPositions(selectedIds, edges, options);
  const nodes = selectedIds.map(id => {
    const record = byId.get(id);
    const degree = degrees.get(id) || 0;
    const position = positions.get(id) || { x: 0, y: 0, ring: 0 };
    return {
      id,
      record,
      label: record.title || excerpt(record.content) || id,
      status: record.status,
      scope: record.scope,
      sourceTask: record.sourceTask,
      hop: selection.hops ? (selection.hops.get(id) ?? null) : null,
      degree,
      isolated: degree === 0,
      x: position.x,
      y: position.y,
      ring: position.ring
    };
  });

  return {
    focusId: focusId && !selection.focusMissing ? focusId : null,
    requestedFocusId: selection.requestedFocusId,
    focusMissing: selection.focusMissing,
    depth: focusId && !selection.focusMissing ? depth : 0,
    nodes,
    edges,
    overflow: {
      nodes: {
        limit: maxNodes,
        shown: nodes.length,
        hidden: Math.max(0, selection.order.length - nodes.length),
        available: records.length
      },
      edges: {
        limit: maxEdges,
        shown: edges.length,
        hidden: Math.max(0, candidates.length - edges.length),
        candidates: candidates.length
      }
    }
  };
}

export function buildMemoryGraph(records, options = {}) {
  const normalized = normalizeMemoryRecords(records, options);
  const visible = options.includeDeleted === true
    ? normalized
    : normalized.filter(record => record.status !== MEMORY_STATUS.DELETED);
  return graphFromNormalized(visible.slice(0, MEMORY_LIST_MAX), options);
}

// The list and the graph share the exact same normalized record objects, so a
// node selected in the graph can be looked up directly in the list without an
// id-only reconciliation step.
export function buildMemorySpace(records, options = {}) {
  const normalized = normalizeMemoryRecords(records, options);
  const matched = filterNormalized(normalized, options);
  const limit = clampInteger(options.limit, MEMORY_LIST_MAX, MEMORY_LIST_MAX);
  const items = matched.slice(0, limit);
  const list = {
    items,
    total: matched.length,
    limit,
    counts: statusCounts(matched),
    overflow: listOverflow(matched.length, items.length, limit)
  };
  const graph = graphFromNormalized(items, options);
  return {
    records: normalized,
    list,
    graph,
    focusId: graph.focusId,
    query: typeof options.query === 'string' ? options.query : '',
    overflow: {
      list: list.overflow,
      nodes: graph.overflow.nodes,
      edges: graph.overflow.edges
    }
  };
}

// Translate already-laid-out nodes so the requested node sits in the middle of
// the viewport. Relative geometry is preserved and only the coordinates move.
export function recenterMemoryPositions(nodes, focusId, { width = 960, height = 640 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const key = focusId == null ? null : String(focusId);
  const focus = list.find(node => node && String(node.id) === key);
  if (!focus || !Number.isFinite(Number(focus.x)) || !Number.isFinite(Number(focus.y))) {
    return list.map(node => ({ ...node }));
  }
  const offsetX = positiveNumber(width, 960) / 2 - Number(focus.x);
  const offsetY = positiveNumber(height, 640) / 2 - Number(focus.y);
  return list.map(node => ({
    ...node,
    x: round(Number(node.x) + offsetX),
    y: round(Number(node.y) + offsetY)
  }));
}

export function createFocusHistory(initialId = null, limit = 20) {
  return pushFocusHistory([], initialId, limit);
}

export function pushFocusHistory(history, focusId, limit = 20) {
  const maximum = clampInteger(limit, 100, 20);
  const items = (Array.isArray(history) ? history : []).filter(item => typeof item === 'string' && item);
  const id = typeof focusId === 'string' && focusId ? focusId : null;
  if (!id || items.at(-1) === id) return items.slice(-maximum);
  return [...items, id].slice(-maximum);
}

export function focusBack(history) {
  const items = (Array.isArray(history) ? history : []).filter(item => typeof item === 'string' && item);
  return items.length > 1 ? items[items.length - 2] : null;
}

/** Optional Explorer graph. Its center is explicit state, independent of selection.
 * No scope, source, wording or proximity creates a memory-to-memory edge. */
export function buildExplorerGraph(detail, { width = 800, height = 500, maxNodes = 9 } = {}) {
  if (!detail?.memory) return { centerId: null, nodes: [], edges: [], hidden: 0 };
  const center = detail.memory;
  const memories = [center, ...(detail.context?.memories || [])];
  const nodes = memories.map(record => ({ id: record.id, kind: 'memory', label: record.content || record.text, record }));
  const edges = (detail.context?.relations || []).filter(edge => edge.status !== 'suggested' && (edge.evidenceKind || edge.evidence?.length)
    && !['shared_scope', 'shared_entity', 'shared_source', 'text_similarity', 'broad_source'].includes(edge.evidenceKind)).map(edge => ({ ...edge }));
  for (const entity of detail.context?.entities || []) {
    nodes.push({ ...entity });
    edges.push({ id: `${center.id}:in:${entity.id}`, from: center.id, to: entity.id, kind: entity.kind === 'person' ? 'about_person' : entity.kind === 'project' ? 'in_project' : 'applies_to_entity', status: 'established', evidenceKind: 'saved_scope', evidenceRef: entity.label });
  }
  for (const source of detail.context?.sources || []) {
    nodes.push({ ...source });
    edges.push({ id: `${center.id}:from:${source.id}`, from: center.id, to: source.id, kind: 'remembered_from', status: 'established', evidenceKind: 'recorded_task', evidenceRef: source.label });
  }
  const unique = [...new Map(nodes.map(node => [node.id, node])).values()];
  // Explore only nodes actually connected to the explicit center.
  const connected = new Set([center.id]);
  for (let hop = 0; hop < 2; hop++) for (const edge of edges) {
    if (connected.has(edge.from) || connected.has(edge.to)) { connected.add(edge.from); connected.add(edge.to); }
  }
  const eligible = unique.filter(node => connected.has(node.id));
  const selected = eligible.slice(0, Math.max(1, maxNodes));
  const allowed = new Set(selected.map(node => node.id));
  const outer = selected.filter(node => node.id !== center.id);
  const radiusX = Math.max(32, width / 2 - (width < 450 ? 66 : 95));
  const radiusY = Math.max(48, height / 2 - 72);
  for (const node of selected) {
    if (node.id === center.id) { node.x = width / 2; node.y = height / 2; continue; }
    const index = outer.indexOf(node);
    const angle = (outer.length === 4 ? -Math.PI / 4 : -Math.PI / 2) + 2 * Math.PI * index / outer.length;
    node.x = Math.round(width / 2 + radiusX * Math.cos(angle));
    node.y = Math.round(height / 2 + radiusY * Math.sin(angle));
  }
  return { centerId: center.id, nodes: selected, edges: edges.filter(edge => allowed.has(edge.from) && allowed.has(edge.to)), hidden: Math.max(0, eligible.length - selected.length) };
}
