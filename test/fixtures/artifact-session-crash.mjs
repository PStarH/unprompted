/**
 * Controlled child for the artifact/session atomicity crash tests.
 *
 * mode=before-link  kill inside the store transaction before the operation link
 * mode=after-link   kill after the operation link but before the store commit
 * mode=after-commit kill after the real request returned, before any external effect
 * mode=recover      replay the same operation and prove no duplicate request/job
 */
import fs from 'node:fs';
import path from 'node:path';
import { SqliteStore } from '../../src/durable/store.js';
import { DurableRuntime } from '../../src/durable/runtime.js';
import { WorkEngine } from '../../src/engine.js';
import { PermissionPolicy } from '../../src/permissions.js';
import { DurableReasoningSessions, runWithOperation } from '../../src/durable/reasoning-sessions.js';
import { draftReviewToken } from '../../src/draft-review.js';

const directory = process.env.CRASH_DIR;
const mode = process.env.CRASH_MODE;
const target = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const records = new Map();
const connection = {
  connector: {
    id: 'notion', live: true, config: {}, folders: [], accountId: 'notion-account',
    auth: { accessToken: async () => 'PRIVATE_TOKEN' },
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (options.method === 'POST') {
        const id = 'cccccccc-1111-2222-3333-dddddddddddd';
        records.set(id, JSON.parse(options.body));
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id }) };
      }
      const remoteId = parsed.pathname.split('/').at(-1);
      if (parsed.pathname.endsWith('/children')) {
        const page = records.get(parsed.pathname.split('/').at(-2));
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results: page?.children || [], has_more: false }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ object: 'page', id: remoteId, archived: false, ...(records.get(remoteId) || {}) }) };
    }
  },
  accountId: 'notion-account', scopes: []
};

const store = new SqliteStore(path.join(directory, 'state.json'));
const engine = new WorkEngine(store, { policy: new PermissionPolicy({}) });
const runtime = new DurableRuntime(engine, { tickMs: 100000, artifactConnectionFor: id => id === 'notion' ? connection : null });
engine.ingest({ id: 'email:m1', source: 'google', connectorId: 'google', type: 'email.received', payload: { id: 'm1', threadId: 'thread:m1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
engine.ingest({ id: 'doc:1', type: 'document.modified', payload: { id: 'cedar-proposal', kind: 'proposal', title: 'Cedar project proposal', content: '# Cedar proposal\n## Experiment results\nSample size: 1,200\nConclusion: Treatment improved conversion.\n' } });
await engine.whenSettled();
const taskId = 'request:m1';
const grant = await runtime.artifacts.createGrant({ connectorId: 'notion', targetId: target }, { confirmed: true });
const sessions = new DurableReasoningSessions(runtime.database, { claimLeaseMs: 1000, workspaceLeaseMs: 1000 });
const existing = sessions.read({ scope: 'workspace', logicalKey: 'artifact-crash-session' });
const session = existing
  ? sessions.begin({ logicalKey: 'artifact-crash-session', owner: { kind: 'workspace', ownerId: 'crash-owner', token: 'crash-token' }, isCurrent: () => true, bindings: { authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1 } })
  : sessions.begin({ logicalKey: 'artifact-crash-session', owner: { kind: 'workspace', ownerId: 'crash-owner', token: 'crash-token' }, isCurrent: () => true, conversation: { marker: 'crash' }, bindings: { authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1 } });
const operationId = 'crash-artifact-operation';
const operation = { sessionId: session.id, operationId, turn: 0, callIndex: 0, tool: 'create_work_artifact', effect: 'write', argsDigest: 'digest' };
if (!sessions.operation({ id: session.id, operationId })) {
  sessions.toolIntent({ id: session.id, owner: session.owner, claimId: session.claimId, turn: 0, callIndex: 0, tool: 'create_work_artifact',
    effect: 'write', args: { grantId: grant.id }, operationId, isCurrent: () => true });
}

const crash = () => { process.kill(process.pid, 'SIGKILL'); };
if (mode === 'before-link') {
  runtime.database.db.function('crash_now', crash);
  runtime.database.db.exec("CREATE TRIGGER crash_link BEFORE INSERT ON reasoning_session_operations WHEN NEW.operation_id='crash-artifact-operation' BEGIN SELECT crash_now(); END");
} else if (mode === 'after-link') {
  runtime.database.db.function('crash_now', crash);
  runtime.database.db.exec('CREATE TRIGGER crash_commit BEFORE UPDATE ON workspace_state WHEN NEW.version > OLD.version BEGIN SELECT crash_now(); END');
}

const request = () => runtime.artifacts.request(taskId, { grantId: grant.id, title: 'Cedar 工作进展', body: 'Project findings\nA source-backed summary.' },
  { actor: 'user', reviewToken: draftReviewToken(runtime.tasks.get(taskId)) });
const pending = runWithOperation(operation, request);
fs.writeFileSync(path.join(directory, `${mode}.json`), JSON.stringify({ id: pending.id }));
if (mode === 'after-commit') process.kill(process.pid, 'SIGKILL');
await runtime.close();
await engine.whenSettled();
store.close();
