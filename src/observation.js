import { createHash } from 'node:crypto';

/**
 * Phase 0: deterministic, read-only failure observation.
 *
 * This module answers exactly one question about existing event data: does the
 * content of an authorized event state a failure, and on what evidence? It is a
 * pure derivation — it reads state and returns a report; it writes nothing, and
 * it deliberately runs nowhere in the server yet.
 *
 * What it does NOT do, by design (Phase 0 boundary):
 * - no candidate generation, no root-cause merging, no handoff, no tasks,
 *   notifications or clarifications, no user-visible surface;
 * - no persistence of any kind, including history entries: every observation
 *   is recomputable from state.events plus the rule version below;
 * - no relevance and no value/risk judgment. Source-access authorization is the
 *   one gate implemented here, and it is decided by the event's connector
 *   source only — never by the sender address or project association. An
 *   empty `authorizedSources` is fail-closed: nothing is read at all.
 *
 * A single event is enough for an observation; recurrence is reported only as a
 * raw signature count and is never a prerequisite. A signature is a stable
 * fingerprint of the matched evidence (markers + captured specifics); it is a
 * hint for a later, evidenced analysis, not a claim that two events share one
 * root cause.
 *
 * The rule reads `payload.subject` and `payload.body`, which the engine retains
 * on every stored email event (`state.events` holds the full event; only the
 * public API strips payloads). Events without readable content are counted, not
 * guessed at.
 */

export const FAILURE_RULE = Object.freeze({ id: 'failure-report', version: 1 });

/**
 * Failure markers, tried in this declaration order; the first un-suppressed
 * match per marker, per field (subject before body), becomes one piece of
 * evidence. Patterns describe failure content in general — failure statements,
 * error details, exit codes — never a particular source system, and each
 * capture feeds the evidence fingerprint.
 */
const FAILURE_MARKERS = [
  { id: 'states-failure', pattern: '\\bfailed\\b', describe: 'states that something failed' },
  { id: 'states-crash', pattern: '\\bcrash(?:ed|es)?\\b', describe: 'states a crash' },
  { id: 'error-detail', pattern: '\\berror:\\s*([^.\\n]{1,120})', capture: 1, describe: 'carries an explicit error detail' },
  { id: 'exit-code', pattern: '\\bexit code (\\d+)\\b', capture: 1, describe: 'reports a process exit code' },
  { id: 'missing-module', pattern: '\\bcannot find module\\s+[\'"`]?([^\\s\'"`]+)', capture: 1, describe: 'names a module that could not be found' },
  { id: 'permission-denied', pattern: '\\bpermission denied\\b', describe: 'reports a permission denial' }
];

/**
 * Success-summary guard: "0 failed", "no tests failed", "not failed" describe
 * the absence of failure, so such a match is skipped rather than observed.
 */
function isSuppressed(content, index) {
  const before = content.slice(Math.max(0, index - 16), index);
  return /\b(?:0|zero|no|not)\s+(?:\S+\s+)?$/i.test(before);
}

/** First un-suppressed occurrence of a marker pattern, or null. */
function firstUnscreened(content, patternSource) {
  const pattern = new RegExp(patternSource, 'gi');
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (!isSuppressed(content, match.index)) return match;
    if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
  }
  return null;
}

/** A bounded, whitespace-normalised window around the match, for the evidence. */
function excerptAround(content, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + length + 60);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function collectEvidence(subject, body) {
  const evidence = [];
  for (const marker of FAILURE_MARKERS) {
    for (const [field, content] of [['subject', subject], ['body', body]]) {
      if (!content) continue;
      const match = firstUnscreened(content, marker.pattern);
      if (!match) continue;
      evidence.push({
        marker: marker.id,
        basis: marker.describe,
        field,
        match: match[0],
        excerpt: excerptAround(content, match.index, match[0].length),
        captured: marker.capture ? String(match[marker.capture] ?? '').trim() || null : null
      });
      break;
    }
  }
  return evidence;
}

/** Stable fingerprint over the evidence discriminators — never over event ids. */
function failureFingerprint({ markers, captured }) {
  const canonical = JSON.stringify({ family: FAILURE_RULE.id, version: FAILURE_RULE.version, markers, captured });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derive failure observations from the events already held in state.
 *
 * `authorizedSources` is the set of connector sources whose content this
 * observation layer is allowed to read; it must come from source-access
 * authorization, not from anything in the individual message. Returns a report:
 * counts, per-event observations with provenance and evidence, and a raw
 * signature count for later analysis. Pure and deterministic: same state and
 * rule version, same report.
 */
export function observeFailureSignals(state, { authorizedSources = [] } = {}) {
  const authorized = new Set(authorizedSources);
  const observations = [];
  const counts = { unauthorized: 0, notEmail: 0, unreadable: 0, nonFailure: 0 };
  for (const event of Array.isArray(state?.events) ? state.events : []) {
    if (event?.type !== 'email.received') {
      counts.notEmail += 1;
      continue;
    }
    if (!authorized.has(event.source)) {
      counts.unauthorized += 1;
      continue;
    }
    const subject = typeof event.payload?.subject === 'string' ? event.payload.subject : '';
    const body = typeof event.payload?.body === 'string' ? event.payload.body : '';
    if (!subject && !body) {
      counts.unreadable += 1;
      continue;
    }
    const evidence = collectEvidence(subject, body);
    if (!evidence.length) {
      counts.nonFailure += 1;
      continue;
    }
    const discriminators = {
      markers: evidence.map(item => item.marker),
      captured: evidence.filter(item => item.captured).map(item => `${item.marker}=${item.captured}`).sort()
    };
    observations.push({
      family: FAILURE_RULE.id,
      ruleVersion: FAILURE_RULE.version,
      eventRef: {
        id: event.id,
        type: event.type,
        at: event.at,
        source: event.source,
        connectorId: event.connectorId ?? null
      },
      evidence,
      discriminators,
      signature: failureFingerprint(discriminators)
    });
  }
  const signatureCounts = {};
  for (const observation of observations) {
    signatureCounts[observation.signature] = (signatureCounts[observation.signature] || 0) + 1;
  }
  return { rule: FAILURE_RULE.id, ruleVersion: FAILURE_RULE.version, counts, observations, signatureCounts };
}
