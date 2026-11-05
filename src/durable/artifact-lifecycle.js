import { parse } from './database.js';

/**
 * Artifact lifecycle.
 *
 * The stored artifact row records what was generated and what the user changed.
 * Its lifecycle state is derived here from that row, the owning task and the
 * executions that cite it, so there is one answer to "where is this draft now"
 * without a second status column that could drift.
 */

export const ARTIFACT_STATES = ['draft', 'pending_review', 'edited', 'approved', 'sent', 'uncertain', 'superseded', 'expired', 'discarded'];

/**
 * What can be done about an external effect after it happened.
 *   reversible   - the provider object can be removed with no one else seeing it
 *   compensating - it cannot be undone, only followed by a corrective action
 *   irreversible - other people may already have seen it; only a follow-up helps
 */
export const ACTION_REVERSIBILITY = Object.freeze({
  'email.prepare': { kind: 'reversible', automatic: false, how: 'Discard the local draft.' },
  'email.draft': { kind: 'reversible', automatic: true, how: 'Delete the provider draft before it is sent.' },
  'notion.page.create': { kind: 'reversible', automatic: true, how: 'Archive the created Notion page.' },
  'notes.note.create': { kind: 'reversible', automatic: false, how: 'Delete the note in Apple Notes; automatic removal is not available.' },
  'reminders.reminder.create': { kind: 'reversible', automatic: false, how: 'Delete the reminder in Apple Reminders; automatic removal is not available.' },
  'document.patch': { kind: 'compensating', how: 'Apply a new patch that restores the previous text; collaborators may have seen the change.' },
  'email.send': { kind: 'irreversible', how: 'The message was delivered. Send a correction or follow-up instead.' },
  'context.read': { kind: 'none', how: 'Reads have no external effect.' },
  'evidence.read': { kind: 'none', how: 'Reads have no external effect.' }
});

export function reversibility(actionFamily) {
  return ACTION_REVERSIBILITY[actionFamily] || { kind: 'irreversible', how: 'Unknown action; treat it as permanent.' };
}

const CLOSED = ['completed', 'cancelled'];

/** Derive one artifact's lifecycle state. `executions` are those citing the artifact. */
export function artifactState(artifact, { task = null, executions = [], newer = false } = {}) {
  if (executions.some(item => item.status === 'verified') || artifact.status === 'sent') return 'sent';
  if (executions.some(item => item.status === 'unknown')) return 'uncertain';
  if (executions.some(item => ['intent', 'dispatched', 'accepted'].includes(item.status))) return 'approved';
  if (newer) return 'superseded';
  if (artifact.stale) return 'expired';
  if (!task || task.privacyInvalidated || CLOSED.includes(task.status) || task.userDismissed) return 'discarded';
  if (artifact.status === 'edited') return 'edited';
  if (task.status === 'ready_for_approval') return 'pending_review';
  return 'draft';
}

/** The lifecycle of every artifact a task produced, newest first. */
export function taskArtifactLifecycle(db, taskId, task) {
  const rows = db.prepare('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at DESC, rowid DESC').all(taskId);
  const executions = db.prepare(`SELECT id,action_family,status,provider,provider_receipt_id,effect_signature_json,updated_at FROM tool_executions
    WHERE task_id=? AND is_write=1 ORDER BY created_at`).all(taskId);
  const items = rows.map((artifact, index) => {
    const cited = executions.filter(item => parse(item.effect_signature_json)?.artifactId === artifact.id);
    const state = artifactState(artifact, { task, executions: cited, newer: index > 0 });
    return {
      id: artifact.id, state, generatedVersion: artifact.generated_version, visibleVersion: artifact.visible_version,
      editedByUser: artifact.status === 'edited' || artifact.generated_digest !== artifact.latest_digest, editRatio: artifact.edit_ratio,
      stale: Boolean(artifact.stale), situationVersion: artifact.situation_version, createdAt: artifact.created_at, updatedAt: artifact.updated_at,
      supersededBy: index > 0 ? rows[index - 1].id : null,
      executions: cited.map(item => ({ id: item.id, actionFamily: item.action_family, status: item.status, receipt: item.provider_receipt_id || null, reversibility: reversibility(item.action_family) }))
    };
  });
  // Artifacts created through a grant (Gmail drafts, Notion pages, notes) live
  // on the task; their effect is tracked by the same execution ledger.
  const published = (task?.artifactRequests || []).map(request => {
    const execution = executions.find(item => parse(item.effect_signature_json)?.requestId === request.id);
    return { id: request.id, family: request.family, connectorId: request.connectorId, status: request.status === 'undone' ? 'undone' : execution?.status || request.status,
      receipt: execution?.provider_receipt_id || null, reversibility: reversibility(request.family) };
  });
  return { taskId, artifacts: items, published };
}
