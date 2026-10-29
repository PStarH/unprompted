import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONNECTION_PROVIDERS, OAUTH_LOOPBACK_HOST, OAUTH_LOOPBACK_PORT, connectionProvider, oauthRedirectUri, validClientSecret, validPublicClientId } from './connection-catalog.js';
import { providerJSON } from './connectors/http.js';

const TOKEN_LIMIT = 32_000;
const CODE_LIMIT = 4096;

function statesMatch(expected, actual) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(actual || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function page(message) {
  const safe = String(message).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unprompted</title><body><h1>${safe}</h1><p>You can close this window and return to Unprompted.</p></body></html>`;
}

function respond(res, status, message) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(page(message));
}

function authorizeUrlFor(provider, clientId, redirectUri, state, challenge = null) {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (provider.id === 'slack') {
    url.searchParams.set('user_scope', provider.userScope);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  } else {
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('owner', 'user');
  }
  return url.href;
}

function tokenFields(data, now) {
  const accessToken = typeof data?.access_token === 'string' ? data.access_token : data?.authed_user?.access_token;
  const refreshToken = typeof data?.refresh_token === 'string' ? data.refresh_token : data?.authed_user?.refresh_token;
  const expiresIn = Number(data?.expires_in || data?.authed_user?.expires_in);
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > TOKEN_LIMIT || /^xoxb-/i.test(accessToken)) throw new Error('The provider returned an invalid token.');
  if (refreshToken != null && (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > TOKEN_LIMIT)) throw new Error('The provider returned an invalid token.');
  return { accessToken, refreshToken: refreshToken || null, expiresAt: expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : null };
}

async function exchangeSlack(session, code, fetchImpl, now) {
  const data = await providerJSON('https://slack.com/api/oauth.v2.access', { provider: 'slack', origin: 'https://slack.com', fetchImpl, method: 'POST', maxChars: 64_000,
    form: { client_id: session.clientId, code, redirect_uri: session.redirectUri, code_verifier: session.verifier } });
  if (data?.ok !== true) throw new Error('Slack rejected the authorization.');
  const scopes = String(data.authed_user?.scope || '').split(/[,\s]+/).filter(Boolean);
  if (!scopes.includes('im:history')) throw new Error('Slack direct-message history was not granted.');
  return { ...tokenFields(data.authed_user, now), scopes };
}

async function identitySlack(token, fetchImpl) {
  const data = await providerJSON('https://slack.com/api/auth.test', { provider: 'slack', origin: 'https://slack.com', fetchImpl, method: 'POST', maxChars: 16_000,
    headers: { authorization: `Bearer ${token}` } });
  if (data?.ok !== true) throw new Error('Slack did not verify an account identity.');
  const userId = String(data.user_id || '');
  const teamId = String(data.team_id || '');
  const user = String(data.user || '').replace(/[\r\n\t]/g, ' ').trim();
  const team = String(data.team || '').replace(/[\r\n\t]/g, ' ').trim();
  if (!/^U[A-Z0-9]{2,32}$/.test(userId) || !/^T[A-Z0-9]{2,32}$/.test(teamId) || !user || user.length > 120 || team.length > 120) throw new Error('Slack did not verify an account identity.');
  return { id: `${teamId}:${userId}`, label: `${user} · ${team || teamId}`.slice(0, 320), userId, teamId, login: user };
}

async function exchangeNotion(session, code, fetchImpl, now) {
  const data = await providerJSON('https://api.notion.com/v1/oauth/token', { provider: 'notion', origin: 'https://api.notion.com', fetchImpl, method: 'POST', maxChars: 64_000, allowOAuthError: true,
    headers: { authorization: `Basic ${Buffer.from(`${session.clientId}:${session.clientSecret}`).toString('base64')}`, 'Notion-Version': '2022-06-28' },
    body: { grant_type: 'authorization_code', code, redirect_uri: session.redirectUri } });
  if (data?.error) throw new Error('Notion rejected the authorization.');
  const token = tokenFields(data, now);
  const user = data.owner?.type === 'user' ? data.owner.user : null;
  const userId = String(user?.id || '');
  const workspaceId = String(data.workspace_id || '');
  const name = String(user?.name || user?.person?.email || '').replace(/[\r\n\t]/g, ' ').trim();
  const workspace = String(data.workspace_name || '').replace(/[\r\n\t]/g, ' ').trim();
  if (!/^[0-9a-f-]{32,80}$/i.test(userId) || !/^[0-9a-f-]{32,80}$/i.test(workspaceId) || !name || name.length > 200 || !workspace || workspace.length > 200) throw new Error('Notion did not verify an account identity.');
  return { token, account: { id: `${workspaceId}:${userId}`, label: `${name} · ${workspace}`.slice(0, 320), userId, workspaceId } };
}

/** One loopback authorization-code server for providers that require a client secret. */
export class CodeOAuth {
  constructor(setup, { fetchImpl = globalThis.fetch, onConnected = async () => {}, now = Date.now, port = OAUTH_LOOPBACK_PORT } = {}) {
    Object.assign(this, { setup, fetchImpl, onConnected, now, port });
    this.sessions = new Map();
    this.status = new Map();
    this.server = null;
    this.servers = [];
    this.listening = null;
  }

  describe(id) {
    const status = this.status.get(id) || { phase: 'idle' };
    const session = this.sessions.get(id);
    return { phase: status.phase, ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
      ...(session && !session.consumed && status.authorizeUrl ? { authorizeUrl: status.authorizeUrl } : {}) };
  }

  #status(id, phase, authorizeUrl = null) {
    const next = { phase, updatedAt: new Date(this.now()).toISOString() };
    if (authorizeUrl) next.authorizeUrl = authorizeUrl;
    this.status.set(id, next);
  }

  async #listen() {
    if (this.server?.listening) return;
    if (!this.listening) {
      const onRequest = (req, res) => { void this.#callback(req, res); };
      const server = createServer(onRequest);
      this.server = server;
      this.servers = [server];
      this.listening = new Promise((resolve, reject) => {
        const fail = error => {
          if (this.server === server) { this.server = null; this.servers = []; this.listening = null; }
          reject(error);
        };
        server.once('error', fail);
        server.listen(this.port, OAUTH_LOOPBACK_HOST, () => { server.off('error', fail); resolve(); });
      }).then(async () => {
        const v6 = createServer(onRequest);
        try {
          await new Promise((resolve, reject) => {
            v6.once('error', reject);
            v6.listen(server.address().port, '::1', () => { v6.off('error', reject); resolve(); });
          });
          this.servers.push(v6);
        } catch { v6.close(); }
      });
    }
    try { await this.listening; }
    catch (error) {
      if (error.code === 'EADDRINUSE') throw new Error('The local authorization port is already in use. Close the other Unprompted window and try again.');
      throw new Error('Authorization could not start. Check the registered Client ID and Client Secret.');
    }
  }

  #closeServer() {
    const servers = this.servers || [];
    this.server = null;
    this.servers = [];
    this.listening = null;
    for (const server of servers) server.close();
  }

  async start(id, { clientId = null, clientSecret = null, observe = true } = {}) {
    const provider = connectionProvider(id);
    if (provider.flow !== 'code') throw new Error('This provider does not use browser authorization.');
    this.cancel(id);
    const saved = this.setup.getConnection(id);
    const selectedId = clientId == null || clientId === '' ? saved.clientId : clientId;
    const selectedSecret = clientSecret == null || clientSecret === '' ? saved.clientSecret : clientSecret;
    if (!validPublicClientId(selectedId) || !validClientSecret(selectedSecret)) throw new Error('Enter the registered Client ID and Client Secret, not an access token.');
    await this.#listen();
    const redirectUri = oauthRedirectUri(id, this.server.address().port);
    const state = randomBytes(32).toString('hex');
    const verifier = provider.id === 'slack' ? randomBytes(32).toString('base64url') : null;
    const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
    const authorizeUrl = authorizeUrlFor(provider, selectedId, redirectUri, state, challenge);
    try { this.setup.saveConnectionCredentials(id, { clientId: selectedId, clientSecret: selectedSecret }); }
    catch (error) {
      if (this.sessions.size === 0) this.#closeServer();
      throw error;
    }
    const session = { state, verifier, clientId: selectedId, clientSecret: selectedSecret, redirectUri, observe: observe === true, consumed: false, expiresAt: this.now() + 10 * 60_000 };
    session.timer = setTimeout(() => this.#finish(id, session, 'expired'), Math.max(0, session.expiresAt - this.now()));
    session.timer.unref?.();
    this.sessions.set(id, session);
    this.#status(id, 'authorizing', authorizeUrl);
    return this.describe(id);
  }

  async #callback(req, res) {
    let url;
    try { url = new URL(req.url || '/', `http://${OAUTH_LOOPBACK_HOST}`); }
    catch { respond(res, 400, 'This authorization did not match an open connection attempt.'); return; }
    const id = url.pathname.split('/')[2];
    const provider = CONNECTION_PROVIDERS[id];
    if (req.method !== 'GET' || url.pathname !== `/oauth/${id}` || provider?.flow !== 'code') {
      respond(res, 404, 'Not found.'); return;
    }
    const session = this.sessions.get(id);
    if (!session || session.consumed || this.now() >= session.expiresAt || !statesMatch(session.state, url.searchParams.get('state'))) {
      respond(res, 400, 'This authorization did not match an open connection attempt.'); return;
    }
    const denied = url.searchParams.get('error');
    if (denied) {
      this.#finish(id, session, denied === 'access_denied' ? 'cancelled' : 'failed');
      respond(res, 200, 'Authorization was not completed.'); return;
    }
    const code = url.searchParams.get('code');
    if (typeof code !== 'string' || !code || code.length > CODE_LIMIT) {
      this.#finish(id, session, 'failed');
      respond(res, 400, 'The provider did not return an authorization code.'); return;
    }
    session.consumed = true;
    this.#status(id, 'verifying');
    try {
      if (id === 'slack') {
        const token = await exchangeSlack(session, code, this.fetchImpl, this.now());
        const account = await identitySlack(token.accessToken, this.fetchImpl);
        if (this.sessions.get(id) !== session) { respond(res, 409, 'This authorization was cancelled.'); return; }
        this.setup.saveConnectionAuthorization(id, { clientId: session.clientId, clientSecret: session.clientSecret, ...token, account });
      } else {
        const exchanged = await exchangeNotion(session, code, this.fetchImpl, this.now());
        if (this.sessions.get(id) !== session) { respond(res, 409, 'This authorization was cancelled.'); return; }
        this.setup.saveConnectionAuthorization(id, { clientId: session.clientId, clientSecret: session.clientSecret, ...exchanged.token, account: exchanged.account, scopes: [] });
      }
      try { await this.onConnected(id, { observe: session.observe }); }
      catch {
        if (this.sessions.get(id) === session) this.#finish(id, session, 'activation_failed');
        respond(res, 200, 'Authorization is saved. Return to Unprompted to apply the connection.'); return;
      }
      respond(res, 200, 'You can close this window.');
      if (this.sessions.get(id) === session) this.#finish(id, session, 'connected');
    } catch {
      if (this.sessions.get(id) === session) this.#finish(id, session, 'failed');
      respond(res, 400, 'Authorization could not be completed.');
    }
  }

  #finish(id, session, phase) {
    if (this.sessions.get(id) !== session) return;
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(id);
    this.#status(id, phase);
    if (this.sessions.size === 0) this.#closeServer();
  }

  cancel(id) {
    const session = this.sessions.get(id);
    if (session) this.#finish(id, session, 'cancelled');
  }

  close() {
    for (const id of [...this.sessions.keys()]) this.cancel(id);
    this.#closeServer();
  }
}
