import { createHash } from 'node:crypto';

// A review names the prepared reply, not the workspace's unrelated revision.
export function draftReviewToken(task) {
  if (!task.draft) return null;
  return createHash('sha256').update(JSON.stringify([
    task.id, task.documentId, Number(task.commitment?.revision || 1), task.draft
  ])).digest('hex');
}
