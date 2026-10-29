import { parse } from './database.js';

export const DEFAULT_RECALL_WINDOW_MS = 72 * 60 * 60 * 1000;
const GENERIC = new Set(['meeting', 'update', 'request', 'please', 'thanks', 'hello', 'team', 'project', 'today', 'tomorrow']);

/** Structural identities only. A shared person address is not an entity: it
 * must not merge two responsibilities. */
export function entityKeys(event) {
  const payload = event?.payload || {};
  const account = payload.accountId || '';
  const keys = [];
  if (typeof payload.projectId === 'string' && payload.projectId && payload.projectId.length <= 200) keys.push({ key: `project:${payload.projectId}`, role: 'project' });
  if (typeof payload.resourceId === 'string' && payload.resourceId && payload.resourceId.length <= 200) keys.push({ key: `resource:${event.connectorId || ''}:${payload.resourceId}`, role: 'resource' });
  if (typeof payload.threadId === 'string' && payload.threadId && payload.threadId.length <= 300) keys.push({ key: `thread:${event.connectorId || ''}:${account}:${payload.threadId}`, role: 'thread' });
  return keys;
}

export function distinctiveTokens(event) {
  const text = `${event?.payload?.subject || ''} ${event?.payload?.body || ''}`.normalize('NFKC').toLowerCase();
  return [...new Set(text.match(/[\p{L}\p{N}]{5,}/gu) || [])].filter(token => !GENERIC.has(token)).slice(0, 12);
}

export function scopesCompatible(left = {}, right = {}) {
  if (left.responsibility && right.responsibility && left.responsibility !== right.responsibility) return false;
  if (left.accountId && right.accountId && left.accountId !== right.accountId) return false;
  return true;
}

/** Three bounded candidate lanes: active Situations, unattached Events, and
 * active StandingIntents. Lexical overlap never crosses a responsibility or
 * account boundary, and it never treats a shared contact as a relationship. */
export function recallCandidates(db, event, { now, windowMs = DEFAULT_RECALL_WINDOW_MS, limit = 8, intentHits = [] } = {}) {
  const cap = Math.max(1, Math.min(20, limit));
  const since = new Date(now - windowMs).toISOString();
  const keys = entityKeys(event);
  const structural = keys.filter(item => item.role !== 'thread');
  const tokens = new Set(distinctiveTokens(event));
  const situations = [];
  const seen = new Set();
  const pushSituation = (row, method) => {
    if (!row || seen.has(row.id) || situations.length >= cap) return;
    const scope = parse(row.scope_json) || {};
    if (!scopesCompatible(scope, { responsibility: event.payload?.responsibility, accountId: event.payload?.accountId || null })) return;
    seen.add(row.id);
    situations.push({ id: row.id, method, responsibility: scope.responsibility || null });
  };
  if (event.payload?.threadId) {
    for (const row of db.prepare(`SELECT DISTINCT s.id,s.scope_json FROM situations s
      JOIN event_situation_links l ON l.situation_id=s.id JOIN durable_inbox e ON e.id=l.event_id
      WHERE s.lifecycle_state IN ('OPEN','OBSERVING') AND e.provider=? AND json_extract(e.event_json,'$.payload.threadId')=?
      AND COALESCE(json_extract(e.event_json,'$.payload.accountId'),'')=? LIMIT ?`).all(event.connectorId, event.payload.threadId, event.payload.accountId || '', cap)) {
      pushSituation(row, 'structural');
    }
  }
  for (const entity of structural) {
    for (const row of db.prepare(`SELECT s.id,s.scope_json FROM situations s JOIN situation_entities n ON n.situation_id=s.id
      WHERE s.lifecycle_state IN ('OPEN','OBSERVING') AND n.entity_key=? AND n.role=? LIMIT ?`).all(entity.key, entity.role, cap)) pushSituation(row, 'entity');
  }
  if (tokens.size) {
    const rows = db.prepare(`SELECT s.id,s.scope_json,e.event_json FROM situations s
      JOIN event_situation_links l ON l.situation_id=s.id JOIN durable_inbox e ON e.id=l.event_id
      WHERE s.lifecycle_state IN ('OPEN','OBSERVING') AND e.state!='forgotten' AND e.received_at>=?
      ORDER BY e.received_at DESC LIMIT 80`).all(since);
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const other = parse(row.event_json);
      if ((other.payload?.accountId || null) !== (event.payload?.accountId || null)) continue;
      const overlap = distinctiveTokens(other).filter(token => tokens.has(token));
      if (!overlap.some(token => token.length >= 12)) continue;
      pushSituation(row, 'lexical');
    }
  }
  const unattached = [];
  if (structural.length) {
    const rows = db.prepare(`SELECT id,event_json,received_at FROM durable_inbox WHERE provider=? AND state='processed' AND received_at>=? AND id!=? ORDER BY received_at DESC LIMIT 80`)
      .all(event.connectorId, since, event.id || '');
    for (const row of rows) {
      if (unattached.length >= cap) break;
      if (db.prepare('SELECT 1 FROM event_situation_links WHERE event_id=? LIMIT 1').get(row.id)) continue;
      const other = parse(row.event_json);
      if ((other.payload?.accountId || null) !== (event.payload?.accountId || null)) continue;
      const shared = entityKeys(other).some(item => structural.some(candidate => candidate.key === item.key && candidate.role === item.role));
      if (!shared) continue;
      if (!scopesCompatible(other.payload || {}, event.payload || {})) continue;
      const overlap = distinctiveTokens(other).filter(token => tokens.has(token));
      if (!overlap.length) continue;
      unattached.push({ id: row.id, method: 'lexical', overlap: overlap.slice(0, 4) });
    }
  }
  const standingIntents = intentHits.filter(id => typeof id === 'string').slice(0, cap).map(id => ({ id, method: 'prefilter' }));
  return { situations, unattachedEvents: unattached, standingIntents, windowMs };
}
