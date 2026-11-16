#!/usr/bin/env node
// Central activation-quality oracle runner. It executes the fixed 30-case
// fixture through the real normalized-event → durable activation path. It
// never opens a network socket: any fetch call throws, and the fake replay
// connector only records probes. Production modules are read-only here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openActivationReplay } from '../src/durable/activation-replay.js';
import { normalizeEvent } from '../src/connectors/events.js';
import { emailPrincipalRole, simpleMailboxList } from '../src/connectors/principal-role.js';
import { notification } from '../src/notifications.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_PATH = path.join(ROOT, 'test/fixtures/activation-quality.json');
export const EVAL_VERSION = 'activation-quality-eval-2026-11-13.1';
const GOLD_PATH = path.join(ROOT, '.internal/agents/codex/2026-11-12-central/56-activation-quality-gold.json');

const SOURCE_FILES = [
  'src/engine.js',
  'src/requests.js',
  'src/external-work.js',
  'src/notifications.js',
  'src/connectors/events.js',
  'src/connectors/principal-role.js',
  'src/durable/activation-replay.js',
  'src/durable/attention.js',
  'src/durable/candidates.js',
  'src/durable/context.js',
  'src/durable/privacy.js',
  'src/durable/runtime.js',
  'src/durable/situations.js',
  'src/durable/standing-intents.js',
  'src/durable/store.js',
  'src/durable/tasks.js'
];

const MODEL_METHODS = ['assessSituationPair', 'extractSituationDelta', 'assessStandingIntent', 'discoverRequestCandidate'];

// Facts observed by this runner against the frozen source tree. These are
// findings for central review, not accepted answers and not gold edits.
const KNOWN_GAP_NOTES = {
  U3: {
    title: 'Cancelled Calendar event is resurrected by a late older revision',
    productionArea: 'src/engine.js #ingestDocument stale comparison',
    evidence: 'After document.unavailable, modifiedAt remains the old value while unavailableAt is later. The late document.modified has modifiedAt equal to the stored value, so incomingAt < storedAt is false and the document is written back with available:true.',
    proposedAlgorithmSpec: 'The revision watermark for an unavailable document must be max(modifiedAt, unavailableAt, observedAt). Any document.modified with a revision at or before unavailableAt must be recorded as stale_change and must not clear available:false; only a revision newer than the unavailability watermark may revive the document.'
  },
  G5: {
    title: 'Same document filename across two authorized local roots links evidence across roots',
    productionArea: 'src/engine.js document-change relation matching / src/durable/candidates.js',
    evidence: 'The root-boreal proposal.md document event is recorded as related_change with a relation to the root-atlas observed task, and event_situation_links places that Boreal event in the Atlas Situation. The two tasks remain separate, but a provider event from one root is associated with the other root work.',
    proposedAlgorithmSpec: 'Evidence and event association must include the authorized root/account binding in the resource identity. A document title or filename alone must never create a relation across roots; when accountId differs, the event may only remain its own evidence or require an explicit user link. Situation association must reject cross-root relation targets before writing event_situation_links.'
  },
  G6: {
    title: 'Same thread string across two account bindings is merged as duplicate_request',
    productionArea: 'src/commitments.js commitmentScope / sameCommitment',
    evidence: 'Two normalized email events with different payload.accountId but identical threadId, sender, participants, entity and deliverable produce one task and one Situation. commitmentScope identity has no connector or account binding component.',
    proposedAlgorithmSpec: 'Commitment identity must include the source connection binding (connectorId plus accountId/tenant) before threadId. A matching thread string from a different connection is a distinct commitment; cross-connection association requires an explicit user merge action or a trusted mapping, never title/thread equality alone.'
  },
  N2: {
    title: 'Low-priority notification starves under sustained fresh high-priority arrivals',
    productionArea: 'src/durable/attention.js releaseDue',
    evidence: 'With maxInteractivePerHour=1, a pending low item is never delivered across four slots when a new high item is offered before each release. releaseDue sorts by static priority then created_at; no aging or maximum deferral applies.',
    proposedAlgorithmSpec: 'Add a bounded service guarantee: each pending interactive item carries a deferral count/age; effective ordering must raise an item after a bounded number of higher-priority deliveries or elapsed time so it is offered within a fixed number of slots. The guarantee must not bypass maxInteractivePerHour, quiet hours, issue cooldowns or privacy blocks, and must not drop high-priority items.'
  },
  A4: {
    title: 'Explicit delegation with a quoted verifiable target is not actionable',
    productionArea: 'src/requests.js recoverRequestCandidateWithReasoner / quoteCarriesAction',
    evidence: 'Active text "Please handle this for me." plus a forwarded line naming the Atlas proposal and experiment results is rejected with no_request_verb. quoteCarriesAction only accepts UPDATE_VERBS and SEND_VERBS; "handle" is absent, and the grounded quotes for the target live in the quoted region.',
    proposedAlgorithmSpec: 'Treat an explicit delegation verb in active unquoted text (for example handle, take care of, process, follow up) as a request action when the model proposal grounds deliverable, entity and required content in the message, including a quoted forwarded block. Keep the delegation quote in active text, preserve quoted evidence provenance, and keep pure quoted witnesses non-actionable.'
  },
  A9: {
    title: 'Standing-intent semantic match is accepted without trusted sender identity',
    productionArea: 'src/durable/runtime.js standing-intent evaluation',
    evidence: 'A predicate "The sender is the trusted Sam" matches when the model returns matched:true and the From header is the display string "Sam" with no parseable sender address. The run records a MATCHED standing_intent decision and an intent Situation.',
    proposedAlgorithmSpec: 'Before evaluating a predicate that references sender identity, require a trusted identity feature derived from provider metadata. If sender.identity is absent or unparseable, the predicate result is unknown, the intent must not activate, and the model text claim cannot supply the missing feature.'
  }
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourceHashes() {
  const files = {};
  for (const relative of SOURCE_FILES) files[relative] = sha256(fs.readFileSync(path.join(ROOT, relative)));
  const tree = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, digest]) => `${file}:${digest}`).join('\n');
  return { files, treeSha256: sha256(`${tree}\n`) };
}

function bounded(value, depth = 0) {
  if (depth > 4) return '[depth-limited]';
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => bounded(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) out[key] = bounded(item, depth + 1);
    return out;
  }
  return value;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(3));
}

function mailbox(value) {
  if (Array.isArray(value)) return simpleMailboxList(value.join(', '));
  return simpleMailboxList(value);
}

function roleMeta(step) {
  if (!step.role) return step.meta ? structuredClone(step.meta) : {};
  return emailPrincipalRole(
    step.role.accountEmail,
    mailbox(step.role.to),
    mailbox(step.role.cc || [])
  );
}

function buildEvent(step) {
  if (step.kind === 'email') {
    return normalizeEvent({
      connectorId: step.connectorId,
      source: step.source,
      providerEventId: step.providerEventId,
      providerRevision: step.providerRevision,
      type: 'email.received',
      at: step.at,
      meta: roleMeta(step),
      payload: structuredClone(step.payload)
    });
  }
  if (step.kind === 'github_issue') {
    return normalizeEvent({
      connectorId: 'github',
      source: 'github',
      providerEventId: step.providerEventId,
      providerRevision: step.providerRevision,
      type: 'issue.updated',
      at: step.at,
      payload: structuredClone(step.payload)
    });
  }
  if (step.kind === 'document') {
    return normalizeEvent({
      connectorId: step.connectorId,
      source: step.source,
      providerEventId: step.providerEventId,
      providerRevision: step.providerRevision,
      type: step.eventType || 'document.modified',
      at: step.at,
      payload: structuredClone(step.payload)
    });
  }
  if (step.kind === 'task_observed') {
    return normalizeEvent({
      connectorId: step.connectorId,
      source: step.source,
      providerEventId: step.providerEventId,
      type: 'task.observed',
      at: step.at,
      payload: structuredClone(step.payload)
    });
  }
  throw new Error(`Unknown fixture step kind: ${step.kind}`);
}

function simplifyIngest(result) {
  if (!result || typeof result !== 'object') return { raw: bounded(result) };
  return {
    duplicate: result.duplicate === true,
    id: result.id || null,
    disposition: result.disposition || null,
    rejection: result.rejection?.code || null,
    relations: Array.isArray(result.relations) ? result.relations.slice(0, 8) : []
  };
}

function installContract(def, env, counters) {
  const contract = def.input.contract;
  if (!contract) return;
  for (const method of MODEL_METHODS) {
    if (!(method in contract)) continue;
    const proposal = structuredClone(contract[method]);
    counters[method] = 0;
    env.engine.reasoner[method] = async () => {
      counters[method] += 1;
      return structuredClone(proposal);
    };
  }
}

function applySetup(step, env) {
  if (step.kind === 'intent') {
    return env.runtime.intents.create(structuredClone(step.spec), { actor: 'user', confirmed: true });
  }
  if (step.kind === 'policy') {
    return env.runtime.policies.save(structuredClone(step.spec));
  }
  if (step.kind === 'revoke') {
    return env.runtime.privacy.revokePermission({ connectorId: step.connectorId });
  }
  throw new Error(`Unknown fixture setup kind: ${step.kind}`);
}

function snapshot(env) {
  const tasks = Object.values(env.store.state.tasks || {});
  const documents = env.store.state.documents || {};
  const events = env.store.state.events || [];
  const situations = env.runtime.tasks.situations.listActive();
  const links = env.store.db.prepare('SELECT event_id,situation_id,association_method FROM event_situation_links ORDER BY event_id').all();
  const decisions = env.store.db.prepare('SELECT stage,outcome,reason_code,event_a,event_b,situation_id FROM activation_decisions ORDER BY created_at,id').all();
  const notifications = env.store.db.prepare('SELECT dedupe_key,issue_key,state,class,delivered_at,not_before FROM notification_deliveries ORDER BY created_at,dedupe_key').all();
  const toolRows = env.store.db.prepare('SELECT COUNT(*) AS n FROM tool_executions WHERE is_write=1').get().n;
  return {
    tasks: bounded(tasks.map(task => ({
      id: task.id,
      status: task.status,
      situationId: task.situationId || null,
      subject: task.subject || null,
      kind: task.kind || null,
      documentId: task.documentId || null,
      guidanceReviewRequired: task.guidanceReviewRequired === true,
      paused: task.control?.paused === true,
      requestText: task.request?.text || null,
      requestDeadline: task.request?.deadline?.iso || null
    }))),
    documents: bounded(Object.fromEntries(Object.entries(documents).map(([id, doc]) => [id, {
      version: doc.version,
      available: doc.available,
      title: doc.title || null,
      kind: doc.kind || null,
      modifiedAt: doc.modifiedAt || null,
      contentSha256: typeof doc.content === 'string' ? sha256(doc.content) : null,
      contentLength: typeof doc.content === 'string' ? doc.content.length : null
    }]))),
    events: bounded(events.map(event => ({
      id: event.id,
      type: event.type,
      disposition: event.disposition || null,
      rejection: event.rejection?.code || null,
      payloadId: event.payload?.id || null,
      accountId: event.payload?.accountId || null
    }))),
    situations: bounded(situations.map(situation => ({ id: situation.id, kind: situation.kind, lifecycle: situation.lifecycleState }))),
    links: bounded(links),
    decisions: bounded(decisions),
    notifications: bounded(notifications),
    writeCount: Number(toolRows) || 0,
    connectorCalls: env.calls.length
  };
}

function duplicateCount(outcomes) {
  return outcomes.filter(outcome => outcome.duplicate === true).length;
}

function taskGrouping(snap) {
  const ids = snap.tasks.map(task => task.situationId).filter(Boolean);
  return {
    ids,
    same: ids.length > 1 && new Set(ids).size === 1,
    distinct: new Set(ids).size,
    single: ids.length <= 1
  };
}

function linkedGrouping(snap, grouping) {
  const linked = [...new Set(snap.links.map(link => link.situation_id).filter(Boolean))];
  if (snap.links.length >= 2 && linked.length === 1) return 'same';
  if (linked.length >= 2 || grouping.distinct >= 2) return 'distinct';
  if (snap.tasks.length === 1 && snap.links.length <= 1) return 'single';
  return 'unknown';
}

function crossAccountLinks(snap) {
  const accounts = new Map(snap.events.map(event => [event.id, event.accountId || null]));
  const bySituation = new Map();
  for (const link of snap.links) {
    const account = accounts.get(link.event_id);
    if (!account) continue;
    const entry = bySituation.get(link.situation_id) || { situationId: link.situation_id, accounts: new Set(), eventIds: [] };
    entry.accounts.add(account);
    entry.eventIds.push(link.event_id);
    bySituation.set(link.situation_id, entry);
  }
  return [...bySituation.values()]
    .filter(entry => entry.accounts.size > 1)
    .map(entry => ({ situationId: entry.situationId, accounts: [...entry.accounts].sort(), eventIds: entry.eventIds }));
}

function hasDecision(snap, predicate) {
  return snap.decisions.some(predicate);
}

function eventSituation(snap, eventId) {
  return snap.links.find(link => link.event_id === eventId)?.situation_id || null;
}

async function runEvents(def, env, counters) {
  installContract(def, env, counters);
  if (def.input.model === 'disabled') env.engine.reasoner.available = () => false;
  for (const setup of def.input.setup || []) await applySetup(setup, env);

  const steps = [];
  const snapshots = [];
  let stepIndex = 0;
  for (const step of def.input.steps) {
    if (step.advanceMs) {
      env.advance(step.advanceMs);
      continue;
    }
    const event = buildEvent(step);
    const outcomes = [];
    for (let repeat = 0; repeat < (step.repeat || 1); repeat += 1) {
      outcomes.push(simplifyIngest(env.engine.ingest(structuredClone(event))));
      await env.settle();
    }
    steps.push({ step: stepIndex, index: steps.length, kind: step.kind, eventId: event.id, outcomes });
    snapshots.push({ step: stepIndex, at: env.at(), ...snapshot(env) });
    stepIndex += 1;
  }
  return { steps, snapshots };
}

async function runAttention(def, env) {
  const steps = [];
  let index = 0;
  for (const step of def.input.steps) {
    if (step.advanceMs) {
      env.advance(step.advanceMs);
      index += 1;
      continue;
    }
    if (step.configure) {
      env.store.attention.configure(structuredClone(step.configure));
      steps.push({ index, kind: 'configure', policy: bounded(step.configure) });
      index += 1;
      continue;
    }
    if (step.offer) {
      const rows = [];
      for (let repeat = 0; repeat < (step.repeat || 1); repeat += 1) {
        const result = env.store.attention.offer(notification(structuredClone(step.offer)), { issueKey: step.issueKey });
        rows.push({ state: result?.state || null, class: result?.class || null });
      }
      steps.push({ index, kind: 'offer', key: step.offer.dedupeKey, repeat: step.repeat || 1, rows });
      index += 1;
      continue;
    }
    if (step.release) {
      const released = env.store.attention.releaseDue();
      steps.push({ index, kind: 'release', keys: released.map(row => row.dedupe_key) });
      index += 1;
      continue;
    }
    throw new Error('Unknown attention step.');
  }
  await env.settle();
  return { steps, snapshots: [{ step: index, at: env.at(), ...snapshot(env) }] };
}

function deliveredOrder(snap) {
  return snap.notifications
    .filter(row => row.state === 'delivered')
    .sort((a, b) => `${a.delivered_at || ''}:${a.dedupe_key}`.localeCompare(`${b.delivered_at || ''}:${b.dedupe_key}`))
    .map(row => row.dedupe_key);
}

function measure(def, env, run) {
  const snap = run.snapshots.at(-1) || snapshot(env);
  const stepOutcomes = run.steps.flatMap(step => step.outcomes || []);
  const duplicates = duplicateCount(stepOutcomes);
  const grouping = taskGrouping(snap);
  const externalWrites = snap.writeCount;
  const common = { externalWrites, duplicates, groupingDetail: { ...grouping, documents: Object.keys(snap.documents) } };
  const key = id => snap.notifications.find(row => row.dedupe_key === id) || null;

  switch (def.id) {
    case 'D1':
    case 'D2':
    case 'D3': {
      const changed = duplicates === (stepOutcomes.length - (def.id === 'D3' ? 1 : 1)) && snap.tasks.length <= 1;
      return {
        activation: changed || duplicates >= 1 ? 'once' : 'repeated',
        grouping: 'unchanged',
        ...common,
        details: { stepOutcomes, taskCount: snap.tasks.length, situationCount: snap.situations.length, intentDecisions: snap.decisions.filter(d => d.stage === 'standing_intent') }
      };
    }
    case 'D4': {
      const before = run.snapshots[0];
      const unchanged = before && snap.situations.length === before.situations.length && snap.tasks.length === before.tasks.length;
      return {
        activation: duplicates >= 1 ? 'no_new' : 'reprocessed',
        grouping: unchanged ? 'unchanged' : 'changed',
        ...common,
        details: { stepOutcomes, taskCount: snap.tasks.length, beforeSituations: before?.situations.length, afterSituations: snap.situations.length }
      };
    }
    case 'U1': {
      const task = snap.tasks[0] || null;
      const text = `${task?.requestText || ''} ${task?.subject || ''}`.toLowerCase();
      const latest = Boolean(task) && text.includes('monday') && text.includes('sample size');
      return {
        activation: latest ? 'latest' : text.includes('friday') ? 'stale_revision' : 'unknown',
        grouping: grouping.single || grouping.same ? 'same' : 'distinct',
        ...common,
        details: { task, stepOutcomes }
      };
    }
    case 'U2': {
      const withdrawn = snap.tasks.length > 0 && snap.tasks.every(task => task.status === 'cancelled');
      const resurrected = snap.tasks.some(task => task.status !== 'cancelled');
      return {
        activation: withdrawn ? 'withdrawn' : resurrected ? 'resurrected' : 'unknown',
        grouping: grouping.single || grouping.same ? 'same' : 'distinct',
        ...common,
        details: { tasks: snap.tasks, stepOutcomes }
      };
    }
    case 'U3': {
      const doc = Object.values(snap.documents)[0] || null;
      return {
        activation: doc?.available === false ? 'withdrawn' : doc?.available === true ? 'resurrected' : 'unknown',
        grouping: Object.keys(snap.documents).length <= 1 ? 'same' : 'distinct',
        ...common,
        details: { documents: snap.documents, stepOutcomes }
      };
    }
    case 'U4': {
      const doc = snap.documents['notion:page-1'] || null;
      const latest = doc?.contentSha256 === sha256('Atlas proposal without the supporting quote.');
      return {
        activation: latest ? 'latest' : 'stale_revision',
        grouping: Object.keys(snap.documents).length <= 1 ? 'same' : 'distinct',
        ...common,
        details: { document: doc, stepOutcomes, staleChange: stepOutcomes.some(outcome => outcome.disposition === 'stale_change') }
      };
    }
    case 'G1': {
      return {
        activation: snap.tasks.length >= 2 ? 'actionable' : snap.tasks.length ? 'partial' : 'no_new',
        grouping: grouping.distinct >= 2 ? 'distinct' : grouping.same ? 'same' : 'unknown',
        ...common,
        details: { tasks: snap.tasks, situations: snap.situations, links: snap.links, baselineOnly: true }
      };
    }
    case 'G2':
    case 'G3':
    case 'G4':
    case 'G5':
    case 'G6': {
      const crossAccount = crossAccountLinks(snap);
      const linked = linkedGrouping(snap, grouping);
      return {
        activation: snap.tasks.length ? 'actionable' : 'no_new',
        grouping: def.id === 'G5' && crossAccount.length ? 'cross_root_link' : linked,
        ...common,
        details: { tasks: snap.tasks, situations: snap.situations, links: snap.links, crossAccountLinks: crossAccount }
      };
    }
    case 'G7': {
      const emailTask = snap.tasks[0] || null;
      const docEvent = run.steps.find(step => step.kind === 'document')?.eventId || null;
      const docSituation = docEvent ? eventSituation(snap, docEvent) : null;
      return {
        activation: emailTask ? 'actionable' : 'no_new',
        grouping: emailTask && docSituation && emailTask.situationId === docSituation ? 'same'
          : emailTask && !docSituation ? 'unlinked' : 'distinct',
        ...common,
        details: { emailTask, docEvent, docSituation, links: snap.links }
      };
    }
    case 'G8': {
      const review = snap.tasks.some(task => task.guidanceReviewRequired || task.paused)
        || hasDecision(snap, decision => String(decision.outcome || '').toUpperCase() === 'CONTRADICT')
        || hasDecision(snap, decision => String(decision.reason_code || '').toLowerCase().includes('contradict'));
      return {
        activation: review ? 'review_required' : snap.tasks.length ? 'actionable' : 'no_new',
        grouping: grouping.single || grouping.same ? 'same' : 'distinct',
        ...common,
        details: { tasks: snap.tasks, decisions: snap.decisions, links: snap.links }
      };
    }
    case 'A1':
    case 'A4': {
      return {
        activation: snap.tasks.length ? 'actionable' : 'no_new',
        grouping: 'not_applicable',
        ...common,
        details: { taskCount: snap.tasks.length, tasks: snap.tasks, decisions: snap.decisions, stepOutcomes }
      };
    }
    case 'A9': {
      const intent = snap.decisions.filter(decision => decision.stage === 'standing_intent');
      const matched = intent.some(decision => String(decision.outcome || '').toUpperCase() === 'MATCHED');
      return {
        activation: snap.tasks.length || matched ? 'actionable' : intent.some(decision => decision.outcome === 'UNKNOWN') ? 'unknown' : 'no_new',
        grouping: 'not_applicable',
        ...common,
        details: { taskCount: snap.tasks.length, tasks: snap.tasks, intentDecisions: intent, decisions: snap.decisions, stepOutcomes }
      };
    }
    case 'A2':
    case 'A3':
    case 'A5': {
      return {
        activation: snap.tasks.length ? 'actionable' : 'no_new',
        grouping: 'not_applicable',
        ...common,
        details: { taskCount: snap.tasks.length, tasks: snap.tasks, stepOutcomes }
      };
    }
    case 'A6':
    case 'A7': {
      const suppressedDispositions = new Set(['suppressed_by_user_policy', 'permission_revoked', 'suppressed', 'privacy_blocked']);
      const suppressed = snap.tasks.length === 0
        && (hasDecision(snap, decision => ['suppress', 'suppressed'].includes(String(decision.outcome || '').toLowerCase()))
          || stepOutcomes.some(outcome => suppressedDispositions.has(String(outcome.disposition || '')))
          || snap.events.some(event => suppressedDispositions.has(String(event.disposition || ''))));
      return {
        activation: suppressed ? 'suppressed' : snap.tasks.length ? 'actionable' : 'no_new',
        grouping: 'not_applicable',
        ...common,
        details: { taskCount: snap.tasks.length, decisions: snap.decisions, events: snap.events, stepOutcomes }
      };
    }
    case 'A8': {
      const intent = snap.decisions.filter(decision => decision.stage === 'standing_intent');
      const deferred = intent.some(decision => String(decision.outcome || '').toLowerCase().includes('defer')
        || String(decision.reason_code || '').toLowerCase().includes('budget'));
      return {
        activation: deferred ? 'deferred' : snap.tasks.length ? 'actionable' : 'no_new',
        grouping: 'not_applicable',
        ...common,
        details: { intentDecisions: intent, taskCount: snap.tasks.length, stepOutcomes }
      };
    }
    case 'A10': {
      const linkedSituations = [...new Set(snap.links.map(link => link.situation_id))];
      const merged = linkedSituations.length === 1 && snap.links.length >= 2;
      const rejected = hasDecision(snap, decision => ['reject', 'rejected', 'review_required', 'guard_rejected'].includes(String(decision.outcome || '').toLowerCase()))
        || hasDecision(snap, decision => String(decision.reason_code || '').toLowerCase().includes('tenant'))
        || (run.steps.length >= 2 && (run.steps[1].outcomes || []).some(outcome => outcome.disposition !== 'task_created'));
      return {
        activation: rejected ? 'review_or_reject' : snap.tasks.length ? 'actionable' : 'unknown',
        grouping: merged ? 'same' : grouping.distinct >= 2 || snap.links.length === 0 ? 'distinct' : 'unknown',
        ...common,
        details: { tasks: snap.tasks, decisions: snap.decisions, links: snap.links, stepOutcomes }
      };
    }
    case 'N1': {
      const delivered = deliveredOrder(snap);
      return {
        activation: delivered[0] === 'high' ? 'priority_high_first' : delivered.length ? 'wrong_order' : 'not_delivered',
        grouping: 'not_applicable',
        ...common,
        details: { delivered, notifications: snap.notifications, steps: run.steps }
      };
    }
    case 'N2': {
      const delivered = deliveredOrder(snap);
      const low = key('low');
      return {
        activation: low?.state === 'delivered' ? 'bounded_low_service' : 'starvation',
        grouping: 'not_applicable',
        ...common,
        details: { delivered, low, notifications: snap.notifications }
      };
    }
    case 'N3': {
      const delivered = deliveredOrder(snap);
      return {
        activation: delivered.length === 1 && delivered[0] === 'issue:atlas:7' ? 'deduped_notice' : 'notification_storm',
        grouping: 'not_applicable',
        ...common,
        details: { delivered, notifications: snap.notifications, steps: run.steps }
      };
    }
    case 'N4': {
      const delivered = deliveredOrder(snap);
      const quiet = key('n4-quiet');
      const cap = key('n4-cap0');
      const observable = quiet?.state === 'pending' && cap?.state === 'digest';
      return {
        activation: delivered.length === 0 && observable ? 'no_interruption' : delivered.length ? 'interrupted' : 'unknown',
        grouping: 'not_applicable',
        ...common,
        details: { delivered, quiet, cap, notifications: snap.notifications }
      };
    }
    default:
      throw new Error(`No measurement for case ${def.id}`);
  }
}

function declaredModules(def) {
  const modules = new Set(['connectors/events.js', 'engine.js', 'durable/runtime.js', 'durable/store.js', 'durable/tasks.js', 'durable/situations.js', 'durable/candidates.js']);
  if (['D3', 'A8', 'A9'].includes(def.id)) modules.add('durable/standing-intents.js');
  if (['A6'].includes(def.id)) modules.add('durable/context.js');
  if (['A7'].includes(def.id)) modules.add('durable/privacy.js');
  if (['A4'].includes(def.id)) modules.add('requests.js');
  if (['G2', 'G3', 'G4', 'G5', 'G6', 'U2'].includes(def.id)) modules.add('external-work.js');
  if (['N1', 'N2', 'N3', 'N4'].includes(def.id)) modules.add('durable/attention.js');
  if (['N1', 'N2', 'N3', 'N4'].includes(def.id)) modules.add('notifications.js');
  if (def.input.contract) modules.add('reasoning.js (production interface; contract script only)');
  return [...modules].sort();
}

export function judgeCase(entry) {
  if (entry.execution === 'not_executed') return { judgment: 'not_executed', mismatches: [] };
  const mismatches = ['activation', 'grouping', 'externalWrites']
    .filter(field => entry.actual[field] !== entry.expected[field]);
  if (entry.contract && entry.contract.matched === false) mismatches.push('contractCalls');
  return { judgment: mismatches.length ? 'fail' : 'pass', mismatches };
}

function runNetworkGuard(requests) {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    requests.push(url);
    throw new Error('activation-quality: network access is not allowed');
  };
  return () => { globalThis.fetch = original; };
}

async function executeCase(def, networkRequests) {
  const started = performance.now();
  const counters = {};
  const env = openActivationReplay({ at: def.input.clockStart || '2026-10-28T12:00:00.000Z' });
  try {
    const run = def.input.runner === 'attention'
      ? await runAttention(def, env)
      : await runEvents(def, env, counters);
    const actual = measure(def, env, run);
    const nativeAdmissionBlocked = actual.details?.decisions?.some(decision => decision.stage === 'standing_intent' && decision.outcome === 'UNKNOWN' && decision.reason_code === 'sender_identity_unavailable') ? 'sender_identity_unavailable' : null;
    const contract = def.input.contract ? {
      nativeAdmissionBlocked,
      expectedCalls: structuredClone(def.input.contract.expectCalls || {}),
      actualCalls: Object.fromEntries(MODEL_METHODS.map(method => [method, counters[method] || 0])),
      matched: Object.entries(def.input.contract.expectCalls || {}).every(([method, count]) => (counters[method] || 0) === (nativeAdmissionBlocked && method === 'assessStandingIntent' ? 0 : count))
    } : null;
    return {
      actual,
      contract,
      modelCalls: Object.fromEntries(MODEL_METHODS.map(method => [method, counters[method] || 0])),
      networkRequestCount: networkRequests.length,
      latencyMs: Number((performance.now() - started).toFixed(3))
    };
  } finally {
    await env.close();
  }
}

export function buildReport({ fixture, fixturePath, hashes, caseResults, extras = {} }) {
  const cases = caseResults.map(result => {
    const base = {
      id: result.def.id,
      axis: result.def.axis,
      description: result.def.description,
      expected: result.def.expected,
      execution: result.def.execution,
      executionReason: result.def.executionReason || null,
      provenance: result.def.execution === 'proposal_contract' ? 'proposal_contract'
        : result.def.execution === 'not_executed' ? 'not_executed' : 'deterministic',
      semanticQuality: result.def.semanticQuality,
      actual: result.actual,
      contract: result.contract,
      modelCalls: result.modelCalls,
      modules: declaredModules(result.def),
      latencyMs: result.latencyMs,
      error: result.error || null
    };
    const judged = judgeCase(base);
    return { ...base, judgment: judged.judgment, mismatches: judged.mismatches };
  });
  const deterministic = cases.filter(entry => entry.execution === 'deterministic');
  const contractCases = cases.filter(entry => entry.execution === 'proposal_contract');
  const notExecuted = cases.filter(entry => entry.execution === 'not_executed');

  const deterministicFailures = deterministic.filter(entry => entry.judgment === 'fail').map(entry => entry.id);
  const contractFailures = contractCases.filter(entry => entry.judgment === 'fail').map(entry => entry.id);
  const unexpectedContractFailures = contractCases.filter(entry => entry.judgment === 'fail').map(entry => entry.id);
  const externalWritesTotal = cases.reduce((sum, entry) => sum + Number(entry.actual.externalWrites || 0), 0);
  const duplicateCases = cases.filter(entry => ['D1', 'D2', 'D3'].includes(entry.id));
  const resurrectionCases = cases.filter(entry => ['U2', 'U3'].includes(entry.id));
  const activationEntries = cases.filter(entry => entry.execution !== 'not_executed' && entry.expected.activation !== 'not_applicable'
    && ['actionable', 'no_new', 'suppressed', 'deferred', 'unknown', 'review_required', 'review_or_reject', 'withdrawn', 'latest', 'once', 'no_new'].includes(entry.expected.activation));
  const falseActivation = activationEntries.filter(entry => entry.actual.activation === 'actionable'
    && ['no_new', 'suppressed', 'deferred', 'unknown', 'review_or_reject', 'withdrawn', 'once'].includes(entry.expected.activation)).map(entry => entry.id);
  const missedActivation = activationEntries.filter(entry => entry.expected.activation === 'actionable' && entry.actual.activation !== 'actionable').map(entry => entry.id);

  const pairCases = cases.filter(entry => entry.id.startsWith('G'));
  const pairs = [];
  for (const entry of pairCases) {
    const snap = entry.actual.details?.links ? entry.actual.details : null;
    const links = Array.isArray(snap?.links) ? snap.links : [];
    const ids = [...new Set(links.map(link => link.event_id))];
    for (let a = 0; a < ids.length; a += 1) {
      for (let b = a + 1; b < ids.length; b += 1) {
        const sa = links.find(link => link.event_id === ids[a])?.situation_id || null;
        const sb = links.find(link => link.event_id === ids[b])?.situation_id || null;
        if (!sa || !sb) continue;
        pairs.push({ case: entry.id, a: ids[a], b: ids[b], merged: sa === sb, expected: entry.expected.grouping, executed: entry.execution !== 'not_executed' });
      }
    }
  }
  const executedPairs = pairs.filter(pair => pair.executed);
  const truePositive = executedPairs.filter(pair => pair.expected === 'same' && pair.merged).length;
  const falsePositive = executedPairs.filter(pair => pair.expected === 'distinct' && pair.merged).length;
  const falseNegative = executedPairs.filter(pair => pair.expected === 'same' && !pair.merged).length;
  const notExecutedPairs = pairs.filter(pair => !pair.executed).length;

  const latencies = cases.map(entry => entry.latencyMs).filter(value => Number.isFinite(value));
  const modelCalls = Object.fromEntries(MODEL_METHODS.map(method => [method, cases.reduce((sum, entry) => sum + Number(entry.modelCalls?.[method] || 0), 0)]));
  const notifications = cases.reduce((sum, entry) => sum + (entry.actual.details?.notifications?.length || 0), 0);
  const contractMatched = contractCases.every(entry => entry.contract?.matched !== false);

  const networkRequests = extras.networkRequests || [];
  const failures = [
    ...deterministicFailures.map(id => ({ id, type: 'deterministic_mismatch' })),
    ...contractFailures.map(id => ({ id, type: 'proposal_contract_mismatch' })),
    ...notExecuted.map(entry => ({ id: entry.id, type: 'not_executed' }))
  ];
  if (networkRequests.length) failures.push({ id: 'network', type: 'unexpected_network', count: networkRequests.length });
  if (externalWritesTotal !== 0) failures.push({ id: 'external_writes', type: 'external_write', count: externalWritesTotal });
  if (!contractMatched) failures.push({ id: 'contract_calls', type: 'contract_call_mismatch' });

  const knownGapIds = Object.keys(KNOWN_GAP_NOTES).filter(id => failures.some(failure => failure.id === id));
  const notExecutedIds = notExecuted.map(entry => entry.id);
  const knownIds = new Set([...knownGapIds, ...notExecutedIds]);
  const unexpectedFailures = failures.filter(failure => !knownIds.has(failure.id));
  const gate = {
    status: failures.length ? 'FAIL' : 'PASS',
    deterministic: { total: deterministic.length, passed: deterministic.length - deterministicFailures.length, failed: deterministicFailures },
    proposalContract: { total: contractCases.length, passed: contractCases.length - contractFailures.length, failed: unexpectedContractFailures },
    notExecuted: notExecutedIds,
    semanticGate: notExecuted.length ? 'not_executed' : contractCases.length ? 'contract_only' : 'not_applicable',
    knownGapIds,
    unexpectedFailureIds: unexpectedFailures.map(failure => failure.id),
    networkRequests: networkRequests.length,
    externalWritesTotal,
    failures
  };

  const aggregation = {
    pairwise: {
      method: 'All linked event pairs inside G cases; merged means both event ids share one event_situation_links situation. The G1 baseline pair is not_executed.',
      truePositive,
      falsePositive,
      falseNegative,
      notExecutedPairs,
      precision: truePositive + falsePositive ? Number((truePositive / (truePositive + falsePositive)).toFixed(4)) : null,
      recall: truePositive + falseNegative ? Number((truePositive / (truePositive + falseNegative)).toFixed(4)) : null,
      pairs: bounded(pairs)
    },
    falseActivation,
    missedActivation,
    duplicateSurvived: duplicateCases.filter(entry => entry.actual.duplicates < 1).map(entry => entry.id),
    resurrectionObserved: resurrectionCases.filter(entry => entry.actual.activation === 'resurrected').map(entry => entry.id),
    modelCalls,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    notifications,
    tokenUsage: 'unknown',
    currency: 'unknown',
    counterfactual: {
      method: 'call_count_only',
      case: 'D1',
      baselineEvents: 3,
      dedupedModelRequests: 0,
      naiveModelRequests: 3,
      difference: 3,
      tokenDifference: 'unknown'
    }
  };

  return {
    schema: 1,
    evalVersion: EVAL_VERSION,
    generatedAt: new Date().toISOString(),
    fixture: {
      path: path.relative(ROOT, fixturePath),
      version: fixture.fixtureVersion,
      oracleVersion: fixture.oracleVersion,
      sha256: hashes.fixtureSha256,
      sourceGoldSha256: fixture.provenance.sourceGoldSha256,
      cases: fixture.cases.length
    },
    environment: {
      node: process.version,
      platform: process.platform,
      tmpdir: os.tmpdir(),
      clockStart: fixture.provenance.clockStart,
      networkGuard: 'globalThis.fetch throws on any call'
    },
    sourceHashes: hashes.sources,
    cases,
    aggregation,
    negativeControls: buildNegativeControls(cases),
    actualModel: {
      executed: false,
      maxRequests: 8,
      usedRequests: 0,
      plannedCases: ['G1', 'G2', 'G3', 'A1', 'A3', 'A4'],
      plannedBudgetRequests: 6,
      reserveRequests: 2,
      bridge: 'test/fixtures/activation-quality-bridge.mjs',
      contextIsolation: [
        'explicit application system prompt via --system-prompt, not a coding-agent wrapper',
        'empty tool set and strict empty MCP configuration',
        'clean temporary cwd and no session persistence',
        'only the public synthetic fixture may be sent; gold expected values and project documents are marker-scanned and rejected',
        'authentication values never placed in argv or report output'
      ],
      provenanceRule: 'Only a real CLI result may be labelled actual-model. Proposal-contract mocks cannot establish semantic precision or recall.',
      tokenUsage: 'unknown',
      currency: 'unknown',
      blockedBy: 'Frozen candidate plus the central single-heavy slot; implementation phase does not run live model calls.'
    },
    knownGaps: knownGapIds.map(id => {
      const entry = cases.find(item => item.id === id);
      return {
        id,
        expected: entry?.expected || null,
        actual: entry ? { activation: entry.actual.activation, grouping: entry.actual.grouping } : null,
        judgment: entry?.judgment || null,
        ...KNOWN_GAP_NOTES[id]
      };
    }),
    gate,
    incompleteBoundaries: [
      'Actual-model semantic quality is not executed in this implementation phase; the maximum-8-request gate remains closed.',
      'G1 semantic same-Situation grouping is not_executed; only provider identity and baseline task distinctness are recorded.',
      'Proposal-contract cases validate downstream defences against scripted proposals, not model precision or recall.',
      'Token usage, cache components and currency cost are unknown; only model request counts are measured.',
      'The CLI bridge is contract-tested with a fake CLI only; no real Claude connection was exercised.'
    ]
  };
}

function mutateAndDetect(cases, target, mutate) {
  const copy = structuredClone(cases);
  mutate(copy);
  for (const entry of copy) {
    const judged = judgeCase(entry);
    entry.judgment = judged.judgment;
    entry.mismatches = judged.mismatches;
  }
  const failures = copy.filter(entry => entry.execution === 'deterministic' && entry.judgment === 'fail').map(entry => entry.id);
  return { detected: failures.includes(target), target, failures };
}

export function buildNegativeControls(cases) {
  return [
    {
      name: 'grouping_false_merge',
      description: 'Force G2 to report one situation; the grouping gate must fail.',
      ...mutateAndDetect(cases, 'G2', copy => {
        const entry = copy.find(item => item.id === 'G2');
        entry.actual.grouping = 'same';
        entry.actual.externalWrites = entry.expected.externalWrites;
      })
    },
    {
      name: 'activation_false_positive',
      description: 'Force A2 (automated build notice) to report actionable; the activation gate must fail.',
      ...mutateAndDetect(cases, 'A2', copy => {
        const entry = copy.find(item => item.id === 'A2');
        entry.actual.activation = 'actionable';
      })
    },
    {
      name: 'counting_duplicate_miss',
      description: 'Force D1 to report that no duplicate was observed; the dedupe gate must fail.',
      ...mutateAndDetect(cases, 'D1', copy => {
        const entry = copy.find(item => item.id === 'D1');
        entry.actual.duplicates = 0;
        entry.actual.activation = 'repeated';
      })
    }
  ];
}

function fixtureIntegrity(fixture) {
  const ids = fixture.cases.map(entry => entry.id);
  const expectedIds = [
    'D1', 'D2', 'D3', 'D4', 'U1', 'U2', 'U3', 'U4',
    'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8',
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10',
    'N1', 'N2', 'N3', 'N4'
  ];
  const errors = [];
  if (fixture.cases.length !== 30) errors.push(`expected 30 cases, got ${fixture.cases.length}`);
  if (new Set(ids).size !== ids.length) errors.push('case ids are not unique');
  for (const id of expectedIds) if (!ids.includes(id)) errors.push(`missing case ${id}`);
  for (const entry of fixture.cases) {
    if (!entry.expected || !['activation', 'grouping', 'externalWrites'].every(key => key in entry.expected)) errors.push(`${entry.id} expected is incomplete`);
    if (!entry.description || entry.description.length < 10) errors.push(`${entry.id} description is empty`);
    if (!entry.input) errors.push(`${entry.id} input is missing`);
  }
  return { ok: errors.length === 0, errors, fixtureVersion: fixture.fixtureVersion, oracleVersion: fixture.oracleVersion };
}

export async function runEval({ fixturePath = FIXTURE_PATH } = {}) {
  const fixture = readJson(fixturePath);
  const integrity = fixtureIntegrity(fixture);
  if (!integrity.ok) throw new Error(`activation-quality fixture integrity failed: ${integrity.errors.join('; ')}`);
  const networkRequests = [];
  const restoreFetch = runNetworkGuard(networkRequests);
  const caseResults = [];
  try {
    for (const def of fixture.cases) {
      try {
        const result = await executeCase(def, networkRequests);
        caseResults.push({ def, ...result });
      } catch (error) {
        caseResults.push({
          def,
          actual: { activation: 'error', grouping: 'error', externalWrites: 0, duplicates: 0, details: { error: bounded(String(error?.stack || error)) } },
          contract: def.input.contract ? { expectedCalls: def.input.contract.expectCalls || {}, actualCalls: {}, matched: false } : null,
          modelCalls: {},
          error: bounded(String(error?.stack || error)),
          latencyMs: 0
        });
      }
    }
  } finally {
    restoreFetch();
  }
  const hashes = {
    fixtureSha256: sha256(fs.readFileSync(fixturePath)),
    sources: sourceHashes()
  };
  const report = buildReport({ fixture, fixturePath, hashes, caseResults, extras: { networkRequests } });
  report.fixtureIntegrity = integrity;
  report.networkRequests = networkRequests;
  report.sourceHashes = hashes.sources;
  report.fixture.sha256 = hashes.fixtureSha256;
  report.goldFile = {
    path: path.relative(ROOT, GOLD_PATH),
    sha256: fs.existsSync(GOLD_PATH) ? sha256(fs.readFileSync(GOLD_PATH)) : null,
    matchesFixtureProvenance: fs.existsSync(GOLD_PATH)
      ? sha256(fs.readFileSync(GOLD_PATH)) === fixture.provenance.sourceGoldSha256
      : null
  };
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  runEval()
    .then(report => {
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (outIndex >= 0 && args[outIndex + 1]) fs.writeFileSync(path.resolve(args[outIndex + 1]), text);
      else process.stdout.write(text);
      process.exitCode = report.gate.status === 'PASS' ? 0 : 2;
    })
    .catch(error => {
      process.stderr.write(`activation-quality eval failed: ${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
