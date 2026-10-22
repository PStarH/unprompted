import { findJustification, isVerbatimQuote } from './probes/lexicon.js';
import { EVENT_TYPES } from './connectors/events.js';
import { CRITERION_STATES } from './probes/assess.js';
import { ACTION_CLASSES } from './permissions.js';
import { NOTIFICATION_KINDS, PRIORITY_RANK } from './notifications.js';
import { CALIBRATION_KINDS, CALIBRATION_SOURCES, CONFIDENCE } from './calibration.js';
import { TRACE_STAGES } from './trace.js';
import { VERIFICATION_DEPTHS, VERIFICATION_OUTCOMES } from './verification.js';

/**
 * Core data contracts.
 *
 * The six layers of the framework hand work to each other through a small set of
 * artefacts: an event, a request, an evidence item, a criterion, a probe spec, an
 * action, an execution record, a notification, an opportunity and a calibration
 * entry. Before this module those shapes existed only implicitly — each module
 * read whatever fields it needed, so a renamed or dropped field surfaced as a
 * runtime crash deep inside an unrelated layer rather than as a contract
 * violation at the boundary.
 *
 * This module states each shape once, in one place, and provides a validator so
 * the claim can be checked against real artefacts rather than trusted. Enums are
 * imported from the module that owns them, never re-declared, so there is exactly
 * one source of truth per vocabulary.
 *
 * It also states the one contract that spans two layers: **what a probe is
 * allowed to cite**. See `requestQuotationTexts` below.
 */

export const CONTRACT_VERSION = 1;

const INTENTS = ['update', 'send', 'update_and_send', 'informational'];
const INTERPRETATIONS = ['deterministic', 'deterministic+model', 'model', 'migrated'];
const PLAN_ORIGINS = ['builtin', 'lexicon', 'derived', 'model', 'freshness'];
const STRENGTHS = ['direct', 'indicative'];
const EFFORT = ['low', 'medium', 'high'];
const OPPORTUNITY_STATUSES = ['proposed', 'parked', 'accepted', 'dismissed', 'resolved'];
const EXPLORATION_VERDICTS = ['supported', 'inconclusive', 'resolved'];

const string = (options = {}) => ({ type: 'string', ...options });
const object = (fields, options = {}) => ({ type: 'object', fields, ...options });

/**
 * A cross-field rule: at least one alternative must be present and non-empty.
 *
 * Some invariants are not field-local. A probe spec, for example, must declare
 * *how* it will be executed — either a set of strategies, or a built-in probe —
 * and neither field alone carries that requirement.
 */
const anyOf = alternatives => ({ requireAny: alternatives });
const array = (of, options = {}) => ({ type: 'array', of, ...options });
const value = (options = {}) => ({ ...options });

const sourceRef = object({ kind: string({ required: true }), id: string({ required: true }) });

/**
 * The canonical shapes.
 *
 * `required` marks a field another layer genuinely depends on. Optional fields
 * are those a layer may legitimately not have yet (a deadline nobody stated, a
 * probe with no constraints).
 */
export const CONTRACTS = {
  event: object({
    id: string({ required: true, minLength: 1 }),
    type: string({ required: true, enum: EVENT_TYPES }),
    at: string({ required: true }),
    source: string({ required: true }),
    connectorId: string({ required: true }),
    payload: object({}, { required: true }),
    disposition: string({ required: true })
  }),

  request: object({
    id: string({ required: true }),
    intent: string({ required: true, enum: INTENTS }),
    deliverable: string({ required: true }),
    subjectEntity: string({ required: true }),
    // The request's own wording. A request with no text cannot be justified
    // against, so it is empty by contract as well as in practice.
    text: string({ required: true, minLength: 1 }),
    source: object({ kind: string({ required: true }), id: string({ required: true }) }, { required: true }),
    interpretedBy: string({ required: true, enum: INTERPRETATIONS }),
    requiredContent: array(object({ text: string({ required: true }) })),
    impliedClaims: array(object({ id: string({ required: true }) })),
    deadline: value() // { text, iso, kind } or null
  }),

  evidenceItem: object({
    source: { ...sourceRef, required: true },
    strength: string({ enum: STRENGTHS })
  }),

  criterion: object({
    id: string({ required: true }),
    label: string({ required: true }),
    required: { type: 'boolean', required: true },
    status: string({ required: true, enum: CRITERION_STATES }),
    evidence: array({ type: 'object' }, { required: true }),
    probe: object({
      id: string({ required: true }),
      origin: string({ required: true, enum: PLAN_ORIGINS }),
      provider: string({ required: true })
    })
  }),

  verification: object({
    depth: string({ required: true, enum: VERIFICATION_DEPTHS }),
    // At least one reason must be stated: a depth with no basis would be a
    // level assigned rather than a decision explained.
    basis: array(object({
      code: string({ required: true }),
      detail: string({ required: true })
    }), { required: true, minItems: 1 }),
    checkedDocuments: array(string(), { required: true }),
    performed: array(object({
      documentId: string({ required: true }),
      documentVersion: value(),
      criterionId: string({ required: true }),
      outcome: string({ required: true, enum: VERIFICATION_OUTCOMES })
    }), { required: true }),
    at: string({ required: true })
  }),

  planSpec: object({
    id: string({ required: true }),
    criterionId: string({ required: true }),
    criterionLabel: string({ required: true }),
    concept: string(),
    provider: string({ required: true }),
    // A built-in probe declares `builtinProbe` and needs no strategy; a
    // request-derived or model probe declares strategies. One of the two must be
    // present, which is what `requireAny` enforces.
    strategies: array(string(), { required: true }),
    builtinProbe: value(),
    keywords: array(string(), { required: true }),
    origin: string({ required: true, enum: PLAN_ORIGINS }),
    justified: { type: 'boolean', required: true },
    expectedEvidence: string()
  }, anyOf([['strategies'], ['builtinProbe']])),

  action: object({
    id: string({ required: true }),
    idempotencyKey: string({ required: true }),
    actionClass: string({ required: true, enum: ACTION_CLASSES }),
    permission: string({ required: true, enum: ['user_approved', 'pre_authorized'] }),
    status: string({ required: true })
  }),

  notification: object({
    id: string({ required: true }),
    kind: string({ required: true, enum: NOTIFICATION_KINDS }),
    priority: string({ required: true, enum: Object.keys(PRIORITY_RANK) }),
    what: string({ required: true, minLength: 1 }),
    why: string({ required: true, minLength: 1 }),
    decision: string({ required: true, minLength: 1 }),
    checked: array(string(), { required: true, minItems: 1 }),
    at: string({ required: true })
  }),

  opportunity: object({
    id: string({ required: true }),
    kind: string({ required: true }),
    statement: string({ required: true }),
    benefit: string({ required: true, enum: EFFORT }),
    verificationCost: string({ required: true, enum: EFFORT }),
    // Benefit, cost *and* risk must be weighed together; an
    // opportunity that omitted risk could not satisfy the decision gate.
    risk: string({ required: true, enum: EFFORT }),
    status: string({ required: true, enum: OPPORTUNITY_STATUSES }),
    evidence: array({ type: 'object' }, { required: true }),
    exploration: object({ verdict: string({ required: true, enum: EXPLORATION_VERDICTS }) }, { required: true })
  }),

  trace: object({
    id: string({ required: true }),
    at: string({ required: true }),
    stage: string({ required: true, enum: TRACE_STAGES }),
    // A stage must be able to say what it saw and what it produced.
    input: object({}, { required: true }),
    outcome: object({}, { required: true }),
    taskId: string()
  }),

  calibration: object({
    id: string({ required: true }),
    key: string({ required: true }),
    kind: string({ required: true, enum: CALIBRATION_KINDS }),
    value: value({ required: true }),
    source: string({ required: true, enum: CALIBRATION_SOURCES }),
    confidence: string({ required: true, enum: Object.values(CONFIDENCE) }),
    scope: object({}, { required: true }),
    at: string({ required: true })
  })
};

const isNonEmpty = item => {
  if (item == null) return false;
  if (Array.isArray(item)) return item.length > 0;
  if (typeof item === 'string') return item.trim().length > 0;
  return true;
};

function checkValue(sample, spec, path, problems) {
  if (sample == null) {
    if (spec.required) problems.push(`${path} is required but was ${sample === null ? 'null' : 'missing'}`);
    return;
  }

  // An enum applies to whatever the field is, including a typed one: an event
  // type is a string *and* a member of the event vocabulary, and checking only
  // the first would let an unknown event type through.
  if (spec.enum && !spec.enum.includes(sample)) {
    problems.push(`${path} must be one of ${spec.enum.join(', ')} (got ${JSON.stringify(sample)})`);
  }

  switch (spec.type) {
    case 'string':
      if (typeof sample !== 'string') { problems.push(`${path} must be a string`); return; }
      if (spec.minLength && sample.trim().length < spec.minLength) problems.push(`${path} must not be empty`);
      return;
    case 'boolean':
      if (typeof sample !== 'boolean') problems.push(`${path} must be a boolean`);
      return;
    case 'object': {
      if (typeof sample !== 'object' || Array.isArray(sample)) { problems.push(`${path} must be an object`); return; }
      for (const [field, fieldSpec] of Object.entries(spec.fields || {})) {
        checkValue(sample[field], fieldSpec, `${path}.${field}`, problems);
      }
      if (spec.requireAny) {
        const satisfied = spec.requireAny.some(alternative => alternative.every(field => isNonEmpty(sample[field])));
        if (!satisfied) {
          const described = spec.requireAny.map(alternative => alternative.join(' + ')).join(' or ');
          problems.push(`${path} must provide ${described}`);
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(sample)) { problems.push(`${path} must be an array`); return; }
      if (spec.minItems && sample.length < spec.minItems) problems.push(`${path} needs at least ${spec.minItems} item(s)`);
      if (spec.of) sample.forEach((item, index) => checkValue(item, spec.of, `${path}[${index}]`, problems));
      return;
    }
    default:
      return;
  }
}

/**
 * Validate an artefact against a named contract.
 * Returns { ok, contract, problems } — never throws, so it is safe to call on
 * anything, including data that failed to build.
 */
export function validateContract(name, sample) {
  const contract = CONTRACTS[name];
  if (!contract) return { ok: false, contract: name, problems: [`unknown contract: ${name}`] };
  const problems = [];
  checkValue(sample, contract, name, problems);
  if (contract.type === 'object' && (typeof sample !== 'object' || sample === null || Array.isArray(sample))) {
    return { ok: false, contract: name, problems: [`${name} must be an object`] };
  }
  return { ok: problems.length === 0, contract: name, problems };
}

/** Validate many artefacts of one kind at once, keeping the failing samples. */
export function validateAll(name, samples) {
  const failures = [];
  for (const sample of samples || []) {
    const result = validateContract(name, sample);
    if (!result.ok) failures.push({ sample, problems: result.problems });
  }
  return { contract: name, checked: (samples || []).length, failures, ok: failures.length === 0 };
}

export function describeContracts() {
  return Object.entries(CONTRACTS).map(([name, contract]) => ({
    name,
    version: CONTRACT_VERSION,
    fields: Object.keys(contract.fields || {})
  }));
}

/**
 * The request-quoting contract.
 *
 * A probe must be able to cite the request it came from, or it is not a probe —
 * it is a search nobody asked for. The open question is *what counts as the
 * request*, and the answer has to be the same in both layers that need it: the
 * deterministic planner that derives probes, and the validator that screens a
 * model's proposals.
 *
 * The request is its raw text **plus its declared required content**. That is not
 * a concession: `requiredContent` is produced by interpreting the request, and it
 * is the structured statement of what the user asked for. A probe citing "the
 * vendor reconciliation notes" is citing the request whether the phrase was
 * stored in `text` or in `requiredContent`.
 *
 * Each source is returned separately so a citation can record *which* it came
 * from — `request_text` is a direct quotation, `declared_content` is a quotation
 * of the interpreted ask.
 */
export function requestQuotationTexts(request) {
  const texts = [];
  if (request?.text) texts.push(String(request.text));
  for (const item of request?.requiredContent || []) {
    const text = typeof item === 'string' ? item : item?.text;
    if (text) texts.push(String(text));
  }
  return texts.filter(Boolean);
}

/**
 * A leading determiner is not load-bearing in a citation.
 *
 * This is not leniency for its own sake: `extractRequiredContent` strips a
 * leading article when it records required content ("with the vendor
 * reconciliation notes" is stored as "vendor reconciliation notes"). A model
 * quoting the email's actual words would therefore never match the stored ask
 * unless the comparison applies the same normalisation. Both directions are
 * tried, so "the vendor reconciliation notes" and "vendor reconciliation notes"
 * are the same citation, while "a quote that is not in the request" still is not.
 */
const LEADING_DETERMINER = /^(?:the|a|an|this|that|these|those|our|your|its|their|my|his|her)\s+/i;

export function citationForms(quote) {
  const text = String(quote || '').trim();
  if (!text) return [];
  const stripped = text.replace(LEADING_DETERMINER, '').trim();
  return stripped && stripped !== text ? [text, stripped] : [text];
}

/** True when `quote` genuinely occurs in the request's text or declared content. */
export function isRequestQuotation(request, quote) {
  const forms = citationForms(quote).filter(form => form.length >= 3);
  if (!forms.length) return false;
  const sources = requestQuotationTexts(request);
  return sources.some(text => forms.some(form => isVerbatimQuote(text, form)));
}

/**
 * Locate the span of the request that justifies a phrase, preferring the raw
 * text so a direct quotation is reported as such, and falling back to the
 * declared content.
 */
export function justifyRequestContent(request, phrase) {
  const forms = citationForms(phrase);
  for (const form of forms) {
    const direct = findJustification(request?.text, form);
    if (direct) return { span: direct, source: 'request_text' };
  }
  for (const item of request?.requiredContent || []) {
    const text = typeof item === 'string' ? item : item?.text;
    if (!text) continue;
    for (const form of forms) {
      const declared = findJustification(text, form);
      if (declared) return { span: declared, source: 'declared_content' };
    }
  }
  return { span: null, source: null };
}

export const contractsApi = {
  CONTRACT_VERSION, CONTRACTS, validateContract, validateAll, describeContracts,
  requestQuotationTexts, citationForms, isRequestQuotation, justifyRequestContent
};
