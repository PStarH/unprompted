import { createHash, randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';
import { FeatureRegistry, scopeMatches } from './context.js';
import { eligibleMemoryIds } from './memory.js';
import {
  TRIAL_ADOPTABLE_EFFECTS, TRIAL_EMPTY_CASE_SET_DIGEST, TRIAL_FIXTURE_DIGEST, TRIAL_FIXTURE_VERSION, TRIAL_POLICY_DIGEST
} from './experience-trial-fixtures.js';

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
export function experienceContentDigest(experience) {
  return effectDigest({
    kind: experience.kind,
    actionFamily: experience.action_family ?? null,
    directiveKey: experience.directive_key ?? null,
    instruction: experience.instruction_text,
    predicate: experience.predicate ?? parse(experience.predicate_ast_json),
    effect: experience.effect ?? parse(experience.effect_signature_json),
    scopeType: experience.scope_type,
    scopeKey: experience.scope_key,
    freshnessClass: experience.freshness_class,
    validUntil: experience.valid_until ?? null
  });
}
const CONTENT_VERSION_COLUMNS = 'experience_id,revision,kind,action_family,directive_key,content_digest,instruction_text,predicate_ast_json,effect_signature_json,scope_type,scope_key,freshness_class,valid_until,change_kind,parent_revision,restored_from_revision,created_at';
const CONTENT_VERSION_DDL = `CREATE TABLE IF NOT EXISTS experience_content_versions (
        experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action_family TEXT,
        directive_key TEXT,
        content_digest TEXT NOT NULL,
        instruction_text TEXT NOT NULL,
        predicate_ast_json TEXT NOT NULL,
        effect_signature_json TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        freshness_class TEXT NOT NULL,
        valid_until TEXT,
        change_kind TEXT NOT NULL CHECK(change_kind IN ('create','revalidate','adopt','promote','rollback','baseline')),
        parent_revision INTEGER,
        restored_from_revision INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY(experience_id, revision)
      )`;
const CONTENT_VERSION_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS trg_experience_content_versions_immutable
        BEFORE UPDATE ON experience_content_versions
        BEGIN SELECT RAISE(ABORT, 'experience content versions are immutable'); END`;
/** Immutable content snapshots and isolated trials live in the same SQLite
 * database as the Experience they belong to. Creation is idempotent and runs
 * in a short transaction, matching the existing TokenBudgetService pattern
 * while the formal schema summary remains part of the later C8 release step. */
export function ensureExperienceTrialSchema(database) {
  if (!database?.db) throw new TypeError('Experience trial storage requires a DurableDatabase.');
  const initialize = () => {
    // An uncommitted earlier revision of this local branch created the content
    // table without the `promote` change kind. Rebuild only that narrow case;
    // the table is unreleased and no other table references it.
    const existingContent = database.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='experience_content_versions'").get();
    if (existingContent && !/'promote'/.test(existingContent.sql)) {
      database.db.exec(`DROP TRIGGER IF EXISTS trg_experience_content_versions_immutable;
        ALTER TABLE experience_content_versions RENAME TO experience_content_versions_previous;
        ${CONTENT_VERSION_DDL};
        INSERT INTO experience_content_versions(${CONTENT_VERSION_COLUMNS}) SELECT ${CONTENT_VERSION_COLUMNS} FROM experience_content_versions_previous;
        DROP TABLE experience_content_versions_previous;
        ${CONTENT_VERSION_TRIGGER_DDL}`);
    }
    database.db.exec(`${CONTENT_VERSION_DDL};
      ${CONTENT_VERSION_TRIGGER_DDL};
      CREATE TABLE IF NOT EXISTS experience_trial_case_sets (
        experience_id TEXT PRIMARY KEY REFERENCES experiences(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version >= 1),
        digest TEXT NOT NULL,
        cases_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experience_trials (
        id TEXT PRIMARY KEY,
        experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        content_digest TEXT NOT NULL,
        fixture_version TEXT NOT NULL,
        fixture_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('passed','failed','unknown','expired')),
        passed_cases INTEGER NOT NULL DEFAULT 0 CHECK(passed_cases >= 0),
        failed_cases INTEGER NOT NULL DEFAULT 0 CHECK(failed_cases >= 0),
        unknown_cases INTEGER NOT NULL DEFAULT 0 CHECK(unknown_cases >= 0),
        total_cases INTEGER NOT NULL DEFAULT 0 CHECK(total_cases >= 0),
        differences_json TEXT NOT NULL,
        tested_revision INTEGER NOT NULL,
        adopted_revision INTEGER,
        attestation_of TEXT,
        evaluated_context_version INTEGER,
        case_set_version INTEGER NOT NULL DEFAULT 0,
        case_set_digest TEXT NOT NULL DEFAULT '',
        categories_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      )`);
    // Additive columns for a database created by the earlier local revision.
    const trialColumns = new Set(database.db.prepare('PRAGMA table_info(experience_trials)').all().map(column => column.name));
    if (!trialColumns.has('case_set_version')) database.db.exec('ALTER TABLE experience_trials ADD COLUMN case_set_version INTEGER NOT NULL DEFAULT 0');
    if (!trialColumns.has('case_set_digest')) database.db.exec("ALTER TABLE experience_trials ADD COLUMN case_set_digest TEXT NOT NULL DEFAULT ''");
    if (!trialColumns.has('categories_json')) database.db.exec("ALTER TABLE experience_trials ADD COLUMN categories_json TEXT NOT NULL DEFAULT '{}'");
    database.db.exec(`CREATE INDEX IF NOT EXISTS ix_experience_trials_current ON experience_trials(experience_id,revision,state,expires_at);
      CREATE INDEX IF NOT EXISTS ix_experience_trials_created ON experience_trials(experience_id,created_at);`);
    // Existing installations already have Experience rows. Record one
    // immutable baseline of their current content so the evaluator has a
    // verifiable starting version; no earlier content is invented. Records
    // disabled by a revoked or forgotten source stay unversioned until the user
    // explicitly revalidates them from current content.
    const at = iso(database.now());
    const unavailable = new Set(database.db.prepare(`SELECT DISTINCT l.derived_id id FROM lineage l
      WHERE l.derived_kind='experience' AND NOT EXISTS (
        SELECT 1 FROM source_records s WHERE s.kind=l.source_kind AND s.id=l.source_id AND s.active=1
      )`).all().map(row => row.id));
    for (const row of database.db.prepare(`SELECT e.* FROM experiences e WHERE NOT EXISTS (
      SELECT 1 FROM experience_content_versions v WHERE v.experience_id=e.id)`).all()) {
      if (unavailable.has(row.id) || ['needs_revalidation', 'cooldown', 'retired'].includes(row.status)) continue;
      database.db.prepare(`INSERT OR IGNORE INTO experience_content_versions(${CONTENT_VERSION_COLUMNS})
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'baseline',NULL,NULL,?)`).run(row.id, row.revision, row.kind, row.action_family, row.directive_key,
        experienceContentDigest(row), row.instruction_text, row.predicate_ast_json, row.effect_signature_json, row.scope_type, row.scope_key,
        row.freshness_class, row.valid_until, at);
    }
  };
  if (database.db.inTransaction) initialize(); else database.atomic(initialize);
}
const projection = row => row && ({ ...row, predicate: parse(row.predicate_ast_json), effect: parse(row.effect_signature_json),
  contentDigest: experienceContentDigest(row),
  advisoryOnly: row.status !== 'active' || ['trigger_hint', 'omission_guard'].includes(row.kind) || parse(row.effect_signature_json).type === 'advisory' });

export class ExperienceService {
  constructor(database, { jobs = null, registry = new FeatureRegistry(), policy = {}, authorizationCheck = null } = {}) {
    if (!database?.db) throw new TypeError('ExperienceService requires a DurableDatabase.');
    ensureExperienceTrialSchema(database);
    this.database = database; this.db = database.db; this.jobs = jobs; this.registry = registry;
    this.policy = { ...LEARNING_DEFAULTS, ...parse(database.get('learning_policy', '{}')), ...policy };
    this.authorizationCheck = typeof authorizationCheck === 'function' ? authorizationCheck : null;
  }
  /** The runtime binds a read-only, provider-free grant check. It can only
   * observe current user authorizations; it can never create or widen one. */
  bindAuthorizationCheck(check) {
    if (check != null && typeof check !== 'function') throw new TypeError('An Experience authorization check must be a function.');
    this.authorizationCheck = check || null;
    return this;
  }
  authorizationFor(experience) {
    if (experience?.effect?.type !== 'archive_destination') return { required: false, status: 'not_required', reason: 'no_external_target' };
    if (!this.authorizationCheck) return { required: true, status: 'unknown', reason: 'authorization_check_unavailable' };
    try {
      const result = this.authorizationCheck(experience);
      if (!result || !['authorized', 'denied', 'unknown'].includes(result.status)) return { required: true, status: 'unknown', reason: 'authorization_check_invalid' };
      return { required: true, status: result.status, reason: String(result.reason || '').slice(0, 120) || 'authorization_check' };
    } catch { return { required: true, status: 'unknown', reason: 'authorization_check_failed' }; }
  }
  authorizationValid(experience) {
    const result = this.authorizationFor(experience);
    return !result.required || result.status === 'authorized';
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
      const created = this.get(id);
      this.#snapshotContent(created, 'create');
      return created;
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
      // A candidate that was never adopted and has not been touched within the
      // operational window must stop influencing planning on its own. Stable
      // guidance (for example a formatting preference) has no such clock.
      const retired = this.db.prepare(`UPDATE experiences SET status='retired',revision=revision+1,updated_at=? WHERE status='candidate'
        AND freshness_class='operational' AND verified_success_count=0 AND updated_at<=?`).run(at, iso(now - this.policy.operationalRevalidateMs)).changes;
      // A time-bounded trial pass stops admitting its revision as soon as it
      // expires. Bumping the context version makes waiting tasks reload instead
      // of reusing a manifest built while the pass was still current.
      const expiredTrials = this.db.prepare("UPDATE experience_trials SET state='expired' WHERE state='passed' AND expires_at IS NOT NULL AND expires_at<=?").run(at).changes;
      // A fixture or policy change invalidates every earlier pass even though
      // the Experience content itself has not changed.
      const supersededTrials = this.db.prepare(`UPDATE experience_trials SET state='expired' WHERE state='passed'
        AND (fixture_version<>? OR fixture_digest<>? OR policy_digest<>?)`).run(TRIAL_FIXTURE_VERSION, TRIAL_FIXTURE_DIGEST, TRIAL_POLICY_DIGEST).changes;
      // A saved case-set version/digest change invalidates every prior pass,
      // including an attestation carried to a later revision.
      const supersededCases = this.db.prepare(`UPDATE experience_trials SET state='expired' WHERE state='passed' AND (
        case_set_version=0 AND case_set_digest<>?
        OR case_set_version>0 AND NOT EXISTS (SELECT 1 FROM experience_trial_case_sets c
          WHERE c.experience_id=experience_trials.experience_id AND c.version=experience_trials.case_set_version AND c.digest=experience_trials.case_set_digest)
      )`).run(TRIAL_EMPTY_CASE_SET_DIGEST).changes;
      if (changed || expired || retired || expiredTrials || supersededTrials || supersededCases) this.database.bump('context_version');
      return changed + expired + retired + expiredTrials + supersededTrials + supersededCases;
    });
  }
  /** A trial pass is valid only for the exact current revision, content,
   * fixture, policy, case set and available provenance. Any content or status
   * revision therefore fails closed until the user evaluates again or adopts
   * with an explicit attestation. Archive guidance additionally needs a
   * current, read-only user grant check; a pass never becomes a grant. */
  currentTrialPass(experience, { now = this.database.now() } = {}) {
    if (!experience || !['active', 'candidate'].includes(experience.status)) return null;
    if (experience.negative_evidence_count || experience.last_negative_at) return null;
    if (experience.valid_until && !(Date.parse(experience.valid_until) > now)) return null;
    if (this.sourceUnavailable(experience.id) || this.sourceRevoked(experience.id)) return null;
    if (!this.authorizationValid(experience)) return null;
    const latest = this.latestContentVersion(experience.id);
    if (!latest || latest.revision !== experience.revision) return null;
    const digest = experienceContentDigest(experience);
    if (latest.content_digest !== digest) return null;
    return this.#validTrialRow(experience, digest, now) || null;
  }
  validTrialPass(experience, options) { return Boolean(this.currentTrialPass(experience, options)); }
  caseSetState(id) {
    const row = this.db.prepare('SELECT version,digest FROM experience_trial_case_sets WHERE experience_id=?').get(id);
    return row ? { version: row.version, digest: row.digest } : { version: 0, digest: TRIAL_EMPTY_CASE_SET_DIGEST };
  }
  #validTrialRow(experience, digest, now) {
    const caseSet = this.caseSetState(experience.id);
    const rows = this.db.prepare(`SELECT * FROM experience_trials WHERE experience_id=? AND revision=? AND content_digest=?
      AND fixture_version=? AND fixture_digest=? AND policy_digest=? AND case_set_version=? AND case_set_digest=? AND state='passed'
      AND passed_cases=total_cases AND failed_cases=0 AND unknown_cases=0 AND total_cases>0
      AND expires_at IS NOT NULL AND expires_at>?
      AND (tested_revision=? OR (adopted_revision=? AND attestation_of IS NOT NULL AND tested_revision<?
        AND EXISTS (SELECT 1 FROM experience_content_versions v WHERE v.experience_id=experience_trials.experience_id
          AND v.revision=experience_trials.revision AND v.parent_revision=experience_trials.tested_revision
          AND v.content_digest=experience_trials.content_digest)))
      ORDER BY created_at DESC,rowid DESC LIMIT 8`).all(experience.id, experience.revision, digest, TRIAL_FIXTURE_VERSION,
      TRIAL_FIXTURE_DIGEST, TRIAL_POLICY_DIGEST, caseSet.version, caseSet.digest, iso(now), experience.revision, experience.revision, experience.revision);
    // A stored pass only counts when the row itself records a passing positive
    // candidate assertion. This makes the stronger policy structural, not only
    // a digest that an older pass might have bypassed.
    return rows.find(row => Number(parse(row.categories_json)?.behavior?.positive) >= 1) || null;
  }
  #snapshotContent(experience, changeKind, { parentRevision = null, restoredFromRevision = null } = {}) {
    if (!experience) throw durableError('EXPERIENCE_NOT_FOUND', 'This Experience no longer exists.', 404);
    this.db.prepare(`INSERT INTO experience_content_versions(experience_id,revision,kind,action_family,directive_key,content_digest,
      instruction_text,predicate_ast_json,effect_signature_json,scope_type,scope_key,freshness_class,valid_until,change_kind,parent_revision,restored_from_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(experience.id, experience.revision, experience.kind, experience.action_family ?? null,
      experience.directive_key ?? null, experienceContentDigest(experience), experience.instruction_text, json(experience.predicate), json(experience.effect),
      experience.scope_type, experience.scope_key, experience.freshness_class, experience.valid_until ?? null, changeKind, parentRevision, restoredFromRevision,
      iso(this.database.now()));
  }
  latestContentVersion(id) { return this.db.prepare('SELECT * FROM experience_content_versions WHERE experience_id=? ORDER BY revision DESC LIMIT 1').get(id); }
  contentVersions(id, { limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 100));
    return this.db.prepare('SELECT * FROM experience_content_versions WHERE experience_id=? ORDER BY revision DESC LIMIT ?').all(id, bounded).map(row => ({
      revision: row.revision, contentDigest: row.content_digest, changeKind: row.change_kind, createdAt: row.created_at, kind: row.kind,
      effectType: parse(row.effect_signature_json)?.type || 'advisory', scopeType: row.scope_type, scopeKey: row.scope_key,
      freshnessClass: row.freshness_class, validUntil: row.valid_until, parentRevision: row.parent_revision, restoredFromRevision: row.restored_from_revision
    }));
  }
  /** Resolve real provenance through feedback, plan steps, runs, tasks,
   * events and memories. The walk is bounded; exceeding the bound fails
   * closed rather than pretending the source is still authorized. */
  #provenance(id) {
    const connectors = new Set(), seen = new Set(), path = new Set();
    let unavailable = false, overflow = false;
    const visit = (kind, sourceId, depth) => {
      if (overflow) return;
      if (depth > 4 || seen.size >= 200) { overflow = true; return; }
      const key = `${kind}\0${sourceId}`;
      // A cycle is a stored-data fault: fail closed instead of treating the
      // repeated parent edge as an already-validated root.
      if (path.has(key)) { unavailable = true; return; }
      if (seen.has(key)) return;
      seen.add(key); path.add(key);
      if (['event', 'task', 'memory', 'task_memory', 'feedback', 'artifact', 'policy', 'experience'].includes(kind)) {
        const record = this.db.prepare('SELECT active FROM source_records WHERE kind=? AND id=?').get(kind, sourceId);
        if (!record || record.active === 0) unavailable = true;
      }
      if (kind === 'event') {
        const row = this.db.prepare('SELECT provider,event_json FROM durable_inbox WHERE id=?').get(sourceId);
        if (row) { const event = parse(row.event_json), connector = row.provider || event?.connectorId || event?.source; if (connector) connectors.add(connector); }
      } else if (kind === 'task') {
        const row = this.db.prepare('SELECT data_json FROM tasks WHERE id=?').get(sourceId), data = row && parse(row.data_json);
        const connector = data?.sourceConnectorId || data?.connectorId || data?.request?.source?.connectorId;
        if (connector) connectors.add(connector);
      } else if (kind === 'task_run') {
        const row = this.db.prepare('SELECT task_id FROM task_runs WHERE id=?').get(sourceId);
        if (row?.task_id) visit('task', row.task_id, depth + 1);
        else unavailable = true;
      } else if (kind === 'plan_step') {
        const row = this.db.prepare('SELECT r.task_id FROM task_runs r JOIN plan_steps s ON s.task_run_id=r.id WHERE s.id=?').get(sourceId);
        if (row?.task_id) visit('task', row.task_id, depth + 1);
        else unavailable = true;
      } else if (kind === 'memory' || kind === 'task_memory') {
        const row = this.db.prepare('SELECT source_kind,source_id FROM user_memories WHERE id=?').get(sourceId);
        if (!row || !eligibleMemoryIds(this.database, [sourceId]).has(sourceId)) unavailable = true;
        if (row && kind === 'task_memory' && row.source_kind === 'task_memory' && row.source_id === sourceId) {
          // The native store projects a task-memory source into user_memories
          // under the same id. Its parents live in lineage; the projection's
          // self-reference is an alias, not a recursive provenance edge.
          for (const edge of this.db.prepare("SELECT source_kind,source_id FROM lineage WHERE derived_kind='task_memory' AND derived_id=? LIMIT 201").all(sourceId)) {
            visit(edge.source_kind, edge.source_id, depth + 1);
          }
        } else if (row) visit(row.source_kind, row.source_id, depth + 1);
      } else if (kind === 'feedback') {
        const row = this.db.prepare('SELECT task_id,plan_step_id FROM feedback_events WHERE id=?').get(sourceId);
        if (row?.task_id) visit('task', row.task_id, depth + 1);
        if (row?.plan_step_id) visit('plan_step', row.plan_step_id, depth + 1);
        if (!row) unavailable = true;
      } else if (kind === 'experience') {
        // A stored parent-experience edge contributes the parent's real
        // provenance. The parent's status/pass is not authority here; only its
        // actual sources are traversed, still under the same bounded visit.
        const parent = this.db.prepare('SELECT 1 FROM experiences WHERE id=?').get(sourceId);
        if (!parent) unavailable = true;
        else for (const edge of this.db.prepare("SELECT source_kind,source_id FROM lineage WHERE derived_kind='experience' AND derived_id=? LIMIT 201").all(sourceId)) {
          visit(edge.source_kind, edge.source_id, depth + 1);
        }
      }
      path.delete(key);
    };
    for (const row of this.db.prepare("SELECT source_kind,source_id FROM lineage WHERE derived_kind='experience' AND derived_id=? LIMIT 201").all(id)) visit(row.source_kind, row.source_id, 0);
    return { connectors: [...connectors], unavailable, overflow };
  }
  /** Provenance remains authoritative even when a connector was revoked
   * without purging local content. Only opaque connector identifiers are read. */
  provenanceConnectors(id) { return this.#provenance(id).connectors; }
  sourceRevoked(id, revoked = null) {
    const state = this.#provenance(id);
    if (state.overflow) return true;
    const set = revoked || new Set(parse(this.database.get('revoked_connectors', '[]')) || []);
    return set.size > 0 && state.connectors.some(connector => set.has(connector));
  }
  sourceUnavailable(id) {
    const state = this.#provenance(id);
    return state.overflow || state.unavailable;
  }
  retrieve({ scopes = [], features = {}, contextVersion = null, purpose = 'inspect', allowedExperienceId = null } = {}) {
    if (!['inspect', 'automatic', 'supervised_trial'].includes(purpose)) throw durableError('INVALID_RETRIEVAL_PURPOSE', 'Unknown Experience retrieval purpose.', 400);
    if (purpose === 'supervised_trial' && (typeof allowedExperienceId !== 'string' || !allowedExperienceId)) throw durableError('INVALID_RETRIEVAL_PURPOSE', 'A supervised preview needs one explicit Experience.', 400);
    this.refreshStaleness();
    // Resolve after staleness refresh: an expired trial or stale Experience may
    // bump the context version inside this call, and predicates must not be
    // evaluated against the previous generation.
    contextVersion ??= Number(this.database.get('context_version'));
    // A source can be forgotten or its permission revoked after the
    // Experience was compiled. Resolve the real provenance chain so indirect
    // feedback, plan-step and memory derivations fail closed too.
    const revoked = new Set(parse(this.database.get('revoked_connectors', '[]')) || []);
    const eligible = this.list().filter(experience => ['active', 'candidate'].includes(experience.status)
      && !this.sourceUnavailable(experience.id) && !this.sourceRevoked(experience.id, revoked)
      && scopeMatches(experience.scope_type, experience.scope_key, scopes)
      && (!experience.valid_until || Date.parse(experience.valid_until) > this.database.now())
      && this.registry.evaluate(experience.predicate, features, { now: this.database.now(), contextVersion }).matched);
    if (purpose === 'supervised_trial') return eligible.filter(experience => experience.id === allowedExperienceId).slice(0, 1);
    if (purpose === 'automatic') return eligible.filter(experience => experience.status === 'active' && this.validTrialPass(experience)).slice(0, 24);
    return eligible.slice(0, 24);
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
        this.db.prepare('INSERT OR IGNORE INTO plan_step_experiences(plan_step_id,experience_id,relation_kind,experience_revision,created_at) VALUES(?,?,?,?,?)').run(step.id, influence.id, influence.relation, experience.revision, at);
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
      const credible = step ? this.db.prepare(`SELECT e.*, p.experience_revision AS attributed_revision FROM experiences e JOIN plan_step_experiences p ON p.experience_id=e.id
        WHERE p.plan_step_id=? AND p.relation_kind IN ('planner_declared','user_confirmed')`).all(step.id) : [];
      if (['explicit_rejection', 'undo'].includes(kind)) {
        this.database.bump('context_version');
        const effect = step ? parse(step.expected_effect_json) : parse(execution.effect_signature_json);
        const family = step?.action_family || execution?.action_family || step?.step_kind;
        const context = this.contextKey(taskId);
        this.db.prepare('INSERT OR IGNORE INTO action_suppressions VALUES(?,?,?,?,?,?,?)').run(randomUUID(), taskId, context, family, effectDigest(effect), id, at);
        if (step && ['proposed', 'approved', 'skipped'].includes(step.status)) this.db.prepare("UPDATE plan_steps SET status='rejected',updated_at=? WHERE id=?").run(at, step.id);
        for (const experience of credible) this.db.prepare("UPDATE experiences SET status='cooldown',cooldown_until=?,last_negative_at=?,negative_evidence_count=negative_evidence_count+1,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
          .run(iso(this.database.now() + this.policy.cooldownMs), at, at, experience.id, experience.revision);
      }
      for (const experience of credible) {
        if (kind === 'silence') continue;
        if (kind === 'verified_consumption' && artifact.edit_ratio >= this.policy.highEditRatio && (['wording', 'style'].includes(effectDimension) || parse(experience.effect_signature_json).type === 'draft_format')) continue;
        if (kind === 'implicit_override' && !['draft_format', 'advisory'].includes(parse(experience.effect_signature_json).type)) continue;
        const verified = ['supervised_success', 'verified_consumption'].includes(kind);
        const attributedRevision = experience.attributed_revision ?? experience.revision;
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO experience_evidence(id,experience_id,experience_revision,task_id,task_run_id,plan_step_id,execution_id,evidence_kind,effect_dimension,independent_key,verified,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), experience.id, attributedRevision, taskId, run?.id || null, step?.id || null, executionId, kind, effectDimension, taskId || id, Number(verified), at).changes;
        if (!inserted) continue;
        this.database.lineage('feedback', id, 'experience', experience.id);
        // Positive evidence is promotion evidence only for the revision that
        // actually influenced the step. Late feedback for an earlier revision
        // stays in the evidence history, but it cannot refill the counts the
        // user cleared by revalidating, nor refresh last_verified_at.
        if (kind === 'supervised_success') this.db.prepare('UPDATE experiences SET verified_success_count=verified_success_count+1,positive_evidence_count=positive_evidence_count+1,last_verified_at=?,updated_at=? WHERE id=? AND revision=?').run(at, at, experience.id, attributedRevision);
        else if (['explicit_acceptance', 'verified_consumption', 'similar_content_consumption'].includes(kind)) this.db.prepare('UPDATE experiences SET positive_evidence_count=positive_evidence_count+1,updated_at=? WHERE id=? AND revision=?').run(at, experience.id, attributedRevision);
        if (kind === 'implicit_override') {
          const count = this.db.prepare("SELECT COUNT(DISTINCT independent_key) n FROM experience_evidence WHERE experience_id=? AND experience_revision=? AND evidence_kind='implicit_override'").get(experience.id, experience.revision).n;
          if (count >= this.policy.repeatedOverrides) this.db.prepare("UPDATE experiences SET status='needs_revalidation',last_negative_at=?,updated_at=? WHERE id=?").run(at, at, experience.id);
        }
      }
      if (kind !== 'silence' && this.jobs) {
        const payload = { sourceKind: 'feedback', sourceId: id, privacyEpoch: Number(this.database.get('privacy_epoch')) };
        // Bind the source summary at feedback time without putting the private
        // model input in a public job payload.
        payload.compilationInputDigest = effectDigest(this.compilationInput({ payload }).summary);
        const job = this.jobs.enqueue({ queue: 'learning', type: 'compile_experience', key: `feedback:${id}`, payload, taskId });
        this.database.lineage('feedback', id, 'job', job.id);
      }
      if (kind === 'supervised_success' && this.policy.autoPromote) for (const experience of credible) {
        // A late success attributed to an older revision must not trigger a
        // promotion decision about the current, separately revalidated revision.
        if ((experience.attributed_revision ?? experience.revision) !== experience.revision) continue;
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
  #attestTrial(experience, trial, digest, revision, at) {
    const attestationId = randomUUID();
    this.db.prepare(`INSERT INTO experience_trials(id,experience_id,revision,content_digest,fixture_version,fixture_digest,policy_digest,scope_type,scope_key,
      state,passed_cases,failed_cases,unknown_cases,total_cases,differences_json,tested_revision,adopted_revision,attestation_of,evaluated_context_version,
      case_set_version,case_set_digest,categories_json,started_at,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'passed',?,0,0,?,?,?,?,?,?,?,?,?,?,?,?)`).run(attestationId, experience.id, revision, digest, trial.fixture_version,
      trial.fixture_digest, trial.policy_digest, trial.scope_type, trial.scope_key, trial.passed_cases, trial.total_cases, trial.differences_json,
      trial.revision, revision, trial.id, trial.evaluated_context_version ?? 0, trial.case_set_version, trial.case_set_digest,
      trial.categories_json ?? '{}', trial.started_at, trial.expires_at, at);
    this.database.lineage('experience', experience.id, 'experience_trial', attestationId);
    return attestationId;
  }
  promote(id, { expectedRevision, userRequested = false } = {}) {
    return this.database.atomic(() => {
      const experience = this.get(id); if (!experience || experience.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      if (!userRequested && !this.policy.autoPromote) throw durableError('PROMOTION_DISABLED', 'Autonomous Experience promotion is disabled.');
      if (experience.status !== 'candidate' || experience.kind !== 'execution_hint' || experience.scope_type === 'global' || !['draft_format'].includes(experience.effect.type)
        || experience.verified_success_count < this.policy.mechanicalSuccesses || experience.negative_evidence_count || experience.last_negative_at
        || experience.valid_until && Date.parse(experience.valid_until) <= this.database.now()) throw durableError('PROMOTION_INELIGIBLE', 'This Experience is not eligible for bounded low-risk promotion.');
      const now = this.database.now(), digest = experienceContentDigest(experience), latest = this.latestContentVersion(id);
      // A pass may travel only across a status-only revision with unchanged
      // content, an intact parent chain and the same fixture/policy/case set.
      // Reuse currentTrialPass so promote also re-checks the current provenance
      // and authorization validity; an unknown/overflow boundary is not copied
      // into a new attestation.
      const trial = this.currentTrialPass(experience, { now });
      const nextRevision = experience.revision + 1, at = iso(now);
      const changed = this.db.prepare("UPDATE experiences SET status='active',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='candidate'")
        .run(at, id, expectedRevision);
      if (!changed.changes) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision changed during promotion.');
      const promoted = this.get(id);
      // The promoted revision is versioned in this same transaction. It never
      // relies on a later constructor backfill, so an active revision is
      // always evaluable and never inherits an old revision's evidence.
      this.#snapshotContent(promoted, 'promote', { parentRevision: latest?.revision ?? null });
      if (trial) this.#attestTrial(promoted, trial, digest, nextRevision, at);
      this.database.bump('context_version');
      return this.get(id);
    });
  }
  revalidate(id, { expectedRevision, userRequested = false } = {}) {
    // Explicit confirmation only: autonomous callers must not move stale or
    // negatively evidenced guidance back into use.
    if (userRequested !== true) throw durableError('REVALIDATION_CONFIRMATION_REQUIRED', 'Only an explicit user confirmation can revalidate an Experience.', 403);
    return this.database.atomic(() => {
      const experience = this.get(id); if (!experience || experience.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      // `retired` stays terminal: it is not needs_revalidation, so it cannot pass.
      if (experience.status !== 'needs_revalidation') throw durableError('REVALIDATION_INELIGIBLE', 'Only an Experience awaiting revalidation can return to candidate.');
      if (experience.freshness_class === 'time_sensitive' && (!experience.valid_until || Date.parse(experience.valid_until) <= this.database.now())) throw durableError('REVALIDATION_EXPIRED', 'Time-sensitive guidance needs a new validity window before it can be revalidated.', 400);
      // Return to candidate with a clean evidence slate: the user re-authorizes
      // trying it again, not the old successes or the old negative evidence.
      const parent = this.latestContentVersion(id)?.revision ?? null;
      this.db.prepare(`UPDATE experiences SET status='candidate',verified_success_count=0,positive_evidence_count=0,negative_evidence_count=0,last_negative_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='needs_revalidation'`)
        .run(iso(this.database.now()), id, expectedRevision);
      const revalidated = this.get(id);
      this.#snapshotContent(revalidated, 'revalidate', { parentRevision: parent });
      this.database.bump('context_version');
      return revalidated;
    });
  }
  /** Explicit adoption of a supported non-format Experience. It changes only
   * planning eligibility; permissions, destinations and execution remain with
   * the existing dispatcher. The pass travels to the new revision only because
   * the content digest is unchanged and the parent chain is intact. */
  adopt(id, { expectedRevision, userRequested = false } = {}) {
    if (userRequested !== true) throw durableError('ADOPTION_CONFIRMATION_REQUIRED', 'Only an explicit user action can adopt an Experience.', 403);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw durableError('INVALID_EXPERIENCE_REVISION', 'An exact Experience revision is required.', 400);
    return this.database.atomic(() => {
      const experience = this.get(id);
      if (!experience || experience.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      if (experience.status !== 'candidate') throw durableError('ADOPTION_INELIGIBLE', 'Only a candidate Experience can be adopted.');
      if (!TRIAL_ADOPTABLE_EFFECTS.includes(experience.effect?.type)) throw durableError('ADOPTION_UNSUPPORTED', 'This Experience effect needs its existing supervised or promotion path.');
      if (experience.scope_type === 'global') throw durableError('ADOPTION_UNSUPPORTED', 'Global guidance cannot be adopted from an offline trial.');
      if (experience.negative_evidence_count || experience.last_negative_at) throw durableError('ADOPTION_INELIGIBLE', 'An Experience with negative evidence cannot be adopted.');
      if (this.sourceUnavailable(id) || this.sourceRevoked(id)) throw durableError('SOURCE_UNAVAILABLE', 'The Experience provenance is no longer available.', 409);
      if (!this.authorizationValid(experience)) throw durableError('TARGET_UNAUTHORIZED', 'The external target has no current user authorization. A trial can never create one.', 409);
      const now = this.database.now(), digest = experienceContentDigest(experience);
      const latest = this.latestContentVersion(id);
      if (!latest || latest.revision !== experience.revision || latest.content_digest !== digest) throw durableError('ADOPTION_UNTESTED', 'The current content has no immutable version.');
      const trial = this.#validTrialRow(experience, digest, now);
      if (!trial) throw durableError('ADOPTION_UNTESTED', 'A current passing offline evaluation with an independent scenario is required before adoption.');
      const nextRevision = experience.revision + 1, at = iso(now);
      const changed = this.db.prepare("UPDATE experiences SET status='active',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='candidate'")
        .run(at, id, expectedRevision);
      if (!changed.changes) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision changed during adoption.');
      const adopted = this.get(id);
      this.#snapshotContent(adopted, 'adopt', { parentRevision: latest.revision });
      this.#attestTrial(adopted, trial, digest, nextRevision, at);
      this.database.bump('context_version');
      return adopted;
    });
  }
  /** Explicit rollback to an immutable historical content version. It creates
   * a new candidate revision; it never lowers the revision, restores active
   * status, copies old evidence or carries a trial pass. */
  rollback(id, { expectedRevision, targetRevision, userRequested = false } = {}) {
    if (userRequested !== true) throw durableError('ROLLBACK_CONFIRMATION_REQUIRED', 'Only an explicit user action can roll back an Experience.', 403);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || !Number.isInteger(targetRevision) || targetRevision < 1) throw durableError('INVALID_EXPERIENCE_REVISION', 'Exact current and target revisions are required.', 400);
    return this.database.atomic(() => {
      const experience = this.get(id);
      if (!experience || experience.revision !== expectedRevision) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision has changed.');
      if (targetRevision >= experience.revision) throw durableError('ROLLBACK_TARGET_INVALID', 'Rollback needs an earlier content version.', 409);
      const target = this.db.prepare('SELECT * FROM experience_content_versions WHERE experience_id=? AND revision=?').get(id, targetRevision);
      if (!target) throw durableError('ROLLBACK_TARGET_NOT_FOUND', 'That historical Experience version no longer exists.', 404);
      if (this.sourceUnavailable(id) || this.sourceRevoked(id)) throw durableError('SOURCE_UNAVAILABLE', 'The Experience provenance is no longer available.', 409);
      if (!kinds.includes(target.kind) || !Object.hasOwn(scopeRank, target.scope_type) || typeof target.scope_key !== 'string' || !target.scope_key
        || !['stable', 'operational', 'time_sensitive'].includes(target.freshness_class)) throw durableError('ROLLBACK_TARGET_INVALID', 'The historical Experience record is invalid.', 409);
      const predicate = parse(target.predicate_ast_json), effect = validateExperienceEffect(parse(target.effect_signature_json));
      this.registry.validate(predicate);
      if (effect.type !== 'advisory' && (typeof target.directive_key !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/.test(target.directive_key) || forbidden.test(target.directive_key))) throw durableError('ROLLBACK_TARGET_INVALID', 'The historical directive key is invalid.', 409);
      if (target.freshness_class === 'time_sensitive' && (!target.valid_until || Date.parse(target.valid_until) <= this.database.now())) throw durableError('ROLLBACK_EXPIRED', 'Expired time-sensitive guidance cannot be rolled back.');
      const parent = this.latestContentVersion(id)?.revision ?? null, at = iso(this.database.now());
      const changed = this.db.prepare(`UPDATE experiences SET kind=?,action_family=?,directive_key=?,predicate_ast_json=?,effect_signature_json=?,instruction_text=?,
        scope_type=?,scope_key=?,specificity=?,freshness_class=?,valid_until=?,status='candidate',verified_success_count=0,positive_evidence_count=0,
        negative_evidence_count=0,last_verified_at=NULL,last_negative_at=NULL,cooldown_until=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
        .run(target.kind, target.action_family, target.directive_key, target.predicate_ast_json, target.effect_signature_json, target.instruction_text,
          target.scope_type, target.scope_key, scopeRank[target.scope_type], target.freshness_class, target.valid_until, at, id, expectedRevision);
      if (!changed.changes) throw durableError('EXPERIENCE_CHANGED', 'The Experience revision changed during rollback.');
      const restored = this.get(id);
      this.#snapshotContent(restored, 'rollback', { parentRevision: parent, restoredFromRevision: targetRevision });
      this.database.bump('context_version');
      return restored;
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
  compilationInput(job, { allowEpochChange = false } = {}) {
    const epoch = Number(this.database.get('privacy_epoch'));
    const source = this.db.prepare('SELECT * FROM source_records WHERE kind=? AND id=? AND active=1').get(job.payload.sourceKind, job.payload.sourceId);
    if (!source || !allowEpochChange && epoch !== job.payload.privacyEpoch) throw durableError('PRIVACY_CHANGED', 'The compiler source is no longer available.');
    const feedback = this.db.prepare('SELECT kind,effect_dimension,edit_ratio,plan_step_id,task_id FROM feedback_events WHERE id=?').get(source.id);
    const step = feedback?.plan_step_id && this.db.prepare('SELECT step_kind,action_family,expected_effect_json,omission_reason,status FROM plan_steps WHERE id=?').get(feedback.plan_step_id);
    const task = feedback?.task_id && parse(this.db.prepare('SELECT data_json FROM tasks WHERE id=?').get(feedback.task_id)?.data_json);
    const scope = task?.request?.subjectEntity ? { type: 'project', key: task.request.subjectEntity } : { type: 'task_family', key: task?.request?.deliverable || task?.kind || 'work_request' };
    // Only the exact attributed step can establish an observed format; a
    // later or unrelated preparation on this task is not its evidence.
    const observedDraftFormat = parse(step?.expected_effect_json)?.type === 'draft_format' ? parse(step.expected_effect_json) : null;
    const summary = { feedback, step, scope, observedDraftFormat, schemaVersion: 1 };
    if (job.payload.compilationInputDigest && job.payload.compilationInputDigest !== effectDigest(summary)) {
      throw durableError('COMPILATION_SOURCE_CHANGED', 'The feedback context changed; it cannot teach a different scope or trace.', 400);
    }
    return { epoch, source, scope, observedDraftFormat, summary };
  }
  async compile(job, generate, { assertOwned = () => {}, commit = null } = {}) {
    assertOwned();
    const { epoch, source, scope, observedDraftFormat, summary } = this.compilationInput(job);
    // Structured summaries only. No raw source documents, prompts or diffs.
    const candidates = await generate(summary);
    if (!Array.isArray(candidates) || candidates.length > 4) throw durableError('INVALID_COMPILATION', 'The compiler must return at most four structured candidates.', 400);
    const mutation = () => {
      assertOwned();
      if (effectDigest(this.compilationInput(job).summary) !== effectDigest(summary)) throw durableError('CONTEXT_CHANGED', 'The compilation evidence changed; rebuild before retrying.', 503);
      if (Number(this.database.get('privacy_epoch')) !== epoch || !this.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=? AND active=1').get(source.kind, source.id)) throw durableError('PRIVACY_CHANGED', 'Privacy changed before the compiler could commit.');
      return candidates.map(candidate => {
        if (candidate.scopeType !== scope.type || candidate.scopeKey !== scope.key) throw durableError('COMPILER_SCOPE', 'Compilation cannot generalize beyond its source scope.', 400);
        if (candidate.effect?.type === 'draft_format' && (!observedDraftFormat || candidate.effect.format !== observedDraftFormat.format)) throw durableError('UNSUPPORTED_LEARNING', 'The proposed format was not observed in the source trace.', 400);
        return this.create(candidate, { sources: [{ kind: source.kind, id: source.id }] });
      });
    };
    return commit ? commit(mutation) : this.database.write(mutation);
  }
}

const archiveTargetId = (connectorId, value) => connectorId === 'notion'
  ? String(value).replace(/-/g, '').toLowerCase() : String(value);
/** Read-only current-authorization check for an archive target. It reuses the
 * existing ArtifactActions grants/provider/covers matcher, executes no
 * provider request and never creates or widens a grant. A missing exact grant
 * is unknown, not a pass; a matching grant that is revoked, scoped elsewhere,
 * on another account or unavailable is denied. */
export function archiveAuthorization(experience, artifacts) {
  if (experience?.effect?.type !== 'archive_destination') return { required: false, status: 'not_required', reason: 'no_external_target' };
  if (!artifacts || typeof artifacts.grants !== 'function' || typeof artifacts.provider !== 'function' || typeof artifacts.covers !== 'function') {
    return { required: true, status: 'unknown', reason: 'authorization_check_unavailable' };
  }
  try {
    const connectorId = experience.effect.provider, targetId = archiveTargetId(connectorId, experience.effect.resourceId);
    const grants = artifacts.grants().filter(grant => grant && grant.connectorId === connectorId && archiveTargetId(connectorId, grant.targetId) === targetId);
    if (!grants.length) return { required: true, status: 'unknown', reason: 'no_matching_user_grant' };
    const task = { id: null, request: { source: { connectorId }, ...(experience.scope_type === 'project' ? { subjectEntity: experience.scope_key } : {}) } };
    const reasons = grants.map(grant => {
      if (grant.status !== 'active') return 'grant_revoked';
      if (grant.createdBy !== 'user' || !grant.confirmedAt) return 'grant_unconfirmed';
      if (!artifacts.covers(grant, task)) return 'scope_mismatch';
      if (!artifacts.provider(grant)) return 'account_or_permission_unavailable';
      return 'authorized';
    });
    if (reasons.includes('authorized')) return { required: true, status: 'authorized', reason: 'matching_user_grant' };
    return { required: true, status: 'denied', reason: reasons[0] };
  } catch { return { required: true, status: 'unknown', reason: 'authorization_check_failed' }; }
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
