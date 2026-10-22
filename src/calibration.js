/**
 * User calibration.
 *
 * The system works "environment first, user calibration second": it prefers to
 * learn about the user from the authorised environment, and it asks only when an
 * important goal, preference, constraint or permission is unclear **and** the
 * answer would materially change what it does.
 *
 * Two guarantees are encoded here directly:
 *
 *   1. Facts and inferences are kept apart. Every entry records where it came
 *      from (`source`) and when (`at`). Behaviour may be inferred, but a single
 *      observation is never a permanent rule: it stays a `single_observation`
 *      until it repeats consistently, and even then it is only a
 *      `working_assumption` — never `stated`.
 *   2. The user can correct the system's understanding, and a correction carries
 *      its own source, time and scope rather than silently overwriting history.
 *
 * Every entry carries a `scope` (the entity and deliverable it applies to), so
 * something learned in one part of the workspace cannot silently govern another.
 * This is the "适用范围" requirement: important information needs a source, a
 * time and a scope, or it goes stale in a way nobody can see.
 */

export const CALIBRATION_KINDS = ['goal', 'preference', 'constraint', 'permission'];
export const CALIBRATION_SOURCES = ['user_stated', 'inferred'];

/** How firmly an entry may be relied on. Only `stated` is authoritative. */
export const CONFIDENCE = {
  STATED: 'stated',
  WORKING_ASSUMPTION: 'working_assumption',
  SINGLE_OBSERVATION: 'single_observation'
};

/** Consistent observations of an inference needed before it becomes a working assumption. */
export const INFERENCE_THRESHOLD = 2;

/** Permission keys the engine knows how to use. */
export const PERMISSION_KEYS = {
  /** May the system send approved-for-scope follow-ups without a fresh click? */
  SEND_AUTOMATION: 'permission:send_automation'
};

/** Preference keys the engine knows how to use. */
export const PREFERENCE_KEYS = {
  /** How numeric dates are read: MM/DD or DD/MM. Only ever stated by the user. */
  DATE_LOCALE: 'preference:date_locale'
};

const clean = value => (value == null ? null : String(value).trim() || null);

export function normaliseScope(scope = {}) {
  return { entity: clean(scope.entity), deliverable: clean(scope.deliverable) };
}

export function scopeKey(scope = {}) {
  const normalised = normaliseScope(scope);
  return `${normalised.entity || '*'}::${normalised.deliverable || '*'}`;
}

export function calibrationId(key, scope = {}) {
  return `${key}#${scopeKey(scope)}`;
}

/**
 * Does an entry's scope cover the scope being asked about?
 *
 * A narrower entry only covers exactly what it names. A wildcard entry covers
 * anything. Scope is compared case-insensitively because entities are matched
 * that way elsewhere in the pipeline.
 */
export function scopeCovers(entryScope = {}, scope = {}) {
  const entry = normaliseScope(entryScope);
  const target = normaliseScope(scope);
  const covers = (allowed, wanted) => !allowed || !wanted || allowed.toLowerCase() === wanted.toLowerCase();
  return covers(entry.entity, target.entity) && covers(entry.deliverable, target.deliverable);
}

function store(calibrations, entry) {
  calibrations[entry.id] = entry;
  return entry;
}

/**
 * Record something the user stated. Authoritative, and it supersedes any
 * inference for the same key and scope.
 */
export function recordCalibration(calibrations, { key, kind = 'preference', value, scope = {}, at = new Date().toISOString(), note = null, origin = 'user_answer' }) {
  if (!key) throw new Error('A calibration entry requires a key');
  if (!CALIBRATION_KINDS.includes(kind)) throw new Error(`Unknown calibration kind: ${kind}`);
  if (value == null || value === '') throw new Error('A calibration entry requires a value');
  const id = calibrationId(key, scope);
  const previous = calibrations[id];
  return store(calibrations, {
    id,
    key,
    kind,
    value,
    scope: normaliseScope(scope),
    source: 'user_stated',
    confidence: CONFIDENCE.STATED,
    observations: previous?.observations || 1,
    origin,
    note,
    at: previous?.at || at,
    updatedAt: at,
    correctedAt: null
  });
}

/**
 * Correct the system's understanding of the user.
 *
 * Deliberately the same shape as a stated fact, but flagged `correctedAt` so the
 * interface and the history can show that a previous understanding was wrong
 * rather than pretending it was never held.
 */
export function correctCalibration(calibrations, { key, kind, value, scope = {}, at = new Date().toISOString(), note = null }) {
  const previous = calibrations[calibrationId(key, scope)];
  const entry = recordCalibration(calibrations, {
    key, kind: kind || previous?.kind || 'preference', value, scope, at, note, origin: 'user_correction'
  });
  entry.correctedAt = at;
  entry.previousValue = previous ? previous.value : null;
  return entry;
}

/**
 * Record a preference inferred from behaviour.
 *
 * An inference never overrides something the user stated, and one observation
 * never becomes a rule: the first observation is recorded as
 * `single_observation`, and only consistent repetition promotes it to a
 * `working_assumption`. A conflicting observation drops it back down.
 */
export function inferCalibration(calibrations, { key, kind = 'preference', value, scope = {}, at = new Date().toISOString(), note = null }) {
  if (!key) throw new Error('A calibration entry requires a key');
  const id = calibrationId(key, scope);
  const previous = calibrations[id];
  if (previous?.source === 'user_stated') return previous; // the user already answered; behaviour does not overrule it

  const consistent = previous && JSON.stringify(previous.value) === JSON.stringify(value);
  const observations = consistent ? (previous.observations || 1) + 1 : 1;
  return store(calibrations, {
    id,
    key,
    kind,
    value,
    scope: normaliseScope(scope),
    source: 'inferred',
    confidence: observations >= INFERENCE_THRESHOLD ? CONFIDENCE.WORKING_ASSUMPTION : CONFIDENCE.SINGLE_OBSERVATION,
    observations,
    origin: 'behaviour',
    note,
    at: previous?.at || at,
    updatedAt: at,
    correctedAt: null
  });
}

/** The entry that currently governs a key/scope, or null. */
export function findCalibration(calibrations, key, scope = {}) {
  return calibrations[calibrationId(key, scope)] || null;
}

/**
 * The entry the system may actually rely on for a decision.
 *
 * `stated` always qualifies. An inferred entry qualifies only once it is a
 * working assumption, and only for non-permission keys — the system never grants
 * itself an external-action permission from observed behaviour.
 */
export function usableCalibration(calibrations, key, scope = {}) {
  const entry = findCalibration(calibrations, key, scope);
  if (!entry) return null;
  if (entry.source === 'user_stated' && entry.confidence === CONFIDENCE.STATED) return entry;
  if (entry.kind === 'permission') return null;
  return entry.confidence === CONFIDENCE.WORKING_ASSUMPTION ? entry : null;
}

/**
 * A pre-authorisation grant for an external action.
 *
 * A previously authorised, clearly scoped, repeated process may
 * run without asking each time. To qualify, a grant must be (a) stated by the
 * user, (b) explicitly allowed, (c) scoped to a named entity, and (d) not since
 * corrected. Anything less falls back to asking.
 */
export function grantFor(calibrations, { key = PERMISSION_KEYS.SEND_AUTOMATION, entity, deliverable = null } = {}) {
  // A grant is matched by *coverage*, not by an identical scope string: an
  // authorisation recorded as "all Northstar work" must also cover "the Northstar
  // proposal", which is what makes a scoped standing decision usable at all.
  return Object.values(calibrations || {}).find(entry =>
    entry.key === key &&
    entry.source === 'user_stated' &&
    entry.confidence === CONFIDENCE.STATED &&
    entry.value === 'allow' &&
    Boolean(entry.scope?.entity) && // a grant must name what it covers
    scopeCovers(entry.scope, { entity, deliverable })) || null;
}

/**
 * A stated answer that settles the standing question without granting it.
 *
 * `grantFor` covers only `allow`, because only an explicit allow authorises
 * autonomous execution. A user who answers "never" or "ask me each time" has
 * answered the question the system asked; re-raising it on every sweep would
 * re-open a decision that is already settled. This finds those answers so the
 * pipeline can stop asking — and nothing here ever authorises anything.
 */
export function permissionAnswerFor(calibrations, { key = PERMISSION_KEYS.SEND_AUTOMATION, entity, deliverable = null } = {}) {
  return Object.values(calibrations || {}).find(entry =>
    entry.key === key &&
    entry.source === 'user_stated' &&
    entry.confidence === CONFIDENCE.STATED &&
    ['never', 'ask_each_time'].includes(entry.value) &&
    Boolean(entry.scope?.entity) &&
    scopeCovers(entry.scope, { entity, deliverable })) || null;
}

/**
 * Should the system ask the user about this key/scope?
 *
 * Only when it has nothing usable — and the caller is responsible for asking
 * only when the answer would materially change an action. This function answers
 * "do we already know?"; the engine answers "does it matter right now?".
 */
export function needsCalibration(calibrations, key, scope = {}) {
  return usableCalibration(calibrations, key, scope) === null;
}

/**
 * Build a calibration question.
 *
 * A question is only raised for a decision with a real consequence, so it always
 * carries what is unclear, why it matters and what each answer would change.
 */
export function calibrationQuestion({ id, key, kind, scope = {}, question, why, affects, options = [], resolvedBy = null, at = new Date().toISOString() }) {
  return {
    id: id || `calibration:${calibrationId(key, scope)}`,
    key,
    kind,
    scope: normaliseScope(scope),
    question,
    why,
    affects,
    options,
    resolvedBy,
    status: 'open',
    raisedAt: at
  };
}

export function describeCalibration(entry) {
  if (!entry) return 'nothing recorded';
  const learned = entry.source === 'user_stated' ? 'the user said so' : `inferred from ${entry.observations} observation(s)`;
  const scope = entry.scope.entity ? ` for ${entry.scope.entity}${entry.scope.deliverable ? ` ${entry.scope.deliverable}` : ''}` : ' (no scope)';
  const correction = entry.correctedAt ? ', corrected by the user' : '';
  return `${entry.key} = ${JSON.stringify(entry.value)}${scope} · ${learned} · ${entry.updatedAt}${correction}`;
}

export const calibrationApi = {
  CALIBRATION_KINDS, CALIBRATION_SOURCES, CONFIDENCE, INFERENCE_THRESHOLD, PERMISSION_KEYS, PREFERENCE_KEYS,
  normaliseScope, scopeKey, calibrationId, scopeCovers, recordCalibration, correctCalibration,
  inferCalibration, findCalibration, usableCalibration, grantFor, permissionAnswerFor, needsCalibration,
  calibrationQuestion, describeCalibration
};
