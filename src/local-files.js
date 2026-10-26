import fs from 'node:fs';

/** Read and inspect the same opened file; path replacement cannot change it. */
export function readRegularFile(filename, { maxBytes = 1024 * 1024, mode = null } = {}) {
  const expected = fs.constants.O_NOFOLLOW ? null : fs.lstatSync(filename);
  if (expected && (!expected.isFile() || expected.isSymbolicLink())) throw new Error('Configuration must be a regular file.');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const descriptor = fs.openSync(filename, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Configuration must be a regular file.');
    if (expected && (expected.ino !== stat.ino || expected.dev !== stat.dev)) throw new Error('Configuration changed while opening it.');
    if (stat.size > maxBytes) throw new Error('Configuration file is too large.');
    if (mode != null) {
      try { fs.fchmodSync(descriptor, mode); } catch { /* Filesystems without POSIX modes. */ }
    }
    // Bound the read too: a writer may grow this inode after fstat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new Error('Configuration file is too large.');
    return buffer.toString('utf8', 0, length);
  } finally { fs.closeSync(descriptor); }
}
