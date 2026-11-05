import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_FOR_OPERATION = Object.freeze({
  'choose-notes': 'Notes', 'read-notes': 'Notes', 'create-note': 'Notes',
  'choose-reminders': 'Reminders', 'read-reminders': 'Reminders', 'create-reminder': 'Reminders', 'change-reminder': 'Reminders', 'delete-reminder': 'Reminders',
  'choose-calendar': 'Calendar', 'read-calendar': 'Calendar',
  'choose-mail': 'Mail', 'read-mail': 'Mail',
  'choose-contacts': 'Contacts', 'read-contacts': 'Contacts', 'lookup-contacts': 'Contacts'
});

export function nativeAccessMessage(code, operation) {
  const app = APP_FOR_OPERATION[operation];
  if (code === 'AUTOMATION_DENIED') {
    const target = app || 'Notes, Reminders, Calendar, Mail, or Contacts';
    return `macOS blocked Automation access to ${target}. Open System Settings → Privacy & Security → Automation, allow this app to control ${target}, then retry.`;
  }
  if (code === 'UNSUPPORTED') return 'Notes, Reminders, Calendar, Mail, Contacts, and the folder picker require macOS.';
  if (code === 'NO_FOLDERS') return app ? `No readable ${app} items are available to select.` : 'Nothing in the selected Apple app is available to read.';
  return undefined;
}

export class NativeAccessError extends Error {
  constructor(code, message) {
    const messages = { UNSUPPORTED: 'Notes, Reminders, Calendar, Mail, Contacts, and the folder picker require macOS.', CANCELLED: 'Selection was cancelled.',
      AUTOMATION_DENIED: 'macOS blocked Automation access. Open System Settings → Privacy & Security → Automation, allow this app to control the Apple app you selected, then retry.',
      NO_FOLDERS: 'Nothing in the selected Apple app is available to read.', NATIVE_ACCESS_FAILED: 'The native source could not be read. Check its permission and try again.',
      TIMEOUT: 'The native source did not respond in time. Try again.', TOO_LARGE: 'The native response exceeded the read limit.' };
    super(message || messages[code] || messages.NATIVE_ACCESS_FAILED); this.name = 'NativeAccessError'; this.code = code;
  }
}

export class NativeSourceBridge {
  constructor({ platform = process.platform, spawnImpl = spawn } = {}) { Object.assign(this, { platform, spawnImpl }); }
  async run(operation, payload = {}, { signal, timeoutMs = operation.startsWith('choose-') ? 120_000 : 30_000 } = {}) {
    if (this.platform !== 'darwin') throw new NativeAccessError('UNSUPPORTED');
    if (!['choose-files', 'choose-notes', 'read-notes', 'create-note', 'choose-reminders', 'read-reminders', 'create-reminder', 'change-reminder', 'delete-reminder', 'choose-calendar', 'read-calendar', 'choose-mail', 'read-mail', 'choose-contacts', 'read-contacts', 'lookup-contacts'].includes(operation)) throw new NativeAccessError('NATIVE_ACCESS_FAILED');
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
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (code !== 0 || value.ok !== true) throw new NativeAccessError(value.code || 'NATIVE_ACCESS_FAILED', nativeAccessMessage(value.code, operation)); finish(null, value); }
        catch (error) { finish(error instanceof NativeAccessError ? error : new NativeAccessError('NATIVE_ACCESS_FAILED')); }
      });
      if (signal?.aborted) abort();
      if (!settled) child.stdin.end(JSON.stringify(payload));
    });
  }
  chooseReminders(options = {}) { return this.run('choose-reminders', { locale: options.locale }, options); }
  readReminders(folders, options = {}) { return this.run('read-reminders', { folders }, options); }
  createReminder(folder, content, options = {}) { return this.run('create-reminder', { folder, ...content }, options); }
  changeReminder(folder, reminderId, changes, expectedUpdatedAt, options = {}) { return this.run('change-reminder', { folder, reminderId, changes, expectedUpdatedAt }, options); }
  deleteReminder(folder, reminderId, expectedUpdatedAt, options = {}) { return this.run('delete-reminder', { folder, reminderId, expectedUpdatedAt }, options); }
  chooseFiles(options = {}) { return this.run('choose-files', { locale: options.locale }, options); }
  chooseNotes(options = {}) { return this.run('choose-notes', { locale: options.locale }, options); }
  readNotes(folders, known, options = {}) { return this.run('read-notes', { folders, known }, options); }
  createNote(folder, content, options = {}) { return this.run('create-note', { folder, ...content }, options); }
  chooseCalendar(options = {}) { return this.run('choose-calendar', { locale: options.locale }, options); }
  readCalendar(folders, window, options = {}) { return this.run('read-calendar', { folders, window }, options); }
  chooseMail(options = {}) { return this.run('choose-mail', { locale: options.locale }, options); }
  readMail(folders, window, options = {}) { return this.run('read-mail', { folders, window }, options); }
  chooseContacts(options = {}) { return this.run('choose-contacts', { locale: options.locale }, options); }
  readContacts(folders, options = {}) { return this.run('read-contacts', { folders }, options); }
  lookupContacts(folders, query, options = {}) { return this.run('lookup-contacts', { folders, query }, options); }
}
