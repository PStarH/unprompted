// Shared selection for both harnesses and the UI. Whole instructions are
// admitted or deferred; truncation must not remove exceptions or conditions.
export function planningContextManifest(context, { taskId = null, inputVersion = null, privacyEpoch = null, guidance = null, budgetChars = 4000 } = {}) {
  const arbitration = context.arbitration || {};
  const conflicts = arbitration.conflicts || [];
  const permitted = new Set([...(arbitration.decisions || []).map(item => item.record.id), ...(arbitration.advisory || []).map(item => item.id)]);
  const conflicting = new Set(conflicts.flatMap(item => item.ids));
  const experiences = (context.experiences || []).filter(item => permitted.has(item.id) && !conflicting.has(item.id));
  const overridden = (context.experiences || []).filter(item => !permitted.has(item.id) && !conflicting.has(item.id)).map(item => ({ id: item.id, kind: 'experience', reason: 'overridden' }));
  const selected = [], deferred = [];
  let used = 0;
  const choose = item => {
    const size = JSON.stringify(item).length;
    if (used + size <= budgetChars) { selected.push(item); used += size; }
    else deferred.push({ id: item.id, kind: item.kind, reason: 'context_budget', readTool: 'read_context_item' });
  };
  for (const item of context.memories || []) choose({ id: item.id, kind: 'memory', text: item.content, scopeType: item.scopeType, scopeKey: item.scopeKey, sourceKind: item.sourceKind, sourceId: item.sourceId, version: item.version, expectedVersion: item.expectedVersion ?? item.version, memoryKind: item.memoryKind });
  for (const item of experiences) choose({ id: item.id, kind: 'experience', experienceKind: item.kind, status: item.status, instruction: item.instruction_text, advisoryOnly: item.advisoryOnly });
  return { taskId, inputVersion, contextVersion: context.version, privacyEpoch, selected, deferred, overridden, conflicts,
    currentUserDirection: guidance ? { id: guidance.id, text: guidance.text, precedence: 'current_user' } : null,
    budget: { limitChars: budgetChars, usedChars: used },
    memory: selected.filter(item => item.kind === 'memory'), experiences: selected.filter(item => item.kind === 'experience'),
    relatedEvents: (context.events || []).slice(0, 2).map(event => ({ id: event.id, type: event.type, text: String(event.payload?.body || event.payload?.content || event.payload?.title || '').slice(0, 200) })) };
}
