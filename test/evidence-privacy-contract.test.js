import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';

const reply = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  deliverable: 'proposal', subjectEntity: 'Cedar', requiredContent: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });

function fixture(t, fetchImpl = async () => reply()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-privacy-contract-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const clock = Date.now(); store.database.now = () => clock;
  const state = { calls: 0, birchCalls: 0, cedarCalls: 0 };
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 },
    fetchImpl: async (url, init) => {
      state.calls++; const wire = String(init.body || '');
      if (wire.includes('Birch')) state.birchCalls++;
      if (wire.includes('Cedar')) state.cedarCalls++;
      return fetchImpl(url, init, wire);
    } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime, reasoner, state };
}

function task(f, project) {
  const created = f.store.tasks.createOrLoad({ candidateKey: `scope-${project}`, data: {
    subject: `${project} proposal`, request: { text: `Update the ${project} proposal.`, subjectEntity: project, deliverable: 'proposal' } } });
  f.store.refresh();
  const queued = f.store.jobs.list({ taskId: created.taskId }).find(entry => entry.job_type === 'task_initial');
  const job = f.store.jobs.claim(`owner-${project}`, { id: queued.id });
  const run = f.store.tasks.beginRun(job);
  f.store.tasks.checkpoint(run, job, { expectedInputVersion: f.store.tasks.get(created.taskId).inputVersion, plan: {} });
  f.store.refresh();
  return { taskId: created.taskId, job, run };
}

function nativeContext(f, item) {
  return f.runtime.taskModelContext(item.taskId, { key: `interpret:${item.taskId}`,
    durableFence: f.runtime.capture(item.taskId) }, { stage: 'interpret', catalogVersion: 'interpret/no-tools/v1' });
}
const session = (f, taskId) => f.store.db.prepare('SELECT * FROM reasoning_sessions WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(taskId);

test('a late native model result cannot commit after its scoped Memory is revised; an independent native task keeps its committed result without a new provider call or job', { timeout: 15000 }, async t => {
  let releaseCedar;
  const cedarHeld = new Promise(resolve => { releaseCedar = resolve; });
  let enterCedar;
  const entered = new Promise(resolve => { enterCedar = resolve; });
  t.after(() => releaseCedar());
  const f = fixture(t, async (_url, _init, wire) => {
    if (wire.includes('Cedar')) { enterCedar(); await cedarHeld; }
    return reply();
  });
  const memory = f.runtime.memory.put({ id: 'cedar-brief', content: 'Cedar brief uses the old amounts.', scopeType: 'project', scopeKey: 'Cedar' });
  const a = task(f, 'Cedar'), b = task(f, 'Birch');
  f.store.mutate(state => {
    state.tasks[a.taskId].contextManifest = { selected: [{ kind: 'memory', id: memory.id, version: memory.version }], deferred: [], overridden: [] };
    state.tasks[b.taskId].contextManifest = { selected: [], deferred: [], overridden: [] };
  });

  await f.runtime.scope.run({ taskId: b.taskId, job: b.job, run: b.run }, async () => {
    const context = nativeContext(f, b);
    await f.reasoner.interpretRequest({ subject: 'Birch proposal', body: 'Update the Birch proposal.' }, 'birch-native', context);
    assert.deepEqual(f.runtime.modelCommits.commitSql(context, () => {
      const current = f.store.tasks.get(b.taskId);
      f.store.tasks.update(b.taskId, current.stateVersion, data => { data.request.text = 'Birch accepted the committed native result.'; });
      return 'birch-committed';
    }), { committed: true, value: 'birch-committed' });
  });
  assert.equal(session(f, b.taskId).status, 'completed');
  assert.equal(f.state.birchCalls, 1);
  const bJobs = f.store.jobs.list({ taskId: b.taskId }).length;

  const pending = f.runtime.scope.run({ taskId: a.taskId, job: a.job, run: a.run }, async () => {
    const context = nativeContext(f, a);
    await f.reasoner.interpretRequest({ subject: 'Cedar proposal', body: 'Update the Cedar proposal.' }, 'cedar-native', context);
  });
  await entered;
  assert.equal(f.store.tasks.get(a.taskId).contextManifest.selected[0].version, memory.version);
  try {
    const updated = f.runtime.memorySpace.update(memory.id, { operation: 'edit', content: 'Cedar brief uses corrected amounts.', expectedVersion: memory.version });
    assert.equal(updated.memory.content, 'Cedar brief uses corrected amounts.');
    assert.equal(updated.replacementId, null);
  } finally { releaseCedar(); }
  await assert.rejects(pending, error => ['CONTEXT_CHANGED', 'SESSION_NOT_CURRENT', 'INVALID_SESSION_COMMIT'].includes(error.code));

  const aRow = session(f, a.taskId);
  assert.notEqual(aRow.status, 'completed');
  assert.equal(f.store.tasks.get(a.taskId).request.text, 'Update the Cedar proposal.');
  assert.equal(f.store.db.prepare('SELECT content,version FROM user_memories WHERE id=?').get(memory.id).version, memory.version + 1);

  assert.equal(session(f, b.taskId).status, 'completed');
  assert.equal(f.store.tasks.get(b.taskId).request.text, 'Birch accepted the committed native result.');
  assert.equal(f.state.birchCalls, 1);
  assert.equal(f.store.jobs.list({ taskId: b.taskId }).length, bJobs);
  assert.equal(f.runtime.isCurrent(b.taskId, f.runtime.capture(b.taskId)), true);
});
