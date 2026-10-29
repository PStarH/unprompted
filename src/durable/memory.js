import { createHash, randomUUID } from 'node:crypto';
import { durableError, iso, json } from './database.js';

export const LOCAL_EMBEDDING = Object.freeze({ id: 'local-lexical-ngram-v1', dimensions: 384, semantic: false });
export const RETRIEVAL_DEFAULTS = Object.freeze({ version: 1, rrfK: 60, lexicalWeight: 1, vectorWeight: 1, minVectorSimilarity: 0.05 });
const terms = text => [...new Set(String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].slice(0, 2048);

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
  invalidate() { this.cache.clear(); this.cacheVersion = -1; }
  checkCache() { const version = this.version(); if (this.cacheVersion !== version) { this.cache.clear(); this.cacheVersion = version; } return version; }
  put({ id = randomUUID(), content, scopeType = 'global', scopeKey = '*', sourceKind = 'user_instruction', sourceId = id, expectedVersion = null }, { vector = null, expectedPrivacyEpoch = null } = {}) {
    if (typeof content !== 'string' || !content.trim() || content.length > 12000 || !['global', 'task_family', 'project', 'entity', 'resource'].includes(scopeType)) throw durableError('INVALID_MEMORY', 'Invalid grounded memory.', 400);
    const embedding = vector || this.encoder.encode(content);
    if (embedding?.then) throw durableError('ASYNC_EMBEDDING', 'Use putAsync for an asynchronous local encoder.', 400);
    if (!(embedding instanceof Float32Array) || embedding.length !== this.encoder.dimensions || [...embedding].some(n => !Number.isFinite(n))) throw durableError('INVALID_EMBEDDING', 'The local encoder returned an invalid vector.', 400);
    return this.database.atomic(() => {
      const epoch = Number(this.database.get('privacy_epoch', '0'));
      if (expectedPrivacyEpoch != null && expectedPrivacyEpoch !== epoch) throw durableError('PRIVACY_CHANGED', 'The privacy generation changed while embedding this source.');
      const source = this.db.prepare('SELECT * FROM source_records WHERE kind=? AND id=?').get(sourceKind, sourceId);
      if (this.database.forgotten(sourceKind, sourceId) || this.database.forgotten('memory', id)) throw durableError('SOURCE_FORGOTTEN', 'The memory source was forgotten.');
      if (source?.active === 0) throw durableError('SOURCE_FORGOTTEN', 'The memory source is no longer available.');
      if (!source && sourceKind !== 'user_instruction') throw durableError('MISSING_PROVENANCE', 'A memory must reference an existing grounded source.', 400);
      const at = iso(this.database.now()), existing = this.db.prepare('SELECT * FROM user_memories WHERE id=?').get(id);
      if (expectedVersion != null && existing?.version !== expectedVersion) throw durableError('MEMORY_CHANGED', 'This memory has changed.');
      if (existing?.content === content && existing.scope_type === scopeType && existing.scope_key === scopeKey
        && this.db.prepare('SELECT 1 FROM memory_embeddings WHERE memory_id=?').get(id) && this.db.prepare('SELECT 1 FROM memory_fts WHERE id=?').get(id)) return existing;
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(?,?,?)').run(sourceKind, sourceId, at);
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'memory\',?,?)').run(id, at);
      this.db.prepare(`INSERT INTO user_memories(id,scope_type,scope_key,content,source_kind,source_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,scope_type=excluded.scope_type,scope_key=excluded.scope_key,
        source_kind=excluded.source_kind,source_id=excluded.source_id,version=user_memories.version+1,updated_at=excluded.updated_at`).run(id, scopeType, scopeKey, content, sourceKind, sourceId, at, at);
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
      this.db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, content);
      this.db.prepare(`INSERT INTO memory_embeddings VALUES(?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET model_id=excluded.model_id,
        dimensions=excluded.dimensions,vector=excluded.vector,privacy_epoch=excluded.privacy_epoch`).run(id, this.encoder.id, embedding.length, encodeBlob(embedding), epoch);
      this.database.lineage(sourceKind, sourceId, 'memory', id);
      this.database.lineage('memory', id, 'embedding', id);
      const version = this.database.bump('context_version');
      this.db.prepare(`INSERT INTO hot_context_items VALUES(?,?,?,?,?,?) ON CONFLICT(origin_kind,origin_id) DO UPDATE SET
        context_version=excluded.context_version,projection_json=excluded.projection_json,updated_at=excluded.updated_at`).run(`memory:${id}`, 'memory', id, version, json({ id, scopeType, scopeKey, content }), at);
      this.invalidate(); return this.db.prepare('SELECT * FROM user_memories WHERE id=?').get(id);
    });
  }
  async putAsync(input) {
    const epoch = Number(this.database.get('privacy_epoch', '0'));
    const vector = await this.encoder.encode(input.content);
    return this.database.write(() => this.put(input, { vector, expectedPrivacyEpoch: epoch }));
  }
  search(query, { scopes = [], limit = 8, expectedContextVersion = null, vector = null } = {}) {
    const version = this.checkCache();
    if (expectedContextVersion != null && expectedContextVersion !== version) throw durableError('CONTEXT_CHANGED', 'The retrieval context version is stale.');
    const key = json([query, scopes, limit, this.encoder.id, version]);
    if (this.cache.has(key)) return structuredClone(this.cache.get(key));
    const permitted = memory => memory.scope_type === 'global' || scopes.some(scope => scope.type === memory.scope_type && scope.key === memory.scope_key);
    const rows = this.db.prepare(`SELECT m.*,e.model_id,e.vector FROM user_memories m LEFT JOIN memory_embeddings e ON e.memory_id=m.id
      JOIN source_records s ON s.kind=m.source_kind AND s.id=m.source_id AND s.active=1 ORDER BY m.updated_at DESC LIMIT ?`).all(this.maxVectors).filter(permitted);
    const queryVector = vector || this.encoder.encode(String(query).slice(0, 4000));
    if (queryVector?.then) throw durableError('ASYNC_EMBEDDING', 'Use searchAsync for an asynchronous local encoder.', 400);
    const matches = new Map(rows.map(row => [row.id, { id: row.id, content: row.content, scopeType: row.scope_type, scopeKey: row.scope_key, sourceKind: row.source_kind, sourceId: row.source_id, score: 0, channels: [] }]));
    const ftsQuery = terms(query).filter(term => [...term].length >= 3).slice(0, 8).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    if (ftsQuery) {
      const lexical = this.db.prepare('SELECT id,bm25(memory_fts) rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 100').all(ftsQuery);
      lexical.forEach((row, index) => { const match = matches.get(row.id); if (match) { match.score += this.ranking.lexicalWeight / (this.ranking.rrfK + index); match.channels.push('fts5'); } });
    }
    rows.filter(row => row.vector && row.model_id === this.encoder.id).map(row => ({ id: row.id, similarity: dot(queryVector, decodeBlob(row.vector)) }))
      .filter(row => row.similarity > this.ranking.minVectorSimilarity).sort((a, b) => b.similarity - a.similarity).slice(0, 40).forEach((row, index) => {
        const match = matches.get(row.id); match.score += this.ranking.vectorWeight / (this.ranking.rrfK + index); match.channels.push(this.encoder.semantic ? 'local_semantic' : 'local_lexical_vector');
      });
    const result = [...matches.values()].filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.min(20, Math.max(1, limit)));
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, result); return structuredClone(result);
  }
  async searchAsync(query, options = {}) {
    const version = this.version(), epoch = Number(this.database.get('privacy_epoch', '0'));
    const vector = await this.encoder.encode(query);
    if (epoch !== Number(this.database.get('privacy_epoch', '0'))) throw durableError('PRIVACY_CHANGED', 'Privacy changed during retrieval.');
    return this.search(query, { ...options, vector, expectedContextVersion: version });
  }
  configure({ expectedVersion, ...values }) {
    if (expectedVersion !== this.ranking.version || Object.keys(values).some(key => !Object.hasOwn(RETRIEVAL_DEFAULTS, key) || key === 'version')) throw durableError('RETRIEVAL_POLICY_CHANGED', 'The retrieval policy version or fields are invalid.');
    const next = { ...this.ranking, ...values, version: this.ranking.version + 1 };
    if (!Number.isFinite(next.rrfK) || next.rrfK < 10 || next.rrfK > 200 || [next.lexicalWeight, next.vectorWeight].some(value => !Number.isFinite(value) || value < 0 || value > 4)
      || next.lexicalWeight + next.vectorWeight === 0 || next.minVectorSimilarity < 0 || next.minVectorSimilarity > 1) throw durableError('INVALID_RETRIEVAL_POLICY', 'Invalid retrieval ranking parameters.', 400);
    this.database.atomic(() => { const saved = JSON.parse(this.database.get('retrieval_policy', '{}')); if (saved.version != null && saved.version !== expectedVersion) throw durableError('RETRIEVAL_POLICY_CHANGED', 'The retrieval policy changed.'); this.database.set('retrieval_policy', json(next)); this.database.bump('context_version'); }); this.ranking = next; this.invalidate(); return next;
  }
  describe() { return { lexical: 'FTS5 trigram', vector: this.encoder.id, semantic: this.encoder.semantic === true, inProcess: true, ranking: this.ranking, cachedQueries: this.cache.size, contextVersion: this.version() }; }
}
