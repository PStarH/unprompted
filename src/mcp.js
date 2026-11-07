import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readRegularFile } from './local-files.js';
import { createKeyStore, openMcpDocument, sealMcpDocument, SecretBoxError, visitMcpSecrets, writeSealedJson } from './at-rest.js';
import { MCP_PRESETS, publicPresetConnection, RUNTIME_HINTS, validatePresetConfig, expandImportedServers, isGitPresetServer, isGitReadTool } from './mcp-presets.js';

export { MCP_PRESETS };

/** A write-tool update widens access only when it adds a tool or turns a disabled server on. */
export function mcpWritesWidened(previous, { writeTools, enabled } = {}) {
  const oldTools = new Set(previous?.writeTools || []);
  const nextTools = Array.isArray(writeTools) ? writeTools : [...oldTools];
  const addsTool = nextTools.some(tool => !oldTools.has(tool));
  const enables = enabled === true && previous?.enabled !== true;
  return addsTool || enables;
}

export function findExecutable(command, pathValue = stdioEnvironment().PATH) {
  if (typeof command !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(command)) return null;
  for (const dir of String(pathValue || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* Try the next directory. */ }
  }
  return null;
}

export function stdioEnvironment(defaults = {}, overrides = {}) {
  const runtime = path.dirname(process.execPath), home = os.homedir();
  const entries = [runtime, ...(process.env.PATH || defaults.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return { ...defaults, PATH: [...new Set(entries.filter(Boolean))].join(path.delimiter), ...overrides };
}


export const MCP_LIMITS = Object.freeze({ servers: 12, tools: 1024, exposedTools: 24, maxConcurrent: 4, timeoutMs: 15000, resultChars: 6000, configBytes: 128 * 1024, oauthBytes: 32 * 1024 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'MCP_ERROR' });
const validId = id => typeof id === 'string' && id === id.trim() && /^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,63}$/u.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
const strings = (value, max = 64) => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 4096 && !item.includes('\0'));
const resourceId = uri => createHash('sha256').update(uri).digest('hex');

function stringMap(value, headers = false) {
  if (value == null) return {};
  if (!object(value) || Object.keys(value).length > 64) throw fail('Invalid MCP environment or headers.');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof item !== 'string' || item.length > 8192 || item.includes('\0') || (headers && (/\r|\n/.test(item) || /^(host|connection|content-length|transfer-encoding|cookie)$/i.test(key)))) throw fail('Invalid MCP environment or headers.');
    result[key] = item;
  }
  return result;
}

function plainJson(value) {
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > MCP_LIMITS.oauthBytes) return undefined;
    const parsed = JSON.parse(text);
    return object(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

/** Keep a previously saved sign-in blob. Drop anything that is not a credential field, or that is too large to store. */
export function keptOAuth(value) {
  if (!object(value)) return undefined;
  const allowed = {};
  const clientInformation = plainJson(value.clientInformation);
  if (clientInformation && typeof clientInformation.client_id === 'string' && clientInformation.client_id.length <= 2048) allowed.clientInformation = clientInformation;
  const tokens = plainJson(value.tokens);
  if (tokens && typeof tokens.access_token === 'string' && tokens.access_token.length <= 16384 && tokens.access_token.length >= 1) allowed.tokens = tokens;
  if (typeof value.codeVerifier === 'string' && value.codeVerifier.length >= 32 && value.codeVerifier.length <= 256) allowed.codeVerifier = value.codeVerifier;
  const discoveryState = plainJson(value.discoveryState);
  if (discoveryState) allowed.discoveryState = discoveryState;
  if (typeof value.resourceUrl === 'string' && value.resourceUrl.length <= 2048 && value.resourceUrl.length > 0) allowed.resourceUrl = value.resourceUrl;
  if (!Object.keys(allowed).length) return undefined;
  if (JSON.stringify(allowed).length > MCP_LIMITS.oauthBytes) return undefined;
  return allowed;
}

function mergeOAuth(current, patch) {
  const next = { ...(current || {}) };
  for (const [key, item] of Object.entries(patch)) {
    if (item == null) delete next[key];
    else next[key] = item;
  }
  return keptOAuth(next);
}

export function normalizeMcpConfig(id, value, { oauth = 'keep' } = {}) {
  if (!validId(id) || !object(value)) throw fail('Invalid MCP server name or configuration.');
  if (oauth === 'reject' && Object.hasOwn(value, 'oauth')) throw fail('MCP OAuth state cannot be imported.');
  for (const flag of ['enabled', 'allowDeclaredRead']) if (value[flag] != null && typeof value[flag] !== 'boolean') throw fail('Invalid MCP permission value.');
  const type = value.type || value.transport || (value.url ? 'http' : 'stdio');
  const config = { type: type === 'streamable-http' ? 'http' : type, enabled: value.enabled !== false,
    // The user grants a connection access to declared read tools once. The
    // annotation is a server claim, so this is shown explicitly in the form.
    allowDeclaredRead: value.allowDeclaredRead === true, readTools: strings(value.readTools, MCP_LIMITS.tools) ? [...new Set(value.readTools)] : [],
    writeTools: strings(value.writeTools, MCP_LIMITS.tools) ? [...new Set(value.writeTools)] : [],
    readResources: strings(value.readResources, MCP_LIMITS.tools) ? [...new Set(value.readResources)] : [] };
  if (value.writeTools != null && !strings(value.writeTools, MCP_LIMITS.tools)) throw fail('Invalid MCP action tool permissions.');
  if (value.readTools != null && !strings(value.readTools, MCP_LIMITS.tools)) throw fail('Invalid MCP read tool permissions.');
  if (value.readResources != null && (!strings(value.readResources, MCP_LIMITS.tools) || value.readResources.some(id => !/^[a-f0-9]{64}$/.test(id)))) throw fail('Invalid MCP resource permissions.');
  if (config.type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 4096 || value.command.includes('\0') || (value.args != null && !strings(value.args))) throw fail('Invalid MCP command or arguments.');
    if (value.cwd != null && (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || value.cwd.includes('\0'))) throw fail('MCP cwd requires an absolute path.');
    Object.assign(config, { command: value.command, args: value.args || [], env: stringMap(value.env), ...(value.cwd ? { cwd: value.cwd } : {}) });
  } else if (['http', 'sse'].includes(config.type)) {
    let url;
    try { url = new URL(value.url); } catch { throw fail('Invalid MCP URL.'); }
    if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw fail('MCP requires HTTPS, or HTTP on localhost. Put credentials in headers.');
    Object.assign(config, { url: url.href, headers: stringMap(value.headers, true) });
  } else throw fail('MCP transport must be http, sse or stdio.');
  const savedOAuth = oauth === 'keep' ? keptOAuth(value.oauth) : undefined;
  if (savedOAuth) config.oauth = savedOAuth;
  return config;
}

export function parseMcpImport(value, { allowDeclaredRead = false } = {}) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw fail('Invalid MCP JSON.'); }
  const servers = parsed?.mcpServers;
  if (!object(servers) || !Object.keys(servers).length || Object.keys(servers).length > MCP_LIMITS.servers || JSON.stringify(parsed).length > MCP_LIMITS.configBytes) throw fail('Expected {"mcpServers":{"name":{...}}}, with at most 12 servers.');
  return Object.fromEntries(Object.entries(servers).map(([id, config]) => [id, normalizeMcpConfig(id, { ...config, writeTools: [], allowDeclaredRead }, { oauth: 'reject' })]));
}

/** Private configuration is deliberately separate from task exports and state. Credentials are sealed before they are written. */
export class McpConfigStore {
  constructor(directory, { keyStore = null, env = process.env } = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, 'mcp.json');
    this.env = env;
    this.boundKeyStore = keyStore;
    this.keyStore = null;
    this.secretKey = null;
  }
  #store() {
    if (this.boundKeyStore) return this.boundKeyStore;
    if (!this.keyStore) this.keyStore = createKeyStore({ directory: this.directory, env: this.env });
    return this.keyStore;
  }
  #key() {
    if (this.secretKey) return this.secretKey;
    try { this.secretKey = this.#store().load(); }
    catch (error) {
      if (error instanceof SecretBoxError) throw fail(error.message, 500);
      throw error;
    }
    return this.secretKey;
  }
  get() {
    let data;
    try { data = JSON.parse(readRegularFile(this.filePath, { maxBytes: MCP_LIMITS.configBytes, mode: 0o600 })); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    if (!object(data) || Object.keys(data).length > MCP_LIMITS.servers) throw fail('Invalid saved MCP configuration.');
    let opened;
    try { opened = openMcpDocument(data, this.#key()); }
    catch (error) {
      if (error instanceof SecretBoxError) throw fail('Saved MCP credentials could not be decrypted. The file was left unchanged.', 500);
      throw error;
    }
    const configs = Object.fromEntries(Object.entries(opened.document).map(([id, value]) => [id, normalizeMcpConfig(id, value)]));
    if (opened.migrated) this.write(configs);
    return configs;
  }
  write(configs) {
    try { writeSealedJson(this.filePath, configs, this.#key(), sealMcpDocument, visitMcpSecrets, { maxBytes: MCP_LIMITS.configBytes }); }
    catch (error) {
      if (error instanceof SecretBoxError && error.code === 'SECRET_TOO_LARGE') throw fail('MCP configuration is too large.');
      if (error instanceof SecretBoxError) throw fail(error.message, 500);
      throw error;
    }
  }
}

async function loadSdk() {
  try {
    const [client, stdio] = await Promise.all([import('@modelcontextprotocol/client'), import('@modelcontextprotocol/client/stdio')]);
    return { ...client, ...stdio };
  } catch { throw fail('MCP SDK unavailable. Run npm ci --include=optional and restart.', 503); }
}

function errorMessage(error) {
  // Never surface a remote message: URLs, headers, command arguments and child
  // stderr can contain credentials. Protocol errors remain actionable by type.
  if (error.code === 'MCP_ERROR') return error.message;
  if (error.name === 'AbortError' || /timed out|timeout/i.test(error.message || '')) return 'MCP request timed out. Check the server and reconnect.';
  if (/sign-in required|sign-in expired/i.test(error.message || '')) return 'Sign-in required. Use Sign in and connect.';
  if (/401|403|unauthoriz|authenticat/i.test(error.message || '')) return 'MCP authentication failed. Check the authorization header or server credentials.';
  if (error.code === 'ENOENT' || /ENOENT/.test(error.message || '')) return 'MCP executable not found. Check the command and installation.';
  return 'MCP request failed. Check the server configuration and reconnect.';
}

export class McpManager {
  constructor({ configStore, timeoutMs = MCP_LIMITS.timeoutMs, load = loadSdk, onChange = () => {}, executableLookup = findExecutable } = {}) {
    this.configStore = configStore; this.configs = configStore.get(); this.timeoutMs = timeoutMs;
    const bundledFetch = MCP_PRESETS.find(preset => preset.id === 'fetch').config;
    const savedFetch = this.configs.fetch;
    // Fetch always uses this process's Node and the bundled script. A saved config
    // that still points at another machine (for example a developer's nvm path)
    // or the old uvx package is rewritten here.
    const savedFetchScript = savedFetch?.args?.length === 1 && /[/\\]mcp-fetch-server\.js$/.test(savedFetch.args[0]);
    if (savedFetch?.type === 'stdio' && (savedFetch.command === 'uvx' && JSON.stringify(savedFetch.args) === '["mcp-server-fetch"]' || savedFetchScript)) this.configs.fetch = { ...savedFetch, ...bundledFetch };
    for (const id of ['brave-search', 'firecrawl']) {
      const saved = this.configs[id], preset = MCP_PRESETS.find(item => item.id === id).config;
      const legacyArgs = id === 'brave-search' ? ['-y', '@modelcontextprotocol/server-brave-search'] : ['-y', 'firecrawl-mcp'];
      if (saved?.type === 'stdio' && (saved.command === 'npx' && JSON.stringify(saved.args) === JSON.stringify(legacyArgs) || saved.args?.length === 2 && /[/\\]src[/\\]mcp-key-server\.js$/.test(saved.args[0]) && saved.args[1] === id)) this.configs[id] = { ...saved, ...preset };
    }
    this.presetErrors = {};
    let expanded = this.configs;
    let persist = null;
    try {
      const next = expandImportedServers(this.configs);
      if (next !== this.configs) persist = next;
      expanded = next;
    } catch (error) {
      Object.assign(this.presetErrors, error.serverErrors || { git: error.message });
      if (error.servers) expanded = error.servers;
      if (error.canonical && error.servers) persist = error.servers;
    }
    const runtime = { ...expanded };
    for (const [id, config] of Object.entries(runtime)) {
      if (!this.presetErrors[id]) {
        try { validatePresetConfig(id, config); }
        catch (error) { this.presetErrors[id] = error.message; }
      }
      if (this.presetErrors[id] && config?.enabled !== false) runtime[id] = { ...config, enabled: false };
    }
    this.configs = Object.keys(this.presetErrors).length ? runtime : expanded;
    // A missing directory is remembered only for this process. Canonical paths are saved.
    if (persist && typeof this.configStore.write === 'function') {
      try { this.configStore.write(persist); } catch { /* Canonical paths remain in memory. */ }
    }
    this.load = load; this.onChange = onChange; this.executableLookup = executableLookup; this.connections = new Map(); this.busy = false; this.closed = false; this.inFlight = 0;
    this.lockContext = new AsyncLocalStorage(); this.oauthBroker = null;
  }
  attachOAuth(broker) { this.oauthBroker = broker; }
  oauthStatus(id) {
    const view = this.oauthBroker?.view(id) || {};
    const signedIn = Boolean(this.configs[id]?.oauth?.tokens?.access_token);
    const phase = view.phase || (signedIn ? 'authorized' : 'idle');
    return { signedIn, oauthPhase: phase,
      ...(phase === 'authorizing' && view.authorizeUrl ? { authorizeUrl: view.authorizeUrl } : {}),
      ...(phase === 'failed' && view.error ? { oauthError: view.error } : {}) };
  }
  describe() {
    return { servers: Object.entries(this.configs).map(([id, config]) => {
      const connection = this.connections.get(id);
      return { id, type: config.type, enabled: config.enabled, endpoint: config.url ? new URL(config.url).origin : 'stdio',
        ...this.oauthStatus(id),
        status: connection?.status || 'disconnected', lastError: connection?.lastError || this.presetErrors[id] || null,
        allowDeclaredRead: config.allowDeclaredRead,
        tools: (connection?.tools || []).filter(tool => this.redact(String(tool.name)) === tool.name).map(tool => ({ name: tool.name, description: this.redact(String(tool.description || '')).slice(0, 500), inputSchema: this.redactMetadata(tool.inputSchema),
          declaredReadOnly: tool.annotations?.readOnlyHint === true, writeTool: this.isWrite(id, config, tool), allowed: this.allowed(id, config, tool) })),
        resources: (connection?.resources || []).map(resource => ({ id: resourceId(resource.uri), name: this.redact(String(resource.name || '').slice(0, 300)), description: this.redact(String(resource.description || '').slice(0, 500)), allowed: config.enabled && config.readResources.includes(resourceId(resource.uri)) })) };
    }), presets: MCP_PRESETS.map(preset => ({
      id: preset.id, name: preset.name, category: preset.category, auth: preset.auth || (preset.requiresAuth ? 'key' : 'none'),
      tagZh: preset.tagZh || '', tagEn: preset.tagEn || '',
      titleZh: preset.titleZh, titleEn: preset.titleEn,
      descriptionZh: preset.descriptionZh, descriptionEn: preset.descriptionEn,
      defaultEnabled: preset.defaultEnabled, requiresAuth: preset.requiresAuth,
      connection: publicPresetConnection(preset),
      ...(preset.runtime ? { runtime: { command: preset.runtime, available: this.#runtimeAvailable(preset.runtime), ...RUNTIME_HINTS[preset.runtime] } } : {}),
      fields: preset.fields, configured: Object.hasOwn(this.configs, preset.id),
      enabled: this.configs[preset.id]?.enabled ?? false, ...this.oauthStatus(preset.id)
    })), limits: MCP_LIMITS };
  }
  #runtimeAvailable(command) { try { return Boolean(this.executableLookup(command)); } catch { return false; } }
  isWrite(serverId, config, tool) {
    if (isGitPresetServer(serverId, config) && isGitReadTool(tool?.name) && tool?.annotations?.destructiveHint !== true) return false;
    return tool?.annotations?.readOnlyHint !== true || tool?.annotations?.destructiveHint === true;
  }
  allowed(serverId, config, tool) {
    if (!config.enabled) return false;
    if (this.isWrite(serverId, config, tool)) return (config.writeTools || []).includes(tool.name);
    return config.readTools.includes(tool.name) || config.allowDeclaredRead === true;
  }
  async exclusive(fn) {
    if (this.closed) throw fail('MCP is shutting down.', 503);
    // Token saves happen inside auth() and during a 401 refresh. Those calls
    // are on the same async path as the connection update, so they must re-enter
    // this lock. A second HTTP request has no store and still receives 409.
    if (this.lockContext.getStore() === this) return await fn();
    if (this.busy) throw fail('An MCP connection update is already running.', 409);
    this.busy = true;
    try { return await this.lockContext.run(this, fn); } finally { this.busy = false; this.onChange(); }
  }
  async import(value, options) {
    let incoming = parseMcpImport(value, options);
    try {
      incoming = expandImportedServers(incoming);
      for (const [id, config] of Object.entries(incoming)) validatePresetConfig(id, config);
    } catch (error) { throw fail(error.message); }
    return this.exclusive(async () => {
      const merged = { ...this.configs };
      for (const [id, config] of Object.entries(incoming)) {
        const previous = this.configs[id];
        const next = { ...config };
        if (previous?.type === 'stdio' && next.type === 'stdio' && !Object.keys(next.env || {}).length && Object.keys(previous.env || {}).length) next.env = previous.env;
        for (const key of ['writeTools', 'readTools', 'readResources']) {
          if (previous && previous[key]?.length && !next[key]?.length) next[key] = previous[key];
        }
        merged[id] = next;
      }
      if (Object.keys(merged).length > MCP_LIMITS.servers || JSON.stringify(merged).length > MCP_LIMITS.configBytes) throw fail('Too many MCP servers or configuration too large.');
      this.configStore.write(merged); this.configs = merged;
      await Promise.all(Object.keys(incoming).map(async id => { await this.disconnect(id); if (merged[id].enabled) await this.connect(id); }));
      return this.describe();
    });
  }
  async update(id, { enabled, readTools, writeTools, readResources, allowDeclaredRead, remove = false, reconnect = false }) {
    if (typeof remove !== 'boolean' || typeof reconnect !== 'boolean') throw fail('Invalid MCP update value.');
    if (!Object.hasOwn(this.configs, id)) throw fail('Unknown MCP server.', 404);
    return this.exclusive(async () => {
      const previousTools = [...(this.configs[id]?.writeTools || [])];
      const merged = { ...this.configs };
      if (remove) delete merged[id];
      else merged[id] = normalizeMcpConfig(id, { ...merged[id], ...(enabled != null ? { enabled } : {}), ...(readTools != null ? { readTools } : {}), ...(writeTools != null ? { writeTools } : {}), ...(readResources != null ? { readResources } : {}), ...(allowDeclaredRead != null ? { allowDeclaredRead } : {}) });
      this.configStore.write(merged); this.configs = merged;
      const nextTools = new Set(merged[id]?.writeTools || []);
      const removedTools = previousTools.filter(tool => !nextTools.has(tool));
      if (removedTools.length) this.onWriteToolsChanged?.({ id, removed: removedTools });
      const permissionsChanged = readTools != null || writeTools != null || readResources != null || allowDeclaredRead != null;
      if (remove || !merged[id].enabled || reconnect || permissionsChanged) await this.disconnect(id);
      if (merged[id]?.enabled && (reconnect || enabled === true || permissionsChanged)) await this.connect(id);
      return this.describe();
    });
  }
  async prepareOAuthServer(id, url) {
    const base = normalizeMcpConfig(id, { type: 'http', url, enabled: false, allowDeclaredRead: true });
    return this.exclusive(async () => {
      const previous = this.configs[id];
      const next = { ...base };
      if (previous?.url === base.url && previous.oauth) next.oauth = previous.oauth;
      const merged = { ...this.configs, [id]: next };
      if (Object.keys(merged).length > MCP_LIMITS.servers || JSON.stringify(merged).length > MCP_LIMITS.configBytes) throw fail('Too many MCP servers or configuration too large.');
      this.configStore.write(merged); this.configs = merged;
      await this.disconnect(id);
      return next;
    });
  }
  async writeOAuth(id, patch) {
    return this.exclusive(async () => {
      const current = this.configs[id];
      if (!current) throw fail('Unknown MCP server.', 404);
      const oauth = mergeOAuth(current.oauth, patch);
      const next = { ...current };
      if (oauth) next.oauth = oauth; else delete next.oauth;
      const merged = { ...this.configs, [id]: next };
      this.configStore.write(merged); this.configs = merged;
      return oauth;
    });
  }
  async finishOAuth(id) {
    await this.exclusive(async () => {
      const current = this.configs[id];
      if (!current) throw fail('Unknown MCP server.', 404);
      const oauth = current.oauth ? { ...current.oauth } : undefined;
      if (oauth) delete oauth.codeVerifier;
      const next = normalizeMcpConfig(id, { ...current, enabled: true, allowDeclaredRead: true, ...(oauth ? { oauth } : {}) });
      const merged = { ...this.configs, [id]: next };
      this.configStore.write(merged); this.configs = merged;
    });
    await this.connect(id);
  }
  bearerAuth(id) {
    if (!this.configs[id]?.oauth?.tokens?.access_token || !this.oauthBroker) return null;
    const manager = this;
    return {
      async token() {
        const token = manager.configs[id]?.oauth?.tokens?.access_token;
        if (!token) throw new Error('Sign-in required');
        return token;
      },
      async onUnauthorized() {
        const refreshed = await manager.oauthBroker.refresh(id);
        if (!refreshed) throw new Error('Sign-in required');
      }
    };
  }
  async start() {
    await Promise.allSettled(Object.entries(this.configs).filter(([, config]) => config.enabled).map(([id]) => this.connect(id)));
  }
  async connect(id) {
    if (this.closed || !this.configs[id]?.enabled) return;
    const existing = this.connections.get(id);
    if (existing?.status === 'connected' || existing?.status === 'connecting') return;
    const config = this.configs[id], entry = { status: 'connecting', tools: [], resources: [], client: null, transport: null, controller: new AbortController() };
    this.connections.set(id, entry); this.onChange();
    try { validatePresetConfig(id, config); }
    catch (error) {
      entry.status = 'failed'; entry.tools = []; entry.resources = []; entry.lastError = error.message; this.onChange(); return;
    }
    if (config.type === 'stdio') {
      const base = path.basename(config.command);
      const hint = RUNTIME_HINTS[base];
      if (hint && !this.#runtimeAvailable(base)) {
        entry.status = 'failed'; entry.tools = []; entry.resources = []; entry.lastError = hint.hintEn; this.onChange(); return;
      }
    }
    let timer;
    try {
      const sdk = await this.load();
      entry.schemaValidator = sdk.fromJsonSchema;
      if (this.closed || this.connections.get(id) !== entry) throw fail('MCP connection cancelled.');
      const client = new sdk.Client({ name: 'unprompted', version: '0.3.0' }, { capabilities: {}, listMaxPages: MCP_LIMITS.tools,
        listChanged: { tools: { onChanged: (error, tools) => {
          if (this.connections.get(id) !== entry) return;
          if (error || !Array.isArray(tools) || tools.length > MCP_LIMITS.tools || JSON.stringify(tools).length > 1000000) {
            entry.tools = []; entry.lastError = 'MCP tool catalog changed. Reconnect to refresh tools.';
          } else { entry.tools = tools; entry.lastError = null; }
          this.onChange();
        } }, resources: { onChanged: (error, resources) => {
          if (this.connections.get(id) !== entry) return;
          if (error || !Array.isArray(resources) || resources.length > MCP_LIMITS.tools || JSON.stringify(resources).length > 1000000) {
            entry.resources = []; entry.lastError = 'MCP resource catalog changed. Reconnect to refresh resources.';
          } else { entry.resources = resources; entry.lastError = null; }
          this.onChange();
        } } }
      });
      const authProvider = config.type === 'stdio' ? null : this.bearerAuth(id);
      const transport = config.type === 'stdio'
        ? new sdk.StdioClientTransport({ command: config.command, args: config.args, env: stdioEnvironment(sdk.getDefaultEnvironment(), config.env), ...(config.cwd ? { cwd: config.cwd } : {}), stderr: 'ignore', maxBufferSize: 1024 * 1024 })
        : new (config.type === 'sse' ? sdk.SSEClientTransport : sdk.StreamableHTTPClientTransport)(new URL(config.url), { requestInit: { headers: config.headers }, ...(authProvider ? { authProvider } : {}), fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([entry.controller.signal, ...(init?.signal ? [init.signal] : [])]) }) });
      entry.client = client; entry.transport = transport;
      client.onclose = () => { if (this.connections.get(id) === entry && entry.status !== 'failed') { entry.status = 'disconnected'; entry.tools = []; entry.resources = []; this.onChange(); } };
      // Remote exceptions and logs are intentionally never printed.
      client.onerror = () => {};
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { entry.controller.abort(); reject(fail('MCP connection timed out. Check the server and reconnect.', 504)); }, this.timeoutMs); });
      await Promise.race([(async () => {
        await client.connect(transport, { timeout: this.timeoutMs });
        const list = async (method, key) => {
          const items = [], seen = new Set(); let cursor;
          do {
            const page = await client[method](cursor ? { cursor } : {}, { timeout: this.timeoutMs });
            if (!Array.isArray(page[key])) throw fail('Invalid MCP catalog.');
            items.push(...page[key]); cursor = page.nextCursor;
            if (items.length > MCP_LIMITS.tools || JSON.stringify(items).length > 1000000) {
              while (items.length && (items.length > MCP_LIMITS.tools || JSON.stringify(items).length > 1000000)) items.pop();
              return items;
            }
            if (cursor && (!page[key].length || seen.has(cursor))) throw fail('Invalid MCP catalog pagination.');
            if (cursor) seen.add(cursor);
          } while (cursor);
          return items;
        };
        const capabilities = client.getServerCapabilities() || {};
        const tools = capabilities.tools ? await list('listTools', 'tools') : [];
        const resources = capabilities.resources ? await list('listResources', 'resources') : [];
        if (this.closed || this.connections.get(id) !== entry || entry.controller.signal.aborted) throw fail('MCP connection cancelled.');
        entry.tools = tools; entry.resources = resources; entry.status = 'connected'; entry.lastError = null;
      })(), timeout]);
    } catch (error) {
      entry.status = 'failed'; entry.tools = []; entry.resources = []; entry.lastError = errorMessage(error); entry.controller.abort();
      await entry.client?.close().catch(() => {});
    } finally { clearTimeout(timer); this.onChange(); }
  }
  async disconnect(id) {
    const entry = this.connections.get(id);
    this.connections.delete(id);
    if (entry) { entry.controller.abort(); await entry.client?.close().catch(() => {}); }
  }
  tools({ taskId = null, isCurrent = () => false, onCall = () => {}, executeWrite = null, exposedLimit = MCP_LIMITS.exposedTools, includeDispatcher = true } = {}) {
    const tools = [];
    for (const [serverId, entry] of this.connections) {
      const config = this.configs[serverId];
      if (!config || entry.status !== 'connected') continue;
      for (const tool of entry.tools) {
        if (this.redact(String(tool.name)) !== tool.name || !this.allowed(serverId, config, tool) || tools.length >= (includeDispatcher ? MCP_LIMITS.tools : exposedLimit)) continue;
        const name = `mcp_${createHash('sha256').update(`${serverId}\0${tool.name}`).digest('hex').slice(0, 16)}`;
        tools.push({ name, effect: this.isWrite(serverId, config, tool) ? 'write' : 'read', label: `${serverId} · ${tool.name}`, description: this.redact(`${serverId} / ${tool.name}: ${tool.description || ''}`).slice(0, 1000), parameters: this.redactMetadata(tool.inputSchema),
          execute: async (_id, args, signal) => {
            if (this.closed || !isCurrent() || this.connections.get(serverId) !== entry || !entry.tools.includes(tool) || entry.status !== 'connected' || !this.allowed(serverId, this.configs[serverId] || { enabled: false }, tool)) throw fail('MCP tool access is no longer current.', 409);
            if (!object(args) || JSON.stringify(args).length > 8000) throw fail('Invalid MCP tool arguments.');
            try {
              if (typeof entry.schemaValidator !== 'function') throw new Error('Validator unavailable');
              const validation = await entry.schemaValidator(tool.inputSchema)['~standard'].validate(args);
              if (validation.issues) throw new Error('Invalid arguments');
            } catch { throw fail('MCP tool arguments do not match the advertised schema.'); }
            if (this.closed || !isCurrent() || this.connections.get(serverId) !== entry || !entry.tools.includes(tool) || entry.status !== 'connected' || !this.allowed(serverId, this.configs[serverId] || { enabled: false }, tool)) throw fail('MCP tool access is no longer current.', 409);
            const check = () => !signal?.aborted && !this.closed && isCurrent() && this.connections.get(serverId) === entry && entry.tools.includes(tool) && entry.status === 'connected' && this.allowed(serverId, this.configs[serverId] || { enabled: false }, tool);
            const invoke = async dispatchSignal => {
              if (!check()) throw fail('MCP action permission changed before dispatch.', 409);
            if (this.inFlight >= MCP_LIMITS.maxConcurrent) throw fail('MCP read concurrency limit reached. Retry later.', 429);
            this.inFlight++;
            const startedAt = new Date().toISOString();
            let status = 'failed', text = '', error = null;
            try {
              const result = await entry.client.callTool({ name: tool.name, arguments: args }, {
                timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs, signal: AbortSignal.any([entry.controller.signal, ...(dispatchSignal instanceof AbortSignal ? [dispatchSignal] : [])])
              });
              if (!isCurrent() || this.connections.get(serverId) !== entry || !entry.tools.includes(tool) || !this.allowed(serverId, this.configs[serverId] || { enabled: false }, tool)) throw fail('MCP task or connection changed during the call.', 409);
              if (result.isError) throw fail('MCP tool reported an error.');
              // Text and structured data only. Never fetch returned image/resource URLs.
              const contents = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
              text = this.redact(result.structuredContent ? JSON.stringify({ content: contents, structuredContent: result.structuredContent }) : contents).slice(0, MCP_LIMITS.resultChars);
              status = 'completed';
              return { content: [{ type: 'text', text: text || '(No text content returned)' }], details: {} };
            } catch (cause) { error = errorMessage(cause); throw fail(error, 502); }
            finally { this.inFlight--; onCall({ id: randomUUID(), serverId, tool: tool.name, status, startedAt, finishedAt: new Date().toISOString(), ...(error ? { error } : { text }) }); }
            };
            if (this.isWrite(serverId, this.configs[serverId], tool)) {
              if (!taskId || typeof executeWrite !== 'function') throw fail('MCP actions require an authorized durable task.', 403);
              const result = await executeWrite({ taskId, serverId, tool: tool.name, args, isCurrent, check, invoke });
              return { content: [{ type: 'text', text: JSON.stringify(result).slice(0, MCP_LIMITS.resultChars) }], details: {} };
            }
            return invoke(signal);
          }
        });
      }
      for (const resource of entry.resources) {
        const id = resourceId(resource.uri);
        if (!config.readResources.includes(id) || tools.length >= (includeDispatcher ? MCP_LIMITS.tools : exposedLimit)) continue;
        const current = () => !this.closed && isCurrent() && this.connections.get(serverId) === entry && entry.status === 'connected'
          && entry.resources.includes(resource) && this.configs[serverId]?.enabled && this.configs[serverId].readResources.includes(id);
        tools.push({ name: `mcp_${createHash('sha256').update(`${serverId}\0resource\0${id}`).digest('hex').slice(0, 16)}`,
          label: `${serverId} · ${this.redact(resource.name).slice(0, 200)}`,
          description: `Read authorized MCP resource ${this.redact(resource.name).slice(0, 200)}: ${this.redact(resource.description || '').slice(0, 500)}`,
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async (_callId, args, signal) => {
            if (!current()) throw fail('MCP resource access is no longer current.', 409);
            if (!object(args) || Object.keys(args).length) throw fail('Invalid MCP resource arguments.');
            if (this.inFlight >= MCP_LIMITS.maxConcurrent) throw fail('MCP read concurrency limit reached. Retry later.', 429);
            this.inFlight++;
            const startedAt = new Date().toISOString(); let status = 'failed', text = '', error = null;
            try {
              const result = await entry.client.readResource({ uri: resource.uri }, { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs,
                signal: AbortSignal.any([entry.controller.signal, ...(signal instanceof AbortSignal ? [signal] : [])]) });
              if (!current()) throw fail('MCP task or connection changed during the call.', 409);
              if (!Array.isArray(result.contents)) throw fail('MCP resource returned an invalid result.');
              text = this.redact(result.contents.filter(item => typeof item.text === 'string').map(item => item.text).join('\n')).slice(0, MCP_LIMITS.resultChars);
              status = 'completed';
              return { content: [{ type: 'text', text: text || '(No text content returned)' }], details: {} };
            } catch (cause) { error = errorMessage(cause); throw fail(error, 502); }
            finally { this.inFlight--; onCall({ id: randomUUID(), serverId, tool: `resource:${id}`, status, startedAt, finishedAt: new Date().toISOString(), ...(error ? { error } : { text }) }); }
          } });
      }
    }
    if (!includeDispatcher || tools.length <= exposedLimit) return tools.slice(0, exposedLimit);
    const all = () => this.tools({ taskId, isCurrent, onCall, executeWrite, exposedLimit: MCP_LIMITS.tools, includeDispatcher: false });
    const find = { name: 'find_connected_tools', contextProvider: 'workspace', label: 'Find connected service capabilities',
      description: 'Find authorized tools beyond the inline tool catalog. Returns exact schemas and whether a tool can change data. Use call_connected_tool with the returned name.',
      parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, additionalProperties: false },
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted(); if (!isCurrent() || !object(args) || Object.keys(args).some(key => key !== 'query') || args.query != null && typeof args.query !== 'string') throw fail('Invalid tool search.');
        const query = (args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const matches = all().filter(tool => query.every(word => `${tool.name} ${tool.label} ${tool.description}`.toLowerCase().includes(word)));
        const selected = []; for (const tool of matches.slice(0, 10)) { const item = { name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, effect: tool.effect || 'read' }; if (JSON.stringify([...selected,item]).length <= 12000) selected.push(item); }
        return { content: [{ type: 'text', text: JSON.stringify({ tools: selected, total: matches.length }) }], details: {} };
      } };
    const call = { name: 'call_connected_tool', contextProvider: 'workspace', effect: 'write', label: 'Use an authorized connected service tool',
      description: 'Execute a tool returned by find_connected_tools using its exact schema. Read tools retain their grants; action tools use the durable write ledger. Acceptance alone is not verified completion.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name','arguments'], additionalProperties: false },
      execute: async (id, args, signal) => { signal?.throwIfAborted(); if (!isCurrent() || !object(args) || Object.keys(args).some(key => !['name','arguments'].includes(key)) || typeof args.name !== 'string') throw fail('Invalid connected tool call.'); const tool = all().find(item => item.name === args.name); if (!tool) throw fail('This tool is not currently authorized.', 403); return tool.execute(id, args.arguments, signal); } };
    return [...tools.slice(0, Math.max(0, exposedLimit - 2)), find, call];
  }
  redactMetadata(value, depth = 0) {
    if (depth > 16) return '[truncated]';
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.redactMetadata(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.redactMetadata(item, depth + 1)]));
    return value;
  }
  redact(text) {
    let safe = String(text);
    for (const config of Object.values(this.configs)) {
      const oauth = config.oauth || {};
      const secrets = [...Object.values(config.headers || {}), ...Object.values(config.env || {}), ...(config.url ? [...new URL(config.url).searchParams.values()] : []),
        oauth.tokens?.access_token, oauth.tokens?.refresh_token, oauth.tokens?.id_token, oauth.clientInformation?.client_secret, oauth.codeVerifier];
      for (const value of secrets) { if (typeof value !== 'string' || value.length < 4) continue; safe = safe.replaceAll(value, '[redacted]'); const token = value.replace(/^Bearer\s+/i, ''); if (token.length >= 4 && token !== value) safe = safe.replaceAll(token, '[redacted]'); }
    }
    return safe;
  }
  async close() { this.closed = true; await Promise.allSettled([...this.connections.keys()].map(id => this.disconnect(id))); }
}
