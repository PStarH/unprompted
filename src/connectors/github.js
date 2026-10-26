import { createHash } from 'node:crypto';
import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { providerJSON } from './http.js';

const API = 'https://api.github.com';
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);

export class GitHubConnector extends Connector {
  constructor({ auth, account, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    super({ id: 'github', kind: 'github', fetchImpl });
    Object.assign(this, { auth, account, now, live: Boolean(account?.id && auth), shadow: true });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['GitHub authorization'], detail: 'Read assigned issues from repositories authorized to the app.' }; }
  async #request(url, signal) {
    return providerJSON(url, { provider: this.id, origin: API, fetchImpl: this.fetchImpl, signal,
      headers: { authorization: `Bearer ${await this.auth.accessToken()}`, 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'Unprompted' } });
  }
  #event(issue, restoredAfter = null) {
    const repository = issue.repository?.full_name || String(issue.repository_url || '').replace(/^https:\/\/api\.github\.com\/repos\//, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(issue.number)
      || !issue.id || typeof issue.title !== 'string' || !Number.isFinite(Date.parse(issue.updated_at))) throw new ConnectorError('GitHub returned an invalid issue.', { connectorId: this.id });
    const assigned = (issue.assignees || []).some(user => String(user.id) === String(this.account.id));
    const payload = { id: `github:${this.account.id}:${issue.id}`, title: issue.title.slice(0, 1000), body: String(issue.body || '').slice(0, 8000),
      bodyTruncated: String(issue.body || '').length > 8000,
      repository, number: issue.number, state: issue.state === 'closed' ? 'closed' : 'open', assigned,
      assignee: this.account.login, accountId: String(this.account.id), updatedAt: new Date(issue.updated_at).toISOString(),
      url: `https://github.com/${repository}/issues/${issue.number}`, author: String(issue.user?.login || 'GitHub'),
      providerIssueId: String(issue.id) };
    return toNormalizedEvents(this.id, 'github', [{ type: 'issue.updated',
      providerEventId: `issue:${this.account.id}:${issue.id}:${signature(payload)}${restoredAfter ? `:available:${signature(restoredAfter)}` : ''}`, at: payload.updatedAt, payload }])[0];
  }
  async pull({ cursor = null } = {}) {
    if (!this.live) throw new ConnectorError('GitHub is disconnected.', { connectorId: this.id });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const window = cursor?.window || new Date(this.now()).toISOString();
      const page = Number.isSafeInteger(cursor?.page) && cursor.page > 0 ? cursor.page : 1;
      const query = new URLSearchParams({ filter: 'assigned', state: 'all', sort: 'updated', direction: 'desc', per_page: '100', page: String(page) });
      if (cursor?.since) query.set('since', cursor.since);
      const issues = await this.#request(`${API}/issues?${query}`, controller.signal);
      if (!Array.isArray(issues)) throw new ConnectorError('GitHub returned an invalid issue listing.', { connectorId: this.id });
      const events = [], errors = [], tracked = { ...(cursor?.tracked || {}) };
      const seen = new Set();
      for (const issue of issues) {
        if (issue.pull_request) continue;
        const known = cursor?.tracked?.[`github:${this.account.id}:${issue.id}`];
        const event = this.#event(issue, known?.unavailableAt); events.push(event); seen.add(event.payload.id);
        if (event.payload.assigned && event.payload.state === 'open') tracked[event.payload.id] = { repository: event.payload.repository, number: event.payload.number };
        else delete tracked[event.payload.id];
      }
      // Assignment-filtered listings cannot report an issue reassigned away.
      // Recheck a bounded rotating subset so old work is eventually withdrawn.
      const candidates = Object.entries(tracked).filter(([id]) => !seen.has(id));
      const start = candidates.length ? Number(cursor?.recheck || 0) % candidates.length : 0;
      for (let index = 0; index < Math.min(candidates.length, 20); index++) {
        const [id, known] = candidates[(start + index) % candidates.length];
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(known.repository) || !Number.isSafeInteger(known.number)) continue;
        try {
          const issue = await this.#request(`${API}/repos/${known.repository}/issues/${known.number}`, controller.signal);
          const event = this.#event({ ...issue, repository: { full_name: known.repository } }, known.unavailableAt); events.push(event);
          if (!event.payload.assigned || event.payload.state === 'closed') delete tracked[id];
          else tracked[id] = { repository: known.repository, number: known.number };
        } catch (error) {
          if (error.status === 404) {
            if (known.unavailable) continue;
            const payload = { id, title: `${known.repository} #${known.number}`, body: '', repository: known.repository, number: known.number,
              state: 'unavailable', assigned: false, accountId: String(this.account.id), assignee: this.account.login,
              updatedAt: new Date(this.now()).toISOString(), url: `https://github.com/${known.repository}/issues/${known.number}`, author: 'GitHub' };
            events.push(toNormalizedEvents(this.id, 'github', [{ type: 'issue.updated', providerEventId: `unavailable:${id}:${payload.updatedAt}`, at: payload.updatedAt, payload }])[0]);
            tracked[id] = { ...known, unavailable: true, unavailableAt: payload.updatedAt };
          } else {
            errors.push({ scope: 'issues', message: error.message, retryable: error.retryable });
            if (error.rateLimited) break;
          }
        }
      }
      const ids = Object.keys(tracked);
      if (ids.length > 500) throw new ConnectorError('GitHub has more than 500 open assigned issues. Narrow the app repository access before syncing.', { connectorId: this.id });
      const next = issues.length === 100 ? { since: cursor?.since || null, page: page + 1, window }
        : { since: window, page: 1, window: null };
      return { events, errors, partial: errors.length > 0,
        cursor: errors.length ? cursor : { ...next, tracked, recheck: candidates.length ? (start + 20) % candidates.length : 0 } };
    } finally { clearTimeout(timer); }
  }
}
