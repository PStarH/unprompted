import { randomUUID } from 'node:crypto';
import { durableError } from './durable/database.js';
import { MODEL_PROTOCOLS, isModelProtocol } from './model-protocol.js';

/**
 * Transport-facing token accounting adapter.
 *
 * This is the seam between a real model request and the durable
 * TokenBudgetService ledger. It deliberately owns no ledger of its own and
 * performs no network I/O, permissions, retries or provider selection.
 *
 * One real network request uses one attempt:
 *
 *   const { attempt, payload } = accounting.prepare({
 *     protocol, payload, scope: 'task', taskId
 *   });
 *   // Run local checks here. If they fail before the network call:
 *   //   accounting.fail(attempt)
 *   accounting.markDispatched(attempt);
 *   const response = await fetch(...);           // outside this adapter
 *   accounting.settleResponse(attempt, { protocol, body });
 *
 * `scope` is required and is either `'workspace'` or `'task'`. A task-scoped
 * call must carry a trusted `taskId` from the caller's own context (never from
 * model output); a workspace-scoped call may not carry one. Workspace calls
 * cover requests that are not attributable to a task, such as discovery and
 * connection checks: they are checked against the workspace limit only, so
 * another task's exhausted limit can never block them. Task calls are checked
 * against their own task limit and the workspace limit. The adapter cannot
 * infer which task an untagged request belongs to; trusted entry wiring must
 * declare the real scope, and declaring `'workspace'` to dodge a task limit is
 * a wiring-review boundary, not something this layer can detect.
 *
 * `prepare` reserves the complete wire payload's UTF-8 byte length as a
 * conservative input estimate. Tools, schemas and tool-loop follow-up results
 * are included because the estimate covers the whole JSON body, not just
 * system and user text. When a workspace or task limit is configured (even a
 * zero limit), it also adds or clamps the protocol's output cap to 2048 tokens
 * and fails closed on any known cap field that belongs to another protocol
 * (`max_output_tokens` on chat, `max_tokens`/`max_completion_tokens` on
 * responses, `max_completion_tokens`/`max_output_tokens` on messages), so the
 * reservation always covers the cap that goes on the wire. Without a
 * configured limit the caller's payload shape is preserved so existing
 * requests keep working; the reservation then holds a legal explicit output
 * cap as written (not clamped), or a 2048 default when no legal cap exists.
 * The attempt reports `outputBound`:
 * - `'enforced'`: the reservation covers a legal explicit cap on the wire
 *   (adapter-added when limited, or caller-supplied when unlimited).
 * - `'estimated'`: the wire request has no legal output limit, so the 2048
 *   hold is only a conservative estimate. It is never a retroactive hard
 *   bound on a request that was allowed to be uncapped.
 *
 * The returned payload is a deep-frozen JSON clone of the caller's object. The
 * caller's own object is never modified and stays mutable; the returned clone
 * cannot be changed after the input estimate is taken, so a cap change, an
 * appended message or a schema edit fails loudly instead of silently
 * under-covering the reservation. Send the returned payload unchanged.
 *
 * The prepare-time workspace limit and, for task scope, that task's limit are
 * snapshotted. `markDispatched` re-reads them in the same transaction as the
 * dispatch marker and refuses the permit if either relevant value changed, so
 * an enabled, disabled or resized budget can never send an old payload whose
 * cap no longer matches the configuration. The error tells the caller to
 * cancel the attempt with `fail` and prepare a new one. Unrelated task limits
 * do not affect a workspace call or another task. A request that has already
 * been dispatched cannot be retracted by a later configuration change.
 *
 * `markDispatched` is the single network permit for an attempt. Inside one
 * transaction it re-checks the limit snapshot, re-reads the ledger row through
 * the core's idempotent `reserve` replay, accepts only a row that is still the
 * one `prepare` created and still `reserved`, and only then calls the core
 * dispatch marker. A row dispatched, settled, unknown or cancelled by anyone
 * else is refused; the core's idempotent return value is never treated as a
 * fresh permit. Attempt tokens are opaque, frozen and identity-bound: only the
 * exact object returned by this adapter's `prepare` is accepted, so a clone,
 * lookalike or token from another adapter cannot borrow a reservation.
 *
 * Core validation errors pass through unchanged: an invalid `taskId` surfaces
 * the core `INVALID_TOKEN_BUDGET` (400) rather than a second adapter copy of
 * the same validation.
 *
 * `settleResponse` accepts a response only for a dispatched attempt. Provider
 * usage is normalized into the core's mutually exclusive canonical components.
 * For chat-completions and responses, the provider's input count includes
 * cached input, so the adapter subtracts cacheRead before handing the four
 * separate counts to the ledger. Anthropic messages already reports separate
 * components. A `null` OpenAI cache-details object is treated like an absent
 * one (zero cached tokens) because some compatible servers emit `null` for
 * empty details; non-object, array and malformed values are still untrusted.
 * Missing or untrusted usage marks the whole hold unknown rather than mapping
 * absent fields to a trusted zero. An explicit complete zero is trusted and
 * settles normally. Usage above the reservation is recorded truthfully; if the
 * ledger cannot represent it, the adapter marks the hold unknown and rethrows
 * the original overflow error for observation.
 *
 * `fail` cancels an attempt that never reached the network. For a dispatched
 * attempt it keeps the entire hold by marking it unknown, because the provider
 * may already have processed the request. A settled attempt can never be
 * turned back into unknown.
 *
 * Coverage limit: this layer only covers call sites that explicitly use these
 * methods. Any path that cannot intercept every real provider call (notably the
 * Pi/SDK entry points) must be refused while a token budget is enabled instead
 * of silently bypassing accounting. Do not describe this adapter alone as
 * product-wide budget enforcement.
 *
 * The adapter stores no prompt, message body, API key or response body. Attempt
 * metadata contains only the attempt id, protocol, scope, optional task id,
 * token counts and the output-bound kind.
 */

const DEFAULT_OUTPUT_CAP = 2048;
const OUTPUT_BOUND_ENFORCED = 'enforced';
const OUTPUT_BOUND_ESTIMATED = 'estimated';
const SCOPES = ['workspace', 'task'];
const CAP_FIELDS = {
  'chat-completions': ['max_tokens', 'max_completion_tokens'],
  responses: ['max_output_tokens'],
  messages: ['max_tokens']
};
const FOREIGN_CAP_FIELDS = {
  'chat-completions': ['max_output_tokens'],
  responses: ['max_tokens', 'max_completion_tokens'],
  messages: ['max_completion_tokens', 'max_output_tokens']
};

const invalid = message => durableError('INVALID_TOKEN_ACCOUNTING', message, 400);
const conflict = message => durableError('TOKEN_ACCOUNTING_CONFLICT', message, 409);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function wirePayload(payload, protocol) {
  if (!plainObject(payload)) throw invalid('payload must be a plain JSON wire object.');
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw invalid('payload must be JSON-encodable.');
  }
  if (typeof serialized !== 'string') throw invalid('payload must be JSON-encodable.');
  let clone;
  try {
    clone = JSON.parse(serialized);
  } catch {
    throw invalid('payload must be JSON-encodable.');
  }
  if (!plainObject(clone)) throw invalid('payload must be a JSON object.');
  if (typeof clone.model !== 'string' || clone.model.trim() === '') {
    throw invalid('payload.model must be a non-empty string.');
  }
  if (protocol === 'responses') {
    const input = clone.input;
    const usable = Array.isArray(input) ? input.length > 0 : typeof input === 'string' && input.length > 0;
    if (!usable) throw invalid('payload.input must be a non-empty array or string for responses.');
  } else if (!Array.isArray(clone.messages) || clone.messages.length === 0) {
    throw invalid(`payload.messages must be a non-empty array for ${protocol}.`);
  }
  return clone;
}

/** Largest legal explicit output cap already on the wire, or 0 when absent. */
function explicitOutputCap(protocol, payload) {
  let cap = 0;
  for (const field of CAP_FIELDS[protocol]) {
    if (!Object.hasOwn(payload, field)) continue;
    const value = payload[field];
    if (Number.isSafeInteger(value) && value > 0) cap = Math.max(cap, value);
  }
  return cap;
}

/**
 * Add or clamp the protocol's own output cap while a budget is configured.
 * Foreign known cap fields are rejected so the wire cannot carry a second,
 * larger cap that the reservation does not cover.
 */
function applyOutputCap(protocol, payload) {
  for (const field of FOREIGN_CAP_FIELDS[protocol]) {
    if (Object.hasOwn(payload, field)) {
      throw invalid(`${field} is not an output cap field for ${protocol} and is rejected while a token budget is enabled.`);
    }
  }
  let field = CAP_FIELDS[protocol][0];
  if (protocol === 'chat-completions') {
    const completion = Object.hasOwn(payload, 'max_completion_tokens');
    const classic = Object.hasOwn(payload, 'max_tokens');
    if (completion && classic) {
      throw invalid('payload must not set both max_tokens and max_completion_tokens.');
    }
    field = completion ? 'max_completion_tokens' : 'max_tokens';
  }
  const existing = payload[field];
  if (existing === undefined) {
    payload[field] = DEFAULT_OUTPUT_CAP;
    return DEFAULT_OUTPUT_CAP;
  }
  if (!Number.isSafeInteger(existing) || existing <= 0) {
    throw invalid(`${field} must be a positive safe integer when a token budget is enabled.`);
  }
  const effective = Math.min(DEFAULT_OUTPUT_CAP, existing);
  payload[field] = effective;
  return effective;
}

function estimateInput(payload) {
  const serialized = JSON.stringify(payload);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw invalid('payload must have a non-empty JSON UTF-8 encoding.');
  }
  return bytes;
}

const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function optionalToken(usage, field) {
  if (!Object.hasOwn(usage, field) || usage[field] === undefined) return 0;
  return tokenCount(usage[field]);
}

function optionalCached(usage, detailsField) {
  if (!Object.hasOwn(usage, detailsField) || usage[detailsField] === undefined) return 0;
  const details = usage[detailsField];
  // Some OpenAI-compatible servers send null for empty details. The top-level
  // input/output counts are still complete, so treat it like an absent object.
  if (details === null) return 0;
  if (!plainObject(details)) return null;
  if (!Object.hasOwn(details, 'cached_tokens') || details.cached_tokens === undefined) return 0;
  return tokenCount(details.cached_tokens);
}

function extractUsage(protocol, body) {
  if (!plainObject(body) || !Object.hasOwn(body, 'usage')) return null;
  const usage = body.usage;
  if (!plainObject(usage)) return null;
  if (protocol === 'messages') {
    if (!Object.hasOwn(usage, 'input_tokens') || !Object.hasOwn(usage, 'output_tokens')) return null;
    const input = tokenCount(usage.input_tokens);
    const output = tokenCount(usage.output_tokens);
    const cacheRead = optionalToken(usage, 'cache_read_input_tokens');
    const cacheWrite = optionalToken(usage, 'cache_creation_input_tokens');
    if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
    return { input, output, cacheRead, cacheWrite };
  }
  const inputField = protocol === 'responses' ? 'input_tokens' : 'prompt_tokens';
  const outputField = protocol === 'responses' ? 'output_tokens' : 'completion_tokens';
  const detailsField = protocol === 'responses' ? 'input_tokens_details' : 'prompt_tokens_details';
  if (!Object.hasOwn(usage, inputField) || !Object.hasOwn(usage, outputField)) return null;
  const rawInput = tokenCount(usage[inputField]);
  const output = tokenCount(usage[outputField]);
  const cacheRead = optionalCached(usage, detailsField);
  if (rawInput === null || output === null || cacheRead === null) return null;
  if (cacheRead > rawInput) return null;
  return { input: rawInput - cacheRead, output, cacheRead, cacheWrite: 0 };
}

function normalizeUsage(protocol, body) {
  try {
    return extractUsage(protocol, body);
  } catch {
    return null;
  }
}

const sameUsage = (left, right) => left != null && right != null
  && left.input === right.input
  && left.output === right.output
  && left.cacheRead === right.cacheRead
  && left.cacheWrite === right.cacheWrite;

const reservedSnapshot = row => ({
  input: row.reserved.input,
  output: row.reserved.output,
  total: row.reserved.total
});

export class TokenRequestAccounting {
  #budget;
  #attempts = new WeakMap();

  constructor(budget) {
    const required = ['reserve', 'markDispatched', 'settle', 'markUnknown', 'cancelBeforeDispatch', 'describe'];
    if (!budget || required.some(method => typeof budget[method] !== 'function')
      || typeof budget.database?.atomic !== 'function') {
      throw new TypeError('TokenRequestAccounting requires a TokenBudgetService.');
    }
    this.#budget = budget;
  }

  /**
   * Reserve one attempt and return a deep-frozen payload plus a bound attempt
   * token. `scope` is required: `'workspace'` for requests that do not belong
   * to a task, `'task'` with a trusted `taskId` for task work.
   *
   * The limit read, cap decision and reservation share the core database
   * transaction, so a limit enabled between them cannot be missed. The
   * prepare-time limit values are kept for the dispatch-time re-check. The
   * caller's payload object is never modified.
   */
  prepare({ protocol, payload, scope, taskId = null } = {}) {
    if (!isModelProtocol(protocol)) {
      throw invalid(`protocol must be one of ${MODEL_PROTOCOLS.join(', ')}.`);
    }
    if (!SCOPES.includes(scope)) throw invalid("scope must be 'workspace' or 'task'.");
    const task = taskId === undefined ? null : taskId;
    if (scope === 'workspace' && task !== null) {
      throw invalid('workspace scope does not accept a taskId.');
    }
    if (scope === 'task' && task === null) {
      throw invalid('task scope requires a trusted taskId from the caller context.');
    }
    const wire = wirePayload(payload, protocol);
    return this.#budget.database.atomic(() => {
      const view = this.#budget.describe({ taskId: task });
      const workspaceLimit = view.workspace.limit;
      const taskLimit = scope === 'task' ? view.task.limit : null;
      const limited = workspaceLimit != null || taskLimit != null;
      let outputTokens;
      let outputBound;
      if (limited) {
        outputTokens = applyOutputCap(protocol, wire);
        outputBound = OUTPUT_BOUND_ENFORCED;
      } else {
        const explicit = explicitOutputCap(protocol, wire);
        if (explicit > 0) {
          outputTokens = explicit;
          outputBound = OUTPUT_BOUND_ENFORCED;
        } else {
          outputTokens = DEFAULT_OUTPUT_CAP;
          outputBound = OUTPUT_BOUND_ESTIMATED;
        }
      }
      const inputTokens = estimateInput(wire);
      const attemptId = randomUUID();
      const reservation = this.#budget.reserve({ attemptId, taskId: task, inputTokens, outputTokens });
      const attempt = Object.freeze({
        attemptId,
        protocol,
        scope,
        taskId: task,
        inputTokens,
        outputTokens,
        outputBound
      });
      this.#attempts.set(attempt, {
        attemptId,
        protocol,
        scope,
        taskId: task,
        inputTokens,
        outputTokens,
        outputBound,
        workspaceLimit,
        taskLimit,
        createdAt: reservation.createdAt,
        state: 'prepared',
        usage: null,
        result: null,
        overflowError: null,
        overflowUsage: null
      });
      return {
        attempt,
        payload: deepFreeze(wire),
        reservation: deepFreeze(reservation)
      };
    });
  }

  /**
   * Issue the one network permit for this attempt. Inside one transaction the
   * prepare-time limit snapshot is re-checked and the ledger row is re-read
   * through the core's idempotent reserve replay; only the reservation this
   * attempt created, still in `reserved` state, may be dispatched. The core
   * marker is idempotent, but an adapter attempt is not: a second call is
   * rejected even if the ledger row is already dispatched.
   */
  markDispatched(attempt) {
    const record = this.#record(attempt);
    if (record.state !== 'prepared') {
      throw conflict(`Attempt "${record.attemptId}" is ${record.state} and cannot produce a new dispatch permit.`);
    }
    return this.#budget.database.atomic(() => {
      const view = this.#budget.describe({ taskId: record.taskId });
      const workspaceChanged = view.workspace.limit !== record.workspaceLimit;
      const taskChanged = record.scope === 'task' && view.task?.limit !== record.taskLimit;
      if (workspaceChanged || taskChanged) {
        throw conflict(`Token limits changed after attempt "${record.attemptId}" was prepared; cancel it with fail() and prepare a new attempt.`);
      }
      const current = this.#budget.reserve({
        attemptId: record.attemptId,
        taskId: record.taskId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens
      });
      if (current.createdAt !== record.createdAt) {
        throw conflict(`Attempt "${record.attemptId}" is not backed by the reservation created during prepare; prepare a new attempt.`);
      }
      if (current.state !== 'reserved') {
        throw conflict(`Attempt "${record.attemptId}" is ${current.state} in the ledger and cannot produce a new dispatch permit.`);
      }
      const row = this.#budget.markDispatched(record.attemptId);
      record.state = 'dispatched';
      record.result = deepFreeze({
        attemptId: record.attemptId,
        protocol: record.protocol,
        scope: record.scope,
        taskId: record.taskId,
        outputBound: record.outputBound,
        day: row.day,
        state: 'dispatched',
        reserved: reservedSnapshot(row),
        dispatchedAt: row.dispatchedAt
      });
      return record.result;
    });
  }

  /**
   * Settle a real response. Untrusted usage marks the whole hold unknown and
   * returns an `unknown` result; overflow marks it unknown and rethrows the
   * original core error. Repeating the identical outcome is idempotent.
   */
  settleResponse(attempt, { protocol, body } = {}) {
    const record = this.#record(attempt);
    if (!isModelProtocol(protocol)) {
      throw invalid(`protocol must be one of ${MODEL_PROTOCOLS.join(', ')}.`);
    }
    if (protocol !== record.protocol) {
      throw conflict(`Attempt "${record.attemptId}" was prepared for ${record.protocol}, not ${protocol}.`);
    }
    if (record.state === 'prepared') {
      throw conflict(`Attempt "${record.attemptId}" has not been dispatched and cannot accept a response.`);
    }
    if (record.state === 'cancelled') {
      throw conflict(`Attempt "${record.attemptId}" was cancelled before dispatch and cannot accept a response.`);
    }
    if (record.state === 'settled') {
      const usage = normalizeUsage(protocol, body);
      if (sameUsage(record.usage, usage)) return record.result;
      throw conflict(`Attempt "${record.attemptId}" was already settled with different usage.`);
    }
    if (record.state === 'unknown') {
      const usage = normalizeUsage(protocol, body);
      if (record.overflowError !== null) {
        if (sameUsage(record.overflowUsage, usage)) throw record.overflowError;
        throw conflict(`Attempt "${record.attemptId}" is unknown and cannot be settled with different usage.`);
      }
      if (usage === null) return record.result;
      throw conflict(`Attempt "${record.attemptId}" is unknown and cannot be settled.`);
    }

    const usage = normalizeUsage(protocol, body);
    if (usage === null) {
      const row = this.#budget.markUnknown(record.attemptId);
      record.state = 'unknown';
      record.result = deepFreeze({
        attemptId: record.attemptId,
        protocol: record.protocol,
        scope: record.scope,
        taskId: record.taskId,
        outputBound: record.outputBound,
        day: row.day,
        state: 'unknown',
        reserved: reservedSnapshot(row)
      });
      return record.result;
    }

    try {
      const row = this.#budget.settle(record.attemptId, usage);
      record.state = 'settled';
      record.usage = usage;
      record.result = deepFreeze({
        protocol: record.protocol,
        scope: record.scope,
        outputBound: record.outputBound,
        ...row
      });
      return record.result;
    } catch (error) {
      if (error?.code !== 'TOKEN_BUDGET_OVERFLOW') throw error;
      record.overflowError = error;
      record.overflowUsage = usage;
      try {
        const row = this.#budget.markUnknown(record.attemptId);
        record.state = 'unknown';
        record.result = deepFreeze({
          attemptId: record.attemptId,
          protocol: record.protocol,
          scope: record.scope,
          taskId: record.taskId,
          outputBound: record.outputBound,
          day: row.day,
          state: 'unknown',
          reserved: reservedSnapshot(row)
        });
      } catch (secondary) {
        error.markUnknownError = secondary?.code ?? 'UNKNOWN';
      }
      // Preserve the original overflow (and its detail) for observation.
      throw error;
    }
  }

  /**
   * Cancel an undispatched attempt; keep a dispatched attempt's entire hold by
   * marking it unknown. Settled attempts cannot be failed retroactively.
   */
  fail(attempt) {
    const record = this.#record(attempt);
    if (record.state === 'settled') {
      throw conflict(`Attempt "${record.attemptId}" is settled and cannot be marked failed.`);
    }
    if (record.state === 'cancelled' || record.state === 'unknown') return record.result;
    if (record.state === 'prepared') {
      try {
        const row = this.#budget.cancelBeforeDispatch(record.attemptId);
        record.state = 'cancelled';
        record.result = deepFreeze({
          attemptId: record.attemptId,
          protocol: record.protocol,
          scope: record.scope,
          taskId: record.taskId,
          outputBound: record.outputBound,
          day: row.day,
          state: 'cancelled',
          reserved: reservedSnapshot(row)
        });
        return record.result;
      } catch (error) {
        if (error?.code !== 'TOKEN_BUDGET_ALREADY_DISPATCHED') throw error;
      }
    }
    const row = this.#budget.markUnknown(record.attemptId);
    record.state = 'unknown';
    record.result = deepFreeze({
      attemptId: record.attemptId,
      protocol: record.protocol,
      scope: record.scope,
      taskId: record.taskId,
      outputBound: record.outputBound,
      day: row.day,
      state: 'unknown',
      reserved: reservedSnapshot(row)
    });
    return record.result;
  }

  #record(attempt) {
    if (attempt === null || typeof attempt !== 'object') {
      throw invalid('attempt must be the exact token returned by prepare.');
    }
    const record = this.#attempts.get(attempt);
    if (!record) {
      throw invalid('attempt must be the exact token returned by prepare for this adapter; clones and lookalikes are not accepted.');
    }
    return record;
  }
}
