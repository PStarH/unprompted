import { createHash } from 'node:crypto';

// Fixed, manually maintained regression inputs and independent expected
// decisions. Expected values are never derived from an Experience instruction
// or from the candidate effect under test. These are library guards: they
// prove the registry/arbiter contract, but they are not candidate behaviour
// evidence. Candidate-specific evidence comes only from the saved, bounded,
// user-confirmed scenario set evaluated by experience-trials.js.
export const trialCanonical = value => Array.isArray(value) ? `[${value.map(trialCanonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${trialCanonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
export const trialDigest = value => createHash('sha256').update(trialCanonical(value)).digest('hex');

export const TRIAL_FIXTURE_VERSION = 'experience-trials-2026-11-13.1';
export const TRIAL_POLICY_VERSION = 'experience-trial-policy-2026-11-13.2';
export const TRIAL_PASS_TTL_MS = 7 * 86400000;
export const TRIAL_DEADLINE_MS = 2000;
export const TRIAL_MAX_CASES = 64;
export const TRIAL_MAX_BEHAVIOR_CASES = 16;
export const TRIAL_MAX_CASE_SET_CHARS = 24000;
export const TRIAL_MAX_DIFFERENCE_CHARS = 600;
export const TRIAL_MAX_DIFFERENCES_CHARS = 24000;
export const TRIAL_SUPPORTED_EFFECTS = Object.freeze(['draft_format', 'archive_destination', 'notification_behavior', 'review_requirements', 'step_behavior']);
// A format experience keeps its existing supervised draft trial and explicit
// promote path. The other structured effects use the isolated evaluator and an
// explicit adopt action.
export const TRIAL_ADOPTABLE_EFFECTS = Object.freeze(['archive_destination', 'notification_behavior', 'review_requirements', 'step_behavior']);
export const TRIAL_CASE_SCOPE_TYPES = Object.freeze(['global', 'task_family', 'project', 'entity', 'resource']);
export const TRIAL_CASE_SOURCE_KINDS = Object.freeze(['event', 'task', 'memory', 'task_memory', 'feedback']);
export const TRIAL_CASE_CATEGORIES = Object.freeze(['guard', 'behavior', 'authorization']);
export const TRIAL_POLICY = Object.freeze({
  version: TRIAL_POLICY_VERSION,
  passTtlMs: TRIAL_PASS_TTL_MS,
  deadlineMs: TRIAL_DEADLINE_MS,
  maxCases: TRIAL_MAX_CASES,
  maxBehaviorCases: TRIAL_MAX_BEHAVIOR_CASES,
  // Readiness requires at least one actually applicable case that expects the
  // candidate's literal structured effect and observes it selected. A
  // user-precedence or negative case is supporting evidence only.
  positiveCandidateEvidence: 'required',
  candidateShadowAuthority: 'active',
  arbitrationAuthority: Object.freeze({ safety: 1, currentUser: 2, policy: 3, workflow: 4, activeExperience: 5, candidateExperience: 6, default: 7 })
});
export const TRIAL_POLICY_DIGEST = trialDigest(TRIAL_POLICY);
export const TRIAL_EMPTY_CASE_SET = Object.freeze({ version: 0, cases: Object.freeze([]) });
export const TRIAL_EMPTY_CASE_SET_DIGEST = trialDigest(TRIAL_EMPTY_CASE_SET);
export const TRIAL_CASE_SET_DIGEST = (version, cases) => trialDigest({ version, cases });

// Every registered feature is observed and fresh in this probe context so the
// evaluator can decide any valid predicate. This is a manual applicability
// oracle, not a claim about the instruction's meaning.
export const TRIAL_PROBE_FEATURES = Object.freeze({
  'event.provider': 'google', 'event.family': 'work_request', 'event.actionable': true,
  'sender.identity': 'probe@example.test', 'project.id': 'atlas', 'resource.id': 'resource-1',
  'task.family': 'work_request', 'task.priority': 3, 'task.requires_review': false,
  'task.has_deadline': false, 'user.present': true
});

// The direct user record wins at authority 2. Each baseline is deliberately a
// different concrete target/effect from the probe candidate, so the comparison
// proves precedence rather than recency or specificity.
export const TRIAL_BASELINE_EFFECTS = Object.freeze({
  draft_format: Object.freeze({ type: 'draft_format', format: 'markdown' }),
  notification_behavior: Object.freeze({ type: 'notification_behavior', mode: 'digest' }),
  review_requirements: Object.freeze({ type: 'review_requirements', required: false }),
  step_behavior: Object.freeze({ type: 'step_behavior', stepKind: 'trial_probe_step', operation: 'include' }),
  archive_destination: Object.freeze({ type: 'archive_destination', provider: 'local_files', resourceId: 'trial-other-folder' })
});

export const TRIAL_FAMILY_PROBES = Object.freeze({
  draft_format: Object.freeze([
    Object.freeze({ id: 'plain', effect: Object.freeze({ type: 'draft_format', format: 'plain' }) }),
    Object.freeze({ id: 'markdown', effect: Object.freeze({ type: 'draft_format', format: 'markdown' }) }),
    Object.freeze({ id: 'table', effect: Object.freeze({ type: 'draft_format', format: 'table' }) }),
    Object.freeze({ id: 'json', effect: Object.freeze({ type: 'draft_format', format: 'json' }) })
  ]),
  notification_behavior: Object.freeze([
    Object.freeze({ id: 'silent', effect: Object.freeze({ type: 'notification_behavior', mode: 'silent' }) }),
    Object.freeze({ id: 'digest', effect: Object.freeze({ type: 'notification_behavior', mode: 'digest' }) }),
    Object.freeze({ id: 'interactive', effect: Object.freeze({ type: 'notification_behavior', mode: 'interactive' }) })
  ]),
  review_requirements: Object.freeze([
    Object.freeze({ id: 'required-true', effect: Object.freeze({ type: 'review_requirements', required: true }) }),
    Object.freeze({ id: 'required-false', effect: Object.freeze({ type: 'review_requirements', required: false }) })
  ]),
  step_behavior: Object.freeze([
    Object.freeze({ id: 'include', effect: Object.freeze({ type: 'step_behavior', stepKind: 'trial_probe_step', operation: 'include' }) }),
    Object.freeze({ id: 'omit', effect: Object.freeze({ type: 'step_behavior', stepKind: 'trial_probe_step', operation: 'omit' }) })
  ]),
  archive_destination: Object.freeze([
    Object.freeze({ id: 'exact-target', effect: Object.freeze({ type: 'archive_destination', provider: 'local_files', resourceId: 'trial-authorized-folder' }) })
  ])
});

const genericCases = Object.freeze([
  Object.freeze({ id: 'scope-own', kind: 'scope', effects: 'all', target: 'own', expected: true }),
  Object.freeze({ id: 'scope-other', kind: 'scope', effects: 'all', target: 'other', skipForGlobal: true, expected: false }),
  Object.freeze({ id: 'candidate-predicate-observed', kind: 'candidate-predicate', effects: 'all', captureContextVersionDelta: 0, evaluateContextVersionDelta: 0, expectedKnown: true }),
  Object.freeze({ id: 'registry-eq-match', kind: 'predicate-probe', effects: 'all', predicate: Object.freeze({ op: 'eq', feature: 'event.provider', value: 'google' }), features: Object.freeze({ 'event.provider': 'google' }), expected: Object.freeze({ matched: true, known: true }) }),
  Object.freeze({ id: 'registry-stale-context', kind: 'predicate-probe', effects: 'all', predicate: Object.freeze({ op: 'eq', feature: 'event.provider', value: 'google' }), features: Object.freeze({ 'event.provider': 'google' }), captureContextVersionDelta: 0, evaluateContextVersionDelta: 1, expected: Object.freeze({ matched: false, known: false }) }),
  Object.freeze({ id: 'registry-eq-miss', kind: 'predicate-probe', effects: 'all', predicate: Object.freeze({ op: 'eq', feature: 'event.provider', value: 'google' }), features: Object.freeze({ 'event.provider': 'github' }), expected: Object.freeze({ matched: false, known: true }) }),
  Object.freeze({ id: 'registry-in-match', kind: 'predicate-probe', effects: 'all', predicate: Object.freeze({ op: 'in', feature: 'event.provider', value: Object.freeze(['google', 'microsoft']) }), features: Object.freeze({ 'event.provider': 'google' }), expected: Object.freeze({ matched: true, known: true }) }),
  Object.freeze({ id: 'registry-missing-feature', kind: 'predicate-probe', effects: 'all', predicate: Object.freeze({ op: 'eq', feature: 'sender.identity', value: 'probe@example.test' }), features: Object.freeze({}), expected: Object.freeze({ matched: false, known: false }) }),
  Object.freeze({ id: 'registry-not-unknown', kind: 'predicate-probe', effects: 'all', predicate: Object.freeze({ op: 'not', arg: Object.freeze({ op: 'eq', feature: 'sender.identity', value: 'probe@example.test' }) }), features: Object.freeze({}), expected: Object.freeze({ matched: false, known: false }) }),
  Object.freeze({ id: 'registry-gte', kind: 'predicate-probe', effects: 'all', predicate: Object.freeze({ op: 'gte', feature: 'task.priority', value: 3 }), features: Object.freeze({ 'task.priority': 5 }), expected: Object.freeze({ matched: true, known: true }) }),
  Object.freeze({ id: 'isolation-task-a', kind: 'isolation', effects: 'all', target: 'own', expected: Object.freeze({ scoped: true, known: true, winner: 'candidate' }) }),
  Object.freeze({ id: 'isolation-task-b', kind: 'isolation', effects: 'all', target: 'other', skipForGlobal: true, expected: Object.freeze({ scoped: false, known: true, winner: 'none' }) })
]);

const familyCases = Object.freeze(TRIAL_SUPPORTED_EFFECTS.flatMap(effectType => [
  ...TRIAL_FAMILY_PROBES[effectType].map(probe => Object.freeze({
    id: `family-${effectType}-${probe.id}`, kind: 'family-probe', effects: Object.freeze([effectType]),
    directiveKey: 'trial.probe.effect', effect: probe.effect, expected: Object.freeze({ winner: 'probe', effect: probe.effect })
  })),
  Object.freeze({
    id: `family-${effectType}-user-precedence`, kind: 'family-user-precedence', effects: Object.freeze([effectType]),
    directiveKey: 'trial.probe.effect', probeEffect: TRIAL_FAMILY_PROBES[effectType][0].effect, baselineEffect: TRIAL_BASELINE_EFFECTS[effectType],
    expected: Object.freeze({ winner: 'baseline', effect: TRIAL_BASELINE_EFFECTS[effectType] })
  })
]));

export const TRIAL_CASES = Object.freeze([
  ...genericCases,
  Object.freeze({ id: 'candidate-user-precedence', kind: 'candidate-user-precedence', effects: TRIAL_SUPPORTED_EFFECTS, expected: Object.freeze({ winner: 'baseline' }) }),
  ...familyCases,
  Object.freeze({ id: 'advisory-unknown', kind: 'advisory', effects: Object.freeze(['advisory']) })
]);
export const TRIAL_FIXTURE_DIGEST = trialDigest(TRIAL_CASES);

if (TRIAL_CASES.length > TRIAL_MAX_CASES) throw new Error('Experience trial fixture set exceeds its bounded case limit.');

export function trialCasesForEffect(effectType) {
  if (!TRIAL_SUPPORTED_EFFECTS.includes(effectType)) return TRIAL_CASES.filter(testCase => Array.isArray(testCase.effects) && testCase.effects.includes('advisory'));
  return TRIAL_CASES.filter(testCase => testCase.effects === 'all' || Array.isArray(testCase.effects) && testCase.effects.includes(effectType));
}
