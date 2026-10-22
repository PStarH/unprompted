import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { prepareText, runStrategies } from '../src/probes/strategies.js';
import { validateContract } from '../src/contracts.js';

/**
 * Contradictory evidence.
 *
 * A document that states two different values for the same claim must not have
 * one of them picked silently. The criterion becomes `conflicting`, completion is
 * refused, and the contradiction reaches the user as a `risk` notification.
 *
 * This exercises a path that previously had no producer at all: the `conflicting`
 * criterion state and the `risk` notification were both declared, validated and
 * tested in isolation, but nothing in the pipeline ever emitted them.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-contradiction-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = (id, subject, body) => ({
  id: `event-email-${id}`, type: 'email.received',
  payload: { id, from: 'alex@example.test', subject, body }
});

// Each revision is a distinct event: re-ingesting the same event id is a
// duplicate, and a duplicate correctly changes nothing.
let revision = 0;
const document = (id, title, content) => ({
  id: `event-doc-${id}-${++revision}`, type: 'document.modified',
  payload: { id, kind: 'playbook', title, content, modifiedAt: `2026-10-16T09:0${Math.min(revision, 9)}:00.000Z` }
});

const request = () => email('m1', 'Helios incident playbook',
  'Please update the Helios incident playbook with the latest incident statistics and share it by Friday.');

const playbook = incidentLines => document('helios-playbook', 'Helios incident playbook',
  `# Helios incident playbook\n\n## Incident statistics\nAs of: 2026-10-12\n${incidentLines}\n\n## Escalation\nPage the on-call lead within five minutes of a severity-one alert.\n`);

const consistent = () => playbook('Incident count: 9\nMean time to recovery: 31 minutes');
const contradictory = () => playbook('Incident count: 9\nMean time to recovery: 31 minutes\nIncident count: 14');

// ---------------------------------------------------------------- strategies

test('the same label reported with two values is returned as a conflict, not a choice', () => {
  const prepared = prepareText(contradictory().payload.content);
  const hit = runStrategies(prepared, ['incident', 'incident count'], ['labelled_value']);
  assert.ok(hit.conflict, 'a contradiction must be reported');
  assert.equal(hit.conflict.label, 'incident count');
  assert.deepEqual(hit.conflict.values.sort(), ['14', '9']);
  assert.equal(hit.conflict.entries.length, 2);
  for (const entry of hit.conflict.entries) {
    assert.ok(Number.isInteger(entry.line), 'each value keeps the line it came from');
    assert.ok(entry.text.includes('Incident count'));
  }
  assert.match(hit.detail, /different values/);
});

test('different labels about the same concept are not a contradiction', () => {
  const prepared = prepareText('# Report\n\n## Stats\nControl: 12.0% activation\nControl group size: 300\n');
  const hit = runStrategies(prepared, ['control'], ['labelled_value']);
  assert.equal(hit.conflict ?? null, null, 'two different facts are not a conflict');
  assert.equal(hit.matched, true);
});

test('a label repeated with the same value is not a contradiction', () => {
  const prepared = prepareText('# Report\n\n## Stats\nIncident count: 9\nIncident count: 9\n');
  const hit = runStrategies(prepared, ['incident count'], ['labelled_value']);
  assert.equal(hit.conflict ?? null, null);
});

test('the same concept stated twice in prose with different figures is a conflict', () => {
  const prepared = prepareText(
    '# Helios incident playbook\n\n## Incident statistics\nThe incident count is 9.\nMean time to recovery was 31 minutes.\nLater notes say the incident count is 14.\n'
  );
  const hit = runStrategies(prepared, ['incident count', 'incident', 'incidents'], ['labelled_value']);
  assert.ok(hit.conflict, 'prose contradictions must be reported');
  assert.equal(hit.conflict.label, 'incident count');
  assert.deepEqual(hit.conflict.values.sort(), ['14', '9']);
});

test('prose about related but different phrases is not a contradiction', () => {
  const prepared = prepareText(
    '# Report\n\n## Stats\nThe control conversion is 12%.\nThe control group size is 300.\n'
  );
  const hit = runStrategies(prepared, ['control group', 'control', 'baseline'], ['labelled_value']);
  assert.equal(hit.conflict ?? null, null, 'different phrases stay different facts');
  assert.equal(hit.matched, true);
});

test('a bare mention of a concept and a number is not enough to claim a prose figure', () => {
  const prepared = prepareText('# Notes\n\nWe discussed the incident count during the 9am review.\n');
  const hit = runStrategies(prepared, ['incident count', 'incident'], ['labelled_value']);
  assert.equal(hit?.conflict ?? null, null);
});

test('a dated update is a change over time, not a contradiction', () => {
  const prepared = prepareText(
    '# Report\n\n## Incident statistics\nAs of: 2026-10-01\nIncident count: 5\n\n## Update\nAs of: 2026-10-15\nIncident count: 7\n'
  );
  const hit = runStrategies(prepared, ['incident count', 'incident'], ['labelled_value']);
  assert.equal(hit.conflict ?? null, null, 'later dates explain a changed value');
  assert.match(hit.excerpt, /7/);
  assert.match(hit.detail, /most recent/i);
  assert.equal(hit.date, '2026-10-15', 'the newest date is carried so freshness can use it');
  assert.match(hit.superseded[0].value, /5/);
  assert.match(hit.superseded[0].at, /2026-10-01/);
});

test('a value with no time anchor keeps the contradiction', () => {
  const prepared = prepareText(
    '# Report\n\n## Incident statistics\nAs of: 2026-10-01\nIncident count: 5\n\n## Update\nIncident count: 7\n'
  );
  const hit = runStrategies(prepared, ['incident count', 'incident'], ['labelled_value']);
  assert.ok(hit.conflict, 'an undated second value leaves the newest reading unknown');
  assert.deepEqual(hit.conflict.values.sort(), ['5', '7']);
});

test('relative periods order repeated values even without dates', () => {
  const prepared = prepareText(
    '# Report\n\n## Incident statistics\nIncident count: 5 (last month)\nIncident count: 7 (this month)\n'
  );
  const hit = runStrategies(prepared, ['incident count', 'incident'], ['labelled_value']);
  assert.equal(hit.conflict ?? null, null);
  assert.match(hit.excerpt, /7/);
});

test('ordering words alone are not time evidence', () => {
  // "Later notes say" sounds temporal but does not date either value; the
  // pinned behaviour above (conflict) must survive the dated-update rule.
  const prepared = prepareText(
    '# Playbook\n\n## Incident statistics\nThe incident count is 9.\nLater notes say the incident count is 14.\n'
  );
  const hit = runStrategies(prepared, ['incident count', 'incident'], ['labelled_value']);
  assert.ok(hit.conflict, 'prose ordering words must not resolve a contradiction');
});

// ----------------------------------------------------------------- assessor

test('a contradictory document yields a conflicting criterion, not a satisfied one', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(contradictory());
  const task = store.state.tasks['request:m1'];
  const criterion = task.evidence.criteria.find(item => item.status === 'conflicting');
  assert.ok(criterion, `expected a conflicting criterion, got ${task.evidence.criteria.map(item => `${item.id}:${item.status}`).join(', ')}`);
  assert.equal(criterion.required, true);
  assert.equal(criterion.evidence.length, 2, 'both values are carried as evidence');
  for (const item of criterion.evidence) assert.ok(item.source?.id, 'each conflicting value is traceable to a source');
  assert.match(criterion.note, /different values/);
});

test('the contract accepts the conflicting criterion and its evidence', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(contradictory());
  const task = store.state.tasks['request:m1'];
  for (const criterion of task.evidence.criteria) {
    const result = validateContract('criterion', criterion);
    assert.ok(result.ok, `${criterion.id}: ${result.problems.join('; ')}`);
  }
  for (const conflict of task.evidence.conflicts) {
    assert.equal(typeof conflict.detail, 'string');
    assert.ok(conflict.detail.length > 0);
  }
});

// ------------------------------------------------------- end-to-end behaviour

test('contradictory prose stops a completion that would otherwise be prepared', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(playbook(
    'The incident count is 9.\nMean time to recovery was 31 minutes.\nA later note says the incident count is 14.'
  ));
  const task = store.state.tasks['request:m1'];
  assert.equal(task.status, 'waiting_for_information');
  assert.equal(task.draft, null);
  assert.equal(task.assessment?.complete, false);
  assert.ok(task.evidence.criteria.some(item => item.status === 'conflicting'));
  assert.ok(
    engine.publicState().notifications.some(item => item.kind === 'risk' && !item.resolvedAt),
    'the contradiction reaches the user as a risk decision'
  );
  assert.equal(store.state.outbox.length, 0);
});

test('contradictory evidence stops a completion that would otherwise be prepared', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(consistent());
  const taskId = 'request:m1';
  assert.equal(store.state.tasks[taskId].assessment.complete, true, 'the consistent version is preparable');

  // The document is edited so it now states two different incident counts.
  engine.ingest(document('helios-playbook', 'Helios incident playbook', contradictory().payload.content));
  assert.equal(store.state.tasks[taskId].assessment.complete, false, 'a contradiction must not be treated as satisfied');
  assert.notEqual(store.state.tasks[taskId].status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 0, 'nothing is sent');
});

test('a contradiction is raised to the user as a risk with both values attached', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(contradictory());

  const conflict = store.state.tasks['request:m1'].evidence.conflicts.find(item => String(item.id).startsWith('conflicting:'));
  assert.ok(conflict, `expected a conflicting: entry, got ${store.state.tasks['request:m1'].evidence.conflicts.map(item => item.id).join(', ') || 'none'}`);

  const risk = engine.publicState().notifications.find(item => item.kind === 'risk');
  assert.ok(risk, 'the conflicting criterion must produce a risk notification');
  assert.match(risk.what, /different values/);
  assert.ok(risk.checked.length > 0, 'a notification must say what was already checked');
  assert.ok(risk.decision.length > 0, 'and what the user must decide');
  assert.ok(risk.evidence.length >= 1);
});

test('the same contradiction is not raised twice', () => {
  const { engine } = setup();
  engine.ingest(request());
  engine.ingest(contradictory());
  engine.ingest(contradictory());
  const risks = engine.publicState().notifications.filter(item => item.kind === 'risk');
  assert.equal(risks.length, 1, 'a persisting condition keeps one open notification');
});

test('resolving the contradiction withdraws the notification and re-enables the work', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(contradictory());
  const taskId = 'request:m1';
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'risk').length, 1);

  // The document is corrected to state one count.
  engine.ingest(document('helios-playbook', 'Helios incident playbook', consistent().payload.content));

  assert.equal(store.state.tasks[taskId].evidence.criteria.some(item => item.status === 'conflicting'), false);
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'risk').length, 0,
    'a condition that cleared must not leave a notification behind');
  assert.equal(store.state.tasks[taskId].assessment.complete, true);
});

test('the document title is not a section, so it cannot satisfy a criterion on its own', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(document('helios-playbook', 'Helios incident playbook',
    '# Helios incident playbook\n\n## Notes\nWe discussed incident statistics in the review.\n'));
  const task = store.state.tasks['request:m1'];
  const criterion = task.evidence.criteria.find(item => item.id === 'incident_stats');
  assert.ok(criterion, 'the criterion is still assessed');
  assert.notEqual(criterion.status, 'satisfied',
    'a passing mention in the body, under the deliverable\'s own title, is not the requested content');
  // Whatever it found is at most indicative: the mention is real, the statistics are not.
  for (const item of criterion.evidence) {
    assert.equal(item.strength, 'indicative', 'a mention must never be recorded as direct evidence');
  }
  assert.equal(task.assessment.complete, false);
  assert.equal(store.state.outbox.length, 0);
});

test('a real section with the content still satisfies the criterion', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(consistent());
  const task = store.state.tasks['request:m1'];
  const criterion = task.evidence.criteria.find(item => item.id === 'incident_stats');
  assert.equal(criterion.status, 'satisfied');
  assert.equal(criterion.strength, 'direct');
  assert.ok(criterion.evidence.length >= 1);
});

test('a later-dated document update supersedes an earlier value end to end', () => {
  const { engine, store } = setup();
  engine.ingest(request());
  engine.ingest(document('helios-playbook', 'Helios incident playbook',
    '# Helios incident playbook\n\n## Incident statistics\nAs of: 2026-10-01\nIncident count: 5\nMean time to recovery: 29 minutes\n\n## Update\nAs of: 2026-10-15\nIncident count: 7\n\n## Escalation\nPage the on-call lead within five minutes of a severity-one alert.\n'));
  const task = store.state.tasks['request:m1'];
  const criterion = task.evidence.criteria.find(item => item.id === 'incident_stats');
  assert.equal(criterion.status, 'satisfied', `got ${criterion.status}: ${criterion.note || ''}`);
  assert.match(criterion.evidence[0].detail, /most recent/i);
});
