/**
 * Concept lexicon.
 *
 * Phase 2 resolved requested content through six fixed probes keyed to the
 * Northstar experiment. That meant any other request — "incident statistics",
 * "customer feedback", "reviewer comments" — resolved to nothing and could
 * never be assessed.
 *
 * This module inverts the relationship. A request's own wording is the input:
 *
 *   - `matchConcepts` finds semantic categories a phrase belongs to, using
 *     curated synonym sets. These are *categories*, not tasks: they describe
 *     kinds of content, not kinds of request.
 *   - `deriveKeywords` falls back to the request's own significant tokens when
 *     no category matches, so a request written in vocabulary the lexicon has
 *     never seen still yields a probe.
 *
 * Both paths produce keywords that are executed by a small, fixed set of
 * generic strategies (see strategies.js). Nothing here is per-task.
 */

/** Words that carry no search value on their own. */
export const GENERIC_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'nor', 'of', 'for', 'with', 'without', 'to', 'in', 'on', 'at', 'by', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'this', 'that', 'these', 'those', 'it', 'its', 'your', 'our', 'their', 'his', 'her', 'my', 'we', 'you', 'they', 'i',
  'me', 'us', 'them', 'him', 'who', 'which', 'what', 'when', 'where', 'how', 'why',
  'most', 'more', 'less', 'much', 'many', 'very', 'recent', 'recently', 'latest', 'newest', 'current', 'currently',
  'updated', 'revised', 'final', 'new', 'old', 'good', 'better', 'best', 'all', 'any', 'some', 'each', 'every', 'both',
  'please', 'could', 'would', 'should', 'shall', 'can', 'may', 'might', 'will', 'must', 'need', 'needs', 'needed',
  'want', 'wants', 'wanted', 'like', 'also', 'plus', 'per', 'about', 'over', 'under', 'than', 'then', 'again',
  'include', 'includes', 'included', 'including', 'contain', 'contains', 'containing', 'cover', 'covers', 'covering',
  'add', 'added', 'adding', 'make', 'makes', 'made', 'sure', 'give', 'given', 'take', 'taken', 'get', 'got',
  'use', 'used', 'using', 'after', 'before', 'during', 'since', 'until', 'between', 'into', 'onto', 'out', 'up', 'down',
  'summary', 'summarise', 'summarize', 'detail', 'details', 'information', 'info', 'stuff', 'thing', 'things',
  'anything', 'everything', 'something', 'nothing', 'mean', 'time', 'times', 'value', 'values', 'total', 'overall',
  'general', 'various', 'several', 'set', 'list', 'part', 'parts', 'section', 'sections', 'your', 'my'
]);

/**
 * Qualifiers restrict a requirement rather than describing content.
 *
 * "signed customer testimonials" is not satisfied by unsigned testimonials, so a
 * qualifier becomes a required term: the probe must find the content *and* the
 * qualifier, or the criterion stays unknown.
 *
 * Only *status markers a document would actually state* belong here. Freshness
 * words ("latest", "newest", "current") and quantifiers ("all", "every") are
 * deliberately excluded: freshness is settled by the freshness mechanism against
 * a source of truth, and a quantifier is not a word the document has to contain.
 */
export const QUALIFIERS = [
  'signed', 'unsigned', 'approved', 'unapproved', 'final', 'draft',
  'reviewed', 'unreviewed', 'verified', 'unverified',
  'authorised', 'authorized', 'endorsed', 'certified', 'ratified'
];

export function extractQualifiers(phrase) {
  const words = String(phrase || '').toLowerCase().split(/[^a-z0-9]+/);
  return QUALIFIERS.filter(qualifier => words.includes(qualifier));
}

/**
 * Content categories.
 *
 * `synonyms` are matched against the request phrase. `strategies` lists the
 * extraction strategies to try, most precise first. `builtinProbe` links a
 * category to a pre-existing probe so behaviour for the original experiment
 * concepts is bit-for-bit unchanged.
 */
export const CONCEPTS = [
  {
    id: 'experiment_results',
    label: 'Experiment results',
    umbrella: 'experiment',
    synonyms: ['experiment results', 'experiment result', 'experiment outcome', 'a/b test results', 'ab test results', 'test results', 'split test results'],
    strategies: ['labelled_value', 'section_body']
  },
  {
    id: 'metrics',
    label: 'Reported metrics or statistics',
    synonyms: ['statistics', 'statistic', 'metrics', 'metric', 'results', 'result', 'numbers', 'number', 'figures', 'figure', 'performance', 'kpis', 'kpi', 'data points', 'measurements', 'measurement'],
    strategies: ['labelled_value', 'section_body']
  },
  {
    id: 'incident_stats',
    label: 'Incident statistics',
    synonyms: ['incident statistics', 'incident stats', 'incident count', 'incidents', 'incident', 'outages', 'outage', 'downtime', 'severity breakdown', 'error rate', 'postmortem', 'post-mortem'],
    strategies: ['labelled_value', 'section_body']
  },
  {
    id: 'customer_feedback',
    label: 'Customer feedback',
    synonyms: ['customer feedback', 'feedback', 'testimonials', 'testimonial', 'customer comments', 'reviews', 'review scores', 'survey results', 'survey', 'csat', 'nps', 'voice of customer', 'customer sentiment'],
    strategies: ['section_body', 'quoted_statement', 'keyword_presence']
  },
  {
    id: 'reviewer_comments',
    label: 'Reviewer comments',
    synonyms: ['reviewer comments', 'reviewer feedback', 'review comments', 'comments from reviewers', 'suggested changes', 'edits', 'markup'],
    strategies: ['section_body', 'quoted_statement']
  },
  {
    id: 'trend_assessment',
    label: 'An assessment or conclusion',
    synonyms: ['assessment', 'conclusion', 'conclusions', 'findings', 'finding', 'recommendation', 'recommendations', 'takeaway', 'takeaways', 'analysis', 'judgement', 'judgment', 'next steps', 'interpretation'],
    strategies: ['section_body', 'labelled_value']
  },
  {
    id: 'dated_reference',
    label: 'A dated reference',
    synonyms: ['as of', 'as at', 'reporting period', 'period covered', 'reviewed on', 'updated on', 'completed on', 'incident date', 'run date', 'date'],
    strategies: ['dated_reference']
  },
  {
    id: 'timeline',
    label: 'A timeline or schedule',
    synonyms: ['timeline', 'schedule', 'milestones', 'milestone', 'roadmap', 'due dates', 'delivery dates'],
    strategies: ['dated_reference', 'section_body']
  },
  {
    id: 'budget',
    label: 'Budget or cost figures',
    synonyms: ['budget', 'costs', 'cost', 'spend', 'expenses', 'expense', 'pricing', 'price', 'invoice total', 'burn rate'],
    strategies: ['labelled_value']
  },
  {
    id: 'approval',
    label: 'An approval or sign-off',
    synonyms: ['approval', 'approved', 'sign-off', 'signed off', 'authorisation', 'authorization', 'endorsement'],
    strategies: ['labelled_value', 'section_body', 'keyword_presence']
  },
  {
    id: 'owners',
    label: 'Named owners or contacts',
    synonyms: ['owners', 'owner', 'assignees', 'assignee', 'responsible party', 'stakeholders', 'stakeholder', 'contacts', 'point of contact'],
    // A section is direct evidence; a bare mention is not.
    strategies: ['section_body', 'keyword_presence']
  },
  {
    id: 'risks',
    label: 'Risks or blockers',
    synonyms: ['risks', 'risk', 'blockers', 'blocker', 'open issues', 'concerns', 'concern', 'dependencies', 'dependency'],
    strategies: ['section_body', 'keyword_presence']
  },
  {
    id: 'sample_size',
    label: 'The sample size',
    synonyms: ['sample size', 'sample', 'participants', 'cohort size', 'users tested'],
    strategies: ['labelled_value'],
    builtinProbe: 'sample_size'
  },
  {
    id: 'control_group',
    label: 'A control-group result',
    synonyms: ['control group', 'control', 'baseline', 'holdout'],
    strategies: ['labelled_value'],
    builtinProbe: 'control_metric'
  },
  {
    id: 'treatment_group',
    label: 'A treatment-group result',
    synonyms: ['treatment group', 'treatment', 'variant', 'test group', 'experiment group'],
    strategies: ['labelled_value'],
    builtinProbe: 'treatment_metric'
  }
];

export const CONCEPTS_BY_ID = Object.fromEntries(CONCEPTS.map(concept => [concept.id, concept]));

/** Categories whose umbrella expands into the full experiment checklist. */
export const UMBRELLA_TRIGGERS = CONCEPTS.filter(concept => concept.umbrella).map(concept => concept.id);

const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Find which content categories a phrase belongs to.
 * Longer synonyms win, so "incident count" beats "incident".
 */
export function matchConcepts(phrase) {
  const needle = normalize(phrase);
  if (!needle) return [];
  const hits = [];
  for (const concept of CONCEPTS) {
    const matched = concept.synonyms.filter(synonym => needle.includes(synonym));
    if (matched.length) hits.push({ concept, matched: matched.sort((a, b) => b.length - a.length)[0] });
  }
  return hits.sort((a, b) => b.matched.length - a.matched.length);
}

/** The single best category for a phrase, or null. */
export function conceptFor(phrase) {
  return matchConcepts(phrase)[0]?.concept || null;
}

/**
 * Reduce a phrase to searchable keywords.
 *
 * Returns the phrase itself plus its significant tokens. The phrase is used for
 * an exact match; the tokens are the fallback for wording the lexicon has never
 * seen. When a category matched, its synonyms are used instead, because a
 * curated synonym set is more reliable than the request's own nouns.
 */
export function deriveKeywords(phrase, concept = null) {
  const text = normalize(phrase);
  const tokens = [...new Set(text.split(/[^a-z0-9%/-]+/).filter(token => token.length > 2 && !GENERIC_WORDS.has(token)))];
  const lexicon = concept ? [...new Set(concept.synonyms)].sort((a, b) => b.length - a.length) : [];
  return {
    phrase: text,
    tokens,
    lexicon,
    // Strongest keywords first: an exact phrase, then curated synonyms, then tokens.
    keywords: [...new Set([...(text.includes(' ') ? [text] : []), ...lexicon, ...tokens])].filter(Boolean)
  };
}

const MAX_JUSTIFICATION_SPAN = 160;

/**
 * Locate a verbatim span of the request that justifies a probe.
 *
 * A probe must be traceable to what the user actually wrote. Returns null when
 * the phrase does not occur in the request, which is the signal callers use to
 * reject a model-invented quotation.
 *
 * The returned span is always a genuine substring of the request, clipped to a
 * readable window so the justification points at the asking phrase rather than
 * an entire paragraph.
 */
export function findJustification(requestText, phrase) {
  const haystack = normalize(requestText);
  const needle = normalize(phrase);
  if (!needle) return null;
  const index = haystack.indexOf(needle);
  if (index !== -1) return clipSpan(haystack, index, index + needle.length);

  // Fall back to the sentence containing the longest significant token.
  const tokens = needle.split(' ').filter(token => token.length > 3 && !GENERIC_WORDS.has(token));
  for (const token of tokens) {
    const tokenIndex = haystack.indexOf(token);
    if (tokenIndex === -1) continue;
    return clipSpan(haystack, tokenIndex, tokenIndex + token.length);
  }
  return null;
}

/** Expand a match to word boundaries, bounded to a readable length. */
function clipSpan(haystack, start, end) {
  let from = start;
  let to = end;
  while (from > 0 && haystack[from - 1] !== ' ' && start - from < 40) from -= 1;
  while (to < haystack.length && haystack[to] !== ' ' && to - end < 40) to += 1;
  let span = haystack.slice(from, to).trim();
  if (span.length > MAX_JUSTIFICATION_SPAN) {
    span = span.slice(0, MAX_JUSTIFICATION_SPAN).replace(/\s+\S*$/, '').trim();
  }
  return span || needle;
}

/** True when `quote` genuinely occurs in the request text. */
export function isVerbatimQuote(requestText, quote) {
  const haystack = normalize(requestText);
  const needle = normalize(quote);
  return Boolean(needle) && needle.length >= 3 && haystack.includes(needle);
}

export const lexiconApi = {
  GENERIC_WORDS, CONCEPTS, CONCEPTS_BY_ID, UMBRELLA_TRIGGERS, QUALIFIERS,
  matchConcepts, conceptFor, deriveKeywords, findJustification, isVerbatimQuote, extractQualifiers
};
