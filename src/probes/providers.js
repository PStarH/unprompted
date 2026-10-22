/**
 * Registered evidence providers.
 *
 * The bounded execution interface. A probe names a provider; it cannot issue a
 * query of its own. Only the providers below exist, each with explicit bounds,
 * and none of them performs network access or an external action.
 *
 * Adding a provider is a deliberate code change, which is the point: a
 * model-proposed probe can only reach data the system has decided it may read.
 */

import { evidenceItem, sourceRef } from '../evidence.js';
import { prepareText, runStrategies, DEFAULT_BOUNDS } from './strategies.js';

export const QUERY_BOUNDS = {
  maxDocuments: 6,
  maxLinesPerDocument: 4000,
  maxExcerpt: 320,
  maxResults: 5
};

export class ProviderUnavailableError extends Error {
  constructor(providerId, reason) {
    super(`Evidence provider "${providerId}" is unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
    this.providerId = providerId;
  }
}

function documentSource(document, locator) {
  return sourceRef({
    kind: 'document',
    id: document.id,
    version: document.version ?? null,
    timestamp: document.modifiedAt ?? null,
    url: document.url ?? null,
    locator: locator || null
  });
}

/**
 * Searches the text of correlated documents.
 * Documents must be supplied by the caller: a provider never scans the whole
 * workspace on its own initiative.
 */
const documentText = {
  id: 'document_text',
  label: 'Document text',
  kind: 'local_document',
  readOnly: true,
  available(context) {
    return Array.isArray(context?.documents) && context.documents.length > 0;
  },
  unavailableReason() { return 'no correlated document is available'; },
  search({ documents, keywords, strategies, bounds = DEFAULT_BOUNDS, requiredAnyKeywords = [] }) {
    const scanned = documents.slice(0, QUERY_BOUNDS.maxDocuments);
    let fallback = null;
    for (const document of scanned) {
      const prepared = prepareText(
        document.content,
        { ...bounds, maxLines: QUERY_BOUNDS.maxLinesPerDocument },
        { title: document.title, requiredAny: requiredAnyKeywords }
      );
      const hit = runStrategies(prepared, keywords, strategies, { ...bounds, maxExcerpt: QUERY_BOUNDS.maxExcerpt });
      if (!hit) continue;
      const shaped = {
        matched: true,
        provider: this.id,
        strength: hit.strength,
        strategy: hit.strategy,
        fallback: hit.fallback === true,
        excerpt: hit.excerpt,
        detail: hit.detail,
        matchedKeyword: hit.matchedKeyword,
        date: hit.date || null,
        // A reconciled hit (an earlier value superseded by a dated update)
        // carries what it superseded, so the evidence can say so.
        superseded: hit.superseded || null,
        // A strategy that found contradictory values reports them rather than
        // picking one. `entries` carries the line each value came from, so the
        // conflict is auditable rather than an assertion.
        conflict: hit.conflict
          ? { label: hit.conflict.label, values: hit.conflict.values, entries: hit.conflict.entries }
          : null,
        source: documentSource(document, hit.locator),
        documentId: document.id,
        documentVersion: document.version ?? null
      };
      // A candidate that matched only the broad words does not end the scan: a
      // later document may contain what the request actually named. It is kept
      // as the fallback so "related content exists" is still reported when
      // nothing qualifies.
      if (hit.fallback) {
        if (!fallback) fallback = shaped;
        continue;
      }
      return shaped;
    }
    if (fallback) return fallback;
    return { matched: false, provider: this.id, scanned: scanned.map(document => document.id) };
  }
};

/**
 * The run registry: the source of truth for which run, incident or release is
 * the newest. Used only for freshness, never to prove content is present.
 */
const runRegistry = {
  id: 'run_registry',
  label: 'Run registry',
  kind: 'run_registry',
  readOnly: true,
  available(context) {
    return Boolean(context?.runRecords) && Object.keys(context.runRecords).length > 0;
  },
  unavailableReason() { return 'no run registry is connected'; },
  search({ runRecords, subjectEntity }) {
    const records = Object.values(runRecords || {})
      .filter(record => !subjectEntity || !record.subjectEntity ||
        String(record.subjectEntity).toLowerCase() === String(subjectEntity).toLowerCase())
      .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
      .slice(0, QUERY_BOUNDS.maxResults);
    if (!records.length) return { matched: false, provider: this.id };
    const newest = records[0];
    return {
      matched: true,
      provider: this.id,
      strength: 'direct',
      excerpt: newest.label,
      detail: `Newest registered entry: ${newest.label}`,
      source: sourceRef({ kind: 'run_registry', id: newest.id, timestamp: newest.completedAt, url: newest.source?.url || null }),
      newest
    };
  }
};

export const PROVIDERS = {
  document_text: documentText,
  run_registry: runRegistry
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function isProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/**
 * Execute one probe against one provider.
 * Throws ProviderUnavailableError rather than returning empty evidence, so an
 * unavailable source is never mistaken for a negative finding.
 */
export function searchProvider(providerId, context, query) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new ProviderUnavailableError(providerId, 'no such provider is registered');
  if (!provider.available(context)) throw new ProviderUnavailableError(providerId, provider.unavailableReason(context));
  return provider.search({ ...query, ...context });
}

/** Convert a provider hit into a traceable evidence item. */
export function hitToEvidence(hit, detail) {
  return evidenceItem({
    source: hit.source,
    excerptText: hit.excerpt,
    detail: detail || hit.detail,
    strength: hit.strength === 'indicative' ? 'indicative' : 'direct'
  });
}

export function describeProviders() {
  return PROVIDER_IDS.map(id => ({
    id,
    label: PROVIDERS[id].label,
    kind: PROVIDERS[id].kind,
    readOnly: PROVIDERS[id].readOnly
  }));
}

export const providersApi = { PROVIDERS, PROVIDER_IDS, QUERY_BOUNDS, isProvider, searchProvider, hitToEvidence, describeProviders, ProviderUnavailableError };
