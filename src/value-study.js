// Research bookkeeping only. This does not discover work, execute it, or infer user intent.
const present = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const array = value => Array.isArray(value) ? value : [];

export function valueStudyTemplate() {
  return {
    schemaVersion: 1,
    evidenceScope: 'synthetic',
    collection: { mode: 'read_only_silent', startedAt: null, endedAt: null, externalWrites: 0, participantNotifications: 0, evidenceRef: null },
    participants: [], cases: [], misses: []
  };
}

/** Count only complete participant attestations; referenced evidence still needs human audit. */
export function evaluateValueStudy(study, { now = Date.now() } = {}) {
  if (!study || study.schemaVersion !== 1 || !['synthetic', 'real_user'].includes(study.evidenceScope)) {
    throw new Error('Expected value-study schemaVersion 1 and an explicit evidenceScope.');
  }
  if (!Array.isArray(study.participants) || !Array.isArray(study.cases) || !Array.isArray(study.misses)) {
    throw new Error('participants, cases and misses must be arrays.');
  }
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(at)) throw new Error('Invalid evaluation time.');
  const participants = new Map();
  for (const participant of study.participants) {
    if (!present(participant?.id) || participants.has(participant.id)) throw new Error('Participant IDs must be present and unique.');
    participants.set(participant.id, participant);
  }
  const caseIds = new Set();
  const collection = study.collection || {};
  const start = timestamp(collection.startedAt), end = timestamp(collection.endedAt);
  const windowValid = Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 7 * 86_400_000;
  const protocolValid = collection.mode === 'read_only_silent' && collection.externalWrites === 0 &&
    collection.participantNotifications === 0 && present(collection.evidenceRef) && windowValid;
  const counts = { reviewed: 0, unreviewed: 0, useful: 0, notUseful: 0, invalidReview: 0 };
  const excluded = {};
  const qualifyingUsers = new Set();
  let qualifyingCases = 0;
  for (const item of study.cases) {
    if (!present(item?.id) || caseIds.has(item.id)) throw new Error('Case IDs must be present and unique.');
    caseIds.add(item.id);
    const participant = participants.get(item.participantId);
    const discoveredAt = timestamp(item.discoveredAt);
    const review = item.review;
    const reviewedAt = timestamp(review?.reviewedAt);
    const validReview = participant && review?.source === 'participant' && review.participantId === item.participantId &&
      Number.isFinite(discoveredAt) && Number.isFinite(reviewedAt) && reviewedAt >= discoveredAt && reviewedAt <= at && present(review.evidenceRef);
    if (!review) counts.unreviewed++;
    else if (!validReview) counts.invalidReview++;
    else {
      counts.reviewed++;
      if (review.useful === true) counts.useful++;
      if (review.useful === false) counts.notUseful++;
    }
    const checks = {
      real_scope: study.evidenceScope === 'real_user',
      collection_protocol: protocolValid,
      real_participant: participant?.confirmedRealUser === true && participant?.source === 'participant',
      consent: present(participant?.consentRef) && Number.isFinite(timestamp(participant?.consentedAt)) && timestamp(participant?.consentedAt) <= discoveredAt,
      environment_discovery: item.discoveryMode === 'environment',
      discovery_evidence: present(item.discoveryEvidenceRef) && array(item.contextEventRefs).length > 0 && item.contextEventRefs.every(present),
      study_window: windowValid && discoveredAt >= start && discoveredAt <= end && discoveredAt <= at,
      participant_review: Boolean(validReview),
      unrequested: validReview && review.notExplicitlyRequested === true,
      recognized_useful: validReview && review.useful === true,
      reason_to_keep: validReview && review.keepBecauseOfDiscovery === true
    };
    let qualifies = true;
    for (const [reason, passed] of Object.entries(checks)) if (!passed) { excluded[reason] = (excluded[reason] || 0) + 1; qualifies = false; }
    if (qualifies) { qualifyingCases++; qualifyingUsers.add(item.participantId); }
  }
  const misses = new Set();
  let recordedMisses = 0;
  for (const miss of study.misses) {
    if (!present(miss?.id) || misses.has(miss.id)) throw new Error('Miss IDs must be present and unique.');
    misses.add(miss.id);
    if (participants.has(miss.participantId) && miss.source === 'participant' && present(miss.evidenceRef) &&
      Number.isFinite(timestamp(miss.recordedAt)) && timestamp(miss.recordedAt) <= at) recordedMisses++;
  }
  return {
    kind: 'explicit-user-value-study', evidenceScope: study.evidenceScope,
    collectionProtocol: protocolValid ? 'recorded_as_read_only_silent' : 'incomplete_or_deviating',
    participantsRecorded: participants.size, casesRecorded: caseIds.size,
    qualifyingUsers: qualifyingUsers.size, qualifyingCases,
    reviews: counts, excludedConditions: excluded, recordedMisses,
    unknown: { recall: 'unknown', timeSaved: 'unknown', observedRetention: 'not_measured' },
    evidenceBasis: 'Explicit participant attestations and referenced research records; references are not independently authenticated by this tool.',
    interpretation: 'Willingness to keep the product is self-reported for this discovery, not measured longitudinal retention. Synthetic studies never count as real-user value.'
  };
}
