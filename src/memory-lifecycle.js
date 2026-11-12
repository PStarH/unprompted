export const MEMORY_LIFECYCLES = Object.freeze(['active', 'disabled', 'archived', 'deleted', 'superseded']);

export function memoryLifecycle(memory) {
  if (memory?.deletedAt || memory?.deleted_at) return 'deleted';
  return memory?.lifecycleState || memory?.lifecycle_state || 'active';
}

export function memoryExpired(memory, now = Date.now()) {
  const value = memory?.validUntil ?? memory?.valid_until;
  if (!value) return false;
  const expires = Date.parse(value);
  return Number.isFinite(expires) && expires <= now;
}

export function memoryConsumable(memory, now = Date.now()) {
  return memoryLifecycle(memory) === 'active' && !memory?.supersededBy && !memory?.superseded_by && !memoryExpired(memory, now);
}

export function validMemoryDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Validity must be an ISO date or empty.');
  return new Date(value).toISOString();
}
