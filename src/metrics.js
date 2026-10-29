/**
 * Workflow quality and explicitly recorded user judgments.
 *
 * The value of Unprompted must not be measured by the
 * number of tasks run, documents generated or minutes spent. What must be
 * measured is whether it actually reduced worry and manual work. This module
 * derives six product-value measures from observed outcomes in persisted state:
 *
 *   - the share of discovered work that turned out to be valuable
 *   - the share of work the system surfaced but could not serve (noise)
 *   - the rate at which completed results were independently verified
 *   - how often the user was interrupted
 *   - how much manual follow-through the system absorbed
 *   - how often the user had to take over or correct the system
 *
 * Every number carries a `basis`, so an assessment can be checked rather than
 * trusted, and each is derived from records the engine already keeps rather than
 * from a counter that could drift. Prepared/verified work remains a legacy
 * activity proxy. PRD user-value evidence is assessed separately in value-study.js;
 * these counters cannot establish unrequestedness or a user's reason to keep it.
 */

const round = value => Math.round(value * 1000) / 1000;

function taskIsPrepared(task) {
  return Boolean(task.draft || task.action) || task.status === 'ready_for_approval';
}

function taskIsVerifiedComplete(task) {
  return task.status === 'completed' && Boolean(task.action?.status?.startsWith?.('verified'));
}

function verifiedDeliveryKind(task) {
  if (!taskIsVerifiedComplete(task) || !task.action?.receiptId) return null;
  if (task.action.live === true && task.action.status === 'verified_live') return 'real';
  if (task.action.live === false && task.action.status === 'verified_simulated') return 'simulated';
  return null;
}

function verifiedPatchKind(patch) {
  if (patch.status !== 'applied' || patch.result?.readbackVerified !== true || patch.result?.applied !== true) return null;
  return patch.simulated === true ? 'simulated' : patch.result?.live === true ? 'real' : null;
}

function userActivityDates(history, now) {
  const kinds = new Set([
    'approval', 'rejection', 'retry', 'reconciliation', 'cancellation', 'feedback',
    'feedback_correction', 'feedback_undo', 'dependency_decision', 'wait_requested',
    'task_direction', 'task_direction_undo', 'task_paused', 'task_resumed', 'memory_edit', 'memory_delete', 'memory_restore',
    'opportunity_accepted', 'patch_authorized'
  ]);
  const current = Date.parse(now);
  const dates = (history || [])
    .filter(item => kinds.has(item.kind) && item.at && Math.abs(current - Date.parse(item.at)) <= 400 * 86_400_000)
    .map(item => new Date(item.at).toISOString().slice(0, 10));
  return [...new Set(dates)].sort();
}

/**
 * A discovery is "unservable" when the request could be read but nothing could
 * ever verify it: no document correlated, and the requested content has no probe
 * at all. This is a capability/coverage proxy, not evidence that the work lacks
 * value to the user. It must not become a noise label without user judgment.
 */
function taskIsUnservable(task) {
  if (taskIsPrepared(task)) return false;
  if (task.documentId) return false;
  return (task.evidence?.plan?.unverifiable?.length || 0) > 0;
}

export function computeProductMetrics(state, { now = new Date().toISOString() } = {}) {
  const tasks = Object.values(state.tasks || {});
  const history = state.history || [];
  const notifications = state.notifications || [];
  const calibrations = Object.values(state.calibrations || {});
  const opportunities = Object.values(state.opportunities || {});
  const patches = Object.values(state.documentPatches || {});

  // A request the user closed while it was still waiting is neither noise nor
  // unfinished work: it was a real discovery that the user chose to end. It is
  // counted separately rather than folded into either rate.
  const isUserClosed = task => task.status === 'cancelled';
  const prepared = tasks.filter(taskIsPrepared);
  const completed = tasks.filter(taskIsVerifiedComplete);
  const valuable = tasks.filter(task => taskIsPrepared(task) || taskIsVerifiedComplete(task));
  const unservable = tasks.filter(task => !isUserClosed(task) && taskIsUnservable(task));
  const waiting = tasks.filter(task => !isUserClosed(task) && !taskIsPrepared(task) && !taskIsUnservable(task));
  const closed = tasks.filter(isUserClosed);

  const historyCount = kind => history.filter(item => item.kind === kind).length;
  const taskCorrections = Object.values(state.taskFeedbackRules || {}).filter(entry => entry.source === 'user').length + Object.keys(state.taskDirections || {}).length;
  const correctionUndos = Object.values(state.taskFeedbackRules || {}).filter(entry => entry.source === 'user' && entry.active === false).length + Object.values(state.taskDirections || {}).filter(entry => entry.active === false).length;
  const takeovers = {
    rejectedDrafts: historyCount('rejection'),
    retries: historyCount('retry'),
    reconciliations: historyCount('reconciliation'),
    corrections: calibrations.filter(entry => entry.correctedAt).length + taskCorrections
  };
  const takeoverTotal = Object.values(takeovers).reduce((sum, value) => sum + value, 0);

  const interruptionsByKind = {};
  for (const item of notifications) interruptionsByKind[item.kind] = (interruptionsByKind[item.kind] || 0) + 1;

  const withheldClaims = tasks.reduce((sum, task) => sum + (task.draft?.withheldClaims?.length || 0), 0);
  const events = state.events || [];
  const labelled = tasks.filter(task => task.feedback?.source === 'user' && task.feedback?.label);
  const labelCount = label => labelled.filter(task => task.feedback.label === label).length;
  const connectorStatus = Object.values(state.connectorStatus || {});
  const activityDates = userActivityDates(history, now);
  const windowStart = days => new Date(Date.parse(now) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const activeDays7 = activityDates.filter(day => day >= windowStart(7)).length;
  const activeDays30 = activityDates.filter(day => day >= windowStart(30)).length;
  const deliveries = tasks.reduce((counts, task) => {
    const kind = verifiedDeliveryKind(task);
    if (kind) counts[kind] += 1;
    if (kind && task.feedback?.source === 'user' && task.feedback?.label === 'useful') counts[`recognized${kind[0].toUpperCase()}${kind.slice(1)}`] += 1;
    return counts;
  }, { real: 0, simulated: 0, recognizedReal: 0, recognizedSimulated: 0 });
  const documentPatchResults = patches.reduce((counts, patch) => {
    const kind = verifiedPatchKind(patch);
    if (kind) counts[kind] += 1;
    const task = state.tasks?.[patch.taskId];
    if (kind && task?.feedback?.source === 'user' && task.feedback?.label === 'useful') counts[`recognized${kind[0].toUpperCase()}${kind.slice(1)}`] += 1;
    return counts;
  }, { real: 0, simulated: 0, recognizedReal: 0, recognizedSimulated: 0 });
  const approvals = history.filter(item => ['approval', 'patch_authorized'].includes(item.kind)).length;

  return {
    at: now,
    discovery: {
      discovered: tasks.length,
      valuable: valuable.length,
      unservable: unservable.length,
      waiting: waiting.length,
      closed: closed.length,
      valuableRate: tasks.length ? round(valuable.length / tasks.length) : null,
      unservableRate: tasks.length ? round(unservable.length / tasks.length) : null,
      basis: [
        'legacy valuable is an agent activity proxy: prepared, evidence-backed action or verified completion; it is not a user-recognized outcome',
        'unservable = a request with no correlated document and no probe for the requested content',
        'closed = a request the user ended while it was still waiting for information',
        `counts from ${tasks.length} task record(s)`
      ]
    },
    completion: {
      preparedActions: prepared.length,
      verifiedCompletions: completed.length,
      unverifiedCompletions: tasks.filter(task => task.status === 'completed' && !taskIsVerifiedComplete(task)).length,
      verifiableCompletionRate: prepared.length ? round(completed.length / prepared.length) : null,
      withheldClaims,
      basis: [
        'legacy completion counts when the task records a provider-verified receipt; see outcomes for recognized results separated by live and simulated provider',
        `verified completions derived from ${prepared.length} prepared action(s)`
      ]
    },
    attention: {
      interruptions: notifications.length,
      unresolved: notifications.filter(item => !item.resolvedAt).length,
      byKind: interruptionsByKind,
      takeovers: takeoverTotal,
      takeoverBreakdown: takeovers,
      explicitApprovals: approvals,
      taskCorrections,
      correctionUndos,
      basis: [
        'an interruption is a decision-supporting notification, not a history entry',
        'takeovers preserve the original rejection, retry, reconciliation and calibration counts; task corrections are also listed separately',
        'explicit approvals include approved outbound actions and explicitly authorized document patches'
      ]
    },
    value: {
      estimatedManualStepsAvoided: completed.length,
      note: 'This legacy activity proxy counts verified completions. It does not establish that the user found the result useful or measure time saved.',
      basis: [
        'legacy verified-completion count is kept for continuity and is not a user-recognized value measure',
        `counted ${completed.length} provider-verified completion(s)`,
        'time saved and retention remain unknown because neither is measured'
      ]
    },
    outcomes: {
      verifiedDeliveries: { real: deliveries.real, simulated: deliveries.simulated },
      recognizedVerifiedDeliveries: { real: deliveries.recognizedReal, simulated: deliveries.recognizedSimulated },
      verifiedDocumentPatches: { real: documentPatchResults.real, simulated: documentPatchResults.simulated },
      recognizedVerifiedDocumentPatches: { real: documentPatchResults.recognizedReal, simulated: documentPatchResults.recognizedSimulated },
      basis: [
        'a delivery requires a completed task, provider-verified status and receipt ID; real and simulated providers are counted separately',
        'a result is user-recognized only when the user explicitly labelled its task useful',
        'a document patch requires applied status and a successful readback; prepared, blocked, failed and uncertain patches are not outcomes',
        'no user-recognized outcomes means zero recognized deliveries, not an inferred positive result'
      ]
    },
    management: {
      pendingDecisions: new Set([
        ...notifications.filter(item => !item.resolvedAt).map(item => `notification:${item.id}`),
        ...tasks.filter(task => task.status === 'ready_for_approval').map(task => `approval:${task.id}`)
      ]).size,
      activeDays: { last7: activeDays7, last30: activeDays30 },
      missedItems: (state.misses || []).length,
      basis: [
        'pending decisions are unresolved notifications plus tasks explicitly waiting for approval, deduplicated by record',
        'active days count persisted user decision or correction dates; page views and background checks do not count',
        'missed items are user-recorded omissions, not a measured system recall rate'
      ]
    },
    // How much verification the work actually needed, and what the extra
    // checks found. Depth is recomputed per assessment, so a task is counted
    // once by its current depth — never once per check that ran.
    verification: {
      enhanced: tasks.filter(task => task.verification?.depth === 'enhanced').length,
      standard: tasks.filter(task => task.verification?.depth === 'standard').length,
      corroborations: tasks.reduce((sum, task) => sum + (task.verification?.performed || []).filter(item => item.outcome === 'corroborated').length, 0),
      sourceConflicts: tasks.reduce((sum, task) => sum + (task.verification?.performed || []).filter(item => item.outcome === 'conflict' || item.outcome === 'conflict_newer_source').length, 0),
      basis: [
        'a task is counted once, by the verification depth recorded in its latest assessment',
        'corroborations and source conflicts are cross-source check results, not user judgements',
        `counts from ${tasks.length} task record(s)`
      ]
    },
    opportunities: {
      proposed: opportunities.filter(item => item.status === 'proposed').length,
      accepted: opportunities.filter(item => item.status === 'accepted').length,
      dismissed: opportunities.filter(item => item.status === 'dismissed').length,
      parked: opportunities.filter(item => item.status === 'parked').length,
      resolved: opportunities.filter(item => item.status === 'resolved').length,
      basis: 'only explored, evidence-gated opportunities reach the proposed state'
    },
    // User judgements of discoveries. These are separate from `discovery`,
    // which is an automatic proxy. Missing evidence is never counted as noise.
    review: {
      discoveries: tasks.length,
      reviewed: labelled.length,
      unreviewed: tasks.length - labelled.length,
      useful: labelCount('useful'),
      notUseful: labelCount('not_useful'),
      wrongAssociation: labelCount('wrong_association'),
      negative: labelCount('not_useful') + labelCount('wrong_association'),
      noise: labelCount('noise'),
      awaitingEvidence: labelCount('awaiting_evidence'),
      unevaluated: tasks.length - labelled.length,
      misses: (state.misses || []).length,
      // Unobserved outcomes. These are words, not counts, so they cannot be
      // mistaken for unevaluated discoveries or for a negative judgement.
      unknown: { recall: 'unknown', timeSaved: 'unknown', retention: 'unknown' },
      basis: [
        'a discovery is reviewed only when the user has labelled it',
        'unevaluated means the user has not judged that discovery',
        'not useful and wrong association are negative judgements; they are not the same as unevaluated',
        'unknown recall, time saved and retention are outcomes that have not been observed',
        'useful, not useful, wrong association, noise and awaiting evidence are user labels',
        'an unreviewed finding is not noise, including when evidence is missing',
        'a missed item is something the user recorded; it is not a discovered task'
      ]
    },
    events: {
      ingested: events.length,
      real: events.filter(event => event.source && event.source !== 'simulated').length,
      basis: 'legacy real counts persisted events tagged with a non-simulated source; a source tag alone proves neither participant consent, unrequested discovery nor user value'
    },
    sync: {
      failures: connectorStatus.filter(item => item && item.ok === false).length,
      basis: 'a synchronization failure is a connector status recorded with ok: false'
    },
    resources: {
      events: events.length,
      tasks: tasks.length,
      traceEntries: (state.trace || []).length,
      historyEntries: history.length,
      documentPatches: patches.length,
      basis: 'counts of persisted records in this workspace; wall-clock time, model tokens, user retention and time saved are not measured'
    }
  };
}

/** The bare address of a From header, so one sender groups even when the display name varies. */
function senderAddress(from) {
  const raw = String(from || '').trim();
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).toLowerCase() || 'unknown';
}

/**
 * Group observed email by sender, so silence is visible at the source level.
 *
 * Per-message rejection codes explain one message. With a busy inbox the
 * useful question is the aggregate one: which sources never ask for anything,
 * and by which check are they always declined? A source is "quiet" only from
 * real volume (never from one message), and the dominant check is reported so
 * the claim stays auditable.
 */
export function summariseSources(state, { quietThreshold = 3 } = {}) {
  const senders = new Map();
  for (const event of state.events || []) {
    if (event.type !== 'email.received') continue;
    const address = senderAddress(event.payload?.from);
    let entry = senders.get(address);
    if (!entry) {
      entry = {
        sender: address,
        display: String(event.payload?.from || address),
        messages: 0,
        requests: 0,
        declined: {}
      };
      senders.set(address, entry);
    }
    entry.messages += 1;
    if (event.disposition === 'discovered_request') entry.requests += 1;
    else if (event.rejection?.code) entry.declined[event.rejection.code] = (entry.declined[event.rejection.code] || 0) + 1;
  }

  return [...senders.values()]
    .map(entry => {
      const dominant = Object.entries(entry.declined).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
      return {
        sender: entry.sender,
        display: entry.display,
        messages: entry.messages,
        requests: entry.requests,
        declinedBy: entry.declined,
        dominantRejection: dominant ? dominant[0] : null,
        // Quiet is a claim about a source, so it needs volume behind it: two
        // ignored messages could be a person who has not asked anything yet.
        neverAsks: entry.messages >= quietThreshold && entry.requests === 0
      };
    })
    .sort((a, b) => b.messages - a.messages || a.sender.localeCompare(b.sender));
}

/** Flatten the metrics into labelled lines for a CLI report. */
export function describeMetrics(metrics) {
  const pct = value => (value == null ? 'n/a' : `${Math.round(value * 100)}%`);
  return [
    `discovered work: ${metrics.discovery.discovered} (prepared/verified proxy ${metrics.discovery.valuable} · unservable ${metrics.discovery.unservable} · waiting ${metrics.discovery.waiting}${metrics.discovery.closed ? ` · closed ${metrics.discovery.closed}` : ''})`,
    `prepared-action activity rate: ${pct(metrics.discovery.valuableRate)} · unservable proxy: ${pct(metrics.discovery.unservableRate)}`,
    `verifiable completion rate: ${pct(metrics.completion.verifiableCompletionRate)} (${metrics.completion.verifiedCompletions}/${metrics.completion.preparedActions})`,
    `withheld unsupported claims: ${metrics.completion.withheldClaims}`,
    `interruptions: ${metrics.attention.interruptions} (unresolved ${metrics.attention.unresolved})`,
    `user takeovers: ${metrics.attention.takeovers}`,
    `opportunities: proposed ${metrics.opportunities.proposed} · accepted ${metrics.opportunities.accepted} · parked ${metrics.opportunities.parked}`,
    `verification: ${metrics.verification.standard} standard · ${metrics.verification.enhanced} enhanced (${metrics.verification.corroborations} corroborated · ${metrics.verification.sourceConflicts} conflicts)`,
    `review: ${metrics.review.reviewed} reviewed · ${metrics.review.unevaluated} unevaluated · useful ${metrics.review.useful} · not useful ${metrics.review.notUseful} · wrong association ${metrics.review.wrongAssociation} · noise ${metrics.review.noise} · awaiting evidence ${metrics.review.awaitingEvidence} · misses ${metrics.review.misses} · recall ${metrics.review.unknown.recall} · time saved ${metrics.review.unknown.timeSaved}`,
    `events: ${metrics.events.ingested} ingested · ${metrics.events.real} real · sync failures ${metrics.sync.failures}`
  ];
}

export const metricsApi = { computeProductMetrics, describeMetrics, summariseSources };
