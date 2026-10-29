import { createHash } from 'node:crypto';
import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { providerJSON } from './http.js';

const API = 'https://api.github.com';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,250}$/;
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const githubUrl = (value, suffix) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && url.pathname.startsWith('/') && url.pathname.includes(suffix)) return url.href;
  } catch { /* build a canonical URL from the validated identifiers */ }
  return null;
};

export class GitHubConnector extends Connector {
  constructor({ auth, account, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    super({ id: 'github', kind: 'github', fetchImpl });
    Object.assign(this, { auth, account, now, live: Boolean(account?.id && auth), shadow: true });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['GitHub authorization'], detail: 'Read assigned issues, pull request reviews, repository commits and Actions runs from repositories authorized to the app.' }; }
  capabilities() {
    const read = ['github.assigned_issues', 'github.pull_request_reviews', 'github.repository_changes', 'github.workflow_runs'];
    return { ...super.capabilities(), read: this.live ? read : [], pagination: this.live ? read : [], incremental: this.live ? read : [], observation: this.live ? 'poll' : 'none' };
  }
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
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: null });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 1, unavailable: false };
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
      const issueCursor = errors.length ? { since: cursor?.since || null, page: cursor?.page || 1, window: cursor?.window || null, tracked: cursor?.tracked || {}, recheck: cursor?.recheck || 0 }
        : { ...next, tracked, recheck: candidates.length ? (start + 20) % candidates.length : 0 };
      const pagingIssues = issues.length === 100 && errors.length === 0;
      const extra = pagingIssues
        ? { events: [], errors: [], hasMore: false, reviews: cursor?.reviews || { tracked: {} }, repository: cursor?.repository || null }
        : await this.#pullWork(cursor, controller.signal);
      const allErrors = [...errors, ...extra.errors];
      return { events: [...events, ...extra.events], errors: allErrors, partial: allErrors.length > 0,
        hasMore: pagingIssues || extra.hasMore === true,
        cursor: { ...issueCursor, reviews: extra.reviews, repository: extra.repository } };
    } finally { clearTimeout(timer); }
  }
  async #pullWork(cursor, signal) {
    const reviews = await this.#pullReviews(cursor, signal);
    const repository = await this.#pullRepositoryWork(cursor, signal);
    return { events: [...reviews.events, ...repository.events], errors: [...reviews.errors, ...repository.errors], hasMore: repository.hasMore === true, reviews: reviews.cursor, repository: repository.cursor };
  }
  async #pullReviews(cursor, signal) {
    const tracked = { ...(cursor?.reviews?.tracked || {}) }, events = [], errors = [], seen = new Set();
    for (const [work, q] of [['review_requested', 'is:pr is:open review-requested:@me'], ['changes_requested', 'is:pr is:open author:@me review:changes_requested']]) {
      try {
        const data = await this.#request(`${API}/search/issues?${new URLSearchParams({ q, sort: 'updated', order: 'desc', per_page: '20' })}`, signal);
        if (!Array.isArray(data?.items)) throw new ConnectorError('GitHub returned an invalid pull request listing.', { connectorId: this.id });
        for (const item of data.items) {
          const event = this.#reviewEvent(item, work);
          if (!event) continue;
          events.push(event); seen.add(event.payload.id);
          tracked[event.payload.id] = { repository: event.payload.repository, number: event.payload.number, work };
        }
      } catch (error) {
        errors.push({ scope: 'pull_requests', message: error.message, retryable: error.retryable === true });
        if (error.rateLimited) break;
      }
    }
    const missing = Object.entries(tracked).filter(([id]) => !seen.has(id)).slice(0, 10);
    for (const [id, known] of missing) {
      if (!REPOSITORY.test(known.repository) || !Number.isSafeInteger(known.number)) { delete tracked[id]; continue; }
      try {
        const pull = await this.#request(`${API}/repos/${known.repository}/pulls/${known.number}`, signal);
        const stillRequested = known.work === 'review_requested' && [pull.requested_reviewers, pull.requested_teams].flat().filter(Boolean).some(user => String(user.id) === String(this.account.id));
        let changesRequested = false;
        if (known.work === 'changes_requested' && pull.state === 'open') {
          const feedback = await this.#request(`${API}/repos/${known.repository}/pulls/${known.number}/reviews?per_page=20`, signal);
          changesRequested = Array.isArray(feedback) && feedback.some(review => review.state === 'CHANGES_REQUESTED' && String(review.user?.id) !== String(this.account.id));
        }
        const active = pull.state === 'open' && !pull.merged && (stillRequested || changesRequested);
        const event = this.#reviewEvent({ ...pull, repository_url: `${API}/repos/${known.repository}`, updated_at: pull.updated_at }, known.work, !active);
        if (event) events.push(event);
        if (!active) delete tracked[id];
      } catch (error) {
        if (error.status === 404) {
          const payload = { id, title: `${known.repository} #${known.number}`, body: '', repository: known.repository, number: known.number, state: 'unavailable', active: false, work: known.work,
            accountId: String(this.account.id), author: 'GitHub', updatedAt: new Date(this.now()).toISOString(), url: `https://github.com/${known.repository}/pull/${known.number}` };
          events.push(toNormalizedEvents(this.id, 'github', [{ type: 'pull_request.updated', providerEventId: `unavailable:${id}:${payload.updatedAt}`, at: payload.updatedAt, payload }])[0]);
          delete tracked[id];
        } else { errors.push({ scope: 'pull_requests', message: error.message, retryable: error.retryable === true }); if (error.rateLimited) break; }
      }
    }
    return { events, errors, cursor: errors.length ? (cursor?.reviews || { tracked: {} }) : { tracked } };
  }
  #reviewEvent(item, work, withdrawn = false) {
    const repository = this.#repoName(String(item.repository_url || '').replace(/^https:\/\/api\.github\.com\/repos\//, ''));
    const parsed = Date.parse(item.updated_at);
    if (!repository || !Number.isSafeInteger(item.number) || !item.id || typeof item.title !== 'string' || !Number.isFinite(parsed)) return null;
    const updatedAt = new Date(parsed).toISOString();
    const state = withdrawn || item.state === 'closed' || item.merged ? 'closed' : 'open';
    const payload = { id: `github:${this.account.id}:pr:${item.id}`, title: item.title.slice(0, 1000), body: String(item.body || '').slice(0, 8000),
      bodyTruncated: String(item.body || '').length > 8000, repository, number: item.number, state, active: state === 'open', work, accountId: String(this.account.id),
      author: String(item.user?.login || 'GitHub'), updatedAt, url: githubUrl(item.html_url, `/pull/${item.number}`) || `https://github.com/${repository}/pull/${item.number}` };
    return toNormalizedEvents(this.id, 'github', [{ type: 'pull_request.updated', providerEventId: `pr:${this.account.id}:${item.id}:${signature(payload)}`, at: updatedAt, payload }])[0];
  }
  async #pullRepositoryWork(cursor, signal) {
    const since = cursor?.repository?.since || new Date(this.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const page = Number.isSafeInteger(cursor?.repository?.page) && cursor.repository.page > 0 ? cursor.repository.page : 1;
    const previous = cursor?.repository || { since, page: 1 };
    let repos;
    try { repos = await this.#request(`${API}/user/repos?${new URLSearchParams({ sort: 'pushed', per_page: '5', page: String(page) })}`, signal); }
    catch (error) { return { events: [], errors: [{ scope: 'repository', message: error.message, retryable: error.retryable === true }], hasMore: false, cursor: previous }; }
    if (!Array.isArray(repos)) return { events: [], errors: [{ scope: 'repository', message: 'GitHub returned an invalid repository listing.', retryable: false }], hasMore: false, cursor: previous };
    const events = [], errors = [];
    for (const repo of repos) {
      const name = this.#repoName(repo?.full_name);
      const branch = typeof repo?.default_branch === 'string' && BRANCH.test(repo.default_branch) ? repo.default_branch : null;
      if (!name || !branch || !Number.isFinite(Date.parse(repo.pushed_at)) || Date.parse(repo.pushed_at) < Date.parse(since)) continue;
      await this.#pullCommits(name, branch, since, signal, events, errors);
      await this.#pullRuns(name, since, signal, events, errors);
      if (errors.some(error => error.rateLimited)) break;
    }
    const hasMore = repos.length === 5 && errors.length === 0;
    return { events, errors, hasMore, cursor: errors.length ? previous : hasMore ? { since, page: page + 1 } : { since: new Date(this.now()).toISOString(), page: 1 } };
  }
  async #pullCommits(repository, branch, since, signal, events, errors) {
    try {
      const commits = await this.#request(`${API}/repos/${repository}/commits?${new URLSearchParams({ sha: branch, since, per_page: '5' })}`, signal);
      if (!Array.isArray(commits)) throw new ConnectorError('GitHub returned an invalid commit listing.', { connectorId: this.id });
      for (const commit of commits) {
        if (!SHA.test(commit?.sha || '')) continue;
        const detail = await this.#request(`${API}/repos/${repository}/commits/${commit.sha}`, signal);
        const event = this.#commitEvent(repository, detail);
        if (event) events.push(event);
      }
    } catch (error) { errors.push({ scope: 'contents', message: error.message, retryable: error.retryable === true, rateLimited: error.rateLimited === true }); }
  }
  #commitEvent(repository, commit) {
    const sha = commit?.sha;
    const parsed = Date.parse(commit?.commit?.author?.date || commit?.commit?.committer?.date);
    if (!SHA.test(sha || '') || !Number.isFinite(parsed)) return null;
    const updatedAt = new Date(parsed).toISOString();
    const message = String(commit.commit?.message || '').slice(0, 4000);
    const files = Array.isArray(commit.files) ? commit.files.map(file => file?.filename).filter(name => typeof name === 'string' && name.length > 0 && name.length <= 300 && !name.includes('..')).slice(0, 30) : [];
    const title = message.split('\n', 1)[0].slice(0, 1000) || sha.slice(0, 7);
    const payload = { id: `github:${this.account.id}:commit:${sha}`, title, body: [message, files.length ? `Files:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n').slice(0, 8000),
      repository, sha, files, marker: sha.slice(0, 7), state: 'open', active: true, work: 'commit', accountId: String(this.account.id),
      author: String(commit.author?.login || commit.commit?.author?.name || 'GitHub'), updatedAt, url: githubUrl(commit.html_url, `/commit/${sha}`) || `https://github.com/${repository}/commit/${sha}` };
    return toNormalizedEvents(this.id, 'github', [{ type: 'content.changed', providerEventId: `commit:${this.account.id}:${sha}`, at: updatedAt, payload }])[0];
  }
  async #pullRuns(repository, since, signal, events, errors) {
    try {
      const data = await this.#request(`${API}/repos/${repository}/actions/runs?${new URLSearchParams({ per_page: '10' })}`, signal);
      const runs = data?.workflow_runs;
      if (!Array.isArray(runs)) throw new ConnectorError('GitHub returned an invalid Actions listing.', { connectorId: this.id });
      for (const run of runs) {
        if (!Number.isFinite(Date.parse(run.updated_at)) || Date.parse(run.updated_at) < Date.parse(since)) continue;
        const event = this.#runEvent(repository, run);
        if (event) events.push(event);
      }
    } catch (error) { errors.push({ scope: 'actions', message: error.message, retryable: error.retryable === true, rateLimited: error.rateLimited === true }); }
  }
  #runEvent(repository, run) {
    const updatedAt = new Date(run.updated_at).toISOString();
    if (!Number.isSafeInteger(run.id) || typeof run.name !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return null;
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion : run.status || 'changed';
    const payload = { id: `github:${this.account.id}:run:${run.id}`, title: `${run.name}: ${conclusion}`.slice(0, 1000),
      body: [`Workflow: ${run.name}`, `Status: ${run.status || 'unknown'}`, `Conclusion: ${run.conclusion || 'pending'}`, `Branch: ${String(run.head_branch || '').slice(0, 200)}`, `Event: ${String(run.event || '').slice(0, 80)}`].join('\n').slice(0, 8000),
      repository, runId: run.id, marker: run.name.slice(0, 80), state: 'open', active: true, work: 'workflow', status: String(run.status || ''), conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      accountId: String(this.account.id), author: String(run.triggering_actor?.login || run.actor?.login || 'GitHub'), updatedAt,
      url: githubUrl(run.html_url, '/actions/runs/') || `https://github.com/${repository}/actions/runs/${run.id}` };
    return toNormalizedEvents(this.id, 'github', [{ type: 'workflow.updated', providerEventId: `workflow:${this.account.id}:${run.id}:${signature(payload)}`, at: updatedAt, payload }])[0];
  }
  #repoName(value) { return REPOSITORY.test(value) ? value : null; }
}
