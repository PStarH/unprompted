import { createHash, randomUUID } from 'node:crypto';
import { durableError, iso, json } from './database.js';

export const LOCAL_EMBEDDING = Object.freeze({ id: 'local-lexical-ngram-v1', dimensions: 384, semantic: false });
export const RETRIEVAL_DEFAULTS = Object.freeze({ version: 1, rrfK: 60, lexicalWeight: 1, vectorWeight: 1, minVectorSimilarity: 0.05 });
const terms = text => [...new Set(String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].slice(0, 2048);
const MEMORY_KINDS = new Set(['fact', 'preference']);
const LIFECYCLE_STATES = new Set(['active', 'disabled', 'archived', 'deleted', 'superseded']);
/** Shared eligibility for retrieval, Hot Context and cached results. A memory is
 * consumable only while it is active, its source is active, it has not expired,
 * and no established incoming supersedes relation replaces it. */
const ELIGIBLE_MEMORY = `m.lifecycle_state='active' AND (m.valid_until IS NULL OR m.valid_until > ?)
  AND NOT EXISTS (SELECT 1 FROM memory_relations r WHERE r.target_memory_id=m.id AND r.relation_kind='supersedes' AND r.status='established')`;
const matchFor = row => ({ id: row.id, content: row.content, scopeType: row.scope_type, scopeKey: row.scope_key, sourceKind: row.source_kind, sourceId: row.source_id,
  version: row.version, expectedVersion: row.version, memoryKind: row.memory_kind, lifecycleState: row.lifecycle_state, validUntil: row.valid_until, score: 0, channels: [] });
export function eligibleMemoryIds(database, ids) {
  if (!ids.length) return new Set();
  const at = iso(database.now());
  return new Set(database.db.prepare(`SELECT m.id FROM user_memories m
    JOIN source_records s ON s.kind=m.source_kind AND s.id=m.source_id AND s.active=1
    WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${ELIGIBLE_MEMORY}`).all(...ids, at).map(row => row.id));
}
const normalizeValidUntil = value => {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw durableError('INVALID_MEMORY', 'validUntil must be a valid timestamp.', 400);
  return date.toISOString();
};

/** A deterministic lexical vector, not a claimed neural semantic model. A
 * locally hosted in-process encoder can be injected through the same contract;
 * retrieval never requires a remote embedding API or a vector database. */
export function lexicalEmbedding(text, dimensions = LOCAL_EMBEDDING.dimensions) {
  const vector = new Float32Array(dimensions);
  const add = (term, weight) => {
    const hash = createHash('sha256').update(term).digest();
    vector[hash.readUInt32LE(0) % dimensions] += (hash[4] & 1 ? 1 : -1) * weight;
  };
  for (const word of terms(text)) {
    add(`word:${word}`, 2);
    const letters = [...word];
    for (let length = 2; length <= 3; length++) for (let index = 0; index <= letters.length - length; index++) add(`gram:${letters.slice(index, index + length).join('')}`, 0.5);
  }
  const norm = Math.hypot(...vector);
  if (norm) for (let index = 0; index < dimensions; index++) vector[index] /= norm;
  return vector;
}
const encodeBlob = vector => { const buffer = Buffer.alloc(vector.length * 4); vector.forEach((number, i) => buffer.writeFloatLE(number, i * 4)); return buffer; };
const decodeBlob = buffer => Float32Array.from({ length: buffer.length / 4 }, (_, i) => buffer.readFloatLE(i * 4));
const dot = (left, right) => left.length === right.length ? left.reduce((score, n, i) => score + n * right[i], 0) : 0;

export class HybridMemory {
  constructor(database, { encoder = { ...LOCAL_EMBEDDING, encode: lexicalEmbedding }, maxVectors = 2000 } = {}) {
    this.database = database; this.db = database.db; this.encoder = encoder; this.maxVectors = maxVectors;
    this.cache = new Map(); this.cacheVersion = -1;
    this.ranking = { ...RETRIEVAL_DEFAULTS, ...JSON.parse(database.get('retrieval_policy', '{}')) };
  }
  version() { return Number(this.database.get('context_version', '0')); }
  /** One probe decides the encoder. Swap the encoder only after setting asyncEncoderKnown back to null. */
  usesAsyncEncoder() {
    if (this.asyncEncoderKnown != null) return this.asyncEncoderKnown;
    let encoded;
    try { encoded = this.encoder.encode(' '); }
    catch { this.asyncEncoderKnown = false; return false; }
    const pending = encoded != null && typeof encoded.then === 'function';
    if (pending) Promise.resolve(encoded).catch(() => {});
    this.asyncEncoderKnown = pending;
    return pending;
  }
  #asyncEncoderBlocked() { return this.database.db.inTransaction || this.database.writes?.active === true; }
  invalidate() { this.cache.clear(); this.cacheVersion = -1; }
  checkCache() { const version = this.version(); if (this.cacheVersion !== version) { this.cache.clear(); this.cacheVersion = version; } return version; }
  put(input = {}, { vector = null, expectedPrivacyEpoch = null, embeddingModel = this.encoder } = {}) {
    const { id = randomUUID(), content, scopeType = 'global', scopeKey = '*', sourceKind = 'user_instruction', sourceId = id,
      memoryKind = 'fact', lifecycleState = 'active', validUntil = null, changeKind = null, expectedVersion = null } = input;
    if (typeof content !== 'string' || !content.trim() || content.length > 12000 || !['global', 'task_family', 'project', 'entity', 'resource'].includes(scopeType)) throw durableError('INVALID_MEMORY', 'Invalid grounded memory.', 400);
    if (!MEMORY_KINDS.has(memoryKind)) throw durableError('INVALID_MEMORY', 'Unknown memory kind.', 400);
    if (!LIFECYCLE_STATES.has(lifecycleState)) throw durableError('INVALID_MEMORY', 'Unknown memory lifecycle state.', 400);
    if (changeKind != null && (typeof changeKind !== 'string' || !changeKind.trim() || changeKind.length > 40)) throw durableError('INVALID_MEMORY', 'Invalid memory change kind.', 400);
    const validUntilAt = normalizeValidUntil(validUntil);
    if (!vector && this.usesAsyncEncoder()) {
      if (this.#asyncEncoderBlocked()) throw durableError('ASYNC_EMBEDDING', 'Use putAsync for an asynchronous local encoder.', 400);
      return this.putAsync(input);
    }
    const embedding = vector || this.encoder.encode(content);
    if (embedding?.then) throw durableError('ASYNC_EMBEDDING', 'Use putAsync for an asynchronous local encoder.', 400);
    if (!(embedding instanceof Float32Array) || embedding.length !== embeddingModel.dimensions || [...embedding].some(n => !Number.isFinite(n))) throw durableError('INVALID_EMBEDDING', 'The local encoder returned an invalid vector.', 400);
    return this.database.atomic(() => {
      const epoch = Number(this.database.get('privacy_epoch', '0'));
      if (expectedPrivacyEpoch != null && expectedPrivacyEpoch !== epoch) throw durableError('PRIVACY_CHANGED', 'The privacy generation changed while embedding this source.');
      const source = this.db.prepare('SELECT * FROM source_records WHERE kind=? AND id=?').get(sourceKind, sourceId);
      if (this.database.forgotten(sourceKind, sourceId) || this.database.forgotten('memory', id)) throw durableError('SOURCE_FORGOTTEN', 'The memory source was forgotten.');
      // A legacy delete deactivates its own source in the same transaction.
      // Other inactive sources remain unavailable and cannot be resurrected.
      if (source?.active === 0 && !(sourceKind === 'task_memory' && sourceId === id && lifecycleState === 'deleted')) throw durableError('SOURCE_FORGOTTEN', 'The memory source is no longer available.');
      if (!source && sourceKind !== 'user_instruction') throw durableError('MISSING_PROVENANCE', 'A memory must reference an existing grounded source.', 400);
      const at = iso(this.database.now()), existing = this.db.prepare('SELECT * FROM user_memories WHERE id=?').get(id);
      if (expectedVersion != null && existing?.version !== expectedVersion) throw durableError('MEMORY_CHANGED', 'This memory has changed.');
      const unchanged = existing && existing.content === content && existing.scope_type === scopeType && existing.scope_key === scopeKey
        && existing.source_kind === sourceKind && existing.source_id === sourceId && existing.memory_kind === memoryKind
        && existing.lifecycle_state === lifecycleState && (existing.valid_until ?? null) === validUntilAt;
      if (unchanged && this.db.prepare('SELECT 1 FROM memory_embeddings WHERE memory_id=?').get(id) && this.db.prepare('SELECT 1 FROM memory_fts WHERE id=?').get(id)) return existing;
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(?,?,?)').run(sourceKind, sourceId, at);
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'memory\',?,?)').run(id, at);
      const contentChanged = !existing || existing.content !== content;
      const lifecycleChanged = !existing || existing.lifecycle_state !== lifecycleState || (existing.valid_until ?? null) !== validUntilAt;
      const lifecycleAt = lifecycleChanged ? (existing || lifecycleState !== 'active' || validUntilAt != null ? at : null) : existing?.lifecycle_updated_at ?? null;
      this.db.prepare(`INSERT INTO user_memories(id,scope_type,scope_key,content,source_kind,source_id,memory_kind,lifecycle_state,valid_until,lifecycle_updated_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,scope_type=excluded.scope_type,scope_key=excluded.scope_key,
        source_kind=excluded.source_kind,source_id=excluded.source_id,memory_kind=excluded.memory_kind,lifecycle_state=excluded.lifecycle_state,
        valid_until=excluded.valid_until,lifecycle_updated_at=excluded.lifecycle_updated_at,version=user_memories.version+1,updated_at=excluded.updated_at`)
        .run(id, scopeType, scopeKey, content, sourceKind, sourceId, memoryKind, lifecycleState, validUntilAt, lifecycleAt, at, at);
      const ftsPresent = this.db.prepare('SELECT 1 FROM memory_fts WHERE id=?').get(id);
      if (contentChanged) { this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id); this.db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, content); }
      else if (!ftsPresent) this.db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, content);
      const embeddingRow = this.db.prepare('SELECT model_id FROM memory_embeddings WHERE memory_id=?').get(id);
      if (contentChanged || !embeddingRow || embeddingRow.model_id !== embeddingModel.id) this.db.prepare(`INSERT INTO memory_embeddings VALUES(?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET model_id=excluded.model_id,
        dimensions=excluded.dimensions,vector=excluded.vector,privacy_epoch=excluded.privacy_epoch`).run(id, embeddingModel.id, embedding.length, encodeBlob(embedding), epoch);
      this.database.lineage(sourceKind, sourceId, 'memory', id);
      this.database.lineage('memory', id, 'embedding', id);
      const row = this.db.prepare('SELECT * FROM user_memories WHERE id=?').get(id);
      this.db.prepare(`INSERT INTO memory_versions(memory_id,version,content,scope_type,scope_key,memory_kind,source_kind,source_id,lifecycle_state,valid_until,change_kind,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id,version) DO NOTHING`)
        .run(row.id, row.version, row.content, row.scope_type, row.scope_key, row.memory_kind, row.source_kind, row.source_id, row.lifecycle_state, row.valid_until, changeKind || (existing ? 'update' : 'created'), at);
      const version = this.database.bump('context_version');
      const superseded = this.db.prepare("SELECT 1 FROM memory_relations WHERE target_memory_id=? AND relation_kind='supersedes' AND status='established'").get(id);
      if (lifecycleState === 'active' && (validUntilAt == null || validUntilAt > at) && !superseded) this.db.prepare(`INSERT INTO hot_context_items VALUES(?,?,?,?,?,?) ON CONFLICT(origin_kind,origin_id) DO UPDATE SET
        context_version=excluded.context_version,projection_json=excluded.projection_json,updated_at=excluded.updated_at`)
        .run(`memory:${id}`, 'memory', id, version, json({ id, scopeType, scopeKey, content, memoryKind, lifecycleState, validUntil: validUntilAt }), at);
      else this.db.prepare("DELETE FROM hot_context_items WHERE origin_kind='memory' AND origin_id=?").run(id);
      this.invalidate(); return row;
    });
  }
  async putAsync(input) {
    const epoch = Number(this.database.get('privacy_epoch', '0'));
    const encoder = this.encoder, vector = await encoder.encode(input.content);
    if (encoder !== this.encoder) throw durableError('CONTEXT_CHANGED', 'The memory encoder changed during embedding.');
    return this.database.write(() => this.put(input, { vector, expectedPrivacyEpoch: epoch }));
  }
  /** Re-check eligibility at read time so a cached answer cannot outlive a
   * valid_until, a lifecycle change or a newly established supersedes edge. */
  eligible(ids) { return eligibleMemoryIds(this.database, ids); }

  /** Applicable preferences are guidance, not similarity hits. Keep whole
   * instructions available to the planning manifest, which budgets/defer them. */
  preferences({ scopes = [] } = {}) {
    const scopeSql = ["m.scope_type='global'", ...scopes.map(() => '(m.scope_type=? AND m.scope_key=?)')].join(' OR ');
    return this.db.prepare(`SELECT m.* FROM user_memories m
      JOIN source_records s ON s.kind=m.source_kind AND s.id=m.source_id AND s.active=1
      WHERE m.memory_kind='preference' AND (${scopeSql}) AND ${ELIGIBLE_MEMORY}
      ORDER BY CASE m.scope_type WHEN 'resource' THEN 0 WHEN 'project' THEN 1 WHEN 'entity' THEN 2 WHEN 'task_family' THEN 3 ELSE 4 END,m.updated_at DESC,m.id`)
      .all(...scopes.flatMap(scope => [scope.type, scope.key]), iso(this.database.now()))
      .map(row => ({ ...matchFor(row), channels: ['applicable_preference'] }));
  }

  search(query, { scopes = [], limit = 8, expectedContextVersion = null, vector = null } = {}) {
    const version = this.checkCache();
    if (expectedContextVersion != null && expectedContextVersion !== version) throw durableError('CONTEXT_CHANGED', 'The retrieval context version is stale.');
    if (!vector && this.usesAsyncEncoder()) {
      if (this.#asyncEncoderBlocked()) throw durableError('ASYNC_EMBEDDING', 'Use searchAsync for an asynchronous local encoder.', 400);
      return this.searchAsync(query, { scopes, limit, expectedContextVersion: version });
    }
    const key = json([query, scopes, limit, this.encoder.id, version]);
    const filterCached = results => results.filter(row => this.eligible([row.id]).has(row.id));
    if (this.cache.has(key)) return structuredClone(filterCached(this.cache.get(key)));
    const at = iso(this.database.now());
    const scopeSql = ["m.scope_type='global'", ...scopes.map(() => '(m.scope_type=? AND m.scope_key=?)')].join(' OR ');
    const scopeArgs = scopes.flatMap(scope => [scope.type, scope.key]);
    const rows = this.db.prepare(`SELECT m.*,e.model_id,e.vector FROM user_memories m LEFT JOIN memory_embeddings e ON e.memory_id=m.id
      JOIN source_records s ON s.kind=m.source_kind AND s.id=m.source_id AND s.active=1
      WHERE (${scopeSql}) AND ${ELIGIBLE_MEMORY} ORDER BY m.updated_at DESC,m.id LIMIT ?`).all(...scopeArgs, at, this.maxVectors);
    const queryVector = vector || this.encoder.encode(String(query).slice(0, 4000));
    if (queryVector?.then) throw durableError('ASYNC_EMBEDDING', 'Use searchAsync for an asynchronous local encoder.', 400);
    const matches = new Map(rows.map(row => [row.id, matchFor(row)]));
    const ftsQuery = terms(query).filter(term => [...term].length >= 3).slice(0, 8).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    if (ftsQuery) {
      const lexical = this.db.prepare(`SELECT m.*,bm25(memory_fts) rank FROM memory_fts JOIN user_memories m ON m.id=memory_fts.id
        JOIN source_records s ON s.kind=m.source_kind AND s.id=m.source_id AND s.active=1
        WHERE memory_fts MATCH ? AND (${scopeSql}) AND ${ELIGIBLE_MEMORY} ORDER BY rank,m.id LIMIT 100`).all(ftsQuery, ...scopeArgs, at);
      lexical.forEach((row, index) => { if (!matches.has(row.id)) matches.set(row.id, matchFor(row)); const match = matches.get(row.id); match.score += this.ranking.lexicalWeight / (this.ranking.rrfK + index); match.channels.push('fts5'); });
    }
    rows.filter(row => row.vector && row.model_id === this.encoder.id).map(row => ({ id: row.id, similarity: dot(queryVector, decodeBlob(row.vector)) }))
      .filter(row => row.similarity > this.ranking.minVectorSimilarity).sort((a, b) => b.similarity - a.similarity).slice(0, 40).forEach((row, index) => {
        const match = matches.get(row.id); match.score += this.ranking.vectorWeight / (this.ranking.rrfK + index); match.channels.push(this.encoder.semantic ? 'local_semantic' : 'local_lexical_vector');
      });
    const eligible = this.eligible([...matches.keys()]);
    const result = [...matches.values()].filter(row => row.score > 0 && eligible.has(row.id)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.min(20, Math.max(1, limit)));
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, result); return structuredClone(result);
  }
  async searchAsync(query, options = {}) {
    const version = this.version(), epoch = Number(this.database.get('privacy_epoch', '0'));
    if (options.expectedContextVersion != null && options.expectedContextVersion !== version) throw durableError('CONTEXT_CHANGED', 'The retrieval context version is stale.');
    const encoder = this.encoder, vector = await encoder.encode(String(query).slice(0, 4000));
    if (epoch !== Number(this.database.get('privacy_epoch', '0'))) throw durableError('PRIVACY_CHANGED', 'Privacy changed during retrieval.');
    if (encoder !== this.encoder) throw durableError('CONTEXT_CHANGED', 'The memory encoder changed during retrieval.');
    return this.search(query, { ...options, vector, expectedContextVersion: version });
  }
  configure({ expectedVersion, ...values }) {
    if (expectedVersion !== this.ranking.version || Object.keys(values).some(key => !Object.hasOwn(RETRIEVAL_DEFAULTS, key) || key === 'version')) throw durableError('RETRIEVAL_POLICY_CHANGED', 'The retrieval policy version or fields are invalid.');
    const next = { ...this.ranking, ...values, version: this.ranking.version + 1 };
    if (!Number.isFinite(next.rrfK) || next.rrfK < 10 || next.rrfK > 200 || [next.lexicalWeight, next.vectorWeight].some(value => !Number.isFinite(value) || value < 0 || value > 4)
      || next.lexicalWeight + next.vectorWeight === 0 || !Number.isFinite(next.minVectorSimilarity) || next.minVectorSimilarity < 0 || next.minVectorSimilarity > 1) throw durableError('INVALID_RETRIEVAL_POLICY', 'Invalid retrieval ranking parameters.', 400);
    this.database.atomic(() => { const saved = JSON.parse(this.database.get('retrieval_policy', '{}')); if (saved.version != null && saved.version !== expectedVersion) throw durableError('RETRIEVAL_POLICY_CHANGED', 'The retrieval policy changed.'); this.database.set('retrieval_policy', json(next)); this.database.bump('context_version'); }); this.ranking = next; this.invalidate(); return next;
  }
  describe() { return { lexical: 'FTS5 trigram', vector: this.encoder.id, semantic: this.encoder.semantic === true, inProcess: true, ranking: this.ranking, cachedQueries: this.cache.size, contextVersion: this.version() }; }
}
