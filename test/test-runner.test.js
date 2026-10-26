import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/test-runner.mjs', import.meta.url));

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  return directory;
}

function runRunner(args, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: childEnv
  });
}

function writeTest(directory, filename, source) {
  const location = path.join(directory, filename);
  fs.writeFileSync(location, source);
  return location;
}

function waitForFile(filename, timeoutMs = 6_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(filename)) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for nested test startup.'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test('runner handles spaced paths, exact file exclusions, stable order, and Node name filters', () => {
  const directory = temporaryDirectory('unprompted test runner spaces');
  const marker = path.join(directory, 'selection marker.txt');
  try {
    writeTest(directory, 'a selected suite.test.js', `
      import test from 'node:test';
      import fs from 'node:fs';
      test('selected request', () => fs.appendFileSync(process.env.TEST_RUNNER_MARKER, 'a-selected\\n'));
      test('unrelated request', () => fs.appendFileSync(process.env.TEST_RUNNER_MARKER, 'wrong-filter\\n'));
    `);
    writeTest(directory, 'm excluded suite.test.js', `
      import test from 'node:test';
      import fs from 'node:fs';
      test('selected excluded request', () => fs.appendFileSync(process.env.TEST_RUNNER_MARKER, 'excluded\\n'));
    `);
    writeTest(directory, 'z selected suite.test.js', `
      import test from 'node:test';
      import fs from 'node:fs';
      test('selected last', () => fs.appendFileSync(process.env.TEST_RUNNER_MARKER, 'z-last\\n'));
    `);

    const result = runRunner([
      '--test-dir', directory,
      '--exclude', 'm excluded suite.test.js',
      '--test-name-pattern=selected'
    ], { TEST_RUNNER_MARKER: marker });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'a-selected\nz-last\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runner accepts an explicitly selected filename with spaces', () => {
  const directory = temporaryDirectory('unprompted explicit test selection');
  const marker = path.join(directory, 'selected.txt');
  try {
    writeTest(directory, 'chosen suite.test.js', `
      import test from 'node:test';
      import fs from 'node:fs';
      test('chosen', () => fs.writeFileSync(process.env.TEST_RUNNER_MARKER, 'chosen'));
    `);
    writeTest(directory, 'other suite.test.js', `
      import test from 'node:test';
      import fs from 'node:fs';
      test('other', () => fs.writeFileSync(process.env.TEST_RUNNER_MARKER, 'other'));
    `);
    const result = runRunner([
      `--test-dir=${directory}`,
      '--file', 'chosen suite.test.js'
    ], { TEST_RUNNER_MARKER: marker });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'chosen');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runner returns a failing test suite exit code', () => {
  const directory = temporaryDirectory('unprompted failing test selection');
  try {
    writeTest(directory, 'failure.test.js', `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      test('intentional failure', () => assert.equal(1, 2));
    `);
    const result = runRunner([`--test-dir=${directory}`]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runner forwards termination and exits nonzero instead of leaving the test process active', async () => {
  const directory = temporaryDirectory('unprompted signal test');
  const marker = path.join(directory, 'started.txt');
  let child;
  let closed = null;
  let closePromise;

  try {
    writeTest(directory, 'wait for signal.test.js', `
      import test from 'node:test';
      import fs from 'node:fs';
      test('waits for termination', () => {
        fs.writeFileSync(process.env.TEST_RUNNER_MARKER, 'started');
        setInterval(() => {}, 1000);
        return new Promise(() => {});
      });
    `);
    const childEnv = { ...process.env, TEST_RUNNER_MARKER: marker };
    delete childEnv.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, [runner, `--test-dir=${directory}`], {
      stdio: 'ignore',
      env: childEnv
    });
    closePromise = new Promise(resolve => {
      child.once('close', (code, signal) => {
        closed = { code, signal };
        resolve(closed);
      });
    });
    await waitForFile(marker);
    child.kill('SIGTERM');
    let timeout;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Runner did not stop after SIGTERM.')), 8_000);
    });
    const result = await Promise.race([closePromise, timedOut]);
    clearTimeout(timeout);
    assert.notEqual(result.code, 0);
    assert.ok(result.signal || result.code >= 128, `unexpected successful exit: ${JSON.stringify(result)}`);
  } finally {
    if (child && !closed) child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
