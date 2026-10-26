import crypto from 'node:crypto';
import { aggregateTaskDependencies, projectTaskManagement } from './task-management.js';
import {
  LocalDocumentProvider, requestSignature, validateDocumentChanges, applyTextChanges
} from './document-delivery.js';
import { normalizeAddress, requestRevisionSignature } from './commitments.js';
import { rankCandidates } from './correlation.js';
import { assessPlan } from './probes/assess.js';
import { buildDeterministicPlan } from './probes/plan.js';
import { interpretRequest } from './requests.js';

const stamp = () => new Date().toISOString();
const normalise = value => String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const safeId = value => String(value ?? '').trim().slice(0, 240);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
const ACTIVE_TASKS = new Set(['newly_discovered', 'waiting_for_information', 'ready_for_approval', 'verifying', 'blocked']);
const AUTO_PATCH_BUDGET = 4_000;

function requireTask(state, taskId) {
  const task = state.tasks?.[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}

function requestFields(request = {}, message = null, documentId = null) {
  return {
    sender: message?.from || request.source?.from ? normalizeAddress(message?.from || request.source?.from) : null,
    threadId: message?.threadId || request.source?.threadId || null,
    subjectEntity: request.subjectEntity || null,
    deliverable: request.deliverable || null,
    ...(documentId ? { documentId } : {})
  };
}

function messageForTask(state, task) {
  return (state.inbox || []).find(item => item.id === task.sourceEmailId) || null;
}

function handledSnapshotForTask(task, state) {
  const message = messageForTask(state, task);
  return {
    threadId: message?.threadId || task.commitment?.threadId || task.request?.source?.threadId || null,
    sourceMessageId: task.sourceEmailId || task.request?.source?.id || null,
    sender: normalizeAddress(message?.from || task.request?.source?.from || task.sender) || null,
    requestRevisionSignature: task.request ? requestRevisionSignature(task.request) : null
  };
}

function inferLegacyHandledSnapshot(rule, state) {
  const task = state.tasks?.[rule.taskId];
  if (!task) return null;
  const origin = messageForTask(state, task);
  const history = (task.requestHistory || []).filter(item => item?.signature || item?.request);
  const cutoff = Date.parse(rule.createdAt || '');
  const eligible = Number.isFinite(cutoff)
    ? history.filter(item => !item.at || !Number.isFinite(Date.parse(item.at)) || Date.parse(item.at) <= cutoff)
    : [];
  eligible.sort((a, b) => Date.parse(a.at || '') - Date.parse(b.at || ''));
  const historical = eligible.at(-1) || history.find(item => item.kind === 'initial') || null;
  let sourceRequest = historical?.request || null;
  if (!sourceRequest && origin) {
    try { sourceRequest = interpretRequest(origin); } catch { /* a missing source cannot justify suppression */ }
  }
  if (!sourceRequest && task.request?.source?.id === task.sourceEmailId) sourceRequest = task.request;
  const signature = historical?.signature || (sourceRequest ? requestRevisionSignature(sourceRequest) : null);
  const initialHistory = history.find(item => item.kind === 'initial') || history[0] || null;
  const sourceMessageId = task.sourceEmailId || initialHistory?.sourceMessageId || sourceRequest?.source?.id || null;
  const threadId = origin?.threadId || initialHistory?.source?.threadId || task.commitment?.threadId || sourceRequest?.source?.threadId || null;
  const sender = normalizeAddress(origin?.from || initialHistory?.source?.from || sourceRequest?.source?.from || task.sender) || null;
  if (!signature || (!threadId && !sourceMessageId) || !sender) return null;
  return { threadId: threadId || null, sourceMessageId, sender, requestRevisionSignature: signature };
}

function alreadyHandledMatches(rule, request, message, state) {
  const snapshot = rule.handledSnapshot || inferLegacyHandledSnapshot(rule, state);
  if (!snapshot?.requestRevisionSignature || !snapshot.sender) return false;
  const candidateThreadId = message?.threadId || request?.source?.threadId || null;
  const candidateSourceId = message?.id || request?.source?.id || null;
  if (snapshot.threadId) {
    if (normalise(candidateThreadId) !== normalise(snapshot.threadId)) return false;
  } else if (!snapshot.sourceMessageId || candidateSourceId !== snapshot.sourceMessageId) {
    return false;
  }
  const candidateSender = normalizeAddress(message?.from || request?.source?.from);
  if (candidateSender !== snapshot.sender) return false;
  return requestRevisionSignature(request) === snapshot.requestRevisionSignature;
}

function fieldsMatch(scope, fields) {
  const selectors = Object.entries(scope || {}).filter(([, value]) => value != null && String(value).trim());
  return selectors.length > 0 && selectors.every(([key, value]) => key === 'sender'
    ? normalizeAddress(fields[key]) === normalizeAddress(value)
    : normalise(fields[key]) === normalise(value));
}

function validateFeedbackScope(label, scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('Feedback needs a finite scope.');
  const allowed = new Set(['sender', 'threadId', 'subjectEntity', 'deliverable', 'documentId']);
  const clean = {};
  for (const [key, value] of Object.entries(scope)) {
    if (!allowed.has(key)) throw new Error(`Unsupported feedback scope selector: ${key}`);
    if (typeof value !== 'string' || !value.trim() || value.length > 240) throw new Error(`Feedback scope ${key} must be a non-empty string under 240 characters.`);
    clean[key] = value.trim();
  }
  const selectors = Object.keys(clean);
  if (!selectors.length) throw new Error('Feedback needs at least one exact-match scope selector.');
  if (label === 'not_mine' && !clean.threadId && selectors.length < 2) {
    throw new Error('“Not mine” needs an exact thread ID or at least two scope selectors.');
  }
  if (label === 'already_handled' && !clean.threadId && !clean.subjectEntity) {
    throw new Error('“Already handled” needs an exact thread or subject entity scope.');
  }
  if (label === 'wrong_association' && !clean.documentId) {
    throw new Error('“Wrong association” needs the exact document ID to exclude.');
  }
  return clean;
}

function riskFor(task, state, now, wait) {
  if (task.evidence?.conflicts?.length) return { kind: 'evidence_conflict', reason: 'New conflicting evidence needs review.' };
  if (task.action?.status === 'uncertain') return { kind: 'uncertain_result', reason: 'The external action result is uncertain and needs reconciliation.' };
  const deadline = task.request?.deadline;
  if (deadline?.iso && !deadline.ambiguous) {
    const until = Date.parse(`${deadline.iso}T23:59:59.999Z`);
    const remaining = until - Date.parse(now);
    if (remaining <= 3 * 86_400_000) {
      return { kind: 'deadline_risk', reason: remaining < 0 ? `The ${deadline.iso} deadline has passed.` : `The ${deadline.iso} deadline is within three days.` };
    }
  }
  const waitingOnGoogle = wait?.base?.provider === 'google';
  if (waitingOnGoogle && Object.entries(state.connectorStatus || {}).some(([id, status]) =>
    status?.ok === false && (id === 'google' || status.connectorId === 'google'))) {
    return { kind: 'provider_failure', reason: 'A critical provider failure interrupted the wait.' };
  }
  return null;
}

function conditionMet(wait, state, now, event = null) {
  if (wait.kind === 'time') return Date.parse(wait.until) <= Date.parse(now);
  if (wait.kind === 'document') {
    const id = wait.condition.documentId;
    const current = state.documents?.[id];
    const eventMatch = !event || (event.type === 'document.modified' && String(event.payload?.id) === id);
    const task = state.tasks?.[wait.taskId];
    const semanticChanged = wait.base?.progressSemanticSignature
      ? task?.progress?.semanticSignature !== wait.base.progressSemanticSignature
      : hash(String(current?.content || '').replace(/\s+/g, ' ').trim()) !== wait.base?.documentContentSignature;
    const requestChanged = task && requestSignature(task) !== wait.base?.requestSignature;
    return Boolean(current && current.available !== false && current.version > Number(wait.base?.documentVersion || 0) && eventMatch && (semanticChanged || requestChanged));
  }
  if (wait.kind === 'reply') {
    const threadId = wait.condition.threadId;
    if (event && (event.type !== 'email.received' || event.payload?.threadId !== threadId || event.payload?.id === wait.base?.messageId)) return false;
    return (state.inbox || []).some(message => message.threadId === threadId && message.id !== wait.base?.messageId && Date.parse(message.receivedAt || '') > Date.parse(wait.createdAt));
  }
  return false;
}

function insertHistory(state, kind, text, taskId, at = stamp()) {
  state.history = state.history || [];
  state.history.push({ id: `h-${state.history.length + 1}`, at, kind, text, taskId: taskId || null, eventId: null });
}

function autoSourceBackedChanges(task, state, targetDocument) {
  if (task.evidence?.conflicts?.length) {
    return { changes: [], blockers: ['Current evidence contains a conflict. Resolve it before assembling a document patch.'] };
  }
  if (task.evidence?.plan?.restoreBlocked) {
    return { changes: [], blockers: ['The saved verification plan is no longer valid, so source-backed patch preparation is paused.'] };
  }
  let plan = task.evidence?.plan?.specs?.length ? task.evidence.plan : buildDeterministicPlan(task.request);
  const taskCriteria = task.evidence?.criteria?.length ? task.evidence.criteria : assessPlan(plan, {
    documents: [targetDocument], runRecords: state.runRecords || {}, subjectEntity: task.request.subjectEntity
  }).criteria;
  const missing = taskCriteria.filter(item => item.required !== false && item.status !== 'satisfied');
  if (!missing.length) {
    return { changes: [], blockers: ['The current assessment has no unsatisfied content criterion to patch.'] };
  }
  const documents = Object.fromEntries(Object.entries(state.documents || {}).filter(([id, document]) =>
    id !== targetDocument.id && document.available !== false && typeof document.content === 'string'));
  const sourceMessage = messageForTask(state, task);
  const activeAssociationExclusions = Object.values(state.taskFeedbackRules || {}).filter(rule =>
    rule.active && rule.label === 'wrong_association');
  const ranked = rankCandidates(task.request, documents).ranked.filter(({ document }) => {
    const fields = requestFields(task.request, sourceMessage, document.id);
    return !activeAssociationExclusions.some(rule => fieldsMatch(rule.scope, fields));
  });
  const changes = [];
  const blockers = [];
  let budget = AUTO_PATCH_BUDGET;
  for (const criterion of missing) {
    const spec = plan.specs?.find(item => item.criterionId === criterion.id);
    if (!spec) {
      blockers.push(`No saved verification rule is available for “${criterion.label}”.`);
      continue;
    }
    const supported = [];
    for (const candidate of ranked) {
      const assessment = assessPlan({ specs: [spec] }, {
        documents: [candidate.document],
        runRecords: state.runRecords || {},
        subjectEntity: task.request.subjectEntity
      });
      const result = assessment.criteria[0];
      if (result?.status !== 'satisfied' || result.strength !== 'direct') continue;
      const evidence = result.evidence?.find(item => item.source?.kind === 'document' && item.source.id === candidate.document.id && item.source.version === candidate.document.version && item.excerpt);
      if (!evidence || !String(candidate.document.content).includes(evidence.excerpt)) continue;
      supported.push({ candidate: candidate.document, quote: evidence.excerpt });
    }
    if (!supported.length) {
      blockers.push(`No identity-linked, current source document directly verifies “${criterion.label}”; that content was not invented.`);
      continue;
    }
    const distinctQuotes = new Set(supported.map(item => item.quote.replace(/\s+/g, ' ').trim().toLocaleLowerCase()));
    if (distinctQuotes.size > 1) {
      blockers.push(`Related source documents disagree about “${criterion.label}”; no value was chosen.`);
      continue;
    }
    const selected = supported[0];
    if (selected.quote.length > budget) {
      blockers.push(`The verified source quote for “${criterion.label}” exceeds the ${AUTO_PATCH_BUDGET}-character patch budget.`);
      continue;
    }
    budget -= selected.quote.length;
    const existing = changes.find(change => change.source.id === selected.candidate.id && change.text === selected.quote);
    if (existing) existing.criterionIds.push(criterion.id);
    else changes.push({
      type: 'append',
      text: selected.quote,
      source: { kind: 'document', id: selected.candidate.id, version: selected.candidate.version, quote: selected.quote },
      criterionIds: [criterion.id]
    });
  }
  if (changes.length > 10) return { changes: [], blockers: ['The patch would exceed the 10-quote content budget. Prepare smaller, reviewed patches.'] };
  return { changes, blockers };
}

/**
 * Explicit task lifecycle services. All durable transitions use the injected
 * engine store; no prototype patches or imports from engine are required.
 */
export class TaskServices {
  constructor(engineOrConfig, options = {}) {
    const isEngine = Boolean(engineOrConfig?.store?.state && (
      typeof engineOrConfig.changed === 'function' || typeof engineOrConfig.ingest === 'function' || typeof engineOrConfig.assess === 'function'
    ));
    const engine = isEngine ? engineOrConfig : engineOrConfig?.engine || options.engine || null;
    const config = engine ? options : (engineOrConfig || {});
    const store = engine?.store || config.store;
    if (!store?.state || typeof store.mutate !== 'function') throw new Error('TaskServices requires an engine or persistent store.');
    this.engine = engine;
    this.store = store;
    this.provider = config.provider || engine?.provider || null;
    this.mode = config.mode || engine?.mode || store.state.mode || 'simulation';
    this.policy = config.policy || engine?.policy || null;
    this.documentProvider = config.documentProvider || engine?.documentProvider || null;
    this.onChange = config.onChange || (() => {});
    this.ingest = engine?.ingest ? engine.ingest.bind(engine) : config.ingest || null;
    this.assess = engine?.assess ? engine.assess.bind(engine) : config.assess || null;
    this.clock = config.clock || stamp;
    this.localDocumentProvider = new LocalDocumentProvider({ store: this.store });
    this.#recoverInterruptedPatchWrites();
  }

  #recoverInterruptedPatchWrites() {
    const interrupted = Object.values(this.store.state.documentPatches || {}).filter(patch => patch?.status === 'applying');
    if (!interrupted.length) return false;
    const at = this.clock();
    this.store.mutate(state => {
      for (const patch of Object.values(state.documentPatches || {})) {
        if (patch?.status !== 'applying') continue;
        patch.status = 'uncertain';
        patch.result = {
          status: 'unknown',
          applied: null,
          provider: patch.provider,
          simulated: Boolean(patch.simulated),
          detail: 'The process stopped during a document write attempt. The provider may or may not have accepted it; reconcile the document before preparing another patch.'
        };
        patch.appliedAt = at;
        delete patch.writeAttemptId;
        insertHistory(state, 'patch_uncertain', `Recovered an interrupted ${patch.provider} document write as uncertain; no retry was attempted.`, patch.taskId, at);
      }
    });
    return true;
  }

  #changed() {
    if (typeof this.engine?.changed === 'function') this.engine.changed();
    else this.onChange(this.store.state);
  }

  /** Store an event-driven or time-driven wake condition; one active wait per task. */
  waitForTask(taskId, { kind, dependsOn = {}, until = null, interruptOnRisk = true } = {}) {
    const task = requireTask(this.store.state, taskId);
    if (!ACTIVE_TASKS.has(task.status) || task.status === 'completed' || task.status === 'cancelled' || task.userDismissed) {
      throw new Error('A closed task cannot enter a wait.');
    }
    if (!['document', 'reply', 'time'].includes(kind)) throw new Error('Invalid wait kind. Expected document, reply, or time.');
    const condition = {};
    const message = messageForTask(this.store.state, task);
    let base = {};
    if (kind === 'document') {
      const documentId = safeId(dependsOn.documentId || task.documentId);
      const document = this.store.state.documents?.[documentId];
      if (!documentId || !document || document.available === false) throw new Error('A document wait requires an available, observed document ID.');
      condition.documentId = documentId;
      condition.label = `a new version of ${document.title || documentId}`;
      base.documentVersion = Number(document.version || 0);
      base.provider = document.source || null;
      base.progressSemanticSignature = task.progress?.semanticSignature || null;
      base.documentContentSignature = hash(String(document.content || '').replace(/\s+/g, ' ').trim());
      base.requestSignature = requestSignature(task);
    } else if (kind === 'reply') {
      const threadId = safeId(dependsOn.threadId || message?.threadId || task.request?.source?.threadId);
      if (!threadId) throw new Error('A reply wait requires the exact email thread ID.');
      condition.threadId = threadId;
      condition.label = `a reply in thread ${threadId}`;
      base.messageId = message?.id || task.sourceEmailId || null;
      base.provider = this.store.state.events?.find(event => event.type === 'email.received' && event.payload?.id === base.messageId)?.source || null;
    } else {
      const time = Date.parse(until || '');
      if (!Number.isFinite(time)) throw new Error('A time wait requires an ISO date or timestamp.');
      condition.label = `the time ${new Date(time).toISOString()}`;
      until = new Date(time).toISOString();
    }
    const at = this.clock();
    const conditionKey = JSON.stringify({ kind, condition, until, interruptOnRisk: interruptOnRisk !== false });
    const existing = this.store.state.taskWaits?.[taskId];
    if (existing?.status === 'active' && existing.conditionKey === conditionKey) return existing;
    let wait;
    this.store.mutate(state => {
      state.taskWaits = state.taskWaits || {};
      const current = state.taskWaits[taskId];
      if (current?.status === 'active' && current.conditionKey === conditionKey) {
        wait = current;
        return;
      }
      if (current?.status === 'active') {
        current.status = 'superseded';
        current.supersededAt = at;
      }
      wait = {
        id: `wait:${taskId}:${state.revision + 1}`,
        taskId,
        kind,
        condition,
        conditionKey,
        base,
        until,
        interruptOnRisk: interruptOnRisk !== false,
        status: 'active',
        createdAt: at,
        lastEvaluatedAt: at,
        interruption: null,
        resolution: null
      };
      state.taskWaits[taskId] = wait;
      insertHistory(state, 'wait_requested', `User set a persistent ${kind} wait for task ${taskId}.`, taskId, at);
    });
    this.#changed();
    return wait;
  }

  /** Advance active waits exactly once when their matching event or a risk arrives. */
  processObservedEvent(event) {
    return this.refreshWaits(event?.at || this.clock(), event);
  }

  /** Evaluate saved conditions after restart and during the engine's periodic sweep. */
  refreshWaits(now = this.clock(), event = null) {
    let changed = false;
    this.store.mutateIfChanged(state => {
      for (const wait of Object.values(state.taskWaits || {})) {
        if (wait.status !== 'active') continue;
        const task = state.tasks?.[wait.taskId];
        if (!task || task.status === 'completed' || task.status === 'cancelled' || task.userDismissed) {
          wait.status = 'resolved';
          wait.resolution = { kind: 'task_closed', at: now, reason: 'The task was closed.' };
          wait.lastEvaluatedAt = now;
          changed = true;
          continue;
        }
        const risk = wait.interruptOnRisk ? riskFor(task, state, now, wait) : null;
        if (risk) {
          wait.status = 'interrupted';
          wait.interruption = { ...risk, at: now };
          wait.lastEvaluatedAt = now;
          insertHistory(state, 'wait_interrupted', `A ${risk.kind} interrupted the saved wait for task ${task.id}.`, task.id, now);
          changed = true;
          continue;
        }
        if (conditionMet(wait, state, now, event)) {
          wait.status = 'resolved';
          wait.resolution = {
            kind: wait.kind,
            at: now,
            eventId: event?.id || null,
            reason: wait.kind === 'time' ? 'The scheduled time arrived.' : 'The matching event condition occurred.'
          };
          wait.lastEvaluatedAt = now;
          insertHistory(state, 'wait_resolved', `The saved ${wait.kind} wait resolved for task ${task.id}; evidence must still be assessed.`, task.id, now);
          changed = true;
        }
      }
    });
    if (changed) this.#changed();
    return changed;
  }

  /**
   * Prepare a source-cited patch. Every inserted string must be an exact quote
   * from the request or a current document, and the target/request versions are
   * pinned for application-time checks.
   */
  async prepareDocumentPatch(taskId, { changes = null, provider: providerName = null } = {}) {
    const task = requireTask(this.store.state, taskId);
    if (task.status === 'completed' || task.status === 'cancelled' || task.userDismissed) throw new Error('A closed or withdrawn request cannot receive a document patch.');
    const document = task.documentId ? this.store.state.documents?.[task.documentId] : null;
    if (!document || document.available === false || typeof document.content !== 'string') {
      throw new Error('A document patch requires a currently available correlated document.');
    }
    const selected = providerName || (['simulated', 'local'].includes(document.source) && !document.externalId ? 'local' : 'google');
    if (!['local', 'google'].includes(selected)) throw new Error('Unknown document patch provider.');
    const provider = selected === 'local' ? this.localDocumentProvider : this.documentProvider;
    const providerIssue = !provider
      ? 'Google Docs document provider is not configured.'
      : !provider.supports?.(document)
        ? `${selected === 'google' ? 'Google Docs' : 'Local'} provider cannot patch this document source.`
        : null;
    const autoPrepared = !Array.isArray(changes) || changes.length === 0
      ? autoSourceBackedChanges(task, this.store.state, document)
      : { changes, blockers: [] };
    const validation = autoPrepared.changes.length
      ? validateDocumentChanges(autoPrepared.changes, { task, state: this.store.state, targetDocument: document })
      : { changes: [], blockers: autoPrepared.blockers };
    const knownCriteria = new Set((task.evidence?.criteria || []).map(item => item.id));
    for (const change of validation.changes) {
      if (change.criterionIds?.some(id => !knownCriteria.has(id))) {
        change.criterionIds = change.criterionIds.filter(id => knownCriteria.has(id));
      }
    }
    let base = { revisionId: null, content: document.content, provider: selected, simulated: selected === 'local' };
    const blockers = [...(providerIssue ? [providerIssue] : []), ...autoPrepared.blockers, ...validation.blockers];
    if (!blockers.length && typeof provider.prepareBase === 'function') {
      try { base = await provider.prepareBase(document); }
      catch (error) { blockers.push(error.message); }
    }
    const at = this.clock();
    const patchId = `patch:${taskId}:${this.store.state.revision + 1}:${hash(`${taskId}:${at}:${JSON.stringify(validation.changes)}`)}`;
    const patch = {
      id: patchId,
      taskId,
      status: blockers.length ? 'blocked' : 'prepared',
      provider: selected,
      simulated: Boolean(base.simulated),
      baseDocument: { id: document.id, version: document.version, revisionId: base.revisionId || null },
      requestSignature: requestSignature(task),
      sourceVersions: Object.fromEntries([...new Set(validation.changes.map(change => change.source).filter(source => source.kind === 'document').map(source => source.id))]
        .map(id => [id, this.store.state.documents[id]?.version ?? null])),
      changes: validation.changes,
      provenance: validation.changes.map(change => ({ source: change.source, criterionIds: change.criterionIds || [] })),
      blockers,
      result: null,
      createdAt: at,
      appliedAt: null
    };
    this.store.mutate(state => {
      state.documentPatches = state.documentPatches || {};
      state.documentPatches[patch.id] = patch;
      const current = state.tasks[taskId];
      current.documentPatches = current.documentPatches || [];
      current.documentPatches.push(patch.id);
      insertHistory(state, 'patch_prepared', blockers.length
        ? `A document patch could not be prepared: ${blockers.join(' ')}`
        : `Prepared a ${selected} document patch for ${taskId}; no document was changed.`, taskId, at);
    });
    this.#changed();
    return patch;
  }

  #authorizationMatches(authorization, patch, kind) {
    return authorization?.kind === kind && authorization.confirmed === true &&
      authorization.taskId === patch.taskId && authorization.patchId === patch.id &&
      authorization.baseDocumentVersion === patch.baseDocument.version;
  }

  #currentSourcesStillMatch(patch, state) {
    for (const change of patch.changes) {
      const source = change.source;
      if (source.kind === 'document') {
        const current = state.documents?.[source.id];
        if (!current || current.available === false || current.version !== patch.sourceVersions[source.id] || !String(current.content).includes(source.quote)) return false;
      } else if (source.kind === 'email') {
        const current = (state.inbox || []).find(item => item.id === source.id);
        if (!current?.body?.includes(source.quote)) return false;
      }
    }
    return true;
  }

  #patchStaleReason(taskId, patchId, { expectedStatus = null, attemptId = null, authorizationKind = 'explicit' } = {}) {
    const state = this.store.state;
    const patch = state.documentPatches?.[patchId];
    if (!patch || patch.taskId !== taskId) return 'The document patch is no longer available.';
    if (expectedStatus && patch.status !== expectedStatus) return `The document patch is ${patch.status}; it is no longer eligible to write.`;
    if (attemptId && patch.writeAttemptId !== attemptId) return 'The document write attempt is no longer current.';
    if (patch.authorization?.kind !== authorizationKind || patch.authorization?.taskId !== taskId ||
        patch.authorization?.patchId !== patchId || patch.authorization?.baseDocumentVersion !== patch.baseDocument.version) {
      return 'The document patch authorization is missing or no longer matches this base version.';
    }
    const task = state.tasks?.[taskId];
    if (!task || task.status === 'cancelled' || task.status === 'completed' || task.userDismissed) {
      return 'The request was closed or withdrawn after patch preparation.';
    }
    if (requestSignature(task) !== patch.requestSignature) return 'The request changed after patch preparation.';
    const target = state.documents?.[patch.baseDocument.id];
    if (!target || target.available === false) return 'The target document is unavailable.';
    if (target.version !== patch.baseDocument.version) return 'The target document changed after patch preparation.';
    if (!this.#currentSourcesStillMatch(patch, state)) return 'A source cited by this patch changed or is no longer available.';
    return null;
  }

  /** Apply once with exact task/patch/version consent, then reread and reassess. */
  async applyDocumentPatch(taskId, { patchId, authorization = null } = {}) {
    const patch = this.store.state.documentPatches?.[patchId];
    const task = requireTask(this.store.state, taskId);
    if (!patch || patch.taskId !== taskId) throw new Error('Unknown document patch for this task.');
    if (patch.status === 'applied') return { patch, task, result: patch.result };
    const shadowReviewed = patch.status === 'shadow_read_only' && patch.result?.applied === false;
    if (patch.status !== 'prepared' && !shadowReviewed) throw new Error(`Document patch is ${patch.status}; prepare a new patch before applying.`);
    if (!this.#authorizationMatches(authorization, patch, 'explicit') && !this.#authorizationMatches(authorization, patch, 'shadow_read_only')) {
      throw new Error('Applying a document patch requires explicit consent bound to this task, patch ID, and base document version.');
    }
    if (shadowReviewed && authorization.kind === 'shadow_read_only') return { patch, task, result: patch.result };
    const consentAt = this.clock();
    this.store.mutate(state => {
      const current = state.documentPatches[patchId];
      current.authorizedAt = consentAt;
      current.authorization = { kind: authorization.kind, taskId, patchId, baseDocumentVersion: patch.baseDocument.version };
      insertHistory(state, authorization.kind === 'explicit' ? 'patch_authorized' : 'patch_shadow_review',
        authorization.kind === 'explicit'
          ? 'User explicitly authorized this exact source-backed document patch and base version.'
          : 'User requested a read-only shadow review of this exact document patch.', taskId, consentAt);
    });
    const currentDocument = this.store.state.documents?.[patch.baseDocument.id];
    const staleReason = this.#patchStaleReason(taskId, patchId, { authorizationKind: authorization.kind });
    if (staleReason) {
      this.store.mutate(state => {
        state.documentPatches[patchId].status = 'stale';
        state.documentPatches[patchId].blockers = [...(state.documentPatches[patchId].blockers || []), staleReason];
        insertHistory(state, 'patch_stale', `Refused a stale document patch: ${staleReason}`, taskId, this.clock());
      });
      this.#changed();
      throw new Error(staleReason);
    }

    const dryRun = authorization.kind === 'shadow_read_only';
    if (dryRun) {
      let expected;
      if (patch.provider === 'google') {
        const read = await this.documentProvider?.read?.(currentDocument);
        if (!read || read.revisionId !== patch.baseDocument.revisionId) throw new Error('The Google Doc revision changed after patch preparation; prepare and review a new patch.');
        expected = read.content;
      } else {
        expected = (await this.localDocumentProvider.prepareBase(currentDocument)).content;
      }
      const output = applyTextChanges(expected, patch.changes);
      const result = {
        status: 'shadow_read_only',
        applied: false,
        simulated: patch.simulated,
        provider: patch.provider,
        wouldContainAllChanges: patch.changes.every(change => output.includes(change.text)),
        documentChanged: false
      };
      this.store.mutate(state => {
        const current = state.documentPatches[patchId];
        current.status = 'shadow_read_only';
        current.result = result;
        current.appliedAt = this.clock();
        insertHistory(state, 'patch_shadow_read_only', `Checked a document patch in shadow mode. No document was changed.`, taskId, current.appliedAt);
      });
      this.#changed();
      return { patch: this.store.state.documentPatches[patchId], task: this.store.state.tasks[taskId], result };
    }

    if (patch.provider === 'google' && this.policy?.shadow) throw new Error('Shadow mode is read-only. Google Docs writes are refused.');
    const provider = patch.provider === 'local' ? this.localDocumentProvider : this.documentProvider;
    if (!provider) throw new Error('Document provider is no longer configured.');
    if (typeof this.ingest !== 'function') throw new Error('Applying a patch requires the engine event-ingestion path for readback and reassessment.');
    if (patch.provider === 'google' && !provider.validate?.({ forWrite: true })?.ok) {
      throw new Error(provider.validate({ forWrite: true })?.reason || 'Google Docs writes are not enabled.');
    }
    if (patch.provider === 'local' && !provider.supports(currentDocument)) throw new Error('Local provider cannot write the current document.');

    const writeAttemptId = crypto.randomUUID();
    this.store.mutate(state => {
      const current = state.documentPatches[patchId];
      if (!['prepared', 'shadow_read_only'].includes(current.status)) {
        throw new Error(`Document patch is ${current.status}; it cannot start another write attempt.`);
      }
      current.status = 'applying';
      current.writeAttemptId = writeAttemptId;
      current.applyStartedAt = this.clock();
      insertHistory(state, 'patch_applying', 'Starting one version-bound document patch attempt.', taskId, current.applyStartedAt);
    });
    const beforeWrite = () => {
      const reason = this.#patchStaleReason(taskId, patchId, { expectedStatus: 'applying', attemptId: writeAttemptId });
      const currentPatch = this.store.state.documentPatches?.[patchId];
      const writeProvider = currentPatch?.provider === 'google' ? this.documentProvider : null;
      const providerCheck = writeProvider?.validate?.({ forWrite: true });
      const writeBlocker = reason || (currentPatch?.provider === 'google' && this.policy?.shadow
        ? 'Shadow mode became read-only before the Google Docs write.'
        : providerCheck && !providerCheck.ok ? providerCheck.reason : null);
      if (writeBlocker) {
        const error = new Error(writeBlocker);
        error.stale = true;
        throw error;
      }
    };
    let applied;
    try {
      applied = await provider.apply({
        document: currentDocument,
        changes: patch.changes,
        requiredRevisionId: patch.baseDocument.revisionId,
        beforeWrite
      });
    } catch (error) {
      if (error.stale) {
        this.store.mutate(state => {
          state.documentPatches[patchId].status = 'stale';
          delete state.documentPatches[patchId].writeAttemptId;
          state.documentPatches[patchId].blockers = [...state.documentPatches[patchId].blockers, error.message];
          insertHistory(state, 'patch_stale', error.message, taskId, this.clock());
        });
        this.#changed();
        throw error;
      }
      if (error.writeOutcomeUnknown) {
        this.store.mutate(state => {
          const current = state.documentPatches[patchId];
          current.status = 'uncertain';
          delete current.writeAttemptId;
          current.result = { status: 'unknown', applied: null, provider: current.provider, simulated: current.simulated, detail: error.message };
          current.appliedAt = this.clock();
          insertHistory(state, 'patch_uncertain', `The document provider outcome is uncertain; no retry was attempted. ${error.message}`, taskId, current.appliedAt);
        });
        this.#changed();
        throw new Error(`Document write outcome is uncertain and will not be retried: ${error.message}`);
      }
      this.store.mutate(state => {
        const current = state.documentPatches[patchId];
        current.status = 'failed';
        delete current.writeAttemptId;
        current.result = { status: 'failed', applied: false, provider: current.provider, simulated: current.simulated, detail: error.message };
        insertHistory(state, 'patch_failed', `Document patch failed before an accepted write: ${error.message}`, taskId, this.clock());
      });
      this.#changed();
      throw error;
    }

    const providerEventId = `patch:${hash(`${patch.id}:${applied.revisionId || currentDocument.version + 1}`)}`;
    const source = patch.provider === 'google' ? 'google' : 'simulated';
    this.ingest({
      id: `document-patch:${providerEventId}`,
      type: 'document.modified',
      source,
      connectorId: patch.provider === 'google' ? 'google-docs' : 'local',
      providerEventId,
      at: this.clock(),
      payload: {
        id: currentDocument.id,
        title: currentDocument.title,
        kind: currentDocument.kind,
        content: applied.content,
        modifiedAt: this.clock(),
        externalId: currentDocument.externalId,
        url: currentDocument.url
      }
    });
    const readback = this.store.state.documents?.[currentDocument.id];
    const expectedContent = applyTextChanges(currentDocument.content, patch.changes).replace(/\r\n?/g, '\n');
    const actualContent = String(readback?.content || '').replace(/\r\n?/g, '\n');
    if (actualContent !== expectedContent) {
      this.store.mutate(state => {
        const current = state.documentPatches[patchId];
        current.status = 'uncertain';
        delete current.writeAttemptId;
        current.result = { status: 'unknown', applied: null, provider: current.provider, simulated: current.simulated, detail: 'The persisted readback did not contain all source-backed changes.' };
        current.appliedAt = this.clock();
        insertHistory(state, 'patch_uncertain', 'The write may have occurred, but persisted readback did not contain every change. No retry was attempted.', taskId, current.appliedAt);
      });
      this.#changed();
      throw new Error('The document patch could not be verified against the exact readback content; no retry was attempted.');
    }
    const result = {
      status: 'verified',
      applied: true,
      provider: patch.provider,
      simulated: Boolean(applied.simulated),
      live: patch.provider === 'google',
      documentId: readback.id,
      documentVersion: readback.version,
      revisionId: applied.revisionId || null,
      readbackVerified: true
    };
    this.store.mutate(state => {
      const current = state.documentPatches[patchId];
      current.status = 'applied';
      delete current.writeAttemptId;
      current.result = result;
      current.appliedAt = this.clock();
      insertHistory(state, 'patch_applied', `Applied and read back a ${current.provider} document patch (${current.simulated ? 'simulated' : 'live provider'}).`, taskId, current.appliedAt);
    });
    this.assess?.(taskId, `document-patch:${providerEventId}`, { force: true, allowAutomation: false });
    this.#changed();
    return { patch: this.store.state.documentPatches[patchId], task: this.store.state.tasks[taskId], result };
  }

  /** Store a reversible, exact-scope correction. It never grants execution permission. */
  recordTaskFeedback(taskId, { label, scope, relatedTaskId = null, reason = null } = {}) {
    const task = requireTask(this.store.state, taskId);
    const labels = ['not_mine', 'duplicate', 'already_handled', 'wrong_association'];
    if (!labels.includes(label)) throw new Error(`Invalid task correction. Expected ${labels.join(', ')}.`);
    const cleanScope = validateFeedbackScope(label, scope);
    if (label === 'duplicate') {
      const related = relatedTaskId ? this.store.state.tasks[relatedTaskId] : null;
      if (!relatedTaskId || relatedTaskId === taskId || !related || related.status === 'cancelled' || related.userDismissed) {
        throw new Error('Duplicate feedback requires a different, existing relatedTaskId.');
      }
      if (normalise(related.request?.subjectEntity) !== normalise(task.request?.subjectEntity) ||
          normalise(related.request?.deliverable) !== normalise(task.request?.deliverable)) {
        throw new Error('Duplicate feedback target must have the same subject entity and deliverable.');
      }
    }
    const handledSnapshot = label === 'already_handled' ? handledSnapshotForTask(task, this.store.state) : null;
    if (label === 'already_handled' && (!handledSnapshot.requestRevisionSignature || !handledSnapshot.sender ||
        (!handledSnapshot.threadId && !handledSnapshot.sourceMessageId))) {
      throw new Error('Already-handled feedback needs the task’s original source, sender and semantic request signature.');
    }
    const cleanReason = reason == null ? null : String(reason).trim().slice(0, 280) || null;
    const at = this.clock();
    let entry;
    this.store.mutate(state => {
      state.taskFeedbackRules = state.taskFeedbackRules || {};
      entry = {
        id: `feedback:${taskId}:${state.revision + 1}`,
        taskId,
        label,
        scope: cleanScope,
        relatedTaskId: label === 'duplicate' ? relatedTaskId : null,
        ...(handledSnapshot ? { handledSnapshot } : {}),
        reason: cleanReason,
        active: true,
        createdAt: at,
        undoneAt: null,
        source: 'user'
      };
      state.taskFeedbackRules[entry.id] = entry;
      task.feedbackCorrection = { id: entry.id, label, at };
      insertHistory(state, 'feedback_correction', `User recorded a reversible ${label.replaceAll('_', ' ')} correction. It did not authorize any external action.`, taskId, at);
    });
    this.#changed();
    return entry;
  }

  undoTaskFeedback(feedbackId) {
    const entry = this.store.state.taskFeedbackRules?.[feedbackId];
    if (!entry) throw new Error('Unknown feedback correction.');
    if (!entry.active) return entry;
    const at = this.clock();
    this.store.mutate(state => {
      const current = state.taskFeedbackRules[feedbackId];
      current.active = false;
      current.undoneAt = at;
      const task = state.tasks[current.taskId];
      if (task?.feedbackCorrection?.id === feedbackId) task.feedbackCorrection.undoneAt = at;
      insertHistory(state, 'feedback_undo', `User withdrew the ${current.label.replaceAll('_', ' ')} correction; its future matching effect is removed.`, current.taskId, at);
    });
    this.#changed();
    return this.store.state.taskFeedbackRules[feedbackId];
  }

  /** Return exact-scope effects for A's discovery/correlation gate. */
  matchingFeedbackRules({ request = {}, message = null, documentId = null } = {}) {
    const fields = requestFields(request, message, documentId);
    const output = [];
    for (const rule of Object.values(this.store.state.taskFeedbackRules || {})) {
      if (!rule.active || !fieldsMatch(rule.scope, fields)) continue;
      if (rule.label === 'already_handled' && !alreadyHandledMatches(rule, request, message, this.store.state)) continue;
      if (rule.label === 'duplicate') {
        const target = this.store.state.tasks?.[rule.relatedTaskId];
        if (!target || target.status === 'cancelled' || target.userDismissed) continue;
      }
      output.push({
        rule,
        effect: rule.label === 'not_mine' ? 'suppress_scoped_candidate'
          : rule.label === 'duplicate' ? 'associate_with_existing_task'
            : rule.label === 'already_handled' ? 'ignore_as_already_handled'
              : 'exclude_document_association',
        targetTaskId: rule.relatedTaskId || null
      });
    }
    return output;
  }

  /** Answer once for a deterministic shared dependency; the answer is not verification evidence. */
  resolveDependency(dependencyId, { decision, value = null } = {}) {
    const allowed = ['provided', 'defer', 'dismiss', 'failed'];
    if (!allowed.includes(decision)) throw new Error(`Invalid dependency decision. Expected ${allowed.join(', ')}.`);
    const dependency = aggregateTaskDependencies(this.store.state, this.clock()).find(item => item.id === dependencyId);
    if (!dependency) throw new Error('Unknown or no-longer-active dependency.');
    if (this.store.state.dependencyDecisions?.[dependencyId]) return this.store.state.dependencyDecisions[dependencyId];
    if (decision === 'provided' && (typeof value !== 'string' || !value.trim())) throw new Error('A provided dependency needs the exact information or source location.');
    const at = this.clock();
    const answer = decision === 'provided' ? String(value).trim().slice(0, 1000) : null;
    let resolved;
    this.store.mutate(state => {
      state.dependencyDecisions = state.dependencyDecisions || {};
      resolved = {
        id: dependencyId,
        decision,
        value: answer,
        status: decision === 'provided' ? 'answered_needs_recheck' : decision,
        taskIds: dependency.taskIds.filter(id => state.tasks?.[id] && state.tasks[id].status !== 'completed' && state.tasks[id].status !== 'cancelled'),
        criterionIds: dependency.criterionIds,
        answeredAt: at,
        source: 'user'
      };
      state.dependencyDecisions[dependencyId] = resolved;
      insertHistory(state, 'dependency_decision', `User answered the shared ${dependency.label} dependency for ${resolved.taskIds.length} active task(s). Evidence must still be rechecked.`, resolved.taskIds[0] || null, at);
    });
    this.#changed();
    return resolved;
  }

  /** Create one durable owner/action/result condition for an accepted opportunity. */
  createFollowUpForOpportunity(opportunityId) {
    const opportunity = this.store.state.opportunities?.[opportunityId];
    if (!opportunity || opportunity.status !== 'accepted') throw new Error('Only an accepted opportunity can create a follow-up.');
    let followUp;
    this.store.mutate(state => {
      state.followUps = state.followUps || {};
      const existing = state.followUps[opportunityId];
      if (existing) { followUp = existing; return; }
      const at = state.opportunities[opportunityId].decidedAt || this.clock();
      const kind = opportunity.kind;
      const completionCondition = kind === 'connect_evidence_source'
        ? 'The named source is connected and its required probe completes with current, source-backed evidence.'
        : kind === 'verify_freshness'
          ? 'A source of truth for the named entity is recorded and the freshness check passes.'
          : 'A direct, source-backed verification probe exists and passes for the requested content.';
      followUp = {
        id: `followup:${hash(opportunityId)}`,
        opportunityId,
        status: 'open',
        owner: { id: 'user', label: 'You', source: 'explicit_acceptance' },
        nextAction: { kind: 'user_action', label: opportunity.nextStep || `Review the accepted opportunity: ${opportunity.statement}` },
        completionCondition,
        source: { kind: 'opportunity', id: opportunityId, evidence: opportunity.evidence || [] },
        createdAt: at,
        updatedAt: at
      };
      state.followUps[opportunityId] = followUp;
      state.opportunities[opportunityId].followUpId = followUp.id;
      insertHistory(state, 'followup_created', `Accepted opportunity now has a persisted owner, next action and completion condition.`, null, at);
    });
    this.#changed();
    return followUp;
  }

  /** Mark a saved dependency as answered without claiming the requirement is verified. */
  projectTask(task, state = this.store.state, now = this.clock()) {
    return projectTaskManagement(task, state, now);
  }
}

export { projectTaskManagement };

export const taskServicesApi = { TaskServices, projectTaskManagement };
