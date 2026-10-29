import { createHash, randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { FeatureRegistry, scopeMatches } from './context.js';

export const LEARNING_DEFAULTS = Object.freeze({ version: 1, autoPromote: false, mechanicalSuccesses: 3, repeatedOverrides: 3, highEditRatio: 0.7, operationalRevalidateMs: 30 * 86400000, cooldownMs: 7 * 86400000 });
const kinds = ['execution_hint', 'planning_hint', 'omission_guard', 'trigger_hint'];
const scopeRank = { global: 0, task_family: 1, project: 2, entity: 3, resource: 4 };
const effectKeys = Object.freeze({
  draft_format: ['type', 'format', 'fields'], archive_destination: ['type', 'provider', 'resourceId'],
  notification_behavior: ['type', 'mode'], review_requirements: ['type', 'required', 'reviewerIds'],
  step_behavior: ['type', 'stepKind', 'operation'], advisory: ['type']
});
const forbidden = /permission|authoriz|runtime|registry|executable|source_code|grant|shell/i;
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${json(key)}:${canonical(value[key])}`).join(',')}}` : json(value);
export const effectDigest = effect => createHash('sha256').update(canonical(effect)).digest('hex');
export function validateExperienceEffect(effect) {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect) || json(effect).length > 8000) throw durableError('INVALID_EFFECT', 'Invalid Experience effect.', 400);
  if (Object.keys(effect).some(key => forbidden.test(key))) throw durableError('UNSAFE_EXPERIENCE', 'Experiences cannot modify permissions, runtime code or the FeatureRegistry.', 400);
  const allowed = effectKeys[effect.type];
  if (!allowed) return { type: 'advisory' };
  if (Object.keys(effect).some(key => !allowed.includes(key))) throw durableError('INVALID_EFFECT', 'Unexpected field in a structured Experience effect.', 400);
  const strings = values => Array.isArray(values) && values.length <= 20 && values.every(value => typeof value === 'string' && value.length <= 200);
  if (effect.type === 'draft_format' && (!['markdown', 'plain', 'table', 'json'].includes(effect.format) || effect.fields != null && !strings(effect.fields))) throw durableError('INVALID_EFFECT', 'Invalid draft format effect.', 400);
  if (effect.type === 'archive_destination' && (typeof effect.provider !== 'string' || typeof effect.resourceId !== 'string' || !effect.resourceId)) throw durableError('INVALID_EFFECT', 'Archive hints require an exact destination.', 400);
  if (effect.type === 'notification_behavior' && !['silent', 'digest', 'interactive'].includes(effect.mode)) throw durableError('INVALID_EFFECT', 'Invalid notification guidance.', 400);
  if (effect.type === 'review_requirements' && (typeof effect.required !== 'boolean' || effect.reviewerIds != null && !strings(effect.reviewerIds))) throw durableError('INVALID_EFFECT', 'Invalid review guidance.', 400);
  if (effect.type === 'step_behavior' && (typeof effect.stepKind !== 'string' || !['include', 'omit'].includes(effect.operation))) throw durableError('INVALID_EFFECT', 'Invalid step guidance.', 400);
  return structuredClone(effect);
}
const projection = row => row && ({ ...row, predicate: parse(row.predicate_ast_json), effect: parse(row.effect_signature_json), advisoryOnly: row.status !== 'active' || ['trigger_hint', 'omission_guard'].includes(row.kind) || parse(row.effect_signature_json).type === 'advisory' });

export class ExperienceService {
  constructor(database, { jobs = null, registry = new FeatureRegistry(), policy = {} } = {}) {
    this.database = database; this.db = database.db; this.jobs = jobs; this.registry = registry;
    this.policy = { ...LEARNING_DEFAULTS, ...parse(database.get('learning_policy', '{}')), ...policy };
  }
  create(input, { sources = [] } = {}) {
    if (!kinds.includes(input.kind) || !Object.hasOwn(scopeRank, input.scopeType) || typeof input.scopeKey !== 'string' || !input.scopeKey
      || typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 2000
      || !['stable', 'operational', 'time_sensitive'].includes(input.freshnessClass || 'operational')) throw durableError('INVALID_EXPERIENCE', 'Invalid structured Experience.', 400);
    if (['permissions', 'authorization', 'authority', 'code', 'featureRegistry', 'autoPromote'].some(key => Object.hasOwn(input, key))) throw durableError('UNSAFE_EXPERIENCE', 'An Experience cannot change authority or runtime configuration.', 400);
    const predicate = this.registry.validate(input.predicate || { op: 'always' }), effect = validateExperienceEffect(input.effect || { type: 'advisory' });
    if (effect.type !== 'advisory' && (typeof input.directiveKey !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/.test(input.directiveKey) || forbidden.test(input.directiveKey))) throw durableError('INVALID_DIRECTIVE', 'A structured Experience needs a safe normalized directive key.', 400);
    if (input.freshnessClass === 'time_sensitive' && (!input.validUntil || !Number.isFinite(Date.parse(input.validUntil)))) throw durableError('INVALID_FRESHNESS', 'Time-sensitive guidance requires an explicit validity window.', 400);
    return this.database.atomic(() => {
      if (!sources.length || sources.length > 32 || sources.some(source => !this.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=? AND active=1').get(source.kind, source.id))) throw durableError('MISSING_PROVENANCE', 'Experience sources must exist and remain available.', 400);
      const id = input.id || randomUUID(), at = iso(this.database.now());
      this.db.prepare(`INSERT INTO experiences(id,user_id,kind,status,scope_type,scope_key,action_family,directive_key,predicate_ast_json,effect_signature_json,
        instruction_text,priority,specificity,freshness_class,valid_until,created_at,updated_at) VALUES(?,'local',?,'candidate',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.kind, input.scopeType, input.scopeKey, input.actionFamily || null, effect.type === 'advisory' ? null : input.directiveKey, json(predicate), json(effect), input.instruction.trim(), Math.max(-100, Math.min(100, Number(input.priority) || 0)), scopeRank[input.scopeType], input.freshnessClass || 'operational', input.validUntil || null, at, at);
      for (const source of sources) this.database.lineage(source.kind, source.id, 'experience', id);
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'experience\',?,?)').run(id, at);
      return this.get(id);
    });
  }
  get(id) { return projection(this.db.prepare('SELECT * FROM experiences WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM experiences ORDER BY created_at,id').all().map(projection); }
  refreshStaleness() {
    return this.database.atomic(() => {
      const now = this.database.now(), at = iso(now);
      const changed = this.db.prepare(`UPDATE experiences SET status='needs_revalidation',revision=revision+1,updated_at=? WHERE status='active' AND
        (freshness_class='time_sensitive' AND (valid_until IS NULL OR valid_until<=?) OR
        freshness_class='operational' AND (last_verified_at IS NULL OR last_verified_at<=?))`).run(at, at, iso(now - this.policy.operationalRevalidateMs)).changes;
      const expired = this.db.prepare("UPDATE experiences SET status='needs_revalidation',revision=revision+1,updated_at=? WHERE status='cooldown' AND cooldown_until IS NOT NULL AND cooldown_until<=?").run(at, at).changes;
      if (changed || expired) this.database.bump('context_version'); return changed + expired;
    });
  }
  retrieve({ scopes = [], features = {}, contextVersion = Number(this.database.get('context_version')) } = {}) {
    this.refreshStaleness();
    return this.list().filter(experience => ['active', 'candidate'].includes(experience.status) && scopeMatches(experience.scope_type, experience.scope_key, scopes)
      && (!experience.valid_until || Date.parse(experience.valid_until) > this.database.now())
      && this.registry.evaluate(experience.predicate, features, { now: this.database.now(), contextVersion }).matched).slice(0, 24);
  }
  step({ taskRunId, logicalStepId, planVersion = 1, stepKind, actionFamily = null, expectedEffect = {}, omissionReason = null, status = 'proposed', experiences = [] }) {
    if (!logicalStepId || !stepKind || json(expectedEffect).length > 12000 || experiences.length > 24) throw durableError('INVALID_STEP', 'Invalid bounded plan step.', 400);
    return this.database.atomic(() => {
      const at = iso(this.database.now()), id = randomUUID();
      this.db.prepare('INSERT OR IGNORE INTO plan_steps VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, taskRunId, logicalStepId, planVersion, stepKind, actionFamily, json(expectedEffect), omissionReason, status, at, at);
      const step = this.db.prepare('SELECT * FROM plan_steps WHERE task_run_id=? AND logical_step_id=? AND plan_version=?').get(taskRunId, logicalStepId, planVersion);
      for (const influence of experiences) {
        if (!['planner_declared', 'predicate_matched', 'user_confirmed'].includes(influence.relation)) throw durableError('INVALID_ATTRIBUTION', 'Unknown plan-step attribution.', 400);
        const experience = this.get(influence.id); if (!experience || !['candidate', 'active'].includes(experience.status)) throw durableError('INVALID_ATTRIBUTION', 'The Experience is unavailable for this plan step.', 400);
        this.db.prepare('INSERT OR IGNORE INTO plan_step_experiences VALUES(?,?,?,?)').run(step.id, influence.id, influence.relation, at);
        this.database.lineage('experience', influence.id, 'plan_step', step.id);
      }
      this.database.lineage('task_run', taskRunId, 'plan_step', step.id); return step;
    });
  }
  transitionStep(id, from, to) {
    const permitted = { proposed: ['approved', 'skipped', 'rejected', 'cancelled'], approved: ['executing', 'rejected', 'cancelled'], executing: ['completed', 'cancelled'], skipped: ['rejected'] };
    if (!permitted[from]?.includes(to)) throw durableError('INVALID_STEP_TRANSITION', 'Invalid plan-step transition.', 400);
    const result = this.database.atomic(() => this.db.prepare('UPDATE plan_steps SET status=?,updated_at=? WHERE id=? AND status=?').run(to, iso(this.database.now()), id, from));
    if (!result.changes) throw durableError('PLAN_CHANGED', 'The plan step changed before this update.');
  }
  artifact({ id = randomUUID(), taskId, taskRunId, planStepId, content, version = 1 }) {
    const at = iso(this.database.now()), digest = effectDigest(String(content));
    return this.database.atomic(() => {
      this.db.prepare(`INSERT INTO artifacts(id,task_id,task_run_id,plan_step_id,generated_version,visible_version,status,generated_digest,latest_digest,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'generated',?,?,?,?)`).run(id, taskId, taskRunId, planStepId, version, version, digest, digest, at, at);
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'artifact\',?,?)').run(id, at);
      if (planStepId) this.database.lineage('plan_step', planStepId, 'artifact', id);
      this.database.lineage('task', taskId, 'artifact', id);
      if (taskRunId) this.database.lineage('task_run', taskRunId, 'artifact', id);
      const task = this.db.prepare('SELECT situation_id FROM tasks WHERE id=?').get(taskId);
      const situation = task?.situation_id && this.db.prepare('SELECT version FROM situations WHERE id=?').get(task.situation_id);
      if (situation) this.db.prepare('UPDATE artifacts SET situation_id=?,situation_version=?,stale=0 WHERE id=?').run(task.situation_id, situation.version, id);
      return this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);
    });
  }
  editedArtifact(id, { expectedVersion, content, originalContent, redactedDiffRef = null }) {
    const artifact = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);
    if (!artifact || artifact.visible_version !== expectedVersion || effectDigest(String(originalContent)) !== artifact.latest_digest) throw durableError('ARTIFACT_CHANGED', 'The artifact version or original content has changed.');
    if (redactedDiffRef && this.database.get('retain_redacted_diffs', 'false') !== 'true') throw durableError('RETENTION_DISABLED', 'Raw or redacted diffs are not retained by default.', 400);
    const ratio = normalizedEditRatio(originalContent, content);
    return this.database.atomic(() => {
      const changed = this.db.prepare("UPDATE artifacts SET visible_version=visible_version+1,status='edited',latest_digest=?,edit_ratio=?,redacted_diff_ref=?,updated_at=? WHERE id=? AND visible_version=?")
        .run(effectDigest(String(content)), ratio, redactedDiffRef, iso(this.database.now()), id, expectedVersion);
      if (!changed.changes) throw durableError('ARTIFACT_CHANGED', 'The artifact changed during this edit.');
      if (ratio >= this.policy.highEditRatio) this.feedback({ kind: 'implicit_override', artifactId: id, planStepId: artifact.plan_step_id, taskId: artifact.task_id, editRatio: ratio, effectDimension: 'wording' });
      return this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);
    });
  }
  feedback({ kind, taskId = null, planStepId = null, executionId = null, artifactId = null, editRatio = null, effectDimension = 'workflow', consumption = null }) {
    if (!['explicit_acceptance', 'verified_consumption', 'similar_content_consumption', 'implicit_override', 'explicit_rejection', 'undo', 'silence', 'supervised_success'].includes(kind)) throw durableError('INVALID_FEEDBACK', 'Unknown learning evidence.', 400);
    return this.database.atomic(() => {
      const execution = executionId && this.db.prepare('SELECT * FROM tool_executions WHERE id=?').get(executionId);
      if (executionId && !execution) throw durableError('MISSING_EXECUTION', 'The cited execution does not exist.', 400);
      planStepId ||= execution?.plan_step_id;
      const artifact = artifactId && this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId);
      planStepId ||= artifact?.plan_step_id;
      const step = planStepId && this.db.prepare('SELECT * FROM plan_steps WHERE id=?').get(planStepId);
      const run = step && this.db.prepare('SELECT * FROM task_runs WHERE id=?').get(step.task_run_id);
      if (taskId && run && taskId !== run.task_id) throw durableError('ATTRIBUTION_SCOPE', 'Feedback refers to a different task.', 400);
      taskId ||= run?.task_id || execution?.task_id || artifact?.task_id || null;
      if (kind === 'supervised_success' && (!step || !['approved', 'executing', 'completed'].includes(step.status) || execution?.status !== 'verified' || execution.plan_step_id !== step.id)) throw durableError('UNVERIFIED_SUPERVISION', 'Supervised success needs the exact approved step and verified execution.', 400);
      if (kind === 'verified_consumption' && (!artifact || execution?.status !== 'verified' || !consumption || consumption.version !== artifact.visible_version || consumption.digest !== artifact.latest_digest
        || parse(execution.effect_signature_json)?.artifactId !== artifact.id)) throw durableError('UNVERIFIED_CONSUMPTION', 'Consumption must trace the exact artifact version to a verified downstream execution.', 400);
      if (['explicit_rejection', 'undo'].includes(kind) && !step && !execution) throw durableError('MISSING_FEEDBACK_TARGET', 'Stop-loss needs an exact plan step or execution.', 400);
      const at = iso(this.database.now()), id = randomUUID();
      this.db.prepare('INSERT INTO feedback_events VALUES(?,?,?,?,?,?,?,?,?)').run(id, taskId, planStepId || null, executionId || null, artifactId || null, kind, editRatio, effectDimension, at);
      this.db.prepare('INSERT OR IGNORE INTO source_records(kind,id,created_at) VALUES(\'feedback\',?,?)').run(id, at);
      if (taskId) this.database.lineage('task', taskId, 'feedback', id);
      if (planStepId) this.database.lineage('plan_step', planStepId, 'feedback', id);
      const credible = step ? this.db.prepare(`SELECT e.* FROM experiences e JOIN plan_step_experiences p ON p.experience_id=e.id
        WHERE p.plan_step_id=? AND p.relation_kind IN ('planner_declared','user_confirmed')`).all(step.id) : [];
      if (['explicit_rejection', 'undo'].includes(kind)) {
        this.database.bump('context_version');
        const effect = step ? parse(step.expected_effect_json) : parse(execution.effect_signature_json);
        const family = step?.action_family || execution.action_family || step.step_kind;
        const context = this.contextKey(taskId);
        this.db.prepare('INSERT OR IGNORE INTO action_suppressions VALUES(?,?,?,?,?,?,?)').run(randomUUID(), taskId, context, family, effectDigest(effect), id, at);
        if (step && ['proposed', 'approved', 'skipped'].includes(step.status)) this.db.prepare("UPDATE plan_steps SET status='rejected',updated_at=? WHERE id=?").run(at, step.id);
        for (const experience of credible) this.db.prepare("UPDATE experiences SET status='cooldown',cooldown_until=?,last_negative_at=?,negative_evidence_count=negative_evidence_count+1,updated_at=? WHERE id=? AND revision=?")
          .run(iso(this.database.now() + this.policy.cooldownMs), at, at, experience.id, experience.revision);
      }
      for (const experience of credible) {
        if (kind === 'silence') continue;
        if (kind === 'verified_consumption' && artifact.edit_ratio >= this.policy.highEditRatio && (['wording', 'style'].includes(effectDimension) || parse(experience.effect_signature_json).type === 'draft_format')) continue;
        if (kind === 'implicit_override' && !['draft_format', 'advisory'].includes(parse(experience.effect_signature_json).type)) continue;
        const verified = ['supervised_success', 'verified_consumption'].includes(kind);
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO experience_evidence(id,experience_id,experience_revision,task_id,task_run_id,plan_step_id,execution_id,evidence_kind,effect_dimension,independent_key,verified,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), experience.id, experience.revision, taskId, run?.id || null, step?.id || null, executionId, kind, effectDimension, taskId || id, Number(verified), at).changes;
        if (!inserted) continue;
        this.database.lineage('feedback', id, 'experience', experience.id);
        if (kind === 'supervised_success') this.db.prepare('UPDATE experiences SET verified_success_count=verified_success_count+1,positive_evidence_count=positive_evidence_count+1,last_verified_at=?,updated_at=? WHERE id=?').run(at, at, experience.id);
        else if (['explicit_acceptance', 'verified_consumption', 'similar_content_consumption'].includes(kind)) this.db.prepare('UPDATE experiences SET positive_evidence_count=positive_evidence_count+1,updated_at=? WHERE id=?').run(at, experience.id);
        if (kind === 'implicit_override') {
          const count = this.db.prepare("SELECT COUNT(DISTINCT independent_key) n FROM experience_evidence WHERE experience_id=? AND experience_revision=? AND evidence_kind='implicit_override'").get(experience.id, experience.revision).n;
          if (count >= this.policy.repeatedOverrides) this.db.prepare("UPDATE experiences SET status='needs_revalidation',last_negative_at=?,updated_at=? WHERE id=?").run(at, at, experience.id);
        }
      }
      if (kind !== 'silence' && this.jobs) {
        const job = this.jobs.enqueue({ queue: 'learning', type: 'compile_experience', key: `feedback:${id}`, payload: { sourceKind: 'feedback', sourceId: id, privacyEpoch: Number(this.database.get('privacy_epoch')) }, taskId });
        this.database.lineage('feedback', id, 'job', job.id);
      }
      if (kind === 'supervised_success' && this.policy.autoPromote) for (const experience of credible) {
        const current = this.get(experience.id);
        if (current.status === 'candidate' && current.verified_success_count >= this.policy.mechanicalSuccesses) {
          try { this.promote(current.id, { expectedRevision: current.revision }); } catch (error) { if (error.code !== 'PROMOTION_INELIGIBLE') throw error; }
        }
      }
      return { id, kind, affectedExperiences: credible.map(experience => experience.id), stopLoss: ['explicit_rejection', 'undo'].includes(kind) };
    });
  }
  contextKey(taskId) {
    const task = this.db.prepare('SELECT data_json FROM tasks WHERE id=?').get(taskId);
    const data = task && parse(task.data_json);
    return effectDigest([data?.request?.subjectEntity || taskId, data?.request?.deliverable || 'task', data?.documentId || null]);
  }
  blocked({ taskId, actionFamily, effect }) {
    return Boolean(this.db.prepare('SELECT 1 FROM action_suppressions WHERE context_key=? AND action_family=? AND effect_digest=?').get(this.contextKey(taskId), actionFamily, effectDigest(effect)));
  }
  promote(id, { expectedRevision, userRequested = false } = {}) {
    return this.database.atomic(() => {
      const experience = this.get(id); if (!experience || experience.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      if (!userRequested && !this.policy.autoPromote) throw durableError('PROMOTION_DISABLED', 'Autonomous Experience promotion is disabled.');
      if (experience.status !== 'candidate' || experience.kind !== 'execution_hint' || experience.scope_type === 'global' || !['draft_format'].includes(experience.effect.type)
        || experience.verified_success_count < this.policy.mechanicalSuccesses || experience.negative_evidence_count || experience.last_negative_at
        || experience.valid_until && Date.parse(experience.valid_until) <= this.database.now()) throw durableError('PROMOTION_INELIGIBLE', 'This Experience is not eligible for bounded low-risk promotion.');
      this.db.prepare("UPDATE experiences SET status='active',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(iso(this.database.now()), id, expectedRevision);
      this.database.bump('context_version');
      return this.get(id);
    });
  }
  retire(id, expectedRevision) {
    return this.database.atomic(() => {
      const record = this.get(id); if (!record || record.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      this.db.prepare("UPDATE experiences SET status='retired',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(iso(this.database.now()), id, expectedRevision);
      this.database.bump('context_version'); return this.get(id);
    });
  }
  configurePolicy({ expectedVersion, ...values }) {
    if (expectedVersion !== this.policy.version || Object.keys(values).some(key => !Object.hasOwn(LEARNING_DEFAULTS, key) || key === 'version')) throw durableError('LEARNING_POLICY_CHANGED', 'The learning policy version or fields are invalid.');
    const next = { ...this.policy, ...values, version: this.policy.version + 1 };
    if (typeof next.autoPromote !== 'boolean' || !Number.isInteger(next.mechanicalSuccesses) || next.mechanicalSuccesses < 1 || next.mechanicalSuccesses > 20
      || !Number.isInteger(next.repeatedOverrides) || next.repeatedOverrides < 2 || next.repeatedOverrides > 20 || next.highEditRatio < 0 || next.highEditRatio > 1
      || next.operationalRevalidateMs < 3600000 || next.cooldownMs < 60000) throw durableError('INVALID_LEARNING_POLICY', 'Invalid bounded learning thresholds.', 400);
    this.database.atomic(() => { const saved = parse(this.database.get('learning_policy', '{}')); if (saved.version != null && saved.version !== expectedVersion) throw durableError('LEARNING_POLICY_CHANGED', 'The learning policy changed.'); this.database.set('learning_policy', json(next)); }); this.policy = next; return next;
  }
  async compile(job, generate, { assertOwned = () => {} } = {}) {
    assertOwned(); const epoch = Number(this.database.get('privacy_epoch'));
    const source = this.db.prepare('SELECT * FROM source_records WHERE kind=? AND id=? AND active=1').get(job.payload.sourceKind, job.payload.sourceId);
    if (!source || epoch !== job.payload.privacyEpoch) throw durableError('PRIVACY_CHANGED', 'The compiler source is no longer available.');
    const feedback = this.db.prepare('SELECT kind,effect_dimension,edit_ratio,plan_step_id,task_id FROM feedback_events WHERE id=?').get(source.id);
    const step = feedback?.plan_step_id && this.db.prepare('SELECT step_kind,action_family,expected_effect_json,omission_reason,status FROM plan_steps WHERE id=?').get(feedback.plan_step_id);
    const task = feedback?.task_id && parse(this.db.prepare('SELECT data_json FROM tasks WHERE id=?').get(feedback.task_id)?.data_json);
    const scope = task?.request?.subjectEntity ? { type: 'project', key: task.request.subjectEntity } : { type: 'task_family', key: task?.request?.deliverable || task?.kind || 'work_request' };
    const preparation = feedback?.task_id && this.db.prepare("SELECT s.expected_effect_json FROM plan_steps s JOIN task_runs r ON r.id=s.task_run_id WHERE r.task_id=? AND s.step_kind='draft_preparation' ORDER BY s.created_at DESC LIMIT 1").get(feedback.task_id);
    const observedDraftFormat = preparation && parse(preparation.expected_effect_json)?.type === 'draft_format' ? parse(preparation.expected_effect_json) : null;
    // Structured summaries only. No raw source documents, prompts or diffs.
    const candidates = await generate({ feedback, step, scope, observedDraftFormat, schemaVersion: 1 });
    if (!Array.isArray(candidates) || candidates.length > 4) throw durableError('INVALID_COMPILATION', 'The compiler must return at most four structured candidates.', 400);
    return this.database.write(() => {
      assertOwned();
      if (Number(this.database.get('privacy_epoch')) !== epoch || !this.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=? AND active=1').get(source.kind, source.id)) throw durableError('PRIVACY_CHANGED', 'Privacy changed before the compiler could commit.');
      return candidates.map(candidate => {
        if (candidate.scopeType !== scope.type || candidate.scopeKey !== scope.key) throw durableError('COMPILER_SCOPE', 'Compilation cannot generalize beyond its source scope.', 400);
        if (candidate.effect?.type === 'draft_format' && (!observedDraftFormat || candidate.effect.format !== observedDraftFormat.format)) throw durableError('UNSUPPORTED_LEARNING', 'The proposed format was not observed in the source trace.', 400);
        return this.create(candidate, { sources: [{ kind: source.kind, id: source.id }] });
      });
    });
  }
}

/** Authority is assigned by the caller's trusted record category, never by a
 * model field. Incompatible equal-priority effects fail closed; recency is not
 * a tie-breaker and free text remains advisory. */
export function arbitrateExperiences({ safety = [], currentUser = [], policies = [], workflows = [], experiences = [], defaults = [] }) {
  const records = [
    ...safety.map(record => ({ ...record, authority: 1 })), ...currentUser.map(record => ({ ...record, authority: 2 })),
    ...policies.map(record => ({ ...record, authority: 3 })), ...workflows.map(record => ({ ...record, authority: 4 })),
    ...experiences.filter(record => ['active', 'candidate'].includes(record.status)).map(record => ({ ...record, directiveKey: record.directiveKey || record.directive_key, effect: record.effect || parse(record.effect_signature_json), authority: record.status === 'active' ? 5 : 6 })),
    ...defaults.map(record => ({ ...record, authority: 7 }))
  ];
  const groups = new Map(), advisory = [];
  for (const record of records) {
    if (!record.directiveKey || !record.effect || record.effect.type === 'advisory') { advisory.push(record); continue; }
    const group = groups.get(record.directiveKey) || []; group.push(record); groups.set(record.directiveKey, group);
  }
  const decisions = [], conflicts = [];
  for (const [directiveKey, group] of groups) {
    group.sort((a, b) => a.authority - b.authority || (b.priority || 0) - (a.priority || 0) || (b.specificity || 0) - (a.specificity || 0));
    const first = group[0], peers = group.filter(record => record.authority === first.authority && (record.priority || 0) === (first.priority || 0));
    if (new Set(peers.map(record => canonical(record.effect))).size > 1) conflicts.push({ directiveKey, ids: peers.map(record => record.id), requiresClarification: true });
    else decisions.push({ directiveKey, record: first, advisoryOnly: first.authority >= 6 || first.advisoryOnly === true, effect: first.effect });
  }
  return { decisions, conflicts, advisory, hasUnresolvedConflict: conflicts.length > 0, authorizationRequired: true };
}

export function normalizedEditRatio(before, after) {
  const tokenize = text => (String(text).normalize('NFKC').match(/[\p{Script=Han}]|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || []).slice(0, 2048);
  const left = tokenize(before), right = tokenize(after);
  if (!left.length && !right.length) return 0;
  let previous = Uint16Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = new Uint16Array(right.length + 1); current[0] = i;
    for (let j = 1; j <= right.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(left[i - 1] !== right[j - 1]));
    previous = current;
  }
  return previous[right.length] / Math.max(left.length, right.length);
}
