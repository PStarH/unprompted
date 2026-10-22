/**
 * Reasoning provider boundary.
 *
 * The system must be fully usable with no model configured. Deterministic logic
 * handles identity, extraction, comparison, permissions and state transitions.
 * A model is optional and is only consulted for semantic interpretation the
 * deterministic pass could not resolve — currently: proposing evidence probes
 * for requested content the lexicon does not cover.
 *
 * Configuration (all optional — see .env.example):
 *   UNPROMPTED_MODEL_BASE_URL   e.g. https://api.openai.com/v1
 *   UNPROMPTED_MODEL_API_KEY    secret, never logged
 *   UNPROMPTED_MODEL_NAME       e.g. gpt-4o-mini
 *
 * Operational guarantees, all enforced here rather than by callers:
 *   - a bounded number of calls per request and per minute
 *   - a concurrency ceiling
 *   - request and response size limits
 *   - a hard timeout
 *   - a failure is reported as a failure. It is never converted into a negative
 *     assessment result, and a timeout never means "work is incomplete".
 */

import { GENERIC_WORDS } from './probes/lexicon.js';
import { readTextBounded } from './bounded.js';

export const REASONING_LIMITS = {
  maxCallsPerRequest: 1,
  maxCallsPerMinute: 20,
  maxConcurrent: 2,
  maxRequestChars: 8000,
  maxResponseChars: 20000,
  timeoutMs: 20000,
  // Bounds on the bookkeeping itself. Without them a long-lived server grows
  // one map entry per request id and one rejection object per refused call.
  maxTrackedRequests: 500,
  maxRejections: 50
};

/** Token bucket plus per-request attempt tracking. */
export class ReasoningBudget {
  constructor(limits = {}, now = () => Date.now()) {
    this.limits = { ...REASONING_LIMITS, ...limits };
    this.now = now;
    this.windowStart = this.now();
    this.callsThisWindow = 0;
    this.inFlight = 0;
    this.perRequest = new Map();
    this.rejections = [];
    this.rejectionsDropped = 0;
  }

  #rollWindow() {
    if (this.now() - this.windowStart >= 60000) {
      this.windowStart = this.now();
      this.callsThisWindow = 0;
    }
  }

  /** Why a call must be refused right now, or null when it may proceed. */
  #refusal(requestId) {
    const used = this.perRequest.get(requestId) || 0;
    if (used >= this.limits.maxCallsPerRequest) {
      return `budget exhausted for this request (${used}/${this.limits.maxCallsPerRequest})`;
    }
    if (this.inFlight >= this.limits.maxConcurrent) {
      return `concurrency limit reached (${this.inFlight}/${this.limits.maxConcurrent})`;
    }
    if (this.callsThisWindow >= this.limits.maxCallsPerMinute) {
      return `rate limit reached (${this.callsThisWindow}/${this.limits.maxCallsPerMinute} per minute)`;
    }
    return null;
  }

  /**
   * Check whether a call may proceed. Returns { ok, reason }.
   *
   * A refusal is recorded here rather than by the caller. Observability of the
   * budget must not depend on every call site remembering to report it — an
   * unreported refusal makes the mechanism look idle when it is actually
   * throttling, which is exactly the wrong thing to hide.
   */
  tryAcquire(requestId) {
    this.#rollWindow();
    const refusal = this.#refusal(requestId);
    if (refusal) {
      this.record(refusal);
      return { ok: false, reason: refusal };
    }
    this.perRequest.set(requestId, (this.perRequest.get(requestId) || 0) + 1);
    // Map insertion order is oldest-first; evict completed request ids once the
    // cap is crossed. A currently active id may be evicted under extreme churn,
    // which only permits a new attempt, never more concurrency than the limit.
    const tracked = Number(this.limits.maxTrackedRequests);
    while (Number.isFinite(tracked) && tracked > 0 && this.perRequest.size > tracked) {
      this.perRequest.delete(this.perRequest.keys().next().value);
    }
    this.callsThisWindow += 1;
    this.inFlight += 1;
    return { ok: true };
  }

  release() { this.inFlight = Math.max(0, this.inFlight - 1); }

  record(reason) {
    this.rejections.push({ at: this.now(), reason });
    const cap = Number(this.limits.maxRejections);
    while (Number.isFinite(cap) && cap >= 0 && this.rejections.length > cap) {
      this.rejections.shift();
      this.rejectionsDropped += 1;
    }
  }

  /** Trim per-request counters so the map cannot grow without bound. */
  prune(keepIds = []) {
    const keep = new Set(keepIds);
    for (const key of this.perRequest.keys()) if (!keep.has(key)) this.perRequest.delete(key);
  }

  describe() {
    this.#rollWindow();
    return {
      callsThisWindow: this.callsThisWindow,
      inFlight: this.inFlight,
      trackedRequests: this.perRequest.size,
      recentRejections: this.rejections.slice(-5),
      rejectionsDropped: this.rejectionsDropped,
      limits: this.limits
    };
  }
}

export class NullReasoner {
  constructor(reason = 'No model provider is configured.') {
    this.reason = reason;
    this.budget = new ReasoningBudget();
  }
  get id() { return 'none'; }
  available() { return false; }
  status() {
    return { id: 'none', configured: false, available: false, detail: this.reason, budget: this.budget.describe() };
  }
  async interpretRequest() { return null; }
  async proposeProbes() { return null; }
}

export class OpenAiCompatibleReasoner {
  constructor({ baseUrl, apiKey = null, model, fetchImpl = globalThis.fetch, timeoutMs = REASONING_LIMITS.timeoutMs, limits = {}, id = 'openai-compatible' } = {}) {
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/$/, '') : null;
    this.apiKey = apiKey;
    this.model = model || null;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.id = id;
    this.lastError = null;
    this.lastFailureAt = null;
    this.calls = 0;
    this.budget = new ReasoningBudget(limits);
  }

  available() { return Boolean(this.baseUrl && this.model && typeof this.fetchImpl === 'function'); }

  status() {
    return {
      id: this.id,
      configured: Boolean(this.baseUrl && this.model),
      available: this.available(),
      model: this.model,
      baseUrl: this.baseUrl,
      calls: this.calls,
      lastError: this.lastError,
      lastFailureAt: this.lastFailureAt,
      budget: this.budget.describe()
    };
  }

  async #complete({ requestId, system, user }) {
    if (!this.available()) throw new Error('Model provider is not configured');

    const payload = JSON.stringify({ system, user });
    if (payload.length > this.budget.limits.maxRequestChars) {
      throw new Error(`Reasoning request exceeds ${this.budget.limits.maxRequestChars} characters`);
    }

    const permit = this.budget.tryAcquire(requestId);
    if (!permit.ok) {
      // The refusal was already recorded by tryAcquire; recording again here
      // would double-count it in recentRejections.
      const error = new Error(`Reasoning skipped: ${permit.reason}`);
      error.code = 'REASONING_BUDGET';
      throw error;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      this.calls += 1;
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Model provider returned ${response.status}`);
      // Read with a hard cap while the body is still streaming. Falling back to
      // response.json() keeps simple transports working; the stream path is what
      // prevents an unbounded buffer.
      const readable = typeof response.text === 'function'
        || (response.body && typeof response.body.getReader === 'function');
      const body = readable
        ? JSON.parse(await readTextBounded(response, this.budget.limits.maxResponseChars, 'Reasoning response'))
        : await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Model provider returned no content');
      this.lastError = null;
      return JSON.parse(content);
    } catch (error) {
      this.lastError = error.message;
      this.lastFailureAt = new Date().toISOString();
      throw error;
    } finally {
      clearTimeout(timer);
      this.budget.release();
    }
  }

  /**
   * Ask the model only to name the entity/deliverable it can see, never to
   * invent one.
   *
   * Every suggested phrase is checked against the original message before it is
   * used (see `groundModelContent` in requests.js). The model's own confidence
   * or quotation is never accepted as proof: only a verbatim span of the email
   * can become a requirement.
   */
  async interpretRequest({ subject, body }, requestId = 'interpret') {
    const system = [
      'You extract structured facts from a work email. Reply with JSON only.',
      'Keys: deliverable (single lowercase noun such as proposal, report, deck, plan),',
      'subjectEntity (the project or product name the deliverable is about),',
      'intent (one of update, send, update_and_send),',
      'requiredContent (array of objects, each {"text": short noun phrase, "sourceQuote": the exact phrase copied from the email, "sourceField": "subject" or "body"}).',
      'Every text and sourceQuote must appear verbatim in the email. Paraphrases are discarded.',
      'Never answer with a generic word such as "details" or "information": name the content itself.',
      'Use null for anything the email does not state. Never guess a project name that is not present.'
    ].join(' ');
    const result = await this.#complete({ requestId, system, user: `Subject: ${subject}\n\nBody:\n${body}` });
    if (!result || typeof result !== 'object') return null;
    if (!result.deliverable || !result.subjectEntity) return null;
    const requiredContent = [];
    const seen = new Set();
    for (const item of Array.isArray(result.requiredContent) ? result.requiredContent : []) {
      const candidate = typeof item === 'string' ? { text: item } : (item && typeof item === 'object' ? item : null);
      if (!candidate) continue;
      const text = String(candidate.text || '').replace(/\s+/g, ' ').trim();
      if (text.length < 3 || text.length > 80) continue;
      const key = text.toLowerCase();
      // A phrase the deterministic lexicon already calls contentless is not a
      // verifiable reading; accepting it would only add an unverifiable probe.
      if (GENERIC_WORDS.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { text };
      const sourceQuote = typeof candidate.sourceQuote === 'string' ? candidate.sourceQuote.replace(/\s+/g, ' ').trim() : '';
      if (sourceQuote) entry.sourceQuote = sourceQuote;
      if (candidate.sourceField === 'subject' || candidate.sourceField === 'body') entry.sourceField = candidate.sourceField;
      requiredContent.push(entry);
      if (requiredContent.length >= 12) break;
    }
    return {
      deliverable: String(result.deliverable).toLowerCase(),
      subjectEntity: String(result.subjectEntity),
      intent: ['update', 'send', 'update_and_send'].includes(result.intent) ? result.intent : 'update_and_send',
      requiredContent
    };
  }

  /**
   * Ask the model to propose evidence probes for requested content the
   * deterministic pass could not cover.
   *
   * The model is told that the justification must be copied verbatim. The
   * planner independently verifies that, so an invented quotation is rejected
   * rather than trusted.
   */
  async proposeProbes({ request, uncovered, providers, strategies, contextHints = [] }, requestId = 'plan') {
    const system = [
      'You propose evidence probes that decide whether a work deliverable satisfies a request.',
      'Reply with JSON only: {"probes": [ ... ]}.',
      'Each probe must have exactly these keys:',
      '  concept            short noun phrase naming the content to look for',
      '  criterionLabel     short human label for the requirement',
      '  provider           one of the allowed providers',
      '  strategies         array of allowed strategies, most precise first',
      '  keywords           array of lowercase search terms (2-40 chars)',
      '  justification      an EXACT quotation copied from the request text that asks for this content',
      '  expectedEvidence   what a satisfying document would contain',
      '  constraints        {"freshness": true|false}',
      'Rules you must follow:',
      '  - justification MUST be copied character-for-character from the request. Do not paraphrase it.',
      '  - Propose at most one probe per uncovered requirement.',
      '  - Propose only what the request actually asks for. Do not add extra requirements.',
      '  - A probe describes what to investigate. It does not claim anything is satisfied.',
      '  - If the request asks for all of a named set ("all reviewers"), propose one probe using the',
      '    coverage_statement strategy with keywords naming that set.',
      '  - Keywords must be content words from the request. Never emit generic words like "details".'
    ].join('\n');
    const user = JSON.stringify({
      entity: request.subjectEntity,
      deliverable: request.deliverable,
      intent: request.intent,
      requestText: request.text,
      qualifiers: (request.qualifiers || []).map(item => item.text),
      uncoveredRequirements: uncovered,
      allowedProviders: providers,
      allowedStrategies: strategies,
      contextHints
    }, null, 2);
    const result = await this.#complete({ requestId, system, user });
    if (!result || !Array.isArray(result.probes)) return null;
    return result.probes;
  }
}

/**
 * Build a reasoner from the environment. Never throws and never requires
 * credentials: an unconfigured environment simply yields the null provider.
 */
export function createReasoner(env = process.env, { fetchImpl } = {}) {
  const baseUrl = env.UNPROMPTED_MODEL_BASE_URL;
  const model = env.UNPROMPTED_MODEL_NAME;
  if (!baseUrl || !model) return new NullReasoner();
  return new OpenAiCompatibleReasoner({
    baseUrl,
    model,
    apiKey: env.UNPROMPTED_MODEL_API_KEY || null,
    ...(fetchImpl ? { fetchImpl } : {}),
    limits: env.UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE
      ? { maxCallsPerMinute: Number(env.UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE) }
      : {}
  });
}

export const reasoningApi = { REASONING_LIMITS, ReasoningBudget, NullReasoner, OpenAiCompatibleReasoner, createReasoner };
