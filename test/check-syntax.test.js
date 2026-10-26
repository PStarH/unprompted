import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(projectRoot, 'scripts', 'check-syntax.mjs');

function runChecker(directory, scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15_000
  });
}

test('syntax check uses Git candidates, ignores generated files, and handles Unicode paths', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted syntax repo with spaces 雪-'));
  const checkerPath = path.join(directory, 'scripts', 'check-syntax.mjs');
  const ignoredPath = path.join(directory, 'outputs', 'invalid generated file.js');
  const sourcePath = path.join(directory, 'src', 'syntax check invalid source 雪.js');

  try {
    fs.mkdirSync(path.dirname(checkerPath), { recursive: true });
    fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.copyFileSync(checker, checkerPath);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(directory, '.gitignore'), 'outputs/\n');
    fs.writeFileSync(path.join(directory, 'src', 'valid.js'), 'export const valid = true;\n');
    fs.writeFileSync(ignoredPath, 'const = ;\n');

    const init = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr || init.error?.message);
    const add = spawnSync('git', ['add', 'scripts/check-syntax.mjs', 'src/valid.js'], { cwd: directory, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr || add.error?.message);
    const clean = runChecker(directory, checkerPath);
    assert.equal(clean.status, 0, clean.stderr || clean.stdout || clean.error?.message);
    assert.match(clean.stdout, /Syntax check passed for 2 JavaScript files/);
    assert.ok(!clean.stderr.includes(ignoredPath), clean.stderr);

    fs.writeFileSync(sourcePath, 'const = ;\n');
    const invalidSource = runChecker(directory, checkerPath);
    assert.equal(invalidSource.status, 1, invalidSource.stderr || invalidSource.stdout || invalidSource.error?.message);
    assert.ok(invalidSource.stderr.includes('src/syntax check invalid source 雪.js'), invalidSource.stderr);
    assert.ok(!invalidSource.stderr.includes('invalid generated file.js'), invalidSource.stderr);
    assert.match(invalidSource.stderr, /1 of 3 JavaScript files failed syntax checks/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
