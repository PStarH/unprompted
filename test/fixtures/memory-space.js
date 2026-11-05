/**
 * Deterministic Memory Space fixture for service tests.
 *
 * `createMemorySpaceFixture(count)` accepts exactly 100, 250 or 500 and builds
 * a fixed-clock snapshot from the demo catalog. The result is practical for a
 * Memory Space service test:
 *
 *   {
 *     count, now, origin,
 *     memories:   [memory descriptor, ...],
 *     experiences:[experience descriptor, ...],  // never merged into memories
 *     policies:   [policy descriptor, ...],      // never merged into memories
 *     indexes:    { memoryById, experienceById, policyById },
 *     summary:    counts by type/scope/status/relation
 *   }
 *
 * A memory descriptor carries `id`, `text`, `memoryType` (fact, preference or
 * scoped legacy), `descriptor` (direct or legacy_scoped), `scope`, `contexts`,
 * `status` (active, disabled, archived, deleted, expired, superseded),
 * `createdAt`, `updatedAt`, `deletedAt`, `validFrom`, `validUntil`,
 * `source`, `lineage`, `relations` (`contradicts` or `related_to`),
 * `supersedes`, `supersededBy`, `taskId` and `origin`.
 *
 * IDs use stable prefixes: `mem-`, `exp-` and `pol-`. Relations and
 * supersession references always point at a record included in the fixture.
 * Repeated calls with the same count are deep-equal.
 */

import {
  createDemoMemoryRecords,
  DEMO_MEMORY_COUNTS,
  DEMO_MEMORY_EPOCH,
  DEMO_MEMORY_ORIGIN,
  DEMO_MEMORY_PREFIX,
  seedDemoMemories
} from '../../src/demo-memories.js';

export const MEMORY_SPACE_COUNTS = DEMO_MEMORY_COUNTS;
export const MEMORY_SPACE_NOW = DEMO_MEMORY_EPOCH;
export const MEMORY_SPACE_ORIGIN = DEMO_MEMORY_ORIGIN;
export const MEMORY_ID_PREFIX = 'mem-';
export const EXPERIENCE_ID_PREFIX = 'exp-';
export const POLICY_ID_PREFIX = 'pol-';
export const MEMORY_STATES = Object.freeze(['active', 'disabled', 'archived', 'deleted', 'expired', 'superseded']);
export const MEMORY_RELATION_TYPES = Object.freeze(['contradicts', 'related_to']);
export const MEMORY_DESCRIPTORS = Object.freeze(['direct', 'legacy_scoped']);

const HOUR = 3_600_000;
const pad = value => String(value).padStart(3, '0');
const fixtureTime = index => new Date(Date.parse(MEMORY_SPACE_NOW) - index * HOUR).toISOString();
const fixtureId = id => id.replace(DEMO_MEMORY_PREFIX, MEMORY_ID_PREFIX);

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function createExperiences(count) {
  const total = Math.max(2, Math.round(count / 50));
  const kinds = ['execution_hint', 'planning_hint', 'omission_guard', 'trigger_hint'];
  return Array.from({ length: total }, (_, index) => ({
    id: `${EXPERIENCE_ID_PREFIX}${pad(index + 1)}`,
    kind: 'experience',
    experienceKind: kinds[index % kinds.length],
    status: index % 6 === 5 ? 'retired' : index % 4 === 0 ? 'candidate' : 'active',
    instruction: `经验示例：在第 ${index + 1} 类交付前先核对来源与证据。`,
    scopeType: index % 4 === 0 ? 'global' : 'project',
    scopeKey: index % 4 === 0 ? '*' : `project/示例-${pad(index + 1)}`,
    effect: { type: 'advisory' },
    verifiedSuccessCount: index % 4,
    negativeEvidenceCount: index % 3 === 0 ? 1 : 0,
    createdAt: fixtureTime(index + 1),
    updatedAt: fixtureTime(index + 1),
    origin: MEMORY_SPACE_ORIGIN
  }));
}

function createPolicies(count) {
  const total = Math.max(2, Math.round(count / 50));
  return Array.from({ length: total }, (_, index) => ({
    id: `${POLICY_ID_PREFIX}${pad(index + 1)}`,
    kind: 'policy',
    status: index % 5 === 4 ? 'disabled' : 'active',
    instruction: `规则示例：第 ${index + 1} 类外部操作前暂停并请求确认。`,
    scopeType: index % 3 === 0 ? 'global' : 'project',
    scopeKey: index % 3 === 0 ? '*' : `project/示例-${pad(index + 1)}`,
    createdAt: fixtureTime(index + 1),
    updatedAt: fixtureTime(index + 1),
    origin: MEMORY_SPACE_ORIGIN
  }));
}

function summarize(memories, experiences, policies) {
  const textCounts = countBy(memories, memory => memory.text);
  return {
    memories: memories.length,
    experiences: experiences.length,
    policies: policies.length,
    memoryTypes: countBy(memories, memory => memory.memoryType),
    descriptors: countBy(memories, memory => memory.descriptor),
    statuses: countBy(memories, memory => memory.status),
    primaryScopeTypes: countBy(memories, memory => memory.scope.type),
    contextTypes: countBy(memories.flatMap(memory => memory.contexts), context => context.type),
    relationTypes: countBy(memories.flatMap(memory => memory.relations), relation => relation.type),
    duplicateTextGroups: Object.values(textCounts).filter(total => total > 1).length,
    multiContext: memories.filter(memory => memory.contexts.length > 1).length,
    pastValidUntil: memories.filter(memory => memory.validUntil && Date.parse(memory.validUntil) < Date.parse(MEMORY_SPACE_NOW)).length,
    futureValidUntil: memories.filter(memory => memory.validUntil && Date.parse(memory.validUntil) > Date.parse(MEMORY_SPACE_NOW)).length
  };
}

/**
 * Build a deterministic Memory Space snapshot. Valid counts are exactly the
 * representative sizes 100, 250 and 500.
 */
export function createMemorySpaceFixture(count) {
  if (!MEMORY_SPACE_COUNTS.includes(count)) {
    throw new RangeError(`Memory Space fixtures support exactly ${MEMORY_SPACE_COUNTS.join(', ')} memories.`);
  }
  const memories = createDemoMemoryRecords(count).map(record => {
    const id = fixtureId(record.id);
    return {
      ...record,
      id,
      relations: record.relations.map(relation => ({ ...relation, targetId: fixtureId(relation.targetId) })),
      supersedes: record.supersedes.map(fixtureId),
      supersededBy: record.supersededBy ? fixtureId(record.supersededBy) : null
    };
  });
  const experiences = createExperiences(count);
  const policies = createPolicies(count);
  return {
    count,
    now: MEMORY_SPACE_NOW,
    origin: MEMORY_SPACE_ORIGIN,
    memories,
    experiences,
    policies,
    indexes: {
      memoryById: Object.fromEntries(memories.map(memory => [memory.id, memory])),
      experienceById: Object.fromEntries(experiences.map(experience => [experience.id, experience])),
      policyById: Object.fromEntries(policies.map(policy => [policy.id, policy]))
    },
    summary: summarize(memories, experiences, policies)
  };
}

/**
 * A small store adapter around `seedDemoMemories`, useful for service tests
 * that expect the same `{ state, mutate }` shape as production stores.
 */
export function createSeededMemoryStore(count = 0) {
  const store = { state: {}, mutate(change) { change(this.state); } };
  const seeded = seedDemoMemories(store, { count, demo: true });
  return {
    store,
    seeded,
    memories: Object.values(store.state.taskMemories || {})
  };
}
