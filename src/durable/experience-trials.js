import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { FeatureRegistry, scopeMatches } from './context.js';
import {
  arbitrateExperiences, archiveAuthorization, ensureExperienceTrialSchema, experienceContentDigest, validateExperienceEffect
} from './experience.js';
import {
  TRIAL_BASELINE_EFFECTS, TRIAL_CASE_SCOPE_TYPES, TRIAL_CASE_SET_DIGEST, TRIAL_CASE_SOURCE_KINDS, TRIAL_DEADLINE_MS,
  TRIAL_EMPTY_CASE_SET_DIGEST, TRIAL_FIXTURE_DIGEST, TRIAL_FIXTURE_VERSION, TRIAL_MAX_BEHAVIOR_CASES, TRIAL_MAX_CASE_SET_CHARS,
  TRIAL_MAX_CASES, TRIAL_MAX_DIFFERENCE_CHARS, TRIAL_MAX_DIFFERENCES_CHARS, TRIAL_PASS_TTL_MS, TRIAL_POLICY, TRIAL_POLICY_DIGEST,
  TRIAL_POLICY_VERSION, TRIAL_PROBE_FEATURES, TRIAL_SUPPORTED_EFFECTS, trialCanonical, trialCasesForEffect
} from './experience-trial-fixtures.js';

const sameEffect = (left, right) => trialCanonical(left) === trialCanonical(right);
const decisionFor = (result, directiveKey) => {
  const conflict = (result.conflicts || []).find(item => item.directiveKey === directiveKey);
  if (conflict) return { kind: 'conflict', ids: conflict.ids || [] };
  const decision = (result.decisions || []).find(item => item.directiveKey === directiveKey);
  if (decision) return { kind: 'decision', recordId: decision.record.id, effect: decision.effect };
  const advisory = (result.advisory || []).find(item => (item.directiveKey || item.directive_key) === directiveKey);
  if (advisory) return { kind: 'advisory', recordId: advisory.id };
  return { kind: 'none' };
};
const winnerOf = (decision, candidateId, probeId) => decision.kind !== 'decision' ? decision.kind
  : decision.recordId === candidateId ? 'candidate' : decision.recordId === probeId ? 'probe' : 'baseline';
const ownScopes = experience => experience.scope_type === 'global' ? [] : [{ type: experience.scope_type, key: experience.scope_key }];
const otherScopes = experience => experience.scope_type === 'global' ? [] : [{
  type: experience.scope_type,
  key: experience.scope_key === '__trial_other_scope__' ? '__trial_other_scope_2__' : '__trial_other_scope__'
}];
const candidateRecord = experience => ({
  id: experience.id, status: 'active', directiveKey: experience.directive_key,
  effect: structuredClone(experience.effect), priority: experience.priority || 0, specificity: experience.specificity || 0
});
const actualOf = (result, decision, candidateId, probeId) => ({
  winner: winnerOf(decision, candidateId, probeId),
  ...(decision.kind === 'decision' ? { effect: decision.effect } : {}),
  ...(decision.kind === 'conflict' ? { ids: decision.ids } : {}),
  authorizationRequired: result.authorizationRequired === true
});
const boundary = value => {
  const text = json(value);
  return text.length <= TRIAL_MAX_DIFFERENCE_CHARS ? value : { caseId: value?.caseId || 'case', status: value?.status || 'unknown', reason: 'difference_truncated' };
};
const blankCategory = () => ({ passed: 0, failed: 0, unknown: 0, total: 0 });
const invalidCase = detail => durableError('INVALID_TRIAL_CASE', detail, 400);
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

function evaluateCase(testCase, { experience, candidate, registry, arbitrate, now, contextVersion }) {
  const effectType = experience.effect?.type || 'advisory';
  if (testCase.kind === 'advisory') return { status: 'unknown', expected: { outcome: 'unknown' }, actual: { outcome: 'unknown' }, reason: 'advisory_not_mechanically_decidable' };
  if (testCase.kind === 'scope') {
    if (testCase.skipForGlobal && experience.scope_type === 'global') return { status: 'skip' };
    const scopes = testCase.target === 'own' ? ownScopes(experience) : otherScopes(experience);
    const actual = scopeMatches(experience.scope_type, experience.scope_key, scopes);
    return { status: actual === testCase.expected ? 'pass' : 'fail', expected: { scoped: testCase.expected }, actual: { scoped: actual } };
  }
  if (testCase.kind === 'candidate-predicate') {
    const captureVersion = contextVersion + (testCase.captureContextVersionDelta || 0);
    const evaluateVersion = contextVersion + (testCase.evaluateContextVersionDelta || 0);
    const features = registry.capture(TRIAL_PROBE_FEATURES, { now, contextVersion: captureVersion });
    const actual = registry.evaluate(experience.predicate, features, { now, contextVersion: evaluateVersion });
    const pass = actual.known === testCase.expectedKnown && (testCase.expectedKnown ? typeof actual.matched === 'boolean' : true);
    return { status: pass ? 'pass' : 'fail', expected: { known: testCase.expectedKnown }, actual: { known: actual.known, matched: actual.matched } };
  }
  if (testCase.kind === 'predicate-probe') {
    const captureVersion = contextVersion + (testCase.captureContextVersionDelta || 0);
    const evaluateVersion = contextVersion + (testCase.evaluateContextVersionDelta || 0);
    const features = registry.capture(testCase.features || {}, { now, contextVersion: captureVersion });
    const actual = registry.evaluate(testCase.predicate, features, { now, contextVersion: evaluateVersion });
    const pass = actual.known === testCase.expected.known && (testCase.expected.known ? actual.matched === testCase.expected.matched : true);
    return { status: pass ? 'pass' : 'fail', expected: testCase.expected, actual: { known: actual.known, matched: actual.matched } };
  }
  if (testCase.kind === 'isolation') {
    if (testCase.skipForGlobal && experience.scope_type === 'global') return { status: 'skip' };
    const scopes = testCase.target === 'own' ? ownScopes(experience) : otherScopes(experience);
    const features = registry.capture(TRIAL_PROBE_FEATURES, { now, contextVersion });
    const predicate = registry.evaluate(experience.predicate, features, { now, contextVersion });
    const scoped = scopeMatches(experience.scope_type, experience.scope_key, scopes);
    const result = arbitrate({ experiences: scoped ? [candidate] : [] });
    const decision = decisionFor(result, experience.directive_key);
    const actual = { scoped, known: predicate.known, winner: winnerOf(decision, experience.id, null) };
    const pass = actual.scoped === testCase.expected.scoped && actual.known === testCase.expected.known && actual.winner === testCase.expected.winner
      && result.authorizationRequired === true;
    return { status: pass ? 'pass' : 'fail', expected: testCase.expected, actual };
  }
  if (testCase.kind === 'candidate-user-precedence') {
    const baseline = { id: `trial-baseline:${testCase.id}`, directiveKey: experience.directive_key, effect: structuredClone(TRIAL_BASELINE_EFFECTS[effectType]) };
    const result = arbitrate({ currentUser: [baseline], experiences: [candidate] });
    const decision = decisionFor(result, experience.directive_key);
    const actual = actualOf(result, decision, experience.id, null);
    const pass = actual.winner === 'baseline' && decision.kind === 'decision' && sameEffect(decision.effect, baseline.effect) && actual.authorizationRequired;
    return { status: pass ? 'pass' : 'fail', expected: { winner: 'baseline', effect: baseline.effect }, actual };
  }
  if (testCase.kind === 'family-probe') {
    const probe = { id: `trial-probe:${testCase.id}`, status: 'active', directiveKey: testCase.directiveKey, effect: structuredClone(testCase.effect) };
    const result = arbitrate({ experiences: [probe] });
    const decision = decisionFor(result, testCase.directiveKey);
    const actual = actualOf(result, decision, null, probe.id);
    const pass = actual.winner === 'probe' && decision.kind === 'decision' && sameEffect(decision.effect, probe.effect) && actual.authorizationRequired;
    return { status: pass ? 'pass' : 'fail', expected: testCase.expected, actual };
  }
  if (testCase.kind === 'family-user-precedence') {
    const probe = { id: `trial-probe:${testCase.id}`, status: 'active', directiveKey: testCase.directiveKey, effect: structuredClone(testCase.probeEffect) };
    const baseline = { id: `trial-baseline:${testCase.id}`, directiveKey: testCase.directiveKey, effect: structuredClone(testCase.baselineEffect) };
    const result = arbitrate({ currentUser: [baseline], experiences: [probe] });
    const decision = decisionFor(result, testCase.directiveKey);
    const actual = actualOf(result, decision, null, probe.id);
    const pass = actual.winner === 'baseline' && decision.kind === 'decision' && sameEffect(decision.effect, baseline.effect) && actual.authorizationRequired;
    return { status: pass ? 'pass' : 'fail', expected: testCase.expected, actual };
  }
  return { status: 'unknown', reason: 'unknown_fixture_case' };
}

/** A user-confirmed scenario is data, never authority. Every scope and
 * predicate is evaluated for real; only an actually applicable positive
 * scenario is compared with the arbiter, and its expected decision is the
 * literal value the user recorded. */
function evaluateBehaviorCase(testCase, { experience, registry, arbitrate, now, contextVersion }) {
  const features = registry.capture(testCase.features, { now, contextVersion });
  const predicate = registry.evaluate(experience.predicate, features, { now, contextVersion });
  const scoped = scopeMatches(experience.scope_type, experience.scope_key, testCase.scope);
  const applicable = scoped && predicate.known && predicate.matched === true;
  const actual = { scoped, known: predicate.known, matched: predicate.matched, applicable };
  const expected = testCase.expected;
  if (!applicable) {
    const result = arbitrate({ experiences: [] });
    const decision = decisionFor(result, experience.directive_key);
    actual.winner = winnerOf(decision, experience.id, null);
    const pass = expected.applies === false && expected.winner === 'none' && actual.winner === 'none';
    return { status: pass ? 'pass' : 'fail', expected, actual };
  }
  const candidate = candidateRecord(experience);
  if (expected.winner === 'user') {
    const baseline = { id: `trial-case-user:${testCase.id}`, directiveKey: experience.directive_key, effect: structuredClone(testCase.userEffect) };
    const result = arbitrate({ currentUser: [baseline], experiences: [candidate] });
    const decision = decisionFor(result, experience.directive_key);
    actual.winner = winnerOf(decision, experience.id, null);
    if (decision.kind === 'decision') actual.effect = decision.effect;
    const pass = expected.applies === true && actual.winner === 'baseline' && decision.kind === 'decision' && sameEffect(decision.effect, testCase.userEffect);
    return { status: pass ? 'pass' : 'fail', expected, actual };
  }
  const result = arbitrate({ experiences: [candidate] });
  const decision = decisionFor(result, experience.directive_key);
  actual.winner = winnerOf(decision, experience.id, null);
  if (decision.kind === 'decision') actual.effect = decision.effect;
  const positiveCandidate = expected.applies === true && expected.winner === 'candidate' && actual.winner === 'candidate'
    && decision.kind === 'decision' && sameEffect(decision.effect, expected.effect);
  actual.positiveCandidateAssertion = positiveCandidate;
  return { status: positiveCandidate ? 'pass' : 'fail', expected, actual, positiveCandidate };
}

function safeAuthorization(callback, experience) {
  let result;
  try { result = typeof callback === 'function' ? callback(experience) : archiveAuthorization(experience, null); }
  catch { return { required: true, status: 'unknown', reason: 'authorization_check_failed' }; }
  if (!result || !['authorized', 'denied', 'unknown', 'not_required'].includes(result.status)) {
    return { required: true, status: 'unknown', reason: 'authorization_check_invalid' };
  }
  if (result.required === false || result.status === 'not_required') return { required: false, status: 'not_required', reason: 'no_external_target' };
  return { required: true, status: result.status, reason: String(result.reason || '').slice(0, 120) || 'authorization_check' };
}

/** Run every fixture and every saved behaviour scenario that applies to this
 * Experience against the real arbitration and predicate paths. Nothing is
 * written and no tool, provider or authorization table is touched. A case that
 * cannot be mechanically evaluated is unknown; an exception, cancellation or
 * deadline is unknown, never a pass. Guards are counted separately and never
 * stand in for candidate behaviour. */
export function runFixtureSuite({
  experience, registry = new FeatureRegistry(), arbitrate = arbitrateExperiences, now = Date.now(), contextVersion = 0,
  signal = null, behaviorCases = [], authorization = null, deadline = null, monotonic = () => performance.now()
} = {}) {
  const effectType = experience?.effect?.type || 'advisory';
  const cases = trialCasesForEffect(effectType);
  const totalCases = cases.length + behaviorCases.length;
  if (totalCases > TRIAL_MAX_CASES) throw durableError('INVALID_TRIAL_FIXTURE', 'The Experience trial fixture set exceeds its bounded case limit.', 500);
  const counts = { passed: 0, failed: 0, unknown: 0, total: 0 };
  const categories = {
    guard: blankCategory(),
    // `applicable` counts every matched scenario (including user precedence);
    // only `positive` counts a passing candidate-effect assertion.
    behavior: { ...blankCategory(), applicable: 0, positive: 0 },
    authorization: { required: false, status: 'not_required', ...blankCategory() }
  };
  const differences = [];
  let timedOut = false;
  const deadlineReached = () => deadline != null && monotonic() >= deadline;
  const skipReason = () => signal?.aborted ? 'cancelled' : deadlineReached() ? 'deadline_exceeded' : null;
  const record = (category, testCase, outcome) => {
    if (outcome.status === 'skip') return;
    counts.total++; categories[category].total++;
    if (outcome.status === 'pass') { counts.passed++; categories[category].passed++; }
    else if (outcome.status === 'fail') { counts.failed++; categories[category].failed++; }
    else { counts.unknown++; categories[category].unknown++; }
    differences.push(boundary({ caseId: testCase?.id || category, category, status: outcome.status,
      ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
      ...(outcome.actual !== undefined ? { actual: outcome.actual } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.applicable !== undefined ? { applicable: outcome.applicable } : {}) }));
  };
  const candidate = candidateRecord(experience);
  for (const testCase of cases) {
    const reason = skipReason();
    let outcome;
    if (reason) outcome = { status: 'unknown', reason };
    else {
      try { outcome = evaluateCase(testCase, { experience, candidate, registry, arbitrate, now, contextVersion }); }
      catch (error) { outcome = { status: 'unknown', reason: 'evaluation_error', detail: String(error?.code || 'evaluation_error').slice(0, 120) }; }
      if (deadlineReached()) timedOut = true;
    }
    record('guard', testCase, outcome);
  }
  for (const testCase of behaviorCases) {
    const reason = skipReason();
    let outcome;
    if (reason) outcome = { status: 'unknown', reason };
    else {
      try { outcome = evaluateBehaviorCase(testCase, { experience, registry, arbitrate, now, contextVersion }); }
      catch (error) { outcome = { status: 'unknown', reason: 'evaluation_error', detail: String(error?.code || 'evaluation_error').slice(0, 120) }; }
      if (outcome.actual?.applicable === true) categories.behavior.applicable++;
      if (outcome.positiveCandidate === true && outcome.status === 'pass') categories.behavior.positive++;
      if (deadlineReached()) timedOut = true;
    }
    record('behavior', testCase, { ...outcome, applicable: outcome.actual?.applicable === true ? true : undefined });
  }
  if (categories.behavior.total === 0) differences.push({ caseId: 'behavior', category: 'behavior', status: 'unknown', reason: 'no_independent_behavior_case' });
  else if (categories.behavior.positive === 0 && counts.failed === 0) differences.push({ caseId: 'behavior', category: 'behavior', status: 'unknown',
    reason: categories.behavior.applicable === 0 ? 'no_applicable_positive_case' : 'no_applicable_positive_candidate_case' });
  const authorizationSkip = skipReason();
  const auth = authorizationSkip ? { required: effectType === 'archive_destination', status: 'unknown', reason: authorizationSkip }
    : safeAuthorization(authorization, experience);
  categories.authorization.required = auth.required;
  categories.authorization.status = auth.status;
  if (auth.required) {
    counts.total++; categories.authorization.total++;
    if (auth.status === 'authorized') { counts.passed++; categories.authorization.passed++; }
    else if (auth.status === 'denied') { counts.failed++; categories.authorization.failed++; }
    else { counts.unknown++; categories.authorization.unknown++; }
    differences.push({ caseId: 'archive-target', category: 'authorization', status: auth.status === 'authorized' ? 'pass' : auth.status === 'denied' ? 'fail' : 'unknown',
      expected: { authorized: true }, actual: { status: auth.status, reason: auth.reason } });
  }
  if (deadlineReached()) timedOut = true;
  if (timedOut) differences.push({ caseId: 'suite', category: 'suite', status: 'unknown', reason: 'deadline_exceeded' });
  if (signal?.aborted) differences.push({ caseId: 'suite', category: 'suite', status: 'unknown', reason: 'cancelled' });
  const behaviorReady = categories.behavior.total > 0 && categories.behavior.positive > 0
    && categories.behavior.failed === 0 && categories.behavior.unknown === 0 && categories.behavior.passed === categories.behavior.total;
  const guardsReady = categories.guard.failed === 0 && categories.guard.unknown === 0 && categories.guard.passed === categories.guard.total;
  const authorizationReady = !categories.authorization.required || categories.authorization.status === 'authorized';
  let state;
  if (counts.failed > 0) state = 'failed';
  else if (timedOut || signal?.aborted || !behaviorReady || !guardsReady || !authorizationReady) state = 'unknown';
  else state = 'passed';
  if (json(differences).length > TRIAL_MAX_DIFFERENCES_CHARS) {
    state = 'unknown';
    differences.length = 0;
    differences.push({ caseId: 'suite', status: 'unknown', reason: 'difference_limit', totalCases: counts.total });
  }
  return { state, counts, categories, differences };
}

function boundedDifferences(differences) {
  const text = json(differences);
  return text.length <= TRIAL_MAX_DIFFERENCES_CHARS ? text : json([{ caseId: 'suite', status: 'unknown', reason: 'difference_limit' }]);
}

function summaryEffective(row, { now, caseSet, experienceRevision }) {
  // A stored expired row has no historical cause column. Report the generic
  // stored state instead of inventing a TTL or a user revocation.
  if (row.state !== 'passed') return { effectiveState: row.state, effectiveReason: row.state === 'expired' ? 'stored_expired' : null };
  if (!row.expires_at || Date.parse(row.expires_at) <= now) return { effectiveState: 'expired', effectiveReason: 'pass_expired' };
  if (row.fixture_version !== TRIAL_FIXTURE_VERSION || row.fixture_digest !== TRIAL_FIXTURE_DIGEST || row.policy_digest !== TRIAL_POLICY_DIGEST) {
    return { effectiveState: 'superseded', effectiveReason: 'fixture_or_policy_changed' };
  }
  if (!(Number(parse(row.categories_json)?.behavior?.positive) >= 1)) {
    return { effectiveState: 'superseded', effectiveReason: 'positive_candidate_evidence_missing' };
  }
  if (caseSet && (row.case_set_version !== caseSet.version || row.case_set_digest !== caseSet.digest)) {
    return { effectiveState: 'superseded', effectiveReason: 'case_set_changed' };
  }
  if (experienceRevision != null && row.revision !== experienceRevision) return { effectiveState: 'superseded', effectiveReason: 'revision_changed' };
  return { effectiveState: 'passed', effectiveReason: null };
}

const trialSummary = (row, { includeDifferences = false, now = Date.now(), caseSet = null, experienceRevision = null } = {}) => row && ({
  id: row.id, state: row.state, revision: row.revision, contentDigest: row.content_digest,
  fixtureVersion: row.fixture_version, fixtureDigest: row.fixture_digest, policyDigest: row.policy_digest,
  caseSetVersion: row.case_set_version, caseSetDigest: row.case_set_digest,
  counts: { passed: row.passed_cases, failed: row.failed_cases, unknown: row.unknown_cases, total: row.total_cases },
  categories: row.categories_json ? parse(row.categories_json) : {},
  ...summaryEffective(row, { now, caseSet, experienceRevision }),
  testedRevision: row.tested_revision, adoptedRevision: row.adopted_revision, attestationOf: row.attestation_of,
  evaluatedContextVersion: row.evaluated_context_version, startedAt: row.started_at, expiresAt: row.expires_at, createdAt: row.created_at,
  ...(includeDifferences ? { differences: parse(row.differences_json) } : {})
});

/** Validate the bounded declarative scenario set. The schema is an allowlist:
 * no JavaScript, network, secret, permission, raw document, instruction or
 * client-supplied result field can reach storage. */
export function validateBehaviorCases(cases, { experience = null, experiences = null, registry = new FeatureRegistry() } = {}) {
  if (!Array.isArray(cases) || cases.length > TRIAL_MAX_BEHAVIOR_CASES) throw invalidCase('A case set needs at most 16 bounded scenarios.');
  const text = json(cases);
  if (text.length > TRIAL_MAX_CASE_SET_CHARS) throw invalidCase('The case set exceeds its bounded size.');
  const definitions = registry.describe(), ids = new Set();
  const effectFields = scope => scope && typeof scope === 'object' && !Array.isArray(scope)
    && Object.keys(scope).every(key => ['type', 'key'].includes(key));
  return cases.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !Object.keys(raw).every(key => ['id', 'scope', 'features', 'expected', 'userEffect', 'source'].includes(key))) throw invalidCase('Unknown or unsafe scenario field.');
    if (!validText(raw.id, 64) || !/^[a-z0-9][a-z0-9_-]*$/.test(raw.id) || ids.has(raw.id)) throw invalidCase('Scenario ids must be unique, short, lower-case identifiers.');
    ids.add(raw.id);
    if (!Array.isArray(raw.scope) || raw.scope.length > 4 || !raw.scope.every(scope => effectFields(scope)
      && TRIAL_CASE_SCOPE_TYPES.includes(scope.type) && validText(scope.key, 200))) throw invalidCase('A scenario scope must use known scope types and bounded keys.');
    if (!raw.features || typeof raw.features !== 'object' || Array.isArray(raw.features) || Object.keys(raw.features).length > 16) throw invalidCase('Scenario features must be a bounded object.');
    const features = Object.fromEntries(Object.entries(raw.features).map(([key, value]) => {
      const definition = definitions[key];
      if (!definition || typeof value !== definition.type || typeof value === 'number' && !Number.isFinite(value)
        || typeof value === 'string' && (!value || value.length > 200 || value.includes('\0'))) throw invalidCase('A scenario feature is unknown, mistyped or unbounded.');
      return [key, value];
    }));
    const expected = raw.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || !Object.keys(expected).every(key => ['applies', 'winner', 'effect'].includes(key))
      || typeof expected.applies !== 'boolean' || !['candidate', 'user', 'none'].includes(expected.winner)) throw invalidCase('A scenario needs a literal applies/winner/effect expectation.');
    if (expected.applies === false && expected.winner !== 'none') throw invalidCase('A non-applicable scenario must expect no winner.');
    if (expected.applies === true && expected.winner === 'none') throw invalidCase('An applicable scenario must expect a concrete decision.');
    let effect;
    if (expected.effect !== undefined) {
      if (expected.winner !== 'candidate') throw invalidCase('An expected effect belongs only to a candidate decision.');
      effect = validateExperienceEffect(expected.effect);
      if (!TRIAL_SUPPORTED_EFFECTS.includes(effect.type)) throw invalidCase('The expected effect is not mechanically supported.');
    }
    if (expected.winner === 'candidate' && !effect) throw invalidCase('A candidate decision needs the literal expected structured effect.');
    let userEffect;
    if (expected.winner === 'user') {
      userEffect = validateExperienceEffect(raw.userEffect);
      if (!TRIAL_SUPPORTED_EFFECTS.includes(userEffect.type)) throw invalidCase('The user effect is not mechanically supported.');
    } else if (raw.userEffect !== undefined) throw invalidCase('A user effect is only valid for a user-precedence expectation.');
    let source;
    if (raw.source !== undefined) {
      if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source)
        || !Object.keys(raw.source).every(key => ['kind', 'id'].includes(key))
        || !TRIAL_CASE_SOURCE_KINDS.includes(raw.source.kind) || !validText(raw.source.id, 200)) throw invalidCase('A scenario source reference must be an opaque known source.');
      if (experiences && experience) {
        const linked = experiences.db.prepare('SELECT 1 FROM lineage WHERE derived_kind=? AND derived_id=? AND source_kind=? AND source_id=?')
          .get('experience', experience.id, raw.source.kind, raw.source.id);
        const active = experiences.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=? AND active=1').get(raw.source.kind, raw.source.id);
        if (!linked || !active) throw invalidCase('A scenario source must already be an available source of this Experience.');
      }
      source = { kind: raw.source.kind, id: raw.source.id };
    }
    return Object.freeze({ id: raw.id, scope: raw.scope.map(scope => ({ type: scope.type, key: scope.key })), features,
      expected: Object.freeze({ applies: expected.applies, winner: expected.winner, ...(effect ? { effect } : {}) }),
      ...(userEffect ? { userEffect } : {}), ...(source ? { source } : {}) });
  });
}

export class ExperienceTrialService {
  constructor(database, { experiences, registry = new FeatureRegistry(), arbitrate = arbitrateExperiences, authorizationCheck = null } = {}) {
    if (!database?.db) throw new TypeError('ExperienceTrialService requires a DurableDatabase.');
    if (!experiences) throw new TypeError('ExperienceTrialService requires the ExperienceService.');
    ensureExperienceTrialSchema(database);
    this.database = database; this.db = database.db; this.experiences = experiences;
    this.registry = registry; this.arbitrate = arbitrate;
    if (authorizationCheck) this.bindAuthorizationCheck(authorizationCheck);
  }
  bindAuthorizationCheck(check) { this.experiences.bindAuthorizationCheck(check); return this; }
  describe() {
    return { fixtureVersion: TRIAL_FIXTURE_VERSION, fixtureDigest: TRIAL_FIXTURE_DIGEST, policyVersion: TRIAL_POLICY_VERSION, policyDigest: TRIAL_POLICY_DIGEST,
      passTtlMs: TRIAL_PASS_TTL_MS, deadlineMs: TRIAL_DEADLINE_MS, maxCases: TRIAL_MAX_CASES, maxBehaviorCases: TRIAL_MAX_BEHAVIOR_CASES,
      supportedEffects: TRIAL_SUPPORTED_EFFECTS, positiveCandidateEvidence: TRIAL_POLICY.positiveCandidateEvidence,
      candidateShadowAuthority: TRIAL_POLICY.candidateShadowAuthority, categories: ['guard', 'behavior', 'authorization'] };
  }
  caseSet(id) {
    const row = this.db.prepare('SELECT * FROM experience_trial_case_sets WHERE experience_id=?').get(id);
    if (!row) return { version: 0, digest: TRIAL_EMPTY_CASE_SET_DIGEST, count: 0, cases: [], createdAt: null, updatedAt: null };
    let cases;
    try {
      cases = parse(row.cases_json);
      if (!Array.isArray(cases)) throw new Error('invalid');
      validateBehaviorCases(cases, { registry: this.registry });
    } catch { return { version: row.version, digest: row.digest, count: 0, cases: [], createdAt: row.created_at, updatedAt: row.updated_at, invalid: true }; }
    return { version: row.version, digest: row.digest, count: cases.length, cases, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  caseSetSummary(id) {
    const current = this.caseSet(id);
    return { version: current.version, digest: current.digest, count: current.count, ...(current.invalid ? { invalid: true } : {}) };
  }
  saveCases(id, { expectedRevision, expectedCaseSetVersion, cases, userRequested = false } = {}) {
    if (userRequested !== true) throw durableError('CASE_SET_CONFIRMATION_REQUIRED', 'Only an explicit user confirmation can save trial scenarios.', 403);
    if (typeof id !== 'string' || !id) throw durableError('INVALID_EXPERIENCE_ID', 'A valid Experience id is required.', 400);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw durableError('INVALID_EXPERIENCE_REVISION', 'An exact Experience revision is required.', 400);
    if (!Number.isInteger(expectedCaseSetVersion) || expectedCaseSetVersion < 0) throw durableError('INVALID_CASE_SET_VERSION', 'An exact case-set version is required.', 400);
    return this.database.atomic(() => {
      const experience = this.experiences.get(id);
      if (!experience) throw durableError('EXPERIENCE_NOT_FOUND', 'This Experience no longer exists.', 404);
      if (experience.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      if (experience.status === 'retired') throw durableError('EXPERIENCE_UNAVAILABLE', 'A retired Experience cannot receive trial scenarios.', 409);
      const current = this.caseSet(id);
      if (current.version !== expectedCaseSetVersion) throw durableError('CASE_SET_CHANGED', 'The saved scenario set has changed. Reload before saving.', 409);
      const validated = validateBehaviorCases(cases, { experience, experiences: this.experiences, registry: this.registry });
      const version = current.version + 1, digest = TRIAL_CASE_SET_DIGEST(version, validated), at = iso(this.database.now());
      this.db.prepare(`INSERT INTO experience_trial_case_sets(experience_id,version,digest,cases_json,created_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(experience_id) DO UPDATE SET version=excluded.version,digest=excluded.digest,cases_json=excluded.cases_json,updated_at=excluded.updated_at`)
        .run(id, version, digest, json(validated), current.createdAt || at, at);
      // A changed case set invalidates prior passes and attestations at once.
      this.db.prepare("UPDATE experience_trials SET state='expired' WHERE experience_id=? AND state='passed'").run(id);
      this.database.bump('context_version');
      return { version, digest, count: validated.length, cases: validated, createdAt: current.createdAt || at, updatedAt: at };
    });
  }
  latest(id, options = {}) {
    const experienceRevision = options.experienceRevision ?? this.experiences.get(id)?.revision ?? null;
    return this.summary(this.db.prepare('SELECT * FROM experience_trials WHERE experience_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id), id,
      { ...options, experienceRevision });
  }
  list(id, { limit = 8, includeDifferences = false, ...options } = {}) {
    const bounded = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 8));
    const experienceRevision = options.experienceRevision ?? this.experiences.get(id)?.revision ?? null;
    return this.db.prepare('SELECT * FROM experience_trials WHERE experience_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(id, bounded)
      .map(row => this.summary(row, id, { includeDifferences, ...options, experienceRevision }));
  }
  summary(row, id, { includeDifferences = false, now = this.database.now(), caseSet = null, experienceRevision = null } = {}) {
    return row ? trialSummary(row, { includeDifferences, now, caseSet: caseSet || this.caseSet(id), experienceRevision }) : null;
  }
  evaluate(id, { expectedRevision, signal = null, deadline = null, monotonic = () => performance.now() } = {}) {
    if (typeof id !== 'string' || !id) throw durableError('INVALID_EXPERIENCE_ID', 'A valid Experience id is required.', 400);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw durableError('INVALID_EXPERIENCE_REVISION', 'An exact Experience revision is required.', 400);
    return this.database.atomic(() => {
      const experience = this.experiences.get(id);
      if (!experience) throw durableError('EXPERIENCE_NOT_FOUND', 'This Experience no longer exists.', 404);
      if (experience.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      if (!['active', 'candidate'].includes(experience.status)) throw durableError('EXPERIENCE_UNAVAILABLE', 'Only an active or candidate Experience can be evaluated.');
      const now = this.database.now(), startedAt = iso(now);
      if (experience.valid_until && !(Date.parse(experience.valid_until) > now)) throw durableError('EXPERIENCE_EXPIRED', 'This Experience has expired and cannot be evaluated.');
      const contentDigest = experienceContentDigest(experience), latest = this.experiences.latestContentVersion(id);
      const contextVersion = Number(this.database.get('context_version'));
      const caseSet = this.caseSet(id);
      const empty = reason => ({
        state: 'unknown', counts: { passed: 0, failed: 0, unknown: 1, total: 1 },
        categories: { guard: blankCategory(), behavior: { ...blankCategory(), applicable: 0, positive: 0 },
          authorization: { required: experience.effect?.type === 'archive_destination', status: 'unknown', ...blankCategory() } },
        differences: [{ caseId: reason === 'content_not_versioned' ? 'version' : 'provenance', status: 'unknown', reason }]
      });
      let outcome;
      if (this.experiences.sourceUnavailable(id)) outcome = empty('source_unavailable');
      else if (this.experiences.sourceRevoked(id)) outcome = empty('source_revoked');
      else if (!latest || latest.revision !== experience.revision || latest.content_digest !== contentDigest) outcome = empty('content_not_versioned');
      else if (caseSet.invalid) outcome = empty('invalid_case_set');
      else outcome = runFixtureSuite({ experience, registry: this.registry, arbitrate: this.arbitrate, now, contextVersion, signal,
        behaviorCases: caseSet.cases, authorization: record => this.experiences.authorizationFor(record),
        deadline: deadline ?? monotonic() + TRIAL_DEADLINE_MS, monotonic });
      let state = outcome.state;
      let expiresAt = null;
      if (state === 'passed') {
        const validUntil = experience.valid_until ? Date.parse(experience.valid_until) : Number.POSITIVE_INFINITY;
        expiresAt = iso(Math.min(now + TRIAL_PASS_TTL_MS, validUntil));
        if (!(Date.parse(expiresAt) > now)) { state = 'unknown'; expiresAt = null; }
      }
      const trialId = randomUUID(), at = iso(this.database.now());
      this.db.prepare(`INSERT INTO experience_trials(id,experience_id,revision,content_digest,fixture_version,fixture_digest,policy_digest,scope_type,scope_key,
        state,passed_cases,failed_cases,unknown_cases,total_cases,differences_json,tested_revision,adopted_revision,attestation_of,evaluated_context_version,
        case_set_version,case_set_digest,categories_json,started_at,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?)`).run(trialId, id, experience.revision, contentDigest, TRIAL_FIXTURE_VERSION,
        TRIAL_FIXTURE_DIGEST, TRIAL_POLICY_DIGEST, experience.scope_type, experience.scope_key, state, outcome.counts.passed, outcome.counts.failed,
        outcome.counts.unknown, outcome.counts.total, boundedDifferences(outcome.differences), experience.revision,
        contextVersion, caseSet.version, caseSet.digest, json(outcome.categories || {}), startedAt, expiresAt, at);
      this.database.lineage('experience', id, 'experience_trial', trialId);
      if (state === 'passed') this.database.bump('context_version');
      return this.summary(this.db.prepare('SELECT * FROM experience_trials WHERE id=?').get(trialId), id, { caseSet, now: this.database.now(), experienceRevision: experience.revision });
    });
  }
}
