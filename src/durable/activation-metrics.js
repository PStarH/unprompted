/** Denominators are explicit. Missing labels or costs stay unknown; this does
 * not estimate opportunities the user never showed. */
const ratio = (numerator, denominator) => denominator > 0 ? { numerator, denominator, value: numerator / denominator } : { numerator, denominator, value: 'unknown', reason: 'empty_denominator' };
const unknown = reason => ({ numerator: null, denominator: null, value: 'unknown', reason });

export function activationMetrics(database, { labeled = null, costs = null, since = null, until = null } = {}) {
  const db = database.db;
  const window = [since, until];
  const decisions = db.prepare(`SELECT COUNT(*) n FROM activation_decisions WHERE (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?)`).get(...window, ...window).n;
  const tasks = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?)`).get(...window, ...window).n;
  const duplicateSignals = db.prepare(`SELECT COUNT(*) n FROM (SELECT task_id,source_event_id,signal_type FROM task_signals GROUP BY task_id,source_event_id,signal_type HAVING COUNT(*)>1)`).get().n;
  const activeDupes = db.prepare(`SELECT COUNT(*) n FROM (SELECT situation_id,dedup_task_key FROM tasks WHERE situation_id IS NOT NULL AND dedup_task_key IS NOT NULL AND status NOT IN ('completed','cancelled') GROUP BY situation_id,dedup_task_key HAVING COUNT(*)>1)`).get().n;
  const stale = db.prepare('SELECT COUNT(*) n FROM artifacts WHERE stale=1').get().n;
  const artifacts = db.prepare('SELECT COUNT(*) n FROM artifacts').get().n;
  const yields = db.prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(data_json,'$.yieldState')='YIELDED_TO_USER'").get().n;
  const resumed = db.prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(data_json,'$.yieldResumedAt') IS NOT NULL").get().n;
  const forgotten = db.prepare('SELECT COUNT(*) n FROM forgotten_sources').get().n;
  const repeatedReceipts = db.prepare(`SELECT COUNT(*) n FROM (
    SELECT provider,provider_receipt_id FROM tool_executions
    WHERE is_write=1 AND status='verified' AND provider_receipt_id IS NOT NULL
    GROUP BY provider,provider_receipt_id HAVING COUNT(*)>1)`).get().n;
  const verifiedWrites = db.prepare("SELECT COUNT(*) n FROM tool_executions WHERE is_write=1 AND status='verified'").get().n;
  const labeledMetrics = labeled && Number.isInteger(labeled.useful) && Number.isInteger(labeled.activated) && Number.isInteger(labeled.truePositives) && Number.isInteger(labeled.labeledPositives)
    ? {
      usefulTaskPrecision: ratio(labeled.useful, labeled.activated),
      labeledRecall: ratio(labeled.truePositives, labeled.labeledPositives),
      falseActivation: ratio(Math.max(0, labeled.activated - labeled.useful), labeled.activated)
    }
    : { usefulTaskPrecision: unknown('unlabeled'), labeledRecall: unknown('unlabeled'), falseActivation: unknown('unlabeled') };
  return {
    window: { since, until, decisions },
    ...labeledMetrics,
    duplicateTaskRate: ratio(activeDupes, tasks),
    duplicateSignalGroups: duplicateSignals,
    incorrectClosure: unknown('requires_labeled_closure'),
    missedCancellation: unknown('requires_labeled_cancellation'),
    staleArtifactRate: ratio(stale, artifacts),
    yieldResumeRate: ratio(resumed, yields),
    unnecessaryInterruption: unknown('requires_labeled_interruption'),
    evidenceToDelivery: unknown('requires_labeled_delivery_times'),
    costPerUsefulTask: costs && Number.isFinite(costs.total) && labeled?.useful > 0 ? { numerator: costs.total, denominator: labeled.useful, value: costs.total / labeled.useful, currency: costs.currency || null } : unknown('no_cost_data'),
    repeatedSideEffects: ratio(repeatedReceipts, verifiedWrites),
    forgetScope: { forgottenKeys: forgotten, physicalErasure: 'not_claimed' }
  };
}
