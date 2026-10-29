import { randomUUID } from 'node:crypto';
import { durableError, iso, json } from './database.js';

/** Offline evaluation never invokes a provider, planner or tool. Only aggregate
 * metrics are retained, and Forget clears these derived comparison records. */
export class OfflineReplay {
  constructor(database, memory) { this.database = database; this.memory = memory; this.db = database.db; }
  retrieval(cases, { limit = 8, configurationVersion = 1 } = {}) {
    if (!Array.isArray(cases) || !cases.length || cases.length > 100 || cases.some(item => typeof item.query !== 'string' || item.query.length > 2000 || !Array.isArray(item.relevantIds))) throw durableError('INVALID_REPLAY', 'Replay requires at most 100 labeled retrieval cases.', 400);
    let reciprocal = 0, recalled = 0, relevant = 0, lexicalHits = 0, vectorHits = 0;
    for (const item of cases) {
      const ranked = this.memory.search(item.query, { scopes: item.scopes || [], limit });
      const expected = new Set(item.relevantIds), first = ranked.findIndex(row => expected.has(row.id));
      if (first >= 0) reciprocal += 1 / (first + 1);
      relevant += expected.size;
      for (const row of ranked) if (expected.has(row.id)) {
        recalled++; if (row.channels.includes('fts5')) lexicalHits++;
        if (row.channels.some(channel => /vector|semantic/.test(channel))) vectorHits++;
      }
    }
    const metrics = { cases: cases.length, limit, meanReciprocalRank: reciprocal / cases.length, recall: relevant ? recalled / relevant : null, lexicalHits, vectorHits,
      interpretation: 'Labeled offline retrieval only; not a claim of real-user usefulness or satisfaction.' };
    const id = randomUUID();
    this.database.atomic(() => this.db.prepare('INSERT INTO replay_results VALUES(?,?,?,?,?)').run(id, 'retrieval', configurationVersion, json(metrics), iso(this.database.now())));
    return { id, metrics };
  }
  shadowArbitration(cases, arbitrate) {
    if (!Array.isArray(cases) || cases.length > 100) throw durableError('INVALID_REPLAY', 'Too many shadow cases.', 400);
    const results = cases.map(input => {
      const outcome = arbitrate(input);
      return { unresolvedDirectives: outcome.conflicts.length, advisoryRecords: outcome.advisory.length };
    });
    const metrics = { cases: results.length, conflicts: results.reduce((sum, row) => sum + row.unresolvedDirectives, 0), externalActions: 0 };
    const id = randomUUID(); this.database.atomic(() => this.db.prepare('INSERT INTO replay_results VALUES(?,?,?,?,?)').run(id, 'arbitration_shadow', 1, json(metrics), iso(this.database.now())));
    return { id, metrics };
  }
}
