import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_GRAPH_MAX_EDGES,
  MEMORY_GRAPH_MAX_NODES,
  MEMORY_LIST_MAX,
  MEMORY_STATUS,
  buildMemoryGraph,
  buildMemoryList,
  buildMemorySpace,
  createFocusHistory,
  filterMemoryRecords,
  focusBack,
  memoryLifecycle,
  normalizeMemoryRecords,
  pushFocusHistory,
  recenterMemoryPositions,
  searchMemoryRecords,
  sortMemoryRecords
} from '../public/memory-space-model.js';

const ids = entries => entries.map(entry => entry.id);
const positions = graph => Object.fromEntries(graph.nodes.map(node => [node.id, [node.x, node.y]]));
const NOW = '2024-06-01T00:00:00.000Z';

test('sorting is stable, deterministic and tie-broken by id', () => {
  const records = [
    { id: 'b', content: 'Beta', updatedAt: '2024-01-02T00:00:00.000Z' },
    { id: 'a', content: 'Alpha', updatedAt: '2024-01-02T00:00:00.000Z' },
    { id: 'c', content: 'Charlie', updatedAt: '2024-01-03T00:00:00.000Z' }
  ];
  assert.deepEqual(ids(sortMemoryRecords(records)), ['c', 'a', 'b']);
  assert.deepEqual(ids(sortMemoryRecords([...records].reverse())), ['c', 'a', 'b']);
  assert.deepEqual(ids(sortMemoryRecords(records, { sort: 'oldest' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(sortMemoryRecords(records, { sort: 'content' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(sortMemoryRecords(records, { sort: 'unknown' })), ['c', 'a', 'b']);

  const scoped = [
    { id: '2', content: 'x', scope: { entity: 'Zulu', deliverable: 'B' } },
    { id: '1', content: 'x', scope: { entity: 'Alpha', deliverable: 'B' } },
    { id: '3', content: 'x', scope: { entity: 'Alpha', deliverable: 'A' } }
  ];
  assert.deepEqual(ids(sortMemoryRecords(scoped, { sort: 'scope' })), ['3', '1', '2']);
});

test('filters use derived lifecycle, scope, source task and literal query matching', () => {
  const records = [
    { id: 'active', content: 'One', updatedAt: '2024-01-03T00:00:00.000Z' },
    { id: 'expired', content: 'Two', expiresAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' },
    { id: 'superseded', content: 'Three', supersededBy: 'active' },
    { id: 'deleted', content: 'Four', deletedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'scoped', content: 'Five', scope: { entity: 'Design', deliverable: 'Spec' }, sourceTaskId: 'task-2' }
  ];
  assert.deepEqual(new Set(ids(filterMemoryRecords(records, { now: NOW }))), new Set(['active', 'expired', 'superseded', 'scoped']));
  assert.deepEqual(ids(filterMemoryRecords(records, { now: NOW, status: MEMORY_STATUS.EXPIRED })), ['expired']);
  assert.deepEqual(ids(filterMemoryRecords(records, { now: NOW, status: 'superseded' })), ['superseded']);
  assert.deepEqual(ids(filterMemoryRecords(records, { now: NOW, includeDeleted: true, status: 'deleted' })), ['deleted']);
  assert.deepEqual(ids(filterMemoryRecords(records, { now: NOW, entity: 'design' })), ['scoped']);
  assert.deepEqual(ids(filterMemoryRecords(records, { now: NOW, sourceTaskId: 'task-2' })), ['scoped']);
  assert.deepEqual(ids(filterMemoryRecords(records, { now: NOW, query: 'five' })), ['scoped']);
  assert.deepEqual(ids(filterMemoryRecords(records, { now: NOW, query: 'five design' })), ['scoped']);
});

test('search covers content and supplied scope, source-task and related-term metadata without fuzzy inference', () => {
  const records = [
    { id: 'a', text: 'Write the weekly report', scope: { entity: 'Product', deliverable: 'Roadmap' }, sourceTask: { id: 'task-9', title: 'Quarterly planning' }, relatedTerms: ['budget', 'risk'] },
    { id: 'b', text: 'Unrelated note', scope: { entity: 'Design' }, relatedTerms: ['typography'] }
  ];
  assert.deepEqual(ids(searchMemoryRecords(records, 'weekly')), ['a']);
  assert.deepEqual(ids(searchMemoryRecords(records, 'product')), ['a']);
  assert.deepEqual(ids(searchMemoryRecords(records, 'roadmap')), ['a']);
  assert.deepEqual(ids(searchMemoryRecords(records, 'quarterly')), ['a']);
  assert.deepEqual(ids(searchMemoryRecords(records, 'task-9')), ['a']);
  assert.deepEqual(ids(searchMemoryRecords(records, 'budget')), ['a']);
  assert.deepEqual(ids(searchMemoryRecords(records, 'weekly product budget')), ['a']);
  assert.deepEqual(ids(searchMemoryRecords(records, 'weeky')), []);
  assert.deepEqual(ids(searchMemoryRecords(records, '')), ['a', 'b']);
});

test('lifecycle is derived without a hidden clock and prefers deleted over superseded over expired', () => {
  assert.equal(memoryLifecycle({ id: 'a' }, { now: NOW }), MEMORY_STATUS.ACTIVE);
  assert.equal(memoryLifecycle({ id: 'a', expiresAt: '2024-05-31T00:00:00.000Z' }, { now: NOW }), MEMORY_STATUS.EXPIRED);
  assert.equal(memoryLifecycle({ id: 'a', expiresAt: '2024-05-31T00:00:00.000Z' }, { now: null }), MEMORY_STATUS.ACTIVE);
  assert.equal(memoryLifecycle({ id: 'a', supersededBy: 'b' }, { now: NOW }), MEMORY_STATUS.SUPERSEDED);
  assert.equal(memoryLifecycle({ id: 'a', expiresAt: '2024-05-31T00:00:00.000Z', supersededAt: '2024-05-01T00:00:00.000Z' }, { now: NOW }), MEMORY_STATUS.SUPERSEDED);
  assert.equal(memoryLifecycle({ id: 'a', deletedAt: '2024-05-01T00:00:00.000Z', supersededAt: '2024-05-02T00:00:00.000Z' }, { now: NOW }), MEMORY_STATUS.DELETED);
  assert.equal(memoryLifecycle({ id: 'a', status: 'expired' }, { now: NOW }), MEMORY_STATUS.EXPIRED);
});

test('the list is capped at 500 with deterministic prefix order and overflow reporting', () => {
  const records = Array.from({ length: MEMORY_LIST_MAX + 5 }, (_, index) => ({
    id: `m${String(index).padStart(3, '0')}`,
    content: `Entry ${String(index).padStart(3, '0')}`
  }));
  const list = buildMemoryList(records);
  assert.equal(list.items.length, MEMORY_LIST_MAX);
  assert.equal(list.total, MEMORY_LIST_MAX + 5);
  assert.deepEqual(ids(list.items.slice(0, 3)), ['m000', 'm001', 'm002']);
  assert.deepEqual(list.overflow, { limit: MEMORY_LIST_MAX, shown: MEMORY_LIST_MAX, hidden: 5 });

  const short = buildMemoryList(records, { limit: 2 });
  assert.deepEqual(ids(short.items), ['m000', 'm001']);
  assert.deepEqual(short.overflow, { limit: 2, shown: 2, hidden: MEMORY_LIST_MAX + 3 });
});

test('the graph enforces the node and edge caps and reports overflow', () => {
  const records = Array.from({ length: 60 }, (_, index) => ({
    id: `m${String(index).padStart(2, '0')}`,
    content: `Entry ${index}`,
    relations: index === 0 ? Array.from({ length: 40 }, (_, offset) => ({ targetId: `m${String(offset + 1).padStart(2, '0')}` })) : []
  }));
  const graph = buildMemoryGraph(records, { focusId: 'm00' });
  assert.equal(graph.nodes.length, MEMORY_GRAPH_MAX_NODES);
  assert.equal(graph.nodes[0].id, 'm00');
  assert.equal(new Set(ids(graph.nodes)).size, graph.nodes.length);
  assert.ok(graph.edges.length <= MEMORY_GRAPH_MAX_EDGES);
  assert.deepEqual(graph.overflow.nodes, { limit: MEMORY_GRAPH_MAX_NODES, shown: MEMORY_GRAPH_MAX_NODES, hidden: 9, available: 60 });
  assert.ok(graph.overflow.edges.hidden >= 0);
  const nodeIds = new Set(ids(graph.nodes));
  assert.ok(graph.edges.every(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to));

  const dense = Array.from({ length: 32 }, (_, index) => ({
    id: `d${String(index).padStart(2, '0')}`,
    content: `Dense ${index}`,
    scope: { entity: 'Project', deliverable: 'Plan' }
  }));
  const capped = buildMemoryGraph(dense, { maxNodes: 99, maxEdges: 99 });
  assert.equal(capped.nodes.length, MEMORY_GRAPH_MAX_NODES);
  assert.equal(capped.edges.length, MEMORY_GRAPH_MAX_EDGES);
  assert.equal(capped.overflow.edges.candidates, 496);
  assert.equal(capped.overflow.edges.hidden, 496 - MEMORY_GRAPH_MAX_EDGES);
});

test('positions are deterministic, independent of record order and round to stable coordinates', () => {
  const records = [
    { id: 'a', content: 'A', relations: [{ targetId: 'z' }, { targetId: 'm' }] },
    { id: 'b', content: 'B', sourceTaskId: 'shared' },
    { id: 'c', content: 'C', scope: { entity: 'Project', deliverable: 'Plan' } },
    { id: 'z', content: 'Z' },
    { id: 'm', content: 'M', scope: { entity: 'Project', deliverable: 'Plan' } },
    { id: 'y', content: 'Y', sourceTaskId: 'shared' }
  ];
  const forward = buildMemoryGraph(records, { focusId: 'a', depth: 1 });
  const reverse = buildMemoryGraph([...records].reverse(), { focusId: 'a', depth: 1 });
  assert.deepEqual(positions(forward), positions(reverse));
  assert.deepEqual(ids(forward.nodes), ids(reverse.nodes));
  const focus = forward.nodes.find(node => node.id === 'a');
  assert.deepEqual([focus.x, focus.y, focus.ring], [480, 320, 0]);
  assert.ok(forward.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));

  const unfilteredForward = buildMemorySpace(records, { sort: 'content' });
  const unfilteredReverse = buildMemorySpace([...records].reverse(), { sort: 'content' });
  assert.deepEqual(ids(unfilteredForward.list.items), ids(unfilteredReverse.list.items));
  assert.deepEqual(positions(unfilteredForward.graph), positions(unfilteredReverse.graph));
});

test('recentering moves the focus to the viewport centre without changing relative geometry', () => {
  const graph = buildMemoryGraph([
    { id: 'a', content: 'A' },
    { id: 'b', content: 'B' },
    { id: 'c', content: 'C' }
  ]);
  const beforeB = graph.nodes.find(node => node.id === 'b');
  const beforeC = graph.nodes.find(node => node.id === 'c');
  const recentered = recenterMemoryPositions(graph.nodes, 'b', { width: 800, height: 600 });
  const afterB = recentered.find(node => node.id === 'b');
  const afterC = recentered.find(node => node.id === 'c');
  assert.deepEqual([afterB.x, afterB.y], [400, 300]);
  assert.equal(Math.round((beforeC.x - beforeB.x) * 1000), Math.round((afterC.x - afterB.x) * 1000));
  assert.equal(Math.round((beforeC.y - beforeB.y) * 1000), Math.round((afterC.y - afterB.y) * 1000));
  assert.deepEqual(recenterMemoryPositions(graph.nodes, 'missing', { width: 800, height: 600 }), graph.nodes);
});

test('the focused neighbourhood visits explicit relations before evidence and supports a second hop', () => {
  const records = [
    { id: 'a', content: 'Focus', sourceTaskId: 't1', scope: { entity: 'P', deliverable: 'D' }, relations: [{ targetId: 'z' }] },
    { id: 'z', content: 'Explicit one hop', relations: [{ targetId: 'y' }] },
    { id: 'b', content: 'Evidence one hop' },
    { id: 'c', content: 'Evidence one hop' },
    { id: 'y', content: 'Second hop' }
  ];
  // b and c derive from the same source task as a; z is explicit and sorts
  // after them, so explicit-first ordering is observable.
  records[2].sourceTaskId = 't1';
  records[3].sourceTaskId = 't1';
  const oneHop = buildMemoryGraph(records, { focusId: 'a', depth: 1 });
  assert.deepEqual(ids(oneHop.nodes), ['a', 'z', 'b', 'c']);
  assert.deepEqual(oneHop.nodes.map(node => node.hop), [0, 1, 1, 1]);

  const twoHops = buildMemoryGraph(records, { focusId: 'a', depth: 2 });
  assert.deepEqual(ids(twoHops.nodes), ['a', 'z', 'b', 'c', 'y']);
  assert.equal(twoHops.nodes.find(node => node.id === 'y').hop, 2);

  const bounded = buildMemoryGraph(records, { focusId: 'a', depth: 1, maxNodes: 2 });
  assert.deepEqual(ids(bounded.nodes), ['a', 'z']);
  assert.deepEqual(bounded.overflow.nodes, { limit: 2, shown: 2, hidden: 2, available: 5 });

  const missing = buildMemoryGraph(records, { focusId: 'not-there' });
  assert.equal(missing.focusMissing, true);
  assert.equal(missing.focusId, null);
  assert.deepEqual(ids(missing.nodes), ['a', 'z', 'b', 'c', 'y']);
});

test('duplicate relations, duplicate records and self relations never create duplicate or self edges', () => {
  const records = [
    {
      id: 'a',
      content: 'A',
      sourceTaskId: 't',
      scope: { entity: 'P', deliverable: 'D' },
      evidence: [{ id: 'doc-1', title: 'Doc one' }],
      relations: [{ targetId: 'b' }, { targetId: 'b', evidence: 'Same decision' }, { targetId: 'a' }]
    },
    {
      id: 'b',
      content: 'B',
      sourceTaskId: 't',
      scope: { entity: 'P', deliverable: 'D' },
      evidence: [{ id: 'doc-1', title: 'Doc one' }],
      relations: [{ targetId: 'a' }]
    },
    { id: 'a', content: 'Duplicate record' }
  ];
  assert.equal(normalizeMemoryRecords(records).length, 2);
  const graph = buildMemoryGraph(records, { focusId: 'a' });
  assert.deepEqual(ids(graph.nodes), ['a', 'b']);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].source, 'explicit');
  assert.equal(graph.edges[0].status, 'established');
  assert.ok(graph.nodes.every(node => node.degree === 1 && node.isolated === false));
});

test('isolated, expired and superseded records stay in the graph with derived statuses', () => {
  const records = [
    { id: 'isolated', content: 'Isolated', expiresAt: '2024-05-01T00:00:00.000Z' },
    { id: 'superseded', content: 'Old', supersededBy: 'new' },
    { id: 'b', content: 'B', relations: [{ targetId: 'c' }] },
    { id: 'c', content: 'C' },
    { id: 'deleted', content: 'Gone', deletedAt: '2024-05-01T00:00:00.000Z' }
  ];
  const focused = buildMemoryGraph(records, { now: NOW, focusId: 'isolated' });
  assert.deepEqual(ids(focused.nodes), ['isolated']);
  assert.equal(focused.nodes[0].status, MEMORY_STATUS.EXPIRED);
  assert.equal(focused.nodes[0].isolated, true);
  assert.equal(focused.edges.length, 0);

  const all = buildMemoryGraph(records, { now: NOW });
  assert.deepEqual(ids(all.nodes), ['isolated', 'superseded', 'b', 'c']);
  assert.equal(all.nodes.find(node => node.id === 'isolated').status, MEMORY_STATUS.EXPIRED);
  assert.equal(all.nodes.find(node => node.id === 'superseded').status, MEMORY_STATUS.SUPERSEDED);
  assert.equal(all.nodes.find(node => node.id === 'isolated').isolated, true);

  const withDeleted = buildMemoryGraph(records, { now: NOW, includeDeleted: true });
  assert.equal(withDeleted.nodes.length, 5);
  assert.equal(withDeleted.nodes.find(node => node.id === 'deleted').status, MEMORY_STATUS.DELETED);
});

test('the list and graph share the same normalized records and graph ids are list ids', () => {
  const records = [
    { id: 'a', content: 'Weekly report', scope: { entity: 'Product', deliverable: 'Roadmap' }, sourceTaskId: 't1', relatedTerms: ['budget'] },
    { id: 'b', content: 'Unrelated note', scope: { entity: 'Design' } },
    { id: 'c', content: 'Planning note', sourceTaskId: 't1' }
  ];
  const space = buildMemorySpace(records, { query: 'weekly product budget', focusId: 'a', now: NOW });
  assert.deepEqual(ids(space.list.items), ['a']);
  assert.deepEqual(ids(space.graph.nodes), ['a']);
  assert.equal(space.graph.nodes[0].record, space.list.items[0]);
  assert.deepEqual(space.overflow, {
    list: { limit: MEMORY_LIST_MAX, shown: 1, hidden: 0 },
    nodes: { limit: MEMORY_GRAPH_MAX_NODES, shown: 1, hidden: 0, available: 1 },
    edges: { limit: MEMORY_GRAPH_MAX_EDGES, shown: 0, hidden: 0, candidates: 0 }
  });

  const broader = buildMemorySpace(records, { focusId: 'a', now: NOW });
  const listIds = new Set(ids(broader.list.items));
  assert.ok(broader.graph.nodes.every(node => listIds.has(node.id)));
  for (const node of broader.graph.nodes) {
    assert.equal(node.record, broader.list.items.find(record => record.id === node.id));
  }
});

test('edges carry human-readable established and suggested presentation with evidence', () => {
  const explicit = buildMemoryGraph([
    { id: 'a', content: 'A', relations: [{ targetId: 'b', kind: 'same_topic', label: 'Same topic', evidence: 'Reviewed together' }] },
    { id: 'b', content: 'B' }
  ], { focusId: 'a' });
  assert.equal(explicit.edges.length, 1);
  assert.deepEqual(
    {
      status: explicit.edges[0].status,
      statusLabel: explicit.edges[0].statusLabel,
      title: explicit.edges[0].title,
      source: explicit.edges[0].source
    },
    { status: 'established', statusLabel: 'Established', title: 'Same topic', source: 'explicit' }
  );
  assert.ok(explicit.edges[0].evidence.includes('Reviewed together'));
  assert.match(explicit.edges[0].detail, /Reviewed together/);

  const suggested = buildMemoryGraph([
    { id: 'a', content: 'A', sourceTask: { id: 't', title: 'Send weekly report' } },
    { id: 'b', content: 'B', sourceTask: { id: 't', title: 'Send weekly report' } }
  ], { focusId: 'a' });
  assert.equal(suggested.edges.length, 1);
  assert.equal(suggested.edges[0].status, 'suggested');
  assert.equal(suggested.edges[0].statusLabel, 'Suggested');
  assert.equal(suggested.edges[0].title, 'Same source task');
  assert.equal(suggested.edges[0].source, 'derived');
  assert.ok(suggested.edges[0].evidence.some(item => item.includes('Send weekly report')));

  const explicitlySuggested = buildMemoryGraph([
    { id: 'a', content: 'A', relations: [{ targetId: 'b', status: 'suggested', evidence: 'Probably related' }] },
    { id: 'b', content: 'B' }
  ], { focusId: 'a' });
  assert.equal(explicitlySuggested.edges[0].source, 'explicit');
  assert.equal(explicitlySuggested.edges[0].status, 'suggested');
  assert.equal(explicitlySuggested.edges[0].statusLabel, 'Suggested');
});

test('explicit edges win the deterministic edge prefix over suggested edges', () => {
  const records = [
    { id: 'a', content: 'A', sourceTaskId: 'shared', relations: [{ targetId: 'b' }] },
    { id: 'b', content: 'B', sourceTaskId: 'shared' },
    { id: 'c', content: 'C', sourceTaskId: 'shared' }
  ];
  const graph = buildMemoryGraph(records, { focusId: 'a', maxEdges: 1 });
  assert.equal(graph.edges.length, 1);
  assert.deepEqual([graph.edges[0].from, graph.edges[0].to], ['a', 'b']);
  assert.equal(graph.edges[0].source, 'explicit');
  assert.deepEqual(graph.overflow.edges, { limit: 1, shown: 1, hidden: 2, candidates: 3 });
});

test('focus history is bounded, duplicate-safe and supports going back', () => {
  let history = createFocusHistory('a');
  assert.deepEqual(history, ['a']);
  history = pushFocusHistory(history, 'b');
  history = pushFocusHistory(history, 'b');
  assert.deepEqual(history, ['a', 'b']);
  assert.equal(focusBack(history), 'a');
  history = pushFocusHistory(history, 'c', 2);
  assert.deepEqual(history, ['b', 'c']);
  assert.equal(focusBack(history), 'b');
  assert.equal(focusBack(['only']), null);
  assert.deepEqual(pushFocusHistory(['a'], null), ['a']);
});


test('quiet exploration shows local scope connections without drawing a clique', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({ id: String(index), text: `Fact ${index}`, scopeType: 'project', scopeKey: 'Cedar' }));
  const graph = buildMemoryGraph(records, { focusId: '0', quiet: true, maxNodes: 10 });
  assert.equal(graph.nodes.length, 10);
  assert.equal(graph.edges.length, 9);
  assert.ok(graph.edges.every(edge => edge.from === '0' || edge.to === '0'));
  assert.equal(graph.overflow.nodes.hidden, 10);
  const global = buildMemoryGraph(records.map(record => ({ ...record, scopeType: 'global', scopeKey: '*' })), { focusId: '0', quiet: true });
  assert.equal(global.nodes.length, 1);
  assert.equal(global.edges.length, 0);
});

test('disabled and archived records retain their state in the shared presentation model', () => {
  const records = normalizeMemoryRecords([{ id: 'off', lifecycleState: 'disabled' }, { id: 'archive', lifecycleState: 'archived' }]);
  assert.deepEqual(records.map(record => record.status), ['disabled', 'archived']);
});
