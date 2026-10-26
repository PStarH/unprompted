import { sourceRef } from './evidence.js';
import { relevantRuns } from './freshness.js';

/**
 * Evidence-backed opportunity discovery.
 *
 * An opportunity follows this execution order:
 *
 *   1. Inspect the information and evidence already available.
 *   2. Estimate the potential benefit and the minimum cost of verifying it.
 *   3. Prefer a low-cost, verifiable exploration.
 *   4. Decide from real results whether it is worth continuing.
 *   5. Propose a next step only when the preliminary evidence is sufficient and
 *      the benefit is clear.
 *   6. Stop, or park, anything with weak evidence, high cost or limited benefit.
 *
 * Two prohibitions are structural. Discovery always starts from an *existing*
 * work problem rather than an invented one, and nothing here can start a project:
 * an opportunity can only become a `proposed` suggestion for the user to accept
 * or dismiss. Accepting records a decision; it never commits a resource.
 *
 * Quiet by construction: every signal is a condition that blocks or degrades
 * work the system is already doing, and it must earn attention before it is
 * raised. How much evidence that takes is a property of the signal, not a
 * blanket rule:
 *
 *   - A gap that **blocks** work outright (a registered evidence source that
 *     cannot be reached) is a concrete problem the moment it is observed, so a
 *     single occurrence may be judged on its own.
 *   - A gap that merely **degrades** work or would require new investment
 *     (a withheld claim, content no probe can verify) needs recurrence: one
 *     occurrence is a task still gathering evidence, not a pattern worth acting
 *     on.
 *
 * Each signal is registered in `OPPORTUNITY_SIGNALS` with its threshold and the
 * reason for it, so the policy is one declarative place rather than an implicit
 * habit of each function. Adding a new signal means adding one descriptor and a
 * `collect` function; the shared decision gate (`decideOpportunity`) applies
 * unchanged. Nothing here can start a project, and no signal may bypass the gate.
 */

const BENEFIT_RANK = { low: 1, medium: 2, high: 3 };
const RISK_RANK = { low: 1, medium: 2, high: 3 };

/** Kinds of opportunity this scanner can raise from observable workspace state. */
export const OPPORTUNITY_KINDS = [
  'verify_freshness',        // a claim is withheld because no source of truth is connected
  'connect_evidence_source', // a probe is blocked because a non-local provider is unavailable
  'extend_verification'      // requested content has no probe, so nothing can confirm it
];

const reason = (text, source = null) => ({ detail: text, source });
const taskSource = task => sourceRef({ kind: 'task', id: task.id, timestamp: task.createdAt });
const documentSource = document => document
  ? sourceRef({ kind: 'document', id: document.id, version: document.version, timestamp: document.modifiedAt, url: document.url })
  : null;

/**
 * Signal 1 — a withheld "latest" claim because no run registry is connected.
 *
 * Raised only once the same gap has blocked more than one request for the same
 * entity. A single occurrence is a task still gathering evidence; a repeated one
 * is a missing source of truth, which is where connecting it pays for itself.
 */
function freshnessGapOpportunities(tasks, state, now, signal) {
  const groups = new Map();
  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    const gap = (task.evidence?.unknowns || []).find(item => item.id === 'freshness_source_of_truth');
    if (!gap || task.assessment?.freshness?.status === 'verified') continue;
    const entity = task.request.subjectEntity;
    if (!entity) continue;
    if (!groups.has(entity)) groups.set(entity, { gap, tasks: [], document: null });
    const group = groups.get(entity);
    group.tasks.push(task);
    group.document = group.document || state.documents?.[task.documentId] || null;
  }

  const out = [];
  for (const [entity, group] of groups) {
    if (group.tasks.length < signal.minOccurrences) continue;
    // Only a run record *for this entity* is a possible source of truth. An
    // unrelated run elsewhere in the workspace must not resolve the gap: the
    // suggestion is about whether this entity's data can be verified.
    const runs = relevantRuns(state.runRecords || {}, entity);
    const exploration = runs.length
      ? { verdict: 'resolved', basis: [reason(`${runs.length} run record(s) for ${entity} are now known, so a source of truth may already be connected.`)] }
      : { verdict: 'supported', basis: [
        reason(`${group.tasks.length} separate ${entity} requests could not establish freshness.`, taskSource(group.tasks[0])),
        group.document ? reason(`A correlated document (${group.document.id}) exists whose freshness claim depends on this source.`, documentSource(group.document)) : null
      ].filter(Boolean) };
    out.push({
      id: `opportunity:verify_freshness:${entity}`,
      kind: 'verify_freshness',
      scope: { entity, deliverable: group.tasks[0].request.deliverable },
      statement: `Connect a run registry for ${entity} so the "latest" claim can be verified instead of withheld each time.`,
      evidence: [
        reason(group.gap.question, taskSource(group.tasks[0])),
        reason(group.gap.reason, taskSource(group.tasks[0])),
        ...group.tasks.slice(1).map(task => reason(`Also affected: ${task.request.intent.replaceAll('_', ' ')} request for ${entity}.`, taskSource(task)))
      ],
      benefit: 'medium',
      verificationCost: 'low',
      // Connecting a read-only source of truth and comparing dates: no
      // external effect, nothing irreversible.
      risk: 'low',
      nextStep: `Connect the ${entity} run registry (or publish the run record).`,
      exploration,
      firstSeenAt: now,
      updatedAt: now
    });
  }
  return out;
}

/**
 * Signal 2 — a probe is blocked because an evidence provider is unavailable.
 *
 * `document_text` is excluded deliberately: it is the local workspace, so its
 * absence means "no document has been observed yet", not "a source needs
 * connecting". Only a registered, non-local provider that cannot be reached is a
 * genuine connection gap, and it blocks work immediately, so it is raised at once.
 */
function blockedSourceOpportunities(tasks, now) {
  // `minOccurrences` is 1 for this signal: the gap already blocks a criterion,
  // so waiting for it to repeat would withhold a decision that is due now.
  const out = [];
  const seen = new Set();
  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    for (const criterion of task.evidence?.criteria || []) {
      if (criterion.status !== 'blocked') continue;
      const provider = criterion.probe?.provider;
      if (!provider || provider === 'document_text') continue;
      const id = `opportunity:connect_evidence_source:${provider}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: 'connect_evidence_source',
        scope: { entity: task.request.subjectEntity, deliverable: task.request.deliverable },
        statement: `Connect the "${provider}" evidence source so "${criterion.label}" can be checked instead of blocked.`,
        evidence: [reason(criterion.note || `The probe for "${criterion.label}" was blocked.`, taskSource(task))],
        benefit: 'medium',
        verificationCost: 'medium',
        // Connecting a readable provider that registered itself: the check is
        // local and reversible, and nothing is written through the connection.
        risk: 'low',
        nextStep: `Connect the "${provider}" provider and re-run the check.`,
        exploration: {
          verdict: 'supported',
          basis: [reason(`The provider "${provider}" is registered but unavailable, and it is currently blocking "${criterion.label}".`, taskSource(task))]
        },
        firstSeenAt: now,
        updatedAt: now
      });
    }
  }
  return out;
}

/**
 * Signal 3 — requested content with no probe. A single occurrence is not enough
 * evidence to justify widening the verifier, so exploration counts how many
 * distinct requests hit the same gap. A single unusual request is not enough to
 * justify a product-wide investment.
 */
function unverifiableOpportunities(tasks, now, signal) {
  const byText = new Map();
  for (const task of tasks) {
    for (const item of task.evidence?.plan?.unverifiable || []) {
      const key = String(item.text || '').toLowerCase();
      if (!key) continue;
      if (!byText.has(key)) byText.set(key, { text: item.text, tasks: [], reason: item.reason });
      byText.get(key).tasks.push(task);
    }
  }
  const out = [];
  for (const [key, entry] of byText) {
    const repeated = entry.tasks.length >= signal.minOccurrences;
    out.push({
      id: `opportunity:extend_verification:${key.slice(0, 40)}`,
      kind: 'extend_verification',
      scope: { entity: entry.tasks[0].request.subjectEntity, deliverable: entry.tasks[0].request.deliverable },
      statement: `Add verification coverage for "${entry.text}" so a request asking for it can be checked instead of reported as unverifiable.`,
      evidence: entry.tasks.map(task => reason(`"${entry.text}" could not be mapped to a probe (${entry.reason}).`, taskSource(task))),
      benefit: 'low',
      verificationCost: 'medium',
      // Widening the verifier changes what the system is allowed to claim, so
      // the suggestion carries more weight — and more risk — than connecting a
      // readable source: a bad probe could later satisfy a criterion on the
      // wrong evidence.
      risk: 'medium',
      nextStep: `Define a probe for "${entry.text}" that must cite the text it matched.`,
      exploration: {
        verdict: repeated ? 'supported' : 'inconclusive',
        basis: [reason(repeated
          ? `${entry.tasks.length} separate requests asked for "${entry.text}", so the gap is recurring rather than a one-off.`
          : `Only one request has asked for "${entry.text}" so far; one occurrence is not enough evidence to widen the verifier.`, taskSource(entry.tasks[0]))]
      },
      firstSeenAt: now,
      updatedAt: now
    });
  }
  return out;
}

/**
 * Turn a candidate into a decision through the shared evidence gate.
 *
 * Proposed only when the exploration supports it, the benefit clearly meets or
 * exceeds the cost of verifying it, and the risk of pursuing it is reasonable.
 * Benefit, cost and risk are weighed together; a high-risk next step never
 * becomes a suggestion, however attractive its
 * benefit/cost ratio looks. Everything not proposed is parked with the reason
 * recorded, so "we chose not to pursue this" is visible rather than silent.
 */
export function decideOpportunity(opportunity) {
  const verdict = opportunity.exploration?.verdict;
  if (verdict === 'resolved') {
    return { ...opportunity, status: 'resolved', reason: 'The gap this described is no longer present.' };
  }
  if (verdict !== 'supported') {
    return { ...opportunity, status: 'parked', reason: 'The evidence is not yet sufficient to justify action.' };
  }
  if (RISK_RANK[opportunity.risk] >= RISK_RANK.high) {
    return { ...opportunity, status: 'parked', reason: 'The risk is too high to suggest without an explicit user decision.' };
  }
  if (BENEFIT_RANK[opportunity.benefit] >= BENEFIT_RANK[opportunity.verificationCost]) {
    return { ...opportunity, status: 'proposed', reason: null };
  }
  return { ...opportunity, status: 'parked', reason: 'The benefit does not clearly exceed the cost of verifying it.' };
}

/**
 * The registered signals.
 *
 * Each entry declares how much evidence it needs before a candidate is worth
 * judging (`minOccurrences`), whether the gap it describes blocks work or merely
 * degrades it, and why — so the recurrence policy is explicit and auditable
 * rather than implied by each function's internal counting. A signal that
 * blocks work may stand on a single occurrence; a signal that degrades work or
 * proposes an investment must recur. `collect(state, now, signal)` returns raw
 * candidates; the shared gate above decides them.
 */
const SIGNAL_FRESHNESS = {
  id: 'verify_freshness',
  kind: 'verify_freshness',
  blocking: false,
  minOccurrences: 2,
  rationale: 'A withheld claim degrades one request; connecting a source of truth pays for itself only when the same gap keeps recurring.'
};
const SIGNAL_BLOCKED_SOURCE = {
  id: 'connect_evidence_source',
  kind: 'connect_evidence_source',
  blocking: true,
  minOccurrences: 1,
  rationale: 'An unavailable registered provider blocks a criterion outright, so one occurrence is already a concrete, blocking gap.'
};
const SIGNAL_UNVERIFIABLE = {
  id: 'extend_verification',
  kind: 'extend_verification',
  blocking: false,
  minOccurrences: 2,
  rationale: 'Widening the verifier is an investment in the product itself; one unusual request is not evidence that the content type recurs.'
};

SIGNAL_FRESHNESS.collect = (state, now) =>
  freshnessGapOpportunities(Object.values(state.tasks || {}), state, now, SIGNAL_FRESHNESS);
SIGNAL_BLOCKED_SOURCE.collect = (state, now) =>
  blockedSourceOpportunities(Object.values(state.tasks || {}), now);
SIGNAL_UNVERIFIABLE.collect = (state, now) =>
  unverifiableOpportunities(Object.values(state.tasks || {}), now, SIGNAL_UNVERIFIABLE);

export const OPPORTUNITY_SIGNALS = [SIGNAL_FRESHNESS, SIGNAL_BLOCKED_SOURCE, SIGNAL_UNVERIFIABLE];

/**
 * Evaluate every registered signal against the workspace and return decided
 * opportunities. Read-only: it inspects state and estimates, and never touches
 * an external system or the task list.
 */
export function evaluateOpportunities(state, { now = new Date().toISOString(), signals = OPPORTUNITY_SIGNALS } = {}) {
  // A decision to close or decline work also removes it from recurrence evidence.
  const activeState = {
    ...state,
    tasks: Object.fromEntries(Object.entries(state.tasks || {}).filter(([, task]) =>
      !['completed', 'cancelled'].includes(task.status) && task.userDismissed !== true))
  };
  const candidates = signals.flatMap(signal => signal.collect(activeState, now, signal));
  return candidates.map(decideOpportunity);
}

/**
 * Merge freshly evaluated opportunities into the stored set.
 *
 * A decision the user already made (`accepted` / `dismissed`) is preserved — the
 * scanner must not resurrect a suggestion the user turned down — and an
 * opportunity whose gap has closed is marked `resolved` even if it was proposed.
 */
export function mergeOpportunities(existing = {}, evaluated = []) {
  const merged = { ...existing };
  const seen = new Set();
  for (const opportunity of evaluated) {
    seen.add(opportunity.id);
    const previous = merged[opportunity.id];
    if (!previous) { merged[opportunity.id] = opportunity; continue; }
    const status = opportunity.status === 'resolved' ? 'resolved'
      : (previous.status === 'accepted' || previous.status === 'dismissed') ? previous.status
        : opportunity.status;
    const next = {
      ...opportunity,
      status,
      decidedAt: previous.decidedAt || null,
      decisionNote: previous.decisionNote || null,
      firstSeenAt: previous.firstSeenAt || opportunity.firstSeenAt
    };
    // Re-deriving an identical proposal on every attention sweep is not a
    // change. Only move `updatedAt` when something a user could see changed,
    // otherwise the periodic sweep would rewrite the whole workspace each pass.
    const strip = value => { const copy = { ...value }; delete copy.updatedAt; return JSON.stringify(copy); };
    merged[opportunity.id] = strip(previous) === strip(next)
      ? { ...next, updatedAt: previous.updatedAt }
      : next;
  }
  // An opportunity no longer produced by any signal, and never acted on, is
  // stale: the workspace changed underneath it.
  for (const id of Object.keys(merged)) {
    if (seen.has(id)) continue;
    if (['accepted', 'dismissed'].includes(merged[id].status)) continue;
    merged[id] = { ...merged[id], status: 'resolved', reason: 'The condition that produced this is no longer present.' };
  }
  return merged;
}

export function openOpportunities(opportunities) {
  return Object.values(opportunities || {}).filter(item => item.status === 'proposed');
}

export const opportunitiesApi = {
  OPPORTUNITY_KINDS, OPPORTUNITY_SIGNALS, decideOpportunity, evaluateOpportunities, mergeOpportunities, openOpportunities
};
