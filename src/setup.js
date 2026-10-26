import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { connectionProvider, validPublicClientId } from './connection-catalog.js';
import { readRegularFile } from './local-files.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 15_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_STATE = Object.freeze({
  version: 1,
  restartRequired: false,
  model: { baseUrl: null, model: null, apiKey: null, harness: 'classic', role: 'primary', lastValidation: null },
  connections: {},
  nativeSources: {},
  monitoring: {
    enabled: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    userConfigured: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastOutcome: null,
    lastExpiredAt: null,
    lastError: null
  },
  google: {
    clientId: null,
    clientSecret: null,
    refreshToken: null,
    accountEmail: null,
    accountId: null,
    scopes: { readGmail: true, readDrive: true, docsWrite: false, gmailSend: false },
    grantedScopes: [],
    authorizationState: 'not_configured',
    authorizedAt: null,
    lastValidation: null
  },
  permissions: { allowExternalWrites: false }
});

export function defaultSetupDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.UNPROMPTED_CONFIG_DIR) return path.resolve(env.UNPROMPTED_CONFIG_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Unprompted');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Unprompted');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'unprompted');
}

export function googleWorkspacePath(directory, accountId) {
  const suffix = accountId ? `-${createHash('sha256').update(`google:${accountId}`).digest('hex').slice(0, 24)}` : '';
  return path.join(directory, `google${suffix}-state.json`);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validText(value, max = 8192) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }

function normalise(state) {
  const result = clone(DEFAULT_STATE);
  if (!state || typeof state !== 'object' || Array.isArray(state)) return result;
  result.version = 1;
  result.restartRequired = state.restartRequired === true;
  if (state.model && typeof state.model === 'object') result.model = { ...result.model, ...state.model };
  for (const id of ['github', 'microsoft']) {
    const saved = state.connections?.[id];
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) result.connections[id] = { ...saved };
  }
  if (state.nativeSources && typeof state.nativeSources === 'object') {
    for (const id of ['local_files', 'apple_notes']) {
      const saved = state.nativeSources[id];
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) result.nativeSources[id] = {
        scopeId: typeof saved.scopeId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(saved.scopeId) ? saved.scopeId : null,
        roots: Array.isArray(saved.roots) ? saved.roots.slice(0, 10).filter(item => item && typeof item.id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(item.id) && typeof item.path === 'string' && path.isAbsolute(item.path)).map(item => ({ id: item.id, path: item.path, label: String(item.label || path.basename(item.path)).slice(0, 250) })) : [],
        folders: Array.isArray(saved.folders) ? saved.folders.slice(0, 20).filter(item => item && typeof item.accountId === 'string' && item.accountId.length <= 4096 && typeof item.folderId === 'string' && item.folderId.length <= 4096).map(item => ({ accountId: item.accountId, folderId: item.folderId, label: String(item.label || 'Notes').slice(0, 250), accountLabel: String(item.accountLabel || 'Notes').slice(0, 250) })) : []
      };
    }
  }
  if (state.monitoring && typeof state.monitoring === 'object') {
    result.monitoring = { ...result.monitoring, ...state.monitoring };
    result.monitoring.enabled = result.monitoring.enabled === true;
    const interval = Number(result.monitoring.intervalMs);
    result.monitoring.intervalMs = Number.isFinite(interval)
      ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(interval)))
      : DEFAULT_INTERVAL_MS;
  }
  if (state.google && typeof state.google === 'object') result.google = { ...result.google, ...state.google };
  if (state.google?.scopes && typeof state.google.scopes === 'object') {
    result.google.scopes = {
      readGmail: state.google.scopes.readGmail === true,
      readDrive: state.google.scopes.readDrive === true,
      docsWrite: state.google.scopes.docsWrite === true,
      gmailSend: state.google.scopes.gmailSend === true
    };
  }
  if (Array.isArray(state.google?.grantedScopes)) result.google.grantedScopes = state.google.grantedScopes.filter(value => typeof value === 'string');
  if (state.permissions && typeof state.permissions === 'object') result.permissions = { allowExternalWrites: state.permissions.allowExternalWrites === true };
  return result;
}

/**
 * User-level local configuration. Secret values are written only to this
 * 0600 file and every browser-facing method returns a redacted projection.
 */
export class LocalSetupStore {
  constructor({ filePath = null, env = process.env } = {}) {
    this.directory = filePath ? path.dirname(path.resolve(filePath)) : defaultSetupDirectory(env);
    this.filePath = filePath ? path.resolve(filePath) : path.join(this.directory, 'setup.json');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.directory, 0o700); } catch { /* best effort on filesystems without POSIX modes */ }
    this.#read();
  }

  #read() {
    try {
      this.state = normalise(JSON.parse(readRegularFile(this.filePath, { mode: 0o600 })));
    } catch (error) {
      if (error.code === 'ENOENT') this.state = clone(DEFAULT_STATE);
      else if (error instanceof SyntaxError) throw new Error('The local setup file is invalid JSON; move it aside to restore defaults.');
      else throw error;
    }
  }

  #write(next) {
    const state = normalise(next);
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort */ }
    fs.renameSync(temporary, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
    this.state = state;
    return clone(state);
  }

  get() { this.#read(); return clone(this.state); }

  saveModel(settings, validation) {
    return this.#write({ ...this.get(), model: { ...settings, lastValidation: validation } });
  }

  clearModel() {
    return this.#write({ ...this.get(), model: clone(DEFAULT_STATE.model) });
  }

  getConnection(id) { connectionProvider(id); return { ...(this.get().connections[id] || {}) }; }

  getNativeSource(id) {
    if (!['local_files', 'apple_notes'].includes(id)) throw new Error('Unknown native source.');
    return clone(this.get().nativeSources[id] || { scopeId: null, roots: [], folders: [] });
  }
  saveNativeSource(id, selection) {
    this.getNativeSource(id);
    return this.#write({ ...this.get(), nativeSources: { ...this.get().nativeSources, [id]: selection } });
  }
  clearNativeSource(id) {
    this.getNativeSource(id);
    const next = this.get(); delete next.nativeSources[id]; return this.#write(next);
  }

  saveConnectionClient(id, clientId) {
    connectionProvider(id);
    if (!validPublicClientId(clientId)) throw new Error('A public application Client ID is required; do not enter an access token.');
    const state = this.get();
    const old = state.connections[id] || {};
    const next = old.accessToken && old.clientId !== clientId ? { ...old, pendingClientId: clientId } : { ...old, clientId };
    return this.#write({ ...state, connections: { ...state.connections, [id]: next } });
  }

  saveConnectionAuthorization(id, authorization) {
    connectionProvider(id);
    if (!validText(authorization?.accessToken, 32_000) || !validText(authorization?.account?.id, 512)
      || !validText(authorization?.account?.label, 320)) throw new Error('A verified provider account is required.');
    const state = this.get();
    return this.#write({ ...state, connections: { ...state.connections, [id]: {
      clientId: authorization.clientId, accessToken: authorization.accessToken,
      refreshToken: authorization.refreshToken || null, expiresAt: authorization.expiresAt || null,
      account: { ...authorization.account }, scopes: Array.isArray(authorization.scopes) ? authorization.scopes : [],
      authorizedAt: state.connections[id]?.account?.id === authorization.account.id ? state.connections[id].authorizedAt : new Date().toISOString()
    } } });
  }

  clearConnection(id) {
    connectionProvider(id);
    const state = this.get(), clientId = state.connections[id]?.clientId;
    return this.#write({ ...state, connections: { ...state.connections, [id]: clientId ? { clientId } : {} } });
  }

  setMonitoring(patch) {
    const current = this.get();
    return this.#write({ ...current, monitoring: { ...current.monitoring, ...patch } });
  }

  saveDesktopClientJson(text) {
    if (!validText(text, 64 * 1024)) throw new Error('Choose a valid Google Desktop OAuth client JSON file.');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('The selected OAuth client file is not valid JSON.'); }
    if (parsed?.web) throw new Error('This is a Web OAuth client. Choose a Desktop app client from Google Cloud.');
    const client = parsed?.installed;
    if (!client || !validText(client.client_id, 512) || !validText(client.client_secret, 1024)) {
      throw new Error('The file must contain an installed Desktop OAuth client_id and client_secret.');
    }
    const authUri = client.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth';
    const tokenUri = client.token_uri || 'https://oauth2.googleapis.com/token';
    if (authUri !== 'https://accounts.google.com/o/oauth2/v2/auth' || tokenUri !== 'https://oauth2.googleapis.com/token') {
      throw new Error('The OAuth endpoints must be Google’s official authorization and token endpoints.');
    }
    const current = this.get();
    const changed = current.google.clientId !== client.client_id || current.google.clientSecret !== client.client_secret;
    const google = {
      ...current.google,
      clientId: client.client_id.trim(),
      clientSecret: client.client_secret.trim(),
      authorizationState: changed || !current.google.refreshToken ? 'client_saved' : current.google.authorizationState
    };
    if (changed) {
      google.refreshToken = null;
      google.accountEmail = null;
      google.accountId = null;
      google.grantedScopes = [];
      google.authorizedAt = null;
      google.lastValidation = null;
    }
    return this.#write({
      ...current,
      restartRequired: current.restartRequired || (changed && Boolean(current.google.refreshToken)),
      google,
      permissions: changed ? { allowExternalWrites: false } : current.permissions
    });
  }

  saveAuthorization({ refreshToken, accountEmail = null, accountId = null, grantedScopes = [] }) {
    if (!validText(refreshToken, 8192)) throw new Error('Google did not return a refresh token.');
    const current = this.get();
    if (!current.google.clientId || !current.google.clientSecret) throw new Error('Save a Google Desktop OAuth client before authorizing.');
    const accountChanged = current.google.accountId !== accountId;
    return this.#write({
      ...current,
      restartRequired: true,
      permissions: accountChanged ? { allowExternalWrites: false } : current.permissions,
      google: {
        ...current.google,
        refreshToken,
        accountEmail: validText(accountEmail, 320) ? accountEmail : null,
        accountId: validText(accountId, 320) ? accountId : null,
        grantedScopes: Array.isArray(grantedScopes) ? grantedScopes.filter(scope => typeof scope === 'string') : [],
        authorizationState: 'authorized_pending_restart',
        authorizedAt: new Date().toISOString(),
        lastValidation: null
      }
    });
  }

  setGoogleValidation({ ok, error = null } = {}) {
    const current = this.get();
    const validation = {
      status: ok === true ? 'validated' : 'failed',
      at: new Date().toISOString(),
      error: ok === true ? null : String(error || 'Google authorization could not be validated.').slice(0, 240)
    };
    return this.#write({ ...current, google: { ...current.google, lastValidation: validation } });
  }

  setGoogleScopes(scopes = {}) {
    const selected = {
      readGmail: scopes.readGmail === true,
      readDrive: scopes.readDrive === true,
      docsWrite: scopes.docsWrite === true,
      gmailSend: scopes.gmailSend === true
    };
    if (selected.docsWrite && !selected.readDrive) throw new Error('Google Docs write access also requires Drive read access for version checks.');
    if (!Object.values(selected).some(Boolean)) throw new Error('Choose at least one Google access scope.');
    const current = this.get();
    const changed = JSON.stringify(selected) !== JSON.stringify(current.google.scopes || {});
    const google = { ...current.google, scopes: selected, authorizationState: current.google.refreshToken && changed ? 'reauthorization_required' : current.google.authorizationState };
    return this.#write({ ...current, restartRequired: current.restartRequired || (current.google.refreshToken && changed), google });
  }

  markGoogleRuntimeActive() {
    const current = this.get();
    if (!current.google.refreshToken) return current;
    const granted = new Set(current.google.grantedScopes || []);
    const scopes = current.google.scopes || {};
    const missingGrant = [
      scopes.readGmail ? 'https://www.googleapis.com/auth/gmail.readonly' : null,
      scopes.readDrive ? 'https://www.googleapis.com/auth/drive.readonly' : null,
      scopes.docsWrite ? 'https://www.googleapis.com/auth/documents' : null,
      scopes.gmailSend ? 'https://www.googleapis.com/auth/gmail.send' : null
    ].filter(Boolean).some(scope => !granted.has(scope));
    if (missingGrant) {
      return this.#write({
        ...current,
        restartRequired: false,
        google: { ...current.google, authorizationState: 'reauthorization_required' }
      });
    }
    if (!current.restartRequired && current.google.authorizationState === 'connected') return current;
    return this.#write({ ...current, restartRequired: false, google: { ...current.google, authorizationState: 'connected' } });
  }

  setExternalWrites(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('allowExternalWrites must be a boolean.');
    const current = this.get();
    const granted = new Set(current.google.grantedScopes || []);
    if (enabled && !((current.google.scopes?.gmailSend && granted.has('https://www.googleapis.com/auth/gmail.send'))
      || (current.google.scopes?.docsWrite && granted.has('https://www.googleapis.com/auth/documents')))) {
      throw new Error('Request the Gmail send or Google Docs write scope before enabling external writes.');
    }
    return this.#write({ ...current, restartRequired: current.restartRequired || current.permissions.allowExternalWrites !== enabled, permissions: { allowExternalWrites: enabled } });
  }

  clearGoogle({ keepClient = false } = {}) {
    const current = this.get();
    const hadLocalAuthorization = Boolean(current.google.clientId || current.google.refreshToken || current.permissions.allowExternalWrites);
    return this.#write({ ...current, restartRequired: current.restartRequired || hadLocalAuthorization,
      google: { ...clone(DEFAULT_STATE.google), ...(keepClient ? { clientId: current.google.clientId, clientSecret: current.google.clientSecret, authorizationState: 'client_saved' } : {}) }, permissions: { allowExternalWrites: false } });
  }

  clearRestartRequired() {
    const current = this.get();
    return current.restartRequired ? this.#write({ ...current, restartRequired: false }) : current;
  }

  resetObservationHistory() {
    const current = this.get();
    return this.#write({ ...current, monitoring: { ...clone(DEFAULT_STATE.monitoring),
      enabled: current.monitoring.enabled, intervalMs: current.monitoring.intervalMs,
      userConfigured: current.monitoring.userConfigured } });
  }

  runtimeEnv(env = process.env) {
    const output = { ...env };
    const model = this.get().model;
    if (!output.UNPROMPTED_MODEL_BASE_URL && !output.UNPROMPTED_MODEL_NAME && model.baseUrl && model.model) {
      output.UNPROMPTED_MODEL_BASE_URL = model.baseUrl;
      output.UNPROMPTED_MODEL_NAME = model.model;
      delete output.UNPROMPTED_MODEL_API_KEY;
      if (model.apiKey) output.UNPROMPTED_MODEL_API_KEY = model.apiKey;
      output.UNPROMPTED_AGENT_HARNESS = model.harness;
      output.UNPROMPTED_MODEL_ROLE = model.role;
    }
    const google = this.get().google;
    for (const [key, value] of Object.entries({
      GOOGLE_CLIENT_ID: google.clientId,
      GOOGLE_CLIENT_SECRET: google.clientSecret,
      GOOGLE_REFRESH_TOKEN: google.refreshToken,
      GOOGLE_ACCOUNT_EMAIL: google.accountEmail
    })) {
      // Explicit process configuration remains authoritative.
      if (!env.GOOGLE_REFRESH_TOKEN && output[key] == null && value) output[key] = value;
    }
    const granted = new Set(google.grantedScopes || []);
    const scopes = google.scopes || {};
    const requestedGmailRead = scopes.readGmail === true && granted.has('https://www.googleapis.com/auth/gmail.readonly');
    const requestedDriveRead = scopes.readDrive === true && granted.has('https://www.googleapis.com/auth/drive.readonly');
    const requestedSend = scopes.gmailSend === true && granted.has('https://www.googleapis.com/auth/gmail.send');
    const requestedDocsWrite = scopes.docsWrite === true && granted.has('https://www.googleapis.com/auth/documents');
    if (output.GOOGLE_READ_GMAIL == null && google.refreshToken && !env.GOOGLE_REFRESH_TOKEN) output.GOOGLE_READ_GMAIL = requestedGmailRead ? 'true' : 'false';
    if (output.GOOGLE_READ_DRIVE == null && google.refreshToken && !env.GOOGLE_REFRESH_TOKEN) output.GOOGLE_READ_DRIVE = requestedDriveRead ? 'true' : 'false';
    if (output.GOOGLE_SEND_ENABLED == null && google.refreshToken && !env.GOOGLE_REFRESH_TOKEN) output.GOOGLE_SEND_ENABLED = requestedSend ? 'true' : 'false';
    if (output.GOOGLE_DOCS_WRITE_ENABLED == null && google.refreshToken && !env.GOOGLE_REFRESH_TOKEN) output.GOOGLE_DOCS_WRITE_ENABLED = requestedDocsWrite ? 'true' : 'false';
    if (google.refreshToken && !env.GOOGLE_REFRESH_TOKEN) {
      // For accounts connected in the UI, launch settings may restrict access
      // but cannot expand the account's selected/granted permissions.
      output.GOOGLE_READ_GMAIL = requestedGmailRead && env.GOOGLE_READ_GMAIL !== 'false' ? 'true' : 'false';
      output.GOOGLE_READ_DRIVE = requestedDriveRead && env.GOOGLE_READ_DRIVE !== 'false' ? 'true' : 'false';
      output.GOOGLE_SEND_ENABLED = requestedSend && env.GOOGLE_SEND_ENABLED !== 'false' ? 'true' : 'false';
      output.GOOGLE_DOCS_WRITE_ENABLED = requestedDocsWrite && env.GOOGLE_DOCS_WRITE_ENABLED !== 'false' ? 'true' : 'false';
      output.UNPROMPTED_SHADOW_MODE = env.UNPROMPTED_SHADOW_MODE === 'true' || !this.get().permissions.allowExternalWrites ? 'true' : 'false';
    }
    if (output.UNPROMPTED_SHADOW_MODE == null) output.UNPROMPTED_SHADOW_MODE = !env.GOOGLE_REFRESH_TOKEN && this.get().permissions.allowExternalWrites ? 'false' : 'true';
    return output;
  }

  publicStatus({ runtime = null, monitoring = null, connectorStatus = null } = {}) {
    const state = this.get();
    const google = state.google;
    const hasClient = Boolean(google.clientId && google.clientSecret);
    const hasRefreshToken = Boolean(google.refreshToken);
    const restartRequired = state.restartRequired === true;
    const lastSyncAt = connectorStatus?.lastSyncAt || null;
    const validationAt = google.lastValidation?.at || null;
    const latestSyncAfterValidation = lastSyncAt && (!validationAt || Date.parse(lastSyncAt) > Date.parse(validationAt));
    const granted = new Set(google.grantedScopes || []);
    const selectedScopes = google.scopes || {};
    const missingRequestedScope = hasRefreshToken && [
      selectedScopes.readGmail ? 'https://www.googleapis.com/auth/gmail.readonly' : null,
      selectedScopes.readDrive ? 'https://www.googleapis.com/auth/drive.readonly' : null,
      selectedScopes.docsWrite ? 'https://www.googleapis.com/auth/documents' : null,
      selectedScopes.gmailSend ? 'https://www.googleapis.com/auth/gmail.send' : null
    ].filter(Boolean).some(scope => !granted.has(scope));
    const connectionStatus = missingRequestedScope ? 'reauthorization_required'
      : hasRefreshToken && restartRequired ? 'restart_required'
      : !runtime?.live ? (hasRefreshToken ? 'configured_unverified' : 'not_configured')
      : latestSyncAfterValidation ? (connectorStatus?.ok ? 'sync_ok' : 'sync_failed')
        : google.lastValidation?.status === 'validated' ? 'validated' : 'configured_unverified';
    return {
      fileProtection: '0600',
      model: { baseUrl: state.model.baseUrl, model: state.model.model, hasApiKey: Boolean(state.model.apiKey), harness: state.model.harness, role: state.model.role, lastValidation: state.model.lastValidation },
      monitoring: monitoring || { ...state.monitoring },
      google: {
        hasClient,
        hasRefreshToken,
        accountEmail: google.accountEmail || null,
        authorizationState: google.authorizationState,
        authorizedAt: google.authorizedAt,
        requestedScopes: { ...(google.scopes || {}) },
        grantedScopes: [...(google.grantedScopes || [])],
        configuredThisRun: Boolean(runtime?.live),
        connectionStatus,
        lastSyncAt,
        lastValidationAt: validationAt,
        lastValidationStatus: google.lastValidation?.status || null,
        lastValidationError: google.lastValidation?.error || null,
        restartRequired,
        allowExternalWrites: state.permissions.allowExternalWrites === true,
        readOnly: runtime ? Boolean(runtime.shadow) : true,
        sendEnabled: Boolean(runtime?.report?.google?.sendEnabled)
      }
    };
  }
}

function secureStateMatch(expected, actual) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(actual || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function callbackPage(message, { locale = 'en', returnUrl = null } = {}) {
  const zh = locale === 'zh-CN';
  const safe = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const labels = {
    'Google is connected.': 'Google 已连接。',
    'Google authorization is saved.': 'Google 授权已保存。',
    'Google authorization was not completed.': 'Google 授权已取消。',
    'Google authorization could not be completed.': 'Google 授权未完成。',
    'Your account is authorized. Return to Unprompted to retry connecting.': '账号已授权，请返回 Unprompted 重试连接。'
  };
  let target = null;
  try {
    const url = new URL(returnUrl);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password) target = url.origin + '/';
  } catch { /* standalone setup has no parent application */ }
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unprompted · Google</title><style>body{font:16px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:2rem;color:#283e35;background:#f8f9f7}h1{font-size:2rem;letter-spacing:-.04em}a{display:inline-block;background:#283e35;color:white;padding:.75rem 1.25rem;border-radius:.6rem;text-decoration:none}p{color:#5f6d66}</style><body><small>unprompted.</small><h1>${safe(zh ? labels[message] || message : message)}</h1><p>${zh ? '连接状态会自动更新。你可以关闭此窗口，回到自己的工作空间。' : 'Your connection status updates automatically. You can close this window and return to your workspace.'}</p>${target ? `<a href="${safe(target)}" target="_blank" rel="noopener">${zh ? '回到工作空间' : 'Return to your workspace'}</a><script>if(window.opener)window.opener.postMessage({type:'unprompted:google-connection'},${JSON.stringify(new URL(target).origin)})</script>` : ''}</body></html>`;
}

/** A short-lived loopback OAuth callback server using PKCE and a random state. */
export class GoogleOAuthSetup {
  constructor(store, { fetchImpl = globalThis.fetch, timeoutMs = 5 * 60_000, exchangeTimeoutMs = 15_000, onAuthorized = null } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.exchangeTimeoutMs = exchangeTimeoutMs;
    this.onAuthorized = onAuthorized;
    this.active = null;
    this.status = { phase: 'idle', message: null, updatedAt: null };
  }

  describe() { return { ...this.status, authorizeUrl: this.active && !this.active.consumed ? this.active.authorizeUrl : null }; }

  async start({ scopes: requested = null, observe = true, allowExternalWrites = false, locale = 'en', returnUrl = null } = {}) {
    this.cancel('restarted');
    const config = this.store.get().google;
    if (!config.clientId || !config.clientSecret) throw new Error('Choose a valid Google Desktop OAuth client first.');
    const scopes = this.store.setGoogleScopes(requested || config.scopes).google.scopes;
    const state = randomBytes(24).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authUri = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
      }
      if (!secureStateMatch(state, url.searchParams.get('state'))) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(callbackPage('Google authorization response did not match this setup session.'));
        return;
      }
      if (this.active?.consumed) {
        res.writeHead(409, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(callbackPage('This Google authorization response was already used.'));
        return;
      }
      void this.#finish({ res, url, state, verifier });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}/`;
    authUri.searchParams.set('client_id', config.clientId);
    authUri.searchParams.set('redirect_uri', redirectUri);
    authUri.searchParams.set('response_type', 'code');
    const scopeUris = [
      'openid', 'email',
      scopes.readGmail ? 'https://www.googleapis.com/auth/gmail.readonly' : null,
      scopes.readDrive ? 'https://www.googleapis.com/auth/drive.readonly' : null,
      scopes.docsWrite ? 'https://www.googleapis.com/auth/documents' : null,
      scopes.gmailSend ? 'https://www.googleapis.com/auth/gmail.send' : null
    ].filter(Boolean);
    authUri.searchParams.set('scope', scopeUris.join(' '));
    authUri.searchParams.set('access_type', 'offline');
    authUri.searchParams.set('prompt', 'consent');
    authUri.searchParams.set('state', state);
    authUri.searchParams.set('code_challenge', challenge);
    authUri.searchParams.set('code_challenge_method', 'S256');
    const timer = setTimeout(() => {
      this.status = { phase: 'expired', message: 'Google authorization expired. Start again when ready.', updatedAt: new Date().toISOString() };
      this.#closeActive();
    }, this.timeoutMs);
    timer.unref?.();
    this.active = { server, timer, state, verifier, config: { clientId: config.clientId, clientSecret: config.clientSecret }, scopes, observe: observe === true, allowExternalWrites: allowExternalWrites === true,
      locale: locale === 'zh-CN' ? 'zh-CN' : 'en', returnUrl, authorizeUrl: authUri.toString(), controller: null, consumed: false };
    this.status = { phase: 'authorizing', message: 'Waiting for Google authorization.', updatedAt: new Date().toISOString() };
    return { authorizeUrl: authUri.toString() };
  }

  async #finish({ res, url, state, verifier }) {
    const active = this.active;
    if (!active || active.consumed || !secureStateMatch(active.state, url.searchParams.get('state'))) return;
    // Consume the callback state before awaiting the token endpoint. Replays
    // cannot start a second exchange with the same authorization code.
    active.consumed = true;
    active.response = res;
    if (url.searchParams.has('error')) {
      const denied = url.searchParams.get('error');
      this.status = { phase: denied === 'access_denied' ? 'cancelled' : 'failed', code: denied === 'admin_policy_enforced' ? 'GOOGLE_ADMIN_BLOCKED' : 'GOOGLE_CONSENT_CANCELLED', message: 'Google authorization was not completed.', updatedAt: new Date().toISOString() };
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(callbackPage('Google authorization was not completed.', active));
      this.#closeActive(); return;
    }
    const code = url.searchParams.get('code');
    if (!validText(code, 4096)) {
      this.status = { phase: 'failed', code: 'GOOGLE_CODE_MISSING', message: 'Google did not return an authorization code. Try connecting again.', updatedAt: new Date().toISOString() };
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(callbackPage('Google did not return an authorization code.', active));
      this.#closeActive();
      return;
    }
    const controller = new AbortController();
    active.controller = controller;
    const exchangeTimer = setTimeout(() => controller.abort(), this.exchangeTimeoutMs);
    exchangeTimer.unref?.();
    try {
      let tokenResponse;
      let token;
      try {
        tokenResponse = await this.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: active.config.clientId,
          client_secret: active.config.clientSecret,
          code_verifier: verifier,
          redirect_uri: `http://127.0.0.1:${active.server.address().port}/`,
          grant_type: 'authorization_code'
          }).toString(),
          signal: controller.signal
        });
        if (!tokenResponse.ok) throw new Error('Google rejected the authorization exchange.');
        token = await tokenResponse.json();
      } catch {
        throw new Error('Google authorization exchange failed or timed out.');
      } finally { clearTimeout(exchangeTimer); }
      if (this.active !== active) throw new Error('Google authorization was stopped.');
      if (!validText(token?.refresh_token, 8192)) throw new Error('Google did not return a refresh token. Revoke the previous grant in your Google Account and authorize again.');
      const grantedScopes = String(token.scope || '').split(/\s+/).filter(Boolean);
      const granted = new Set(grantedScopes);
      const requiredScopes = [
        active.scopes.readGmail ? 'https://www.googleapis.com/auth/gmail.readonly' : null,
        active.scopes.readDrive ? 'https://www.googleapis.com/auth/drive.readonly' : null,
        active.scopes.docsWrite ? 'https://www.googleapis.com/auth/documents' : null,
        active.scopes.gmailSend ? 'https://www.googleapis.com/auth/gmail.send' : null
      ].filter(Boolean);
      if (requiredScopes.some(scope => !granted.has(scope))) {
        throw new Error('Google did not grant every requested scope.');
      }
      // Resolve identity from Google's authenticated userinfo endpoint, never
      // from a user-entered address or an unverified JWT payload.
      if (!validText(token.access_token, 8192)) throw new Error('Google did not return an access token.');
      const identityController = new AbortController();
      active.controller = identityController;
      const identityTimer = setTimeout(() => identityController.abort(), this.exchangeTimeoutMs);
      identityTimer.unref?.();
      let identity;
      try {
        const response = await this.fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' }, signal: identityController.signal
        });
        if (!response.ok) throw new Error('Google account identity could not be verified.');
        identity = await response.json();
      } finally { clearTimeout(identityTimer); }
      if (this.active !== active) throw new Error('Google authorization was stopped.');
      if (!validText(identity?.sub, 320) || !validText(identity?.email, 320) || identity.email_verified !== true) {
        throw new Error('Google account identity could not be verified.');
      }
      this.store.saveAuthorization({ refreshToken: token.refresh_token, grantedScopes, accountId: identity.sub, accountEmail: identity.email });
      this.status = { phase: 'connecting', message: 'Connecting your Google workspace.', updatedAt: new Date().toISOString() };
      clearTimeout(active.timer);
      if (this.onAuthorized) {
        try { await this.onAuthorized({ observe: active.observe, allowExternalWrites: active.allowExternalWrites }); }
        catch {
          if (this.active !== active) return;
          this.status = { phase: 'activation_failed', message: 'Authorization is saved. Retry connecting your workspace.', updatedAt: new Date().toISOString() };
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(callbackPage('Your account is authorized. Return to Unprompted to retry connecting.', active));
          this.#closeActive(); return;
        }
      }
      if (this.active !== active) return;
      this.status = { phase: this.onAuthorized ? 'connected' : 'authorized_pending_restart', message: this.onAuthorized ? 'Google is connected. Your first observation is starting.' : 'Google authorization is saved. Restart Unprompted to activate sync.', updatedAt: new Date().toISOString() };
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(callbackPage(this.onAuthorized ? 'Google is connected.' : 'Google authorization is saved.', active));
      this.#closeActive();
    } catch (error) {
      if (this.active !== active) {
        if (!res.writableEnded) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(callbackPage('Google authorization was stopped.'));
        }
        return;
      }
      const message = /refresh token/i.test(error.message)
        ? 'Google did not return a refresh token. Revoke the previous grant and authorize again.'
        : 'Google authorization could not be completed. Check the OAuth client and try again.';
      const failureCode = /requested scope/.test(error.message) ? 'GOOGLE_SCOPE_MISSING' : /identity/.test(error.message) ? 'GOOGLE_IDENTITY_FAILED'
        : /refresh token/.test(error.message) ? 'GOOGLE_REFRESH_MISSING' : 'GOOGLE_EXCHANGE_FAILED';
      this.status = { phase: 'failed', code: failureCode, message, updatedAt: new Date().toISOString() };
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(callbackPage('Google authorization could not be completed.', active));
      this.#closeActive();
    }
  }

  #closeActive() {
    if (!this.active) return;
    clearTimeout(this.active.timer);
    const { server, controller } = this.active;
    this.active = null;
    controller?.abort();
    server.close();
  }

  cancel(reason = 'cancelled') {
    if (!this.active) return;
    const response = this.active.response;
    this.status = { phase: reason, message: 'Google authorization was stopped.', updatedAt: new Date().toISOString() };
    this.#closeActive();
    if (response && !response.writableEnded) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(callbackPage('Google authorization was stopped.'));
    }
  }
}

export const setupConstants = { DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS };
