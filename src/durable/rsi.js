import { randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { UNATTACHED_WINDOW_MS } from './pair-evidence.js';
import { ATTENTION_DEFAULTS } from './attention.js';

const PARAMETERS = Object.freeze({
  pairWindowMs: { min: 3600000, max: 14 * 86400000 },
  maxPairCandidates: { min: 1, max: 10 },
  maxInteractivePerHour: { min: 0, max: 20 },
  minIntervalMs: { min: 0, max: 86400000 }
});

/** Bounded retrieval and pacer proposals. Silence is not evidence. Authority,
 * prohibited actions, and connector permissions are not parameters. */
export class BoundedRsi {
  constructor(database) { this.database = database; this.db = database.db; }
  get(id) { const row = this.db.prepare('SELECT * FROM rsi_proposals WHERE id=?').get(id); return row && { ...row, previous: parse(row.previous_json), proposed: parse(row.proposed_json), evidence: parse(row.evidence_json), scope: parse(row.scope_json) }; }
  currentValue(parameter) {
    const applied = parse(this.database.get('rsi_applied', '{}')) || {};
    if (Number.isFinite(applied[parameter])) return applied[parameter];
    const defaults = { pairWindowMs: UNATTACHED_WINDOW_MS, maxPairCandidates: 3, maxInteractivePerHour: ATTENTION_DEFAULTS.maxInteractivePerHour, minIntervalMs: ATTENTION_DEFAULTS.minIntervalMs };
    return defaults[parameter];
  }
  propose({ parameter, value, evidence, scope = { type: 'global' }, replayId = null }) {
    if (!Object.hasOwn(PARAMETERS, parameter) || /permission|authori[sz]e|prohibited|connector/i.test(parameter)) throw durableError('RSI_FORBIDDEN', 'This parameter is outside the bounded RSI surface.', 403);
    const bounds = PARAMETERS[parameter];
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) throw durableError('RSI_INVALID', 'The proposed value is outside its allowed range.', 400);
    if (!evidence || typeof evidence !== 'object' || typeof replayId !== 'string' || !replayId) throw durableError('RSI_INVALID', 'A proposal needs replay evidence and a replay id.', 400);
    const replay = this.db.prepare('SELECT metrics_json FROM replay_results WHERE id=? AND kind=?').get(replayId, 'activation_v15');
    const metrics = replay && parse(replay.metrics_json);
    if (!metrics || !Array.isArray(metrics.scenarios) || !metrics.scenarios.length || metrics.scenarios.some(item => item.passed !== true) || metrics.externalActions || metrics.networkCalls) throw durableError('RSI_INVALID', 'A proposal needs a passed activation replay with no external action.', 400);
    const previous = this.currentValue(parameter);
    if (!Number.isFinite(previous)) throw durableError('RSI_INVALID', 'The current parameter value is unavailable.', 400);
    const id = randomUUID(), at = iso(this.database.now());
    this.database.atomic(() => {
      this.db.prepare('INSERT INTO rsi_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'proposed', parameter, json(previous), json(value), json(evidence), json(scope), replayId, null, 1, at, at);
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
