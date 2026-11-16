import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ROUTING_STAGES } from '../model-routing.js';

const FAILURE_CLASSES = new Set(['auth','rate_limit','provider','transport','cancelled','context','accounting','response','other']);
const number = value => Number.isSafeInteger(value) && value >= 0;
const knownCounts = usage => usage && ['input','output','cacheRead','cacheWrite'].every(key => number(usage[key]));
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'METRICS_UNAVAILABLE';

/** Advisory observations only. No prompt, response, credential, task or request
 * identifiers are stored. An observation failure never changes model outcome. */
export class ModelRoutingMetrics {
  #starts = new WeakMap();
  #writeFailures = 0;
  #lastFailure = null;
  constructor(database, { clock = () => performance.now() } = {}) {
    if (typeof database?.atomic !== 'function' || typeof clock !== 'function') throw new TypeError('Routing observations need a workspace database and local clock.');
    this.database = database;
    this.clock = clock;
  }
  #schema() {
    this.database.db.exec(`CREATE TABLE IF NOT EXISTS model_route_attempts (
      id TEXT PRIMARY KEY, stage TEXT NOT NULL, routing_version INTEGER NOT NULL,
      routing_digest TEXT, model TEXT NOT NULL, protocol TEXT NOT NULL,
      fallback INTEGER NOT NULL, started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL, failure_class TEXT, http_status INTEGER,
      usage_known INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER,
      CHECK(usage_known IN (0,1)), CHECK(outcome IN ('success','failure')),
      CHECK(duration_ms>=0), CHECK(fallback IN (0,1)),
      CHECK((usage_known=0 AND input_tokens IS NULL AND output_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND total_tokens IS NULL)
        OR (usage_known=1 AND input_tokens>=0 AND output_tokens>=0 AND cache_read_tokens>=0 AND cache_write_tokens>=0 AND total_tokens>=0)))`);
    this.database.db.exec('CREATE INDEX IF NOT EXISTS idx_model_route_attempts_comparison ON model_route_attempts(routing_version,stage,model,started_at)');
  }
  #failed(error) {
    this.#writeFailures = Math.min(Number.MAX_SAFE_INTEGER, this.#writeFailures + 1);
    let now;
    try { now = new Date(this.database.now()).toISOString(); } catch { now = new Date().toISOString(); }
    this.#lastFailure = { code: safeCode(error), at: now };
  }
  noteFailure(error) { this.#failed(error); }
  status() { return { writeFailures: this.#writeFailures, lastFailure: this.#lastFailure && { ...this.#lastFailure } }; }
  /** Called only at the actual provider-fetch boundary, never at reservation. */
  start() {
    try {
      const token = Object.freeze({});
      this.#starts.set(token, { monotonic: this.clock(), at: new Date(this.database.now()).toISOString() });
      return token;
    } catch (error) { this.#failed(error); return null; }
  }
  finish(token, { stage = 'general', routingVersion = 0, routingDigest = null, model, protocol,
    fallback = false, success = false, failureClass = null, httpStatus = null, usage = null } = {}) {
    const start = this.#starts.get(token);
    if (!start) return null;
    this.#starts.delete(token); // a callback/repeated finally cannot duplicate a row
    try {
      const duration = this.clock() - start.monotonic;
      if (!ROUTING_STAGES.includes(stage) || !number(routingVersion) || !(routingDigest === null || /^sha256:[a-f0-9]{64}$/.test(routingDigest))
        || typeof model !== 'string' || !model || model.length > 200 || typeof protocol !== 'string' || protocol.length > 40
        || !Number.isFinite(duration) || duration < 0 || !number(Math.floor(duration))) throw new TypeError('Invalid native routing observation metadata.');
      const counts = knownCounts(usage) ? usage : null;
      const total = counts ? counts.input + counts.output + counts.cacheRead + counts.cacheWrite : null;
      const trusted = counts && number(total);
      const id = randomUUID();
      this.database.atomic(() => {
        this.#schema();
        this.database.db.prepare(`INSERT INTO model_route_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, stage, routingVersion, routingDigest, model, protocol, fallback ? 1 : 0,
          start.at, Math.floor(duration), success ? 'success' : 'failure', success ? null : FAILURE_CLASSES.has(failureClass) ? failureClass : 'other',
          Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
          trusted ? 1 : 0, trusted ? counts.input : null, trusted ? counts.output : null,
          trusted ? counts.cacheRead : null, trusted ? counts.cacheWrite : null, trusted ? total : null);
      });
      return id;
    } catch (error) { this.#failed(error); return null; }
  }
  summary({ since = null } = {}) {
    try {
      if (since !== null && (typeof since !== 'string' || !Number.isFinite(Date.parse(since)))) throw new TypeError('A routing observation cutoff must be a timestamp.');
      const result = this.database.atomic(() => {
        this.#schema();
        const groups = this.database.db.prepare(`SELECT stage,routing_version AS routingVersion,routing_digest AS routingDigest,model,protocol,
          COUNT(*) AS attempts,SUM(outcome='success') AS successes,SUM(outcome='failure') AS failures,
          SUM(fallback) AS fallbackAttempts,SUM(usage_known) AS usageKnownCalls,SUM(usage_known=0) AS usageUnknownCalls,
          SUM(total_tokens) AS knownTokens,SUM(input_tokens) AS knownInput,SUM(output_tokens) AS knownOutput,
          SUM(cache_read_tokens) AS knownCacheRead,SUM(cache_write_tokens) AS knownCacheWrite,
          AVG(duration_ms) AS avgDurationMs,MAX(duration_ms) AS maxDurationMs
          FROM model_route_attempts WHERE (? IS NULL OR started_at>=?)
          GROUP BY stage,routing_version,routing_digest,model,protocol
          ORDER BY routing_version DESC,stage,model LIMIT 101`).all(since, since);
        const totals = this.database.db.prepare(`SELECT COUNT(*) AS attempts,COALESCE(SUM(outcome='success'),0) AS successes,
          COALESCE(SUM(outcome='failure'),0) AS failures,COALESCE(SUM(usage_known),0) AS usageKnownCalls,
          COALESCE(SUM(usage_known=0),0) AS usageUnknownCalls,SUM(total_tokens) AS knownTokens
          FROM model_route_attempts WHERE (? IS NULL OR started_at>=?)`).get(since,since);
        return { groups: groups.slice(0,100), truncated: groups.length > 100, totals };
      });
      return { available: true, since, ...result, observationStatus: this.status() };
    } catch (error) { this.#failed(error); return { available: false, since, totals: null, groups: [], observationStatus: this.status() }; }
  }
}
