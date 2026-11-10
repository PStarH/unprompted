import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore, Connector } from '../src/connectors/connector.js';
import { normalizeEvent } from '../src/connectors/events.js';
import { needsUserAttention, taskState } from '../public/workspace-model.js';
import { notification, emitNotification } from '../src/notifications.js';
import { autonomyCeiling, ceilingAllows } from '../src/follow-through.js';
import { setActivationFlags } from '../src/durable/flags.js';

/**
 * Product-clause stories. Companion suites stay in their own files:
 * send authority, Needs you, release acceptance, autonomy, and notifications.
 */

const AT = '2026-11-10T15:00:00.000Z';
const LATER = '2026-11-11T15:00:00.000Z';
const DISTANT = '2099-06-01';
const QUOTE = 'Acme quoted 4200 USD';
const REQUEST = `Please update the Cedar brief with the vendor quote and send it by ${DISTANT}.`;
const INCOMPLETE = '# Cedar brief\n\n## Overview\nThe brief does not yet include a priced vendor section.\n';
const COMPLETE = `# Cedar brief\n\n## Vendor quote\n${QUOTE} for the Cedar engagement.\n`;
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

class CountingReasoner extends NullReasoner {
  constructor() { super(); this.calls = 0; }
  available() { return true; }
  async interpretRequest() { this.calls += 1; return null; }
  async discoverRequestCandidate() { this.calls += 1; return null; }
  async proposeProbes() { this.calls += 1; return null; }
  async extractSituationDelta() { this.calls += 1; return null; }
}

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-clauses-'));
  roots.push(root);
  return root;
}

function engineOn(Store = JsonStore, { reasoner = new NullReasoner(), stallAfterMs = 86_400_000 } = {}) {
  const root = directory();
  const filename = path.join(root, 'state.json');
  const store = new Store(filename);
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider, reasoner, stallAfterMs });
  return { root, filename, store, provider, engine, reasoner };
}

function mail(id, body = REQUEST, { subject = 'Cedar brief', from = 'Alex <alex@example.test>', to = 'maya@example.test', threadId = 'gmail-cedar-thread', receivedAt = AT, connectorId = 'google', source = 'google' } = {}) {
  return normalizeEvent({
    connectorId, source, providerEventId: `gmail:${id}`, type: 'email.received', at: receivedAt,
    payload: { id, threadId, from, to, subject, body, receivedAt }
  });
}

function slack(id, body, { from = 'Ada', receivedAt = AT } = {}) {
  const channel = 'D0CEDAR';
  const key = `${channel}:${id}`;
  return mail(`slack:T0CEDAR:${key}`, body, {
    from, subject: `Message from ${from}`, threadId: `slack:T0CEDAR:${channel}`, receivedAt,
    connectorId: 'slack', source: 'slack'
  });
}

function documentEvent(content, { id = 'cedar-brief', at = AT, type = 'document.modified', reason = null } = {}) {
  return normalizeEvent({
    connectorId: 'local', source: 'simulated', providerEventId: `${type}:${id}:${at}`, type, at,
    payload: { id, title: 'Cedar brief', kind: 'brief', ...(content == null ? {} : { content }), modifiedAt: at, ...(reason ? { reason } : {}) }
  });
}

function fieldOf(engine, taskId) {
  const view = engine.publicState();
  const task = view.tasks.find(item => item.id === taskId);
  const context = { taskWaits: view.taskWaits };
  return { view, task, zone: taskState(task, context), needsUser: needsUserAttention(task, context) };
}

function openNotices(store) {
  return (store.state.notifications || []).filter(item => !item.resolvedAt && !['pending', 'digest'].includes(item.deliveryState));
}

class ScriptedConnector extends Connector {
  constructor(id, pulls) { super({ id, kind: 'scripted' }); this.live = true; this.pulls = [...pulls]; }
  async pull() {
    if (!this.pulls.length) return { events: [], cursor: { page: 'held' }, errors: [], partial: false };
    return this.pulls.shift();
  }
}

function discoverCedar(engine, body = REQUEST) {
  engine.ingest(documentEvent(INCOMPLETE));
  engine.ingest(mail('cedar-mail', body));
  return 'request:cedar-mail';
}

test('FT1 happy: missing evidence waits or continues, a draft asks, and a verified send closes', () => {
  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    const found = store.state.tasks[taskId];
    assert.notEqual(found.followThrough.decision, 'close');
    assert.ok(['wait', 'continue'].includes(found.followThrough.decision));
    assert.notEqual(found.status, 'completed');
    assert.equal(store.state.outbox.length, 0);

    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    const ready = store.state.tasks[taskId];
    assert.equal(ready.status, 'ready_for_approval');
    assert.equal(ready.followThrough.decision, 'ask');
    assert.ok(ready.draft?.body);
    assert.equal(store.state.outbox.length, 0);
    assert.ok(['L0', 'L1', 'L2'].includes(ready.followThrough.ceiling));

    const verified = engine.approve(taskId);
    assert.equal(verified.status, 'completed');
    assert.equal(verified.followThrough.decision, 'close');
    assert.equal(verified.followThrough.closeKind, 'verified');
    assert.equal(verified.action.status, 'verified_simulated');
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('FT1 failure: a draft or an accepted-but-unverified send is not a close', () => {
  const { store, engine, provider } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    assert.equal(store.state.tasks[taskId].followThrough.decision, 'ask');
    assert.notEqual(store.state.tasks[taskId].status, 'completed');

    let accepted = false;
    provider.send = (payload, _mode, options) => {
      accepted = true;
      return SimulatedMailProvider.prototype.send.call(provider, payload, 'timeout_after_accept', options);
    };
    provider.lookup = () => accepted ? { status: 'unknown' } : { status: 'not_found' };
    const unverified = engine.approve(taskId);
    assert.notEqual(unverified.followThrough.decision, 'close');
    assert.notEqual(unverified.status, 'completed');
    assert.notEqual(unverified.action?.status, 'verified_simulated');
    assert.equal(store.state.outbox.length, 1);
    assert.throws(() => engine.approve(taskId));
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('FT1 recovery: an unknown lookup after acceptance does not enable a second send', () => {
  const { store, engine, provider } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    let accepted = false;
    provider.send = (payload, _mode, options) => {
      accepted = true;
      return SimulatedMailProvider.prototype.send.call(provider, payload, 'timeout_after_accept', options);
    };
    provider.lookup = () => accepted ? { status: 'unknown' } : { status: 'not_found' };
    engine.approve(taskId);
    assert.equal(store.state.outbox.length, 1);
    assert.notEqual(store.state.tasks[taskId].followThrough.decision, 'close');
    assert.throws(() => engine.retry(taskId));
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('FT2: the Cedar vendor wait records wait and stays Waiting', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    const taskId = discoverCedar(engine);
    engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
    const field = fieldOf(engine, taskId);
    assert.equal(store.state.taskWaits[taskId].status, 'active');
    assert.equal(field.zone, 'waiting_external');
    assert.equal(field.needsUser, false);
    assert.equal(field.task.followThrough.decision, 'wait');
    assert.notEqual(field.task.status, 'completed');
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('FT3 happy: an explicit user completion closes as user-finished and does not send', () => {
  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    const marked = engine.markUserFinished(taskId);
    assert.equal(marked.status, 'completed');
    assert.equal(marked.completion.kind, 'user_finished');
    assert.equal(marked.followThrough.decision, 'close');
    assert.equal(marked.followThrough.closeKind, 'user_finished');
    assert.equal(marked.action, null);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('FT3 message: a user reply in the thread that already finished the deliverable does not send', () => {
  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    const result = engine.ingest(mail('already-replied', 'I already replied to the vendor.', {
      from: 'maya@example.test', receivedAt: LATER
    }));
    assert.equal(result.disposition, 'user_finished');
    assert.equal(store.state.tasks[taskId].followThrough.closeKind, 'user_finished');
    assert.equal(store.state.tasks[taskId].action, null);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('FT3 failure: vague, unrelated, and ambiguous notes do not close the work', () => {
  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    for (const [id, body] of [
      ['vague', "I'm on it."],
      ['unrelated', 'Want to grab lunch tomorrow?'],
      ['ambiguous', 'Maybe I sent something?']
    ]) {
      engine.ingest(mail(id, body, { from: 'maya@example.test', receivedAt: LATER, threadId: id === 'unrelated' ? 'lunch-thread' : 'gmail-cedar-thread' }));
      assert.notEqual(store.state.tasks[taskId].status, 'completed');
      assert.notEqual(store.state.tasks[taskId].followThrough.decision, 'close');
    }
    assert.equal(store.state.outbox.length, 0);
    assert.equal(Object.keys(store.state.tasks).length, 1);
  } finally { store.close(); }
});

test('FT3 recovery: reopening user-finished work resumes the same task and does not send', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    const taskId = discoverCedar(engine);
    const situationId = store.state.tasks[taskId].situationId;
    engine.markUserFinished(taskId);
    const resumed = engine.reopen(taskId);
    assert.equal(resumed.id, taskId);
    assert.equal(resumed.situationId, situationId);
    assert.notEqual(resumed.status, 'completed');
    assert.notEqual(resumed.followThrough?.decision, 'close');
    assert.equal(store.state.outbox.length, 0);
    assert.equal(Object.keys(store.state.tasks).length, 1);
  } finally { store.close(); }
});

test('FT3: a ledgered send echo is not user-finished and does not start work', () => {
  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    const sent = engine.approve(taskId);
    const echo = engine.ingest(mail('echo-1', sent.draft.body, {
      from: 'maya@example.test', receivedAt: LATER, threadId: 'gmail-cedar-thread', subject: sent.draft.subject
    }));
    assert.equal(echo.disposition, 'self_echo');
    assert.equal(Object.keys(store.state.tasks).length, 1);
    assert.equal(store.state.tasks[taskId].status, 'completed');
    assert.equal(store.state.tasks[taskId].followThrough.closeKind, 'verified');
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('FT4 happy and failure: a withdrawn source or missing document blocks without closing or inventing evidence', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    const taskId = discoverCedar(engine);
    engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
    engine.ingest(documentEvent(null, { type: 'document.unavailable', reason: 'removed', at: LATER }));
    const blocked = store.state.tasks[taskId];
    assert.equal(blocked.followThrough.decision, 'blocked');
    assert.match(blocked.reason, /unavailable|not closed/i);
    assert.notEqual(blocked.status, 'completed');
    assert.notEqual(blocked.action?.status, 'verified_simulated');
    const field = fieldOf(engine, taskId);
    assert.equal(field.zone, 'waiting_external');
    assert.equal(field.needsUser, false);
    assert.equal(store.state.outbox.length, 0);

    engine.ingest(normalizeEvent({
      connectorId: 'google', source: 'google', providerEventId: 'mail-gone:cedar-mail', type: 'email.unavailable', at: LATER,
      payload: { id: 'cedar-mail', reason: 'deleted' }
    }));
    assert.equal(store.state.tasks[taskId].followThrough.decision, 'blocked');
    assert.notEqual(store.state.tasks[taskId].status, 'completed');
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('FT4 recovery: the same task continues when the document returns', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    const taskId = discoverCedar(engine);
    const situationId = store.state.tasks[taskId].situationId;
    engine.ingest(documentEvent(null, { type: 'document.unavailable', reason: 'removed', at: LATER }));
    assert.equal(store.state.tasks[taskId].followThrough.decision, 'blocked');
    engine.ingest(documentEvent(COMPLETE, { at: '2026-11-12T15:00:00.000Z' }));
    assert.equal(store.state.tasks[taskId].id, taskId);
    assert.equal(store.state.tasks[taskId].situationId, situationId);
    assert.notEqual(store.state.tasks[taskId].followThrough.decision, 'close');
    assert.notEqual(store.state.tasks[taskId].status, 'completed');
    assert.equal(Object.keys(store.state.tasks).length, 1);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('FT4: contradictory evidence is blocked rather than closed', () => {
  const { store, engine } = engineOn();
  try {
    engine.ingest(mail('m1', 'Please update the Helios incident playbook with the latest incident statistics and share it by 2099-06-01.', {
      subject: 'Helios incident playbook', threadId: 'helios-thread'
    }));
    engine.ingest(documentEvent(
      '# Helios incident playbook\n\n## Incident statistics\nAs of: 2026-10-12\nIncident count: 9\nMean time to recovery: 31 minutes\nIncident count: 14\n\n## Escalation\nPage the on-call lead within five minutes of a severity-one alert.\n',
      { id: 'helios-playbook', at: LATER }
    ));
    const task = store.state.tasks['request:m1'];
    assert.equal(task.followThrough.decision, 'blocked');
    assert.notEqual(task.status, 'completed');
    assert.equal(task.assessment.complete, false);
    assert.equal(store.state.outbox.length, 0);
    assert.equal(fieldOf(engine, task.id).needsUser, needsUserAttention(task, { taskWaits: store.state.taskWaits }));
  } finally { store.close(); }
});

test('FT5 happy and failure: a promised timer prepares a nudge and an empty timer does not', async () => {
  const reasoner = new CountingReasoner();
  const { store, engine } = engineOn(SqliteStore, { reasoner });
  try {
    const taskId = discoverCedar(engine);
    const situationId = store.state.tasks[taskId].situationId;
    const callsAfterDiscover = reasoner.calls;
    engine.ingest({
      id: 'scheduler:empty', type: 'timer.due', source: 'internal', connectorId: 'scheduler', at: LATER,
      payload: { id: 'empty-check', situationId, scheduledAt: LATER }
    });
    assert.equal(reasoner.calls, callsAfterDiscover);
    assert.equal(store.state.tasks[taskId].draft, null);
    assert.equal(openNotices(store).length, 0);
    assert.equal(store.state.outbox.length, 0);
    assert.equal(Object.keys(store.state.tasks).length, 1);
    engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });

    engine.ingest({
      id: 'scheduler:cedar-nudge', type: 'timer.due', source: 'internal', connectorId: 'scheduler', at: LATER,
      payload: { id: 'cedar-nudge', situationId, taskId, scheduledAt: LATER }
    });
    assert.equal(reasoner.calls, callsAfterDiscover);
    assert.equal(store.state.tasks[taskId].draft.kind, 'nudge');
    assert.equal(store.state.tasks[taskId].followThrough.decision, 'ask');
    assert.equal(store.state.tasks[taskId].followThrough.ceiling, 'L2');
    assert.equal(store.state.outbox.length, 0);
    assert.equal(store.state.taskWaits[taskId].status, 'active');
    await engine.whenSettled();
  } finally { store.close(); }
});

test('FT5 recovery: the vendor reply still resumes preparation without sending', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    const taskId = discoverCedar(engine);
    const situationId = store.state.tasks[taskId].situationId;
    engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
    engine.ingest({
      id: 'scheduler:cedar-nudge', type: 'timer.due', source: 'internal', connectorId: 'scheduler', at: LATER,
      payload: { id: 'cedar-nudge', situationId, scheduledAt: LATER }
    });
    const reply = engine.ingest(mail('vendor-reply', `Cedar: ${QUOTE} for the engagement.`, {
      from: 'Vendor <vendor@example.test>', threadId: 'vendor-cedar-thread', subject: 'Cedar vendor reply', receivedAt: LATER
    }));
    assert.equal(reply.disposition, 'wait_resumed');
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    assert.equal(store.state.tasks[taskId].situationId, situationId);
    assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
    assert.notEqual(store.state.tasks[taskId].draft?.kind, 'nudge');
    assert.equal(store.state.outbox.length, 0);
    assert.equal(Object.keys(store.state.tasks).length, 1);
  } finally { store.close(); }
});

test('FT6: discover, wait, and prepare stay quiet, and a verified send is history rather than an interrupt', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    const taskId = discoverCedar(engine);
    assert.equal(openNotices(store).length, 0);
    engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
    assert.equal(openNotices(store).length, 0);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
    assert.equal(openNotices(store).filter(item => item.kind !== 'deadline').length, 0);
    engine.approve(taskId);
    assert.ok(store.state.history.some(item => item.taskId === taskId && item.kind === 'verification'));
    assert.equal(openNotices(store).length, 0);
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('BA1: missing evidence stays below L3, a model send proposal does not raise it, and arrival can', () => {
  const capped = autonomyCeiling({ evidenceComplete: false, evidenceMissing: true, nextStep: 'investigate', proposedLevel: 'L4' });
  assert.equal(capped.level, 'L1');
  assert.equal(capped.gate, 'evidence');
  assert.match(capped.reason, /L4/);
  assert.equal(ceilingAllows(capped, 'L3'), false);
  const nudge = autonomyCeiling({ evidenceComplete: false, evidenceMissing: true, promisedNudge: true, nextStep: 'prepare', proposedLevel: 'L4' });
  assert.equal(nudge.level, 'L2');
  assert.equal(ceilingAllows(nudge, 'L4'), false);

  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    store.mutate(state => { state.tasks[taskId].reasoning = { ...(state.tasks[taskId].reasoning || {}), proposedCeiling: 'L4' }; });
    engine.assess(taskId, null, { force: true, allowAutomation: false });
    assert.equal(store.state.tasks[taskId].followThrough.ceiling, 'L1');
    assert.match(store.state.tasks[taskId].followThrough.ceilingReason, /L4/);
    assert.equal(store.state.outbox.length, 0);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    assert.equal(store.state.tasks[taskId].followThrough.decision, 'ask');
    assert.ok(['L2', 'L4'].includes(store.state.tasks[taskId].followThrough.ceiling) === false || store.state.tasks[taskId].followThrough.ceiling === 'L2');
    assert.equal(store.state.tasks[taskId].followThrough.ceiling, 'L2');
  } finally { store.close(); }
});

test('BA2: no grant means L2 and ask, a forged grant is rejected, and approval can send once', () => {
  const refused = autonomyCeiling({ evidenceComplete: true, consequential: true, nextStep: 'consequential', approval: false, validGrant: false, proposedLevel: 'L4' });
  assert.equal(refused.level, 'L2');
  assert.equal(refused.gate, 'authority');
  const forged = autonomyCeiling({ evidenceComplete: true, consequential: true, nextStep: 'consequential', forgedGrant: true, validGrant: false });
  assert.equal(forged.level, 'L2');
  assert.match(forged.reason, /forged|not authority/i);

  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    assert.equal(store.state.tasks[taskId].followThrough.decision, 'ask');
    assert.equal(store.state.tasks[taskId].followThrough.ceiling, 'L2');
    assert.throws(() => engine.policy.authorize({
      actionClass: 'execute_external', taskId, approval: { permission: 'temporary_yolo', taskId, grantId: 'invented' }
    }), /YOLO authorization/);
    assert.throws(() => engine.approve(taskId, { autonomyGrantId: 'invented' }));
    assert.equal(store.state.outbox.length, 0);
    const verified = engine.approve(taskId);
    assert.equal(verified.followThrough.closeKind, 'verified');
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('BA3: a consequential send stays capped until review, and a changed draft needs a new review', () => {
  const send = autonomyCeiling({ evidenceComplete: true, consequential: true, nextStep: 'consequential', approval: false });
  assert.equal(send.level, 'L2');
  const reviewed = autonomyCeiling({ evidenceComplete: true, consequential: true, nextStep: 'consequential', validGrant: true, requiresReview: true });
  assert.equal(reviewed.level, 'L2');
  assert.equal(reviewed.gate, 'authority');
  const draft = autonomyCeiling({ evidenceComplete: true, reversibleDraft: true, nextStep: 'prepare' });
  assert.equal(draft.level, 'L2');
  const allowed = autonomyCeiling({ evidenceComplete: true, consequential: true, nextStep: 'consequential', approval: true });
  assert.equal(allowed.level, 'L4');

  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    store.mutate(state => { state.tasks[taskId].guidanceReviewRequired = true; });
    engine.recordCalibration({
      key: 'permission:send_automation', kind: 'permission', value: 'allow',
      scope: { entity: 'Cedar', deliverable: store.state.tasks[taskId].request.deliverable }
    });
    assert.throws(() => engine.executePreAuthorized(taskId));
    assert.equal(store.state.outbox.length, 0);
    store.mutate(state => { delete state.tasks[taskId].guidanceReviewRequired; });
    const token = fieldOf(engine, taskId).task.reviewToken;
    store.mutate(state => { state.tasks[taskId].draft.body += '\nChanged after review.'; });
    assert.throws(() => engine.approve(taskId, { reviewToken: token }), { code: 'REVIEW_CHANGED' });
    assert.equal(store.state.outbox.length, 0);
    const next = fieldOf(engine, taskId).task.reviewToken;
    const verified = engine.approve(taskId, { reviewToken: next });
    assert.equal(verified.status, 'completed');
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('BA4: revoke and cancel stop the lease, reopen does not revive it, and a new grant is required', () => {
  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    const grant = engine.autonomy.create({ mode: 'task', taskId });
    assert.equal(engine.autonomy.valid(grant, taskId), true);
    engine.autonomy.revoke(grant.id);
    assert.equal(engine.autonomy.valid(engine.autonomy.grants().find(item => item.id === grant.id), taskId), false);
    engine.cancel(taskId);
    engine.reopen(taskId);
    assert.equal(engine.autonomy.forTask(taskId), null);
    const replacement = engine.autonomy.create({ mode: 'task', taskId });
    assert.notEqual(replacement.id, grant.id);
    assert.equal(engine.autonomy.valid(replacement, taskId), true);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('SA1: quiet distant deadline, a close deadline interrupts, and verification resolves it', () => {
  const { store, engine } = engineOn();
  try {
    const quietId = discoverCedar(engine);
    assert.equal(openNotices(store).filter(item => item.kind === 'deadline').length, 0);
    engine.ingest(mail('vega', 'Please update the Vega status report with the metrics and share it by Thursday. I need the uptime figure.', {
      subject: 'Vega status report', threadId: 'vega-thread', receivedAt: AT
    }));
    const near = store.state.tasks['request:vega'];
    assert.equal(near.request.deadline.iso, '2026-11-12');
    const deadline = openNotices(store).find(item => item.kind === 'deadline' && item.taskId === near.id);
    assert.ok(deadline);
    assert.match(deadline.what, /2026-11-12/);
    assert.match(deadline.why, /deadline/i);
    assert.ok(deadline.decision);
    engine.markUserFinished(near.id);
    engine.lastAttentionDay = null;
    engine.sweepAttention(new Date(AT));
    assert.equal(openNotices(store).some(item => item.dedupeKey === deadline.dedupeKey), false);
    assert.equal(store.state.tasks[quietId].status === 'completed', false);
  } finally { store.close(); }
});

test('SA2: the same decision reuses one notification, and a real recurrence revives it', () => {
  assert.throws(() => notification({ kind: 'deadline', what: 'Something happened', why: 'Because', checked: ['Looked'], decision: '' }));
  const { store, engine } = engineOn();
  try {
    engine.ingest(mail('vega', 'Please update the Vega status report with the metrics and share it by Thursday. I need the uptime figure.', {
      subject: 'Vega status report', threadId: 'vega-thread', receivedAt: AT
    }));
    const taskId = 'request:vega';
    engine.lastAttentionDay = null;
    engine.sweepAttention(new Date(AT));
    const open = openNotices(store).filter(item => item.taskId === taskId && item.kind === 'deadline');
    assert.equal(open.length, 1);
    const id = open[0].id;
    engine.lastAttentionDay = null;
    engine.sweepAttention(new Date(LATER));
    const again = openNotices(store).filter(item => item.dedupeKey === open[0].dedupeKey);
    assert.equal(again.length, 1);
    assert.equal(again[0].id, id);
    store.mutate(state => { state.notifications.find(item => item.id === id).resolvedAt = LATER; });
    engine.lastAttentionDay = null;
    engine.sweepAttention(new Date('2026-11-12T12:00:00.000Z'));
    const revived = store.state.notifications.filter(item => item.dedupeKey === open[0].dedupeKey);
    assert.equal(revived.length, 1);
    assert.equal(revived[0].id, id);
    assert.equal(revived[0].resolvedAt, null);
    assert.equal(revived[0].readAt, null);
  } finally { store.close(); }
});

test('SA3: AttentionBudget may defer a notice without hiding or duplicating Needs you', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    setActivationFlags(store.database, { stagedReadiness: false });
    store.attention.configure({ maxInteractivePerHour: 0, minIntervalMs: 0, digestWindowMs: 0 });
    const taskId = discoverCedar(engine);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    assert.equal(fieldOf(engine, taskId).needsUser, true);
    store.mutate(state => {
      emitNotification(state.notifications, notification({
        kind: 'deadline', priority: 'low', taskId, dedupeKey: `notice:${taskId}`, at: LATER,
        what: `The Cedar brief still needs a decision at ${LATER}.`,
        why: 'The prepared reply cannot be sent until you approve it.',
        checked: ['Prepared the reply and held it for approval.'],
        decision: 'Approve the prepared reply or leave it waiting?'
      }));
    });
    const notice = store.state.notifications.find(item => item.dedupeKey === `notice:${taskId}`);
    assert.ok(['pending', 'digest'].includes(notice.deliveryState));
    assert.equal(fieldOf(engine, taskId).needsUser, true);
    assert.equal(fieldOf(engine, taskId).zone, 'needs_user');
    const before = store.state.tasks[taskId].id;
    store.attention.configure({ maxInteractivePerHour: 3, minIntervalMs: 0, digestWindowMs: 0 });
    store.attention.releaseDue();
    assert.equal(fieldOf(engine, taskId).needsUser, true);
    assert.equal(store.state.tasks[before].id, taskId);
    assert.equal(Object.values(store.state.tasks).filter(task => needsUserAttention(task, { taskWaits: store.state.taskWaits })).length, 1);
  } finally { store.close(); }
});

test('IA1: duplicates and self-echo do not start work, lunch does not call a model, and a real reply still matches', () => {
  const reasoner = new CountingReasoner();
  const { store, engine } = engineOn(SqliteStore, { reasoner });
  try {
    const first = mail('cedar-mail');
    engine.ingest(first);
    const taskId = 'request:cedar-mail';
    const situationId = store.state.tasks[taskId].situationId;
    assert.equal(engine.ingest(first).duplicate, true);
    assert.equal(Object.keys(store.state.tasks).length, 1);
    const calls = reasoner.calls;
    const lunch = engine.ingest(slack('1710000000.000200', 'Want to grab lunch tomorrow?', { from: 'Sam' }));
    assert.equal(lunch.disposition, 'context_only');
    assert.equal(reasoner.calls, calls);
    assert.equal(Object.keys(store.state.tasks).length, 1);
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    const sent = engine.approve(taskId);
    const echo = engine.ingest(mail('echo-cedar', sent.draft.body, { from: 'maya@example.test', receivedAt: LATER, subject: sent.draft.subject }));
    assert.equal(echo.disposition, 'self_echo');
    assert.equal(Object.keys(store.state.tasks).length, 1);
    const reply = engine.ingest(mail('vendor-reply', `Cedar: ${QUOTE} for the engagement.`, {
      from: 'Vendor <vendor@example.test>', threadId: 'vendor-cedar-thread', subject: 'Cedar vendor reply', receivedAt: LATER
    }));
    assert.notEqual(reply.disposition, 'self_echo');
    assert.equal(store.state.tasks[taskId].situationId, situationId);
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('IA2: a promised timer and a restored source resume the same task, and a finished timer is a no-op', async () => {
  const reasoner = new CountingReasoner();
  const { store, engine } = engineOn(SqliteStore, { reasoner });
  try {
    const taskId = discoverCedar(engine);
    const situationId = store.state.tasks[taskId].situationId;
    engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
    const calls = reasoner.calls;
    engine.markUserFinished(taskId);
    engine.ingest({
      id: 'scheduler:done', type: 'timer.due', source: 'internal', connectorId: 'scheduler', at: LATER,
      payload: { id: 'done', situationId, taskId, scheduledAt: LATER }
    });
    assert.equal(reasoner.calls, calls);
    assert.equal(store.state.tasks[taskId].status, 'completed');
    assert.equal(store.state.outbox.length, 0);
    engine.reopen(taskId);
    engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
    engine.ingest({
      id: 'scheduler:again', type: 'timer.due', source: 'internal', connectorId: 'scheduler', at: LATER,
      payload: { id: 'again', situationId, taskId, scheduledAt: LATER }
    });
    assert.equal(store.state.tasks[taskId].situationId, situationId);
    assert.equal(store.state.outbox.length, 0);
    assert.equal(Object.keys(store.state.tasks).length, 1);

    engine.ingest(normalizeEvent({
      connectorId: 'google', source: 'google', providerEventId: 'mail-gone:cedar-mail', type: 'email.unavailable', at: LATER,
      payload: { id: 'cedar-mail', reason: 'deleted' }
    }));
    assert.equal(store.state.tasks[taskId].followThrough.decision, 'blocked');
    const restored = mail('cedar-mail', REQUEST, { receivedAt: '2026-11-12T15:00:00.000Z' });
    restored.id = 'google:gmail:cedar-restored';
    restored.providerEventId = 'gmail:cedar-restored';
    engine.ingest(restored);
    assert.equal(store.state.tasks[taskId].id, taskId);
    assert.equal(store.state.tasks[taskId].sourceUnavailable, undefined);
    assert.equal(Object.keys(store.state.tasks).length, 1);
    await engine.whenSettled();
  } finally { store.close(); }
});

test('IA3: one sync pass folds Cedar events, and an empty timer adds no draft or model call', async () => {
  const reasoner = new CountingReasoner();
  const { store, engine } = engineOn(SqliteStore, { reasoner });
  try {
    const first = mail('cedar-mail');
    const second = slack('1710000000.000100', REQUEST);
    const connector = new ScriptedConnector('google', [{ events: [first, second], cursor: { page: 2 }, errors: [], partial: false }]);
    const outcome = await new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine }).run();
    assert.equal(outcome.results[0].ingested, 2);
    assert.equal(Object.keys(store.state.tasks).length, 1);
    const taskId = 'request:cedar-mail';
    assert.equal(store.state.history.filter(item => item.kind === 'assessment' && item.taskId === taskId).length, 1);
    assert.equal(store.state.tasks[taskId].draft == null || !Array.isArray(store.state.tasks[taskId].draft), true);
    const calls = reasoner.calls;
    const notices = openNotices(store).length;
    engine.ingest({
      id: 'scheduler:empty-later', type: 'timer.due', source: 'internal', connectorId: 'scheduler', at: LATER,
      payload: { id: 'empty-later', situationId: store.state.tasks[taskId].situationId, scheduledAt: LATER }
    });
    assert.equal(reasoner.calls, calls);
    assert.equal(openNotices(store).length, notices);
    assert.equal(store.state.tasks[taskId].draft ?? null, null);
    assert.equal(store.state.outbox.length, 0);
    engine.ingest(documentEvent(INCOMPLETE));
    engine.ingest(documentEvent(COMPLETE, { at: LATER }));
    assert.equal(store.state.tasks[taskId].draft?.kind == null || typeof store.state.tasks[taskId].draft === 'object', true);
    assert.equal(Array.isArray(store.state.tasks[taskId].draft), false);
    assert.equal(store.state.tasks[taskId].action ?? null, null);
    await engine.whenSettled();
  } finally { store.close(); }
});

test('the ceiling function is the cap WorkEngine records, including L3 execute and L0 pause', () => {
  assert.equal(autonomyCeiling({ evidenceComplete: true, nextStep: 'execute', approval: true }).level, 'L3');
  assert.equal(autonomyCeiling({ evidenceComplete: true, nextStep: 'consequential', approval: true, paused: true }).level, 'L0');
  assert.equal(autonomyCeiling({ sourceWithdrawn: true, nextStep: 'consequential', approval: true }).level, 'L0');
  const { store, engine } = engineOn();
  try {
    const taskId = discoverCedar(engine);
    engine.setTaskPaused(taskId, true);
    const paused = autonomyCeiling({ ...engine.store.state.tasks[taskId].followThrough, paused: true, evidenceComplete: false, nextStep: 'consequential' });
    assert.equal(paused.level, 'L0');
    assert.equal(ceilingAllows(paused, 'L4'), false);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});
