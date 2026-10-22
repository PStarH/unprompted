import { criterion, evidenceItem, sourceRef, excerpt } from '../evidence.js';

/**
 * Built-in probes.
 *
 * The original six content probes, preserved exactly so behaviour for the
 * experiment-shaped requests that Phase 2 handled is unchanged. They are now one
 * source of probes among several: the planner in plan.js adds request-derived
 * probes for everything these do not cover.
 *
 * This module deliberately has no dependency on the planner, so the planner can
 * use it without a cycle.
 */

export const PROBES = {
  run_date: {
    id: 'run_date',
    label: 'A dated experiment run',
    concepts: ['run date', 'experiment date', 'date of the run', 'completed on', 'as of', 'when the run'],
    find: text => matchLine(text, /\b(?:run date|experiment date|date|completed on|as of)\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\s+\w+\s+\d{4})/i)
  },
  sample_size: {
    id: 'sample_size',
    label: 'The sample size',
    concepts: ['sample size', 'sample', 'participants', 'users', 'traffic', 'n ='],
    find: text => matchLine(text, /\b(?:sample size|sample|participants|users|traffic)\s*:?\s*([\d,]{2,})/i)
  },
  control_metric: {
    id: 'control_metric',
    label: 'A control-group result',
    concepts: ['control', 'control group', 'baseline', 'baseline group', 'holdout'],
    find: text => matchLine(text, /\b(?:control|baseline|holdout)\b[^\n]{0,40}?(\d+(?:\.\d+)?)\s*(%|percent|pp|points?|ms|s|seconds?)?/i)
  },
  treatment_metric: {
    id: 'treatment_metric',
    label: 'A treatment-group result',
    concepts: ['treatment', 'variant', 'test group', 'experiment group', 'new version'],
    find: text => matchLine(text, /\b(?:treatment|variant|test group|experiment group)\b[^\n]{0,40}?(\d+(?:\.\d+)?)\s*(%|percent|pp|points?|ms|s|seconds?)?/i)
  },
  conclusion: {
    id: 'conclusion',
    label: 'A stated conclusion',
    concepts: ['conclusion', 'finding', 'recommendation', 'takeaway', 'result summary'],
    find: text => matchLine(text, /\b(?:conclusion|finding|recommendation|takeaway)s?\s*:?\s*(\S[^\n]{7,})/i)
  },
  results_present: {
    id: 'results_present',
    label: 'Reported results or metrics',
    concepts: ['experiment results', 'results', 'metrics', 'outcome', 'measurements', 'experiment outcome', 'performance numbers'],
    // Broader probe used when a request asks for "the results" without naming parts.
    find: text => matchLine(text, /\b(\d+(?:\.\d+)?\s*(?:%|percent|pp|points?))\b/i)
  }
};

/** Concepts that, when requested, imply the full experiment-results checklist. */
const RESULT_UMBRELLA = ['results_present', 'run_date', 'sample_size', 'control_metric', 'treatment_metric', 'conclusion'];

/**
 * The umbrella checklist describes an *experiment*. Requests that merely mention
 * results or statistics generally must not inherit sample size, control and
 * treatment criteria — doing so made any non-experiment request unassessable.
 */
const EXPERIMENT_HINT = /\b(experiment|a\/b|ab test|split test|test results|experiment results)\b/i;

function matchLine(text, pattern) {
  if (typeof text !== 'string' || !text) return null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(pattern);
    if (match) return { value: match[0].trim(), matched: (match[1] || match[0]).trim() };
  }
  return null;
}

/**
 * Find the part of a document that reports results. Used only as a search scope
 * hint — a missing heading is an observation, never a hard requirement, because
 * a user asking for results does not require a particular heading.
 */
export function findResultsScope(content) {
  const lines = String(content || '').split('\n');
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s*(.+)$/);
    if (heading && /result|metric|finding|measurement|outcome|performance|statistic|incident|feedback/i.test(heading[2])) {
      start = index;
      level = heading[1].length;
      break;
    }
  }
  if (start === -1) return { found: false, title: null, text: String(content || ''), line: null };
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s*(.+)$/);
    if (heading && heading[1].length <= level) break;
    body.push(lines[index]);
  }
  return { found: true, title: lines[start].replace(/^#+\s*/, '').trim(), text: body.join('\n'), line: start + 1 };
}

/**
 * Resolve requested content into built-in probe ids.
 *
 * Returns { probeIds, unverifiable }. Content that only matches the generic
 * "results" concept, or that matches nothing, is reported as unverifiable so the
 * planner can derive a probe from the request's own wording instead of silently
 * dropping the requirement.
 */
export function resolveRequiredContent(requiredContent) {
  const probeIds = new Set();
  const unverifiable = [];
  // Which item of the request triggered each probe id. A probe must be able to
  // cite the request, and this is the span it cites, so the origin travels with
  // the id instead of being re-guessed downstream.
  const origins = {};
  const wantsUmbrella = [];
  const note = (id, text) => { if (text && !origins[id]) origins[id] = text; };
  for (const item of requiredContent || []) {
    const text = item.text || item;
    const needle = String(text).toLowerCase();
    const matches = [];
    for (const probe of Object.values(PROBES)) {
      if (probe.concepts.some(concept => needle.includes(concept) || concept.includes(needle))) matches.push(probe.id);
    }
    const specific = matches.filter(id => id !== 'results_present');
    for (const id of specific) { probeIds.add(id); note(id, text); }

    if (matches.includes('results_present')) {
      if (EXPERIMENT_HINT.test(needle)) wantsUmbrella.push(text);
      // Only unresolved when nothing more specific matched: an item like
      // "treatment conversion results" is already covered by treatment_metric.
      else if (!specific.length) {
        unverifiable.push({ text, reason: 'Requested content needs a request-derived probe.', qualifiers: item?.qualifiers || [] });
      }
    } else if (!matches.length) {
      unverifiable.push({ text, reason: 'No built-in probe matches this requested content.', qualifiers: item?.qualifiers || [] });
    }
  }
  if (wantsUmbrella.length) {
    for (const id of RESULT_UMBRELLA) {
      if (id === 'results_present') continue;
      probeIds.add(id);
      note(id, wantsUmbrella[0]);
    }
  }
  return { probeIds: [...probeIds], unverifiable, origins };
}

function documentRef(document, line) {
  return sourceRef({
    kind: 'document',
    id: document.id,
    version: document.version ?? null,
    timestamp: document.modifiedAt ?? null,
    url: document.url ?? null,
    locator: line != null ? `line ${line}` : null
  });
}

/**
 * Scan one document against built-in probe ids, producing source-referenced
 * evidence. Used for the built-in concepts and by callers that already know
 * which built-in probes they want.
 */
export function assessAgainstCriteria(document, probeIds) {
  const scope = findResultsScope(document.content);
  const searchText = scope.text || document.content || '';
  const observations = [];

  observations.push(scope.found
    ? { id: 'results_scope', detail: `Used the “${scope.title}” section as the search scope.`, source: documentRef(document, scope.line) }
    : { id: 'results_scope', detail: 'No results heading found; searched the whole document.', source: documentRef(document, null) });

  const criteria = [];
  for (const probeId of probeIds) {
    const probe = PROBES[probeId];
    if (!probe) continue;
    const found = probe.find(searchText) || (scope.found ? probe.find(document.content || '') : null);
    criteria.push(criterion({
      id: probe.id,
      label: probe.label,
      kind: 'content',
      required: true,
      status: found ? 'satisfied' : 'not_satisfied',
      evidence: found ? [evidenceItem({
        source: documentRef(document, scope.line),
        excerptText: found.value,
        detail: probe.label
      })] : [],
      note: found && scope.found && !probe.find(searchText) ? 'Found outside the results section.' : null
    }));
  }
  return { criteria, observations, scope };
}

export function criteriaToHumanStrings(criteria) {
  return criteria.flatMap(item => item.evidence.map(evidence => {
    const value = evidence.excerpt || evidence.detail || 'observed';
    return `${item.label}: ${value}`;
  }));
}

export function missingLabels(criteria) {
  return criteria.filter(item => item.required && item.status !== 'satisfied').map(item => item.label);
}

export const builtinApi = {
  PROBES, RESULT_UMBRELLA, EXPERIMENT_HINT, matchLine, findResultsScope,
  resolveRequiredContent, assessAgainstCriteria, criteriaToHumanStrings, missingLabels, excerpt
};
