#!/usr/bin/env node
// Review the candidate public file set. Findings print locations, never secret values.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function publicFiles() {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return [...new Set(names.split('\0').filter(Boolean))].filter(name => fs.existsSync(path.join(root, name))).sort();
}
const privatePath = /(^|\/)(?:\.internal|outputs|data|films|\.workbuddy-ai|\.browser-cache|node_modules|\.aws|\.codex|\.agents)(\/|$)|^docs\/evidence\//;
const credentialPath = /(^|\/)(?:\.env(?:\..*)?|client_secret[^/]*\.json|credentials\.json|token\.json|[^/]+\.(?:pem|key))$/i;
const secrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/, /ya29\.[A-Za-z0-9_-]{15,}/,
  /1\/\/[A-Za-z0-9_-]{25,}/, /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{30,}/, /sk-[A-Za-z0-9_-]{25,}/,
  /GOCSPX-[A-Za-z0-9_-]{20,}/, /AIza[A-Za-z0-9_-]{30,}/
];
const internalProse = /private\s+during\s+the\s+value-validation\s+phase|contributions\s+are\s+by\s+invitation|仓库.{0,12}保持私有|竞品|竞争背景|北极星指标|\/Users\/|\/Volumes\/WorkDisk\//i;
function slug(heading) {
  return heading.toLowerCase().replace(/`([^`]+)`/g, '$1').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
}
export function checkPublic(files = publicFiles()) {
  const findings = [];
  const allowed = new Set(files);
  for (const name of files) {
    const filename = path.join(root, name);
    if (privatePath.test(name) || (name !== '.env.example' && credentialPath.test(name))) findings.push(`${name}: private file in public candidate`);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) { findings.push(`${name}: symbolic links need explicit review`); continue; }
    if (!stat.isFile()) continue;
    const data = fs.readFileSync(filename);
    if (data.includes(0)) continue;
    const content = data.toString('utf8');
    content.split('\n').forEach((line, i) => {
      if (secrets.some(pattern => pattern.test(line))) findings.push(`${name}:${i + 1}: credential signature`);
      if (/\.(?:md|ya?ml)$/.test(name) && internalProse.test(line)) findings.push(`${name}:${i + 1}: internal document content or machine path`);
    });
    if (!name.endsWith('.md')) continue;
    // Inline Markdown links/images, excluding fenced code examples.
    const markdown = content.replace(/```[\s\S]*?```/g, '');
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const url = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|data:)/.test(url)) continue;
      const [target, fragment] = url.split('#');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), decodeURIComponent(target || path.posix.basename(name))));
      if (!allowed.has(resolved)) { findings.push(`${name}: link target absent from public candidate: ${resolved}`); continue; }
      if (fragment && resolved.endsWith('.md')) {
        const headings = fs.readFileSync(path.join(root, resolved), 'utf8').split('\n').filter(line => /^#{1,6} /.test(line)).map(line => slug(line.replace(/^#{1,6} /, '')));
        if (!headings.includes(decodeURIComponent(fragment))) findings.push(`${name}: missing heading: ${resolved}#${fragment}`);
      }
    }
  }
  return { files: files.length, findings };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPublic();
  if (result.findings.length) { console.error(result.findings.join('\n')); process.exitCode = 1; }
  else console.log(`Public file check passed: ${result.files} files; local links and document content checked; no credential signatures found.\nThis pattern-based check does not erase Git history or replace manual review.`);
}
