import { withOAuthScopes } from './oauth-scopes.js';
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONNECTION_PROVIDERS, OAUTH_LOOPBACK_HOST, OAUTH_LOOPBACK_PORT, connectionProvider, oauthRedirectUri, validClientSecret, validPublicClientId, validSlackRedirectUri } from './connection-catalog.js';
import { providerJSON } from './connectors/http.js';
import { providerIdentity } from './device-oauth.js';

const TOKEN_LIMIT = 32_000;
const CODE_LIMIT = 4096;

function statesMatch(expected, actual) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(actual || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function page(message) {
  const safe = String(message).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const connected = message === 'You can close this window.';
  const saved = message === 'Authorization is saved. Return to Unprompted to apply the connection.';
  const title = connected ? 'Connection complete' : saved ? 'Almost there' : safe;
  const detail = connected ? 'Your account is connected. You can close this window and return to Unprompted.'
    : saved ? 'Your authorization was saved. Return to Unprompted to finish setting up the connection.'
      : 'Return to Unprompted to review your connection and try again.';
  const symbol = connected ? '&#10003;' : '!';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Unprompted</title>
<style>
  :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", sans-serif; color: #18202b; background: #e7e8e4; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
  main { width: min(100%, 480px); background: #f8f9f7; border: 1px solid #d6d9d6; border-radius: 16px; box-shadow: 0 18px 50px #18202b12; overflow: hidden; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 22px 28px; border-bottom: 1px solid #e2e4e1; font-size: 15px; font-weight: 650; letter-spacing: -.03em; }
  .brand-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: #f8f9f7; background: #18202b; }
  .content { padding: 48px 32px 52px; }
  .status { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; background: #d3dff2; color: #405572; font-size: 25px; font-weight: 600; }
  h1 { margin: 25px 0 12px; font-size: clamp(26px, 6vw, 32px); line-height: 1.15; letter-spacing: -.04em; font-weight: 650; }
  p { max-width: 34ch; margin: 0; color: #59636e; font-size: 15px; line-height: 1.65; }
  @media (max-width: 420px) { body { padding: 16px; } .brand { padding: 20px 22px; } .content { padding: 38px 24px 42px; } }
</style></head><body><main><div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" width="22" height="22" focusable="false"><path d="M18 17v20c0 18 28 18 28 0V28" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><circle cx="46" cy="14" r="5" fill="currentColor"/></svg></span>unprompted.</div><div class="content"><div class="status" aria-hidden="true">${symbol}</div><h1>${title}</h1><p>${detail}</p></div></main></body></html>`;
}

function respond(res, status, message) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
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
  } else if (provider.id === 'microsoft') {
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', provider.scope);
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
  constructor(setup, { fetchImpl = globalThis.fetch, onConnected = async () => {}, now = Date.now, port = OAUTH_LOOPBACK_PORT, slackPublicClient = null } = {}) {
    if (slackPublicClient && (!validPublicClientId(slackPublicClient.clientId) || !validSlackRedirectUri(slackPublicClient.redirectUri))) throw new Error('Invalid Slack public client redirect.');
    Object.assign(this, { setup, fetchImpl, onConnected, now, port, slackPublicClient });
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

  async start(id, { clientId = null, clientSecret = null, observe = true, channels = false, drafts = false, scopes = [] } = {}) {
    const provider = connectionProvider(id);
    if (provider.flow !== 'code' && id !== 'microsoft') throw new Error('This provider does not use browser authorization.');
    this.cancel(id);
    const saved = this.setup.getConnection(id);
    const selectedId = clientId == null || clientId === '' ? saved.pendingClientId || saved.clientId : clientId;
    const selectedSecret = clientSecret == null || clientSecret === '' ? saved.clientSecret : clientSecret;
    if (!validPublicClientId(selectedId) || (id !== 'microsoft' && (id !== 'slack' || selectedSecret != null) && !validClientSecret(selectedSecret))) throw new Error('Enter the registered Client ID and Client Secret, not an access token.');
    await this.#listen();
    const redirectUri = id === 'slack' && this.slackPublicClient?.clientId === selectedId
      ? this.slackPublicClient.redirectUri : oauthRedirectUri(id, this.server.address().port);
    const state = randomBytes(32).toString('hex');
    const verifier = ['slack', 'microsoft'].includes(provider.id) ? randomBytes(32).toString('base64url') : null;
    const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
    let requestedProvider = id === 'slack' && !channels ? { ...provider, userScope: provider.userScope.split(',').filter(scope => !/^(channels|groups):/.test(scope)).join(',') } : provider;
    if (id === 'slack') requestedProvider = { ...requestedProvider, userScope: withOAuthScopes(requestedProvider.userScope, scopes).join(',') };
    if (id === 'microsoft') requestedProvider = { ...requestedProvider, scope: withOAuthScopes(`${provider.scope}${drafts ? ' Mail.ReadWrite' : ''}`, scopes).join(' ') };
    const authorizeUrl = authorizeUrlFor(requestedProvider, selectedId, redirectUri, state, challenge);
    try { if (id === 'microsoft') this.setup.saveConnectionClient(id, selectedId); else this.setup.saveConnectionCredentials(id, { clientId: selectedId, clientSecret: selectedSecret }); }
    catch (error) {
      if (this.sessions.size === 0) this.#closeServer();
      throw error;
    }
    const session = { state, verifier, clientId: selectedId, clientSecret: selectedSecret, redirectUri, observe: observe === true, drafts: drafts === true, consumed: false, expiresAt: this.now() + 10 * 60_000 };
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
    if (req.method !== 'GET' || url.pathname !== `/oauth/${id}` || (provider?.flow !== 'code' && id !== 'microsoft')) {
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
      } else if (id === 'microsoft') {
        const data = await providerJSON(provider.tokenUrl, { provider: id, origin: new URL(provider.tokenUrl).origin,
          fetchImpl: this.fetchImpl, method: 'POST', maxChars: 64_000, allowOAuthError: true,
          form: { client_id: session.clientId, grant_type: 'authorization_code', code, redirect_uri: session.redirectUri, code_verifier: session.verifier } });
        if (data.error) throw new Error('Microsoft rejected the authorization.');
        const scopes = String(data.scope || '').split(/[\s,]+/).filter(Boolean);
        if (!scopes.some(scope => /(?:^|\/)Mail\.Read(?:Write)?$/i.test(scope)) || (session.drafts && !scopes.some(scope => /(?:^|\/)Mail\.ReadWrite$/i.test(scope)))) throw new Error('Required mail access was not granted.');
        if (this.sessions.get(id) !== session) { respond(res, 409, 'This authorization was cancelled.'); return; }
        const token = tokenFields(data, this.now());
        const account = await providerIdentity(id, token.accessToken, { fetchImpl: this.fetchImpl });
        if (this.sessions.get(id) !== session) { respond(res, 409, 'This authorization was cancelled.'); return; }
        this.setup.saveConnectionAuthorization(id, { clientId: session.clientId, ...token, account, scopes });
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
