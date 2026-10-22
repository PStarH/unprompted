/**
 * Correlation.
 *
 * Decides whether a document is the deliverable a request refers to.
 *
 * The governing rule: a shared generic noun ("proposal", "report", "review") is
 * never enough. A document only correlates when an **identity signal** connects
 * it to the request:
 *
 *   identity (required for a match)
 *     - the request links to this exact document
 *     - the request's entity appears in the title or the body
 *     - the request names the document (full title, or two distinctive title words)
 *     - a participant in the request is named in the document
 *
 *   topical (ranking only, never sufficient)
 *     - the deliverable noun or kind matches
 *     - the document's headings overlap the request's requested concepts
 *     - the document was modified after the request arrived
 *
 * Semantic overlap therefore raises and orders candidates — a request about
 * "reliability" can find a document titled "Production Reliability Review" — but
 * it can never, on its own, declare a document related. That is what keeps a
 * differently-worded document findable while an unrelated document with the same
 * generic noun stays out.
 */

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Title words that carry no identity. */
const TITLE_GENERIC = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'from', 'with',
  'project', 'proposal', 'report', 'deck', 'plan', 'memo', 'brief', 'summary', 'document', 'doc',
  'review', 'update', 'draft', 'final', 'v1', 'v2', 'copy', 'notes', 'overview', 'analysis',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'
]);

/**
 * Tokens that name the medium rather than the work.
 * "Email" or "app" appearing in a document is not an identity link.
 */
const ENTITY_GENERIC = new Set([
  ...TITLE_GENERIC,
  'email', 'mail', 'message', 'messages', 'sent', 'send', 'app', 'apps',
  'account', 'accounts', 'reader', 'readers', 'https', 'http', 'www', 'link', 'url', 'newsletter'
]);

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 1);
}

function containsAllTokens(haystack, needleTokens) {
  if (!needleTokens.length) return false;
  const hay = new Set(tokens(haystack));
  return needleTokens.every(token => hay.has(token));
}

/** A whole word, not a letter sequence inside a longer token or a tracking id. */
function containsWord(haystack, word) {
  if (!word) return false;
  return new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(String(haystack));
}

/** Distinctive words in a title, used for the "request names this document" signal. */
export function distinctiveTitleTokens(title) {
  return [...new Set((String(title || '').match(/\b[A-Za-z][\w'-]{2,}\b/g) || [])
    .map(word => word.toLowerCase())
    .filter(word => !TITLE_GENERIC.has(word)))];
}

/** Heading titles in a document, used for topical overlap. */
function headingsOf(content) {
  return (String(content || '').match(/^#{1,6}\s*(.+)$/gm) || [])
    .map(line => line.replace(/^#+\s*/, '').trim().toLowerCase());
}

/** Requested concepts, as lowercase words, from the request's required content. */
function requestedConceptWords(request) {
  const words = new Set();
  for (const item of request.requiredContent || []) {
    for (const token of tokens(item.text || item)) words.add(token);
  }
  return [...words];
}

/**
 * Names by which the request's participants are known, for the participant
 * signal: the local part of an address, or a name mentioned in the body.
 */
function participantNames(request) {
  const names = new Set();
  for (const address of [request.source?.from, request.source?.to].filter(Boolean)) {
    const local = String(address).split('@')[0];
    if (local && local.length > 2) names.add(local.toLowerCase());
    const words = String(address).split('@')[0].split(/[._-]+/).filter(word => word.length > 2);
    for (const word of words) names.add(word.toLowerCase());
  }
  return [...names];
}

/**
 * Signal weights.
 *
 * Identity signals establish *which* document this is and are the only thing
 * that can produce a match. Topical signals only order candidates. Keeping the
 * two scores separate is what lets a differently-titled document be found
 * (identity is enough on its own) while a document with no identity link can
 * never be related, however topically similar it looks.
 */
const IDENTITY_WEIGHTS = {
  explicit_link: 0.85,
  title_named: 0.6,
  entity_in_title: 0.55,
  entity_in_body: 0.5,
  participant: 0.4
};
const TOPICAL_WEIGHTS = {
  deliverable_in_title: 0.15,
  kind_match: 0.05,
  modified_after_request: 0.05
};
const IDENTITY_CAP = 0.85;
const TOPICAL_CAP = 0.45;
/** Minimum identity evidence for a match; topical overlap alone never qualifies. */
const IDENTITY_FLOOR = 0.5;
const MATCH_FLOOR = 0.5;
/** Candidates whose identity evidence differs by less than this are ambiguous. */
const AMBIGUITY_TOLERANCE = 0.15;

export function correlate(request, document) {
  const empty = {
    score: 0, identityScore: 0, topicalScore: 0, reasons: [], matched: false, entityEvidence: false,
    identitySignals: [], topicalSignals: [], contradictions: []
  };
  if (!document?.id || !request) return empty;

  const title = document.title || '';
  const content = String(document.content || '').slice(0, 6000);
  const requestText = String(request.text || `${request.source?.subject || ''} ${request.requiredContent?.map(item => item.text).join(' ') || ''}`);
  const entityTokens = tokens(request.subjectEntity);

  const identitySignals = [];
  const topicalSignals = [];
  const contradictions = [];
  let identityScore = 0;
  let topicalScore = 0;

  const addIdentity = (id, detail, weight = IDENTITY_WEIGHTS[id]) => {
    identityScore += weight;
    identitySignals.push({ id, detail, weight });
  };
  const addTopical = (id, detail, weight = TOPICAL_WEIGHTS[id]) => {
    topicalScore += weight;
    topicalSignals.push({ id, detail, weight });
  };

  // ---------------------------------------------------------------- identity
  const explicitLink = Boolean(request.explicitDocumentUrl) && (
    document.url === request.explicitDocumentUrl ||
    document.externalId === request.explicitDocumentUrl ||
    (document.url && String(request.explicitDocumentUrl).endsWith(document.url))
  );
  if (explicitLink) addIdentity('explicit_link', 'The request links to this exact document.');

  const entityInTitle = containsAllTokens(title, entityTokens);
  const entityInBody = containsAllTokens(content, entityTokens);
  // A generic token such as "email" can occur in any document. It is recorded
  // as presence above for contradiction checks, and it is not an identity link.
  const entityIsSpecific = entityTokens.some(token => !ENTITY_GENERIC.has(token));
  if (entityIsSpecific && entityInTitle) addIdentity('entity_in_title', `The title names ${request.subjectEntity}.`);
  else if (entityIsSpecific && entityInBody) addIdentity('entity_in_body', `The document content names ${request.subjectEntity}.`);

  const distinctive = distinctiveTitleTokens(title);
  const titleWordsInRequest = distinctive.filter(word => containsWord(requestText, word));
  // A bare generic title ("Proposal") must never count as being named, so the
  // verbatim form requires at least one distinctive word and real length.
  const fullTitleNamed = distinctive.length > 0 && title.trim().length >= 12 &&
    requestText.toLowerCase().includes(title.trim().toLowerCase());
  if (fullTitleNamed) {
    addIdentity('title_named', 'The request names this document.');
  } else if (titleWordsInRequest.length >= 2) {
    addIdentity('title_named', `The request names this document (“${titleWordsInRequest.join('”, “')}”).`);
  }

  const participants = participantNames(request);
  const participantInDocument = participants.filter(name => tokens(`${title} ${content}`).includes(name));
  if (participantInDocument.length) {
    addIdentity('participant', `A request participant (${participantInDocument.join(', ')}) appears in the document.`);
  }

  // ---------------------------------------------------------------- topical
  const deliverableInTitle = request.deliverable &&
    new RegExp(`\\b${escapeRegex(request.deliverable)}\\b`, 'i').test(title);
  if (deliverableInTitle) addTopical('deliverable_in_title', `The title names it as a ${request.deliverable}.`);

  if (document.kind && request.deliverable &&
      String(document.kind).toLowerCase() === String(request.deliverable).toLowerCase()) {
    addTopical('kind_match', `The document kind matches “${request.deliverable}”.`);
  }

  const headings = headingsOf(content);
  const conceptWords = requestedConceptWords(request);
  const headingOverlap = [...new Set(conceptWords.filter(word =>
    word.length > 4 && headings.some(heading => heading.includes(word))))];
  if (headingOverlap.length) {
    topicalScore += Math.min(0.25, 0.08 * headingOverlap.length);
    topicalSignals.push({ id: 'heading_overlap', weight: Math.min(0.25, 0.08 * headingOverlap.length),
      detail: `Requested concepts appear as headings: ${headingOverlap.join(', ')}.` });
  }

  const requestTime = Date.parse(request.source?.receivedAt || '') || null;
  const modifiedTime = Date.parse(document.modifiedAt || '') || null;
  if (requestTime && modifiedTime && modifiedTime >= requestTime) {
    addTopical('modified_after_request', 'The document was modified after the request arrived.');
  }

  // ------------------------------------------------------------- contradicting
  const titleEntities = distinctiveTitleTokens(title);
  const titleNamesSomethingElse = titleEntities.length > 0 && !titleEntities.some(word => entityTokens.includes(word));
  if (titleNamesSomethingElse && !entityInBody && !explicitLink && !fullTitleNamed) {
    contradictions.push({
      id: 'title_names_other_entity',
      detail: `The title names “${titleEntities[0]}” while the request concerns ${request.subjectEntity}, which does not appear in the document.`
    });
  }

  const cappedIdentity = Math.min(IDENTITY_CAP, identityScore);
  const cappedTopical = Math.min(TOPICAL_CAP, topicalScore);
  const score = Math.min(1, Math.round((cappedIdentity + cappedTopical) * 100) / 100);
  const entityEvidence = cappedIdentity >= IDENTITY_FLOOR;
  // Topical signals alone can never produce a match.
  const matched = entityEvidence && score >= MATCH_FLOOR;

  return {
    score,
    identityScore: Math.round(cappedIdentity * 100) / 100,
    topicalScore: Math.round(cappedTopical * 100) / 100,
    reasons: [...identitySignals, ...topicalSignals].map(signal => signal.detail),
    matched,
    entityEvidence,
    identitySignals,
    topicalSignals,
    contradictions
  };
}

/**
 * Rank candidate documents for a request.
 *
 * Ambiguity compares *identity* evidence, not total score: the question is which
 * document the request refers to. Two documents the request names equally well
 * are ambiguous; one the request names explicitly is not, even if a look-alike
 * shares more topical words.
 */
export function rankCandidates(request, documents) {
  const scored = Object.values(documents || {})
    .map(document => ({ document, match: correlate(request, document) }));
  const ranked = scored
    .filter(candidate => candidate.match.matched)
    .sort((a, b) => b.match.identityScore - a.match.identityScore ||
      b.match.score - a.match.score || (b.document.version || 0) - (a.document.version || 0));

  const ambiguous = ranked.length > 1 &&
    (ranked[0].match.identityScore - ranked[1].match.identityScore) < AMBIGUITY_TOLERANCE;
  const rejected = scored
    .filter(candidate => !candidate.match.matched && candidate.match.contradictions.length)
    .map(candidate => ({ documentId: candidate.document.id, contradictions: candidate.match.contradictions }));

  return {
    ranked,
    best: ranked[0] || null,
    ambiguous,
    contenders: ranked.map(entry => entry.document.id),
    rejected
  };
}

export const correlationApi = { correlate, rankCandidates, distinctiveTitleTokens, IDENTITY_WEIGHTS, TOPICAL_WEIGHTS };
