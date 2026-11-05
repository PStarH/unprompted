// Read-only retrieval and context projection shared by SQLite and the JSON demo.
// Query interpretation is local lexical matching, not a claimed semantic model.
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/(?<=\d)[,_](?=\d)/g, '').replace(/\s+/g, ' ').trim();
const concepts = [
  ['budget', 'budgets', 'spending', 'spending limit', 'allocate', 'allocated', 'allocation', '预算', '经费'],
  ['prefer', 'prefers', 'preference', 'preferences', '偏好', '喜欢', '习惯'],
  ['correct', 'corrected', 'correction', 'corrections', 'revised', 'superseded', '更正', '纠正', '纠偏', '修正', '替代'],
  ['deadline', 'due', '截止', '交付日期'],
  ['meeting', 'meetings', '会议'],
  ['brief', 'concise', 'short', '简短', '简洁'],
];
const stops = new Set('a an the i my me we our you your it its is are was were be been do did does have has had what which when where why how much who find show tell locate search memory memories remember remembered said say stated expressed agree agreed give gave about for to from in on at of and or with all everything relevant please previously previous ago several some last past weeks week days day months month user during particular project person task conversation recall saved notes details mentioned earlier told us those that this them there regarding any ever originally'.split(' '));
const chineseStops = new Set(['几', '过的', '有', '哪些', '上次', '里', '记得', '记住', '提过', '谈过', '说的', '查询', '当时', '已经', '曾', '那个', '这个', '信息', '事情', '详情', '和', '跟', '与', '能', '有没有', '是否', '哪里', '怎么', '怎样', '我', '的', '你', '他', '她', '了', '过', '是', '吗', '多少', '什么', '之前', '此前', '以前', '几周', '几周前', '几个月', '前', '周', '星期', '最近', '请', '帮', '帮我', '找', '找到', '查找', '搜索', '一下', '有关', '关于', '所有', '相关', '记忆', '项目', '任务', '对话', '曾经', '说', '说过', '提到', '告诉', '给', '中', '在', '预算是多少']);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const conceptFor = term => concepts.find(group => group.includes(term));
const text = memory => memory.content || memory.text || '';
const entityLabel = memory => memory.scope?.entity || (memory.scopeType === 'global' ? '' : memory.scopeKey) || '';
export const isMeaningfulRelation = edge => edge.status !== 'suggested'
  && Boolean(edge.evidenceKind || edge.evidence?.length)
  && !['shared_scope', 'shared_entity', 'shared_source', 'text_similarity', 'broad_source'].includes(edge.evidenceKind);

function termsFor(query, records) {
  let remaining = normalize(query);
  const entities = [...new Set(records.flatMap(memory => [entityLabel(memory), ...(memory.contexts || []).map(context => context.entity)]).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const terms = [];
  for (const entity of entities) {
    const label = normalize(entity);
    if (label.length > 1 && label !== '*' && remaining.includes(label)) { terms.push([label]); remaining = remaining.replaceAll(label, ' '); }
  }
  for (const group of concepts) {
    if (group.some(word => (/[\u3400-\u9fff]/u.test(word) || word.includes(' ')) && remaining.includes(word))) {
      terms.push(group);
      for (const word of [...group].sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(word, ' ');
    }
  }
  for (const item of segmenter.segment(remaining)) {
    const term = normalize(item.segment);
    if (!item.isWordLike || stops.has(term) || chineseStops.has(term)) continue;
    terms.push(conceptFor(term) || [term]);
  }
  return [...new Map(terms.map(group => [group.join('|'), group])).values()].slice(0, 16);
}

/** All explicit query terms must be supported; rank only actual matching fields.
 * Hybrid retrieval may break ties but never invent a match or graph relationship. */
export function rankMemoryResults(records, query, { retrieval = [], now = Date.now() } = {}) {
  const temporal = /(?:several\s+weeks?\s+ago|几周前)/i.test(query) ? { minDays: 14, maxDays: 90 }
    : /(?:last\s+month|上个月)/i.test(query) ? { minDays: 20, maxDays: 60 } : null;
  const needle = normalize(query), terms = termsFor(query, records);
  const hybridRank = new Map(retrieval.map((memory, index) => [memory.id, retrieval.length - index]));
  const results = [];
  for (const memory of records) {
    const ageDays = (Number(now) - Date.parse(memory.createdAt)) / 86400000;
    if (temporal && (!Number.isFinite(ageDays) || ageDays < temporal.minDays || ageDays > temporal.maxDays)) continue;
    const reasons = [];
    const fields = [
      { kind: 'content', value: text(memory), weight: 12 },
      { kind: 'project', value: [entityLabel(memory), memory.scope?.deliverable, ...(memory.contexts || []).map(context => context.entity)].filter(Boolean).join(' '), weight: 10 },
      { kind: 'source', value: [...(memory.sourceTasks || []).flatMap(task => [task.subject, task.title, task.id]), memory.source?.title, memory.source?.id, memory.sourceId].filter(Boolean).join(' '), weight: 8 },
      { kind: 'correction', value: (memory.historyKinds || []).some(kind => ['edit', 'supersede', 'restore-version'].includes(kind)) || memory.supersededBy || memory.isCorrection ? concepts[2].join(' ') : '', weight: 7 },
      { kind: 'preference', value: memory.memoryKind === 'preference' ? concepts[1].join(' ') : '', weight: 7 },
      { kind: 'related', value: (memory.relatedMemories || []).map(item => text(item)).join(' '), weight: 3 },
    ].map(field => ({ ...field, normalized: normalize(field.value) }));
    let score = 0, matched = true;
    for (const alternatives of terms) {
      let found = false;
      for (const field of fields) {
        const term = alternatives.find(term => field.normalized.includes(term));
        if (!term) continue;
        score += field.weight;
        if (!reasons.some(reason => reason.kind === field.kind && reason.term === term)) reasons.push({ kind: field.kind, term, context: field.value.slice(0, 200) });
        found = true; break;
      }
      if (!found) { matched = false; break; }
    }
    if (needle && !terms.length && !temporal) {
      const field = fields.find(field => field.normalized.includes(needle));
      if (!field) continue;
      reasons.push({ kind: field.kind, term: query.trim(), context: field.value.slice(0, 200) }); score += field.weight;
    }
    if (!matched) continue;
    if (temporal) reasons.push({ kind: 'time', term: query.match(/several\s+weeks?\s+ago|几周前|last\s+month|上个月/i)?.[0] || '', context: memory.createdAt });
    if (needle && normalize(text(memory)).includes(needle)) score += 30;
    const content = text(memory);
    const contentTerm = reasons.find(reason => reason.kind === 'content')?.term;
    const position = contentTerm ? Math.max(0, normalize(content).indexOf(contentTerm) - 45) : 0;
    const excerpt = `${position ? '…' : ''}${content.slice(position, position + 190)}${content.length > position + 190 ? '…' : ''}`;
    results.push({ ...memory, match: { score, reasons, excerpt, query: query.trim() } });
  }
  return results.sort((a, b) => b.match.score - a.match.score
    || (hybridRank.get(b.id) || 0) - (hybridRank.get(a.id) || 0)
    || String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
}

/** Shared metadata is displayed as a typed reference, never as a semantic edge
 * between every memory in a bucket. Only recorded, evidenced memory links enter. */
export function memoryContext(memory, records, relations = []) {
  const byId = new Map(records.map(record => [record.id, record]));
  const explicit = relations.filter(isMeaningfulRelation).filter(edge => edge.from === memory.id || edge.to === memory.id);
  const memories = explicit.map(edge => byId.get(edge.from === memory.id ? edge.to : edge.from)).filter(Boolean);
  const entities = [];
  const addEntity = (kind, key, label) => {
    if (!key || key === '*' || !label || entities.some(entity => entity.kind === kind && entity.key === key)) return;
    entities.push({ id: `entity:${kind}:${key}`, kind, key, label });
  };
  // Old demo buckets carry no verified entity type. Do not relabel them projects.
  if (memory.origin !== 'demo_preview' || memory.scope?.type) {
    if (memory.scopeType === 'project') addEntity('project', memory.scopeKey, entityLabel(memory));
    if (memory.scopeType === 'entity') addEntity(memory.scope?.entityType === 'person' ? 'person' : 'entity', memory.scopeKey, entityLabel(memory));
    for (const context of memory.contexts || []) {
      if (context.type === 'project') addEntity('project', context.key, context.entity);
      if (context.type === 'entity') addEntity(context.entityType === 'person' ? 'person' : 'entity', context.key, context.entity);
    }
  }
  const sources = (memory.sourceTasks || []).map(task => ({ id: `task:${task.id}`, taskId: task.id, kind: 'task', label: task.subject || task.title || task.id }));
  return { memories: [...new Map(memories.map(record => [record.id, record])).values()].slice(0, 32), entities, sources, relations: explicit };
}
