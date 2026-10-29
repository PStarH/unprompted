import { randomUUID } from 'node:crypto';
import { ArtifactProvider, ARTIFACT_ACTIONS, artifactObservationText } from '../artifact-providers.js';
import { digest, explicitTasks } from '../connectors/local-snapshot.js';
import { durableError, iso, json, parse } from './database.js';
import { effectDigest } from './experience.js';
import { draftReviewToken } from '../draft-review.js';

const fail = (message, code = 'ARTIFACT_NOT_AUTHORIZED', status = 403) => durableError(code, message, status);
const activeTask = task => task && !task.privacyInvalidated && !task.control?.paused && !task.yieldState
  && !['completed', 'cancelled'].includes(task.status) && !task.pendingCommitmentChange
  && !['withdrawn', 'withdrawn_pending_reconciliation'].includes(task.commitment?.status);
const knownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !value.includes('\0');
const publicRequest = request => ({ id: request.id, grantId: request.grantId, connectorId: request.connectorId, family: request.family,
  status: request.status, inputVersion: request.inputVersion, receipt: request.receipt || null, createdAt: request.createdAt, error: request.error || null });

export class ArtifactActions {
  constructor(runtime, { connectionFor = () => null } = {}) {
    this.runtime = runtime;
    this.engine = runtime.engine;
    this.database = runtime.database;
    this.connectionFor = connectionFor;
  }
  grants() { return parse(this.database.get('artifact_grants', '[]')) || []; }
  provider(grant) {
    const connection = this.connectionFor(grant.connectorId);
    if (!connection || connection.accountId !== grant.accountId || this.runtime.privacy.permissionRevoked(grant.connectorId)) return null;
    const provider = new ArtifactProvider(connection, grant.targetId);
    return provider.available() ? provider : null;
  }
  targets() {
    return Object.entries(ARTIFACT_ACTIONS).flatMap(([connectorId, spec]) => {
      const connection = this.connectionFor(connectorId);
      if (!connection?.connector?.live || !connection.accountId || this.runtime.privacy.permissionRevoked(connectorId)) return [];
      const targets = connectorId === 'apple_notes' ? connection.connector.folders.map(folder => ({ id: folder.folderId, label: folder.label }))
        : connectorId === 'notion' ? Object.values(this.engine.store.state.documents).filter(document => document.source === 'notion' && document.available !== false).map(document => ({ id: document.externalId, label: document.title }))
          : [{ id: 'drafts', label: spec.label }];
      return [{ connectorId, family: spec.family, label: spec.label, accountLabel: connection.accountLabel || connectorId,
        targets: targets.filter(target => target.id).slice(0, 100), available: connectorId === 'notion' || targets.some(target => new ArtifactProvider(connection, target.id).available()) }];
    });
  }
  describe() { return { available: true, enabled: !this.engine.policy.shadow, targets: this.targets(), grants: this.grants().map(grant => ({ ...grant, available: Boolean(this.provider(grant)) })) }; }
  async createGrant(input, { actor = 'user', confirmed = false } = {}) {
    if (actor !== 'user' || confirmed !== true) throw fail('Only a confirmed user choice can authorize artifact creation.');
    if (!knownKeys(input, ['connectorId', 'targetId', 'taskId', 'project', 'automatic', 'confirmed']) || !ARTIFACT_ACTIONS[input.connectorId]
      || !text(input.targetId, 4096) || input.taskId != null && !text(input.taskId, 500) || input.project != null && !text(input.project, 200)
      || input.automatic != null && typeof input.automatic !== 'boolean') throw fail('Choose a supported action and exact target.', 'INVALID_ARTIFACT_GRANT', 400);
    const connection = this.connectionFor(input.connectorId);
    if (!connection?.accountId || this.runtime.privacy.permissionRevoked(input.connectorId)) throw fail('Connect the target account first.');
    const targetId = input.connectorId === 'notion' ? input.targetId.replace(/-/g, '').toLowerCase() : input.targetId;
    const grant = { id: randomUUID(), version: 1, status: 'active', connectorId: input.connectorId, family: ARTIFACT_ACTIONS[input.connectorId].family,
      accountId: connection.accountId, targetId, taskId: input.taskId || null, project: input.project || null, automatic: input.automatic !== false,
      createdBy: 'user', confirmedAt: iso(this.database.now()) };
    const provider = this.provider(grant);
    if (!provider) throw fail('The connected account lacks this action permission. Reauthorize with the requested scope.');
    await provider.validateTarget();
    if (this.runtime.closed || this.connectionFor(input.connectorId)?.connector !== connection.connector || !this.provider(grant)) throw fail('The target connection changed during authorization.');
    return this.database.atomic(() => {
      const grants = this.grants();
      const existing = grants.find(item => item.status === 'active' && item.connectorId === grant.connectorId && item.accountId === grant.accountId
        && item.targetId === grant.targetId && item.taskId === grant.taskId && item.project === grant.project && item.automatic === grant.automatic);
      if (existing) return existing;
      if (grants.length >= 100) throw fail('At most 100 artifact authorizations can be retained.', 'ARTIFACT_GRANT_LIMIT', 400);
      this.database.set('artifact_grants', json([...grants, grant]));
      this.database.bump('context_version');
      return grant;
    });
  }
  revoke(id) {
    return this.database.atomic(() => {
      const grants = this.grants(), grant = grants.find(item => item.id === id);
      if (!grant) throw fail('Artifact authorization not found.', 'MISSING_ARTIFACT_GRANT', 404);
      if (grant.status === 'active') { grant.status = 'revoked'; grant.version++; this.database.set('artifact_grants', json(grants)); this.database.bump('context_version'); }
      return grant;
    });
  }
  covers(grant, task) {
    if (grant.status !== 'active' || grant.createdBy !== 'user' || !grant.confirmedAt || grant.taskId && grant.taskId !== task.id
      || grant.project && grant.project !== task.request?.subjectEntity) return false;
    return grant.family !== 'email.draft' || (task.sourceConnectorId || task.request?.source?.connectorId || 'google') === grant.connectorId;
  }
  check(task, grant, { explicit = false } = {}) {
    if (!activeTask(task) || this.engine.policy.shadow || this.runtime.closed || this.runtime.suspended || !this.covers(grant, task)
      || this.runtime.tasks.hasPendingSemantic(task.id) || task.inputVersion !== task.processedInputVersion || !this.provider(grant)) throw fail('Artifact access or the current task context is unavailable.');
    const activation = this.runtime.activationFor(task);
    if (!activation.activate || !explicit && (activation.requiresReview || task.guidanceReviewRequired || !grant.automatic)) throw fail('This task requires individual review before creating an artifact.');
  }
  request(taskId, input, { actor = 'harness', isCurrent = () => false, reviewToken = null } = {}) {
    if (!knownKeys(input, ['grantId', 'title', 'body']) || !text(input.grantId, 80)) throw fail('Invalid artifact request.', 'INVALID_ARTIFACT', 400);
    const task = this.runtime.tasks.get(taskId), grant = this.grants().find(item => item.id === input.grantId);
    if (!task) throw fail('Task not found.', 'MISSING_TASK', 404);
    if (!grant) throw fail('Choose an active user authorization.');
    const explicit = actor === 'user';
    if (!explicit && (actor !== 'activation' && (this.runtime.current()?.taskId !== taskId || !isCurrent()))) throw fail('A current task harness is required.');
    if (explicit && draftReviewToken(task) !== reviewToken) throw fail('Refresh this task before creating an artifact.', 'REVIEW_CHANGED', 409);
    this.check(task, grant, { explicit });
    let payload;
    if (grant.family === 'email.draft') {
      if (!task.draft || task.draft.userEdited || task.userDraftStale || task.action || task.status !== 'ready_for_approval') throw fail('A current prepared reply is required.');
      const message = this.engine.store.state.inbox.find(item => item.id === task.sourceEmailId);
      payload = { title: task.draft.subject, body: task.draft.body, to: task.draft.to,
        ...(grant.connectorId === 'google' ? { threadId: message?.threadId || null, replyToMessageId: message?.providerMessageId || null } : {}) };
      if (input.title != null || input.body != null) throw fail('Mail drafts use the current task reply.', 'INVALID_ARTIFACT', 400);
    } else payload = { title: input.title, body: input.body };
    if (!text(payload.title, 500) || /[\r\n]/.test(payload.title) || !text(payload.body, 64000)) throw fail('Supply a title and 1–64,000 characters of content.', 'INVALID_ARTIFACT', 400);
    const prior = (task.artifactRequests || []).find(item => item.grantId === grant.id && item.inputVersion === task.inputVersion);
    if (prior && !(explicit && prior.status === 'blocked' && !['dispatched', 'accepted', 'unknown', 'verified'].includes(this.runtime.ledger.byKey(prior.key)?.status))) return publicRequest(prior);
    if ((task.artifactRequests || []).length >= 50) throw fail('This task reached its artifact limit.', 'ARTIFACT_LIMIT', 400);
    const id = randomUUID(), key = `artifact:${id}`;
    const request = { id, key, grantId: grant.id, grantVersion: grant.version, accountId: grant.accountId, targetId: grant.targetId,
      connectorId: grant.connectorId, family: grant.family, inputVersion: task.inputVersion, privacyEpoch: task.privacyEpoch,
      contextVersion: Number(this.database.get('context_version')), payload: { ...payload, idempotencyKey: key },
      ...(grant.family === 'email.draft' ? { draftToken: draftReviewToken(task) } : {}),
      explicit, status: 'queued', createdAt: iso(this.database.now()) };
    this.engine.store.mutate(state => {
      state.tasks[taskId].artifactRequests = [...(state.tasks[taskId].artifactRequests || []), request];
      this.runtime.jobs.enqueue({ queue: 'effects', type: 'artifact_publish', taskId, key, payload: { taskId, requestId: id } });
    });
    this.runtime.kick(); this.engine.changed();
    return publicRequest(request);
  }
  effect(request) { return { type: 'artifact_create', requestId: request.id, grantId: request.grantId, accountId: request.accountId,
    targetId: request.targetId, contentDigest: effectDigest(request.payload) }; }
  authorize({ taskId, provider, tool, actionFamily, resourceId, key, payload, effect }) {
    const task = this.runtime.tasks.get(taskId), request = task?.artifactRequests?.find(item => item.key === key);
    const grant = request && this.grants().find(item => item.id === request.grantId);
    if (!request || !grant || grant.version !== request.grantVersion || request.status !== 'executing' || request.inputVersion !== task.inputVersion
      || request.privacyEpoch !== task.privacyEpoch || request.contextVersion !== Number(this.database.get('context_version'))
      || request.family !== actionFamily || tool !== 'create_artifact' || resourceId !== `${grant.accountId}:${grant.targetId}`
      || effectDigest(payload) !== effectDigest(request.payload) || effectDigest(effect) !== effectDigest(this.effect(request))
      || this.provider(grant)?.connector !== provider.connector || provider.targetId !== grant.targetId
      || grant.family === 'email.draft' && (request.draftToken !== draftReviewToken(task) || task.action || task.draft?.userEdited)) throw fail('The artifact differs from the authorized task or target.');
    this.check(task, grant, { explicit: request.explicit });
    return request.explicit ? { permission: 'user_approved', taskId }
      : { permission: 'pre_authorized', source: 'user_stated', scope: { entity: grant.targetId }, grantId: grant.id };
  }
  record(taskId, requestId, fields) {
    this.engine.store.mutateIfChanged(state => {
      const task = state.tasks[taskId], request = task?.artifactRequests?.find(item => item.id === requestId);
      if (request && !task.privacyInvalidated) Object.assign(request, fields);
    });
    this.engine.changed();
  }
  isSelfEcho(event) {
    if (!['apple_notes', 'notion'].includes(event.connectorId) || !['document.modified', 'task.observed'].includes(event.type)) return false;
    const executions = this.database.db.prepare("SELECT task_id,idempotency_key,provider_receipt_id FROM tool_executions WHERE provider=? AND is_write=1 AND status IN ('accepted','verified') AND provider_receipt_id IS NOT NULL ORDER BY created_at DESC LIMIT 500")
      .all(ARTIFACT_ACTIONS[event.connectorId].kind);
    return executions.some(execution => {
      const request = this.runtime.tasks.get(execution.task_id)?.artifactRequests?.find(item => item.key === execution.idempotency_key);
      if (!request?.payload) return false;
      const documentId = event.connectorId === 'apple_notes' ? `apple_notes:${request.accountId}:${digest(execution.provider_receipt_id)}`
        : `notion:${execution.provider_receipt_id.replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}`;
      const content = artifactObservationText(event.connectorId, request.payload);
      if (event.type === 'document.modified') return event.payload.id === documentId && event.payload.title === request.payload.title.trim()
        && String(event.payload.content).replace(/\r\n?/g, '\n').trim() === content.trim();
      return event.connectorId === 'apple_notes' && event.payload.documentId === documentId && event.payload.state === 'open'
        && explicitTasks(content).some(task => event.payload.id === `${documentId}:todo:${task.key}` && event.payload.title === task.title);
    });
  }
  async publish(job) {
    this.runtime.jobs.assert(job);
    const task = this.runtime.tasks.get(job.payload.taskId), request = task?.artifactRequests?.find(item => item.id === job.payload.requestId);
    if (!request || request.status === 'verified') return;
    const existing = this.runtime.ledger.byKey(request.key);
    if (existing?.status === 'verified') { this.record(task.id, request.id, { status: 'verified', receipt: parse(existing.result_json) }); return; }
    try {
      const grant = this.grants().find(item => item.id === request.grantId), provider = grant && this.provider(grant);
      if (!grant || !provider) throw fail('The artifact target is disconnected or no longer authorized.');
      this.record(task.id, request.id, { status: 'executing', error: null });
      const effect = this.effect(request), resourceId = `${grant.accountId}:${grant.targetId}`;
      const receipt = await this.runtime.external({ ...task, action: request.explicit ? { permission: 'user_approved', inputVersion: request.inputVersion } : null }, { provider, tool: 'create_artifact', actionFamily: request.family,
        resourceId, key: request.key, payload: request.payload, effect, deferDispatch: true,
        send: (signal, beforeDispatch) => provider.create(request.payload, { signal, beforeDispatch }),
        verify: accepted => provider.lookup(request.key, { receiptId: accepted.id, payload: request.payload }) });
      this.record(task.id, request.id, { status: 'verified', receipt: { ...receipt, status: 'verified' } });
    } catch (error) {
      const execution = this.runtime.ledger.byKey(request.key);
      const uncertain = execution && ['dispatched', 'accepted', 'unknown'].includes(execution.status);
      this.record(task.id, request.id, { status: uncertain ? 'unknown' : 'blocked', error: uncertain
        ? 'The provider outcome needs reconciliation. No automatic repeat was attempted.' : 'Authorization or task context changed. Review the task before trying again.' });
      if (uncertain) this.runtime.jobs.enqueue({ queue: 'effects', type: 'reconcile_execution', taskId: task.id, key: `artifact-reconcile:${execution.id}`, payload: { executionId: execution.id } });
    }
  }
  recoveryProvider(execution) {
    const task = this.runtime.tasks.get(execution.task_id), request = task?.artifactRequests?.find(item => item.key === execution.idempotency_key);
    const grant = request && this.grants().find(item => item.id === request.grantId), provider = grant && this.provider(grant);
    if (!provider || execution.privacy_redacted || provider.kind !== execution.provider) return null;
    return { lookup: (key, options) => provider.lookup(key, { ...options, payload: request.payload }) };
  }
  schedulePrepared(task) {
    if (task.status !== 'ready_for_approval' || !task.draft || task.draft.userEdited || task.action) return;
    for (const grant of this.grants().filter(item => item.family === 'email.draft' && item.automatic && this.covers(item, task))) {
      try { this.request(task.id, { grantId: grant.id }, { actor: 'activation' }); } catch { }
    }
  }
  tools({ taskId, isCurrent = () => false } = {}) {
    if (this.engine.policy.shadow) return [];
    const task = taskId && this.runtime.tasks.get(taskId);
    const grants = this.grants().filter(grant => grant.status === 'active' && grant.automatic && this.provider(grant) && (!task || this.covers(grant, task))).slice(0, 12);
    if (!grants.length) return [];
    return [{ name: 'create_work_artifact', label: 'Create an authorized work artifact',
      description: `Queue a work artifact in a user-authorized destination. This does not send mail or complete the task. Mail uses the current prepared reply; omit title/body for mail. Available destinations: ${json(grants.map(grant => ({ grantId: grant.id, connector: grant.connectorId, target: grant.targetId })))}`,
      parameters: { type: 'object', properties: { grantId: { type: 'string', enum: grants.map(grant => grant.id) }, title: { type: 'string', maxLength: 500 }, body: { type: 'string', maxLength: 64000 } }, required: ['grantId'], additionalProperties: false },
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        const result = this.request(taskId, input, { isCurrent });
        return { content: [{ type: 'text', text: json(result) }], details: {} };
      } }];
  }
}
