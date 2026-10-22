/**
 * Criteria assessment.
 *
 * This module is the stable entry point for content assessment. It composes:
 *
 *   probes/builtin.js   the original six probes, unchanged
 *   probes/plan.js      request-driven probe planning
 *   probes/assess.js    bounded execution with explicit criterion states
 *
 * The built-in exports are re-exported here so existing callers and tests keep
 * working unchanged.
 */

export {
  PROBES, findResultsScope, resolveRequiredContent,
  assessAgainstCriteria, criteriaToHumanStrings, missingLabels
} from './probes/builtin.js';

export { excerpt } from './evidence.js';

export { buildDeterministicPlan, applyModelProposals, planSignature, PlanCache, validateProposal } from './probes/plan.js';
export { assessPlan, executeSpec, completionFromCriteria, CRITERION_STATES } from './probes/assess.js';
export { CONCEPTS, conceptFor, matchConcepts, deriveKeywords, findJustification, isVerbatimQuote } from './probes/lexicon.js';
export { STRATEGIES, STRATEGY_IDS } from './probes/strategies.js';
export { PROVIDERS, PROVIDER_IDS, describeProviders, QUERY_BOUNDS } from './probes/providers.js';

import { assessPlan, completionFromCriteria } from './probes/assess.js';
import { buildDeterministicPlan } from './probes/plan.js';
import { missingLabels, criteriaToHumanStrings, assessAgainstCriteria } from './probes/builtin.js';

/**
 * Convenience wrapper: build a deterministic plan for a request and assess it.
 * Used by callers that do not need to hold on to the plan.
 */
export function assessRequest(request, context) {
  const plan = buildDeterministicPlan(request);
  const { criteria, observations } = assessPlan(plan, context);
  return { plan, criteria, observations, completion: completionFromCriteria(criteria) };
}

export const criteriaApi = {
  missingLabels, criteriaToHumanStrings, assessAgainstCriteria, assessRequest, assessPlan, completionFromCriteria
};
