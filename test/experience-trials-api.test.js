import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { ExperienceService } from '../src/durable/experience.js';
import { TRIAL_FIXTURE_VERSION } from '../src/durable/experience-trial-fixtures.js';
import { loadedCaseSet, trialCaseSubmission } from '../public/durable.js';
import { startFixtureServer } from './browser/fixture-server.mjs';

const get = async (fixture, route) => {
  const response = await fetch(fixture.base + route);
  return { status: response.status, body: await response.json() };
};
async function post(fixture, route, body, origin = null) {
  const response = await fetch(fixture.base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function seed(directory) {
  const database = new DurableDatabase(path.join(directory, 'state.sqlite'));
  const jobs = new DurableJobs(database), experiences = new ExperienceService(database, { jobs });
  database.atomic(() => database.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('event','api-source',?)").run(iso(Date.now())));
  const notification = experiences.create({
    kind: 'planning_hint', scopeType: 'project', scopeKey: 'A', directiveKey: 'api.notification.mode',
    effect: { type: 'notification_behavior', mode: 'digest' }, instruction: 'Use a digest for this project.', freshnessClass: 'stable'
  }, { sources: [{ kind: 'event', id: 'api-source' }] });
  const override = experiences.create({
    kind: 'planning_hint', scopeType: 'project', scopeKey: 'A', directiveKey: 'api.notification.override',
    effect: { type: 'notification_behavior', mode: 'interactive' }, instruction: 'Use interactive notifications for this project.', freshnessClass: 'stable'
  }, { sources: [{ kind: 'event', id: 'api-source' }] });
  database.close();
  return { notification, override };
}
test('the case editor appends only from a loaded current detail and refuses a stale conflict', () => {
  const experience = { id: 'experience-1', revision: 3, caseSet: { version: 2, digest: 'd'.repeat(64), count: 1 } };
  const detail = { experience: { id: 'experience-1', revision: 3, caseSet: { version: 2, digest: 'd'.repeat(64), count: 1,
    cases: [{ id: 'existing-case' }] } } };
  assert.equal(loadedCaseSet({ detail: undefined, experience }), null, 'an unloaded detail cannot yield a case set');
  assert.equal(loadedCaseSet({ detail: { experience: { ...detail.experience, revision: 2 } }, experience }), null, 'an old revision cannot be appended to');
  assert.equal(loadedCaseSet({ detail: { experience: { ...detail.experience, caseSet: { ...detail.experience.caseSet, version: 1 } } }, experience }), null, 'an old case-set version cannot be appended to');
  assert.equal(loadedCaseSet({ detail: { experience: { ...detail.experience, caseSet: { version: 2, digest: 'd'.repeat(64), count: 1 } } }, experience }), null, 'a summary without a real cases array is not a detail');
  assert.equal(loadedCaseSet({ detail: { experience: { ...detail.experience, caseSet: { ...detail.experience.caseSet, invalid: true } } }, experience }), null);
  assert.equal(loadedCaseSet({ detail, experience }).cases.length, 1);
  const action = { experienceId: 'experience-1', revision: 3, caseSet: { version: 2 } };
  const nextCase = { id: 'new-case' };
  assert.deepEqual(trialCaseSubmission({ detail, experience, action, nextCase }),
    { expectedRevision: 3, expectedCaseSetVersion: 2, cases: [{ id: 'existing-case' }, { id: 'new-case' }] });
  assert.equal(trialCaseSubmission({ detail: undefined, experience, action, nextCase }), null, 'a failed detail load writes nothing');
  assert.equal(trialCaseSubmission({ detail, experience, action: { ...action, caseSet: { version: 1 } }, nextCase }), null, 'a stale form cannot overwrite the latest set');
  assert.equal(trialCaseSubmission({ detail, experience, action: { ...action, revision: 2 }, nextCase }), null, 'a stale revision writes nothing');
  assert.equal(trialCaseSubmission({ detail: { experience: { ...detail.experience, revision: 2 } }, experience, action, nextCase }), null);
});
const literalCase = {
  id: 'api-independent-case', scope: [{ type: 'project', key: 'A' }], features: {},
  expected: { applies: true, winner: 'candidate', effect: { type: 'notification_behavior', mode: 'digest' } }
};
test('the durable API saves user cases, evaluates only server-side data, adopts and rolls back', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-experience-api-'));
  const { notification: seeded, override } = seed(directory);
  const fixture = await startFixtureServer({ ruleDemo: false, directory });
  t.after(async () => { await fixture.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  let listed = await get(fixture, '/api/experiences');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.available, true);
  assert.equal(listed.body.evaluation.fixtureVersion, TRIAL_FIXTURE_VERSION);
  assert.equal(listed.body.evaluation.policyDigest.length, 64);
  assert.match(listed.body.evaluation.policyVersion, /\.2$/);
  assert.equal(listed.body.evaluation.positiveCandidateEvidence, 'required');
  assert.ok(listed.body.evaluation.deadlineMs > 0);
  const first = listed.body.experiences.find(experience => experience.id === seeded.id);
  assert.equal(first.latestTrial, null);
  assert.deepEqual({ version: first.caseSet.version, count: first.caseSet.count }, { version: 0, count: 0 });
  assert.deepEqual(first.authorization, { required: false, status: 'not_required', reason: 'no_external_target' });
  assert.equal(first.contentVersions.length, 1);
  assert.equal(first.contentVersions[0].changeKind, 'create');

  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 1, passed: true })).status, 400);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 1, purpose: 'automatic' })).status, 400);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 99 })).status, 409);
  const conflict = await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 99 });
  assert.equal(conflict.body.code, 'EXPERIENCE_CHANGED');
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 1 }, 'https://foreign.test')).status, 403);

  const strict = await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 1 });
  assert.equal(strict.status, 200);
  assert.equal(strict.body.trial.state, 'unknown');
  assert.equal(strict.body.trial.categories.behavior.total, 0);
  assert.equal(strict.body.trial.categories.guard.total > 0, true);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/adopt`, { expectedRevision: 1 })).body.code, 'ADOPTION_UNTESTED');

  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/cases`, { expectedRevision: 1, expectedCaseSetVersion: 0, cases: [literalCase], passed: true })).status, 400);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/cases`, { expectedRevision: 1, expectedCaseSetVersion: 0, cases: [literalCase], userRequested: true })).status, 400);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/cases`, { expectedRevision: 1, expectedCaseSetVersion: 0,
    cases: [{ ...literalCase, passed: true }] })).status, 400);
  const saved = await post(fixture, `/api/experiences/${seeded.id}/cases`, { expectedRevision: 1, expectedCaseSetVersion: 0, cases: [literalCase] });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.caseSet.version, 1);
  assert.equal(saved.body.caseSet.count, 1);
  assert.equal(saved.body.caseSet.digest.length, 64);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/cases`, { expectedRevision: 1, expectedCaseSetVersion: 0, cases: [literalCase] })).body.code, 'CASE_SET_CHANGED');
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/cases`, { expectedRevision: 9, expectedCaseSetVersion: 1, cases: [literalCase] })).body.code, 'EXPERIENCE_CHANGED');

  const evaluated = await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 1 });
  assert.equal(evaluated.status, 200);
  assert.equal(evaluated.body.trial.state, 'passed');
  assert.equal(evaluated.body.trial.counts.failed, 0);
  assert.equal(evaluated.body.trial.counts.unknown, 0);
  assert.equal(evaluated.body.trial.counts.passed, evaluated.body.trial.counts.total);
  assert.equal(evaluated.body.trial.categories.behavior.total, 1);
  assert.equal(evaluated.body.trial.categories.behavior.applicable, 1);
  assert.equal(evaluated.body.trial.caseSetVersion, 1);
  assert.equal(evaluated.body.trial.testedRevision, 1);
  assert.equal(evaluated.body.trial.effectiveState, 'passed');
  assert.ok(Date.parse(evaluated.body.trial.expiresAt) > Date.now());

  const detail = await get(fixture, `/api/experiences/${seeded.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.evaluation.fixtureVersion, listed.body.evaluation.fixtureVersion);
  assert.equal(detail.body.experience.caseSet.version, 1);
  assert.deepEqual(detail.body.experience.caseSet.cases, [literalCase]);
  assert.equal(detail.body.trials.length, 2);
  assert.ok(Array.isArray(detail.body.trials[0].differences));
  assert.equal(detail.body.trials[0].differences.every(difference => difference.status === 'pass'), true);
  assert.equal((await get(fixture, '/api/experiences/absent')).status, 404);

  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/adopt`, { expectedRevision: 1, passed: true })).status, 400);
  const adopted = await post(fixture, `/api/experiences/${seeded.id}/adopt`, { expectedRevision: 1 });
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.experience.status, 'active');
  assert.equal(adopted.body.experience.revision, 2);
  assert.equal(adopted.body.experience.verified_success_count, 0);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 1 })).status, 409);

  listed = await get(fixture, '/api/experiences');
  const active = listed.body.experiences.find(experience => experience.id === seeded.id);
  assert.equal(active.latestTrial.revision, 2);
  assert.equal(active.latestTrial.testedRevision, 1);
  assert.equal(active.latestTrial.adoptedRevision, 2);
  assert.equal(active.latestTrial.state, 'passed');
  assert.equal(active.latestTrial.effectiveState, 'passed');
  assert.equal(active.latestTrial.caseSetVersion, 1);

  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/rollback`, { expectedRevision: 2 })).status, 400);
  const rolled = await post(fixture, `/api/experiences/${seeded.id}/rollback`, { expectedRevision: 2, targetRevision: 1 });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.experience.status, 'candidate');
  assert.equal(rolled.body.experience.revision, 3);
  assert.equal(rolled.body.experience.verified_success_count, 0);
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/adopt`, { expectedRevision: 3 })).body.code, 'ADOPTION_UNTESTED');

  const rolledDetail = await get(fixture, `/api/experiences/${seeded.id}`);
  assert.deepEqual(rolledDetail.body.experience.contentVersions.map(version => [version.revision, version.changeKind]), [[3, 'rollback'], [2, 'adopt'], [1, 'create']]);
  assert.equal(/^(expired|superseded)$/.test(rolledDetail.body.experience.latestTrial.effectiveState), true, 'the adopted attestation is invalidated by the rollback');
  assert.equal((await post(fixture, `/api/experiences/${seeded.id}/evaluate`, { expectedRevision: 3 })).body.trial.state, 'passed');
  const readopted = await post(fixture, `/api/experiences/${seeded.id}/adopt`, { expectedRevision: 3 });
  assert.equal(readopted.status, 200);
  assert.equal(readopted.body.experience.revision, 4);
  assert.equal(readopted.body.experience.status, 'active');

  // The override-only path through the real HTTP service is supporting
  // evidence, not candidate behaviour evidence: no pass and no adoption.
  // Appending a literal positive case to the loaded set makes the same
  // candidate testable.
  const overrideCase = { id: 'api-override-only', scope: [{ type: 'project', key: 'A' }], features: {},
    expected: { applies: true, winner: 'user' }, userEffect: { type: 'notification_behavior', mode: 'silent' } };
  const savedOverride = await post(fixture, `/api/experiences/${override.id}/cases`,
    { expectedRevision: 1, expectedCaseSetVersion: 0, cases: [overrideCase] });
  assert.equal(savedOverride.status, 200);
  assert.equal(savedOverride.body.caseSet.count, 1);
  const overrideUnknown = await post(fixture, `/api/experiences/${override.id}/evaluate`, { expectedRevision: 1 });
  assert.equal(overrideUnknown.status, 200);
  assert.equal(overrideUnknown.body.trial.state, 'unknown');
  assert.equal(overrideUnknown.body.trial.categories.behavior.applicable, 1);
  assert.equal(overrideUnknown.body.trial.categories.behavior.positive, 0);
  assert.equal(overrideUnknown.body.trial.counts.failed, 0);
  assert.equal((await post(fixture, `/api/experiences/${override.id}/adopt`, { expectedRevision: 1 })).body.code, 'ADOPTION_UNTESTED');
  const overrideDetail = await get(fixture, `/api/experiences/${override.id}`);
  assert.equal(overrideDetail.body.experience.latestTrial.state, 'unknown');
  assert.equal(overrideDetail.body.experience.latestTrial.effectiveState, 'unknown');
  assert.ok(overrideDetail.body.trials[0].differences.some(difference => difference.reason === 'no_applicable_positive_candidate_case'));

  const positiveCase = { id: 'api-override-positive', scope: [{ type: 'project', key: 'A' }], features: {},
    expected: { applies: true, winner: 'candidate', effect: { type: 'notification_behavior', mode: 'interactive' } } };
  const appended = await post(fixture, `/api/experiences/${override.id}/cases`,
    { expectedRevision: 1, expectedCaseSetVersion: 1, cases: [overrideCase, positiveCase] });
  assert.equal(appended.status, 200);
  assert.equal(appended.body.caseSet.version, 2);
  assert.equal(appended.body.caseSet.count, 2);
  const overridePassed = await post(fixture, `/api/experiences/${override.id}/evaluate`, { expectedRevision: 1 });
  assert.equal(overridePassed.body.trial.state, 'passed');
  assert.equal(overridePassed.body.trial.categories.behavior.applicable, 2);
  assert.equal(overridePassed.body.trial.categories.behavior.positive, 1);
  const overrideAdopted = await post(fixture, `/api/experiences/${override.id}/adopt`, { expectedRevision: 1 });
  assert.equal(overrideAdopted.status, 200);
  assert.equal(overrideAdopted.body.experience.status, 'active');
  assert.equal(overrideAdopted.body.experience.revision, 2);
});
