import { evidenceItem, sourceRef, unknownItem } from './evidence.js';

/**
 * Freshness.
 *
 * The request in the demonstration asks for the *latest* experiment results.
 * Finding a results section is not evidence that the results are the latest
 * ones. Freshness can only be claimed when the system has a source of truth for
 * experiment runs and can show the document reflects the newest of them.
 *
 * Statuses:
 *   verified      - a run registry exists and the document reflects the newest run
 *   stale         - the registry knows of a newer run than the one in the document
 *   unverified    - no registry connected, or the document carries no run date
 *   contradictory - the document cites a run the registry does not contain
 */

export function runRecord({ id, label, subjectEntity = null, completedAt, source, metrics = null }) {
  if (!id || !completedAt) throw new Error('A run record requires an id and a completion date');
  return { id, label: label || id, subjectEntity, completedAt, source, metrics };
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value);
  const iso = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function relevantRuns(runRecords, subjectEntity) {
  const all = Object.values(runRecords || {});
  if (!subjectEntity) return all;
  const entity = subjectEntity.toLowerCase();
  const matching = all.filter(record => !record.subjectEntity || String(record.subjectEntity).toLowerCase() === entity);
  return matching.length ? matching : all.filter(record => !record.subjectEntity);
}

export function newestRun(runRecords, subjectEntity) {
  return relevantRuns(runRecords, subjectEntity)
    .slice()
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0] || null;
}

/**
 * Decide what the system is allowed to say about freshness.
 *
 * `documentRunDate` is the date of the underlying event the document reports
 * (the run, incident or release), extracted from the document's own text. It is
 * deliberately separate from `document.modifiedAt`, which only says when the
 * file was last touched — editing a document today says nothing about whether
 * the results inside it are current.
 */
function requestAsksForFreshness(request) {
  if ((request?.impliedClaims || []).some(item => item.requiresFreshness)) return true;
  return /\b(latest|newest|most\s+recent|up[- ]to[- ]date|current)\b/i.test(request?.text || '');
}

export function determineFreshness({ document, documentRunDate, runRecords, request }) {
  const runs = relevantRuns(runRecords, request?.subjectEntity);
  const newest = newestRun(runRecords, request?.subjectEntity);
  const documentModifiedAt = document?.modifiedAt || null;
  const eventDate = documentRunDate ? dateOnly(documentRunDate) : null;
  const base = {
    newestRun: newest,
    documentRunDate: eventDate,
    // Recorded so the distinction is visible rather than implicit.
    documentModifiedAt,
    modificationTimeIsNotFreshnessEvidence: true
  };

  if (!runs.length && !requestAsksForFreshness(request)) {
    return {
      ...base,
      status: 'not_required',
      reason: 'The request does not ask whether these are the latest results.',
      evidence: [],
      unknowns: []
    };
  }

  if (!runs.length) {
    return {
      ...base,
      status: 'unverified',
      reason: 'No experiment run registry is connected, so nothing can confirm these are the newest results.',
      evidence: [],
      unknowns: [unknownItem({
        id: 'freshness_source_of_truth',
        question: 'Are these the latest available experiment results?',
        reason: 'No source of truth for experiment runs is connected.',
        whatWouldResolveIt: 'Connect the experiment run registry (or paste the run record) so the document run can be compared against the newest run.'
      })]
    };
  }

  if (!eventDate) {
    return {
      ...base,
      status: 'unverified',
      reason: 'The document does not state which run the results came from, so freshness cannot be established.',
      evidence: [],
      unknowns: [unknownItem({
        id: 'document_run_identity',
        question: 'Which experiment run produced these results?',
        reason: `The document has no run date or run identifier. It was last modified ${documentModifiedAt || 'at an unknown time'}, which is not evidence of freshness.`,
        whatWouldResolveIt: 'State the run date or run id in the document.'
      })]
    };
  }

  const newestDate = dateOnly(newest.completedAt);
  const runSource = sourceRef({
    kind: 'run_registry',
    id: newest.id,
    timestamp: newest.completedAt,
    url: newest.source?.url || null
  });
  const documentSource = sourceRef({
    kind: 'document', id: document.id, version: document.version, timestamp: document.modifiedAt, url: document.url
  });

  if (newestDate && eventDate < newestDate) {
    return {
      ...base,
      status: 'stale',
      reason: `The document reflects the ${eventDate} run, but the registry knows of a newer run completed ${newestDate}.`,
      evidence: [
        evidenceItem({ source: runSource, detail: `Newer run available: ${newest.label}`, excerptText: newest.label }),
        evidenceItem({ source: documentSource, detail: `Document reports the ${eventDate} run`, excerptText: documentRunDate })
      ],
      unknowns: [unknownItem({
        id: 'stale_results',
        question: 'Do the newer run results change the conclusion?',
        reason: `A run completed ${newestDate} is newer than the results in the document (${eventDate}).`,
        whatWouldResolveIt: `Update the document with the ${newest.label} results before claiming the deliverable is current.`
      })]
    };
  }

  if (newestDate && eventDate === newestDate) {
    return {
      ...base,
      status: 'verified',
      reason: `The document reflects the ${eventDate} run, which is the newest run in the registry.`,
      evidence: [
        evidenceItem({ source: runSource, detail: `Newest known run: ${newest.label}`, excerptText: newest.label }),
        evidenceItem({ source: documentSource, detail: `Document reports the ${eventDate} run`, excerptText: documentRunDate })
      ],
      unknowns: []
    };
  }

  if (newestDate && eventDate > newestDate) {
    // The document claims a run the registry has never seen. That may simply
    // mean the registry has not synced yet, so it is not proof of staleness —
    // but it also cannot be confirmed, so the claim is withheld.
    return {
      ...base,
      status: 'unverified',
      reason: `The document reports a ${eventDate} run that the registry does not contain (newest known: ${newestDate}). It cannot be confirmed as current.`,
      evidence: [
        evidenceItem({ source: runSource, detail: `Newest registered run: ${newest.label}`, excerptText: newest.label })
      ],
      unknowns: [unknownItem({
        id: 'unregistered_run',
        question: `Is the ${eventDate} run the one the deliverable should report?`,
        reason: 'The run registry does not contain a run with that date.',
        whatWouldResolveIt: 'Publish the run to the registry, or correct the date in the document.'
      })]
    };
  }

  return {
    ...base,
    status: 'unverified',
    reason: 'The document run date could not be compared against the run registry.',
    evidence: [],
    unknowns: []
  };
}

export const freshnessApi = { runRecord, determineFreshness, newestRun, relevantRuns, dateOnly };
