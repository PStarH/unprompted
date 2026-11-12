import { randomUUID } from 'node:crypto';
import { iso } from './database.js';

const count = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

/** Record-only model token accounting.
 *
 * One row per provider response. This is an observation ledger, not a budget:
 * there is no threshold, routing decision or cost estimate here. A response
 * without usage fields writes no row so an unknown report is never mistaken
 * for a real zero-token call. */
export class UsageLedger {
  constructor(database) { this.database = database; this.db = database.db; }
  record({ provider = 'model', protocol = 'unknown', model = null, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
    const tokens = { input: count(input), output: count(output), cacheRead: count(cacheRead), cacheWrite: count(cacheWrite) };
    if (!tokens.input && !tokens.output && !tokens.cacheRead && !tokens.cacheWrite) return null;
    const id = randomUUID(), at = iso(this.database.now());
    // A requestId supplied by a reasoner is deliberately not persisted:
    // token totals do not need workspace identifiers, so forgetting a task or
    // message needs no ledger purge. The request_id column stays unpopulated.
    this.db.prepare(`INSERT INTO model_usage(id,provider,protocol,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, String(provider || 'model').slice(0, 80), String(protocol || 'unknown').slice(0, 40),
      model == null ? null : String(model).slice(0, 200),
      tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, at);
    return { id, ...tokens, createdAt: at };
  }
  summary({ since = iso(this.database.now() - 30 * 86400000) } = {}) {
    // Grouping is capped for display; the total is aggregated separately so a
    // workspace with more than 50 provider/model combinations still totals all rows.
    const total = this.db.prepare(`SELECT COUNT(*) calls,COALESCE(SUM(input_tokens),0) input,
      COALESCE(SUM(output_tokens),0) output,COALESCE(SUM(cache_read_tokens),0) cacheRead,
      COALESCE(SUM(cache_write_tokens),0) cacheWrite FROM model_usage WHERE created_at>=?`).get(since);
    const byProviderModel = this.db.prepare(`SELECT provider,protocol,model,COUNT(*) calls,
      COALESCE(SUM(input_tokens),0) input,COALESCE(SUM(output_tokens),0) output,
      COALESCE(SUM(cache_read_tokens),0) cacheRead,COALESCE(SUM(cache_write_tokens),0) cacheWrite
      FROM model_usage WHERE created_at>=? GROUP BY provider,protocol,model ORDER BY calls DESC LIMIT 50`).all(since);
    return { since, total, byProviderModel };
  }
}
