import { Connector, ConnectorError } from './connector.js';
import { toNormalizedEvents } from './connector.js';
import { readTextBounded } from '../bounded.js';

/**
 * Google Workspace connector — Gmail + Drive/Docs.
 *
 * This is real provider code: OAuth refresh-token flow, Gmail incremental
 * history sync, Drive change tracking, Google Docs export, and Gmail send with
 * verification. It requires credentials to run; without them `validate()`
 * reports exactly what is missing and the application keeps using the
 * simulation. Nothing here fabricates a result.
 *
 * Scopes needed (read + send only what the product needs):
 *   https://www.googleapis.com/auth/gmail.readonly
 *   https://www.googleapis.com/auth/gmail.send
 *   https://www.googleapis.com/auth/drive.readonly
 *
 * NOTE: `gmail.send` is required to deliver an approved reply. Do not grant it
 * if you only want read-only discovery; the connector degrades to read-only and
 * will refuse to execute.
 */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DOC_MIME = 'application/vnd.google-apps.document';
const DOCUMENT_LIST_LIMIT = 20;

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SYNC_BUDGET_MS = 120000;
const DEFAULT_MAX_DOCUMENT_CHARS = 1000000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_DELAY_MS = 30000;

const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

/**
 * Race a promise against a hard deadline.
 *
 * The AbortController only helps when the transport honours the signal; the
 * race guarantees the caller stops waiting even if the fake (or a misbehaving
 * runtime) never settles. The losing promise is not cancelled silently: the
 * signal is aborted where possible so its socket can be released.
 */
function withTimeout(promise, ms, createError, onTimeout = null) {
  const limit = Number(ms);
  if (!(limit > 0)) return promise;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(createError());
    }, limit);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}


function dedupeEvents(events) {
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

const decodeBase64Url = value => Buffer.from(String(value || ''), 'base64url').toString('utf8');
const encodeBase64Url = value => Buffer.from(String(value || ''), 'utf8').toString('base64url');

const HEADER_FORBIDDEN = /[\r\n\u0000]/;
const MAILBOX = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function assertNoHeaderBreak(value, label) {
  if (HEADER_FORBIDDEN.test(String(value ?? ''))) {
    throw new ConnectorError(`${label} contains a line break or NUL control character; refusing to build the message.`, { connectorId: 'google' });
  }
}

/** Parse exactly one mailbox: `address` or `Display Name <address>`. */
function parseMailbox(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ConnectorError('A recipient address is required.', { connectorId: 'google' });
  assertNoHeaderBreak(raw, 'The recipient address');
  const angled = raw.match(/^(?:"([^"]*)"|([^<>"]*?))?\s*<([^<>]+)>\s*$/);
  let displayName = null;
  let address;
  if (angled) {
    displayName = (angled[1] ?? angled[2] ?? '').trim() || null;
    address = angled[3].trim();
  } else {
    address = raw;
  }
  if (!MAILBOX.test(address)) {
    throw new ConnectorError(`The recipient "${address}" is not a single valid email address.`, { connectorId: 'google' });
  }
  if (displayName) assertNoHeaderBreak(displayName, 'The recipient display name');
  return { address, displayName };
}

/**
 * RFC 2047 encoded words for a header value with non-ASCII text.
 * Long values are split into encoded words no larger than `maxBytes` each and
 * folded on continuation lines, so a subject can never smuggle a header.
 */
function encodeHeaderValue(value, { maxBytes = 45 } = {}) {
  const text = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = '';
  for (const character of text) {
    if (Buffer.byteLength(chunk + character, 'utf8') > maxBytes) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  return words.join('\r\n ');
}

function formatMailbox({ address, displayName }) {
  if (!displayName) return address;
  const ascii = /^[\x20-\x7e]*$/.test(displayName);
  const rendered = ascii
    ? (displayName.includes(',') ? `"${displayName.replace(/(["\\])/g, '\\$1')}"` : displayName)
    : encodeHeaderValue(displayName);
  return `${rendered} <${address}>`;
}

const normaliseBody = value => String(value ?? '').replace(/\r\n|\r|\n/g, '\r\n');

export class GoogleAuth {
  constructor({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = positive(timeoutMs, DEFAULT_TIMEOUT_MS);
    this.cached = null;
  }

  configured() { return Boolean(this.clientId && this.clientSecret && this.refreshToken); }

  async accessToken() {
    if (this.cached && this.cached.expiresAt > this.now() + 30000) return this.cached.token;
    if (!this.configured()) throw new ConnectorError('Google credentials are incomplete', { connectorId: 'google' });
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
    });
    const controller = new AbortController();
    let response;
    try {
      response = await withTimeout(
        Promise.resolve().then(() => this.fetchImpl(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: controller.signal
        })),
        this.timeoutMs,
        () => new ConnectorError(`Google token request timed out after ${this.timeoutMs}ms.`, {
          connectorId: 'google', retryable: true, timeout: true
        }),
        () => controller.abort()
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(`Could not reach the Google token endpoint: ${error.message}`, { connectorId: 'google', retryable: true });
    }
    if (!response.ok) {
      throw new ConnectorError(`Google token refresh failed with ${response.status}. The refresh token may be expired or revoked.`, {
        connectorId: 'google', status: response.status, retryable: false
      });
    }
    const payload = await response.json();
    this.cached = { token: payload.access_token, expiresAt: this.now() + (payload.expires_in || 3600) * 1000 };
    return this.cached.token;
  }

  async headers() {
    return { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' };
  }
}

export class GoogleWorkspaceConnector extends Connector {
  constructor({ id = 'google', auth, config = {}, fetchImpl = globalThis.fetch }) {
    super({ id, kind: 'google-workspace', fetchImpl });
    this.config = config;
    this.live = true;
    // Fail closed: a connector sends only when shadow mode is explicitly off.
    this.shadow = config.shadow !== false;
    this.sendEnabled = config.sendEnabled === true && this.shadow === false;
    this.timeoutMs = positive(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.syncBudgetMs = positive(config.syncBudgetMs, DEFAULT_SYNC_BUDGET_MS);
    this.maxDocumentChars = positive(config.maxDocumentChars, DEFAULT_MAX_DOCUMENT_CHARS);
    this.maxRetries = Number.isFinite(Number(config.maxRetries)) && Number(config.maxRetries) >= 0
      ? Number(config.maxRetries)
      : DEFAULT_MAX_RETRIES;
    this.retryBaseMs = Number.isFinite(Number(config.retryBaseMs)) && Number(config.retryBaseMs) >= 0
      ? Number(config.retryBaseMs)
      : DEFAULT_RETRY_BASE_MS;
    this.sleep = typeof config.sleep === 'function'
      ? config.sleep
      : ms => new Promise(resolve => setTimeout(resolve, ms));
    this.random = typeof config.random === 'function' ? config.random : Math.random;
    this.deadline = null;
    this.auth = auth || new GoogleAuth({ ...config, fetchImpl, timeoutMs: this.timeoutMs });
  }

  validate() {
    const missing = [];
    if (!this.auth.configured()) {
      if (!this.auth.clientId) missing.push('GOOGLE_CLIENT_ID');
      if (!this.auth.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
      if (!this.auth.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');
    }
    return {
      ok: missing.length === 0,
      missing,
      detail: missing.length
        ? `Set ${missing.join(', ')} to enable live Google Workspace sync. The simulation stays active until then.`
        : 'Google credentials present. Live sync enabled.'
    };
  }

  /** Fail fast once the sync deadline has passed instead of starting more I/O. */
  #checkBudget() {
    if (this.deadline != null && Date.now() >= this.deadline) {
      throw new ConnectorError(
        `Google sync exceeded its ${this.syncBudgetMs}ms time budget; the cursor was not advanced.`,
        { connectorId: this.id, retryable: true, timeout: true }
      );
    }
  }

  /** Never let a single request outlive the remaining sync budget. */
  #requestTimeoutMs() {
    if (this.deadline == null) return this.timeoutMs;
    return Math.max(1, Math.min(this.timeoutMs, this.deadline - Date.now()));
  }

  async #backoff(attempt, retryAfter = null) {
    const seconds = Number(retryAfter);
    const base = Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
      : Math.min(this.retryBaseMs * (2 ** attempt), MAX_RETRY_DELAY_MS);
    const jitter = Math.floor(this.random() * Math.max(1, this.retryBaseMs));
    const delay = Math.min(base + jitter, MAX_RETRY_DELAY_MS);
    if (delay > 0) await this.sleep(delay);
  }

  /**
   * One Google API call. GETs are idempotent and may be retried a bounded
   * number of times with exponential backoff and Retry-After support. A POST is
   * never retried here: a lost response may mean the provider already acted,
   * so the caller must reconcile instead (see the mail adapter).
   */
  async #request(url, { method = 'GET', body = null, headers = {}, retry = method === 'GET' } = {}) {
    this.#checkBudget();
    const authHeaders = await this.auth.headers();
    const attempts = retry ? this.maxRetries + 1 : 1;
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.#checkBudget();
      const controller = new AbortController();
      let response;
      try {
        response = await withTimeout(
          Promise.resolve().then(() => this.fetchImpl(url, {
            method,
            headers: { ...authHeaders, ...headers },
            ...(body ? { body } : {}),
            signal: controller.signal
          })),
          this.#requestTimeoutMs(),
          () => new ConnectorError(`Google request timed out after ${this.timeoutMs}ms.`, {
            connectorId: this.id, retryable: true, timeout: true
          }),
          () => controller.abort()
        );
      } catch (error) {
        lastError = error instanceof ConnectorError
          ? error
          : new ConnectorError(`Google request failed: ${error.message}`, { connectorId: this.id, retryable: true });
        if (!retry || !lastError.retryable || attempt === attempts - 1) throw lastError;
        await this.#backoff(attempt, null);
        continue;
      }

      if (response.status === 401) throw new ConnectorError('Google rejected the access token (401). Re-authorise the connector.', { connectorId: this.id, status: 401 });
      if (response.status === 403) {
        let disabled = false;
        try {
          const detail = await response.json();
          const reasons = [...(detail.error?.details || []).map(item => item.reason), ...(detail.error?.errors || []).map(item => item.reason)];
          disabled = reasons.some(reason => reason === 'SERVICE_DISABLED' || reason === 'accessNotConfigured');
        } catch { /* malformed diagnostics do not change the denied result */ }
        throw new ConnectorError(disabled ? 'Google API_DISABLED (403). Enable the requested API in your Google Cloud project.'
          : 'Google denied access (403). Check granted scopes and API enablement.', { connectorId: this.id, status: 403 });
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new ConnectorError(
          response.status === 429
            ? 'Google rate limited the request (429).'
            : `Google request failed with ${response.status}`,
          { connectorId: this.id, status: response.status, retryable: true }
        );
        if (!retry || attempt === attempts - 1) throw lastError;
        await this.#backoff(attempt, response.headers?.get?.('retry-after'));
        continue;
      }
      if (!response.ok) {
        throw new ConnectorError(`Google request failed with ${response.status}`, {
          connectorId: this.id, status: response.status, retryable: false
        });
      }
      // The deadline may have passed while waiting for the response. Do not
      // process a late response as if the sync still had time left.
      this.#checkBudget();
      return response.json();
    }

    throw lastError || new ConnectorError('Google request failed without a response.', { connectorId: this.id, retryable: true });
  }

  /** Incremental sync. Returns events plus a cursor to resume from. */
  async pull({ cursor = null } = {}) {
    this.deadline = Date.now() + this.syncBudgetMs;
    try {
      const errors = [];
      const nextCursor = { ...(cursor || {}) };
      const events = [];

      if (this.config.readGmail !== false) {
        try {
          const gmail = await this.#pullGmail(cursor?.gmail || null);
          events.push(...gmail.events);
          nextCursor.gmail = gmail.cursor;
        } catch (error) {
          errors.push({ scope: 'gmail', message: error.message, retryable: Boolean(error.retryable) });
        }
      }

      if (this.config.readDrive !== false) {
        try {
          const drive = await this.#pullDrive(cursor?.drive || null);
          events.push(...drive.events);
          nextCursor.drive = drive.cursor;
          for (const error of drive.errors || []) {
            errors.push({ scope: 'drive', message: error.message, retryable: Boolean(error.retryable) });
          }
        } catch (error) {
          errors.push({ scope: 'drive', message: error.message, retryable: Boolean(error.retryable) });
        }
      }

      return { events, cursor: nextCursor, errors, partial: errors.length > 0 };
    } finally {
      this.deadline = null;
    }
  }

  async #pullGmail(cursor) {
    const query = this.config.gmailQuery || 'newer_than:3d -in:chats';
    let messageIds = [];
    let historyId = cursor?.historyId || null;
    let resynced = false;

    if (historyId) {
      try {
        // Every page must be consumed before the cursor can advance. The History
        // API can return more message ids than one page holds; taking only the
        // first page used to advance the cursor past mail that was never read.
        const history = await this.#collectHistory(historyId);
        messageIds = history.messageIds;
        historyId = history.historyId || historyId;
      } catch (error) {
        // A too-old history cursor cannot be resumed; fall back to a bounded query
        // and record that we resynced rather than silently missing messages.
        if (error.status === 404) {
          historyId = null;
          resynced = true;
        } else {
          throw error;
        }
      }
    }

    if (!historyId) {
      // Bootstrap (first run or expired cursor): capture the resume point BEFORE
      // listing. Mail that arrives during the listing is then picked up by the
      // next history sync instead of falling into the gap between list and
      // profile. Re-delivery is deduplicated by event id in the engine.
      const profile = await this.#request(`${GMAIL}/users/me/profile`);
      historyId = profile.historyId || null;
      messageIds = await this.#listMessageIds(query);
    }

    const events = [];
    for (const id of [...new Set(messageIds)]) {
      let message;
      try {
        message = await this.#request(`${GMAIL}/users/me/messages/${encodeURIComponent(id)}?format=full`);
      } catch (error) {
        // A message deleted between the history entry and the read has nothing
        // left to ingest; that is not a reason to hold the cursor forever. Any
        // other failure aborts before the cursor is returned.
        if (error.status === 404) continue;
        throw error;
      }
      events.push(...toNormalizedEvents(this.id, 'google', [this.#toEmailRecord(message)]));
    }
    return { events, cursor: { historyId, query, ...(resynced ? { resynced: true } : {}) } };
  }

  /** Read every messageAdded page; only the final page's historyId is a safe cursor. */
  async #collectHistory(startHistoryId) {
    const ids = [];
    let pageToken = null;
    let historyId = startHistoryId;
    let pages = 0;
    do {
      const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.#request(`${GMAIL}/users/me/history?${params}`);
      for (const entry of page.history || []) {
        for (const message of entry.messages || []) {
          if (message?.id) ids.push(message.id);
        }
      }
      if (page.historyId) historyId = page.historyId;
      pageToken = page.nextPageToken || null;
      pages += 1;
      if (pages > 100) {
        throw new ConnectorError('Gmail history returned more than 100 pages; refusing to advance the cursor without consuming them.', { connectorId: this.id, retryable: true });
      }
    } while (pageToken);
    return { messageIds: [...new Set(ids)], historyId };
  }

  async #listMessageIds(query) {
    const ids = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ q: query, maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const listing = await this.#request(`${GMAIL}/users/me/messages?${params}`);
      for (const message of listing.messages || []) {
        if (message?.id) ids.push(message.id);
      }
      pageToken = listing.nextPageToken || null;
    } while (pageToken);
    return [...new Set(ids)];
  }

  #toEmailRecord(message) {
    const headers = Object.fromEntries((message.payload?.headers || []).map(header => [header.name.toLowerCase(), header.value]));
    return {
      providerEventId: `gmail:${message.id}`,
      type: 'email.received',
      at: headers.date ? new Date(headers.date).toISOString() : new Date().toISOString(),
      payload: {
        id: message.id,
        threadId: message.threadId || null,
        from: headers.from || '',
        to: headers.to || '',
        subject: headers.subject || '(no subject)',
        body: this.#extractBody(message.payload) || message.snippet || '',
        receivedAt: headers.date ? new Date(headers.date).toISOString() : new Date().toISOString(),
        providerMessageId: headers['message-id'] || null
      },
      meta: { labelIds: message.labelIds || [] }
    };
  }

  #extractBody(part) {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
    for (const child of part.parts || []) {
      const text = this.#extractBody(child);
      if (text) return text;
    }
    return '';
  }

  async #pullDrive(cursor) {
    const current = cursor || {};
    let pageToken = current.pageToken || null;
    if (!pageToken) {
      const start = await this.#request(`${DRIVE}/changes/startPageToken`);
      pageToken = start.startPageToken;
      // Capture the change baseline before listing current documents. The first
      // observation needs existing evidence immediately, without waiting for
      // another polling interval. Later changes resume from this baseline.
      const listed = await this.#driveFiles(current);
      return { events: listed.events, errors: listed.errors, cursor: { pageToken,
        filesModifiedAfter: listed.filesModifiedAfter, filesPageToken: listed.filesPageToken } };
    }

    const changes = await this.#driveChanges(pageToken);
    const listed = await this.#driveFiles(current);
    return {
      events: dedupeEvents([...changes.events, ...listed.events]),
      errors: listed.errors,
      cursor: {
        pageToken: changes.pageToken,
        filesModifiedAfter: listed.filesModifiedAfter,
        filesPageToken: listed.filesPageToken
      }
    };
  }

  async #driveChanges(pageToken) {
    const events = [];
    let nextPageToken = pageToken;
    let newStartPageToken = null;
    let pages = 0;

    do {
      const page = await this.#request(
        `${DRIVE}/changes?pageToken=${encodeURIComponent(nextPageToken)}&pageSize=100` +
        '&fields=nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,modifiedTime,version,trashed))'
      );
      for (const change of page.changes || []) {
        const file = change.file;
        const fileId = change.fileId || file?.id;
        if (!fileId) continue;
        // `removed` means the file left this user's view: deleted, trashed, or
        // access revoked. The old copy must stop counting as current evidence,
        // but it is not proof of what happened, so the reason stays descriptive.
        if (change.removed) {
          events.push(this.#unavailableEvent(fileId, { title: file?.name, reason: 'removed', at: change.time, file }));
          continue;
        }
        if (!file || file.mimeType !== DOC_MIME) continue;
        if (file.trashed) {
          events.push(this.#unavailableEvent(file.id, { title: file.name, reason: 'trashed', at: change.time || file.modifiedTime, file }));
          continue;
        }
        try {
          events.push(await this.#documentEvent(file, change.time));
        } catch (error) {
          if (error.status === 403 || error.status === 404) {
            // A definitive per-file permission/availability answer. Record the
            // invalidation and continue; a transient 5xx still aborts the scope.
            events.push(this.#unavailableEvent(file.id, {
              title: file.name, reason: 'inaccessible', at: change.time || file.modifiedTime, file
            }));
            continue;
          }
          throw error;
        }
      }
      nextPageToken = page.nextPageToken || null;
      newStartPageToken = page.newStartPageToken || newStartPageToken;
      pages += 1;
    } while (nextPageToken && pages < 10);

    return { events, pageToken: newStartPageToken || nextPageToken || pageToken };
  }

  /**
   * A document that left the readable view (removed, trashed, or inaccessible).
   *
   * The provider event id is stable for a given file/version/reason so a
   * repeated sync deduplicates instead of re-invalidating forever. It carries
   * no content: this is an availability change, not a new revision.
   */
  #unavailableEvent(id, { title = null, reason = 'unavailable', at = null, file = null } = {}) {
    const modifiedAt = file?.modifiedTime ? new Date(file.modifiedTime).toISOString() : null;
    const stamp = at ? new Date(at).toISOString() : (modifiedAt || new Date().toISOString());
    const discriminator = file?.version || modifiedAt || 'event';
    const [event] = toNormalizedEvents(this.id, 'google', [{
      providerEventId: `drive:${id}:unavailable:${reason}:${discriminator}`,
      type: 'document.unavailable',
      at: stamp,
      payload: {
        id,
        title: title || id,
        reason,
        modifiedAt: modifiedAt || stamp,
        externalId: id,
        url: `https://docs.google.com/document/d/${id}/edit`
      },
      meta: { driveVersion: file?.version || null }
    }]);
    return event;
  }

  /**
   * Bounded read of Google Docs that already exist.
   *
   * Change tracking only sees edits after the baseline cursor, so a document
   * that has not changed since then would never be fetched. This lists at most
   * DOCUMENT_LIST_LIMIT Docs, follows the list page token, and remembers the
   * newest modified time so the next sync does not export the same revisions.
   * One inaccessible file is reported; it does not erase a file that exported.
   */
  async #driveFiles(cursor) {
    const clauses = [`mimeType='${DOC_MIME}'`, 'trashed=false'];
    if (cursor.filesModifiedAfter) clauses.push(`modifiedTime > '${cursor.filesModifiedAfter}'`);
    const query = clauses.join(' and ');
    const files = [];
    let pageToken = cursor.filesPageToken || null;
    let pages = 0;

    do {
      let url = `${DRIVE}/files?q=${encodeURIComponent(query)}&pageSize=20&orderBy=modifiedTime desc` +
        '&fields=nextPageToken,files(id,name,mimeType,modifiedTime,version)';
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const page = await this.#request(url);
      for (const file of page.files || []) {
        if (file.mimeType === DOC_MIME) files.push(file);
        if (files.length >= DOCUMENT_LIST_LIMIT) break;
      }
      pageToken = page.nextPageToken || null;
      pages += 1;
      if (files.length >= DOCUMENT_LIST_LIMIT) break;
    } while (pageToken && pages < 5);

    const events = [];
    const errors = [];
    for (const file of files) {
      try {
        events.push(await this.#documentEvent(file, file.modifiedTime));
      } catch (error) {
        if (error.status === 404 || error.status === 403) {
          // Definitive per-file answer: invalidate it and keep the rest of the
          // listing moving. The invalidation is itself an event, so the engine
          // can withdraw anything that depended on the old copy.
          events.push(this.#unavailableEvent(file.id, { title: file.name, reason: 'inaccessible', file }));
          continue;
        }
        throw error;
      }
    }

    const complete = errors.length === 0 && !pageToken;
    const newest = events
      .map(event => event.payload.modifiedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    return {
      events,
      errors,
      filesModifiedAfter: complete ? (newest || cursor.filesModifiedAfter || null) : cursor.filesModifiedAfter,
      filesPageToken: complete ? null : (pageToken || cursor.filesPageToken || null)
    };
  }

  async #documentEvent(file, atFallback) {
    const content = await this.#exportDocument(file.id);
    const modifiedAt = file.modifiedTime ? new Date(file.modifiedTime).toISOString() : new Date().toISOString();
    const [event] = toNormalizedEvents(this.id, 'google', [{
      providerEventId: `drive:${file.id}:${file.version || atFallback || modifiedAt}`,
      type: 'document.modified',
      at: modifiedAt,
      payload: {
        id: file.id,
        title: file.name,
        kind: 'document',
        content,
        modifiedAt,
        externalId: file.id,
        url: `https://docs.google.com/document/d/${file.id}/edit`
      },
      meta: { driveVersion: file.version || null }
    }]);
    return event;
  }

  async #exportDocument(fileId) {
    const authHeaders = await this.auth.headers();
    const attempts = this.maxRetries + 1;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.#checkBudget();
      const controller = new AbortController();
      let response;
      try {
        response = await withTimeout(
          Promise.resolve().then(() => this.fetchImpl(
            `${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
            { headers: authHeaders, signal: controller.signal }
          )),
          this.#requestTimeoutMs(),
          () => new ConnectorError(`Document export timed out after ${this.timeoutMs}ms.`, {
            connectorId: this.id, retryable: true, timeout: true
          }),
          () => controller.abort()
        );
      } catch (error) {
        lastError = error instanceof ConnectorError
          ? error
          : new ConnectorError(`Could not export document ${fileId}: ${error.message}`, { connectorId: this.id, retryable: true });
        if (!lastError.retryable || attempt === attempts - 1) throw lastError;
        await this.#backoff(attempt, null);
        continue;
      }

      if (response.status === 401) throw new ConnectorError('Google rejected the access token (401). Re-authorise the connector.', { connectorId: this.id, status: 401 });
      if (response.status === 403) throw new ConnectorError('Google denied access (403). Check granted scopes and API enablement.', { connectorId: this.id, status: 403 });
      if (response.status === 429 || response.status >= 500) {
        lastError = new ConnectorError(`Document export failed with ${response.status}`, {
          connectorId: this.id, status: response.status, retryable: true
        });
        if (attempt === attempts - 1) throw lastError;
        await this.#backoff(attempt, response.headers?.get?.('retry-after'));
        continue;
      }
      if (!response.ok) {
        throw new ConnectorError(`Document export failed with ${response.status}`, {
          connectorId: this.id, status: response.status, retryable: false
        });
      }
      try {
        return await readTextBounded(response, this.maxDocumentChars, 'Document export');
      } catch (error) {
        throw new ConnectorError(`Could not read document ${fileId}: ${error.message}`, {
          connectorId: this.id, retryable: false
        });
      }
    }
    throw lastError || new ConnectorError(`Could not export document ${fileId}.`, { connectorId: this.id, retryable: true });
  }

  /**
   * Send an approved reply.
   *
   * Every header is validated before it is rendered: a line break in the
   * recipient or the subject would otherwise smuggle an extra header into the
   * message. The Message-ID is derived from the idempotency key, which makes
   * the send reconcilable: if a response is lost we can search the mailbox for
   * that exact Message-ID instead of guessing whether the message went out.
   */
  async execute({ to, subject, body, idempotencyKey, threadId = null }) {
    if (this.shadow) {
      throw new ConnectorError('Shadow mode is read-only. No external write was attempted.', { connectorId: this.id });
    }
    if (!this.sendEnabled) throw new ConnectorError('Gmail send is disabled for this connector (read-only mode).', { connectorId: this.id });
    if (!idempotencyKey) throw new ConnectorError('A send requires an idempotency key.', { connectorId: this.id });
    const recipient = parseMailbox(to);
    assertNoHeaderBreak(subject, 'The subject');
    if (!String(subject ?? '').trim()) throw new ConnectorError('The subject must not be empty.', { connectorId: this.id });
    const messageId = `<unprompted-${String(idempotencyKey).replace(/[^a-zA-Z0-9]/g, '-')}@unprompted.local>`;
    const raw = [
      `To: ${formatMailbox(recipient)}`,
      `Subject: ${encodeHeaderValue(String(subject))}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      normaliseBody(body)
    ].join('\r\n');
    const payload = { raw: encodeBase64Url(raw) };
    if (threadId) payload.threadId = threadId;
    const result = await this.#request(`${GMAIL}/users/me/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return { receiptId: result.id, provider: 'gmail', messageId, threadId: result.threadId || threadId || null };
  }

  /**
   * Read a sent message back by its provider id.
   *
   * The send response is an acceptance receipt; this is the independent check
   * that the message actually exists in the mailbox. A 404 is definitive; a
   * transient failure is reported as unknown so the caller blocks instead of
   * claiming completion.
   */
  async verifyMessage(messageId) {
    const id = String(messageId ?? '').trim();
    if (!id) return { status: 'unknown', receipt: null, detail: 'No provider message id was available to read back.' };
    try {
      const message = await this.#request(`${GMAIL}/users/me/messages/${encodeURIComponent(id)}?format=minimal`);
      return {
        status: 'found',
        receipt: { id: message.id || id, threadId: message.threadId || null },
        detail: 'Gmail returned the message by id.'
      };
    } catch (error) {
      if (error.status === 404) return { status: 'not_found', receipt: null, detail: 'Gmail reports no message with this id.' };
      if (error.status === 401 || error.status === 403) throw error;
      return { status: 'unknown', receipt: null, detail: `Could not read the message back: ${error.message}` };
    }
  }

  /**
   * Verify by looking the message up in the provider, not in local state.
   *
   * A definitive authorisation failure is rethrown rather than reported as
   * "unknown", so the caller can tell broken credentials apart from an
   * genuinely ambiguous delivery outcome.
   */
  async verify(idempotencyKey) {
    const messageId = `<unprompted-${String(idempotencyKey).replace(/[^a-zA-Z0-9]/g, '-')}@unprompted.local>`;
    let listing;
    try {
      listing = await this.#request(`${GMAIL}/users/me/messages?q=${encodeURIComponent(`rfc822msgid:${messageId}`)}&maxResults=1`);
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      return { status: 'unknown', receipt: null, detail: `Could not verify with the provider: ${error.message}` };
    }
    const found = (listing.messages || [])[0];
    if (!found) return { status: 'not_found', receipt: null, detail: 'Provider reports no message with this Message-ID.' };
    try {
      const message = await this.#request(`${GMAIL}/users/me/messages/${encodeURIComponent(found.id)}?format=metadata`);
      return { status: 'found', receipt: { id: found.id, threadId: message.threadId || null, messageId }, detail: 'Provider confirmed the message exists.' };
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      return { status: 'found', receipt: { id: found.id, threadId: null, messageId }, detail: 'Provider listed the message; thread metadata was unavailable.' };
    }
  }
}

export function googleConfigFromEnv(env = process.env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || null,
    clientSecret: env.GOOGLE_CLIENT_SECRET || null,
    refreshToken: env.GOOGLE_REFRESH_TOKEN || null,
    accountEmail: env.GOOGLE_ACCOUNT_EMAIL || null,
    gmailQuery: env.GOOGLE_GMAIL_QUERY || undefined,
    readGmail: env.GOOGLE_READ_GMAIL !== 'false',
    readDrive: env.GOOGLE_READ_DRIVE !== 'false',
    sendEnabled: env.GOOGLE_SEND_ENABLED === 'true',
    timeoutMs: env.GOOGLE_REQUEST_TIMEOUT_MS || undefined,
    syncBudgetMs: env.GOOGLE_SYNC_BUDGET_MS || undefined,
    maxDocumentChars: env.GOOGLE_MAX_DOCUMENT_CHARS || undefined,
    maxRetries: env.GOOGLE_MAX_RETRIES != null ? Number(env.GOOGLE_MAX_RETRIES) : undefined,
    retryBaseMs: env.GOOGLE_RETRY_BASE_MS || undefined
  };
}

export const googleApi = { GoogleAuth, GoogleWorkspaceConnector, googleConfigFromEnv };
