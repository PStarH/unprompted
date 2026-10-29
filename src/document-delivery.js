import crypto from 'node:crypto';

const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const normaliseNewlines = value => String(value ?? '').replace(/\r\n?/g, '\n');
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');

export function requestSignature(task) {
  return sha(JSON.stringify([task?.request || null, Number(task?.guidanceRevision) || 0]));
}

function paragraphText(paragraph) {
  return (paragraph?.elements || []).map(element => element.textRun?.content || '').join('');
}

/** Extract text in the default document body returned by documents.get. */
export function googleDocumentText(document) {
  const pieces = [];
  const visit = elements => {
    for (const element of elements || []) {
      if (element.paragraph) pieces.push(paragraphText(element.paragraph));
      if (element.table) {
        for (const row of element.table.tableRows || []) {
          for (const cell of row.tableCells || []) visit(cell.content);
        }
      }
      if (element.tableOfContents) visit(element.tableOfContents.content);
    }
  };
  visit(document?.body?.content);
  return pieces.join('');
}

function sourceText(source, task, state) {
  if (!source || typeof source !== 'object' || typeof source.quote !== 'string' || !source.quote.trim()) return null;
  if (source.kind === 'document') {
    const document = state.documents?.[source.id];
    if (!document || document.available === false) return null;
    if (source.version == null || document.version !== source.version) return null;
    return typeof document.content === 'string' ? document.content : null;
  }
  if (source.kind === 'email') {
    const message = (state.inbox || []).find(item => item.id === source.id);
    return message?.body || null;
  }
  return null;
}

function exactQuote(quote, content) {
  return normaliseNewlines(content).includes(normaliseNewlines(quote));
}

async function readJsonBounded(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteLength = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
          await reader.cancel();
          throw new Error(`Google Docs response exceeded the ${maxBytes}-byte limit.`);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock?.();
    }
    return JSON.parse(text);
  }
  // Small test doubles and older fetch-compatible runtimes may not expose a
  // stream. Check their buffered response size before parsing it.
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`Google Docs response exceeded the ${maxBytes}-byte limit.`);
    return JSON.parse(text);
  }
  throw new Error('Google Docs response has no bounded-readable body.');
}

/** Validate proposed changes against exact source text and the current target document. */
export function validateDocumentChanges(changes, { task, state, targetDocument }) {
  const blockers = [];
  if (!Array.isArray(changes) || !changes.length) {
    return { changes: [], blockers: ['No source-backed change was supplied. Missing content is left blank; it cannot be invented.'] };
  }
  if (changes.length > 20) return { changes: [], blockers: ['A document patch may contain at most 20 changes.'] };
  const accepted = [];
  changes.forEach((raw, index) => {
    const label = `Change ${index + 1}`;
    if (!raw || !['append', 'insert_after'].includes(raw.type)) {
      blockers.push(`${label} has an unsupported operation; use append or insert_after.`);
      return;
    }
    if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 5000) {
      blockers.push(`${label} must contain 1–5,000 characters of source-backed text.`);
      return;
    }
    if (raw.type === 'insert_after' && (typeof raw.anchor !== 'string' || !raw.anchor.trim() || !targetDocument.content.includes(raw.anchor))) {
      blockers.push(`${label} anchor is not present in the current target document.`);
      return;
    }
    if (normaliseNewlines(targetDocument.content).includes(normaliseNewlines(raw.text))) {
      blockers.push(`${label} text is already present in the target document; it is not an unapplied change.`);
      return;
    }
    const source = raw.source;
    const content = sourceText(source, task, state);
    if (!content || !exactQuote(source.quote, content)) {
      blockers.push(`${label} source is missing, unavailable, stale, or does not contain its cited quote.`);
      return;
    }
    if (normaliseNewlines(raw.text).trim() !== normaliseNewlines(source.quote).trim()) {
      blockers.push(`${label} text must match its cited source quote exactly; paraphrased or generated claims are not accepted.`);
      return;
    }
    accepted.push({
      type: raw.type,
      ...(raw.type === 'insert_after' ? { anchor: raw.anchor } : {}),
      text: raw.text,
      ...(Array.isArray(raw.criterionIds) && raw.criterionIds.length ? { criterionIds: [...new Set(raw.criterionIds.map(String))] } : {}),
      source: {
        kind: source.kind,
        id: source.id,
        ...(source.version != null ? { version: source.version } : {}),
        quote: source.quote
      }
    });
  });
  return { changes: accepted, blockers };
}

function insertionAt(content, change) {
  let index;
  if (change.type === 'append') {
    index = content.endsWith('\n') ? content.length - 1 : content.length;
  } else {
    const start = content.indexOf(change.anchor);
    if (start < 0) throw new Error(`The patch anchor “${change.anchor}” is no longer present.`);
    const end = content.indexOf('\n', start + change.anchor.length);
    index = end < 0 ? content.length : end + 1;
    if (index === content.length && content.endsWith('\n')) index -= 1;
  }
  const prefix = index > 0 && content[index - 1] !== '\n' ? '\n' : '';
  const suffix = change.text.endsWith('\n') || content[index] === '\n' ? '' : '\n';
  return { index, text: `${prefix}${change.text}${suffix}` };
}

/** Apply an append/insert patch to plain text, preserving source text verbatim. */
export function applyTextChanges(content, changes) {
  let output = normaliseNewlines(content);
  for (const change of changes) {
    const { index, text } = insertionAt(output, change);
    output = output.slice(0, index) + text + output.slice(index);
  }
  return output;
}

/** In-memory provider used for the explicitly simulated/local document store. */
export class LocalDocumentProvider {
  constructor({ store = null } = {}) {
    this.store = store;
    this.id = 'local';
    this.simulated = true;
    this.live = false;
  }

  supports(document) {
    return Boolean(document && document.available !== false && ['simulated', 'local'].includes(document.source) && !document.externalId);
  }

  prepareBase(document) {
    if (!this.supports(document)) throw new Error('Local patching is available only for a local or simulated document, not a mirrored Google document.');
    return { revisionId: null, content: document.content, provider: this.id, simulated: true };
  }

  apply({ document, changes, beforeWrite = null }) {
    if (!this.supports(document)) throw new Error('The local document is no longer available for editing.');
    beforeWrite?.();
    return { content: applyTextChanges(document.content, changes), revisionId: null, provider: this.id, simulated: true };
  }
}

function googleInsertion(document, content, change) {
  if (!document?.body?.content?.length) throw new Error('Google Docs did not return an editable document body.');
  const { index } = insertionAt(content, change);
  // The default Google Docs body starts at index 1; JavaScript string offsets
  // therefore map to Docs API indexes by adding one (UTF-16 in both APIs).
  return index + 1;
}

/**
 * Explicitly enabled Google Docs writer. It is deliberately separate from the
 * mail provider and requires its own documents/drive.file OAuth scope. Writes
 * use Docs API requiredRevisionId and are followed by a GET readback.
 */
export class GoogleDocsWriteProvider {
  constructor({ connector, enabled = false, shadow = true, fetchImpl = connector?.fetchImpl || globalThis.fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
    this.connector = connector;
    this.enabled = enabled === true;
    this.shadow = shadow === true;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(100, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxResponseBytes = Math.max(1024, Number(maxResponseBytes) || MAX_RESPONSE_BYTES);
    this.id = 'google';
    this.simulated = false;
    this.live = true;
  }

  validate({ forWrite = false } = {}) {
    if (!this.enabled) return { ok: false, reason: 'Google Docs write provider is not explicitly enabled.' };
    if (!this.connector?.auth?.configured?.()) return { ok: false, reason: 'Google Docs provider has no configured Google authentication.' };
    if (forWrite && this.shadow) return { ok: false, reason: 'Shadow mode is read-only; Google Docs writes are refused.' };
    return { ok: true };
  }

  supports(document) {
    return Boolean(document && document.available !== false && document.source === 'google' && document.externalId);
  }

  async #headers() {
    if (!this.connector?.auth?.headers) throw new Error('Google Docs provider has no Google authorization adapter.');
    return { ...(await this.connector.auth.headers()), 'content-type': 'application/json' };
  }

  async #request(documentId, { method = 'GET', body = null, suffix = '', beforeRequest = null, signal = null } = {}) {
    const controller = new AbortController();
    let timer;
    let requestStarted = false;
    let timeoutError = null;
    const operation = async () => {
      const headers = await this.#headers();
      if (controller.signal.aborted) throw timeoutError || new Error('Google Docs request was aborted before the HTTP call started.');
      // Run the caller's final policy/version check after asynchronous auth
      // header acquisition and immediately before handing the request to fetch.
      signal?.throwIfAborted();
      beforeRequest?.();
      requestStarted = true;
      const response = await this.fetchImpl(`${DOCS_API}/${encodeURIComponent(documentId)}${suffix}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
      });
      if (!response?.ok) {
        const error = new Error(response?.status === 403
          ? 'Google Docs denied access (403). Confirm the OAuth grant has documents or drive.file scope and that this account can edit the document.'
          : `Google Docs API ${method} failed with ${response?.status || 'no response'}.`);
        error.status = response?.status || null;
        if (method === 'POST' && Number(error.status) >= 500) error.writeOutcomeUnknown = true;
        throw error;
      }
      return readJsonBounded(response, this.maxResponseBytes);
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error(`Google Docs API ${method} timed out after ${this.timeoutMs}ms.`);
        error.timeout = true;
        error.requestStarted = requestStarted;
        timeoutError = error;
        if (method === 'POST' && requestStarted) error.writeOutcomeUnknown = true;
        reject(error);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (method === 'POST' && requestStarted && error.status == null) error.writeOutcomeUnknown = true;
      if (method === 'POST' && !requestStarted) error.definitiveNoEffect = true;
      error.requestStarted ??= requestStarted;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async read(document, { signal = null } = {}) {
    if (!this.supports(document)) throw new Error('Google Docs patching requires a currently available Google document.');
    const enabled = this.validate();
    if (!enabled.ok) throw new Error(enabled.reason);
    const remote = await this.#request(document.externalId, { signal });
    return { content: googleDocumentText(remote), revisionId: remote.revisionId || null, raw: remote };
  }

  async prepareBase(document) {
    const remote = await this.read(document);
    if (!remote.revisionId) throw new Error('Google Docs did not return a revision ID; a version-checked patch cannot be prepared.');
    if (normaliseNewlines(remote.content) !== normaliseNewlines(document.content)) {
      throw new Error('The current Google Doc differs from the last synced source. Sync and assess it again before preparing a patch.');
    }
    return { revisionId: remote.revisionId, content: remote.content, provider: this.id, simulated: false, raw: remote.raw };
  }

  async apply({ document, changes, requiredRevisionId, beforeWrite = null, signal = null }) {
    const permitted = this.validate({ forWrite: true });
    if (!permitted.ok) throw new Error(permitted.reason);
    const current = await this.read(document, { signal });
    if (!requiredRevisionId || current.revisionId !== requiredRevisionId) {
      const error = new Error('The Google Doc revision changed after patch preparation; prepare and review a new patch.');
      error.stale = true;
      throw error;
    }
    const grouped = new Map();
    for (const change of changes) {
      const index = googleInsertion(current.raw, current.content, change);
      const { text } = insertionAt(current.content, change);
      if (!grouped.has(index)) grouped.set(index, []);
      grouped.get(index).push(text);
    }
    const requests = [...grouped.entries()]
      .sort(([a], [b]) => b - a)
      .map(([index, texts]) => ({ insertText: { location: { index }, text: texts.reverse().join('') } }));
    let accepted = false;
    const expectedContent = applyTextChanges(current.content, changes);
    try {
      await this.#request(document.externalId, {
        method: 'POST',
        suffix: ':batchUpdate',
        body: { requests, writeControl: { requiredRevisionId } },
        beforeRequest: beforeWrite, signal
      });
      accepted = true;
    } catch (error) {
      if (error.status === 400) error.stale = true;
      if ((error.status == null && error.requestStarted === true) || Number(error.status) >= 500) error.writeOutcomeUnknown = true;
      throw error;
    }
    let readback;
    try {
      readback = await this.read(document, { signal });
    } catch (error) {
      error.writeOutcomeUnknown = accepted;
      throw error;
    }
    if (normaliseNewlines(readback.content) !== normaliseNewlines(expectedContent)) {
      const error = new Error('Google Docs accepted the write, but readback did not contain every requested source quote. The result is uncertain and must be reconciled manually.');
      error.writeOutcomeUnknown = true;
      throw error;
    }
    return { content: readback.content, revisionId: readback.revisionId, provider: this.id, simulated: false, readbackVerified: true };
  }
}

export const documentDeliveryApi = {
  requestSignature, validateDocumentChanges, applyTextChanges, googleDocumentText,
  LocalDocumentProvider, GoogleDocsWriteProvider
};
