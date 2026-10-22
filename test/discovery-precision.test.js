import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { interpretRequest, explainRequest, isAutomatedSender, hasRequestForm, deliverableIsGoverned } from '../src/requests.js';

/**
 * Synthetic discovery-precision regressions: announcements, automated notices,
 * and digests must not manufacture tasks. All people, addresses, subjects and
 * message bodies below are fictional; no mailbox content is included.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-precision-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const message = (id, from, subject, body) => ({ id, from, to: 'maya@example.test', subject, body, receivedAt: '2026-10-16T08:00:00.000Z' });
const event = (payload, id = payload.id) => ({ id: `e-${id}`, type: 'email.received', source: 'google', payload });

/** Fictional examples covering eight non-request shapes. */
const NOT_REQUESTS = [
  ['product announcement', 'Aster Desk <support@asterdesk.example.test>', 'Aster Desk Update',
    'Hello there, a new release is available. Tables now include formula fields and calculation helpers.'],
  ['follower digest', 'Reading Club <noreply@reading.example.test>', 'Your reading digest is ready.',
    'A fictional subscriber joined your reading list. This is an automatic weekly summary.'],
  ['account notice', 'Example Accounts <noreply-accounts@accounts.example.test>', 'A test account connection was added',
    'Review the fictional test account connections in its settings. This is an automatic account notice.'],
  ['model announcement', 'Example Models <news@models.example.test>', 'New: Example Vision Model',
    'A fictional model announcement describes image input support and a new example benchmark.'],
  ['newsletter', 'Work Journal <newsletter@journal.example.test>', 'This week in the Work Journal',
    'This automated roundup includes recent articles. View the fictional digest in your browser.'],
  ['education feed', 'Education Bulletin <githubeducation@learning.example.test>', 'Watch the fictional learning sessions',
    'Recorded study sessions are available for members of this fictional learning group.'],
  ['design digest', 'Design Weekly <no-reply@design.example.test>', 'A weekly design roundup',
    'This week: page layouts, accessible navigation, and a fictional component library.'],
  ['published statement', 'alex@example.test', 'Weekly note',
    'The report was published yesterday and the plan is finished.']
];

const IS_REQUEST = [
  ['imperative with a named document', 'Casey Test <casey@example.test>', 'Zephyr flyer update',
    'Please update the Zephyr Course Flyer report by Friday. The document is https://docs.google.com/document/d/abc123'],
  ['passive phrasing', 'alex@example.test', 'Northstar',
    'I need the Northstar proposal updated by Friday.'],
  ['question form', 'alex@example.test', 'Q3',
    'Could you send the Q3 report today?'],
  ['unseen deliverable noun', 'priya@example.test', 'Helios',
    'Please update the Helios playbook with the latest incident statistics and share it by Friday.']
];

test('an automated sender is recognised before any wording is interpreted', () => {
  for (const from of [
    'Reading Club <noreply@reading.example.test>',
    'Example Accounts <noreply-accounts@accounts.example.test>',
    'Example Models <news@models.example.test>',
    'Work Journal <newsletter@journal.example.test>',
    'Design Weekly <no-reply@design.example.test>',
    'Education Bulletin <githubeducation@learning.example.test>',
    'Alerts <alerts@example.test>',
    'Team <do-not-reply@example.test>'
  ]) {
    assert.equal(isAutomatedSender(from), true, `${from} should be treated as automated`);
  }
  for (const from of ['Casey Test <casey@example.test>', 'alex@example.test', 'Priya Raman <priya@example.test>']) {
    assert.equal(isAutomatedSender(from), false, `${from} should be treated as a person`);
  }
});

test('a request has an imperative or a direct ask', () => {
  assert.equal(hasRequestForm('Please update the report.'), true);
  assert.equal(hasRequestForm('Could you send it?'), true);
  assert.equal(hasRequestForm('I need the sample size.'), true);
  assert.equal(hasRequestForm('Make sure it covers the conclusion.'), true);
  assert.equal(hasRequestForm('v0.14.7 is out with new functions.'), false);
  assert.equal(hasRequestForm('You shared some account data.'), false);
});

test('the deliverable must be the object of the request', () => {
  const text = 'Please update the Northstar project proposal by Friday.';
  const index = text.indexOf('proposal');
  assert.equal(deliverableIsGoverned(text, { index, length: 8 }), true);

  const declarative = 'Hey there, v0.14.7 is out with functions.';
  const thereIndex = declarative.indexOf('there');
  assert.equal(deliverableIsGoverned(declarative, { index: thereIndex, length: 5 }), false);
});

for (const [label, from, subject, body] of NOT_REQUESTS) {
  test(`not discovered: ${label}`, () => {
    const env = setup();
    const result = env.engine.ingest(event(message(`n-${label}`, from, subject, body)));
    assert.equal(result.disposition, 'context_only', `${label} must not become a task`);
    assert.equal(Object.keys(env.store.state.tasks).length, 0);
    assert.equal(env.store.state.outbox.length, 0);
  });
}

for (const [label, from, subject, body] of IS_REQUEST) {
  test(`still discovered: ${label}`, () => {
    const env = setup();
    const result = env.engine.ingest(event(message(`y-${label}`, from, subject, body)));
    assert.equal(result.disposition, 'discovered_request', `${label} is a real request`);
    const tasks = Object.values(env.store.state.tasks);
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].request.subjectEntity, 'the entity is still identified');
    assert.ok(tasks[0].request.deliverable, 'the deliverable is still identified');
    assert.equal(env.store.state.outbox.length, 0, 'discovery never sends');
  });
}

test('the same real-inbox shape yields exactly one discovery', () => {
  const env = setup();
  for (const [label, from, subject, body] of NOT_REQUESTS) {
    env.engine.ingest(event(message(`m-${label}`, from, subject, body)));
  }
  const genuine = IS_REQUEST[0];
  env.engine.ingest(event(message('m-genuine', genuine[1], genuine[2], genuine[3])));

  const tasks = Object.values(env.store.state.tasks);
  assert.equal(tasks.length, 1, 'eight feeds and one request produce one task');
  assert.equal(tasks[0].request.subjectEntity, 'Zephyr Course Flyer');
  assert.equal(tasks[0].request.deliverable, 'report');
  const dispositions = env.store.state.events.map(item => item.disposition);
  assert.equal(dispositions.filter(item => item === 'discovered_request').length, 1);
  assert.equal(dispositions.filter(item => item === 'context_only').length, NOT_REQUESTS.length);
});

test('a gate rejection is recorded as an observation, not as silence', () => {
  const env = setup();
  // A message that *does* name a deliverable, from an automated address: the
  // sender is then the check that declines it.
  env.engine.ingest(event(message('obs', 'Reading Club <noreply@reading.example.test>', 'Your reading digest is ready.', 'Please update the readers report.')));
  const observation = env.store.state.history.find(item => item.kind === 'observation');
  assert.ok(observation, 'the message is still observed and traceable');
  assert.match(observation.text, /did not treat it as a request/i);
  assert.match(observation.text, /automated address/i, 'the observation names the check that declined it');
});

test('each gate reports why it declined, with a stable code', () => {
  const cases = [
    ['no_deliverable', { subject: 'Hello', body: 'Please take a look when you can.' }],
    ['no_request_verb', { subject: 'Status', body: 'The report looks good this quarter.' }],
    ['automated_sender', { subject: 'Digest', body: 'Please update the readers report.' }],
    ['no_request_form', { subject: 'Status', body: 'The report was updated yesterday by the team.' }],
    ['deliverable_not_requested', { subject: 'Notes', body: 'Please send it over. Quarterly report highlights attached.' }]
  ];
  for (const [code, fields] of cases) {
    const from = code === 'automated_sender' ? 'Reading Club <noreply@reading.example.test>' : 'alex@example.test';
    const { request, rejection } = explainRequest({ id: `r-${code}`, from, receivedAt: '2026-10-16T08:00:00.000Z', ...fields });
    assert.equal(request, null, `${code}: no request should be produced`);
    assert.equal(rejection.code, code, `expected ${code}, got ${rejection.code}`);
    assert.ok(rejection.detail.length > 20, `${code}: the detail must be a sentence a person can act on`);
  }
});

test('a discovered request has no rejection attached', () => {
  const { request, rejection } = explainRequest({
    id: 'ok', from: 'alex@example.test', subject: 'Northstar',
    body: 'Please update the Northstar proposal by Friday.', receivedAt: '2026-10-16T08:00:00.000Z'
  });
  assert.ok(request);
  assert.equal(rejection, null);
});

test('the rejection reaches the state endpoint, so the interface can explain silence', () => {
  const env = setup();
  env.engine.ingest(event(message('vis', 'Example Models <news@models.example.test>', 'New: Example Model', 'Please update the spec for the new model.')));
  const shown = env.engine.publicState().events.find(item => item.id === 'e-vis');
  assert.ok(shown, 'the event is exposed');
  assert.equal(shown.disposition, 'context_only');
  assert.equal(shown.rejection.code, 'automated_sender');
  assert.match(shown.rejection.detail, /automated address/);
});
