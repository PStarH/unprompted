/**
 * Follow-through decision and autonomy ceiling.
 *
 * One deterministic function, used by WorkEngine and by the clause tests.
 * Gates run in order: Evidence, then Authority, then Risk. A model proposal
 * can never raise the ceiling. The recorded level is the cap that turn obeyed.
 */

import { normalizeAddress } from './commitments.js';

export const CEILING_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];
export const FOLLOW_THROUGH_DECISIONS = ['continue', 'wait', 'ask', 'close', 'blocked'];

const RANK = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

function lower(state, level, gate, reason) {
  if (RANK[level] < RANK[state.level]) {
    state.level = level;
    state.gate = gate;
    state.reason = reason;
  }
}

/**
 * Highest action this turn may take.
 *
 * `proposedLevel` is recorded only so a model suggestion cannot raise the
 * result. Missing required evidence stays below L3/L4. A promised nudge or
 * other reversible draft may still be prepared at L2.
 */
export function autonomyCeiling(input = {}) {
  const state = {
    level: 'L4',
    gate: 'risk',
    reason: 'Evidence, authority, and risk allow a consequential action.'
  };
  const missing = input.evidenceComplete !== true || input.evidenceMissing === true;
  const withdrawn = input.sourceWithdrawn === true;
  const contradictory = input.contradictory === true;
  const prepare = input.promisedNudge === true || input.nextStep === 'prepare' || input.reversibleDraft === true;
  const consequential = input.consequential === true || input.nextStep === 'consequential';
  const executing = consequential || input.nextStep === 'execute';
  const approved = input.approval === true && input.paused !== true;
  const reviewBlocksAuto = input.requiresReview === true && !approved;
  const grantDead = input.forgedGrant === true || input.grantExpired === true || input.grantRevoked === true;
  const grantOk = input.validGrant === true && !grantDead && !reviewBlocksAuto && input.paused !== true;

  if (withdrawn) {
    lower(state, 'L0', 'evidence', 'A required source or document is unavailable, so the agent only records the block.');
  } else if (contradictory) {
    lower(state, 'L1', 'evidence', 'Evidence is contradictory, so the agent must not invent a result or close the work.');
  } else if (missing) {
    lower(state, prepare ? 'L2' : input.nextStep === 'observe' ? 'L0' : 'L1', 'evidence',
      prepare
        ? 'Required evidence is still missing. A draft or promised nudge may be prepared. Execution and send stay closed.'
        : 'Required evidence is missing. Investigation is allowed. Execution and send stay closed.');
  }

  if (input.paused === true) {
    lower(state, 'L0', 'authority', 'The task is paused, so automatic execution stops.');
  } else if (executing && reviewBlocksAuto) {
    lower(state, 'L2', 'authority', 'An explicit review requirement beats automatic execution, even when a grant exists.');
  } else if (executing && grantDead) {
    lower(state, 'L2', 'authority', input.forgedGrant
      ? 'A forged or planner-created grant is not authority.'
      : 'The grant ended, so automatic execution stops.');
  } else if (executing && !approved && !grantOk) {
    lower(state, 'L2', 'authority', 'No user approval and no valid grant. This action requires explicit user approval before execution. A draft may exist. Nothing is sent.');
  } else if (consequential && (approved || grantOk) && !missing && !withdrawn && !contradictory) {
    state.gate = 'risk';
    state.reason = approved
      ? 'Evidence is complete and the user approved this consequential action.'
      : 'A lock-allowed narrow grant covers this consequential action.';
  } else if (!executing) {
    const level = input.nextStep === 'observe' ? 'L0' : prepare ? 'L2' : 'L1';
    lower(state, level, missing || withdrawn || contradictory ? state.gate : 'risk',
      prepare && missing
        ? 'Required evidence is still missing. A draft or promised nudge may be prepared. Execution and send stay closed.'
        : 'This turn does not include a consequential action.');
  } else if (input.nextStep === 'execute' && !consequential && (approved || grantOk) && !missing && !withdrawn && !contradictory) {
    lower(state, 'L3', 'authority', 'An in-scope authorized operation may execute. A consequential external effect still needs its own approval.');
  }

  if (input.reversibleDraft === true && !consequential) {
    lower(state, 'L2', 'risk', 'A reversible internal draft is preparation, not a consequential action.');
  }

  if (input.proposedLevel && RANK[input.proposedLevel] > RANK[state.level]) {
    state.reason = `${state.reason} A model proposal of ${input.proposedLevel} does not raise the ceiling.`;
  }
  return { level: state.level, reason: state.reason, gate: state.gate };
}

export function ceilingAllows(ceiling, required) {
  const level = typeof ceiling === 'string' ? ceiling : ceiling?.level;
  return RANK[level] >= RANK[required];
}

/** Write the one follow-through field the clause tests read. */
export function recordFollowThrough(task, { decision, reason, ceiling, at, closeKind = null }) {
  if (!task || !FOLLOW_THROUGH_DECISIONS.includes(decision)) return null;
  const entry = {
    decision,
    reason,
    ceiling: ceiling.level,
    ceilingReason: ceiling.reason,
    gate: ceiling.gate,
    at
  };
  if (closeKind) entry.closeKind = closeKind;
  task.followThrough = entry;
  task.lastEvaluatedAt = at;
  return entry;
}

/** Conservative explicit completion. Vague progress and guesses do not match. */
export function explicitUserCompletion(text) {
  const body = String(text || '');
  if (/\b(i['’]?m on it|working on it|let me check|not sure|maybe i|might have)\b/i.test(body)) return false;
  return /\b(i already replied(?: to the vendor)?|i already sent|i have already (?:replied|sent|finished)|i['’]ve already (?:replied|sent|finished)|i sent the|this is done|i finished the|marked (?:it|this) complete)\b/i.test(body);
}

export function userAddress(task) {
  return normalizeAddress(task?.request?.source?.to || '');
}

/** A ledgered agent send reappearing as mail is self-echo, not new work and not user-finished. */
export function ledgeredSendEcho(message, state) {
  const id = message?.id == null ? '' : String(message.id);
  const body = String(message?.body || '').trim();
  if (!id && !body) return false;
  for (const task of Object.values(state?.tasks || {})) {
    const sends = [task?.action, ...(task?.actionHistory || [])].filter(Boolean);
    for (const send of sends) {
      if (send.receiptId && (send.receiptId === id || id.endsWith(String(send.receiptId)))) return true;
    }
    const sent = sends.some(send => ['verified_live', 'verified_simulated', 'accepted_live'].includes(send.status));
    if (sent && body && task.draft?.body && body === String(task.draft.body).trim()) return true;
  }
  for (const receipt of state?.outbox || []) {
    if (receipt?.id && id && receipt.id === id) return true;
    if (body && receipt?.body && String(receipt.body).trim() === body) return true;
  }
  return false;
}

/**
 * One open task in this thread, authored by the user, with an explicit
 * completion and no new request. Ambiguous or multi-task threads do not close.
 */
export function userFinishedTask(message, state, { requestFound = false } = {}) {
  if (requestFound || ledgeredSendEcho(message, state)) return null;
  if (!explicitUserCompletion(`${message?.subject || ''}\n${message?.body || ''}`)) return null;
  const threadId = String(message?.threadId || '');
  const from = normalizeAddress(message?.from || '');
  if (!threadId || !from) return null;
  const matches = Object.values(state?.tasks || {}).filter(task => {
    if (!task || task.status === 'completed' || task.status === 'cancelled' || task.userDismissed || task.control?.paused) return false;
    if (['executing', 'accepted_live', 'uncertain', 'unknown'].includes(task.action?.status)) return false;
    const thread = task.commitment?.threadId || task.request?.source?.threadId;
    return thread === threadId && from === userAddress(task);
  });
  return matches.length === 1 ? matches[0] : null;
}

export function applyUserFinished(task, { at, reason, ceiling = null }) {
  task.status = 'completed';
  task.completion = { kind: 'user_finished', at };
  task.reason = reason;
  task.updatedAt = at;
  if (task.draft && !task.draft.userEdited) task.draft = null;
  recordFollowThrough(task, {
    decision: 'close',
    closeKind: 'user_finished',
    reason,
    ceiling: ceiling || autonomyCeiling({ evidenceComplete: false, evidenceMissing: true, nextStep: 'observe', approval: true }),
    at
  });
}
