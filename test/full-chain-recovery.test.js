import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '../src/durable/store.js';

const worker = fileURLToPath(new URL('./fixtures/full-chain-worker.mjs', import.meta.url));
const run = (phase, filename, endpoint) => new Promise((resolve, reject) => {
  const child = fork(worker, [phase, filename, endpoint], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal, errors }));
});

test('connector to supervised feedback survives crashes after remote acceptance and after local feedback', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-full-chain-'));
  const filename = path.join(directory, 'state.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let sends = 0, accepted, unavailable = false, modelSawMemory = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.local');
    if (url.pathname === '/model/v1/chat/completions') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const user = JSON.parse(body.messages.find(message => message.role === 'user').content);
      if (user.planningContext?.memory?.some(memory => memory.id === 'cedar-preference')) modelSawMemory = true;
      const message = body.messages.some(item => item.role === 'tool') ? { content: '{"probes":[]}' }
        : { content: null, tool_calls: [{ id: 'source-read', type: 'function', function: { name: 'fixture_lookup', arguments: '{}' } }] };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message }] })); return;
    }
    if (url.pathname === '/send') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      sends++;
      accepted = { id: 'remote-1', provider: 'fixture-mail', status: 'accepted_live', idempotencyKey: payload.idempotencyKey };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(accepted)); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(unavailable ? { status: 'unknown' } : accepted?.idempotencyKey === url.searchParams.get('key') ? { status: 'found', receipt: accepted } : { status: 'not_found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  for (const [phase, code] of [['crash-after-remote', 23], ['recover-unknown', 0], ['crash-during-feedback', 25], ['crash-after-feedback', 24], ['recover', 0]]) {
    unavailable = phase === 'recover-unknown';
    if (phase !== 'crash-after-remote') {
      // Advance abandoned lease deadlines rather than making the test sleep for
      // the production lease duration. The remote requests have already ended.
      const beforeRestart = new SqliteStore(filename);
      beforeRestart.database.atomic(() => beforeRestart.db.prepare("UPDATE jobs SET lease_until=? WHERE state='running'").run('2000-01-01T00:00:00.000Z'));
      beforeRestart.close();
    }
    const result = await run(phase, filename, endpoint);
    assert.equal(result.code, code, `${phase}: ${result.errors}`);
    if (phase === 'crash-during-feedback') {
      const interrupted = new SqliteStore(filename);
      assert.equal(interrupted.db.prepare('SELECT COUNT(*) n FROM feedback_events').get().n, 0, 'feedback must roll back as one unit');
      interrupted.close();
    }
  }
  assert.equal(sends, 1, 'recovery must not dispatch a second external action');
  assert.equal(modelSawMemory, true, 'retrieved memory reaches the real harness request');
  const store = new SqliteStore(filename);
  t.after(() => store.close());
  const task = store.tasks.get('request:m1');
  assert.equal(task.status, 'completed');
  assert.ok(task.situationId);
  assert.equal(task.activation.activate, true);
  const blockers = store.state.notifications.filter(item => item.dedupeKey === `blocker:${task.id}`);
  assert.ok(blockers.length <= 1, 'recovery must not duplicate the same blocker');
  assert.ok(blockers.every(item => item.resolvedAt), 'any unknown-outcome notification resolves after successful reconciliation');
  assert.ok(store.db.prepare('SELECT 1 FROM event_situation_links WHERE event_id=? AND situation_id=?').get('email:m1', task.situationId));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM task_events WHERE task_id=?').get(task.id).n, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM tool_executions WHERE task_id=? AND is_write=1 AND status='verified'").get(task.id).n, 1);
  assert.ok(store.db.prepare("SELECT 1 FROM tool_executions WHERE task_id=? AND provider='mcp' AND is_write=0 AND status='verified'").get(task.id), 'the harness read passes through the task-owned ledger');
  const candidate = store.db.prepare("SELECT * FROM experiences WHERE instruction_text='Use Markdown for Cedar replies.'").get();
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.verified_success_count, 1);
  const evidence = store.db.prepare("SELECT f.kind, f.task_id, f.plan_step_id, f.execution_id, f.artifact_id FROM feedback_events f WHERE f.kind IN ('supervised_success','verified_consumption')").all();
  assert.equal(evidence.filter(row => row.kind === 'supervised_success').length, 1);
  assert.equal(evidence.filter(row => row.kind === 'verified_consumption').length, 1);
  assert.ok(evidence.every(row => row.task_id === task.id && row.plan_step_id && row.execution_id));
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM experience_evidence WHERE experience_id=? AND execution_id=? AND evidence_kind='supervised_success' AND verified=1").get(candidate.id, evidence[0].execution_id).n, 1);
  for (const row of evidence) {
    const jobs = store.db.prepare("SELECT j.state FROM lineage l JOIN jobs j ON j.id=l.derived_id WHERE l.source_kind='feedback' AND l.source_id=(SELECT id FROM feedback_events WHERE execution_id=? AND kind=?) AND l.derived_kind='job'").all(row.execution_id, row.kind);
    assert.deepEqual(jobs.map(job => job.state), ['completed']);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM experiences').get().n, 1, 'the absent compiler must not invent learning');
});
