/**
 * Action permission policy.
 *
 * The system may investigate, correlate, assess and prepare without asking.
 * Anything consequential outside the local store needs approval. This is
 * enforced in the execution layer, not the interface, so a direct API call
 * cannot bypass it.
 *
 * Action classes:
 *   observe            - reading authorised content, storing state locally
 *   prepare            - drafting an outbound artefact, no external effect
 *   execute_external   - anything a third party can observe
 */

import { isAuthorityCredential } from './authority-credential.js';

export const ACTION_CLASSES = ['observe', 'prepare', 'execute_external'];

const DEFAULT_POLICY = {
  observe: { requiresApproval: false, reversible: true },
  prepare: { requiresApproval: false, reversible: true },
  execute_external: { requiresApproval: true, reversible: false }
};

export class PermissionDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export class PermissionPolicy {
  constructor(overrides = {}) {
    const shadow = overrides.shadow === true;
    const rules = { ...overrides };
    delete rules.shadow;
    this.shadow = shadow;
    this.rules = { ...DEFAULT_POLICY, ...rules };
  }

  ruleFor(actionClass) {
    const rule = this.rules[actionClass];
    if (!rule) throw new PermissionDeniedError(`Unknown action class: ${actionClass}`);
    return rule;
  }

  requiresApproval(actionClass) {
    return Boolean(this.ruleFor(actionClass).requiresApproval);
  }

  /**
   * Decide whether an action may execute. Approval is checked here rather than
   * trusted from the caller, so no route can self-authorise.
   */
  authorize({ actionClass, approval = null, taskId = null }) {
    const rule = this.ruleFor(actionClass);
    // Shadow mode is read-only at the policy boundary. Approval and
    // pre-authorisation cannot promote an external write.
    if (this.shadow && actionClass === 'execute_external') {
      throw Object.assign(new PermissionDeniedError('Shadow mode is read-only. External writes are refused.'), { code: 'SHADOW_READ_ONLY', status: 403, definitiveNoEffect: true });
    }
    if (!rule.requiresApproval) return { allowed: true, actionClass, reason: 'No approval required for this class.' };
    const credential = isAuthorityCredential(approval) ? approval : null;
    if (!credential) {
      const forged = approval?.permission;
      const message = forged === 'temporary_yolo'
        ? 'A permission string is not a YOLO authorization. The stored lease was not accepted.'
        : `Action class "${actionClass}" requires explicit user approval before execution.`;
      throw Object.assign(new PermissionDeniedError(message), { code: 'AUTHORIZATION_REQUIRED', status: 403, definitiveNoEffect: true });
    }
    if (taskId && credential.taskId && credential.taskId !== taskId) {
      throw Object.assign(new PermissionDeniedError('Approval was granted for a different task.'), { code: 'EFFECT_MISMATCH', status: 403, definitiveNoEffect: true });
    }
    return { allowed: true, actionClass, reason: 'Stored authorization credential.', credential };
  }

  describe() {
    return ACTION_CLASSES.map(actionClass => ({ actionClass, ...this.ruleFor(actionClass) }));
  }
}

export const defaultPolicy = new PermissionPolicy();

/** A failed disconnect or scope removal stays read-only. A failed widening grant restores the prior flag. */
export function shadowAfterFailedSourceRefresh({ widening, previousShadow }) {
  return widening ? previousShadow === true : true;
}

/**
 * After the grant response's bounded wait, do not start a tool investigation
 * while a draft is still dispatching. One extra wait is enough; then skip.
 */
export function grantInvestigationDecision({ draftExecuting, round, maxRounds = 1 } = {}) {
  if (draftExecuting && round < maxRounds) return 'defer';
  if (draftExecuting) return 'skip';
  return 'investigate';
}

export const permissionsApi = { ACTION_CLASSES, PermissionPolicy, PermissionDeniedError, defaultPolicy, shadowAfterFailedSourceRefresh, grantInvestigationDecision };
