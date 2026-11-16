import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { iso } from './durable/database.js';
import { DurableJobs, DurableWorker } from './durable/jobs.js';
import { HttpRequestError, readRawBody } from './http-transport.js';

/**
 * GitHub repository webhook receiver.
 *
 * The signature authenticates the raw request body only. Delivery and event
 * headers are untrusted routing hints, so a receipt is deduplicated twice:
 * once by the current account plus the delivery GUID, and once by the current
 * account plus the SHA-256 digest of the exact raw body. The body itself, issue
 * text and the shared secret are never stored.
 *
 * A verified delivery is only a prompt to run the existing ConnectorSync pull.
 * It is never evidence, authorization or a source of provider content.
 */

export const GITHUB_WEBHOOK_PATH = '/api/webhooks/github';
export const GITHUB_WEBHOOK_LIMITS = Object.freeze({
  maxBodyBytes: 256 * 1024,
  timeoutMs: 10_000,
  idleTimeoutMs: 5_000
});
export const GITHUB_WEBHOOK_QUEUE = 'webhooks';
export const GITHUB_WEBHOOK_JOB_TYPE = 'github_webhook_pull';

const DELIVERY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCOUNT_ID = /^[1-9][0-9]{0,19}$/;
const SIGNATURE_VALUE = /^sha256=([0-9a-f]{64})$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const HEX40 = /^[a-f0-9]{40}$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const EVENT_RULES = Object.freeze({
  issues: {
    actions: ['opened', 'edited', 'reopened', 'closed', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'transferred', 'deleted'],
    validate: payload => isObject(payload.issue) && Number.isSafeInteger(payload.issue.id) && payload.issue.id > 0
      && Number.isSafeInteger(payload.issue.number) && payload.issue.number > 0 && typeof payload.issue.title === 'string'
  },
  pull_request: {
    actions: ['opened', 'edited', 'reopened', 'closed', 'synchronize', 'review_requested', 'review_request_removed',
      'ready_for_review', 'converted_to_draft', 'assigned', 'unassigned', 'labeled', 'unlabeled'],
    validate: payload => isObject(payload.pull_request) && Number.isSafeInteger(payload.pull_request.id) && payload.pull_request.id > 0
      && Number.isSafeInteger(payload.pull_request.number) && payload.pull_request.number > 0
  },
  pull_request_review: {
    actions: ['submitted', 'edited', 'dismissed'],
    validate: payload => isObject(payload.pull_request) && Number.isSafeInteger(payload.pull_request.number) && payload.pull_request.number > 0
      && isObject(payload.review) && Number.isSafeInteger(payload.review.id)
  },
  push: {
    actions: null,
    validate: payload => typeof payload.ref === 'string' && payload.ref.startsWith('refs/') && payload.ref.length <= 256
      && HEX40.test(String(payload.before || '')) && HEX40.test(String(payload.after || ''))
  },
  workflow_run: {
    actions: ['requested', 'in_progress', 'completed'],
    validate: payload => isObject(payload.workflow_run) && Number.isSafeInteger(payload.workflow_run.id) && payload.workflow_run.id > 0
      && typeof payload.workflow_run.status === 'string'
  }
});

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const configError = code => Object.freeze({
  enabled: true, configured: false, code, secret: null, repositories: new Set(), accountId: null
});

/** Parse trusted environment configuration without ever echoing the secret. */
export function parseGitHubWebhookConfig(env = {}) {
  if (env.UNPROMPTED_GITHUB_WEBHOOK_ENABLED !== 'true') {
    return Object.freeze({ enabled: false, configured: false, code: 'WEBHOOK_DISABLED', secret: null, repositories: new Set(), accountId: null });
  }
  const secret = env.UNPROMPTED_GITHUB_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 1024) return configError('WEBHOOK_CONFIG_SECRET');
  const names = String(env.UNPROMPTED_GITHUB_WEBHOOK_REPOS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!names.length || names.length > 100) return configError('WEBHOOK_CONFIG_REPOSITORIES');
  const repositories = new Set();
  for (const name of names) {
    if (!REPOSITORY_NAME.test(name)) return configError('WEBHOOK_CONFIG_REPOSITORIES');
    repositories.add(name.toLowerCase());
  }
  const accountId = String(env.UNPROMPTED_GITHUB_WEBHOOK_ACCOUNT_ID || '').trim();
  if (!ACCOUNT_ID.test(accountId)) return configError('WEBHOOK_CONFIG_ACCOUNT');
  return Object.freeze({ enabled: true, configured: true, code: null, secret, repositories, accountId });
}

/**
 * Constant-time verification of GitHub's X-Hub-Signature-256 over raw bytes.
 * Exported so the official HMAC test vector can be checked directly.
 */
export function verifyGitHubSignature({ secret, rawBody, signatureHeader } = {}) {
  if (typeof secret !== 'string' || !secret || !Buffer.isBuffer(rawBody) || typeof signatureHeader !== 'string') return false;
  const match = SIGNATURE_VALUE.exec(signatureHeader);
  if (!match) return false;
  const provided = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function rawHeaderValues(req, name) {
  const values = [];
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === name) values.push(String(raw[index + 1]));
  }
  return values;
}

function repeatedHeader(values) {
  return values.length > 1;
}

function respond(req, res, status, value, { close = false } = {}) {
  if (res.destroyed || res.writableEnded || res.headersSent) return false;
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(close ? { connection: 'close' } : {})
    });
    res.end(JSON.stringify(value));
    if (close) res.once('finish', () => {
      try { if (!req.socket?.destroyed) req.socket?.destroy(); } catch { /* already gone */ }
    });
    return true;
  } catch {
    try { res.destroy(); } catch { /* already gone */ }
    return false;
  }
}

const failure = (code, message) => Object.assign(new Error(message), { code });

export class GitHubWebhookService {
  #config;
  #database;
  #jobs;
  #db;
  #setup;
  #getSync;
  #getRuntime;
  #getAccountId;
  #getLifecycle;
  #now;
  #limits;
  #maxPending;
  #retentionMs;
  #maxCompleted;
  #tickMs;
  #reconcileMs;
  #secret;
  #worker;
  #started = false;
  #stopped = false;
  #stoppedPromise = null;
  #tickTimer = null;
  #reconcileTimer = null;
  #activeControllers = new Set();
  #lastPullAt = null;
  #lastErrorCode = null;

  constructor({
    store = null,
    setup = null,
    getSync = null,
    getRuntime = null,
    getAccountId = null,
    getLifecycle = () => 'running',
    env = process.env,
    config = null,
    now = Date.now,
    autoStart = false,
    tickMs = 1000,
    reconcileMs = 30_000,
    limits = {},
    maxPending = 128,
    retentionMs = 7 * 24 * 60 * 60 * 1000,
    maxCompleted = 10_000
  } = {}) {
    this.#config = config || parseGitHubWebhookConfig(env);
    this.#database = store?.database || null;
    this.#db = this.#database?.db || null;
    this.#jobs = store?.jobs || (this.#database ? new DurableJobs(this.#database) : null);
    this.#setup = setup;
    this.#getSync = getSync;
    this.#getRuntime = getRuntime;
    this.#getAccountId = getAccountId;
    this.#getLifecycle = getLifecycle;
    this.#now = now;
    this.#limits = Object.freeze({ ...GITHUB_WEBHOOK_LIMITS, ...limits });
    this.#maxPending = Math.max(1, Math.min(10_000, Number(maxPending) || 128));
    this.#retentionMs = Math.max(0, Number(retentionMs) || 0);
    this.#maxCompleted = Math.max(0, Math.min(1_000_000, Number(maxCompleted) || 0));
    this.#tickMs = Math.max(50, Number(tickMs) || 1000);
    this.#reconcileMs = Math.max(1000, Number(reconcileMs) || 30_000);
    this.#secret = this.#config.secret;
    this.#lastErrorCode = this.#config.code || null;

    // Only static configurability decides whether the durable worker exists.
    // The transient lifecycle, account and observation state are admission
    // checks: the server constructs the receiver while workspaceChanging is
    // still true, and it must keep the worker so the queue drains after the
    // rebuild instead of requiring a process restart.
    if (!this.#staticAvailabilityError()) {
      this.#worker = new DurableWorker({
        jobs: this.#jobs,
        id: `webhooks:${process.pid}:${randomUUID()}`,
        queue: GITHUB_WEBHOOK_QUEUE,
        deadlines: { [GITHUB_WEBHOOK_JOB_TYPE]: 5 * 60_000 },
        handlers: { [GITHUB_WEBHOOK_JOB_TYPE]: (job, context) => this.#runJob(job, context) },
        recovery: job => this.#recover(job),
        onDead: (job, error) => this.#dead(job, error)
      });
    }
    if (autoStart) this.start();
  }

  start() {
    if (this.#started || this.#stopped || !this.#worker) return this;
    this.#started = true;
    this.#tickTimer = setInterval(() => { void this.kick(); }, this.#tickMs);
    this.#tickTimer?.unref?.();
    this.#reconcileTimer = setInterval(() => {
      try { this.refresh(); }
      catch { this.#lastErrorCode = 'storage_unavailable'; }
    }, this.#reconcileMs);
    this.#reconcileTimer?.unref?.();
    try { this.refresh(); }
    catch { this.#lastErrorCode = 'storage_unavailable'; }
    return this;
  }

  /**
   * Wake the webhook queue after a durable receipt was committed. A blocked
   * lifecycle or a stopped receiver must not claim work or call the provider;
   * the bounded timer retries once the server has rebound the workspace.
   */
  kick() {
    if (!this.#worker || this.#stopped || this.#lifecycleBlocked()) return Promise.resolve(false);
    return this.#worker.tick().catch(() => {
      this.#lastErrorCode = 'worker_failed';
      return false;
    });
  }

  async drain({ maxJobs = 100 } = {}) {
    if (!this.#worker || this.#stopped || this.#lifecycleBlocked()) return 0;
    return this.#worker.drain({ maxJobs });
  }

  async stop() {
    if (this.#stopped) return this.#stoppedPromise || Promise.resolve();
    this.#stopped = true;
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#tickTimer = null;
    this.#reconcileTimer = null;
    for (const controller of this.#activeControllers) {
      try { controller.abort(new Error('The GitHub webhook service stopped.')); } catch { /* already aborted */ }
    }
    this.#activeControllers.clear();
    const worker = this.#worker;
    this.#worker = null;
    this.#stoppedPromise = worker ? worker.close().catch(() => {}) : Promise.resolve();
    return this.#stoppedPromise;
  }

  describe() {
    let pending = 0, retained = 0, lastReceivedAt = null;
    if (this.#db) {
      try {
        pending = this.#db.prepare("SELECT COUNT(*) n FROM github_webhook_receipts WHERE state IN ('queued','pulling','paused')").get().n;
        retained = this.#db.prepare("SELECT COUNT(*) n FROM github_webhook_receipts WHERE state IN ('completed','expired','cancelled')").get().n;
        lastReceivedAt = this.#db.prepare('SELECT MAX(received_at) at FROM github_webhook_receipts').get()?.at || null;
      } catch { this.#lastErrorCode = 'storage_unavailable'; }
    }
    return {
      provider: 'github',
      mode: 'repository-webhook',
      enabled: this.#config.enabled === true,
      configured: this.#config.configured === true,
      available: this.#available(),
      paused: !this.#monitoringEnabled(),
      accountBound: this.#accountMatches(),
      pending,
      retained,
      lastReceivedAt,
      lastPullAt: this.#lastPullAt,
      lastErrorCode: this.#lastErrorCode
    };
  }

  /**
   * Handle one POST /api/webhooks/github request. Raw bytes are read and the
   * signature verified before this function parses JSON. Transport limit
   * failures are raised as HttpRequestError so the server applies its existing
   * close rules; everything else is a bounded JSON response without body text.
   */
  async handle(req, res) {
    const unavailable = this.#availabilityError();
    if (unavailable) return respond(req, res, 503, { error: 'GitHub webhooks are not available.', code: unavailable }, { close: true });

    const headers = this.#strictHeaders(req);
    if (!headers.signature) {
      // The body was not read, so the connection cannot be reused safely.
      this.#lastErrorCode = 'invalid_signature';
      return respond(req, res, 401, { error: 'A valid signature is required.', code: 'INVALID_SIGNATURE' }, { close: true });
    }

    const raw = await readRawBody(req, this.#limits);
    if (!verifyGitHubSignature({ secret: this.#secret, rawBody: raw, signatureHeader: headers.signature })) {
      this.#lastErrorCode = 'invalid_signature';
      return respond(req, res, 401, { error: 'A valid signature is required.', code: 'INVALID_SIGNATURE' });
    }

    let text;
    try { text = UTF8.decode(raw); }
    catch { return respond(req, res, 400, { error: 'The webhook body is not valid UTF-8.', code: 'INVALID_PAYLOAD' }); }
    let payload;
    try { payload = JSON.parse(text); }
    catch { return respond(req, res, 400, { error: 'The webhook body is not valid JSON.', code: 'INVALID_PAYLOAD' }); }
    if (!isObject(payload)) return respond(req, res, 400, { error: 'The webhook body must be a JSON object.', code: 'INVALID_PAYLOAD' });

    if (!this.#accountMatches()) {
      this.#lastErrorCode = 'account_unavailable';
      return respond(req, res, 503, { error: 'The configured GitHub account is not connected.', code: 'WEBHOOK_ACCOUNT_UNAVAILABLE' });
    }

    // GitHub App installation deliveries are explicitly out of scope. Their
    // installation object must never be treated as a grant for a local account.
    if (payload.installation != null) {
      return respond(req, res, 400, { error: 'GitHub App installation deliveries are not supported.', code: 'INSTALLATION_UNSUPPORTED' });
    }

    if (headers.event === 'ping') {
      const repository = isObject(payload.repository) ? payload.repository.full_name : null;
      if (repository != null && !this.#repositoryAllowed(repository)) {
        this.#lastErrorCode = 'repository_not_allowed';
        return respond(req, res, 403, { error: 'This repository is not allowed.', code: 'REPOSITORY_NOT_ALLOWED' });
      }
      return respond(req, res, 200, { ok: true, event: 'ping', configured: true });
    }

    const rule = EVENT_RULES[headers.event];
    if (!rule) return respond(req, res, 202, { accepted: false, state: 'ignored', reason: 'unsupported_event' });
    const action = payload.action ?? null;
    if (rule.actions) {
      if (typeof action !== 'string' || !rule.actions.includes(action)) {
        return respond(req, res, 202, { accepted: false, state: 'ignored', reason: 'unsupported_action' });
      }
    } else if (action != null) {
      return respond(req, res, 202, { accepted: false, state: 'ignored', reason: 'unsupported_action' });
    }
    if (!isObject(payload.repository) || !REPOSITORY_NAME.test(String(payload.repository.full_name || ''))
      || !Number.isSafeInteger(payload.repository.id) || payload.repository.id <= 0 || !rule.validate(payload)) {
      return respond(req, res, 400, { error: 'The webhook payload has an unsupported shape.', code: 'INVALID_PAYLOAD' });
    }
    const repository = payload.repository.full_name;
    if (!this.#repositoryAllowed(repository)) {
      this.#lastErrorCode = 'repository_not_allowed';
      return respond(req, res, 403, { error: 'This repository is not allowed.', code: 'REPOSITORY_NOT_ALLOWED' });
    }

    if (this.#revoked()) {
      this.#lastErrorCode = 'permission_revoked';
      return respond(req, res, 202, { accepted: false, state: 'paused', code: 'PERMISSION_REVOKED' });
    }
    if (!this.#monitoringEnabled()) {
      this.#lastErrorCode = 'monitoring_paused';
      return respond(req, res, 202, { accepted: false, state: 'paused', code: 'MONITORING_PAUSED' });
    }
    if (!this.#connectorLive()) {
      this.#lastErrorCode = 'connector_unavailable';
      return respond(req, res, 202, { accepted: false, state: 'paused', code: 'CONNECTOR_UNAVAILABLE' });
    }

    const accountId = this.#currentAccountId();
    const digest = createHash('sha256').update(raw).digest('hex');
    let outcome;
    try {
      outcome = this.#accept({ accountId, delivery: headers.delivery, digest, repository,
        event: headers.event, action });
    } catch (error) {
      if (error?.code === 'WEBHOOK_DELIVERY_CONFLICT') {
        this.#lastErrorCode = 'delivery_conflict';
        return respond(req, res, 409, { error: 'This delivery id was already used for a different body.', code: 'WEBHOOK_DELIVERY_CONFLICT' });
      }
      if (error?.code === 'WEBHOOK_BACKLOG_FULL') {
        this.#lastErrorCode = 'backlog_full';
        return respond(req, res, 503, { error: 'The webhook backlog is full.', code: 'WEBHOOK_BACKLOG_FULL' });
      }
      this.#lastErrorCode = 'storage_unavailable';
      return respond(req, res, 503, { error: 'The webhook receipt could not be stored.', code: 'WEBHOOK_STORAGE_UNAVAILABLE' });
    }

    this.#lastErrorCode = null;
    const result = { accepted: true, duplicate: outcome.duplicate, state: outcome.state, receiptId: outcome.id };
    const sent = outcome.duplicate
      ? respond(req, res, 200, result)
      : respond(req, res, 202, result);
    if (outcome.created) void this.kick();
    return sent;
  }

  /**
   * Adopt pending receipts after an explicit observation resume or restart.
   * Never pulls from here; it only repairs the durable queue.
   */
  refresh() {
    if (!this.#db || !this.#jobs || !this.#config.enabled || !this.#config.configured || this.#stopped) return { queued: 0 };
    if (this.#lifecycleBlocked()) return { queued: 0 };
    const now = this.#now();
    const at = iso(now);
    const accountId = this.#currentAccountId();
    const revoked = this.#revoked();
    return this.#database.atomic(() => {
      if (!accountId || accountId !== this.#config.accountId || revoked) {
        const code = revoked ? 'permission_revoked' : 'authorization_changed';
        const changed = this.#db.prepare(`UPDATE github_webhook_receipts SET state='expired',error_code=?,updated_at=?,completed_at=?
          WHERE state IN ('queued','pulling','paused')`).run(code, at, at).changes;
        if (changed) this.#lastErrorCode = code;
        return { queued: 0 };
      }
      // Retention is enforced on every reconcile, not only when a new delivery
      // arrives, so a quiet workspace still stays bounded.
      this.#prune(now);
      // A crash can leave a receipt marked pulling after its job is gone.
      const stale = this.#db.prepare(`SELECT r.id,r.job_id,j.state AS job_state FROM github_webhook_receipts r
        LEFT JOIN jobs j ON j.id=r.job_id WHERE r.state='pulling'`).all();
      for (const row of stale) {
        if (!row.job_state || !['queued', 'retry_wait', 'running', 'recovery_required'].includes(row.job_state)) {
          this.#db.prepare("UPDATE github_webhook_receipts SET state='queued',job_id=NULL,updated_at=? WHERE id=? AND state='pulling'").run(at, row.id);
        }
      }
      if (!this.#monitoringEnabled()) return { queued: 0 };
      // Paused receipts stay visible until observation is explicitly resumed.
      this.#db.prepare("UPDATE github_webhook_receipts SET state='queued',updated_at=? WHERE state='paused' AND account_id=?").run(at, accountId);
      const queued = this.#db.prepare(`SELECT r.id,r.job_id,j.state AS job_state FROM github_webhook_receipts r
        LEFT JOIN jobs j ON j.id=r.job_id WHERE r.state='queued' AND r.account_id=? ORDER BY r.received_at LIMIT 256`).all(accountId);
      const adoptable = queued.filter(row => !row.job_state || !['queued', 'retry_wait', 'running', 'recovery_required'].includes(row.job_state));
      if (!adoptable.length) return { queued: 0 };
      const job = this.#activeJob(accountId) || this.#enqueueJob(accountId);
      for (const row of adoptable) {
        this.#db.prepare("UPDATE github_webhook_receipts SET job_id=?,state='queued',updated_at=? WHERE id=? AND state='queued'").run(job.id, at, row.id);
      }
      return { queued: adoptable.length };
    });
  }

  /** Conditions that need a restart or a configuration change to satisfy. */
  #staticAvailabilityError() {
    if (!this.#config.enabled) return 'WEBHOOK_DISABLED';
    if (!this.#config.configured) return this.#config.code || 'WEBHOOK_CONFIG_INVALID';
    if (!this.#db || !this.#jobs) return 'WEBHOOK_SQLITE_REQUIRED';
    return null;
  }

  #availabilityError() {
    const staticError = this.#staticAvailabilityError();
    if (staticError) return staticError;
    if (this.#stopped) return 'WEBHOOK_UNAVAILABLE';
    if (this.#lifecycleBlocked()) return 'WEBHOOK_UNAVAILABLE';
    return null;
  }

  #available() {
    return !this.#availabilityError() && this.#accountMatches();
  }

  #lifecycleBlocked() {
    try { return this.#getLifecycle?.() !== 'running'; }
    catch { return true; }
  }

  /**
   * Why the pull may no longer act for `accountId`, or null when every
   * authorization fact still holds. This is the trusted closure handed to
   * ConnectorSync; it never reads the request body or headers.
   */
  #authorizationIssue(accountId) {
    if (this.#stopped) return 'service_stopped';
    if (this.#lifecycleBlocked()) return 'lifecycle_blocked';
    if (this.#revoked()) return 'permission_revoked';
    const current = this.#currentAccountId();
    if (!current || current !== accountId || current !== this.#config.accountId) return 'authorization_changed';
    if (!this.#monitoringEnabled()) return 'monitoring_paused';
    if (!this.#connectorLive()) return 'connector_unavailable';
    return null;
  }

  #monitoringEnabled() {
    try { return this.#setup?.get?.().monitoring?.enabled === true; }
    catch { return false; }
  }

  #currentAccountId() {
    try {
      const value = this.#getAccountId
        ? this.#getAccountId()
        : this.#setup?.getConnection?.('github')?.account?.id;
      if (value == null || value === '') return null;
      return String(value);
    } catch { return null; }
  }

  #accountMatches() {
    const current = this.#currentAccountId();
    return Boolean(this.#config.accountId && current && current === this.#config.accountId);
  }

  #connectorLive() {
    try {
      const runtime = this.#getRuntime?.();
      const connector = runtime?.connectors?.find(item => item.id === 'github');
      return Boolean(connector?.live);
    } catch { return false; }
  }

  #revoked() {
    try {
      const parsed = JSON.parse(this.#database?.get?.('revoked_connectors', '[]') || '[]');
      return Array.isArray(parsed) && parsed.includes('github');
    } catch { return true; }
  }

  #repositoryAllowed(repository) {
    return typeof repository === 'string' && this.#config.repositories.has(repository.toLowerCase());
  }

  #strictHeaders(req) {
    const signatureValues = rawHeaderValues(req, 'x-hub-signature-256');
    const deliveryValues = rawHeaderValues(req, 'x-github-delivery');
    const eventValues = rawHeaderValues(req, 'x-github-event');
    const typeValues = rawHeaderValues(req, 'content-type');
    const encodingValues = rawHeaderValues(req, 'content-encoding');
    const lengthValues = rawHeaderValues(req, 'content-length');
    const transferValues = rawHeaderValues(req, 'transfer-encoding');
    if ([signatureValues, deliveryValues, eventValues, typeValues, encodingValues, lengthValues, transferValues].some(repeatedHeader)) {
      throw new HttpRequestError('Repeated request header.', { status: 400, closeConnection: true });
    }
    if (transferValues.length && lengthValues.length) {
      throw new HttpRequestError('Ambiguous request framing.', { status: 400, closeConnection: true });
    }
    const delivery = deliveryValues[0]?.trim();
    if (!delivery || !DELIVERY_GUID.test(delivery)) {
      throw new HttpRequestError('Invalid delivery header.', { status: 400, closeConnection: true });
    }
    const event = eventValues[0]?.trim();
    if (!event || !EVENT_NAME.test(event)) {
      throw new HttpRequestError('Invalid event header.', { status: 400, closeConnection: true });
    }
    const contentType = typeValues[0]?.trim();
    if (!contentType || !CONTENT_TYPE.test(contentType)) {
      throw new HttpRequestError('Expected application/json.', { status: 400, closeConnection: true });
    }
    const encoding = encodingValues[0]?.trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      throw new HttpRequestError('Content encoding is not supported.', { status: 415, closeConnection: true });
    }
    const signature = signatureValues[0]?.trim() || null;
    // A structurally invalid signature is still read and compared below, so the
    // body is consumed and the connection stays reusable. The value itself is
    // never parsed into a digest.
    return { signature, delivery, event };
  }

  #activeJob(accountId) {
    const rows = this.#db.prepare(`SELECT id,payload_json FROM jobs WHERE queue_name=? AND job_type=?
      AND state IN ('queued','retry_wait') ORDER BY available_at,id LIMIT 10`).all(GITHUB_WEBHOOK_QUEUE, GITHUB_WEBHOOK_JOB_TYPE);
    for (const row of rows) {
      try {
        if (JSON.parse(row.payload_json)?.accountId === accountId) return row;
      } catch { /* an unreadable payload is not coalescible */ }
    }
    return null;
  }

  #enqueueJob(accountId) {
    return this.#jobs.enqueue({
      queue: GITHUB_WEBHOOK_QUEUE,
      type: GITHUB_WEBHOOK_JOB_TYPE,
      key: `github-webhook:${accountId}:${randomUUID()}`,
      payload: { accountId },
      maxAttempts: 12
    });
  }

  #accept({ accountId, delivery, digest, repository, event, action }) {
    const now = this.#now();
    const at = iso(now);
    return this.#database.atomic(() => {
      const byDelivery = this.#db.prepare('SELECT * FROM github_webhook_receipts WHERE account_id=? AND delivery_guid=?').get(accountId, delivery);
      if (byDelivery) {
        if (byDelivery.body_digest !== digest) throw failure('WEBHOOK_DELIVERY_CONFLICT', 'The delivery id was reused for a different body.');
        return { duplicate: true, created: false, id: byDelivery.id, state: byDelivery.state };
      }
      const byDigest = this.#db.prepare('SELECT * FROM github_webhook_receipts WHERE account_id=? AND body_digest=?').get(accountId, digest);
      if (byDigest) return { duplicate: true, created: false, id: byDigest.id, state: byDigest.state };

      const pending = this.#db.prepare("SELECT COUNT(*) n FROM github_webhook_receipts WHERE state IN ('queued','pulling','paused')").get().n;
      if (pending >= this.#maxPending) throw failure('WEBHOOK_BACKLOG_FULL', 'The webhook backlog is full.');
      this.#prune(now);

      const job = this.#activeJob(accountId) || this.#enqueueJob(accountId);
      const id = randomUUID();
      this.#db.prepare(`INSERT INTO github_webhook_receipts
        (id,account_id,delivery_guid,body_digest,repository,event,action,state,job_id,error_code,received_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,?,?,'queued',?,NULL,?,?,NULL)`)
        .run(id, accountId, delivery, digest, repository.toLowerCase(), event, action, job.id, at, at);
      return { duplicate: false, created: true, id, state: 'queued' };
    });
  }

  #prune(now) {
    const cutoff = iso(now - this.#retentionMs);
    this.#db.prepare(`DELETE FROM github_webhook_receipts WHERE id IN (
      SELECT id FROM github_webhook_receipts WHERE state IN ('completed','expired','cancelled')
      AND COALESCE(completed_at,updated_at) < ? ORDER BY COALESCE(completed_at,updated_at) LIMIT 100)`).run(cutoff);
    const retained = this.#db.prepare("SELECT COUNT(*) n FROM github_webhook_receipts WHERE state IN ('completed','expired','cancelled')").get().n;
    if (retained > this.#maxCompleted) {
      const excess = Math.min(100, retained - this.#maxCompleted);
      this.#db.prepare(`DELETE FROM github_webhook_receipts WHERE id IN (
        SELECT id FROM github_webhook_receipts WHERE state IN ('completed','expired','cancelled')
        ORDER BY COALESCE(completed_at,updated_at) ASC LIMIT ?)`).run(excess);
    }
  }

  #updateReceipts(ids, sql, ...values) {
    if (!ids.length) return 0;
    let changes = 0;
    this.#database.atomic(() => {
      for (const id of ids) changes += this.#db.prepare(sql).run(...values, id).changes;
    });
    return changes;
  }

  #finishReceipts(ids, state, code) {
    const at = iso(this.#now());
    return this.#updateReceipts(ids, `UPDATE github_webhook_receipts SET state=?,error_code=?,completed_at=?,updated_at=?
      WHERE id=? AND state IN ('queued','pulling','paused')`, state, code, at, at);
  }

  #pauseReceipts(ids, code) {
    const at = iso(this.#now());
    return this.#updateReceipts(ids, `UPDATE github_webhook_receipts SET state='paused',error_code=?,updated_at=?
      WHERE id=? AND state IN ('queued','pulling')`, code, at);
  }

  #requeueReceipts(ids, code) {
    const at = iso(this.#now());
    return this.#updateReceipts(ids, `UPDATE github_webhook_receipts SET state='queued',error_code=?,updated_at=?
      WHERE id=? AND state IN ('queued','pulling')`, code, at);
  }

  async #runJob(job, { signal, assertOwned } = {}) {
    const rows = this.#db.prepare(`SELECT * FROM github_webhook_receipts WHERE job_id=? AND state IN ('queued','pulling')
      ORDER BY received_at LIMIT 256`).all(job.id);
    if (!rows.length) return;
    if (this.#stopped || this.#lifecycleBlocked()) {
      // A tick can race the start of a rebuild. Do not claim provider work or
      // complete anything for the old workspace; leave the receipt durable and
      // let the retry run after the server has rebound the lifecycle.
      this.#requeueReceipts(rows.map(row => row.id), 'lifecycle_blocked');
      this.#lastErrorCode = 'lifecycle_blocked';
      throw Object.assign(new Error('The workspace is changing.'), {
        name: 'AbortError', code: 'WEBHOOK_LIFECYCLE_BLOCKED', retryAfterMs: 1000
      });
    }
    const accountId = this.#currentAccountId();
    const revoked = this.#revoked();
    if (!accountId || accountId !== this.#config.accountId || revoked) {
      const code = revoked ? 'permission_revoked' : 'authorization_changed';
      this.#finishReceipts(rows.map(row => row.id), 'expired', code);
      this.#lastErrorCode = code;
      return;
    }
    const mismatched = rows.filter(row => row.account_id !== accountId);
    if (mismatched.length) this.#finishReceipts(mismatched.map(row => row.id), 'expired', 'authorization_changed');
    const active = rows.filter(row => row.account_id === accountId);
    if (!active.length) return;

    if (!this.#monitoringEnabled()) {
      this.#pauseReceipts(active.map(row => row.id), 'monitoring_paused');
      this.#lastErrorCode = 'monitoring_paused';
      return;
    }
    if (!this.#connectorLive()) {
      this.#pauseReceipts(active.map(row => row.id), 'connector_unavailable');
      this.#lastErrorCode = 'connector_unavailable';
      return;
    }
    const sync = this.#getSync?.();
    if (!sync || typeof sync.runConnector !== 'function') {
      this.#pauseReceipts(active.map(row => row.id), 'sync_unavailable');
      this.#lastErrorCode = 'sync_unavailable';
      return;
    }

    const at = iso(this.#now());
    this.#updateReceipts(active.map(row => row.id), `UPDATE github_webhook_receipts SET state='pulling',updated_at=?
      WHERE id=? AND state IN ('queued','pulling')`, at);

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener?.('abort', forwardAbort, { once: true });
    this.#activeControllers.add(controller);
    let result;
    try {
      // The trusted fence closes over the current account and the live
      // authorization facts. ConnectorSync checks it before the pull, after
      // every page, and before ingest or a cursor commit; it never derives
      // authorization from the request body.
      result = await sync.runConnector('github', {
        afterCurrent: true,
        signal: controller.signal,
        isCurrent: () => this.#authorizationIssue(accountId) === null
      });
    } catch (error) {
      if (this.#jobs.owns(job)) this.#requeueReceipts(active.map(row => row.id), 'pull_failed');
      throw error;
    } finally {
      this.#activeControllers.delete(controller);
      signal?.removeEventListener?.('abort', forwardAbort);
    }

    if (controller.signal.aborted || signal?.aborted) {
      if (this.#jobs.owns(job)) this.#requeueReceipts(active.map(row => row.id), 'pull_aborted');
      this.#lastErrorCode = 'pull_aborted';
      throw Object.assign(new Error('The GitHub observation was stopped.'), { name: 'AbortError', code: 'WEBHOOK_ABORTED' });
    }
    try { assertOwned?.(); } catch { return; }
    if (!this.#jobs.owns(job)) return;

    // A page can finish after pause, revocation, an account change or the
    // start of a rebuild. The sync runner already refused to ingest or commit
    // that page; this settles the durable receipt for the current facts.
    const issue = this.#authorizationIssue(accountId);
    if (issue) {
      const ids = active.map(row => row.id);
      if (issue === 'permission_revoked' || issue === 'authorization_changed') {
        this.#finishReceipts(ids, 'expired', issue);
        this.#lastErrorCode = issue;
        return;
      }
      if (issue === 'monitoring_paused' || issue === 'connector_unavailable') {
        this.#pauseReceipts(ids, issue);
        this.#lastErrorCode = issue;
        return;
      }
      this.#requeueReceipts(ids, issue === 'lifecycle_blocked' ? 'lifecycle_blocked' : 'pull_aborted');
      this.#lastErrorCode = issue;
      throw Object.assign(new Error('The GitHub observation was stopped.'), {
        name: 'AbortError', code: 'WEBHOOK_ABORTED', retryAfterMs: 1000
      });
    }
    if (result?.aborted) {
      // The fence fired but the facts recovered before this check. An abandoned
      // page is never reused; one bounded retry performs a fresh pull.
      this.#requeueReceipts(active.map(row => row.id), 'pull_aborted');
      this.#lastErrorCode = 'pull_aborted';
      throw Object.assign(new Error('The GitHub observation was stopped.'), {
        name: 'AbortError', code: 'WEBHOOK_ABORTED', retryAfterMs: 1000
      });
    }

    if (result?.skipped) {
      // Re-check every authorization fact after yielding to the pull.
      if (this.#revoked()) {
        this.#finishReceipts(active.map(row => row.id), 'expired', 'permission_revoked');
        this.#lastErrorCode = 'permission_revoked';
      } else if (this.#currentAccountId() !== accountId || !this.#accountMatches()) {
        this.#finishReceipts(active.map(row => row.id), 'expired', 'authorization_changed');
        this.#lastErrorCode = 'authorization_changed';
      } else if (!this.#monitoringEnabled()) {
        this.#pauseReceipts(active.map(row => row.id), 'monitoring_paused');
        this.#lastErrorCode = 'monitoring_paused';
      } else if (!this.#connectorLive()) {
        this.#pauseReceipts(active.map(row => row.id), 'connector_unavailable');
        this.#lastErrorCode = 'connector_unavailable';
      } else {
        this.#requeueReceipts(active.map(row => row.id), 'pull_incomplete');
        this.#lastErrorCode = 'pull_incomplete';
        throw Object.assign(new Error('The GitHub connector was unavailable.'), { status: 503, retryAfterMs: 30_000 });
      }
      return;
    }

    if (!result || result.failed || result.partial || result.hasMore) {
      const rateLimited = result?.rateLimited === true || result?.status === 429;
      const code = rateLimited ? 'rate_limited' : result?.failed ? 'pull_failed' : result?.partial ? 'pull_partial' : 'pull_incomplete';
      this.#requeueReceipts(active.map(row => row.id), code);
      this.#lastErrorCode = code;
      const error = new Error('The GitHub observation did not complete.');
      error.status = rateLimited ? 429 : 503;
      if (rateLimited) error.code = 'RATE_LIMIT';
      error.retryAfterMs = rateLimited ? 60_000 : result?.failed ? 30_000 : 5_000;
      throw error;
    }

    this.#finishReceipts(active.map(row => row.id), 'completed', null);
    this.#lastPullAt = iso(this.#now());
    this.#lastErrorCode = null;
  }

  #recover(job) {
    const rows = this.#db.prepare(`SELECT * FROM github_webhook_receipts WHERE job_id=?
      AND state IN ('queued','pulling','paused')`).all(job.id);
    if (!rows.length) return { state: 'completed' };
    const accountId = this.#currentAccountId();
    const revoked = this.#revoked();
    if (!accountId || accountId !== this.#config.accountId || revoked) {
      const code = revoked ? 'permission_revoked' : 'authorization_changed';
      this.#finishReceipts(rows.map(row => row.id), 'expired', code);
      this.#lastErrorCode = code;
      return { state: 'cancelled' };
    }
    const at = iso(this.#now());
    this.#updateReceipts(rows.filter(row => row.state === 'pulling').map(row => row.id),
      "UPDATE github_webhook_receipts SET state='queued',updated_at=? WHERE id=? AND state='pulling'", at);
    // A pull only reads provider state. Replaying it is safe: cursor commits are
    // per page and ingest is idempotent.
    return { state: 'queued', safeToRepeat: true };
  }

  #dead(job) {
    try {
      const rows = this.#db.prepare(`SELECT id FROM github_webhook_receipts WHERE job_id=?
        AND state IN ('queued','pulling','paused')`).all(job.id);
      this.#finishReceipts(rows.map(row => row.id), 'expired', 'pull_attempts_exhausted');
    } catch { /* the dead job is already terminal */ }
    this.#lastErrorCode = 'pull_attempts_exhausted';
  }
}

export const githubWebhooksApi = { GitHubWebhookService, parseGitHubWebhookConfig, verifyGitHubSignature, GITHUB_WEBHOOK_PATH };
