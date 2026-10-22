import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { PERMISSION_KEYS } from '../src/calibration.js';
import { validateContract } from '../src/contracts.js';
import { chooseVerificationDepth, comparableReading, comparableVerdict, compareAcrossSources, applySourceConflicts, VERIFICATION_DEPTHS } from '../src/verification.js';

/**
 * Verification depth.
 *
 * Verification effort should match risk:
 * work backed by one directly relevant source must not be pushed through extra
 * checks, while a request a second plausible document could also satisfy gets
 * its competing version of the facts checked independently — agreement is
 * corroboration, disagreement stops completion with a readable reason, and no
 * standing authorisation can bypass the approval that a competing source
 * demands. These are counterexamples first: each test exists because the wrong
 * behaviour is tempting.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-verification-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

let revision = 0;
const email = (body = 'Please update the Zephyr incident analysis with the incident statistics and send it by Friday.') => ({
  id: `event-email-${++revision}`, type: 'email.received',
  payload: { id: 'm1', from: 'alex@example.test', subject: 'Zephyr incident analysis', body }
});

const latestEmail = () => email('Please update the Zephyr incident analysis with the latest incident statistics and send it by Friday.');

const document = (id, title, content, at = '2026-10-16T09:00:00.000Z') => ({
  id: `event-doc-${id}-${++revision}`, type: 'document.modified',
  payload: { id, kind: 'report', title, content, modifiedAt: at }
});

const analysis = (count, asOf = null) => document('zephyr-incident-analysis', 'Zephyr incident analysis',
  `# Zephyr incident analysis\n\n## Incident statistics\n${asOf ? `As of: ${asOf}\n` : ''}Incident count: ${count}\n`);

const retrospective = (count, asOf = null, at = '2026-10-16T09:05:00.000Z') => document('zephyr-retrospective', 'Zephyr service retrospective',
  `# Zephyr service retrospective\n\n## Incident statistics\n${asOf ? `As of: ${asOf}\n` : ''}Incident count: ${count}\n`, at);

const approvalEmail = () => email('Please update the Zephyr proposal with the approval and send it by Friday.');
const latestApprovalEmail = () => email('Please update the Zephyr proposal with the latest approval and send it by Friday.');
const proposal = (conclusion, asOf = null) => document('zephyr-proposal', 'Zephyr proposal',
  `# Zephyr proposal\n\n## Approval\nApproval: ${conclusion}\n${asOf ? `As of: ${asOf}\n` : ''}`);
const serviceReview = (conclusion, asOf = null, at = '2026-10-16T09:05:00.000Z') => document('zephyr-service-review', 'Zephyr service review',
  `# Zephyr service review\n\n## Approval\nApproval: ${conclusion}\n${asOf ? `As of: ${asOf}\n` : ''}`, at);

const migrationEmail = () => email('Please update the Zephyr retrospective with the assessment and send it by Friday.');
const migrationRetrospective = (conclusion) => document('zephyr-migration-retrospective', 'Zephyr retrospective',
  `# Zephyr retrospective\n\n## Assessment\nAssessment: the migration is ${conclusion}.\n`);
const migrationReview = (conclusion) => document('zephyr-service-review', 'Zephyr service review',
  `# Zephyr service review\n\n## Assessment\nAssessment: the migration is ${conclusion}.\n`, '2026-10-16T09:05:00.000Z');

const task = store => store.state.tasks['request:m1'];

// ------------------------------------------------------------------ selection

test('depth is chosen from the evidence state: one source standard, a competitor enhanced, an equal match enhanced without acting', () => {
  assert.deepEqual(VERIFICATION_DEPTHS, ['standard', 'enhanced']);
  const entry = (id, version = 1) => ({ document: { id, version } });
  const single = chooseVerificationDepth({ ranked: [entry('a')] });
  assert.equal(single.depth, 'standard');
  assert.ok(single.basis.some(item => item.code === 'single_source'));
  assert.deepEqual(single.crossCheck, [], 'a single source gets no extra checks');

  const ranked = [entry('a'), entry('b'), entry('c'), entry('d')];
  const competing = chooseVerificationDepth({ ranked });
  assert.equal(competing.depth, 'enhanced');
  assert.ok(competing.basis.some(item => item.code === 'competing_sources'));
  assert.ok(competing.basis.some(item => item.code === 'approval_required'));
  assert.deepEqual(competing.crossCheck.map(item => item.document.id), ['b', 'c'], 'the check is bounded, not open-ended');

  const ambiguous = chooseVerificationDepth({ ranked, ambiguous: true });
  assert.equal(ambiguous.depth, 'enhanced');
  assert.ok(ambiguous.basis.some(item => item.code === 'ambiguous_sources'));
  assert.deepEqual(ambiguous.crossCheck, [], 'nothing is re-checked while the match itself cannot be established');
});

test('a date is freshness evidence, not a value two documents can disagree about', () => {
  assert.deepEqual(comparableReading('Incident count: 11'), { raw: '11', value: 11 });
  assert.deepEqual(comparableReading('Conversion improved to 8.1%'), { raw: '8.1%', value: 8.1 });
  assert.deepEqual(comparableReading('1,204 minutes sampled'), { raw: '1,204', value: 1204 });
  assert.equal(comparableReading('As of: 2026-10-15'), null, 'an ISO date is not a comparable value');
  assert.equal(comparableReading('Reviewed 10/15/2026'), null, 'a slash date is not a comparable value either');
  assert.equal(comparableReading('no numbers here'), null);
});

const satisfied = (id, excerpt, extra = {}) => ({ id, label: id === 'incident_stats' ? 'Incident statistics' : id, status: 'satisfied', evidence: [{ excerpt }], date: null, ...extra });

test('cross-source comparison separates agreement, disagreement, older readings and newer rivals', () => {
  const contender = { id: 'zephyr-retrospective', title: 'Zephyr service retrospective', version: 1, modifiedAt: '2026-10-16T09:05:00.000Z', url: 'doc://retro' };

  const agree = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11')],
    contenderCriteria: [satisfied('incident_stats', 'Incident count: 11')],
    contenderDocument: contender
  });
  assert.equal(agree.length, 1);
  assert.equal(agree[0].outcome, 'corroborated');

  const disagree = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11')],
    contenderCriteria: [satisfied('incident_stats', 'Incident count: 4')],
    contenderDocument: contender
  });
  assert.equal(disagree[0].outcome, 'conflict');
  assert.equal(disagree[0].contendingExcerpt, 'Incident count: 4');
  assert.match(disagree[0].detail, /disagree/);
  assert.match(disagree[0].detail, /Confirm which one is current/);

  const superseded = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11', { date: '2026-10-15' })],
    contenderCriteria: [satisfied('incident_stats', 'Incident count: 4')],
    contenderDocument: contender,
    contenderDocumentDate: '2026-10-10'
  });
  assert.equal(superseded[0].outcome, 'superseded', 'an older, contradicting reading is recorded, not treated as a conflict');

  const newerRival = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11', { date: '2026-10-10' })],
    contenderCriteria: [satisfied('incident_stats', 'Incident count: 4')],
    contenderDocument: contender,
    contenderDocumentDate: '2026-10-15'
  });
  assert.equal(newerRival[0].outcome, 'conflict_newer_source', 'a later-dated rival with a different value must stop the work');
  assert.match(newerRival[0].detail, /dated later/);

  const sameMoment = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11', { date: '2026-10-15' })],
    contenderCriteria: [satisfied('incident_stats', 'Incident count: 4')],
    contenderDocument: contender,
    contenderDocumentDate: '2026-10-15'
  });
  assert.equal(sameMoment[0].outcome, 'conflict', 'two values from the same moment disagree; recency cannot decide them');

  const selfContradicting = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11')],
    contenderCriteria: [{ id: 'incident_stats', label: 'Incident statistics', status: 'conflicting', evidence: [], date: null }],
    contenderDocument: contender
  });
  assert.equal(selfContradicting[0].outcome, 'internal_conflict');

  const missing = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11')],
    contenderCriteria: [{ id: 'incident_stats', label: 'Incident statistics', status: 'not_satisfied', evidence: [], date: null }],
    contenderDocument: contender
  });
  assert.deepEqual(missing, [], 'a source that does not mention the content is not evidence against it');

  const unreadable = compareAcrossSources({
    bestCriteria: [satisfied('incident_stats', 'Incident count: 11')],
    contenderCriteria: [{ id: 'incident_stats', label: 'Incident statistics', status: 'unknown', evidence: [], date: null }],
    contenderDocument: contender
  });
  assert.equal(unreadable[0].outcome, 'no_additional_evidence', 'an unresolved reading in the other source is recorded as such, not treated as agreement');

  const meta = compareAcrossSources({
    bestCriteria: [satisfied('as_of_date', 'As of: 2026-10-15')],
    contenderCriteria: [satisfied('as_of_date', 'As of: 2026-10-10')],
    contenderDocument: contender
  });
  assert.deepEqual(meta, [], 'document dates are never compared as disagreeing values');
});

test('a criterion two sources disagree about is downgraded; agreement leaves it untouched', () => {
  const criteria = [satisfied('incident_stats', 'Incident count: 11')];
  const untouched = applySourceConflicts(criteria, [{ criterionId: 'incident_stats', outcome: 'corroborated' }]);
  assert.equal(untouched, criteria, 'nothing is rebuilt when nothing disagrees');

  const conflict = {
    criterionId: 'incident_stats', label: 'Incident statistics', outcome: 'conflict',
    chosen: '11', rival: '4', contender: { id: 'zephyr-retrospective', title: 'Zephyr service retrospective', version: 1, modifiedAt: null, url: null },
    contendingExcerpt: 'Incident count: 4', detail: '“Incident statistics”: two plausible documents disagree.'
  };
  const applied = applySourceConflicts(criteria, [conflict]);
  assert.equal(applied[0].status, 'conflicting');
  assert.equal(applied[0].note, conflict.detail);
  assert.match(applied[0].whatWouldResolveIt, /Reconcile the two documents/);
  assert.equal(applied[0].evidence.length, 2, 'the competing excerpt is kept next to the chosen one');
  assert.equal(applied[0].evidence[1].source.id, 'zephyr-retrospective');
});

// ------------------------------------------------------------------ engine

test('a single-source request is verified with the baseline checks and no extra work runs', () => {
  const { store, engine } = setup();
  engine.ingest(email());
  engine.ingest(analysis(11));
  const current = task(store);
  assert.equal(current.status, 'ready_for_approval');
  assert.equal(current.verification.depth, 'standard');
  assert.deepEqual(current.verification.performed, [], 'a low-risk single-source task is not forced through redundant verification');
  assert.deepEqual(current.verification.checkedDocuments, []);
  assert.ok(validateContract('verification', current.verification).ok, 'the recorded verification satisfies its contract');
  assert.equal(store.state.outbox.length, 0);
});

test('two plausible sources that disagree stop the work with a readable reason and no draft', () => {
  const { store, engine } = setup();
  engine.ingest(email());
  engine.ingest(analysis(11));
  engine.ingest(retrospective(4));
  const current = task(store);
  assert.equal(current.status, 'waiting_for_information');
  assert.equal(current.assessment.complete, false);
  assert.equal(current.draft, null, 'no draft may rest on a disputed value');
  assert.equal(store.state.outbox.length, 0);
  assert.ok(current.evidence.conflicts.some(item => item.id === 'conflicting:incident_stats'));
  const criterion = current.evidence.criteria.find(item => item.id === 'incident_stats');
  assert.equal(criterion.status, 'conflicting');
  assert.match(criterion.note, /two plausible documents disagree/);
  assert.match(criterion.note, /Confirm which one is current/);
  assert.match(criterion.whatWouldResolveIt, /Reconcile the two documents/);
  assert.ok(criterion.evidence.some(item => item.source.id === 'zephyr-retrospective'), 'both readings are kept as evidence');
  assert.equal(current.verification.depth, 'enhanced');
  assert.deepEqual(current.verification.performed, [{
    documentId: 'zephyr-retrospective', documentVersion: 1, criterionId: 'incident_stats', outcome: 'conflict'
  }]);
  assert.ok(validateContract('verification', current.verification).ok, 'the enhanced record satisfies the same contract');
});

test('a standing authorisation cannot bypass strengthened verification, but an explicit approval still completes', async () => {
  const { store, engine } = setup();
  engine.recordCalibration({ key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Zephyr' } });
  // Both plausible documents are already observed when the request arrives, so
  // the very first assessment sees the competition. (A competitor arriving
  // after an autonomous completion cannot un-send it; that ordering is the
  // pre-existing grant contract, not something this check silently changes.)
  engine.ingest(analysis(11));
  engine.ingest(retrospective(11));
  engine.ingest(email());
  await engine.whenSettled();
  const current = task(store);
  assert.equal(current.verification.depth, 'enhanced');
  assert.deepEqual(current.verification.performed, [{
    documentId: 'zephyr-retrospective', documentVersion: 1, criterionId: 'incident_stats', outcome: 'corroborated'
  }]);
  assert.equal(current.status, 'ready_for_approval', 'a competing source means the grant is not enough');
  assert.equal(store.state.outbox.length, 0, 'nothing may be sent under a grant alone when the evidence needed strengthening');
  assert.throws(() => engine.executePreAuthorized('request:m1'), /Enhanced verification requires an explicit approval/);
  engine.approve('request:m1');
  await engine.whenSettled();
  assert.equal(task(store).status, 'completed');
  assert.equal(task(store).action.permission, 'user_approved');
  assert.equal(store.state.outbox.length, 1);
});

test('the same authorisation still runs a single-source follow-through without a fresh click', async () => {
  const { store, engine } = setup();
  engine.recordCalibration({ key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Zephyr' } });
  engine.ingest(email());
  engine.ingest(analysis(11));
  await engine.whenSettled();
  const current = task(store);
  assert.equal(current.verification.depth, 'standard');
  assert.equal(current.status, 'completed');
  assert.equal(current.action.permission, 'pre_authorized');
  assert.equal(store.state.outbox.length, 1);
});

test('new evidence is re-evaluated: a revised competitor resolves the stop, and a later divergence stops the work again', () => {
  const { store, engine } = setup();
  engine.ingest(email());
  engine.ingest(analysis(11));
  engine.ingest(retrospective(4));
  assert.equal(task(store).status, 'waiting_for_information');

  engine.ingest(retrospective(11));
  const resolved = task(store);
  assert.equal(resolved.status, 'ready_for_approval', 'an agreeing revision resolves the conflict');
  assert.equal(resolved.evidence.conflicts.length, 0);
  assert.deepEqual(resolved.verification.performed, [{
    documentId: 'zephyr-retrospective', documentVersion: 2, criterionId: 'incident_stats', outcome: 'corroborated'
  }]);

  engine.ingest(retrospective(7));
  const diverged = task(store);
  assert.equal(diverged.status, 'waiting_for_information', 'a new disagreement stops the work again');
  assert.ok(diverged.evidence.conflicts.some(item => item.id === 'conflicting:incident_stats'));
  assert.equal(diverged.verification.performed[0].documentVersion, 3);
  assert.equal(diverged.verification.performed[0].outcome, 'conflict');
});

test('an older competing reading is recorded and superseded, not treated as a contradiction', () => {
  const { store, engine } = setup();
  engine.ingest(latestEmail());
  engine.ingest(analysis(11, '2026-10-15'));
  engine.ingest(retrospective(4, '2026-10-10'));
  const current = task(store);
  assert.equal(current.status, 'ready_for_approval');
  assert.equal(current.evidence.conflicts.length, 0);
  assert.deepEqual(current.verification.performed, [{
    documentId: 'zephyr-retrospective', documentVersion: 1, criterionId: 'incident_stats', outcome: 'superseded'
  }]);
  assert.ok(current.evidence.observations.some(item => item.id === 'cross_source:zephyr-retrospective:incident_stats'));
});

test('a later-dated competing source with a different value blocks completion', () => {
  const { store, engine } = setup();
  engine.ingest(latestEmail());
  engine.ingest(analysis(11, '2026-10-10'));
  engine.ingest(retrospective(4, '2026-10-15'));
  const current = task(store);
  assert.equal(current.status, 'waiting_for_information');
  assert.equal(current.verification.performed[0].outcome, 'conflict_newer_source');
  assert.match(current.evidence.criteria.find(item => item.id === 'incident_stats').note, /dated later/);
});

test('when the match itself is ambiguous, depth is recorded as enhanced and no comparison runs on an unfounded choice', () => {
  const { store, engine } = setup();
  engine.ingest({ id: 'event-email', type: 'email.received', payload: {
    id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal',
    body: 'Please update the Northstar proposal with the reviewer comments and send it by Friday.'
  } });
  engine.ingest(document('northstar-proposal-a', 'Northstar proposal', '# Northstar proposal\n\n## Reviewer comments\nDana: tighten the introduction.\n'));
  engine.ingest(document('northstar-proposal-b', 'Northstar proposal', '# Northstar proposal\n\n## Reviewer comments\nPriya: add the comparison table.\n'));
  const current = store.state.tasks['request:m1'];
  assert.equal(current.status, 'waiting_for_information');
  assert.ok(current.evidence.conflicts.some(item => item.id === 'ambiguous_document'));
  assert.equal(current.verification.depth, 'enhanced');
  assert.ok(current.verification.basis.some(item => item.code === 'ambiguous_sources'));
  assert.deepEqual(current.verification.performed, [], 'no comparison is performed while the choice of document is unfounded');
});

test('repeated assessment does not duplicate the verification record or inflate the value metrics', () => {
  const { store, engine } = setup();
  engine.ingest(email());
  engine.ingest(analysis(11));
  engine.ingest(retrospective(11));
  const before = task(store).verification.performed.length;
  engine.assess('request:m1', null, { force: true });
  engine.assess('request:m1', null, { force: true });
  assert.equal(task(store).verification.performed.length, before, 'a repeated check cannot manufacture a second corroboration');
  const metrics = engine.publicState().metrics.verification;
  assert.equal(metrics.corroborations, 1, 'the corroboration is counted once, from the stored record');
  assert.equal(metrics.enhanced, 1);
  assert.equal(metrics.standard, 0);
  assert.equal(metrics.sourceConflicts, 0);
  assert.ok(metrics.basis.length > 0, 'every metric states how it was derived');
});

test('a resolved source conflict is visible as a conflict metric, and a stopped task is not counted as valuable', () => {
  const { store, engine } = setup();
  engine.ingest(email());
  engine.ingest(analysis(11));
  engine.ingest(retrospective(4));
  const metrics = engine.publicState().metrics;
  assert.equal(metrics.verification.sourceConflicts, 1);
  assert.equal(metrics.verification.enhanced, 1);
  assert.equal(metrics.discovery.valuable, 0, 'a task stopped by a conflict is not counted as prepared value');
  assert.equal(store.state.outbox.length, 0);
});

// ------------------------------------------------------------------ verdicts

test('explicit prose conclusions are read only when unambiguous: negation flips, speculation and open questions do not', () => {
  assert.equal(comparableVerdict('The request was approved.').polarity, 1);
  assert.equal(comparableVerdict('The request was approved.').raw, 'approved');
  assert.equal(comparableVerdict('Status: rejected').polarity, -1);
  assert.equal(comparableVerdict('not approved').polarity, -1);
  assert.equal(comparableVerdict('Migration is not completed').polarity, -1);
  assert.equal(comparableVerdict('has yet to be approved').polarity, -1);
  assert.equal(comparableVerdict('unresolved').polarity, -1);
  assert.equal(comparableVerdict('should be approved'), null, 'a recommendation or expectation is not a conclusion');
  assert.equal(comparableVerdict('to be approved'), null, 'a future passive states an intention');
  assert.equal(comparableVerdict('awaiting sign-off'), null);
  assert.equal(comparableVerdict('not rejected'), null, 'a double negative concludes nothing');
  assert.equal(comparableVerdict('rejected in May but approved in June'), null, 'an excerpt stating several conclusions is not comparable');
  assert.equal(comparableVerdict('no conclusion in this sentence'), null);
  assert.ok(comparableVerdict('According to the minutes, the request was approved'), '“according to” must not be misread as a future marker');
  assert.ok(comparableVerdict('The plan was approved in May'), 'a month name must not gate a real conclusion');
  assert.ok(comparableVerdict('The board not only approved the plan but doubled it'), '“not only” is rhetorical, not a negation');
});

test('cross-source comparison catches opposite conclusions and keeps conclusions on different requirements apart', () => {
  const contender = { id: 'zephyr-service-review', title: 'Zephyr service review', version: 1, modifiedAt: '2026-10-16T09:05:00.000Z', url: 'doc://review' };

  const opposite = compareAcrossSources({
    bestCriteria: [satisfied('approval', 'Approval: approved by the review board')],
    contenderCriteria: [satisfied('approval', 'Approval: rejected by the review board')],
    contenderDocument: contender
  });
  assert.equal(opposite[0].outcome, 'conflict');
  assert.equal(opposite[0].chosen, 'approved');
  assert.equal(opposite[0].rival, 'rejected');
  assert.equal(opposite[0].contendingExcerpt, 'Approval: rejected by the review board', 'the competing conclusion is kept as evidence');
  assert.match(opposite[0].detail, /opposite conclusions/);
  assert.match(opposite[0].detail, /Confirm which one is current/);

  const negated = compareAcrossSources({
    bestCriteria: [satisfied('approval', 'Approval: approved by the review board')],
    contenderCriteria: [satisfied('approval', 'Approval: not approved by the review board')],
    contenderDocument: contender
  });
  assert.equal(negated[0].outcome, 'conflict');
  assert.equal(negated[0].rival, 'not approved');

  const same = compareAcrossSources({
    bestCriteria: [satisfied('approval', 'Approval: approved by the review board')],
    contenderCriteria: [satisfied('approval', 'Approval: signed off by the finance lead')],
    contenderDocument: contender
  });
  assert.equal(same[0].outcome, 'corroborated', 'compatible wording is agreement, not a conflict');
  assert.match(same[0].detail, /same conclusion/);

  const speculative = compareAcrossSources({
    bestCriteria: [satisfied('approval', 'Approval: approved by the review board')],
    contenderCriteria: [satisfied('approval', 'Approval: should be approved next week')],
    contenderDocument: contender
  });
  assert.equal(speculative[0].outcome, 'corroborated', 'an undecided document is not evidence against the chosen one');

  const older = compareAcrossSources({
    bestCriteria: [satisfied('approval', 'Approval: approved by the review board', { date: '2026-10-15' })],
    contenderCriteria: [satisfied('approval', 'Approval: rejected by the review board')],
    contenderDocument: contender,
    contenderDocumentDate: '2026-10-10'
  });
  assert.equal(older[0].outcome, 'superseded', 'a newer conclusion supersedes an older opposite one — that is a status change, not a conflict');

  const isolated = compareAcrossSources({
    bestCriteria: [satisfied('approval', 'Approval: approved by the review board'), satisfied('incident_stats', 'Incident count: 11')],
    contenderCriteria: [satisfied('approval', 'Approval: rejected by the review board'), satisfied('incident_stats', 'Incident count: 11')],
    contenderDocument: contender
  });
  assert.equal(isolated.length, 2);
  assert.equal(isolated.find(item => item.criterionId === 'approval').outcome, 'conflict');
  assert.equal(isolated.find(item => item.criterionId === 'incident_stats').outcome, 'corroborated', 'a conclusion about one requirement never bleeds into another');
});

test('opposite prose conclusions about the same requirement stop the work and keep both conclusions as evidence', () => {
  const { store, engine } = setup();
  engine.ingest(approvalEmail());
  engine.ingest(proposal('approved by the review board'));
  engine.ingest(serviceReview('rejected by the review board'));
  const current = task(store);
  assert.equal(current.status, 'waiting_for_information');
  assert.equal(current.assessment.complete, false);
  assert.equal(current.draft, null, 'no draft may rest on a disputed conclusion');
  assert.equal(store.state.outbox.length, 0);
  const criterion = current.evidence.criteria.find(item => item.id === 'approval');
  assert.equal(criterion.status, 'conflicting');
  assert.match(criterion.note, /opposite conclusions/);
  assert.match(criterion.note, /“approved”/);
  assert.match(criterion.note, /“rejected”/);
  assert.match(criterion.note, /Confirm which one is current/);
  assert.match(criterion.whatWouldResolveIt, /Reconcile the two documents/);
  assert.ok(criterion.evidence.some(item => item.source.id === 'zephyr-service-review'), 'the competing conclusion stays visible next to the chosen one');
  assert.deepEqual(current.verification.performed, [{
    documentId: 'zephyr-service-review', documentVersion: 1, criterionId: 'approval', outcome: 'conflict'
  }]);
  assert.ok(validateContract('verification', current.verification).ok, 'the verdict conflict is recorded in the same contract');
  assert.equal(engine.publicState().metrics.verification.sourceConflicts, 1, 'the conflict is counted from the stored record');
});

test('completed versus not completed is a contradiction; speculation and compatible wording are not', () => {
  const { store, engine } = setup();
  engine.ingest(migrationEmail());
  engine.ingest(migrationRetrospective('completed'));
  engine.ingest(migrationReview('not completed'));
  const current = task(store);
  assert.equal(current.status, 'waiting_for_information');
  const criterion = current.evidence.criteria.find(item => item.id === 'trend_assessment');
  assert.equal(criterion.status, 'conflicting');
  assert.match(criterion.note, /“completed”/);
  assert.match(criterion.note, /“not completed”/);
  assert.equal(current.verification.performed[0].outcome, 'conflict');

  const { store: agreedStore, engine: agreedEngine } = setup();
  agreedEngine.ingest(migrationEmail());
  agreedEngine.ingest(migrationRetrospective('completed'));
  agreedEngine.ingest(migrationReview('finished'));
  assert.equal(task(agreedStore).status, 'ready_for_approval', '“finished” agrees with “completed”');
  assert.equal(task(agreedStore).verification.performed[0].outcome, 'corroborated');

  const { store: uncertainStore, engine: uncertainEngine } = setup();
  uncertainEngine.ingest(migrationEmail());
  uncertainEngine.ingest(migrationRetrospective('completed'));
  uncertainEngine.ingest(migrationReview('not expected before next week'));
  const uncertain = task(uncertainStore);
  assert.equal(uncertain.status, 'ready_for_approval', 'prose that states no conclusion must not be turned into a conflict');
  assert.equal(uncertain.evidence.conflicts.length, 0);
  assert.equal(uncertain.verification.performed[0].outcome, 'corroborated');
});

test('an opposite conclusion in a different entity’s document is not conflated with this request', () => {
  const { store, engine } = setup();
  engine.ingest(approvalEmail());
  engine.ingest(proposal('approved by the review board'));
  engine.ingest(document('aurora-proposal', 'Aurora proposal', '# Aurora proposal\n\n## Approval\nApproval: rejected by the review board\n'));
  const current = task(store);
  assert.equal(current.status, 'ready_for_approval', 'another entity’s rejection says nothing about this request');
  assert.equal(current.verification.depth, 'standard', 'an uncorrelated document is not a competitor to check against');
  assert.deepEqual(current.verification.performed, []);
  assert.equal(current.evidence.conflicts.length, 0);
});

test('a newer conclusion supersedes an older opposite one, and a newer opposite conclusion still blocks', () => {
  const { store, engine } = setup();
  engine.ingest(latestApprovalEmail());
  engine.ingest(proposal('approved by the review board', '2026-10-15'));
  engine.ingest(serviceReview('rejected by the review board', '2026-10-10'));
  const superseded = task(store);
  assert.equal(superseded.status, 'ready_for_approval', 'an older rejection superseded by a newer approval is a status change, not a conflict');
  assert.equal(superseded.evidence.conflicts.length, 0);
  assert.deepEqual(superseded.verification.performed, [{
    documentId: 'zephyr-service-review', documentVersion: 1, criterionId: 'approval', outcome: 'superseded'
  }]);

  const { store: blockedStore, engine: blockedEngine } = setup();
  blockedEngine.ingest(latestApprovalEmail());
  blockedEngine.ingest(proposal('approved by the review board', '2026-10-10'));
  blockedEngine.ingest(serviceReview('rejected by the review board', '2026-10-15'));
  const blocked = task(blockedStore);
  assert.equal(blocked.status, 'waiting_for_information');
  assert.equal(blocked.verification.performed[0].outcome, 'conflict_newer_source');
  assert.match(blocked.evidence.criteria.find(item => item.id === 'approval').note, /dated later/);
});

test('a standing authorisation cannot act on a prose-conflict task either', async () => {
  const { store, engine } = setup();
  engine.recordCalibration({ key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Zephyr' } });
  // Both documents are already observed when the request arrives, so the first
  // assessment sees the conflict — the same ordering as the numeric date case.
  engine.ingest(proposal('approved by the review board'));
  engine.ingest(serviceReview('rejected by the review board'));
  engine.ingest(approvalEmail());
  await engine.whenSettled();
  const current = task(store);
  assert.equal(current.verification.depth, 'enhanced');
  assert.equal(current.status, 'waiting_for_information', 'a prose conflict cannot be executed under a grant');
  assert.equal(store.state.outbox.length, 0, 'nothing may be sent while two sources state opposite conclusions');
  assert.throws(() => engine.executePreAuthorized('request:m1'), /Task is not ready for approval/);
  assert.throws(() => engine.approve('request:m1'), /Task is not ready for approval/, 'a conflict must be resolved, not approved over');
});

test('a verdict conflict is re-evaluated when the competitor is revised, and a new divergence stops the work again', () => {
  const { store, engine } = setup();
  engine.ingest(approvalEmail());
  engine.ingest(proposal('approved by the review board'));
  engine.ingest(serviceReview('rejected by the review board'));
  assert.equal(task(store).status, 'waiting_for_information');

  engine.ingest(serviceReview('approved by the review board'));
  const resolved = task(store);
  assert.equal(resolved.status, 'ready_for_approval', 'a revision that agrees resolves the stop');
  assert.equal(resolved.evidence.conflicts.length, 0);
  assert.deepEqual(resolved.verification.performed, [{
    documentId: 'zephyr-service-review', documentVersion: 2, criterionId: 'approval', outcome: 'corroborated'
  }]);

  engine.ingest(serviceReview('rejected by the review board'));
  const diverged = task(store);
  assert.equal(diverged.status, 'waiting_for_information', 'a new explicit disagreement stops the work again');
  assert.ok(diverged.evidence.conflicts.some(item => item.id === 'conflicting:approval'));
  assert.equal(diverged.verification.performed[0].documentVersion, 3);
  assert.equal(diverged.verification.performed[0].outcome, 'conflict');
});
