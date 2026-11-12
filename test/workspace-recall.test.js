import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';

const email = (id, threadId, subject, body) => ({
  id: `event:${id}`, type: 'email.received', source: 'simulated', connectorId: 'simulated',
  payload: { id, threadId, from: 'alex@example.test', to: 'reader@example.test', subject, body, receivedAt: '2026-10-26T10:00:00Z' }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-recall-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime };
}

test('a task can read connected memories, documents, messages and other work without calling a provider', async t => {
  const { store, engine, runtime } = fixture(t);
  runtime.suspended = true;
  engine.ingest(email('initial', 'cedar-thread', 'Cedar proposal', 'Please update the Cedar budget proposal with the experiment results and send it by Friday.'));
  engine.ingest(email('other', 'finance-thread', 'Cedar budget check', 'Please update the Cedar budget figure and send it to finance by Friday.'));
  engine.ingest({ id: 'event:notes', type: 'document.modified', source: 'local_files', connectorId: 'local_files',
    payload: { id: 'notes-1', title: 'Cedar budget notes', content: 'The Cedar budget notes live in the selected folder.' } });
  engine.ingest({ id: 'event:secret', type: 'document.modified', source: 'slack', connectorId: 'slack',
    payload: { id: 'secret-1', title: 'Cedar budget secret', content: 'The Cedar budget secret belongs to a revoked source.' } });
  runtime.memory.put({ id: 'ceiling', content: 'The Cedar budget ceiling is 40000 dollars.', scopeType: 'global', scopeKey: '*' });
  runtime.memory.put({ id: 'private-budget', content: 'Cedar budget for another project', scopeType: 'project', scopeKey: 'other-project' });
  await runtime.privacy.revokePermission({ connectorId: 'slack', purgeLocal: false });
  const task = store.tasks.get('request:initial');
  assert.ok(task, 'the source email did not become a task');
  const queued = runtime.jobs.list().find(job => job.task_id === task.id && ['queued', 'retry_wait'].includes(job.state));
  assert.ok(queued, 'the task has no queued run');
  const job = runtime.jobs.claim('recall-test', { id: queued.id });
  const run = runtime.tasks.beginRun(job);
  runtime.tasks.checkpoint(run, job, { expectedInputVersion: task.inputVersion, contextVersion: Number(runtime.database.get('context_version')), sources: [], plan: {} });
  runtime.suspended = false;
  await runtime.scope.run({ taskId: task.id, job, run }, async () => {
    const tools = runtime.tools({ taskId: task.id, isCurrent: () => true });
    const search = tools.find(tool => tool.name === 'search_workspace');
    const read = tools.find(tool => tool.name === 'read_workspace_record');
    const found = JSON.parse((await search.execute('search', { query: 'Cedar budget' })).content[0].text);
    const ids = found.records.map(record => `${record.kind}:${record.id}`);
    assert.ok(ids.includes('memory:ceiling'));
    assert.ok(ids.includes('document:notes-1'));
    assert.ok(ids.includes('message:other'));
    assert.ok(ids.includes('work:request:other'));
    assert.equal(ids.some(id => id.includes('secret') || id.includes('private-budget')), false);
    const ceiling = JSON.parse((await read.execute('read', { kind: 'memory', id: 'ceiling' })).content[0].text);
    assert.match(ceiling.content, /40000/);
    await assert.rejects(read.execute('revoked', { kind: 'document', id: 'secret-1' }), { code: 'TASK_CONTEXT_UNAVAILABLE' });
    await assert.rejects(read.execute('scoped', { kind: 'memory', id: 'private-budget' }), { code: 'TASK_CONTEXT_UNAVAILABLE' });
    runtime.tasks.finish(run, job);
    runtime.jobs.complete(job);
    await assert.rejects(search.execute('stale', { query: 'Cedar budget' }), { code: 'TASK_CONTEXT_UNAVAILABLE' });
  });
});
