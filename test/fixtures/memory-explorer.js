import { randomUUID } from 'node:crypto';

export function createMemoryExplorerFixture(count = 500) {
  if (![100, 250, 500].includes(count)) throw new RangeError('Use a representative 100, 250 or 500 record collection.');
  const records = [
    { id: 'budget-old', content: 'Cedar had a budget of ¥48,000 before the user corrected it.', scopeType: 'project', scopeKey: 'Cedar', createdAt: '2026-09-28T09:00:00.000Z', lifecycleState: 'superseded', taskId: 'budget-conversation' },
    { id: 'budget-current', content: 'Cedar’s approved budget is ¥62,000, including tax. 林晨 confirmed the revised amount.', scopeType: 'project', scopeKey: 'Cedar', createdAt: '2026-10-29T09:00:00.000Z', taskId: 'budget-correction' },
    { id: 'old-preference', content: '林晨 prefers a concise written summary before meetings, rather than a slide presentation.', scopeType: 'entity', scopeKey: 'person:林晨', memoryKind: 'preference', createdAt: '2026-09-18T09:00:00.000Z', taskId: 'meeting-conversation' },
    { id: 'recent-preference', content: '林晨 now prefers a two-page written summary for monthly meetings.', scopeType: 'entity', scopeKey: 'person:林晨', memoryKind: 'preference', createdAt: '2026-10-31T09:00:00.000Z', taskId: 'meeting-conversation' },
    { id: 'isolated-key', content: 'The spare key is kept in the studio’s blue drawer.', scopeType: 'global', scopeKey: '*', createdAt: '2026-10-16T09:00:00.000Z' },
    { id: 'cedar-requirement', content: 'Cedar requires a supplier comparison before purchase approval.', scopeType: 'project', scopeKey: 'Cedar', createdAt: '2026-10-27T09:00:00.000Z', taskId: 'budget-correction' },
    { id: 'cedar-context', content: 'Cedar supplier comparisons include tax, delivery dates and support terms.', scopeType: 'project', scopeKey: 'Cedar', createdAt: '2026-10-26T09:00:00.000Z', taskId: 'budget-correction' },
  ];
  const projects = ['Juniper', 'Harbor', 'Orion', 'Monroe', 'Northstar', 'Fieldnotes', 'Sequoia', 'Cedar'];
  const subjects = [
    'the design review needs an accessibility checklist',
    'deployment notes must include rollback steps',
    'the research summary cites original interviews',
    'support handoff includes the responsible person',
    'the next meeting starts with unresolved decisions',
    'the contract renewal requires seven days of notice',
    'new suppliers must confirm delivery dates',
    'the release brief includes open risks and owners',
  ];
  while (records.length < count) {
    const index = records.length;
    const project = projects[index % projects.length];
    records.push({ id: `context-${String(index).padStart(3, '0')}`, content: `${project}: ${subjects[Math.floor(index / projects.length) % subjects.length]}. Recorded for milestone ${Math.floor(index / 64) + 1}.`, scopeType: 'project', scopeKey: project,
      memoryKind: index % 9 === 0 ? 'preference' : 'fact', createdAt: new Date(Date.parse('2026-10-25T09:00:00.000Z') - index * 3600000).toISOString() });
  }
  return { records, tasks: [
    { id: 'budget-conversation', subject: 'Cedar launch planning · original budget conversation' },
    { id: 'budget-correction', subject: 'Cedar review · user corrected the approved budget' },
    { id: 'meeting-conversation', subject: '林晨 · meeting preparation conversation' },
  ], relations: [
    { from: 'budget-current', to: 'budget-old', kind: 'supersedes', evidenceKind: 'direct_correction', evidenceRef: 'budget-correction' },
    { from: 'budget-current', to: 'cedar-requirement', kind: 'related_to', evidenceKind: 'user_confirmed', evidenceRef: 'Cedar review: comparison is required before committing this budget.' },
    { from: 'cedar-requirement', to: 'cedar-context', kind: 'derived_from', evidenceKind: 'user_confirmed', evidenceRef: 'The supplier checklist was explicitly used to define the comparison requirement.' },
  ] };
}

/** Seed real SQLite data in a disposable fixture. Nothing touches user workspaces. */
export function seedMemoryExplorerStore(store, count = 500) {
  const fixture = createMemoryExplorerFixture(count);
  store.mutate(state => {
    for (const task of fixture.tasks) state.tasks[task.id] = { ...task, status: 'completed',
      request: { subjectEntity: task.id === 'meeting-conversation' ? '林晨' : 'Cedar', deliverable: 'planning brief', text: task.subject },
      control: { paused: true } };
  });
  store.database.atomic(() => {
    for (const record of fixture.records) {
      store.memory.put({ ...record, memoryKind: record.memoryKind || 'fact', changeKind: record.id === 'budget-current' ? 'supersede' : 'created' });
      store.db.prepare('UPDATE user_memories SET created_at=?,updated_at=? WHERE id=?').run(record.createdAt, record.createdAt, record.id);
      store.db.prepare('UPDATE memory_versions SET created_at=? WHERE memory_id=?').run(record.createdAt, record.id);
      if (record.taskId) store.database.lineage('task', record.taskId, 'memory', record.id);
    }
    for (const edge of fixture.relations) {
      let { from, to } = edge;
      if (edge.kind === 'related_to' && from > to) [from, to] = [to, from];
      store.db.prepare(`INSERT INTO memory_relations
        (id,source_memory_id,target_memory_id,relation_kind,status,evidence_kind,evidence_ref,created_at,updated_at)
        VALUES(?,?,?,?,'established',?,?,?,?)`).run(randomUUID(), from, to, edge.kind, edge.evidenceKind, edge.evidenceRef, '2026-10-29T09:00:00.000Z', '2026-10-29T09:00:00.000Z');
    }
    store.database.bump('context_version');
  });
  return fixture;
}
