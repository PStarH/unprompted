import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractDeadline, parseDeadline, resolveDeadlineIso, normaliseDateLocale, interpretRequest } from '../src/requests.js';
import { JsonStore, normaliseDeadlines } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';
import { deadlineRisk } from '../src/notifications.js';

const tempFiles = [];
test.after(() => {
  for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-deadline-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  const store = new JsonStore(filename);
  return { filename, store, engine: new WorkEngine(store, { policy: new PermissionPolicy({ shadow: true }), ...options }) };
}

/** A request whose only deadline is a bare numeric date. */
const numericDeadlineEmail = ({ id = 'm-num', phrase = '10/11', receivedAt = '2026-10-17T09:00:00.000Z' } = {}) => ({
  id: `event-${id}`, type: 'email.received', source: 'simulated',
  payload: {
    id, from: 'alex@example.test', subject: 'Vega status report',
    body: `Please update the Vega status report with the uptime metrics and share it by ${phrase}.`,
    receivedAt
  }
});

// 2026-10-16 is a Friday.
const friday = new Date('2026-10-16T09:00:00.000Z');
const wednesday = new Date('2026-10-14T12:00:00.000Z');
const earlyOctober = new Date('2026-10-05T12:00:00.000Z');

test('relative weekday phrases resolve against the request day', () => {
  assert.equal(resolveDeadlineIso('Friday', friday), '2026-10-16');
  assert.equal(resolveDeadlineIso('this Friday', wednesday), '2026-10-16');
  assert.equal(resolveDeadlineIso('Thursday', friday), '2026-10-22');
  assert.equal(resolveDeadlineIso('tomorrow', friday), '2026-10-17');
  assert.equal(resolveDeadlineIso('today', friday), '2026-10-16');
  assert.equal(resolveDeadlineIso('eow', wednesday), '2026-10-16');
  assert.equal(resolveDeadlineIso('next week', friday), '2026-10-23');
  assert.equal(resolveDeadlineIso('Oct 20', friday), '2026-10-20');
  assert.equal(resolveDeadlineIso('2026-10-18', friday), '2026-10-18');
  assert.equal(resolveDeadlineIso('10/18/2026', friday), '2026-10-18');
  // 10/18 has only one real reading under any convention (month 18 does not
  // exist), so it resolves. 10/11 genuinely has two and stays ambiguous.
  assert.equal(resolveDeadlineIso('10/18', friday), '2026-10-18');
  assert.equal(resolveDeadlineIso('10/11', friday), null, 'bare m/d with two real readings stays unresolved');
});

test('extractDeadline records the resolved day and keeps the original phrase', () => {
  const deadline = extractDeadline(
    'Please update the report by Friday.',
    { now: wednesday }
  );
  assert.equal(deadline.text, 'Friday');
  assert.equal(deadline.iso, '2026-10-16');
  assert.equal(deadline.kind, 'relative_resolved');
});

test('interpretRequest anchors the deadline to the email receivedAt', () => {
  const request = interpretRequest({
    id: 'm1',
    from: 'alex@example.test',
    subject: 'Northstar proposal',
    body: 'Please update the Northstar project proposal and send it by Friday. I need the sample size.',
    receivedAt: '2026-10-14T15:00:00.000Z'
  });
  assert.equal(request.deadline.text, 'Friday');
  assert.equal(request.deadline.iso, '2026-10-16');
  assert.equal(request.deadline.kind, 'relative_resolved');
});

test('an unresolved relative deadline on incomplete work becomes a deadline decision once resolved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-deadline-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: true }) });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  // Use a weekday name that resolves to tomorrow from "today" as receivedAt.
  const receivedAt = new Date().toISOString();
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const tomorrowName = weekdayNames[new Date(Date.now() + 86400000).getUTCDay()];
  engine.ingest({
    id: 'e-mail', type: 'email.received', source: 'simulated',
    payload: {
      id: 'm-deadline', from: 'alex@example.test',
      subject: 'Vega status report',
      body: `Please update the Vega status report with the metrics and share it by ${tomorrowName}. I need the uptime figure.`,
      receivedAt
    }
  });
  const task = store.state.tasks['request:m-deadline'];
  assert.equal(task.request.deadline.iso, tomorrow);
  assert.equal(task.status, 'waiting_for_information');
  const item = engine.publicState().notifications.find(entry => entry.kind === 'deadline');
  assert.ok(item, 'a near relative deadline on incomplete work interrupts once');
  assert.match(item.what, new RegExp(tomorrow));
  assert.equal(store.state.outbox.length, 0);
});

test('a complete draft does not raise a deadline interruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-deadline-ready-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: true }) });
  const receivedAt = new Date().toISOString();
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const tomorrowName = weekdayNames[new Date(Date.now() + 86400000).getUTCDay()];
  engine.ingest({
    id: 'e-mail', type: 'email.received', source: 'simulated',
    payload: {
      id: 'm-ready', from: 'alex@example.test',
      subject: 'Northstar proposal — experiment results',
      body: `Please update the Northstar project proposal with the latest experiment results and send the revised proposal by ${tomorrowName}. I need the sample size, control and treatment conversion results, and your conclusion.`,
      receivedAt
    }
  });
  engine.ingest({
    id: 'e-doc', type: 'document.modified', source: 'simulated',
    payload: {
      id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
      content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-14\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
    }
  });
  assert.equal(store.state.tasks['request:m-ready'].status, 'ready_for_approval');
  assert.equal(store.state.tasks['request:m-ready'].assessment.complete, true);
  assert.equal(
    engine.publicState().notifications.filter(entry => entry.kind === 'deadline').length,
    0,
    'a prepared complete reply is already waiting; a deadline ping would be noise'
  );
});

test('stored relative deadlines gain an iso on load without clearing evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-deadline-migrate-'));
  tempFiles.push(dir);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 4,
    revision: 1,
    mode: 'simulation',
    events: [],
    inbox: [{ id: 'm1', from: 'a@b.c', subject: 'x', body: 'by Friday', receivedAt: '2026-10-14T12:00:00.000Z' }],
    documents: {},
    runRecords: {},
    tasks: {
      'request:m1': {
        id: 'request:m1', status: 'waiting_for_information', sourceEmailId: 'm1',
        request: {
          subjectEntity: 'Vega', deliverable: 'report', intent: 'update_and_send',
          deadline: { text: 'Friday', iso: null, kind: 'relative' },
          requiredContent: [], impliedClaims: [], text: 'by Friday',
          source: { kind: 'email', id: 'm1', receivedAt: '2026-10-14T12:00:00.000Z' }
        },
        evidence: { criteria: [{ id: 'keep-me', status: 'unknown' }] },
        assessment: { complete: false },
        draft: null
      }
    },
    outbox: [],
    history: [],
    cursors: {},
    connectorStatus: {},
    calibrations: {},
    clarifications: [],
    notifications: [],
    opportunities: {},
    misses: [],
    trace: []
  }));
  const store = new JsonStore(file);
  assert.equal(store.state.tasks['request:m1'].request.deadline.iso, '2026-10-16');
  assert.equal(store.state.tasks['request:m1'].request.deadline.kind, 'relative_resolved');
  assert.equal(store.state.tasks['request:m1'].evidence.criteria[0].id, 'keep-me');
  assert.equal(normaliseDeadlines(store.state), false);
});

// ---------------------------------------------------------------------------
// Numeric dates: a locale is configuration, never a guess.
// ---------------------------------------------------------------------------

test('an explicitly configured locale resolves a bare numeric date deterministically', () => {
  const ref = new Date('2026-10-17T09:00:00.000Z');
  const monthFirst = parseDeadline('10/11', ref, { dateLocale: 'MM/DD' });
  const dayFirst = parseDeadline('10/11', ref, { dateLocale: 'DD/MM' });

  assert.equal(monthFirst.status, 'resolved');
  assert.equal(monthFirst.iso, '2027-10-11');
  assert.equal(dayFirst.status, 'resolved');
  assert.equal(dayFirst.iso, '2026-11-10');

  // Aliases canonicalise to the two supported readings, and nothing else does.
  for (const alias of ['M/D', 'MDY', 'month/day', 'MM-DD', 'mm/dd']) {
    assert.equal(normaliseDateLocale(alias), 'MM/DD', `${alias} should mean month/day`);
  }
  for (const alias of ['D/M', 'DMY', 'day/month', 'DD-MM', 'dd/mm']) {
    assert.equal(normaliseDateLocale(alias), 'DD/MM', `${alias} should mean day/month`);
  }
  assert.equal(normaliseDateLocale('ISO'), null);
  assert.equal(normaliseDateLocale(''), null);
  assert.equal(normaliseDateLocale(null), null);
});

test('a configured locale rejects the reading it cannot mean instead of silently flipping', () => {
  const ref = new Date('2026-10-17T09:00:00.000Z');

  // 13 is not a month, so under month/day this input is invalid rather than
  // quietly reinterpreted as 13 November.
  const rejected = parseDeadline('13/11', ref, { dateLocale: 'MM/DD' });
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.iso, null);
  assert.match(rejected.reason, /not a real calendar date/);

  // The same input is a real date under day/month, and under no locale only one
  // reading is possible at all.
  assert.equal(parseDeadline('13/11', ref, { dateLocale: 'DD/MM' }).iso, '2026-11-13');
  assert.equal(parseDeadline('13/11', ref).iso, '2026-11-13');

  // The mirror case.
  assert.equal(parseDeadline('11/13', ref, { dateLocale: 'DD/MM' }).status, 'invalid');
  assert.equal(parseDeadline('11/13', ref, { dateLocale: 'MM/DD' }).iso, '2026-11-13');
  assert.equal(parseDeadline('11/13', ref).iso, '2026-11-13');
});

test('without a locale a date with two real readings stays ambiguous and keeps its evidence', () => {
  const ref = new Date('2026-10-17T09:00:00.000Z');
  const result = parseDeadline('10/11', ref);

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.iso, null);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.readings.map(reading => reading.format).sort(), ['DD/MM', 'MM/DD']);
  assert.ok(result.readings.every(reading => reading.iso));
  assert.match(result.reason, /could mean/);

  const deadline = extractDeadline('Please send the report by 10/11.', { now: ref });
  assert.equal(deadline.text, '10/11', 'the original wording is kept');
  assert.equal(deadline.iso, null, 'no day is invented');
  assert.equal(deadline.ambiguous, true);
  assert.equal(deadline.candidates.length, 2);
  assert.match(deadline.reason, /no date format is configured/);
});

test('an invalid date is rejected rather than nudged into a plausible one', () => {
  const ref = new Date('2026-10-17T09:00:00.000Z');
  for (const phrase of ['2026-02-30', 'Feb 30', '31/31', '0/5', '2/30']) {
    const result = parseDeadline(phrase, ref);
    assert.equal(result.status, 'invalid', `${phrase} should be rejected`);
    assert.equal(result.iso, null, `${phrase} must not yield a day`);
    assert.match(result.reason, /not a real calendar date/);
  }
  // A leap day exists only in a leap year; the year is part of the check.
  assert.equal(parseDeadline('2024-02-29', ref).iso, '2024-02-29');
  assert.equal(parseDeadline('2026-02-29', ref).status, 'invalid');

  const deadline = extractDeadline('Please send it by Feb 30.', { now: ref });
  assert.equal(deadline.kind, 'invalid');
  assert.equal(deadline.iso, null);
  assert.match(deadline.reason, /not a real calendar date/);
});

test('boundary inputs resolve only when a single calendar day is possible', () => {
  const ref = new Date('2026-10-17T09:00:00.000Z');
  // Both conventions name the same day, so there is nothing to be ambiguous about.
  assert.equal(parseDeadline('12/12', ref).iso, '2026-12-12');
  assert.equal(parseDeadline('1/1', ref).iso, '2027-01-01');
  // Only one convention can produce a day.
  assert.equal(parseDeadline('12/31', ref).iso, '2026-12-31');
  assert.equal(parseDeadline('31/12', ref).iso, '2026-12-31');
  // Out of range on both sides.
  assert.equal(parseDeadline('00/00', ref).status, 'invalid');
  assert.equal(parseDeadline('32/13', ref).status, 'invalid');
});

test('an ambiguous date is not a deadline: no warning is raised and nothing is sent', () => {
  // The risk rule refuses it outright...
  assert.equal(deadlineRisk({ deadline: { iso: null, ambiguous: true, kind: 'ambiguous', text: '10/11' } }), null);
  assert.equal(deadlineRisk({ deadline: { iso: null, kind: 'invalid', text: 'Feb 30' } }), null);
  // ...and so does the engine, end to end.
  const env = setup();
  env.engine.ingest(numericDeadlineEmail({ phrase: '10/11' }));

  const task = env.store.state.tasks['request:m-num'];
  assert.ok(task, 'the request is still discovered');
  assert.equal(task.request.deadline.ambiguous, true);
  assert.equal(task.request.deadline.iso, null);
  assert.equal(task.status, 'waiting_for_information');
  assert.equal(
    env.engine.publicState().notifications.filter(item => item.kind === 'deadline').length,
    0,
    'an ambiguous day must not become a deadline warning'
  );
  assert.equal(env.store.state.outbox.length, 0, 'and it must not trigger an action');
});

test('the ambiguity reaches the user only when one reading changes the decision', () => {
  // Both readings are comfortably ahead, so asking would be noise. The sweep
  // still runs (it is stall-worthy), which is what makes this a real check.
  const quiet = setup({ stallAfterMs: 0 });
  quiet.engine.ingest(numericDeadlineEmail({ phrase: '10/11', receivedAt: '2026-10-17T09:00:00.000Z' }));
  quiet.engine.sweepAttention(new Date('2026-10-25T09:00:00.000Z'));
  assert.equal(
    quiet.engine.publicState().notifications.filter(item => item.kind === 'calibration').length,
    0,
    'a distant ambiguity is not put to the user'
  );

  // One reading lands tomorrow, so the answer changes whether this needs
  // attention now. A second ambiguous request must not ask again.
  const material = setup({ stallAfterMs: 0 });
  material.engine.ingest(numericDeadlineEmail({ phrase: '10/11', receivedAt: '2026-10-17T09:00:00.000Z' }));
  material.engine.ingest(numericDeadlineEmail({ id: 'm-num-2', phrase: '10/11', receivedAt: '2026-10-17T09:00:00.000Z' }));
  material.engine.sweepAttention(new Date('2026-11-09T09:00:00.000Z'));

  const asked = material.engine.publicState().notifications.filter(item => item.kind === 'calibration');
  assert.equal(asked.length, 1, 'the same question is asked once, not per request');
  assert.match(asked[0].headline, /10\/11/);
  assert.deepEqual(asked[0].options.map(option => option.value).sort(), ['DD/MM', 'MM/DD']);
  // Until it is answered the day is still not a deadline.
  assert.equal(
    material.engine.publicState().notifications.filter(item => item.kind === 'deadline').length,
    0
  );
  assert.equal(material.store.state.outbox.length, 0);
});

test('a stated date format re-reads the deadlines already stored', () => {
  const env = setup();
  env.engine.ingest(numericDeadlineEmail({ phrase: '11/10', receivedAt: '2026-11-09T09:00:00.000Z' }));
  const before = env.store.state.tasks['request:m-num'].request.deadline;
  assert.equal(before.iso, null);
  assert.equal(before.ambiguous, true);
  // `11/10` reads as 10 November (day/month) or 10 November next year under the
  // month/day reading, because 11 October has already passed.
  assert.deepEqual(before.candidates, ['2026-11-10', '2027-10-11']);

  env.engine.recordCalibration({
    key: 'preference:date_locale', kind: 'preference', value: 'DD/MM',
    scope: {}, instruction: 'correct'
  });

  const after = env.store.state.tasks['request:m-num'].request.deadline;
  assert.equal(after.iso, '2027-10-11', 'day/month means 11 October, the next one still ahead');
  assert.equal(after.ambiguous, undefined);
  assert.equal(after.candidates, undefined);
  // The same answer now governs a newly arriving request.
  env.engine.ingest(numericDeadlineEmail({ id: 'm-num-2', phrase: '11/10', receivedAt: '2026-11-09T09:00:00.000Z' }));
  assert.equal(env.store.state.tasks['request:m-num-2'].request.deadline.iso, '2027-10-11');
  assert.equal(env.store.state.tasks['request:m-num-2'].request.deadline.ambiguous, undefined);
});

test('a deadline that becomes imminent while nothing else happens still reaches the user', () => {
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const env = setup();
  // Five days out: outside the three-day warning window when it arrives.
  const target = new Date(Date.now() + 5 * 86400000);
  const iso = target.toISOString().slice(0, 10);
  env.engine.ingest({
    id: 'event-quiet', type: 'email.received', source: 'simulated',
    payload: {
      id: 'm-quiet', from: 'alex@example.test', subject: 'Vega status report',
      body: `Please update the Vega status report with the uptime metrics and share it by ${weekdayNames[target.getUTCDay()]}.`,
      receivedAt: new Date().toISOString()
    }
  });
  assert.equal(env.store.state.tasks['request:m-quiet'].request.deadline.iso, iso);
  assert.equal(
    env.engine.publicState().notifications.filter(item => item.kind === 'deadline').length,
    0,
    'five days out is not yet worth an interruption'
  );

  // Three days pass with no new event: only the calendar moved. The periodic
  // sweep is the only thing that can notice, and it must.
  const later = new Date(Date.now() + 3 * 86400000);
  // Pin the sweep to 30 minutes before UTC midnight. The follow-up tick an hour
  // later then crosses a day boundary, which is the one case where a quiet tick
  // *does* re-run attention evaluation — it must still not rewrite the state.
  later.setUTCHours(23, 30, 0, 0);
  env.engine.sweepAttention(later);
  const raised = env.engine.publicState().notifications.filter(item => item.kind === 'deadline');
  assert.equal(raised.length, 1, 'the deadline is now inside the window and must be raised');
  assert.match(raised[0].what, new RegExp(iso));

  // A second tick crossing midnight must not rewrite the workspace either:
  // attention evaluation found nothing new.
  const revision = env.store.state.revision;
  const crossing = new Date(later.getTime() + 3600000);
  assert.notEqual(crossing.toISOString().slice(0, 10), later.toISOString().slice(0, 10), 'the tick must cross a UTC day for this to test anything');
  env.engine.sweepAttention(crossing);
  assert.equal(env.store.state.revision, revision, 'a quiet tick does not rewrite state');
  assert.equal(env.store.state.outbox.length, 0);
});
