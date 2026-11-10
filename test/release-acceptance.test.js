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
import { GoogleDocsWriteProvider } from '../src/document-delivery.js';
import { needsUserAttention, taskState, stateGroup } from '../public/workspace-model.js';

/**
 * Release-acceptance scenes. Companion suites keep their own files:
 * send authority, sync, Needs you, and test/full-chain-recovery.test.js.
 * Slack direct messages use the event type SlackConnector.pull records.
 */

const AT = '2026-11-01T15:00:00.000Z';
const LATER = '2026-11-02T15:00:00.000Z';
const DEADLINE = '2099-06-01';
const QUOTE = 'Acme quoted 4200 USD';
const REQUEST = `Please update the Cedar brief with the vendor quote and send it by ${DEADLINE}.`;
const INCOMPLETE = '# Cedar brief\n\n## Overview\nThe brief does not yet include a priced vendor section.\n';
const COMPLETE = `# Cedar brief\n\n## Vendor quote\n${QUOTE} for the Cedar engagement.\n`;
const USER_TEXT = 'The user wrote this Cedar sentence and it must stay.';
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-release-'));
  roots.push(root);
  return root;
}

function engineOn(Store, { stallAfterMs = 86_400_000 } = {}) {
  const root = directory();
  const filename = path.join(root, 'state.json');
  const store = new Store(filename);
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider, reasoner: new NullReasoner(), stallAfterMs });
  return { root, filename, store, provider, engine };
}

function mail({ connectorId, source, providerEventId, id, threadId, from, to = 'maya@example.test', subject, body, receivedAt = AT }) {
  return normalizeEvent({
    connectorId, source, providerEventId, type: 'email.received', at: receivedAt,
    payload: { id, threadId, from, to, subject, body, receivedAt }
  });
}

function gmail(id, body = REQUEST, { subject = 'Cedar brief', from = 'Alex <alex@example.test>', threadId = 'gmail-cedar-thread', receivedAt = AT } = {}) {
  return mail({
    connectorId: 'google', source: 'google', providerEventId: `gmail:${id}`,
    id, threadId, from, subject, body, receivedAt
  });
}

// SlackConnector.pull emits this type for a direct message. It is not an
// email.received label invented by a harness fixture; see src/connectors/slack.js.
function slack(id, body = REQUEST, { from = 'Ada', receivedAt = AT } = {}) {
  const teamId = 'T0CEDAR';
  const channel = 'D0CEDAR';
  const key = `${channel}:${id}`;
  return mail({
    connectorId: 'slack', source: 'slack', providerEventId: `dm:${teamId}:${key}`,
    id: `slack:${teamId}:${key}`, threadId: `slack:${teamId}:${channel}`,
    from, subject: `Message from ${from}`, body, receivedAt
  });
}

function documentEvent(content, { id = 'cedar-doc', at = AT } = {}) {
  return normalizeEvent({
    connectorId: 'local', source: 'simulated', providerEventId: `doc:${id}`, type: 'document.modified', at,
    payload: { id: 'cedar-brief', title: 'Cedar brief', kind: 'brief', content, modifiedAt: at }
  });
}

function fieldOf(engine, taskId) {
  const view = engine.publicState();
  const task = view.tasks.find(item => item.id === taskId);
  const context = { taskWaits: view.taskWaits };
  return { view, task, zone: taskState(task, context), needsUser: needsUserAttention(task, context) };
}

function cedarTasks(store) {
  return Object.values(store.state.tasks).filter(task => task.request?.subjectEntity === 'Cedar' && !['completed', 'cancelled'].includes(task.status) && !task.userDismissed);
}

function openSituations(store) {
  return store.db.prepare("SELECT id, lifecycle_state FROM situations WHERE lifecycle_state IN ('OPEN','OBSERVING')").all();
}

function situationLinks(store, situationId) {
  return store.db.prepare('SELECT event_id FROM event_situation_links WHERE situation_id=? ORDER BY event_id').all(situationId).map(row => row.event_id);
}

class ScriptedConnector extends Connector {
  constructor(id, pulls) {
    super({ id, kind: 'scripted' });
    this.live = true;
    this.pulls = [...pulls];
  }
  async pull() {
    if (!this.pulls.length) return { events: [], cursor: { page: 'held' }, errors: [], partial: false };
    return this.pulls.shift();
  }
}

function discoverPair(engine) {
  const first = gmail('cedar-mail');
  const second = slack('1710000000.000100');
  engine.ingest(first);
  engine.ingest(second);
  return { first, second, taskId: 'request:cedar-mail' };
}

test('scene 1 happy: mail and Slack attach to one open commitment', () => {
  const slackSource = fs.readFileSync(new URL('../src/connectors/slack.js', import.meta.url), 'utf8');
  assert.match(slackSource, /type: 'email\.received'/, 'the Slack connector emits email.received for a direct message');
  const { store, engine } = engineOn(SqliteStore);
  try {
    const { first, second, taskId } = discoverPair(engine);
    assert.equal(second.type, 'email.received');
    assert.equal(first.source, 'google');
    assert.equal(second.source, 'slack');
    const tasks = cedarTasks(store);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, taskId, 'the first stable task id is kept');
    assert.equal(store.state.tasks[`request:${second.payload.id}`], undefined);
    assert.ok(tasks[0].commitment.sourceMessageIds.includes('cedar-mail'));
    assert.ok(tasks[0].commitment.sourceMessageIds.includes(second.payload.id));
    assert.equal(store.state.events.find(event => event.id === second.id).disposition, 'linked_commitment');
    const situations = openSituations(store);
    assert.equal(situations.length, 1);
    assert.equal(store.state.tasks[taskId].situationId, situations[0].id);
    const links = situationLinks(store, situations[0].id);
    assert.ok(links.includes(first.id));
    assert.ok(links.includes(second.id));
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").get(situations[0].id).n, 1);
    const field = fieldOf(engine, taskId);
    assert.equal(field.view.tasks.filter(task => task.request?.subjectEntity === 'Cedar').length, 1);
    assert.equal(store.state.outbox.length, 0);
    assert.equal(field.view.notifications.filter(item => !item.resolvedAt).length, 0);
  } finally { store.close(); }
});

test('scene 1 failure: unrelated Slack and a non-request do not join Cedar', () => {
  const { store, engine } = engineOn(SqliteStore);
  try {
    const { taskId } = discoverPair(engine);
    const situationId = store.state.tasks[taskId].situationId;
    const lunch = slack('1710000000.000200', 'Want to grab lunch tomorrow?', { from: 'Sam' });
    const lunchResult = engine.ingest(lunch);
    assert.equal(lunchResult.disposition, 'context_only');
    assert.equal(cedarTasks(store).length, 1);
    assert.equal(situationLinks(store, situationId).includes(lunch.id), false);

    const fyi = gmail('cedar-fyi', 'The Cedar brief file is saved for your records.', { threadId: 'gmail-fyi', subject: 'Cedar files' });
    const fyiResult = engine.ingest(fyi);
    assert.equal(fyiResult.disposition, 'context_only');
    assert.equal(cedarTasks(store).length, 1);

    const orion = gmail('orion-mail', `Please update the Orion brief with the vendor quote and send it by ${DEADLINE}.`, {
      threadId: 'gmail-orion', subject: 'Orion brief', from: 'Dana <dana@example.test>'
    });
    engine.ingest(orion);
    assert.equal(cedarTasks(store).length, 1);
    assert.equal(store.state.tasks['request:orion-mail'].request.subjectEntity, 'Orion');
    assert.notEqual(store.state.tasks['request:orion-mail'].situationId, situationId);

    const genericA = gmail('quotes-a', `Please update the Quotes proposal with the budget and send it by ${DEADLINE}.`, {
      threadId: 'gmail-quotes-a', subject: 'Quotes proposal', from: 'Riley <riley@example.test>'
    });
    const genericB = slack('1710000000.000300', `Please update the Quotes proposal with the budget and send it by ${DEADLINE}.`, { from: 'Riley' });
    engine.ingest(genericA);
    engine.ingest(genericB);
    assert.equal(store.state.tasks['request:quotes-a'].id, 'request:quotes-a');
    assert.notEqual(store.state.events.find(event => event.id === genericB.id).disposition, 'linked_commitment');
    assert.equal(cedarTasks(store).length, 1);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('scene 1 recovery: replaying either source does not recreate the commitment', async () => {
  const { filename, store, engine } = engineOn(SqliteStore);
  const { first, second, taskId } = discoverPair(engine);
  const situationId = store.state.tasks[taskId].situationId;
  assert.equal(engine.ingest(first).duplicate, true);
  assert.equal(engine.ingest(second).duplicate, true);
  assert.equal(Object.keys(store.state.tasks).length, 1);
  store.close();

  const restored = new SqliteStore(filename);
  const resumed = new WorkEngine(restored, { provider: new SimulatedMailProvider(restored), reasoner: new NullReasoner() });
  try {
    const cursors = new CursorStore(restored);
    const connector = new ScriptedConnector('google', [{
      events: [first, second], cursor: { page: 2 }, errors: [], partial: false
    }]);
    const outcome = await new ConnectorSync({ connectors: [connector], cursors, engine: resumed }).run();
    assert.equal(outcome.results[0].duplicates, 2);
    assert.equal(outcome.results[0].ingested, 0);
    assert.equal(Object.keys(restored.state.tasks).length, 1);
    assert.equal(restored.state.tasks[taskId].id, taskId);
    assert.equal(openSituations(restored).length, 1);
    assert.equal(restored.state.tasks[taskId].situationId, situationId);
    assert.equal(situationLinks(restored, situationId).length, 2);
    assert.equal(restored.state.outbox.length, 0);
    assert.equal(resumed.publicState().notifications.filter(item => !item.resolvedAt).length, 0);
  } finally { restored.close(); }
});

function waitingCedar() {
  const opened = engineOn(SqliteStore);
  opened.engine.ingest(documentEvent(INCOMPLETE, { id: 'cedar-incomplete' }));
  opened.engine.ingest(gmail('cedar-mail'));
  const taskId = 'request:cedar-mail';
  assert.equal(opened.store.state.tasks[taskId].status, 'waiting_for_information');
  opened.engine.waitForTask(taskId, { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
  return { ...opened, taskId };
}

test('scene 2 happy: a vendor reply clears the wait and preparation continues without sending', () => {
  assert.equal(stateGroup('needs_user'), 'attention');
  assert.equal(stateGroup('working'), 'working');
  assert.equal(stateGroup('waiting_external'), 'waiting');
  assert.equal(stateGroup('observing'), 'quiet');
  const { store, engine, taskId } = waitingCedar();
  try {
    const situationId = store.state.tasks[taskId].situationId;
    const before = fieldOf(engine, taskId);
    assert.equal(store.state.taskWaits[taskId].status, 'active');
    assert.equal(before.zone, 'waiting_external');
    assert.equal(before.needsUser, false);
    assert.equal(store.state.outbox.length, 0);
    assert.equal(before.view.notifications.filter(item => !item.resolvedAt).length, 0);
    engine.ingest({
      id: 'scheduler:cedar-nudge', type: 'timer.due', source: 'internal', connectorId: 'scheduler', at: LATER,
      payload: { id: 'cedar-nudge', situationId, scheduledAt: LATER }
    });
    assert.equal(store.state.outbox.length, 0, 'a scheduled check must not send a nudge');
    assert.equal(store.state.taskWaits[taskId].status, 'active');

    const reply = gmail('vendor-reply', `Cedar: ${QUOTE} for the engagement.`, {
      from: 'Vendor <vendor@example.test>', threadId: 'vendor-cedar-thread', subject: 'Cedar vendor reply', receivedAt: LATER
    });
    const resumed = engine.ingest(reply);
    assert.equal(resumed.disposition, 'wait_resumed');
    assert.equal(store.state.tasks[taskId].situationId, situationId);
    assert.equal(store.state.taskWaits[taskId].status, 'resolved');
    assert.equal(store.state.tasks[taskId].resumedEvidence[0].quote, QUOTE);
    assert.ok(store.state.tasks[taskId].evidence.observations.some(item => item.quote === QUOTE));
    assert.notEqual(store.state.tasks[taskId].status, 'completed');
    assert.equal(store.state.outbox.length, 0);

    engine.ingest(documentEvent(COMPLETE, { id: 'cedar-complete', at: LATER }));
    assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
    assert.equal(store.state.tasks[taskId].situationId, situationId);
    assert.equal(fieldOf(engine, taskId).needsUser, true);
    assert.equal(store.state.outbox.length, 0);
    const approvalNotices = store.state.notifications.filter(item => item.taskId === taskId && !item.resolvedAt);
    assert.ok(approvalNotices.length <= 1);
  } finally { store.close(); }
});

test('scene 2 failure: unrelated mail, another vendor, and an unknown send do not count as the quote', () => {
  const { store, engine, taskId } = waitingCedar();
  try {
    engine.ingest(slack('1710000000.000400', 'Want to grab lunch tomorrow?', { from: 'Sam' }));
    assert.equal(store.state.taskWaits[taskId].status, 'active');
    engine.ingest(gmail('other-vendor', 'Orion: Beta quoted 900 USD for a different engagement.', {
      from: 'Other <other@example.test>', threadId: 'vendor-orion-thread', subject: 'Orion vendor reply', receivedAt: LATER
    }));
    assert.equal(store.state.taskWaits[taskId].status, 'active');
    assert.equal(store.state.tasks[taskId].resumedEvidence, undefined);
    assert.notEqual(store.state.tasks[taskId].status, 'completed');
    store.mutate(state => {
      state.tasks[taskId].action = { id: 'send:unknown', status: 'uncertain', idempotencyKey: 'send:unknown' };
      state.taskWaits[taskId].interruptOnRisk = false;
    });
    const reply = engine.ingest(gmail('vendor-unknown', `Cedar: ${QUOTE} for the engagement.`, {
      from: 'Vendor <vendor@example.test>', threadId: 'vendor-cedar-thread', subject: 'Cedar vendor reply', receivedAt: LATER
    }));
    assert.notEqual(reply.disposition, 'wait_resumed');
    assert.equal(store.state.taskWaits[taskId].status, 'active');
    assert.equal(store.state.tasks[taskId].resumedEvidence, undefined);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('scene 2 recovery: restart keeps the wait, then the same reply resumes it', () => {
  const json = engineOn(JsonStore);
  json.engine.ingest(documentEvent(INCOMPLETE, { id: 'cedar-incomplete' }));
  json.engine.ingest(gmail('cedar-mail'));
  json.engine.waitForTask('request:cedar-mail', { kind: 'reply', dependsOn: { quote: QUOTE, subjectEntity: 'Cedar' } });
  const before = fs.readFileSync(json.filename, 'utf8');
  const revision = json.store.state.revision;
  const evaluated = json.store.state.taskWaits['request:cedar-mail'].lastEvaluatedAt;
  json.store.close();
  const reopened = new JsonStore(json.filename);
  const restarted = new WorkEngine(reopened, { reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
  try {
    assert.equal(reopened.state.revision, revision);
    assert.equal(fs.readFileSync(json.filename, 'utf8'), before);
    assert.equal(reopened.state.taskWaits['request:cedar-mail'].status, 'active');
    assert.equal(reopened.state.taskWaits['request:cedar-mail'].lastEvaluatedAt, evaluated);
  } finally { reopened.close(); }

  const durable = waitingCedar();
  const situationId = durable.store.state.tasks[durable.taskId].situationId;
  const waitEvaluated = durable.store.state.taskWaits[durable.taskId].lastEvaluatedAt;
  const taskUpdated = durable.store.state.tasks[durable.taskId].updatedAt;
  durable.store.close();
  const restored = new SqliteStore(durable.filename);
  const resumed = new WorkEngine(restored, { provider: new SimulatedMailProvider(restored), reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
  try {
    assert.equal(restored.state.tasks[durable.taskId].situationId, situationId);
    assert.equal(restored.state.tasks[durable.taskId].updatedAt, taskUpdated);
    assert.equal(restored.state.taskWaits[durable.taskId].status, 'active');
    assert.equal(restored.state.taskWaits[durable.taskId].lastEvaluatedAt, waitEvaluated);
    resumed.ingest(gmail('vendor-reply', `Cedar: ${QUOTE} for the engagement.`, {
      from: 'Vendor <vendor@example.test>', threadId: 'vendor-cedar-thread', subject: 'Cedar vendor reply', receivedAt: LATER
    }));
    assert.equal(restored.state.tasks[durable.taskId].situationId, situationId);
    assert.equal(restored.state.taskWaits[durable.taskId].status, 'resolved');
    assert.equal(restored.state.tasks[durable.taskId].resumedEvidence[0].quote, QUOTE);
    assert.equal(restored.state.outbox.length, 0);
  } finally { restored.close(); }
});

function patchAuthorization(patch) {
  return { kind: 'explicit', taskId: patch.taskId, patchId: patch.id, baseDocumentVersion: patch.baseDocument.version, confirmed: true };
}

test('scene 3 happy: a prepared write is refused after the user edits the document', async () => {
  const { store, engine } = engineOn(JsonStore);
  try {
    engine.ingest(documentEvent('# Cedar brief\n'));
    engine.ingest(gmail('cedar-mail'));
    const taskId = 'request:cedar-mail';
    const patch = await engine.prepareDocumentPatch(taskId, {
      provider: 'local',
      changes: [{ type: 'append', text: 'vendor quote', source: { kind: 'email', id: 'cedar-mail', quote: 'vendor quote' } }]
    });
    assert.equal(patch.status, 'prepared');
    engine.ingest(documentEvent(`# Cedar brief\n\n${USER_TEXT}\n`, { id: 'user-edit', at: LATER }));
    await assert.rejects(() => engine.applyDocumentPatch(taskId, { patchId: patch.id, authorization: patchAuthorization(patch) }), /changed/);
    assert.equal(store.state.documents['cedar-brief'].content.includes(USER_TEXT), true);
    assert.equal(store.state.documents['cedar-brief'].content.includes('vendor quote\n'), false);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('scene 3 failure: a mismatch or uncertain write is not treated as verified', async () => {
  let posts = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === 'POST') posts += 1;
    const document = {
      documentId: 'cedar-doc', title: 'Cedar brief', revisionId: 'revision-2',
      body: { content: [{ startIndex: 1, endIndex: 14, paragraph: { elements: [{ textRun: { content: 'User text\n' } }] } }] }
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(document) };
  };
  const provider = new GoogleDocsWriteProvider({
    connector: { auth: { configured: () => true, headers: async () => ({ authorization: 'Bearer test' }) } },
    enabled: true, shadow: false, fetchImpl
  });
  await assert.rejects(() => provider.apply({
    document: { id: 'cedar-doc', externalId: 'cedar-doc', source: 'google', available: true },
    requiredRevisionId: 'revision-1',
    changes: [{ type: 'append', text: 'replacement quote' }]
  }), error => error.stale === true);
  assert.equal(posts, 0);

  const { store, engine } = engineOn(JsonStore);
  try {
    engine.ingest(documentEvent(INCOMPLETE, { id: 'cedar-incomplete' }));
    engine.ingest(gmail('cedar-mail'));
    const taskId = 'request:cedar-mail';
    engine.waitForTask(taskId, { kind: 'document', dependsOn: { documentId: 'cedar-brief' } });
    const formatted = INCOMPLETE.replace('Overview', 'Overview');
    engine.ingest(documentEvent(`${formatted}\n`, { id: 'format-only', at: LATER }));
    assert.equal(store.state.taskWaits[taskId].status, 'active');
    const patch = await engine.prepareDocumentPatch(taskId, {
      provider: 'local',
      changes: [{ type: 'append', text: 'vendor quote', source: { kind: 'email', id: 'cedar-mail', quote: 'vendor quote' } }]
    });
    store.mutate(state => { state.documentPatches[patch.id].status = 'uncertain'; });
    await assert.rejects(() => engine.applyDocumentPatch(taskId, { patchId: patch.id, authorization: patchAuthorization(patch) }), /uncertain/);
    assert.equal(store.state.documents['cedar-brief'].content.includes(USER_TEXT), false);
    engine.ingest(documentEvent(`# Cedar brief\n\n${USER_TEXT}\n`, { id: 'semantic-edit', at: '2026-11-03T15:00:00.000Z' }));
    await assert.rejects(() => engine.applyDocumentPatch(taskId, { patchId: patch.id, authorization: patchAuthorization(patch) }), /uncertain/);
    assert.equal(store.state.documents['cedar-brief'].content.includes(USER_TEXT), true);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('scene 3 recovery: an interrupted apply stays uncertain after restart', async () => {
  const companion = fs.readFileSync(new URL('./task-services.test.js', import.meta.url), 'utf8');
  assert.match(companion, /an interrupted applying patch recovers as uncertain and cannot be replayed after restart/);
  const { filename, store, engine } = engineOn(JsonStore);
  engine.ingest(documentEvent('# Cedar brief\n'));
  engine.ingest(gmail('cedar-mail'));
  const patch = await engine.prepareDocumentPatch('request:cedar-mail', {
    provider: 'local',
    changes: [{ type: 'append', text: 'vendor quote', source: { kind: 'email', id: 'cedar-mail', quote: 'vendor quote' } }]
  });
  store.mutate(state => {
    state.documentPatches[patch.id].status = 'applying';
    state.documentPatches[patch.id].writeAttemptId = 'process-that-stopped';
  });
  const content = store.state.documents['cedar-brief'].content;
  store.close();
  const restored = new JsonStore(filename);
  const restarted = new WorkEngine(restored, { reasoner: new NullReasoner() });
  try {
    assert.equal(restored.state.documentPatches[patch.id].status, 'uncertain');
    assert.equal(restored.state.documentPatches[patch.id].result.applied, null);
    await assert.rejects(() => restarted.applyDocumentPatch('request:cedar-mail', {
      patchId: patch.id, authorization: patchAuthorization(patch)
    }), /uncertain/);
    assert.equal(restored.state.documents['cedar-brief'].content, content);
    assert.equal(restored.state.outbox.length, 0);
  } finally { restored.close(); }
});

function readyCedar(Store = JsonStore) {
  const opened = engineOn(Store);
  opened.engine.ingest(documentEvent(COMPLETE, { id: 'cedar-complete' }));
  opened.engine.ingest(gmail('cedar-mail'));
  const taskId = 'request:cedar-mail';
  assert.equal(opened.store.state.tasks[taskId].status, 'ready_for_approval');
  assert.equal(opened.store.state.outbox.length, 0);
  return { ...opened, taskId };
}

test('scene 4 happy: approval verifies one Cedar send', () => {
  const { store, engine, taskId } = readyCedar();
  try {
    assert.equal(fieldOf(engine, taskId).needsUser, true);
    const reviewed = fieldOf(engine, taskId).task.reviewToken;
    const result = engine.approve(taskId, { reviewToken: reviewed });
    assert.equal(result.status, 'completed');
    assert.equal(result.action.status, 'verified_simulated');
    assert.equal(store.state.outbox.length, 1);
    assert.equal(store.state.outbox[0].idempotencyKey, result.action.idempotencyKey);
  } finally { store.close(); }
});

test('scene 4 failure: a changed review token is rejected and nothing is sent', () => {
  const { store, engine, taskId } = readyCedar();
  try {
    const reviewed = fieldOf(engine, taskId).task.reviewToken;
    store.mutate(state => { state.tasks[taskId].draft.body += '\nA different reply.'; });
    assert.throws(() => engine.approve(taskId, { reviewToken: reviewed }), { code: 'REVIEW_CHANGED' });
    assert.equal(store.state.outbox.length, 0);
    assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  } finally { store.close(); }
});

test('scene 4 recovery: restart after acceptance does not send the Cedar reply again', () => {
  const { filename, store, provider, taskId } = readyCedar();
  store.mutate(state => {
    state.tasks[taskId].status = 'verifying';
    state.tasks[taskId].action = {
      id: `send:${taskId}:1`, idempotencyKey: `send:${taskId}:1`,
      permission: 'user_approved', status: 'executing'
    };
  });
  provider.send({
    idempotencyKey: `send:${taskId}:1`, to: 'alex@example.test', subject: 'Re: Cedar brief',
    body: 'Prepared', documentUrl: store.state.tasks[taskId].draft.documentUrl
  });
  store.close();
  const restored = new JsonStore(filename);
  const restarted = new WorkEngine(restored, { reasoner: new NullReasoner() });
  try {
    assert.equal(restored.state.tasks[taskId].status, 'completed');
    assert.equal(restored.state.outbox.length, 1);
    assert.throws(() => restarted.approve(taskId), /not ready/);
    assert.equal(restored.state.outbox.length, 1);
  } finally { restored.close(); }
});

test('scene 5 happy: a correction persists and the next event does not repeat it', () => {
  const { store, engine, taskId } = readyCedar();
  try {
    const feedback = engine.recordTaskFeedback(taskId, {
      label: 'wrong_association',
      scope: { sender: 'alex@example.test', threadId: 'gmail-cedar-thread', subjectEntity: 'Cedar', deliverable: 'brief', documentId: 'cedar-brief' }
    });
    assert.equal(store.state.taskFeedbackRules[feedback.id].active, true);
    assert.equal(store.state.tasks[taskId].documentId, null);
    assert.ok(store.state.tasks[taskId].evidence.observations.some(item => item.id === 'feedback_excluded_document:cedar-brief'));
    const edited = engine.ingest(documentEvent(`${COMPLETE}\nExtra line.\n`, { id: 'after-correction', at: LATER }));
    assert.equal(edited.disposition, 'unrelated_change');
    assert.equal(store.state.tasks[taskId].documentId, null);

    const ownership = engine.recordTaskFeedback(taskId, {
      label: 'not_mine', scope: { sender: 'alex@example.test', subjectEntity: 'Cedar' }
    });
    assert.equal(store.state.taskFeedbackRules[ownership.id].active, true);
    const again = engine.ingest(gmail('cedar-again', REQUEST, { threadId: 'gmail-cedar-other', receivedAt: LATER }));
    assert.equal(again.disposition, 'suppressed_by_feedback');
    assert.equal(store.state.tasks['request:cedar-again'], undefined);
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); }
});

test('scene 5 failure: undo after provider acceptance does not unsend or send again', () => {
  const { store, engine, taskId } = readyCedar();
  try {
    engine.approve(taskId);
    assert.equal(store.state.outbox.length, 1);
    engine.ingest(gmail('cancel-cedar', 'Please cancel the Cedar brief request.', { receivedAt: LATER }));
    const task = store.state.tasks[taskId];
    assert.match(task.reason, /not undone/i);
    assert.equal(task.action?.status || task.actionHistory.at(-1).status, 'verified_simulated');
    assert.equal(store.state.outbox.length, 1);
    assert.throws(() => engine.approve(taskId), /not ready/);
    assert.equal(store.state.outbox.length, 1);
  } finally { store.close(); }
});

test('scene 5 recovery: restart keeps the correction', () => {
  const { filename, store, engine, taskId } = readyCedar();
  const feedback = engine.recordTaskFeedback(taskId, {
    label: 'not_mine', scope: { sender: 'alex@example.test', subjectEntity: 'Cedar' }
  });
  store.close();
  const restored = new JsonStore(filename);
  const restarted = new WorkEngine(restored, { reasoner: new NullReasoner() });
  try {
    assert.equal(restored.state.taskFeedbackRules[feedback.id].active, true);
    const again = restarted.ingest(gmail('cedar-after-restart', REQUEST, { threadId: 'gmail-cedar-restart', receivedAt: LATER }));
    assert.equal(again.disposition, 'suppressed_by_feedback');
    assert.equal(restored.state.tasks['request:cedar-after-restart'], undefined);
    assert.equal(Object.keys(restored.state.tasks).length, 1);
    assert.equal(restored.state.outbox.length, 0);
  } finally { restored.close(); }
});

test('scene 6 happy and recovery: the durable crash proof stays in the companion file', () => {
  const proof = fs.readFileSync(new URL('./full-chain-recovery.test.js', import.meta.url), 'utf8');
  assert.match(proof, /connector to supervised feedback survives crashes after remote acceptance and after local feedback/);
  assert.match(proof, /recovery must not dispatch a second external action/);
  assert.match(proof, /full-chain-worker/);
  const { filename, store, provider, taskId } = readyCedar();
  store.mutate(state => {
    state.tasks[taskId].status = 'verifying';
    state.tasks[taskId].action = {
      id: `send:${taskId}:1`, idempotencyKey: `send:${taskId}:1`,
      permission: 'user_approved', status: 'executing'
    };
  });
  provider.send({
    idempotencyKey: `send:${taskId}:1`, to: 'alex@example.test', subject: 'Re: Cedar brief',
    body: 'Prepared', documentUrl: store.state.tasks[taskId].draft.documentUrl
  });
  store.close();
  const restored = new JsonStore(filename);
  new WorkEngine(restored, { reasoner: new NullReasoner() });
  try {
    assert.equal(restored.state.tasks[taskId].status, 'completed');
    assert.equal(restored.state.outbox.length, 1);
    assert.equal(restored.state.outbox.filter(item => item.idempotencyKey === `send:${taskId}:1`).length, 1);
  } finally { restored.close(); }
});

test('scene 6 failure: an unknown lookup during recovery does not enable a second send', () => {
  const { filename, store, engine, provider, taskId } = readyCedar();
  provider.lookup = () => ({ status: 'unknown' });
  const result = engine.approve(taskId);
  assert.equal(result.status, 'blocked');
  assert.equal(result.action.status, 'uncertain');
  assert.equal(store.state.outbox.length, 0);
  store.close();
  const restored = new JsonStore(filename);
  class UnknownLookup extends SimulatedMailProvider {
    lookup() { return { status: 'unknown' }; }
  }
  const restarted = new WorkEngine(restored, { provider: new UnknownLookup(restored), reasoner: new NullReasoner() });
  try {
    assert.equal(restored.state.tasks[taskId].action.status, 'uncertain');
    assert.throws(() => restarted.retry(taskId), /confirmed absence|uncertain|not ready/);
    assert.equal(restored.state.outbox.length, 0);
  } finally { restored.close(); }
});
