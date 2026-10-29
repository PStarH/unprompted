CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, state_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS durable_inbox (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL,
 event_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received','processed','suppressed','forgotten')),
 material_signature TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT,
 UNIQUE(provider,provider_event_id)
);
CREATE INDEX IF NOT EXISTS ix_durable_inbox_recent ON durable_inbox(provider,state,received_at DESC);
CREATE TABLE IF NOT EXISTS negative_pair_cache (
 event_a TEXT NOT NULL REFERENCES durable_inbox(id) ON DELETE CASCADE,
 event_b TEXT NOT NULL REFERENCES durable_inbox(id) ON DELETE CASCADE,
 evaluator_version TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(event_a,event_b,evaluator_version)
);
CREATE TABLE IF NOT EXISTS source_records (
 kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT 'local',
 version INTEGER NOT NULL DEFAULT 1, privacy_epoch INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS situations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('OBSERVING','OPEN','RESOLVED','CANCELLED','EXPIRED','SUPPRESSED','SUPERSEDED')),
 summary TEXT NOT NULL, closure_condition_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 last_evidence_at TEXT, next_eval_at TEXT, expires_at TEXT, version INTEGER NOT NULL DEFAULT 1,
 closure_status TEXT NOT NULL DEFAULT 'NONE' CHECK(closure_status IN ('NONE','SUSPECTED','CONFIRMED')),
 closure_evidence_json TEXT NOT NULL DEFAULT '[]', superseded_by_situation_id TEXT REFERENCES situations(id) ON DELETE SET NULL,
 standing_intent_id TEXT, scope_json TEXT NOT NULL DEFAULT '{}', source_watermark_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_situations_active ON situations(lifecycle_state,next_eval_at);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, candidate_key TEXT UNIQUE, data_json TEXT NOT NULL, status TEXT NOT NULL,
 input_version INTEGER NOT NULL DEFAULT 0, processed_input_version INTEGER NOT NULL DEFAULT 0,
 run_generation INTEGER NOT NULL DEFAULT 0, privacy_epoch INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 situation_id TEXT REFERENCES situations(id) ON DELETE SET NULL, dedup_task_key TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES durable_inbox(id) ON DELETE CASCADE,
 material_signature TEXT NOT NULL, associated_at TEXT NOT NULL,
 PRIMARY KEY(task_id,event_id)
);
CREATE TABLE IF NOT EXISTS task_signals (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 signal_type TEXT NOT NULL, source_event_id TEXT, input_version INTEGER,
 payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONSUMED')),
 created_at TEXT NOT NULL, consumed_at TEXT,
 UNIQUE(task_id,source_event_id,signal_type)
);
CREATE TABLE IF NOT EXISTS event_situation_links (
 event_id TEXT NOT NULL REFERENCES durable_inbox(id) ON DELETE CASCADE,
 situation_id TEXT NOT NULL REFERENCES situations(id) ON DELETE CASCADE,
 association_method TEXT NOT NULL, associated_at TEXT NOT NULL,
 PRIMARY KEY(event_id,situation_id)
);
CREATE INDEX IF NOT EXISTS ix_situation_events ON event_situation_links(situation_id,associated_at);
CREATE TABLE IF NOT EXISTS activation_decisions (
 id TEXT PRIMARY KEY, event_a TEXT REFERENCES durable_inbox(id) ON DELETE CASCADE,
 event_b TEXT REFERENCES durable_inbox(id) ON DELETE CASCADE,
 situation_id TEXT REFERENCES situations(id) ON DELETE CASCADE,
 stage TEXT NOT NULL, outcome TEXT NOT NULL, reason_code TEXT NOT NULL,
 evaluator_version TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_task_signals_pending ON task_signals(task_id,status,input_version);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, job_type TEXT NOT NULL, payload_json TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('queued','running','retry_wait','recovery_required','completed','dead','cancelled')),
 priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
 available_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, lease_token INTEGER NOT NULL DEFAULT 0, heartbeat_at TEXT,
 last_error_class TEXT, dead_letter_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(queue_name,idempotency_key)
);
CREATE INDEX IF NOT EXISTS ix_jobs_claimable ON jobs(queue_name,state,priority DESC,available_at);
CREATE INDEX IF NOT EXISTS ix_jobs_expired ON jobs(state,lease_until);
CREATE TABLE IF NOT EXISTS task_runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, job_lease_token INTEGER NOT NULL,
 input_version INTEGER NOT NULL, run_generation INTEGER NOT NULL, privacy_epoch INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','waiting','completed','recovery_required','failed','cancelled')),
 plan_version INTEGER NOT NULL DEFAULT 1, checkpoint_json TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_executions (
 id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
 task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
 plan_step_id TEXT REFERENCES plan_steps(id) ON DELETE SET NULL,
 user_id TEXT NOT NULL DEFAULT 'local', provider TEXT NOT NULL, tool TEXT NOT NULL, action_family TEXT NOT NULL,
 resource_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, effect_signature_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('intent','dispatched','accepted','verified','failed','unknown','cancelled')),
 is_write INTEGER NOT NULL, payload_json TEXT, result_json TEXT,
 provider_receipt_id TEXT, conditional_version TEXT, provider_idempotent INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT, lease_token INTEGER, input_version INTEGER NOT NULL, run_generation INTEGER NOT NULL, privacy_epoch INTEGER NOT NULL,
 dispatched_at TEXT, verified_at TEXT, last_error_class TEXT,
 privacy_redacted INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_executions_unresolved ON tool_executions(status,is_write,resource_id);
CREATE TABLE IF NOT EXISTS execution_attempts (
 execution_id TEXT NOT NULL REFERENCES tool_executions(id) ON DELETE CASCADE,
 attempt_number INTEGER NOT NULL, job_id TEXT NOT NULL, lease_token INTEGER NOT NULL,
 state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(execution_id,attempt_number)
);
CREATE TABLE IF NOT EXISTS resource_claims (
 user_id TEXT NOT NULL, provider TEXT NOT NULL, resource_id TEXT NOT NULL,
 owner_task_run_id TEXT, lease_owner TEXT, lease_token INTEGER NOT NULL DEFAULT 0, lease_until TEXT,
 current_execution_id TEXT REFERENCES tool_executions(id) ON DELETE SET NULL,
 claim_state TEXT NOT NULL CHECK(claim_state IN ('free','held','unresolved')),
 PRIMARY KEY(user_id,provider,resource_id)
);

CREATE TABLE IF NOT EXISTS user_memories (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local', scope_type TEXT NOT NULL, scope_key TEXT NOT NULL,
 content TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, privacy_epoch INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',1);
CREATE TABLE IF NOT EXISTS memory_embeddings (
 memory_id TEXT PRIMARY KEY REFERENCES user_memories(id) ON DELETE CASCADE,
 model_id TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, privacy_epoch INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activation_policies (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL CHECK(status IN ('active','draft','disabled')),
 scope_type TEXT NOT NULL, scope_key TEXT NOT NULL, predicate_ast_json TEXT NOT NULL,
 effect_signature_json TEXT NOT NULL, instruction_text TEXT NOT NULL,
 authority INTEGER NOT NULL DEFAULT 3, priority INTEGER NOT NULL DEFAULT 0,
 identity_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hot_context_items (
 id TEXT PRIMARY KEY, origin_kind TEXT NOT NULL, origin_id TEXT NOT NULL, context_version INTEGER NOT NULL,
 projection_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(origin_kind,origin_id)
);
CREATE TABLE IF NOT EXISTS canonical_entities (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
 aliases_json TEXT NOT NULL, confirmed_by_user INTEGER NOT NULL CHECK(confirmed_by_user=1), updated_at TEXT NOT NULL,
 UNIQUE(provider,provider_id)
);
CREATE TABLE IF NOT EXISTS working_candidates (
 id TEXT PRIMARY KEY, family TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ACCUMULATE','ACTIVE','NOTIFICATION_PENDING','CLOSED')),
 anchors_json TEXT NOT NULL, entities_json TEXT NOT NULL, task_ids_json TEXT NOT NULL,
 deadline_at TEXT, first_event_at TEXT NOT NULL, last_event_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_events (
 candidate_id TEXT NOT NULL REFERENCES working_candidates(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES durable_inbox(id) ON DELETE CASCADE, associated_at TEXT NOT NULL,
 PRIMARY KEY(candidate_id,event_id)
);
CREATE TABLE IF NOT EXISTS entity_events (
 entity_key TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES durable_inbox(id) ON DELETE CASCADE,
 observed_at TEXT NOT NULL, PRIMARY KEY(entity_key,event_id)
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
 id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, issue_key TEXT NOT NULL, candidate_id TEXT,
 class TEXT NOT NULL CHECK(class IN ('critical','interactive','informational','digest')),
 state TEXT NOT NULL CHECK(state IN ('pending','delivered','digest','resolved')),
 notification_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, not_before TEXT,
 UNIQUE(dedupe_key)
);

CREATE TABLE IF NOT EXISTS experiences (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('execution_hint','planning_hint','omission_guard','trigger_hint')),
 status TEXT NOT NULL CHECK(status IN ('candidate','active','cooldown','needs_revalidation','retired')),
 scope_type TEXT NOT NULL CHECK(scope_type IN ('global','task_family','project','entity','resource')),
 scope_key TEXT NOT NULL, action_family TEXT, directive_key TEXT,
 predicate_ast_json TEXT NOT NULL, effect_signature_json TEXT NOT NULL, instruction_text TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0, specificity INTEGER NOT NULL DEFAULT 0,
 verified_success_count INTEGER NOT NULL DEFAULT 0, positive_evidence_count INTEGER NOT NULL DEFAULT 0,
 negative_evidence_count INTEGER NOT NULL DEFAULT 0,
 freshness_class TEXT NOT NULL CHECK(freshness_class IN ('stable','operational','time_sensitive')),
 last_verified_at TEXT, last_negative_at TEXT, valid_until TEXT, cooldown_until TEXT,
 revision INTEGER NOT NULL DEFAULT 1, schema_version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_experience_retrieval ON experiences(user_id,status,kind,scope_type,scope_key);
CREATE INDEX IF NOT EXISTS ix_experience_directive ON experiences(user_id,directive_key,status);
CREATE TABLE IF NOT EXISTS lineage (
 source_kind TEXT NOT NULL, source_id TEXT NOT NULL, derived_kind TEXT NOT NULL, derived_id TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(source_kind,source_id,derived_kind,derived_id)
);
CREATE INDEX IF NOT EXISTS ix_lineage_derived ON lineage(derived_kind,derived_id);
CREATE TABLE IF NOT EXISTS plan_steps (
 id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
 logical_step_id TEXT NOT NULL, plan_version INTEGER NOT NULL, step_kind TEXT NOT NULL, action_family TEXT,
 expected_effect_json TEXT NOT NULL, omission_reason TEXT,
 status TEXT NOT NULL CHECK(status IN ('proposed','approved','executing','completed','skipped','rejected','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_run_id,logical_step_id,plan_version)
);
CREATE TABLE IF NOT EXISTS plan_step_experiences (
 plan_step_id TEXT NOT NULL REFERENCES plan_steps(id) ON DELETE CASCADE,
 experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
 relation_kind TEXT NOT NULL CHECK(relation_kind IN ('planner_declared','predicate_matched','user_confirmed')),
 created_at TEXT NOT NULL, PRIMARY KEY(plan_step_id,experience_id)
);
CREATE TABLE IF NOT EXISTS experience_evidence (
 id TEXT PRIMARY KEY, experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
 task_id TEXT, task_run_id TEXT, plan_step_id TEXT REFERENCES plan_steps(id) ON DELETE CASCADE,
 execution_id TEXT REFERENCES tool_executions(id) ON DELETE SET NULL,
 experience_revision INTEGER NOT NULL DEFAULT 1, evidence_kind TEXT NOT NULL, effect_dimension TEXT NOT NULL, independent_key TEXT NOT NULL,
 verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 UNIQUE(experience_id,experience_revision,evidence_kind,effect_dimension,independent_key)
);
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
 task_run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE, plan_step_id TEXT REFERENCES plan_steps(id) ON DELETE SET NULL,
 generated_version INTEGER NOT NULL, visible_version INTEGER NOT NULL, status TEXT NOT NULL,
 generated_digest TEXT NOT NULL, latest_digest TEXT NOT NULL, edit_ratio REAL NOT NULL DEFAULT 0,
 redacted_diff_ref TEXT, situation_id TEXT, situation_version INTEGER, stale INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_events (
 id TEXT PRIMARY KEY, task_id TEXT, plan_step_id TEXT REFERENCES plan_steps(id) ON DELETE SET NULL,
 execution_id TEXT REFERENCES tool_executions(id) ON DELETE SET NULL, artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
 kind TEXT NOT NULL, edit_ratio REAL, effect_dimension TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_suppressions (
 id TEXT PRIMARY KEY, task_id TEXT, context_key TEXT NOT NULL, action_family TEXT NOT NULL,
 effect_digest TEXT NOT NULL, feedback_id TEXT REFERENCES feedback_events(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, UNIQUE(context_key,action_family,effect_digest)
);
CREATE TABLE IF NOT EXISTS privacy_requests (
 id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_id_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('purging','pending','completed','failed')),
 status_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forgotten_sources (
 kind TEXT NOT NULL, id_digest TEXT NOT NULL, forgotten_at TEXT NOT NULL, PRIMARY KEY(kind,id_digest)
);
CREATE TABLE IF NOT EXISTS retained_files (
 id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL,
 source_kind TEXT, source_id TEXT, delete_on_forget INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replay_results (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, configuration_version INTEGER NOT NULL,
 metrics_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS standing_intents (
 id TEXT PRIMARY KEY,
 status TEXT NOT NULL CHECK(status IN ('proposed','active','paused','disabled','expired')),
 description TEXT NOT NULL,
 prefilter_json TEXT NOT NULL,
 predicate_json TEXT,
 scope_json TEXT NOT NULL,
 desired_outcome TEXT NOT NULL,
 autonomy_json TEXT NOT NULL,
 prohibited_json TEXT NOT NULL,
 probe_policy_json TEXT NOT NULL DEFAULT '{}',
 budget_json TEXT NOT NULL DEFAULT '{}',
 created_by TEXT NOT NULL,
 confirmation TEXT NOT NULL CHECK(confirmation IN ('user_confirmed','proposed_only')),
 version INTEGER NOT NULL DEFAULT 1,
 matches_used INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 expires_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_standing_intents_status ON standing_intents(status,expires_at);
CREATE TABLE IF NOT EXISTS situation_entities (
 situation_id TEXT NOT NULL REFERENCES situations(id) ON DELETE CASCADE,
 entity_key TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('project','resource','thread')),
 source_event_id TEXT,
 PRIMARY KEY(situation_id,entity_key,role)
);
CREATE INDEX IF NOT EXISTS ix_situation_entities_key ON situation_entities(entity_key,role);
CREATE TABLE IF NOT EXISTS tentative_claims (
 id TEXT PRIMARY KEY,
 claim_kind TEXT NOT NULL CHECK(claim_kind IN ('resource','time')),
 scope_key TEXT NOT NULL,
 situation_id TEXT,
 task_id TEXT,
 expires_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('held','released')),
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tentative_held ON tentative_claims(claim_kind,scope_key) WHERE state='held';
CREATE TABLE IF NOT EXISTS rsi_proposals (
 id TEXT PRIMARY KEY,
 status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','rolled_back')),
 parameter TEXT NOT NULL,
 previous_json TEXT NOT NULL,
 proposed_json TEXT NOT NULL,
 evidence_json TEXT NOT NULL,
 scope_json TEXT NOT NULL,
 replay_id TEXT,
 rollback_of TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
