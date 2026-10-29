import { createHash } from 'node:crypto';
import { grantFor, permissionAnswerFor, scopeCovers } from './calibration.js';
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
  authorize({ taskId, provider, tool, actionFamily, resourceId, key, payload, effect, conditionalVersion, patchAuthorization }) {
    const state = this.engine.store.state, task = state.tasks[taskId];
    if (!task || task.privacyInvalidated || task.control?.paused || ['completed', 'cancelled'].includes(task.status)) throw deny('The task is no longer active.');
    if (this.engine.durableRuntime?.tasks.hasPendingSemantic(taskId)) throw deny('A new source update must be interpreted before an external write.');
    let approval;
    if (['email.draft', 'notion.page.create', 'notes.note.create'].includes(actionFamily)) {
      if (!this.engine.durableRuntime?.artifacts) throw deny('Artifact writes need the durable workspace.');
      approval = this.engine.durableRuntime.artifacts.authorize({ taskId, provider, tool, actionFamily, resourceId, key, payload, effect });
    } else if (actionFamily === 'email.send') {
      const draft = task.draft, action = task.action;
      if (tool !== 'send' || provider !== this.mailProvider(task) || typeof provider.send !== 'function' || provider.canSend === false) throw deny('The selected mail provider is outside this task authorization.');
      if (!object(payload) || Object.keys(payload).some(key => !['idempotencyKey', 'to', 'subject', 'body', 'documentUrl', 'threadId'].includes(key)) || !draft || !action || action.idempotencyKey !== key || payload.idempotencyKey !== key
        || typeof payload.body !== 'string' || payload.body !== draft.body || payload.to !== draft.to || payload.subject !== draft.subject
        || payload.documentUrl !== draft.documentUrl || effect.to !== draft.to || effect.documentId !== task.documentId || effect.bodyDigest !== digest(draft.body)) throw deny('The tool parameters differ from the reviewed reply.');
      const threadId = state.inbox.find(message => message.id === task.sourceEmailId)?.threadId || null;
      if ((payload.threadId || null) !== threadId || resourceId !== (threadId || `${draft.to}:${draft.subject}`)) throw deny('The reply targets a different resource.');
      approval = action;
      if (action.permission === 'pre_authorized') {
        const currentGrant = grantFor(state.calibrations || {}, { entity: task.request?.subjectEntity, deliverable: task.request?.deliverable });
        if (permissionAnswerFor(state.calibrations || {}, { entity: task.request?.subjectEntity, deliverable: task.request?.deliverable }) || !currentGrant || currentGrant.id !== action.grantId || !scopeCovers(currentGrant.scope, { entity: task.request?.subjectEntity, deliverable: task.request?.deliverable })) throw deny('The standing authorization was revoked or changed.');
        approval = { ...action, source: currentGrant.source, scope: currentGrant.scope };
      }
    } else if (actionFamily === 'document.patch') {
      const patch = state.documentPatches?.[patchAuthorization?.patchId], document = patch && state.documents[patch.baseDocument.id];
      const expectedProvider = patch?.provider === 'local' ? this.engine.taskServices.localDocumentProvider : this.engine.documentProvider;
      if (tool !== 'apply_patch' || provider !== expectedProvider || !provider?.supports?.(document) || provider.validate && !provider.validate({ forWrite: true }).ok) throw deny('The document provider is no longer authorized.');
      if (!patch || patch.taskId !== taskId || patch.status !== 'applying' || patch.authorization?.kind !== 'explicit'
        || patchAuthorization.taskId !== taskId || patchAuthorization.baseDocumentVersion !== patch.baseDocument.version
        || document.version !== patch.baseDocument.version || effect.documentId !== document.id || effect.baseVersion !== patch.baseDocument.version
        || resourceId !== (document.externalId || document.id) || key !== `patch:${patch.id}:${patch.baseDocument.version}`
        || String(conditionalVersion) !== String(patch.baseDocument.revisionId || patch.baseDocument.version)
        || JSON.stringify(payload) !== JSON.stringify(patch.changes) || effect.changesDigest !== digest(JSON.stringify(patch.changes))
        || effect.expectedContentDigest !== digest(applyTextChanges(document.content, patch.changes).replace(/\r\n?/g, '\n'))) throw deny('The tool parameters differ from the reviewed document patch.');
      approval = { permission: 'user_approved', taskId };
    } else throw deny('This tool has no authorized write adapter.');
    const activation = this.engine.durableRuntime?.activationFor(task);
    if (approval.permission !== 'user_approved' && activation && (!activation.activate || activation.requiresReview)) throw deny('A current user policy requires individual review.');
    return this.engine.policy.authorize({ actionClass: 'execute_external', approval, taskId });
  }
}

/** A provider's word "found" is not sufficient. Reject malformed/mismatched
 * receipts before they can complete a task or release a resource claim. */
export function validReceipt(receipt, { key = null, receiptId = null } = {}) {
  return object(receipt) && typeof receipt.id === 'string' && Boolean(receipt.id.trim())
    && (!receiptId || receipt.id === receiptId)
    && (receipt.idempotencyKey == null || receipt.idempotencyKey === key);
}
