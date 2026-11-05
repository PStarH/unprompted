import { randomUUID } from 'node:crypto';
import { rankMemoryResults, memoryContext, isMeaningfulRelation } from '../memory-explorer.js';
import { durableError, iso, parse } from './database.js';
import { memoryConsumable, memoryExpired, memoryLifecycle, validMemoryDate } from '../memory-lifecycle.js';

const KINDS = ['fact', 'preference'];
const RELATIONS = ['belongs_to', 'mentions', 'related_to', 'derived_from', 'supersedes', 'contradicts'];
const SYMMETRIC = new Set(['related_to', 'contradicts']);
const normal = value => String(value || '').trim().toLocaleLowerCase();

function memoryText(row) {
  return {
    id: row.id, text: row.content, content: row.content,
    memoryKind: row.memory_kind || 'fact', lifecycleState: row.lifecycle_state || 'active',
    scopeType: row.scope_type, scopeKey: row.scope_key,
    sourceKind: row.source_kind, sourceId: row.source_id,
    version: row.version, expectedVersion: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    lifecycleUpdatedAt: row.lifecycle_updated_at || null, validUntil: row.valid_until || null,
    taskId: null, scope: null, origin: row.source_kind === 'task_memory' ? 'task_direction' : row.source_kind
  };
}

function versionText(row) {
  return { version: row.version, text: row.content, content: row.content,
    memoryKind: row.memory_kind || 'fact', scopeType: row.scope_type, scopeKey: row.scope_key,
    lifecycleState: row.lifecycle_state, validUntil: row.valid_until || null,
    changeKind: row.change_kind, createdAt: row.created_at };
}

function relationText(row) {
  return { id: row.id || `${row.source_memory_id}:${row.relation_kind}:${row.target_memory_id}`,
    from: row.source_memory_id, to: row.target_memory_id, kind: row.relation_kind,
    status: row.status || 'established', evidenceKind: row.evidence_kind,
    evidenceRef: row.evidence_ref || null, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at };
}

/** A read projection and lifecycle router. The graph never owns memory content;
 * legacy task directions remain authoritative in the workspace store. */
export class MemorySpaceService {
  constructor(runtime) {
    this.runtime = runtime; this.engine = runtime.engine; this.store = runtime.store;
    this.database = runtime.database; this.db = runtime.db;
  }

  row(id) { return this.db.prepare('SELECT * FROM user_memories WHERE id=?').get(id); }

  record(row) {
    const memory = memoryText(row), legacy = this.store.state.taskMemories?.[row.id];
    if (legacy) {
      memory.taskId = legacy.taskId || null; memory.scope = legacy.scope || null;
      memory.origin = legacy.origin || memory.origin;
      memory.expectedVersion = legacy.updatedAt;
      memory.updatedAt = legacy.updatedAt || memory.updatedAt;
      memory.createdAt = legacy.createdAt || memory.createdAt;
      memory.mirrorUpdatedAt = row.updated_at;
      memory.memoryKind = legacy.memoryKind || memory.memoryKind;
      memory.supersededBy = legacy.supersededBy || null;
    } else if (row.scope_type === 'project') {
      const scope = row.scope_key.trim().startsWith('[') ? parse(row.scope_key) : null;
      memory.scope = Array.isArray(scope) && scope.length === 2
        ? { entity: scope[0], deliverable: scope[1] }
        : { entity: row.scope_key, deliverable: null };
    }
    if (row.scope_type === 'entity') memory.scope = { entity: row.scope_key.startsWith('person:') ? row.scope_key.slice(7) : row.scope_key, entityType: row.scope_key.startsWith('person:') ? 'person' : 'entity' };
    memory.status = memory.lifecycleState === 'active' && memoryExpired(memory, this.database.now()) ? 'expired' : memory.lifecycleState;
    memory.consumable = memoryConsumable(memory, this.database.now())
      && Boolean(this.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=? AND active=1').get(row.source_kind, row.source_id))
      && !this.db.prepare("SELECT 1 FROM memory_relations WHERE target_memory_id=? AND relation_kind='supersedes' AND status='established'").get(row.id);
    memory.readonly = !this.engine || this.store.state.mode === 'simulation' && this.store.state.simulation?.demo === true;
    memory.sourceTasks = this.sourceTasks(row);
    memory.sourceTask = memory.sourceTasks[0] ? { id: memory.sourceTasks[0].id, title: memory.sourceTasks[0].subject } : null;
    return memory;
  }

  sourceTasks(row) {
    const ids = new Set();
    const legacy = this.store.state.taskMemories?.[row.id];
    if (legacy?.taskId) ids.add(legacy.taskId);
    for (const execution of this.db.prepare("SELECT DISTINCT task_id FROM tool_executions WHERE provider='workspace_memory' AND tool='update_memory' AND resource_id=? AND status='verified' LIMIT 32").all(row.id)) ids.add(execution.task_id);
    for (const relation of this.db.prepare(`SELECT source_kind,source_id,derived_kind,derived_id FROM lineage
      WHERE (source_kind IN ('memory','task_memory') AND source_id=?) OR (derived_kind IN ('memory','task_memory') AND derived_id=?) LIMIT 64`).all(row.id, row.id)) {
      if (relation.source_kind === 'task') ids.add(relation.source_id);
    }
    return [...ids].filter(id => this.store.state.tasks?.[id] && !this.store.state.tasks[id].privacyInvalidated).sort().slice(0, 32)
      .map(id => ({ id, subject: this.store.state.tasks[id].subject || null }));
  }

  records() {
    return this.db.prepare('SELECT * FROM user_memories ORDER BY updated_at DESC,id').all().map(row => this.record(row));
  }

  browse({ query = '', q = query, kind = 'all', scope = '', status = 'current', focus = null, focusId = focus, limit = 500 } = {}) {
    const maximum = Math.max(1, Math.min(500, Number.isInteger(Number(limit)) ? Number(limit) : 500));
    const all = this.records();
    const relations = this.relationsFor(all.map(memory => memory.id));
    const changes = this.db.prepare("SELECT memory_id,change_kind FROM memory_versions WHERE change_kind IN ('edit','supersede','restore-version','agent_edit','agent_supersede')").all();
    const history = new Map();
    for (const change of changes) { if (!history.has(change.memory_id)) history.set(change.memory_id, []); history.get(change.memory_id).push(change.change_kind.replace(/^agent_/, '')); }
    for (const memory of all) {
      memory.historyKinds = history.get(memory.id) || [];
      const edges = relations.filter(isMeaningfulRelation).filter(edge => edge.from === memory.id || edge.to === memory.id);
      memory.relatedMemories = edges.map(edge => all.find(record => record.id === (edge.from === memory.id ? edge.to : edge.from))).filter(Boolean).map(record => ({ id: record.id, content: record.content }));
      memory.isCorrection = edges.some(edge => edge.kind === 'supersedes');
      memory.relations = edges.map(edge => ({ ...edge, targetId: edge.from === memory.id ? edge.to : edge.from }));
    }
    const candidates = all.filter(memory => {
      if (kind !== 'all' && memory.memoryKind !== kind) return false;
      if (scope && normal(memory.scopeKey) !== normal(scope) && normal(memory.scope?.entity) !== normal(scope)) return false;
      if (status === 'remembered') return memory.lifecycleState !== 'deleted';
      if (status === 'current') return memory.consumable;
      if (status === 'active') return memory.lifecycleState === 'active';
      return status === 'all' || memory.status === status;
    });
    // Reuse the existing local hybrid index as a tie-breaker, with the same
    // saved applicability scopes. Explorer search itself remains read-only.
    const scopes = [...new Map(candidates.filter(memory => memory.scopeType !== 'global').map(memory => [`${memory.scopeType}:${memory.scopeKey}`, { type: memory.scopeType, key: memory.scopeKey }])).values()];
    const finish = retrieval => {
    const ranked = rankMemoryResults(candidates, q, { retrieval, now: this.database.now() });
    const records = ranked.slice(0, maximum);
    const allowed = new Set(records.map(memory => memory.id));
    return { records, relations: relations.filter(edge => allowed.has(edge.from) && allowed.has(edge.to)), derivedRelations: [],
      total: ranked.length, truncated: ranked.length > maximum,
      focusId: records.find(memory => memory.id === focusId)?.id || records[0]?.id || null,
      contextVersion: Number(this.database.get('context_version', '0')) };
    };
    if (q.trim() && this.runtime.memory.usesAsyncEncoder()) return this.runtime.memory.searchAsync(q, { scopes: scopes.slice(0, 200), limit: 20 }).then(finish);
    return finish(q.trim() ? this.runtime.memory.search(q, { scopes: scopes.slice(0, 200), limit: 20 }) : []);
  }

  relationsFor(ids) {
    if (!ids.length) return [];
    const allowed = new Set(ids);
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM memory_relations WHERE source_memory_id IN (${placeholders}) OR target_memory_id IN (${placeholders})
      ORDER BY created_at,source_memory_id,relation_kind,target_memory_id`).all(...ids, ...ids)
      .filter(row => allowed.has(row.source_memory_id) && allowed.has(row.target_memory_id)).map(relationText);
  }

  get(id, { depth = 1 } = {}) {
    const row = this.row(id);
    if (!row) throw durableError('MEMORY_NOT_FOUND', 'This memory no longer exists.', 404);
    const memory = this.record(row);
    const versions = this.db.prepare('SELECT * FROM memory_versions WHERE memory_id=? ORDER BY version DESC LIMIT 100').all(id).map(versionText);
    const legacy = this.store.state.taskMemories?.[id];
    if (legacy) for (const version of legacy.versions || []) if (!versions.some(existing => existing.changeKind === version.changeKind && existing.createdAt === version.createdAt)) versions.push({ ...version, content: version.text });
    versions.sort((a, b) => b.version - a.version);
    const relations = this.db.prepare('SELECT * FROM memory_relations WHERE source_memory_id=? OR target_memory_id=? ORDER BY created_at,source_memory_id,relation_kind,target_memory_id LIMIT 128').all(id, id).map(relationText);
    const lineage = this.db.prepare(`SELECT * FROM lineage WHERE (source_kind IN ('memory','task_memory') AND source_id=?)
      OR (derived_kind IN ('memory','task_memory') AND derived_id=?) ORDER BY created_at,source_kind,source_id LIMIT 64`).all(id, id)
      .map(row => ({ sourceKind: row.source_kind, sourceId: row.source_id, derivedKind: row.derived_kind, derivedId: row.derived_id, createdAt: row.created_at }));
    const usage = this.db.prepare(`SELECT r.id runId,r.task_id taskId,r.status,r.created_at createdAt,t.data_json FROM lineage l
      JOIN task_runs r ON r.id=l.derived_id AND l.derived_kind='task_run' JOIN tasks t ON t.id=r.task_id
      WHERE l.source_kind IN ('memory','task_memory') AND l.source_id=? ORDER BY r.created_at DESC,r.id LIMIT 32`).all(id)
      .filter(run => !parse(run.data_json)?.privacyInvalidated).map(({ data_json, ...run }) => ({ ...run, subject: parse(data_json)?.subject || null }));
    const activationUsage = this.db.prepare(`SELECT j.id,j.job_type kind,l.created_at createdAt,e.id eventId,e.event_json
      FROM lineage l JOIN jobs j ON l.derived_kind='job' AND j.id=l.derived_id
      JOIN lineage origin ON origin.derived_kind='job' AND origin.derived_id=j.id AND origin.source_kind='event'
      JOIN durable_inbox e ON e.id=origin.source_id AND e.state!='forgotten'
      JOIN source_records s ON s.kind='event' AND s.id=e.id AND s.active=1
      WHERE l.source_kind IN ('memory','task_memory') AND l.source_id=?
        AND j.job_type IN ('standing_intent_match','situation_pair','situation_delta')
      ORDER BY l.created_at DESC,j.id,e.id LIMIT 16`).all(id)
      .filter(item => !this.runtime.privacy.permissionRevoked(parse(item.event_json)?.connectorId))
      .map(({ event_json, ...item }) => { const event = parse(event_json); return { ...item, subject: event?.payload?.subject || event?.payload?.title || null }; });
    const source = this.db.prepare('SELECT kind,id,active,created_at FROM source_records WHERE kind=? AND id=?').get(memory.sourceKind, memory.sourceId);
    const all = this.records(), allRelations = this.relationsFor(all.map(record => record.id));
    const neighborhood = new Set([id]);
    for (let hop = 0; hop < Math.max(1, Math.min(2, Number(depth) || 1)); hop++) {
      const frontier = new Set(neighborhood);
      for (const edge of allRelations.filter(isMeaningfulRelation)) {
        if (frontier.has(edge.from)) neighborhood.add(edge.to);
        if (frontier.has(edge.to)) neighborhood.add(edge.from);
      }
    }
    const context = memoryContext(memory, all, allRelations);
    context.centerId = id;
    context.memories = all.filter(record => record.id !== id && neighborhood.has(record.id)).slice(0, 32);
    const allowed = new Set([id, ...context.memories.map(record => record.id)]);
    context.relations = allRelations.filter(isMeaningfulRelation).filter(edge => allowed.has(edge.from) && allowed.has(edge.to));
    return { memory, context, versions: versions.slice(0, 100), provenance: { source: source ? { kind: source.kind, id: source.id, active: Boolean(source.active), createdAt: source.created_at } : null,
      tasks: memory.sourceTasks, lineage, usage, activationUsage }, relations };
  }

  create({ content, text: inputText = content, memoryKind = 'fact', scopeType = 'global', scopeKey = '*', validUntil = null } = {}, { actor = 'user', sourceKind, sourceId, id, vector = null } = {}) {
    this.assertWritable();
    if (typeof inputText !== 'string' || !inputText.trim() || inputText.trim().length > 2000 || !KINDS.includes(memoryKind)) throw durableError('INVALID_MEMORY', 'A memory needs 1–2,000 characters and a valid kind.', 400);
    if (!['global', 'task_family', 'project', 'entity', 'resource'].includes(scopeType) || typeof scopeKey !== 'string' || !scopeKey.trim()) throw durableError('INVALID_MEMORY', 'Choose a valid applicability scope.', 400);
    let validity;
    try { validity = validMemoryDate(validUntil); } catch (error) { throw durableError('INVALID_MEMORY', error.message, 400); }
    const input = { content: inputText.trim(), memoryKind, scopeType, scopeKey: scopeKey.trim(), validUntil: validity, changeKind: actor === 'agent' ? 'agent_remember' : 'created', ...(actor === 'agent' ? { id, sourceKind, sourceId } : {}) };
    if (!vector && this.runtime.memory.usesAsyncEncoder()) return this.runtime.memory.putAsync(input).then(memory => { this.runtime.contextChanged(); return this.get(memory.id); });
    const memory = this.runtime.memory.put(input, { vector });
    this.runtime.contextChanged(); return this.get(memory.id);
  }

  assertWritable() {
    if (!this.engine || !this.runtime) throw durableError('DURABLE_WORKSPACE_REQUIRED', 'Open the persistent workspace to change memory.', 409);
  }

  update(id, input = {}, { actor = 'user', sourceKind, sourceId, vector = null, replacementVector = null, onCommit = null } = {}) {
    this.assertWritable();
    const legacy = this.store.state.taskMemories?.[id];
    if (legacy) {
      const version = input.version ?? input.expectedVersion;
      const result = this.engine.updateTaskMemory(id, { ...input, version, text: input.text ?? input.content }, { afterSync: recordId => {
        if (actor === 'agent') {
          this.db.prepare('UPDATE memory_versions SET change_kind=? WHERE memory_id=? AND version=(SELECT MAX(version) FROM memory_versions WHERE memory_id=?)').run(`agent_${input.operation}`, recordId, recordId);
          const history = this.store.state.taskMemories[recordId].versions;
          if (history?.length) history.at(-1).changeKind = `agent_${input.operation}`;
        }
        onCommit?.({ memory: this.record(this.row(recordId)), replacementId: recordId === id ? null : recordId });
      } });
      this.runtime.contextChanged();
      return { memory: this.record(this.row(result.id)), replacementId: result.id === id ? null : result.id };
    }
    if (!vector && this.runtime.memory.usesAsyncEncoder()) return this.#updateAsync(id, input, { actor, sourceKind, sourceId });
    const row = this.row(id);
    if (!row) throw durableError('MEMORY_NOT_FOUND', 'This memory no longer exists.', 404);
    const expected = input.expectedVersion ?? input.version;
    if (expected !== row.version) throw durableError('MEMORY_CHANGED', 'This memory changed. Review its latest version.');
    const operation = input.operation, lifecycle = memoryLifecycle(row);
    const allowed = { edit: ['active', 'disabled'], disable: ['active'], reactivate: ['disabled'], archive: ['active', 'disabled'],
      restore: ['archived', 'deleted'], 'restore-delete': ['deleted'], delete: ['active', 'disabled', 'archived'],
      supersede: ['active', 'disabled'], 'restore-version': ['active', 'disabled'], validity: ['active', 'disabled'] };
    if (!allowed[operation]?.includes(lifecycle)) throw durableError('INVALID_MEMORY_OPERATION', `A ${lifecycle} memory cannot use this operation.`);
    let validity;
    try { validity = validMemoryDate(operation === 'validity' || input.validUntil !== undefined ? input.validUntil : row.valid_until); }
    catch (error) { throw durableError('INVALID_MEMORY', error.message, 400); }
    const changes = { id, expectedVersion: row.version, content: row.content, scopeType: row.scope_type, scopeKey: row.scope_key,
      sourceKind: row.source_kind, sourceId: row.source_id, memoryKind: input.memoryKind || row.memory_kind || 'fact', lifecycleState: lifecycle,
      validUntil: validity, changeKind: actor === 'agent' ? `agent_${operation}` : operation };
    if (actor === 'agent' && operation === 'edit') { changes.sourceKind = sourceKind; changes.sourceId = sourceId; }
    if (!KINDS.includes(changes.memoryKind)) throw durableError('INVALID_MEMORY', 'Choose a fact or preference.', 400);
    let replacementId = null;
    this.database.atomic(() => {
      if (['edit', 'restore-version'].includes(operation)) {
        const content = input.text ?? input.content;
        if (typeof content !== 'string' || !content.trim() || content.trim().length > 2000) throw durableError('INVALID_MEMORY', 'An editable memory requires 1–2,000 characters.', 400);
        changes.content = content.trim();
        if (input.scopeType) changes.scopeType = input.scopeType;
        if (input.scopeKey) changes.scopeKey = input.scopeKey;
      }
      if (operation === 'disable') changes.lifecycleState = 'disabled';
      if (operation === 'reactivate') changes.lifecycleState = 'active';
      if (operation === 'archive') changes.lifecycleState = 'archived';
      if (operation === 'restore' || operation === 'restore-delete') {
        if (this.db.prepare("SELECT 1 FROM memory_relations WHERE target_memory_id=? AND relation_kind='supersedes' AND status='established'").get(id)) throw durableError('MEMORY_SUPERSEDED', 'A superseded memory cannot be restored as current.');
        changes.lifecycleState = 'active';
      }
      if (operation === 'delete') changes.lifecycleState = 'deleted';
      if (operation === 'supersede') {
        const content = input.text ?? input.content ?? input.replacement?.content;
        if (typeof content !== 'string' || !content.trim() || content.trim().length > 2000) throw durableError('INVALID_MEMORY', 'A replacement requires 1–2,000 characters.', 400);
        const replacement = this.runtime.memory.put({ content: content.trim(), memoryKind: changes.memoryKind,
          scopeType: changes.scopeType, scopeKey: changes.scopeKey, validUntil: validMemoryDate(input.replacement && Object.hasOwn(input.replacement, 'validUntil') ? input.replacement.validUntil : validity), changeKind: actor === 'agent' ? 'agent_supersede' : 'supersede',
          ...(actor === 'agent' ? { sourceKind, sourceId } : {}) }, { vector: replacementVector });
        replacementId = replacement.id;
        this.db.prepare(`INSERT INTO memory_relations(id,source_memory_id,target_memory_id,relation_kind,status,evidence_kind,evidence_ref,created_at,updated_at)
          VALUES(?,?,?,'supersedes','established','direct_correction',?,?,?)`).run(randomUUID(), replacementId, id, id, iso(this.database.now()), iso(this.database.now()));
        changes.lifecycleState = 'superseded'; changes.expectedVersion = row.version;
      }
      this.runtime.memory.put(changes, { vector });
    });
    this.runtime.contextChanged();
    return { memory: this.record(this.row(replacementId || id)), replacementId };
  }

  async #updateAsync(id, input = {}, options = {}) {
    const row = this.row(id);
    if (!row) throw durableError('MEMORY_NOT_FOUND', 'This memory no longer exists.', 404);
    if ((input.expectedVersion ?? input.version) !== row.version) throw durableError('MEMORY_CHANGED', 'This memory changed. Review its latest version.');
    const content = ['edit', 'restore-version'].includes(input.operation) ? input.text ?? input.content : row.content;
    const replacement = input.operation === 'supersede' ? input.text ?? input.content ?? input.replacement?.content : null;
    if (typeof content !== 'string' || !content.trim() || replacement != null && (typeof replacement !== 'string' || !replacement.trim())) throw durableError('INVALID_MEMORY', 'Supply the memory content.', 400);
    const encoder = this.runtime.memory.encoder, epoch = Number(this.database.get('privacy_epoch'));
    const [vector, replacementVector] = await Promise.all([encoder.encode(content.trim()), replacement == null ? null : encoder.encode(replacement.trim())]);
    return this.database.write(() => {
      if (epoch !== Number(this.database.get('privacy_epoch'))) throw durableError('PRIVACY_CHANGED', 'Privacy changed while preparing this memory update.');
      if (encoder !== this.runtime.memory.encoder) throw durableError('CONTEXT_CHANGED', 'The memory encoder changed while preparing this update.');
      // Reuse the synchronous atomic lifecycle implementation after all async
      // work. Version/source checks, replacement and history commit together.
      return this.update(id, input, { ...options, vector, replacementVector });
    });
  }

  changeRelation(id, { operation, targetId, kind, expectedVersion, status = 'established', evidenceKind = 'user_confirmed', evidenceRef = null } = {}) {
    this.assertWritable();
    const source = this.row(id), target = this.row(targetId);
    if (!source || !target || id === targetId || kind === 'supersedes' || !RELATIONS.includes(kind) || !['add', 'remove'].includes(operation)) throw durableError('INVALID_RELATION', 'Choose two existing memories and a supported relation.', 400);
    if (expectedVersion !== source.version || !['established', 'suggested'].includes(status)) throw durableError('MEMORY_CHANGED', 'The memory or relation status changed.');
    let from = id, to = targetId;
    if (SYMMETRIC.has(kind) && from > to) [from, to] = [to, from];
    this.database.atomic(() => {
      if (operation === 'remove') this.db.prepare('DELETE FROM memory_relations WHERE relation_kind=? AND ((source_memory_id=? AND target_memory_id=?) OR (source_memory_id=? AND target_memory_id=?))').run(kind, from, to, to, from);
      else this.db.prepare(`INSERT INTO memory_relations(id,source_memory_id,target_memory_id,relation_kind,status,evidence_kind,evidence_ref,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_memory_id,target_memory_id,relation_kind) DO UPDATE SET status=excluded.status,evidence_kind=excluded.evidence_kind,evidence_ref=excluded.evidence_ref,updated_at=excluded.updated_at`)
        .run(randomUUID(), from, to, kind, status, evidenceKind, evidenceRef, iso(this.database.now()), iso(this.database.now()));
      this.database.bump('context_version');
    });
    this.runtime.contextChanged(); return this.relationsFor([id, targetId]);
  }
}
