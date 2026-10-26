#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.test\.(?:cjs|mjs|js)$/;

function usage() {
  return [
    'Usage: node scripts/test-runner.mjs [runner options] [node test options]',
    '',
    'Runner options:',
    '  --test-dir <path>  Test directory (default: test)',
    '  --file <path>      Run one file; repeat to select several files',
    '  --exclude <name>   Exclude an exact test filename; repeat as needed',
    '  --help             Show this help',
    '',
    'Node test options such as --test-name-pattern are passed through.'
  ].join('\n');
}

function optionValue(args, index, name) {
  const argument = args[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), nextIndex: index };
  if (argument === name) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return { value, nextIndex: index + 1 };
  }
  return null;
}

function parseOptions(args) {
  const options = { testDir: path.join(projectRoot, 'test'), files: [], excludes: [], nodeArgs: [], help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    let parsed = optionValue(args, index, '--test-dir');
    if (parsed) {
      options.testDir = path.resolve(projectRoot, parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    parsed = optionValue(args, index, '--file');
    if (parsed) {
      options.files.push(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    parsed = optionValue(args, index, '--exclude');
    if (parsed) {
      options.excludes.push(parsed.value.replaceAll('\\', '/'));
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--') {
      options.nodeArgs.push(...args.slice(index + 1));
      break;
    }
    options.nodeArgs.push(argument);
  }
  return options;
}

function listTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && TEST_FILE.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(name => path.join(directory, name));
}

function resolveSelectedFiles(options) {
  const selected = options.files.length
    ? options.files.map(value => {
      const candidates = path.isAbsolute(value)
        ? [value]
        : [path.resolve(options.testDir, value), path.resolve(projectRoot, value)];
      const found = candidates.find(candidate => {
        try { return statSync(candidate).isFile(); }
        catch { return false; }
      });
      if (!found) throw new Error(`Test file does not exist: ${value}`);
      return path.resolve(found);
    })
    : listTestFiles(options.testDir);

  const excludes = new Set(options.excludes);
  const filtered = selected.filter(file => {
    const relative = path.relative(options.testDir, file).split(path.sep).join('/');
    return !excludes.has(path.basename(file)) && !excludes.has(relative);
  });
  const knownExcludes = new Set(listTestFiles(options.testDir).flatMap(file => [
    path.basename(file),
    path.relative(options.testDir, file).split(path.sep).join('/')
  ]));
  for (const exclude of excludes) {
    if (!knownExcludes.has(exclude)) throw new Error(`Test exclusion does not match a selected file: ${exclude}`);
  }
  if (!filtered.length) throw new Error('No test files selected.');
  return [...new Set(filtered)];
}

function signalExitCode(signal) {
  return 128 + (osConstants.signals?.[signal] || 0);
}

function run(args) {
  let options;
  try { options = parseOptions(args); }
  catch (error) {
    process.stderr.write(`Test selection error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let files;
  try {
    if (!statSync(options.testDir).isDirectory()) throw new Error(`Test directory is not a directory: ${options.testDir}`);
    files = resolveSelectedFiles(options);
  } catch (error) {
    process.stderr.write(`Test selection error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const childArgs = ['--test', ...options.nodeArgs, '--test-concurrency=1', ...files];
  const child = spawn(process.execPath, childArgs, { cwd: projectRoot, stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  let receivedSignal = null;
  let escalationTimer = null;

  const cleanup = () => {
    if (escalationTimer) clearTimeout(escalationTimer);
    for (const signal of signals) process.removeListener(signal, handleSignal);
  };
  const handleSignal = signal => {
    if (receivedSignal) {
      try { child.kill('SIGKILL'); } catch { try { child.kill(); } catch { /* the child may already have exited */ } }
      return;
    }
    receivedSignal = signal;
    try { child.kill(signal); } catch { /* close/error will establish the final status */ }
    escalationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { try { child.kill(); } catch { /* the child may already have exited */ } }
      }
    }, 5_000);
    escalationTimer.unref();
  };

  for (const signal of signals) process.on(signal, handleSignal);
  child.once('error', error => {
    cleanup();
    process.stderr.write(`Could not start Node's test runner: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    cleanup();
    process.exitCode = receivedSignal
      ? signalExitCode(receivedSignal)
      : signal ? signalExitCode(signal) : code ?? 1;
  });
}

run(process.argv.slice(2));
