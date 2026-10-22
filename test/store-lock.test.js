import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JsonStore } from '../src/store.js';

/**
 * One state file may only be mutated by one process. A second live process must
 * be refused with an actionable error; a lock left behind by a crash must not
 * brick the next start. These are safety properties for the only durable store.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function storeIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-lock-'));
  tempFiles.push(dir);
  return path.join(dir, 'state.json');
}

test('the lock is created with owner metadata and released on close', () => {
  const file = storeIn();
  const store = new JsonStore(file);
  const lockPath = `${file}.lock`;
  assert.ok(fs.existsSync(lockPath));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.ok(lock.startedAt);
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);

  store.close();
  assert.equal(fs.existsSync(lockPath), false);
  store.close(); // idempotent
});

test('a second store in the same process can reopen the file without stealing the lock', () => {
  const file = storeIn();
  const first = new JsonStore(file);
  first.mutate(state => { state.mode = 'simulation'; });

  const second = new JsonStore(file);
  assert.equal(second.state.mode, 'simulation');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).pid, process.pid);

  second.close();
  assert.equal(fs.existsSync(`${file}.lock`), true, 'the first store still owns the lock');
  first.close();
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a lock left by a dead process is recovered instead of blocking startup', async () => {
  const file = storeIn();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({
    pid: child.pid, startedAt: '2026-01-01T00:00:00.000Z', file
  }));

  const store = new JsonStore(file);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).pid, process.pid);
  store.close();
});

test('an unreadable lock file is treated as stale rather than trusted', () => {
  const file = storeIn();
  fs.writeFileSync(`${file}.lock`, 'not json');
  const store = new JsonStore(file);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).pid, process.pid);
  store.close();
});

test('a live foreign process holding the lock is refused with an actionable error', async () => {
  const file = storeIn();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(`${file}.lock`, JSON.stringify({
      pid: child.pid, startedAt: '2026-10-20T00:00:00.000Z', file
    }));
    assert.throws(() => new JsonStore(file), error => {
      assert.equal(error.code, 'STATE_LOCKED');
      assert.match(error.message, /already in use/);
      assert.match(error.message, /UNPROMPTED_STATE_FILE/);
      assert.equal(error.pid, child.pid);
      return true;
    });
    assert.equal(fs.existsSync(file), false, 'a refused instance must not create or rewrite state');
  } finally {
    child.kill('SIGKILL');
    if (child.exitCode == null) await once(child, 'exit').catch(() => {});
  }
});
