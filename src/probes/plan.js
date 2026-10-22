import crypto from 'node:crypto';
import { resolveRequiredContent, PROBES } from './builtin.js';
import { CONCEPTS, conceptFor, matchConcepts, deriveKeywords, extractQualifiers, QUALIFIERS } from './lexicon.js';
import { justifyRequestContent, isRequestQuotation } from '../contracts.js';
import { isStrategy, DEFAULT_BOUNDS } from './strategies.js';
import { isProvider, QUERY_BOUNDS } from './providers.js';

/**
 * Probe planning.
 *
 * Turns a request into a list of *probe specs*: bounded, traceable questions
 * that can be executed against registered evidence providers.
 *
 * Two sources feed a plan:
 *
 *   1. Deterministic derivation from the request's own wording. Built-in
 *      concepts keep their original probes so existing behaviour is unchanged;
 *      everything else is derived from the lexicon or from the request's own
 *      significant tokens. This path always runs and needs no model.
 *
 *   2. Optional model proposals. These are validated against the request text
 *      and the provider/strategy registries before they are allowed into a
 *      plan. A rejected proposal is recorded with its reason, never dropped
 *      silently and never partially applied.
 *
 * A probe describes what to investigate. It never asserts that a criterion is
 * satisfied — that comes only from evidence returned by a provider.
 */

export const MAX_PROBES_PER_PLAN = 10;
export const MAX_MODEL_PROBES = 6;
const MAX_CONCEPT_CHARS = 80;
const MAX_JUSTIFICATION_CHARS = 240;
// The prompt tells the model keywords run 2-40 characters; the bound is
// enforced here so a response cannot smuggle in an unbounded search string.
const MAX_KEYWORD_CHARS = 40;
const MAX_PROPOSAL_STRATEGIES = 8;

export const slugify = value => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

/** Stable identity for a request, used to cache and reuse plans. */
export function planSignature(request) {
  return crypto.createHash('sha1').update(JSON.stringify({
    entity: request.subjectEntity,
    deliverable: request.deliverable,
    intent: request.intent,
    content: (request.requiredContent || []).map(item => String(item.text || item).toLowerCase()),
    claims: (request.impliedClaims || []).map(item => item.id),
    // Qualifiers change which criteria a plan must contain ("all reviewers"
    // adds a coverage probe), so two otherwise-identical requests with
    // different qualifiers are not the same plan.
    qualifiers: (request.qualifiers || []).map(item => String(item.id || item.text || '').toLowerCase())
  })).digest('hex').slice(0, 16);
}

/**
 * Words in the requested phrase that the matched concept does not explain.
 *
 * A broad concept is matched by one word ("results", "figures", "numbers"), and
 * any document section using that word satisfies the concept — but not the
 * request. "Results of a particular evaluation" is not satisfied by a generic
 * "Results" section: at least one of the phrase's remaining distinctive words
 * ("evaluation") must appear in what was found. A multi-word match ("experiment
 * results", "customer feedback") already pins the content, so it needs none.
 *
 * A remaining word that is itself known content vocabulary is not dropped —
 * that would make the requirement *more* generic than the request. "Outage
 * statistics" must still be content *about incidents*: the token "outage"
 * expands to the vocabulary of the concept it belongs to ("incident statistics",
 * "incident count", "outage", "downtime", …), and a generic "Statistics"
 * section about something else is not accepted. A token the lexicon does not
 * know ("revenue", "pilot", "evaluation") stays a literal requirement.
 */
function residualKeywords(phrase, concept) {
  if (!concept) return [];
  const best = matchConcepts(phrase).find(hit => hit.concept.id === concept.id);
  if (!best || best.matched.includes(' ')) return [];
  const covered = new Set(best.matched.split(/[^a-z0-9%/-]+/).filter(Boolean));
  const residual = [];
  for (const token of deriveKeywords(phrase, null).tokens) {
    // Status qualifiers ("signed") are checked separately and strictly, so they
    // are not distinguishing content words.
    if (covered.has(token) || QUALIFIERS.includes(token)) continue;
    const host = CONCEPTS.find(item => item.synonyms.includes(token));
    if (!host) {
      residual.push(token);
      continue;
    }
    // Vocabulary of the matched concept itself is already explained by the
    // match; vocabulary of another concept becomes that concept's own words.
    if (host.id !== concept.id) residual.push(...host.synonyms);
  }
  return [...new Set(residual)];
}

/**
 * Strategies to try for a concept, most precise first, always ending with the
 * weak fallback. A request-derived concept gets the full set: the user's own
 * wording may well be a labelled figure ("mean time to recovery: 42 minutes"),
 * and each strategy is individually bounded and requires the keyword next to a
 * value, so the extra reach does not cost precision.
 */
function strategiesFor(concept) {
  const preferred = concept?.strategies?.filter(isStrategy) || [];
  const fallback = ['labelled_value', 'dated_reference', 'section_body', 'quoted_statement', 'keyword_presence'];
  const ordered = [...new Set([...preferred, ...fallback])].filter(isStrategy);
  return ordered.length ? ordered : ['section_body', 'keyword_presence'];
}

function specFromBuiltin(probeId, request, itemText) {
  const probe = PROBES[probeId];
  if (!probe) return null;
  // A built-in probe is triggered by the request's own declared content, so it
  // cites that wording. `justificationSource` records whether the citation is a
  // direct quotation of the email or of the interpreted ask.
  const quote = itemText ? justifyRequestContent(request, itemText) : { span: null, source: null };
  return {
    id: `probe:${probeId}`,
    criterionId: probeId,
    criterionLabel: probe.label,
    concept: probeId,
    provider: 'document_text',
    strategies: [],
    keywords: [],
    requiredKeywords: [],
    requiredAnyKeywords: [],
    builtinProbe: probeId,
    bounds: { ...DEFAULT_BOUNDS, ...QUERY_BOUNDS },
    justification: quote.span,
    justificationSource: quote.source,
    justified: Boolean(quote.span),
    expectedEvidence: probe.label,
    constraints: { freshness: false },
    origin: 'builtin',
    required: true
  };
}

/**
 * A keyword spec derived from the request's own wording.
 *
 * `item` is the interpreted content requirement when the caller has it. Its
 * qualifiers are honoured: a status qualifier ("signed testimonials") becomes a
 * required term, because content that lacks it is not yet the requested
 * content. Freshness is settled by the freshness mechanism rather than by a
 * word match, and coverage gets its own probe (see `specForCoverage`).
 */
function specFromConcept(phrase, request, item = null) {
  const concept = conceptFor(phrase);
  if (concept?.builtinProbe) return specFromBuiltin(concept.builtinProbe, request, phrase);

  const keywords = deriveKeywords(phrase, concept);
  const statusQualifiers = (item?.qualifiers || [])
    .filter(qualifier => qualifier.kind === 'status')
    .map(qualifier => qualifier.text)
    .filter(Boolean);
  const qualifiers = [...new Set([...extractQualifiers(phrase), ...statusQualifiers])];
  const requiredAnyKeywords = residualKeywords(phrase, concept);
  const usable = keywords.keywords.filter(keyword => keyword.length > 2);
  if (!usable.length && !qualifiers.length) return null; // nothing searchable: honestly unverifiable

  // Criterion ids stay the concept's own slug so a request's criteria are
  // stable across phrasings. A collision (two items mapping to the same broad
  // concept) is what forces a distinct id — see buildDeterministicPlan.
  const slug = concept ? concept.id : `derived-${slugify(phrase) || 'content'}`;
  // Cite the request's wording for this content, falling back to its strongest
  // searchable term when the phrase itself does not appear verbatim.
  const primary = justifyRequestContent(request, phrase);
  const quote = primary.span ? primary : justifyRequestContent(request, usable[0]);
  const freshnessSensitive = /latest|newest|most recent|current|up to date|up-to-date/i.test(request.text) &&
    ['metrics', 'incident_stats', 'experiment_results'].includes(concept?.id);

  return {
    id: `probe:${slug}`,
    criterionId: slug,
    criterionLabel: concept ? concept.label : `“${String(phrase).slice(0, 60)}”`,
    concept: concept?.id || `derived:${slug}`,
    provider: 'document_text',
    strategies: strategiesFor(concept),
    keywords: [...new Set([...usable, ...qualifiers])],
    // A qualifier must appear alongside the content, or the criterion is unknown.
    requiredKeywords: qualifiers,
    // A distinguishing word must appear too, when the concept match was broad.
    requiredAnyKeywords,
    builtinProbe: null,
    bounds: { ...DEFAULT_BOUNDS, ...QUERY_BOUNDS },
    justification: quote.span,
    justificationSource: quote.source,
    justified: Boolean(quote.span),
    expectedEvidence: concept
      ? `content satisfying “${concept.label}”${qualifiers.length ? ` and marked ${qualifiers.join(', ')}` : ''}`
      : `content satisfying “${phrase}”`,
    constraints: { freshness: Boolean(freshnessSensitive) },
    origin: concept ? 'lexicon' : 'derived',
    required: true
  };
}

/**
 * A probe for a completeness qualifier ("comments from all reviewers").
 *
 * Coverage is a claim only the deliverable can make: the document must state
 * that the set is fully covered ("all three reviewers", "every reviewer"), or
 * the criterion stays unknown and the work stays unverified. This probe can
 * therefore never be satisfied by the requester's own words — only by an
 * explicit statement in the document.
 */
function specForCoverage(qualifier, request) {
  const noun = qualifier.noun || String(qualifier.text || '').replace(/^(all|every|each)\s+/i, '');
  const singular = noun.replace(/s$/, '');
  const keywords = [...new Set([noun, singular])].filter(term => term.length > 2);
  const slug = slugify(noun) || 'coverage';
  const quote = justifyRequestContent(request, qualifier.span || qualifier.text);
  return {
    id: `probe:coverage:${slug}`,
    criterionId: `coverage:${slug}`,
    criterionLabel: `Coverage of ${noun}`,
    concept: 'coverage',
    provider: 'document_text',
    strategies: ['coverage_statement'],
    keywords,
    requiredKeywords: [],
    requiredAnyKeywords: [],
    coverage: true,
    builtinProbe: null,
    bounds: { ...DEFAULT_BOUNDS, ...QUERY_BOUNDS },
    justification: quote.span,
    justificationSource: quote.source,
    justified: Boolean(quote.span),
    expectedEvidence: `an explicit statement that the ${noun} are all covered`,
    constraints: { freshness: false },
    origin: 'coverage',
    required: true
  };
}

/**
 * A request that asks for the "most recent" or "latest" content is implicitly
 * asking for something that can be dated. Without a date there is no way to
 * compare the content against a source of truth, so the plan adds a probe for it.
 */
function specForFreshness(request) {
  const keywords = ['as of', 'as at', 'reporting period', 'period covered', 'updated on', 'completed on', 'reviewed on', 'date'];
  // This probe is only added when the request asked for current content, so one
  // of these phrases is present; the span records which one.
  const quote = ['most recent', 'latest', 'newest', 'current', 'as of', 'up to date']
    .map(phrase => justifyRequestContent(request, phrase))
    .find(result => result.span) || { span: null, source: null };
  return {
    id: 'probe:as_of_date',
    criterionId: 'as_of_date',
    criterionLabel: 'A date the content is current as of',
    concept: 'dated_reference',
    provider: 'document_text',
    strategies: ['dated_reference'],
    keywords,
    requiredKeywords: [],
    requiredAnyKeywords: [],
    builtinProbe: null,
    bounds: { ...DEFAULT_BOUNDS, ...QUERY_BOUNDS },
    justification: quote.span,
    justificationSource: quote.source,
    justified: Boolean(quote.span),
    expectedEvidence: 'a date stating when the reported content was current',
    constraints: { freshness: true },
    origin: 'freshness',
    // Investigated and reported, and its evidence feeds the freshness verdict —
    // but its absence alone does not block completion. Freshness already
    // withholds the "latest" claim, which is the safer place to be strict.
    required: false
  };
}

/**
 * Build the deterministic plan. Synchronous and model-free, so ingestion never
 * depends on a provider being reachable.
 */
export function buildDeterministicPlan(request) {
  const { probeIds, unverifiable, origins = {} } = resolveRequiredContent(request.requiredContent || []);
  const specs = [];
  const seen = new Set();

  for (const probeId of probeIds) {
    const spec = specFromBuiltin(probeId, request, origins[probeId] ?? null);
    if (!spec || seen.has(spec.criterionId)) continue;
    seen.add(spec.criterionId);
    specs.push(spec);
  }

  const unresolved = [];
  for (const item of unverifiable) {
    const text = String(item.text || item);
    let spec = specFromConcept(text, request, item);
    if (!spec) {
      unresolved.push({ text, reason: 'The requested content has no searchable terms, so it cannot be investigated.' });
      continue;
    }
    if (seen.has(spec.criterionId)) {
      // Two requirements can map to the same broad concept ("revenue figures"
      // and "results of the particular evaluation" are both metrics). When the
      // distinguishing words differ, both criteria must survive; otherwise one
      // requirement would silently absorb the other.
      const distinct = spec.requiredAnyKeywords.length ? `${spec.criterionId}-${slugify(text)}` : null;
      if (!distinct || seen.has(distinct)) continue;
      spec = { ...spec, id: `probe:${distinct}`, criterionId: distinct };
    }
    seen.add(spec.criterionId);
    specs.push(spec);
  }

  // A completeness qualifier ("all reviewers") is a criterion of its own: the
  // document must state the coverage, so it is planned and assessed even when
  // the content itself is verified.
  const qualifiers = request.qualifiers || request.analysis?.qualifiers || [];
  for (const qualifier of qualifiers.filter(item => item.kind === 'completeness')) {
    const noun = qualifier.noun || String(qualifier.text || '').replace(/^(all|every|each)\s+/i, '');
    const criterionId = `coverage:${slugify(noun) || 'coverage'}`;
    if (seen.has(criterionId)) continue;
    seen.add(criterionId);
    specs.push(specForCoverage(qualifier, request));
  }

  // Freshness is only worth probing when the request asked for current content.
  const wantsFreshness = /latest|newest|most recent|current|up to date|up-to-date|as of/i.test(request.text || '');
  if (wantsFreshness && !seen.has('as_of_date')) {
    seen.add('as_of_date');
    specs.push(specForFreshness(request));
  }

  return {
    requestId: request.id,
    signature: planSignature(request),
    builtAt: new Date().toISOString(),
    reasoning: 'deterministic',
    degraded: true,
    specs: specs.slice(0, MAX_PROBES_PER_PLAN),
    rejected: [],
    unverifiable: unresolved
  };
}

/**
 * Validate one model-proposed probe.
 *
 * The justification must be a genuine quotation from the request. That single
 * check is what stops a model from inventing a reason for an arbitrary search.
 */
export function validateProposal(proposal, request) {
  const reject = reason => ({ ok: false, reason });
  if (!proposal || typeof proposal !== 'object') return reject('proposal is not an object');

  const concept = String(proposal.concept || '').trim();
  if (!concept) return reject('proposal has no concept');
  if (concept.length > MAX_CONCEPT_CHARS) return reject('concept is too long');
  if (/[\u0000-\u001f]/.test(concept)) return reject('concept contains control characters');

  const provider = String(proposal.provider || 'document_text');
  if (!isProvider(provider)) return reject(`provider "${provider}" is not registered`);

  const strategies = [...new Set((Array.isArray(proposal.strategies) ? proposal.strategies : [proposal.strategy])
    .filter(Boolean).map(String))].slice(0, MAX_PROPOSAL_STRATEGIES);
  if (!strategies.length) return reject('proposal names no strategy');
  const unknown = strategies.filter(id => !isStrategy(id));
  if (unknown.length) return reject(`unknown strategy: ${unknown.join(', ')}`);

  const justification = String(proposal.justification || '').trim();
  if (!justification) return reject('proposal has no justification quotation');
  if (justification.length > MAX_JUSTIFICATION_CHARS) return reject('justification is too long');
  // The request is its text plus its declared required content; a citation of
  // either is a citation of the request. See contracts.requestQuotationTexts.
  if (!isRequestQuotation(request, justification)) {
    return reject(`justification is not a quotation from the request: “${justification.slice(0, 80)}”`);
  }

  const keywords = (Array.isArray(proposal.keywords) ? proposal.keywords : [])
    .filter(item => typeof item === 'string').map(item => item.trim())
    .filter(item => item.length > 2 && item.length <= MAX_KEYWORD_CHARS).slice(0, 12);
  const lexicon = deriveKeywords(concept, conceptFor(concept));
  const usable = [...new Set([...keywords, ...lexicon.keywords])].filter(keyword => keyword.length > 2);
  if (!usable.length) return reject('proposal yields no searchable keywords');

  const slug = slugify(proposal.criterionId || concept) || 'model-content';
  return {
    ok: true,
    spec: {
      id: `probe:${slug}`,
      criterionId: `model-${slug}`,
      criterionLabel: String(proposal.criterionLabel || proposal.expectedEvidence || concept).slice(0, 120),
      concept,
      provider,
      strategies,
      keywords: usable,
      requiredKeywords: (Array.isArray(proposal.requiredKeywords) ? proposal.requiredKeywords : [])
        .filter(item => typeof item === 'string').map(item => item.toLowerCase().trim())
        .filter(item => item.length > 2 && item.length <= MAX_KEYWORD_CHARS).slice(0, 8),
      requiredAnyKeywords: [],
      builtinProbe: null,
      bounds: { ...DEFAULT_BOUNDS, ...QUERY_BOUNDS },
      justification,
      justificationSource: 'model_quote',
      justified: true,
      expectedEvidence: String(proposal.expectedEvidence || `content satisfying “${concept}”`).slice(0, 160),
      constraints: { freshness: Boolean(proposal.constraints?.freshness) },
      origin: 'model',
      required: true
    }
  };
}

/**
 * Merge validated model proposals into an existing plan.
 * A rejected proposal is recorded; the deterministic plan stays intact.
 */
export function applyModelProposals(plan, proposals, request) {
  const specs = [...plan.specs];
  const rejected = [...plan.rejected];
  const seen = new Set(specs.map(spec => spec.criterionId));
  const seenConcepts = new Set(specs.map(spec => String(spec.concept).toLowerCase()));

  for (const proposal of (proposals || []).slice(0, MAX_MODEL_PROBES)) {
    const outcome = validateProposal(proposal, request);
    if (!outcome.ok) {
      rejected.push({ proposal: { concept: proposal?.concept ?? null, strategy: proposal?.strategy ?? null }, reason: outcome.reason });
      continue;
    }
    // Do not let a model add a second probe for something already covered.
    if (seen.has(outcome.spec.criterionId) || seenConcepts.has(outcome.spec.concept.toLowerCase())) {
      rejected.push({ proposal: { concept: outcome.spec.concept }, reason: 'duplicates a criterion already in the plan' });
      continue;
    }
    seen.add(outcome.spec.criterionId);
    seenConcepts.add(outcome.spec.concept.toLowerCase());
    specs.push(outcome.spec);
  }

  return {
    ...plan,
    specs: specs.slice(0, MAX_PROBES_PER_PLAN),
    rejected,
    reasoning: 'deterministic+model',
    degraded: false
  };
}

/**
 * Bounded plan cache. Reuses a valid plan for an identical request instead of
 * re-deriving it, and never grows without limit.
 */
export class PlanCache {
  constructor({ max = 200 } = {}) { this.max = max; this.entries = new Map(); this.hits = 0; this.misses = 0; }

  get(signature) {
    const entry = this.entries.get(signature);
    if (entry) { this.hits += 1; return entry; }
    this.misses += 1;
    return null;
  }

  set(signature, plan) {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.entries.set(signature, plan);
    return plan;
  }

  describe() { return { size: this.entries.size, max: this.max, hits: this.hits, misses: this.misses }; }
}

export const planApi = {
  MAX_PROBES_PER_PLAN, MAX_MODEL_PROBES, planSignature, buildDeterministicPlan,
  validateProposal, applyModelProposals, PlanCache, slugify
};
