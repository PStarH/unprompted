import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readRegularFile } from './local-files.js';

export const MCP_LIMITS = Object.freeze({ servers: 12, tools: 64, exposedTools: 24, maxConcurrent: 4, timeoutMs: 15000, resultChars: 6000, configBytes: 128 * 1024 });
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

export function normalizeMcpConfig(id, value) {
  if (!validId(id) || !object(value)) throw fail('Invalid MCP server name or configuration.');
  for (const flag of ['enabled', 'allowDeclaredRead']) if (value[flag] != null && typeof value[flag] !== 'boolean') throw fail('Invalid MCP permission value.');
  const type = value.type || value.transport || (value.url ? 'http' : 'stdio');
  const config = { type: type === 'streamable-http' ? 'http' : type, enabled: value.enabled !== false,
    // The user grants a connection access to declared read tools once. The
    // annotation is a server claim, so this is shown explicitly in the form.
    allowDeclaredRead: value.allowDeclaredRead === true, readTools: strings(value.readTools) ? [...new Set(value.readTools)] : [],
    readResources: strings(value.readResources) ? [...new Set(value.readResources)] : [] };
  if (value.readTools != null && !strings(value.readTools)) throw fail('Invalid MCP read tool permissions.');
  if (value.readResources != null && (!strings(value.readResources) || value.readResources.some(id => !/^[a-f0-9]{64}$/.test(id)))) throw fail('Invalid MCP resource permissions.');
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
  return config;
}

export function parseMcpImport(value, { allowDeclaredRead = false } = {}) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw fail('Invalid MCP JSON.'); }
  const servers = parsed?.mcpServers;
  if (!object(servers) || !Object.keys(servers).length || Object.keys(servers).length > MCP_LIMITS.servers || JSON.stringify(parsed).length > MCP_LIMITS.configBytes) throw fail('Expected {"mcpServers":{"name":{...}}}, with at most 12 servers.');
  return Object.fromEntries(Object.entries(servers).map(([id, config]) => [id, normalizeMcpConfig(id, { ...config, allowDeclaredRead })]));
}

/** Private configuration is deliberately separate from task exports and state. */
export class McpConfigStore {
  constructor(directory) { this.directory = directory; this.filePath = path.join(directory, 'mcp.json'); }
  get() {
    try {
      const data = JSON.parse(readRegularFile(this.filePath, { maxBytes: MCP_LIMITS.configBytes, mode: 0o600 }));
      if (!object(data) || Object.keys(data).length > MCP_LIMITS.servers) throw fail('Invalid saved MCP configuration.');
      return Object.fromEntries(Object.entries(data).map(([id, value]) => [id, normalizeMcpConfig(id, value)]));
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  write(configs) {
    const payload = JSON.stringify(configs, null, 2) + '\n';
    if (Buffer.byteLength(payload) > MCP_LIMITS.configBytes) throw fail('MCP configuration is too large.');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
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
  if (/401|403|unauthoriz|authenticat/i.test(error.message || '')) return 'MCP authentication failed. Check the authorization header or server credentials.';
  if (error.code === 'ENOENT' || /ENOENT/.test(error.message || '')) return 'MCP executable not found. Check the command and installation.';
  return 'MCP request failed. Check the server configuration and reconnect.';
}

export class McpManager {
  constructor({ configStore, timeoutMs = MCP_LIMITS.timeoutMs, load = loadSdk, onChange = () => {} } = {}) {
    this.configStore = configStore; this.configs = configStore.get(); this.timeoutMs = timeoutMs;
    this.load = load; this.onChange = onChange; this.connections = new Map(); this.busy = false; this.closed = false; this.inFlight = 0;
  }
  describe() {
    return { servers: Object.entries(this.configs).map(([id, config]) => {
      const connection = this.connections.get(id);
      return { id, type: config.type, enabled: config.enabled, endpoint: config.url ? new URL(config.url).origin : 'stdio',
        status: connection?.status || 'disconnected', lastError: connection?.lastError || null,
        allowDeclaredRead: config.allowDeclaredRead,
        tools: (connection?.tools || []).filter(tool => this.redact(String(tool.name)) === tool.name).map(tool => ({ name: tool.name, description: this.redact(String(tool.description || '')).slice(0, 500), inputSchema: this.redactMetadata(tool.inputSchema),
          declaredReadOnly: tool.annotations?.readOnlyHint === true, writeTool: tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true, allowed: this.allowed(config, tool) })),
        resources: (connection?.resources || []).map(resource => ({ id: resourceId(resource.uri), name: this.redact(String(resource.name || '').slice(0, 300)), description: this.redact(String(resource.description || '').slice(0, 500)), allowed: config.enabled && config.readResources.includes(resourceId(resource.uri)) })) };
    }), limits: MCP_LIMITS };
  }
  allowed(config, tool) {
    return config.enabled && tool.annotations?.readOnlyHint !== false && tool.annotations?.destructiveHint !== true
      && (config.readTools.includes(tool.name) || (config.allowDeclaredRead && tool.annotations?.readOnlyHint === true));
  }
  async exclusive(fn) {
    if (this.closed) throw fail('MCP is shutting down.', 503);
    if (this.busy) throw fail('An MCP connection update is already running.', 409);
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; this.onChange(); }
  }
  async import(value, options) {
    const incoming = parseMcpImport(value, options);
    return this.exclusive(async () => {
      const merged = { ...this.configs, ...incoming };
      if (Object.keys(merged).length > MCP_LIMITS.servers || JSON.stringify(merged).length > MCP_LIMITS.configBytes) throw fail('Too many MCP servers or configuration too large.');
      this.configStore.write(merged); this.configs = merged;
      await Promise.all(Object.keys(incoming).map(async id => { await this.disconnect(id); if (merged[id].enabled) await this.connect(id); }));
      return this.describe();
    });
  }
  async update(id, { enabled, readTools, readResources, allowDeclaredRead, remove = false, reconnect = false }) {
    if (typeof remove !== 'boolean' || typeof reconnect !== 'boolean') throw fail('Invalid MCP update value.');
    if (!Object.hasOwn(this.configs, id)) throw fail('Unknown MCP server.', 404);
    return this.exclusive(async () => {
      const merged = { ...this.configs };
      if (remove) delete merged[id];
      else merged[id] = normalizeMcpConfig(id, { ...merged[id], ...(enabled != null ? { enabled } : {}), ...(readTools != null ? { readTools } : {}), ...(readResources != null ? { readResources } : {}), ...(allowDeclaredRead != null ? { allowDeclaredRead } : {}) });
      this.configStore.write(merged); this.configs = merged;
      if (remove || !merged[id].enabled || reconnect) await this.disconnect(id);
      if (merged[id]?.enabled && (reconnect || enabled === true)) await this.connect(id);
      return this.describe();
    });
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
    let timer;
    try {
      const sdk = await this.load();
      entry.schemaValidator = sdk.fromJsonSchema;
      if (this.closed || this.connections.get(id) !== entry) throw fail('MCP connection cancelled.');
      const client = new sdk.Client({ name: 'unprompted', version: '0.3.0' }, { capabilities: {}, listMaxPages: 8,
        listChanged: { tools: { onChanged: (error, tools) => {
          if (this.connections.get(id) !== entry) return;
          if (error || !Array.isArray(tools) || tools.length > MCP_LIMITS.tools || JSON.stringify(tools).length > 64000) {
            entry.tools = []; entry.lastError = 'MCP tool catalog changed. Reconnect to refresh tools.';
          } else { entry.tools = tools; entry.lastError = null; }
          this.onChange();
        } }, resources: { onChanged: (error, resources) => {
          if (this.connections.get(id) !== entry) return;
          if (error || !Array.isArray(resources) || resources.length > MCP_LIMITS.tools || JSON.stringify(resources).length > 64000) {
            entry.resources = []; entry.lastError = 'MCP resource catalog changed. Reconnect to refresh resources.';
          } else { entry.resources = resources; entry.lastError = null; }
          this.onChange();
        } } }
      });
      const transport = config.type === 'stdio'
        ? new sdk.StdioClientTransport({ command: config.command, args: config.args, env: { ...sdk.getDefaultEnvironment(), ...config.env }, ...(config.cwd ? { cwd: config.cwd } : {}), stderr: 'ignore', maxBufferSize: 1024 * 1024 })
        : new (config.type === 'sse' ? sdk.SSEClientTransport : sdk.StreamableHTTPClientTransport)(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' }, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([entry.controller.signal, ...(init?.signal ? [init.signal] : [])]), redirect: 'error' }) });
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
            if (items.length > MCP_LIMITS.tools || JSON.stringify(items).length > 64000) throw fail('MCP catalog exceeds the supported limit.');
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
  tools({ isCurrent = () => false, onCall = () => {} } = {}) {
    const tools = [];
    for (const [serverId, entry] of this.connections) {
      const config = this.configs[serverId];
      if (!config || entry.status !== 'connected') continue;
      for (const tool of entry.tools) {
        if (this.redact(String(tool.name)) !== tool.name || !this.allowed(config, tool) || tools.length >= MCP_LIMITS.exposedTools) continue;
        const name = `mcp_${createHash('sha256').update(`${serverId}\0${tool.name}`).digest('hex').slice(0, 16)}`;
        tools.push({ name, label: `${serverId} · ${tool.name}`, description: this.redact(`${serverId} / ${tool.name}: ${tool.description || ''}`).slice(0, 1000), parameters: this.redactMetadata(tool.inputSchema),
          execute: async (_id, args, signal) => {
            if (this.closed || !isCurrent() || this.connections.get(serverId) !== entry || !entry.tools.includes(tool) || entry.status !== 'connected' || !this.allowed(this.configs[serverId] || { enabled: false }, tool)) throw fail('MCP tool access is no longer current.', 409);
            if (!object(args) || JSON.stringify(args).length > 8000) throw fail('Invalid MCP tool arguments.');
            try {
              if (typeof entry.schemaValidator !== 'function') throw new Error('Validator unavailable');
              const validation = await entry.schemaValidator(tool.inputSchema)['~standard'].validate(args);
              if (validation.issues) throw new Error('Invalid arguments');
            } catch { throw fail('MCP tool arguments do not match the advertised schema.'); }
            if (this.closed || !isCurrent() || this.connections.get(serverId) !== entry || !entry.tools.includes(tool) || entry.status !== 'connected' || !this.allowed(this.configs[serverId] || { enabled: false }, tool)) throw fail('MCP tool access is no longer current.', 409);
            if (this.inFlight >= MCP_LIMITS.maxConcurrent) throw fail('MCP read concurrency limit reached. Retry later.', 429);
            this.inFlight++;
            const startedAt = new Date().toISOString();
            let status = 'failed', text = '', error = null;
            try {
              const result = await entry.client.callTool({ name: tool.name, arguments: args }, {
                timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs, signal: AbortSignal.any([entry.controller.signal, ...(signal instanceof AbortSignal ? [signal] : [])])
              });
              if (!isCurrent() || this.connections.get(serverId) !== entry || !entry.tools.includes(tool) || !this.allowed(this.configs[serverId] || { enabled: false }, tool)) throw fail('MCP task or connection changed during the call.', 409);
              if (result.isError) throw fail('MCP tool reported an error.');
              // Text and structured data only. Never fetch returned image/resource URLs.
              const contents = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
              text = this.redact(result.structuredContent ? JSON.stringify({ content: contents, structuredContent: result.structuredContent }) : contents).slice(0, MCP_LIMITS.resultChars);
              status = 'completed';
              return { content: [{ type: 'text', text: text || '(No text content returned)' }], details: {} };
            } catch (cause) { error = errorMessage(cause); throw fail(error, 502); }
            finally { this.inFlight--; onCall({ id: randomUUID(), serverId, tool: tool.name, status, startedAt, finishedAt: new Date().toISOString(), ...(error ? { error } : { text }) }); }
          }
        });
      }
      for (const resource of entry.resources) {
        const id = resourceId(resource.uri);
        if (!config.readResources.includes(id) || tools.length >= MCP_LIMITS.exposedTools) continue;
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
    return tools;
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
      const secrets = [...Object.values(config.headers || {}), ...Object.values(config.env || {}), ...(config.url ? [...new URL(config.url).searchParams.values()] : [])];
      for (const value of secrets) { if (value.length >= 4) safe = safe.replaceAll(value, '[redacted]'); const token = value.replace(/^Bearer\s+/i, ''); if (token.length >= 4) safe = safe.replaceAll(token, '[redacted]'); }
    }
    return safe;
  }
  async close() { this.closed = true; await Promise.allSettled([...this.connections.keys()].map(id => this.disconnect(id))); }
}
