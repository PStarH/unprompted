import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateValueStudy, valueStudyTemplate } from '../src/value-study.js';

// All records here are invented test inputs, including those testing the real_user branch.
const now = Date.parse('2026-10-26T12:00:00Z');
function fixture() {
  return { schemaVersion: 1, evidenceScope: 'real_user',
    collection: { mode: 'read_only_silent', startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-27T00:00:00Z',
      externalWrites: 0, participantNotifications: 0, evidenceRef: 'test-only-collection-log' },
    participants: [{ id: 'participant-1', source: 'participant', confirmedRealUser: true, consentRef: 'test-only-consent', consentedAt: '2026-10-20T00:00:00Z' }],
    cases: [{ id: 'case-1', participantId: 'participant-1', discoveredAt: '2026-10-21T00:00:00Z', discoveryMode: 'environment',
      contextEventRefs: ['test-event-1'], discoveryEvidenceRef: 'test-only-discovery-record',
      review: { source: 'participant', participantId: 'participant-1', reviewedAt: '2026-10-22T00:00:00Z', evidenceRef: 'test-only-interview-note',
        notExplicitlyRequested: true, useful: true, keepBecauseOfDiscovery: true } }], misses: [] };
}
const evaluate = input => evaluateValueStudy(input, { now });

test('only all four explicit user conditions qualify, without requiring an external action', () => {
  const report = evaluate(fixture());
  assert.equal(report.qualifyingUsers, 1);
  assert.equal(report.qualifyingCases, 1);
  assert.equal(report.unknown.observedRetention, 'not_measured');
  assert.match(report.evidenceBasis, /not independently authenticated/);
});

for (const field of ['notExplicitlyRequested', 'useful', 'keepBecauseOfDiscovery']) {
  test(`an absent or negative ${field} cannot become a positive case`, () => {
    for (const value of [undefined, false, 'true']) {
      const input = fixture(); input.cases[0].review[field] = value;
      assert.equal(evaluate(input).qualifyingUsers, 0);
    }
  });
}

test('simulation never counts as real-user value, even if every response is positive', () => {
  const input = fixture(); input.evidenceScope = 'synthetic';
  const report = evaluate(input);
  assert.equal(report.qualifyingUsers, 0);
  assert.equal(report.reviews.useful, 1);
  assert.equal(report.excludedConditions.real_scope, 1);
});

test('unreviewed work stays unknown rather than becoming noise or value', () => {
  const input = fixture(); delete input.cases[0].review;
  const report = evaluate(input);
  assert.equal(report.reviews.unreviewed, 1);
  assert.equal(report.reviews.notUseful, 0);
  assert.equal(report.qualifyingCases, 0);
  assert.equal(report.unknown.recall, 'unknown');
});

test('multiple qualifying discoveries for one user count that user once', () => {
  const input = fixture(); input.cases.push({ ...structuredClone(input.cases[0]), id: 'case-2' });
  assert.equal(evaluate(input).qualifyingCases, 2);
  assert.equal(evaluate(input).qualifyingUsers, 1);
  input.cases.push(structuredClone(input.cases[0]));
  assert.throws(() => evaluate(input), /Case IDs/);
});

test('agent labels, a different reviewer, future feedback and prompted work do not qualify', () => {
  for (const mutate of [
    input => { input.cases[0].review.source = 'agent'; },
    input => { input.cases[0].review.participantId = 'someone-else'; },
    input => { input.cases[0].review.reviewedAt = '2027-01-01'; },
    input => { input.cases[0].discoveryMode = 'prompted'; },
    input => { input.participants[0].confirmedRealUser = false; },
    input => { input.cases[0].contextEventRefs = []; }
  ]) { const input = fixture(); mutate(input); assert.equal(evaluate(input).qualifyingUsers, 0); }
});

test('missing consent, non-silent collection and write effects cannot pass the current protocol', () => {
  for (const mutate of [
    input => { delete input.participants[0].consentRef; },
    input => { input.participants[0].consentedAt = '2026-10-25'; },
    input => { input.collection.externalWrites = 1; },
    input => { delete input.collection.externalWrites; },
    input => { input.collection.participantNotifications = 1; },
    input => { input.collection.endedAt = '2026-11-30'; },
    input => { input.cases[0].discoveredAt = '2026-10-19'; }
  ]) { const input = fixture(); mutate(input); assert.equal(evaluate(input).qualifyingCases, 0); }
});

test('recorded misses are separate from recall and do not alter positive user counts', () => {
  const input = fixture(); input.misses = [{ id: 'miss-1', participantId: 'participant-1', source: 'participant', evidenceRef: 'test-only-miss', recordedAt: '2026-10-22' }];
  const report = evaluate(input);
  assert.equal(report.recordedMisses, 1);
  assert.equal(report.unknown.recall, 'unknown');
  assert.equal(report.qualifyingUsers, 1);
});

test('the offline CLI leaves its input untouched and prints no identifying content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-study-cli-'));
  const filename = path.join(root, 'study.json');
  try {
    const input = fixture(); input.cases[0].privateInterviewText = 'PRIVATE_INTERVIEW_CONTENT';
    input.participants[0].email = 'private-person@example.test';
    const content = JSON.stringify(input); fs.writeFileSync(filename, content);
    const script = fileURLToPath(new URL('../scripts/value-study.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--input', filename], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(filename, 'utf8'), content);
    assert.doesNotMatch(result.stdout, /PRIVATE_INTERVIEW_CONTENT|private-person|test-only-interview-note|participant-1/);
    const empty = evaluateValueStudy(valueStudyTemplate(), { now });
    assert.equal(empty.qualifyingUsers, 0);
    assert.equal(empty.casesRecorded, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
