import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegularFile } from '../src/local-files.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-file-read-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'config.json') };
}

test('configuration reads reject oversized files, directories and symlinks', t => {
  const { directory, file } = fixture(t);
  fs.writeFileSync(file, 'small');
  assert.equal(readRegularFile(file, { maxBytes: 5 }), 'small');
  assert.throws(() => readRegularFile(file, { maxBytes: 4 }), /too large/);
  assert.throws(() => readRegularFile(directory));
  if (process.platform !== 'win32') {
    const link = path.join(directory, 'link');
    fs.symlinkSync(file, link);
    assert.throws(() => readRegularFile(link));
  }
});

test('configuration reads and permissions remain bound to the opened inode after replacement', t => {
  const { directory, file } = fixture(t);
  const retired = path.join(directory, 'original');
  fs.writeFileSync(file, 'original');
  const fstat = fs.fstatSync;
  fs.fstatSync = descriptor => {
    const stat = fstat(descriptor);
    fs.renameSync(file, retired);
    fs.writeFileSync(file, 'replacement', { mode: 0o644 });
    return stat;
  };
  try { assert.equal(readRegularFile(file, { mode: 0o600 }), 'original'); }
  finally { fs.fstatSync = fstat; }
  if (process.platform !== 'win32') assert.equal(fs.statSync(retired).mode & 0o777, 0o600);
  assert.equal(readRegularFile(file), 'replacement');
});

test('configuration reads remain bounded when a file grows after the metadata check', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, 'a');
  const fstat = fs.fstatSync;
  fs.fstatSync = descriptor => {
    const stat = fstat(descriptor);
    fs.appendFileSync(file, 'too much data');
    return stat;
  };
  try { assert.throws(() => readRegularFile(file, { maxBytes: 3 }), /too large/); }
  finally { fs.fstatSync = fstat; }
});
