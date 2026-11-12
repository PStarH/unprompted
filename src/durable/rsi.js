import { randomUUID, createHash } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { UNATTACHED_WINDOW_MS } from './pair-evidence.js';
import { ATTENTION_DEFAULTS } from './attention.js';
import { AttentionBudget } from './attention.js';
import { DurableDatabase } from './database.js';

const PARAMETERS = Object.freeze({
  pairWindowMs: { min: 3600000, max: 14 * 86400000 },
  maxPairCandidates: { min: 1, max: 10 },
  maxInteractivePerHour: { min: 0, max: 20 },
  minIntervalMs: { min: 0, max: 86400000 }
});

/** Bounded retrieval and pacer proposals. Silence is not evidence. Authority,
 * prohibited actions, and connector permissions are not parameters. */
export class BoundedRsi {
  constructor(database, defaults = {}) { this.database = database; this.db = database.db; this.defaults = { pairWindowMs: UNATTACHED_WINDOW_MS, maxPairCandidates: 3, ...defaults }; }
  get(id) { const row = this.db.prepare('SELECT * FROM rsi_proposals WHERE id=?').get(id); return row && { ...row, previous: parse(row.previous_json), proposed: parse(row.proposed_json), evidence: parse(row.evidence_json), scope: parse(row.scope_json) }; }
  currentValue(parameter) {
    if (['maxInteractivePerHour', 'minIntervalMs'].includes(parameter)) return (parse(this.database.get('attention_policy', '{}')) || {})[parameter] ?? ATTENTION_DEFAULTS[parameter];
    const applied = parse(this.database.get('rsi_applied', '{}')) || {};
    if (Number.isFinite(applied[parameter])) return applied[parameter];
    return this.defaults[parameter];
  }
  configuration(parameter) { return { value: this.currentValue(parameter), ...(parse(this.database.get(`rsi_config:${parameter}`, 'null')) || { version: 0, proposalId: null }) }; }
  signature(parameter) { return createHash('sha256').update(json([parameter, ...Object.keys(PARAMETERS).map(key => [key, this.configuration(key)])])).digest('hex'); }
  validateCandidate(parameter, value, scope = { type: 'global' }) {
    if (!Object.hasOwn(PARAMETERS, parameter)) throw durableError('RSI_FORBIDDEN', 'This parameter is outside the bounded RSI surface.', 403);
    if (!scope || scope.type !== 'global' || Object.keys(scope).some(key => key !== 'type')) throw durableError('RSI_SCOPE', 'Only global RSI configuration is supported.', 400);
    const bounds = PARAMETERS[parameter];
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) throw durableError('RSI_INVALID', 'The proposed value is outside its allowed range.', 400);
  }
  /** Labeled local policy replay. Reports are produced here, never accepted as
   * caller-supplied passed flags. This measures eligibility/pacing, not utility. */
  evaluate({ parameter, value, cases, datasetVersion }) {
    this.validateCandidate(parameter, value);
    if (typeof datasetVersion !== 'string' || !datasetVersion.trim() || datasetVersion.length > 100 || !Array.isArray(cases) || !cases.length || cases.length > 200) throw durableError('RSI_INVALID', 'Supply a versioned, bounded labeled policy dataset.', 400);
    const pair = ['pairWindowMs', 'maxPairCandidates'].includes(parameter);
    if (cases.some(item => typeof item?.expected !== 'boolean' || (pair ? !Number.isInteger(item.rank) || item.rank < 1 || !Number.isFinite(item.ageMs) || item.ageMs < 0 : !Number.isSafeInteger(item.at) || item.at < 0))
      || !pair && cases.some((item, i) => i > 0 && item.at < cases[i - 1].at)) throw durableError('RSI_INVALID', 'Invalid labeled policy cases.', 400);
    const baselineSignature = this.signature(parameter), previous = this.currentValue(parameter);
    const score = candidate => {
      let errors = 0, falsePositives = 0, work = 0;
      let database;
      let attention;
      if (!pair) { database = new DurableDatabase(':memory:'); attention = new AttentionBudget(database, { ...parse(this.database.get('attention_policy', '{}')), [parameter]: candidate }); }
      try {
        cases.forEach((item, index) => {
          let predicted;
          if (pair) predicted = item.rank <= (parameter === 'maxPairCandidates' ? candidate : this.currentValue('maxPairCandidates')) && item.ageMs <= (parameter === 'pairWindowMs' ? candidate : this.currentValue('pairWindowMs'));
          else { database.now = () => item.at; predicted = attention.offer({ id: `case:${index}`, dedupeKey: `case:${index}` }).state === 'delivered'; }
          if (predicted) work++;
          if (predicted !== item.expected) errors++;
          if (predicted && !item.expected) falsePositives++;
        });
        return { errors, falsePositives, work };
      } finally { database?.close(); }
    };
    const baseline = score(previous), candidate = score(value);
    const metrics = { contract: 'bounded-policy-comparison-v1', parameter, previous, proposed: value, scope: { type: 'global' }, baselineSignature,
      datasetVersion, datasetDigest: createHash('sha256').update(json(cases)).digest('hex'), cases: cases.length, baseline, candidate,
      passed: candidate.errors < baseline.errors && candidate.falsePositives <= baseline.falsePositives, externalActions: 0, networkCalls: 0,
      interpretation: 'Labeled offline eligibility and pacing only; not evidence of general user satisfaction.' };
    const id = randomUUID();
    this.database.atomic(() => {
      this.db.prepare('INSERT INTO replay_results VALUES(?,?,?,?,?)').run(id, 'rsi_comparison', 1, json(metrics), iso(this.database.now()));
      this.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('replay',?,?)").run(id, iso(this.database.now()));
    });
    return { id, metrics };
  }
  propose({ parameter, value, evidence, scope = { type: 'global' }, replayId = null }) {
    if (!Object.hasOwn(PARAMETERS, parameter) || /permission|authori[sz]e|prohibited|connector/i.test(parameter)) throw durableError('RSI_FORBIDDEN', 'This parameter is outside the bounded RSI surface.', 403);
    this.validateCandidate(parameter, value, scope);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !Object.keys(evidence).length || typeof replayId !== 'string' || !replayId) throw durableError('RSI_INVALID', 'A proposal needs replay evidence and a replay id.', 400);
    const replay = this.db.prepare('SELECT metrics_json FROM replay_results WHERE id=? AND kind=?').get(replayId, 'rsi_comparison');
    const metrics = replay && parse(replay.metrics_json);
    if (!metrics || metrics.contract !== 'bounded-policy-comparison-v1' || metrics.passed !== true || metrics.parameter !== parameter || metrics.proposed !== value || metrics.previous !== this.currentValue(parameter)
      || metrics.baselineSignature !== this.signature(parameter) || metrics.externalActions !== 0 || metrics.networkCalls !== 0) throw durableError('RSI_INVALID', 'A proposal needs an improving comparison of this exact configuration.', 400);
    const previous = this.currentValue(parameter);
    if (!Number.isFinite(previous)) throw durableError('RSI_INVALID', 'The current parameter value is unavailable.', 400);
    const id = randomUUID(), at = iso(this.database.now());
    this.database.atomic(() => {
      this.db.prepare('INSERT INTO rsi_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'proposed', parameter, json(previous), json(value), json({ ...evidence, baselineSignature: metrics.baselineSignature }), json(scope), replayId, null, 1, at, at);
      this.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('rsi_proposal',?,?)").run(id, at);
      this.database.lineage('replay', replayId, 'rsi_proposal', id);
    });
    return this.get(id);
  }
  transition(id, expectedVersion, status) {
    if (!['approved', 'rejected', 'rolled_back'].includes(status)) throw durableError('RSI_INVALID', 'Unsupported proposal transition.', 400);
    return this.database.atomic(() => {
      const current = this.get(id);
      if (!current || current.version !== expectedVersion || current.status === 'rolled_back') throw durableError('RSI_CHANGED', 'The proposal changed.');
      if (status === 'approved' && current.status !== 'proposed') throw durableError('RSI_CHANGED', 'Only a proposed change can be approved.');
      if (status === 'rolled_back' && current.status !== 'approved') throw durableError('RSI_CHANGED', 'Only an approved change can be rolled back.');
      const at = iso(this.database.now());
      const changed = this.db.prepare('UPDATE rsi_proposals SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, at, id, expectedVersion).changes;
      if (!changed) throw durableError('RSI_CHANGED', 'The proposal changed.');
      if (status === 'rolled_back') {
        const rollback = randomUUID();
        this.db.prepare('INSERT INTO rsi_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(rollback, 'approved', current.parameter, json(current.proposed), json(current.previous), json({ rollbackOf: id }), json(current.scope), current.replay_id, id, 1, at, at);
      }
      return this.get(id);
    });
  }
  noteFeedback(kind) {
    if (!['silence', 'explicit_rejection', 'verified_consumption'].includes(kind)) throw durableError('RSI_INVALID', 'Unknown RSI feedback.', 400);
    return { kind, adjustsReward: kind === 'verified_consumption', adjustsPenalty: kind === 'explicit_rejection', neutral: kind === 'silence' };
  }
}
