import { randomUUID } from 'node:crypto';
import { durableError, iso } from './database.js';

/** Tentative claims coordinate Situations that want the same resource or time
 * slot. They do not replace the execution ledger, and they do not stop work
 * that names a different scope. */
export class Coordination {
  constructor(database) { this.database = database; this.db = database.db; }
  releaseExpired() {
    this.db.prepare("UPDATE tentative_claims SET state='released' WHERE state='held' AND expires_at<=?").run(iso(this.database.now()));
  }
  claim({ kind, scopeKey, situationId, taskId = null, ttlMs = 15 * 60000 }) {
    if (!['resource', 'time'].includes(kind) || typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > 300) throw durableError('INVALID_CLAIM', 'A claim needs a bounded resource or time scope.', 400);
    if (!situationId || typeof situationId !== 'string') throw durableError('INVALID_CLAIM', 'A claim must name its Situation.', 400);
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 7 * 86400000) throw durableError('INVALID_CLAIM', 'Claim expiry is out of range.', 400);
    return this.database.atomic(() => {
      this.releaseExpired();
      const now = this.database.now(), expires = iso(now + ttlMs);
      const holder = this.db.prepare("SELECT * FROM tentative_claims WHERE claim_kind=? AND scope_key=? AND state='held'").get(kind, scopeKey);
      if (holder && holder.situation_id !== situationId) return { blocked: true, holderSituationId: holder.situation_id, claimId: holder.id };
      if (holder) {
        this.db.prepare('UPDATE tentative_claims SET expires_at=?,task_id=? WHERE id=?').run(expires, taskId, holder.id);
        return { blocked: false, claimId: holder.id, refreshed: true };
      }
      const id = randomUUID();
      try {
        this.db.prepare('INSERT INTO tentative_claims VALUES(?,?,?,?,?,?,?,?)').run(id, kind, scopeKey, situationId, taskId, expires, 'held', iso(now));
      } catch (error) {
        if (!/UNIQUE/.test(error.message)) throw error;
        const raced = this.db.prepare("SELECT * FROM tentative_claims WHERE claim_kind=? AND scope_key=? AND state='held'").get(kind, scopeKey);
        return { blocked: raced?.situation_id !== situationId, holderSituationId: raced?.situation_id || null, claimId: raced?.id || null };
      }
      return { blocked: false, claimId: id, refreshed: false };
    });
  }
  release(id) {
    this.db.prepare("UPDATE tentative_claims SET state='released' WHERE id=?").run(id);
  }
  held({ kind = null, situationId = null } = {}) {
    this.releaseExpired();
    return this.db.prepare("SELECT * FROM tentative_claims WHERE state='held' AND (? IS NULL OR claim_kind=?) AND (? IS NULL OR situation_id=?) ORDER BY created_at").all(kind, kind, situationId, situationId);
  }
}

export function readinessBlock(db, task) {
  if (!task) return null;
  if (task.yieldState === 'YIELDED_TO_USER') return 'yielded_to_user';
  if (task.status === 'ready_for_approval' && db.prepare('SELECT 1 FROM artifacts WHERE task_id=? AND stale=1 LIMIT 1').get(task.id)) return 'artifact_stale';
  return null;
}
