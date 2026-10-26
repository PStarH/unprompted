#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const listing = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: projectRoot,
  maxBuffer: 16 * 1024 * 1024
});

if (listing.error || listing.status !== 0) {
  process.stderr.write(`Could not enumerate files for the syntax check; run it inside a Git working tree${listing.error ? ` (${listing.error.message})` : '.'}\n`);
  if (listing.stderr) process.stderr.write(listing.stderr);
  process.exitCode = 1;
} else {
  const files = listing.stdout.toString('utf8').split('\0').filter(Boolean)
    .filter(relative => SOURCE_EXTENSIONS.has(path.posix.extname(relative)))
    .map(relative => ({
      relative,
      absolute: path.resolve(projectRoot, ...relative.split('/'))
    }))
    .filter(file => {
      try { return lstatSync(file.absolute).isFile(); }
      catch { return false; }
    })
    .sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const failures = [];

  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file.absolute], { cwd: projectRoot, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      failures.push(file.relative);
      process.stderr.write(`Syntax check failed: ${file.relative}\n`);
      if (result.error) process.stderr.write(`${result.error.message}\n`);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.stdout) process.stderr.write(result.stdout);
    }
  }

  if (failures.length) {
    process.stderr.write(`\n${failures.length} of ${files.length} JavaScript files failed syntax checks.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
  }
}
