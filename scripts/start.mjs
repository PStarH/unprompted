#!/usr/bin/env node
// Persistent model-first workspace. Never strips model/account configuration.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseDemoPort } from './demo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const usage = 'Usage: npm start -- [--port 4173] [--no-open | --open]';
async function start() {
  if (args.includes('--help')) { console.log(usage); return; }
  let requested = process.env.PORT || '4173', strict = Boolean(process.env.PORT);
  let open = Boolean(process.stdin.isTTY && !process.env.CI);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port' && args[index + 1]) { requested = args[++index]; strict = true; }
    else if (args[index] === '--no-open') open = false;
    else if (args[index] === '--open') open = true;
    else throw new Error(usage);
  }
  if (!/^\d+$/.test(requested) || Number(requested) < 1 || Number(requested) > 65535) throw new Error(usage);
  const port = await chooseDemoPort(Number(requested), { strict });
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
  let ended = false;
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const done = new Promise(resolve => {
    const finish = code => { if (ended) return; ended = true; process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); resolve(code); };
    child.once('error', () => finish(1)); child.once('exit', (code, signal) => finish(code ?? (['SIGINT', 'SIGTERM'].includes(signal) ? 0 : 1)));
  });
  const base = `http://127.0.0.1:${port}/`;
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (!ended && Date.now() < deadline) {
      try {
        const response = await fetch(base + 'api/health', { signal: AbortSignal.timeout(500) });
        const health = response.ok ? await response.json() : null;
        if (health?.ok && health.processId === child.pid) { ready = true; break; }
      } catch { /* wait for our own server */ }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    if (ready) {
      console.log(`\nReady → ${base}`);
      console.log('Connect your model in the interface. Your settings and workspace stay on this machine.');
      if (port !== Number(requested)) console.log(`Port ${requested} was busy; using ${port}.`);
      if (open) {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const opener = spawn(command, process.platform === 'win32' ? ['/c', 'start', '', base] : [base], { stdio: 'ignore', detached: process.platform !== 'win32' });
        opener.on('error', () => console.log(`Open ${base} in your browser.`)); opener.unref();
      }
    } else if (!ended) { child.kill('SIGTERM'); console.error('The workspace did not become ready. Check the server message above.'); }
    process.exitCode = await done;
  } catch (error) { child.kill('SIGTERM'); await done; throw error; }
}
start().catch(error => { console.error(error.message); process.exitCode = 1; });
