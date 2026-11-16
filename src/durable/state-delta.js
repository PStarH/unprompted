import { unquotedMessageFields } from '../commitments.js';
import { extractDeadline } from '../requests.js';

const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const short = (value, max = 300) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Validate all extracted facts against the actual, unquoted observation. */
export function validateStateDelta(value, event) {
  if (!object(value, ['associated', 'polarity', 'stateDelta', 'evidenceRefs', 'confidence']) || typeof value.associated !== 'boolean'
    || !['ADVANCE', 'CANCEL', 'SUPERSEDE', 'CONTRADICT', 'NEUTRAL', 'UNKNOWN'].includes(value.polarity)
    || !object(value.stateDelta, ['deadlineUpdates', 'commitments', 'closureConditionUpdates', 'probeTargets', 'missingEvidence'])
    || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 8
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return null;
  const fields = unquotedMessageFields(event.payload), delta = value.stateDelta;
  const grounded = ref => object(ref, ['field', 'quote']) && ['subject', 'body'].includes(ref.field) && short(ref.quote)
    && String(fields[ref.field] || '').includes(ref.quote);
  if (!value.evidenceRefs.every(grounded) || value.associated && !value.evidenceRefs.length) return null;
  for (const name of ['deadlineUpdates', 'commitments', 'closureConditionUpdates']) {
    if (!Array.isArray(delta[name]) || delta[name].length > 8 || !delta[name].every(grounded)) return null;
  }
  if (!Array.isArray(delta.probeTargets) || delta.probeTargets.length || !Array.isArray(delta.missingEvidence)
    || delta.missingEvidence.length > 8 || delta.missingEvidence.some(item => !short(item))) return null;
  const deadlines = [];
  for (const ref of delta.deadlineUpdates) {
    const parsed = extractDeadline(ref.quote, { now: event.at });
    if (!parsed?.iso) return null;
    deadlines.push({ iso: parsed.iso, quote: ref.quote, field: ref.field });
  }
  return { associated: value.associated, polarity: value.polarity, confidence: value.confidence, evidenceRefs: value.evidenceRefs,
    stateDelta: { deadlineUpdates: deadlines, commitments: delta.commitments, closureConditionUpdates: delta.closureConditionUpdates,
      probeTargets: [], missingEvidence: delta.missingEvidence } };
}

/** A model's classification cannot turn negation or vague uncertainty into a
 * cancellation. Restrict automatic cancellation to a clear source statement. */
export function confirmsCancellation(refs, event) {
  const fields = unquotedMessageFields(event.payload);
  return refs.some(({ field, quote }) => String(fields[field] || '').split(/\r?\n/).some(line => {
    const text = line.trim().toLowerCase();
    if (!text.includes(quote.toLowerCase()) || /\b(?:if|unless|whether|might|may|would|could|consider|possibly|think|discuss)\b/.test(text)
      || /\b(?:do not|don't|never|not|cannot|can't)\s+(?:cancel|withdraw|stop)\b/.test(text)) return false;
    return /^(?:(?:please\s+)?(?:cancel|withdraw)\s+(?:the|this|our|my)\s+[\p{L}\p{N}][\p{L}\p{N} '\-]{0,80}|(?:we|i)\s+(?:will not|won't|decided not to)\s+(?:proceed|go ahead)(?:\s+with\s+(?:the|this|our)\s+[\p{L}\p{N}][\p{L}\p{N} '\-]{0,80})?)[.!]?$/u.test(text);
  }));
}

/** Source-bound semantic receipt. It survives private final scrubbing so a
 * crash after ACK cannot lose the exact scoped control interpretation. */
export function ensureStateDeltaSchema(database) {
  database.atomic(() => {
    database.db.exec(`CREATE TABLE IF NOT EXISTS situation_delta_results (
    event_id TEXT NOT NULL REFERENCES durable_inbox(id) ON DELETE CASCADE,
    situation_id TEXT NOT NULL REFERENCES situations(id) ON DELETE CASCADE,
    delta_json TEXT NOT NULL, target_fences_json TEXT NOT NULL, scoped_task_ids_json TEXT NOT NULL,
    situation_version INTEGER NOT NULL, privacy_epoch INTEGER NOT NULL, context_json TEXT NOT NULL DEFAULT '{}',
    scoped_applied INTEGER NOT NULL DEFAULT 0 CHECK(scoped_applied IN (0,1)),
    PRIMARY KEY(event_id,situation_id))`);
    const columns = new Set(database.db.pragma('table_info(situation_delta_results)').map(row => row.name));
    if (!columns.has('context_json')) database.db.exec("ALTER TABLE situation_delta_results ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
  });
}
