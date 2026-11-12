#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(repoRoot, 'website', 'docs');
const failures = [];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
}

const htmlFiles = walk(docsRoot);
const cache = new Map();
const read = file => {
  if (!cache.has(file)) cache.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return cache.get(file);
};

for (const file of htmlFiles) {
  const html = read(file);
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map(match => match[1]);
  for (const ref of refs) {
    if (!ref || /^(?:https?:|mailto:|#)/i.test(ref)) continue;
    const [pathname, hash] = ref.split('#');
    const target = path.normalize(path.join(path.dirname(file), pathname || '.'));
    const candidate = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, 'index.html')
      : target;
    const body = read(candidate);
    const label = `${path.relative(repoRoot, file)} → ${ref}`;
    if (body == null) {
      failures.push(`${label} (missing)`);
      continue;
    }
    if (hash && !idsIn(body).has(decodeURIComponent(hash))) failures.push(`${label} (missing #${hash})`);
  }
}

const expected = [
  ['website/index.html', 'docs/'],
  ['website/index.html', 'docs/quickstart/'],
  ['website/index.html', 'docs/connectors/'],
  ['website/privacy.html', 'docs/configuration/'],
  ['website/terms.html', 'docs/'],
  ['website/terms.html', 'docs/architecture/']
];
for (const [file, href] of expected) {
  const html = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  if (!html.includes(`href="${href}"`) && !html.includes(`href="${href.replace(/\/$/, '')}"`)) {
    failures.push(`${file} does not link to ${href}`);
  }
  const target = path.join(repoRoot, 'website', href, 'index.html');
  if (!fs.existsSync(target)) failures.push(`missing published page ${href}`);
}

for (const file of ['sitemap.xml', 'faq/index.html', 'zh/faq/index.html', 'security/index.html', 'follow-up/index.html']) {
  if (!fs.existsSync(path.join(docsRoot, file))) failures.push(`missing published file ${file}`);
}
for (const file of ['llms.txt', 'llms-full.txt', 'index.md']) {
  if (fs.existsSync(path.join(docsRoot, file))) failures.push(`unexpected published file ${file}`);
}
const home = fs.readFileSync(path.join(docsRoot, 'index.html'), 'utf8');
for (const needle of ['class="crumbs"', 'issues/new?title=', 'application/ld+json', 'data-copy-page', 'id="page-markdown"']) {
  if (!home.includes(needle)) failures.push(`overview missing ${needle}`);
}
for (const needle of ['class="hero"', 'llms.txt', 'href="index.md"', '/edit/main/', 'Local-first prototype', '本地优先的原型', 'Edit this page', '编辑此页']) {
  if (home.includes(needle)) failures.push(`overview still contains ${needle}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Checked ${htmlFiles.length} HTML files. Internal links and website Docs entries resolve.`);
