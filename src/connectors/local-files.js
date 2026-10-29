import fs from 'node:fs';
import path from 'node:path';
import { Connector, ConnectorError } from './connector.js';
import { digest, nativeSnapshot } from './local-snapshot.js';

const EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const IGNORED = new Set(['node_modules', 'Library', 'vendor', 'build', 'dist', 'coverage']);
const MAX_BYTES = 512 * 1024, MAX_FILES = 500, MAX_ENTRIES = 5000, MAX_PASS_BYTES = 4 * 1024 * 1024;
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const version = stat => `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;

export function canonicalLocalRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 4096) throw new Error('Choose an absolute folder path.');
  const canonical = fs.realpathSync(input), stat = fs.statSync(canonical);
  if (!stat.isDirectory() || canonical === path.parse(canonical).root) throw new Error('Choose a specific folder, not the filesystem root.');
  return canonical;
}

/** A parent selection already covers its children; never duplicate their tasks. */
export function mergeLocalRoots(existing, additions, makeId) {
  let roots = [...existing];
  for (const input of additions) {
    const canonical = canonicalLocalRoot(input);
    if (roots.some(root => root.path === canonical || inside(root.path, canonical))) continue;
    roots = roots.filter(root => !inside(canonical, root.path));
    roots.push({ id: makeId(), path: canonical, label: path.basename(canonical) });
  }
  if (roots.length > 10) throw new Error('Select up to 10 specific folders.');
  return roots;
}

/** Descriptor-bound text reads; scope and inode are checked around opening. */
export function readScopedText(root, relative, expected = null) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('Invalid local document path.');
  const target = path.join(root, relative), canonical = fs.realpathSync(target);
  if (!inside(root, canonical) || canonical !== target || !EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error('Local document is outside the selected scope.');
  const before = fs.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_BYTES)) throw new Error('Local document is unavailable or too large.');
  if (expected && version(before) !== expected) throw new Error('Local document changed during observation.');
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || version(opened) !== version(before) || fs.realpathSync(target) !== canonical) throw new Error('Local document changed while opening.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) { const n = fs.readSync(descriptor, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
    if (length > MAX_BYTES || buffer.subarray(0, length).includes(0) || version(fs.fstatSync(descriptor, { bigint: true })) !== version(opened)) throw new Error('Local document is incomplete, binary, or changed during reading.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
}

export class LocalFilesConnector extends Connector {
  constructor({ scopeId, roots = [], baseUrl = '', now = Date.now } = {}) {
    super({ id: 'local_files', kind: 'local_files' });
    Object.assign(this, { scopeId, roots, baseUrl, now, live: Boolean(scopeId && roots.length), shadow: true,
      account: { id: scopeId, label: 'Selected local folders' } });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Selected local folder'], detail: 'Read Markdown and UTF-8 text in explicitly selected folders.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['local.selected_text'] : [], incremental: this.live ? ['local.snapshot'] : [], observation: this.live ? 'poll' : 'none' }; }
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: null });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 0, unavailable: false };
  }
  async pull({ cursor = null } = {}) {
    if (!this.live) throw new ConnectorError('No local folder is connected.', { connectorId: this.id });
    const documents = [], unavailable = [], errors = [], seen = new Set();
    let entries = 0, files = 0, bytes = 0, complete = true;
    for (const grant of this.roots) {
      try {
        if (canonicalLocalRoot(grant.path) !== grant.path) throw new Error('Selected folder identity changed.');
        const stack = [{ directory: grant.path, relative: '', depth: 0 }];
        while (stack.length) {
          const current = stack.pop();
          if (fs.realpathSync(current.directory) !== current.directory) throw new Error('A selected directory changed identity.');
          if (current.depth > 12) { complete = false; errors.push({ scope: grant.label || 'Selected folder', message: 'A selected folder exceeds the nesting limit.', retryable: false }); continue; }
          const listing = fs.readdirSync(current.directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of listing) {
            if (++entries > MAX_ENTRIES) throw new Error('The selected folders contain too many entries. Choose a narrower folder.');
            if (entry.name.startsWith('.') || IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
            const relative = path.join(current.relative, entry.name), filename = path.join(grant.path, relative);
            if (entry.isDirectory()) { stack.push({ directory: filename, relative, depth: current.depth + 1 }); continue; }
            if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            if (++files > MAX_FILES) throw new Error('The selected folders contain more than 500 text files. Choose a narrower folder.');
            const id = `local_files:${this.scopeId}:${grant.id}:${digest(relative)}`;
            seen.add(id);
            try {
              const stat = fs.lstatSync(filename, { bigint: true }), stamp = version(stat);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_BYTES)) { unavailable.push({ id, reason: 'too_large_or_unreadable' }); continue; }
              const metadata = { id, title: entry.name, rootId: grant.id, relative, stamp, modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() };
              const known = cursor?.documents?.[id];
              if (known?.stamp === stamp && !known.unavailable) { documents.push({ ...metadata, unchanged: true }); continue; }
              if (bytes + Number(stat.size) > MAX_PASS_BYTES) { complete = false; errors.push({ scope: grant.label || 'Selected folder', message: 'More local text remains for the next observation.', retryable: true }); continue; }
              const content = readScopedText(grant.path, relative, stamp); bytes += Buffer.byteLength(content);
              documents.push({ ...metadata, content });
            } catch { unavailable.push({ id, reason: 'unreadable_or_changed' }); errors.push({ scope: grant.label || 'Selected folder', message: 'A local text file could not be read completely.', retryable: true }); }
          }
        }
      } catch {
        complete = false;
        for (const [id, doc] of Object.entries(cursor?.documents || {})) if (doc.rootId === grant.id && !seen.has(id)) unavailable.push({ id, reason: 'folder_unreadable' });
        errors.push({ scope: grant.label || 'Selected folder', message: 'A selected folder could not be completely observed. Check access or choose a narrower folder.', retryable: true });
      }
    }
    // Revoked grants are known to be unavailable even if another folder failed.
    const allowed = new Set(this.roots.map(root => root.id));
    for (const [id, doc] of Object.entries(cursor?.documents || {})) if (!allowed.has(doc.rootId)) unavailable.push({ id, reason: 'scope_removed' });
    return nativeSnapshot({ connectorId: this.id, scopeId: this.scopeId, documents, unavailable, cursor, complete,
      baseUrl: this.baseUrl, now: this.now, errors, counts: { documents: documents.length, textFilesSeen: files, skippedOrUnavailable: unavailable.length } });
  }
}
