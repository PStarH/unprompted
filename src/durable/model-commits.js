import { ModelRoutingService } from './model-routing.js';
import { durableError } from './database.js';
import { stableDigest } from './reasoning-sessions.js';
import { requireAccountingContext, guardModelContext, brandModelStage } from '../model-request.js';

function snapshot(value) {
  let copy;
  try { copy = structuredClone(value); }
  catch { throw durableError('INVALID_SESSION', 'Model context bindings must be snapshot data.', 400); }
  const seen = new WeakSet();
  const freeze = item => {
    if (!item || typeof item !== 'object' || seen.has(item)) return item;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(copy);
}

/** Native semantic commit bridge. Contexts are local capabilities, never task
 * state or wire data. Callers validate model meaning and tool authority. */
export class ModelCommits {
  #store;
  #sessions;
  #calls = new WeakMap();

  constructor(store, sessions) {
    if (!store?.database?.db || typeof store.mutate !== 'function') {
      throw durableError('UNSUPPORTED_STORE', 'Private model commits require the durable workspace store.', 409);
    }
    if (sessions?.database !== store.database) throw durableError('INVALID_SESSION', 'The session service must share this workspace database.', 400);
    this.#store = store;
    this.#sessions = sessions;
  }

  context({ scope, taskId = null, key, stage = 'general', owner, bindings, sourceRefs = [], isCurrent } = {}) {
    const normalized = requireAccountingContext({ scope, taskId });
    if (typeof key !== 'string' || !key || key.length > 16000 || typeof isCurrent !== 'function'
      || !['general', 'interpret', 'discovery', 'planning', 'verification'].includes(stage)) {
      throw durableError('INVALID_SESSION', 'A model context needs a semantic key, stage and current-owner check.', 400);
    }
    const routingService = new ModelRoutingService(this.#store.database), routing = routingService.snapshot(stage);
    const current = () => isCurrent() === true && routingService.isCurrent(routing);
    // Preserve pre-routing cached sessions exactly when no policy was ever
    // configured; any explicit revision starts a new private content identity.
    const routeIdentity = routing.version === 0 ? {} : { routingVersion: routing.version, routingDigest: routing.digest || 'disabled' };
    const spec = Object.freeze({ logicalKey: stableDigest({ scope, taskId, key, stage, ...routeIdentity }), semanticStage: stage,
      owner: snapshot(owner), bindings: snapshot({ ...bindings, ...routeIdentity }), sourceRefs: snapshot(sourceRefs), isCurrent: current });
    const context = brandModelStage(guardModelContext(Object.freeze({ ...normalized, session: spec }), current), stage, routing);
    const record = { handle: null, consumed: false };
    this.#calls.set(context, record);
    this.#sessions.watchContext(spec, turn => {
      if (record.handle) throw durableError('INVALID_SESSION', 'The context already captured a model invocation.', 409);
      record.handle = Object.freeze({ id: turn.id, owner: structuredClone(turn.owner), claimId: turn.claimId, isCurrent: current });
    });
    return context;
  }

  hasInvocation(context) {
    const record = this.#calls.get(context);
    return Boolean(record?.handle && !record.consumed);
  }

  #ready(context) {
    const record = this.#calls.get(context);
    if (!record?.handle || record.consumed) throw durableError('INVALID_SESSION_COMMIT', 'A live captured model context is required.', 409);
    this.#sessions.assertOwner(record.handle);
    const view = this.#sessions.read({ id: record.handle.id });
    if (view.status !== 'awaiting_commit' || !view.hasFinal) throw durableError('SESSION_NO_FINAL', 'A final answer must pass semantic validation before commit.', 409);
    return record;
  }

  commit(context, mutation, { afterSync = null } = {}) {
    if (afterSync !== null && typeof afterSync !== 'function') throw durableError('INVALID_SESSION_COMMIT', 'A synchronous native commit hook is required.', 400);
    if (typeof mutation !== 'function') throw durableError('INVALID_SESSION_COMMIT', 'A synchronous semantic mutation is required.', 400);
    let record;
    const result = this.#store.mutate(state => {
      if (this.#store.database !== this.#sessions.database || !this.#sessions.db.inTransaction) {
        throw durableError('INVALID_SESSION_COMMIT', 'The semantic projection and session must share one active transaction.', 409);
      }
      record = this.#ready(context);
      // ACK and the projection become visible in one COMMIT. Before #sync,
      // the original SQL input fence still holds even if the accepted output
      // advances inputVersion. Any later failure rolls back private erasure.
      this.#sessions.ack(record.handle);
      return mutation(state);
    }, { afterSync });
    record.consumed = true;
    return result;
  }

  /** Native SQL callers own their projection and refresh the workspace view
   * after success. This bridge owns its transaction so declining can roll back
   * every guard write while keeping the private final unconsumed. */
  commitSql(context, mutation, { canCommit = null } = {}) {
    if (typeof mutation !== 'function' || canCommit !== null && typeof canCommit !== 'function') {
      throw durableError('INVALID_SESSION_COMMIT', 'Synchronous native SQL callbacks are required.', 400);
    }
    if (this.#sessions.db.inTransaction) throw durableError('INVALID_SESSION_COMMIT', 'A native SQL commit must own its transaction.', 409);
    const declined = Symbol('declined-native-model-commit');
    let record, outcome;
    try {
      outcome = this.#sessions.database.atomic(() => {
        if (this.#store.database !== this.#sessions.database || !this.#sessions.db.inTransaction) {
          throw durableError('INVALID_SESSION_COMMIT', 'SQL projection and session must share one active transaction.', 409);
        }
        record = this.#ready(context);
        if (canCommit) {
          const allowed = canCommit();
          if (allowed?.then) { Promise.resolve(allowed).catch(() => {}); throw new TypeError('SQL commit predicates must be synchronous.'); }
          if (typeof allowed !== 'boolean') throw durableError('INVALID_SESSION_COMMIT', 'SQL commit predicates must return a boolean.', 400);
          if (!allowed) throw declined;
        }
        // ACK against the original input before the accepted SQL projection
        // can advance it; a subsequent failure rolls back both writes.
        this.#sessions.ack(record.handle);
        const value = mutation();
        if (value?.then) { Promise.resolve(value).catch(() => {}); throw new TypeError('SQL commit mutations must be synchronous.'); }
        return { committed: true, value };
      });
    } catch (error) {
      if (error === declined) return { committed: false };
      throw error;
    }
    record.consumed = true;
    return outcome;
  }

  reject(context, reason = 'semantic_validation_failed') {
    if (typeof reason !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(reason)) {
      throw durableError('INVALID_SESSION_COMMIT', 'Use a bounded rejection tag, not model or provider prose.', 400);
    }
    // Single-call interpretation/discovery can return null/scalars without caching a
    // final. Retire that invalid invocation under its real owner; never ACK it.
    const captured = this.#calls.get(context);
    if (captured?.handle && !captured.consumed && ['interpret', 'discovery'].includes(context.session?.semanticStage)) {
      const discarded = this.#sessions.database.atomic(() => {
        this.#sessions.assertOwner(captured.handle);
        const view = this.#sessions.read({ id: captured.handle.id });
        if (view.status !== 'active' || view.hasFinal || view.hasPending) return false;
        this.#sessions.invalidate({ id: captured.handle.id, reason });
        return true;
      });
      if (discarded) { captured.consumed = true; return; }
    }
    const record = this.#ready(context);
    const result = this.#sessions.rejectFinal({ ...record.handle, reason });
    record.consumed = true;
    return result;
  }
}
