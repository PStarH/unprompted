import fs from 'node:fs';
import path from 'node:path';

const privateName = /^(?:\.env(?:\..*)?|\.npmrc|credentials\.json|token\.json|mcp\.json|connector-clients\.json|client_secret.*\.json)$/i;
const privateExtension = /\.(?:pem|key|sqlite(?:-wal|-shm)?|db|log|map|migration-backup)$/i;

export function copyApplicationTree(source, destination) {
  const root = path.resolve(source);
  fs.cpSync(root, destination, { recursive: true, filter: current => {
    const relative = path.relative(root, current);
    if (!relative) return true;
    const parts = relative.split(path.sep), name = parts.at(-1);
    if (parts.some(part => part.startsWith('.')) || privateName.test(name) || privateExtension.test(name)) return false;
    return !fs.lstatSync(current).isSymbolicLink();
  } });
}

export function copyDependencyTree(source, destination) {
  const root = fs.realpathSync(source);
  fs.cpSync(root, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: current => {
    const relative = path.relative(root, current);
    if (!relative) return true;
    const parts = relative.split(path.sep), name = parts.at(-1);
    if (parts.some(part => ['test', 'tests', 'fixtures', 'examples', '.cache', '__MACOSX'].includes(part))
      || name === '.DS_Store' || name.startsWith('._') || /\.(?:test|spec)(?:\.|$)/i.test(name)
      || /\.d\.(?:ts|cts|mts)$/i.test(name) || privateName.test(name) || privateExtension.test(name)) return false;
    if (!fs.lstatSync(current).isSymbolicLink()) return true;
    const target = fs.readlinkSync(current);
    if (path.isAbsolute(target)) throw new Error('A dependency symlink has an absolute target. Reinstall dependencies in a clean directory.');
    let resolved;
    try { resolved = fs.realpathSync(current); } catch { throw new Error('A dependency symlink is broken. Reinstall dependencies in a clean directory.'); }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('A dependency symlink points outside node_modules. Reinstall dependencies in a clean directory.');
    return true;
  } });
}
