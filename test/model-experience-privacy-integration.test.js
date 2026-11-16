import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { DurableReasoningSessions } from '../src/durable/reasoning-sessions.js';

for (const action of ['forget', 'purge-connector']) {
  test(`${action} clears both private model bodies and Experience derivatives while preserving unrelated work and unknown spend`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-experience-privacy-'));
    const store = new SqliteStore(path.join(directory, 'state.json'));
    const engine = new WorkEngine(store, { reasoner: new NullReasoner('fixture') });
    const runtime = new DurableRuntime(engine, { tickMs: 1000000 });
    t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const sessions = new DurableReasoningSessions(store.database), records = [];
    for (const [connector, project] of [['google', 'A'], ['notion', 'B']]) {
      const task = store.tasks.createOrLoad({ candidateKey: `privacy-${connector}`, data: {
        sourceConnectorId: connector, request: { subjectEntity: project, deliverable: 'report' }
      } });
      const effect = { type: 'review_requirements', required: true };
      const experience = runtime.experiences.create({ kind: 'planning_hint', scopeType: 'project', scopeKey: project,
        directiveKey: 'review.required', effect, instruction: `PRIVATE-INSTRUCTION-${connector}`, freshnessClass: 'stable' },
      { sources: [{ kind: 'task', id: task.taskId }] });
      runtime.trials.saveCases(experience.id, { expectedRevision: 1, expectedCaseSetVersion: 0, userRequested: true,
        cases: [{ id: 'literal', scope: [{ type: 'project', key: project }], features: {},
          expected: { applies: true, winner: 'candidate', effect: { type: 'review_requirements', required: true } } }] });
      assert.equal(runtime.trials.evaluate(experience.id, { expectedRevision: 1 }).state, 'passed');
      const active = runtime.experiences.adopt(experience.id, { expectedRevision: 1, userRequested: true });
      const owner = { kind: 'workspace', ownerId: `privacy-${connector}`, token: `token-${connector}` };
      const session = sessions.begin({ logicalKey: `private-${connector}`, owner,
        bindings: { authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1 },
        isCurrent: () => true, conversation: { secret: `PRIVATE-PROMPT-${connector}` },
        sourceRefs: [{ kind: 'task', id: task.taskId }, { kind: 'connector', id: connector }] });
      sessions.awaitCommit({ id: session.id, owner, claimId: session.claimId, final: { secret: `PRIVATE-FINAL-${connector}` },
        turn: 1, calls: 0, isCurrent: () => true });
      records.push({ taskId: task.taskId, experienceId: active.id, sessionId: session.id });
    }
    const [first, other] = records;
    runtime.tokenBudget.reserve({ attemptId: 'uncertain-dispatch', taskId: first.taskId, inputTokens: 10, outputTokens: 20 });
    runtime.tokenBudget.markDispatched('uncertain-dispatch'); runtime.tokenBudget.markUnknown('uncertain-dispatch');
    store.refresh();
    if (action === 'forget') await runtime.privacy.forget({ kind: 'task', id: first.taskId });
    else await runtime.privacy.revokePermission({ connectorId: 'google', purgeLocal: true });
    const row = store.db.prepare('SELECT * FROM reasoning_sessions WHERE id=?').get(first.sessionId);
    assert.equal(row.status, 'invalidated');
    for (const field of ['conversation_json', 'pending_json', 'final_json', 'claim_id']) assert.equal(row[field], null);
    assert.equal(runtime.experiences.get(first.experienceId), undefined);
    for (const table of ['experience_trials', 'experience_trial_case_sets', 'experience_content_versions']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE experience_id=?`).get(first.experienceId).n, 0);
    }
    assert.equal(runtime.experiences.validTrialPass(runtime.experiences.get(other.experienceId)), true);
    assert.equal(sessions.read({ id: other.sessionId }).hasFinal, true);
    assert.equal(runtime.tokenBudget.describe().workspace.unknown, 30);
  });
}
