/**
 * Private state for the Notion broker.
 *
 * One SQLite database, one active writer. Every mutation is fenced by a
 * short-lived ownership lease so a process that lost the lease after an await
 * cannot publish a ready handoff, activate a grant or update a refresh token.
 * Tokens, account metadata, flow parameters and cached replies are encrypted
 * with AES-256-GCM; lookup values and proofs are stored only as HMACs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual
} from 'node:crypto';
import {
  LIMITS, PROTOCOL_VERSION, errors, isPlainObject, validOpaqueId
} from '../../src/notion-broker-protocol.js';

const require = createRequire(import.meta.url);
const HASH_DOMAINS = new Set(['oauth-state', 'flow-cookie', 'handoff-code', 'refresh-proof', 'refresh-token']);
const FENCE = 'EXISTS (SELECT 1 FROM broker_lease WHERE id=1 AND owner_id=? AND expires_at>?)';

function isBusy(error) {
  return /^SQLITE_(BUSY|LOCKED)/.test(error?.code || '');
}

function keyBytes(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (value instanceof Uint8Array && value.length === 32) return Buffer.from(value);
  throw new Error('The broker master key must be exactly 32 bytes.');
}

function deriveKey(masterKey, label, clientId, publicOrigin) {
  return Buffer.from(hkdfSync(
    'sha256',
    masterKey,
    Buffer.from('unprompted-notion-broker-v1', 'utf8'),
    Buffer.from(`unprompted-notion-broker-v1\0${label}\0${clientId}\0${publicOrigin}`, 'utf8'),
    32
  ));
}

export class NotionBrokerStore {
  constructor({
    databaseFile, clientId, publicOrigin, masterKey, now = Date.now,
    leaseTtlMs = LIMITS.leaseTtlMs, maxSessions = LIMITS.maxSessions,
    maxGrants = LIMITS.maxGrants, maxRefreshOps = LIMITS.maxRefreshOps
  }) {
    if (typeof databaseFile !== 'string' || databaseFile.length === 0) throw new Error('A broker state file is required.');
    if (typeof clientId !== 'string' || typeof publicOrigin !== 'string') throw new Error('Broker client configuration is incomplete.');
    this.databaseFile = databaseFile === ':memory:' ? databaseFile : path.resolve(databaseFile);
    this.clientId = clientId;
    this.publicOrigin = publicOrigin;
    this.now = now;
    this.leaseTtlMs = leaseTtlMs;
    this.maxSessions = maxSessions;
    this.maxGrants = maxGrants;
    this.maxRefreshOps = maxRefreshOps;
    this.ownerId = null;
    this.leaseLost = false;
    this.closed = false;

    const key = keyBytes(masterKey);
    this.encKey = deriveKey(key, 'encryption', clientId, publicOrigin);
    this.macKey = deriveKey(key, 'signing', clientId, publicOrigin);
    this.hashKey = deriveKey(key, 'hashing', clientId, publicOrigin);
    this.keyFingerprint = createHash('sha256').update(key).digest('base64url');

    this.#prepareLocation();
    let Database;
    try { Database = require('better-sqlite3'); }
    catch { throw new Error('SQLite is unavailable. Install the existing better-sqlite3 dependency.'); }
    this.db = new Database(this.databaseFile, { timeout: 2500 });
    try {
      this.db.pragma('journal_mode=WAL');
      this.db.pragma('synchronous=FULL');
      this.db.pragma('foreign_keys=ON');
      this.db.pragma('secure_delete=ON');
      this.db.pragma('busy_timeout=2500');
      this.#schema();
      this.#verifyMetadata();
      this.#restrictFiles();
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  #prepareLocation() {
    if (this.databaseFile === ':memory:') return;
    const directory = path.dirname(this.databaseFile);
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The broker state directory must be a private directory.');
      // Never chmod an existing directory: it may be a shared parent such as
      // the system temporary directory. The operator must provide a dedicated
      // directory that is already private to the broker user.
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error('The broker state directory must already have mode 700 (private to the broker user).');
      }
    } else {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Only tighten a directory this process just created.
      if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    }
    try {
      const stat = fs.lstatSync(this.databaseFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('The broker state file must be a regular file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  #restrictFiles() {
    if (this.databaseFile === ':memory:') return;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(`${this.databaseFile}${suffix}`, 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  #schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS broker_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS broker_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS broker_sessions (
        id TEXT PRIMARY KEY,
        flow_key TEXT NOT NULL UNIQUE,
        oauth_state_hash TEXT UNIQUE,
        cookie_hash TEXT,
        enc_flow BLOB,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_sessions_status ON broker_sessions(status, expires_at);
      CREATE TABLE IF NOT EXISTS broker_handoffs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        grant_id TEXT NOT NULL UNIQUE,
        code_hash TEXT NOT NULL UNIQUE,
        enc_reply BLOB,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS broker_handoffs_status ON broker_handoffs(status, expires_at);
      CREATE TABLE IF NOT EXISTS broker_grants (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        proof_hash TEXT NOT NULL,
        initial_refresh_hash TEXT,
        current_refresh_hash TEXT,
        enc_account BLOB,
        enc_tokens BLOB,
        status TEXT NOT NULL,
        cap_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_grants_status ON broker_grants(status, cap_expires_at);
      CREATE TABLE IF NOT EXISTS broker_refresh_ops (
        grant_id TEXT NOT NULL,
        old_token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        enc_reply BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (grant_id, old_token_hash)
      );
      CREATE INDEX IF NOT EXISTS broker_refresh_ops_status ON broker_refresh_ops(status, expires_at);
    `);
  }

  #verifyMetadata() {
    const expected = {
      schema: '1',
      protocol: PROTOCOL_VERSION,
      client_id: this.clientId,
      public_origin: this.publicOrigin,
      key_fingerprint: this.keyFingerprint
    };
    this.#tx(() => {
      const rows = this.db.prepare('SELECT key, value FROM broker_meta').all();
      if (rows.length === 0) {
        const insert = this.db.prepare('INSERT INTO broker_meta(key, value) VALUES (?, ?)');
        for (const [name, value] of Object.entries(expected)) insert.run(name, value);
        return;
      }
      const stored = new Map(rows.map(row => [row.key, row.value]));
      for (const [name, value] of Object.entries(expected)) {
        if (stored.get(name) !== value) throw new Error('The broker state does not match the configured client, origin, or master key.');
      }
    });
  }

  #tx(callback) {
    if (this.closed) throw errors.capacity();
    if (this.db.inTransaction) throw new Error('Broker database transactions must not nest.');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = callback();
      if (result && typeof result.then === 'function') throw new Error('Broker database transactions must not await.');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { if (this.db.inTransaction) this.db.exec('ROLLBACK'); } catch {}
      if (isBusy(error)) throw errors.capacity();
      throw error;
    }
  }

  #assertOwnedInTx(now) {
    const row = this.db.prepare('SELECT owner_id, expires_at FROM broker_lease WHERE id=1').get();
    if (!this.ownerId || this.leaseLost || !row || row.owner_id !== this.ownerId || !(row.expires_at > now)) {
      this.leaseLost = true;
      throw errors.capacity();
    }
  }

  assertOwner(now = this.now()) {
    if (this.closed || !this.ownerId) throw errors.capacity();
    this.#tx(() => this.#assertOwnedInTx(now));
  }

  isOwner(now = this.now()) {
    if (this.closed || !this.ownerId || this.leaseLost) return false;
    const row = this.db.prepare('SELECT owner_id, expires_at FROM broker_lease WHERE id=1').get();
    return Boolean(row && row.owner_id === this.ownerId && row.expires_at > now);
  }

  acquireLease(now = this.now()) {
    if (this.ownerId || this.closed) throw new Error('The broker lease is already initialized.');
    const ownerId = randomBytes(24).toString('base64url');
    const expiresAt = now + this.leaseTtlMs;
    this.#tx(() => {
      const row = this.db.prepare('SELECT owner_id, expires_at FROM broker_lease WHERE id=1').get();
      if (row && row.expires_at > now) throw new Error('Another broker process owns this state file.');
      this.db.prepare(`INSERT INTO broker_lease(id, owner_id, expires_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, expires_at=excluded.expires_at`).run(ownerId, expiresAt);
      // Recover on every successful acquisition, even when the previous owner
      // released its row (normal close) or the row was never created. A close
      // after lease expiry cannot settle its own pending work, so relying on a
      // remaining row would leave those claims pending forever.
      this.#recoverAbandoned(now);
    });
    this.ownerId = ownerId;
    return { ownerId, expiresAt };
  }

  renewLease(now = this.now()) {
    if (this.closed || !this.ownerId || this.leaseLost) return false;
    // A lease that has already expired is never revived, even by the same
    // process. Another process may have taken over; only an unexpired row can
    // be extended.
    const result = this.db.prepare('UPDATE broker_lease SET expires_at=? WHERE id=1 AND owner_id=? AND expires_at>?')
      .run(now + this.leaseTtlMs, this.ownerId, now);
    if (result.changes !== 1) {
      this.leaseLost = true;
      return false;
    }
    return true;
  }

  releaseLease() {
    if (!this.ownerId || this.closed) return;
    try { this.db.prepare('DELETE FROM broker_lease WHERE id=1 AND owner_id=?').run(this.ownerId); }
    catch {}
  }

  #recoverAbandoned(now) {
    this.db.prepare(`UPDATE broker_sessions SET status='unknown', enc_flow=NULL, updated_at=?
      WHERE status='exchanging'`).run(now);
    this.db.prepare(`UPDATE broker_refresh_ops SET status='unknown', enc_reply=NULL, updated_at=?
      WHERE status='pending'`).run(now);
    this.db.prepare(`UPDATE broker_grants SET status='reauthorization_required', updated_at=?
      WHERE status='active' AND id IN (SELECT grant_id FROM broker_refresh_ops WHERE status='unknown')`).run(now);
  }

  settleOwnPending(now = this.now()) {
    if (this.closed || !this.ownerId) return;
    this.#tx(() => {
      this.#assertOwnedInTx(now);
      this.db.prepare(`UPDATE broker_sessions SET status='unknown', enc_flow=NULL, updated_at=?
        WHERE status='exchanging' AND ${FENCE}`).run(now, this.ownerId, now);
      this.db.prepare(`UPDATE broker_refresh_ops SET status='unknown', enc_reply=NULL, updated_at=?
        WHERE status='pending' AND ${FENCE}`).run(now, this.ownerId, now);
      this.db.prepare(`UPDATE broker_grants SET status='reauthorization_required', updated_at=?
        WHERE status='active' AND id IN (SELECT grant_id FROM broker_refresh_ops WHERE status='unknown') AND ${FENCE}`)
        .run(now, this.ownerId, now);
    });
  }

  hash(domain, value) {
    if (!HASH_DOMAINS.has(domain) || typeof value !== 'string') throw errors.invalidRequest();
    return createHmac('sha256', this.hashKey).update(domain, 'utf8').update('\0', 'utf8')
      .update(value, 'utf8').digest('base64url');
  }

  #encrypt(kind, id, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, nonce);
    cipher.setAAD(Buffer.from(`${kind}\0${id}\0${this.clientId}\0${this.publicOrigin}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  #decrypt(kind, id, blob) {
    if (!Buffer.isBuffer(blob) || blob.length < 29) throw errors.invalidGrant();
    const nonce = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, nonce);
    decipher.setAAD(Buffer.from(`${kind}\0${id}\0${this.clientId}\0${this.publicOrigin}`, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8'));
    if (!isPlainObject(value)) throw errors.invalidGrant();
    return value;
  }

  signCapability(grantId, expiresAt) {
    if (!validOpaqueId(grantId) || !Number.isSafeInteger(expiresAt)) throw errors.invalidRequest();
    const payload = {
      v: 1, iss: this.publicOrigin, cid: this.clientId,
      gid: grantId, exp: Math.floor(expiresAt / 1000)
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signingInput = `v1.${encoded}`;
    const mac = createHmac('sha256', this.macKey).update(signingInput, 'utf8').digest('base64url');
    return `${signingInput}.${mac}`;
  }

  verifyCapability(capability, now = this.now()) {
    if (typeof capability !== 'string' || capability.length > 4096) throw errors.invalidGrant();
    const parts = capability.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || parts[1].length === 0 || parts[1].length > 2048) throw errors.invalidGrant();
    const signingInput = `v1.${parts[1]}`;
    const expected = createHmac('sha256', this.macKey).update(signingInput, 'utf8').digest('base64url');
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(parts[2], 'utf8');
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw errors.invalidGrant();
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
    catch { throw errors.invalidGrant(); }
    if (!isPlainObject(payload) || Object.keys(payload).length !== 5) throw errors.invalidGrant();
    if (payload.v !== 1 || payload.iss !== this.publicOrigin || payload.cid !== this.clientId
      || !validOpaqueId(payload.gid) || !Number.isSafeInteger(payload.exp)) throw errors.invalidGrant();
    const expiresAt = payload.exp * 1000;
    if (expiresAt <= now) throw errors.expired();
    return { grantId: payload.gid, expiresAt };
  }

  createSession({ challenge, redirectUri, clientState, flowKey, expiresAt, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const active = this.db.prepare(`SELECT COUNT(*) n FROM broker_sessions
        WHERE status IN ('pending','authorizing','exchanging','ready','redeemed') AND expires_at>?`).get(now).n;
      if (active >= this.maxSessions) throw errors.capacity();
      const id = randomBytes(32).toString('base64url');
      const encFlow = this.#encrypt('session-flow', id, { challenge, redirectUri, clientState, flowKey });
      this.db.prepare(`INSERT INTO broker_sessions(id, flow_key, oauth_state_hash, cookie_hash, enc_flow, status, expires_at, created_at, updated_at)
        SELECT ?, ?, NULL, NULL, ?, 'pending', ?, ?, ? WHERE ${FENCE}`)
        .run(id, flowKey, encFlow, expiresAt, now, now, this.ownerId, now);
      return { id, flowKey };
    });
  }

  getSession(id) {
    return this.db.prepare('SELECT * FROM broker_sessions WHERE id=?').get(id) || null;
  }

  getSessionByState(stateHash) {
    return this.db.prepare('SELECT * FROM broker_sessions WHERE oauth_state_hash=?').get(stateHash) || null;
  }

  sessionFlow(row) {
    try { return this.#decrypt('session-flow', row.id, row.enc_flow); }
    catch { throw errors.invalidGrant(); }
  }

  claimPendingAuthorize({ id, oauthStateHash, cookieHash, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const changes = this.db.prepare(`UPDATE broker_sessions SET status='authorizing', oauth_state_hash=?, cookie_hash=?, updated_at=?
        WHERE id=? AND status='pending' AND expires_at>? AND ${FENCE}`)
        .run(oauthStateHash, cookieHash, now, id, now, this.ownerId, now).changes;
      return changes === 1;
    });
  }

  refreshAuthorizeState({ id, oauthStateHash, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const changes = this.db.prepare(`UPDATE broker_sessions SET oauth_state_hash=?, updated_at=?
        WHERE id=? AND status='authorizing' AND expires_at>? AND ${FENCE}`)
        .run(oauthStateHash, now, id, now, this.ownerId, now).changes;
      return changes === 1;
    });
  }

  claimCallback({ id, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const changes = this.db.prepare(`UPDATE broker_sessions SET status='exchanging', updated_at=?
        WHERE id=? AND status='authorizing' AND expires_at>? AND ${FENCE}`)
        .run(now, id, now, this.ownerId, now).changes;
      return changes === 1;
    });
  }

  denySession({ id, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      return this.db.prepare(`UPDATE broker_sessions SET status='denied', enc_flow=NULL, updated_at=?
        WHERE id=? AND status='authorizing' AND ${FENCE}`)
        .run(now, id, this.ownerId, now).changes === 1;
    });
  }

  failCallback({ id, status = 'failed', now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      return this.db.prepare(`UPDATE broker_sessions SET status=?, enc_flow=NULL, updated_at=?
        WHERE id=? AND status='exchanging' AND ${FENCE}`)
        .run(status, now, id, this.ownerId, now).changes === 1;
    });
  }

  completeCallback({ sessionId, grantId, handoffId, codeHash, reply, expiresAt, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const session = this.db.prepare('SELECT status, expires_at FROM broker_sessions WHERE id=?').get(sessionId);
      if (!session || session.status !== 'exchanging' || session.expires_at <= now) throw errors.invalidGrant();
      const encReply = this.#encrypt('handoff-reply', handoffId, reply);
      const changes = this.db.prepare(`UPDATE broker_sessions SET status='ready', updated_at=?
        WHERE id=? AND status='exchanging' AND expires_at>? AND ${FENCE}`)
        .run(now, sessionId, now, this.ownerId, now).changes;
      if (changes !== 1) throw errors.invalidGrant();
      this.db.prepare(`INSERT INTO broker_handoffs(id, session_id, grant_id, code_hash, enc_reply, status, expires_at, created_at)
        SELECT ?, ?, ?, ?, ?, 'ready', ?, ? WHERE ${FENCE}`)
        .run(handoffId, sessionId, grantId, codeHash, encReply, expiresAt, now, this.ownerId, now);
    });
  }

  getHandoff(codeHash) {
    return this.db.prepare('SELECT * FROM broker_handoffs WHERE code_hash=?').get(codeHash) || null;
  }

  expireHandoff(id, now) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      return this.db.prepare(`UPDATE broker_handoffs SET status='expired', enc_reply=NULL
        WHERE id=? AND status='ready' AND expires_at<=? AND ${FENCE}`)
        .run(id, now, this.ownerId, now).changes === 1;
    });
  }

  consumeHandoff({ handoffId, sessionId, grantId, proofHash, capExpiresAt, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const handoff = this.db.prepare('SELECT * FROM broker_handoffs WHERE id=?').get(handoffId);
      if (!handoff || handoff.status !== 'ready' || handoff.session_id !== sessionId || handoff.grant_id !== grantId) {
        throw errors.invalidGrant();
      }
      if (handoff.expires_at <= now) throw errors.expired();
      const session = this.db.prepare('SELECT * FROM broker_sessions WHERE id=?').get(sessionId);
      if (!session || session.status !== 'ready') throw errors.invalidGrant();
      if (session.expires_at <= now) throw errors.expired();
      const active = this.db.prepare("SELECT COUNT(*) n FROM broker_grants WHERE status='active' AND cap_expires_at>?").get(now).n;
      if (active >= this.maxGrants) throw errors.capacity();
      let reply;
      try { reply = this.#decrypt('handoff-reply', handoffId, handoff.enc_reply); }
      catch { throw errors.invalidGrant(); }
      if (!isPlainObject(reply) || !isPlainObject(reply.tokens) || !isPlainObject(reply.account)) throw errors.invalidGrant();
      const refreshToken = typeof reply.tokens.refreshToken === 'string' ? reply.tokens.refreshToken : null;
      const refreshHash = refreshToken == null ? null : this.hash('refresh-token', refreshToken);
      const consumed = this.db.prepare(`UPDATE broker_handoffs SET status='consumed', consumed_at=?, enc_reply=NULL
        WHERE id=? AND status='ready' AND expires_at>? AND ${FENCE}`)
        .run(now, handoffId, now, this.ownerId, now).changes;
      if (consumed !== 1) throw errors.invalidGrant();
      this.db.prepare(`UPDATE broker_sessions SET status='redeemed', enc_flow=NULL, updated_at=?
        WHERE id=? AND status='ready' AND ${FENCE}`).run(now, sessionId, this.ownerId, now);
      const encAccount = this.#encrypt('grant-account', grantId, reply.account);
      const encTokens = this.#encrypt('grant-tokens', grantId, {
        accessToken: reply.tokens.accessToken,
        refreshToken,
        expiresAt: reply.tokens.expiresAt ?? null
      });
      this.db.prepare(`INSERT INTO broker_grants(id, session_id, proof_hash, initial_refresh_hash, current_refresh_hash,
        enc_account, enc_tokens, status, cap_expires_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ? WHERE ${FENCE}`)
        .run(grantId, sessionId, proofHash, refreshHash, refreshHash, encAccount, encTokens, capExpiresAt, now, now, this.ownerId, now);
      return { tokens: reply.tokens, account: reply.account };
    });
  }

  getGrant(id) {
    return this.db.prepare('SELECT * FROM broker_grants WHERE id=?').get(id) || null;
  }

  grantAccount(grant) {
    try {
      const account = this.#decrypt('grant-account', grant.id, grant.enc_account);
      if (!isPlainObject(account)) throw errors.invalidGrant();
      return account;
    } catch { throw errors.invalidGrant(); }
  }

  getRefreshOp(grantId, oldTokenHash) {
    return this.db.prepare('SELECT * FROM broker_refresh_ops WHERE grant_id=? AND old_token_hash=?')
      .get(grantId, oldTokenHash) || null;
  }

  claimRefresh({ grantId, oldTokenHash, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const existing = this.db.prepare('SELECT * FROM broker_refresh_ops WHERE grant_id=? AND old_token_hash=?')
        .get(grantId, oldTokenHash);
      if (existing) return { claimed: false, op: existing };
      const total = this.db.prepare('SELECT COUNT(*) n FROM broker_refresh_ops').get().n;
      if (total >= this.maxRefreshOps) throw errors.capacity();
      this.db.prepare(`INSERT INTO broker_refresh_ops(grant_id, old_token_hash, status, enc_reply, created_at, updated_at, expires_at)
        SELECT ?, ?, 'pending', NULL, ?, ?, 0 WHERE ${FENCE}`)
        .run(grantId, oldTokenHash, now, now, this.ownerId, now);
      return { claimed: true, op: this.getRefreshOp(grantId, oldTokenHash) };
    });
  }

  markRefreshUnknown({ grantId, oldTokenHash, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      this.db.prepare(`UPDATE broker_refresh_ops SET status='unknown', enc_reply=NULL, updated_at=?
        WHERE grant_id=? AND old_token_hash=? AND status='pending' AND ${FENCE}`)
        .run(now, grantId, oldTokenHash, this.ownerId, now);
      this.db.prepare(`UPDATE broker_grants SET status='reauthorization_required', updated_at=?
        WHERE id=? AND status='active' AND ${FENCE}`)
        .run(now, grantId, this.ownerId, now);
    });
  }

  completeRefresh({ grantId, oldTokenHash, tokens, currentRefreshHash, reply, cacheExpiresAt, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const grant = this.db.prepare('SELECT * FROM broker_grants WHERE id=?').get(grantId);
      if (!grant || grant.status !== 'active' || grant.cap_expires_at <= now) throw errors.invalidGrant();
      const op = this.db.prepare('SELECT * FROM broker_refresh_ops WHERE grant_id=? AND old_token_hash=?')
        .get(grantId, oldTokenHash);
      if (!op || op.status !== 'pending') throw errors.inProgress();
      const encTokens = this.#encrypt('grant-tokens', grantId, tokens);
      const changed = this.db.prepare(`UPDATE broker_grants SET current_refresh_hash=?, enc_tokens=?, updated_at=?
        WHERE id=? AND status='active' AND cap_expires_at>? AND ${FENCE}`)
        .run(currentRefreshHash, encTokens, now, grantId, now, this.ownerId, now).changes;
      if (changed !== 1) throw errors.invalidGrant();
      const encReply = this.#encrypt('refresh-reply', `${grantId}:${oldTokenHash}`, reply);
      this.db.prepare(`UPDATE broker_refresh_ops SET status='done', enc_reply=?, updated_at=?, expires_at=?
        WHERE grant_id=? AND old_token_hash=? AND status='pending' AND ${FENCE}`)
        .run(encReply, now, cacheExpiresAt, grantId, oldTokenHash, this.ownerId, now);
    });
  }

  cachedRefreshReply({ grantId, oldTokenHash, now }) {
    const op = this.getRefreshOp(grantId, oldTokenHash);
    if (!op || op.status !== 'done' || !op.enc_reply || op.expires_at <= now) return null;
    try { return this.#decrypt('refresh-reply', `${grantId}:${oldTokenHash}`, op.enc_reply); }
    catch { throw errors.invalidGrant(); }
  }

  revokeGrant({ grantId, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const changes = this.db.prepare(`UPDATE broker_grants SET status='revoked', current_refresh_hash=NULL,
        enc_account=NULL, enc_tokens=NULL, updated_at=? WHERE id=? AND ${FENCE}`)
        .run(now, grantId, this.ownerId, now).changes;
      if (changes !== 1) throw errors.invalidGrant();
      this.db.prepare('DELETE FROM broker_refresh_ops WHERE grant_id=?').run(grantId);
      this.db.prepare(`UPDATE broker_handoffs SET status='cancelled', enc_reply=NULL
        WHERE grant_id=? AND status='ready'`).run(grantId);
    });
  }

  cancelSession({ id, now }) {
    return this.#tx(() => {
      this.#assertOwnedInTx(now);
      const row = this.db.prepare('SELECT * FROM broker_sessions WHERE id=?').get(id);
      if (!row) return { cancelled: false, status: 'missing' };
      if (row.status === 'cancelled') return { cancelled: true, status: 'cancelled' };
      if (!['pending', 'authorizing', 'exchanging', 'ready'].includes(row.status)) {
        return { cancelled: false, status: row.status };
      }
      this.db.prepare(`UPDATE broker_sessions SET status='cancelled', enc_flow=NULL, updated_at=?
        WHERE id=? AND ${FENCE}`).run(now, id, this.ownerId, now);
      this.db.prepare(`UPDATE broker_handoffs SET status='cancelled', enc_reply=NULL
        WHERE session_id=? AND status='ready'`).run(id);
      return { cancelled: true, status: 'cancelled' };
    });
  }

  purgeExpired(now = this.now()) {
    return this.#tx(() => {
      if (this.ownerId) this.#assertOwnedInTx(now);
      const counts = {};
      counts.sessions = this.db.prepare(`UPDATE broker_sessions SET status='expired', enc_flow=NULL, oauth_state_hash=NULL, updated_at=?
        WHERE expires_at<=? AND status IN ('pending','authorizing','ready')`).run(now, now).changes;
      counts.exchanging = this.db.prepare(`UPDATE broker_sessions SET status='unknown', enc_flow=NULL, updated_at=?
        WHERE expires_at<=? AND status='exchanging'`).run(now, now).changes;
      counts.handoffs = this.db.prepare(`UPDATE broker_handoffs SET status='expired', enc_reply=NULL
        WHERE expires_at<=? AND status='ready'`).run(now).changes;
      counts.grants = this.db.prepare(`UPDATE broker_grants SET status='reauthorization_required',
        current_refresh_hash=NULL, enc_tokens=NULL, updated_at=? WHERE status='active' AND cap_expires_at<=?`)
        .run(now, now).changes;
      this.db.prepare(`UPDATE broker_refresh_ops SET enc_reply=NULL WHERE status='done' AND expires_at<=?`).run(now);
      const sessionCutoff = now - 7 * 24 * 60 * 60_000;
      const grantCutoff = now - 30 * 24 * 60 * 60_000;
      this.db.prepare(`DELETE FROM broker_sessions WHERE id IN (
        SELECT id FROM broker_sessions WHERE status IN ('expired','denied','failed','unknown','redeemed','cancelled')
        AND updated_at<? LIMIT 100)`).run(sessionCutoff);
      this.db.prepare(`DELETE FROM broker_handoffs WHERE id IN (
        SELECT id FROM broker_handoffs WHERE status IN ('expired','consumed','cancelled','unknown')
        AND created_at<? LIMIT 100)`).run(now - 24 * 60 * 60_000);
      this.db.prepare(`DELETE FROM broker_refresh_ops WHERE grant_id||':'||old_token_hash IN (
        SELECT grant_id||':'||old_token_hash FROM broker_refresh_ops
        WHERE status='done' AND updated_at<? LIMIT 100)`).run(sessionCutoff);
      this.db.prepare(`DELETE FROM broker_refresh_ops WHERE grant_id||':'||old_token_hash IN (
        SELECT op.grant_id||':'||op.old_token_hash FROM broker_refresh_ops op
        JOIN broker_grants g ON g.id=op.grant_id
        WHERE op.status='unknown' AND op.updated_at<? AND g.status!='active' LIMIT 100)`).run(grantCutoff);
      this.db.prepare(`DELETE FROM broker_grants WHERE id IN (
        SELECT id FROM broker_grants WHERE status IN ('revoked','reauthorization_required')
        AND updated_at<? LIMIT 100)`).run(grantCutoff);
      return counts;
    });
  }

  close() {
    if (this.closed) return;
    this.releaseLease();
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    this.closed = true;
    try { this.db.close(); } catch {}
  }
}
