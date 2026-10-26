#!/usr/bin/env node
// A disposable, credential-free demo. Normal mode keeps its read-only defaults.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: npm run demo -- [--port 4173] [--no-open | --open]';

export async function chooseDemoPort(preferred, { strict = false, attempts = 20 } = {}) {
  for (let offset = 0; offset < (strict ? 1 : attempts); offset++) {
    const port = preferred + offset;
    if (port > 65535) break;
    const available = await new Promise((resolve, reject) => {
      const listener = net.createServer();
      listener.once('error', error => error.code === 'EADDRINUSE' || error.code === 'EACCES' ? resolve(false) : reject(error));
      listener.listen(port, '127.0.0.1', () => listener.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(`Port ${preferred}${strict ? '' : ` through ${Math.min(preferred + attempts - 1, 65535)}`} is unavailable. Try: npm run demo -- --port ${preferred < 65535 ? Math.min(preferred + attempts, 65535) : 4180}`);
}

export async function launchDemo(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log(`${usage}\nStarts when you open the page. No install, account, API key or external send.\nA busy default port is replaced automatically. Ctrl+C stops the demo.`);
    return;
  }
  let requested = process.env.PORT || '4173';
  let strict = Boolean(process.env.PORT);
  let openBrowser = Boolean(process.stdin.isTTY && !process.env.CI);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port' && args[index + 1]) { requested = args[++index]; strict = true; }
    else if (args[index] === '--no-open') openBrowser = false;
    else if (args[index] === '--open') openBrowser = true;
    else throw new Error(usage);
  }
  if (!/^\d+$/.test(requested) || Number(requested) < 1 || Number(requested) > 65535) {
    throw new Error(`${usage}\nThe port must be between 1 and 65535.`);
  }
  const port = await chooseDemoPort(Number(requested), { strict });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-demo-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
  Object.assign(env, {
    PORT: String(port), UNPROMPTED_DEMO_MODE: 'true',
    UNPROMPTED_CONFIG_DIR: path.join(directory, 'config'),
    UNPROMPTED_STATE_FILE: path.join(directory, 'state.json'),
    UNPROMPTED_SHADOW_MODE: 'false', UNPROMPTED_FORCE_SIMULATION: 'true',
    UNPROMPTED_SYNC_INTERVAL_MS: '0'
  });
  console.log('\nStarting a fresh Unprompted demo…');
  if (port !== Number(requested)) console.log(`Port ${requested} is busy; using ${port}.`);
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env, stdio: 'inherit' });
  let spawnError, exited = false, stopping = false;
  const forward = signal => { stopping = true; child.kill(signal); };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  const done = new Promise(resolve => {
    const finish = code => {
      if (exited) return;
      exited = true;
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
      fs.rmSync(directory, { recursive: true, force: true });
      resolve(code);
    };
    child.once('error', error => { spawnError = error; finish(1); });
    child.once('exit', (code, signal) => finish(code ?? (['SIGINT', 'SIGTERM'].includes(signal) ? 0 : 1)));
  });
  const base = `http://127.0.0.1:${port}/`;
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (!exited && !stopping && Date.now() < deadline) {
      try {
        const response = await fetch(base + 'api/runtime', { signal: AbortSignal.timeout(500) });
        const report = response.ok ? await response.json() : null;
        if (report?.demo?.enabled && report.mode === 'simulation' && report.mailProvider === 'simulated' && !report.shadow) { ready = true; break; }
      } catch { /* wait for this isolated server */ }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    if (!ready && !stopping) throw new Error(spawnError ? `Cannot start: ${spawnError.message}` : 'The demo did not become ready. Try another port with --port 4180.');
    if (ready) {
      console.log(`\nReady → ${base}`);
      console.log('Open the page to begin a 15-second story. No task prompt needed.');
      console.log('Review the reply → Send simulated reply → See the verified result.');
      console.log('中文界面：查看回复 → 发送模拟回复 → 查看核验结果。');
      console.log('Nothing goes to real contacts. This temporary workspace is removed on exit.');
      console.log('Ctrl+C to stop. Your own workspace: npm start\n');
      if (openBrowser) {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const browserArgs = process.platform === 'win32' ? ['/c', 'start', '', base] : [base];
        const opener = spawn(command, browserArgs, { stdio: 'ignore', detached: process.platform !== 'win32' });
        opener.on('error', () => console.log(`Open ${base} in your browser.`));
        opener.unref();
      }
    }
  } catch (error) {
    if (!exited) child.kill('SIGTERM');
    await done;
    throw error;
  }
  process.exitCode = await done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchDemo().catch(error => { console.error(error.message); process.exitCode = 1; });
}
