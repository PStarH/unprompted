import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { durableError, iso, json, parse } from './database.js';

const keyFor = (kind, id) => `${kind}\0${id}`;
const minimalTask = row => ({ id: row.id, status: 'cancelled', userDismissed: true, privacyInvalidated: true,
  inputVersion: row.input_version, processedInputVersion: row.processed_input_version, runGeneration: row.run_generation + 1, privacyEpoch: row.privacy_epoch + 1,
  stateVersion: row.version + 1, control: { paused: true } });

/** Forget removes grounded and derived content. Opaque record identifiers and
 * necessary reconciliation metadata are the only retained invalidation data.
 * A separate explicit Activation Policy owns "don't do this again". */
export class ForgetService {
  constructor(database, { jobs, memory = null, store = null, fileRoot = path.dirname(database.filename), onInvalidate = () => {} } = {}) {
    this.database = database; this.db = database.db; this.jobs = jobs; this.memory = memory; this.store = store;
    this.fileRoot = path.resolve(fileRoot); this.onInvalidate = onInvalidate;
  }
  digest(kind, id) { return createHmac('sha256', this.database.get('privacy_salt')).update(keyFor(kind, id)).digest('hex'); }
  forgotten(kind, id) { return Boolean(this.db.prepare('SELECT 1 FROM forgotten_sources WHERE kind=? AND id_digest=?').get(kind, this.digest(kind, id))); }
  permissionRevoked(connectorId) { return (parse(this.database.get('revoked_connectors', '[]')) || []).includes(connectorId); }
  restorePermission(connectorId) {
    if (typeof connectorId !== 'string' || !connectorId) throw durableError('INVALID_REVOCATION', 'A connector id is required.', 400);
    const next = (parse(this.database.get('revoked_connectors', '[]')) || []).filter(id => id !== connectorId);
    this.database.atomic(() => this.database.set('revoked_connectors', json(next)));
    return { connectorId, revoked: false, suppressedProviderEventsRemain: true };
  }
  async revokePermission({ connectorId, purgeLocal = false } = {}) {
    if (typeof connectorId !== 'string' || !connectorId || connectorId.length > 80 || typeof purgeLocal !== 'boolean') throw durableError('INVALID_REVOCATION', 'Permission revocation needs a connector id.', 400);
    await this.database.write(() => {
      const list = new Set(parse(this.database.get('revoked_connectors', '[]')) || []);
      list.add(connectorId);
      this.database.set('revoked_connectors', json([...list]));
      this.database.bump('privacy_epoch');
      this.database.bump('context_version');
      const at = iso(this.database.now());
      const touchedEvents = new Set();
      const touchedTasks = new Set();
      for (const row of this.db.prepare('SELECT id,status,data_json FROM tasks').all()) {
        const data = parse(row.data_json);
        const source = data.sourceConnectorId || data.connectorId || data.request?.source?.connectorId;
        if (source !== connectorId) continue;
        const closed = ['completed', 'cancelled'].includes(row.status) || data.privacyInvalidated;
        if (!purgeLocal && closed) continue;
        touchedTasks.add(row.id);
        this.jobs.cancelTask(row.id);
        let next = data;
        if (purgeLocal) {
          this.db.prepare('DELETE FROM artifacts WHERE task_id=?').run(row.id);
          this.db.prepare("UPDATE task_runs SET status='cancelled',checkpoint_json=NULL,updated_at=? WHERE task_id=?").run(at, row.id);
          this.db.prepare("UPDATE plan_steps SET expected_effect_json='{}',omission_reason=NULL,updated_at=? WHERE task_run_id IN (SELECT id FROM task_runs WHERE task_id=?)").run(at, row.id);
          this.db.prepare("UPDATE tool_executions SET payload_json=NULL,result_json=NULL,effect_signature_json='{}',privacy_redacted=1,updated_at=? WHERE task_id=?").run(at, row.id);
          next = { sourceConnectorId: connectorId, privacyRedacted: true, privacyInvalidated: true, subject: 'Redacted', control: { paused: true, pauseReason: 'permission_revoked', updatedAt: at } };
        } else {
          this.db.prepare('UPDATE artifacts SET stale=1,updated_at=? WHERE task_id=? AND stale=0').run(at, row.id);
          next.control = { ...(next.control || {}), paused: true, pauseReason: 'permission_revoked', updatedAt: at };
          next.status = 'waiting_for_information';
          this.db.prepare("INSERT OR IGNORE INTO task_signals(id,task_id,signal_type,source_event_id,created_at) VALUES(?,?,'PERMISSION_REVOKED',?,?)").run(randomUUID(), row.id, `permission:${connectorId}`, at);
        }
        this.db.prepare('UPDATE tasks SET data_json=?,status=?,privacy_epoch=privacy_epoch+1,run_generation=run_generation+1,version=version+1,updated_at=? WHERE id=?')
          .run(json(next), purgeLocal && closed ? row.status : 'waiting_for_information', at, row.id);
      }
      if (purgeLocal) {
        const events = this.db.prepare('SELECT id,provider_event_id,event_json FROM durable_inbox WHERE provider=?').all(connectorId);
        const messageIds = new Set();
        const documentIds = new Set();
        const situationIds = new Set();
        for (const event of events) {
          touchedEvents.add(event.id);
          const body = parse(event.event_json);
          if (body?.type === 'email.received' && body.payload?.id) messageIds.add(body.payload.id);
          if (String(body?.type || '').startsWith('document.') && body.payload?.id) documentIds.add(String(body.payload.id));
          this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES(?,?,?)').run('provider_event', this.digest('provider_event', `${connectorId}:${event.provider_event_id}`), at);
          this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES(?,?,?)').run('event', this.digest('event', event.id), at);
          for (const link of this.db.prepare('SELECT situation_id FROM event_situation_links WHERE event_id=?').all(event.id)) situationIds.add(link.situation_id);
          const shell = { id: event.id, connectorId, source: connectorId, redacted: 'permission_revoked', payload: { id: event.provider_event_id } };
          this.db.prepare("UPDATE durable_inbox SET event_json=?,material_signature='redacted',state='forgotten' WHERE id=?").run(json(shell), event.id);
        }
        for (const situationId of situationIds) {
          this.db.prepare("UPDATE situations SET summary='Removed after permission revocation',closure_condition_json=?,closure_evidence_json='[]',scope_json='{}',updated_at=?,version=version+1 WHERE id=?")
            .run(json({ kind: 'UNSPECIFIED' }), at, situationId);
          this.db.prepare("DELETE FROM hot_context_items WHERE origin_kind='situation' AND origin_id=?").run(situationId);
        }
        for (const eventId of touchedEvents) this.db.prepare("DELETE FROM hot_context_items WHERE origin_kind='event' AND origin_id=?").run(eventId);
        for (const taskId of touchedTasks) this.db.prepare("DELETE FROM hot_context_items WHERE origin_kind='task' AND origin_id=?").run(taskId);
        for (const memory of this.db.prepare("SELECT id,source_kind,source_id FROM user_memories WHERE source_kind IN ('event','task')").all()) {
          if (memory.source_kind === 'event' ? !touchedEvents.has(memory.source_id) : !touchedTasks.has(memory.source_id)) continue;
          this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(memory.id);
          this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?').run(memory.id);
          this.db.prepare("DELETE FROM hot_context_items WHERE origin_kind='memory' AND origin_id=?").run(memory.id);
          this.db.prepare('DELETE FROM user_memories WHERE id=?').run(memory.id);
        }
        for (const delivery of this.db.prepare('SELECT id,notification_json FROM notification_deliveries').all()) {
          const notice = parse(delivery.notification_json);
          if (!notice || !touchedTasks.has(notice.taskId)) continue;
          this.db.prepare('UPDATE notification_deliveries SET notification_json=? WHERE id=?').run(json({ taskId: notice.taskId, redacted: 'permission_revoked' }), delivery.id);
        }
        const snapshot = this.db.prepare('SELECT state_json,version FROM workspace_state WHERE id=1').get();
        if (snapshot) {
          const state = parse(snapshot.state_json);
          const fromConnector = item => item?.connectorId === connectorId || item?.source === connectorId;
          state.events = (state.events || []).filter(event => !fromConnector(event) && !touchedEvents.has(event.id));
          state.inbox = (state.inbox || []).filter(message => !fromConnector(message) && !messageIds.has(message.id));
          state.history = (state.history || []).filter(row => !touchedEvents.has(row.eventId) && !touchedTasks.has(row.taskId));
          state.trace = (state.trace || []).filter(row => !touchedEvents.has(row.eventId) && !touchedTasks.has(row.taskId));
          state.notifications = (state.notifications || []).filter(row => !touchedTasks.has(row.taskId));
          state.outbox = (state.outbox || []).filter(item => !fromConnector(item) && !touchedTasks.has(item.taskId));
          state.documents = state.documents || {};
          for (const documentId of documentIds) delete state.documents[documentId];
          for (const [documentId, document] of Object.entries(state.documents)) if (fromConnector(document)) delete state.documents[documentId];
          for (const cursor of Object.values(state.cursors || {})) for (const documentId of Object.keys(cursor?.documents || {})) if (documentIds.has(documentId) || fromConnector(cursor.documents[documentId])) delete cursor.documents[documentId];
          state.tasks = state.tasks || {};
          for (const taskId of touchedTasks) {
            const row = this.db.prepare('SELECT data_json,status FROM tasks WHERE id=?').get(taskId);
            if (row) state.tasks[taskId] = { ...parse(row.data_json), id: taskId, status: row.status };
          }
          for (const [taskId, task] of Object.entries(state.tasks)) {
            if (touchedTasks.has(taskId)) continue;
            const source = task?.sourceConnectorId || task?.connectorId || task?.request?.source?.connectorId;
            if (source !== connectorId) continue;
            state.tasks[taskId] = { id: taskId, sourceConnectorId: connectorId, privacyRedacted: true, privacyInvalidated: true, subject: 'Redacted', status: task.status || 'cancelled', control: { paused: true, pauseReason: 'permission_revoked', updatedAt: at } };
          }
          this.db.prepare('UPDATE workspace_state SET state_json=?,version=version+1 WHERE id=1 AND version=?').run(json(state), snapshot.version);
        }
      }
    });
    this.store?.refresh();
    this.onInvalidate();
    return { connectorId, revoked: true, purgeLocal };
  }
  preview(kind, id) {
    if (!['event', 'situation', 'task', 'memory', 'task_memory', 'task_direction', 'experience', 'artifact', 'policy', 'feedback', 'outcome', 'standing_intent', 'replay', 'rsi_proposal'].includes(kind) || typeof id !== 'string' || !id) throw durableError('INVALID_FORGET', 'Unknown Forget target.', 400);
    const existingSource = this.db.prepare('SELECT 1 FROM source_records WHERE kind=? AND id=?').get(kind, id);
    const tables = { event: 'durable_inbox', situation: 'situations', task: 'tasks', memory: 'user_memories', experience: 'experiences', artifact: 'artifacts', policy: 'activation_policies', feedback: 'feedback_events', outcome: 'tool_executions', standing_intent: 'standing_intents', replay: 'replay_results', rsi_proposal: 'rsi_proposals' };
    if (!existingSource && !(tables[kind] && this.db.prepare(`SELECT 1 FROM ${tables[kind]} WHERE id=?`).get(id)) && !this.forgotten(kind, id)) throw durableError('FORGET_NOT_FOUND', 'This information no longer exists.', 404);
    const roots = [{ kind, id }];
    if (kind === 'situation') for (const task of this.db.prepare('SELECT id FROM tasks WHERE situation_id=?').all(id)) roots.push({ kind: 'task', id: task.id });
    if (kind === 'memory') {
      const memory = this.db.prepare('SELECT source_kind,source_id FROM user_memories WHERE id=?').get(id);
      if (memory) roots.push({ kind: memory.source_kind, id: memory.source_id });
    }
    if (kind === 'outcome') { const execution = this.db.prepare('SELECT task_id FROM tool_executions WHERE id=?').get(id); if (execution) roots.push({ kind: 'task', id: execution.task_id }); }
    if (kind === 'artifact') {
      const artifact = this.db.prepare('SELECT task_id FROM artifacts WHERE id=?').get(id);
      if (artifact?.task_id) roots.push({ kind: 'task', id: artifact.task_id });
    }
    if (kind === 'task') for (const row of this.db.prepare('SELECT event_id FROM task_events WHERE task_id=?').all(id)) roots.push({ kind: 'event', id: row.event_id });
    const dependencies = new Map();
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index];
      for (const row of this.database.descendants(root.kind, root.id)) dependencies.set(keyFor(row.kind, row.id), row);
      for (const record of dependencies.values()) {
        const taskId = record.kind === 'task_run' ? this.db.prepare('SELECT task_id FROM task_runs WHERE id=?').get(record.id)?.task_id
          : record.kind === 'plan_step' ? this.db.prepare('SELECT r.task_id FROM task_runs r JOIN plan_steps s ON s.task_run_id=r.id WHERE s.id=?').get(record.id)?.task_id : null;
        if (taskId && !roots.some(item => item.kind === 'task' && item.id === taskId)) roots.push({ kind: 'task', id: taskId });
      }
      if (dependencies.size > 10000) break;
    }
    if (dependencies.size > 10000) throw durableError('FORGET_SCOPE_LIMIT', 'This deletion requires a larger explicit maintenance pass. No partial deletion was started.');
    const records = [...dependencies.values()];
    const counts = Object.fromEntries([...new Set(records.map(row => row.kind))].map(type => [type, records.filter(row => row.kind === type).length]));
    return { roots, records, counts };
  }
  get(id) { const row = this.db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(id); return row && { id: row.id, state: row.state, status: parse(row.status_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
  async forget({ kind, id }) {
    if (this.forgotten(kind, id)) { const request = this.db.prepare('SELECT id FROM privacy_requests WHERE source_kind=? AND source_id_digest=? ORDER BY created_at DESC LIMIT 1').get(kind, this.digest(kind, id)); if (request) return this.get(request.id); }
    const preview = this.preview(kind, id), requestId = randomUUID(), at = iso(this.database.now());
    const affected = new Map(preview.records.map(record => [keyFor(record.kind, record.id), record]));
    const ids = type => preview.records.filter(record => record.kind === type).map(record => record.id);
    const taskIds = new Set(ids('task')), eventIds = new Set(ids('event')), memoryIds = new Set([...ids('memory'), ...ids('task_memory')]);
    const directions = new Set(ids('task_direction')), docs = new Set(), messages = new Set(), eventRecords = new Set();
    const pendingExecutions = [], fileIds = [], forgottenScopes = [], removedClarifications = new Set(), survivingSituations = new Set();
    await this.database.write(() => {
      const epoch = this.database.bump('privacy_epoch'); this.database.bump('context_version');
      this.db.prepare('INSERT INTO privacy_requests VALUES(?,?,?,?,?,?,?)').run(requestId, kind, this.digest(kind, id), 'purging', json({ counts: preview.counts, localDeletion: 'in_progress', privacyEpoch: epoch }), at, at);
      for (const root of preview.roots) this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES(?,?,?)').run(root.kind, this.digest(root.kind, root.id), at);
      for (const eventId of eventIds) {
        const inbox = this.db.prepare('SELECT * FROM durable_inbox WHERE id=?').get(eventId);
        const event = parse(inbox?.event_json);
        if (inbox) this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES(?,?,?)').run('provider_event', this.digest('provider_event', `${inbox.provider}:${inbox.provider_event_id}`), at);
        if (event?.payload?.id) {
          if (event.type?.startsWith('document.')) docs.add(event.payload.id);
          else if (event.type === 'email.received') messages.add(event.payload.id);
          else eventRecords.add(event.payload.id);
        }
      }
      // Invalidate first, within the same commit that removes checkpoints and
      // cancels compiler jobs. Late workers must fail both generation checks.
      for (const taskId of taskIds) {
        const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId); if (!row) continue;
        const data = parse(row.data_json);
        // Remove event references from ordinary signals; the opaque revocation
        // signal remains even after the source event is deleted.
        this.db.prepare('DELETE FROM task_signals WHERE task_id=?').run(taskId);
        this.db.prepare("INSERT OR IGNORE INTO task_signals(id,task_id,signal_type,source_event_id,created_at) VALUES(?,?,'SYSTEM_REVOKE_SIGNAL',?,?)")
          .run(randomUUID(), taskId, requestId, at);
        if (data.request?.subjectEntity) forgottenScopes.push({ entity: data.request.subjectEntity.toLowerCase(), deliverable: data.request.deliverable?.toLowerCase() });
        if (data.guidance?.id) directions.add(data.guidance.id);
        this.db.prepare("UPDATE tasks SET status='cancelled',data_json=?,run_generation=run_generation+1,privacy_epoch=privacy_epoch+1,version=version+1,dirty=0,updated_at=? WHERE id=? AND version=?")
          .run(json(minimalTask(row)), at, taskId, row.version);
        this.db.prepare("UPDATE task_runs SET status='cancelled',checkpoint_json=NULL,updated_at=? WHERE task_id=?").run(at, taskId);
        this.jobs.cancelTask(taskId);
        const executions = this.db.prepare('SELECT * FROM tool_executions WHERE task_id=?').all(taskId);
        for (const execution of executions) {
          const pending = execution.is_write && ['dispatched', 'accepted', 'unknown'].includes(execution.status);
          this.db.prepare(`UPDATE tool_executions SET payload_json=NULL,result_json=NULL,effect_signature_json='{}',privacy_redacted=1,
            status=CASE WHEN ?=1 THEN 'unknown' WHEN status='intent' THEN 'cancelled' ELSE status END,updated_at=? WHERE id=?`).run(Number(Boolean(pending)), at, execution.id);
          if (pending) {
            pendingExecutions.push({ id: execution.id, provider: execution.provider });
            this.db.prepare("UPDATE resource_claims SET claim_state='unresolved' WHERE current_execution_id=?").run(execution.id);
          } else if (execution.status === 'intent') this.db.prepare("UPDATE resource_claims SET claim_state='free',lease_owner=NULL,lease_until=NULL,current_execution_id=NULL,owner_task_run_id=NULL WHERE current_execution_id=?").run(execution.id);
        }
      }
      for (const memoryId of memoryIds) {
        this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(memoryId);
        this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?').run(memoryId);
        this.db.prepare('DELETE FROM hot_context_items WHERE origin_kind=\'memory\' AND origin_id=?').run(memoryId);
        this.db.prepare('DELETE FROM user_memories WHERE id=?').run(memoryId);
      }
      for (const experienceId of ids('experience')) this.db.prepare('DELETE FROM experiences WHERE id=?').run(experienceId);
      for (const stepId of ids('plan_step')) this.db.prepare('DELETE FROM plan_steps WHERE id=?').run(stepId);
      for (const artifactId of ids('artifact')) this.db.prepare('DELETE FROM artifacts WHERE id=?').run(artifactId);
      for (const replayId of ids('replay')) this.db.prepare('DELETE FROM replay_results WHERE id=?').run(replayId);
      for (const proposalId of ids('rsi_proposal')) this.db.prepare('DELETE FROM rsi_proposals WHERE id=?').run(proposalId);
      for (const intentId of ids('standing_intent')) this.db.prepare('DELETE FROM standing_intents WHERE id=?').run(intentId);
      for (const feedbackId of ids('feedback')) this.db.prepare('DELETE FROM feedback_events WHERE id=?').run(feedbackId);
      for (const candidateId of ids('candidate')) this.db.prepare('DELETE FROM working_candidates WHERE id=?').run(candidateId);
      for (const entityId of ids('canonical_entity')) this.db.prepare('DELETE FROM canonical_entities WHERE id=?').run(entityId);
      for (const policyId of ids('policy')) {
        this.db.prepare('DELETE FROM activation_policies WHERE id=?').run(policyId);
        this.db.prepare('DELETE FROM hot_context_items WHERE origin_kind=\'policy\' AND origin_id=?').run(policyId);
      }
      for (const jobId of ids('job')) {
        const job = this.db.prepare('SELECT job_type,payload_json FROM jobs WHERE id=?').get(jobId);
        const pendingEventId = job?.job_type === 'situation_delta' ? parse(job.payload_json)?.eventId : null;
        if (pendingEventId && !eventIds.has(pendingEventId) && this.db.prepare("SELECT 1 FROM durable_inbox WHERE id=? AND state='received'").get(pendingEventId)) {
          this.db.prepare("UPDATE jobs SET state='queued',attempts=0,lease_owner=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE queue_name='inbox' AND idempotency_key=? AND state='completed'")
            .run(at, at, `event:${pendingEventId}`);
        }
        this.db.prepare("UPDATE jobs SET state='cancelled',payload_json='{}',lease_until=NULL,updated_at=? WHERE id=?").run(at, jobId);
      }
      for (const runId of ids('task_run')) this.db.prepare("UPDATE task_runs SET checkpoint_json=NULL,status='cancelled',updated_at=? WHERE id=?").run(at, runId);
      for (const eventId of eventIds) {
        this.db.prepare("DELETE FROM task_signals WHERE source_event_id=? AND signal_type NOT IN ('SYSTEM_REVOKE_SIGNAL','CANCELLATION','PERMISSION_REVOKED')").run(eventId);
        this.db.prepare('DELETE FROM situation_entities WHERE source_event_id=?').run(eventId);
        this.db.prepare('DELETE FROM durable_inbox WHERE id=?').run(eventId);
        this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES(?,?,?)').run('event', this.digest('event', eventId), at);
      }
      for (const situationId of ids('situation')) {
        const remaining = this.db.prepare("SELECT MAX(l.associated_at) at,COUNT(*) n FROM event_situation_links l JOIN source_records s ON s.kind='event' AND s.id=l.event_id AND s.active=1 WHERE l.situation_id=?").get(situationId);
        if (!(kind === 'situation' && id === situationId) && remaining.n) {
          survivingSituations.add(situationId);
          this.db.prepare("UPDATE situations SET lifecycle_state='OBSERVING',summary='Evidence-backed matter',closure_condition_json=?,closure_status='NONE',closure_evidence_json='[]',scope_json='{}',source_watermark_json='{}',superseded_by_situation_id=NULL,next_eval_at=NULL,expires_at=NULL,last_evidence_at=?,updated_at=?,version=version+1 WHERE id=?")
            .run(json({ kind: 'UNSPECIFIED' }), remaining.at, at, situationId);
          for (const row of this.db.prepare("SELECT * FROM tasks WHERE situation_id=? AND status NOT IN ('completed','cancelled')").all(situationId)) {
            if (taskIds.has(row.id)) continue;
            const data = parse(row.data_json), nextVersion = row.input_version + 1;
            this.db.prepare('UPDATE tasks SET input_version=?,dirty=1,run_generation=run_generation+1,privacy_epoch=privacy_epoch+1,version=version+1,updated_at=? WHERE id=?').run(nextVersion, at, row.id);
            this.db.prepare("UPDATE task_runs SET status='cancelled',checkpoint_json=NULL,updated_at=? WHERE task_id=? AND status='running'").run(at, row.id);
            this.jobs.cancelTask(row.id);
            for (const execution of this.db.prepare("SELECT * FROM tool_executions WHERE task_id=? AND is_write=1 AND status IN ('intent','dispatched','accepted','unknown')").all(row.id)) {
              if (execution.status === 'intent') {
                this.db.prepare("UPDATE tool_executions SET status='cancelled',last_error_class='confirmed_no_effect',updated_at=? WHERE id=?").run(at, execution.id);
                this.db.prepare("UPDATE resource_claims SET claim_state='free',lease_owner=NULL,lease_until=NULL,current_execution_id=NULL,owner_task_run_id=NULL WHERE current_execution_id=?").run(execution.id);
              } else {
                this.db.prepare("UPDATE tool_executions SET status='unknown',updated_at=? WHERE id=?").run(at, execution.id);
                this.db.prepare("UPDATE resource_claims SET claim_state='unresolved' WHERE current_execution_id=?").run(execution.id);
                this.jobs.enqueue({ queue: 'effects', type: 'reconcile_execution', key: `privacy-revalidate:${requestId}:${execution.id}`, payload: { executionId: execution.id } });
              }
            }
            this.db.prepare("INSERT OR IGNORE INTO task_signals(id,task_id,signal_type,source_event_id,input_version,created_at) VALUES(?,?,'SYSTEM_REVOKE_SIGNAL',?,?,?)").run(randomUUID(), row.id, requestId, nextVersion, at);
            if (!data.control?.paused && !data.privacyInvalidated) this.jobs.enqueue({ type: 'task_continue', key: `privacy-revalidate:${requestId}:${row.id}`, taskId: row.id, payload: { taskId: row.id, inputVersion: nextVersion } });
          }
        } else {
          this.db.prepare('DELETE FROM tentative_claims WHERE situation_id=?').run(situationId);
          this.db.prepare('DELETE FROM situations WHERE id=?').run(situationId);
        }
      }
      for (const record of preview.records) {
        if (record.kind === 'situation' && survivingSituations.has(record.id)) continue;
        this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES(?,?,?)').run(record.kind, this.digest(record.kind, record.id), at);
        this.db.prepare('UPDATE source_records SET active=0,privacy_epoch=privacy_epoch+1 WHERE kind=? AND id=?').run(record.kind, record.id);
        this.db.prepare('DELETE FROM lineage WHERE source_kind=? AND source_id=? OR derived_kind=? AND derived_id=?').run(record.kind, record.id, record.kind, record.id);
      }
      const snapshot = this.db.prepare('SELECT state_json,version FROM workspace_state WHERE id=1').get();
      if (snapshot) {
        const state = parse(snapshot.state_json);
        state.events = (state.events || []).filter(event => !eventIds.has(event.id));
        state.inbox = (state.inbox || []).filter(message => !messages.has(message.id));
        for (const documentId of docs) delete state.documents?.[documentId];
        for (const recordId of eventRecords) delete state.runRecords?.[recordId];
        for (const taskId of taskIds) {
          const row = this.db.prepare('SELECT data_json FROM tasks WHERE id=?').get(taskId);
          if (row) state.tasks[taskId] = parse(row.data_json);
        }
        const relatedScope = scope => scope?.entity && forgottenScopes.some(item => item.entity === String(scope.entity).toLowerCase() && (!scope.deliverable || !item.deliverable || item.deliverable === String(scope.deliverable).toLowerCase()));
        for (const notice of state.notifications || []) if (taskIds.has(notice.taskId) && notice.clarificationId) removedClarifications.add(notice.clarificationId);
        for (const question of state.clarifications || []) if (taskIds.has(question.taskId) || relatedScope(question.scope)) removedClarifications.add(question.id);
        state.clarifications = (state.clarifications || []).filter(row => !removedClarifications.has(row.id));
        for (const [key, calibration] of Object.entries(state.calibrations || {})) if (taskIds.has(calibration.taskId) || relatedScope(calibration.scope)) delete state.calibrations[key];
        // Older calibration logs have no source IDs. Remove these derived prose
        // summaries conservatively rather than retaining untraceable copies.
        state.history = (state.history || []).filter(row => !taskIds.has(row.taskId) && !eventIds.has(row.eventId) && !(taskIds.size && ['calibration', 'correction'].includes(row.kind)));
        state.trace = (state.trace || []).filter(row => !taskIds.has(row.taskId) && !eventIds.has(row.eventId) && !(taskIds.size && ['calibration', 'correction'].includes(row.kind)));
        state.notifications = (state.notifications || []).filter(row => !taskIds.has(row.taskId) && !removedClarifications.has(row.clarificationId) && !row.opportunityId);
        // Opportunity suggestions are rebuildable derived context. Clearing
        // them avoids retaining unlinked prose copied from a deleted task.
        state.opportunities = {};
        state.outbox = (state.outbox || []).filter(row => !this.db.prepare('SELECT 1 FROM tool_executions WHERE idempotency_key=? AND privacy_redacted=1').get(row.idempotencyKey));
        for (const memoryId of memoryIds) delete state.taskMemories?.[memoryId];
        for (const [directionId, direction] of Object.entries(state.taskDirections || {})) if (directions.has(directionId) || taskIds.has(direction.taskId)) delete state.taskDirections[directionId];
        for (const map of ['documentPatches', 'taskFeedback', 'taskWaits', 'sharedDependencies', 'ownedFollowUps']) for (const [recordId, record] of Object.entries(state[map] || {})) if (taskIds.has(record.taskId) || record.taskIds?.some(taskId => taskIds.has(taskId))) delete state[map][recordId];
        for (const [cursorId, cursor] of Object.entries(state.cursors || {})) {
          if (Object.keys(cursor.documents || {}).some(documentId => docs.has(documentId))) {
            for (const documentId of docs) delete cursor.documents[documentId];
            state.cursors[cursorId] = cursor;
          }
        }
        this.db.prepare('UPDATE workspace_state SET state_json=?,version=version+1 WHERE id=1 AND version=?').run(json(state), snapshot.version);
      }
      for (const row of this.db.prepare('SELECT * FROM notification_deliveries').all()) if (taskIds.has(parse(row.notification_json)?.taskId) || parse(row.notification_json)?.opportunityId || removedClarifications.has(parse(row.notification_json)?.clarificationId)) this.db.prepare('DELETE FROM notification_deliveries WHERE id=?').run(row.id);
      this.db.prepare('DELETE FROM replay_results').run();
      for (const file of this.db.prepare('SELECT * FROM retained_files WHERE delete_on_forget=1').all()) if (file.purpose === 'legacy_migration_backup' || affected.has(keyFor(file.source_kind, file.source_id))) fileIds.push(file.id);
      for (const execution of pendingExecutions) this.jobs.enqueue({ queue: 'effects', type: 'privacy_reconcile', key: `privacy:${requestId}:${execution.id}`, payload: { requestId, executionId: execution.id } });
    });
    this.memory?.invalidate(); this.store?.refresh(); this.onInvalidate({ taskIds: [...taskIds], requestId });
    const status = { counts: preview.counts, localDeletion: 'complete', backupsRemoved: 0, remainingFiles: [], pendingExternal: pendingExecutions,
      externalRetention: pendingExecutions.length ? 'Dispatched operations are being reconciled. External copies are not erased by local deletion.' : 'Existing connector copies and independent provider backups are outside local deletion.',
      forensicErasure: 'Database secure deletion does not guarantee erasure from filesystem snapshots, storage firmware or independent backups.' };
    for (const fileId of fileIds) {
      const file = this.db.prepare('SELECT * FROM retained_files WHERE id=?').get(fileId);
      try {
        if (!file) continue;
        const relative = path.relative(fs.realpathSync(this.fileRoot), fs.realpathSync(file.path));
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw durableError('RETENTION_SCOPE', 'A retained file is outside the owned workspace directory.');
        const stat = fs.lstatSync(file.path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw durableError('RETENTION_SCOPE', 'The retained payload is not an owned regular file.');
        fs.unlinkSync(file.path); status.backupsRemoved++;
        this.database.atomic(() => this.db.prepare('DELETE FROM retained_files WHERE id=?').run(fileId));
      } catch (error) {
        if (error.code === 'ENOENT') this.database.atomic(() => this.db.prepare('DELETE FROM retained_files WHERE id=?').run(fileId));
        else status.remainingFiles.push({ id: fileId, reason: error.code || 'delete_failed' });
      }
    }
    // Write the opaque request status before truncation, so the final WAL is
    // also free of the original personal payload. Readers can defer truncation.
    let checkpoint = this.database.checkpoint();
    status.wal = checkpoint?.busy ? 'waiting_for_readers' : 'truncated';
    const state = status.remainingFiles.length || status.pendingExternal.length || checkpoint?.busy ? 'pending' : 'completed';
    await this.database.write(() => {
      this.db.prepare('UPDATE privacy_requests SET state=?,status_json=?,updated_at=? WHERE id=?').run(state, json(status), iso(this.database.now()), requestId);
      if (state === 'pending') this.jobs.enqueue({ queue: 'privacy', type: 'finish_forget', key: `finish:${requestId}`, payload: { requestId }, availableAt: iso(this.database.now() + 1000) });
    });
    if (!checkpoint?.busy) this.database.checkpoint();
    return this.get(requestId);
  }
  async finish(requestId) {
    const request = this.get(requestId); if (!request || request.state === 'completed') return request;
    const status = request.status;
    const remaining = [];
    for (const entry of status.remainingFiles || []) {
      const file = this.db.prepare('SELECT * FROM retained_files WHERE id=?').get(entry.id); if (!file) continue;
      try {
        const relative = path.relative(fs.realpathSync(this.fileRoot), fs.realpathSync(file.path));
        const stat = fs.lstatSync(file.path);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !stat.isFile() || stat.isSymbolicLink()) throw durableError('RETENTION_SCOPE', 'Retained file is outside owned scope.');
        fs.unlinkSync(file.path); status.backupsRemoved++;
        this.database.atomic(() => this.db.prepare('DELETE FROM retained_files WHERE id=?').run(entry.id));
      } catch (error) {
        if (error.code === 'ENOENT') this.database.atomic(() => this.db.prepare('DELETE FROM retained_files WHERE id=?').run(entry.id));
        else remaining.push({ id: entry.id, reason: error.code || 'delete_failed' });
      }
    }
    status.remainingFiles = remaining;
    status.pendingExternal = status.pendingExternal.filter(execution => ['intent', 'dispatched', 'accepted', 'unknown'].includes(this.db.prepare('SELECT status FROM tool_executions WHERE id=?').get(execution.id)?.status));
    const checkpoint = this.database.checkpoint(); status.wal = checkpoint?.busy ? 'waiting_for_readers' : 'truncated';
    const state = status.remainingFiles.length || status.pendingExternal.length || checkpoint?.busy ? 'pending' : 'completed';
    await this.database.write(() => this.db.prepare('UPDATE privacy_requests SET state=?,status_json=?,updated_at=? WHERE id=?').run(state, json(status), iso(this.database.now()), requestId));
    if (!checkpoint?.busy) this.database.checkpoint(); return this.get(requestId);
  }
}
