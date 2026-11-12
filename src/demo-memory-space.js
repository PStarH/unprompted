import { memoryConsumable, memoryExpired, memoryLifecycle } from './memory-lifecycle.js';
import { rankMemoryResults, memoryContext } from './memory-explorer.js';
const normalize = value => String(value || '').trim().toLocaleLowerCase();

/** Read-only projection. Old demo scope buckets are never semantic edges. */
export function demoMemorySpace(state, { q = '', kind = 'all', scope = '', status = 'current', focus = null, limit = 500 } = {}) {
  let records = Object.values(state.taskMemories || {}).map(memory => ({
    ...memory, content: memory.text, memoryKind: memory.memoryKind || 'fact',
    lifecycleState: memoryLifecycle(memory), status: memoryLifecycle(memory) === 'active' && memoryExpired(memory) ? 'expired' : memoryLifecycle(memory),
    consumable: memoryConsumable(memory), sourceKind: 'task_memory', sourceId: memory.id,
    sourceTask: null, sourceTasks: memory.taskId && state.tasks?.[memory.taskId] ? [{ id: memory.taskId, subject: state.tasks[memory.taskId].subject }] : [], relations: [], readonly: true,
    scopeType: memory.scope?.type || 'project', scopeKey: memory.scope?.key || JSON.stringify([normalize(memory.scope?.entity), normalize(memory.scope?.deliverable)])
  }));
  records = records.filter(memory => {
    if (kind !== 'all' && memory.memoryKind !== kind) return false;
    if (scope && normalize(memory.scope?.entity) !== normalize(scope) && normalize(memory.scopeKey) !== normalize(scope)) return false;
    if (status === 'remembered') return memory.lifecycleState !== 'deleted';
    if (status === 'current') return memory.consumable;
    if (status === 'active') return memory.lifecycleState === 'active';
    return status === 'all' || memory.status === status;
  });
  records = rankMemoryResults(records, q);
  const total = records.length, maximum = Math.max(1, Math.min(500, Number(limit) || 500));
  records = records.slice(0, maximum);
  return { records, relations: [], derivedRelations: [], total, truncated: total > maximum,
    focusId: records.find(memory => memory.id === focus)?.id || records[0]?.id || null, contextVersion: state.revision || 0, readonly: true };
}

export function demoMemoryDetail(state, id) {
  const records = demoMemorySpace(state, { status: 'all' }).records;
  const memory = records.find(record => record.id === id);
  if (!memory) return null;
  return { memory, context: { ...memoryContext(memory, records), centerId: id }, versions: memory.versions || [],
    provenance: { source: { kind: 'task_memory', id }, tasks: memory.sourceTasks, lineage: [], usage: [] }, relations: [] };
}
