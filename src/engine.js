import {
  explainRequest, interpretRequestWithReasoner, recoverRequestCandidateWithReasoner,
  extractDeadline, extractRequiredContent, analyseRequest, hasRequestForm, isAutomatedSender, normaliseDateLocale
} from './requests.js';
import {
  commitmentScope, sameCommitment, requestRevisionSignature, isWithdrawalMessage,
  isRescheduleMessage, narrowCommitmentsByMessage, isTrustedThreadSender, unquotedMessageFields
} from './commitments.js';
import { rankCandidates } from './correlation.js';
import { criteriaToHumanStrings, missingLabels } from './criteria.js';
import { buildDeterministicPlan, applyModelProposals, checkpointPlan, restorePlan, PlanCache, planSignature } from './probes/plan.js';
import { assessPlan, completionFromCriteria } from './probes/assess.js';
import { PROVIDER_IDS, describeProviders } from './probes/providers.js';
import { STRATEGY_IDS } from './probes/strategies.js';
import { determineFreshness, runRecord, relevantRuns } from './freshness.js';
import { evidenceSignature, claim, unknownItem, sourceRef, evidenceItem } from './evidence.js';
import { PermissionPolicy, PermissionDeniedError } from './permissions.js';
import { SimulatedMailProvider, UncertainDeliveryError } from './providers.js';
import { validateEventPayload, EVENT_TYPES, REGISTRY_EVENT_TYPES } from './connectors/events.js';
import { createReasoner } from './reasoning.js';
import {
  notification, emitNotification, resolveNotifications, markRead, openNotifications, summarise, deadlineRisk
} from './notifications.js';
import {
  recordCalibration as recordCalibrationEntry, correctCalibration as correctCalibrationEntry,
  grantFor, permissionAnswerFor, scopeCovers, describeCalibration, calibrationQuestion, findCalibration, PERMISSION_KEYS, PREFERENCE_KEYS
} from './calibration.js';
import { normaliseDeadlines } from './store.js';
import { evaluateOpportunities, mergeOpportunities, openOpportunities } from './opportunities.js';
import { computeProductMetrics, summariseSources } from './metrics.js';
import { chooseVerificationDepth, compareAcrossSources, applySourceConflicts, CROSS_CHECK_LIMIT } from './verification.js';
import { traceEntry, appendTrace, explainDecision, summariseDecision } from './trace.js';
import { TaskServices } from './task-services.js';
import { projectWorkspaceTaskManagement } from './task-management.js';
import { draftReviewToken } from './draft-review.js';
import { REASONING_RECOVERY, reasoningFailure, reasoningMayResume } from './reasoning-recovery.js';
import { ingestAssignedIssue } from './external-work.js';

/**
 * The work engine.
 *
 * Pipeline, in order:
 *   event received -> normalized -> deduplicated -> context retrieved ->
 *   candidate work identified -> evidence assessed -> next action selected ->
 *   permissions checked -> action prepared or executed -> result verified
 *
 * Deterministic logic owns identity, deduplication, state transitions,
 * completeness comparison and permissions. Primary model mode interprets
 * requests before readiness; the model can never assert verified completion.
 */

const stamp = () => new Date().toISOString();
const setOwnRecord = (records, id, value) => {
  Object.defineProperty(records, id, { value, enumerable: true, configurable: true, writable: true });
};
const record = (state, kind, text, taskId = null, eventId = null) => {
  state.history.push({ id: `h-${state.history.length + 1}`, at: stamp(), kind, text, taskId, eventId });
};
const sourceTimestamp = (message, event) => {
  const raw = message?.receivedAt || event?.at || stamp();
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : stamp();
};
const requestSnapshot = request => ({
  intent: request?.intent || null,
  deliverable: request?.deliverable || null,
  subjectEntity: request?.subjectEntity || null,
  deadline: request?.deadline ? { ...request.deadline } : null,
  requiredContent: (request?.requiredContent || []).map(item => typeof item === 'string' ? item : ({ text: item.text, sourceQuote: item.sourceQuote || null })),
  deliveryRecipients: [...(request?.deliveryRecipients || [])],
  explicitDocumentUrl: request?.explicitDocumentUrl || null
});
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

/**
 * How long a request may sit with no observable progress before the
 * system stops waiting silently and puts the decision to the user. A day is
 * long enough that a normal back-and-forth is never interrupted, and short
 * enough that nothing is left waiting forever.
 */
const DEFAULT_STALL_AFTER_MS = 24 * 60 * 60 * 1000;

const describeDuration = ms => {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'less than an hour';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};

const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A calendar day as plain language: 2026-10-11 → “October 11, 2026”. */
function describeDay(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  if (!year || !month || !day) return iso;
  return `${MONTH_LABELS[month - 1]} ${day}, ${year}`;
}

/** A task is finished — completed, or closed by the user — and inert to new evidence. */
const isSettled = task => task.status === 'completed' || task.status === 'cancelled' || task.userDismissed === true;

/**
 * A document whose source says it was removed, trashed, or is inaccessible is
 * not current evidence. Historical copies may remain for audit, but ranking,
 * assessment, approval and retry all treat them as absent.
 */
const documentAvailable = document => Boolean(document) && document.available !== false;

/** Delivery progress follows requirements and blockers, independently of source revision churn. */
function progressSignature(task) {
  const evidence = task.evidence || {};
  return evidenceSignature({
    request: planSignature(task.request),
    criteria: (evidence.criteria || []).map(item => [item.id, item.required !== false, item.status, item.strength || null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    freshness: evidence.freshness?.status || null,
    blockers: (evidence.completion?.blockers || []).map(item => item.id).sort(),
    conflicts: (evidence.conflicts || []).map(item => [item.id, [...(item.contenders || [])].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    unverifiable: (evidence.plan?.unverifiable || []).map(item => item.text).sort()
  });
}

export function resolveDocumentLink(document, baseUrl) {
  if (document?.url && /^https?:\/\//i.test(document.url)) return document.url;
  if (document?.externalId && /^https?:\/\//i.test(document.externalId)) return document.externalId;
  return `${baseUrl}${document?.url || `/documents/${document?.id}`}`;
}

export class WorkEngine {
  constructor(store, {
    baseUrl = 'http://127.0.0.1:4173',
    provider = null,
    policy = new PermissionPolicy(),
    reasoner = null,
    documentProvider = null,
    mode = null,
    stallAfterMs = DEFAULT_STALL_AFTER_MS,
    dateLocale = null,
    onChange = () => {}
  } = {}) {
    this.store = store;
    this.baseUrl = baseUrl;
    this.provider = provider || new SimulatedMailProvider(store);
    this.documentProvider = documentProvider;
    this.policy = policy;
    this.reasoner = reasoner || createReasoner(process.env);
    this.mode = mode || store.state.mode || 'simulation';
    this.stallAfterMs = Number.isFinite(Number(stallAfterMs)) ? Math.max(0, Number(stallAfterMs)) : DEFAULT_STALL_AFTER_MS;
    // Numeric dates are read only from explicit configuration or a
    // stated user preference; never guessed from a machine or an IP address.
    this.dateLocale = normaliseDateLocale(dateLocale);
    // The last UTC day the periodic sweep refreshed time-driven conditions for.
    this.lastAttentionDay = null;
    this.onChange = onChange;
    this.pending = new Set();
    this.pendingReasoning = new Map();
    this.threadGenerations = new Map();
    this.pendingDiscovery = new Map();
    this.executingActions = new Set();
    this.planCache = new PlanCache();
    this.taskServices = new TaskServices(this, { documentProvider });
    this.recover();
  }

  /**
   * The date-reading format that governs new interpretation: the user's stated
   * preference first, then the process configuration.
   */
  #dateLocale(state = this.store.state) {
    const stated = findCalibration(state.calibrations || {}, PREFERENCE_KEYS.DATE_LOCALE);
    if (stated?.source === 'user_stated') {
      const fromUser = normaliseDateLocale(stated.value);
      if (fromUser) return fromUser;
    }
    return this.dateLocale;
  }

  changed() { this.onChange(this.publicState()); }

  /**
   * Track in-flight asynchronous work.
   *
   * The promise is recorded for `whenSettled()` in a form that never rejects, so
   * shutdown waits quietly. The original promise is returned unchanged so a
   * caller awaiting an asynchronous provider still sees real failures.
   */
  #track(value) {
    const promise = Promise.resolve(value);
    const observed = promise.catch(() => {}).finally(() => this.pending.delete(observed));
    this.pending.add(observed);
    return promise;
  }

  async whenSettled() {
    // Finishing one job can start another, such as a scoped send after model refinement.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Settle a provider call synchronously when the provider is synchronous. */
  #resolve(value, handler) {
    if (value && typeof value.then === 'function') return this.#track(Promise.resolve(value).then(handler));
    return handler(value);
  }

  publicState() {
    const state = this.store.state;
    const now = stamp();
    const taskValues = Object.values(state.tasks);
    const managementByTaskId = projectWorkspaceTaskManagement(taskValues, state, now);
    return {
      revision: state.revision,
      mode: this.mode,
      runtime: state.runtime,
      simulation: state.simulation,
      events: state.events.map(({ payload, ...event }) => event),
      tasks: taskValues.map(task => ({
        ...task,
        reviewToken: draftReviewToken(task),
        management: managementByTaskId.get(task.id)
      })),
      taskWaits: Object.values(state.taskWaits || {}),
      taskFeedbackRules: Object.values(state.taskFeedbackRules || {}),
      documentPatches: Object.values(state.documentPatches || {}),
      followUps: Object.values(state.followUps || {}),
      dependencyDecisions: Object.values(state.dependencyDecisions || {}),
      documents: Object.values(state.documents),
      runRecords: Object.values(state.runRecords || {}),
      inbox: state.inbox,
      outbox: state.outbox,
      history: [...state.history].reverse(),
      connectors: state.connectorStatus || {},
      cursors: state.cursors || {},
      // What the system is allowed to read, and how it reasons. Exposed so the
      // interface can show the reasoning surface rather than hide it.
      providers: describeProviders(),
      reasoner: typeof this.reasoner.status === 'function' ? this.reasoner.status() : { id: 'none', available: false },
      planCache: this.planCache.describe(),
      // What the system learned about the user, what needs a decision, how often
      // the user was interrupted, what it noticed, and how it is performing.
      // Exposed so the interface can show the reasoning surface.
      calibrations: Object.values(state.calibrations || {}),
      clarifications: (state.clarifications || []).filter(item => item.status === 'open'),
      notifications: openNotifications(state.notifications || []),
      opportunities: Object.values(state.opportunities || {}),
      misses: state.misses || [],
      attention: summarise(state.notifications || []),
      metrics: computeProductMetrics(state, { now }),
      // Which sources have been observed, how often they ask for work and by
      // which check their messages are declined — the source-level view of the
      // discovery gate, so "why is this source silent?" has an answer.
      sources: summariseSources(state),
      // A window on the decision trace. The full trace is available per task from
      // GET /api/trace, so the stream stays small.
      trace: (state.trace || []).slice(-40)
    };
  }

  /** The whole decision chain for one task, oldest first. */
  decisionTrace(taskId) {
    return {
      entries: explainDecision(this.store.state.trace || [], taskId),
      summary: summariseDecision(this.store.state.trace || [], taskId)
    };
  }

  /** Append one trace entry inside its own durable write. */
  #addTrace(entry) {
    this.store.mutate(state => { appendTrace(state.trace || (state.trace = []), entry); });
  }

  // ---------------------------------------------------------------- ingestion

  ingest(input) {
    if (!input?.type || !EVENT_TYPES.includes(input.type)) throw new Error('Invalid event type');
    const event = {
      id: input.id || `${input.connectorId || 'local'}:${input.providerEventId}`,
      type: input.type,
      at: input.at || stamp(),
      source: input.source || 'simulated',
      connectorId: input.connectorId || 'simulated',
      providerEventId: input.providerEventId || input.id || null,
      summary: '',
      relations: [],
      disposition: '',
      payload: input.payload
    };
    if (!event.id) throw new Error('Event requires an id');
    validateEventPayload(event);
    if (this.store.state.events.some(existing => existing.id === event.id)) return { duplicate: true, id: event.id };

    let result;
    if (event.type === 'email.received') result = this.#ingestEmail(event);
    else if (event.type === 'issue.updated') {
      result = ingestAssignedIssue(this.store, event);
      this.changed();
    }
    else if (event.type === 'document.modified') result = this.#ingestDocument(event);
    else if (event.type === 'document.unavailable') result = this.#ingestDocumentUnavailable(event);
    else if (REGISTRY_EVENT_TYPES.includes(event.type)) result = this.#ingestRunRecord(event);
    else throw new Error(`Unhandled event type: ${event.type}`);
    this.taskServices.processObservedEvent(event);
    return result;
  }

  #requestHistoryEntry(request, message, event, kind, revision, at = sourceTimestamp(message, event)) {
    return {
      revision,
      kind,
      at,
      sourceMessageId: message.id,
      sourceEventId: event.id,
      source: { threadId: message.threadId || null, from: message.from, to: message.to || null, subject: message.subject || '' },
      signature: requestRevisionSignature(request),
      request: requestSnapshot(request)
    };
  }

  #appendCommitmentSource(task, request, message, event, kind = 'duplicate') {
    const at = sourceTimestamp(message, event);
    const revision = Number(task.commitment?.revision || 1);
    task.commitment = task.commitment || commitmentScope(request || task.request, message);
    task.commitment.sourceMessageIds = [...new Set([...(task.commitment.sourceMessageIds || []), message.id])].slice(-100);
    const previousAt = Date.parse(task.commitment.lastSourceAt || '');
    if (!Number.isFinite(previousAt) || Date.parse(at) > previousAt) task.commitment.lastSourceAt = at;
    task.requestHistory = task.requestHistory || [];
    if (!task.requestHistory.some(item => item.sourceMessageId === message.id && item.kind === kind)) {
      task.requestHistory.push(this.#requestHistoryEntry(request || task.request, message, event, kind, revision, at));
      if (task.requestHistory.length > 100) task.requestHistory.splice(0, task.requestHistory.length - 100);
    }
  }

  #makeRequestTask(state, request, message, event) {
    const id = request.id || `request:${message.id}`;
    const canonicalRequest = { ...request, id };
    const at = sourceTimestamp(message, event);
    const commitment = commitmentScope(canonicalRequest, message);
    Object.assign(commitment, {
      sourceMessageIds: [message.id],
      revision: 1,
      signature: requestRevisionSignature(canonicalRequest),
      lastSourceAt: at,
      status: 'active'
    });
    state.tasks[id] = {
      id,
      status: 'newly_discovered',
      request: canonicalRequest,
      commitment,
      requestHistory: [this.#requestHistoryEntry(canonicalRequest, message, event, 'initial', 1, at)],
      sourceEmailId: message.id,
      sourceConnectorId: event.connectorId,
      sender: message.from,
      subject: message.subject,
      createdAt: stamp(),
      updatedAt: stamp(),
      actionVersion: 0,
      actionHistory: [],
      pendingCommitmentChange: null,
      reasoningWork: null,
      documentId: null,
      progress: null,
      evidence: null,
      assessment: null,
      draft: null,
      action: null,
      reason: null
    };
    record(state, 'discovery',
      `Discovered a request to ${canonicalRequest.intent.replaceAll('_', ' ')} the ${canonicalRequest.subjectEntity} ${canonicalRequest.deliverable} in an incoming email.`,
      id, event.id);
    appendTrace(state.trace, traceEntry({
      stage: 'discovery', taskId: id, eventId: event.id,
      input: { eventType: event.type, source: event.source, messageId: message.id, threadId: message.threadId || null },
      reasoning: {
        interpretedBy: canonicalRequest.interpretedBy,
        entity: canonicalRequest.subjectEntity,
        deliverable: canonicalRequest.deliverable,
        intent: canonicalRequest.intent,
        requiredContent: (canonicalRequest.requiredContent || []).map(item => item.text)
      },
      outcome: { taskId: id, status: 'newly_discovered', commitmentKey: commitment.key }
    }));
    return state.tasks[id];
  }

  #reviseCommitment(task, request, message, event, kind = 'revision') {
    const at = sourceTimestamp(message, event);
    const oldRevision = Number(task.commitment?.revision || 1);
    const nextRevision = oldRevision + 1;
    const latestRequest = { ...request, id: task.id };
    const oldSignature = requestRevisionSignature(task.request);
    const nextSignature = requestRevisionSignature(latestRequest);
    const activeAction = task.action && ['executing', 'uncertain', 'accepted_live'].includes(task.action.status);

    if (activeAction) {
      task.pendingCommitmentChange = {
        revision: nextRevision,
        withdrawn: false,
        at,
        sourceMessageId: message.id,
        previousSignature: oldSignature,
        nextSignature
      };
      task.action.pendingCommitmentRevision = nextRevision;
      task.actionVersion = Number(task.actionVersion || 0) + 1;
    } else if (task.action) {
      task.actionHistory = task.actionHistory || [];
      task.actionHistory.push({ ...task.action, archivedAt: stamp(), archiveReason: 'request revised' });
      if (task.actionHistory.length > 50) task.actionHistory.splice(0, task.actionHistory.length - 50);
      task.action = null;
      task.actionVersion = Number(task.actionVersion || 0) + 1;
      task.pendingCommitmentChange = null;
    }

    task.requestHistory = task.requestHistory || [];
    task.requestHistory.push(this.#requestHistoryEntry(task.request, message, event, 'superseded', oldRevision, at));
    task.request = latestRequest;
    task.commitment = task.commitment || commitmentScope(latestRequest, message);
    task.commitment.revision = nextRevision;
    task.commitment.signature = nextSignature;
    task.commitment.status = activeAction ? 'revision_pending_reconciliation' : 'active';
    task.commitment.lastSourceAt = at;
    task.commitment.sourceMessageIds = [...new Set([...(task.commitment.sourceMessageIds || []), message.id])].slice(-100);
    task.requestHistory.push(this.#requestHistoryEntry(latestRequest, message, event, kind, nextRevision, at));
    if (task.requestHistory.length > 100) task.requestHistory.splice(0, task.requestHistory.length - 100);
    task.actionVersion = Number(task.actionVersion || 0) + 1;
    task.updatedAt = stamp();
    task.draft = null;
    task.evidence = null;
    task.assessment = null;
    task.progress = null;
    task.reason = activeAction ? 'The request changed while an approved action may still be in progress; reconcile that action before continuing.' : null;
    task.userDismissed = false;
    task.reasoningPlan = null;
    task.reasoningAttemptedFor = null;
    task.reasoning = null;
    this.#supersedeReasoning(task, 'request_revised');
    if (!activeAction) task.status = 'newly_discovered';
    record(this.store.state, 'request_revision',
      `The same thread and delivery scope revised this request (${kind}); revision ${nextRevision} replaced the old draft and invalidated its action version.`, task.id, event.id);
    return !activeAction;
  }

  #withdrawCommitment(task, message, event) {
    const at = sourceTimestamp(message, event);
    const revision = Number(task.commitment?.revision || 1) + 1;
    const oldSignature = requestRevisionSignature(task.request);
    const pending = task.action && ['executing', 'uncertain', 'accepted_live'].includes(task.action.status);
    this.#appendCommitmentSource(task, task.request, message, event, 'withdrawal');
    task.commitment.revision = revision;
    task.commitment.signature = oldSignature;
    task.commitment.lastSourceAt = at;
    task.commitment.status = pending ? 'withdrawn_pending_reconciliation' : 'withdrawn';
    task.actionVersion = Number(task.actionVersion || 0) + 1;
    task.draft = null;
    task.reasoningPlan = null;
    task.reasoningAttemptedFor = null;
    this.#supersedeReasoning(task, 'request_withdrawn');
    if (pending) {
      task.pendingCommitmentChange = { revision, withdrawn: true, at, sourceMessageId: message.id, previousSignature: oldSignature };
      task.action.pendingCommitmentRevision = revision;
      task.reason = 'The trusted sender withdrew the request while an approved action may already be in progress. The outcome must be reconciled; the system will not claim that an in-flight send was undone.';
      task.status = task.action.status === 'uncertain' || task.action.status === 'accepted_live' ? 'blocked' : 'verifying';
    } else {
      if (task.action && task.action.status !== 'verified_live' && task.action.status !== 'verified_simulated') {
        task.actionHistory = task.actionHistory || [];
        task.actionHistory.push({ ...task.action, archivedAt: stamp(), archiveReason: 'request withdrawn before delivery was confirmed' });
        task.action = null;
      }
      task.pendingCommitmentChange = null;
      task.status = 'cancelled';
      task.userDismissed = false;
      task.reason = task.action
        ? 'The request was withdrawn after the approved action had already been verified. That action was not undone; no further work will run.'
        : 'The trusted sender withdrew this request. No further work will run.';
    }
    task.updatedAt = stamp();
    task.requestHistory = task.requestHistory || [];
    task.requestHistory.push(this.#requestHistoryEntry(task.request, message, event, 'withdrawal', revision, at));
    if (task.requestHistory.length > 100) task.requestHistory.splice(0, task.requestHistory.length - 100);
    record(this.store.state, 'request_withdrawal', pending
      ? 'The trusted sender withdrew the request while an approved action may be in flight; preserving the action for reconciliation.'
      : task.action
        ? 'The trusted sender withdrew a request whose action was already verified; the sent action remains in history and will not be represented as undone.'
        : 'The trusted sender withdrew the request; its draft and any unsent action were invalidated.', task.id, event.id);
  }

  #amendedRequest(task, message, event, { deadline = null, content = null } = {}) {
    const text = `${task.request.text || ''}\n${message.subject || ''}\n${message.body || ''}`.trim();
    const request = {
      ...task.request,
      text,
      source: { ...task.request.source, id: message.id, threadId: message.threadId || task.commitment?.threadId || null, receivedAt: message.receivedAt || task.request.source?.receivedAt || null },
      ...(deadline ? { deadline } : {}),
      ...(content ? { requiredContent: content } : {})
    };
    request.analysis = analyseRequest({
      text,
      deliverable: request.deliverable,
      subjectEntity: request.subjectEntity,
      intent: request.intent,
      requiredContent: request.requiredContent,
      deadline: request.deadline,
      impliedClaims: request.impliedClaims || []
    });
    request.qualifiers = request.analysis.qualifiers;
    return request;
  }

  #ingestEmail(event) {
    const message = event.payload;
    const sourceAt = sourceTimestamp(message, event);
    const threadKey = message.threadId ? String(message.threadId) : `message:${message.id}`;
    const generation = (this.threadGenerations.get(threadKey) || 0) + 1;
    this.threadGenerations.set(threadKey, generation);
    const { request, rejection } = explainRequest(message, { dateLocale: this.#dateLocale() });
    const activeMessage = unquotedMessageFields(message);
    const activeText = `${activeMessage.subject}\n${activeMessage.body}`;
    const state = this.store.state;
    let taskToAssess = null;
    let allowAutomation = true;
    let shouldReason = false;
    let shouldRecoverDiscovery = false;
    let selected = null;
    const trusted = Object.values(state.tasks || {}).filter(task => isTrustedThreadSender(task, message));
    const namedTrusted = narrowCommitmentsByMessage(trusted, message);
    const directiveCandidates = namedTrusted.length ? namedTrusted : trusted;
    const withdrawalTarget = isWithdrawalMessage(message) && directiveCandidates.length === 1 ? directiveCandidates[0] : null;
    const reschedule = isRescheduleMessage(message) && directiveCandidates.length === 1 && !request
      ? extractDeadline(activeText, { now: message.receivedAt || event.at, dateLocale: this.#dateLocale() })
      : null;
    const supplementContent = !request && directiveCandidates.length === 1 &&
      /\b(?:add|include|incorporate|supplement|also\s+need)\b|(?:补充|補充|添加|增加|加入|纳入|納入)/u.test(activeText)
      ? extractRequiredContent(activeText)
      : [];
    const matchCandidates = request
      ? Object.values(state.tasks || {}).filter(task => sameCommitment(task.request, request))
      : [];
    const feedbackMatches = request ? this.taskServices.matchingFeedbackRules({ request, message }) : [];
    const feedbackSuppress = feedbackMatches.find(item => item.effect === 'suppress_scoped_candidate');
    const feedbackHandled = feedbackMatches.find(item => item.effect === 'ignore_as_already_handled');
    const feedbackDuplicate = feedbackMatches.find(item => item.effect === 'associate_with_existing_task');
    selected = matchCandidates.length === 1 ? matchCandidates[0] : null;

    this.store.mutate(current => {
      current.events.push(event);
      if (!current.inbox.some(item => item.id === message.id)) current.inbox.push({ ...message, connectorId: event.connectorId, source: event.source });
      event.summary = `Email received · ${message.subject}`;

      if (withdrawalTarget) {
        const latestAt = Date.parse(withdrawalTarget.commitment?.lastSourceAt || '');
        if (Number.isFinite(latestAt) && Date.parse(sourceAt) < latestAt) {
          event.disposition = 'stale_change';
          event.relations = [withdrawalTarget.id];
          event.rejection = { code: 'stale_thread_message', detail: 'This withdrawal predates a newer message in the same thread, so the newer request state was kept.' };
          record(current, 'observation', event.rejection.detail, withdrawalTarget.id, event.id);
        } else {
          this.#withdrawCommitment(current.tasks[withdrawalTarget.id], message, event);
          event.disposition = 'request_withdrawn';
          event.relations = [withdrawalTarget.id];
        }
        return;
      }

      if (request && feedbackSuppress) {
        event.disposition = 'suppressed_by_feedback';
        event.feedbackRuleId = feedbackSuppress.rule.id;
        event.rejection = { code: 'user_scope_correction', detail: feedbackSuppress.rule.reason || 'A reversible user correction suppresses this exact sender/thread scope.' };
        record(current, 'feedback_applied', `A reversible user correction suppressed this request candidate within its exact scope (${feedbackSuppress.rule.id}).`, feedbackSuppress.rule.taskId, event.id);
        return;
      }

      if (request && feedbackHandled) {
        event.disposition = 'already_handled';
        event.relations = feedbackHandled.targetTaskId ? [feedbackHandled.targetTaskId] : [];
        event.feedbackRuleId = feedbackHandled.rule.id;
        event.rejection = { code: 'user_marked_already_handled', detail: feedbackHandled.rule.reason || 'The user marked this exact scope as already handled.' };
        record(current, 'feedback_applied', `A reversible user correction marked this scoped candidate already handled (${feedbackHandled.rule.id}); no new work was created.`, feedbackHandled.rule.taskId, event.id);
        return;
      }

      if (request && feedbackDuplicate) {
        const target = current.tasks[feedbackDuplicate.targetTaskId];
        if (target && !isSettled(target)) {
          this.#appendCommitmentSource(target, request, message, event, 'feedback_duplicate');
          event.disposition = 'duplicate_request';
          event.relations = [target.id];
          event.feedbackRuleId = feedbackDuplicate.rule.id;
          record(current, 'feedback_applied', `A reversible user correction associated this candidate with existing task ${target.id} (${feedbackDuplicate.rule.id}).`, target.id, event.id);
          return;
        }
      }

      if (reschedule && directiveCandidates.length === 1) {
        const target = current.tasks[directiveCandidates[0].id];
        const latestAt = Date.parse(target.commitment?.lastSourceAt || '');
        if (Number.isFinite(latestAt) && Date.parse(sourceAt) < latestAt) {
          event.disposition = 'stale_change';
          event.relations = [target.id];
          event.rejection = { code: 'stale_thread_message', detail: 'This deadline change predates a newer message in the same thread, so the newer request state was kept.' };
          record(current, 'observation', event.rejection.detail, target.id, event.id);
        } else {
          const amended = this.#amendedRequest(target, message, event, { deadline: reschedule });
          taskToAssess = this.#reviseCommitment(target, amended, message, event, 'deadline_change') ? target.id : null;
          allowAutomation = false;
          event.disposition = 'request_revision';
          event.relations = [target.id];
        }
        return;
      }

      if (supplementContent.length && directiveCandidates.length === 1) {
        const target = current.tasks[directiveCandidates[0].id];
        const latestAt = Date.parse(target.commitment?.lastSourceAt || '');
        if (Number.isFinite(latestAt) && Date.parse(sourceAt) < latestAt) {
          event.disposition = 'stale_change';
          event.relations = [target.id];
          event.rejection = { code: 'stale_thread_message', detail: 'This supplement predates a newer message in the same thread, so the newer request state was kept.' };
          record(current, 'observation', event.rejection.detail, target.id, event.id);
        } else {
          const combined = [...(target.request.requiredContent || []), ...supplementContent];
          const content = [...new Map(combined.map(item => [String(item.text || item).toLowerCase(), item])).values()];
          const amended = this.#amendedRequest(target, message, event, { content });
          taskToAssess = this.#reviseCommitment(target, amended, message, event, 'requirement_supplement') ? target.id : null;
          allowAutomation = false;
          event.disposition = 'request_revision';
          event.relations = [target.id];
        }
        return;
      }

      if (!request) {
        event.disposition = 'context_only';
        event.rejection = rejection || { code: 'unknown', detail: 'No request was identified.' };
        if (trusted.length > 1 && (isWithdrawalMessage(message) || isRescheduleMessage(message))) {
          event.rejection = { code: 'ambiguous_thread_update', detail: 'This trusted thread update could apply to more than one open commitment; none was changed.' };
        }
        event.reasoning = { status: 'not_started', kind: 'discovery_candidate', attempts: 0, maxAttempts: 2 };
        record(current, 'observation',
          `Observed an email and did not treat it as a request: ${event.rejection.detail}`, null, event.id);
        shouldRecoverDiscovery = Boolean(
          this.reasoner?.available?.() && !isAutomatedSender(message.from) && hasRequestForm(activeText) &&
          ['no_deliverable', 'no_request_verb', 'no_entity', 'deliverable_not_requested'].includes(event.rejection.code)
        );
        return;
      }

      if (matchCandidates.length > 1) {
        event.disposition = 'context_only';
        event.rejection = { code: 'ambiguous_commitment', detail: 'This request could match more than one delivery scope in the thread; no task was merged or duplicated.' };
        record(current, 'observation', event.rejection.detail, null, event.id);
        return;
      }

      if (selected) {
        const target = current.tasks[selected.id];
        const latestAt = Date.parse(target.commitment?.lastSourceAt || '');
        if (Number.isFinite(latestAt) && Date.parse(sourceAt) < latestAt) {
          event.disposition = 'stale_change';
          event.relations = [target.id];
          event.rejection = { code: 'stale_thread_message', detail: 'This request predates a newer message in the same thread, so the newer request state was kept.' };
          record(current, 'observation', event.rejection.detail, target.id, event.id);
          return;
        }
        event.relations = [target.id];
        const nextSignature = requestRevisionSignature(request);
        if (nextSignature === requestRevisionSignature(target.request)) {
          this.#appendCommitmentSource(target, request, message, event, 'duplicate');
          event.disposition = 'duplicate_request';
          record(current, 'duplicate_request', 'A repeated message from the same sender names the same thread, deliverable and delivery participants; it was attached to the existing commitment.', target.id, event.id);
          return;
        }
        taskToAssess = this.#reviseCommitment(target, request, message, event, 'request_revision') ? target.id : null;
        allowAutomation = false;
        event.disposition = 'request_revision';
        return;
      }

      const task = this.#makeRequestTask(current, request, message, event);
      event.disposition = 'discovered_request';
      event.relations = [task.id];
      taskToAssess = task.id;
      shouldReason = true;
    });

    if (taskToAssess) {
      this.assess(taskToAssess, event.id, { force: true, allowAutomation });
      const needsPrimaryReview = this.reasoner.preferModelInterpretation && this.#primaryReviewMissing(this.store.state.tasks[taskToAssess]);
      const reviewMessage = shouldReason ? message : this.#taskSourceMessage(this.store.state.tasks[taskToAssess]) || message;
      if ((shouldReason || needsPrimaryReview) && !this.#maybeRefineWithModel(taskToAssess, reviewMessage)) this.#maybeProposeProbes(taskToAssess);
      if (!shouldReason && allowAutomation === false) this.#maybeProposeProbes(taskToAssess);
    }
    this.changed();
    if (shouldRecoverDiscovery) this.#maybeRecoverUnrecognizedMessage(event, generation);
    return { duplicate: false, id: event.id, disposition: event.disposition, relations: event.relations };
  }

  #isLatestThreadMessage(message) {
    if (!message?.threadId) return true;
    const latest = (this.store.state.inbox || []).filter(item => item.threadId === message.threadId).at(-1);
    return latest?.id === message.id;
  }

  #maybeRecoverUnrecognizedMessage(event, generation = null, { now = Date.now(), dueOnly = false } = {}) {
    if (!this.reasoner?.available?.()) return false;
    if (this.pendingDiscovery.has(event.id)) return false;
    const message = event.payload;
    const threadKey = message.threadId ? String(message.threadId) : `message:${message.id}`;
    const currentGeneration = generation ?? this.threadGenerations.get(threadKey) ?? 0;
    const storedEvent = this.store.state.events.find(item => item.id === event.id);
    if (!storedEvent || !['not_started', 'pending', 'running', 'failed'].includes(storedEvent.reasoning?.status)) return false;
    const work = storedEvent.reasoning;
    if (work.status === 'failed' && !reasoningMayResume(work, now, { automatic: dueOnly })) return false;
    const maxAttempts = Math.max(1, Math.min(2, Number(work.maxAttempts) || 2));
    const attempts = Math.max(0, Number(work.attempts) || 0);
    if (attempts >= maxAttempts) return false;
    const attempt = attempts + 1;
    const requestId = `${event.id}:discover-attempt:${attempt}`;
    this.store.mutate(state => {
      const target = state.events.find(item => item.id === event.id);
      if (!target) return;
      target.reasoning = { ...target.reasoning, status: 'running', attempts: attempt, maxAttempts, startedAt: stamp(), lastError: null, retryAt: null, terminalReason: null };
    });
    this.changed();

    let failure = null;
    const pending = recoverRequestCandidateWithReasoner(message, this.reasoner, {
      dateLocale: this.#dateLocale(),
      onError: error => { failure = error; }
    }).then(request => {
      const current = this.store.state.events.find(item => item.id === event.id);
      if (!current || current.reasoning?.status !== 'running' || current.reasoning.attempts !== attempt) return;
      const latestGeneration = this.threadGenerations.get(threadKey) ?? currentGeneration;
      if (latestGeneration !== currentGeneration || !this.#isLatestThreadMessage(message)) {
        this.store.mutate(state => {
          const target = state.events.find(item => item.id === event.id);
          if (target?.reasoning?.attempts === attempt) {
            target.reasoning = { ...target.reasoning, status: 'superseded', finishedAt: stamp(), detail: 'A newer message arrived before this candidate interpretation completed; the old result was discarded.' };
            record(state, 'reasoning_discarded', 'A model discovery result was discarded because a newer message arrived in the same thread first.', null, event.id);
          }
        });
        this.changed();
        return;
      }
      if (!request) {
        this.store.mutate(state => {
          const target = state.events.find(item => item.id === event.id);
          if (!target) return;
          target.reasoning = {
            ...target.reasoning,
            status: failure ? 'failed' : 'no_candidate',
            finishedAt: stamp(),
            lastError: failure?.message || null,
            ...(failure ? reasoningFailure(failure, { attempts: attempt, maxAttempts }) : {}),
            detail: failure
              ? `Grounded discovery did not complete (${failure.message}); no task was created.`
              : 'No candidate could be fully anchored in the original message; no task was created.'
          };
          record(state, failure ? 'reasoning_failure' : 'reasoning', target.reasoning.detail, null, event.id);
        });
        this.changed();
        return;
      }

      let taskId = null;
      let assess = false;
      let allowAutomation = false;
      this.store.mutate(state => {
        const targetEvent = state.events.find(item => item.id === event.id);
        if (!targetEvent) return;
        const existing = Object.values(state.tasks).filter(task => sameCommitment(task.request, request));
        if (existing.length > 1) {
          targetEvent.disposition = 'context_only';
          targetEvent.rejection = { code: 'ambiguous_commitment', detail: 'The grounded request matches more than one delivery scope; no task was merged or created.' };
          targetEvent.reasoning = { ...targetEvent.reasoning, status: 'no_candidate', finishedAt: stamp(), detail: targetEvent.rejection.detail };
          return;
        }
        if (existing.length === 1) {
          const task = state.tasks[existing[0].id];
          targetEvent.relations = [task.id];
          if (requestRevisionSignature(task.request) === requestRevisionSignature(request)) {
            this.#appendCommitmentSource(task, request, message, event, 'duplicate');
            targetEvent.disposition = 'duplicate_request';
          } else {
            assess = this.#reviseCommitment(task, request, message, event, 'grounded_model_revision');
            taskId = assess ? task.id : null;
            targetEvent.disposition = 'request_revision';
          }
        } else {
          const task = this.#makeRequestTask(state, request, message, event);
          taskId = task.id;
          assess = true;
          targetEvent.disposition = 'discovered_request';
          targetEvent.relations = [task.id];
        }
        targetEvent.reasoning = { ...targetEvent.reasoning, status: 'accepted', finishedAt: stamp(), acceptedTaskId: targetEvent.relations?.[0] || taskId, detail: 'A candidate was accepted only after every identity and action field was anchored in the original message.' };
        record(state, 'grounded_discovery', targetEvent.reasoning.detail, taskId || targetEvent.relations?.[0] || null, event.id);
      });
      if (taskId && assess) {
        this.assess(taskId, event.id, { force: true, allowAutomation });
        this.#maybeProposeProbes(taskId);
      }
      this.changed();
    }).catch(error => {
      this.store.mutate(state => {
        const target = state.events.find(item => item.id === event.id);
        if (!target) return;
        target.reasoning = { ...target.reasoning, status: 'failed', finishedAt: stamp(), lastError: error.message, detail: `Grounded discovery failed (${error.message}); no task was created.` };
        record(state, 'reasoning_failure', target.reasoning.detail, null, event.id);
      });
      this.changed();
    });
    this.pendingDiscovery.set(event.id, pending);
    pending.then(() => { if (this.pendingDiscovery.get(event.id) === pending) this.pendingDiscovery.delete(event.id); });
    this.#track(pending);
    return true;
  }

  #ingestDocument(event) {
    const doc = event.payload;
    const docId = String(doc.id);
    const stored = this.store.state.documents[docId];
    const incomingAt = Date.parse(doc.modifiedAt || event.at || '');
    const storedAt = Date.parse(stored?.modifiedAt || stored?.observedAt || '');
    if (stored && Number.isFinite(incomingAt) && Number.isFinite(storedAt) && incomingAt < storedAt) {
      // Out-of-order arrival: an older revision must never overwrite newer
      // state, or evidence a task was already verified against would appear to
      // regress. The event is recorded and nothing is reassessed.
      this.store.mutate(state => {
        state.events.push(event);
        event.summary = `Stale revision of ${doc.title} · kept the newer version`;
        event.disposition = 'stale_change';
        event.relations = [];
        record(state, 'observation',
          `An older version of "${doc.title}" arrived after a newer one; the newer version was kept and nothing was reassessed.`, null, event.id);
      });
      this.changed();
      return { duplicate: false, id: event.id, disposition: 'stale_change', relations: [] };
    }
    this.store.mutate(state => {
      const previous = state.documents[docId];
      setOwnRecord(state.documents, docId, {
        id: docId,
        title: doc.title,
        kind: doc.kind || 'document',
        content: doc.content,
        url: doc.url || `/documents/${docId}`,
        externalId: doc.externalId || null,
        modifiedAt: doc.modifiedAt || event.at || stamp(),
        observedAt: event.at || stamp(),
        version: (previous?.version || 0) + 1,
        source: event.source,
        available: true,
        unavailableReason: null,
        unavailableAt: null
      });
      state.events.push(event);
      event.summary = `Document changed · ${doc.title}`;
      const related = Object.values(state.tasks).filter(task =>
        !isSettled(task) && !this.#documentExcludedByFeedback(task, docId) &&
        rankCandidates(task.request, Object.fromEntries([[docId, state.documents[docId]]])).best);
      event.relations = related.map(task => task.id);
      event.disposition = related.length ? 'related_change'
        : Object.keys(state.tasks).length ? 'unrelated_change' : 'context_only';
      record(state, 'observation', related.length
        ? `A changed document matches ${related.map(task => task.request.subjectEntity).join(', ')}; checking its actual content.`
        : 'Observed a document edit, but it does not match an outstanding request.', null, event.id);
    });
    for (const taskId of event.relations) this.assess(taskId, event.id);
    this.changed();
    return { duplicate: false, id: event.id, disposition: event.disposition, relations: event.relations };
  }

  /**
   * A document left the readable view: removed, trashed, or access revoked.
   *
   * The local copy is kept for audit but marked unavailable, so no assessment,
   * approval, retry or pre-authorised action can use it as current evidence.
   * Nothing is deleted, and no claim is made about *why* the provider stopped
   * returning it beyond the reason the provider gave.
   */
  #ingestDocumentUnavailable(event) {
    const doc = event.payload;
    const docId = String(doc.id);
    const previous = this.store.state.documents[docId];
    const incomingAt = Date.parse(doc.modifiedAt || event.at || '');
    const storedAt = Date.parse(previous?.modifiedAt || previous?.observedAt || '');
    if (previous && Number.isFinite(incomingAt) && Number.isFinite(storedAt) && incomingAt < storedAt) {
      this.store.mutate(state => {
        state.events.push(event);
        event.summary = `Stale unavailability notice · kept the newer ${previous.title || docId}`;
        event.disposition = 'stale_change';
        event.relations = [];
        record(state, 'observation', `An older unavailability notice for "${previous.title || docId}" arrived after a newer revision; the current document state was kept.`, null, event.id);
      });
      this.changed();
      return { duplicate: false, id: event.id, disposition: 'stale_change', relations: [] };
    }
    let relations = [];
    this.store.mutate(state => {
      const currentPrevious = state.documents[docId];
      const title = doc.title || previous?.title || docId;
      const unavailableAt = event.at || stamp();
      setOwnRecord(state.documents, docId, {
        ...(currentPrevious || {
          id: docId,
          kind: 'document',
          content: '',
          url: doc.url || `/documents/${docId}`,
          externalId: doc.externalId || docId,
          modifiedAt: null,
          version: 0,
          source: event.source
        }),
        title,
        available: false,
        unavailableReason: doc.reason || 'unavailable',
        unavailableAt,
        observedAt: event.at || stamp()
      });
      state.events.push(event);
      event.summary = `Document unavailable · ${title}`;
      relations = Object.values(state.tasks).filter(task =>
        !isSettled(task) && !this.#documentExcludedByFeedback(task, docId) && (
          task.documentId === docId ||
          rankCandidates(task.request, Object.fromEntries([[docId, state.documents[docId]]])).best
        )).map(task => task.id);
      event.relations = relations;
      event.disposition = relations.length ? 'evidence_invalidated' : 'unrelated_change';
      record(state, 'observation', relations.length
        ? `"${title}" is no longer available (${doc.reason || 'unknown reason'}); it is no longer current evidence for ${relations.length} request(s), which were reassessed.`
        : `"${title}" is no longer available (${doc.reason || 'unknown reason'}); no outstanding request depended on it.`, null, event.id);
    });
    for (const taskId of relations) this.assess(taskId, event.id, { force: true });
    this.changed();
    return { duplicate: false, id: event.id, disposition: event.disposition, relations };
  }

  /**
   * A run registry publication. It carries no user instruction; it is new
   * evidence about the world, so any task that depends on freshness is
   * reconsidered.
   */
  #ingestRunRecord(event) {
    const payload = event.payload;
    const incoming = runRecord(payload);
    this.store.mutate(state => {
      state.events.push(event);
      setOwnRecord(state.runRecords, incoming.id, incoming);
      event.summary = `Run recorded · ${incoming.label}`;
      const related = Object.values(state.tasks).filter(task =>
        !isSettled(task) &&
        relevantRuns(Object.fromEntries([[incoming.id, incoming]]), task.request.subjectEntity).length > 0);
      event.relations = related.map(task => task.id);
      event.disposition = related.length ? 'related_change' : 'context_only';
      record(state, 'observation', related.length
        ? `A completed run was published for ${[...new Set(related.map(task => task.request.subjectEntity))].join(', ')}; re-checking freshness.`
        : 'A completed run was published, but no outstanding request depends on it.', null, event.id);
    });
    for (const taskId of event.relations) this.assess(taskId, event.id);
    this.changed();
    return { duplicate: false, id: event.id, disposition: event.disposition, relations: event.relations };
  }

  /**
   * Optional model assist, used only when the deterministic pass could not
   * identify verifiable content requirements. Runs after the deterministic
   * baseline is already persisted, so a model failure changes nothing.
   */
  #supersedeReasoning(task, reason) {
    if (!task.reasoningWork || !['pending', 'running', 'failed'].includes(task.reasoningWork.status)) return;
    task.reasoningWork = { ...task.reasoningWork, status: 'superseded', retryAt: null, terminalReason: reason, updatedAt: stamp() };
    if (task.reasoning) task.reasoning = { ...task.reasoning, status: 'superseded' };
  }

  #beginReasoningWork(taskId, kind, signature, { resume = false } = {}) {
    const task = this.store.state.tasks[taskId];
    if (!task || isSettled(task)) return { started: false, work: null };
    const requestVersion = Number(task.commitment?.revision || 1);
    const key = `${taskId}:${requestVersion}:${kind}:${signature}`;
    const existing = task.reasoningWork;
    if (existing?.key === key && !resume) return { started: false, work: existing };
    const maxAttempts = Math.max(1, Math.min(3, Number(existing?.maxAttempts) || 2));
    const attempts = existing?.key === key ? Number(existing.attempts) || 0 : 0;
    if (existing?.key === key && !['pending', 'running', 'failed'].includes(existing.status)) return { started: false, work: existing };
    if (attempts >= maxAttempts) return { started: false, work: existing };
    const work = {
      key, kind, signature, requestVersion, status: 'running', attempts: attempts + 1,
      maxAttempts, updatedAt: stamp(), lastError: null
    };
    this.store.mutate(state => {
      const current = state.tasks[taskId];
      if (!current || isSettled(current) || Number(current.commitment?.revision || 1) !== requestVersion) return;
      current.reasoningWork = work;
      current.reasoning = { ...(current.reasoning || {}), status: 'pending', kind, attempts: work.attempts, maxAttempts, at: work.updatedAt };
      if (current.evidence) current.evidence.reasoning = current.reasoning;
      record(state, 'reasoning_started', `Started bounded ${kind} reasoning attempt ${work.attempts}/${maxAttempts} for request revision ${requestVersion}.`, taskId);
    });
    const current = this.store.state.tasks[taskId]?.reasoningWork;
    return { started: current?.key === key && current?.attempts === work.attempts, work };
  }

  #finishReasoningWork(taskId, work, status, details = {}) {
    this.store.mutate(state => {
      const current = state.tasks[taskId];
      if (!current || current.reasoningWork?.key !== work.key || current.reasoningWork?.attempts !== work.attempts) return;
      current.reasoningWork = { ...current.reasoningWork, ...details, status, updatedAt: stamp() };
      if (details.lastError != null) current.reasoningWork.lastError = String(details.lastError).slice(0, 500);
      if (current.reasoning) {
        current.reasoning.status = status === 'complete' ? (current.reasoning.status === 'pending' ? 'ok' : current.reasoning.status) : status;
        current.reasoning.at = current.reasoningWork.updatedAt;
        if (details.detail) current.reasoning.detail = details.detail;
      }
      if (current.evidence && current.reasoning) current.evidence.reasoning = current.reasoning;
    });
  }

  #reasoningWorkIsCurrent(taskId, work) {
    const task = this.store.state.tasks[taskId];
    return Boolean(task && !isSettled(task) && task.reasoningWork?.key === work.key &&
      task.reasoningWork?.attempts === work.attempts &&
      task.reasoningWork?.status === 'running' &&
      Number(task.commitment?.revision || 1) === work.requestVersion);
  }

  #maybeRefineWithModel(taskId, message, { resume = false } = {}) {
    const task = this.store.state.tasks[taskId];
    if (!task) return false;
    if (!this.reasoner?.available?.()) return false;
    const plan = this.#planFor(task);
    // Only when the request itself is under-specified: nothing in it could be
    // mapped to a probe. Otherwise the probe-proposal path handles it.
    if (!this.reasoner.preferModelInterpretation && (plan.specs.length || !plan.unverifiable.length)) return false;
    const begun = this.#beginReasoningWork(taskId, 'interpret', plan.signature, { resume });
    if (!begun.started) return true;
    const work = begun.work;
    // A model failure during interpretation is a reasoning failure, recorded as
    // such. The deterministic reading stands; the failure says nothing about
    // whether the work is done.
    const noteFailure = error => {
      if (!this.#reasoningWorkIsCurrent(taskId, work)) return;
      const failure = { status: 'failed', at: stamp(), detail: error.message };
      this.store.mutate(state => {
        const current = state.tasks[taskId];
        if (!current) return;
        current.reasoning = failure;
        if (this.reasoner.preferModelInterpretation) {
          current.status = 'waiting_for_information';
          current.draft = null;
          current.reason = 'Model reasoning failed. Reconnect or retry before continuing.';
        }
        current.reasoningWork = { ...current.reasoningWork, status: 'failed', lastError: String(error.message).slice(0, 500), updatedAt: failure.at, ...reasoningFailure(error, work) };
        // The evidence projection is refreshed on every assessment; without
        // this line the recorded failure would stay invisible until the next
        // one, and the eval harness reads the projection.
        if (current.evidence) current.evidence.reasoning = failure;
        record(state, 'reasoning_failure',
          `Request interpretation by a model did not complete (${error.message}). The deterministic reading stands.`, taskId);
      });
      this.changed();
    };
    const pending = interpretRequestWithReasoner(message, this.reasoner, {
      dateLocale: this.#dateLocale(),
      reasoningRequestId: `${work.key}:attempt:${work.attempts}`,
      preferModel: this.reasoner.preferModelInterpretation === true,
      // interpretRequestWithReasoner degrades to the deterministic result on
      // failure; without this callback the failure would have been invisible.
      onError: noteFailure
    }).then(refined => {
      const current = this.store.state.tasks[taskId];
      if (!this.#reasoningWorkIsCurrent(taskId, work)) return;
      if (!refined || !current || isSettled(current)) {
        this.#finishReasoningWork(taskId, work, 'complete', { detail: 'No grounded request refinement was returned.' });
        return;
      }
      if (refined.interpretedBy === current.request.interpretedBy && !(this.reasoner.preferModelInterpretation && refined.modelInterpretation?.verified)) {
        if (this.reasoner.preferModelInterpretation) {
          noteFailure(new Error('The model did not return a source-grounded interpretation.'));
          return;
        }
        this.#finishReasoningWork(taskId, work, 'complete', { detail: 'The deterministic request stayed in place.' });
        return;
      }
      this.store.mutate(state => {
        const target = state.tasks[taskId];
        const currentDeadline = target.request.deadline;
        target.request = { ...target.request, ...refined, id: target.id };
        if (this.reasoner.preferModelInterpretation) target.request.deadline = currentDeadline;
        target.commitment.signature = requestRevisionSignature(target.request);
        target.reasoningWork = { ...work, status: 'complete', updatedAt: stamp() };
        if (this.reasoner.preferModelInterpretation) target.modelReview = { status: 'verified', requestVersion: work.requestVersion, at: stamp() };
      });
      record(this.store.state, 'interpretation',
        refined.droppedModelContent?.length
          ? `A model proposed a reading; ${refined.droppedModelContent.length} phrase(s) without a verbatim source in the email were discarded.`
          : 'The deterministic pass could not verify the requested content; a model proposed a verifiable reading.',
        taskId);
      if (refined.droppedModelContent?.length) {
        record(this.store.state, 'grounding',
          `Model content discarded because it does not occur verbatim in the email: ${refined.droppedModelContent.join('; ')}`,
          taskId);
      }
      this.assess(taskId);
      this.changed();
    }).catch(error => {
      // A model failure must never disturb the deterministic baseline.
      noteFailure(error);
    });
    this.pendingReasoning.set(work.key, pending);
    pending.then(() => { if (this.pendingReasoning.get(work.key) === pending) this.pendingReasoning.delete(work.key); });
    this.#track(pending);
    return true;
  }

  /**
   * Resolve the probe plan for a task, reusing a cached one for an identical
   * request rather than re-deriving it on every event.
   */
  #planFor(task) {
    const signature = planSignature(task.request);
    // Cache only deterministic plans. Model quotations belong to this task's request.
    const baseline = this.planCache.get(signature) || this.planCache.set(signature, buildDeterministicPlan(task.request));
    let checkpoint = task.reasoningPlan;
    // Older states already hold bounded, validated model specs in the evidence projection.
    if (!checkpoint && task.reasoningAttemptedFor === signature && Array.isArray(task.evidence?.plan?.specs) && task.evidence.plan.specs.some(spec => spec.origin === 'model')) {
      checkpoint = checkpointPlan({ ...task.evidence.plan, signature });
    }
    return restorePlan({ ...baseline, requestId: task.id }, checkpoint, task.request);
  }

  #taskSourceMessage(task) {
    return (this.store.state.inbox || []).find(message =>
      message.id === task?.sourceEmailId || message.id === task?.request?.source?.id) || null;
  }

  #documentExcludedByFeedback(task, documentId) {
    if (!task || !documentId) return false;
    return this.taskServices.matchingFeedbackRules({
      request: task.request,
      message: this.#taskSourceMessage(task),
      documentId
    }).some(match => match.effect === 'exclude_document_association');
  }

  /**
   * Optional model assist.
   *
   * Only consulted when the deterministic plan still leaves requested content
   * uncovered, so a fully covered request never costs a model call. The model
   * may only add probes, and only validated ones; a failure leaves the
   * deterministic plan in place and is recorded as a reasoning failure, never as
   * a negative assessment result.
   */
  #maybeProposeProbes(taskId, { resume = false } = {}) {
    const task = this.store.state.tasks[taskId];
    if (!task) return;
    if (!this.reasoner?.available?.()) return;
    const plan = this.#planFor(task);
    const uncovered = plan.unverifiable.map(item => item.text);
    const hasOnlyWeakCoverage = plan.specs.length === 0 ||
      plan.specs.every(spec => spec.origin === 'derived');
    if (!uncovered.length && !hasOnlyWeakCoverage) return;
    if (task.reasoningAttemptedFor === plan.signature) return; // do not re-ask for the same request
    const begun = this.#beginReasoningWork(taskId, 'probes', plan.signature, { resume });
    if (!begun.started) return;
    const work = begun.work;
    const correlated = rankCandidates(task.request, Object.fromEntries(Object.entries(this.store.state.documents)
      .filter(([, document]) => documentAvailable(document)))).ranked.slice(0, 8).map(entry => entry.document);
    const reasoningKey = `${work.key}:attempt:${work.attempts}`;
    const pending = Promise.resolve().then(() => {
      if (!this.#reasoningWorkIsCurrent(taskId, work)) return null;
      return this.reasoner.proposeProbes({
      request: task.request,
      uncovered,
      providers: PROVIDER_IDS,
      strategies: STRATEGY_IDS,
      contextHints: correlated.slice(0, 5).map(document => `${document.title} (#${document.id})`),
      ...(this.reasoner.id === 'pi' ? { documents: () => {
        const current = this.store.state.tasks[taskId];
        if (!current || isSettled(current) || planSignature(current.request) !== plan.signature) return [];
        return rankCandidates(current.request, Object.fromEntries(Object.entries(this.store.state.documents)
          .filter(([, document]) => documentAvailable(document)))).ranked.slice(0, 8).map(entry => entry.document);
      } } : {})
    }, reasoningKey);
    }).then(proposals => {
      const current = this.store.state.tasks[taskId];
      if (!this.#reasoningWorkIsCurrent(taskId, work) || !current || isSettled(current) || planSignature(current.request) !== plan.signature) return;
      if (!proposals?.length) {
        this.store.mutate(state => {
          state.tasks[taskId].reasoningAttemptedFor = plan.signature;
          state.tasks[taskId].reasoningWork = { ...work, status: 'complete', updatedAt: stamp(), detail: 'The model proposed no usable probes.' };
          state.tasks[taskId].reasoning = {
            status: 'no_proposal', at: stamp(), detail: 'The model proposed no usable probes.',
            ...(this.reasoner.runSummary ? { runtime: this.reasoner.runSummary(reasoningKey) } : {})
          };
          record(state, 'reasoning', 'The model proposed no additional probes; the deterministic plan stands.', taskId);
        });
        return;
      }
      const merged = applyModelProposals(plan, proposals, task.request);
      this.store.mutate(state => {
        state.tasks[taskId].reasoningAttemptedFor = plan.signature;
        state.tasks[taskId].reasoningPlan = checkpointPlan(merged);
        state.tasks[taskId].reasoningWork = { ...work, status: 'complete', updatedAt: stamp() };
        state.tasks[taskId].reasoning = {
          status: merged.rejected.length ? 'partial' : 'ok',
          ...(this.reasoner.runSummary ? { runtime: this.reasoner.runSummary(reasoningKey) } : {}),
          at: stamp(),
          accepted: merged.specs.filter(spec => spec.origin === 'model').length,
          rejected: merged.rejected
        };
        record(state, 'reasoning',
          `Model proposed ${proposals.length} probe(s): ${merged.specs.filter(spec => spec.origin === 'model').length} accepted, ${merged.rejected.length} rejected.`,
          taskId);
      });
      // Force a re-assessment so the recorded plan, including any rejected
      // proposals, is reflected even when the accepted specs did not change.
      this.assess(taskId, null, { force: true });
      this.changed();
    }).catch(error => {
      // A reasoning failure is recorded as a reasoning failure. It is never a
      // statement about the work itself.
      const budgetExhausted = error.code === 'REASONING_BUDGET';
      if (!this.#reasoningWorkIsCurrent(taskId, work)) return;
      this.store.mutate(state => {
        const current = state.tasks[taskId];
        if (!current) return;
        if (current.reasoningWork?.key === work.key && current.reasoningWork?.attempts === work.attempts) {
          current.reasoningWork = { ...current.reasoningWork, status: 'failed', lastError: String(error.message).slice(0, 500), updatedAt: stamp(), ...reasoningFailure(error, work) };
        }
        current.reasoning = {
          status: 'failed',
          ...(this.reasoner.runSummary ? { runtime: this.reasoner.runSummary(reasoningKey) } : {}),
          at: stamp(),
          detail: error.message,
          budgetExhausted
        };
        record(state, 'reasoning_failure',
          `Model reasoning did not complete (${error.message}). The deterministic plan was used; this says nothing about whether the work is done.`,
          taskId);
      });
      this.changed();
    });
    this.pendingReasoning.set(work.key, pending);
    pending.then(() => { if (this.pendingReasoning.get(work.key) === pending) this.pendingReasoning.delete(work.key); });
    this.#track(pending);
    return true;
  }

  // ---------------------------------------------------------------- assessment

  /** The date a probe actually found, used as the freshness comparison input. */
  #runDateEvidence(criteria) {
    return criteria.find(item => item.id === 'as_of_date' && item.date)?.date ||
      criteria.find(item => item.id === 'run_date')?.evidence?.[0]?.excerpt ||
      criteria.find(item => item.date)?.date || null;
  }

  assess(taskId, eventId = null, { force = false, allowAutomation = true } = {}) {
    const task = this.store.state.tasks[taskId];
    if (!task || isSettled(task) || task.kind === 'external_issue') return;
    const state = this.store.state;

    const feedbackExcluded = [];
    const assessmentDocuments = Object.fromEntries(Object.entries(state.documents).filter(([id, entry]) => {
      if (!documentAvailable(entry)) return false;
      if (this.#documentExcludedByFeedback(task, id)) {
        feedbackExcluded.push(id);
        return false;
      }
      return true;
    }));
    const { ranked, best, ambiguous, contenders, rejected } = rankCandidates(
      task.request,
      // An unavailable or explicitly corrected association is not current
      // evidence. Filtering here covers assessment, cross-checks and ambiguity.
      assessmentDocuments
    );
    const document = best?.document || null;
    const plan = this.#planFor(task);
    const context = {
      documents: document ? [document] : [],
      runRecords: state.runRecords || {},
      subjectEntity: task.request.subjectEntity
    };
    const scan = assessPlan(plan, context);
    const rawCriteria = scan.criteria;
    // A document whose identity contradicts the request is surfaced rather than
    // silently dropped, so "why was my report not used?" has a visible answer.
    const unavailable = task.documentId && state.documents[task.documentId] && !documentAvailable(state.documents[task.documentId])
      ? state.documents[task.documentId]
      : null;
    const observations = [
      ...scan.observations,
      ...(unavailable ? [{
        id: `unavailable_document:${unavailable.id}`,
        detail: `Document ${unavailable.id} is no longer available (${unavailable.unavailableReason || 'unknown reason'}); it is not used as current evidence.`
      }] : []),
      ...rejected.map(entry => ({
        id: `excluded_document:${entry.documentId}`,
        detail: `Document ${entry.documentId} was not used: ${entry.contradictions.map(contradiction => contradiction.detail).join(' ')}`
      })),
      ...feedbackExcluded.map(documentId => ({
        id: `feedback_excluded_document:${documentId}`,
        detail: `Document ${documentId} was excluded from this request by an active, scoped user correction.`
      }))
    ];

    // Freshness input: the date a probe actually extracted, preferring the
    // dedicated as-of criterion, then any other probe that found a date.
    const runDateEvidence = this.#runDateEvidence(rawCriteria);
    const freshness = document
      ? determineFreshness({ document, documentRunDate: runDateEvidence, runRecords: state.runRecords || {}, request: task.request })
      : { status: 'unverified', reason: 'No matching document has been observed yet.', evidence: [], newestRun: null, documentRunDate: null, unknowns: [] };

    const signature = evidenceSignature({
      request: requestRevisionSignature(task.request),
      primaryModelReviewed: this.reasoner.preferModelInterpretation ? !this.#primaryReviewMissing(task) : null,
      documentId: document?.id || null,
      version: document?.version ?? null,
      runs: relevantRuns(state.runRecords || {}, task.request.subjectEntity)
        .map(item => ({ id: item.id, label: item.label, subjectEntity: item.subjectEntity, completedAt: item.completedAt, metrics: item.metrics || null }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      probes: plan.specs.map(spec => ({
        id: spec.id,
        criterionId: spec.criterionId,
        provider: spec.provider,
        strategies: spec.strategies,
        builtinProbe: spec.builtinProbe || null,
        constraints: spec.constraints,
        requiredKeywords: spec.requiredKeywords || [],
        requiredAnyKeywords: spec.requiredAnyKeywords || [],
        keywords: spec.keywords || [],
        coverage: Boolean(spec.coverage),
        origin: spec.origin
      })),
      unverifiable: plan.unverifiable.map(item => ({ text: item.text, reason: item.reason })),
      feedbackExcluded: feedbackExcluded.sort(),
      ...(plan.restoreBlocked ? { planValidity: 'blocked' } : {}),
      // The competing sources and their versions are part of what this
      // assessment depends on: a revision of a runner-up can change the
      // verification outcome even when the chosen document is untouched.
      sources: ranked.slice(0, 1 + CROSS_CHECK_LIMIT).map(entry => `${entry.document.id}@${entry.document.version ?? 0}`),
      ambiguous: ambiguous ? contenders : null
    });
    if (!force && task.assessment && task.evidence?.signature === signature) return; // no new evidence

    // Verification depth scales with what could go wrong. One
    // plausible document gets the baseline checks; a competing plausible source
    // is checked independently, so agreement is corroboration and disagreement
    // stops the work instead of being averaged away. The decision is recomputed
    // from current state on every assessment: a runner-up that stops matching —
    // or a new one that appears — raises or lowers the depth on the next pass.
    const verification = chooseVerificationDepth({ ranked, ambiguous });
    const performed = [];
    const crossResults = [];
    for (const entry of verification.crossCheck) {
      const contenderScan = assessPlan(plan, {
        runRecords: state.runRecords || {},
        subjectEntity: task.request.subjectEntity,
        documents: [entry.document]
      });
      const results = compareAcrossSources({
        bestCriteria: rawCriteria,
        contenderCriteria: contenderScan.criteria,
        contenderDocument: entry.document,
        bestDocumentDate: runDateEvidence,
        contenderDocumentDate: this.#runDateEvidence(contenderScan.criteria)
      });
      for (const result of results) {
        performed.push({
          documentId: entry.document.id,
          documentVersion: entry.document.version ?? null,
          criterionId: result.criterionId,
          outcome: result.outcome
        });
        crossResults.push(result);
        // Corroborations and superseded readings are recorded next to the
        // evidence they bear on; disagreements block through the criterion.
        if (result.outcome === 'corroborated' || result.outcome === 'superseded' || result.outcome === 'internal_conflict') {
          observations.push({ id: `cross_source:${entry.document.id}:${result.criterionId}`, detail: result.detail });
        }
      }
    }
    const criteria = applySourceConflicts(rawCriteria, crossResults);

    const claims = (task.request.impliedClaims || []).map(item => {
      const supported = item.requiresFreshness ? freshness.status === 'verified' : true;
      return claim({
        id: item.id,
        text: item.text,
        supported,
        basis: supported ? freshness.evidence : [],
        note: supported ? null : freshness.reason,
        forbiddenPattern: item.forbiddenPattern
      });
    });

    // Unknowns come from criteria that could not be settled, plus freshness.
    const unknowns = [
      ...(freshness.unknowns || []),
      ...criteria.filter(item => item.status === 'unknown' || item.status === 'blocked').map(item => unknownItem({
        id: `unverifiable:${item.id}`,
        question: `Does the deliverable satisfy “${item.label}”?`,
        reason: item.note || 'This criterion could not be settled from the available evidence.',
        whatWouldResolveIt: item.whatWouldResolveIt || 'Add the missing content, or have a person confirm it.'
      })),
      ...plan.unverifiable.map(item => unknownItem({
        id: `unverifiable:${item.text}`,
        question: `Does the deliverable satisfy “${item.text}”?`,
        reason: item.reason,
        whatWouldResolveIt: 'Add a verification probe for this content type, or have a person confirm it.'
      }))
    ];

    const conflicts = [
      ...(ambiguous ? [{
        id: 'ambiguous_document',
        detail: `More than one document matches this request equally well: ${contenders.join(', ')}.`,
        contenders
      }] : []),
      ...criteria.filter(item => item.status === 'conflicting').map(item => ({
        id: `conflicting:${item.id}`,
        detail: item.note || `Evidence for “${item.label}” contradicts itself.`
      }))
    ];

    const freshnessBlockers = [];
    if (freshness.status === 'stale' || freshness.status === 'contradictory') {
      freshnessBlockers.push({ id: 'stale_evidence', detail: freshness.reason });
    }
    if (ambiguous) freshnessBlockers.push({ id: 'ambiguous_document', detail: `Ambiguous document match: ${contenders.join(', ')}.` });
    if (!document) freshnessBlockers.push({ id: 'no_document', detail: 'No document with an identity link to this request has been observed.' });

    const completion = completionFromCriteria(criteria, { blockers: freshnessBlockers });
    const complete = completion.complete && !this.#primaryReviewMissing(task);
    const missing = missingLabels(criteria);

    if (!criteria.length && document) {
      unknowns.push(unknownItem({
        id: 'no_verifiable_criteria',
        question: `Does the ${task.request.deliverable} satisfy the request?`,
        reason: 'No requested content could be mapped to a verification probe, so nothing can be confirmed.',
        whatWouldResolveIt: 'Add a probe for the requested content type, or have a person confirm the deliverable.'
      }));
    }

    const documents = best ? [{
      documentId: document.id,
      title: document.title,
      version: document.version,
      modifiedAt: document.modifiedAt,
      url: document.url,
      source: document.source,
      correlationScore: best.match.score,
      correlationReasons: best.match.reasons,
      identitySignals: best.match.identitySignals,
      topicalSignals: best.match.topicalSignals
    }] : [];

    this.store.mutate(current => {
      const target = current.tasks[taskId];
      // Deriving the old signature also migrates legacy records without moving their clock.
      const previousProgress = target.progress?.semanticSignature || progressSignature(target);
      target.documentId = document?.id || null;
      target.updatedAt = stamp();
      target.reason = null;
      target.evidence = {
        signature,
        request: { source: task.request.source, intent: task.request.intent, deliverable: task.request.deliverable, subjectEntity: task.request.subjectEntity, deadline: task.request.deadline, requiredContent: task.request.requiredContent, qualifiers: task.request.qualifiers || [] },
        documents,
        criteria,
        observations,
        plan: {
          reasoning: plan.reasoning,
          degraded: plan.degraded,
          specs: plan.specs.map(spec => ({
            id: spec.id,
            criterionId: spec.criterionId, criterionLabel: spec.criterionLabel, concept: spec.concept,
            // `builtinProbe` records how a spec executes: a built-in probe carries
            // one and no strategies, a derived or model probe carries strategies.
            provider: spec.provider, strategies: spec.strategies, builtinProbe: spec.builtinProbe ?? null,
            origin: spec.origin,
            justification: spec.justification, justificationSource: spec.justificationSource ?? null,
            justified: spec.justified,
            expectedEvidence: spec.expectedEvidence, constraints: spec.constraints,
            requiredKeywords: spec.requiredKeywords || [], requiredAnyKeywords: spec.requiredAnyKeywords || [],
            coverage: Boolean(spec.coverage),
            keywords: spec.keywords.slice(0, 8)
          })),
          rejected: plan.rejected,
          unverifiable: plan.unverifiable
        },
        freshness: { status: freshness.status, reason: freshness.reason, documentRunDate: freshness.documentRunDate, newestRun: freshness.newestRun?.id || null, evidence: freshness.evidence },
        claims,
        unknowns,
        conflicts,
        completion,
        interpretation: task.request.interpretedBy,
        reasoning: target.reasoning || { status: plan.degraded ? 'deterministic' : 'ok', at: stamp() }
      };
      const semanticSignature = progressSignature(target);
      target.progress = {
        signature,
        semanticSignature,
        at: target.progress && previousProgress === semanticSignature ? target.progress.at : stamp()
      };
      // How much verification this assessment warranted, why, and what was
      // actually performed. Replaced on every assessment, never accumulated:
      // a repeated check cannot manufacture a second corroboration, and a
      // depth that no longer applies disappears together with its basis.
      target.verification = {
        depth: verification.depth,
        basis: verification.basis,
        checkedDocuments: verification.crossCheck.map(entry => entry.document.id),
        performed,
        at: stamp()
      };
      target.assessment = {
        checkedAt: stamp(),
        documentId: document?.id || null,
        documentVersion: document?.version ?? null,
        correlationScore: best?.match.score || 0,
        correlationReasons: best?.match.reasons || [],
        complete,
        missing,
        evidence: [...criteriaToHumanStrings(criteria), ...(document ? [`Document link: ${document.url}`] : [])],
        confidence: complete ? 'strong_field_evidence' : document ? 'incomplete_field_evidence' : 'insufficient_evidence',
        caveat: freshness.status === 'verified' ? null : freshness.reason,
        freshness: { status: freshness.status, reason: freshness.reason, documentRunDate: freshness.documentRunDate, newestRun: freshness.newestRun?.id || null },
        claims: claims.map(item => ({ id: item.id, text: item.text, supported: item.supported, note: item.note })),
        unknowns: unknowns.map(item => ({ id: item.id, question: item.question, reason: item.reason })),
        conflicts,
        criteria: criteria.map(item => ({ id: item.id, label: item.label, status: item.status, strength: item.strength || null, origin: item.probe?.origin || null })),
        planReasoning: plan.reasoning,
        completion,
        interpretation: task.request.interpretedBy
      };
      if (complete) {
        target.draft = this.#buildDraft(target, document, criteria, freshness, claims);
        target.status = 'ready_for_approval';
        record(current, 'preparation',
          `Satisfied all ${criteria.length} criterion/criteria in ${document.title} with direct evidence; prepared a reply for approval. Nothing was sent.`,
          taskId, eventId);
      } else {
        target.draft = null;
        target.status = this.#primaryReviewMissing(target) && target.reasoningWork?.status === 'running' ? 'investigating' : 'waiting_for_information';
        const why = [
          missing.length ? `not satisfied: ${missing.join('; ')}` : null,
          freshnessBlockers.length ? freshnessBlockers.map(blocker => blocker.detail).join(' · ') : null,
          plan.unverifiable.length ? `cannot verify: ${plan.unverifiable.map(item => item.text).join('; ')}` : null
        ].filter(Boolean).join(' · ');
        record(current, 'assessment', `Checked ${task.request.subjectEntity}: ${why || completion.reason}`, taskId, eventId);
      }
    });

    this.#addTrace(traceEntry({
      stage: 'assessment', taskId, eventId,
      input: {
        documentId: document?.id || null,
        documentVersion: document?.version ?? null,
        evidenceSignature: signature,
        planSignature: plan.signature,
        verification: {
          depth: verification.depth,
          basis: verification.basis.map(item => item.code),
          crossCheck: performed.map(item => `${item.documentId}:${item.criterionId}:${item.outcome}`)
        }
      },
      evidence: {
        satisfied: criteria.filter(item => item.status === 'satisfied').map(item => item.id),
        unsatisfied: criteria.filter(item => item.status !== 'satisfied').map(item => item.id),
        freshness: freshness.status,
        conflicts: conflicts.map(item => item.id),
        unknowns: unknowns.map(item => item.id)
      },
      reasoning: {
        interpretation: task.request.interpretedBy,
        planReasoning: plan.reasoning,
        degraded: plan.degraded,
        specs: plan.specs.map(item => item.criterionId),
        unverifiable: plan.unverifiable.map(item => item.text)
      },
      outcome: { complete, missing, status: complete ? 'ready_for_approval' : 'waiting_for_information' }
    }));

    // A stated, clearly scoped pre-authorisation for a repeated flow lets
    // the work run without a fresh click. With no such grant nothing changes.
    const grant = complete
      ? grantFor(this.store.state.calibrations || {}, { entity: task.request.subjectEntity, deliverable: task.request.deliverable })
      : null;
    this.#refreshAttention();
    // A standing grant is still an external write. Shadow mode never starts it,
    // and strengthened verification is exactly the uncertainty a grant cannot
    // cover: a competing source could contradict the draft, so the action needs
    // a fresh approval even though the user pre-authorised this flow.
    if (allowAutomation && grant && !this.policy.shadow && verification.depth !== 'enhanced') this.#runPreAuthorized(taskId, grant);
    this.changed();
  }

  #providerForTask(task) {
    if (!this.provider.forSource) return this.provider;
    const message = this.store.state.inbox.find(item => item.id === task?.sourceEmailId);
    const origin = this.store.state.events.find(event => event.payload?.id === task?.sourceEmailId);
    return this.provider.forSource(task?.sourceConnectorId || message?.connectorId || origin?.connectorId || task?.request?.source?.connectorId);
  }

  /**
   * Build the outbound draft from supported claims only.
   *
   * Unsupported claims are withheld and recorded, so the reply can never assert
   * something the evidence does not support.
   */
  #buildDraft(task, document, criteria, freshness, claims) {
    const provider = this.#providerForTask(task);
    const satisfied = criteria.filter(item => item.status === 'satisfied').map(item => item.label.toLowerCase());
    const link = resolveDocumentLink(document, this.baseUrl);
    const unsupported = claims.filter(item => !item.supported);
    const freshnessVerified = freshness.status === 'verified';
    const runDate = freshness.documentRunDate || criteria.find(item => item.id === 'run_date')?.evidence?.[0]?.excerpt || null;

    const lines = ['Hi,', ''];
    lines.push(
      freshnessVerified && runDate
        ? `The ${task.request.subjectEntity} ${task.request.deliverable} now contains the latest results, from the ${runDate} run.`
        : runDate
          ? `The ${task.request.subjectEntity} ${task.request.deliverable} now contains the results from the ${runDate} run.`
          : `The ${task.request.subjectEntity} ${task.request.deliverable} has been updated as requested.`
    );
    if (satisfied.length) lines.push(`It covers ${satisfied.join(', ')}.`);
    lines.push('', 'The revised document is here:', '', link);
    if (document.source === 'simulated') {
      lines.push('', '(This is a local simulation link; it is not reachable from outside this machine.)');
    }
    lines.push('', 'Best,', (task.request.source.to || 'User').split('@')[0].replace(/^./, character => character.toUpperCase()));
    const body = lines.join('\n');

    return {
      to: task.sender,
      subject: `Re: ${task.sourceEmailId ? this.store.state.inbox.find(item => item.id === task.sourceEmailId)?.subject || task.subject : task.subject}`,
      body,
      documentUrl: link,
      documentVersion: document.version,
      documentId: document.id,
      requestVersion: Number(task.commitment?.revision || 1),
      providerKind: provider.kind,
      live: Boolean(provider.live),
      canSend: provider.canSend !== false,
      preparedAt: stamp(),
      claims: claims.map(item => ({ id: item.id, text: item.text, supported: item.supported })),
      withheldClaims: unsupported.map(item => ({ id: item.id, text: item.text, reason: item.note })),
      satisfiedCriteria: criteria.filter(item => item.status === 'satisfied').map(item => item.label),
      simulationOnly: document.source === 'simulated'
    };
  }

  // ---------------------------------------------------------------- actions

  #requireTask(taskId) {
    const task = this.store.state.tasks[taskId];
    if (!task) throw new Error('Unknown task');
    return task;
  }

  /**
   * Approve a prepared action.
   *
   * Completeness is re-derived from the document as it exists now, so a stale
   * draft can never be sent, and the permission policy is consulted before any
   * external effect.
   */
  approve(taskId, options = {}) {
    const task = this.#requireTask(taskId);
    const provider = this.#providerForTask(task);
    if (this.#primaryReviewMissing(task)) throw new Error('Model interpretation is not verified yet. Wait for reasoning or retry the failed model request.');
    if (task.status !== 'ready_for_approval' || !task.draft) throw new Error('Task is not ready for approval');
    if (Object.hasOwn(options, 'reviewToken') && options.reviewToken !== draftReviewToken(task)) {
      const error = new Error('The prepared reply changed. Review the updated reply before sending.');
      error.code = 'REVIEW_CHANGED';
      throw error;
    }
    if (Number(task.draft.requestVersion || 1) !== Number(task.commitment?.revision || 1) || (task.commitment?.status && task.commitment.status !== 'active')) {
      this.assess(taskId, null, { force: true, allowAutomation: false });
      throw new Error('The request changed; the draft must be reviewed again');
    }
    const storedDocument = this.store.state.documents[task.documentId];
    const document = documentAvailable(storedDocument) ? storedDocument : null;
    // Re-derive completeness from the document as it exists now, using the same
    // plan that produced the draft, so a stale draft can never be sent. The
    // freshness comparison is re-run too: evidence that went stale after the
    // draft was prepared must not be sent as if it were current.
    const plan = this.#planFor(task);
    const recheck = document
      ? assessPlan(plan, { documents: [document], runRecords: this.store.state.runRecords || {}, subjectEntity: task.request.subjectEntity })
      : { criteria: [] };
    const freshness = document
      ? determineFreshness({
        document,
        documentRunDate: this.#runDateEvidence(recheck.criteria),
        runRecords: this.store.state.runRecords || {},
        request: task.request
      })
      : null;
    const staleNow = freshness && ['stale', 'contradictory'].includes(freshness.status);
    if (!document || document.version !== task.draft.documentVersion || !completionFromCriteria(recheck.criteria).complete || staleNow) {
      const reason = storedDocument && !documentAvailable(storedDocument)
        ? 'The document is no longer available; the draft must be reviewed again'
        : staleNow
          ? 'The evidence is no longer current; the draft must be reviewed again'
          : 'The document changed; the draft must be reviewed again';
      // A refusal is a decision too, and the reason must be on the record.
      this.#addTrace(traceEntry({
        stage: 'policy', taskId,
        input: { actionClass: 'execute_external', documentId: document?.id || null, documentVersion: document?.version ?? null, draftVersion: task.draft.documentVersion },
        policy: { permission: 'user_approved', decision: 'refused', reason },
        outcome: { status: 'not_executed' }
      }));
      this.assess(taskId);
      throw new Error(reason);
    }

    const approval = { permission: 'user_approved', taskId, approvedAt: stamp() };
    try {
      this.policy.authorize({ actionClass: 'execute_external', approval, taskId });
      if (provider.live && provider.canSend === false) throw new PermissionDeniedError('Delivery is not enabled for this source. The reply remains available to copy.');
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        this.#addTrace(traceEntry({
          stage: 'policy',
          taskId,
          input: { actionClass: 'execute_external', providerKind: provider.kind },
          policy: { permission: 'user_approved', decision: 'refused', reason: error.message },
          outcome: { status: 'not_executed' }
        }));
      }
      throw error;
    }

    const requestVersion = Number(task.commitment?.revision || 1);
    const actionVersion = Number(task.actionVersion || 0) + 1;
    const versionSuffix = requestVersion > 1 ? `:r${requestVersion}` : '';
    const action = {
      id: `send:${taskId}:${document.version}${versionSuffix}`,
      idempotencyKey: `send:${taskId}:${document.version}${versionSuffix}`,
      version: actionVersion,
      commitmentRevision: requestVersion,
      actionClass: 'execute_external',
      permission: 'user_approved',
      approvedAt: approval.approvedAt,
      status: 'executing',
      phase: 'approved',
      providerKind: provider.kind,
      live: Boolean(provider.live),
      receiptId: null
    };
    this.store.mutate(state => {
      state.tasks[taskId].status = 'verifying';
      state.tasks[taskId].actionVersion = actionVersion;
      state.tasks[taskId].action = action;
      record(state, 'approval', `User approved the reply. Checking the ${provider.kind} provider before and after sending.`, taskId);
    });
    this.#addTrace(traceEntry({
      stage: 'policy', taskId,
      input: { actionClass: 'execute_external', idempotencyKey: action.idempotencyKey, documentId: document.id, documentVersion: document.version },
      policy: { permission: 'user_approved', decision: 'allowed', reason: 'Explicit user approval present.' },
      outcome: { status: 'verifying' }
    }));
    this.changed();
    return this.execute(taskId, options);
  }

  /**
   * Ask the provider whether an action already took effect.
   *
   * A provider that cannot be reached is reported as an inconclusive outcome
   * with the underlying reason, never as "nothing happened" — that would risk a
   * duplicate external action.
   */
  #lookupSafely(idempotencyKey, options = {}, provider = this.provider) {
    const normalize = value => {
      if (value?.status === 'not_found') return value;
      if (value?.status === 'found' && typeof value.receipt?.id === 'string' && value.receipt.id.trim() &&
        (!value.receipt.idempotencyKey || value.receipt.idempotencyKey === idempotencyKey)) return value;
      return {
        status: 'unknown', receipt: null,
        detail: value?.status === 'unknown' && typeof value.detail === 'string' && value.detail.trim()
          ? value.detail
          : 'The provider cannot confirm whether this operation took effect. The outcome remains unknown; no automatic retry was attempted.'
      };
    };
    const failed = error => ({
      status: 'unknown',
      receipt: null,
      detail: `Could not confirm the outcome with the provider: ${error.message}. No automatic retry was attempted.`
    });
    let result;
    try {
      result = provider.lookup(idempotencyKey, options);
    } catch (error) {
      return failed(error);
    }
    if (result && typeof result.then === 'function') {
      return result.then(normalize, error => failed(error));
    }
    return normalize(result);
  }

  /**
   * Independently verify an acceptance receipt.
   *
   * A send response says the provider accepted the request. It does not say the
   * message exists. This reads the receipt back through the provider; anything
   * short of a definitive "found" must block, never complete.
   */
  #verifyReceiptSafely(receipt, provider = this.provider) {
    const failed = error => ({
      status: 'unknown',
      receipt: null,
      detail: `The send was accepted but could not be independently verified: ${error.message}`
    });
    let result;
    try {
      if (typeof provider.verifyReceipt === 'function') {
        result = provider.verifyReceipt(receipt);
      } else if (typeof provider.lookup === 'function') {
        result = provider.lookup(receipt?.idempotencyKey, { receiptId: receipt?.id });
      } else {
        return failed(new Error('the provider exposes no way to read the receipt back'));
      }
    } catch (error) {
      return failed(error);
    }
    if (result && typeof result.then === 'function') {
      return result.then(value => value, error => failed(error));
    }
    return result || failed(new Error('the provider returned no verification result'));
  }

  #actionIsCurrent(taskId, actionId) {
    const task = this.store.state.tasks[taskId];
    const action = task?.action;
    if (!task || !action || action.id !== actionId || action.status !== 'executing') return false;
    if (task.pendingCommitmentChange || ['withdrawn', 'withdrawn_pending_reconciliation'].includes(task.commitment?.status)) return false;
    const revision = Number(task.commitment?.revision || 1);
    if (Number(action.commitmentRevision || revision) !== revision) return false;
    if (Number(task.draft?.requestVersion || revision) !== revision) return false;
    return true;
  }

  /** Resolve a stale approved action only after the provider confirmed absence. */
  #finalizeSupersededAction(taskId, actionId) {
    let withdrawn = false;
    this.store.mutate(state => {
      const task = state.tasks[taskId];
      if (!task?.action || task.action.id !== actionId || !task.pendingCommitmentChange) return;
      const action = { ...task.action, status: 'superseded_before_send', resolvedAt: stamp(), resolution: 'provider_confirmed_absent' };
      task.actionHistory = task.actionHistory || [];
      task.actionHistory.push(action);
      if (task.actionHistory.length > 50) task.actionHistory.splice(0, task.actionHistory.length - 50);
      task.action = null;
      withdrawn = Boolean(task.pendingCommitmentChange.withdrawn);
      task.pendingCommitmentChange = null;
      task.reasoningPlan = null;
      task.updatedAt = stamp();
      if (withdrawn) {
        task.commitment.status = 'withdrawn';
        task.status = 'cancelled';
        task.reason = 'The request was withdrawn while the provider lookup was pending. The provider confirmed the old action was not sent; no further work will run.';
        record(state, 'request_withdrawal', task.reason, taskId);
      } else {
        task.commitment.status = 'active';
        task.status = 'newly_discovered';
        task.reason = 'The old approved action was confirmed absent and invalidated because the request changed. The revised request needs a new assessment and approval.';
        record(state, 'action_superseded', task.reason, taskId);
      }
    });
    if (!withdrawn) this.assess(taskId, null, { force: true, allowAutomation: false });
    else { this.#refreshAttention(); this.changed(); }
    return this.store.state.tasks[taskId];
  }

  #actionKey(taskId, action) {
    return JSON.stringify([taskId, action?.id, action?.version]);
  }

  #actionCanRecordResult(taskId, action) {
    const current = this.store.state.tasks[taskId]?.action;
    return Boolean(current && current.id === action.id && current.version === action.version &&
      !['verified_live', 'verified_simulated'].includes(current.status));
  }

  execute(taskId, options = {}) {
    const task = this.#requireTask(taskId);
    if (!task.action) throw new Error('External action has no approval');
    const key = this.#actionKey(taskId, task.action);
    if (this.executingActions.has(key)) throw new Error('An execution for this approved action is already in progress.');
    this.executingActions.add(key);
    try {
      const result = this.#executeAction(taskId, options);
      if (result && typeof result.then === 'function') return result.finally(() => this.executingActions.delete(key));
      this.executingActions.delete(key);
      return result;
    } catch (error) { this.executingActions.delete(key); throw error; }
  }

  #executeAction(taskId, options = {}) {
    const task = this.#requireTask(taskId);
    if (!task.action) throw new Error('External action has no approval');
    this.policy.authorize({ actionClass: task.action.actionClass || 'execute_external', approval: task.action, taskId });

    const actionId = task.action.id;
    const actionIdentity = { id: actionId, version: task.action.version };
    this.store.mutate(state => {
      const current = state.tasks[taskId];
      if (current?.action?.id === actionId) current.action.phase = 'lookup';
    });

    // Reconcile FIRST: a previous timeout may have occurred after acceptance.
    return this.#resolve(this.#lookupSafely(task.action.idempotencyKey, { receiptId: task.action.receiptId }, this.#providerForTask(task)), before => {
      if (!this.#actionCanRecordResult(taskId, actionIdentity)) return this.store.state.tasks[taskId];
      if (before.status === 'found') return this.confirm(taskId, before.receipt, true, 'lookup');
      if (before.status === 'unknown') return this.uncertain(taskId, before.detail || 'The provider cannot confirm whether the message was accepted. No retry was attempted.');
      if (!this.#actionIsCurrent(taskId, actionId)) return this.#finalizeSupersededAction(taskId, actionId);
      this.store.mutate(state => {
        const current = state.tasks[taskId];
        if (current?.action?.id === actionId) current.action.phase = 'sending';
      });
      return this.#resolve(this.#sendSafely(task, options), outcome => {
        if (!this.#actionCanRecordResult(taskId, actionIdentity)) return this.store.state.tasks[taskId];
        if (outcome.blocked) return this.uncertain(taskId, outcome.blocked);
        if (outcome.receipt) {
          // Accepted is not verified. Read the message back before claiming it exists.
          return this.#resolve(this.#verifyReceiptSafely(outcome.receipt, this.#providerForTask(task)), verification => {
            if (!this.#actionCanRecordResult(taskId, actionIdentity)) return this.store.state.tasks[taskId];
            if (verification?.status === 'found') return this.confirm(taskId, verification.receipt || outcome.receipt, false, 'receipt');
            return this.uncertain(
              taskId,
              `The provider accepted the message but it could not be independently verified. ${verification?.detail || 'No verification result was returned.'} Completion was not claimed and no retry was attempted.`,
              { status: 'accepted_live', receipt: outcome.receipt }
            );
          });
        }
        return this.#resolve(this.#lookupSafely(task.action.idempotencyKey, { receiptId: task.action.receiptId }, this.#providerForTask(task)), after => {
          if (!this.#actionCanRecordResult(taskId, actionIdentity)) return this.store.state.tasks[taskId];
          if (after.status === 'found') return this.confirm(taskId, after.receipt, true, 'lookup');
          if (after.status === 'unknown') return this.uncertain(taskId, after.detail);
          const current = this.store.state.tasks[taskId];
          if (current?.pendingCommitmentChange && !current.action?.receiptId) return this.#finalizeSupersededAction(taskId, actionId);
          return this.uncertain(taskId, 'Delivery timed out and the provider did not confirm acceptance. No automatic retry was attempted.');
        });
      });
    });
  }

  #sendSafely(task, options) {
    let result;
    try {
      result = this.#providerForTask(task).send({
        idempotencyKey: task.action.idempotencyKey,
        to: task.draft.to,
        subject: task.draft.subject,
        body: task.draft.body,
        documentUrl: task.draft.documentUrl,
        threadId: this.store.state.inbox.find(item => item.id === task.sourceEmailId)?.threadId || null
      }, options.failureMode);
    } catch (error) {
      return this.#sendFailure(error);
    }
    if (result && typeof result.then === 'function') {
      return result.then(value => ({ receipt: value || null }), error => this.#sendFailure(error));
    }
    return { receipt: result || null };
  }

  #sendFailure(error) {
    if (error instanceof UncertainDeliveryError) return {};
    return { blocked: `Delivery failed: ${error.message}. No automatic retry was attempted.` };
  }

  confirm(taskId, receipt, reconciled, via = reconciled ? 'lookup' : 'receipt') {
    let verifiedAction = null;
    let withdrawn = false;
    let recheckRevision = false;
    this.store.mutate(state => {
      const task = state.tasks[taskId];
      const live = Boolean(task.action?.live);
      task.updatedAt = stamp();
      task.action.status = live ? 'verified_live' : 'verified_simulated';
      task.action.receiptId = receipt.id;
      task.action.verifiedAt = stamp();
      task.action.verificationVia = reconciled ? 'provider_lookup' : 'receipt_read_back';
      verifiedAction = { ...task.action };
      const pendingChange = task.pendingCommitmentChange;
      if (pendingChange) {
        withdrawn = Boolean(pendingChange.withdrawn);
        task.actionHistory = task.actionHistory || [];
        task.actionHistory.push({ ...task.action, archivedAt: stamp(), archiveReason: withdrawn ? 'request withdrawn while action was in flight' : 'request revised while action was in flight' });
        if (task.actionHistory.length > 50) task.actionHistory.splice(0, task.actionHistory.length - 50);
        task.action = null;
        task.pendingCommitmentChange = null;
        if (withdrawn) {
          task.commitment.status = 'withdrawn_after_delivery';
          task.status = 'cancelled';
          task.reason = 'The request was withdrawn while the provider action was in flight. The action was verified afterward and was not undone; no further work will run.';
        } else {
          task.commitment.status = 'active';
          task.status = 'newly_discovered';
          task.reason = 'The previous approved action was verified after the request changed. The revised request needs a fresh assessment and approval.';
          task.draft = null;
          task.evidence = null;
          task.assessment = null;
          task.progress = null;
          recheckRevision = true;
        }
      } else {
        task.status = 'completed';
        task.reason = null;
      }
      const how = reconciled
        ? 'by idempotency-key lookup'
        : 'by reading the accepted message back';
      record(state, 'verification', live
        ? `Confirmed with Gmail that message ${receipt.id} exists (${how}).`
        : `Confirmed simulated provider receipt ${receipt.id} (${how}). This was not a real email.`, taskId);
    });
    this.#addTrace(traceEntry({
      stage: 'execution', taskId,
      input: { idempotencyKey: verifiedAction?.idempotencyKey || null, providerKind: verifiedAction?.providerKind || null, live: Boolean(verifiedAction?.live) },
      outcome: { status: 'verified', receiptId: receipt.id, reconciled: Boolean(reconciled), via, requestWithdrawnDuringAction: withdrawn }
    }));
    this.#refreshAttention();
    this.changed();
    if (recheckRevision) this.assess(taskId, null, { force: true, allowAutomation: false });
    return this.store.state.tasks[taskId];
  }

  /**
   * Block an external action whose outcome is not fully verified.
   *
   * `status: 'accepted_live'` means the provider accepted the send but the
   * message could not be read back: the action is not complete and not retried,
   * and reconciliation can still resolve it.
   */
  uncertain(taskId, reason, { status = 'uncertain', receipt = null } = {}) {
    if (typeof reason !== 'string' || !reason.trim()) reason = 'The provider has not confirmed whether this action took effect. No automatic retry was attempted.';
    this.store.mutate(state => {
      const task = state.tasks[taskId];
      task.status = 'blocked';
      task.updatedAt = stamp();
      task.reason = reason;
      if (task.action) {
        task.action.status = status;
        task.action.phase = 'uncertain';
        if (receipt?.id) task.action.receiptId = receipt.id;
      }
      record(state, 'uncertain', reason, taskId);
      // An unknown external outcome is exactly what the user must decide.
      emitNotification(state.notifications, notification({
        kind: 'blocker', priority: 'high', dedupeKey: `blocker:${taskId}`, taskId, at: stamp(),
        headline: status === 'accepted_live'
          ? 'An accepted message could not be verified'
          : 'An external action could not be confirmed',
        what: reason,
        why: status === 'accepted_live'
          ? 'Gmail accepted the send, but the message was not read back. Marking it complete could report delivery that was never verified; sending again could duplicate it.'
          : 'A message may or may not have been sent. Assuming success or retrying blindly could duplicate an external action.',
        checked: status === 'accepted_live'
          ? ['The provider accepted the send.', 'Read the accepted message back by its provider id; the result was not a confirmation.']
          : ['Looked the action up with the provider using its idempotency key.'],
        evidence: [{ detail: `Action ${task.action?.idempotencyKey || 'unknown'} was attempted against ${task.action?.providerKind || 'the provider'}.` }],
        uncertainty: ['Whether the provider accepted the action.'],
        decision: 'Reconcile the outcome with the provider, or leave it blocked?',
        options: [
          { value: 'reconcile', label: 'Reconcile the outcome' },
          { value: 'leave', label: 'Leave it blocked' }
        ]
      }));
    });
    this.#addTrace(traceEntry({
      stage: 'execution', taskId,
      input: {
        idempotencyKey: this.store.state.tasks[taskId].action?.idempotencyKey || null,
        providerKind: this.store.state.tasks[taskId].action?.providerKind || null
      },
      outcome: { status: 'blocked', reason }
    }));
    this.#refreshAttention();
    this.changed();
    return this.store.state.tasks[taskId];
  }

  reconcile(taskId) {
    const task = this.#requireTask(taskId);
    if (!task.action) throw new Error('No approved action to reconcile');
    this.policy.authorize({ actionClass: task.action.actionClass || 'execute_external', approval: task.action, taskId });
    const actionId = task.action.id;
    const actionIdentity = { id: actionId, version: task.action.version };
    const startingStatus = task.action.status;
    return this.#resolve(this.#lookupSafely(task.action.idempotencyKey, { receiptId: task.action.receiptId }, this.#providerForTask(task)), result => {
      if (!this.#actionCanRecordResult(taskId, actionIdentity)) return this.store.state.tasks[taskId];
      if (result.status === 'found') return this.confirm(taskId, result.receipt, true, 'lookup');
      if (this.store.state.tasks[taskId].action.status !== startingStatus) return this.store.state.tasks[taskId];
      // A send the provider already accepted can never reconcile to "confirmed
      // absent": that status enables a retry, and a retry after acceptance could
      // duplicate the message. Only an outcome that was never accepted can.
      const acceptedBefore = Boolean(task.action.receiptId);
      const inFlight = this.executingActions.has(this.#actionKey(taskId, actionIdentity));
      const absent = result.status === 'not_found' && !acceptedBefore && !inFlight;
      if (absent && this.store.state.tasks[taskId]?.pendingCommitmentChange) {
        return this.#finalizeSupersededAction(taskId, actionId);
      }
      const reason = inFlight && result.status === 'not_found'
        ? 'An approved send is still in progress. A missing lookup cannot confirm absence or authorize a retry.'
        : absent
        ? 'Provider definitively reports no matching message. Retry requires a separate click.'
        : result.status === 'not_found'
          ? 'The provider accepted this message earlier, but it cannot be found now. Treating the result as uncertain; do not resend without checking Gmail directly.'
          : result.detail || 'Provider still cannot determine whether delivery occurred. Do not retry.';
      this.store.mutate(state => {
        const current = state.tasks[taskId];
        current.status = 'blocked';
        current.reason = reason;
        current.action.status = absent ? 'confirmed_absent' : 'uncertain';
        record(state, 'reconciliation', reason, taskId);
      });
      this.#refreshAttention();
      this.changed();
      return this.store.state.tasks[taskId];
    });
  }

  retry(taskId) {
    const task = this.#requireTask(taskId);
    if (!task.action || task.action.status !== 'confirmed_absent') throw new Error('Retry requires confirmed absence and prior approval');
    const requestVersion = Number(task.commitment?.revision || 1);
    if (task.pendingCommitmentChange || Number(task.action.commitmentRevision || requestVersion) !== requestVersion ||
        Number(task.draft?.requestVersion || requestVersion) !== requestVersion || task.commitment?.status === 'withdrawn') {
      throw new Error('The request changed; retry requires a new assessment and approval');
    }
    const storedDocument = this.store.state.documents[task.documentId];
    const document = documentAvailable(storedDocument) ? storedDocument : null;
    if (!document || document.version !== task.draft.documentVersion) {
      throw new Error(storedDocument && !documentAvailable(storedDocument)
        ? 'The document is no longer available; retry requires a new approval'
        : 'Document changed; retry requires a new approval');
    }
    const recheck = assessPlan(this.#planFor(task), {
      documents: [document], runRecords: this.store.state.runRecords || {}, subjectEntity: task.request.subjectEntity
    });
    // A retry re-checks freshness as well as completeness: confirmed absence can
    // take long enough for a "latest" claim to go stale in between.
    const freshness = determineFreshness({
      document,
      documentRunDate: this.#runDateEvidence(recheck.criteria),
      runRecords: this.store.state.runRecords || {},
      request: task.request
    });
    const staleNow = freshness && ['stale', 'contradictory'].includes(freshness.status);
    if (!completionFromCriteria(recheck.criteria).complete || staleNow) {
      throw new Error(staleNow
        ? 'The evidence is no longer current; retry requires a new approval'
        : 'Document changed; retry requires a new approval');
    }
    this.store.mutate(state => {
      state.tasks[taskId].action.status = 'executing';
      state.tasks[taskId].status = 'verifying';
      record(state, 'retry', 'User requested retry after definitive provider absence; reconciling before sending.', taskId);
    });
    this.#refreshAttention();
    this.changed();
    return this.execute(taskId);
  }

  reject(taskId) {
    const task = this.#requireTask(taskId);
    if (task.status !== 'ready_for_approval') throw new Error('Task is not awaiting approval');
    this.store.mutate(state => {
      state.tasks[taskId].status = 'blocked';
      state.tasks[taskId].userDismissed = true;
      state.tasks[taskId].reason = 'User rejected the proposed response. Nothing was sent.';
      state.tasks[taskId].draft = null;
      this.#supersedeReasoning(state.tasks[taskId], 'user_declined');
      record(state, 'rejection', 'User rejected the draft. Nothing was sent.', taskId);
    });
    this.#refreshAttention();
    this.changed();
    return this.store.state.tasks[taskId];
  }

  /** Restore a declined or closed request using today's evidence, without sending. */
  reopen(taskId) {
    const task = this.#requireTask(taskId);
    if (task.kind === 'external_issue' && (!task.externalSource.assigned || task.externalSource.state !== 'open' || this.store.state.connectionAccounts?.github !== task.externalSource.accountId)) throw new Error('This issue is no longer actively assigned to the connected account.');
    if (task.action || !['blocked', 'cancelled'].includes(task.status)) {
      throw new Error('Only a declined or closed request without an action can be reopened');
    }
    this.store.mutate(state => {
      const target = state.tasks[taskId];
      target.status = 'waiting_for_information';
      target.userDismissed = false;
      target.draft = null;
      target.reason = null;
      target.updatedAt = stamp();
      record(state, 'reopening', 'User restored this request. Rechecking current evidence; nothing is sent by restoring it.', taskId);
    });
    this.assess(taskId, null, { force: true, allowAutomation: false });
    return this.store.state.tasks[taskId];
  }

  /**
   * Close a request that is still waiting for information.
   *
   * Deliberately narrow: this is the escape hatch for the one state the system
   * cannot leave on its own — a request whose evidence never arrived. The
   * closed request keeps its evidence and history, stops being assessed, and
   * can never be executed. Nothing was sent, so no external state needs
   * reconciling.
   */
  /**
   * Record the user's judgement of a discovery.
   *
   * The label is useful, noise, or awaiting evidence. It does not change task
   * status and it does not execute anything. Missing evidence is not noise
   * until the user says so.
   */
  labelDiscovery(taskId, labelOrInput, maybeReason) {
    this.#requireTask(taskId);
    const input = typeof labelOrInput === 'string' ? { label: labelOrInput, reason: maybeReason } : (labelOrInput || {});
    const label = input.label;
    const allowed = ['useful', 'not_useful', 'wrong_association', 'noise', 'awaiting_evidence'];
    if (!allowed.includes(label)) {
      throw new Error('Invalid discovery label. Expected useful, not_useful, wrong_association, noise, or awaiting_evidence.');
    }
    let reason = null;
    if (input.reason != null && input.reason !== '') {
      if (typeof input.reason !== 'string') throw new Error('Invalid judgement reason.');
      reason = input.reason.trim().slice(0, 280) || null;
    }
    this.store.mutate(state => {
      const current = state.tasks[taskId];
      const email = (state.events || []).find(event => event.type === 'email.received' && (event.relations || []).includes(taskId));
      const document = current.documentId ? state.documents[current.documentId] : null;
      current.feedback = {
        label,
        reason,
        at: stamp(),
        source: 'user',
        revision: state.revision + 1,
        evidence: {
          eventId: email?.id || null,
          eventSource: email?.source || null,
          providerEventId: email?.providerEventId || null,
          documentId: document?.id || null,
          documentSource: document?.source || null
        }
      };
      record(state, 'feedback', `User labelled this discovery ${label.replaceAll('_', ' ')}. Nothing was sent.`, taskId);
    });
    this.changed();
    return this.store.state.tasks[taskId];
  }

  /**
   * Record work the user noticed and the system did not discover.
   *
   * This is an observation, not a task. It does not enter correlation, does
   * not prepare an action, and does not send anything.
   */
  recordMiss({ note, sourceHint } = {}) {
    if (typeof note !== 'string' || !note.trim()) throw new Error('A missed item requires a description');
    const text = note.trim().slice(0, 500);
    const hint = typeof sourceHint === 'string' && sourceHint.trim() ? sourceHint.trim().slice(0, 200) : null;
    let entry;
    this.store.mutate(state => {
      state.misses = state.misses || [];
      entry = {
        id: `miss:${state.revision + 1}`,
        at: stamp(),
        revision: state.revision + 1,
        note: text,
        sourceHint: hint,
        source: 'user'
      };
      state.misses.push(entry);
      record(state, 'feedback', 'User recorded something the system did not discover. No task was created and nothing was sent.');
    });
    this.changed();
    return entry;
  }

  // ---------------------------------------------------- task services

  prepareDocumentPatch(taskId, options = {}) {
    return this.taskServices.prepareDocumentPatch(taskId, options);
  }

  applyDocumentPatch(taskId, options = {}) {
    return this.taskServices.applyDocumentPatch(taskId, options);
  }

  waitForTask(taskId, condition = {}) {
    return this.taskServices.waitForTask(taskId, condition);
  }

  recordTaskFeedback(taskId, feedback = {}) {
    const result = this.taskServices.recordTaskFeedback(taskId, feedback);
    if (result.label === 'wrong_association') this.assess(taskId, null, { force: true, allowAutomation: false });
    return result;
  }

  undoTaskFeedback(feedbackId) {
    const result = this.taskServices.undoTaskFeedback(feedbackId);
    if (result.taskId && result.label === 'wrong_association') {
      this.assess(result.taskId, null, { force: true, allowAutomation: false });
    }
    return result;
  }

  resolveDependency(dependencyId, decision = {}) {
    return this.taskServices.resolveDependency(dependencyId, decision);
  }

  createFollowUpForOpportunity(opportunityId) {
    return this.taskServices.createFollowUpForOpportunity(opportunityId);
  }

  cancel(taskId) {
    const task = this.#requireTask(taskId);
    if (task.status !== 'waiting_for_information') {
      throw new Error('Only a request that is still waiting for evidence can be closed');
    }
    this.store.mutate(state => {
      const current = state.tasks[taskId];
      current.status = 'cancelled';
      if (current.kind === 'external_issue') current.userDismissed = true;
      current.updatedAt = stamp();
      current.reason = 'Closed by the user while waiting for information. Nothing was sent.';
      current.draft = null;
      this.#supersedeReasoning(current, 'user_closed');
      record(state, 'cancellation', 'The user closed this request while it was waiting for information. Nothing was sent.', taskId);
    });
    this.#refreshAttention();
    this.changed();
    return this.store.state.tasks[taskId];
  }

  // --------------------------------------------------- calibration

  /**
   * Record something the user stated.
   *
   * Important information carries a source, a time and a
   * scope; the registry stores all three, and answering an open question closes
   * it in the same step rather than leaving a stale question behind.
   */
  recordCalibration({ key, kind = 'preference', value, scope = {}, origin = 'user_answer' }) {
    const at = stamp();
    let entry = null;
    this.store.mutate(state => {
      entry = recordCalibrationEntry(state.calibrations, { key, kind, value, scope, at, origin });
      for (const clarification of state.clarifications) {
        if (clarification.status !== 'open' || clarification.key !== key) continue;
        if (!scopeCovers(clarification.scope, scope)) continue;
        clarification.status = 'answered';
        clarification.answeredAt = at;
        clarification.answer = value;
      }
      // A stated date-reading preference immediately governs stored deadlines:
      // the days that were honestly ambiguous become calendar days, and those
      // that were already resolved stay as they are.
      if (key === PREFERENCE_KEYS.DATE_LOCALE) normaliseDeadlines(state, { dateLocale: this.dateLocale });
      record(state, 'calibration', `Recorded the user's answer: ${describeCalibration(entry)}`);
    });
    this.#refreshAttention();
    this.changed();
    return entry;
  }

  /** Correct the system's understanding, keeping the correction and its time. */
  correctCalibration({ key, kind, value, scope = {} }) {
    const at = stamp();
    let entry = null;
    this.store.mutate(state => {
      entry = correctCalibrationEntry(state.calibrations, { key, kind, value, scope, at });
      record(state, 'correction', `Corrected the system's understanding: ${describeCalibration(entry)}`);
    });
    this.#refreshAttention();
    this.changed();
    return entry;
  }

  /** Answer one open question about the user's goals, preferences or permissions. */
  answerClarification(id, value) {
    const clarification = (this.store.state.clarifications || []).find(item => item.id === id);
    if (!clarification) throw new Error('Unknown clarification');
    if (clarification.status !== 'open') throw new Error('That clarification is no longer open');
    return this.recordCalibration({
      key: clarification.key, kind: clarification.kind, value, scope: clarification.scope, origin: 'user_answer'
    });
  }

  // -------------------------------------------------- opportunities

  /**
   * Accept a proposed opportunity.
   *
   * Accepting records a decision only. It never starts a project, commits a
   * resource or makes an external commitment — that stays the user's call.
   */
  acceptOpportunity(id) {
    const opportunity = (this.store.state.opportunities || {})[id];
    if (!opportunity) throw new Error('Unknown opportunity');
    if (opportunity.status === 'resolved') throw new Error('That opportunity no longer applies');
    this.store.mutate(state => {
      state.opportunities[id].status = 'accepted';
      state.opportunities[id].decidedAt = stamp();
      record(state, 'opportunity_accepted', `The user chose to pursue an opportunity: ${opportunity.statement}`);
    });
    this.taskServices.createFollowUpForOpportunity(id);
    this.#refreshAttention();
    this.changed();
    return this.store.state.opportunities[id];
  }

  dismissOpportunity(id, note = null) {
    const opportunity = (this.store.state.opportunities || {})[id];
    if (!opportunity) throw new Error('Unknown opportunity');
    this.store.mutate(state => {
      state.opportunities[id].status = 'dismissed';
      state.opportunities[id].decidedAt = stamp();
      state.opportunities[id].decisionNote = note;
      record(state, 'opportunity_dismissed', `The user dismissed an opportunity: ${opportunity.statement}`);
    });
    this.#refreshAttention();
    this.changed();
    return this.store.state.opportunities[id];
  }

  // ------------------------------------------------- notifications

  markNotificationsRead(ids = null) {
    let marked = 0;
    this.store.mutate(state => { marked = markRead(state.notifications, ids, stamp()); });
    this.changed();
    return marked;
  }

  /**
   * Reconsider every condition that could deserve attention.
   *
   * State-driven rather than event-driven on purpose: it derives the open
   * decisions from the workspace as it is now, so a notification is withdrawn the
   * moment its condition clears and the same decision is never sent twice.
   */
  #refreshAttention(now = stamp()) {
    // Attention evaluation is a recurring derivation, not a transition: it must
    // run on every sweep (a day can pass with no event), but it must not rewrite
    // an unchanged workspace. See JsonStore.mutateIfChanged.
    return this.store.mutateIfChanged(state => {
      state.opportunities = mergeOpportunities(state.opportunities || {}, evaluateOpportunities(state, { now }));
      this.#deadlineNotifications(state, now);
      this.#deadlineAmbiguityNotifications(state, now);
      this.#riskNotifications(state, now);
      this.#permissionNotifications(state, now);
      this.#opportunityNotifications(state, now);
      this.#stallNotifications(state, now);
      resolveNotifications(state.notifications,
        item => item.kind === 'blocker' && state.tasks[item.taskId] != null && isSettled(state.tasks[item.taskId]), now);
    });
  }

  /**
   * A cheap periodic sweep, used by the server's sync tick.
   *
   * A stall is the one condition that must reach the user without a new
   * event, so it cannot wait for the next ingest. The sweep first checks —
   * without writing — whether a stall is actually due and unseen, so a quiet
   * workspace is not rewritten on every tick.
   */
  /**
   * A cheap periodic sweep, used by the server's sync tick.
   *
   * Two things can change without any new event: a stall window can elapse, and
   * a calendar day can pass. The second matters because some conditions —
   * a deadline coming inside the warning window, an ambiguous date becoming
   * material — are measured in days. Refreshing only when a stall is due meant a
   * quiet workspace never raised them, so the day boundary is checked too.
   *
   * The refresh still does not run on every tick: the day key changes at most
   * once per day, which keeps a quiet workspace from being rewritten (and its
   * revision bumped) on every pass. Returns true only when a stall was raised,
   * which is the condition that needs an immediate broadcast.
   */
  sweepAttention(now = new Date()) {
    this.taskServices.refreshWaits(now instanceof Date ? now.toISOString() : String(now));
    const at = now.getTime();
    const dayKey = new Date(at).toISOString().slice(0, 10);
    const dayChanged = this.lastAttentionDay !== dayKey;
    const due = Object.values(this.store.state.tasks || {}).some(task =>
      this.#stallWorthy(task, this.store.state, at) &&
      !(this.store.state.notifications || []).some(item => item.dedupeKey === `stalled:${task.id}` && !item.resolvedAt));
    if (!due && !dayChanged) return false;
    this.lastAttentionDay = dayKey;
    const { changed } = this.#refreshAttention(new Date(at).toISOString());
    // A refresh that found nothing new is not an event; broadcasting it would
    // claim the workspace moved when it did not.
    if (changed) this.changed();
    return due;
  }

  /**
   * Waiting has become being stuck.
   *
   * True only when a request is still waiting, its evidence has not changed for
   * `stallAfterMs`, and no stronger decision about it (an imminent deadline, a
   * conflict needing correction) is already open — a second, weaker
   * interruption about the same task would be noise, not information.
   */
  #stallWorthy(task, state, at) {
    if (task.kind === 'external_issue') return false;
    if (task.status !== 'waiting_for_information') return false;
    const since = task.progress?.at ? Date.parse(task.progress.at) : NaN;
    if (!Number.isFinite(since) || at - since < this.stallAfterMs) return false;
    return !(state.notifications || []).some(item =>
      !item.resolvedAt && item.taskId === task.id && ['deadline', 'risk'].includes(item.kind));
  }

  /** A key deadline is close and the completion condition is not met. */
  #deadlineNotifications(state, now) {
    const live = new Set();
    for (const task of Object.values(state.tasks || {})) {
      if (isSettled(task)) continue;
      // A prepared, complete draft is already waiting for approval. A deadline
      // interruption on top of that is noise — the completion condition is met.
      if (task.assessment?.complete) continue;
      const risk = deadlineRisk({ deadline: task.request?.deadline, now: new Date(now), withinDays: 3 });
      if (!risk) continue;
      const entity = task.request.subjectEntity;
      const key = `deadline:${task.id}:${risk.iso}`;
      live.add(key);
      emitNotification(state.notifications, notification({
        kind: 'deadline', priority: risk.overdue ? 'high' : 'normal', dedupeKey: key, taskId: task.id, at: now,
        headline: `${entity} ${task.request.deliverable} is due ${risk.iso}`,
        what: `The ${entity} ${task.request.deliverable} was requested by ${risk.iso}${risk.overdue ? ', which has passed' : `, ${risk.days} day(s) from now`}, and it is still not shown to be complete.`,
        why: 'A key deadline is close and the completion condition is not met, so this can still be changed if you act now.',
        checked: [
          `Extracted the deadline “${risk.text}” from the request email.`,
          'Re-read the correlated document and checked every requested criterion.'
        ],
        evidence: (task.assessment?.missing || []).map(label => ({ detail: `Not yet satisfied: ${label}` })),
        uncertainty: (task.assessment?.unknowns || []).slice(0, 2).map(item => item.reason),
        decision: 'Should this be prioritised because of the deadline, or is it safe to continue as it is?',
        options: [
          { value: 'continue', label: 'Continue as it is' },
          { value: 'prioritise', label: 'Prioritise this work' }
        ]
      }));
    }
    resolveNotifications(state.notifications, item => item.kind === 'deadline' && !live.has(item.dedupeKey), now);
  }

  /**
   * An ambiguous numeric deadline reaches the user only when the
   * reading changes a real decision.
   *
   * “by 10/11” matters when one reading falls inside the deadline window and
   * the other does not, or when one reading has already passed while the work
   * is still incomplete. If every reading is comfortably ahead, the question
   * would be noise and is not asked. Until it is answered the date is not
   * treated as a deadline at all: no deadline notification, no autonomous
   * action — `deadlineRisk` refuses an ambiguous day.
   */
  #deadlineAmbiguityNotifications(state, now) {
    const live = new Set();
    const liveClarifications = new Set();
    const material = Object.values(state.tasks || {})
      .filter(task => {
        if (isSettled(task) || task.assessment?.complete) return false;
        const deadline = task.request?.deadline;
        if (deadline?.ambiguous !== true || !deadline.candidates?.length) return false;
        return deadline.candidates.some(iso =>
          deadlineRisk({ deadline: { iso }, now: new Date(now), withinDays: 3 }) !== null);
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const task = material[0];
    if (task) {
      const deadline = task.request.deadline;
      const options = (deadline.readings || []).map(reading => ({
        value: reading.format,
        label: `${deadline.text} = ${describeDay(reading.iso)} (${reading.format === 'MM/DD' ? 'month/day' : 'day/month'})`
      }));
      const clarification = calibrationQuestion({
        key: PREFERENCE_KEYS.DATE_LOCALE,
        kind: 'preference',
        scope: {},
        question: `“${deadline.text}” could mean ${(deadline.candidates || []).map(describeDay).join(' or ')}. Which way do you write numeric dates?`,
        why: 'The two readings fall on different days, and one of them is close enough that it changes whether this request needs your attention now.',
        affects: 'Which calendar day a request is measured against, and whether a deadline warning is raised for it.',
        options,
        at: now
      });
      const existing = (state.clarifications || []).find(item => item.id === clarification.id);
      if (!existing) state.clarifications.push(clarification);
      else if (existing.status !== 'open') { existing.status = 'open'; existing.raisedAt = now; }
      liveClarifications.add(clarification.id);
      const key = 'deadline_ambiguous';
      live.add(key);
      emitNotification(state.notifications, notification({
        kind: 'calibration', priority: 'normal', dedupeKey: key, taskId: task.id, clarificationId: clarification.id, at: now,
        headline: `“${deadline.text}” could be two different days`,
        what: `A deadline in “${task.subject}” was written as “${deadline.text}”, which reads as ${(deadline.candidates || []).map(describeDay).join(' or ')} without a configured date format.`,
        why: 'Acting on the wrong reading could warn about the wrong day or miss the right one, so the deadline is treated as unknown until you decide how dates like this are read.',
        checked: [
          'No date format is configured, so both month/day and day/month readings were computed.',
          'Checked whether the reading changes a decision now — one candidate is inside the deadline window or already passed.',
          'The request stays waiting; nothing is sent or closed on an ambiguous date.'
        ],
        evidence: [{ detail: `Original deadline text: “${deadline.text}” (${deadline.reason})`, source: sourceRef({ kind: 'email', id: task.sourceEmailId, timestamp: task.createdAt }) }],
        uncertainty: [deadline.reason],
        decision: 'Which way should numeric dates be read?',
        options
      }));
    }
    for (const clarification of state.clarifications) {
      if (clarification.status === 'open' && clarification.key === PREFERENCE_KEYS.DATE_LOCALE && !liveClarifications.has(clarification.id)) {
        clarification.status = 'withdrawn';
      }
    }
    resolveNotifications(state.notifications, item => item.kind === 'calibration' && !live.has(item.dedupeKey), now);
  }

  /** Important risk or a likely serious omission (evidence that contradicts itself). */
  #riskNotifications(state, now) {
    const live = new Set();
    for (const task of Object.values(state.tasks || {})) {
      if (isSettled(task)) continue;
      for (const conflict of task.evidence?.conflicts || []) {
        if (!String(conflict.id).startsWith('conflicting:')) continue;
        const key = `risk:${task.id}:${conflict.id}`;
        live.add(key);
        emitNotification(state.notifications, notification({
          kind: 'risk', priority: 'high', dedupeKey: key, taskId: task.id, at: now,
          headline: `Contradictory evidence for ${task.request.subjectEntity}`,
          what: conflict.detail,
          why: 'Acting on evidence that contradicts itself could produce a wrong result, so no action is taken until it is resolved.',
          checked: [
            'Searched the correlated document for every requested criterion.',
            'Compared the values found for the same criterion.'
          ],
          evidence: [{ detail: conflict.detail }],
          uncertainty: ['Which of the conflicting values is correct is not established.'],
          decision: 'Which value is correct, or should the conflicting content be removed?',
          options: [
            { value: 'corrected', label: 'I will correct the document' },
            { value: 'continue', label: 'Treat the conflict as resolved' }
          ]
        }));
      }
    }
    resolveNotifications(state.notifications, item => item.kind === 'risk' && !live.has(item.dedupeKey), now);
  }

  /** Continuing needs a permission decision, asked once, with a scope. */
  #permissionNotifications(state, now) {
    const groups = new Map();
    for (const task of Object.values(state.tasks || {})) {
      const entity = task.request?.subjectEntity;
      if (!entity || isSettled(task)) continue;
      if (!groups.has(entity)) groups.set(entity, []);
      groups.get(entity).push(task);
    }
    const liveClarifications = new Set();
    const liveNotifications = new Set();
    for (const [entity, group] of groups) {
      // One request is not a repeated flow; asking how to run it would be noise.
      if (group.length < 2) continue;
      if (grantFor(state.calibrations || {}, { entity })) continue; // already authorised
      // A settled scope is asked about once. "Never send for X" and "ask me each
      // time" are answers to the standing question; re-raising it would re-open
      // a decision the user already made. Neither answer authorises anything —
      // only an explicit `allow` reaches the pre-authorised execution path, and
      // per-action approvals are unaffected.
      if (permissionAnswerFor(state.calibrations || {}, { entity })) continue;
      const key = `${PERMISSION_KEYS.SEND_AUTOMATION}:${entity}`;
      const clarification = calibrationQuestion({
        key: PERMISSION_KEYS.SEND_AUTOMATION,
        kind: 'permission',
        scope: { entity },
        question: `Should repeated “${entity}” follow-through run within a scope you approve, or keep asking you each time?`,
        why: `${group.length} separate requests for ${entity} each needed the same follow-through, so a standing decision is where the most attention is saved.`,
        affects: `Whether the system may deliver an approved ${entity} follow-through without a fresh click, or must ask every time.`,
        options: [
          { value: 'allow', label: `Allow for ${entity}` },
          { value: 'ask_each_time', label: 'Ask me each time' },
          { value: 'never', label: `Never send for ${entity}` }
        ],
        at: now
      });
      const existing = (state.clarifications || []).find(item => item.id === clarification.id);
      if (!existing) state.clarifications.push(clarification);
      else if (existing.status !== 'open') { existing.status = 'open'; existing.raisedAt = now; }
      liveClarifications.add(clarification.id);
      liveNotifications.add(key);
      emitNotification(state.notifications, notification({
        kind: 'permission', priority: 'normal', dedupeKey: key, clarificationId: clarification.id, at: now,
        headline: `A standing decision would help for ${entity}`,
        what: `${group.length} separate ${entity} requests each required the same follow-through.`,
        why: 'Each one currently waits for a decision. A clearly scoped authorisation would let the repeated flow run inside that boundary, with every result still verified.',
        checked: [
          'Checked whether an authorisation already covers this scope — none does.',
          'Confirmed the requests are distinct follow-throughs rather than duplicates.'
        ],
        evidence: group.map(task => ({
          detail: `${task.request.intent.replaceAll('_', ' ')} for ${entity} (${task.status})`,
          source: sourceRef({ kind: 'email', id: task.sourceEmailId, timestamp: task.createdAt })
        })),
        uncertainty: ['Whether you want this flow to run without asking, and for which scope.'],
        decision: clarification.question,
        options: clarification.options
      }));
    }
    for (const clarification of state.clarifications) {
      if (clarification.status === 'open' && clarification.kind === 'permission' && !liveClarifications.has(clarification.id)) {
        clarification.status = 'withdrawn';
      }
    }
    resolveNotifications(state.notifications, item => item.kind === 'permission' && !liveNotifications.has(item.dedupeKey), now);
  }

  /** A valuable opportunity worth a user decision, with its evidence attached. */
  #opportunityNotifications(state, now) {
    const live = new Set();
    for (const opportunity of openOpportunities(state.opportunities)) {
      const key = `opportunity:${opportunity.id}`;
      live.add(key);
      emitNotification(state.notifications, notification({
        kind: 'opportunity', priority: opportunity.benefit === 'high' ? 'high' : 'normal',
        dedupeKey: key, opportunityId: opportunity.id, at: now,
        headline: opportunity.kind.replaceAll('_', ' '),
        what: opportunity.statement,
        why: `It concerns a problem in existing work, and the preliminary check already supports pursuing it (${opportunity.benefit} benefit, ${opportunity.verificationCost} verification cost).`,
        nextStep: opportunity.nextStep,
        checked: (opportunity.exploration?.basis || []).map(basis => basis.detail),
        evidence: (opportunity.evidence || []).map(item => ({ detail: item.detail, source: item.source })),
        uncertainty: ['Whether the benefit is worth acting on now.'],
        decision: 'Pursue this, leave it parked, or dismiss it?',
        options: [
          { value: 'accept', label: 'Pursue this' },
          { value: 'dismiss', label: 'Not now' }
        ]
      }));
    }
    resolveNotifications(state.notifications, item => item.kind === 'opportunity' && !live.has(item.dedupeKey), now);
  }

  /**
   * A request that stopped making progress reaches the user once.
   *
   * The alternative is silent indefinite waiting — the failure mode where work
   * "disappears" because no event ever arrives again. The decision offered is
   * the real one: supply the missing information, or close the request. The
   * notification withdraws by itself when evidence moves or the task is closed.
   */
  #stallNotifications(state, now) {
    const at = Date.parse(now);
    const live = new Set();
    for (const task of Object.values(state.tasks || {})) {
      if (!this.#stallWorthy(task, state, at)) continue;
      const stalledFor = at - Date.parse(task.progress.at);
      const key = `stalled:${task.id}`;
      live.add(key);
      const missing = task.assessment?.missing || [];
      const unknowns = task.evidence?.unknowns || [];
      emitNotification(state.notifications, notification({
        kind: 'blocker', priority: 'normal', dedupeKey: key, taskId: task.id, at: now,
        headline: `No progress on the ${task.request.subjectEntity} ${task.request.deliverable}`,
        what: `This request has not advanced for ${describeDuration(stalledFor)}: its verification requirements and blockers have not changed since ${task.progress.at}.${missing.length ? ` Still not satisfied: ${missing.join('; ')}.` : ''}`,
        why: 'Nothing the system can observe has satisfied it, so it cannot complete without new information or a decision to close it.',
        checked: [
          `Compared the required conditions and blockers at the last meaningful change (${task.progress.at}).`,
          'Confirmed that subsequent observations have not changed those conditions.'
        ],
        evidence: [
          ...missing.map(label => ({ detail: `Not yet satisfied: ${label}` })),
          ...unknowns.slice(0, 2).map(item => ({ detail: item.reason }))
        ],
        uncertainty: unknowns.slice(0, 2).map(item => item.whatWouldResolveIt || 'What would settle this is not yet known.'),
        decision: 'Provide the missing information, or close this request?',
        options: [
          { value: 'close', label: 'Close this request' },
          { value: 'acknowledge', label: 'Keep waiting' }
        ]
      }));
    }
    resolveNotifications(state.notifications,
      item => item.kind === 'blocker' && String(item.dedupeKey || '').startsWith('stalled:') && !live.has(item.dedupeKey), now);
  }

  /** Run a prepared action that a stated, scoped pre-authorisation covers. */
  #runPreAuthorized(taskId, grant) {
    const provider = this.#providerForTask(this.store.state.tasks[taskId]);
    if (provider.live && provider.canSend === false) return;
    try {
      this.#track(this.executePreAuthorized(taskId, grant));
    } catch (error) {
      this.store.mutate(state => {
        record(state, 'pre_authorization_failure',
          `A pre-authorised action could not proceed (${error.message}); the draft stays ready for approval.`, taskId);
      });
    }
  }

  /** Execute inside a stated, scoped pre-authorisation, then verify as usual. */
  executePreAuthorized(taskId, grant = null) {
    const task = this.#requireTask(taskId);
    const provider = this.#providerForTask(task);
    if (this.#primaryReviewMissing(task)) throw new Error('Model interpretation is not verified yet.');
    if (task.status !== 'ready_for_approval' || !task.draft) throw new Error('Task is not ready for approval');
    if (provider.live && provider.canSend === false) throw new PermissionDeniedError('Delivery is not enabled for this source.');
    const requestVersion = Number(task.commitment?.revision || 1);
    if (Number(task.draft.requestVersion || 1) !== requestVersion || (task.commitment?.status && task.commitment.status !== 'active')) {
      this.assess(taskId, null, { force: true, allowAutomation: false });
      throw new Error('The request changed; the draft must be reviewed again');
    }
    const resolved = grant || grantFor(this.store.state.calibrations || {}, {
      entity: task.request.subjectEntity, deliverable: task.request.deliverable
    });
    if (!resolved) throw new Error('No pre-authorisation covers this action');
    // Strengthened verification is the one case a standing grant cannot cover:
    // a competing plausible source could contradict the draft, so the public
    // entry point refuses even when a caller resolves the grant itself.
    if (task.verification?.depth === 'enhanced') {
      throw new Error('Enhanced verification requires an explicit approval for this action');
    }
    // Refuse before any state change. A shadowed or invalid grant must not
    // move the task into verifying or contact the provider.
    this.policy.authorize({
      actionClass: 'execute_external',
      approval: {
        permission: 'pre_authorized',
        taskId,
        source: resolved.source,
        scope: resolved.scope,
        grantId: resolved.id
      },
      taskId
    });
    const storedDocument = this.store.state.documents[task.documentId];
    const document = documentAvailable(storedDocument) ? storedDocument : null;
    const recheck = document
      ? assessPlan(this.#planFor(task), { documents: [document], runRecords: this.store.state.runRecords || {}, subjectEntity: task.request.subjectEntity })
      : { criteria: [] };
    // The same freshness recheck as approve() and retry(): a pre-authorised
    // action must not deliver evidence that went stale after the draft was
    // prepared. The automatic caller runs moments after `assess()` gated on
    // completeness, but this is also a public entry point.
    const freshness = document
      ? determineFreshness({
        document,
        documentRunDate: this.#runDateEvidence(recheck.criteria),
        runRecords: this.store.state.runRecords || {},
        request: task.request
      })
      : null;
    const staleNow = freshness && ['stale', 'contradictory'].includes(freshness.status);
    if (!document || document.version !== task.draft.documentVersion || !completionFromCriteria(recheck.criteria).complete || staleNow) {
      const reason = storedDocument && !documentAvailable(storedDocument)
        ? 'The document is no longer available; the draft must be reviewed again'
        : staleNow
          ? 'The evidence is no longer current; the draft must be reviewed again'
          : 'The document changed; the draft must be reviewed again';
      this.assess(taskId);
      throw new Error(reason);
    }
    const actionVersion = Number(task.actionVersion || 0) + 1;
    const versionSuffix = requestVersion > 1 ? `:r${requestVersion}` : '';
    const action = {
      id: `send:${taskId}:${document.version}${versionSuffix}`,
      idempotencyKey: `send:${taskId}:${document.version}${versionSuffix}`,
      version: actionVersion,
      commitmentRevision: requestVersion,
      actionClass: 'execute_external',
      permission: 'pre_authorized',
      source: resolved.source,
      grantId: resolved.id,
      scope: resolved.scope,
      approvedAt: stamp(),
      status: 'executing',
      phase: 'approved',
      providerKind: provider.kind,
      live: Boolean(provider.live),
      receiptId: null
    };
    this.store.mutate(state => {
      state.tasks[taskId].status = 'verifying';
      state.tasks[taskId].actionVersion = actionVersion;
      state.tasks[taskId].action = action;
      record(state, 'pre_authorized',
        `Ran the ${task.request.subjectEntity} follow-through within the authorisation you granted (${resolved.id}). Verifying the result with the provider.`, taskId);
    });
    this.#addTrace(traceEntry({
      stage: 'policy', taskId,
      input: { actionClass: 'execute_external', idempotencyKey: action.idempotencyKey, documentId: document.id, documentVersion: document.version },
      policy: { permission: 'pre_authorized', decision: 'allowed', reason: 'Pre-authorised scope from the user.', grantId: resolved.id, scope: resolved.scope },
      outcome: { status: 'verifying' }
    }));
    this.changed();
    return this.execute(taskId);
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Restart recovery.
   *
   * An action interrupted mid-flight is reconciled against the provider before
   * anything else, because it may already have been accepted. Assessment is
   * then resumed for tasks whose evidence is stale or missing.
   */
  recover() {
    return this.restorePendingWork({ reason: 'startup' });
  }

  replaceReasoner(reasoner) {
    if (this.pendingReasoning.size || this.pendingDiscovery.size) {
      const error = new Error('Model reasoning is still running. Wait for it to finish before changing the connection.');
      error.code = 'MODEL_BUSY'; throw error;
    }
    this.reasoner = reasoner;
    if (reasoner.preferModelInterpretation) {
      this.store.mutate(state => {
        for (const task of Object.values(state.tasks)) if (!isSettled(task) && !task.action) {
          task.modelReview = null; task.reasoningWork = null;
        }
      });
      for (const task of Object.values(this.store.state.tasks)) if (!isSettled(task) && !task.action) {
        this.assess(task.id, null, { force: true, allowAutomation: false });
        const message = this.#taskSourceMessage(task);
        if (message) this.#maybeRefineWithModel(task.id, message);
      }
    }
    this.changed();
  }

  #primaryReviewMissing(task) {
    if (task.kind === 'external_issue') return false;
    return this.reasoner.preferModelInterpretation === true &&
      !(task.modelReview?.status === 'verified' && task.modelReview.requestVersion === Number(task.commitment?.revision || 1));
  }

  /** Recheck unfinished work and bounded reasoning after startup or an explicit resume. */
  restorePendingWork({ reason = 'manual' } = {}) {
    const summary = { reason, checked: 0, reassessed: 0, reconciliations: 0, reasoningResumed: 0, discoveryResumed: 0, failures: 0 };
    const startingRevision = this.store.state.revision;
    const now = stamp();
    this.taskServices.refreshWaits(now);
    for (const task of Object.values(this.store.state.tasks || {})) {
      summary.checked += 1;
      try {
        if (task.action && ['executing', 'uncertain', 'accepted_live'].includes(task.action.status)) {
          summary.reconciliations += 1;
          const result = this.reconcile(task.id);
          if (result && typeof result.then === 'function') this.#track(result);
          continue;
        }
        if (task.commitment?.status === 'withdrawn_pending_reconciliation' && !task.action) {
          this.store.mutate(state => {
            const current = state.tasks[task.id];
            current.commitment.status = 'withdrawn';
            current.status = 'cancelled';
            current.pendingCommitmentChange = null;
            current.reason = 'The withdrawn request had no action left to reconcile; it was closed during recovery.';
            record(state, 'recovery', current.reason, task.id);
          });
          continue;
        }
        if (task.status === 'completed' || task.status === 'cancelled' || task.userDismissed) continue;
        // Recompute the current dependencies; identical evidence signatures
        // take the read-only fast path and do not rewrite history on every boot.
        this.assess(task.id, null, { force: false, allowAutomation: false });
        summary.reassessed += 1;
        if (this.#resumeReasoningForTask(task.id)) summary.reasoningResumed += 1;
      } catch (error) {
        summary.failures += 1;
        this.store.mutate(state => {
          record(state, 'recovery_failure', `Could not resume ${task.id}: ${error.message}`, task.id);
        });
        console.error(`Recovery failed for ${task.id}:`, error.message);
      }
    }
    for (const event of this.store.state.events || []) {
      if (this.pendingReasoning.size + this.pendingDiscovery.size >= REASONING_RECOVERY.maxStartsPerSweep) break;
      if (event.type !== 'email.received' || !['not_started', 'pending', 'running', 'failed'].includes(event.reasoning?.status)) continue;
      const message = this.store.state.inbox.find(item => item.id === event.payload?.id) || event.payload;
      if (!this.reasoner?.available?.() || Number(event.reasoning.attempts || 0) >= Math.min(2, Number(event.reasoning.maxAttempts) || 2)) continue;
      const key = message.threadId ? String(message.threadId) : `message:${message.id}`;
      if (this.#maybeRecoverUnrecognizedMessage(event, this.threadGenerations.get(key) || 0)) summary.discoveryResumed += 1;
    }
    this.#refreshAttention(now);
    if (this.store.state.revision !== startingRevision) this.changed();
    return summary;
  }

  #resumeReasoningForTask(taskId, { now = Date.now(), dueOnly = false } = {}) {
    const task = this.store.state.tasks[taskId];
    if (!task || isSettled(task) || !this.reasoner?.available?.()) return false;
    const source = this.store.state.inbox.find(item => item.id === task.sourceEmailId) ||
      this.store.state.inbox.find(item => item.id === task.request?.source?.id);
    if (!source) return false;
    const work = task.reasoningWork;
    if (dueOnly && !reasoningMayResume(work, now, { automatic: true })) return false;
    if (work?.status === 'failed' && !reasoningMayResume(work, now)) return false;
    if (this.pendingReasoning.size + this.pendingDiscovery.size >= REASONING_RECOVERY.maxStartsPerSweep) return false;
    if (work && ['pending', 'running', 'failed'].includes(work.status) && Number(work.attempts || 0) < Number(work.maxAttempts || 2)) {
      if (this.pendingReasoning.has(work.key)) return false;
      if (work.status === 'running') {
        this.store.mutate(state => {
          const current = state.tasks[taskId];
          if (current?.reasoningWork?.key !== work.key) return;
          current.reasoningWork = { ...current.reasoningWork, status: 'pending', updatedAt: stamp(), recovery: 'interrupted' };
          record(state, 'reasoning_recovery', 'A reasoning job was interrupted by restart and is queued for one bounded retry.', taskId);
        });
      }
      if (work.kind === 'interpret') return this.#maybeRefineWithModel(taskId, source, { resume: true });
      if (work.kind === 'probes') return this.#maybeProposeProbes(taskId, { resume: true }) === true;
    }
    if (work && ['complete', 'no_proposal', 'superseded'].includes(work.status)) return false;
    if (this.#maybeRefineWithModel(taskId, source)) return true;
    const before = this.store.state.tasks[taskId]?.reasoningWork?.status;
    this.#maybeProposeProbes(taskId);
    return this.store.state.tasks[taskId]?.reasoningWork?.status === 'running' || before === 'running';
  }

  /** Retry saved model work while its durable attempt ceiling permits it. */
  retryPendingReasoning(taskId = null, { now = new Date(), dueOnly = false } = {}) {
    let tasks = 0;
    let discoveries = 0;
    const at = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(at)) throw new Error('Invalid reasoning recovery time.');
    const hasCapacity = () => !dueOnly || tasks + discoveries < REASONING_RECOVERY.maxStartsPerSweep &&
      this.pendingReasoning.size + this.pendingDiscovery.size < REASONING_RECOVERY.maxStartsPerSweep;
    for (const task of Object.values(this.store.state.tasks || {})) {
      if (!hasCapacity()) break;
      if (taskId && task.id !== taskId) continue;
      if (this.#resumeReasoningForTask(task.id, { now: at, dueOnly })) tasks += 1;
    }
    for (const event of this.store.state.events || []) {
      if (!hasCapacity()) break;
      if (taskId || event.type !== 'email.received' || !['not_started', 'pending', 'running', 'failed'].includes(event.reasoning?.status)) continue;
      const message = this.store.state.inbox.find(item => item.id === event.payload?.id) || event.payload;
      if (Number(event.reasoning.attempts || 0) >= Math.min(2, Number(event.reasoning.maxAttempts) || 2)) continue;
      if (dueOnly && !reasoningMayResume(event.reasoning, at, { automatic: true })) continue;
      const key = message.threadId ? String(message.threadId) : `message:${message.id}`;
      if (this.#maybeRecoverUnrecognizedMessage(event, this.threadGenerations.get(key) || 0, { now: at, dueOnly })) discoveries += 1;
    }
    return { tasks, discoveries };
  }
}
