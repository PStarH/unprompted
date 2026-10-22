#!/usr/bin/env node
// A disposable, credential-free demo; normal `npm start` keeps its read-only defaults.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run demo -- [--port 4173]\nStarts a fresh local simulation. No account, API key, or external send.');
  process.exit(0);
}
const port = args.length === 2 && args[0] === '--port' ? args[1] : process.env.PORT || '4173';
if ((args.length && !(args.length === 2 && args[0] === '--port')) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('Usage: npm run demo -- [--port 4173]. The port must be between 1 and 65535.');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-demo-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
Object.assign(env, {
  PORT: port,
  UNPROMPTED_STATE_FILE: path.join(dir, 'state.json'),
  UNPROMPTED_SHADOW_MODE: 'false',
  UNPROMPTED_FORCE_SIMULATION: 'true',
  UNPROMPTED_SYNC_INTERVAL_MS: '0'
});
console.log(`\nUnprompted demo → http://127.0.0.1:${port}/`);
console.log('Fresh simulated data. Approval writes only to a local simulated outbox.');
console.log('Watch for about 15 seconds, then choose “Approve simulated send”. Ctrl+C to stop.\n');
const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env, stdio: 'inherit' });
const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
child.on('error', error => { console.error(`Cannot start the demo: ${error.message}`); cleanup(); process.exitCode = 1; });
child.on('exit', (code, signal) => { cleanup(); process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
