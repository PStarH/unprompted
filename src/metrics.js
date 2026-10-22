/**
 * Product-value evaluation.
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
 * from a counter that could drift.
 */

const round = value => Math.round(value * 1000) / 1000;

function taskIsPrepared(task) {
  return Boolean(task.draft || task.action) || task.status === 'ready_for_approval';
}

function taskIsVerifiedComplete(task) {
  return task.status === 'completed' && Boolean(task.action?.status?.startsWith?.('verified'));
}

/**
 * A discovery is "unservable" when the request could be read but nothing could
 * ever verify it: no document correlated, and the requested content has no probe
 * at all. This is the closest honest proxy for "无意义建议" — work the system put
 * in front of the user that it could not actually act on.
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
  const takeovers = {
    rejectedDrafts: historyCount('rejection'),
    retries: historyCount('retry'),
    reconciliations: historyCount('reconciliation'),
    corrections: calibrations.filter(entry => entry.correctedAt).length
  };
  const takeoverTotal = Object.values(takeovers).reduce((sum, value) => sum + value, 0);

  const interruptionsByKind = {};
  for (const item of notifications) interruptionsByKind[item.kind] = (interruptionsByKind[item.kind] || 0) + 1;

  const withheldClaims = tasks.reduce((sum, task) => sum + (task.draft?.withheldClaims?.length || 0), 0);
  const events = state.events || [];
  const labelled = tasks.filter(task => task.feedback?.source === 'user' && task.feedback?.label);
  const labelCount = label => labelled.filter(task => task.feedback.label === label).length;
  const connectorStatus = Object.values(state.connectorStatus || {});

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
        'valuable = a request that reached a prepared, evidence-backed action or a verified completion',
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
        'a completion only counts when it was verified against the provider',
        `verified completions derived from ${prepared.length} prepared action(s)`
      ]
    },
    attention: {
      interruptions: notifications.length,
      unresolved: notifications.filter(item => !item.resolvedAt).length,
      byKind: interruptionsByKind,
      takeovers: takeoverTotal,
      takeoverBreakdown: takeovers,
      basis: [
        'an interruption is a decision-supporting notification, not a history entry',
        'a takeover is a rejection, retry, reconciliation or a user correction'
      ]
    },
    value: {
      estimatedManualStepsAvoided: completed.length,
      note: 'Each verified completion is one follow-through the user did not have to perform. This is an estimate of absorbed work, not a measurement of wall-clock time saved.',
      basis: [
        'a verified completion is one follow-through the user did not have to perform',
        `estimated from ${completed.length} verified completion(s)`,
        'an estimate of absorbed work, not a measurement of wall-clock time saved'
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
      unknown: { recall: 'unknown', timeSaved: 'unknown' },
      basis: [
        'a discovery is reviewed only when the user has labelled it',
        'unevaluated means the user has not judged that discovery',
        'not useful and wrong association are negative judgements; they are not the same as unevaluated',
        'unknown recall and unknown time saved are outcomes that have not been observed',
        'useful, not useful, wrong association, noise and awaiting evidence are user labels',
        'an unreviewed finding is not noise, including when evidence is missing',
        'a missed item is something the user recorded; it is not a discovered task'
      ]
    },
    events: {
      ingested: events.length,
      real: events.filter(event => event.source && event.source !== 'simulated').length,
      basis: 'real events are persisted events whose source is not simulated'
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
      basis: 'counts of persisted records in this workspace; wall-clock time and model tokens are not measured'
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
    `discovered work: ${metrics.discovery.discovered} (valuable ${metrics.discovery.valuable} · unservable ${metrics.discovery.unservable} · waiting ${metrics.discovery.waiting}${metrics.discovery.closed ? ` · closed ${metrics.discovery.closed}` : ''})`,
    `valuable discovery rate: ${pct(metrics.discovery.valuableRate)} · unservable proxy: ${pct(metrics.discovery.unservableRate)}`,
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
