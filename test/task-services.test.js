import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { TaskServices } from '../src/task-services.js';
import { GoogleDocsWriteProvider } from '../src/document-delivery.js';
import { aggregateTaskDependencies, projectTaskManagement } from '../src/task-management.js';
import { computeProductMetrics } from '../src/metrics.js';
import { requestRevisionSignature } from '../src/commitments.js';

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-task-services-'));
  roots.push(root);
  return new JsonStore(path.join(root, 'state.json'));
}

function seedTask(store, {
  id = 'request:m1',
  subjectEntity = 'Northstar',
  deliverable = 'proposal',
  sourceEmailId = 'm1',
  documentId = 'target',
  status = 'waiting_for_information',
  threadId = 'thread-1',
  sender = 'Alex Doe <ALEX@example.test>',
  targetContent = '# Northstar proposal\n\n## Results\n',
  targetVersion = 1,
  progressSignature = 'semantic-v1',
  deadline = null
} = {}) {
  store.mutate(state => {
    state.inbox.push({ id: sourceEmailId, from: sender, threadId, subject: `${subjectEntity} ${deliverable}`, body: 'Please update the proposal. Pilot result: 12.5%', receivedAt: '2026-10-25T00:00:00.000Z' });
    state.documents.target = {
      id: 'target', title: `${subjectEntity} ${deliverable}`, kind: 'proposal', content: targetContent,
      url: '/documents/target', externalId: null, modifiedAt: '2026-10-24T00:00:00.000Z',
      version: targetVersion, source: 'simulated', available: true
    };
    state.documents.source = {
      id: 'source', title: `${subjectEntity} experiment notes`, kind: 'document', content: 'Pilot result: 12.5%',
      url: '/documents/source', externalId: null, modifiedAt: '2026-10-24T00:00:00.000Z',
      version: 3, source: 'simulated', available: true
    };
    state.tasks[id] = {
      id, status, request: {
        id, text: 'Please update the proposal with Pilot result: 12.5%', intent: 'update_and_send',
        subjectEntity, deliverable, deadline, explicitDocumentUrl: null,
        source: { kind: 'email', id: sourceEmailId, from: sender, threadId, receivedAt: '2026-10-25T00:00:00.000Z' },
        requiredContent: [], impliedClaims: []
      },
      sourceEmailId, sender, subject: `${subjectEntity} ${deliverable}`, createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z', documentId, progress: { at: '2026-10-24T00:00:00.000Z', semanticSignature: progressSignature },
      evidence: { criteria: [], conflicts: [] }, assessment: { complete: false, missing: ['Pilot result'] },
      draft: null, action: null, reason: null
    };
  });
}

function makeEngine(store, { policy = { shadow: false } } = {}) {
  return {
    store,
    mode: 'simulation',
    policy,
    provider: null,
    changedCount: 0,
    changed() { this.changedCount += 1; },
    assess() {},
    ingest(event) {
      this.store.mutate(state => {
        if (!state.events.some(item => item.id === event.id)) state.events.push(event);
        const previous = state.documents[event.payload.id];
        state.documents[event.payload.id] = {
          ...previous,
          ...event.payload,
          id: event.payload.id,
          version: (previous?.version || 0) + 1,
          source: event.source,
          available: true
        };
      });
      return { duplicate: false, id: event.id };
    }
  };
}

const authorization = patch => ({
  kind: 'explicit', taskId: patch.taskId, patchId: patch.id,
  baseDocumentVersion: patch.baseDocument.version, confirmed: true
});

test('a local source-backed patch needs bound consent, applies once, and passes exact persisted readback', async () => {
  const store = makeStore();
  seedTask(store);
  const engine = makeEngine(store);
  const services = new TaskServices(engine);
  const blocked = await services.prepareDocumentPatch('request:m1', {
    provider: 'local',
    changes: [{ type: 'append', text: 'Invented result: 99%', source: { kind: 'email', id: 'm1', quote: 'Invented result: 99%' } }]
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blockers.join(' '), /does not contain its cited quote/);

  const patch = await services.prepareDocumentPatch('request:m1', {
    provider: 'local',
    changes: [{ type: 'append', text: 'Pilot result: 12.5%', source: { kind: 'email', id: 'm1', quote: 'Pilot result: 12.5%' } }]
  });
  assert.equal(patch.status, 'prepared');
  assert.equal(store.state.documents.target.content.includes('Pilot result: 12.5%'), false, 'preparation does not alter the document');
  await assert.rejects(services.applyDocumentPatch('request:m1', { patchId: patch.id }), /explicit consent/);
  const firstApply = services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: authorization(patch) });
  await assert.rejects(
    services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: authorization(patch) }),
    /applying|cannot start another write attempt/
  );
  const result = await firstApply;
  assert.equal(result.patch.status, 'applied');
  assert.equal(result.result.readbackVerified, true);
  assert.equal(result.result.simulated, true);
  assert.match(store.state.documents.target.content, /Pilot result: 12\.5%/);
  const version = store.state.documents.target.version;
  const again = await services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: authorization(patch) });
  assert.equal(again.result.documentVersion, version);
  assert.equal(store.state.documents.target.version, version, 'replay returns the existing verified outcome without another edit');
});

test('a request revision after patch preparation makes the patch stale before local write', async () => {
  const store = makeStore();
  seedTask(store);
  const engine = makeEngine(store);
  const services = new TaskServices(engine);
  const patch = await services.prepareDocumentPatch('request:m1', {
    provider: 'local',
    changes: [{ type: 'append', text: 'Pilot result: 12.5%', source: { kind: 'email', id: 'm1', quote: 'Pilot result: 12.5%' } }]
  });
  const before = store.state.documents.target.content;
  store.mutate(state => { state.tasks['request:m1'].request.text += ' Cancel this request.'; });
  await assert.rejects(services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: authorization(patch) }), /request changed/);
  assert.equal(store.state.documents.target.content, before);
  assert.equal(store.state.documentPatches[patch.id].status, 'stale');
});

test('shadow authorization records a read-only review and never applies the document patch', async () => {
  const store = makeStore();
  seedTask(store);
  const services = new TaskServices(makeEngine(store, { policy: { shadow: true } }));
  const patch = await services.prepareDocumentPatch('request:m1', {
    provider: 'local',
    changes: [{ type: 'append', text: 'Pilot result: 12.5%', source: { kind: 'email', id: 'm1', quote: 'Pilot result: 12.5%' } }]
  });
  const before = store.state.documents.target.content;
  const reviewed = await services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: {
    kind: 'shadow_read_only', taskId: patch.taskId, patchId: patch.id,
    baseDocumentVersion: patch.baseDocument.version, confirmed: true
  } });
  assert.equal(reviewed.patch.status, 'shadow_read_only');
  assert.equal(reviewed.result.applied, false);
  assert.equal(store.state.documents.target.content, before);
});

test('one-click patch preparation selects exact source quotes for a missing criterion and preserves provenance', async () => {
  const store = makeStore();
  seedTask(store);
  store.mutate(state => {
    state.documents.source.content = 'Sample size: 1,200';
    state.tasks['request:m1'].evidence.criteria = [{ id: 'sample_size', label: 'The sample size', required: true, status: 'not_satisfied', evidence: [] }];
    state.tasks['request:m1'].evidence.plan = { specs: [{
      id: 'probe:sample_size', criterionId: 'sample_size', criterionLabel: 'The sample size',
      provider: 'document_text', strategies: [], keywords: [], requiredKeywords: [], requiredAnyKeywords: [],
      builtinProbe: 'sample_size', origin: 'builtin', justified: true, coverage: false
    }] };
  });
  const services = new TaskServices(makeEngine(store));
  const patch = await services.prepareDocumentPatch('request:m1', { provider: 'local' });
  assert.equal(patch.status, 'prepared');
  assert.equal(patch.changes[0].text, 'Sample size: 1,200');
  assert.deepEqual(patch.changes[0].criterionIds, ['sample_size']);
  assert.deepEqual(patch.provenance[0], {
    source: { kind: 'document', id: 'source', version: 3, quote: 'Sample size: 1,200' },
    criterionIds: ['sample_size']
  });
});

test('one-click patch preparation honors a reversible wrong-association exclusion for the cited source document', async () => {
  const store = makeStore();
  seedTask(store);
  store.mutate(state => {
    state.documents.source.content = 'Sample size: 1,200';
    state.tasks['request:m1'].evidence.criteria = [{ id: 'sample_size', label: 'The sample size', required: true, status: 'not_satisfied', evidence: [] }];
    state.tasks['request:m1'].evidence.plan = { specs: [{
      id: 'probe:sample_size', criterionId: 'sample_size', criterionLabel: 'The sample size',
      provider: 'document_text', strategies: [], keywords: [], requiredKeywords: [], requiredAnyKeywords: [],
      builtinProbe: 'sample_size', origin: 'builtin', justified: true, coverage: false
    }] };
  });
  const services = new TaskServices(makeEngine(store));
  const feedback = services.recordTaskFeedback('request:m1', {
    label: 'wrong_association', scope: { subjectEntity: 'Northstar', documentId: 'source' }
  });

  const excluded = await services.prepareDocumentPatch('request:m1', { provider: 'local' });
  assert.equal(excluded.status, 'blocked');
  assert.equal(excluded.changes.length, 0);
  assert.match(excluded.blockers.join(' '), /No identity-linked, current source document/);

  services.undoTaskFeedback(feedback.id);
  const restored = await services.prepareDocumentPatch('request:m1', { provider: 'local' });
  assert.equal(restored.status, 'prepared', 'undo restores this source document to the candidate set');
  assert.equal(restored.changes[0].source.id, 'source');
});

test('one-click patch preparation refuses conflicting source values instead of choosing one', async () => {
  const store = makeStore();
  seedTask(store);
  store.mutate(state => {
    state.documents.source.title = 'Northstar experiment notes';
    state.documents.source.content = 'Sample size: 1,200';
    state.documents.source2 = { ...state.documents.source, id: 'source2', title: 'Northstar run results', content: 'Sample size: 1,400' };
    state.tasks['request:m1'].evidence.criteria = [{ id: 'sample_size', label: 'The sample size', required: true, status: 'not_satisfied', evidence: [] }];
    state.tasks['request:m1'].evidence.plan = { specs: [{
      id: 'probe:sample_size', criterionId: 'sample_size', criterionLabel: 'The sample size',
      provider: 'document_text', strategies: [], keywords: [], requiredKeywords: [], requiredAnyKeywords: [],
      builtinProbe: 'sample_size', origin: 'builtin', justified: true, coverage: false
    }] };
  });
  const services = new TaskServices(makeEngine(store));
  const patch = await services.prepareDocumentPatch('request:m1', { provider: 'local' });
  assert.equal(patch.status, 'blocked');
  assert.equal(patch.changes.length, 0);
  assert.match(patch.blockers.join(' '), /disagree/);
});

test('the Google Docs fake uses documents.batchUpdate writeControl and verifies new text by exact readback', async () => {
  let content = 'Heading\n';
  let revision = 'revision-1';
  let batchUrl = null;
  let batchBody = null;
  const connector = { auth: { configured: () => true, headers: async () => ({ authorization: 'Bearer test' }) } };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      batchUrl = url;
      batchBody = JSON.parse(options.body);
      assert.equal(batchBody.writeControl.requiredRevisionId, 'revision-1');
      for (const request of batchBody.requests) {
        const { index } = request.insertText.location;
        const offset = index - 1;
        content = content.slice(0, offset) + request.insertText.text + content.slice(offset);
      }
      revision = 'revision-2';
    }
    const document = {
      documentId: 'google-doc-1', title: 'Proposal', revisionId: revision,
      body: { content: [{ startIndex: 1, endIndex: content.length + 1, paragraph: { elements: [{ textRun: { content } }] } }] }
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(document) };
  };
  const provider = new GoogleDocsWriteProvider({ connector, enabled: true, shadow: false, fetchImpl });
  const document = { id: 'google-doc-1', externalId: 'google-doc-1', source: 'google', available: true, content, version: 4 };
  const base = await provider.prepareBase(document);
  const applied = await provider.apply({
    document,
    requiredRevisionId: base.revisionId,
    changes: [{ type: 'append', text: 'New result: 12.5%', source: { kind: 'document', id: 'source', version: 3, quote: 'New result: 12.5%' } }]
  });
  assert.match(batchUrl, /\/documents\/google-doc-1:batchUpdate$/);
  assert.equal(batchBody.writeControl.requiredRevisionId, 'revision-1');
  assert.equal(applied.content, 'Heading\nNew result: 12.5%\n');
  assert.equal(applied.revisionId, 'revision-2');
  assert.equal(applied.readbackVerified, true);
});

test('the Google Docs writer refuses a revision mismatch before sending a write', async () => {
  let posts = 0;
  const connector = { auth: { configured: () => true, headers: async () => ({ authorization: 'Bearer test' }) } };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') posts += 1;
    const document = {
      documentId: 'google-doc-1', title: 'Proposal', revisionId: 'revision-2',
      body: { content: [{ startIndex: 1, endIndex: 9, paragraph: { elements: [{ textRun: { content: 'Heading\n' } }] } }] }
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(document) };
  };
  const provider = new GoogleDocsWriteProvider({ connector, enabled: true, shadow: false, fetchImpl });
  await assert.rejects(provider.apply({
    document: { id: 'google-doc-1', externalId: 'google-doc-1', source: 'google', available: true },
    requiredRevisionId: 'revision-1', changes: [{ type: 'append', text: 'New fact' }]
  }), error => error.stale === true);
  assert.equal(posts, 0);
});

test('a withdrawal during Google Docs base read is rechecked immediately before POST', async () => {
  const store = makeStore();
  seedTask(store, { targetContent: 'Heading\n' });
  store.mutate(state => {
    state.documents.target.source = 'google';
    state.documents.target.externalId = 'target-doc';
    state.documents.target.url = 'https://docs.google.com/document/d/target-doc/edit';
  });
  let pauseRead = false;
  let readStartedResolve;
  let releaseReadResolve;
  let posts = 0;
  const readStarted = new Promise(resolve => { readStartedResolve = resolve; });
  const readGate = new Promise(resolve => { releaseReadResolve = resolve; });
  const connector = { auth: { configured: () => true, headers: async () => ({ authorization: 'Bearer test' }) } };
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === 'POST') posts += 1;
    else if (pauseRead) {
      pauseRead = false;
      readStartedResolve();
      await readGate;
    }
    const body = { documentId: 'target-doc', title: 'Proposal', revisionId: 'revision-1', body: {
      content: [{ startIndex: 1, endIndex: 9, paragraph: { elements: [{ textRun: { content: 'Heading\n' } }] } }]
    } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const provider = new GoogleDocsWriteProvider({ connector, enabled: true, shadow: false, fetchImpl });
  const engine = makeEngine(store, { policy: { shadow: false } });
  const services = new TaskServices(engine, { documentProvider: provider });
  const patch = await services.prepareDocumentPatch('request:m1', {
    provider: 'google',
    changes: [{ type: 'append', text: 'Pilot result: 12.5%', source: { kind: 'email', id: 'm1', quote: 'Pilot result: 12.5%' } }]
  });
  assert.equal(patch.status, 'prepared');

  pauseRead = true;
  const apply = services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: authorization(patch) });
  await readStarted;
  store.mutate(state => { state.tasks['request:m1'].status = 'cancelled'; state.tasks['request:m1'].userDismissed = true; });
  releaseReadResolve();

  await assert.rejects(apply, /closed or withdrawn/);
  assert.equal(posts, 0, 'the delayed base read must not cross the final pre-POST guard');
  assert.equal(store.state.documentPatches[patch.id].status, 'stale');
  assert.equal(store.state.documents.target.content, 'Heading\n');
});

test('an unknown Google write result is persisted as uncertain and is never blindly retried', async () => {
  const store = makeStore();
  seedTask(store, { targetContent: 'Heading\n' });
  store.mutate(state => {
    state.documents.target.source = 'google';
    state.documents.target.externalId = 'target-doc';
    state.documents.target.url = 'https://docs.google.com/document/d/target-doc/edit';
  });
  let posts = 0;
  const connector = { auth: { configured: () => true, headers: async () => ({ authorization: 'Bearer test' }) } };
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === 'POST') { posts += 1; throw new Error('connection reset after request start'); }
    const body = { documentId: 'target-doc', title: 'Proposal', revisionId: 'revision-1', body: {
      content: [{ startIndex: 1, endIndex: 9, paragraph: { elements: [{ textRun: { content: 'Heading\n' } }] } }]
    } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const provider = new GoogleDocsWriteProvider({ connector, enabled: true, shadow: false, fetchImpl });
  const engine = makeEngine(store, { policy: { shadow: false } });
  const services = new TaskServices(engine, { documentProvider: provider });
  const patch = await services.prepareDocumentPatch('request:m1', {
    provider: 'google',
    changes: [{ type: 'append', text: 'Pilot result: 12.5%', source: { kind: 'email', id: 'm1', quote: 'Pilot result: 12.5%' } }]
  });
  assert.equal(patch.status, 'prepared');
  await assert.rejects(services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: authorization(patch) }), /uncertain and will not be retried/);
  assert.equal(store.state.documentPatches[patch.id].status, 'uncertain');
  await assert.rejects(services.applyDocumentPatch('request:m1', { patchId: patch.id, authorization: authorization(patch) }), /patch is uncertain/);
  assert.equal(posts, 1);
  assert.equal(store.state.documents.target.content, 'Heading\n', 'the local mirror does not claim a write without provider readback');
});

test('an interrupted applying patch recovers as uncertain and cannot be replayed after restart', async () => {
  const store = makeStore();
  seedTask(store);
  const services = new TaskServices({ store });
  const patch = await services.prepareDocumentPatch('request:m1', {
    provider: 'local',
    changes: [{ type: 'append', text: 'Pilot result: 12.5%', source: { kind: 'email', id: 'm1', quote: 'Pilot result: 12.5%' } }]
  });
  store.mutate(state => {
    state.documentPatches[patch.id].status = 'applying';
    state.documentPatches[patch.id].writeAttemptId = 'process-that-stopped';
  });
  const filename = store.filename;
  store.close();
  const reopened = new JsonStore(filename);
  const recovered = new TaskServices({ store: reopened });
  assert.equal(reopened.state.documentPatches[patch.id].status, 'uncertain');
  assert.equal(reopened.state.documentPatches[patch.id].result.applied, null);
  await assert.rejects(recovered.applyDocumentPatch('request:m1', {
    patchId: patch.id, authorization: authorization(patch)
  }), /patch is uncertain/);
  assert.equal(reopened.state.documents.target.content.includes('Pilot result: 12.5%'), false);
  reopened.close();
});

test('document waits survive a service restart, ignore unrelated events and formatting-only revisions, then wake on semantic change', () => {
  const store = makeStore();
  seedTask(store);
  const taskServices = new TaskServices({ store, clock: () => '2026-10-25T12:00:00.000Z' });
  const wait = taskServices.waitForTask('request:m1', { kind: 'document', dependsOn: { documentId: 'target' } });
  assert.equal(wait.status, 'active');
  const restarted = new TaskServices({ store, clock: () => '2026-10-25T13:00:00.000Z' });
  assert.equal(store.state.taskWaits['request:m1'].id, wait.id);
  assert.equal(restarted.processObservedEvent({ type: 'email.received', at: '2026-10-25T13:00:00.000Z', payload: { id: 'other', threadId: 'elsewhere' } }), false);
  store.mutate(state => {
    state.documents.target.version += 1;
    state.documents.target.content = '# Northstar proposal\n\n## Results **\n';
    state.tasks['request:m1'].progress.semanticSignature = 'semantic-v1';
  });
  assert.equal(restarted.processObservedEvent({ type: 'document.modified', payload: { id: 'target' } }), false, 'format churn keeps the wait asleep');
  assert.equal(store.state.taskWaits['request:m1'].status, 'active');
  store.mutate(state => {
    state.documents.target.version += 1;
    state.documents.target.content += 'Pilot result: 12.5%\n';
    state.tasks['request:m1'].progress.semanticSignature = 'semantic-v2';
  });
  assert.equal(restarted.processObservedEvent({ type: 'document.modified', at: '2026-10-25T13:10:00.000Z', payload: { id: 'target' } }), true);
  assert.equal(store.state.taskWaits['request:m1'].status, 'resolved');
});

test('a missing-information task does not claim the user owns the next step without explicit evidence', () => {
  const store = makeStore();
  seedTask(store);
  const projected = projectTaskManagement(store.state.tasks['request:m1'], store.state, '2026-10-25T12:00:00.000Z');
  assert.deepEqual(projected.owner, { id: 'unknown', label: 'Owner not identified', source: 'unknown' });
  assert.equal(projected.nextAction.kind, 'provide_information');
  assert.equal(projected.nextAction.owner, 'unknown');
});

test('not-mine feedback normalizes a From display name, stays exact-scope and can be undone', () => {
  const store = makeStore();
  seedTask(store);
  store.mutate(state => {
    state.tasks.other = { ...state.tasks['request:m1'], id: 'other', request: { ...state.tasks['request:m1'].request, subjectEntity: 'Aurora' } };
  });
  const services = new TaskServices(makeEngine(store));
  const entry = services.recordTaskFeedback('request:m1', {
    label: 'not_mine', scope: { sender: 'alex@example.test', subjectEntity: 'Northstar' }
  });
  const same = services.matchingFeedbackRules({ request: { subjectEntity: 'Northstar', deliverable: 'proposal' }, message: { from: 'Alex Doe <alex@example.test>' } });
  const other = services.matchingFeedbackRules({ request: { subjectEntity: 'Aurora', deliverable: 'proposal' }, message: { from: 'Alex <alex@example.test>' } });
  assert.equal(same[0].effect, 'suppress_scoped_candidate');
  assert.equal(other.length, 0, 'the same sender in another project is not suppressed');
  assert.equal(store.state.tasks['request:m1'].status, 'waiting_for_information');
  const undone = services.undoTaskFeedback(entry.id);
  assert.equal(undone.active, false);
  assert.equal(services.matchingFeedbackRules({ request: { subjectEntity: 'Northstar' }, message: { from: 'alex@example.test' } }).length, 0);
});

test('already-handled feedback only matches the same thread, sender and semantic request revision', () => {
  const store = makeStore();
  seedTask(store);
  const services = new TaskServices(makeEngine(store));
  const task = store.state.tasks['request:m1'];
  const rule = services.recordTaskFeedback(task.id, {
    label: 'already_handled',
    scope: { threadId: 'thread-1', sender: 'alex@example.test', subjectEntity: 'Northstar', deliverable: 'proposal' }
  });
  assert.deepEqual(rule.handledSnapshot, {
    threadId: 'thread-1', sourceMessageId: 'm1', sender: 'alex@example.test',
    requestRevisionSignature: requestRevisionSignature(task.request)
  });
  const duplicate = { ...task.request, id: 'request:m2', source: { ...task.request.source, id: 'm2' } };
  assert.equal(services.matchingFeedbackRules({
    request: duplicate, message: { id: 'm2', threadId: 'thread-1', from: 'Alex <alex@example.test>' }
  }).some(item => item.effect === 'ignore_as_already_handled'), true);

  const changedRequirement = { ...duplicate, requiredContent: [{ text: 'New sample-size section' }] };
  assert.equal(services.matchingFeedbackRules({
    request: changedRequirement, message: { id: 'm3', threadId: 'thread-1', from: 'Alex <alex@example.test>' }
  }).some(item => item.effect === 'ignore_as_already_handled'), false);
  const otherThread = { ...duplicate, source: { ...duplicate.source, threadId: 'thread-2' } };
  assert.equal(services.matchingFeedbackRules({
    request: otherThread, message: { id: 'm4', threadId: 'thread-2', from: 'Alex <alex@example.test>' }
  }).some(item => item.effect === 'ignore_as_already_handled'), false);
});

test('legacy already-handled feedback derives its original semantic signature conservatively', () => {
  const store = makeStore();
  seedTask(store);
  store.mutate(state => {
    const task = state.tasks['request:m1'];
    task.requestHistory = [{
      revision: 1, kind: 'initial', at: '2026-10-24T00:00:00.000Z', sourceMessageId: 'm1',
      source: { threadId: 'thread-1', from: 'Alex Doe <ALEX@example.test>' },
      request: { ...task.request }, signature: requestRevisionSignature(task.request)
    }];
    state.taskFeedbackRules = { old: {
      id: 'old', taskId: task.id, label: 'already_handled', active: true, createdAt: '2026-10-24T01:00:00.000Z',
      scope: { subjectEntity: 'Northstar', deliverable: 'proposal' }
    } };
  });
  const services = new TaskServices(makeEngine(store));
  const task = store.state.tasks['request:m1'];
  const sameRequest = { ...task.request, id: 'request:later', source: { ...task.request.source, id: 'later' } };
  assert.equal(services.matchingFeedbackRules({
    request: sameRequest, message: { id: 'later', threadId: 'thread-1', from: 'Alex <alex@example.test>' }
  }).some(item => item.effect === 'ignore_as_already_handled'), true);
  const changedDeadline = { ...sameRequest, deadline: { iso: '2026-12-01', text: 'December 1' } };
  assert.equal(services.matchingFeedbackRules({
    request: changedDeadline, message: { id: 'new-deadline', threadId: 'thread-1', from: 'Alex <alex@example.test>' }
  }).some(item => item.effect === 'ignore_as_already_handled'), false);
});

test('engine discovers a same-thread requirement and deadline revision after already-handled feedback', async () => {
  const store = makeStore();
  const engine = new WorkEngine(store, { reasoner: new NullReasoner() });
  const mail = (id, body, receivedAt) => ({
    id: `event:${id}`, type: 'email.received', source: 'simulated', at: receivedAt,
    payload: {
      id, threadId: 'thread-1', from: 'Alex <alex@example.test>', to: 'maya@example.test',
      subject: 'Northstar proposal', body, receivedAt
    }
  });
  try {
    const initialBody = 'Please update the Northstar proposal with the experiment results and send it by November 10, 2026.';
    engine.ingest(mail('handled', initialBody, '2026-10-25T09:00:00.000Z'));
    const taskId = 'request:handled';
    engine.recordTaskFeedback(taskId, {
      label: 'already_handled',
      scope: { threadId: 'thread-1', sender: 'alex@example.test', subjectEntity: 'Northstar', deliverable: 'proposal' }
    });

    engine.ingest(mail('repeat', initialBody, '2026-10-26T09:00:00.000Z'));
    assert.equal(store.state.events.find(item => item.id === 'event:repeat').disposition, 'already_handled');

    engine.ingest(mail('revision', 'Please update the Northstar proposal with the experiment results and sample size and send it by November 12, 2026.', '2026-10-27T09:00:00.000Z'));
    const revisionEvent = store.state.events.find(item => item.id === 'event:revision');
    assert.equal(revisionEvent.disposition, 'request_revision');
    assert.ok(store.state.tasks[taskId].request.requiredContent.some(item => /sample size/i.test(item.text)));
    assert.equal(store.state.tasks[taskId].request.deadline.iso, '2026-11-12');
  } finally {
    if (engine.pending?.size) await engine.whenSettled();
    store.close();
  }
});

test('duplicate corrections require a valid target with the same deliverable and never change completion or permission', () => {
  const store = makeStore();
  seedTask(store);
  store.mutate(state => { state.tasks.duplicate = { ...state.tasks['request:m1'], id: 'duplicate' }; });
  const services = new TaskServices(makeEngine(store));
  assert.throws(() => services.recordTaskFeedback('request:m1', {
    label: 'duplicate', relatedTaskId: 'missing', scope: { threadId: 'thread-1', subjectEntity: 'Northstar', deliverable: 'proposal' }
  }), /existing relatedTaskId/);
  const rule = services.recordTaskFeedback('request:m1', {
    label: 'duplicate', relatedTaskId: 'duplicate', scope: { threadId: 'thread-1', subjectEntity: 'Northstar', deliverable: 'proposal' }
  });
  assert.equal(rule.relatedTaskId, 'duplicate');
  assert.equal(store.state.tasks['request:m1'].status, 'waiting_for_information');
  assert.equal(store.state.tasks['request:m1'].action, null);
});

test('dependency aggregation only groups a common source scope and a provided answer still needs evidence recheck', () => {
  const store = makeStore();
  seedTask(store, { id: 't1' });
  store.mutate(state => {
    state.tasks.t1.evidence.criteria = [{ id: 'sample_size', label: 'Sample size', status: 'not_satisfied', evidence: [], required: true }];
    state.tasks.t1.documentId = 'target';
    state.tasks.t2 = { ...state.tasks.t1, id: 't2', sourceEmailId: 'm2' };
    state.tasks.t3 = { ...state.tasks.t1, id: 't3', documentId: 'other-doc' };
    state.tasks.t4 = { ...state.tasks.t1, id: 't4', userDismissed: true };
    state.documents['other-doc'] = { ...state.documents.target, id: 'other-doc' };
  });
  const dependencies = aggregateTaskDependencies(store.state, '2026-10-25T00:00:00.000Z');
  assert.equal(dependencies.length, 2);
  assert.ok(dependencies.some(item => item.taskIds.includes('t1') && item.taskIds.includes('t2')));
  assert.equal(dependencies.some(item => item.taskIds.includes('t4')), false, 'dismissed work exits shared dependency aggregation');
  const services = new TaskServices({ store });
  const shared = dependencies.find(item => item.taskIds.includes('t1'));
  const answer = services.resolveDependency(shared.id, { decision: 'provided', value: 'See source run R-24' });
  assert.equal(answer.status, 'answered_needs_recheck');
  assert.equal(store.state.tasks.t1.evidence.criteria[0].status, 'not_satisfied');
  assert.equal(projectTaskManagement(store.state.tasks.t1, store.state, '2026-10-25T00:00:00.000Z').nextAction.kind, 'recheck');
});

test('accepted opportunities get one persisted follow-up with owner, action and completion condition', () => {
  const store = makeStore();
  store.mutate(state => { state.opportunities.gap = { id: 'gap', status: 'accepted', kind: 'connect_evidence_source', nextStep: 'Connect the run registry', evidence: [] }; });
  const services = new TaskServices({ store });
  const first = services.createFollowUpForOpportunity('gap');
  const again = services.createFollowUpForOpportunity('gap');
  assert.equal(again.id, first.id);
  assert.deepEqual(first.owner, { id: 'user', label: 'You', source: 'explicit_acceptance' });
  assert.equal(first.nextAction.label, 'Connect the run registry');
  assert.match(first.completionCondition, /required probe completes/);
  assert.equal(Object.keys(store.state.followUps).length, 1);
  const filename = store.filename;
  store.close();
  const reopened = new JsonStore(filename);
  assert.equal(reopened.state.followUps.gap.id, first.id, 'the owner and completion condition survive a process restart');
  assert.equal(new TaskServices({ store: reopened }).createFollowUpForOpportunity('gap').id, first.id, 'acceptance remains idempotent after restart');
  reopened.close();
});

test('outcomes separate user-recognized real delivery from simulated work and keep time-saved unknown', () => {
  const state = {
    tasks: {
      real: { id: 'real', status: 'completed', draft: {}, documentId: 'd', action: { live: true, status: 'verified_live', receiptId: 'gmail-1' }, feedback: { source: 'user', label: 'useful' } },
      simulated: { id: 'simulated', status: 'completed', draft: {}, documentId: 'd', action: { live: false, status: 'verified_simulated', receiptId: 'sim-1' } },
      prepared: { id: 'prepared', status: 'ready_for_approval', draft: {}, documentId: 'd', action: null }
    },
    documentPatches: {
      realPatch: { taskId: 'real', status: 'applied', simulated: false, result: { applied: true, live: true, readbackVerified: true } },
      simulatedPatch: { taskId: 'simulated', status: 'applied', simulated: true, result: { applied: true, simulated: true, readbackVerified: true } },
      preparedPatch: { taskId: 'prepared', status: 'prepared', simulated: true, result: null }
    },
    history: [
      { kind: 'approval', at: '2026-10-24T10:00:00.000Z' },
      { kind: 'patch_applied', at: '2026-10-25T10:00:00.000Z' },
      { kind: 'wait_interrupted', at: '2026-10-23T10:00:00.000Z' }
    ], notifications: [], calibrations: {}, opportunities: {}, events: [], misses: []
  };
  const metrics = computeProductMetrics(state, { now: '2026-10-25T12:00:00.000Z' });
  assert.deepEqual(metrics.outcomes.verifiedDeliveries, { real: 1, simulated: 1 });
  assert.deepEqual(metrics.outcomes.recognizedVerifiedDeliveries, { real: 1, simulated: 0 });
  assert.deepEqual(metrics.outcomes.verifiedDocumentPatches, { real: 1, simulated: 1 });
  assert.deepEqual(metrics.outcomes.recognizedVerifiedDocumentPatches, { real: 1, simulated: 0 });
  assert.equal(metrics.management.activeDays.last7, 1, 'only the explicit approval counts as user activity');
  assert.match(metrics.value.note, /measure time saved/);
});
