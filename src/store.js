import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { interpretRequest, parseDeadline, normaliseDateLocale } from './requests.js';
import { findCalibration, PREFERENCE_KEYS } from './calibration.js';

export const SCHEMA_VERSION = 4;

/** Versions this build can migrate forward from. Every published version stays listed. */
export const SUPPORTED_VERSIONS = [1, 2, 3, SCHEMA_VERSION];

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    mode: 'simulation',
    events: [],
    inbox: [],
    documents: {},
    runRecords: {},
    tasks: {},
    outbox: [],
    history: [],
    cursors: {},
    connectorStatus: {},
    runtime: null,
    simulation: null,
    // Calibration records what the user stated or the system inferred, with source,
    // time and scope. Notifications and their open questions. Discovered
    // opportunities. All are additive, so a v2 file migrates without loss.
    calibrations: {},
    clarifications: [],
    notifications: [],
    opportunities: {},
    // Items the user says the system never discovered. They are not tasks.
    misses: [],
    // Bounded decision trace: one entry per stage of each important decision.
    trace: []
  };
}

/**
 * True when the state holds events that the local simulation did not produce.
 *
 * Such a state is the user's only record of what was actually observed. The
 * simulator must never write into it and the replay route must never reset it,
 * because both would replace real observation with the scenario.
 */
export function hasRealEvents(state) {
  return (state?.events || []).some(event => event?.source !== 'simulated');
}

/**
 * Version migration.
 *
 * v1 -> v2 adds run records, connector cursors and connector status.
 * v2 -> v3 adds the calibration registry, open clarifications, notifications and
 * discovered opportunities.
 * v3 -> v4 adds the bounded decision trace.
 * Nothing is dropped; task shape repair is handled separately because it must
 * also apply to files already written at the current version.
 */
export function migrate(state) {
  const version = state.schemaVersion;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`Unsupported state schema version: ${version}`);
  }
  state.runRecords = state.runRecords || {};
  state.cursors = state.cursors || {};
  state.connectorStatus = state.connectorStatus || {};
  state.runtime = state.runtime ?? null;
  state.calibrations = state.calibrations || {};
  state.clarifications = state.clarifications || [];
  state.notifications = state.notifications || [];
  state.opportunities = state.opportunities || {};
  state.misses = state.misses || [];
  state.trace = state.trace || [];
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

/**
 * Rebuild a request into the current shape.
 *
 * Prefers re-reading the source email, because that recovers the subject entity
 * the correlation step depends on. Falls back to normalising whatever fields the
 * old record had so nothing is invented.
 */
function buildCurrentRequest(task, state, dateLocale) {
  const legacy = task.request || {};
  const message = (state.inbox || []).find(item => item.id === task.sourceEmailId);
  if (message) {
    try {
      const derived = interpretRequest(message, { dateLocale });
      if (derived) return { ...derived, id: task.id };
    } catch { /* fall through to the field-level upgrade */ }
  }
  const deadline = legacy.deadline == null ? null
    : typeof legacy.deadline === 'string' ? { text: legacy.deadline, iso: null, kind: 'relative' }
      : legacy.deadline;
  return {
    id: task.id,
    intent: legacy.intent || (legacy.deliverable ? 'update_and_send' : 'informational'),
    deliverable: legacy.deliverable || 'document',
    subjectEntity: legacy.subjectEntity || legacy.project || null,
    deadline,
    requiredContent: Array.isArray(legacy.requiredContent) ? legacy.requiredContent : [],
    explicitDocumentUrl: legacy.explicitDocumentUrl || null,
    impliedClaims: Array.isArray(legacy.impliedClaims) ? legacy.impliedClaims : [],
    text: legacy.text || [task.subject, message?.body].filter(Boolean).join('\n') || '',
    source: legacy.source || {
      kind: 'email', id: task.sourceEmailId || null, from: task.sender || null, subject: task.subject || null, receivedAt: null
    },
    interpretedBy: 'migrated'
  };
}

/**
 * Idempotent task shape repair, applied on every load.
 *
 * A task whose request predates the evidence model is rebuilt and its derived
 * state cleared, so the richer evidence bundle is re-derived from the documents
 * rather than trusting a rule-based verdict produced by older logic. A prepared
 * draft is discarded deliberately: under the new model it must be re-prepared
 * and re-approved, and discarding it can never send anything.
 *
 * Returns true when anything changed, so the caller can persist the repair.
 */
export function normaliseTasks(state, { dateLocale = null } = {}) {
  let changed = false;
  const locale = effectiveDateLocale(state, dateLocale);
  for (const task of Object.values(state.tasks || {})) {
    if (!task || !task.request) continue;
    if (task.request.subjectEntity) continue; // already current shape

    task.request = buildCurrentRequest(task, state, locale);
    task.evidence = null;
    task.assessment = null;
    task.draft = null;
    // Never disturb an action that was already approved and may be in flight;
    // restart recovery reconciles that against the provider.
    if (!task.action && task.status !== 'completed') task.status = 'newly_discovered';
    changed = true;
  }
  return changed;
}

/**
 * The date-reading format that governs this state: an explicitly stated user
 * preference first, then the process configuration. Never guessed.
 */
function effectiveDateLocale(state, configured = null) {
  const stated = findCalibration(state.calibrations || {}, PREFERENCE_KEYS.DATE_LOCALE);
  if (stated?.source === 'user_stated') {
    const fromUser = normaliseDateLocale(stated.value);
    if (fromUser) return fromUser;
  }
  return normaliseDateLocale(configured);
}

/**
 * Re-derive stored deadlines against the current rules.
 *
 * Fills a calendar day for relative deadlines stored as text only, marks
 * ambiguous numeric dates (`10/11` with no configured format) as ambiguous
 * instead of pretending they are unresolved, and clears a day that the words
 * never actually named (a stored Feb 30 from an older build). A day already
 * resolved under an explicit configuration is never regressed to ambiguous:
 * the record only gains information, it does not lose it.
 *
 * Does not clear evidence or change status. The anchor is the source email's
 * receivedAt when present.
 */
export function normaliseDeadlines(state, { dateLocale = null } = {}) {
  let changed = false;
  const locale = effectiveDateLocale(state, dateLocale);
  for (const task of Object.values(state.tasks || {})) {
    const deadline = task?.request?.deadline;
    if (!deadline?.text) continue;
    const message = (state.inbox || []).find(item => item.id === task.sourceEmailId);
    const anchor = message?.receivedAt || task.request?.source?.receivedAt || task.createdAt || null;
    if (!anchor) continue;
    const parsed = parseDeadline(deadline.text, anchor, { dateLocale: locale });
    if (parsed.status === 'resolved') {
      if (deadline.iso === parsed.iso && deadline.kind === parsed.kind && !deadline.ambiguous) continue;
      deadline.iso = parsed.iso;
      deadline.kind = parsed.kind;
      delete deadline.ambiguous;
      delete deadline.candidates;
      delete deadline.readings;
      delete deadline.reason;
      changed = true;
    } else if (parsed.status === 'ambiguous') {
      if (deadline.iso != null) continue; // resolved under an explicit format; keep it
      if (deadline.kind === 'ambiguous' && deadline.ambiguous === true) continue;
      deadline.iso = null;
      deadline.kind = 'ambiguous';
      deadline.ambiguous = true;
      deadline.candidates = parsed.candidates;
      deadline.readings = parsed.readings;
      deadline.reason = parsed.reason;
      changed = true;
    } else if (parsed.status === 'invalid') {
      if (deadline.iso == null && deadline.kind === 'invalid') continue;
      deadline.iso = null;
      deadline.kind = 'invalid';
      delete deadline.ambiguous;
      delete deadline.candidates;
      delete deadline.readings;
      deadline.reason = parsed.reason;
      changed = true;
    }
    // `unresolved` leaves the stored phrase untouched: nothing is invented.
  }
  return changed;
}

/**
 * One state file, one writer.
 *
 * The server and the eval harness both persist JSON state by renaming a file.
 * Two live processes would each load a snapshot, mutate it and rename over the
 * other's work: a lost update, not a merge. A lock file next to the state makes
 * the second process fail loudly. Locks left by a crashed process are detected
 * by PID and reclaimed; a lock owned by this PID is re-entrant so reopening a
 * store in one process (tests, tools) keeps working.
 */
const LOCK_OWNERS = new Map();
// Re-entrant handles share a writer generation, not permission to overwrite
// one another's snapshots. The entry lives only while a handle owns the lock.
const STATE_GENERATIONS = new Map();
const ACTIVE_MUTATIONS = new Set();

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function acquireLock(filename) {
  const resolved = path.resolve(filename);
  const lockPath = `${resolved}.lock`;
  const held = LOCK_OWNERS.get(resolved) || 0;
  if (held > 0) {
    LOCK_OWNERS.set(resolved, held + 1);
    return lockPath;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        file: resolved
      }) + '\n');
      fs.closeSync(fd);
      fd = null;
      LOCK_OWNERS.set(resolved, 1);
      return lockPath;
    } catch (error) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
      }
      if (error.code !== 'EEXIST') throw error;
      const owner = readLock(lockPath);
      if (owner?.pid === process.pid) {
        // Reopening within one process: the lock is already ours.
        LOCK_OWNERS.set(resolved, 1);
        return lockPath;
      }
      if (owner && processAlive(owner.pid)) {
        const since = owner.startedAt ? ` since ${owner.startedAt}` : '';
        const failure = new Error(
          `State file is already in use by process ${owner.pid}${since}: ${resolved}. ` +
          'Run one Unprompted instance per state file, or point UNPROMPTED_STATE_FILE at a different file.'
        );
        failure.code = 'STATE_LOCKED';
        failure.pid = owner.pid;
        throw failure;
      }
      // Dead owner, unreadable lock, or no pid: reclaim it and retry once.
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new Error(`Could not acquire the state lock for ${resolved}.`);
}

function releaseLock(filename) {
  const resolved = path.resolve(filename);
  const held = LOCK_OWNERS.get(resolved) || 0;
  if (held > 1) {
    LOCK_OWNERS.set(resolved, held - 1);
    return false;
  }
  LOCK_OWNERS.delete(resolved);
  STATE_GENERATIONS.delete(resolved);
  try {
    fs.unlinkSync(`${resolved}.lock`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

export class JsonStore {
  #mutating = false;

  constructor(filename, { dateLocale = null } = {}) {
    this.filename = path.resolve(filename);
    this.migrated = false;
    this.closed = false;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    acquireLock(this.filename);
    if (!STATE_GENERATIONS.has(this.filename)) STATE_GENERATIONS.set(this.filename, 0);
    this.generation = STATE_GENERATIONS.get(this.filename);
    try {
      const existed = fs.existsSync(this.filename);
      this.state = existed ? JSON.parse(fs.readFileSync(this.filename, 'utf8')) : emptyState();
      const before = this.state.schemaVersion;
      this.state = migrate(this.state);
      const repaired = normaliseTasks(this.state, { dateLocale });
      const deadlines = normaliseDeadlines(this.state, { dateLocale });
      this.migrated = existed && (before !== this.state.schemaVersion || repaired || deadlines);
      if (!existed || this.migrated) this.save();
    } catch (error) {
      releaseLock(this.filename);
      this.closed = true;
      throw error;
    }
  }

  /** Release the process lock. Idempotent, so shutdown paths may call it freely. */
  close() {
    if (this.closed) return;
    if (this.#mutating) throw this.#transactionError();
    this.closed = true;
    releaseLock(this.filename);
  }

  save() {
    this.#assertWritable();
    this.#write();
  }

  mutate(callback) {
    return this.#transaction(callback, false).result;
  }

  #transactionError() {
    return Object.assign(new Error('A store mutation transaction is already active; nested mutation, save and close are not allowed.'), { code: 'STORE_TRANSACTION_ACTIVE' });
  }

  #assertWritable() {
    if (this.closed) throw Object.assign(new Error('The state store is closed.'), { code: 'STORE_CLOSED' });
    if (this.#mutating || ACTIVE_MUTATIONS.has(this.filename)) throw this.#transactionError();
    if (this.generation !== STATE_GENERATIONS.get(this.filename)) {
      throw Object.assign(new Error('This state snapshot is stale: another store handle committed newer work. Reopen the store before writing.'), { code: 'STORE_CONFLICT' });
    }
  }

  #write() {
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      const serialized = JSON.stringify(this.state, null, 2) + '\n';
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, serialized);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.filename);
      this.generation += 1;
      STATE_GENERATIONS.set(this.filename, this.generation);
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve the original write failure */ } }
      try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup; preserve the original commit outcome */ }
    }
  }

  #transaction(callback, onlyIfChanged) {
    this.#assertWritable();
    const before = JSON.stringify(this.state);
    this.#mutating = true;
    ACTIVE_MUTATIONS.add(this.filename);
    try {
      const result = callback(this.state);
      if (result && typeof result.then === 'function') {
        // Observe rejection, and detach the callback's state reference on rollback
        // so a late asynchronous continuation cannot corrupt the live snapshot.
        Promise.resolve(result).catch(() => {});
        throw new TypeError('Store mutation callbacks must be synchronous.');
      }
      if (onlyIfChanged && JSON.stringify(this.state) === before) return { changed: false, result };
      this.state.revision += 1;
      this.#write();
      return { changed: true, result };
    } catch (error) {
      this.state = JSON.parse(before);
      throw error;
    } finally {
      this.#mutating = false;
      ACTIVE_MUTATIONS.delete(this.filename);
    }
  }

  /**
   * Mutate only when the callback actually changes the state.
   *
   * Recurring attention evaluation re-derives the same notifications and
   * opportunities on every pass. It must still run — a calendar day can pass
   * with no event and turn a deadline imminent — but rewriting byte-identical
   * state bumps the revision, rewrites the file and tells every client that
   * something happened when nothing did. The serialised before/after comparison
   * is the test: identical bytes mean no observer can tell the difference, so
   * nothing is persisted and the revision does not move.
   *
   * Returns { changed, result } so callers can also skip a broadcast.
   */
  mutateIfChanged(callback) {
    return this.#transaction(callback, true);
  }
}
