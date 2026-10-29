import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class NativeAccessError extends Error {
  constructor(code) {
    const messages = { UNSUPPORTED: 'Apple Notes and the native folder picker require macOS.', CANCELLED: 'Selection was cancelled.',
      AUTOMATION_DENIED: 'Allow this application to access Notes in macOS Privacy & Security → Automation, then retry.',
      NO_FOLDERS: 'No readable Notes folders are available.', NATIVE_ACCESS_FAILED: 'The native source could not be read. Check its permission and try again.',
      TIMEOUT: 'The native source did not respond in time. Try again.', TOO_LARGE: 'The native response exceeded the read limit.' };
    super(messages[code] || messages.NATIVE_ACCESS_FAILED); this.name = 'NativeAccessError'; this.code = code;
  }
}

export class NativeSourceBridge {
  constructor({ platform = process.platform, spawnImpl = spawn } = {}) { Object.assign(this, { platform, spawnImpl }); }
  async run(operation, payload = {}, { signal, timeoutMs = operation.startsWith('choose-') ? 120_000 : 30_000 } = {}) {
    if (this.platform !== 'darwin') throw new NativeAccessError('UNSUPPORTED');
    if (!['choose-files', 'choose-notes', 'read-notes', 'create-note'].includes(operation)) throw new NativeAccessError('NATIVE_ACCESS_FAILED');
    if (signal?.aborted) throw new NativeAccessError('CANCELLED');
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnImpl('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./native-source-script.jxa.js', import.meta.url)), operation],
        { stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(new NativeAccessError('NATIVE_ACCESS_FAILED')); return; }
      let bytes = 0, chunks = [], settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { child.kill('SIGTERM'); reject(error); } else resolve(value);
      };
      const abort = () => finish(new NativeAccessError('CANCELLED'));
      const timer = setTimeout(() => finish(new NativeAccessError('TIMEOUT')), timeoutMs); timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) finish(new NativeAccessError('TOO_LARGE')); else chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', () => {}); // Never echo script diagnostics or private source values.
      child.on('error', () => finish(new NativeAccessError('NATIVE_ACCESS_FAILED')));
      child.stdin.on('error', () => finish(new NativeAccessError('NATIVE_ACCESS_FAILED')));
      child.on('close', code => {
        if (settled) return;
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (code !== 0 || value.ok !== true) throw new NativeAccessError(value.code || 'NATIVE_ACCESS_FAILED'); finish(null, value); }
        catch (error) { finish(error instanceof NativeAccessError ? error : new NativeAccessError('NATIVE_ACCESS_FAILED')); }
      });
      if (signal?.aborted) abort();
      if (!settled) child.stdin.end(JSON.stringify(payload));
    });
  }
  chooseFiles(options = {}) { return this.run('choose-files', { locale: options.locale }, options); }
  chooseNotes(options = {}) { return this.run('choose-notes', { locale: options.locale }, options); }
  readNotes(folders, known, options = {}) { return this.run('read-notes', { folders, known }, options); }
  createNote(folder, content, options = {}) { return this.run('create-note', { folder, ...content }, options); }
}
