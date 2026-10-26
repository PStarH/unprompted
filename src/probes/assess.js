import { criterion, evidenceItem } from '../evidence.js';
import { PROBES } from './builtin.js';
import { searchProvider, hitToEvidence, ProviderUnavailableError, QUERY_BOUNDS } from './providers.js';
import { DEFAULT_BOUNDS } from './strategies.js';

/**
 * Spec-driven assessment.
 *
 * Executes a probe plan and produces one criterion per probe, each with an
 * explicit state:
 *
 *   satisfied     - direct evidence found
 *   unknown       - only indicative evidence found; a mention is not the content
 *   not_satisfied - the concept was searched for and is not present
 *   blocked       - the evidence source is unavailable, so nothing is claimed
 *   conflicting   - evidence contradicts itself
 *
 * Completion is derived from these states, never from a keyword sweep. Only
 * `satisfied` counts toward completion, so a weak hit can never justify an
 * outbound action on its own.
 */

export const CRITERION_STATES = ['satisfied', 'unknown', 'not_satisfied', 'blocked', 'conflicting'];

const BOUNDS = { ...DEFAULT_BOUNDS, ...QUERY_BOUNDS };

/** Run the built-in probe for a spec that names one. */
function runBuiltin(spec, document) {
  const probe = PROBES[spec.builtinProbe];
  if (!probe) return null;
  const found = probe.find(document.content || '');
  if (!found) return null;
  return {
    matched: true,
    strength: 'direct',
    strategy: 'builtin',
    excerpt: found.value,
    detail: spec.criterionLabel,
    source: {
      kind: 'document', id: document.id, version: document.version ?? null,
      timestamp: document.modifiedAt ?? null, url: document.url ?? null, locator: null
    }
  };
}

/**
 * Execute one probe spec.
 * Returns { state, evidence, note, strength } — never throws for an unavailable
 * provider, because "cannot check" must not look like "checked and absent".
 */
export function executeSpec(spec, context) {
  try {
    if (spec.builtinProbe) {
      const document = (context.documents || [])[0];
      if (!document) {
        return { state: 'blocked', evidence: [], note: 'No correlated document is available to check.' };
      }
      const hit = runBuiltin(spec, document);
      if (!hit) return { state: 'not_satisfied', evidence: [], note: `Searched the document; no ${spec.criterionLabel.toLowerCase()} found.` };
      return { state: 'satisfied', evidence: [hitToEvidence(hit)], note: null, strength: 'direct' };
    }

    const hit = searchProvider(spec.provider, context, {
      keywords: spec.keywords,
      strategies: spec.strategies,
      // Distinguishing words are applied during the search so a section that
      // only matches a broad synonym is not the first thing found; the check
      // below remains as a backstop for hits that slip through.
      requiredAnyKeywords: spec.requiredAnyKeywords || [],
      // A spec may carry partial bounds; merge over the defaults rather than
      // letting `{}` replace them, which would leave the strategies unbounded.
      bounds: { ...BOUNDS, ...(spec.bounds || {}) },
      subjectEntity: context.subjectEntity
    });

    if (hit?.conflict) {
      // The document states two different things for the same claim. Neither is
      // assumed: the criterion is contradictory, and the conflicting values are
      // carried as evidence so a person can settle it.
      return {
        state: 'conflicting',
        strength: 'direct',
        evidence: hit.conflict.entries.map(entry => evidenceItem({
          source: { ...hit.source, locator: `line ${entry.line}` },
          excerptText: entry.text,
          detail: `“${hit.conflict.label}” reported as “${entry.value}”.`,
          strength: 'direct'
        })),
        note: hit.detail,
        whatWouldResolveIt: 'Establish which value is correct, or remove the conflicting content.'
      };
    }

    if (!hit?.matched) {
      return {
        state: 'not_satisfied',
        evidence: [],
        note: `Searched ${context.documents?.length || 0} document(s); no ${spec.criterionLabel.toLowerCase()} found.`,
        scanned: hit?.scanned || []
      };
    }

    // A reconciled hit's detail names the superseded values and their dates;
    // for ordinary hits the criterion label is the right evidence detail.
    const evidence = [hitToEvidence(hit, hit.superseded?.length ? hit.detail : spec.criterionLabel)];
    const extractedDate = hit.date || null;
    if (hit.strength === 'indicative') {
      // A mention is not the content. Report what was found, but refuse to call
      // the criterion satisfied.
      return {
        state: 'unknown',
        evidence,
        strength: 'indicative',
        note: `Only an indicative mention was found (${hit.detail}). This does not establish that the content is present.`,
        whatWouldResolveIt: `Add the ${spec.criterionLabel.toLowerCase()} explicitly, or confirm it manually.`
      };
    }

    // Some concepts are matched by a single broad word ("results", "figures",
    // "numbers"). When the request said more than that ("revenue figures",
    // "results of a particular evaluation"), a section that matches only the
    // broad word is not the requested content: at least one distinguishing word
    // must appear in what was found.
    const distinctive = spec.requiredAnyKeywords || [];
    if (distinctive.length) {
      const haystack = String(hit.excerpt || '').toLowerCase();
      const missed = distinctive.every(keyword => !haystack.includes(keyword));
      // The search applied this filter to the full statement text and the hit
      // carries the result (`fallback`). A hit it returned as qualified must not
      // be re-rejected merely because its excerpt is clipped before the
      // distinguishing word; the re-check stays for hits with no flag.
      if (hit.fallback === true || (missed && hit.fallback !== false)) {
        return {
          state: 'unknown',
          evidence,
          strength: 'direct',
          date: extractedDate,
          note: `Found ${spec.criterionLabel.toLowerCase()}, but nothing tying it to “${distinctive.join('”, “')}”.`,
          whatWouldResolveIt: `Confirm the found content is the one the request asked for, or add content about “${distinctive.join('”, “')}”.`
        };
      }
    }

    // A qualifier ("signed", "approved", "final") restricts the requirement, so
    // content that lacks it is not yet verified.
    const required = spec.requiredKeywords || [];
    if (required.length) {
      const haystack = String(hit.excerpt || '').toLowerCase();
      const absent = required.filter(keyword => !haystack.includes(keyword));
      if (absent.length) {
        return {
          state: 'unknown',
          evidence,
          strength: 'direct',
          date: extractedDate,
          note: `Found ${spec.criterionLabel.toLowerCase()}, but it is not marked as ${absent.join(', ')}.`,
          whatWouldResolveIt: `Confirm the content is ${absent.join(', ')}, or the requirement does not apply.`
        };
      }
    }
    return { state: 'satisfied', evidence, strength: 'direct', date: extractedDate, note: null };
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return {
        state: 'blocked',
        evidence: [],
        note: error.message,
        whatWouldResolveIt: `Connect the “${spec.provider}” evidence source.`
      };
    }
    return { state: 'blocked', evidence: [], note: `Probe failed: ${error.message}` };
  }
}

/**
 * Assess a plan against the available context.
 * Returns criteria in plan order plus observations about how the search ran.
 */
export function assessPlan(plan, context) {
  const observations = [];
  if (plan?.restoreBlocked) {
    const detail = 'A saved verification plan no longer passes validation; its requirements must be reviewed before execution.';
    return {
      criteria: [criterion({ id: 'model_plan_revalidation', label: 'Saved verification plan is valid', status: 'blocked', note: detail })],
      observations: [{ id: 'model_plan_revalidation', detail }]
    };
  }
  if (!plan?.specs?.length) {
    return {
      criteria: [],
      observations: [{ id: 'no_probes', detail: 'The plan contains no executable probes.' }]
    };
  }

  const documents = context.documents || [];
  observations.push({
    id: 'search_scope',
    detail: documents.length
      ? `Searched ${documents.length} correlated document(s): ${documents.map(document => document.id).join(', ')}.`
      : 'No correlated document was available.',
    source: documents[0]
      ? { kind: 'document', id: documents[0].id, version: documents[0].version ?? null, timestamp: documents[0].modifiedAt ?? null, url: documents[0].url ?? null, locator: null }
      : null
  });

  const criteria = plan.specs.map(spec => {
    const result = executeSpec(spec, context);
    return criterion({
      id: spec.criterionId,
      label: spec.criterionLabel,
      kind: spec.coverage ? 'coverage' : spec.builtinProbe ? 'content' : 'derived_content',
      required: spec.required !== false,
      status: result.state,
      evidence: result.evidence,
      note: result.note,
      // Whichever probe actually extracted a date supplies the freshness input,
      // rather than guessing from which strategies were attempted.
      date: result.date || null,
      probe: {
        id: spec.id,
        origin: spec.origin,
        concept: spec.concept,
        provider: spec.provider,
        strategies: spec.strategies,
        builtinProbe: spec.builtinProbe,
        justification: spec.justification,
        justified: spec.justified,
        expectedEvidence: spec.expectedEvidence,
        constraints: spec.constraints,
        keywords: spec.keywords.slice(0, 8)
      },
      strength: result.strength || null,
      whatWouldResolveIt: result.whatWouldResolveIt || null
    });
  });

  return { criteria, observations };
}

/**
 * Overall completion, derived strictly from criterion states.
 *
 * Blockers are always reported, even when criteria are also unsatisfied, because
 * "there is no document to read" is the reason worth surfacing.
 */
export function completionFromCriteria(criteria, { blockers = [] } = {}) {
  const required = (criteria || []).filter(item => item.required !== false);
  const unsatisfied = required.filter(item => item.status !== 'satisfied');
  if (!required.length) {
    return {
      complete: false,
      reason: 'The plan produced no required criteria to check.',
      unsatisfied: [],
      blockers
    };
  }
  if (unsatisfied.length || blockers.length) {
    const states = [...new Set(unsatisfied.map(item => item.status))];
    const reason = [
      unsatisfied.length ? `${unsatisfied.length} of ${required.length} criteria are not satisfied (${states.join(', ')}).` : null,
      blockers.length ? blockers.map(blocker => blocker.detail || blocker.id).join(' · ') : null
    ].filter(Boolean).join(' ');
    return {
      complete: false,
      reason,
      unsatisfied: unsatisfied.map(item => ({ id: item.id, label: item.label, status: item.status })),
      blockers
    };
  }
  return { complete: true, reason: `All ${required.length} required criteria are satisfied by direct evidence.`, unsatisfied: [], blockers: [] };
}

export const assessApi = { CRITERION_STATES, executeSpec, assessPlan, completionFromCriteria };
