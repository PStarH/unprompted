// Explicit source fields only: credentials, cursors and connector configuration
// must never become searchable/model context through a generic JSON dump.
export function eventContext(event) {
  const payload = event?.payload || {};
  const document = event?.type?.startsWith('document.');
  const titleField = document || ['issue.updated', 'pull_request.updated', 'task.observed'].includes(event?.type) ? 'title' : 'subject';
  const bodyField = document ? 'content' : 'body';
  return { subject: String(payload[titleField] || payload.title || ''), body: String(payload[bodyField] || ''), titleField, bodyField };
}
