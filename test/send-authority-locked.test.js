import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, SQLITE_RUNTIME, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';
import { authorizeForTests } from '../src/authority-credential.js';
import { PermissionPolicy } from '../src/permissions.js';
import { GoogleWorkspaceConnector, gmailMessageId } from '../src/connectors/google.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-locked-'));
  let now = Date.now();
  const database = new DurableDatabase(path.join(directory, 'workspace.sqlite'), { now: () => now });
  const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 });
  const tasks = new DurableTasks(database, jobs);
  const ledger = new ToolExecutionLedger(database, { jobs, tasks, timeoutMs: 50 });
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { database, jobs, tasks, ledger, directory, advance: value => { now += value; } };
}
function running(context) {
  const created = context.tasks.createOrLoad({ candidateKey: 'locked', data: { subject: 'Locked', request: { subjectEntity: 'Cedar', deliverable: 'proposal' } } });
  const job = context.jobs.claim('worker');
  const run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  return { taskId: created.taskId, job, run };
}
function openIntent(context, current, key = 'send-key') {
  return context.ledger.intent({ ...current, provider: 'gmail', tool: 'send', actionFamily: 'email.send', resourceId: 'thread', key, effect: { type: 'email_reply', bodyDigest: 'digest' }, payload: { idempotencyKey: key }, authorize: () => authorizeForTests({ id: key, taskId: current.taskId }) });
}

test('schema v8 adds evidence and authority columns on an existing database', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-schema-'));
  const filename = path.join(directory, 'workspace.sqlite');
  const created = new DurableDatabase(filename);
  assert.equal(created.db.pragma('user_version', { simple: true }), 8);
  created.db.exec('ALTER TABLE tool_executions DROP COLUMN evidence_json');
  created.db.exec('ALTER TABLE tool_executions DROP COLUMN authority_json');
  created.db.pragma('user_version=7');
  created.close();
  const upgraded = new DurableDatabase(filename);
  const names = upgraded.db.pragma('table_info(tool_executions)').map(column => column.name);
  assert.equal(names.filter(name => name === 'evidence_json').length, 1);
  assert.equal(names.filter(name => name === 'authority_json').length, 1);
  assert.equal(upgraded.db.pragma('user_version', { simple: true }), SQLITE_RUNTIME.schemaVersion);
  upgraded.close();
  const again = new DurableDatabase(filename);
  t.after(() => { again.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(again.db.pragma('table_info(tool_executions)').filter(column => column.name === 'evidence_json').length, 1);
});

test('a forgeable permission string is not an execute_external credential', () => {
  const policy = new PermissionPolicy();
  assert.throws(() => policy.authorize({ actionClass: 'execute_external', approval: { permission: 'user_approved', taskId: 't' }, taskId: 't' }), /requires explicit/);
  assert.equal(policy.authorize({ actionClass: 'observe' }).allowed, true);
});

test('verified is terminal and a dispatched key cannot be posted again', async t => {
  const context = fixture(t), current = running(context);
  const intent = openIntent(context, current, 'verified-key');
  await context.ledger.dispatch(intent, { ...current, live: true, send: async () => ({ id: 'message-1', idempotencyKey: 'verified-key' }), verify: async () => ({ status: 'found', receipt: { id: 'message-1', idempotencyKey: 'verified-key' }, detail: 'read back' }) });
  assert.equal(context.ledger.byKey('verified-key').status, 'verified');
  assert.ok(context.ledger.byKey('verified-key').evidence_json);
  const again = context.ledger.reconcile(context.ledger.byKey('verified-key').id, { live: true, lookup: async () => ({ status: 'not_found' }) });
  assert.equal((await again).status, 'found');
  assert.equal(context.ledger.byKey('verified-key').status, 'verified');
  const duplicate = openIntent(context, current, 'verified-key');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.claim, null);
  const second = openIntent(context, current, 'unverified-key');
  assert.throws(() => context.ledger.verified(second.execution.id, { id: 'stamp', idempotencyKey: 'unverified-key' }), /read-back predicate/);
  assert.equal(context.ledger.get(second.execution.id).status, 'intent');
});

test('attestation releases the claim and refuses to reopen the dispatched key', async t => {
  const context = fixture(t), current = running(context);
  const intent = openIntent(context, current, 'absent-key');
  await assert.rejects(context.ledger.dispatch(intent, { ...current, live: true, send: async () => { throw Object.assign(new Error('timed out'), { code: 'OUTCOME_UNKNOWN' }); } }));
  const row = context.ledger.byKey('absent-key');
  assert.equal(row.status, 'unknown');
  assert.ok(row.dispatched_at);
  const attested = context.ledger.attestAbsent(row.id);
  assert.equal(attested.status, 'failed');
  assert.equal(attested.last_error_class, 'user_attested_absent');
  const claim = context.database.db.prepare('SELECT claim_state FROM resource_claims WHERE current_execution_id=?').get(row.id);
  assert.equal(claim, undefined);
  assert.throws(() => openIntent(context, current, 'absent-key'), /RECONCILIATION_REQUIRED|reconciled/);
});

test('live dispatched 429 does not become confirmed_no_effect', async t => {
  const context = fixture(t), current = running(context);
  const intent = openIntent(context, current, 'rate-key');
  await assert.rejects(context.ledger.dispatch(intent, { ...current, live: true, send: async () => { throw Object.assign(new Error('rate'), { status: 429, definitiveNoEffect: true }); } }));
  const row = context.ledger.byKey('rate-key');
  assert.equal(row.status, 'unknown');
  assert.notEqual(row.last_error_class, 'confirmed_no_effect');
});

test('a hung Gmail send performs one POST', async () => {
  let calls = 0;
  const connector = new GoogleWorkspaceConnector({
    config: { clientId: 'fixture', clientSecret: 'fixture', refreshToken: 'fixture', sendEnabled: true, shadow: false, maxRetries: 4, timeoutMs: 30 },
    fetchImpl: async (url, options) => {
      if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'fixture', expires_in: 3600 }) };
      calls += 1;
      assert.equal(options.method, 'POST');
      return new Promise(() => {});
    }
  });
  await assert.rejects(connector.execute({ to: 'alex@example.test', subject: 'Test', body: 'Body', idempotencyKey: 'hung-key' }));
  assert.equal(calls, 1);
  assert.equal(gmailMessageId('hung-key').includes('unprompted-'), true);
});

test('startup cancels intent rows that have no authority', t => {
  const context = fixture(t), current = running(context);
  const at = iso(context.database.now());
  context.database.db.prepare(`INSERT INTO tool_executions(id,task_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES('bare','${current.taskId}','gmail','send','email.send','thread','bare-key','{}','intent',1,0,0,0,?,?)`).run(at, at);
  assert.equal(context.ledger.cancelMissingAuthority(), 1);
  assert.equal(context.ledger.byKey('bare-key').status, 'cancelled');
});
