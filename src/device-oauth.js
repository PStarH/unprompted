import { connectionProvider, validPublicClientId } from './connection-catalog.js';
import { providerJSON } from './connectors/http.js';
import { retryAfterMs } from './reasoning-recovery.js';

const identityHeaders = (provider, token) => ({ authorization: `Bearer ${token}`,
  ...(provider === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'Unprompted' } : {}) });

export async function providerIdentity(providerId, token, { fetchImpl = globalThis.fetch, signal } = {}) {
  const provider = connectionProvider(providerId);
  const data = await providerJSON(provider.identityUrl, { provider: providerId, origin: new URL(provider.identityUrl).origin,
    fetchImpl, signal, headers: identityHeaders(providerId, token), maxChars: 64_000 });
  const id = String(data?.id || '');
  const label = providerId === 'github' ? data.login : data.mail || data.userPrincipalName;
  if (!id || id.length > 512 || typeof label !== 'string' || !label.trim() || label.length > 320) throw new Error('The provider did not verify an account identity.');
  return { id, label: label.trim(), ...(providerId === 'github' ? { login: data.login } : {}) };
}

/** One cancellable device authorization per provider; tokens never reach the UI. */
export class DeviceOAuth {
  constructor(setup, { fetchImpl = globalThis.fetch, onConnected = async () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { setup, fetchImpl, onConnected, now, setTimer, clearTimer });
    this.sessions = new Map(); this.status = new Map();
  }

  describe(id) { return { ...(this.status.get(id) || { phase: 'idle' }) }; }
  #status(id, phase, values = {}) { this.status.set(id, { phase, updatedAt: new Date(this.now()).toISOString(), ...values }); }

  async start(id, { clientId = null, observe = true, drafts = false } = {}) {
    const provider = connectionProvider(id);
    this.cancel(id);
    const configured = this.setup.getConnection(id);
    const selected = clientId == null ? configured.pendingClientId || configured.clientId : clientId;
    if (!validPublicClientId(selected)) throw new Error('Enter the registered public Client ID, not an access token or secret.');
    const session = { controller: new AbortController(), clientId: selected, observe: observe === true, drafts: drafts === true, timer: null };
    this.sessions.set(id, session); this.#status(id, 'starting');
    try {
      const response = await providerJSON(provider.deviceUrl, { provider: id, origin: new URL(provider.deviceUrl).origin,
        fetchImpl: this.fetchImpl, method: 'POST', signal: session.controller.signal,
        form: { client_id: selected, ...(provider.scope ? { scope: `${provider.scope}${id === 'microsoft' && drafts === true ? ' Mail.ReadWrite' : ''}` } : {}) }, maxChars: 32_000, allowOAuthError: true });
      if (this.sessions.get(id) !== session) return this.describe(id);
      if (response.error) throw new Error('The provider rejected device authorization.');
      const verification = new URL(response.verification_uri);
      if (verification.protocol !== 'https:' || !provider.verificationHosts.includes(verification.hostname) || verification.username || verification.password) throw new Error('The provider returned an invalid authorization URL.');
      if (typeof response.device_code !== 'string' || response.device_code.length > 8192 || !response.device_code
        || typeof response.user_code !== 'string' || !/^[A-Za-z0-9 -]{4,32}$/.test(response.user_code)
        || !(Number(response.expires_in) > 0)) throw new Error('The provider returned an invalid authorization response.');
      session.deviceCode = response.device_code;
      const interval = Number(response.interval);
      session.intervalMs = Number.isFinite(interval) && interval > 0 ? Math.max(5000, interval * 1000) : 5000;
      session.expiresAt = this.now() + Math.min(1800, Number(response.expires_in)) * 1000;
      this.setup.saveConnectionClient(id, selected);
      this.#status(id, 'authorizing', { userCode: response.user_code, authorizeUrl: verification.href, expiresAt: new Date(session.expiresAt).toISOString() });
      this.#schedule(id, session);
      return this.describe(id);
    } catch (error) {
      if (this.sessions.get(id) !== session) return this.describe(id);
      this.sessions.delete(id); this.#status(id, 'failed', { code: 'AUTH_START_FAILED' });
      throw new Error('Authorization could not start. Check the registered Client ID and enable device authorization for the app.');
    }
  }

  #schedule(id, session) {
    session.timer = this.setTimer(() => { session.timer = null; void this.#poll(id, session); }, Math.min(session.intervalMs, Math.max(0, session.expiresAt - this.now())));
    session.timer?.unref?.();
  }

  async #poll(id, session) {
    if (this.sessions.get(id) !== session) return;
    if (this.now() >= session.expiresAt) { this.#finish(id, session, 'expired'); return; }
    const provider = connectionProvider(id);
    try {
      const data = await providerJSON(provider.tokenUrl, { provider: id, origin: new URL(provider.tokenUrl).origin,
        fetchImpl: this.fetchImpl, method: 'POST', signal: session.controller.signal, maxChars: 64_000, allowOAuthError: true,
        form: { client_id: session.clientId, device_code: session.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
      if (this.sessions.get(id) !== session) return;
      if (data.error === 'authorization_pending') { this.#schedule(id, session); return; }
      if (data.error === 'slow_down') {
        const interval = Number(data.interval);
        session.intervalMs = Math.max(session.intervalMs + 5000, Number.isFinite(interval) && interval > 0 ? interval * 1000 : 0);
        this.#schedule(id, session); return;
      }
      if (data.error) { this.#finish(id, session, data.error === 'access_denied' || data.error === 'authorization_declined' ? 'cancelled' : data.error === 'expired_token' ? 'expired' : 'failed'); return; }
      if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 32_000) throw new Error('Invalid token response.');
      if (id === 'microsoft' && !String(data.scope || '').split(/\s+/).some(scope => /(?:^|\/)Mail\.Read(?:Write)?$/i.test(scope))) throw new Error('Mail read access was not granted.');
      if (id === 'microsoft' && session.drafts && !String(data.scope || '').split(/\s+/).some(scope => /(?:^|\/)Mail\.ReadWrite$/i.test(scope))) throw new Error('Mail draft access was not granted.');
      this.#status(id, 'verifying');
      const account = await providerIdentity(id, data.access_token, { fetchImpl: this.fetchImpl, signal: session.controller.signal });
      if (this.sessions.get(id) !== session) return;
      this.setup.saveConnectionAuthorization(id, { clientId: session.clientId, accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
        expiresAt: Number(data.expires_in) > 0 ? new Date(this.now() + Number(data.expires_in) * 1000).toISOString() : null,
        account, scopes: String(data.scope || '').split(/[\s,]+/).filter(Boolean) });
      try { await this.onConnected(id, { observe: session.observe }); }
      catch { if (this.sessions.get(id) === session) this.#finish(id, session, 'activation_failed'); return; }
      if (this.sessions.get(id) === session) this.#finish(id, session, 'connected');
    } catch (error) {
      if (this.sessions.get(id) !== session) return;
      if (error.retryable && this.now() < session.expiresAt) {
        session.intervalMs = Math.max(session.intervalMs, retryAfterMs(error.retryAfter, this.now()) || 10_000);
        this.#schedule(id, session); return;
      }
      this.#finish(id, session, 'failed');
    }
  }

  #finish(id, session, phase) {
    if (this.sessions.get(id) !== session) return;
    if (session.timer) this.clearTimer(session.timer);
    session.controller.abort(); this.sessions.delete(id); this.#status(id, phase);
  }

  cancel(id) {
    const session = this.sessions.get(id);
    if (session) this.#finish(id, session, 'cancelled');
  }
  close() { for (const id of this.sessions.keys()) this.cancel(id); }
}

/** Refresh only this exact saved account. A late refresh cannot restore a grant. */
export class SavedConnectionAuth {
  constructor(setup, id, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    Object.assign(this, { setup, id, fetchImpl, now }); this.pending = null;
    this.accountId = setup.getConnection(id).account?.id; this.disabled = false;
  }
  async accessToken() {
    if (this.disabled) throw new Error('This connection is disconnected.');
    const saved = this.setup.getConnection(this.id);
    if (!saved.accessToken || saved.account?.id !== this.accountId) throw new Error('Reconnect this account.');
    if (!saved.expiresAt || Date.parse(saved.expiresAt) > this.now() + 60_000) return saved.accessToken;
    if (!saved.refreshToken) throw new Error('The connection expired. Reconnect this account.');
    if (this.pending) return this.pending;
    this.pending = this.#refresh(saved).finally(() => { this.pending = null; });
    return this.pending;
  }
  async #refresh(saved) {
    const provider = connectionProvider(this.id);
    const origin = new URL(provider.tokenUrl).origin;
    let data;
    if (provider.flow === 'code' && this.id === 'notion') {
      if (!saved.clientSecret) throw new Error('The connection expired. Reconnect this account.');
      data = await providerJSON(provider.tokenUrl, { provider: this.id, origin, fetchImpl: this.fetchImpl, method: 'POST', maxChars: 64_000, allowOAuthError: true,
        headers: { authorization: `Basic ${Buffer.from(`${saved.clientId}:${saved.clientSecret}`).toString('base64')}`, 'Notion-Version': '2022-06-28' },
        body: { grant_type: 'refresh_token', refresh_token: saved.refreshToken } });
    } else if (provider.flow === 'code') {
      if (this.id !== 'slack' && !saved.clientSecret) throw new Error('The connection expired. Reconnect this account.');
      data = await providerJSON(provider.tokenUrl, { provider: this.id, origin, fetchImpl: this.fetchImpl, method: 'POST', maxChars: 64_000, allowOAuthError: true,
        form: { client_id: saved.clientId, grant_type: 'refresh_token', refresh_token: saved.refreshToken, ...(this.id === 'slack' ? {} : { client_secret: saved.clientSecret }) } });
      if (data?.ok === false || data?.token_type === 'bot') throw new Error('The connection expired. Reconnect this account.');
    } else {
      data = await providerJSON(provider.tokenUrl, { provider: this.id, origin, fetchImpl: this.fetchImpl, method: 'POST', maxChars: 64_000, allowOAuthError: true,
        form: { client_id: saved.clientId, grant_type: 'refresh_token', refresh_token: saved.refreshToken } });
    }
    const accessToken = typeof data?.access_token === 'string' ? data.access_token : data?.authed_user?.access_token;
    const refreshToken = data?.refresh_token || data?.authed_user?.refresh_token;
    const expiresIn = Number(data?.expires_in || data?.authed_user?.expires_in);
    if (data?.error || !accessToken) throw new Error('The connection expired. Reconnect this account.');
    data = { ...data, access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
    const current = this.setup.getConnection(this.id);
    if (this.disabled || current.account?.id !== saved.account.id || current.refreshToken !== saved.refreshToken) throw new Error('The connection changed while refreshing.');
    this.setup.saveConnectionAuthorization(this.id, { ...current, accessToken: data.access_token,
      refreshToken: data.refresh_token || current.refreshToken,
      scopes: typeof data.scope === 'string' ? data.scope.split(/[\s,]+/).filter(Boolean) : current.scopes,
      expiresAt: Number(data.expires_in) > 0 ? new Date(this.now() + Number(data.expires_in) * 1000).toISOString() : null });
    return data.access_token;
  }
}
