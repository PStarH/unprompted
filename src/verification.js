/**
 * Verification depth — how much checking a candidate action warrants, and what
 * was actually done about it.
 *
 * Verification effort should match the risk of the action. Low-risk work backed
 * by one directly relevant source
 * must not be pushed through redundant checks; a request that a second
 * plausible document could also satisfy needs its competing version of the
 * facts checked independently, and needs a deliberate approval before anything
 * external happens.
 *
 * Because correlation never looks at document *content* to decide which of two
 * plausible documents is right, a clearly-winning document currently lets a
 * competing plausible source go unchecked. These functions close that gap:
 *
 *   chooseVerificationDepth  picks the depth from the current evidence state
 *   compareAcrossSources     re-runs the same probes on a competing document and
 *                            reports corroboration, disagreement or an older
 *                            reading (superseded by the newer document's date),
 *                            for numeric readings and for explicit prose
 *                            conclusions alike (approved/rejected, completed/
 *                            not completed)
 *   applySourceConflicts     downgrades a criterion that two plausible sources
 *                            disagree about, so completion stops with a reason
 *
 * Nothing here fabricates or counts anything: every `performed` entry
 * corresponds to one real probe run against one real document, and the depth is
 * recomputed from current state on every assessment, so new evidence can raise
 * or lower it.
 */
import { criterion, evidenceItem } from './evidence.js';

export const VERIFICATION_DEPTHS = ['standard', 'enhanced'];

/** How many competing documents are checked. Beyond this the marginal value is
 * low and the cost is not: two independent checks are enough to corroborate or
 * contradict the chosen reading. */
export const CROSS_CHECK_LIMIT = 2;

/** Every outcome a cross-source check can record — the vocabulary a stored
 * `task.verification` is validated against, so a renamed outcome cannot slip
 * through silently. */
export const VERIFICATION_OUTCOMES = [
  'corroborated',
  'conflict',
  'conflict_newer_source',
  'superseded',
  'internal_conflict',
  'no_additional_evidence'
];

// Probe ids that report *when* a document speaks, not *what it says*. Two
// documents with different dates are not in conflict; comparing them as values
// would be a false alarm.
const META_CRITERIA = new Set(['as_of_date', 'run_date']);

/**
 * Choose how much verification this candidate needs, from the state that exists
 * right now.
 *
 *   standard  one document has an identity link; the baseline checks are the
 *             verification and nothing extra runs.
 *   enhanced  a second plausible document exists, or the match itself is
 *             ambiguous. Either way, no standing authorisation may act on this
 *             task: only an explicit approval can.
 */
export function chooseVerificationDepth({ ranked = [], ambiguous = false } = {}) {
  const competing = ranked.slice(1, 1 + CROSS_CHECK_LIMIT);
  if (ambiguous) {
    return {
      depth: 'enhanced',
      basis: [{
        code: 'ambiguous_sources',
        detail: `${ranked.length} documents match this request equally well (${ranked.map(entry => entry.document.id).join(', ')}); nothing may proceed until one can be established.`
      }],
      crossCheck: []
    };
  }
  if (competing.length) {
    return {
      depth: 'enhanced',
      basis: [
        {
          code: 'competing_sources',
          detail: `${competing.length} other plausible document(s) exist (${competing.map(entry => entry.document.id).join(', ')}); their version of the requested facts is checked independently.`
        },
        {
          code: 'approval_required',
          detail: 'A second source could contradict the chosen document, so a standing authorisation is not enough here: this action needs an explicit approval.'
        }
      ],
      crossCheck: competing
    };
  }
  return {
    depth: 'standard',
    basis: [{
      code: 'single_source',
      detail: 'One document has an identity link to this request; the baseline checks are the verification, and no additional source check is warranted.'
    }],
    crossCheck: []
  };
}

const DATE_LIKE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}/g;

/**
 * The number an excerpt reports, if it reports a plain value.
 *
 * Date-like tokens are removed first: a document's own date is freshness
 * evidence, not a value that can "disagree" with another document's date. When
 * nothing comparable remains, `null` is returned and the comparison falls back
 * to presence (both sources state the same content).
 */
export function comparableReading(text) {
  const stripped = String(text || '').replace(DATE_LIKE, ' ');
  const numbers = stripped.match(/-?\d[\d,]*(?:\.\d+)?(?:\s*%)?/g);
  if (!numbers || !numbers.length) return null;
  const raw = numbers[numbers.length - 1].trim();
  const value = Number(raw.replace(/[,\s%]/g, ''));
  return Number.isFinite(value) ? { raw, value } : null;
}

/**
 * Explicit prose conclusions.
 *
 * Some requirements are settled by words rather than numbers: a request is
 * approved or rejected, work is completed or not. Only *state* forms are
 * listed — "to approve" is a plan and "approves" a habit, and neither settles
 * the question. Words that double as something else ("passed" a deadline,
 * "failed" a disk, "done" as an exclamation) are deliberately absent: a
 * misread verdict would fabricate a conflict, which is worse than missing one.
 */
const VERDICT_POSITIVE = /\b(approved|approves|accepted|accepts|completed|finished|resolved|confirmed|confirms|signed)\b/gi;
const VERDICT_NEGATIVE = /\b(rejected|rejects|declined|declines|denied|denies|refused|refuses|incomplete|uncompleted|unfinished|unresolved|unconfirmed|unapproved|unsigned|withdrawn)\b/gi;

/** Words that make a nearby conclusion open or attributed rather than stated:
 * "whether it was approved", "reportedly approved", "when approved" may follow
 * later. Modals are checked separately as modal + be/have ("should be
 * approved") so that a month name — "approved in May" — cannot gate a real
 * conclusion. */
const VERDICT_UNCERTAIN = /\b(whether|if|unless|until|once|when|whenever|pending|await(?:s|ed|ing)?|considers?|considered|recommends?|recommended|reportedly|allegedly|apparently)\b/i;
const VERDICT_MODAL_BE = /\b(?:should|could|would|might|can|will|shall|must|may)\b(?:\s+\w+){0,2}\s+(?:be|have)\b/i;
/** "to be approved" — the future passive states an intention, not an outcome. */
const VERDICT_FUTURE_PASSIVE = /\bto\s+be$/i;

/** Negations that flip a stated conclusion ("not approved", "hasn't been
 * signed", "yet to be confirmed"). "not only"/"not just" are rhetorical and
 * must not flip anything. */
const VERDICT_NEGATION = /\b(?:not(?!\s+(?:only|just))|never|no\s+longer|yet\s+to|isn'?t|aren'?t|wasn'?t|weren'?t|hasn'?t|haven'?t|hadn'?t|doesn'?t|don'?t|didn'?t|won'?t|wouldn'?t|cannot|can'?t|couldn'?t|shouldn'?t)\b/i;

/** The clause the verdict word sits in — text since the last sentence
 * boundary, capped so an unrelated modal far earlier cannot gate it. */
function verdictClause(source, index) {
  const before = source.slice(0, index);
  const boundary = Math.max(
    before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(':'),
    before.lastIndexOf('?'), before.lastIndexOf('!'), before.lastIndexOf('\n')
  );
  return before.slice(boundary + 1).slice(-90);
}

/**
 * The explicit conclusion an excerpt states, if it states exactly one.
 *
 * Returns `{ polarity, raw }` — 1 for a positive conclusion, -1 for its
 * negation or an explicitly negative word — or `null` when the excerpt does
 * not conclude anything: no verdict word, a hypothetical or future one
 * ("should be approved", "to be approved", "awaiting sign-off"), a double
 * negative ("not rejected"), or more than one conclusion of different
 * polarity ("rejected in May but approved in June"). `null` means *unknown*,
 * and unknown never becomes a conflict.
 */
export function comparableVerdict(text) {
  const source = String(text || '');
  if (!source) return null;
  const found = [];
  const usable = clause => {
    if (VERDICT_UNCERTAIN.test(clause) || VERDICT_MODAL_BE.test(clause)) return false;
    return !(VERDICT_FUTURE_PASSIVE.test(clause.trim()) && !VERDICT_NEGATION.test(clause));
  };
  for (const match of source.matchAll(VERDICT_NEGATIVE)) {
    const clause = verdictClause(source, match.index);
    if (!usable(clause) || VERDICT_NEGATION.test(clause)) continue; // "not rejected" concludes nothing
    found.push({ polarity: -1, raw: match[0] });
  }
  for (const match of source.matchAll(VERDICT_POSITIVE)) {
    const clause = verdictClause(source, match.index);
    if (!usable(clause)) continue;
    const negated = VERDICT_NEGATION.test(clause);
    found.push({ polarity: negated ? -1 : 1, raw: negated ? `not ${match[0]}` : match[0] });
  }
  if (!found.length) return null;
  if (new Set(found.map(item => item.polarity)).size > 1) return null; // more than one conclusion
  return { polarity: found[0].polarity, raw: found[0].raw };
}

/**
 * Compare the chosen document's satisfied readings with what the same probes
 * find in a competing document.
 *
 * Outcomes per criterion:
 *   corroborated          both sources state the same value, the same explicit
 *                         conclusion, or the same content with no parseable
 *                         reading — independent confirmation
 *   conflict              both state different readings or opposite conclusions,
 *                         and neither source's date establishes which is newer —
 *                         completion must stop
 *   conflict_newer_source the competing document is dated later and disagrees —
 *                         completion must stop
 *   superseded            the competing document's differing reading is older
 *                         than the chosen document's — recorded, not blocking
 *   internal_conflict     the competing document contradicts itself on the point
 *   no_additional_evidence the competing document has no verifiable reading
 *
 * `not_satisfied` is skipped: a source that simply does not mention the content
 * is not evidence against it.
 */
export function compareAcrossSources({
  bestCriteria = [],
  contenderCriteria = [],
  contenderDocument = null,
  bestDocumentDate = null,
  contenderDocumentDate = null
}) {
  const byId = new Map(contenderCriteria.map(item => [item.id, item]));
  const contender = {
    id: contenderDocument?.id || 'unknown',
    title: contenderDocument?.title || contenderDocument?.id || 'the other document',
    version: contenderDocument?.version ?? null,
    modifiedAt: contenderDocument?.modifiedAt ?? null,
    url: contenderDocument?.url ?? null
  };
  const results = [];
  for (const reading of bestCriteria) {
    if (reading.status !== 'satisfied' || META_CRITERIA.has(reading.id)) continue;
    const other = byId.get(reading.id);
    if (!other || other.status === 'not_satisfied') continue;
    const label = reading.label || reading.id;
    if (other.status === 'conflicting') {
      results.push({
        criterionId: reading.id, label, contender, outcome: 'internal_conflict',
        detail: `“${label}”: the other plausible document ${contender.id} contradicts itself on this point.`
      });
      continue;
    }
    if (other.status !== 'satisfied') {
      results.push({
        criterionId: reading.id, label, contender, outcome: 'no_additional_evidence',
        detail: `“${label}”: the other plausible document ${contender.id} has no verifiable ${label.toLowerCase()} to compare.`
      });
      continue;
    }
    const chosenExcerpt = reading.evidence?.[0]?.excerpt ?? null;
    const rivalExcerpt = other.evidence?.[0]?.excerpt ?? null;
    const chosen = comparableReading(chosenExcerpt);
    const rival = comparableReading(rivalExcerpt);
    // A disagreement's meaning depends on time: when the two dates differ, the
    // newer document decides, and an older contrary reading is recorded as
    // superseded. Equal dates — or none, which leaves the sources no way to be
    // temporally distinguished — are the same moment: a disagreement there
    // cannot be averaged away, and completion must stop.
    const chosenDate = reading.date || bestDocumentDate || null;
    const rivalDate = other.date || contenderDocumentDate || null;
    const chronology = () => {
      if (chosenDate && rivalDate && String(chosenDate) !== String(rivalDate)) {
        return String(chosenDate) > String(rivalDate) ? 'superseded' : 'conflict_newer_source';
      }
      return 'conflict';
    };

    if (chosen && rival && chosen.value !== rival.value) {
      const outcome = chronology();
      if (outcome === 'superseded') {
        results.push({
          criterionId: reading.id, label, contender, outcome,
          chosen: chosen.raw, rival: rival.raw, chosenDate, rivalDate,
          detail: `“${label}”: ${contender.id} reports “${rival.raw}” as of ${rivalDate}; the chosen document is newer (${chosenDate}), so that reading is superseded.`
        });
        continue;
      }
      if (outcome === 'conflict_newer_source') {
        results.push({
          criterionId: reading.id, label, contender, outcome,
          chosen: chosen.raw, rival: rival.raw, chosenDate, rivalDate,
          contendingExcerpt: rivalExcerpt,
          detail: `“${label}”: ${contender.id} is dated later (${rivalDate} vs ${chosenDate}) and reports “${rival.raw}” where the chosen document says “${chosen.raw}”. Confirm which document is current.`
        });
        continue;
      }
      results.push({
        criterionId: reading.id, label, contender, outcome: 'conflict',
        chosen: chosen.raw, rival: rival.raw, chosenDate, rivalDate,
        contendingExcerpt: rivalExcerpt,
        detail: `“${label}”: two plausible documents disagree — “${chosen.raw}” in the chosen document, “${rival.raw}” in ${contender.id}${chosenDate ? ` (both as of ${chosenDate})` : ''}. Confirm which one is current.`
      });
      continue;
    }

    // Nothing numeric to compare — but the two documents may still state
    // explicit, mutually exclusive conclusions about this requirement: one
    // approved where the other rejected, one completed where the other did not.
    // Only conclusions that normalize unambiguously are compared; anything
    // vaguer keeps its uncertainty rather than becoming agreement or conflict.
    const chosenVerdict = comparableVerdict(chosenExcerpt);
    const rivalVerdict = comparableVerdict(rivalExcerpt);
    if (chosenVerdict && rivalVerdict && chosenVerdict.polarity !== rivalVerdict.polarity) {
      const outcome = chronology();
      if (outcome === 'superseded') {
        results.push({
          criterionId: reading.id, label, contender, outcome,
          chosen: chosenVerdict.raw, rival: rivalVerdict.raw, chosenDate, rivalDate,
          detail: `“${label}”: ${contender.id} concludes “${rivalVerdict.raw}” as of ${rivalDate}; the chosen document is newer (${chosenDate}) with “${chosenVerdict.raw}”, so that conclusion is superseded.`
        });
        continue;
      }
      if (outcome === 'conflict_newer_source') {
        results.push({
          criterionId: reading.id, label, contender, outcome,
          chosen: chosenVerdict.raw, rival: rivalVerdict.raw, chosenDate, rivalDate,
          contendingExcerpt: rivalExcerpt,
          detail: `“${label}”: ${contender.id} is dated later (${rivalDate} vs ${chosenDate}) and concludes “${rivalVerdict.raw}” where the chosen document concludes “${chosenVerdict.raw}”. Confirm which document is current.`
        });
        continue;
      }
      results.push({
        criterionId: reading.id, label, contender, outcome: 'conflict',
        chosen: chosenVerdict.raw, rival: rivalVerdict.raw, chosenDate, rivalDate,
        contendingExcerpt: rivalExcerpt,
        detail: `“${label}”: two plausible documents state opposite conclusions — “${chosenVerdict.raw}” in the chosen document, “${rivalVerdict.raw}” in ${contender.id}${chosenDate ? ` (both as of ${chosenDate})` : ''}. Confirm which one is current.`
      });
      continue;
    }
    if (chosenVerdict && rivalVerdict) {
      results.push({
        criterionId: reading.id, label, contender, outcome: 'corroborated',
        detail: `“${label}”: ${contender.id} independently states the same conclusion (“${rivalVerdict.raw}”).`
      });
      continue;
    }
    results.push({
      criterionId: reading.id, label, contender, outcome: 'corroborated',
      detail: `“${label}”: ${contender.id} independently states ${rival ? `the same value (“${rival.raw}”)` : 'the same content'}.`
    });
  }
  return results;
}

/**
 * Downgrade every criterion that two plausible sources disagree about to
 * `conflicting`, keeping the chosen document's evidence and adding the
 * competing excerpt. The existing completion rules then stop the task with a
 * readable reason instead of letting one of the two readings through.
 */
export function applySourceConflicts(criteria, results) {
  const blocking = (results || []).filter(result => result.outcome === 'conflict' || result.outcome === 'conflict_newer_source');
  if (!blocking.length) return criteria;
  return criteria.map(item => {
    const hit = blocking.find(result => result.criterionId === item.id);
    if (!hit) return item;
    const evidence = [...(item.evidence || [])];
    if (hit.contendingExcerpt != null) {
      evidence.push(evidenceItem({
        source: {
          kind: 'document',
          id: hit.contender.id,
          version: hit.contender.version,
          timestamp: hit.contender.modifiedAt,
          url: hit.contender.url,
          locator: null
        },
        excerptText: hit.contendingExcerpt,
        detail: `This plausible document reports “${hit.rival}”.`,
        strength: 'direct'
      }));
    }
    return criterion({
      ...item,
      status: 'conflicting',
      note: hit.detail,
      evidence,
      whatWouldResolveIt: 'Reconcile the two documents, or confirm which one applies to this request.'
    });
  });
}

export const verificationApi = {
  VERIFICATION_DEPTHS,
  VERIFICATION_OUTCOMES,
  CROSS_CHECK_LIMIT,
  chooseVerificationDepth,
  comparableReading,
  comparableVerdict,
  compareAcrossSources,
  applySourceConflicts
};
