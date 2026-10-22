import test from 'node:test';
import assert from 'node:assert/strict';
import { matchConcepts, conceptFor, deriveKeywords, findJustification, isVerbatimQuote, extractQualifiers, GENERIC_WORDS } from '../src/probes/lexicon.js';
import { STRATEGIES, runStrategies, prepareText, isStrategy } from '../src/probes/strategies.js';
import { PROVIDERS, PROVIDER_IDS, isProvider, searchProvider, describeProviders, ProviderUnavailableError } from '../src/probes/providers.js';
import { buildDeterministicPlan, validateProposal, applyModelProposals, PlanCache, planSignature, MAX_MODEL_PROBES } from '../src/probes/plan.js';
import { assessPlan, executeSpec, completionFromCriteria, CRITERION_STATES } from '../src/probes/assess.js';
import { ReasoningBudget, REASONING_LIMITS } from '../src/reasoning.js';
import { interpretRequest } from '../src/requests.js';

const request = overrides => ({
  id: 'request:test', subjectEntity: 'Zephyr', deliverable: 'report', intent: 'update_and_send',
  requiredContent: [], impliedClaims: [], explicitDocumentUrl: null, deadline: null,
  text: 'Please update the Zephyr report with the latest incident statistics and share it by Friday.',
  source: { kind: 'email', id: 'm1', from: 'a@b.test', subject: 'Zephyr report', receivedAt: '2026-10-16T09:00:00.000Z' },
  interpretedBy: 'deterministic',
  ...overrides
});

const documentWith = content => ({
  id: 'doc-1', title: 'Zephyr report', kind: 'report', version: 1,
  modifiedAt: '2026-10-16T09:10:00.000Z', url: '/documents/doc-1', content
});

// ------------------------------------------------------------------- lexicon

test('concept matching prefers the most specific synonym', () => {
  assert.equal(conceptFor('most recent incident statistics').id, 'incident_stats');
  assert.equal(conceptFor('latest metrics').id, 'metrics');
  assert.equal(conceptFor('signed customer testimonials').id, 'customer_feedback');
  assert.equal(conceptFor('completely unrelated phrase about widgets'), null);
});

test('keyword derivation drops generic words but keeps the phrase and lexicon', () => {
  const derived = deriveKeywords('the latest quarterly revenue figures');
  assert.equal(derived.phrase, 'the latest quarterly revenue figures');
  assert.ok(derived.keywords.includes('the latest quarterly revenue figures'));
  assert.ok(derived.tokens.includes('quarterly'));
  assert.ok(derived.tokens.includes('revenue'));
  assert.ok(derived.tokens.includes('figures'));
  for (const token of derived.tokens) assert.equal(GENERIC_WORDS.has(token), false, `${token} should have been filtered`);
});

test('qualifiers are limited to status markers a document would state', () => {
  assert.deepEqual(extractQualifiers('signed customer testimonials'), ['signed']);
  assert.deepEqual(extractQualifiers('the approved final budget'), ['approved', 'final']);
  // Freshness words and quantifiers are not document markers.
  assert.deepEqual(extractQualifiers('the latest metrics'), []);
  assert.deepEqual(extractQualifiers('all reviewer comments'), []);
});

test('a justification must be a genuine quotation from the request', () => {
  const text = 'Please update the Zephyr report with the latest incident statistics and share it by Friday.';
  assert.equal(isVerbatimQuote(text, 'the latest incident statistics'), true);
  assert.equal(isVerbatimQuote(text, 'the latest incident statistics and all supporting charts'), false);
  assert.equal(isVerbatimQuote(text, ''), false);
  assert.match(findJustification(text, 'incident statistics'), /incident statistics/);
  assert.equal(findJustification(text, 'a phrase that is absent'), null);
});

// ----------------------------------------------------------------- strategies

test('each strategy requires what it claims to require', () => {
  const bounds = { maxLines: 500, maxExcerpt: 320, minBodyChars: 24, maxMatches: 5 };
  const lines = prepareText('# Report\n\nIncident count: 14\nSeverity: high\n');

  const labelled = STRATEGIES.labelled_value.run(lines.lines, ['incident count'], bounds);
  assert.equal(labelled.strength, 'direct');
  assert.match(labelled.excerpt, /14/);

  // A line with the keyword but no figure is not a labelled value.
  assert.equal(STRATEGIES.labelled_value.run(prepareText('Incident count: unknown\n').lines, ['incident count'], bounds), null);

  // A mention with no figure is indicative at best.
  const presence = STRATEGIES.keyword_presence.run(prepareText('We discussed the incident count at length.\n').lines, ['incident count'], bounds);
  assert.equal(presence.strength, 'indicative');
});

test('a section strategy needs a heading and real body content', () => {
  const bounds = { maxLines: 500, maxExcerpt: 320, minBodyChars: 24, maxMatches: 5 };
  const rich = STRATEGIES.section_body.run(prepareText('## Assessment\nIncident volume is down 22% quarter over quarter.\n').raw, ['assessment'], bounds);
  assert.equal(rich.strength, 'direct');
  // A heading with no body is not a section.
  assert.equal(STRATEGIES.section_body.run(prepareText('## Assessment\n').raw, ['assessment'], bounds), null);
});

test('a line carrying an inline value is not mistaken for a heading', () => {
  const bounds = { maxLines: 500, maxExcerpt: 320, minBodyChars: 12, maxMatches: 5 };
  const text = 'Incident count: 14\nSeverity breakdown: 3 critical, 5 major\n';
  // "Incident count: 14" must not be treated as a heading named after the concept.
  assert.equal(STRATEGIES.section_body.run(text, ['incident count'], bounds), null);
});

test('runStrategies stops at the first match and reports which strategy fired', () => {
  const bounds = { maxLines: 500, maxExcerpt: 320, minBodyChars: 24, maxMatches: 5 };
  const prepared = prepareText('## Incident statistics\nIncident count: 14\nMean time to recovery: 42 minutes\n');
  const hit = runStrategies(prepared, ['incident count'], ['labelled_value', 'keyword_presence'], bounds);
  assert.equal(hit.strategy, 'labelled_value');
  assert.equal(isStrategy('not_a_strategy'), false);
});

// ------------------------------------------------------------------ providers

test('only registered read-only providers exist', () => {
  assert.deepEqual(PROVIDER_IDS.sort(), ['document_text', 'run_registry']);
  assert.equal(isProvider('the_internet'), false);
  assert.ok(describeProviders().every(provider => provider.readOnly === true));
  assert.equal(PROVIDERS.document_text.kind, 'local_document');
});

test('an unregistered provider is refused rather than silently ignored', () => {
  assert.throws(
    () => searchProvider('the_internet', { documents: [documentWith('x')] }, { keywords: ['x'], strategies: ['keyword_presence'] }),
    ProviderUnavailableError
  );
});

test('an unavailable provider reports unavailability instead of empty evidence', () => {
  assert.throws(
    () => searchProvider('document_text', { documents: [] }, { keywords: ['x'], strategies: ['keyword_presence'] }),
    /no correlated document is available/
  );
  assert.throws(
    () => searchProvider('run_registry', { runRecords: {} }, {}),
    /no run registry is connected/
  );
});

test('the document provider searches only the documents it is handed', () => {
  const hit = searchProvider('document_text', {
    documents: [documentWith('Incident count: 14\n')]
  }, { keywords: ['incident count'], strategies: ['labelled_value'] });
  assert.equal(hit.matched, true);
  assert.equal(hit.documentId, 'doc-1');
  assert.equal(hit.source.id, 'doc-1');
  assert.equal(hit.source.version, 1);
  assert.ok(hit.source.timestamp);
});

// ----------------------------------------------------------------------- plan

test('a plan is derived from the request wording, not from a fixed checklist', () => {
  const plan = buildDeterministicPlan(request({
    requiredContent: [{ text: 'the latest incident statistics' }, { text: 'mean time to recovery' }]
  }));
  assert.equal(plan.degraded, true, 'a model-free plan is explicitly marked degraded');
  assert.equal(plan.reasoning, 'deterministic');
  const ids = plan.specs.map(spec => spec.criterionId);
  assert.ok(ids.includes('incident_stats'));
  assert.ok(ids.includes('as_of_date'), 'a "latest" request should be dateable');
  assert.ok(plan.specs.every(spec => spec.provider === 'document_text'));
  assert.ok(plan.specs.every(spec => spec.justification), 'every probe must cite the request');
});

test('a freshness probe is only added when the request asks for current content', () => {
  const without = buildDeterministicPlan(request({ text: 'Please update the Zephyr report with the incident statistics.' }));
  assert.equal(without.specs.some(spec => spec.criterionId === 'as_of_date'), false);
});

test('proposals naming an unregistered provider or strategy are rejected with a reason', () => {
  const base = request({ requiredContent: [{ text: 'vendor reconciliation notes' }] });
  const cases = [
    [{ concept: 'x', provider: 'the_internet', strategies: ['section_body'], keywords: ['vendor'], justification: 'the vendor reconciliation notes' }, /not registered/],
    [{ concept: 'x', provider: 'document_text', strategies: ['run_shell_command'], keywords: ['vendor'], justification: 'the vendor reconciliation notes' }, /unknown strategy/],
    [{ concept: 'x', provider: 'document_text', strategies: ['section_body'], keywords: ['vendor'], justification: 'a quote that is not in the request' }, /not a quotation/],
    [{ concept: '', provider: 'document_text', strategies: ['section_body'], keywords: ['vendor'], justification: 'the vendor reconciliation notes' }, /no concept/],
    [{ concept: 'x', provider: 'document_text', strategies: ['section_body'], keywords: [], justification: 'the vendor reconciliation notes' }, /no searchable keywords/]
  ];
  for (const [proposal, pattern] of cases) {
    const outcome = validateProposal(proposal, base);
    assert.equal(outcome.ok, false, `expected rejection for ${JSON.stringify(proposal)}`);
    assert.match(outcome.reason, pattern);
  }
});

test('a valid proposal is accepted and becomes a probe bound to a registered provider', () => {
  const base = request({ requiredContent: [{ text: 'vendor reconciliation notes' }] });
  const outcome = validateProposal({
    concept: 'vendor reconciliation status', criterionLabel: 'Vendor reconciliation status',
    provider: 'document_text', strategies: ['section_body'], keywords: ['reconciliation'],
    justification: 'the vendor reconciliation notes', expectedEvidence: 'a reconciliation section'
  }, base);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.spec.origin, 'model');
  assert.equal(outcome.spec.criterionId, 'model-vendor-reconciliation-status');
  assert.equal(outcome.spec.provider, 'document_text');
  assert.equal(outcome.spec.justified, true);
});

test('merging proposals deduplicates, records rejections, and never grows unbounded', () => {
  const base = request({ requiredContent: [{ text: 'vendor reconciliation notes' }] });
  const plan = buildDeterministicPlan(base);
  const valid = i => ({
    concept: `concept ${i}`, criterionLabel: `Concept ${i}`, provider: 'document_text',
    strategies: ['section_body'], keywords: [`keyword${i}`], justification: 'the vendor reconciliation notes'
  });
  const merged = applyModelProposals(plan, [
    valid(1), valid(1), // duplicate criterion slug
    { concept: 'bad', provider: 'the_internet', strategies: ['section_body'], keywords: ['x'], justification: 'the vendor reconciliation notes' },
    ...Array.from({ length: MAX_MODEL_PROBES + 3 }, (_, i) => valid(100 + i))
  ], base);
  assert.equal(merged.reasoning, 'deterministic+model');
  assert.ok(merged.specs.filter(spec => spec.origin === 'model').length <= MAX_MODEL_PROBES);
  assert.ok(merged.rejected.some(item => /not registered/.test(item.reason)));
  assert.ok(merged.rejected.some(item => /duplicates/.test(item.reason)));
  assert.ok(merged.rejected.every(item => typeof item.reason === 'string'));
});

test('the plan cache is bounded and reuses plans for identical requests', () => {
  const cache = new PlanCache({ max: 3 });
  const plan = buildDeterministicPlan(request());
  const signature = planSignature(request());
  assert.equal(cache.get(signature), null);
  cache.set(signature, plan);
  assert.equal(cache.get(signature), plan);
  for (let i = 0; i < 6; i += 1) cache.set(`sig-${i}`, plan);
  const described = cache.describe();
  assert.equal(described.size, 3);
  assert.ok(described.hits >= 1);
});

// ----------------------------------------------------------------- assessment

test('a blocked criterion is distinguished from an absent one', () => {
  const spec = { id: 'probe:x', criterionId: 'x', criterionLabel: 'X', provider: 'document_text', strategies: ['section_body'], keywords: ['x'], requiredKeywords: [], bounds: {} };
  const blocked = executeSpec(spec, { documents: [], runRecords: {} });
  assert.equal(blocked.state, 'blocked');
  const absent = executeSpec(spec, { documents: [documentWith('# Report\n\nNothing relevant.\n')], runRecords: {} });
  assert.equal(absent.state, 'not_satisfied');
});

test('an indicative mention yields unknown, not satisfied', () => {
  const spec = { id: 'probe:x', criterionId: 'x', criterionLabel: 'X', provider: 'document_text', strategies: ['keyword_presence'], keywords: ['reconciliation'], requiredKeywords: [], bounds: {} };
  const result = executeSpec(spec, { documents: [documentWith('We talked about reconciliation briefly.\n')], runRecords: {} });
  assert.equal(result.state, 'unknown');
  assert.match(result.note, /indicative/i);
  assert.ok(result.whatWouldResolveIt);
});

test('a qualifier keeps a found section unverified', () => {
  const spec = {
    id: 'probe:x', criterionId: 'x', criterionLabel: 'Testimonials', provider: 'document_text',
    strategies: ['section_body'], keywords: ['testimonials'], requiredKeywords: ['signed'], bounds: {}
  };
  const result = executeSpec(spec, {
    documents: [documentWith('## Testimonials\nCustomers say the new flow is much faster to complete.\n')], runRecords: {}
  });
  assert.equal(result.state, 'unknown');
  assert.match(result.note, /not marked as signed/);
});

test('a broad word in the request still requires content about the named thing', () => {
  const plan = buildDeterministicPlan(request({ requiredContent: [{ text: 'the outage statistics' }] }));
  const spec = plan.specs.find(item => (item.requiredAnyKeywords || []).length > 0);
  assert.ok(spec, 'the distinguishing word survives into the plan');
  assert.ok(
    spec.requiredAnyKeywords.some(keyword => keyword.includes('incident') || keyword.includes('outage')),
    'it is kept as incident vocabulary rather than dropped or demanded literally'
  );

  const generic = executeSpec(spec, {
    documents: [documentWith('# Zephyr incident analysis\n\n## Statistics\nRevenue grew 12% quarter over quarter.\n')], runRecords: {}
  });
  assert.equal(generic.state, 'unknown', 'a generic statistics section is not outage statistics');
  assert.match(generic.note, /nothing tying it to/);
  assert.equal(generic.evidence.length, 1, 'what was found stays visible as evidence');

  const incident = executeSpec(spec, {
    documents: [documentWith('# Zephyr incident analysis\n\n## Incident statistics\nIncident count: 11\nMean time to recovery: 29 minutes\n')], runRecords: {}
  });
  assert.equal(incident.state, 'satisfied');
});

test('a broad match does not stop the search for the named content', () => {
  const plan = buildDeterministicPlan(request({ requiredContent: [{ text: 'the revenue figures' }] }));
  const spec = plan.specs.find(item => (item.requiredAnyKeywords || []).includes('revenue'));
  assert.ok(spec, 'revenue is the distinguishing word for revenue figures');

  const namedLater = executeSpec(spec, {
    documents: [documentWith('# Zephyr report\n\nMetrics: 12\n\n## Revenue figures\nGrowth was strong this quarter across all regions.\n')], runRecords: {}
  });
  assert.equal(namedLater.state, 'satisfied', 'the section that names the content is found after a broad match');
  assert.equal(namedLater.evidence[0].strength, 'direct');

  const broadOnly = executeSpec(spec, {
    documents: [documentWith('# Zephyr report\n\nMetrics: 12\n')], runRecords: {}
  });
  assert.equal(broadOnly.state, 'unknown', 'found-but-not-named content stays unknown, never not_satisfied');
  assert.match(broadOnly.note, /nothing tying it to/);
});

test('an earlier document that only matches broadly does not hide a later qualifying one', () => {
  const plan = buildDeterministicPlan(request({ requiredContent: [{ text: 'the revenue figures' }] }));
  const spec = plan.specs.find(item => (item.requiredAnyKeywords || []).includes('revenue'));
  const broad = { id: 'doc-broad', title: 'Zephyr report', kind: 'report', version: 1, modifiedAt: '2026-10-16T09:00:00.000Z', content: 'Metrics: 12\n' };
  const named = { id: 'doc-named', title: 'Zephyr report', kind: 'report', version: 2, modifiedAt: '2026-10-16T10:00:00.000Z', content: '## Revenue figures\nGrowth was strong this quarter across all regions.\n' };
  const result = executeSpec(spec, { documents: [broad, named], runRecords: {} });
  assert.equal(result.state, 'satisfied');
  assert.equal(result.evidence[0].source.id, 'doc-named', 'the qualifying document is cited');
});

test('completion is derived from criterion states and always reports blockers', () => {
  const satisfied = { id: 'a', label: 'A', required: true, status: 'satisfied', evidence: [] };
  const missing = { id: 'b', label: 'B', required: true, status: 'not_satisfied', evidence: [] };
  const optional = { id: 'c', label: 'C', required: false, status: 'not_satisfied', evidence: [] };

  assert.equal(completionFromCriteria([satisfied, optional]).complete, true);
  assert.equal(completionFromCriteria([satisfied, missing]).complete, false);
  assert.equal(completionFromCriteria([]).complete, false);

  const blocked = completionFromCriteria([satisfied, missing], { blockers: [{ id: 'no_document', detail: 'No document.' }] });
  assert.equal(blocked.complete, false);
  assert.deepEqual(blocked.blockers.map(item => item.id), ['no_document']);
  assert.match(blocked.reason, /No document/);
});

test('assessment records the probe that produced each criterion', () => {
  const plan = buildDeterministicPlan(request({ requiredContent: [{ text: 'the latest incident statistics' }] }));
  const { criteria, observations } = assessPlan(plan, { documents: [documentWith('## Incident statistics\nIncident count: 14\n')], runRecords: {} });
  assert.ok(criteria.length > 0);
  assert.ok(observations.some(item => item.id === 'search_scope'));
  for (const item of criteria) {
    assert.ok(CRITERION_STATES.includes(item.status));
    assert.ok(item.probe, 'each criterion must carry its probe');
    assert.ok(item.probe.provider);
    assert.ok(item.probe.origin);
  }
});

// --------------------------------------------------------------------- budget

test('the reasoning budget bounds per-request calls, concurrency and rate', () => {
  let now = 0;
  const budget = new ReasoningBudget({ maxCallsPerRequest: 1, maxConcurrent: 2, maxCallsPerMinute: 3 }, () => now);

  assert.equal(budget.tryAcquire('r1').ok, true);
  assert.equal(budget.tryAcquire('r1').ok, false, 'a second call for the same request must be refused');
  assert.match(budget.tryAcquire('r1').reason, /budget exhausted/);

  assert.equal(budget.tryAcquire('r2').ok, true);
  assert.equal(budget.tryAcquire('r3').ok, false, 'concurrency limit should refuse the third in-flight call');
  assert.match(budget.tryAcquire('r3').reason, /concurrency/);

  budget.release();
  budget.release();
  assert.equal(budget.tryAcquire('r4').ok, true);

  now = 61000; // a new window
  assert.equal(budget.tryAcquire('r5').ok, true);
  assert.equal(budget.describe().limits.maxCallsPerRequest, 1);
  assert.ok(budget.describe().recentRejections.length > 0);
});

test('budget limits have safe defaults', () => {
  assert.equal(REASONING_LIMITS.maxCallsPerRequest, 1);
  assert.ok(REASONING_LIMITS.timeoutMs <= 60000);
  assert.ok(REASONING_LIMITS.maxRequestChars > 0 && REASONING_LIMITS.maxResponseChars > 0);
});

test('a request that needs no model yields no probe proposals at all', () => {
  // The engine only asks a model when the deterministic plan leaves gaps; a plan
  // with no unverifiable content and specific specs needs no help.
  const plan = buildDeterministicPlan(request({ requiredContent: [{ text: 'experiment results' }] }));
  assert.equal(plan.unverifiable.length, 0);
  assert.ok(plan.specs.some(spec => spec.origin === 'builtin'));
  assert.ok(plan.specs.some(spec => spec.builtinProbe));
});

test('request interpretation is unchanged for the original experiment wording', () => {
  const interpreted = interpretRequest({
    id: 'm1', from: 'a@b.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send it by Friday.'
  });
  assert.equal(interpreted.subjectEntity, 'Northstar');
  assert.equal(interpreted.deliverable, 'proposal');
  assert.equal(interpreted.intent, 'update_and_send');
});
