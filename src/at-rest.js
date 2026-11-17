// Local at-rest encryption for credentials written to setup.json and mcp.json.
//
// A random 256-bit key seals those fields with AES-256-GCM before they touch
// disk. The key is kept in the OS secret store when that store is available
// (macOS login keychain, Linux secret service, Windows DPAPI). The first
// successful store is recorded in secret-key.json and reused. Decryption
// happens only in memory. This module does not log key material, sealed
// payloads, command output, or secret values.
//
// Threat model: a copy of the config files, or of the config directory
// without the OS key store, does not reveal the credentials. It does not
// stop malware running as the same user, a memory dump, or anyone who can
// unlock that OS store. The workspace database is a separate file and is
// not sealed here. If the OS store cannot be used on first run, the key
// falls back to secret.key (mode 0600) beside the config. That fallback
// stops other OS accounts from reading the files; a copy of the whole
// directory still includes the key.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SEAL_PREFIX = 'unprompted-seal:v1:';
export const SECRET_SERVICE = 'com.unprompted.at-rest';
export const SECRET_ACCOUNT = 'default';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CONNECTION_SECRET_KEYS = Object.freeze(['accessToken', 'refreshToken', 'clientSecret']);
const OAUTH_TOKEN_KEYS = Object.freeze(['access_token', 'refresh_token', 'id_token']);

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$mode = [Console]::In.ReadLine()
$payload = [Console]::In.ReadLine()
$entropy = [Text.Encoding]::UTF8.GetBytes('${SECRET_SERVICE}')
if ($mode -eq 'protect') {
  $bytes = [Convert]::FromBase64String($payload)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'CurrentUser')
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} elseif ($mode -eq 'unprotect') {
  $bytes = [Convert]::FromBase64String($payload)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, 'CurrentUser')
  [Console]::Out.Write([Convert]::ToBase64String($plain))
} else { exit 2 }
`.trim();

export class SecretBoxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretBoxError';
    this.code = code;
  }
}

function asKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new SecretBoxError('SECRET_KEY', 'A 32-byte at-rest key is required.');
  return key;
}

function keysMatch(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

export function isSealed(value) {
  if (typeof value !== 'string' || !value.startsWith(SEAL_PREFIX)) return false;
  const body = value.slice(SEAL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return false;
  const raw = Buffer.from(body, 'base64url');
  return raw.length > IV_BYTES + TAG_BYTES;
}

export function sealString(plaintext, key, purpose) {
  if (typeof plaintext !== 'string') throw new SecretBoxError('SECRET_TYPE', 'Refusing to write a non-string secret.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', asKey(key), iv);
  cipher.setAAD(Buffer.from(String(purpose || ''), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return SEAL_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function openString(sealed, key, purpose) {
  if (!isSealed(sealed)) throw new SecretBoxError('SECRET_FORMAT', 'Stored secret is not sealed.');
  const raw = Buffer.from(sealed.slice(SEAL_PREFIX.length), 'base64url');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', asKey(key), iv);
    decipher.setAAD(Buffer.from(String(purpose || ''), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError('SECRET_UNREADABLE', 'Stored credentials could not be decrypted. The file was left unchanged.');
  }
}

function assertFieldsSealed(document, visit) {
  visit(document, (holder, field) => {
    const value = holder[field];
    if (value == null || value === '') return;
    if (typeof value !== 'string' || !isSealed(value)) throw new SecretBoxError('SECRET_PLAINTEXT', 'Refusing to write plaintext secrets.');
  });
}

function sealFields(document, key, visit) {
  const copy = structuredClone(document);
  visit(copy, (holder, field, purpose) => {
    const value = holder[field];
    if (value == null || value === '') return;
    if (typeof value !== 'string') throw new SecretBoxError('SECRET_TYPE', 'Refusing to write a non-string secret.');
    holder[field] = sealString(value, key, purpose);
  });
  assertFieldsSealed(copy, visit);
  return copy;
}

function openFields(document, key, visit) {
  const copy = structuredClone(document && typeof document === 'object' ? document : {});
  let migrated = false;
  visit(copy, (holder, field, purpose) => {
    const value = holder[field];
    if (value == null || value === '') return;
    if (typeof value !== 'string') throw new SecretBoxError('SECRET_TYPE', 'A stored secret has an unexpected type. The file was left unchanged.');
    if (!isSealed(value)) { migrated = true; return; }
    holder[field] = openString(value, key, purpose);
  });
  return { document: copy, migrated };
}

export function visitSetupSecrets(document, visit) {
  if (!document || typeof document !== 'object') return;
  if (document.model && typeof document.model === 'object' && !Array.isArray(document.model)) visit(document.model, 'apiKey', 'setup:model.apiKey');
  if (document.google && typeof document.google === 'object' && !Array.isArray(document.google)) {
    visit(document.google, 'clientSecret', 'setup:google.clientSecret');
    visit(document.google, 'refreshToken', 'setup:google.refreshToken');
  }
  const connections = document.connections;
  if (!connections || typeof connections !== 'object' || Array.isArray(connections)) return;
  for (const [id, record] of Object.entries(connections)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    for (const field of CONNECTION_SECRET_KEYS) visit(record, field, `setup:connections.${id}.${field}`);
  }
}

export function visitMcpSecrets(document, visit) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return;
  for (const [id, config] of Object.entries(document)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    for (const bucket of ['headers', 'env']) {
      const map = config[bucket];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const field of Object.keys(map)) visit(map, field, `mcp:${id}:${bucket}:${field}`);
    }
    const oauth = config.oauth;
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) continue;
    if (oauth.tokens && typeof oauth.tokens === 'object' && !Array.isArray(oauth.tokens)) {
      for (const field of OAUTH_TOKEN_KEYS) visit(oauth.tokens, field, `mcp:${id}:oauth.tokens.${field}`);
    }
    if (oauth.clientInformation && typeof oauth.clientInformation === 'object' && !Array.isArray(oauth.clientInformation)) {
      visit(oauth.clientInformation, 'client_secret', `mcp:${id}:oauth.client_secret`);
    }
    visit(oauth, 'codeVerifier', `mcp:${id}:oauth.codeVerifier`);
  }
}

export function sealSetupDocument(document, key) { return sealFields(document, key, visitSetupSecrets); }
export function openSetupDocument(document, key) { return openFields(document, key, visitSetupSecrets); }
export function sealMcpDocument(document, key) { return sealFields(document, key, visitMcpSecrets); }
export function openMcpDocument(document, key) { return openFields(document, key, visitMcpSecrets); }

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* filesystems without POSIX modes */ }
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor != null) { try { fs.closeSync(descriptor); } catch { /* already closed */ } }
    try { fs.unlinkSync(temporary); } catch { /* not created */ }
    throw error;
  }
  fs.closeSync(descriptor);
  try { fs.chmodSync(temporary, 0o600); } catch { /* filesystems without POSIX modes */ }
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* filesystems without POSIX modes */ }
}

export function writeSealedJson(filePath, document, key, sealDocument, visit, { maxBytes = Infinity } = {}) {
  const sealed = sealDocument(structuredClone(document), key);
  assertFieldsSealed(sealed, visit);
  const payload = `${JSON.stringify(sealed, null, 2)}\n`;
  if (Buffer.byteLength(payload) > maxBytes) throw new SecretBoxError('SECRET_TOO_LARGE', 'Refusing to write secrets because the sealed file would exceed its size limit.');
  atomicWrite(filePath, payload);
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* lock wait is rare */ } }
}

function withFileLock(lockPath, fn) {
  const started = Date.now();
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 15_000) { fs.unlinkSync(lockPath); continue; }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started > 15_000) throw new SecretBoxError('KEY_LOCKED', 'Another process holds the at-rest key lock. Saved credentials were left unchanged.');
      sleepMs(25);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

function decodeKey(text) {
  const key = Buffer.from(String(text || '').trim(), 'base64url');
  if (key.length !== KEY_BYTES) throw new SecretBoxError('SECRET_KEY', 'The at-rest key has an unexpected length.');
  return key;
}

export function spawnCommand(command, args, { input } = {}) {
  // stderr is discarded. Keychain tools can echo arguments, and this module
  // must not surface that text to logs or errors.
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (result.error) return { status: result.error.code === 'ENOENT' ? 127 : 1, stdout: '', missingCommand: result.error.code === 'ENOENT' };
  return { status: result.status ?? 1, stdout: result.stdout || '' };
}

export class MemoryKeyStore {
  constructor(key = randomBytes(KEY_BYTES)) {
    if (!Buffer.isBuffer(key)) throw new SecretBoxError('SECRET_KEY', 'A 32-byte at-rest key is required.');
    this.cached = asKey(Buffer.from(key));
  }
  load() { return this.cached; }
  describe() { return { version: 1, backend: 'memory' }; }
}

export class FileKeyStore {
  constructor(filePath, { allowCreate = true, fallbackFrom = null } = {}) {
    this.filePath = filePath;
    this.allowCreate = allowCreate;
    this.fallbackFrom = fallbackFrom;
    this.cached = null;
  }
  load() {
    if (this.cached) return this.cached;
    if (fs.existsSync(this.filePath)) {
      this.cached = decodeKey(fs.readFileSync(this.filePath, 'utf8'));
      return this.cached;
    }
    if (!this.allowCreate) throw new SecretBoxError('SECRET_KEY_MISSING', 'The local secret key file is missing. Saved credentials were left unchanged.');
    const key = randomBytes(KEY_BYTES);
    atomicWrite(this.filePath, `${key.toString('base64url')}\n`);
    const confirmed = decodeKey(fs.readFileSync(this.filePath, 'utf8'));
    if (!keysMatch(key, confirmed)) throw new SecretBoxError('SECRET_KEY', 'The local secret key file could not be read back.');
    this.cached = confirmed;
    return confirmed;
  }
  describe() {
    return { version: 1, backend: 'file', file: 'secret.key', ...(this.fallbackFrom ? { fallbackFrom: this.fallbackFrom } : {}) };
  }
}

export class MacOsKeyStore {
  constructor({ runCommand = spawnCommand, allowCreate = true, service = SECRET_SERVICE, account = SECRET_ACCOUNT } = {}) {
    this.runCommand = runCommand;
    this.allowCreate = allowCreate;
    this.service = service;
    this.account = account;
    this.cached = null;
  }
  load() {
    if (this.cached) return this.cached;
    const existing = this.#read();
    if (existing) { this.cached = decodeKey(existing); return this.cached; }
    if (!this.allowCreate) throw new SecretBoxError('SECRET_KEY_MISSING', 'The OS keychain entry for saved credentials is missing. Saved credentials were left unchanged.');
    const key = randomBytes(KEY_BYTES);
    this.#write(key.toString('base64url'));
    const confirmed = decodeKey(this.#read());
    if (!keysMatch(key, confirmed)) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS keychain did not return the at-rest key.');
    this.cached = confirmed;
    return confirmed;
  }
  describe() { return { version: 1, backend: 'os-keychain', service: this.service, account: this.account, platform: 'darwin' }; }
  #read() {
    // Reads do not put the key on the command line. `security` prints it to stdout.
    const result = this.runCommand('/usr/bin/security', ['find-generic-password', '-s', this.service, '-a', this.account, '-w'], {});
    if (result.missingCommand) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS keychain could not be read.');
    if (result.status === 44) return null;
    if (result.status !== 0) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS keychain could not be read.');
    return result.stdout.replace(/\r?\n$/, '');
  }
  #write(secret) {
    // `-w` is the keychain tool's password argument. It is visible to other
    // processes on this machine for the duration of this one call, which is
    // the same-user boundary this design does not claim to stop. `-A` lets
    // later reads by this user proceed without a keychain prompt so a
    // background launch is not blocked on a dialog.
    const result = this.runCommand('/usr/bin/security', [
      'add-generic-password', '-U', '-A', '-s', this.service, '-a', this.account,
      '-l', 'Unprompted at-rest key', '-w', secret
    ], {});
    if (result.status !== 0) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS keychain could not store the at-rest key.');
  }
}

export class LinuxSecretStore {
  constructor({ runCommand = spawnCommand, allowCreate = true, service = SECRET_SERVICE, account = SECRET_ACCOUNT } = {}) {
    this.runCommand = runCommand;
    this.allowCreate = allowCreate;
    this.service = service;
    this.account = account;
    this.cached = null;
  }
  load() {
    if (this.cached) return this.cached;
    const existing = this.#read();
    if (existing) { this.cached = decodeKey(existing); return this.cached; }
    if (!this.allowCreate) throw new SecretBoxError('SECRET_KEY_MISSING', 'The OS secret service entry for saved credentials is missing. Saved credentials were left unchanged.');
    const key = randomBytes(KEY_BYTES);
    const encoded = key.toString('base64url');
    const result = this.runCommand('secret-tool', ['store', '--label=Unprompted at-rest key', 'service', this.service, 'account', this.account], { input: encoded });
    if (result.status !== 0) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS secret service could not store the at-rest key.');
    const confirmed = decodeKey(this.#read());
    if (!keysMatch(key, confirmed)) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS secret service did not return the at-rest key.');
    this.cached = confirmed;
    return confirmed;
  }
  describe() { return { version: 1, backend: 'os-keychain', service: this.service, account: this.account, platform: 'linux' }; }
  #read() {
    const result = this.runCommand('secret-tool', ['lookup', 'service', this.service, 'account', this.account], {});
    if (result.missingCommand) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS secret service is unavailable.');
    if (result.status !== 0) return null;
    return result.stdout.replace(/\r?\n$/, '');
  }
}

export class DpapiKeyStore {
  constructor(directory, { runCommand = spawnCommand, allowCreate = true } = {}) {
    this.filePath = path.join(directory, 'secret.key.dpapi');
    this.runCommand = runCommand;
    this.allowCreate = allowCreate;
    this.cached = null;
  }
  load() {
    if (this.cached) return this.cached;
    if (fs.existsSync(this.filePath)) {
      this.cached = this.#unprotect(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '').trim());
      return this.cached;
    }
    if (!this.allowCreate) throw new SecretBoxError('SECRET_KEY_MISSING', 'The DPAPI key file is missing. Saved credentials were left unchanged.');
    const key = randomBytes(KEY_BYTES);
    const blob = this.#invoke('protect', key.toString('base64'));
    atomicWrite(this.filePath, `${blob}\n`);
    const confirmed = this.#unprotect(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '').trim());
    if (!keysMatch(key, confirmed)) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'Windows DPAPI did not return the at-rest key.');
    this.cached = confirmed;
    return confirmed;
  }
  describe() { return { version: 1, backend: 'dpapi', file: 'secret.key.dpapi' }; }
  #unprotect(blob) { return Buffer.from(this.#invoke('unprotect', blob), 'base64'); }
  #invoke(mode, payload) {
    const encoded = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64');
    const result = this.runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { input: `${mode}\n${payload}\n` });
    const stdout = (result.stdout || '').replace(/^\uFEFF/, '').trim();
    if (result.status !== 0 || !stdout) throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'Windows DPAPI could not protect the at-rest key.');
    return stdout;
  }
}

function metaPath(directory) { return path.join(directory, 'secret-key.json'); }

function readMeta(directory) {
  let text;
  try { text = fs.readFileSync(metaPath(directory), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new SecretBoxError('SECRET_KEY', 'The local secret key record is invalid. Saved credentials were left unchanged.'); }
  if (!parsed || parsed.version !== 1 || !['file', 'os-keychain', 'dpapi'].includes(parsed.backend)) {
    throw new SecretBoxError('SECRET_KEY', 'The local secret key record is invalid. Saved credentials were left unchanged.');
  }
  return parsed;
}

function writeMeta(directory, description) {
  atomicWrite(metaPath(directory), `${JSON.stringify(description, null, 2)}\n`);
}

function fileStore(directory, options) {
  return new FileKeyStore(path.join(directory, 'secret.key'), options);
}

function openBackend(directory, meta, { platform, runCommand }) {
  if (meta.backend === 'file') return fileStore(directory, { allowCreate: false, fallbackFrom: meta.fallbackFrom || null });
  if (meta.backend === 'dpapi') return new DpapiKeyStore(directory, { runCommand, allowCreate: false });
  if (meta.backend === 'os-keychain') {
    const target = meta.platform || platform;
    if (target === 'darwin') return new MacOsKeyStore({ runCommand, allowCreate: false, service: meta.service || SECRET_SERVICE, account: meta.account || SECRET_ACCOUNT });
    if (target === 'linux') return new LinuxSecretStore({ runCommand, allowCreate: false, service: meta.service || SECRET_SERVICE, account: meta.account || SECRET_ACCOUNT });
    if (target === 'win32') return new DpapiKeyStore(directory, { runCommand, allowCreate: false });
  }
  throw new SecretBoxError('SECRET_KEY', 'The local secret key record is invalid. Saved credentials were left unchanged.');
}

function preferredStore(directory, { platform, runCommand }) {
  if (platform === 'darwin') return new MacOsKeyStore({ runCommand, allowCreate: true });
  if (platform === 'linux') return new LinuxSecretStore({ runCommand, allowCreate: true });
  if (platform === 'win32') return new DpapiKeyStore(directory, { runCommand, allowCreate: true });
  return fileStore(directory, { allowCreate: true });
}

function selectNewStore(directory, { platform, runCommand, explicit }) {
  if (explicit === 'file') return fileStore(directory, { allowCreate: true });
  if (explicit === 'dpapi' || (explicit === 'os-keychain' && platform === 'win32')) return new DpapiKeyStore(directory, { runCommand, allowCreate: true });
  if (explicit === 'os-keychain' && platform === 'darwin') return new MacOsKeyStore({ runCommand, allowCreate: true });
  if (explicit === 'os-keychain' && platform === 'linux') return new LinuxSecretStore({ runCommand, allowCreate: true });
  if (explicit === 'os-keychain') throw new SecretBoxError('KEYCHAIN_UNAVAILABLE', 'The OS secret store is unavailable.');
  if (explicit) throw new SecretBoxError('SECRET_KEY', 'Unknown secret backend.');
  return preferredStore(directory, { platform, runCommand });
}

export function createKeyStore({ directory, env = process.env, platform = process.platform, runCommand = spawnCommand } = {}) {
  if (!directory) throw new SecretBoxError('SECRET_KEY', 'A config directory is required for the at-rest key.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* filesystems without POSIX modes */ }
  const existing = readMeta(directory);
  if (existing) {
    const store = openBackend(directory, existing, { platform, runCommand });
    store.load();
    return store;
  }
  return withFileLock(path.join(directory, 'secret-key.lock'), () => {
    const again = readMeta(directory);
    if (again) {
      const store = openBackend(directory, again, { platform, runCommand });
      store.load();
      return store;
    }
    // The test runner must not create login-keychain or secret-service items
    // on a developer's machine. Production launches do not set this variable.
    const explicit = env.UNPROMPTED_SECRET_BACKEND || null;
    const forceFile = !explicit && (Boolean(env.NODE_TEST_CONTEXT) || !['darwin', 'linux', 'win32'].includes(platform));
    let store;
    if (forceFile) {
      store = fileStore(directory, { allowCreate: true });
      store.load();
    } else {
      try {
        store = selectNewStore(directory, { platform, runCommand, explicit });
        store.load();
      } catch (error) {
        if (explicit) throw error;
        store = fileStore(directory, { allowCreate: true, fallbackFrom: platform === 'win32' ? 'dpapi' : 'os-keychain' });
        store.load();
      }
    }
    writeMeta(directory, store.describe());
    return store;
  });
}
