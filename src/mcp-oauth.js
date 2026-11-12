import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { findPreset } from './mcp-presets.js';

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/oauth/mcp';
const SESSION_MS = 10 * 60 * 1000;
export const MCP_OAUTH_PORT = 53683;

const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'MCP_OAUTH' });
const loopbackAddress = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function loopbackServerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('MCP sign-in override must use a loopback URL.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw fail('MCP sign-in override must use a loopback URL.');
  return url.href;
}

function publicOAuthError(error) {
  const message = String(error?.message || '');
  if (error?.code === 'EADDRINUSE' || /already in use/i.test(message)) return 'The local authorization port is already in use. Close the other Unprompted window and try again.';
  if (/dynamic client registration/i.test(message)) return 'This service does not support one-click sign-in.';
  if (error?.status === 404 && error?.code === 'MCP_OAUTH') return message;
  if (/MCP SDK unavailable/i.test(message)) return 'MCP SDK unavailable. Run npm ci --include=optional and restart.';
  return 'Sign-in could not start.';
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * OAuth 2.1 sign-in for hosted MCP presets.
 * The browser opens the vendor page. This process only listens on 127.0.0.1.
 * Tokens are written by the manager and are never returned from describe().
 */
export class McpOAuthBroker {
  constructor({ manager, port = MCP_OAUTH_PORT, now = () => Date.now(), onError = null, onAuthorized = null } = {}) {
    this.manager = manager;
    this.port = port;
    this.now = now;
    this.onError = onError;
    this.onAuthorized = onAuthorized;
    this.sessions = new Map();
    this.sessionsById = new Map();
    this.failures = new Map();
    this.server = null;
    this.listening = null;
    this.closed = false;
  }

  view(id) {
    const session = this.sessionsById.get(id);
    if (session && session.expiresAt <= this.now()) this.#drop(id);
    const current = this.sessionsById.get(id);
    if (current) return { phase: 'authorizing', ...(current.authorizeUrl ? { authorizeUrl: current.authorizeUrl } : {}) };
    if (this.failures.has(id)) return { phase: 'failed', error: this.failures.get(id) };
    if (this.manager.configs[id]?.oauth?.tokens?.access_token) return { phase: 'authorized' };
    return { phase: 'idle' };
  }

  async begin(id, { serverUrl } = {}) {
    if (this.closed) throw fail('MCP is shutting down.', 503);
    const preset = findPreset(id);
    if (!preset || preset.auth !== 'oauth') throw fail('Unknown MCP sign-in.', 404);
    const url = serverUrl == null ? preset.config.url : loopbackServerUrl(serverUrl);
    this.failures.delete(id);
    try {
      await this.#listen();
      await this.manager.prepareOAuthServer(id, url);
      const sdk = await this.#sdk();
      const result = await sdk.auth(this.#provider(id, true), { serverUrl: url, fetchFn: globalThis.fetch });
      if (result === 'AUTHORIZED') {
        this.#drop(id);
        await this.manager.finishOAuth(id);
        this.onAuthorized?.();
        return this.view(id);
      }
      const session = this.sessionsById.get(id);
      if (!session?.authorizeUrl) throw new Error('Authorization URL missing');
      return this.view(id);
    } catch (error) {
      if (error?.code === 'MCP_OAUTH' && error.status === 404) throw error;
      this.onError?.(error);
      const message = publicOAuthError(error);
      this.failures.set(id, message);
      const status = error?.code === 'EADDRINUSE' ? 409 : error?.status === 503 ? 503 : error?.status === 409 ? 409 : 400;
      throw fail(message, status);
    }
  }

  async refresh(id) {
    const config = this.manager.configs[id];
    if (!config?.url || !config.oauth?.tokens?.refresh_token) return false;
    try {
      const sdk = await this.#sdk();
      const result = await sdk.auth(this.#provider(id, false), { serverUrl: config.url, fetchFn: globalThis.fetch });
      return result === 'AUTHORIZED';
    } catch (error) {
      this.onError?.(error);
      return false;
    }
  }

  async cancel(id) {
    this.#drop(id);
    this.failures.delete(id);
    const config = this.manager.configs[id];
    if (config && !config.enabled && !config.oauth?.tokens?.access_token) await this.manager.update(id, { remove: true });
    return this.view(id);
  }

  close() {
    this.closed = true;
    this.server?.close();
    this.server = null;
    this.listening = null;
    this.sessions.clear();
    this.sessionsById.clear();
  }

  async #sdk() {
    try { return await this.manager.load(); }
    catch (error) {
      if (error?.status === 503) throw error;
      throw Object.assign(new Error('MCP SDK unavailable. Run npm ci --include=optional and restart.'), { status: 503 });
    }
  }

  #provider(id, interactive) {
    const broker = this;
    const manager = this.manager;
    return {
      get redirectUrl() { return broker.#redirectUrl(); },
      get clientMetadata() {
        const redirectUrl = broker.#redirectUrl();
        return {
          redirect_uris: [redirectUrl],
          client_name: 'Unprompted',
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code']
        };
      },
      state() {
        const state = randomBytes(32).toString('base64url');
        const previous = broker.sessionsById.get(id);
        if (previous) broker.sessions.delete(previous.state);
        const session = { id, state, expiresAt: broker.now() + SESSION_MS, authorizeUrl: null };
        broker.sessions.set(state, session);
        broker.sessionsById.set(id, session);
        return state;
      },
      clientInformation() { return manager.configs[id]?.oauth?.clientInformation; },
      async saveClientInformation(info) { await manager.writeOAuth(id, { clientInformation: plain(info) }); },
      tokens() { return manager.configs[id]?.oauth?.tokens; },
      async saveTokens(tokens) { await manager.writeOAuth(id, { tokens: plain(tokens), codeVerifier: null }); },
      async redirectToAuthorization(authorizationUrl) {
        if (!interactive) throw new Error('Sign-in required');
        const session = broker.sessionsById.get(id);
        if (session) session.authorizeUrl = String(authorizationUrl);
      },
      async saveCodeVerifier(codeVerifier) { await manager.writeOAuth(id, { codeVerifier }); },
      codeVerifier() {
        const codeVerifier = manager.configs[id]?.oauth?.codeVerifier;
        if (!codeVerifier) throw new Error('Sign-in required');
        return codeVerifier;
      },
      async saveDiscoveryState(state) { await manager.writeOAuth(id, { discoveryState: plain(state) }); },
      discoveryState() { return manager.configs[id]?.oauth?.discoveryState; },
      async saveResourceUrl(resourceUrl) { await manager.writeOAuth(id, { resourceUrl }); },
      resourceUrl() { return manager.configs[id]?.oauth?.resourceUrl; },
      async invalidateCredentials(scope) {
        const patch = scope === 'all' ? { clientInformation: null, tokens: null, codeVerifier: null, discoveryState: null, resourceUrl: null }
          : scope === 'client' ? { clientInformation: null, tokens: null }
            : scope === 'tokens' ? { tokens: null }
              : scope === 'verifier' ? { codeVerifier: null }
                : scope === 'discovery' ? { discoveryState: null }
                  : null;
        if (patch) await manager.writeOAuth(id, patch);
      }
    };
  }

  #redirectUrl() {
    const port = this.server?.address?.()?.port;
    if (!port) throw new Error('Sign-in could not start.');
    return `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
  }

  #drop(id) {
    const session = this.sessionsById.get(id);
    if (session) this.sessions.delete(session.state);
    this.sessionsById.delete(id);
  }

  async #listen() {
    if (this.server?.listening) return;
    if (!this.listening) {
      const server = createServer((req, res) => { void this.#callback(req, res); });
      this.server = server;
      this.listening = new Promise((resolve, reject) => {
        const failListen = error => {
          if (this.server === server) { this.server = null; this.listening = null; }
          reject(error);
        };
        server.once('error', failListen);
        server.listen(this.port, LOOPBACK_HOST, () => { server.off('error', failListen); resolve(); });
      });
    }
    try { await this.listening; }
    catch (error) {
      this.listening = null;
      if (error.code === 'EADDRINUSE') throw Object.assign(new Error('The local authorization port is already in use. Close the other Unprompted window and try again.'), { code: 'EADDRINUSE' });
      throw error;
    }
  }

  async #callback(req, res) {
    let serverId = null;
    try {
      if (!loopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Forbidden');
      }
      if (req.method !== 'GET' || String(req.url || '').length > 4096) return this.#page(res, false);
      const url = new URL(req.url, `http://${LOOPBACK_HOST}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Not found');
      }
      const state = url.searchParams.get('state') || '';
      const session = this.sessions.get(state);
      serverId = session?.id || null;
      if (!session || session.expiresAt <= this.now() || url.searchParams.get('error') || !url.searchParams.get('code')) {
        if (session) this.#drop(session.id);
        if (serverId) this.failures.set(serverId, 'Sign-in could not be completed.');
        return this.#page(res, false);
      }
      const code = url.searchParams.get('code');
      if (!/^[\x21-\x7E]{1,2048}$/.test(code)) {
        this.#drop(session.id);
        this.failures.set(session.id, 'Sign-in could not be completed.');
        return this.#page(res, false);
      }
      this.sessions.delete(state);
      this.sessionsById.delete(session.id);
      const iss = url.searchParams.get('iss');
      const sdk = await this.#sdk();
      const result = await sdk.auth(this.#provider(session.id, false), {
        serverUrl: this.manager.configs[session.id].url,
        authorizationCode: code,
        ...(iss ? { iss } : {}),
        fetchFn: globalThis.fetch
      });
      if (result !== 'AUTHORIZED') throw new Error('Sign-in could not be completed.');
      await this.manager.finishOAuth(session.id);
      this.failures.delete(session.id);
      this.onAuthorized?.();
      return this.#page(res, true);
    } catch (error) {
      this.onError?.(error);
      if (serverId) this.failures.set(serverId, 'Sign-in could not be completed.');
      if (!res.headersSent) return this.#page(res, false);
      res.end();
    }
  }

  #page(res, ok) {
    const text = ok
      ? 'You can close this window.'
      : 'Sign-in did not complete. Return to Unprompted and try again.';
    res.writeHead(ok ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
    });
    res.end(`<!doctype html><meta charset="utf-8"><title>Unprompted</title><p>${text}</p>`);
  }
}
