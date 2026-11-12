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
 *   not_required  - the request does not ask whether the document is current
 *   verified      - a run registry exists and the document reflects the newest run
 *   stale         - the registry knows of a newer run than the one in the document
 *   unverified    - no registry connected, the document carries no run date, it
 *                   cites a run the registry does not contain, or the newest run
 *                   carries no usable date
 *   contradictory - reserved: no producer emits it. The engine treats any such
 *                   value as stale if one ever appears.
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

function hasClockTime(value) {
  return /(?:T|\s)\d{1,2}:\d{2}/.test(String(value || ''));
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

  if (!requestAsksForFreshness(request)) {
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

  const eventHasTime = hasClockTime(documentRunDate);
  const newestHasTime = hasClockTime(newest.completedAt);
  const eventTimestamp = Date.parse(documentRunDate);
  const newestTimestamp = Date.parse(newest.completedAt);
  const eventLabel = eventHasTime ? String(documentRunDate) : eventDate;
  const newestLabel = newestHasTime ? String(newest.completedAt) : newestDate;
  const newer = eventDate < newestDate || (eventDate === newestDate && eventHasTime && newestHasTime
    && Number.isFinite(eventTimestamp) && Number.isFinite(newestTimestamp) && eventTimestamp < newestTimestamp);

  if (newestDate && newer) {
    return {
      ...base,
      status: 'stale',
      reason: `The document reflects the ${eventLabel} run, but the registry knows of a newer run completed ${newestLabel}.`,
      evidence: [
        evidenceItem({ source: runSource, detail: `Newer run available: ${newest.label}`, excerptText: newest.label }),
        evidenceItem({ source: documentSource, detail: `Document reports the ${eventLabel} run`, excerptText: documentRunDate })
      ],
      unknowns: [unknownItem({
        id: 'stale_results',
        question: 'Do the newer run results change the conclusion?',
        reason: `A run completed ${newestLabel} is newer than the results in the document (${eventLabel}).`,
        whatWouldResolveIt: `Update the document with the ${newest.label} results before claiming the deliverable is current.`
      })]
    };
  }

  if (newestDate && eventDate === newestDate) {
    if (eventHasTime && newestHasTime && Number.isFinite(eventTimestamp) && Number.isFinite(newestTimestamp) && eventTimestamp > newestTimestamp) {
      return {
        ...base,
        status: 'unverified',
        reason: `The document reports a ${eventLabel} run that the registry does not contain (newest known: ${newestLabel}). It cannot be confirmed as current.`,
        evidence: [
          evidenceItem({ source: runSource, detail: `Newest registered run: ${newest.label}`, excerptText: newest.label }),
          evidenceItem({ source: documentSource, detail: `Document reports the ${eventLabel} run`, excerptText: documentRunDate })
        ],
        unknowns: [unknownItem({
          id: 'unregistered_run',
          question: `Is the ${eventLabel} run the one the deliverable should report?`,
          reason: 'The run registry does not contain a run with that time.',
          whatWouldResolveIt: 'Publish the run to the registry, or correct the time in the document.'
        })]
      };
    }
    // A date without a time cannot distinguish a morning run from an evening
    // run. If the registry knows more than one run that day, the document does
    // not identify which one it reflects.
    if (!eventHasTime) {
      const sameDay = runs
        .filter(record => dateOnly(record.completedAt) === eventDate)
        .map(record => String(record.completedAt))
        .filter((value, index, all) => all.indexOf(value) === index);
      if (sameDay.length > 1) {
        return {
          ...base,
          status: 'unverified',
          reason: `The document identifies only the ${eventDate} day, but the registry contains ${sameDay.length} runs that day. It cannot be confirmed which run the document reflects.`,
          evidence: [
            evidenceItem({ source: runSource, detail: `Newest known run: ${newest.label}`, excerptText: newest.label }),
            evidenceItem({ source: documentSource, detail: `Document reports the ${eventDate} day`, excerptText: documentRunDate })
          ],
          unknowns: [unknownItem({
            id: 'ambiguous_same_day_run',
            question: `Which ${eventDate} run produced these results?`,
            reason: 'The document states a date but not a run time or run identifier, and more than one run completed that day.',
            whatWouldResolveIt: 'State the run time or run id in the document.'
          })]
        };
      }
    }
    return {
      ...base,
      status: 'verified',
      reason: `The document reflects the ${eventLabel} run, which is the newest run in the registry.`,
      evidence: [
        evidenceItem({ source: runSource, detail: `Newest known run: ${newest.label}`, excerptText: newest.label }),
        evidenceItem({ source: documentSource, detail: `Document reports the ${eventLabel} run`, excerptText: documentRunDate })
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
