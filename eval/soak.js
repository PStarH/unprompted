#!/usr/bin/env node
/**
 * Synthetic continuous-service soak benchmark.
 *
 * This measures the shipped engine and durable runtime under a repeated,
 * long-running synthetic workload. It is not a test-suite loop and it is not a
 * user-value claim: every provider, connector and reasoner here is a local
 * fixture, no account is contacted, and no remote write ever leaves the
 * process.
 *
 *   npm run eval:soak                              30 s smoke run
 *   npm run eval:soak -- --duration-ms=600000      ten minutes
 *   npm run eval:soak -- --seed=7 --output=...     reproducible fault plan
 *
 * Design rules that the report is built to keep:
 *
 *   - Verification is audited per task. A task counted `completed` must have
 *     its own receipt-backed `verified` action; two totals are not enough.
 *   - The connector has one append-only event log and one persisted cursor.
 *     Re-authorising continues the same stream instead of replaying a
 *     replaced two-event array.
 *   - Every work item gets a unique entity, title, thread and document that
 *     the shipped matcher understands. The generator is injective over the
 *     supported work-item range: four base-26 letters give 456,976 labels for
 *     at most 30,000 planned items (10,000 cycles with three burst items each).
 *   - Send attempts and accepted effects are different facts. Re-entering
 *     `send` for a key the remote already accepted is a blind resend and fails
 *     a named gate before any timeout/429/401 branch can mask it, even though
 *     the synthetic remote is natively idempotent. Multi-effect counts come
 *     from the remote's own accepted-effect records.
 *   - The queue must end with zero pending jobs, reached by the real runtime
 *     recovery. The runner never marks a job complete by hand.
 *   - Coverage counts observed injections and completed actions, not plan
 *     entries.
 *   - Shutdown is bounded: one cycle may take at most 60 s, cleanup at most
 *     5 s, so the wall time is at most duration + 65 s. SIGINT/SIGTERM wakes
 *     the current wait instead of being read at the next cycle boundary, and
 *     the crash branch's approval settlement is raced against the same bound.
 *   - Reports never contain message bodies, addresses, raw idempotency keys or
 *     task source ids. A caller-supplied workspace directory is never deleted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { CursorStore } from '../src/connectors/connector.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { googleConnectionIssue } from '../src/google-connection.js';
import { UncertainDeliveryError } from '../src/providers.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = Object.freeze({
  durationMs: 30000,
  maxCycles: 1000,
  seed: 20261112,
  output: path.join('outputs', 'soak', 'report.json')
});

/** The fault matrix every run must reach before it may report success. */
export const REQUIRED_FAULTS = Object.freeze([
  'normal_cycle',
  'duplicate_delivery',
  'burst_delivery',
  'network_timeout',
  'rate_limit',
  'oauth_expired',
  'restart_with_unfinished_work',
  'write_outcome_unknown'
]);

export const LIMITS = Object.freeze({
  minDurationMs: 1000,
  maxDurationMs: 86400000,
  minCycles: 1,
  maxCycles: 10000,
  /** Hard ceiling on one synthetic step. Nothing waits forever. */
  stepTimeoutMs: 15000,
  /** Ceiling for draining the durable queue inside one cycle. */
  settleTimeoutMs: 60000,
  /** Hard ceiling on one cycle. The phase boundary may overrun `durationMs` by this much. */
  maxCycleMs: 60000,
  /** Hard ceiling on closing the runtime and the database after a run. */
  cleanupTimeoutMs: 5000,
  /** Budget for the bounded final recovery phase. */
  finalDrainMs: 45000,
  /** The queue may never hold more than this many pending jobs. */
  maxPendingJobs: 512,
  /** Detailed identity evidence kept in the report (aggregates cover the rest). */
  maxIdentityEvidence: 256
});

const WORK_ITEM_CONNECTOR = 'synthetic-soak-source';
const OAUTH_CONNECTOR = 'synthetic-soak-oauth-source';
const ENTITY_LABEL = 'Ledger';
const ENTITY_PREFIX = 'Zx';
const ORDINAL_BASE = 26 ** 4;
/** Burst delivery is the largest cycle: three distinct work items. */
const MAX_ITEMS_PER_CYCLE = 3;

/** The library accepts these test-only switches. Nothing else. */
const TEST_HOOKS = Object.freeze({
  breakNormalPreparation: 'boolean',
  forgeCompletedWithoutVerification: 'boolean',
  forgeUndefinedKeyVerification: 'boolean',
  resendAcceptedKey: 'boolean',
  resendAcceptedKeyUnderFault: 'boolean',
  hangCrashApproval: 'boolean',
  skipInjection: 'fault',
  suppressUsage: 'boolean',
  failWithPrivateError: 'boolean'
});

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** A small, fully deterministic PRNG. The seed decides the fault plan. */
export function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * The fault plan for a run.
 *
 * The plan is a pure function of the seed, so a failed run can be replayed
 * exactly. The first eight cycles are pinned to the required fault matrix so a
 * short run still reaches every required scenario; later cycles repeat the
 * matrix in a seeded order.
 */
export function planFaults(seed, { maxCycles } = {}) {
  const random = seededRandom(seed);
  const pinned = [
    { fault: 'normal_cycle', note: 'One source event, prepared, explicitly approved, executed, read back and verified.' },
    { fault: 'duplicate_delivery', note: 'The same provider event is delivered repeatedly. No second external effect.' },
    { fault: 'burst_delivery', note: 'A burst of distinct events plus a burst of repeats.' },
    { fault: 'network_timeout', note: 'The provider times out before accepting, then recovers.' },
    { fault: 'rate_limit', note: 'The provider answers 429 before accepting, then recovers.' },
    { fault: 'oauth_expired', note: 'The source rejects a pull with 401 and needs re-authorisation by the fixture user.' },
    { fault: 'restart_with_unfinished_work', note: 'The workspace crashes with a dispatched write in flight, then reopens the same database.' },
    { fault: 'write_outcome_unknown', note: 'The provider accepts, then the response is lost. The outcome must be reconciled, not resent.' }
  ];
  const plan = [];
  const total = Math.max(1, Number(maxCycles) || DEFAULTS.maxCycles);
  for (let index = 0; index < total; index += 1) {
    if (index < pinned.length) { plan.push({ ...pinned[index], cycle: index, pinned: true }); continue; }
    const fault = pinned[Math.floor(random() * pinned.length)].fault;
    plan.push({ fault, cycle: index, pinned: false });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Identity generation
// ---------------------------------------------------------------------------

/**
 * A unique, matcher-readable entity for one work item.
 *
 * The shipped request matcher keeps a contiguous capitalised run before the
 * deliverable noun and ignores one-character tokens, so a bare ordinal such as
 * "A" or "24" would collapse. The label is `Zx` + a four-letter base-26
 * ordinal + " Ledger". `zx...` is not an English word, so it is never filtered
 * as a stopword or entity noise, and every sequence in `0..456975` has its own
 * label. The largest supported plan generates 30,000 items (10,000 cycles with
 * three burst items each), which is below that bound, so a supported run
 * cannot collide. An ordinal outside the range fails instead of wrapping.
 */
export function entityForSequence(sequence) {
  const value = Number(sequence);
  if (!Number.isInteger(value) || value < 0 || value >= ORDINAL_BASE) {
    throw Object.assign(new RangeError(`Entity ordinals cover 0..${ORDINAL_BASE - 1}; got ${sequence}.`), { code: 'SOAK_IDENTITY_RANGE' });
  }
  let rest = value;
  let letters = '';
  for (let index = 0; index < 4; index += 1) {
    letters = String.fromCharCode(97 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26);
  }
  return `${ENTITY_PREFIX}${letters[0].toUpperCase()}${letters.slice(1)} ${ENTITY_LABEL}`;
}

/** The inclusive number of distinct entities the generator can produce. */
export function entityCapacity() { return ORDINAL_BASE; }

const DELIVERABLES = ['proposal', 'report', 'summary'];

/** Build the document event and the request event for one synthetic work item. */
function buildEvents(sequence) {
  const entity = entityForSequence(sequence);
  const deliverable = DELIVERABLES[sequence % DELIVERABLES.length];
  const at = new Date(Date.UTC(2026, 0, 1, 9, sequence % 1440, sequence % 60)).toISOString();
  const mailId = `soak-mail-${sequence}`;
  const documentId = `soak-doc-${sequence}`;
  const title = `${entity} ${deliverable}`;
  return {
    sequence,
    entity,
    deliverable,
    title,
    mailId,
    documentId,
    mail: {
      id: `synthetic:${mailId}`,
      providerEventId: mailId,
      connectorId: WORK_ITEM_CONNECTOR,
      source: 'simulated',
      type: 'email.received',
      at,
      payload: {
        id: mailId, threadId: `soak-thread-${sequence}`,
        from: `requester-${sequence}@example.test`,
        to: 'workspace@example.test',
        subject: title,
        body: `Please update the ${title} with the latest experiment results and send the revised ${deliverable}.`,
        receivedAt: at
      }
    },
    document: {
      id: `synthetic:${documentId}`,
      providerEventId: documentId,
      connectorId: WORK_ITEM_CONNECTOR,
      source: 'simulated',
      type: 'document.modified',
      at,
      payload: {
        id: documentId, kind: deliverable, title,
        content: `# ${title}\n## Experiment results\nRun date: ${at.slice(0, 10)}\nSample size: ${1000 + sequence}\nControl: 5.0% conversion\nTreatment: 6.2% conversion\nConclusion: Treatment improved conversion.\n`
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/**
 * The synthetic "remote" side of a mail provider.
 *
 * It lives in its own file next to the workspace, not inside the engine's
 * process state. That matters: when the runner simulates a crash and reopens
 * the database, the provider's record of what it already accepted must still
 * be there — otherwise a recovered run would send a second copy and the
 * duplicate-effect measurement would be meaningless.
 *
 * The remote is natively idempotent: a repeated idempotency key returns the
 * receipt that already exists. That property is reported separately from the
 * `no-blind-resend` gate, which counts send *attempts* for an accepted key.
 */
export class SyntheticRemote {
  constructor(filename, { idempotent = true } = {}) {
    this.filename = filename;
    // The shipped synthetic provider is idempotent. A test may construct a
    // non-idempotent remote to prove that the multi-effect metric is derived
    // from accepted-effect records rather than assumed from deduplication.
    this.idempotent = idempotent !== false;
    this.state = this.#read();
  }
  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.receipts) {
        // Older remote files predate the append-only effect log. Rebuild it
        // from the receipts they hold; an idempotent remote has one effect per
        // stored key.
        if (!Array.isArray(parsed.effects)) {
          parsed.effects = Object.entries(parsed.receipts)
            .map(([key, receipt]) => ({ key, id: receipt?.id ?? null }))
            .filter(effect => effect.id);
        }
        return parsed;
      }
    } catch { /* the remote has not accepted anything yet */ }
    return { receipts: {}, effects: [], sequence: 0 };
  }
  #write() { fs.writeFileSync(this.filename, JSON.stringify(this.state)); }
  #index() {
    const index = new Map();
    for (const receipt of Object.values(this.state.receipts)) if (receipt?.id) index.set(receipt.id, receipt);
    return index;
  }
  accept(key, payload) {
    const existing = this.state.receipts[key];
    if (existing && this.idempotent) return { receipt: existing, duplicate: true };
    const receipt = {
      id: `synthetic-remote-${++this.state.sequence}`,
      provider: 'synthetic-soak-mail',
      status: 'accepted_simulation',
      idempotencyKey: key,
      to: payload.to,
      subject: payload.subject,
      body: payload.body
    };
    this.state.receipts[key] = receipt;
    // Every actual external effect is recorded here. A duplicate key that the
    // idempotent remote does not turn into a new effect adds no entry, so the
    // multi-effect count is an observation of remote facts.
    this.state.effects.push({ key, id: receipt.id });
    this.#write();
    return { receipt, duplicate: false };
  }
  /** Accepted effect records per key. Keys are never serialised into a report. */
  effectCountsByKey() {
    const counts = new Map();
    for (const effect of this.state.effects) counts.set(effect.key, (counts.get(effect.key) || 0) + 1);
    return counts;
  }
  /** Keys the remote actually gave more than one effect to. */
  keysWithMoreThanOneEffect() {
    let keys = 0;
    for (const count of this.effectCountsByKey().values()) if (count > 1) keys += 1;
    return keys;
  }
  lookupKey(key) {
    if (typeof key !== 'string' || !key) return { status: 'not_found' };
    const receipt = this.state.receipts[key];
    return receipt ? { status: 'found', receipt } : { status: 'not_found' };
  }
  /**
   * Find a stored receipt by its real `receipt.id`.
   *
   * A receipt id is the primary key of the lookup. When an idempotency key is
   * also given it must match the stored key; otherwise the caller is asking
   * about a different operation and this must not return another receipt.
   */
  find({ id = null, idempotencyKey = null } = {}) {
    if (typeof id !== 'string' || !id) return null;
    const receipt = this.#index().get(id) || null;
    if (!receipt) return null;
    if (idempotencyKey != null && idempotencyKey !== '' && receipt.idempotencyKey !== idempotencyKey) return null;
    return receipt;
  }
  /** The receipt for an id, without an operation assertion. Used by the audit. */
  receiptFor(id) {
    if (typeof id !== 'string' || !id) return null;
    return this.#index().get(id) || null;
  }
  /** Count of actual accepted effects, not keys. */
  count() { return this.state.effects.length; }
}

/** One bucket of send-attempt facts. Attempts, acceptance and effects differ. */
const sendStats = () => ({ attempts: 0, accepted: 0, failedBeforeAccept: 0, acceptedResponseLost: 0, duplicateAfterAccept: 0 });

/**
 * A synthetic mail provider.
 *
 * It never leaves the process. Every call that enters `send` is counted,
 * including calls that fail and calls that repeat a key the remote already
 * accepted. Acceptance and external effects come from the remote, not from the
 * caller's opinion.
 */
export class SyntheticMailProvider {
  constructor({ counters, remote } = {}) {
    this.kind = 'synthetic-soak-mail';
    this.id = 'synthetic-soak-mail';
    this.live = false;
    this.canSend = true;
    this.dispatchGuard = true;
    this.nativeIdempotency = true;
    this.counters = counters;
    this.remote = remote;
    this.fault = null;
    /** When set, the provider accepts the message and then never answers. */
    this.hang = null;
  }

  /** The runner decides what the next send does. */
  setFault(fault) { this.fault = fault || null; }

  send(payload, _failureMode = null, { beforeDispatch = null } = {}) {
    beforeDispatch?.();
    const key = payload?.idempotencyKey;
    const bucket = this.counters.scenarioSends(this.counters.currentScenario);
    this.counters.sends.attempts += 1;
    bucket.attempts += 1;
    // Observe an already-accepted key before any fault branch. A timeout, 429
    // or 401 thrown first would otherwise mask the blind resend: the attempt
    // would be classified as "failed before acceptance" even though the remote
    // had already accepted this exact key. This is a read of the remote's
    // receipt map, never an extra accept call.
    const alreadyAccepted = typeof key === 'string' && key !== '' && this.remote.lookupKey(key).status === 'found';
    if (alreadyAccepted) {
      this.counters.sends.duplicateAfterAccept += 1;
      bucket.duplicateAfterAccept += 1;
    }
    if (this.fault === 'timeout_before_accept') {
      this.counters.providerFaults.networkTimeout += 1;
      if (!alreadyAccepted) { this.counters.sends.failedBeforeAccept += 1; bucket.failedBeforeAccept += 1; }
      throw Object.assign(new UncertainDeliveryError('The synthetic provider timed out before confirming acceptance.'), { code: 'ETIMEDOUT' });
    }
    if (this.fault === 'rate_limit') {
      this.counters.providerFaults.rateLimit += 1;
      if (!alreadyAccepted) { this.counters.sends.failedBeforeAccept += 1; bucket.failedBeforeAccept += 1; }
      throw Object.assign(new Error('The synthetic provider is rate limiting this request.'), { status: 429, code: 'RATE_LIMIT' });
    }
    if (this.fault === 'unauthorized') {
      this.counters.providerFaults.oauthExpired += 1;
      if (!alreadyAccepted) { this.counters.sends.failedBeforeAccept += 1; bucket.failedBeforeAccept += 1; }
      throw Object.assign(new Error('The synthetic provider rejected the request (401). Re-authorise the connector.'), { status: 401 });
    }
    const { receipt, duplicate } = this.remote.accept(key, payload);
    if (duplicate) {
      // This is a send for a key the remote already accepted. The remote's
      // native idempotency hides the duplicate from the effect count; the
      // attempt is still a blind resend and the named gate must see it. It was
      // already counted before the fault branches above when it was observed
      // at entry, so count it only once.
      if (!alreadyAccepted) {
        this.counters.sends.duplicateAfterAccept += 1;
        bucket.duplicateAfterAccept += 1;
      }
      return receipt;
    }
    this.counters.sends.accepted += 1;
    bucket.accepted += 1;
    if (this.fault === 'timeout_after_accept') {
      this.counters.providerFaults.writeOutcomeUnknown += 1;
      this.counters.sends.acceptedResponseLost += 1;
      bucket.acceptedResponseLost += 1;
      throw new UncertainDeliveryError('The synthetic provider accepted the message but the response was lost.');
    }
    // A hung provider accepts the message and never answers. The caller must
    // treat the outcome as unknown and reconcile it later.
    if (this.hang) return this.hang(receipt);
    return receipt;
  }

  /**
   * Key first, then receipt id.
   *
   * The engine passes both when it has them. The receipt-id fallback is real:
   * it indexes by `receipt.id` and validates the stored idempotency key, so a
   * mismatched key cannot return another operation's receipt.
   */
  lookup(idempotencyKey, { receiptId = null } = {}) {
    const key = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : null;
    if (key) {
      const byKey = this.remote.lookupKey(key);
      if (byKey.status === 'found') return byKey;
    }
    if (receiptId) {
      const receipt = this.remote.find({ id: receiptId, idempotencyKey: key });
      if (receipt) return { status: 'found', receipt };
    }
    return { status: 'not_found' };
  }

  verifyReceipt(receipt) {
    const found = this.remote.find({ id: receipt?.id, idempotencyKey: receipt?.idempotencyKey ?? null });
    return found
      ? { status: 'found', receipt: found, detail: 'The synthetic provider holds this receipt.' }
      : { status: 'not_found', receipt: null, detail: 'The synthetic provider does not hold this exact receipt.' };
  }
}

/**
 * A synthetic reasoner.
 *
 * It is a scripted stand-in: no model, no network, no credential. It reports
 * usage on successful calls so the token ledger has something honest to
 * record. A suppressed report is unknown, never zero.
 */
export class SyntheticReasoner {
  constructor({ counters } = {}) {
    this.id = 'synthetic-soak-reasoner';
    this.counters = counters;
    this.failWith = null;
    this.budget = { prune() {} };
  }
  available() { return true; }
  status() { return { id: this.id, configured: true, available: true, calls: this.counters.modelCalls }; }
  async interpretRequest() {
    this.counters.modelCalls += 1;
    this.#reportUsage();
    return null;
  }
  async discoverRequestCandidate() {
    this.counters.modelCalls += 1;
    this.#reportUsage();
    return null;
  }
  async proposeProbes() {
    this.counters.modelCalls += 1;
    if (this.failWith === 'timeout') {
      this.counters.providerFaults.networkTimeout += 1;
      throw Object.assign(new Error('The synthetic reasoner timed out.'), { code: 'ETIMEDOUT' });
    }
    if (this.failWith === 'rate_limit') {
      this.counters.providerFaults.rateLimit += 1;
      throw Object.assign(new Error('The synthetic reasoner is rate limited.'), { status: 429 });
    }
    this.#reportUsage();
    // No probes: the deterministic evidence plan stands. A synthetic reasoner
    // must never invent evidence.
    return [];
  }
  #reportUsage() {
    if (this.counters.suppressUsage) return;
    this.counters.modelUsageReports += 1;
    this.onUsage?.({ provider: this.id, protocol: 'synthetic', model: 'synthetic-soak', input: 12, output: 7, cacheRead: 0, cacheWrite: 0 });
  }
}

/**
 * The append-only remote event log behind the connector cursor.
 *
 * It persists beside the database, so a reopen resumes the same stream. The
 * cursor is the offset into this log; an OAuth cycle appends new events and
 * never replaces the log or resets the cursor.
 */
export class SyntheticEventLog {
  constructor(filename) {
    this.filename = filename;
    this.state = this.#read();
  }
  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (parsed && Array.isArray(parsed.events)) return parsed;
    } catch { /* the log has not been written yet */ }
    return { events: [], appends: 0 };
  }
  #write() { fs.writeFileSync(this.filename, JSON.stringify(this.state)); }
  append(events) {
    const start = this.state.events.length;
    for (const event of events) this.state.events.push(structuredClone(event));
    this.state.appends += 1;
    this.#write();
    return { start, end: this.state.events.length };
  }
  page(offset, limit = 50) {
    const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
    return this.state.events.slice(from, from + limit).map(event => structuredClone(event));
  }
  get length() { return this.state.events.length; }
}

/**
 * A synthetic source connector.
 *
 * It reads the append-only event log from the persisted cursor and can fail
 * with a timeout, a 429 or a 401 so the connector health and re-authorisation
 * paths are exercised without a real account. The 401 is counted in the
 * connector branch that actually raises it.
 */
export class SyntheticConnector {
  constructor({ id = OAUTH_CONNECTOR, log = null, counters = null } = {}) {
    this.id = id;
    this.kind = 'synthetic-soak-source';
    this.live = true;
    this.log = log;
    this.counters = counters;
    this.fault = null;
    this.pulls = 0;
  }
  setFault(fault) { this.fault = fault || null; }
  capabilities() { return { read: ['events'], search: [], pagination: false, incremental: true, observation: 'pull', providerPush: false, write: [], verify: [] }; }
  async pull({ cursor } = {}) {
    this.pulls += 1;
    if (this.fault === 'timeout') {
      throw Object.assign(new Error('The synthetic source timed out.'), { code: 'ETIMEDOUT' });
    }
    if (this.fault === 'unauthorized') {
      this.counters.providerFaults.oauthExpired += 1;
      throw Object.assign(new Error('The synthetic source rejected the request (401). Re-authorise the connector.'), { status: 401, code: 'UNAUTHORIZED' });
    }
    if (this.fault === 'rate_limit') {
      throw Object.assign(new Error('The synthetic source is rate limiting this request.'), { status: 429, code: 'RATE_LIMIT' });
    }
    const offset = Number(cursor?.offset || 0);
    const events = this.log ? this.log.page(offset) : [];
    return { cursor: { offset: offset + events.length }, events };
  }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * One durable workspace that survives across cycles and restarts.
 *
 * The engine, the durable runtime and the synthetic provider are rebuilt on
 * every open. The database, the remote's receipts and the connector event log
 * are the only things that persist, which is what makes a reopen a real reopen.
 */
class SoakWorkspace {
  constructor({ directory, counters }) {
    this.directory = directory;
    this.counters = counters;
    this.filename = path.join(directory, 'state.json');
    this.remote = new SyntheticRemote(path.join(directory, 'remote.json'));
    this.eventLog = new SyntheticEventLog(path.join(directory, 'events.json'));
    this.store = null;
    this.engine = null;
    this.runtime = null;
    this.provider = null;
    this.reasoner = null;
    this.connector = null;
    this.generation = 0;
  }

  open() {
    this.store = new SqliteStore(this.filename);
    this.provider = new SyntheticMailProvider({ counters: this.counters, remote: this.remote });
    this.reasoner = new SyntheticReasoner({ counters: this.counters });
    this.connector = new SyntheticConnector({ id: OAUTH_CONNECTOR, log: this.eventLog, counters: this.counters });
    this.engine = new WorkEngine(this.store, { provider: this.provider, reasoner: this.reasoner });
    // No background connector is registered. Every pull in this benchmark is
    // made by the runner through an explicit ConnectorSync, so pull counts and
    // cursor movement are attributable.
    this.runtime = new DurableRuntime(this.engine, { tickMs: 25, connectorFor: () => null });
    this.runtime.start();
    this.generation += 1;
    return this;
  }

  /** Close the workspace exactly the way a process would. */
  async close() {
    if (!this.runtime) return;
    await this.runtime.close();
    await this.engine.whenSettled();
    this.store.close();
    this.runtime = null; this.engine = null; this.store = null;
  }

  /**
   * Abandon the workspace the way a crash does.
   *
   * Nothing is drained: the workers are frozen where they stand and the
   * database is closed underneath them. Any write that was in flight is left
   * exactly as the crash left it, so the reopen has to recover it.
   */
  abandon() {
    if (!this.runtime) return;
    this.runtime.suspended = true;
    this.runtime.closed = true;
    if (this.runtime.timer) clearInterval(this.runtime.timer);
    try { this.store.close(); } catch { /* a transaction in flight is part of the crash */ }
    this.runtime = null; this.engine = null; this.store = null;
  }

  /** Open the same database again. Durable facts must still be there. */
  async reopen() { await this.close(); return this.open(); }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArguments(argv = process.argv.slice(2)) {
  const options = { ...DEFAULTS };
  const errors = [];
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match) { errors.push(`Unknown argument: ${argument}`); continue; }
    const [, key, raw] = match;
    if (key === 'duration-ms') {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < LIMITS.minDurationMs || value > LIMITS.maxDurationMs) errors.push(`--duration-ms must be between ${LIMITS.minDurationMs} and ${LIMITS.maxDurationMs}.`);
      else options.durationMs = Math.floor(value);
    } else if (key === 'max-cycles') {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < LIMITS.minCycles || value > LIMITS.maxCycles) errors.push(`--max-cycles must be an integer between ${LIMITS.minCycles} and ${LIMITS.maxCycles}.`);
      else options.maxCycles = value;
    } else if (key === 'seed') {
      const value = Number(raw);
      if (!Number.isFinite(value)) errors.push('--seed must be a number.');
      else options.seed = Math.floor(value);
    } else if (key === 'output') {
      if (!raw || !String(raw).trim()) errors.push('--output needs a file path.');
      else options.output = path.resolve(PROJECT_ROOT, raw);
    } else errors.push(`Unknown argument: ${argument}`);
  }
  return { options, errors };
}

const USAGE = `Usage: node eval/soak.js [options]

  --duration-ms <ms>   Total run budget, 1000–86400000 (default 30000)
  --max-cycles <n>     Maximum cycles in the run, 1–10000 (default 1000)
  --seed <n>           Seed for the deterministic fault plan (default 20261112)
  --output <path>      Report path, relative to the project root
                       (default outputs/soak/report.json)
  --help               Show this message

The run is bounded and synthetic. It never contacts a real provider, account or
model, and it never performs a remote write.`;

// ---------------------------------------------------------------------------
// Errors and redaction
// ---------------------------------------------------------------------------

const soakError = (code, message) => Object.assign(new Error(message), { code });

/** True for the two failures that must stop the run instead of failing a cycle. */
const isStop = error => error?.code === 'SOAK_INTERRUPTED' || error?.code === 'SOAK_STEP_TIMEOUT';

/**
 * Find private data in a serialised report.
 *
 * Exported so a regression can feed it a deliberately leaking document and
 * prove the detector works without ever writing private data into a report.
 */
export function privacyViolations(serialised, { fragments = [] } = {}) {
  const violations = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialised)) violations.push('email-address');
  if (/\bsynthetic:[^\s"',;)]*/i.test(serialised) || /\bsoak-(?:mail|doc|thread)-\d+/i.test(serialised)) violations.push('source-id');
  if (/\brequest:[^\s"',;)]*/i.test(serialised)) violations.push('task-id');
  if (/\bsend:[^\s"',;)]*/i.test(serialised)) violations.push('idempotency-key');
  for (const fragment of fragments) {
    if (typeof fragment === 'string' && fragment.length >= 8 && serialised.includes(fragment)) { violations.push('generated-content'); break; }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const nonEmptyString = value => typeof value === 'string' && value.trim() !== '';

/**
 * The receipt proof behind one completed task.
 *
 * A verified status on the task is not enough. The action's id, idempotency
 * key and receipt id, the durable execution row and the remote receipt must
 * name the same operation, and every id must be a non-empty string. In
 * particular, two missing keys must not compare equal and pass: the old
 * `receipt.idempotencyKey === action.idempotencyKey` test accepted
 * `undefined === undefined`.
 */
export function proofIdsAgree({ action = null, execution = null, receipt = null } = {}) {
  if (!action || !execution || !receipt) return false;
  if (!nonEmptyString(action.id) || !nonEmptyString(action.idempotencyKey) || !nonEmptyString(action.receiptId)) return false;
  if (action.id !== action.idempotencyKey) return false;
  if (execution.status !== 'verified') return false;
  if (!nonEmptyString(execution.idempotency_key) || execution.idempotency_key !== action.idempotencyKey) return false;
  if (!nonEmptyString(execution.provider_receipt_id) || execution.provider_receipt_id !== action.receiptId) return false;
  if (!nonEmptyString(receipt.id) || receipt.id !== action.receiptId) return false;
  if (!nonEmptyString(receipt.idempotencyKey) || receipt.idempotencyKey !== action.idempotencyKey) return false;
  return true;
}

/** Read the durable counters for one open workspace. */
function readDurableFacts(workspace) {
  const db = workspace.store.db;
  const total = rows => rows.reduce((sum, row) => sum + Number(row.n || 0), 0);
  const executions = db.prepare('SELECT status, COUNT(*) n FROM tool_executions WHERE is_write=1 GROUP BY status').all();
  return {
    tasks: db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all(),
    executions,
    jobs: db.prepare('SELECT state, COUNT(*) n FROM jobs GROUP BY state').all(),
    inbox: db.prepare('SELECT COUNT(*) n FROM durable_inbox').get().n,
    executionCount: total(executions),
    pendingJobs: db.prepare("SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','retry_wait','running','recovery_required')").get().n
  };
}

/** Approve a task as the fixture user, once, and report what actually happened. */
async function approveTask(workspace, taskId, waitFor, { timeoutMs } = {}) {
  const startedAt = Date.now();
  const before = workspace.store.tasks.get(taskId);
  const publicTask = workspace.engine.publicState().tasks.find(task => task.id === taskId);
  if (!publicTask) return { attempted: false, error: null, elapsedMs: 0, beforeStatus: before?.status || null, task: before };
  if (publicTask.status !== 'ready_for_approval') {
    return { attempted: false, error: null, elapsedMs: 0, beforeStatus: publicTask.status, task: before };
  }
  try {
    await waitFor(workspace.engine.approve(taskId, { reviewToken: publicTask.reviewToken }), 'approval', timeoutMs);
    return { attempted: true, error: null, elapsedMs: Date.now() - startedAt, beforeStatus: 'ready_for_approval', task: workspace.store.tasks.get(taskId) };
  } catch (error) {
    if (isStop(error)) throw error;
    return { attempted: true, error, elapsedMs: Date.now() - startedAt, beforeStatus: 'ready_for_approval', task: workspace.store.tasks.get(taskId) };
  }
}

export async function runSoak({
  durationMs = DEFAULTS.durationMs,
  maxCycles = DEFAULTS.maxCycles,
  seed = DEFAULTS.seed,
  output = DEFAULTS.output,
  workspaceDirectory = null,
  keepWorkspace = false,
  shouldStop = () => false,
  signal = null,
  testHooks = null,
  onProgress = null
} = {}) {
  // ---------------------------------------------------------------- options
  if (!Number.isFinite(durationMs) || durationMs < LIMITS.minDurationMs || durationMs > LIMITS.maxDurationMs) {
    throw soakError('INVALID_OPTIONS', `durationMs must be between ${LIMITS.minDurationMs} and ${LIMITS.maxDurationMs}.`);
  }
  if (!Number.isInteger(maxCycles) || maxCycles < LIMITS.minCycles || maxCycles > LIMITS.maxCycles) {
    throw soakError('INVALID_OPTIONS', `maxCycles must be an integer between ${LIMITS.minCycles} and ${LIMITS.maxCycles}.`);
  }
  const hooks = testHooks || {};
  for (const [key, value] of Object.entries(hooks)) {
    const kind = TEST_HOOKS[key];
    if (!kind) throw soakError('INVALID_OPTIONS', `Unknown test hook: ${key}.`);
    if (kind === 'boolean' && typeof value !== 'boolean') throw soakError('INVALID_OPTIONS', `The ${key} hook must be a boolean.`);
    if (kind === 'fault' && !REQUIRED_FAULTS.includes(value)) throw soakError('INVALID_OPTIONS', `The skipInjection hook must name a required fault.`);
  }

  // -------------------------------------------------------- identity capacity
  // The plan is a pure function of the seed. Bound the number of work items it
  // can generate before the run starts: the largest cycle creates
  // MAX_ITEMS_PER_CYCLE items, so even the full supported plan cannot exhaust
  // the entity label space. A plan above capacity fails here instead of
  // reusing a label mid-run.
  const plan = planFaults(seed, { maxCycles });
  const plannedItems = plan.reduce((sum, step) => sum + (step.fault === 'burst_delivery' ? MAX_ITEMS_PER_CYCLE : 1), 0);
  if (plannedItems > entityCapacity()) {
    throw soakError('SOAK_IDENTITY_CAPACITY', `The plan can generate ${plannedItems} work items, above the ${entityCapacity()} unique entity labels.`);
  }

  // ------------------------------------------------------- directory ownership
  // A caller-supplied directory is never deleted and never overwritten. A
  // non-empty one is refused before any fixture writes into it.
  const ownedDirectory = !workspaceDirectory;
  let directory;
  if (ownedDirectory) {
    directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unprompted-soak-'));
  } else {
    directory = path.resolve(workspaceDirectory);
    if (fs.existsSync(directory)) {
      if (!fs.statSync(directory).isDirectory()) throw soakError('WORKSPACE_NOT_DIRECTORY', 'The supplied workspace path is not a directory.');
      if (fs.readdirSync(directory).length > 0) throw soakError('WORKSPACE_NOT_EMPTY', 'The supplied workspace directory is not empty. This run will not overwrite existing state.');
    } else {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const startedAt = new Date();
  const started = Date.now();
  const deadline = started + durationMs;
  const wallBoundMs = durationMs + LIMITS.maxCycleMs + LIMITS.cleanupTimeoutMs;

  // ---------------------------------------------------------------- counters
  const sendsByScenario = new Map(REQUIRED_FAULTS.map(fault => [fault, sendStats()]));
  const counters = {
    currentScenario: null,
    scenarioSends: name => {
      const key = name || 'outside_cycle';
      if (!sendsByScenario.has(key)) sendsByScenario.set(key, sendStats());
      return sendsByScenario.get(key);
    },
    sends: sendStats(),
    providerFaults: { networkTimeout: 0, rateLimit: 0, oauthExpired: 0, writeOutcomeUnknown: 0 },
    crashHangs: 0,
    recoveries: { networkTimeout: 0, rateLimit: 0, oauthExpired: 0, writeOutcomeUnknown: 0, restart: 0 },
    modelCalls: 0,
    modelUsageReports: 0,
    suppressUsage: hooks.suppressUsage === true,
    pendingHangs: new Set()
  };
  const events = { attempted: 0, accepted: 0, duplicates: 0 };
  const latencies = { approveMs: [], cycleMs: [] };
  const restarts = { count: 0, withUnfinishedWork: 0, recovered: 0, factsLost: 0, hangs: 0, simulatedLeaseExpiries: 0 };
  const normal = { cycles: 0, prepared: 0, approved: 0, verified: 0, completed: 0 };
  const duplicate = { cycles: 0, oneEffect: 0, verified: 0, repeats: 0 };
  const burst = { cycles: 0, items: 0, verified: 0, noNewEffects: 0, repeats: 0 };
  const timeout = { cycles: 0, injected: 0, blockedNotSilent: 0, recovered: 0, legitimateRetries: 0 };
  const rateLimit = { cycles: 0, injected: 0, blockedNotSilent: 0, recovered: 0, legitimateRetries: 0 };
  const unknownWrite = { cycles: 0, injected: 0, acceptedNotSilent: 0, recovered: 0, verifiedViaLookup: 0 };
  const oauth = {
    cycles: 0, faults: 0, healthyFailures: 0, actionable: 0, noSilentIngest: 0,
    revocations: 0, pullsWhileRevoked: 0, reauths: 0, recoveredPulls: 0,
    ingested: 0, cursorOffsets: [], continuous: true
  };
  const identities = { generated: 0, unique: 0, correlated: 0, capacity: entityCapacity(), items: [], seen: new Set() };
  const identifiers = new Set();
  const oauthTaskIds = new Set();
  const sensitive = new Set();
  const injectedFaults = [];
  const faults = {
    planned: Object.fromEntries(REQUIRED_FAULTS.map(fault => [fault, 0])),
    attempted: Object.fromEntries(REQUIRED_FAULTS.map(fault => [fault, 0])),
    injected: { networkTimeout: 0, rateLimit: 0, oauthExpired: 0, writeOutcomeUnknown: 0, crashHang: 0 },
    observed: Object.fromEntries(REQUIRED_FAULTS.map(fault => [fault, 0]))
  };
  const scenarios = Object.fromEntries(REQUIRED_FAULTS.map(fault => [fault, {
    planned: 0, attempted: 0, observed: 0,
    tasks: { prepared: 0, verified: 0, completed: 0 }, reconciliations: 0, retries: 0
  }]));
  const checks = [];
  const cycleErrors = [];
  let interrupted = false;
  let interruptReason = null;
  let timedOut = false;
  let fatal = null;
  let cycles = 0;
  let sequence = 0;
  let cycleDeadline = Infinity;
  let peakPending = 0;
  let drain = { attempted: false, passed: false, rounds: 0, elapsedMs: 0, pendingAtEnd: null, queueEmptyAtEnd: null };
  let cleanupTimedOut = false;

  // -------------------------------------------------------------- cancellation
  let wakeAbort = null;
  const abortPromise = new Promise((_, reject) => { wakeAbort = reject; });
  abortPromise.catch(() => {});
  const abortRun = reason => {
    if (interruptReason) return;
    interruptReason = reason;
    interrupted = true;
    wakeAbort(soakError('SOAK_INTERRUPTED', 'The run was interrupted.'));
  };
  if (signal) {
    if (signal.aborted) abortRun('signal');
    else signal.addEventListener('abort', () => abortRun('signal'), { once: true });
  }
  const stopPoll = setInterval(() => { if (shouldStop()) abortRun('stop-requested'); }, 100);
  stopPoll.unref?.();

  const waitFor = async (value, label, ms = LIMITS.stepTimeoutMs) => {
    if (interrupted) throw soakError('SOAK_INTERRUPTED', 'The run was interrupted.');
    const budget = Math.max(1, Math.min(Number(ms) || LIMITS.stepTimeoutMs, cycleDeadline - Date.now()));
    const promise = Promise.resolve(value);
    promise.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(soakError('SOAK_STEP_TIMEOUT', `The ${label} step exceeded its ${budget}ms budget.`)), budget);
    });
    try { return await Promise.race([promise, timeout, abortPromise]); }
    finally { clearTimeout(timer); }
  };

  /** A timeout-only race used by cleanup, where cancellation must not skip closing. */
  const raceTimeout = async (value, ms, label) => {
    const promise = Promise.resolve(value);
    promise.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(soakError('SOAK_STEP_TIMEOUT', `The ${label} step exceeded its ${ms}ms budget.`)), Math.max(1, ms));
    });
    try { return await Promise.race([promise, timeout]); }
    finally { clearTimeout(timer); }
  };

  const delayBounded = (ms, label) => waitFor(delay(ms), label, ms + 1000);

  let workspace;
  try {
    workspace = new SoakWorkspace({ directory, counters }).open();
  } catch (error) {
    // Nothing was measured. Do not fabricate a report body for an unopened
    // workspace; surface the real failure to the caller.
    throw error;
  }

  const scrub = value => {
    let text = String(value ?? '');
    for (const fragment of sensitive) {
      if (typeof fragment === 'string' && fragment.length >= 8 && text.includes(fragment)) text = text.split(fragment).join('[synthetic-content]');
    }
    text = text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[address]')
      .replace(/\bsynthetic:[^\s"',;)]*/gi, '[source-id]')
      .replace(/\brequest:[^\s"',;)]*/gi, '[task-id]')
      .replace(/\bsend:[^\s"',;)]*/gi, '[idempotency-key]')
      .replace(/\bsoak-(?:mail|doc|thread)-\d+/gi, '[source-id]');
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  };
  const record = (id, passed, detail) => { checks.push({ id, passed: Boolean(passed), detail: scrub(detail) }); return passed; };

  // --------------------------------------------------------------- workspace
  const memory = { baseline: process.memoryUsage().rss, peak: 0, end: null };
  memory.peak = memory.baseline;
  const sampler = setInterval(() => { memory.peak = Math.max(memory.peak, process.memoryUsage().rss); }, 100);
  sampler.unref?.();

  const pendingJobs = () => {
    try {
      return workspace.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','retry_wait','running','recovery_required')").get().n;
    } catch { return null; }
  };
  const notePending = () => {
    const pending = pendingJobs();
    if (pending != null && pending > peakPending) peakPending = pending;
    return pending;
  };

  const idleOnce = async () => {
    if (!workspace.runtime) throw soakError('WORKSPACE_CLOSED', 'The workspace is closed.');
    await workspace.runtime.whenIdle();
    await workspace.engine.whenSettled();
    await workspace.runtime.whenIdle();
  };
  const settle = async (label, ms = LIMITS.settleTimeoutMs) => { await waitFor(idleOnce(), label || 'settle', ms); notePending(); };

  /**
   * Let the real durable recovery run inside the current cycle.
   *
   * The runtime is kicked, the queue is allowed to settle, and a due
   * `recovery_required` job (its backoff is at least 5 s) is given time to run.
   * Nothing here edits a job state.
   */
  const drainCycle = async (label, { rounds = 40, pauseMs = 250 } = {}) => {
    for (let round = 0; round < rounds; round += 1) {
      await settle(label);
      workspace.runtime.kick();
      await settle(`${label}-kick`);
      const pending = notePending();
      if (pending === 0) return true;
      await delayBounded(pauseMs, `${label}-pause`);
    }
    await settle(`${label}-last`);
    return notePending() === 0;
  };

  const recentExecution = taskId => workspace.store.db.prepare(
    'SELECT status FROM tool_executions WHERE task_id=? AND is_write=1 ORDER BY created_at DESC LIMIT 1'
  ).get(taskId);

  const isVerified = task => Boolean(
    task?.action
    && ['verified_simulated', 'verified_live'].includes(task.action.status)
    && nonEmptyString(task.action.receiptId)
    && ['provider_lookup', 'receipt_read_back'].includes(task.action.verificationVia)
  );
  const executionForTask = task => workspace.store.db.prepare(
    "SELECT status, idempotency_key, provider_receipt_id FROM tool_executions WHERE task_id=? AND is_write=1 AND idempotency_key=? ORDER BY created_at DESC LIMIT 1"
  ).get(task.id, task.action.idempotencyKey);
  const receiptBacked = task => {
    if (!isVerified(task)) return false;
    const { action } = task;
    if (!nonEmptyString(action.id) || !nonEmptyString(action.idempotencyKey) || !nonEmptyString(action.receiptId)) return false;
    const receipt = workspace.remote.receiptFor(action.receiptId);
    if (!receipt) return false;
    let execution = null;
    try { execution = executionForTask(task); } catch { return false; }
    return proofIdsAgree({ action, execution, receipt });
  };
  const verifiedFact = task => isVerified(task) && receiptBacked(task);

  const registerSensitive = built => {
    for (const value of [built.mail.payload.body, built.mail.payload.subject, built.mail.payload.from, built.mail.payload.to,
      built.document.payload.content, built.mail.id, built.document.id, built.mail.payload.threadId]) {
      if (typeof value === 'string' && value.length >= 8) sensitive.add(value);
    }
  };

  const nextItem = () => {
    const built = buildEvents(sequence);
    sequence += 1;
    if (identifiers.has(built.entity)) throw soakError('SOAK_IDENTITY_COLLISION', 'The synthetic identity generator repeated an entity inside one workspace.');
    identifiers.add(built.entity);
    registerSensitive(built);
    return built;
  };

  const recordIdentity = built => {
    const task = workspace.store.tasks.get(`request:${built.mailId}`);
    // The engine normalizes a document id by dropping a `synthetic:` prefix, so
    // compare against the payload id that the fixture actually supplied.
    const correlated = Boolean(task && task.request?.subjectEntity === built.entity && task.documentId === built.documentId);
    identities.generated += 1;
    if (!identities.seen.has(built.entity)) { identities.seen.add(built.entity); identities.unique += 1; }
    if (correlated) identities.correlated += 1;
    if (identities.items.length < LIMITS.maxIdentityEvidence) identities.items.push({ ordinal: built.sequence, label: built.entity, correlated });
    return { task, correlated };
  };

  const ingestItem = async (built, { document = true, label = 'work-item' } = {}) => {
    if (document) workspace.engine.ingest(structuredClone(built.document));
    const mailResult = workspace.engine.ingest(structuredClone(built.mail));
    events.attempted += 1;
    if (mailResult?.duplicate) events.duplicates += 1; else events.accepted += 1;
    await settle(label);
    return mailResult;
  };

  const redeliver = async (built, times) => {
    let duplicates = 0;
    for (let index = 0; index < times; index += 1) {
      const result = workspace.engine.ingest(structuredClone(built.mail));
      events.attempted += 1;
      if (result?.duplicate) { duplicates += 1; events.duplicates += 1; } else events.accepted += 1;
    }
    await settle('redelivery');
    return duplicates;
  };

  // ------------------------------------------------------------------ cycles
  const readTask = taskId => workspace.store.tasks.get(taskId);
  /**
   * Record that this measurement actually prepared a task for review.
   *
   * It is observed at the moment the cycle is about to hand the task to the
   * fixture user, not inferred later from a final status snapshot. A task that
   * merely sits in `ready_for_approval` at the end (an OAuth catch-up awaiting
   * the user) was never prepared by this measurement and is not counted here.
   */
  const notePrepared = (bucket, taskId) => {
    const task = readTask(taskId);
    const prepared = Boolean(task && task.status === 'ready_for_approval' && !task.action);
    if (prepared) bucket.tasks.prepared += 1;
    return prepared;
  };
  const recordTaskFacts = (bucket, task) => {
    if (!task) return;
    if (task.status === 'completed') bucket.tasks.completed += 1;
    if (verifiedFact(task)) bucket.tasks.verified += 1;
  };

  const runCycle = async step => {
    const fault = step.fault;
    const cycleStarted = Date.now();
    const effectsAtStart = workspace.remote.count();
    let observed = false;

    if (fault === 'normal_cycle') {
      const built = nextItem();
      await ingestItem(built, { document: hooks.breakNormalPreparation !== true, label: 'normal' });
      const taskId = `request:${built.mailId}`;
      const prepared = notePrepared(scenarios.normal_cycle, taskId);
      normal.cycles += 1;
      if (prepared) normal.prepared += 1;
      recordIdentity(built);
      const approval = await approveTask(workspace, taskId, waitFor, { timeoutMs: LIMITS.stepTimeoutMs });
      latencies.approveMs.push(approval.elapsedMs);
      if (approval.attempted && !approval.error) normal.approved += 1;
      const after = readTask(taskId);
      if (verifiedFact(after)) { normal.verified += 1; scenarios.normal_cycle.tasks.verified += 1; }
      if (after?.status === 'completed') { normal.completed += 1; scenarios.normal_cycle.tasks.completed += 1; }
      observed = prepared && approval.attempted && !approval.error && verifiedFact(after) && after?.status === 'completed';
      if (hooks.resendAcceptedKey && after?.action?.idempotencyKey) {
        // Deliberate negative control: re-enter send for a key the remote
        // already accepted. The native idempotency keeps the effect count at
        // one; the attempt gate must still fail.
        try {
          workspace.provider.send({ idempotencyKey: after.action.idempotencyKey, to: built.mail.payload.to, subject: built.mail.payload.subject, body: built.mail.payload.body });
        } catch { /* the duplicate attempt is counted before any throw */ }
        injectedFaults.push('blind-resend-of-an-accepted-key');
      }
      if (hooks.resendAcceptedKeyUnderFault && after?.action?.idempotencyKey) {
        // Deliberate negative control for the fault-masking gap: the remote
        // already accepted this key, then an active provider fault is set and
        // the same key is sent again. The attempt must be counted as a blind
        // resend before the timeout branch throws; it must not be reclassified
        // as a harmless failure-before-acceptance. No extra accept is made for
        // detection, so the effect count stays at one.
        workspace.provider.setFault('timeout_before_accept');
        try {
          workspace.provider.send({ idempotencyKey: after.action.idempotencyKey, to: built.mail.payload.to, subject: built.mail.payload.subject, body: built.mail.payload.body });
        } catch { /* the fault is part of the control; the attempt was counted first */ }
        finally { workspace.provider.setFault(null); }
        injectedFaults.push('blind-resend-of-an-accepted-key-during-a-fault');
      }
      if (hooks.forgeCompletedWithoutVerification) {
        // Deliberate negative control: manufacture a real task in `completed`
        // with no verified action through the store API, exactly the state the
        // per-task audit exists to catch.
        const forged = nextItem();
        await ingestItem(forged, { label: 'forged-item' });
        const forgedId = `request:${forged.mailId}`;
        workspace.store.mutate(state => {
          const task = state.tasks?.[forgedId];
          if (task) task.status = 'completed';
        });
        workspace.store.refresh();
        injectedFaults.push('completed-without-verification');
      }
      if (hooks.forgeUndefinedKeyVerification) {
        // Deliberate negative control for the missing-key comparison: give a
        // task a verified_simulated action whose idempotency key is undefined
        // and point it at a real remote receipt that also has no key. Two
        // undefined keys must not compare equal and pass the audit.
        const forged = nextItem();
        await ingestItem(forged, { label: 'forged-undefined-key' });
        const forgedId = `request:${forged.mailId}`;
        const bare = workspace.remote.accept(undefined, {
          to: 'fixture-recipient', subject: forged.mail.payload.subject, body: forged.mail.payload.body
        }).receipt;
        workspace.store.mutate(state => {
          const task = state.tasks?.[forgedId];
          if (!task) return;
          task.status = 'completed';
          task.action = { id: undefined, idempotencyKey: undefined, receiptId: bare.id, status: 'verified_simulated', verificationVia: 'provider_lookup' };
        });
        workspace.store.refresh();
        injectedFaults.push('completed-with-undefined-proof-ids');
      }
      if (hooks.failWithPrivateError) {
        throw new Error(`Delivery to ${built.mail.payload.from} failed for the request “${built.mail.payload.subject}”: ${built.mail.payload.body}`);
      }
    } else if (fault === 'duplicate_delivery') {
      const built = nextItem();
      await ingestItem(built, { label: 'duplicate-delivery' });
      const taskId = `request:${built.mailId}`;
      notePrepared(scenarios.duplicate_delivery, taskId);
      const approval = await approveTask(workspace, taskId, waitFor, { timeoutMs: LIMITS.stepTimeoutMs });
      latencies.approveMs.push(approval.elapsedMs);
      // The single external effect happens during the approved send. The
      // repeats must not add another one.
      const effectsBefore = workspace.remote.count();
      const duplicates = await redeliver(built, 4);
      const task = readTask(taskId);
      const effectsAfter = workspace.remote.count();
      duplicate.cycles += 1;
      duplicate.repeats += duplicates;
      if (duplicates >= 3 && effectsAfter === effectsBefore) duplicate.oneEffect += 1;
      if (verifiedFact(task) && task?.status === 'completed') duplicate.verified += 1;
      recordTaskFacts(scenarios.duplicate_delivery, task);
      observed = duplicates >= 1 && verifiedFact(task) && task?.status === 'completed' && effectsAfter === effectsBefore;
      recordIdentity(built);
    } else if (fault === 'burst_delivery') {
      const items = [];
      for (let index = 0; index < 3; index += 1) {
        const built = nextItem();
        items.push(built);
        workspace.engine.ingest(structuredClone(built.document));
        const result = workspace.engine.ingest(structuredClone(built.mail));
        events.attempted += 1;
        if (result?.duplicate) events.duplicates += 1; else events.accepted += 1;
      }
      await settle('burst');
      const effectsBefore = workspace.remote.count();
      const repeats = (await redeliver(items[0], 3)) + (await redeliver(items[1], 3));
      const effectsAfter = workspace.remote.count();
      let verified = 0;
      for (const built of items) {
        notePrepared(scenarios.burst_delivery, `request:${built.mailId}`);
        const approval = await approveTask(workspace, `request:${built.mailId}`, waitFor, { timeoutMs: LIMITS.stepTimeoutMs });
        latencies.approveMs.push(approval.elapsedMs);
        const task = readTask(`request:${built.mailId}`);
        if (verifiedFact(task) && task?.status === 'completed') verified += 1;
        recordTaskFacts(scenarios.burst_delivery, task);
        recordIdentity(built);
      }
      burst.cycles += 1;
      burst.items += items.length;
      burst.verified += verified;
      burst.repeats += repeats;
      if (effectsAfter === effectsBefore) burst.noNewEffects += 1;
      observed = repeats >= 1 && verified === items.length && effectsAfter === effectsBefore;
    } else if (fault === 'network_timeout' || fault === 'rate_limit') {
      const bucket = fault === 'network_timeout' ? timeout : rateLimit;
      const name = fault === 'network_timeout' ? 'timeout_before_accept' : 'rate_limit';
      const faultCounter = fault === 'network_timeout' ? 'networkTimeout' : 'rateLimit';
      const built = nextItem();
      await ingestItem(built, { label: fault });
      const taskId = `request:${built.mailId}`;
      notePrepared(scenarios[fault], taskId);
      bucket.cycles += 1;
      let cycleInjected = false;
      if (hooks.skipInjection !== fault) {
        const before = counters.providerFaults[faultCounter];
        workspace.provider.setFault(name);
        const approval = await approveTask(workspace, taskId, waitFor, { timeoutMs: LIMITS.stepTimeoutMs });
        latencies.approveMs.push(approval.elapsedMs);
        workspace.provider.setFault(null);
        cycleInjected = counters.providerFaults[faultCounter] > before;
        const during = readTask(taskId);
        if (cycleInjected && during?.status === 'blocked' && during?.reason) bucket.blockedNotSilent += 1;
      }
      if (cycleInjected) {
        await drainCycle(`${fault}-recovery`);
        if (readTask(taskId)?.action?.status !== 'confirmed_absent') {
          try { await waitFor(workspace.engine.reconcile(taskId), 'reconcile', LIMITS.stepTimeoutMs); }
          catch (error) { if (isStop(error)) throw error; /* a refused reconciliation is a real answer */ }
          await settle(`${fault}-reconcile`);
        }
        const reconciled = readTask(taskId);
        if (reconciled?.action?.status === 'confirmed_absent') {
          scenarios[fault].reconciliations += 1;
          try {
            workspace.engine.retry(taskId);
            scenarios[fault].retries += 1;
            bucket.legitimateRetries += 1;
          } catch (error) { if (isStop(error)) throw error; /* the retry may be refused; that is a real answer */ }
          await settle(`${fault}-retry`);
        }
      }
      const task = readTask(taskId);
      const effectsAfter = workspace.remote.count();
      recordTaskFacts(scenarios[fault], task);
      if (cycleInjected && verifiedFact(task) && task?.status === 'completed' && effectsAfter === effectsAtStart + 1) {
        bucket.recovered += 1;
        counters.recoveries[faultCounter] += 1;
      }
      if (cycleInjected) { bucket.injected += 1; faults.injected[faultCounter] += 1; }
      observed = cycleInjected && verifiedFact(task) && task?.status === 'completed' && effectsAfter === effectsAtStart + 1;
      recordIdentity(built);
    } else if (fault === 'oauth_expired') {
      const built = nextItem();
      const cursorStore = new CursorStore(workspace.store);
      const sync = new ConnectorSync({ connectors: [workspace.connector], cursors: cursorStore, engine: workspace.engine, timeoutMs: 2000 });
      const beforeOffset = Number(cursorStore.get(OAUTH_CONNECTOR)?.offset || 0);
      workspace.eventLog.append([built.document, built.mail]);
      oauth.cycles += 1;
      let cycleFault = false;
      if (hooks.skipInjection !== 'oauth_expired') {
        const beforeFaults = counters.providerFaults.oauthExpired;
        workspace.connector.setFault('unauthorized');
        await waitFor(sync.run(), 'connector pull', LIMITS.stepTimeoutMs);
        cycleFault = counters.providerFaults.oauthExpired > beforeFaults;
        const health = workspace.store.state.connectorStatus?.[OAUTH_CONNECTOR];
        const issue = googleConnectionIssue(health?.lastError);
        if (cycleFault && health?.ok === false && health?.lastError) oauth.healthyFailures += 1;
        if (cycleFault && issue?.action === 'reauthorize') oauth.actionable += 1;
        const silent = (workspace.store.state.events || []).some(event => event.id === built.mail.id);
        if (cycleFault && !silent) oauth.noSilentIngest += 1;
      }
      if (cycleFault) { oauth.faults += 1; faults.injected.oauthExpired += 1; }
      // A permanently revoked permission is a different state: the source is
      // not pulled at all.
      await waitFor(workspace.runtime.privacy.revokePermission({ connectorId: OAUTH_CONNECTOR }), 'revoke permission', LIMITS.stepTimeoutMs);
      oauth.revocations += 1;
      workspace.connector.setFault(null);
      const pullsBefore = workspace.connector.pulls;
      const revoked = await waitFor(sync.run(), 'connector pull while revoked', LIMITS.stepTimeoutMs);
      oauth.pullsWhileRevoked += workspace.connector.pulls - pullsBefore;
      const revokedSilent = (workspace.store.state.events || []).some(event => event.id === built.mail.id);
      // The fixture user re-authorises explicitly. No model or agent may
      // authorise this itself.
      await waitFor(workspace.runtime.privacy.restorePermission(OAUTH_CONNECTOR), 'restore permission', LIMITS.stepTimeoutMs);
      oauth.reauths += 1;
      const recovered = await waitFor(sync.run(), 'connector pull after reauth', LIMITS.stepTimeoutMs);
      const ingested = recovered.results.reduce((sum, item) => sum + (item.ingested || 0), 0);
      const afterOffset = Number(cursorStore.get(OAUTH_CONNECTOR)?.offset || 0);
      if (ingested >= 2 && afterOffset === beforeOffset + ingested) {
        oauth.recoveredPulls += 1;
        oauth.ingested += ingested;
        events.attempted += ingested;
        events.accepted += ingested;
        if (cycleFault) counters.recoveries.oauthExpired += 1;
      }
      if (oauth.cursorOffsets.length === 0) oauth.cursorOffsets.push(beforeOffset);
      oauth.cursorOffsets.push(afterOffset);
      if (afterOffset !== beforeOffset + ingested) oauth.continuous = false;
      if (revoked.results.length !== 0) oauth.continuous = false;
      await settle('oauth-after');
      const identity = recordIdentity(built);
      if (identity.task) oauthTaskIds.add(identity.task.id);
      // An OAuth catch-up task waits for the user. It was not prepared by this
      // measurement for an approval and is counted only under awaitingUser.
      observed = cycleFault && ingested >= 2 && afterOffset === beforeOffset + ingested && identity.correlated
        && revoked.results.length === 0 && !revokedSilent;
    } else if (fault === 'restart_with_unfinished_work') {
      const built = nextItem();
      await ingestItem(built, { label: 'crash-setup' });
      const taskId = `request:${built.mailId}`;
      notePrepared(scenarios.restart_with_unfinished_work, taskId);
      const publicTask = workspace.engine.publicState().tasks.find(task => task.id === taskId);
      workspace.provider.hang = () => {
        counters.crashHangs += 1;
        restarts.hangs += 1;
        faults.injected.crashHang += 1;
        return new Promise(resolve => counters.pendingHangs.add(resolve));
      };
      const approvalSource = workspace.engine.approve(taskId, { reviewToken: publicTask?.reviewToken }).then(
        () => ({ ok: true }), error => ({ ok: false, error })
      );
      // The control may replace the settlement promise with one that never
      // settles. The real approval still has its handlers attached.
      const approval = hooks.hangCrashApproval ? new Promise(() => {}) : approvalSource;
      let dispatched = false;
      for (let attempt = 0; attempt < 200 && !dispatched; attempt += 1) {
        const row = recentExecution(taskId);
        dispatched = ['intent', 'dispatched', 'accepted', 'unknown'].includes(row?.status);
        if (!dispatched) await delayBounded(10, 'crash-dispatch-wait');
      }
      const receiptsBefore = workspace.remote.count();
      const attemptsBefore = counters.sends.attempts;
      workspace.abandon();
      for (const release of [...counters.pendingHangs]) { try { release(null); } catch { /* the promise is already gone */ } }
      counters.pendingHangs.clear();
      // The approval settlement is part of the cycle, not a bare microtask
      // await: it is raced against the step and cycle deadlines, and SIGINT
      // wakes it through `waitFor` like every other wait.
      await delayBounded(20, 'crash-approval-settlement');
      await waitFor(approval.catch(() => {}), 'crash-approval-settlement', LIMITS.stepTimeoutMs);
      workspace.open();
      restarts.count += 1;
      if (dispatched) restarts.withUnfinishedWork += 1;
      // The lease of the interrupted job is still valid; a real process would
      // have to wait it out. Move it into the past, exactly as the existing
      // recovery fixture does. This is simulated time, not production latency.
      const expired = workspace.store.db.prepare("UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE state='running'").run().changes;
      restarts.simulatedLeaseExpiries += expired;
      await drainCycle('crash-recovery');
      const execution = recentExecution(taskId);
      const task = readTask(taskId);
      const receiptsAfter = workspace.remote.count();
      const attemptsAfter = counters.sends.attempts;
      const factsKept = receiptsAfter === receiptsBefore;
      if (!factsKept) restarts.factsLost += 1;
      if (verifiedFact(task) && task?.status === 'completed' && execution?.status === 'verified') {
        restarts.recovered += 1;
        counters.recoveries.restart += 1;
      }
      recordTaskFacts(scenarios.restart_with_unfinished_work, task);
      observed = dispatched && factsKept && attemptsAfter === attemptsBefore && verifiedFact(task) && task?.status === 'completed';
      recordIdentity(built);
    } else if (fault === 'write_outcome_unknown') {
      const built = nextItem();
      await ingestItem(built, { label: 'write-outcome-unknown' });
      const taskId = `request:${built.mailId}`;
      notePrepared(scenarios.write_outcome_unknown, taskId);
      unknownWrite.cycles += 1;
      let cycleInjected = false;
      if (hooks.skipInjection !== fault) {
        const before = counters.providerFaults.writeOutcomeUnknown;
        workspace.provider.setFault('timeout_after_accept');
        const approval = await approveTask(workspace, taskId, waitFor, { timeoutMs: LIMITS.stepTimeoutMs });
        latencies.approveMs.push(approval.elapsedMs);
        workspace.provider.setFault(null);
        cycleInjected = counters.providerFaults.writeOutcomeUnknown > before;
        const effects = workspace.remote.count();
        // The provider accepted before losing the response. Exactly one new
        // effect proves the lost response did not hide it.
        if (cycleInjected && effects === effectsAtStart + 1) unknownWrite.acceptedNotSilent += 1;
      }
      if (cycleInjected) { unknownWrite.injected += 1; faults.injected.writeOutcomeUnknown += 1; }
      // The outcome must be reconciled with the provider before anything else.
      // Reconciliation looks the same idempotency key up; a resend would raise
      // the remote count and fail the no-blind-resend gate.
      if (cycleInjected) {
        try { await waitFor(workspace.engine.reconcile(taskId), 'reconcile unknown write', LIMITS.stepTimeoutMs); }
        catch (error) { if (isStop(error)) throw error; /* the reconciliation path may refuse; that is a real answer */ }
        await settle('write-outcome-unknown-reconcile');
        scenarios.write_outcome_unknown.reconciliations += 1;
      }
      const task = readTask(taskId);
      const effectsAfter = workspace.remote.count();
      recordTaskFacts(scenarios.write_outcome_unknown, task);
      if (cycleInjected && verifiedFact(task) && task?.status === 'completed' && effectsAfter === effectsAtStart + 1) {
        unknownWrite.recovered += 1;
        counters.recoveries.writeOutcomeUnknown += 1;
      }
      if (task?.action?.verificationVia === 'provider_lookup') unknownWrite.verifiedViaLookup += 1;
      observed = cycleInjected && verifiedFact(task) && task?.status === 'completed' && effectsAfter === effectsAtStart + 1
        && task?.action?.verificationVia === 'provider_lookup';
      recordIdentity(built);
    }

    if (observed) {
      faults.observed[fault] += 1;
      scenarios[fault].observed += 1;
    }
    const elapsed = Date.now() - cycleStarted;
    latencies.cycleMs.push(elapsed);
    return observed;
  };

  for (const step of plan) faults.planned[step.fault] += 1;
  for (const fault of REQUIRED_FAULTS) scenarios[fault].planned = faults.planned[fault];

  try {
    while (cycles < maxCycles && Date.now() < deadline && !interrupted) {
      const step = plan[cycles] || { fault: 'normal_cycle', cycle: cycles };
      cycleDeadline = Date.now() + LIMITS.maxCycleMs;
      counters.currentScenario = step.fault;
      faults.attempted[step.fault] += 1;
      scenarios[step.fault].attempted += 1;
      try {
        await runCycle(step);
      } catch (error) {
        if (error?.code === 'SOAK_INTERRUPTED') break;
        if (error?.code === 'SOAK_STEP_TIMEOUT') {
          timedOut = true;
          cycles += 1;
          cycleErrors.push({ cycle: cycles - 1, fault: step.fault, code: 'CYCLE_TIMEOUT', message: scrub(error.message) });
          break;
        }
        cycleErrors.push({ cycle: cycles, fault: step.fault, code: error?.code || 'CYCLE_ERROR', message: scrub(error?.message) });
      } finally {
        counters.currentScenario = null;
      }
      cycles += 1;
      const pending = notePending();
      if (pending != null && pending > LIMITS.maxPendingJobs) break;
      onProgress?.({ cycles, elapsed: Date.now() - started, pending });
      await delayBounded(5, 'between-cycles');
    }
  } catch (error) {
    // A signal can arrive in an outer wait such as the between-cycle pause.
    // That is still a user interrupt, not an internal failure. Only the
    // dedicated interruption code qualifies; every other error stays fatal.
    if (error?.code === 'SOAK_INTERRUPTED') {
      interrupted = true;
      interruptReason ||= 'interrupted';
    } else {
      fatal = error;
    }
  }

  // -------------------------------------------------------------- final drain
  // One bounded recovery phase. It only kicks the real runtime and waits for
  // due jobs; no job state is written by the runner. If the queue cannot reach
  // zero inside the bound, the report says so and the run fails.
  cycleDeadline = Infinity;
  let facts = null;
  let audit = null;
  let usage = null;
  let notificationCounts = null;
  try {
    const drainStarted = Date.now();
    if (!interrupted && workspace.store) {
      drain.attempted = true;
      const drainDeadline = Math.min(drainStarted + LIMITS.finalDrainMs, started + durationMs + LIMITS.maxCycleMs);
      while (!interrupted) {
        const pending = pendingJobs();
        if (pending === 0 || pending == null) break;
        if (Date.now() >= drainDeadline) break;
        workspace.runtime.kick();
        try { await raceTimeout(idleOnce(), Math.min(10000, drainDeadline - Date.now()), 'final-drain'); }
        catch { /* the bounded drain reports the remaining jobs instead of hanging */ }
        drain.rounds += 1;
        if (pendingJobs() === 0) break;
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0) break;
        try { await raceTimeout(delay(Math.min(1000, remaining)), Math.min(1000, remaining) + 250, 'final-drain-wait'); }
        catch { break; }
      }
      drain.elapsedMs = Date.now() - drainStarted;
      drain.pendingAtEnd = pendingJobs();
    }

    // ------------------------------------------------------------- task audit
    if (workspace.store) {
      workspace.store.refresh();
      facts = readDurableFacts(workspace);
      const tasksById = workspace.store.state.tasks || {};
      const taskRows = Object.values(tasksById);
      const completed = taskRows.filter(task => task.status === 'completed');
      const verified = taskRows.filter(verifiedFact);
      const completedWithoutVerifiedAction = completed
        .map((task, index) => ({ task, ordinal: index }))
        .filter(entry => !verifiedFact(entry.task))
        .map(entry => ({ ordinal: entry.ordinal, status: entry.task.status, actionStatus: entry.task.action?.status || null }));
      const byStatus = {};
      for (const task of taskRows) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
      const unknownWrites = workspace.store.db.prepare(
        "SELECT COUNT(*) n FROM tool_executions WHERE is_write=1 AND status IN ('intent','dispatched','accepted','unknown')"
      ).get().n;
      audit = {
        tasks: taskRows.length,
        completed: completed.length,
        verified: verified.length,
        completedWithoutVerifiedAction,
        unknownWrites,
        byStatus,
        awaitingUser: {
          total: taskRows.filter(task => ['ready_for_approval', 'waiting_for_information'].includes(task.status)).length,
          oauthRecovery: taskRows.filter(task => oauthTaskIds.has(task.id) && ['ready_for_approval', 'waiting_for_information'].includes(task.status)).length
        }
      };
      // The final audited count is authoritative, whether or not the drain
      // phase ran. `passed` means the drain actually ran and left zero jobs;
      // an empty queue that was never audited by a drain is reported as
      // queueEmptyAtEnd, not as a passed drain.
      drain.pendingAtEnd = facts.pendingJobs;
      drain.queueEmptyAtEnd = facts.pendingJobs === 0;
      drain.passed = drain.attempted && drain.pendingAtEnd === 0;
      usage = workspace.runtime?.usage?.summary({ since: new Date(0).toISOString() }) || null;
      notificationCounts = readNotifications(workspace);
    }
  } catch (error) { fatal ||= error; }
  if (!facts) {
    // The workspace could not be audited after the run. Do not let a stale
    // pre-audit count or a null look like a successful drain.
    drain.pendingAtEnd = null;
    drain.queueEmptyAtEnd = null;
    drain.passed = false;
  }

  try {
    if (workspace.runtime) await raceTimeout(workspace.close(), LIMITS.cleanupTimeoutMs, 'cleanup');
    else if (workspace.store) workspace.abandon();
  } catch {
    cleanupTimedOut = true;
    workspace.abandon();
  }
  clearInterval(sampler);
  clearInterval(stopPoll);
  for (const release of [...counters.pendingHangs]) { try { release(null); } catch { /* already released */ } }
  counters.pendingHangs.clear();
  memory.end = process.memoryUsage().rss;

  if (ownedDirectory && !keepWorkspace) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* a leftover temp directory is harmless */ }
  }

  // ------------------------------------------------------------------- report
  const finishedAt = new Date();
  const elapsedMs = Date.now() - started;
  const coveredFaults = REQUIRED_FAULTS.filter(fault => faults.observed[fault] > 0);
  const uncoveredFaults = REQUIRED_FAULTS.filter(fault => faults.observed[fault] === 0);
  const unknownCalls = Math.max(0, counters.modelCalls - (usage?.total?.calls || 0));
  const sendTotals = { ...counters.sends };
  const sendsReport = Object.fromEntries([...sendsByScenario.entries()].map(([name, value]) => [name, { ...value }]));
  const effectCounts = workspace.remote.effectCountsByKey();
  const keysObserved = effectCounts.size;
  const keysWithMoreThanOneEffect = workspace.remote.keysWithMoreThanOneEffect();

  record('fault-matrix-covered', uncoveredFaults.length === 0,
    uncoveredFaults.length ? `not observed: ${uncoveredFaults.join(', ')}` : `${coveredFaults.length} required scenarios observed`);
  record('no-blind-resend', sendTotals.duplicateAfterAccept === 0,
    `${sendTotals.attempts} send attempt(s), ${sendTotals.accepted} first acceptance(s), ${sendTotals.duplicateAfterAccept} attempt(s) for an already-accepted key`);
  record('no-completion-without-verification', !audit || audit.completedWithoutVerifiedAction.length === 0,
    audit ? `${audit.completed} completed task(s) audited; ${audit.completedWithoutVerifiedAction.length} lack a receipt-backed verified action${audit.completedWithoutVerifiedAction.length ? ` (task ordinals ${audit.completedWithoutVerifiedAction.map(item => item.ordinal).join(', ')})` : ''}` : 'the task audit could not read the workspace');
  record('no-unresolved-write-outcomes', !audit || audit.unknownWrites === 0,
    audit ? `${audit.unknownWrites} write execution(s) still in intent/dispatched/accepted/unknown` : 'the task audit could not read the workspace');
  record('recoveries-do-not-exceed-injections',
    counters.recoveries.networkTimeout <= counters.providerFaults.networkTimeout
    && counters.recoveries.rateLimit <= counters.providerFaults.rateLimit
    && counters.recoveries.oauthExpired <= counters.providerFaults.oauthExpired
    && counters.recoveries.writeOutcomeUnknown <= counters.providerFaults.writeOutcomeUnknown
    && counters.recoveries.restart <= counters.crashHangs,
    `recovered ${JSON.stringify(counters.recoveries)} against injected ${JSON.stringify({ ...counters.providerFaults, crashHang: counters.crashHangs })}`);
  record('final-queue-drained', drain.attempted && drain.passed && drain.pendingAtEnd === 0,
    !drain.attempted
      ? `the final recovery phase was not attempted${interrupted ? ' because the run was interrupted' : ''}; audited queue ${drain.pendingAtEnd == null ? 'could not be read' : `has ${drain.pendingAtEnd} pending job(s)`}`
      : drain.pendingAtEnd == null ? 'the final drain could not read the queue'
        : `${drain.pendingAtEnd} pending job(s) after the final recovery phase (${drain.rounds} round(s), ${drain.elapsedMs}ms)`);
  record('queue-stayed-bounded', peakPending <= LIMITS.maxPendingJobs,
    `peak pending jobs ${peakPending} sampled at cycle/settle boundaries (guard ${LIMITS.maxPendingJobs}; a transient in-cycle enqueue between samples is not observed)`);
  record('no-cycle-errors', cycleErrors.length === 0,
    cycleErrors.length ? cycleErrors.map(item => `cycle ${item.cycle} ${item.fault} ${item.code}`).join('; ') : 'every cycle completed');
  record('token-usage-accounted', counters.modelCalls > 0 && unknownCalls === 0 && Boolean(usage && usage.total.calls > 0),
    `${counters.modelCalls} synthetic model call(s), ${usage?.total?.calls || 0} with recorded usage, ${unknownCalls} unknown`);
  record('run-stayed-within-budget', !timedOut && elapsedMs <= wallBoundMs,
    `${elapsedMs}ms elapsed against a ${wallBoundMs}ms bound${timedOut ? '; a cycle exceeded its 60s budget' : ''}`);
  record('runtime-closed-cleanly', !cleanupTimedOut,
    cleanupTimedOut ? `closing the runtime exceeded ${LIMITS.cleanupTimeoutMs}ms and the workspace was abandoned` : 'the runtime and database closed inside the cleanup budget');
  record('no-internal-failure', !fatal, fatal ? `an internal failure stopped the measurement: ${scrub(fatal.message)}` : 'the runner and the workspace stayed healthy');
  record('normal-cycle-prepared', normal.cycles > 0 && normal.prepared === normal.cycles,
    `${normal.prepared}/${normal.cycles} normal cycles reached ready_for_approval without an action`);
  record('normal-cycle-explicitly-approved', normal.cycles > 0 && normal.approved === normal.cycles,
    `${normal.approved}/${normal.cycles} normal cycles were approved by the fixture user`);
  record('normal-cycle-executed-and-verified', normal.cycles > 0 && normal.verified === normal.cycles,
    `${normal.verified}/${normal.cycles} normal cycles produced a receipt-backed verified action`);
  record('normal-cycle-completed', normal.cycles > 0 && normal.completed === normal.cycles,
    `${normal.completed}/${normal.cycles} normal cycles ended completed`);
  record('duplicate-delivery-produces-one-effect', duplicate.cycles > 0 && duplicate.oneEffect === duplicate.cycles && duplicate.repeats >= 3,
    `${duplicate.oneEffect}/${duplicate.cycles} duplicate cycles kept one effect across ${duplicate.repeats} repeated deliveries`);
  record('duplicate-delivery-keeps-the-verified-result', duplicate.cycles > 0 && duplicate.verified === duplicate.cycles,
    `${duplicate.verified}/${duplicate.cycles} duplicate cycles kept a receipt-backed verified result`);
  record('burst-every-distinct-item-verified', burst.cycles > 0 && burst.verified === burst.items,
    `${burst.verified}/${burst.items} distinct burst items were verified (${burst.cycles} cycle(s))`);
  record('burst-repeats-produce-no-new-effects', burst.cycles > 0 && burst.noNewEffects === burst.cycles && burst.repeats >= 2,
    `${burst.noNewEffects}/${burst.cycles} burst cycles produced no new effect across ${burst.repeats} repeats`);
  record('network-timeout-is-not-silence', timeout.injected > 0 && timeout.blockedNotSilent === timeout.injected,
    `${timeout.blockedNotSilent}/${timeout.injected} injected timeouts blocked with a recorded reason`);
  record('network-timeout-recovers-without-a-duplicate', timeout.injected > 0 && timeout.recovered === timeout.injected && sendTotals.duplicateAfterAccept === 0,
    `${timeout.recovered}/${timeout.injected} timeouts recovered through a confirmed-absence retry (${timeout.legitimateRetries} legitimate retry/retries, ${sendTotals.duplicateAfterAccept} blind resend(s))`);
  record('rate-limit-is-reported-not-ignored', rateLimit.injected > 0 && rateLimit.blockedNotSilent === rateLimit.injected,
    `${rateLimit.blockedNotSilent}/${rateLimit.injected} injected rate limits blocked with a recorded reason`);
  record('rate-limit-recovers-without-a-duplicate', rateLimit.injected > 0 && rateLimit.recovered === rateLimit.injected && sendTotals.duplicateAfterAccept === 0,
    `${rateLimit.recovered}/${rateLimit.injected} rate limits recovered (${rateLimit.legitimateRetries} legitimate retry/retries)`);
  record('oauth-expiry-is-a-healthy-failure', oauth.faults > 0 && oauth.healthyFailures === oauth.faults,
    `${oauth.healthyFailures}/${oauth.faults} injected 401s were recorded as a healthy connector failure`);
  record('oauth-expiry-is-actionable', oauth.faults > 0 && oauth.actionable === oauth.faults,
    `${oauth.actionable}/${oauth.faults} injected 401s carried the reauthorize action`);
  record('oauth-expiry-is-not-a-silent-success', oauth.faults > 0 && oauth.noSilentIngest === oauth.faults,
    `${oauth.noSilentIngest}/${oauth.faults} failed pulls ingested no event`);
  record('oauth-revocation-blocks-pulls', oauth.revocations > 0 && oauth.pullsWhileRevoked === 0,
    `${oauth.revocations} revocation(s), ${oauth.pullsWhileRevoked} pull(s) while revoked`);
  record('oauth-recovery-is-an-explicit-user-action', oauth.faults > 0 && oauth.reauths === oauth.cycles && oauth.recoveredPulls === oauth.faults,
    `${oauth.reauths}/${oauth.cycles} explicit fixture-user re-authorisations, ${oauth.recoveredPulls}/${oauth.faults} injected 401s recovered, ${oauth.ingested} event(s) ingested`);
  record('oauth-cursor-continues', oauth.cycles > 0 && oauth.continuous && oauth.cursorOffsets.length === oauth.cycles + 1,
    `${oauth.cycles} OAuth cycle(s), cursor offsets ${oauth.cursorOffsets.join(' → ')}`);
  record('crash-observed-unfinished-work', restarts.count > 0 && restarts.withUnfinishedWork === restarts.count,
    `${restarts.withUnfinishedWork}/${restarts.count} crash(es) observed a dispatched write before abandoning the workspace`);
  record('crash-recovery-sends-no-second-copy', restarts.count > 0 && restarts.factsLost === 0 && sendTotals.duplicateAfterAccept === 0,
    `${restarts.count} crash(es), ${restarts.factsLost} lost remote fact(s), ${sendTotals.duplicateAfterAccept} blind resend(s)`);
  record('crash-recovery-verifies-the-interrupted-write', restarts.count > 0 && restarts.recovered === restarts.count,
    `${restarts.recovered}/${restarts.count} interrupted writes ended verified and completed`);
  record('unknown-write-is-reconciled-not-resent', unknownWrite.injected > 0 && unknownWrite.recovered === unknownWrite.injected,
    `${unknownWrite.recovered}/${unknownWrite.injected} accepted-but-unconfirmed writes reconciled without a resend`);
  record('unknown-write-is-verified-only-through-reconciliation', unknownWrite.injected > 0 && unknownWrite.verifiedViaLookup === unknownWrite.injected,
    `${unknownWrite.verifiedViaLookup}/${unknownWrite.injected} unknown writes were verified through a provider lookup`);
  record('entity-identities-are-unique', identities.generated > 0 && identities.unique === identities.generated,
    `${identities.unique} unique entity label(s) across ${identities.generated} work item(s); capacity ${identities.capacity}`);
  record('work-correlates-to-its-own-document', identities.generated > 0 && identities.correlated === identities.generated,
    `${identities.correlated}/${identities.generated} work items correlated to their own document and entity`);

  const pendingAtEnd = drain.pendingAtEnd;
  const report = {
    kind: 'synthetic-soak',
    version: 2,
    seed,
    started: startedAt.toISOString(),
    finished: finishedAt.toISOString(),
    elapsedMs,
    wallBoundMs,
    interrupted,
    interruptReason,
    timedOut,
    cycles,
    durationBudgetMs: durationMs,
    maxCycles,
    events: { ...events, acceptedRatio: events.attempted ? events.accepted / events.attempted : null },
    tasks: audit ? {
      total: audit.tasks,
      byStatus: audit.byStatus,
      completed: audit.completed,
      verified: audit.verified,
      completedWithoutVerifiedAction: audit.completedWithoutVerifiedAction,
      awaitingUser: audit.awaitingUser
    } : { total: null, byStatus: {}, completed: null, verified: null, completedWithoutVerifiedAction: [], awaitingUser: { total: null, oauthRecovery: null } },
    verification: {
      auditedTasks: audit?.tasks ?? null,
      receiptBacked: audit?.verified ?? null,
      completedWithoutVerifiedAction: audit?.completedWithoutVerifiedAction.length ?? null,
      unresolvedWriteExecutions: audit?.unknownWrites ?? null,
      note: 'Verified means the task’s own action carries a verified status, a verification method, and non-empty action id, idempotency key and receipt id that match a verified durable execution row and the synthetic remote receipt. Two missing or empty keys never count as a match. Totals alone are not used.'
    },
    provider: {
      kind: 'synthetic',
      nativeIdempotent: true,
      sendAttempts: sendTotals.attempts,
      accepted: sendTotals.accepted,
      failedBeforeAccept: sendTotals.failedBeforeAccept,
      acceptedResponseLost: sendTotals.acceptedResponseLost,
      duplicateAfterAccept: sendTotals.duplicateAfterAccept,
      effects: workspace.remote.count(),
      keysObserved,
      keysWithMoreThanOneEffect,
      byScenario: sendsReport,
      note: 'sendAttempts counts every entry into send, including failures and repeated keys. Blind resends are detected at the send entrance, before any timeout/429/401 branch. Acceptance and effects are remote facts; keysWithMoreThanOneEffect counts keys with more than one accepted-effect record in the remote, and duplicateAfterAccept counts attempts for a key the remote already accepted. The synthetic remote is natively idempotent; the no-blind-resend gate is what proves the engine did not submit an accepted key again.'
    },
    faults: {
      required: REQUIRED_FAULTS,
      planned: faults.planned,
      attempted: faults.attempted,
      injected: faults.injected,
      observed: faults.observed,
      note: 'planned is the plan for the configured cycle budget. attempted counts started cycles. injected counts a fixture fault that actually fired. observed counts a scenario whose required action and outcome were both observed; coverage uses observed only.'
    },
    scenarios: Object.fromEntries(REQUIRED_FAULTS.map(fault => [fault, {
      ...scenarios[fault],
      sends: sendsReport[fault] || sendStats()
    }])),
    scenariosNote: 'tasks.prepared is observed immediately before this measurement hands each task to the fixture user. It is not inferred from the final status. OAuth catch-up tasks awaiting the user are counted only in tasks.awaitingUser, never as prepared, verified or completed.',
    recoveries: {
      injected: { ...counters.providerFaults, crashHang: counters.crashHangs },
      recovered: { ...counters.recoveries },
      consistent: counters.recoveries.networkTimeout <= counters.providerFaults.networkTimeout
        && counters.recoveries.rateLimit <= counters.providerFaults.rateLimit
        && counters.recoveries.oauthExpired <= counters.providerFaults.oauthExpired
        && counters.recoveries.writeOutcomeUnknown <= counters.providerFaults.writeOutcomeUnknown
        && counters.recoveries.restart <= counters.crashHangs
    },
    restarts: {
      ...restarts,
      simulated: {
        leaseExpiries: restarts.simulatedLeaseExpiries,
        note: 'Lease expiry is simulated by moving the interrupted job lease into the past, the same technique the shipped recovery fixtures use. It is not a measured production recovery latency.'
      }
    },
    normal,
    duplicate,
    burst,
    timeout,
    rateLimit,
    unknownWrite,
    oauth: { ...oauth, cursorOffsets: [...oauth.cursorOffsets] },
    identities: {
      generated: identities.generated,
      unique: identities.unique,
      correlated: identities.correlated,
      capacity: identities.capacity,
      encoding: 'Zx + four-letter base-26 ordinal + " Ledger"',
      collisionBound: `injective for ordinals 0..${identities.capacity - 1}; a supported plan generates at most ${LIMITS.maxCycles * MAX_ITEMS_PER_CYCLE} work items (${LIMITS.maxCycles} cycles x ${MAX_ITEMS_PER_CYCLE})`,
      plannedItems,
      maxItemsPerCycle: MAX_ITEMS_PER_CYCLE,
      items: identities.items
    },
    drain,
    maxPendingJobs: peakPending,
    maxPendingJobsNote: 'Sampled at cycle and settle boundaries, not at every enqueue. The 512 guard is applied at those boundaries, so a transient in-cycle peak between samples can be missed; this is not an instantaneous peak measurement.',
    cleanup: { timedOut: cleanupTimedOut, budgetMs: LIMITS.cleanupTimeoutMs },
    memory: {
      rssBaselineBytes: memory.baseline,
      rssPeakBytes: memory.peak,
      rssEndBytes: memory.end,
      growthBytes: memory.end - memory.baseline
    },
    latency: { approveMs: summarise(latencies.approveMs), cycleMs: summarise(latencies.cycleMs) },
    notifications: notificationCounts || { interactive: 0, digest: 0, informational: 0, critical: 0, open: 0, total: 0 },
    model: { calls: counters.modelCalls, synthetic: true, usageReports: counters.modelUsageReports },
    tokenUsage: {
      known: usage && usage.total.calls > 0 ? usage.total : null,
      unknown: unknownCalls > 0,
      unknownCalls,
      note: 'Unknown means the synthetic provider reported no usage for that call. It is not a zero-token measurement.'
    },
    durable: {
      tasks: facts?.tasks || [],
      executions: facts?.executions || [],
      jobs: facts?.jobs || [],
      inboxRows: facts?.inbox ?? null
    },
    coverage: { required: REQUIRED_FAULTS, covered: coveredFaults, uncovered: uncoveredFaults, complete: uncoveredFaults.length === 0 },
    injectedFaults: [...injectedFaults],
    workspace: { callerSupplied: !ownedDirectory, kept: keepWorkspace || !ownedDirectory },
    pendingJobsAtEnd: pendingAtEnd,
    checks: { total: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, results: checks },
    success: false,
    note: 'Synthetic providers, connectors and reasoner only. No live account, provider, model, message or payment was used. This measures the harness under repetition; it is not a real-user or real-cost result.'
  };

  // The privacy gate is a property of the finished artefact, not a mirrored
  // boolean: scan the serialised report for real private shapes and for the
  // exact bodies, addresses and ids generated during this run.
  const serialisedBeforePrivacy = JSON.stringify(report);
  const violations = privacyViolations(serialisedBeforePrivacy, { fragments: [...sensitive] });
  record('report-contains-no-private-fields', violations.length === 0,
    violations.length ? `the report contained ${violations.join(', ')}` : `scanned ${serialisedBeforePrivacy.length} report characters and ${sensitive.size} generated fragment(s); no address, source id, task id or idempotency key found`);
  report.checks = { total: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, results: checks };
  report.success = !interrupted && !timedOut && !fatal && coverageForSuccess(report);

  const isAbsolute = path.isAbsolute(output);
  const outputPath = output ? (isAbsolute ? output : path.resolve(PROJECT_ROOT, output)) : null;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    report.outputPath = outputPath;
  }
  return report;
}

/** Success is the report's own acceptance: every named check, full coverage, work done. */
function coverageForSuccess(report) {
  return report.checks.failed === 0 && report.coverage.complete && report.cycles > 0;
}

function readNotifications(workspace) {
  const state = workspace.store.state.notifications || [];
  const counts = { interactive: 0, digest: 0, informational: 0, critical: 0, open: 0, total: 0 };
  for (const item of state) {
    const klass = item.deliveryClass || 'interactive';
    if (counts[klass] !== undefined) counts[klass] += 1;
    counts.total += 1;
    if (!item.resolvedAt) counts.open += 1;
  }
  return counts;
}

function summarise(values) {
  if (!values.length) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null };
  const sorted = [...values].sort((left, right) => left - right);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: at(0.5),
    p95: at(0.95)
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options, errors } = parseArguments();
  if (options.help) { console.log(USAGE); process.exit(0); }
  if (errors.length) { console.error(errors.join('\n')); console.error(`\n${USAGE}`); process.exit(2); }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const report = await runSoak({ ...options, signal: controller.signal });
  console.log(JSON.stringify({
    kind: report.kind,
    seed: report.seed,
    cycles: report.cycles,
    elapsedMs: report.elapsedMs,
    success: report.success,
    interrupted: report.interrupted,
    coverageComplete: report.coverage.complete,
    checks: `${report.checks.passed}/${report.checks.total}`,
    uncovered: report.coverage.uncovered,
    pendingJobs: report.pendingJobsAtEnd,
    output: report.outputPath
  }, null, 2));
  process.exitCode = report.success ? 0 : 1;
}
