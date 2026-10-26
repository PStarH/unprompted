import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startFixtureServer({ demo = false, desktop = false, ruleDemo = true, root: suppliedRoot = null, nodeArgs = [], serverEnv = {}, directory: suppliedDirectory = null } = {}) {
  const root = suppliedRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = suppliedDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-browser-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
  const child = spawn(process.env.UNPROMPTED_FIXTURE_NODE || process.execPath, [...nodeArgs, path.join(root, 'server.js')], {
    cwd: root, env: { ...env, PORT: String(port), UNPROMPTED_FORCE_SIMULATION: String(ruleDemo), ...(ruleDemo ? { UNPROMPTED_SHADOW_MODE: desktop ? 'true' : 'false' } : {}),
      UNPROMPTED_DEMO_MODE: String(demo && !desktop), UNPROMPTED_DESKTOP_APP: desktop ? '1' : '0',
      UNPROMPTED_CONFIG_DIR: path.join(directory, 'config'), UNPROMPTED_STATE_FILE: path.join(directory, 'state.json'), ...serverEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const emergencyStop = () => { child.kill(); };
  process.once('exit', emergencyStop);
  const close = async () => {
    process.removeListener('exit', emergencyStop);
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    if (!suppliedDirectory) fs.rmSync(directory, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture server exited: ${log}`);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { base, close, directory, processId: child.pid, log: () => log };
      } catch { /* wait for the isolated server */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Fixture server did not become ready: ${log}`);
  } catch (error) { await close(); throw error; }
}
