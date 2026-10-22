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
      throw new PermissionDeniedError('Shadow mode is read-only. External writes are refused.');
    }
    if (!rule.requiresApproval) return { allowed: true, actionClass, reason: 'No approval required for this class.' };
    if (approval?.permission === 'user_approved') {
      if (taskId && approval.taskId && approval.taskId !== taskId) {
        throw new PermissionDeniedError('Approval was granted for a different task.');
      }
      return { allowed: true, actionClass, reason: 'Explicit user approval present.', approvedAt: approval.approvedAt || null };
    }
    // A previously authorised, clearly scoped, repeated process may run
    // without a fresh click. The scope must come from the user and must name what
    // it covers, so a bare permission flag can never satisfy this branch.
    if (approval?.permission === 'pre_authorized') {
      if (approval.source !== 'user_stated' || !approval.scope?.entity) {
        throw new PermissionDeniedError('A pre-authorisation must be stated by the user and scoped to a named target.');
      }
      return { allowed: true, actionClass, reason: 'Pre-authorised scope from the user.', preAuthorized: true, grantId: approval.grantId || null };
    }
    throw new PermissionDeniedError(`Action class "${actionClass}" requires explicit user approval before execution.`);
  }

  describe() {
    return ACTION_CLASSES.map(actionClass => ({ actionClass, ...this.ruleFor(actionClass) }));
  }
}

export const defaultPolicy = new PermissionPolicy();

export const permissionsApi = { ACTION_CLASSES, PermissionPolicy, PermissionDeniedError, defaultPolicy };
