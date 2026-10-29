import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { DurableWorker, classifyFailure } from './jobs.js';
import { FeatureRegistry, ActivationPolicies, WorkingContextIndex } from './context.js';
import { ExperienceService, arbitrateExperiences, effectDigest } from './experience.js';
import { ToolExecutionLedger } from './execution.js';
import { ForgetService } from './privacy.js';
import { validateEventPayload } from '../connectors/events.js';
import { draftReviewToken } from '../draft-review.js';
import { OfflineReplay } from './replay.js';
import { normalizeAddress, isTrustedThreadSender } from '../commitments.js';
import { unquotedMessageFields } from '../commitments.js';
import { isAutomatedSender } from '../requests.js';
import { PAIR_EVALUATOR_VERSION, UNATTACHED_WINDOW_MS, validatePairAssessment } from './pair-evidence.js';
import { validateStateDelta, confirmsCancellation } from './state-delta.js';
import { applyTextChanges } from '../document-delivery.js';
import { activationFlags, setActivationFlags } from './flags.js';
import { StandingIntents } from './standing-intents.js';
import { entityKeys, recallCandidates, scopesCompatible } from './candidates.js';
import { Coordination, readinessBlock } from './coordination.js';
import { BoundedRsi } from './rsi.js';
import { activationMetrics } from './activation-metrics.js';
import { structuredPrincipalRole } from '../connectors/principal-role.js';
import { ArtifactActions } from './artifact-actions.js';
import { taskSourceTools } from '../task-tools.js';

const familyOf = event => event.payload?.taskFamily || (event.type === 'issue.updated' ? 'assigned_issue' : event.type === 'pull_request.updated' ? 'pull_request_review' : event.type === 'content.changed' ? 'repository_change' : event.type === 'workflow.updated' ? 'workflow_run' : event.type === 'task.observed' ? 'local_todo' : event.payload?.deliverable || 'work_request');
const scopeOf = task => [
  { type: 'task_family', key: task.request?.deliverable || task.kind || 'work_request' },
  { type: 'project', key: task.request?.subjectEntity || '*' },
  { type: 'project', key: json([task.request?.subjectEntity?.toLowerCase(), task.request?.deliverable?.toLowerCase()]) },
  ...(task.documentId ? [{ type: 'resource', key: task.documentId }] : [])
];
const safeReceipt = receipt => receipt && ({ id: receipt.id || receipt.receiptId || null, provider: receipt.provider || null, status: receipt.status || null });

/** Runtime wiring for the shipped single-user application. Legacy deterministic
 * evidence checking remains an executor; durable jobs own model work, writes
 * pass through the ledger, and the policy boundary remains independent. */
export class DurableRuntime {
  constructor(engine, { generateExperience = null, tickMs = 1000, unattachedWindowMs = UNATTACHED_WINDOW_MS, maxPairCandidates = 3, connectorFor = () => null, artifactConnectionFor = () => null } = {}) {
    if (typeof connectorFor !== 'function') throw durableError('INVALID_CONNECTOR_RESOLVER', 'A connector resolver must be a function.', 400);
    if (!Number.isFinite(unattachedWindowMs) || unattachedWindowMs < 60000 || unattachedWindowMs > 90 * 86400000
      || !Number.isInteger(maxPairCandidates) || maxPairCandidates < 1 || maxPairCandidates > 10) throw durableError('INVALID_PAIR_POLICY', 'Pair matching needs bounded window and candidate limits.', 400);
    this.engine = engine; this.store = engine.store; this.database = this.store.database; this.db = this.database.db;
    this.unattachedWindowMs = unattachedWindowMs; this.maxPairCandidates = maxPairCandidates;
    const applied = parse(this.database.get('rsi_applied', 'null'));
    if (Number.isFinite(applied?.pairWindowMs) && applied.pairWindowMs >= 3600000 && applied.pairWindowMs <= 14 * 86400000) this.unattachedWindowMs = applied.pairWindowMs;
    if (Number.isInteger(applied?.maxPairCandidates) && applied.maxPairCandidates >= 1 && applied.maxPairCandidates <= 10) this.maxPairCandidates = applied.maxPairCandidates;
    this.connectorFor = connectorFor;
    this.jobs = this.store.jobs; this.tasks = this.store.tasks; this.memory = this.store.memory;
    this.registry = new FeatureRegistry(); this.policies = new ActivationPolicies(this.database, this.registry);
    this.context = new WorkingContextIndex(this.database); this.experiences = new ExperienceService(this.database, { jobs: this.jobs, registry: this.registry });
    this.replay = new OfflineReplay(this.database, this.memory);
    this.intents = new StandingIntents(this.database);
    this.coordination = new Coordination(this.database);
    this.rsi = new BoundedRsi(this.database);
    this.gateway = engine.toolGateway;
    this.ledger = new ToolExecutionLedger(this.database, { tasks: this.tasks, jobs: this.jobs, experiences: this.experiences });
    this.artifacts = new ArtifactActions(this, { connectionFor: artifactConnectionFor });
    this.owner = `runtime:${process.pid}:${randomUUID()}`; this.scope = new AsyncLocalStorage(); this.closed = false; this.pending = null;
    this.generateExperience = generateExperience;
    this.privacy = new ForgetService(this.database, { jobs: this.jobs, memory: this.memory, store: this.store,
      onInvalidate: () => { this.memory.invalidate(); engine.changed(); this.kick(); } });
    this.worker = new DurableWorker({ jobs: this.jobs, id: this.owner, handlers: {
      task_initial: job => this.runTask(job), task_continue: job => this.runTask(job),
      discovery: job => this.runDiscovery(job), experience_trial: job => this.runTrial(job), situation_timer: job => this.runSituationTimer(job), situation_pair: job => this.runSituationPair(job), situation_delta: job => this.runSituationDelta(job), standing_intent_match: job => this.runStandingIntent(job)
    }, recovery: job => this.recover(job) });
    this.inboxWorker = new DurableWorker({ jobs: this.jobs, queue: 'inbox', id: `${this.owner}:inbox`, handlers: {
      ingest_event: job => {
        const row = this.db.prepare('SELECT event_json FROM durable_inbox WHERE id=?').get(job.payload.eventId);
        if (row) this.ingest(parse(row.event_json), event => this.engine.ingestLegacy(event), { claimedJob: job });
      }
    }, recovery: job => this.recover(job) });
    this.learningWorker = new DurableWorker({ jobs: this.jobs, queue: 'learning', id: `${this.owner}:learning`, handlers: {
      compile_experience: (job, guard) => this.experiences.compile(job, summary => this.compile(summary, job), guard)
    }, recovery: job => this.recover(job) });
    this.effectsWorker = new DurableWorker({ jobs: this.jobs, queue: 'effects', id: `${this.owner}:reconcile`, handlers: {
      artifact_publish: job => this.artifacts.publish(job),
      external_dispatch: job => this.recoverPreparedDispatch(job),
      privacy_reconcile: (job, guard) => this.reconcileExecution(job.payload.executionId, guard),
      reconcile_execution: (job, guard) => this.reconcileExecution(job.payload.executionId, guard)
    }, recovery: job => this.recover(job) });
    this.privacyWorker = new DurableWorker({ jobs: this.jobs, queue: 'privacy', id: `${this.owner}:privacy`, handlers: {
      finish_forget: async job => { const result = await this.privacy.finish(job.payload.requestId); if (result?.state === 'pending') throw Object.assign(new Error('Deletion still has unresolved retention.'), { status: 503 }); }
    }, recovery: job => this.recover(job) });
    engine.durableRuntime = this;
    this.timer = setInterval(() => this.kick(), tickMs); this.timer.unref?.();
  }
  current() { return this.scope.getStore(); }
  tools(scope = {}) { return [...taskSourceTools(this, scope), ...this.artifacts.tools(scope)]; }
  inWorker() { return Boolean(this.current()); }
  canRun(taskId) {
    const scope = this.current();
    if (!scope || scope.taskId !== taskId || !scope.run || !this.jobs.owns(scope.job)) return false;
    try { this.tasks.preResume(scope.run, scope.job); return true; } catch { return false; }
  }
  capture(taskId) {
    const task = this.tasks.get(taskId);
    return task && { inputVersion: task.inputVersion, runGeneration: task.runGeneration, privacyEpoch: task.privacyEpoch,
      contextVersion: Number(this.database.get('context_version')), jobId: this.current()?.job?.id || null, leaseToken: this.current()?.job?.lease_token || null };
  }
  isCurrent(taskId, fence, { allowDirty = false } = {}) {
    const task = this.tasks.get(taskId);
    if (!task || !fence || task.privacyInvalidated || task.control?.paused || ['cancelled', 'completed'].includes(task.status)
      || task.privacyEpoch !== fence.privacyEpoch || task.runGeneration !== fence.runGeneration || !allowDirty && task.inputVersion !== fence.inputVersion
      || Number(this.database.get('context_version')) !== fence.contextVersion) return false;
    if (fence.jobId) { const job = this.jobs.get(fence.jobId); if (!job || job.lease_token !== fence.leaseToken || !this.jobs.owns(job)) return false; }
    return true;
  }
  scheduleTask(taskId, reason = 'context') {
    const task = this.tasks.get(taskId);
    if (!task || task.privacyInvalidated || task.control?.paused || task.yieldState === 'YIELDED_TO_USER' && !String(reason).startsWith('user_resume:') || ['cancelled', 'completed'].includes(task.status)) return false;
    const job = this.jobs.enqueue({ type: 'task_continue', taskId, key: `continue:${taskId}:${task.inputVersion}:g${task.runGeneration}:m${this.database.get('model_version', '0')}:${effectDigest(reason)}:a${task.reasoningWork?.attempts || 0}`,
      payload: { taskId, inputVersion: task.inputVersion } });
    this.kick(); return job;
  }
  scheduleDiscovery(eventId) {
    if (this.privacy.forgotten('event', eventId)) return false;
    const event = this.store.state.events.find(event => event.id === eventId);
    const job = this.jobs.enqueue({ type: 'discovery', key: `discover:${eventId}:m${this.database.get('model_version', '0')}:a${event?.reasoning?.attempts || 0}`, payload: { eventId, privacyEpoch: Number(this.database.get('privacy_epoch')) } });
    this.database.atomic(() => this.database.lineage('event', eventId, 'job', job.id)); this.kick(); return job;
  }
  canDiscover(eventId) { const scope = this.current(); return Boolean(scope?.eventId === eventId && this.jobs.owns(scope.job) && !this.privacy.forgotten('event', eventId) && scope.privacyEpoch === Number(this.database.get('privacy_epoch'))); }
  ingest(input, legacyIngest, { claimedJob = null } = {}) {
    const event = { ...input, id: input.id || `${input.connectorId || 'local'}:${input.providerEventId}`, source: input.source || 'simulated', connectorId: input.connectorId || 'simulated', at: input.at || iso(this.database.now()) };
    validateEventPayload(event);
    const account = event.payload?.accountEmail || (typeof event.payload?.to === 'string' ? event.payload.to : null);
    if (account && (event.payload?.assignedAccount || event.payload?.mentionedAccounts || event.payload?.groupMemberIds)) {
      const structured = structuredPrincipalRole({ account, to: Array.isArray(event.payload.to) ? event.payload.to : [account], cc: Array.isArray(event.payload.cc) ? event.payload.cc : [],
        assignedAccount: event.payload.assignedAccount || null, mentionedAccounts: event.payload.mentionedAccounts || null, groupMemberIds: event.payload.groupMemberIds || null });
      if (['provider_assignment', 'provider_mention', 'shared_group_membership'].includes(structured.roleEvidence?.basis)) event.meta = { ...(event.meta || {}), ...structured };
    }
    if (event.connectorId && this.privacy.permissionRevoked(event.connectorId)) return { id: event.id, duplicate: true, disposition: 'permission_revoked' };
    const selfEcho = this.artifacts.isSelfEcho(event) || event.source === 'google' && event.connectorId === 'google' && event.type === 'email.received' && typeof event.payload.id === 'string'
      && this.db.prepare("SELECT 1 FROM tool_executions WHERE provider='gmail' AND action_family='email.send' AND is_write=1 AND provider_receipt_id=? AND status IN ('accepted','verified') LIMIT 1").get(event.payload.id);
    if (selfEcho) {
      event.meta = { ...event.meta, originClass: 'AGENT_SELF', originEvidence: { basis: 'provider_receipt_id' } };
    }
    const nativeTaskId = event.type === 'issue.updated' ? `issue:${event.payload.id}` : event.type === 'pull_request.updated' ? `review:${event.payload.id}` : event.type === 'content.changed' ? `change:${event.payload.id}` : event.type === 'workflow.updated' ? `check:${event.payload.id}` : event.type === 'task.observed' ? `observed:${event.payload.id}` : null;
    if (nativeTaskId && this.privacy.forgotten('task', nativeTaskId)) return { id: event.id, duplicate: true, disposition: 'forgotten' };
    if (this.privacy.forgotten('event', event.id) || this.privacy.forgotten('provider_event', `${event.connectorId}:${event.providerEventId || event.id}`)) return { id: event.id, duplicate: true, disposition: 'forgotten' };
    const prior = this.db.prepare('SELECT id FROM durable_inbox WHERE provider=? AND provider_event_id=?').get(event.connectorId, event.providerEventId || event.id);
    if (prior) event.id = prior.id;
    let inboxJob;
    this.database.atomic(() => {
      const at = iso(this.database.now());
      this.db.prepare('INSERT OR IGNORE INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)').run(event.id, event.connectorId, event.providerEventId || event.id, json(event), effectDigest([event.type, event.payload]), at);
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'event\',?,?)').run(event.id, at);
      inboxJob = this.jobs.enqueue({ queue: 'inbox', type: 'ingest_event', key: `event:${event.id}`, payload: { eventId: event.id } });
      this.database.lineage('event', event.id, 'job', inboxJob.id);
    });
    if (inboxJob.state === 'completed') return { duplicate: true, id: event.id };
    const alreadyProcessed = this.store.state.events.find(row => row.id === event.id);
    const job = claimedJob || this.jobs.claim(this.owner, { queue: 'inbox', id: inboxJob.id });
    if (!job) return { id: event.id, queued: true, duplicate: true };
    try {
      if (alreadyProcessed) {
        this.database.atomic(() => {
          this.jobs.assert(job);
          if (alreadyProcessed.disposition === 'context_only') this.scheduleUnattachedPairs(event.id);
          this.scheduleStandingIntents(alreadyProcessed);
          this.jobs.complete(job);
        });
        this.kick(); return { duplicate: true, id: event.id, disposition: alreadyProcessed.disposition };
      }
      if (selfEcho) {
        this.store.mutate(state => { state.events.push({ ...event, relations: [], disposition: 'self_echo', summary: 'Provider confirmed an earlier agent mutation.' }); });
        this.database.atomic(() => this.jobs.complete(job));
        return { id: event.id, duplicate: false, disposition: 'self_echo', relations: [] };
      }
      if (event.type === 'timer.due') {
        const result = legacyIngest(event);
        this.database.atomic(() => this.jobs.complete(job));
        this.kick(); return result;
      }
      const structuralTargets = this.situationTargets(event);
      const automated = event.type === 'email.received' && (event.meta?.originClass === 'AUTOMATION' || isAutomatedSender(event.payload.from));
      let targets = automated ? [] : structuralTargets;
      if (!automated && !targets.length && this.flags().lexicalRecall) {
        const recalled = this.situationRecall(event);
        if (recalled.length === 1) {
          const row = this.db.prepare(`SELECT s.id,s.kind,(SELECT COUNT(*) FROM tasks t WHERE t.situation_id=s.id AND t.status NOT IN ('completed','cancelled')) activeTasks FROM situations s WHERE s.id=?`).get(recalled[0].id);
          if (row) targets = [row];
        } else if (recalled.length > 1) {
          const affected = recalled.flatMap(item => this.db.prepare("SELECT id FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(item.id).map(task => task.id));
          this.recordSituationObservation(event, 'ambiguous_situation', null, affected, affected.length > 0, false);
          this.database.atomic(() => this.jobs.complete(job));
          return { id: event.id, duplicate: false, disposition: 'context_only', relations: [] };
        }
      }
      if (automated && structuralTargets.length === 1) this.tasks.situations.linkEvent(structuralTargets[0].id, event.id, 'structural');
      const semanticAvailable = this.engine.reasoner?.available?.() && typeof this.engine.reasoner.extractSituationDelta === 'function';
      const localScope = targets.length === 1 && targets[0].activeTasks > 1 ? this.locallyScopedTaskIds(targets[0].id, event) : [];
      const scopedMulti = this.flags().scopedCancellation && semanticAvailable && localScope.length === 1;
      if (targets.length && (semanticAvailable || this.engine.reasoner?.preferModelInterpretation === true || targets.some(target => target.kind === 'related_observations'))) {
        if (targets.length !== 1 || !semanticAvailable || targets[0].activeTasks > 1 && !scopedMulti) {
          const affected = targets.flatMap(target => this.db.prepare("SELECT id FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(target.id).map(task => task.id));
          this.recordSituationObservation(event, targets.length !== 1 || targets[0].activeTasks > 1 ? 'ambiguous_situation' : 'state_delta_unavailable', null, affected, affected.length > 0, false);
          this.database.atomic(() => this.jobs.complete(job));
          return { id: event.id, duplicate: false, disposition: 'context_only', relations: [] };
        }
        let heldTasks = [];
        this.database.atomic(() => {
          heldTasks = this.tasks.holdForSemantic(targets[0].id, event.id);
          const pending = this.jobs.enqueue({ type: 'situation_delta', key: `situation-delta:${event.id}:${targets[0].id}`,
            payload: { eventId: event.id, situationId: targets[0].id, privacyEpoch: Number(this.database.get('privacy_epoch')) } });
          this.database.lineage('event', event.id, 'job', pending.id);
          this.database.lineage('situation', targets[0].id, 'job', pending.id);
          this.jobs.complete(job);
        });
        if (heldTasks.length) this.store.mutateIfChanged(state => {
          for (const taskId of heldTasks) {
            const task = state.tasks[taskId];
            if (task?.status === 'ready_for_approval' && !task.action) { task.status = 'investigating'; task.reason = 'A new source update is being interpreted.'; }
            for (const notice of state.notifications || []) if (notice.taskId === taskId && !notice.resolvedAt) notice.resolvedAt = iso(this.database.now());
          }
        });
        this.kick(); return { id: event.id, duplicate: false, queued: true, disposition: 'state_delta_pending', relations: [] };
      }
      const anchors = [], payload = event.payload;
      if (payload.threadId) anchors.push({ kind: 'thread', provider: event.connectorId, id: payload.threadId });
      if (payload.projectId) anchors.push({ kind: 'project', id: payload.projectId });
      if (payload.resourceId || event.type.startsWith('document.')) anchors.push({ kind: 'resource', provider: event.connectorId, id: payload.resourceId || payload.id });
      if (payload.taskId) anchors.push({ kind: 'task', id: payload.taskId });
      const family = familyOf(event), version = Number(this.database.get('context_version'));
      const features = this.registry.capture({ 'event.provider': event.connectorId, 'event.family': family, 'event.actionable': true,
        ...(payload.from ? { 'sender.identity': normalizeAddress(payload.from) } : {}), ...(payload.projectId ? { 'project.id': payload.projectId } : {}) }, { now: this.database.now(), contextVersion: version });
      const activation = this.policies.evaluate(features, [{ type: 'task_family', key: family }, ...(payload.projectId ? [{ type: 'project', key: payload.projectId }] : [])], version);
      const association = this.context.associate({ eventId: event.id, provider: event.connectorId, family, anchors,
        entities: payload.projectId ? [`project:${payload.projectId}`] : [], dimensions: [payload.projectId && `project:${payload.projectId}`, payload.resourceId && `resource:${payload.resourceId}`].filter(Boolean), deadlineAt: payload.deadlineAt || null });
      this.jobs.assert(job);
      let result;
      const invalidatesSource = event.type === 'document.unavailable'
        || event.type === 'issue.updated' && (!event.payload.assigned || event.payload.state !== 'open')
        || ['pull_request.updated', 'content.changed', 'workflow.updated'].includes(event.type) && (event.payload.active === false || event.payload.state !== 'open')
        || event.type === 'task.observed' && event.payload.state !== 'open';
      if (!activation.activate && event.type !== 'email.received' && !invalidatesSource) {
        this.store.mutate(state => { state.events.push({ ...event, relations: [], disposition: 'suppressed_by_user_policy', summary: 'Activation suppressed by an explicit user policy.' }); });
        result = { id: event.id, duplicate: false, disposition: 'suppressed_by_user_policy', relations: [] };
      } else result = legacyIngest({ ...event, activation, suppressForwardActivation: !activation.activate });
      if (result.taskId && !result.relations) result = { ...result, relations: [result.taskId] };
      this.database.atomic(() => {
        this.jobs.assert(job);
        for (const candidateId of association.candidateIds) {
          const row = this.db.prepare('SELECT task_ids_json FROM working_candidates WHERE id=?').get(candidateId);
          this.db.prepare('UPDATE working_candidates SET task_ids_json=? WHERE id=?').run(json([...new Set([...parse(row.task_ids_json), ...(result.relations || [])])]), candidateId);
        }
        if (result.disposition === 'context_only') this.scheduleUnattachedPairs(event.id);
        this.scheduleStandingIntents(this.store.state.events.find(item => item.id === event.id) || event);
        this.jobs.complete(job);
      });
      this.kick(); return result;
    } catch (error) { if (this.jobs.owns(job)) this.jobs.fail(job, error); throw error; }
  }
  taskFeatures(task, version = Number(this.database.get('context_version'))) {
    const source = this.store.state.events.find(event => event.payload?.id === (task.sourceEmailId || task.request?.source?.id) && event.type !== 'document.modified');
    const githubFamily = { external_issue: 'assigned_issue', external_review: 'pull_request_review', external_change: 'repository_change', external_check: 'workflow_run' };
    return this.registry.capture({ 'event.family': source ? familyOf(source) : githubFamily[task.kind] || (task.kind === 'observed_task' ? 'local_todo' : 'work_request'), 'event.actionable': !task.privacyInvalidated && !['completed', 'cancelled'].includes(task.status), 'task.family': task.request?.deliverable || task.kind || 'work_request', 'task.priority': Number(task.management?.priority?.score) || 0,
      'event.provider': task.sourceConnectorId || task.request?.source?.connectorId || 'google',
      ...(task.sender || task.request?.source?.from ? { 'sender.identity': normalizeAddress(task.sender || task.request.source.from) } : {}),
      'task.requires_review': Boolean(task.guidanceReviewRequired), 'task.has_deadline': Boolean(task.request?.deadline?.iso),
      ...(task.request?.subjectEntity ? { 'project.id': task.request.subjectEntity } : {}), ...(task.documentId ? { 'resource.id': task.documentId } : {}) }, { now: this.database.now(), contextVersion: version });
  }
  activationFor(task) { const version = Number(this.database.get('context_version')); return this.policies.evaluate(this.taskFeatures(task, version), scopeOf(task), version); }
  buildContext(task, run) {
    this.experiences.refreshStaleness();
    const version = Number(this.database.get('context_version'));
    const features = this.taskFeatures(task, version);
    const scopes = scopeOf(task), memories = this.memory.search(`${task.subject || ''} ${task.request?.text || ''}`, { scopes, limit: 8, expectedContextVersion: version });
    const experiences = this.experiences.retrieve({ scopes, features, contextVersion: version });
    const activation = this.policies.evaluate(features, scopes, version);
    const arbitration = arbitrateExperiences({ policies: activation.policyIds.map(id => { const policy = this.policies.get(id); return { ...policy, directiveKey: policy.effect.directiveKey || null }; }), experiences });
    const events = this.db.prepare(`SELECT e.id,e.event_json FROM durable_inbox e JOIN task_events a ON a.event_id=e.id
      WHERE a.task_id=? ORDER BY EXISTS(SELECT 1 FROM task_signals s WHERE s.task_id=a.task_id AND s.source_event_id=e.id AND s.status='PENDING' AND s.signal_type='EVIDENCE_CHANGED') DESC, a.associated_at DESC LIMIT 12`).all(task.id);
    const sources = [...events.map(event => ({ kind: 'event', id: event.id })), ...memories.map(memory => ({ kind: 'memory', id: memory.id })), ...[...activation.policyIds, ...activation.unresolvedPolicyIds].map(id => ({ kind: 'policy', id }))];
    this.database.atomic(() => {
      for (const source of sources) this.database.lineage(source.kind, source.id, 'task_run', run.id);
      for (const experience of experiences) this.database.lineage('experience', experience.id, 'task_run', run.id);
    });
    return { version, features, memories, experiences, arbitration, events: events.map(event => parse(event.event_json)), sources, activation };
  }
  async runTask(job) {
    const task = this.tasks.get(job.task_id || job.payload.taskId);
    if (!task || task.privacyInvalidated || task.control?.paused || ['completed', 'cancelled'].includes(task.status)) return;
    if (task.yieldState === 'YIELDED_TO_USER') {
      // The user's draft stays authoritative. Advance the input cursor so an
      // explicit rebase is not treated as an in-flight interpretation.
      if (task.dirty || task.inputVersion !== task.processedInputVersion) {
        this.database.atomic(() => {
          const row = this.tasks.row(task.id);
          const current = row && parse(row.data_json);
          if (!row || current.yieldState !== 'YIELDED_TO_USER') return;
          this.db.prepare('UPDATE tasks SET processed_input_version=input_version,dirty=0,version=version+1,updated_at=? WHERE id=? AND version=? AND (dirty=1 OR input_version<>processed_input_version)')
            .run(iso(this.database.now()), task.id, row.version);
        });
        this.store.refresh();
      }
      return;
    }
    if (task.action && ['executing', 'accepted_live', 'uncertain'].includes(task.action.status)) {
      await this.scope.run({ taskId: task.id, job }, () => this.engine.reconcile(task.id)); return;
    }
    if (this.tasks.hasPendingSemantic(task.id)) return;
    const run = this.tasks.beginRun(job);
    await this.scope.run({ taskId: task.id, job, run }, async () => {
      for (let segment = 0; segment < 3; segment++) {
        this.jobs.assert(job);
        if (this.tasks.hasPendingSemantic(task.id)) { this.tasks.finish(run, job, 'waiting'); return; }
        const current = this.tasks.assertRun(run, { job, allowDirty: true });
        const context = this.buildContext(current, run); this.current().context = context;
        this.store.mutateIfChanged(state => { state.tasks[current.id].activation = context.activation; });
        if (!context.activation.activate) {
          this.store.mutateIfChanged(state => { state.tasks[current.id].activationHold = { policyIds: context.activation.policyIds }; });
          this.tasks.finish(run, job, 'waiting'); this.engine.changed(); return;
        }
        this.tasks.checkpoint(run, job, { expectedInputVersion: current.inputVersion, contextVersion: context.version,
          sources: context.sources, plan: { state: 'revalidate_then_plan', sourceIds: context.sources, experienceIds: context.experiences.map(experience => experience.id) } });
        this.store.refresh();
        this.experiences.step({ taskRunId: run.id, logicalStepId: `context:${run.input_version}`, planVersion: segment + 1, stepKind: 'context_revalidation', expectedEffect: { contextVersion: context.version },
          experiences: context.experiences.map(experience => ({ id: experience.id, relation: 'predicate_matched' })) });
        const pending = this.store.state.tasks[task.id]?.reasoningWork;
        if (pending && ['pending', 'running', 'failed'].includes(pending.status) && pending.inputVersion === current.inputVersion) this.engine.retryPendingReasoning(task.id);
        else this.engine.recheckTaskGuidance(task.id);
        await this.engine.whenSettled();
        if (this.tasks.hasPendingSemantic(task.id)) { this.tasks.finish(run, job, 'waiting'); return; }
        const latest = this.tasks.get(task.id);
        if (!latest || latest.privacyInvalidated || latest.runGeneration !== run.run_generation || latest.privacyEpoch !== run.privacy_epoch) return;
        if (latest.inputVersion === run.input_version && Number(this.database.get('context_version')) === context.version) {
          this.tracePlan(latest, run, context);
          this.tasks.acknowledgeEvidence(run, job);
          if (this.db.prepare("SELECT 1 FROM task_signals WHERE task_id=? AND signal_type='EVIDENCE_CHANGED' AND status='PENDING' LIMIT 1").get(task.id)) continue;
          this.artifacts.schedulePrepared(this.tasks.get(task.id));
          this.tasks.finish(run, job); this.engine.changed(); return;
        }
      }
      this.tasks.finish(run, job, 'waiting');
      const pending = this.db.prepare("SELECT id FROM task_signals WHERE task_id=? AND signal_type='EVIDENCE_CHANGED' AND status='PENDING' ORDER BY created_at,id LIMIT 1").get(task.id);
      if (pending) this.jobs.enqueue({ type: 'task_continue', taskId: task.id, key: `signals:${task.id}:${pending.id}`, payload: { taskId: task.id } });
    });
  }
  async runDiscovery(job) {
    const event = this.store.state.events.find(event => event.id === job.payload.eventId);
    if (!event || this.privacy.forgotten('event', event.id) || job.payload.privacyEpoch !== Number(this.database.get('privacy_epoch'))) return;
    await this.scope.run({ eventId: event.id, job, privacyEpoch: job.payload.privacyEpoch }, async () => {
      this.engine.retryPendingReasoning(); await this.engine.whenSettled();
    });
  }
  situationRecall(event) {
    if (!event || !this.flags().lexicalRecall) return [];
    return recallCandidates(this.db, event, { now: this.database.now() }).situations.filter(item => item.method === 'entity' || item.method === 'lexical');
  }
  situationTargets(event) {
    if (event.type !== 'email.received' || !event.payload?.threadId) return [];
    return this.db.prepare(`SELECT DISTINCT s.id,s.kind,(SELECT COUNT(*) FROM tasks t WHERE t.situation_id=s.id AND t.status NOT IN ('completed','cancelled')) activeTasks FROM situations s JOIN event_situation_links l ON l.situation_id=s.id
      JOIN durable_inbox e ON e.id=l.event_id WHERE s.lifecycle_state IN ('OPEN','OBSERVING')
      AND e.provider=? AND json_extract(e.event_json,'$.payload.threadId')=? AND COALESCE(json_extract(e.event_json,'$.payload.accountId'),'')=?
      LIMIT 4`).all(event.connectorId, event.payload.threadId, event.payload.accountId || '');
  }
  recordSituationObservation(event, reason, situationId = null, taskIds = [], holdTasks = false, associateTasks = true) {
    if (this.store.state.events.some(row => row.id === event.id)) return;
    this.store.mutate(state => {
      state.events.push({ ...event, summary: `Email received · ${event.payload.subject}`, relations: associateTasks ? taskIds : [], disposition: 'context_only',
        rejection: { code: reason, detail: 'The observation is retained while its effect on the Situation is reviewed.' }, ...(situationId ? { situationIds: [situationId] } : {}) });
      if (!state.inbox.some(item => item.id === event.payload.id)) state.inbox.push({ ...event.payload, connectorId: event.connectorId, source: event.source });
      if (holdTasks) for (const taskId of taskIds) {
        const task = state.tasks[taskId]; if (!task || ['completed', 'cancelled'].includes(task.status)) continue;
        task.guidanceReviewRequired = true;
        task.guidanceRevision = Number(task.guidanceRevision || 0) + 1;
        if (!associateTasks) this.database.lineage('event', event.id, 'task', taskId);
        if (!task.action || !['executing', 'accepted_live', 'uncertain'].includes(task.action.status)) {
          task.control = { ...task.control, paused: true, pauseReason: 'state_delta_uncertain', updatedAt: iso(this.database.now()) }; if (!task.draft?.userEdited) task.draft = null; task.status = 'waiting_for_information';
          task.reason = 'New evidence needs review before this work continues.';
        }
        for (const notice of state.notifications || []) if (notice.taskId === taskId && !notice.resolvedAt) notice.resolvedAt = iso(this.database.now());
      }
    });
    this.engine.changed();
  }
  finishUninterpretable(event, reason, situationId) {
    const affected = this.db.prepare("SELECT id FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId).map(task => task.id);
    this.recordSituationObservation(event, reason, null, affected, affected.length > 0, false);
    this.tasks.releaseSemantic(event.id);
    for (const taskId of affected) this.scheduleTask(taskId, 'uninterpretable_source_update');
  }
  removeUnrelatedTaskLineage(eventId, taskIds) {
    this.database.atomic(() => {
      for (const taskId of taskIds) this.db.prepare("DELETE FROM lineage WHERE source_kind='event' AND source_id=? AND derived_kind='task' AND derived_id=? AND NOT EXISTS(SELECT 1 FROM task_events WHERE task_id=? AND event_id=?)")
        .run(eventId, taskId, taskId, eventId);
    });
  }
  async runSituationDelta(job) {
    const { eventId, situationId, privacyEpoch } = job.payload;
    if (this.privacy.forgotten('event', eventId)) return;
    const row = this.db.prepare('SELECT event_json FROM durable_inbox WHERE id=?').get(eventId);
    if (!row) return;
    if (privacyEpoch !== Number(this.database.get('privacy_epoch'))) { this.finishUninterpretable(parse(row.event_json), 'context_revoked', situationId); return; }
    let prior = this.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta' AND event_a=? AND situation_id=? ORDER BY created_at DESC LIMIT 1").get(eventId, situationId);
    let interpreted = null;
    if (this.store.state.events.some(event => event.id === eventId)) {
      let released = [];
      this.database.atomic(() => { released = this.tasks.releaseSemantic(eventId); if (prior?.outcome === 'UNRELATED') this.removeUnrelatedTaskLineage(eventId, released); });
      for (const taskId of released) this.scheduleTask(taskId, `situation_delta_recovery:${eventId}`);
      return;
    }
    const event = parse(row.event_json);
    if (!prior) {
      const situation = this.tasks.situations.get(situationId);
      const threadTargets = this.situationTargets(event);
      const entityHits = threadTargets.length ? [] : this.situationRecall(event);
      const targeted = threadTargets.length === 1 && threadTargets[0].id === situationId || threadTargets.length === 0 && entityHits.length === 1 && entityHits[0].id === situationId;
      if (!situation || !['OBSERVING', 'OPEN'].includes(situation.lifecycle_state) || !targeted || threadTargets[0]?.activeTasks > 1 && !this.flags().scopedCancellation) {
        this.finishUninterpretable(event, 'situation_changed', situationId); return;
      }
      if (!this.engine.reasoner?.available?.() || typeof this.engine.reasoner.extractSituationDelta !== 'function') {
        if (job.attempts >= job.max_attempts) {
          this.jobs.assert(job);
          this.finishUninterpretable(event, 'state_delta_unavailable', situationId);
        }
        throw Object.assign(new Error('State interpretation is unavailable.'), { status: 503 });
      }
      const contextVersion = Number(this.database.get('context_version')), modelVersion = this.database.get('model_version', '0');
      const fields = unquotedMessageFields(event.payload), boundedEvent = { subject: fields.subject.slice(0, 200), body: fields.body.slice(0, 600) };
      const missingEvidence = Array.isArray(situation.closureCondition?.missingEvidence) ? situation.closureCondition.missingEvidence.slice(0, 3).map(item => String(item).slice(0, 120)) : [];
      let proposal;
      try { proposal = await this.engine.reasoner.extractSituationDelta({ situation: { id: situation.id, summary: situation.summary.slice(0, 200), missingEvidence }, event: boundedEvent }, `delta:${job.id}:attempt:${job.attempts}`); }
      catch (error) {
        if (error?.code === 'REASONING_BUDGET') { error.status = 429; error.retryAfterMs = Math.max(Number(error.retryAfterMs) || 0, 60000); }
        if (classifyFailure(error) === 'permanent' || job.attempts >= job.max_attempts) {
          this.jobs.assert(job);
          if (privacyEpoch === Number(this.database.get('privacy_epoch')) && !this.privacy.forgotten('event', eventId)) {
            this.finishUninterpretable(event, 'state_delta_failed', situationId);
          }
        }
        throw error;
      }
      const delta = validateStateDelta(proposal, { ...event, payload: { subject: boundedEvent.subject, body: boundedEvent.body } });
      interpreted = delta;
      this.jobs.assert(job);
      if (this.privacy.forgotten('event', eventId)) return;
      if (privacyEpoch !== Number(this.database.get('privacy_epoch'))) { this.finishUninterpretable(event, 'context_revoked', situationId); return; }
      if (!delta) {
        this.finishUninterpretable(event, 'invalid_state_delta', situationId); return;
      }
      this.database.atomic(() => {
        this.jobs.assert(job);
        const current = this.tasks.situations.get(situationId);
        const threadTargets = this.situationTargets(event);
        const recalled = threadTargets.length ? [] : this.situationRecall(event);
        const sameTarget = threadTargets.length === 1 && threadTargets[0].id === situationId || recalled.length === 1 && recalled[0].id === situationId;
        if (!current || current.version !== situation.version || contextVersion !== Number(this.database.get('context_version'))
          || modelVersion !== this.database.get('model_version', '0') || privacyEpoch !== Number(this.database.get('privacy_epoch'))
          || !sameTarget || threadTargets[0]?.activeTasks > 1 && !this.flags().scopedCancellation) throw Object.assign(durableError('CONTEXT_CHANGED', 'The Situation changed during interpretation.'), { status: 503 });
        let outcome = delta.confidence < 0.8 ? 'UNCERTAIN_ASSOCIATION' : delta.associated ? delta.polarity : 'UNRELATED';
        if (delta.associated && outcome !== 'UNCERTAIN_ASSOCIATION') {
          const sources = this.db.prepare('SELECT e.event_json,l.association_method FROM event_situation_links l JOIN durable_inbox e ON e.id=l.event_id WHERE l.situation_id=? ORDER BY l.associated_at DESC LIMIT 12').all(situationId).map(source => ({ ...parse(source.event_json), associationMethod: source.association_method }));
          const originatingSenders = new Set(sources.filter(source => ['task_source', 'semantic'].includes(source.associationMethod)).map(source => normalizeAddress(source.payload?.from)).filter(Boolean));
          const trusted = originatingSenders.size === 1 && originatingSenders.has(normalizeAddress(event.payload.from));
          const activeTasks = this.db.prepare("SELECT id FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId);
          const scopedIds = activeTasks.length > 1 ? this.scopedTaskIds(situationId, delta) : [];
          const trustedTask = activeTasks.length === 0 || activeTasks.length === 1 && isTrustedThreadSender(this.tasks.get(activeTasks[0].id), event.payload)
            || activeTasks.length > 1 && scopedIds.length === 1 && trusted;
          const times = sources.map(source => Date.parse(source.payload?.receivedAt || source.at)).filter(Number.isFinite);
          const observedAt = Date.parse(event.payload?.receivedAt || event.at);
          const stale = Number.isFinite(observedAt) && times.length > 0 && observedAt < Math.max(...times);
          if (stale || outcome === 'CANCEL' && (!trusted || !trustedTask || event.meta?.originClass === 'AUTOMATION' || isAutomatedSender(event.payload.from) || delta.confidence < 0.8 || !confirmsCancellation(delta.evidenceRefs, event))) outcome = 'UNKNOWN';
          this.tasks.situations.linkEvent(situationId, eventId, 'structural');
          let condition = current.closureCondition;
          if (['ADVANCE', 'SUPERSEDE', 'CONTRADICT'].includes(outcome) && delta.confidence >= 0.8) {
            condition = { ...current.closureCondition, probeTargets: [],
              missingEvidence: delta.stateDelta.missingEvidence.length ? delta.stateDelta.missingEvidence : current.closureCondition.missingEvidence || [], evidenceEventId: eventId };
            for (const key of ['deadlineUpdates', 'commitments', 'closureConditionUpdates']) {
              condition[key] = [...(Array.isArray(current.closureCondition[key]) ? current.closureCondition[key] : []), ...delta.stateDelta[key].map(item => ({ ...item, eventId }))].slice(-32);
            }
          }
          const cancelled = outcome === 'CANCEL' && activeTasks.length <= 1;
          this.db.prepare('UPDATE situations SET lifecycle_state=?,closure_status=?,closure_evidence_json=?,closure_condition_json=?,updated_at=?,version=version+1 WHERE id=?')
            .run(cancelled ? 'CANCELLED' : current.lifecycle_state, cancelled ? 'CONFIRMED' : current.closure_status,
              cancelled ? json([{ kind: 'event', id: eventId }]) : current.closure_evidence_json, json(condition), iso(this.database.now()), situationId);
        }
        this.db.prepare('INSERT INTO activation_decisions VALUES(?,?,NULL,?,?,?,?,?,?)').run(randomUUID(), eventId, situationId, 'state_delta', outcome, delta.associated ? 'grounded_interpretation' : 'semantic_unrelated', '1', iso(this.database.now()));
        prior = { outcome };
      });
    }
    this.jobs.assert(job);
    if (privacyEpoch !== Number(this.database.get('privacy_epoch')) || this.privacy.forgotten('event', eventId)) return;
    const activeTasks = this.db.prepare("SELECT id FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId).map(task => task.id);
    if (activeTasks.length > 1 && this.flags().scopedCancellation) {
      const scoped = ['CANCEL', 'SUPERSEDE'].includes(prior.outcome) && interpreted ? this.scopedTaskIds(situationId, interpreted) : [];
      if (scoped.length === 1) {
        const cancel = prior.outcome === 'CANCEL';
        this.tasks.applyControl(scoped[0], cancel ? 'CANCELLATION' : 'SUPERSESSION', eventId, data => {
          if (cancel) data.status = 'cancelled';
          data.control = { ...(data.control || {}), paused: true, pauseReason: cancel ? 'scoped_cancellation' : 'scoped_supersession', updatedAt: iso(this.database.now()) };
          if (!cancel) data.supersededByEventId = eventId;
        });
        this.database.lineage('event', eventId, 'task', scoped[0]);
        this.recordSituationObservation(event, cancel ? 'scoped_cancellation' : 'scoped_supersession', situationId, scoped, false, true);
      } else this.recordSituationObservation(event, prior.outcome === 'CANCEL' ? 'ambiguous_situation' : `state_delta_${String(prior.outcome || 'unknown').toLowerCase()}`, situationId, activeTasks, true, false);
      this.database.atomic(() => this.tasks.releaseSemantic(eventId));
      for (const taskId of activeTasks) if (!scoped.includes(taskId)) this.scheduleTask(taskId, `situation_delta:${eventId}`);
      return;
    }
    const competingUpdate = activeTasks.some(taskId => this.tasks.hasPendingSemantic(taskId, eventId));
    const reviewHeld = activeTasks.some(taskId => { const task = this.tasks.get(taskId); return task?.control?.paused || task?.guidanceReviewRequired; });
    if ((competingUpdate || reviewHeld) && !['CANCEL', 'UNRELATED'].includes(prior.outcome)) this.recordSituationObservation(event, competingUpdate ? 'multiple_source_updates' : 'review_required', situationId, activeTasks, activeTasks.length > 0);
    else if (prior.outcome === 'UNRELATED' || activeTasks.length === 1 && ['ADVANCE', 'NEUTRAL', 'CANCEL'].includes(prior.outcome)) {
      const version = Number(this.database.get('context_version')), family = familyOf(event), payload = event.payload;
      const features = this.registry.capture({ 'event.provider': event.connectorId, 'event.family': family, 'event.actionable': true,
        ...(payload.from ? { 'sender.identity': normalizeAddress(payload.from) } : {}), ...(payload.projectId ? { 'project.id': payload.projectId } : {}) }, { now: this.database.now(), contextVersion: version });
      const activation = this.policies.evaluate(features, [{ type: 'task_family', key: family }, ...(payload.projectId ? [{ type: 'project', key: payload.projectId }] : [])], version);
      this.engine.ingestLegacy({ ...event, activation, suppressForwardActivation: !activation.activate }, prior.outcome === 'UNRELATED' ? {} : {
        confirmedCancellation: prior.outcome === 'CANCEL', situationTaskIds: activeTasks, interpretedSituationId: situationId });
    }
    else this.recordSituationObservation(event, `state_delta_${prior.outcome.toLowerCase()}`, prior.outcome === 'UNCERTAIN_ASSOCIATION' ? null : situationId,
      activeTasks, activeTasks.length > 0, prior.outcome !== 'UNCERTAIN_ASSOCIATION');
    this.database.atomic(() => { this.tasks.releaseSemantic(eventId); if (prior.outcome === 'UNRELATED') this.removeUnrelatedTaskLineage(eventId, activeTasks); });
    for (const taskId of activeTasks) this.scheduleTask(taskId, `situation_delta:${eventId}`);
  }
  flags() { return activationFlags(this.database); }
  setFlags(patch) { return setActivationFlags(this.database, patch); }
  locallyScopedTaskIds(situationId, event) {
    const body = String(event?.payload?.body || '');
    if (body.length < 3) return [];
    return this.db.prepare("SELECT id,data_json FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId).filter(row => {
      const data = parse(row.data_json);
      const needles = [data.subject, data.request?.subjectEntity].filter(value => typeof value === 'string' && value.trim().length >= 3);
      return needles.some(needle => body.includes(needle.trim()));
    }).map(row => row.id);
  }
  scopedTaskIds(situationId, delta) {
    const quotes = (delta?.evidenceRefs || []).map(item => item.quote).filter(quote => typeof quote === 'string' && quote.length >= 3);
    if (!quotes.length) return [];
    return this.db.prepare("SELECT id,data_json FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId).filter(row => {
      const data = parse(row.data_json);
      const haystack = `${data.subject || ''}\n${data.request?.text || ''}\n${data.request?.subjectEntity || ''}`;
      return quotes.some(quote => haystack.includes(quote));
    }).map(row => row.id);
  }
  scheduleStandingIntents(event) {
    if (!this.flags().standingIntents || !event || event.type === 'timer.due' || event.meta?.originClass === 'AUTOMATION' || this.privacy.permissionRevoked(event.connectorId)) return;
    const hits = this.intents.prefilterHits(event, { limit: 50 });
    hits.forEach((intent, index) => {
      const payload = { intentId: intent.id, eventId: event.id, intentVersion: intent.version, privacyEpoch: Number(this.database.get('privacy_epoch')) };
      if (index < 3) {
        const job = this.jobs.enqueue({ type: 'standing_intent_match', key: `intent:${intent.id}:${event.id}:v${intent.version}`, payload });
        this.database.lineage('event', event.id, 'job', job.id);
        this.database.lineage('standing_intent', intent.id, 'job', job.id);
        return;
      }
      this.intents.record(intent.id, event.id, 'DEFERRED', 'prefilter_cap');
      this.jobs.enqueue({ type: 'standing_intent_match', key: `intent-deferred:${intent.id}:${event.id}:v${intent.version}`, availableAt: iso(this.database.now() + Math.min(intent.budget.windowMs, 3600000)), payload });
    });
  }
  async runStandingIntent(job) {
    const { intentId, eventId, intentVersion, privacyEpoch } = job.payload;
    if (privacyEpoch !== Number(this.database.get('privacy_epoch')) || this.privacy.forgotten('event', eventId)) return;
    const intent = this.intents.get(intentId);
    const row = this.db.prepare('SELECT event_json FROM durable_inbox WHERE id=?').get(eventId);
    if (!intent || !row || intent.version !== intentVersion || intent.status !== 'active') return;
    const event = this.store.state.events.find(item => item.id === eventId) || parse(row.event_json);
    if (!this.intents.matchesPrefilter(intent, event)) return;
    if (!this.intents.budgetOpen(intent)) {
      this.database.atomic(() => {
        this.jobs.assert(job);
        this.intents.record(intent.id, eventId, 'DEFERRED', 'budget_exhausted');
        this.jobs.enqueue({ type: 'standing_intent_match', key: `intent-budget:${intent.id}:${eventId}:v${intent.version}:a${job.attempts}`, availableAt: iso(this.database.now() + Math.min(intent.budget.windowMs, 3600000)), payload: job.payload });
      });
      return;
    }
    let matched = !intent.predicate, quote = null;
    if (intent.predicate) {
      if (typeof this.engine.reasoner?.assessStandingIntent !== 'function' || !this.engine.reasoner.available?.()) {
        this.database.atomic(() => this.intents.record(intent.id, eventId, 'UNKNOWN', 'semantic_unavailable'));
        return;
      }
      const proposal = await this.engine.reasoner.assessStandingIntent({ predicate: intent.predicate, event: { id: event.id, subject: String(event.payload?.subject || '').slice(0, 200), body: String(event.payload?.body || '').slice(0, 600) } }, `intent:${job.id}:${job.attempts}`);
      const fields = unquotedMessageFields(event.payload);
      quote = proposal?.quote;
      matched = proposal?.matched === true && typeof quote === 'string' && quote.length > 0 && (`${fields.subject}\n${fields.body}`).includes(quote) && proposal.confidence >= 0.8;
      if (!matched) {
        this.database.atomic(() => this.intents.record(intent.id, eventId, proposal ? 'UNRELATED' : 'INVALID', proposal ? 'semantic_unrelated' : 'ungrounded_or_invalid'));
        return;
      }
    }
    if (privacyEpoch !== Number(this.database.get('privacy_epoch')) || this.privacy.permissionRevoked(event.connectorId) || this.privacy.forgotten('event', eventId)) return;
    this.database.atomic(() => {
      this.jobs.assert(job);
      const current = this.intents.get(intentId);
      if (!current || current.version !== intentVersion || current.status !== 'active' || !this.intents.matchesPrefilter(current, event) || !this.intents.budgetOpen(current)) return;
      if (privacyEpoch !== Number(this.database.get('privacy_epoch')) || this.privacy.permissionRevoked(event.connectorId) || this.privacy.forgotten('event', eventId)) return;
      if (this.db.prepare("SELECT 1 FROM activation_decisions WHERE stage='standing_intent' AND event_a=? AND evaluator_version=? AND outcome='MATCHED'").get(eventId, intentId)) return;
      const situation = this.tasks.situations.create({ kind: 'standing_intent', summary: quote || current.description, lifecycleState: 'OBSERVING',
        closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: [current.desiredOutcome], reevaluationCondition: current.predicate || 'When the prefilter matches again.' },
        scope: { ...current.scope, standingIntentId: current.id }, sourceEventIds: [eventId], associationMethod: 'standing_intent', standingIntentId: current.id });
      if (current.autonomy?.maxAutonomy === 'prepare') this.tasks.createOrLoad({ candidateKey: `intent:${current.id}:${eventId}`, situationId: situation.id, dedupTaskKey: `intent:${current.id}`, eventId, data: { status: 'waiting_for_information', subject: current.description, sourceConnectorId: event.connectorId, guidanceReviewRequired: true, request: { text: current.desiredOutcome, deliverable: 'draft' } } });
      this.intents.record(current.id, eventId, 'MATCHED', current.predicate ? 'semantic_prefilter' : 'prefilter', situation.id);
      this.database.lineage('standing_intent', current.id, 'situation', situation.id);
    });
    this.engine.changed();
  }
  pairEligible(event) {
    if (!(event?.type === 'email.received' && event.disposition === 'context_only' && event.payload?.threadId
      && !event.suppressForwardActivation && event.meta?.originClass !== 'AUTOMATION' && !isAutomatedSender(event.payload?.from)
      && !['PASSIVE_OBSERVER', 'SHARED_GROUP'].includes(event.meta?.principalRole))
      || this.db.prepare('SELECT 1 FROM event_situation_links WHERE event_id=? LIMIT 1').get(event.id)
      || !this.db.prepare("SELECT 1 FROM durable_inbox WHERE id=? AND state='processed' AND received_at>=?").get(event.id, iso(this.database.now() - this.unattachedWindowMs))) return false;
    const version = Number(this.database.get('context_version')), family = familyOf(event), payload = event.payload;
    const features = this.registry.capture({ 'event.provider': event.connectorId, 'event.family': family, 'event.actionable': true,
      ...(payload.from ? { 'sender.identity': normalizeAddress(payload.from) } : {}), ...(payload.projectId ? { 'project.id': payload.projectId } : {}) }, { now: this.database.now(), contextVersion: version });
    return this.policies.evaluate(features, [{ type: 'task_family', key: family }, ...(payload.projectId ? [{ type: 'project', key: payload.projectId }] : [])], version).activate;
  }
  pairEvaluatorVersion() { return `${PAIR_EVALUATOR_VERSION}:${this.database.get('model_version', '0')}`; }
  scheduleUnattachedPairs(eventId) {
    if (!this.engine.reasoner?.available?.() || typeof this.engine.reasoner.assessSituationPair !== 'function') return;
    const current = this.store.state.events.find(event => event.id === eventId);
    if (!this.pairEligible(current)) return;
    const candidates = this.db.prepare("SELECT id FROM durable_inbox WHERE provider=? AND state='processed' AND received_at>=? AND id!=? ORDER BY received_at DESC LIMIT 100")
      .all(current.connectorId, iso(this.database.now() - this.unattachedWindowMs), eventId);
    let scheduled = 0;
    const evaluatorVersion = this.pairEvaluatorVersion();
    for (const candidate of candidates) {
      const other = this.store.state.events.find(event => event.id === candidate.id);
      if (!other || other.source !== current.source || other.payload?.threadId !== current.payload.threadId
        || (other.payload?.accountId || null) !== (current.payload.accountId || null) || !this.pairEligible(other)) continue;
      const [a, b] = [eventId, other.id].sort();
      if (this.db.prepare('SELECT 1 FROM negative_pair_cache WHERE event_a=? AND event_b=? AND evaluator_version=? AND expires_at>?').get(a, b, evaluatorVersion, iso(this.database.now()))) continue;
      const key = createHash('sha256').update(json([a, b, evaluatorVersion])).digest('hex');
      this.database.atomic(() => {
        const job = this.jobs.enqueue({ type: 'situation_pair', key: `situation-pair:${key}`, payload: { eventIds: [a, b], evaluatorVersion, privacyEpoch: Number(this.database.get('privacy_epoch')) } });
        this.database.lineage('event', a, 'job', job.id); this.database.lineage('event', b, 'job', job.id);
      });
      if (++scheduled >= this.maxPairCandidates) break;
    }
    if (!this.flags().lexicalRecall) return;
    const recalled = recallCandidates(this.db, current, { now: this.database.now(), windowMs: this.unattachedWindowMs, limit: this.maxPairCandidates });
    for (const candidate of recalled.unattachedEvents) {
      const other = this.store.state.events.find(item => item.id === candidate.id);
      if (!other || !this.pairEligible(other)) continue;
      const [a, b] = [eventId, other.id].sort();
      const key = createHash('sha256').update(json([a, b, evaluatorVersion, 'lexical'])).digest('hex');
      this.database.atomic(() => {
        const job = this.jobs.enqueue({ type: 'situation_pair', key: `situation-pair:${key}`, payload: { eventIds: [a, b], evaluatorVersion, privacyEpoch: Number(this.database.get('privacy_epoch')), lane: 'lexical' } });
        this.database.lineage('event', a, 'job', job.id); this.database.lineage('event', b, 'job', job.id);
      });
    }
  }
  async runSituationPair(job) {
    const { eventIds, evaluatorVersion, privacyEpoch } = job.payload;
    if (!Array.isArray(eventIds) || eventIds.length !== 2 || evaluatorVersion !== this.pairEvaluatorVersion() || privacyEpoch !== Number(this.database.get('privacy_epoch'))) return;
    const events = eventIds.map(id => this.store.state.events.find(event => event.id === id));
    const sameThread = events[0].connectorId === events[1].connectorId && events[0].payload.threadId === events[1].payload.threadId && (events[0].payload.accountId || null) === (events[1].payload.accountId || null);
    const lexical = job.payload.lane === 'lexical' && this.flags().lexicalRecall && scopesCompatible(events[0].payload, events[1].payload)
      && entityKeys(events[0]).some(item => item.role !== 'thread' && entityKeys(events[1]).some(other => other.key === item.key && other.role === item.role));
    if (!events.every(event => this.pairEligible(event)) || !sameThread && !lexical) return;
    if (this.db.prepare('SELECT 1 FROM negative_pair_cache WHERE event_a=? AND event_b=? AND evaluator_version=? AND expires_at>?').get(...eventIds, evaluatorVersion, iso(this.database.now()))) return;
    if (!this.engine.reasoner?.available?.() || typeof this.engine.reasoner.assessSituationPair !== 'function') return;
    const contextVersion = Number(this.database.get('context_version')), modelVersion = this.database.get('model_version', '0');
    const input = events.map(event => { const fields = unquotedMessageFields(event.payload); return { id: event.id, subject: fields.subject.slice(0, 1000), body: fields.body.slice(0, 4000) }; });
    while (JSON.stringify(JSON.stringify(input)).length > 6000) {
      const longest = input.flatMap(event => ['body', 'subject'].map(field => ({ event, field }))).sort((a, b) => b.event[b.field].length - a.event[a.field].length)[0];
      if (!longest || !longest.event[longest.field]) return;
      longest.event[longest.field] = longest.event[longest.field].slice(0, Math.floor(longest.event[longest.field].length / 2));
    }
    let proposed;
    try { proposed = await this.engine.reasoner.assessSituationPair({ events: input }, `pair:${job.id}:attempt:${job.attempts}`); }
    catch (error) {
      if (error?.code === 'REASONING_BUDGET') { error.status = 429; error.retryAfterMs = Math.max(Number(error.retryAfterMs) || 0, 60000); }
      throw error;
    }
    const result = validatePairAssessment(proposed, input.map(event => ({ id: event.id, payload: { subject: event.subject, body: event.body } })));
    const currentEvents = eventIds.map(id => this.store.state.events.find(event => event.id === id));
    if (!result) {
      this.database.atomic(() => {
        this.jobs.assert(job);
        if (privacyEpoch === Number(this.database.get('privacy_epoch')) && currentEvents.every(event => this.pairEligible(event)))
          this.db.prepare('INSERT INTO activation_decisions VALUES(?,?,?,NULL,?,?,?,?,?)').run(randomUUID(), ...eventIds, 'pair_association', 'INVALID', 'ungrounded_or_invalid', evaluatorVersion, iso(this.database.now()));
      });
      throw durableError('INVALID_PAIR_RESULT', 'The pair assessment did not pass grounded validation.', 400);
    }
    this.database.atomic(() => {
      this.jobs.assert(job);
      if (privacyEpoch !== Number(this.database.get('privacy_epoch')) || contextVersion !== Number(this.database.get('context_version')) || modelVersion !== this.database.get('model_version', '0') || !currentEvents.every(event => this.pairEligible(event))) return;
      if (result.outcome === 'UNRELATED') {
        this.db.prepare('INSERT OR IGNORE INTO negative_pair_cache VALUES(?,?,?,?,?)').run(...eventIds, evaluatorVersion, iso(this.database.now() + this.unattachedWindowMs), iso(this.database.now()));
        this.db.prepare('INSERT INTO activation_decisions VALUES(?,?,?,NULL,?,?,?,?,?)').run(randomUUID(), ...eventIds, 'pair_association', 'UNRELATED', 'semantic_unrelated', evaluatorVersion, iso(this.database.now()));
        return;
      }
      // A pair classifier alone does not supply the evidence and policy gates
      // needed to admit forward work, even if it labels the pair actionable.
      const missingEvidence = result.outcome === 'ACTIONABLE' ? [...result.missingEvidence, 'A concrete action and responsibility need validation.'] : result.missingEvidence;
      const situation = this.tasks.situations.create({ kind: 'related_observations', summary: result.evidence[0].quote, lifecycleState: 'OBSERVING',
        closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence, reevaluationCondition: result.reevaluationCondition }, sourceEventIds: eventIds, associationMethod: 'semantic' });
      this.db.prepare('INSERT INTO activation_decisions VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), ...eventIds, situation.id, 'pair_association', 'RELATED_WAIT', result.outcome === 'ACTIONABLE' ? 'action_requires_validation' : 'missing_evidence', evaluatorVersion, iso(this.database.now()));
    });
    this.engine.changed();
  }
  scheduleSituation(situationId, scheduledAt) {
    const time = Date.parse(scheduledAt);
    if (!Number.isFinite(time)) throw durableError('INVALID_SCHEDULE', 'A valid Situation reevaluation time is required.', 400);
    const at = iso(time);
    const job = this.database.atomic(() => {
      const situation = this.tasks.situations.get(situationId);
      if (!situation || !['OPEN', 'OBSERVING'].includes(situation.lifecycle_state)) throw durableError('MISSING_SITUATION', 'An active Situation is required.');
      this.db.prepare('UPDATE situations SET next_eval_at=?,version=version+1,updated_at=? WHERE id=?').run(at, iso(this.database.now()), situationId);
      const version = this.tasks.situations.get(situationId).version;
      const scheduled = this.jobs.enqueue({ type: 'situation_timer', key: `situation-timer:${situationId}:${version}`, availableAt: at,
        payload: { situationId, scheduledAt: at } });
      this.database.lineage('situation', situationId, 'job', scheduled.id);
      this.database.lineage('situation', situationId, 'event', `scheduler:timer:${scheduled.id}`);
      return scheduled;
    });
    this.kick(); return job;
  }
  configureSituationProbe(situationId, { sourceEventId, scheduledAt }) {
    const at = Date.parse(scheduledAt);
    if (!Number.isFinite(at) || typeof sourceEventId !== 'string' || !sourceEventId) throw durableError('INVALID_PROBE', 'Choose an existing source event and a valid reevaluation time.', 400);
    const result = this.database.atomic(() => {
      const situation = this.tasks.situations.get(situationId);
      const row = this.db.prepare(`SELECT e.event_json FROM durable_inbox e JOIN event_situation_links l ON l.event_id=e.id
        JOIN source_records s ON s.kind='event' AND s.id=e.id AND s.active=1 WHERE e.id=? AND l.situation_id=?`).get(sourceEventId, situationId);
      const source = parse(row?.event_json), sender = normalizeAddress(source?.payload?.from);
      const afterAt = source?.payload?.receivedAt || source?.at;
      if (!situation || !['OPEN', 'OBSERVING'].includes(situation.lifecycle_state) || source?.source !== 'google' || source.connectorId !== 'google'
        || source.type !== 'email.received' || !source.payload.threadId || !source.payload.id || !/^[^\s@]+@[^\s@]+$/.test(sender)
        || source.meta?.originClass === 'AUTOMATION' || isAutomatedSender(source.payload.from) || !Number.isFinite(Date.parse(afterAt)) || Date.parse(afterAt) > this.database.now()) throw durableError('INVALID_PROBE', 'The selected source cannot authorize a scoped reply probe.', 400);
      const target = { kind: 'EXPECTED_REPLY', sourceEventId, connectorId: 'google', threadId: source.payload.threadId,
        sourceMessageId: source.payload.id, expectedSender: sender, afterAt: iso(Date.parse(afterAt)), ...(Number.isFinite(Date.parse(source.payload.deadlineAt)) ? { deadlineAt: iso(Date.parse(source.payload.deadlineAt)) } : {}) };
      this.db.prepare('UPDATE situations SET closure_condition_json=?,updated_at=?,version=version+1 WHERE id=?')
        .run(json({ ...situation.closureCondition, probeTargets: [target] }), iso(this.database.now()), situationId);
      return this.scheduleSituation(situationId, iso(at));
    });
    this.kick(); return result;
  }
  async probeSituation(situation, eventId, job) {
    const targets = situation.closureCondition?.probeTargets;
    if (!Array.isArray(targets) || targets.length !== 1 || targets[0]?.kind !== 'EXPECTED_REPLY') return null;
    const target = targets[0], epoch = Number(this.database.get('privacy_epoch')), contextVersion = Number(this.database.get('context_version'));
    const source = this.db.prepare(`SELECT e.event_json FROM durable_inbox e JOIN event_situation_links l ON l.event_id=e.id
      JOIN source_records s ON s.kind='event' AND s.id=e.id AND s.active=1 WHERE e.id=? AND l.situation_id=?`).get(target.sourceEventId, situation.id);
    const event = parse(source?.event_json), connector = this.connectorFor(target.connectorId), wasLive = Boolean(connector?.live);
    const health = this.store.state.connectorStatus?.[target.connectorId], watermark = this.store.state.cursors?.[target.connectorId]?.gmail?.historyId;
    const healthAt = Date.parse(health?.lastSyncAt || ''), fresh = health?.ok === true && Number.isFinite(healthAt)
      && healthAt <= this.database.now() && this.database.now() - healthAt <= 600000 && typeof watermark === 'string' && watermark.length > 0;
    let outcome = 'PROBE_INCOMPLETE', foundEvent = null;
    const sourceTime = Date.parse(event?.payload?.receivedAt || event?.at);
    const scoped = target.connectorId === 'google' && event?.source === 'google' && event.type === 'email.received' && event.connectorId === target.connectorId && event.payload?.threadId === target.threadId
      && event.payload?.id === target.sourceMessageId && normalizeAddress(event.payload?.from) === target.expectedSender
      && event.meta?.originClass !== 'AUTOMATION' && !isAutomatedSender(event.payload?.from) && Number.isFinite(sourceTime) && iso(sourceTime) === target.afterAt;
    const supported = scoped && fresh && connector?.live && connector.config?.readGmail !== false && !this.privacy.permissionRevoked(target.connectorId);
    if (supported && typeof connector.probeExpectedReply !== 'function') outcome = 'UNKNOWN';
    else if (supported) {
      try {
        this.noteObservation('network');
        const observation = await this.gateway.read(() => connector.probeExpectedReply(target));
        if (observation?.status === 'NOT_FOUND' && observation.complete === true) outcome = target.deadlineAt && Date.parse(target.deadlineAt) <= this.database.now() ? 'DEADLINE_PASSED' : 'EXPECTED_EVENT_ABSENT';
        else if (observation?.status === 'CANCELLED' && observation.complete === true) outcome = 'EXPLICIT_CANCELLATION';
        else if (observation?.status === 'CONTRADICTION') outcome = 'SOURCE_CONTRADICTION';
        else if (observation?.status === 'FOUND' && typeof observation.messageId === 'string' && observation.messageId && typeof connector.fetchProbedMessage === 'function') {
          foundEvent = await this.gateway.read(() => connector.fetchProbedMessage({ threadId: target.threadId, messageId: observation.messageId }));
          if (foundEvent?.source === 'google' && foundEvent.connectorId === target.connectorId && foundEvent.payload?.threadId === target.threadId
            && foundEvent.payload?.id === observation.messageId && normalizeAddress(foundEvent.payload?.from) === target.expectedSender
            && foundEvent.meta?.originClass !== 'AUTOMATION' && !isAutomatedSender(foundEvent.payload.from)
            && !this.privacy.forgotten('event', foundEvent.id)
            && !this.privacy.forgotten('provider_event', `${target.connectorId}:${foundEvent.providerEventId || foundEvent.id}`)) outcome = 'EXPECTED_EVENT_PRESENT';
        }
      } catch { outcome = 'PROBE_INCOMPLETE'; }
    }
    this.jobs.assert(job);
    try { this.gateway.authorizeRead(); } catch { return null; }
    const current = this.tasks.situations.get(situation.id);
    if (!current || current.version !== situation.version || epoch !== Number(this.database.get('privacy_epoch')) || contextVersion !== Number(this.database.get('context_version'))
      || this.privacy.forgotten('event', target.sourceEventId) || this.privacy.permissionRevoked(target.connectorId) || connector !== this.connectorFor(target.connectorId) || wasLive && (!connector?.live || connector.config?.readGmail === false)) return null;
    const currentHealth = this.store.state.connectorStatus?.[target.connectorId], currentWatermark = this.store.state.cursors?.[target.connectorId]?.gmail?.historyId;
    if (['EXPECTED_EVENT_ABSENT', 'DEADLINE_PASSED'].includes(outcome) && (!fresh || currentHealth?.ok !== true || currentHealth.lastSyncAt !== health.lastSyncAt || currentWatermark !== watermark)) outcome = 'PROBE_INCOMPLETE';
    this.database.atomic(() => {
      this.jobs.assert(job);
      this.db.prepare('UPDATE situations SET closure_condition_json=?,source_watermark_json=?,updated_at=?,version=version+1 WHERE id=? AND version=?')
        .run(json({ ...current.closureCondition, probeObservation: { status: outcome, observedAt: iso(this.database.now()), sourceEventId: target.sourceEventId } }),
          json({ connectorId: target.connectorId, syncAt: fresh ? iso(healthAt) : null }), iso(this.database.now()), situation.id, current.version);
      const probeReason = outcome === 'PROBE_INCOMPLETE' ? 'coverage_incomplete' : outcome === 'UNKNOWN' ? 'connector_unsupported' : 'authoritative_thread_metadata';
      this.db.prepare('INSERT INTO activation_decisions VALUES(?,?,NULL,?,?,?,?,?,?)').run(randomUUID(), eventId, situation.id, 'active_probe', outcome, probeReason, null, iso(this.database.now()));
    });
    if (outcome === 'EXPECTED_EVENT_PRESENT' && foundEvent) this.engine.ingest(foundEvent);
    return outcome;
  }
  async runSituationTimer(job) {
    const { situationId, scheduledAt } = job.payload;
    const situation = this.tasks.situations.get(situationId);
    if (!situation || !['OPEN', 'OBSERVING'].includes(situation.lifecycle_state) || situation.next_eval_at !== scheduledAt) return;
    this.jobs.assert(job);
    const providerEventId = `timer:${job.id}`;
    const eventId = `scheduler:${providerEventId}`;
    const observation = this.engine.ingest({ id: eventId, providerEventId, type: 'timer.due', source: 'internal', connectorId: 'scheduler',
      at: iso(this.database.now()), meta: { originClass: 'AUTOMATION', principalRole: 'UNKNOWN', roleEvidence: { basis: 'internal_timer' } },
      payload: { id: providerEventId, situationId, scheduledAt } });
    if (observation.disposition === 'forgotten') return;
    await this.probeSituation(situation, eventId, job);
    this.database.atomic(() => {
      this.jobs.assert(job);
      const changed = this.db.prepare("UPDATE situations SET next_eval_at=NULL,updated_at=?,version=version+1 WHERE id=? AND next_eval_at=? AND lifecycle_state IN ('OPEN','OBSERVING')")
        .run(iso(this.database.now()), situationId, scheduledAt).changes;
      if (!changed) return;
      const tasks = this.db.prepare("SELECT id,input_version,data_json FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId);
      if (!tasks.length) this.db.prepare('INSERT INTO activation_decisions VALUES(?,?,NULL,?,?,?,?,?,?)').run(randomUUID(), eventId, situationId, 'situation_timer', 'WAIT', 'no_new_evidence', null, iso(this.database.now()));
      for (const task of tasks) {
        const data = parse(task.data_json);
        if (!data.control?.paused && !data.privacyInvalidated) this.jobs.enqueue({ type: 'task_continue', taskId: task.id,
          key: `situation-timer:${job.id}:${task.id}`, payload: { taskId: task.id, inputVersion: task.input_version } });
      }
    });
  }
  planningContext(taskId) {
    const scope = this.current(); if (scope?.taskId !== taskId || !scope.context) return null;
    return { memory: scope.context.memories.slice(0, 2).map(memory => ({ id: memory.id, text: memory.content.slice(0, 250) })),
      experiences: scope.context.experiences.slice(0, 3).map(experience => ({ id: experience.id, kind: experience.kind, status: experience.status, instruction: experience.instruction_text.slice(0, 180), advisoryOnly: experience.advisoryOnly })),
      relatedEvents: scope.context.events.slice(0, 2).map(event => ({ id: event.id, type: event.type, text: String(event.payload?.body || event.payload?.content || event.payload?.title || '').slice(0, 200) })),
      conflicts: scope.context.arbitration.conflicts };
  }
  tracePlan(task, run, context) {
    for (const spec of task.evidence?.plan?.specs || []) this.experiences.step({ taskRunId: run.id, logicalStepId: `probe:${spec.id}`, stepKind: 'evidence_probe', actionFamily: 'evidence.read', expectedEffect: { criterionId: spec.criterionId, concept: spec.concept }, experiences: [] });
    if (task.draft) {
      const step = this.experiences.step({ taskRunId: run.id, logicalStepId: `draft:${task.draft.documentVersion}`, stepKind: 'draft_preparation', actionFamily: 'email.prepare', expectedEffect: { type: 'draft_format', format: 'plain' } });
      const id = `draft:${task.id}:${effectDigest(task.draft)}`;
      if (!this.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(id)) this.experiences.artifact({ id, taskId: task.id, taskRunId: run.id, planStepId: step.id, content: task.draft.body, version: task.draft.documentVersion || 1 });
      this.experiences.step({ taskRunId: run.id, logicalStepId: `send:${effectDigest(task.draft)}`, stepKind: 'external_action', actionFamily: 'email.send', expectedEffect: {
        type: 'email_reply', to: task.draft.to, documentId: task.documentId,
        bodyDigest: createHash('sha256').update(task.draft.body).digest('hex')
      } });
    }
  }
  wrapReadTools(tools, taskId, { provider = 'mcp' } = {}) {
    return tools.map(tool => ({ ...tool, execute: async (id, args, signal) => {
      const scope = this.current();
      if (!scope?.run || scope.taskId !== taskId) throw durableError('TASK_LEASE_REQUIRED', 'A read tool requires an active durable task run.');
      this.tasks.preResume(scope.run, scope.job);
      const key = `read:${scope.run.id}:${id}`;
      const intent = this.ledger.intent({ taskId, run: scope.run, job: scope.job, provider: tool.contextProvider === 'workspace' ? 'workspace' : provider, tool: tool.name, actionFamily: 'context.read', resourceId: tool.name, key,
        effect: { type: 'read', tool: tool.name, argumentsDigest: effectDigest(args) }, payload: {}, isWrite: false });
      return this.ledger.dispatch(intent, { run: scope.run, job: scope.job, signal, send: currentSignal => {
        this.gateway.authorizeRead();
        return tool.execute(id, args, currentSignal);
      } });
    } }));
  }
  async external(task, { provider, tool, actionFamily, resourceId, key, effect, payload, send, verify = null, conditionalVersion = null, planStepId = null, deferDispatch = false }) {
    const artifact = task.draft && this.db.prepare('SELECT * FROM artifacts WHERE task_id=? AND latest_digest=? ORDER BY created_at DESC LIMIT 1').get(task.id, effectDigest(task.draft.body));
    if (actionFamily === 'email.send' && artifact) effect = { ...effect, artifactId: artifact.id };
    const existing = this.ledger.byKey(key);
    if (existing?.status === 'verified') {
      if (existing.task_id !== task.id || existing.provider !== (provider.kind || provider.id) || existing.resource_id !== resourceId || effectDigest(parse(existing.effect_signature_json)) !== effectDigest(effect)) throw durableError('IDEMPOTENCY_CONFLICT', 'This execution key belongs to another operation.');
      return parse(existing.result_json);
    }
    if (existing && !['failed', 'cancelled'].includes(existing.status)) throw Object.assign(durableError('RECONCILIATION_REQUIRED', 'This external intent must be reconciled before retry.'), { ambiguous: true });
    let job, run, step, intent;
    try {
      void this.store.state; // Refresh the compatibility view before the short SQL transaction.
      this.database.atomic(() => {
        const attempt = this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE queue_name='effects' AND job_type='external_dispatch' AND json_extract(payload_json,'$.key')=?").get(key).n;
        const enqueued = this.jobs.enqueue({ queue: 'effects', type: 'external_dispatch', key: `${key}:attempt:${attempt}`, taskId: task.id, payload: { taskId: task.id, key } });
        job = this.jobs.claim(`${this.owner}:effect:${randomUUID()}`, { queue: 'effects', id: enqueued.id });
        if (!job) throw Object.assign(durableError('EXECUTION_BUSY', 'This external action is already running or awaiting recovery.'), { ambiguous: true });
        run = this.tasks.beginRun(job, { advanceGeneration: false });
        const current = this.tasks.get(task.id);
        if (this.flags().globalCoordination) {
          const providerId = provider.kind || provider.id || String(provider);
          const holder = current.situationId || `task:${current.id}`;
          const deadline = current.request?.deadline;
          const slot = effect?.startsAt && effect?.endsAt ? `${effect.startsAt}/${effect.endsAt}`
            : deadline?.iso && deadline.ambiguous !== true ? `deadline:${deadline.iso}:${resourceId}` : null;
          if (slot) {
            const time = this.coordination.claim({ kind: 'time', scopeKey: slot, situationId: holder, taskId: current.id });
            if (time.blocked) throw durableError('RESOURCE_CONTENTION', 'Another Situation holds this time.');
          }
          const reserved = this.coordination.claim({ kind: 'resource', scopeKey: `${providerId}:${resourceId}`, situationId: holder, taskId: current.id });
          if (reserved.blocked) throw durableError('RESOURCE_CONTENTION', 'Another Situation holds this resource.');
        }
        const expectedInputVersion = task.action?.inputVersion ?? task.inputVersion;
        if (expectedInputVersion !== current.inputVersion) throw durableError('TASK_DIRTY', 'The approved context changed. Review a refreshed action before sending.');
        const context = this.buildContext(current, run);
        if (!context.activation.activate && task.action?.permission !== 'user_approved' && !task.patchAuthorization) throw durableError('ACTIVATION_SUPPRESSED', 'An explicit user policy suppresses this task action.', 403);
        if (context.activation.requiresReview && task.action?.permission !== 'user_approved' && !task.patchAuthorization) throw durableError('REVIEW_REQUIRED', 'An explicit user policy requires review of this exact action.', 403);
        if (context.arbitration.conflicts.length && task.action?.permission !== 'user_approved' && !task.patchAuthorization) throw durableError('EXPERIENCE_CONFLICT', 'Conflicting guidance requires clarification before this action.');
        this.tasks.checkpoint(run, job, { expectedInputVersion: current.inputVersion, contextVersion: context.version, sources: context.sources, plan: { actionFamily, effect } });
        const selectedStep = planStepId || task.draft?.experienceTrial?.stepId;
        step = selectedStep ? this.db.prepare('SELECT * FROM plan_steps WHERE id=?').get(selectedStep) : this.experiences.step({ taskRunId: run.id, logicalStepId: key, stepKind: 'external_action', actionFamily, expectedEffect: effect });
        if (!step || selectedStep && effectDigest(parse(step.expected_effect_json)) !== effectDigest(effect)) throw durableError('PLAN_CHANGED', 'The approved Experience trial no longer matches this action.');
        if (step.status === 'proposed') this.experiences.transitionStep(step.id, 'proposed', 'approved');
        const authorize = () => this.gateway.authorize({ taskId: task.id, provider, tool, actionFamily, resourceId, key, payload, effect, conditionalVersion, patchAuthorization: task.patchAuthorization });
        intent = this.ledger.intent({ taskId: task.id, run, job, provider: provider.kind || provider.id || provider, tool, actionFamily, resourceId, key, effect, payload,
          conditionalVersion, providerIdempotent: provider.live === false || provider.nativeIdempotency === true, planStepId: step.id,
          expectedInputVersion, authorize });
        this.experiences.transitionStep(step.id, 'approved', 'executing');
      });
      this.noteObservation('external');
      const result = await this.ledger.dispatch(intent, { run, job, send, verify, deferDispatch });
      this.database.atomic(() => {
        if (verify) {
          this.experiences.transitionStep(step.id, 'executing', 'completed');
          this.tasks.finish(run, job);
        } else {
          // Provider acceptance still needs the engine's independent readback.
          this.tasks.assertRun(run, { job, allowDirty: true });
          this.db.prepare("UPDATE task_runs SET status='waiting',updated_at=? WHERE id=? AND status='running'").run(iso(this.database.now()), run.id);
        }
        this.jobs.complete(job);
      });
      return result;
    } catch (error) {
      const execution = this.ledger.byKey(key);
      if (!execution || execution.status === 'cancelled' || execution.status === 'failed' && execution.last_error_class === 'confirmed_absent') error.definitiveNoEffect = true;
      if (job && this.jobs.owns(job)) this.jobs.fail(job, error); throw error;
    }
  }
  normalizeLookup(key, provider, result) {
    const execution = this.ledger.byKey(key);
    if (execution && ['dispatched', 'accepted', 'unknown'].includes(execution.status) && result.status === 'not_found' && provider.live !== false && !provider.reliableAbsence && !provider.nativeIdempotency) return { status: 'unknown', receipt: null, detail: 'A search miss cannot prove the earlier write stopped. Manual reconciliation is required.' };
    return result;
  }
  verifiedAction(taskId, receipt) {
    const task = this.store.state.tasks[taskId], key = task?.action?.idempotencyKey;
    const execution = key && this.ledger.byKey(key);
    if (execution && !execution.privacy_redacted) {
      // Verification may be replayed after a crash before the task itself was
      // marked complete. Persist its attribution as one unit and reuse the
      // evidence already recorded for this exact external execution.
      this.database.atomic(() => {
        this.ledger.verified(execution.id, receipt);
        const step = execution.plan_step_id && this.db.prepare('SELECT * FROM plan_steps WHERE id=?').get(execution.plan_step_id);
        if (step?.status === 'executing') this.experiences.transitionStep(step.id, 'executing', 'completed');
        if (step && !this.db.prepare("SELECT 1 FROM feedback_events WHERE execution_id=? AND kind='supervised_success' AND plan_step_id=?").get(execution.id, step.id))
          this.experiences.feedback({ kind: 'supervised_success', taskId, executionId: execution.id, planStepId: step.id });
        const artifactId = parse(execution.effect_signature_json).artifactId;
        const artifact = artifactId && this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId);
        if (artifact) {
          this.db.prepare("UPDATE artifacts SET status='sent',updated_at=? WHERE id=?").run(iso(this.database.now()), artifact.id);
          if (!this.db.prepare("SELECT 1 FROM feedback_events WHERE execution_id=? AND kind='verified_consumption' AND artifact_id=?").get(execution.id, artifact.id))
            this.experiences.feedback({ kind: 'verified_consumption', taskId, executionId: execution.id, artifactId: artifact.id, consumption: { version: artifact.visible_version, digest: artifact.latest_digest } });
        }
      });
    }
  }
  confirmCurrentContext(taskId, receipt) {
    const task = this.store.state.tasks[taskId];
    if (!task || task.privacyInvalidated) return false;
    if (task.pendingCommitmentChange || task.action?.inputVersion == null || task.action.inputVersion === task.inputVersion) return true;
    this.store.mutate(state => {
      const current = state.tasks[taskId];
      current.actionHistory = [...(current.actionHistory || []), { ...current.action, status: 'verified_prior_context', receiptId: receipt.id, verifiedAt: iso(this.database.now()) }].slice(-50);
      current.action = null; current.draft = null; current.status = 'waiting_for_information';
      current.reason = 'The prior approved action was verified. New input requires a fresh plan and review.';
      current.reasoningWork = null; current.reasoningAttemptedFor = null;
    });
    this.scheduleTask(taskId, 'verified_prior_context'); this.engine.changed(); return false;
  }
  userFeedback(taskId, kind) {
    const steps = this.db.prepare(`SELECT s.* FROM plan_steps s JOIN task_runs r ON r.id=s.task_run_id WHERE r.task_id=?
      AND r.input_version=(SELECT input_version FROM tasks WHERE id=r.task_id) AND s.status IN ('proposed','approved','skipped') ORDER BY s.created_at DESC LIMIT 24`).all(taskId);
    return steps.map(step => this.experiences.feedback({ kind, taskId, planStepId: step.id }));
  }
  providerFor(execution) {
    if (['email.draft', 'notion.page.create', 'notes.note.create'].includes(execution.action_family)) return this.artifacts.recoveryProvider(execution);
    if (execution.action_family === 'document.patch') {
      if (execution.privacy_redacted) return null;
      const effect = parse(execution.effect_signature_json), document = this.store.state.documents[effect.documentId];
      const provider = execution.provider === 'local' ? this.engine.taskServices.localDocumentProvider : this.engine.documentProvider;
      if (!document || !effect.expectedContentDigest || !provider?.read) return null;
      return { lookup: async () => {
        const readback = await provider.read(document);
        const digest = createHash('sha256').update(String(readback.content).replace(/\r\n?/g, '\n')).digest('hex');
        return digest === effect.expectedContentDigest ? { status: 'found', receipt: { id: readback.revisionId || execution.id, provider: execution.provider, status: 'verified' } } : { status: 'unknown' };
      } };
    }
    const task = this.store.state.tasks[execution.task_id];
    const provider = typeof this.engine.provider.forSource === 'function' ? this.engine.provider.forSource(task?.sourceConnectorId || task?.request?.source?.connectorId || 'google') : this.engine.provider;
    return provider?.kind === execution.provider ? provider : null;
  }
  async reconcileExecution(id, { assertOwned = () => {} } = {}) {
    const execution = this.ledger.get(id); if (!execution) return;
    const result = await this.ledger.reconcile(id, this.providerFor(execution), { assertOwned });
    const current = this.ledger.get(id);
    if (result.status === 'found' && current && !current.privacy_redacted) {
      const task = this.tasks.get(current.task_id);
      if (task && !task.privacyInvalidated && current.action_family === 'email.send' && task.action?.idempotencyKey === current.idempotency_key) await this.engine.reconcile(task.id);
      if (task && !task.privacyInvalidated && current.action_family === 'document.patch') {
        this.store.mutateIfChanged(state => { for (const patch of Object.values(state.documentPatches || {})) if (patch.taskId === task.id && `patch:${patch.id}:${patch.baseDocument.version}` === current.idempotency_key && ['applying', 'uncertain'].includes(patch.status)) { patch.status = 'applied'; patch.result = { status: 'verified', applied: true, provider: current.provider, readbackVerified: true }; delete patch.writeAttemptId; } });
      }
      if (task && !task.privacyInvalidated && ['email.draft', 'notion.page.create', 'notes.note.create'].includes(current.action_family)) {
        const request = task.artifactRequests?.find(item => item.key === current.idempotency_key);
        if (request) this.artifacts.record(task.id, request.id, { status: 'verified', receipt: parse(current.result_json), error: null });
      }
      this.engine.changed();
    }
    if (result.status !== 'unknown') for (const request of this.db.prepare("SELECT id FROM privacy_requests WHERE state='pending' ORDER BY created_at LIMIT 100").all()) await this.privacy.finish(request.id);
    if (result.status === 'unknown') throw Object.assign(new Error('External reconciliation still requires provider confirmation.'), { status: 503 });
  }
  recoverPreparedDispatch(job, { recovering = false } = {}) {
    if (recovering) { const current = this.jobs.get(job.id); if (current?.state !== 'recovery_required' || current.lease_token !== job.lease_token) throw durableError('LEASE_LOST', 'The recovery state changed.'); }
    else this.jobs.assert(job);
    const execution = this.ledger.byKey(job.payload.key);
    if (execution) {
      if (['intent', 'dispatched', 'accepted', 'unknown'].includes(execution.status)) this.jobs.enqueue({ queue: 'effects', type: 'reconcile_execution', key: `prepared:${execution.id}`, taskId: execution.task_id, payload: { executionId: execution.id } });
      return;
    }
    // All shipped adapters commit an intent before dispatch. A queued dispatch
    // without that intent was interrupted before it could contact the provider.
    this.store.mutateIfChanged(state => {
      const task = state.tasks[job.task_id];
      if (!task || task.privacyInvalidated || task.control?.paused || ['cancelled', 'completed'].includes(task.status)) return;
      if (task.action?.idempotencyKey === job.payload.key && ['executing', 'uncertain'].includes(task.action.status)) {
        task.action.status = 'confirmed_absent'; task.status = 'blocked';
        task.reason = 'Interrupted before tool dispatch. Nothing was sent by this attempt; retry requires a separate user action.';
      }
      for (const patch of Object.values(state.documentPatches || {})) if (patch.taskId === task.id && `patch:${patch.id}:${patch.baseDocument.version}` === job.payload.key && ['applying', 'uncertain'].includes(patch.status)) {
        patch.status = 'prepared'; patch.result = { status: 'not_dispatched', applied: false }; delete patch.writeAttemptId;
      }
    });
    this.engine.changed();
  }
  async recover(job) {
    if (job.job_type === 'external_dispatch' && !this.ledger.byKey(job.payload.key)) this.recoverPreparedDispatch(job, { recovering: true });
    const executions = this.db.prepare("SELECT * FROM tool_executions WHERE job_id=? AND status IN ('intent','dispatched','accepted','unknown') AND is_write=1").all(job.id);
    for (const execution of executions) {
      if (execution.status === 'intent' && !execution.dispatched_at) this.database.atomic(() => {
        this.db.prepare("UPDATE tool_executions SET status='cancelled',payload_json=NULL,updated_at=? WHERE id=? AND status='intent'").run(iso(this.database.now()), execution.id);
        const claim = this.db.prepare('SELECT * FROM resource_claims WHERE current_execution_id=?').get(execution.id);
        if (claim) this.ledger.claims.release({ userId: claim.user_id, provider: claim.provider, resourceId: claim.resource_id, owner: claim.lease_owner, token: claim.lease_token, executionId: execution.id });
      });
      else {
        const result = await this.ledger.reconcile(execution.id, this.providerFor(execution));
        if (result.status === 'unknown') { this.jobs.deferRecovery(job.id, job.lease_token); return; }
      }
    }
    this.jobs.recover(job.id, () => ({ state: ['external_dispatch', 'privacy_reconcile', 'reconcile_execution'].includes(job.job_type) ? 'completed' : 'queued', safeToRepeat: true }));
  }
  async compile(summary, job) {
    if (this.generateExperience) return this.generateExperience(summary);
    if (this.engine.reasoner.compileExperiences?.bind && this.engine.reasoner.available()) return this.engine.reasoner.compileExperiences(summary, `compile:${job.id}`);
    // No compiler/model is required for P0. Absence never fabricates learning.
    return [];
  }
  ingestInstruction({ text, kind = 'fact', scopeType = 'global', scopeKey = '*', policy = null, identities = [] }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw durableError('INVALID_INSTRUCTION', 'An instruction needs 1–2,000 characters.', 400);
    if (kind === 'fact') { const memory = this.memory.put({ content: text.trim(), scopeType, scopeKey }); this.contextChanged(); return { status: 'saved', memory }; }
    if (kind !== 'policy') throw durableError('INVALID_INSTRUCTION', 'Choose a grounded memory or an explicit activation policy.', 400);
    if (!policy) {
      const address = text.match(/[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase();
      if (!address || !/prioriti[sz]e|优先/i.test(text)) return { status: 'needs_clarification', question: 'Specify an exact sender and supported policy effect before activating this instruction.' };
      policy = { predicate: { op: 'eq', feature: 'sender.identity', value: address }, effect: { type: 'priority', value: 90 } };
    }
    const saved = this.policies.save({ instruction: text, predicate: policy.predicate, effect: policy.effect, scopeType, scopeKey, identities, confirmed: policy.confirmed === true });
    this.contextChanged();
    return { status: saved.status === 'draft' ? 'needs_clarification' : 'saved', policy: saved,
      ...(saved.status === 'draft' ? { question: 'Confirm the exact provider mailbox before this rule can activate.' } : {}) };
  }
  editDraft(taskId, { body, reviewToken }) {
    const task = this.tasks.get(taskId);
    if (this.tasks.hasPendingSemantic(taskId) || task?.dirty || task?.inputVersion !== task?.processedInputVersion) throw durableError('REVIEW_CHANGED', 'New evidence is still being incorporated; refresh before editing.');
    const rebase = task?.draft?.userEdited && task.userDraftStale && task.status === 'waiting_for_information' && task.assessment?.complete
      && task.draft.documentId === task.documentId && this.store.state.documents?.[task.documentId]?.version === task.assessment.documentVersion
      && (!task.commitment?.status || task.commitment.status === 'active');
    if (!task?.draft || task.action || task.control?.paused || task.status !== 'ready_for_approval' && !rebase || task.privacyInvalidated) throw durableError('DRAFT_UNAVAILABLE', 'This draft cannot be edited in its current state.');
    if (typeof body !== 'string' || !body.trim() || body.length > 64000) throw durableError('INVALID_DRAFT', 'A draft needs 1–64,000 characters.', 400);
    if (draftReviewToken(task) !== reviewToken) throw durableError('REVIEW_CHANGED', 'The draft changed. Refresh before editing.');
    const artifacts = this.db.prepare('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at DESC').all(taskId);
    const artifact = artifacts.find(row => row.latest_digest === effectDigest(task.draft.body));
    this.database.atomic(() => {
      if (artifact) this.experiences.editedArtifact(artifact.id, { expectedVersion: artifact.visible_version, content: body, originalContent: task.draft.body });
      const current = this.tasks.get(taskId);
      this.tasks.update(taskId, current.stateVersion, data => {
        data.draft.body = body; data.draft.userEdited = true; delete data.draft.experienceTrial; data.guidanceReviewRequired = true;
        if (rebase) { delete data.yieldState; data.yieldResumedAt = iso(this.database.now()); data.draft.documentVersion = data.assessment.documentVersion; data.draft.requestVersion = Number(data.commitment?.revision || 1); data.userDraftStale = false; data.status = 'ready_for_approval'; }
        else data.yieldState = 'YIELDED_TO_USER';
      });
      const row = this.tasks.row(taskId);
      this.db.prepare('UPDATE tasks SET input_version=input_version+1,processed_input_version=input_version+1,version=version+1,dirty=0 WHERE id=? AND version=?').run(taskId, row.version);
    });
    this.store.refresh(); this.engine.changed(); return this.tasks.get(taskId);
  }
  async trial(experienceId, { taskId, reviewToken }) {
    const task = this.tasks.get(taskId), experience = this.experiences.get(experienceId);
    if (!task?.draft || task.action || task.control?.paused || !experience || !['candidate', 'active'].includes(experience.status) || experience.effect.type !== 'draft_format') throw durableError('TRIAL_UNAVAILABLE', 'A supervised format trial needs an available draft and a mechanical format candidate.');
    if (draftReviewToken(task) !== reviewToken) throw durableError('REVIEW_CHANGED', 'The draft changed before the supervised trial.');
    const job = this.jobs.enqueue({ type: 'experience_trial', taskId, key: `trial:${taskId}:${experienceId}:${experience.revision}:${reviewToken}`, payload: { taskId, experienceId, reviewToken } });
    this.kick(); await this.whenIdle();
    const result = this.jobs.get(job.id);
    if (result.state !== 'completed') throw durableError('TRIAL_FAILED', 'The trial could not prepare a current draft. Refresh before trying again.');
    return { trial: { id: job.id, state: result.state } };
  }
  async runTrial(job) {
    const task = this.tasks.get(job.task_id), experience = this.experiences.get(job.payload.experienceId);
    if (!task?.draft || task.action || draftReviewToken(task) !== job.payload.reviewToken || !experience || !['candidate', 'active'].includes(experience.status)) throw durableError('REVIEW_CHANGED', 'The reviewed trial context is no longer current.');
    const run = this.tasks.beginRun(job);
    const context = this.buildContext(this.tasks.get(task.id), run);
    if (!context.activation.activate || context.arbitration.conflicts.length) throw durableError('TRIAL_POLICY', 'Resolve the current policy or guidance conflict before a trial.');
    if (!context.experiences.some(record => record.id === experience.id) || experience.effect.type !== 'draft_format') throw durableError('TRIAL_SCOPE', 'The candidate does not apply to this task.');
    const original = task.draft.body;
    const format = experience.effect.format;
    const body = format === 'markdown' ? `## ${task.draft.subject}\n\n${original}`
      : format === 'table' ? `| Content |\n| --- |\n${original.split('\n').filter(Boolean).map(line => `| ${line.replaceAll('|', '\\|')} |`).join('\n')}`
        : format === 'json' ? JSON.stringify({ subject: task.draft.subject, body: original, documentUrl: task.draft.documentUrl }, null, 2) : original;
    const artifactId = randomUUID();
    const effect = { type: 'email_reply', artifactId, to: task.draft.to, documentId: task.documentId, bodyDigest: createHash('sha256').update(body).digest('hex') };
    const step = this.experiences.step({ taskRunId: run.id, logicalStepId: `trial:${experience.id}`, stepKind: 'draft_preparation', actionFamily: 'email.send', expectedEffect: effect,
      experiences: [{ id: experience.id, relation: 'user_confirmed' }] });
    this.store.mutate(state => {
      const current = state.tasks[task.id];
      if (draftReviewToken(current) !== job.payload.reviewToken) throw durableError('REVIEW_CHANGED', 'The draft changed during the trial.');
      current.draft = { ...current.draft, body, experienceTrial: { experienceId: experience.id, stepId: step.id } };
      current.guidanceReviewRequired = true; current.updatedAt = iso(this.database.now());
    });
    this.database.atomic(() => {
      const row = this.tasks.row(task.id);
      this.db.prepare('UPDATE tasks SET input_version=input_version+1,dirty=1,version=version+1 WHERE id=? AND version=?').run(task.id, row.version);
      this.database.lineage('experience', experience.id, 'task_run', run.id);
    });
    this.tasks.checkpoint(run, job, { expectedInputVersion: this.tasks.get(task.id).inputVersion, contextVersion: context.version, plan: { trial: experience.id, effect }, sources: [...context.sources, { kind: 'experience', id: experience.id }] });
    this.experiences.artifact({ id: artifactId, taskId: task.id, taskRunId: run.id, planStepId: step.id, content: body, version: task.draft.documentVersion || 1 });
    this.tasks.finish(run, job); this.store.refresh(); this.engine.changed();
  }
  modelChanged() {
    this.database.atomic(() => this.database.bump('model_version'));
    for (const task of Object.values(this.store.state.tasks)) this.scheduleTask(task.id, 'model_changed');
  }
  contextChanged() { this.memory.invalidate(); for (const task of Object.values(this.store.state.tasks)) this.scheduleTask(task.id, `context:${this.database.get('context_version')}`); }
  importUncertainActions() {
    this.database.atomic(() => {
      const at = iso(this.database.now());
      const add = ({ task, provider, tool, family, resource, key, effect, receiptId = null }) => {
        if (!key || this.ledger.byKey(key)) return;
        const prepared = this.db.prepare("SELECT 1 FROM jobs WHERE queue_name='effects' AND job_type='external_dispatch' AND state IN ('queued','retry_wait','running','recovery_required') AND json_extract(payload_json,'$.key')=?").get(key);
        if (prepared) return;
        const id = randomUUID();
        this.db.prepare(`INSERT INTO tool_executions(id,task_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,provider_receipt_id,input_version,run_generation,privacy_epoch,last_error_class,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'unknown',1,?,?,?,?,'legacy_interrupted',?,?)`).run(id, task.id, provider, tool, family, resource, key, json(effect), receiptId, task.inputVersion, task.runGeneration, task.privacyEpoch, at, at);
        this.database.lineage('task', task.id, 'execution', id);
        const claim = this.db.prepare('SELECT * FROM resource_claims WHERE user_id=? AND provider=? AND resource_id=?').get('local', provider, resource);
        if (!claim || claim.claim_state === 'free') {
          const held = this.ledger.claims.acquire({ provider, resourceId: resource, runId: null, owner: this.owner, executionId: id });
          this.ledger.claims.unresolved(held);
        }
        this.jobs.enqueue({ queue: 'effects', type: 'reconcile_execution', key: `import:${id}`, taskId: task.id, payload: { executionId: id } });
      };
      for (const task of Object.values(this.store.state.tasks)) {
        if (task.privacyInvalidated) continue;
        if (task.action && ['executing', 'accepted_live', 'uncertain'].includes(task.action.status)) {
          const provider = typeof this.engine.provider.forSource === 'function' ? this.engine.provider.forSource(task.sourceConnectorId || task.request?.source?.connectorId || 'google') : this.engine.provider;
          const message = this.store.state.inbox.find(item => item.id === task.sourceEmailId);
          add({ task, provider: provider?.kind || 'unavailable_mail', tool: 'send', family: 'email.send', resource: message?.threadId || `${task.draft?.to}:${task.draft?.subject}`, key: task.action.idempotencyKey, receiptId: task.action.receiptId,
            effect: { type: 'email_reply', to: task.draft?.to, documentId: task.documentId, bodyDigest: createHash('sha256').update(task.draft?.body || '').digest('hex') } });
        }
        for (const patch of Object.values(this.store.state.documentPatches || {})) if (patch.taskId === task.id && ['applying', 'uncertain'].includes(patch.status)) {
          const document = this.store.state.documents[patch.documentId || task.documentId];
          add({ task, provider: patch.provider, tool: 'apply_patch', family: 'document.patch', resource: document?.externalId || document?.id || task.documentId, key: `patch:${patch.id}:${patch.baseDocument.version}`,
            effect: { type: 'document_patch', documentId: document?.id || task.documentId, baseVersion: patch.baseDocument.version, changesDigest: createHash('sha256').update(JSON.stringify(patch.changes)).digest('hex') } });
        }
      }
    });
  }
  start() {
    this.importUncertainActions();
    this.ledger.recoverUnfinished();
    // Each process needs one fresh revalidation. Reusing the same completed
    // startup job across restarts can strand a previously unknown outcome even
    // after the provider becomes available again.
    for (const task of Object.values(this.store.state.tasks)) if (!task.privacyInvalidated && !task.control?.paused && !['completed', 'cancelled'].includes(task.status)) this.scheduleTask(task.id, `startup_revalidation:${this.owner}`);
    // Inbox commits precede processing: resume received events after a crash.
    for (const row of this.db.prepare("SELECT event_json FROM durable_inbox WHERE state='received'").all()) this.ingest(parse(row.event_json), event => this.engine.ingestLegacy(event));
    this.kick();
  }
  kick() {
    if (this.suspended || this.closed || this.pending) return;
    this.pending = Promise.resolve().then(async () => {
      this.database.atomic(() => { this.tasks.situations.expireDue(); this.coordination.releaseExpired(); });
      await this.inboxWorker.drain();
      await this.worker.drain();
      await this.effectsWorker.drain({ maxJobs: 8 });
      await this.privacyWorker.drain({ maxJobs: 8 });
      await this.learningWorker.drain({ maxJobs: 8 });
      const released = this.store.attention.releaseDue();
      if (released.length) {
        const deliveries = new Map(released.map(row => [row.dedupe_key, row]));
        this.store.mutate(state => { for (const notice of state.notifications || []) { const delivery = deliveries.get(notice.dedupeKey || notice.id); if (delivery) { notice.deliveryState = delivery.state; notice.notBefore = delivery.not_before; } } });
        this.engine.changed();
      }
    }).catch(() => { /* Jobs preserve bounded failure state; no raw provider errors are logged. */ }).finally(() => { this.pending = null; });
  }
  async whenIdle() { if (this.inWorker()) return; while (this.pending) await this.pending; }
  prepareSituation(situationId) {
    const situation = this.tasks.situations.get(situationId);
    if (!situation) throw durableError('MISSING_SITUATION', 'An active Situation is required.');
    const sources = this.db.prepare(`SELECT l.event_id id, e.material_signature version FROM event_situation_links l JOIN durable_inbox e ON e.id=l.event_id
      JOIN source_records s ON s.kind='event' AND s.id=e.id AND s.active=1 WHERE l.situation_id=? ORDER BY l.associated_at LIMIT 32`).all(situationId);
    return { situationId, situationVersion: situation.version, sources, missing: situation.closureCondition?.missingEvidence || [], stage: 'collect' };
  }
  notifyReady(situationId) {
    const prepared = this.prepareSituation(situationId);
    if (!this.flags().stagedReadiness) return { ready: false, reason: 'readiness_disabled', prepared };
    if (prepared.missing.length) return { ready: false, reason: 'missing_evidence', prepared };
    const tasks = this.db.prepare('SELECT id,data_json,status FROM tasks WHERE situation_id=?').all(situationId).map(row => ({ ...parse(row.data_json), id: row.id, status: row.status }));
    const block = tasks.map(task => readinessBlock(this.db, task, { claimsReady: true })).find(Boolean);
    if (block) return { ready: false, reason: block, prepared };
    if (this.db.prepare('SELECT 1 FROM artifacts WHERE situation_id=? AND stale=1 LIMIT 1').get(situationId)) return { ready: false, reason: 'artifact_stale', prepared };
    const fresh = this.db.prepare('SELECT 1 FROM artifacts WHERE situation_id=? AND stale=0 AND situation_version=? LIMIT 1').get(situationId, prepared.situationVersion);
    if (!fresh) return { ready: false, reason: 'not_synthesized', prepared };
    return { ready: true, reason: 'fresh', prepared, stage: 'synthesize' };
  }
  resumeYield(taskId, expectedVersion) {
    const task = this.tasks.get(taskId);
    if (!task || task.stateVersion !== expectedVersion || task.yieldState !== 'YIELDED_TO_USER') throw durableError('YIELD_CHANGED', 'The task is not yielded at this version.', 409);
    this.tasks.update(taskId, expectedVersion, data => { delete data.yieldState; data.yieldResumedAt = iso(this.database.now()); });
    this.scheduleTask(taskId, 'user_resume:explicit');
    return this.tasks.get(taskId);
  }
  noteUnobservedActivity(taskId) {
    const task = this.tasks.get(taskId);
    return { observed: false, telemetry: 'unavailable', action: 'compare_versions_only', draftPreserved: task?.draft?.body || null };
  }
  noteObservation(kind) {
    const key = kind === 'network' ? 'activation_network_calls' : 'activation_external_actions';
    this.database.atomic(() => this.database.set(key, String(Number(this.database.get(key, '0')) + 1)));
  }
  async backfill(connectorId, { limit = 20 } = {}) {
    if (typeof connectorId !== 'string' || !connectorId) throw durableError('INVALID_BACKFILL', 'A connector id is required.', 400);
    if (this.privacy.permissionRevoked(connectorId)) return { blocked: true, reason: 'permission_revoked', networkCalls: 0 };
    const cap = Math.max(1, Math.min(50, limit));
    const connector = this.connectorFor(connectorId);
    if (typeof connector?.listHistoricalEvents === 'function') {
      const discovered = await connector.listHistoricalEvents({ limit: cap });
      if (!discovered?.unavailable) {
        let ingested = 0;
        for (const event of (discovered.events || []).slice(0, cap)) {
          const providerEventId = event.providerEventId || event.payload?.id || event.id;
          if (this.db.prepare('SELECT 1 FROM durable_inbox WHERE id=? OR (provider=? AND provider_event_id=?)').get(event.id, connectorId, providerEventId)) continue;
          this.ingest(event, input => this.engine.ingestLegacy(input));
          ingested += 1;
        }
        const networkCalls = Number(discovered.networkCalls) || 0;
        for (let index = 0; index < networkCalls; index += 1) this.noteObservation('network');
        return { advanced: ingested, cursor: this.database.get(`backfill:${connectorId}`, ''), networkCalls, historyDiscovery: 'available' };
      }
    }
    const cursor = this.database.get(`backfill:${connectorId}`, '');
    const rows = this.db.prepare("SELECT received_at FROM durable_inbox WHERE provider=? AND state='processed' AND received_at>? ORDER BY received_at LIMIT ?").all(connectorId, cursor, cap);
    if (rows.length) this.database.atomic(() => this.database.set(`backfill:${connectorId}`, rows.at(-1).received_at));
    return { advanced: rows.length, cursor: this.database.get(`backfill:${connectorId}`, ''), networkCalls: 0, historyDiscovery: 'unavailable' };
  }
  activationMetrics(options) { return activationMetrics(this.database, options); }
  applyRsi(proposalId, expectedVersion) {
    if (!this.flags().boundedRsi) throw durableError('RSI_DISABLED', 'Bounded RSI is disabled.', 403);
    const proposal = this.rsi.get(proposalId);
    if (!proposal || proposal.version !== expectedVersion || proposal.status !== 'proposed') throw durableError('RSI_CHANGED', 'The proposal changed.');
    this.assertRsiValue(proposal.parameter, proposal.proposed);
    this.database.atomic(() => {
      this.rsi.transition(proposalId, expectedVersion, 'approved');
      this.applyRsiValue(proposal.parameter, proposal.proposed);
    });
    return this.rsi.get(proposalId);
  }
  rollbackRsi(proposalId, expectedVersion) {
    const current = this.rsi.get(proposalId);
    if (!current || current.version !== expectedVersion || current.status !== 'approved') throw durableError('RSI_CHANGED', 'The proposal changed.');
    this.assertRsiValue(current.parameter, current.previous);
    this.database.atomic(() => {
      this.rsi.transition(proposalId, expectedVersion, 'rolled_back');
      this.applyRsiValue(current.parameter, current.previous);
    });
    return this.rsi.get(proposalId);
  }
  assertRsiValue(parameter, value) {
    if (parameter === 'pairWindowMs' && (!Number.isInteger(value) || value < 3600000 || value > 14 * 86400000)) throw durableError('RSI_INVALID', 'Pair window is outside its allowed range.', 400);
    else if (parameter === 'maxPairCandidates' && (!Number.isInteger(value) || value < 1 || value > 10)) throw durableError('RSI_INVALID', 'Pair candidate limit is outside its allowed range.', 400);
    else if (parameter === 'maxInteractivePerHour' && (!Number.isInteger(value) || value < 0 || value > 20)) throw durableError('RSI_INVALID', 'Interactive budget is outside its allowed range.', 400);
    else if (parameter === 'minIntervalMs' && (!Number.isInteger(value) || value < 0 || value > 86400000)) throw durableError('RSI_INVALID', 'Minimum interval is outside its allowed range.', 400);
    else if (!['pairWindowMs', 'maxPairCandidates', 'maxInteractivePerHour', 'minIntervalMs'].includes(parameter)) throw durableError('RSI_FORBIDDEN', 'This parameter is outside the bounded RSI surface.', 403);
  }
  applyRsiValue(parameter, value) {
    this.assertRsiValue(parameter, value);
    if (parameter === 'pairWindowMs') {
      if (!Number.isFinite(value) || value < 3600000 || value > 14 * 86400000) throw durableError('RSI_INVALID', 'Pair window is outside its allowed range.', 400);
      this.unattachedWindowMs = value;
    } else if (parameter === 'maxPairCandidates') {
      if (!Number.isInteger(value) || value < 1 || value > 10) throw durableError('RSI_INVALID', 'Pair candidate limit is outside its allowed range.', 400);
      this.maxPairCandidates = value;
    } else if (parameter === 'maxInteractivePerHour') this.store.attention.configure({ maxInteractivePerHour: value });
    else if (parameter === 'minIntervalMs') this.store.attention.configure({ minIntervalMs: value });
    else throw durableError('RSI_FORBIDDEN', 'This parameter is outside the bounded RSI surface.', 403);
    const applied = parse(this.database.get('rsi_applied', '{}')) || {};
    applied[parameter] = value;
    this.database.atomic(() => this.database.set('rsi_applied', json(applied)));
  }
  describe() { return { version: '1.2', activationContract: '1.5.0', activityTelemetry: 'unavailable', flags: this.flags(), storage: this.database.describe(), jobs: this.jobs.list().map(({ payload_json, payload, ...job }) => job),
    executions: this.ledger.list(), deletion: this.db.prepare("SELECT id FROM privacy_requests WHERE state='pending' ORDER BY created_at LIMIT 100").all().map(row => this.privacy.get(row.id)), memory: this.memory.describe(), context: this.context.options, attention: this.store.attention.describe(), learning: { ...this.experiences.policy, active: this.experiences.list().filter(experience => experience.status === 'active').length, candidates: this.experiences.list().filter(experience => experience.status === 'candidate').length } }; }
  async close() { this.closed = true; clearInterval(this.timer); await this.whenIdle(); await Promise.all([this.inboxWorker.close(), this.worker.close(), this.effectsWorker.close(), this.learningWorker.close(), this.privacyWorker.close()]); }
}
