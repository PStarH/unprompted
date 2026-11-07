import { createHash } from 'node:crypto';
import { issueCredential } from './authority-credential.js';
import { grantFor, scopeCovers } from './calibration.js';
import { applyTextChanges } from './document-delivery.js';

const deny = message => Object.assign(new Error(message), { code: 'AUTHORIZATION_REQUIRED', status: 403 });
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Trusted execution boundary. No jobs, timers or database ownership here.
 * Call before preparing an intent and again at the adapter's actual dispatch.
 * Approval comes from current local state, never a planner/tool response. */
export class ToolSafetyGateway {
  constructor(engine, { readTimeoutMs = 20000 } = {}) { this.engine = engine; this.readTimeoutMs = readTimeoutMs; }
  authorizeRead() { return this.engine.policy.authorize({ actionClass: 'observe' }); }
  read(invoke) {
    this.authorizeRead();
    const controller = new AbortController();
    const result = invoke(controller.signal);
    if (!result?.then) return result;
    let timer;
    return Promise.race([result, new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('Provider read timed out; the outcome remains unknown.'), { code: 'TOOL_READ_TIMEOUT', status: 504 })); }, this.readTimeoutMs);
    })]).finally(() => clearTimeout(timer));
  }
  mailProvider(task) {
    return typeof this.engine.provider.forSource === 'function'
      ? this.engine.provider.forSource(task.sourceConnectorId || task.request?.source?.connectorId || 'google') : this.engine.provider;
  }
  authorize(spec) { return this.decide(spec); }
  /**
   * The only allow path for execute_external. Tool arguments named permission,
   * grantId, or approved are ignored. The returned credential is sealed.
   */
  decide({ taskId, provider, tool, actionFamily, resourceId, key, payload, effect, conditionalVersion, patchAuthorization, phase = 'intent', origin = null, grantId = null } = {}) {
    if (this.engine.policy.shadow) this.engine.policy.authorize({ actionClass: 'execute_external', taskId });
    const state = this.engine.store.state, task = state.tasks[taskId];
    if (!task || task.privacyInvalidated || task.control?.paused || ['completed', 'cancelled'].includes(task.status)) throw deny('The task is no longer active.');
    if (this.engine.durableRuntime?.tasks.hasPendingSemantic(taskId)) throw deny('A new source update must be interpreted before an external write.');
    const credential = this.#credential({ state, task, taskId, provider, tool, actionFamily, resourceId, key, payload, effect, conditionalVersion, patchAuthorization, phase, origin, grantId });
    if (credential.kind !== 'approval' && task.contextReadRequired) throw deny('Read or review the deferred task context before an automatic action.');
    const activation = this.engine.durableRuntime?.activationFor(task);
    if (credential.kind !== 'approval' && activation && (!activation.activate || activation.requiresReview)) throw Object.assign(deny('A current user policy requires individual review.'), { code: 'REVIEW_REQUIRED' });
    return this.engine.policy.authorize({ actionClass: 'execute_external', approval: credential, taskId });
  }
  #credential({ state, task, taskId, provider, tool, actionFamily, resourceId, key, payload, effect, conditionalVersion, patchAuthorization, phase, origin, grantId }) {
    if (actionFamily === 'artifact.undo') {
      if (origin !== 'approval') throw deny('Only the user can undo an artifact.');
      return issueCredential({ kind: 'approval', id: key, version: 1, taskId, effectDigest: effect?.requestId || null });
    }
    if (['email.draft', 'notion.page.create', 'notes.note.create', 'reminders.reminder.create'].includes(actionFamily)) {
      if (!this.engine.durableRuntime?.artifacts) throw deny('Artifact writes need the durable workspace.');
      return this.engine.durableRuntime.artifacts.credential({ taskId, provider, tool, actionFamily, resourceId, key, payload, effect });
    }
    if (actionFamily === 'email.send') return this.#mailCredential({ state, task, taskId, provider, tool, resourceId, key, payload, effect, phase, origin, grantId });
    if (actionFamily === 'document.patch') return this.#patchCredential({ state, task, taskId, provider, tool, resourceId, key, payload, effect, conditionalVersion, patchAuthorization });
    if (['connector.request', 'mcp.tool'].includes(actionFamily)) {
      if (!this.engine.durableRuntime?.connectorActions) throw deny('Platform writes require the durable workspace.');
      return this.engine.durableRuntime.connectorActions.credential({ taskId, provider, tool, actionFamily, resourceId, key, payload, effect });
    }
    throw deny('This tool has no authorized write adapter.');
  }
  #mailCredential({ state, task, taskId, provider, tool, resourceId, key, payload, effect, phase, origin, grantId }) {
    const draft = task.draft, action = task.action;
    if (tool !== 'send' || provider !== this.mailProvider(task) || typeof provider.send !== 'function' || provider.canSend === false) throw deny('The selected mail provider is outside this task authorization.');
    const bodyDigest = digest(draft?.body || '');
    if (!object(payload) || Object.keys(payload).some(name => !['idempotencyKey', 'to', 'subject', 'body', 'documentUrl', 'threadId'].includes(name)) || !draft
      || payload.idempotencyKey !== key || typeof payload.body !== 'string' || payload.body !== draft.body || payload.to !== draft.to || payload.subject !== draft.subject
      || payload.documentUrl !== draft.documentUrl || effect?.to !== draft.to || effect?.documentId !== task.documentId || effect?.bodyDigest !== bodyDigest) throw deny('The tool parameters differ from the reviewed reply.');
    const threadId = state.inbox.find(message => message.id === task.sourceEmailId)?.threadId || null;
    if ((payload.threadId || null) !== threadId || resourceId !== (threadId || `${draft.to}:${draft.subject}`)) throw deny('The reply targets a different resource.');
    if (phase !== 'issue' && (!action || action.idempotencyKey !== key)) throw deny('The tool parameters differ from the reviewed reply.');
    if (action?.taskId && action.taskId !== taskId) throw Object.assign(deny('Approval was granted for a different task.'), { code: 'EFFECT_MISMATCH' });
    const stored = action?.authority;
    const requested = origin || stored?.kind || null;
    if (requested === 'yolo' || grantId || stored?.kind === 'yolo') {
      const id = grantId || stored?.id;
      const lease = this.engine.autonomy?.grants().find(item => item.id === id);
      if (!this.engine.autonomy?.valid(lease, taskId)) throw Object.assign(deny('YOLO expired or was revoked before the action was sent.'), { code: 'GRANT_INACTIVE' });
      if (stored && (stored.kind !== 'yolo' || stored.id !== lease.id || Number(stored.version) !== (Number(lease.version) || 1))) throw Object.assign(deny('YOLO expired or was revoked before the action was sent.'), { code: 'GRANT_INACTIVE' });
      return issueCredential({ kind: 'yolo', id: lease.id, version: Number(lease.version) || 1, taskId, effectDigest: bodyDigest });
    }
    if (requested === 'approval' || stored?.kind === 'approval' || phase === 'issue' && origin === 'approval') {
      const version = Number(stored?.version) || 1;
      const id = stored?.id || key;
      if (stored?.spent) throw Object.assign(deny('This approval was already used.'), { code: 'AUTHORIZATION_REQUIRED' });
      return issueCredential({ kind: 'approval', id, version, taskId, effectDigest: bodyDigest });
    }
    const standing = grantFor(state.calibrations || {}, { entity: task.request?.subjectEntity, deliverable: task.request?.deliverable });
    if (!standing || !scopeCovers(standing.scope, { entity: task.request?.subjectEntity, deliverable: task.request?.deliverable })) throw Object.assign(deny('Action class "execute_external" requires explicit user approval before execution.'), { code: 'AUTHORIZATION_REQUIRED' });
    if (stored && (stored.kind !== 'standing' || stored.id !== standing.id)) throw deny('The standing authorization was revoked or changed.');
    return issueCredential({ kind: 'standing', id: standing.id, version: Number(standing.version) || 1, taskId, effectDigest: bodyDigest });
  }
  #patchCredential({ state, taskId, provider, tool, resourceId, key, payload, effect, conditionalVersion, patchAuthorization }) {
    const patch = state.documentPatches?.[patchAuthorization?.patchId], document = patch && state.documents[patch.baseDocument.id];
    const expectedProvider = patch?.provider === 'local' ? this.engine.taskServices.localDocumentProvider : this.engine.documentProvider;
    if (tool !== 'apply_patch' || provider !== expectedProvider || !provider?.supports?.(document) || provider.validate && !provider.validate({ forWrite: true }).ok) throw deny('The document provider is no longer authorized.');
    if (!patch || patch.taskId !== taskId || patch.status !== 'applying' || !['explicit', 'temporary_yolo'].includes(patch.authorization?.kind)
      || patchAuthorization.taskId !== taskId || patchAuthorization.baseDocumentVersion !== patch.baseDocument.version
      || document.version !== patch.baseDocument.version || effect.documentId !== document.id || effect.baseVersion !== patch.baseDocument.version
      || resourceId !== (document.externalId || document.id) || key !== `patch:${patch.id}:${patch.baseDocument.version}`
      || String(conditionalVersion) !== String(patch.baseDocument.revisionId || patch.baseDocument.version)
      || JSON.stringify(payload) !== JSON.stringify(patch.changes) || effect.changesDigest !== digest(JSON.stringify(patch.changes))
      || effect.expectedContentDigest !== digest(applyTextChanges(document.content, patch.changes).replace(/\r\n?/g, '\n'))) throw deny('The tool parameters differ from the reviewed document patch.');
    if (patch.authorization.kind === 'temporary_yolo') {
      const lease = this.engine.autonomy?.grants().find(item => item.id === patch.authorization.grantId);
      if (!this.engine.autonomy?.valid(lease, taskId)) throw Object.assign(deny('YOLO expired or was revoked before the action was sent.'), { code: 'GRANT_INACTIVE' });
      return issueCredential({ kind: 'yolo', id: lease.id, version: Number(lease.version) || 1, taskId, effectDigest: effect.expectedContentDigest });
    }
    return issueCredential({ kind: 'approval', id: key, version: 1, taskId, effectDigest: effect.expectedContentDigest });
  }
}

/** A provider's word "found" is not sufficient. Reject malformed/mismatched
 * receipts before they can complete a task or release a resource claim. */
export function validReceipt(receipt, { key = null, receiptId = null } = {}) {
  return object(receipt) && typeof receipt.id === 'string' && Boolean(receipt.id.trim())
    && (!receiptId || receipt.id === receiptId)
    && (receipt.idempotencyKey == null || receipt.idempotencyKey === key);
}
