// Controlled transport for the eventual actual-model activation-quality gate.
// It is deliberately not used by `npm run eval:activation-quality`. A real run
// needs a frozen candidate and the central single-heavy slot. This module only
// provides a bounded, context-isolated way to send the production reasoner's
// existing protocol payloads through the locally configured Claude Code CLI and
// wrap the untouched result/usage back into that same protocol.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const BRIDGE_VERSION = 'activation-quality-bridge-2026-11-13.1';
export const MAX_MODEL_REQUESTS = 8;
export const DEFAULT_FORBIDDEN_MARKERS = [
  'central-activation-gold',
  'oracleVersion',
  '56-activation-quality-gold',
  'activation-quality.json',
  'CLAUDE.md',
  '.internal/agents'
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bridgeError(code, detail) {
  const error = new Error(detail || code);
  error.code = code;
  return error;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => contentText(item)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return contentText(value.text ?? value.content ?? value.input_text ?? '');
  return '';
}

function extractProtocol(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemFromMessages = messages
    .filter(message => message?.role === 'system' || message?.role === 'developer')
    .map(message => contentText(message.content)).filter(Boolean).join('\n\n');
  const system = (contentText(body?.system) || contentText(body?.instructions) || systemFromMessages).trim();
  const users = messages.filter(message => message?.role === 'user');
  let user = users.length ? contentText(users.at(-1)?.content) : '';
  if (!user && body?.input != null) user = contentText(body.input);
  if (!user && typeof body?.prompt === 'string') user = body.prompt;
  const kind = body?.input != null || 'instructions' in (body || {}) ? 'responses'
    : messages.length && !('system' in (body || {})) ? 'chat' : 'messages';
  return { system, user: String(user || '').trim(), kind };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const numeric = (...values) => values.find(value => Number.isFinite(value)) ?? null;
  const usage = {
    input_tokens: numeric(raw.input_tokens, raw.prompt_tokens),
    output_tokens: numeric(raw.output_tokens, raw.completion_tokens),
    cache_read_input_tokens: numeric(raw.cache_read_input_tokens, raw.cache_read_tokens, raw.input_tokens_details?.cached_tokens),
    cache_creation_input_tokens: numeric(raw.cache_creation_input_tokens)
  };
  return Object.values(usage).some(value => value != null) ? usage : null;
}

function usagePayload(usage) {
  if (!usage) return undefined;
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value != null));
}

function wrapResponse(kind, { text, usage, modelAlias, index }) {
  const model = modelAlias || 'unknown-alias';
  const normalized = usagePayload(usage);
  if (kind === 'chat') {
    return {
      id: `chatcmpl_bridge_${index}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      ...(normalized ? {
        usage: {
          prompt_tokens: normalized.input_tokens ?? 0,
          completion_tokens: normalized.output_tokens ?? 0,
          total_tokens: (normalized.input_tokens ?? 0) + (normalized.output_tokens ?? 0),
          prompt_tokens_details: { cached_tokens: normalized.cache_read_input_tokens ?? 0 }
        }
      } : {})
    };
  }
  if (kind === 'responses') {
    return {
      id: `resp_bridge_${index}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output: [{
        id: `msg_bridge_${index}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      }],
      output_text: text,
      ...(normalized ? {
        usage: {
          input_tokens: normalized.input_tokens ?? 0,
          output_tokens: normalized.output_tokens ?? 0,
          total_tokens: (normalized.input_tokens ?? 0) + (normalized.output_tokens ?? 0),
          input_tokens_details: { cached_tokens: normalized.cache_read_input_tokens ?? 0 }
        }
      } : {})
    };
  }
  return {
    id: `msg_bridge_${index}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    ...(normalized ? {
      usage: {
        input_tokens: normalized.input_tokens ?? 0,
        output_tokens: normalized.output_tokens ?? 0,
        ...(normalized.cache_read_input_tokens != null ? { cache_read_input_tokens: normalized.cache_read_input_tokens } : {}),
        ...(normalized.cache_creation_input_tokens != null ? { cache_creation_input_tokens: normalized.cache_creation_input_tokens } : {})
      }
    } : {})
  };
}

function responseLike(status, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Gateway',
    headers: new Map([['content-type', 'application/json']]),
    body: null,
    async text() { return text; },
    async json() { return JSON.parse(text); },
    clone() { return responseLike(status, payload); }
  };
}

function appendNodeOption(existing, option) {
  const value = String(existing || '').trim();
  if (value.includes(option)) return value;
  return value ? `${value} ${option}` : option;
}

/**
 * CLI transport. The application system prompt is passed explicitly with
 * --system-prompt so the CLI does not add its coding-agent role. The child runs
 * in a clean empty cwd with no tools, no MCP servers, no session persistence and
 * a bounded heap/time. Auth values are never placed in argv or report output.
 */
export function createClaudeCliTransport({
  cliPath = 'claude',
  cliArgsPrefix = [],
  cliVersion = null,
  timeoutMs = 120000,
  maxOutputBytes = 1_000_000,
  cwd = null,
  spawnImpl = spawn,
  envAllowlist = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
  extraEnv = {}
} = {}) {
  const workdir = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-activation-bridge-'));
  const ownsWorkdir = !cwd;

  async function call({ system, prompt, index }) {
    const args = [
      ...cliArgsPrefix,
      '--bare',
      '--print',
      '--system-prompt', system,
      '--tools', '',
      '--output-format', 'json',
      '--no-session-persistence',
      '--strict-mcp-config'
    ];
    const env = {};
    for (const key of envAllowlist) if (process.env[key] != null) env[key] = process.env[key];
    Object.assign(env, extraEnv);
    env.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, '--max-old-space-size=512');

    const started = performance.now();
    return await new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const child = spawnImpl(cliPath, args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      const collect = target => chunk => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          child.kill('SIGKILL');
          finish(reject, bridgeError('BRIDGE_OUTPUT_LIMIT', 'CLI output exceeded the bounded limit.'));
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout?.on('data', collect('stdout'));
      child.stderr?.on('data', collect('stderr'));
      child.on('error', error => finish(reject, bridgeError('BRIDGE_SPAWN_ERROR', error.message)));
      child.on('close', code => {
        if (timedOut) return finish(reject, bridgeError('BRIDGE_TIMEOUT', `CLI exceeded ${timeoutMs}ms.`));
        if (code !== 0) return finish(reject, bridgeError('BRIDGE_CLI_EXIT', `CLI exited with code ${code}.`));
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return finish(reject, bridgeError('BRIDGE_INVALID_CLI_JSON', 'CLI stdout was not one JSON object.'));
        }
        const text = typeof parsed.result === 'string' ? parsed.result
          : typeof parsed.text === 'string' ? parsed.text : null;
        if (typeof text !== 'string') return finish(reject, bridgeError('BRIDGE_INVALID_RESULT', 'CLI JSON did not contain a result string.'));
        const modelAlias = parsed.model || Object.keys(parsed.modelUsage || {})[0] || null;
        finish(resolve, {
          text,
          usage: normalizeUsage(parsed.usage),
          modelAlias,
          modelAliasMutable: true,
          cliVersion: parsed.version || cliVersion,
          exitCode: code,
          latencyMs: Number((performance.now() - started).toFixed(3)),
          stdoutDigest: sha256(stdout),
          stderrDigest: sha256(stderr),
          stderrBytes: Buffer.byteLength(stderr),
          requestIndex: index
        });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    });
  }

  return {
    kind: 'claude-cli',
    cliVersion,
    workdir,
    isolation: {
      bare: true,
      tools: 'none',
      mcp: 'strict-empty',
      sessionPersistence: false,
      systemPromptMode: 'explicit_cli_system_prompt',
      possibleCodingAgentWrap: false,
      cleanCwd: path.resolve(workdir) !== path.resolve(process.cwd()),
      heapLimitMb: 512,
      timeoutMs
    },
    describe() {
      return {
        kind: 'claude-cli',
        cliVersion,
        workdir,
        envKeys: envAllowlist.filter(key => process.env[key] != null),
        isolation: this.isolation,
        authInArgv: false
      };
    },
    call,
    dispose() {
      if (ownsWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
    }
  };
}

/**
 * Fetch implementation injected into the production reasoner. Every request is
 * counted before transport, the production system/user content is checked for
 * oracle/project markers, and only hashes/metrics are retained in the report.
 */
export function createFetchBridge({
  transport,
  maxRequests = MAX_MODEL_REQUESTS,
  forbiddenMarkers = DEFAULT_FORBIDDEN_MARKERS
} = {}) {
  if (!transport || typeof transport.call !== 'function') throw bridgeError('BRIDGE_TRANSPORT_REQUIRED', 'A transport with call() is required.');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_MODEL_REQUESTS) {
    throw bridgeError('BRIDGE_BUDGET_INVALID', `maxRequests must be an integer from 1 to ${MAX_MODEL_REQUESTS}.`);
  }
  const requests = [];
  let used = 0;

  async function fetchImpl(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'POST') throw bridgeError('BRIDGE_METHOD_REJECTED', 'Only model POST requests are allowed.');
    if (used >= maxRequests) throw bridgeError('BRIDGE_BUDGET_EXHAUSTED', `The bridge already used ${maxRequests} model requests.`);
    let body;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    } catch {
      throw bridgeError('BRIDGE_BODY_INVALID', 'The model request body was not JSON.');
    }
    if (!body || typeof body !== 'object') throw bridgeError('BRIDGE_BODY_INVALID', 'The model request body was not an object.');
    const { system, user, kind } = extractProtocol(body);
    if (!system || !user) throw bridgeError('BRIDGE_PROMPT_INCOMPLETE', 'Production system and user prompts are required.');
    const wire = `${system}\n${user}`;
    for (const marker of forbiddenMarkers) {
      if (wire.includes(marker)) throw bridgeError('BRIDGE_CONTEXT_LEAK', `Forbidden context marker was present: ${marker}`);
    }
    const rawBody = typeof init.body === 'string' ? init.body : JSON.stringify(body);
    used += 1;
    const index = used;
    const started = performance.now();
    try {
      const result = await transport.call({ system, prompt: user, index });
      const payload = wrapResponse(kind, {
        text: result.text,
        usage: result.usage,
        modelAlias: result.modelAlias,
        index
      });
      requests.push({
        index,
        kind,
        endpointPath: (() => { try { return new URL(url).pathname; } catch { return null; } })(),
        requestDigest: sha256(rawBody),
        requestBytes: Buffer.byteLength(rawBody),
        systemDigest: sha256(system),
        userDigest: sha256(user),
        resultDigest: sha256(result.text),
        resultBytes: Buffer.byteLength(result.text),
        usage: result.usage || null,
        modelAlias: result.modelAlias || null,
        modelAliasMutable: true,
        cliVersion: result.cliVersion || transport.cliVersion || null,
        responseValid: true,
        errorClass: null,
        latencyMs: Number((performance.now() - started).toFixed(3))
      });
      return responseLike(200, payload);
    } catch (error) {
      requests.push({
        index,
        kind,
        endpointPath: (() => { try { return new URL(url).pathname; } catch { return null; } })(),
        requestDigest: sha256(rawBody),
        requestBytes: Buffer.byteLength(rawBody),
        systemDigest: sha256(system),
        userDigest: sha256(user),
        resultDigest: null,
        resultBytes: null,
        usage: null,
        modelAlias: null,
        modelAliasMutable: true,
        cliVersion: transport.cliVersion || null,
        responseValid: false,
        errorClass: error?.code || 'BRIDGE_TRANSPORT_ERROR',
        latencyMs: Number((performance.now() - started).toFixed(3))
      });
      return responseLike(502, { error: { type: 'bridge_provider_failure', code: error?.code || 'BRIDGE_ERROR' } });
    }
  }

  return {
    fetchImpl,
    requests,
    report() {
      return {
        version: BRIDGE_VERSION,
        transport: transport.kind || 'custom',
        maxRequests,
        usedRequests: used,
        remainingRequests: maxRequests - used,
        providerFailures: requests.filter(request => !request.responseValid).length,
        requests: requests.map(request => ({ ...request })),
        contextLeakCheck: 'marker_scan',
        forbiddenMarkers,
        authInArgv: false,
        transportDescription: typeof transport.describe === 'function' ? transport.describe() : null
      };
    },
    dispose() {
      if (typeof transport.dispose === 'function') transport.dispose();
    }
  };
}
