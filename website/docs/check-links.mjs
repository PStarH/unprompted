#!/usr/bin/env node
/**
 * Check the generated documentation site without network access.
 * Verifies local href/src targets, fragment IDs, search-index targets and
 * basic page metadata.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = [];
const errors = [];
const internal = [];
const external = new Set();

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'content') continue;
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(full);
    }
  }
}

function decode(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"');
}

function stripHash(value) {
  const index = value.indexOf('#');
  return index === -1 ? { pathname: value, hash: '' } : { pathname: value.slice(0, index), hash: value.slice(index + 1) };
}

function pageFile(target) {
  const resolved = path.resolve(root, target);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) return { resolved, outside: true };
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return { resolved: path.join(resolved, 'index.html') };
  }
  if (!fs.existsSync(resolved) && !path.extname(resolved)) {
    const candidate = path.join(resolved, 'index.html');
    if (fs.existsSync(candidate)) return { resolved: candidate };
    const htmlCandidate = `${resolved}.html`;
    if (fs.existsSync(htmlCandidate)) return { resolved: htmlCandidate };
  }
  return { resolved };
}

function idsFor(file) {
  const html = fs.readFileSync(file, 'utf8');
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => decode(match[1])));
}

function checkFragment(file, hash, source) {
  if (!hash) return;
  let target = hash;
  try { target = decodeURIComponent(hash); } catch { /* keep raw */ }
  const ids = idsFor(file);
  if (!ids.has(target)) errors.push(`${path.relative(root, source)}: missing fragment #${hash} in ${path.relative(root, file)}`);
}

walk(root);
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  if (!/<html\s+lang="(?:en|zh-CN)"/.test(html)) errors.push(`${relative}: missing or unexpected html lang`);
  if (!/<meta\s+name="viewport"/.test(html)) errors.push(`${relative}: missing viewport meta`);
  if (!/<title>[^<]+<\/title>/.test(html)) errors.push(`${relative}: missing title`);
  if (!/<h1[\s>]/.test(html)) errors.push(`${relative}: missing h1`);

  const seen = new Set();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    const id = decode(match[1]);
    if (seen.has(id)) errors.push(`${relative}: duplicate id #${id}`);
    seen.add(id);
  }

  for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = decode(match[1]).trim();
    if (!raw) {
      errors.push(`${relative}: empty href/src`);
      continue;
    }
    if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(raw)) {
      if (/^https?:/i.test(raw)) external.add(raw);
      continue;
    }
    if (raw.startsWith('#')) {
      checkFragment(file, raw.slice(1), file);
      continue;
    }
    const { pathname, hash } = stripHash(raw);
    if (!pathname) {
      checkFragment(file, hash, file);
      continue;
    }
    const { resolved, outside } = pageFile(path.resolve(path.dirname(file), pathname));
    if (outside) {
      errors.push(`${relative}: local target escapes docs root: ${raw}`);
      continue;
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      errors.push(`${relative}: missing local target ${raw}`);
      continue;
    }
    internal.push(path.relative(root, resolved));
    if (hash) checkFragment(resolved, hash, file);
  }

  if (relative.endsWith('index.html') && /\bhref="(?!#|https?:)[^"]*\.md(?:#[^"]*)?"/.test(html)) {
    errors.push(`${relative}: raw .md link in generated HTML`);
  }
}

for (const lang of ['en', 'zh']) {
  const indexFile = path.join(root, `search-${lang}.json`);
  if (!fs.existsSync(indexFile)) {
    errors.push(`missing search-${lang}.json`);
    continue;
  }
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch (error) {
    errors.push(`search-${lang}.json is not valid JSON: ${error.message}`);
    continue;
  }
  if (!Array.isArray(entries) || !entries.length) {
    errors.push(`search-${lang}.json is empty`);
    continue;
  }
  for (const entry of entries) {
    if (!entry.title || !entry.pageTitle || typeof entry.url !== 'string') {
      errors.push(`search-${lang}.json: incomplete entry ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    const { pathname, hash } = stripHash(entry.url);
    const { resolved, outside } = pageFile(pathname);
    if (outside || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      errors.push(`search-${lang}.json: missing target ${entry.url}`);
      continue;
    }
    if (hash) checkFragment(resolved, hash, indexFile);
  }
}

const uniqueInternal = new Set(internal);
console.log(`Checked ${files.length} HTML files.`);
console.log(`Internal targets: ${internal.length} references, ${uniqueInternal.size} unique files.`);
console.log(`External targets: ${external.size} unique URLs (not fetched).`);
if (errors.length) {
  console.error(`\n${errors.length} link problem${errors.length === 1 ? '' : 's'}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('All local links, fragments, search targets and page metadata check out.');
