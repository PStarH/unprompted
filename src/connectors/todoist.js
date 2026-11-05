import { Connector, ConnectorError } from './connector.js';
import { providerJSON } from './http.js';
import { taskSnapshot } from './task-snapshot.js';
const ORIGIN = 'https://api.todoist.com';
export async function todoistIdentity(token, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw new Error('Enter your Todoist personal API token.');
  const user = await providerJSON(`${ORIGIN}/api/v1/user`, { provider: 'todoist', origin: ORIGIN, fetchImpl, signal, headers: { authorization: `Bearer ${token}` } });
  if (!user?.id || typeof user.email !== 'string' || !user.email) throw new Error('Todoist did not verify an account identity.');
  return { id: String(user.id), label: user.email.slice(0, 320) };
}
export class TodoistConnector extends Connector {
  constructor({ auth, account, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    super({ id: 'todoist', kind: 'todoist', fetchImpl });
    Object.assign(this, { auth, account, now, live: Boolean(auth && account?.id), shadow: true });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Todoist personal API token'], detail: 'Observe explicit tasks with a personal token; no developer application registration.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['todoist.tasks'] : [], pagination: this.live ? ['todoist.tasks'] : [], observation: this.live ? 'poll' : 'none' }; }
  async pull({ cursor = null, signal } = {}) {
    if (!this.live) throw new ConnectorError('Todoist is disconnected.', { connectorId: this.id });
    const params = new URLSearchParams({ limit: '100' });
    if (cursor?.pageToken) params.set('cursor', cursor.pageToken);
    const page = await providerJSON(`${ORIGIN}/api/v1/tasks?${params}`, { provider: this.id, origin: ORIGIN, fetchImpl: this.fetchImpl, signal, headers: { authorization: `Bearer ${await this.auth.accessToken()}` } });
    if (!Array.isArray(page?.results) || page.next_cursor && (typeof page.next_cursor !== 'string' || page.next_cursor === cursor?.pageToken)) throw new ConnectorError('Todoist returned an invalid task page.', { connectorId: this.id });
    const items = page.results.map(item => {
      if (typeof item.id !== 'string' || !item.id || typeof item.content !== 'string' || !item.content.trim() || !Number.isFinite(Date.parse(item.updated_at || item.added_at))) throw new ConnectorError('Todoist returned an incomplete task.', { connectorId: this.id });
      return { id: item.id, title: item.content.slice(0, 500), body: String(item.description || '').slice(0, 8000), updatedAt: item.updated_at || item.added_at,
        state: item.is_deleted ? 'unavailable' : item.checked || item.is_completed ? 'closed' : 'open', dueAt: item.due?.datetime || item.due?.date || null,
        list: 'Todoist', url: `https://app.todoist.com/app/task/${encodeURIComponent(item.id)}` };
    });
    const seen = [...new Set([...(cursor?.seen || []), ...items.map(item => item.id)])];
    if (seen.length > 10000) throw new ConnectorError('Todoist task scan exceeds 10,000 items.', { connectorId: this.id });
    const result = taskSnapshot({ connectorId: this.id, accountId: this.account.id, items, cursor, seen, complete: !page.next_cursor, now: this.now });
    return { ...result, partial: false, hasMore: Boolean(page.next_cursor), cursor: { ...result.cursor, ...(page.next_cursor ? { pageToken: page.next_cursor, seen } : {}) } };
  }
}
