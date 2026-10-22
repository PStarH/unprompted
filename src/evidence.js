import crypto from 'node:crypto';

/**
 * Evidence model.
 *
 * Every decision the system makes must be traceable to something it actually
 * observed. This module defines the small vocabulary used throughout:
 *
 *   - EvidenceItem  : a single observed fact, always carrying a source reference
 *   - Criterion     : one acceptance criterion for a request, plus its evidence
 *   - Claim         : a statement the system would make on the user's behalf,
 *                     marked supported or unsupported
 *   - Unknown       : something the system explicitly cannot establish
 *   - EvidenceBundle: the whole picture for one task, separating
 *                     requested / observed / inferred / unknown
 */

const MAX_EXCERPT = 320;

/** Trim an excerpt so stored evidence stays readable and bounded. */
export function excerpt(text, limit = MAX_EXCERPT) {
  if (typeof text !== 'string') return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/**
 * A source reference must be concrete: a stable identifier plus, where
 * available, a version and timestamp. We refuse to build evidence without one
 * so that no claim can end up citing a source that does not exist.
 */
export function sourceRef({ kind, id, version = null, timestamp = null, url = null, locator = null }) {
  if (!kind || !id) throw new Error('Evidence requires a source kind and id');
  return { kind, id, version, timestamp, url, locator };
}

export function evidenceItem({ source, excerptText = null, detail = null, strength = 'direct' }) {
  if (!source?.kind || !source?.id) throw new Error('Evidence item requires a source reference');
  return { source, excerpt: excerpt(excerptText), detail, strength };
}

/**
 * A criterion is one acceptance requirement plus the evidence bearing on it.
 * `status` is one of the criterion states defined in probes/assess.js; extra
 * metadata (the probe that produced it, evidence strength) is carried through
 * so the interface can explain *why* a criterion landed in that state.
 */
export function criterion({ id, label, kind = 'content', required = true, status = 'not_satisfied', evidence = [], note = null, ...rest }) {
  return { id, label, kind, required, status, evidence, note, ...rest };
}

/**
 * Claims are what the system intends to tell the user or send externally.
 * `supported` must be justified by evidence; an unsupported claim is never
 * allowed into an outbound draft.
 */
export function claim({ id, text, supported, basis = [], note = null }) {
  return { id, text, supported: Boolean(supported), basis, note };
}

export function unknownItem({ id, question, reason, whatWouldResolveIt }) {
  return { id, question, reason, whatWouldResolveIt };
}

/** A stable signature of the inputs that produced an assessment. */
export function evidenceSignature(parts) {
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * Guard used before any outbound text is generated: strip or reject claims that
 * the evidence does not support. This is the mechanism that prevents the system
 * from asserting "latest results" when freshness is unknown.
 */
export function unsupportedClaims(claims) {
  return (claims || []).filter(item => !item.supported);
}

export function claimTextIsAllowed(text, claims) {
  const unsupported = unsupportedClaims(claims);
  return unsupported.every(item => !new RegExp(item.forbiddenPattern || item.text, 'i').test(text));
}

/** Human-readable one-line summary of an evidence item, for the interface. */
export function describeEvidence(item) {
  const source = item.source;
  const where = [source.id, source.version != null ? `v${source.version}` : null, source.timestamp].filter(Boolean).join(' · ');
  return item.detail ? `${item.detail} (${where})` : `${item.excerpt || 'observed'} (${where})`;
}

export const evidenceApi = {
  excerpt, sourceRef, evidenceItem, criterion, claim, unknownItem,
  evidenceSignature, unsupportedClaims, claimTextIsAllowed, describeEvidence
};
