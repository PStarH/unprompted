import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { aggregateTaskDependencies, projectTaskManagement, projectWorkspaceTaskManagement } from '../src/task-management.js';

const NOW = '2026-10-26T12:00:00.000Z';
const counts = process.argv.slice(2).map(Number).filter(Number.isFinite).filter(value => value > 0).map(Math.floor);
const sizes = counts.length ? counts : [250, 500, 1000];

function syntheticState(taskCount, groupSize) {
  const tasks = {};
  for (let index = 0; index < taskCount; index += 1) {
    const id = `task-${String(index).padStart(5, '0')}`;
    const group = Math.floor(index / groupSize);
    const closed = index % 37 === 0;
    tasks[id] = {
      id,
      status: closed ? (index % 2 ? 'completed' : 'cancelled') : 'waiting_for_information',
      userDismissed: index % 53 === 0,
      request: {
        subjectEntity: `Entity ${group}`,
        deliverable: 'proposal',
        deadline: { iso: `2026-11-${String((group % 20) + 1).padStart(2, '0')}` },
        explicitDocumentUrl: null,
        source: { kind: 'email', id: `message-${index}`, threadId: `thread-${group}` }
      },
      sourceEmailId: `message-${index}`,
      documentId: `document-${group}`,
      createdAt: '2026-10-20T00:00:00.000Z',
      progress: { at: '2026-10-25T00:00:00.000Z' },
      assessment: { missing: ['Sample size', 'Control result'] },
      evidence: {
        conflicts: index % 43 === 0 ? [{ id: `conflict-${index}` }] : [],
        criteria: [
          { id: 'sample_size', label: 'Sample size', required: true, status: 'not_satisfied', evidence: [{ source: { kind: 'document', id: `document-${group}` } }] },
          { id: 'control_result', label: 'Control result', required: true, status: index % 5 === 0 ? 'satisfied' : 'not_satisfied', evidence: [{ source: { kind: 'document', id: `document-${group}` } }] }
        ]
      }
    };
  }
  return {
    tasks,
    documents: Object.fromEntries(Array.from({ length: Math.ceil(taskCount / groupSize) }, (_, group) => [
      `document-${group}`, { id: `document-${group}`, title: `Entity ${group} proposal` }
    ])),
    taskWaits: {},
    dependencyDecisions: {}
  };
}

function repeatedProjection(tasks, state) {
  return tasks.map(task => projectTaskManagement(task, state, NOW));
}

function batchedProjection(tasks, state) {
  const byTaskId = projectWorkspaceTaskManagement(tasks, state, NOW);
  return tasks.map(task => byTaskId.get(task.id));
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(2));
}

function measurePair(baseline, optimized, iterations) {
  for (let index = 0; index < 2; index += 1) {
    baseline();
    optimized();
  }
  const baselineSamples = [];
  const optimizedSamples = [];
  const run = (fn, samples) => {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  };
  for (let index = 0; index < iterations; index += 1) {
    if (index % 2) {
      run(optimized, optimizedSamples);
      run(baseline, baselineSamples);
    } else {
      run(baseline, baselineSamples);
      run(optimized, optimizedSamples);
    }
  }
  return { baselineMs: median(baselineSamples), optimizedMs: median(optimizedSamples) };
}

const requestedIterations = Number(process.env.BENCH_ITERATIONS || 5);
const iterations = Number.isFinite(requestedIterations) && requestedIterations >= 1 ? Math.floor(requestedIterations) : 5;
const requestedGroupSize = Number(process.env.BENCH_GROUP_SIZE || 10);
const groupSize = Number.isFinite(requestedGroupSize) && requestedGroupSize >= 1 ? Math.floor(requestedGroupSize) : 10;
console.log(JSON.stringify({
  kind: 'synthetic task-management projection benchmark',
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpus: os.cpus().length,
  iterations,
  groupSize,
  warmups: 2,
  note: 'Synthetic in-memory state only. Includes V8/JIT and host variance; elapsed times are comparisons, not product latency guarantees.'
}, null, 2));

for (const count of sizes) {
  const state = syntheticState(count, groupSize);
  const tasks = Object.values(state.tasks);
  const dependencies = aggregateTaskDependencies(state, NOW);
  const dependencyGroups = dependencies.length;
  const largestDependency = dependencies.reduce((max, item) => Math.max(max, item.taskIds.length), 0);
  const { baselineMs, optimizedMs } = measurePair(
    () => repeatedProjection(tasks, state),
    () => batchedProjection(tasks, state),
    iterations
  );
  console.log(JSON.stringify({
    tasks: count,
    criteriaPerTask: 2,
    dependencyGroups,
    largestDependency,
    baseline: 'repeated-projectTaskManagement',
    baselineMedianMs: baselineMs,
    optimized: 'projectWorkspaceTaskManagement',
    optimizedMedianMs: optimizedMs,
    ratio: Number((baselineMs / optimizedMs).toFixed(2))
  }));
}
