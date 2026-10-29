import { unquotedMessageFields } from '../commitments.js';

export const PAIR_EVALUATOR_VERSION = 1;
export const UNATTACHED_WINDOW_MS = 72 * 60 * 60 * 1000;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const bounded = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Treat model output as a proposal; every positive relationship needs a
 * non-quoted source span from each Event. It cannot grant write authority. */
export function validatePairAssessment(result, events) {
  if (!exactKeys(result, ['outcome', 'summary', 'missingEvidence', 'reevaluationCondition', 'evidence', 'confidence'])
    || !['UNRELATED', 'RELATED_WAIT', 'ACTIONABLE'].includes(result.outcome)
    || !Array.isArray(result.evidence) || result.evidence.length > 8
    || !Array.isArray(result.missingEvidence) || result.missingEvidence.length > 8 || result.missingEvidence.some(item => !bounded(item, 300))
    || result.confidence != null && (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1)
    || result.summary != null && !bounded(result.summary, 500)
    || result.reevaluationCondition != null && !bounded(result.reevaluationCondition, 300)) return null;
  const byId = new Map(events.map(event => [event.id, unquotedMessageFields(event.payload)]));
  for (const item of result.evidence) {
    if (!exactKeys(item, ['eventId', 'field', 'quote']) || !byId.has(item.eventId) || !['subject', 'body'].includes(item.field) || !bounded(item.quote, 300)
      || !String(byId.get(item.eventId)[item.field] || '').includes(item.quote)) return null;
  }
  if (result.outcome !== 'UNRELATED') {
    if (!bounded(result.summary, 500) || !events.every(event => result.evidence.some(item => item.eventId === event.id))) return null;
    if (result.outcome === 'RELATED_WAIT' && (!result.missingEvidence.length || !bounded(result.reevaluationCondition, 300))) return null;
  }
  return { outcome: result.outcome, summary: result.summary || null, missingEvidence: result.missingEvidence,
    reevaluationCondition: result.reevaluationCondition || null, evidence: result.evidence, confidence: result.confidence ?? null };
}
