#!/usr/bin/env node
// Export reviewed working files only. Git history, local state and campaign files never enter the snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, publicFiles, checkPublic } from './check-public.mjs';

const files = publicFiles();
const result = checkPublic(files);
if (result.findings.length) { console.error(result.findings.join('\n')); process.exit(1); }
const output = path.join(root, 'outputs');
fs.mkdirSync(output, { recursive: true });
const bundle = fs.mkdtempSync(path.join(output, 'public-release-'));
const snapshot = path.join(bundle, 'unprompted');
fs.mkdirSync(snapshot);
for (const name of files) {
  const target = path.join(snapshot, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, name), target);
}
const archive = path.join(bundle, 'unprompted-source.tar.gz');
execFileSync('tar', ['--no-xattrs', '-czf', archive, '-C', bundle, 'unprompted'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' }
});
fs.writeFileSync(path.join(bundle, 'MANIFEST.txt'), files.join('\n') + '\n');
fs.writeFileSync(path.join(bundle, 'PUBLISHING.md'), `# Reviewed public snapshot\n\nThis directory contains current public source files only, with no .git directory or old history.\n\nBefore making the existing GitHub repository public, resolve the internal documents in its old commits. A normal commit deleting or editing them does not remove those versions.\n\nOptions are a fresh repository from this snapshot, or a separately reviewed history migration. Do not force-push over the existing repository without reviewing branches, tags, pull requests, releases and backups.\n\nTo start a new history locally:\n\n\`\`\`sh\ncd unprompted\ngit init -b main\ngit add .\ngit commit -m "Initial public release"\n\`\`\`\n\nThen connect the intended destination after reviewing it. No remote was modified by the preparation command.\n`);
console.log(JSON.stringify({ snapshot, archive, files: files.length, historyIncluded: false, remoteModified: false }, null, 2));
