import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalSetupStore } from '../src/setup.js';
import { McpConfigStore } from '../src/mcp.js';
import {
  DpapiKeyStore, FileKeyStore, LinuxSecretStore, MacOsKeyStore, MemoryKeyStore,
  SEAL_PREFIX, createKeyStore, openSetupDocument, openString, sealSetupDocument, sealString,
  visitSetupSecrets, writeSealedJson
} from '../src/at-rest.js';

function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-at-rest-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function silence(t) {
  const calls = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map(method => [method, console[method]]));
  for (const method of methods) console[method] = (...args) => { calls.push(args.map(String).join(' ')); };
  t.after(() => { for (const method of methods) console[method] = originals[method]; });
  return calls;
}

const LEGACY = {
  version: 1,
  model: { baseUrl: 'https://provider.example/v1', model: 'fixture', apiKey: 'legacy-model-key' },
  google: { clientId: 'public-client-id', clientSecret: 'legacy-client-secret', refreshToken: 'legacy-refresh-token' },
  connections: { github: { clientId: 'public-github-id', accessToken: 'legacy-access-token', refreshToken: 'legacy-connection-refresh', clientSecret: 'legacy-connection-secret' } }
};
const LEGACY_SECRETS = ['legacy-model-key', 'legacy-client-secret', 'legacy-refresh-token', 'legacy-access-token', 'legacy-connection-refresh', 'legacy-connection-secret'];

test('AES-GCM round-trips unicode secrets and rejects tampering or a swapped field', () => {
  const key = randomBytes(32);
  const secret = '密钥-token-\n-with-unicode-🔑';
  const sealed = sealString(secret, key, 'setup:model.apiKey');
  assert.equal(sealed.startsWith(SEAL_PREFIX), true);
  assert.equal(sealed.includes(secret), false);
  assert.equal(openString(sealed, key, 'setup:model.apiKey'), secret);
  assert.notEqual(sealString(secret, key, 'setup:model.apiKey'), sealed);
  assert.throws(() => openString(sealed, randomBytes(32), 'setup:model.apiKey'), error => {
    assert.equal(error.code, 'SECRET_UNREADABLE');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.throws(() => openString(sealed, key, 'setup:google.refreshToken'), /could not be decrypted/);
  const chars = sealed.split('');
  chars[chars.length - 2] = chars[chars.length - 2] === 'A' ? 'B' : 'A';
  assert.throws(() => openString(chars.join(''), key, 'setup:model.apiKey'), /could not be decrypted/);
  const long = 'k'.repeat(20_000);
  assert.equal(openString(sealString(long, key, 'purpose'), key, 'purpose'), long);
});

test('a plaintext setup file migrates in place and a later open keeps the same credentials', t => {
  const logs = silence(t);
  const folder = directory(t);
  const file = path.join(folder, 'setup.json');
  const key = randomBytes(32);
  fs.writeFileSync(file, `${JSON.stringify(LEGACY, null, 2)}\n`, { mode: 0o600 });
  const store = new LocalSetupStore({ filePath: file, keyStore: new MemoryKeyStore(key) });
  assert.equal(store.get().model.apiKey, 'legacy-model-key');
  assert.equal(store.get().google.clientSecret, 'legacy-client-secret');
  assert.equal(store.get().google.refreshToken, 'legacy-refresh-token');
  assert.equal(store.get().google.clientId, 'public-client-id');
  assert.equal(store.get().connections.github.accessToken, 'legacy-access-token');
  assert.equal(store.get().connections.github.refreshToken, 'legacy-connection-refresh');
  assert.equal(store.get().connections.github.clientSecret, 'legacy-connection-secret');
  const disk = fs.readFileSync(file, 'utf8');
  for (const secret of LEGACY_SECRETS) assert.equal(disk.includes(secret), false, secret);
  assert.match(disk, /unprompted-seal:v1:/);
  assert.match(disk, /public-client-id/);
  assert.equal(logs.some(line => LEGACY_SECRETS.some(secret => line.includes(secret))), false);
  const status = JSON.stringify(store.publicStatus());
  assert.equal(LEGACY_SECRETS.some(secret => status.includes(secret)), false);
  assert.equal(store.publicStatus().secretsAtRest.algorithm, 'aes-256-gcm');
  const wrong = randomBytes(32);
  assert.throws(() => new LocalSetupStore({ filePath: file, keyStore: new MemoryKeyStore(wrong) }), error => {
    assert.match(error.message, /left unchanged/);
    assert.equal(error.message.includes('legacy-refresh-token'), false);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
  const restored = new LocalSetupStore({ filePath: file, keyStore: new MemoryKeyStore(Buffer.from(key)) });
  assert.equal(restored.get().google.refreshToken, 'legacy-refresh-token');
  assert.equal(restored.get().connections.github.clientSecret, 'legacy-connection-secret');
  assert.equal(restored.runtimeEnv({}).GOOGLE_REFRESH_TOKEN, 'legacy-refresh-token');
  assert.equal(restored.runtimeEnv({}).UNPROMPTED_MODEL_API_KEY, 'legacy-model-key');
});

test('swapped ciphertext does not decrypt as another field', () => {
  const key = randomBytes(32);
  const sealed = sealSetupDocument({
    model: { apiKey: 'model-key-value' },
    google: { clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value' },
    connections: {}
  }, key);
  const apiKey = sealed.model.apiKey;
  sealed.model.apiKey = sealed.google.refreshToken;
  sealed.google.refreshToken = apiKey;
  assert.throws(() => openSetupDocument(sealed, key), /could not be decrypted/);
});

test('refuses to write plaintext secrets and does not create the file', t => {
  const folder = directory(t);
  const file = path.join(folder, 'setup.json');
  const key = randomBytes(32);
  const document = {
    model: { apiKey: 'super-secret-value' },
    google: { clientSecret: 'desktop-client-secret', refreshToken: null },
    connections: { todoist: { accessToken: 'todoist-personal-token' } }
  };
  assert.throws(() => writeSealedJson(file, document, key, value => value, visitSetupSecrets), error => {
    assert.equal(error.code, 'SECRET_PLAINTEXT');
    assert.equal(error.message.includes('super-secret-value'), false);
    return true;
  });
  assert.equal(fs.existsSync(file), false);
  writeSealedJson(file, document, key, sealSetupDocument, visitSetupSecrets);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('super-secret-value'), false);
  assert.equal(disk.includes('desktop-client-secret'), false);
  assert.equal(disk.includes('todoist-personal-token'), false);
  assert.equal(openSetupDocument(JSON.parse(disk), key).document.connections.todoist.accessToken, 'todoist-personal-token');
});

test('plaintext MCP credentials migrate and stay usable without a new sign-in', t => {
  const logs = silence(t);
  const folder = directory(t);
  const key = randomBytes(32);
  const file = path.join(folder, 'mcp.json');
  const verifier = 'plaintext-verifier-0123456789abcdef';
  fs.writeFileSync(file, `${JSON.stringify({
    local: {
      type: 'stdio', command: 'node', args: ['server.js'], enabled: true,
      env: { MCP_FIXTURE_SECRET: 'plaintext-env-secret' },
      oauth: {
        tokens: { access_token: 'plaintext-access-token', refresh_token: 'plaintext-refresh-token', token_type: 'Bearer' },
        clientInformation: { client_id: 'public-mcp-client', client_secret: 'plaintext-mcp-client-secret' },
        codeVerifier: verifier
      }
    },
    remote: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer plaintext-header-secret' } }
  }, null, 2)}\n`);
  const store = new McpConfigStore(folder, { keyStore: new MemoryKeyStore(key) });
  const opened = store.get();
  assert.equal(opened.local.env.MCP_FIXTURE_SECRET, 'plaintext-env-secret');
  assert.equal(opened.remote.headers.Authorization, 'Bearer plaintext-header-secret');
  assert.equal(opened.local.oauth.tokens.access_token, 'plaintext-access-token');
  assert.equal(opened.local.oauth.tokens.refresh_token, 'plaintext-refresh-token');
  assert.equal(opened.local.oauth.tokens.token_type, 'Bearer');
  assert.equal(opened.local.oauth.clientInformation.client_secret, 'plaintext-mcp-client-secret');
  assert.equal(opened.local.oauth.codeVerifier, verifier);
  const disk = fs.readFileSync(file, 'utf8');
  for (const secret of ['plaintext-env-secret', 'plaintext-header-secret', 'plaintext-access-token', 'plaintext-refresh-token', 'plaintext-mcp-client-secret', verifier]) {
    assert.equal(disk.includes(secret), false, secret);
  }
  assert.match(disk, /unprompted-seal:v1:/);
  assert.match(disk, /public-mcp-client/);
  assert.equal(logs.some(line => line.includes('plaintext-access-token') || line.includes(verifier)), false);
  const again = new McpConfigStore(folder, { keyStore: new MemoryKeyStore(Buffer.from(key)) });
  assert.equal(again.get().local.oauth.tokens.refresh_token, 'plaintext-refresh-token');
  assert.equal(again.get().local.env.MCP_FIXTURE_SECRET, 'plaintext-env-secret');
});

test('macOS keychain key is not written beside the ciphertext', t => {
  const folder = directory(t);
  let saved = null;
  const calls = [];
  const runCommand = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    if (args[0] === 'find-generic-password') {
      assert.equal(args.includes(saved), false);
      if (!saved) return { status: 44, stdout: '' };
      return { status: 0, stdout: `${saved}\n` };
    }
    if (args[0] === 'add-generic-password') {
      assert.equal(args.includes('-A'), true);
      saved = args[args.indexOf('-w') + 1];
      return { status: 0, stdout: '' };
    }
    return { status: 127, stdout: '', missingCommand: true };
  };
  const store = createKeyStore({ directory: folder, env: {}, platform: 'darwin', runCommand });
  const key = store.load();
  assert.equal(key.length, 32);
  assert.equal(fs.existsSync(path.join(folder, 'secret.key')), false);
  const meta = JSON.parse(fs.readFileSync(path.join(folder, 'secret-key.json'), 'utf8'));
  assert.equal(meta.backend, 'os-keychain');
  assert.equal(JSON.stringify(meta).includes(saved), false);
  assert.equal(calls.some(call => call.command !== '/usr/bin/security'), false);
  assert.equal(calls.filter(call => call.args[0] === 'add-generic-password').length, 1);
  const again = createKeyStore({ directory: folder, env: {}, platform: 'darwin', runCommand });
  assert.equal(again.load().equals(key), true);
  assert.equal(calls.filter(call => call.args[0] === 'add-generic-password').length, 1);
});

test('Linux secret service receives the key on stdin, not on the command line', t => {
  const folder = directory(t);
  let saved = null;
  const runCommand = (command, args, options = {}) => {
    assert.equal(command, 'secret-tool');
    assert.equal(args.includes(saved), false);
    if (args[0] === 'lookup') return saved ? { status: 0, stdout: `${saved}\n` } : { status: 1, stdout: '' };
    assert.equal(args[0], 'store');
    assert.equal(args.includes(options.input), false);
    saved = options.input;
    return { status: 0, stdout: '' };
  };
  const key = createKeyStore({ directory: folder, env: {}, platform: 'linux', runCommand }).load();
  assert.equal(fs.existsSync(path.join(folder, 'secret.key')), false);
  assert.equal(createKeyStore({ directory: folder, env: {}, platform: 'linux', runCommand }).load().equals(key), true);
});

test('Windows DPAPI blob does not contain the raw key, and the script is not given the key on the command line', t => {
  const folder = directory(t);
  let protectedKey = null;
  const runCommand = (command, args, options = {}) => {
    assert.equal(command, 'powershell.exe');
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.equal(script.includes(protectedKey || 'raw-key-marker'), false);
    const [mode, payload] = options.input.split('\n');
    assert.equal(script.includes(payload), false);
    if (mode === 'protect') { protectedKey = payload; return { status: 0, stdout: 'BLOB' }; }
    assert.equal(payload, 'BLOB');
    return { status: 0, stdout: protectedKey };
  };
  const store = new DpapiKeyStore(folder, { runCommand, allowCreate: true });
  const key = store.load();
  assert.equal(fs.readFileSync(path.join(folder, 'secret.key.dpapi'), 'utf8').includes(protectedKey), false);
  assert.equal(fs.readFileSync(path.join(folder, 'secret.key.dpapi'), 'utf8').trim(), 'BLOB');
  assert.equal(new DpapiKeyStore(folder, { runCommand, allowCreate: false }).load().equals(key), true);
});

test('a missing OS store falls back once to a private key file and then stays there', t => {
  const folder = directory(t);
  const unavailable = () => ({ status: 127, stdout: '', missingCommand: true });
  assert.throws(() => createKeyStore({ directory: folder, env: { UNPROMPTED_SECRET_BACKEND: 'os-keychain' }, platform: 'linux', runCommand: unavailable }), /unavailable|could not|secret service/i);
  assert.equal(fs.existsSync(path.join(folder, 'secret.key')), false);
  const store = createKeyStore({ directory: folder, env: {}, platform: 'linux', runCommand: unavailable });
  const key = store.load();
  const meta = JSON.parse(fs.readFileSync(path.join(folder, 'secret-key.json'), 'utf8'));
  assert.equal(meta.backend, 'file');
  assert.equal(meta.fallbackFrom, 'os-keychain');
  assert.equal(meta.file, 'secret.key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(folder, 'secret.key')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(folder, 'secret-key.json'), 'utf8').includes(key.toString('base64url')), false);
  assert.equal(createKeyStore({ directory: folder, env: {}, platform: 'linux', runCommand: unavailable }).load().equals(key), true);
  const stuck = directory(t);
  fs.writeFileSync(path.join(stuck, 'secret-key.json'), `${JSON.stringify({ version: 1, backend: 'os-keychain', platform: 'linux', service: 'com.unprompted.at-rest', account: 'default' })}\n`);
  assert.throws(() => createKeyStore({ directory: stuck, env: {}, platform: 'linux', runCommand: unavailable }), /unavailable|missing|left unchanged/i);
  assert.equal(fs.existsSync(path.join(stuck, 'secret.key')), false);
});

test('the test runner stores a directory key file instead of touching the OS store', t => {
  const folder = directory(t);
  let called = false;
  const store = createKeyStore({ directory: folder, env: { NODE_TEST_CONTEXT: '1' }, platform: 'darwin', runCommand: () => { called = true; return { status: 0, stdout: '' }; } });
  assert.equal(called, false);
  assert.equal(store.describe().backend, 'file');
  assert.equal(store.load().equals(new FileKeyStore(path.join(folder, 'secret.key'), { allowCreate: false }).load()), true);
});

test('a saved model key is sealed on disk and still returned to the process', t => {
  const folder = directory(t);
  const file = path.join(folder, 'setup.json');
  const store = new LocalSetupStore({ filePath: file, keyStore: new MemoryKeyStore(randomBytes(32)) });
  store.saveModel({ baseUrl: 'https://provider.example/v1', model: 'fixture', apiKey: 'private-fixture-key', harness: 'classic', protocol: 'chat-completions', role: 'primary' }, { status: 'verified' });
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('private-fixture-key'), false);
  assert.match(disk, /unprompted-seal:v1:/);
  assert.equal(store.runtimeEnv({}).UNPROMPTED_MODEL_API_KEY, 'private-fixture-key');
});
