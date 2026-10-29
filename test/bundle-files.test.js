import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyApplicationTree, copyDependencyTree } from '../scripts/bundle-files.mjs';

test('application bundle omits ignored local data, credentials, source maps and symlinks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-bundle-filter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), destination = path.join(directory, 'app');
  fs.mkdirSync(path.join(source, 'durable'), { recursive: true });
  for (const name of ['server.js', 'durable/schema.sql', '.DS_Store', '.env', 'credentials.json', 'state.sqlite', 'build.log', 'module.js.map']) fs.writeFileSync(path.join(source, name), 'fixture');
  fs.mkdirSync(path.join(source, '.cache')); fs.writeFileSync(path.join(source, '.cache', 'data'), 'fixture');
  fs.symlinkSync(path.join(source, 'server.js'), path.join(source, 'linked.js'));
  copyApplicationTree(source, destination);
  assert.deepEqual(fs.readdirSync(destination).sort(), ['durable', 'server.js']);
  assert.deepEqual(fs.readdirSync(path.join(destination, 'durable')), ['schema.sql']);
});

test('dependency bundle preserves portable links and refuses external links', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-dependency-filter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'node_modules'), destination = path.join(directory, 'bundle');
  fs.mkdirSync(path.join(source, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(source, 'package', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package', 'cli.js'), 'fixture');
  fs.writeFileSync(path.join(source, 'package', 'cli.js.map'), 'fixture');
  fs.writeFileSync(path.join(source, 'package', 'cli.test.js'), 'fixture');
  fs.writeFileSync(path.join(source, 'package', 'cli.test.d.ts'), 'fixture');
  fs.writeFileSync(path.join(source, 'package', 'cli.d.ts'), 'fixture');
  fs.writeFileSync(path.join(source, '.DS_Store'), 'fixture');
  fs.writeFileSync(path.join(source, 'package', 'tests', 'sample.js'), 'fixture');
  fs.symlinkSync('../package/cli.js', path.join(source, '.bin', 'cli'));
  copyDependencyTree(source, destination);
  assert.equal(fs.existsSync(path.join(destination, '.DS_Store')), false);
  assert.equal(fs.readlinkSync(path.join(destination, '.bin', 'cli')), '../package/cli.js');
  assert.equal(fs.readFileSync(path.join(destination, '.bin', 'cli'), 'utf8'), 'fixture');
  assert.deepEqual(fs.readdirSync(path.join(destination, 'package')), ['cli.js']);
  fs.symlinkSync(directory, path.join(source, 'outside'));
  assert.throws(() => copyDependencyTree(source, path.join(directory, 'bad-bundle')), /absolute target/);
});
