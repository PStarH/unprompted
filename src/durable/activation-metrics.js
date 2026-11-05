import { durableError } from './database.js';

/** Denominators are explicit. Missing labels or costs stay unknown; this does
 * not estimate opportunities the user never showed. */
const ratio = (numerator, denominator) => denominator > 0 ? { numerator, denominator, value: numerator / denominator } : { numerator, denominator, value: 'unknown', reason: 'empty_denominator' };
const unknown = reason => ({ numerator: null, denominator: null, value: 'unknown', reason });

export function activationMetrics(database, { labeled = null, costs = null, since = null, until = null } = {}) {
  const db = database.db;
  if ([since, until].some(value => value != null && !Number.isFinite(Date.parse(value))) || since && until && Date.parse(since) > Date.parse(until)) throw durableError('INVALID_METRIC_WINDOW', 'Choose an ordered valid time window.', 400);
  since = since == null ? null : new Date(since).toISOString(); until = until == null ? null : new Date(until).toISOString();
  const window = [since, since, until, until];
  const decisions = db.prepare(`SELECT COUNT(*) n FROM activation_decisions WHERE (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?)`).get(...window).n;
  const tasks = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?)`).get(...window).n;
  const taskWindow = `(? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?)`;
  const duplicateSignals = db.prepare(`SELECT COUNT(*) n FROM (SELECT task_id,source_event_id,signal_type FROM task_signals WHERE ${taskWindow} GROUP BY task_id,source_event_id,signal_type HAVING COUNT(*)>1)`).get(...window).n;
  const activeDupes = db.prepare(`SELECT COUNT(*) n FROM (SELECT situation_id,dedup_task_key FROM tasks WHERE ${taskWindow} AND situation_id IS NOT NULL AND dedup_task_key IS NOT NULL AND status NOT IN ('completed','cancelled') GROUP BY situation_id,dedup_task_key HAVING COUNT(*)>1)`).get(...window).n;
  const stale = db.prepare(`SELECT COUNT(*) n FROM artifacts WHERE stale=1 AND ${taskWindow}`).get(...window).n;
  const artifacts = db.prepare(`SELECT COUNT(*) n FROM artifacts WHERE ${taskWindow}`).get(...window).n;
  const yieldedCohort = db.prepare(`SELECT data_json FROM tasks WHERE ${taskWindow} AND (json_extract(data_json,'$.yieldState')='YIELDED_TO_USER' OR json_extract(data_json,'$.yieldResumedAt') IS NOT NULL)`).all(...window).map(row => JSON.parse(row.data_json));
  const yields = yieldedCohort.length, resumed = yieldedCohort.filter(task => task.yieldResumedAt).length;
  const forgotten = db.prepare('SELECT COUNT(*) n FROM forgotten_sources').get().n;
  const repeatedReceipts = db.prepare(`SELECT COUNT(*) n FROM (
    SELECT provider,provider_receipt_id FROM tool_executions
    WHERE ${taskWindow} AND is_write=1 AND status='verified' AND provider_receipt_id IS NOT NULL
    GROUP BY provider,provider_receipt_id HAVING COUNT(*)>1)`).get(...window).n;
  const verifiedWrites = db.prepare(`SELECT COUNT(*) n FROM tool_executions WHERE ${taskWindow} AND is_write=1 AND status='verified'`).get(...window).n;
  if (labeled && (['useful', 'activated', 'truePositives', 'labeledPositives'].some(key => !Number.isInteger(labeled[key]) || labeled[key] < 0) || labeled.useful > labeled.activated || labeled.truePositives > labeled.labeledPositives)) throw durableError('INVALID_METRIC_LABELS', 'Labeled counts must be consistent nonnegative integers.', 400);
  const labeledMetrics = labeled && Number.isInteger(labeled.useful) && Number.isInteger(labeled.activated) && Number.isInteger(labeled.truePositives) && Number.isInteger(labeled.labeledPositives)
    ? {
      usefulTaskPrecision: ratio(labeled.useful, labeled.activated),
      labeledRecall: ratio(labeled.truePositives, labeled.labeledPositives),
      falseActivation: ratio(Math.max(0, labeled.activated - labeled.useful), labeled.activated)
    }
    : { usefulTaskPrecision: unknown('unlabeled'), labeledRecall: unknown('unlabeled'), falseActivation: unknown('unlabeled') };
  return {
    window: { since, until, decisions, cohort: 'created_in_window', inventoryAsOf: 'current' },
    ...labeledMetrics,
    duplicateTaskRate: ratio(activeDupes, tasks),
    duplicateSignalGroups: duplicateSignals,
    incorrectClosure: unknown('requires_labeled_closure'),
    missedCancellation: unknown('requires_labeled_cancellation'),
    staleArtifactRate: ratio(stale, artifacts),
    yieldResumeRate: ratio(resumed, yields),
    unnecessaryInterruption: unknown('requires_labeled_interruption'),
    evidenceToDelivery: unknown('requires_labeled_delivery_times'),
    costPerUsefulTask: costs && Number.isFinite(costs.total) && costs.total >= 0 && labeled?.useful > 0 ? { numerator: costs.total, denominator: labeled.useful, value: costs.total / labeled.useful, currency: costs.currency || null } : unknown('no_cost_data'),
    repeatedSideEffects: ratio(repeatedReceipts, verifiedWrites),
    forgetScope: { forgottenKeys: forgotten, physicalErasure: 'not_claimed' }
  };
}
