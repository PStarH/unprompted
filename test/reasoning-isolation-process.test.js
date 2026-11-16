import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DurableDatabase } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';

/**
 * Two real processes reuse the same SQLite database and the same task/job
 * context. Exactly one obtains the invocation claim and reaches the fake
 * provider; the other is refused with SESSION_BUSY.
 */

const childSource = `
import fs from 'node:fs';
import { DurableDatabase } from ${JSON.stringify(new URL('../src/durable/database.js', import.meta.url).href)};
import { DurableReasoningSessions } from ${JSON.stringify(new URL('../src/durable/reasoning-sessions.js', import.meta.url).href)};
const database = new DurableDatabase(process.env.DB_PATH);
const sessions = new DurableReasoningSessions(database);
const job = JSON.parse(process.env.JOB_JSON);
const spec = JSON.parse(process.env.SPEC_JSON);
spec.isCurrent = () => true;
let calls = 0;
const reasoner = { model: 'm-1', protocol: 'chat-completions', fetchImpl: async () => {
  calls += 1;
  fs.writeFileSync(process.env.COUNT_PATH, String(calls));
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [] }) };
} };
const context = { scope: 'task', taskId: process.env.TASK_ID, session: { ...spec, owner: { kind: 'job', job } } };
try {
  const turn = sessions.classicTurn({ reasoner, requestId: process.env.MODE, system: 'synthetic system', user: 'synthetic user', context });
  if (process.env.MODE === 'holder') {
    fs.writeFileSync(process.env.CLAIMED_PATH, 'claimed');
    while (!fs.existsSync(process.env.RELEASE_PATH)) await new Promise(resolve => setTimeout(resolve, 20));
    await sessions.runClassic(turn, () => sessions.sessionFetch(reasoner, process.env.MODE)('https://synthetic.invalid', { body: '{}' }));
    database.close();
    process.exit(0);
  }
  fs.writeFileSync(process.env.RESULT_PATH, 'acquired');
  database.close();
  process.exit(2);
} catch (error) {
  if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, error.code || error.message);
  else console.error(error);
  database.close();
  process.exit(error.code === 'SESSION_BUSY' ? 0 : 3);
}
`;

function spawnChild(env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; if (process.env.DEBUG_CHILD) process.stderr.write(chunk); });
  return { child, done: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stderr }))) };
}

async function waitFor(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

test('two processes on the same task and logical key obtain one fetch capability', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-isolation-process-'));
  const databasePath = path.join(directory, 'state.sqlite');
  const database = new DurableDatabase(databasePath);
  const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 });
  const tasks = new DurableTasks(database, jobs);
  t.after(() => { try { database.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); });
  const created = tasks.createOrLoad({ candidateKey: 'process-task', data: { subject: 'process', request: { subjectEntity: 'project', deliverable: 'report' } } });
  const queued = jobs.list({ taskId: created.taskId }).find(job => job.state === 'queued');
  const job = jobs.claim('parent', { id: queued.id });
  const spec = { logicalKey: 'two-process-key', semanticStage: 'general',
    bindings: { authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1 }, isCurrent: true };
  const common = {
    DB_PATH: databasePath, TASK_ID: created.taskId,
    JOB_JSON: JSON.stringify({ id: job.id, task_id: job.task_id, lease_owner: job.lease_owner, lease_token: job.lease_token }),
    SPEC_JSON: JSON.stringify(spec),
    CLAIMED_PATH: path.join(directory, 'claimed'), RELEASE_PATH: path.join(directory, 'release'),
    COUNT_PATH: path.join(directory, 'count')
  };
  const holder = spawnChild({ ...common, MODE: 'holder' });
  await waitFor(common.CLAIMED_PATH);
  const contender = spawnChild({ ...common, MODE: 'contender', RESULT_PATH: path.join(directory, 'contender-result') });
  const contenderExit = await contender.done;
  assert.equal(contenderExit.code, 0, contenderExit.stderr);
  assert.equal(fs.readFileSync(path.join(directory, 'contender-result'), 'utf8'), 'SESSION_BUSY');
  assert.equal(fs.existsSync(common.COUNT_PATH), false, 'the refused process never reached the fake provider');
  fs.writeFileSync(common.RELEASE_PATH, 'go');
  const holderExit = await holder.done;
  assert.equal(holderExit.code, 0, holderExit.stderr);
  assert.equal(fs.readFileSync(common.COUNT_PATH, 'utf8'), '1', 'the holder fetched exactly once');
  const row = database.db.prepare('SELECT claim_id,claim_epoch,owner_id FROM reasoning_sessions WHERE logical_key=?').get('two-process-key');
  assert.ok(row?.claim_id);
  assert.equal(row.claim_epoch, 1, 'the contender did not obtain a second claim');
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM reasoning_sessions').get().n, 1);
});
