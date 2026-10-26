#!/usr/bin/env node
// Build a local, unsigned macOS .app with an official Node runtime.
// The Node archive is checked against the SHA-256 entry published at nodejs.org.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { publicClientConfiguration } from '../src/connection-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = 'v22.23.4';
const ARCH_MAP = { arm64: 'arm64', x64: 'x64' };
const arch = ARCH_MAP[process.arch];
if (process.platform !== 'darwin' || !arch) {
  throw new Error(`The local app builder needs macOS arm64 or x64; found ${process.platform}/${process.arch}.`);
}

const args = process.argv.slice(2);
let output = path.join(ROOT, 'outputs', 'Unprompted.app');
let googleClientFile = null;
let connectorClientFile = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--out' && args[index + 1]) output = path.resolve(args[++index]);
  else if (args[index] === '--google-client' && args[index + 1]) googleClientFile = path.resolve(args[++index]);
  else if (args[index] === '--connector-clients' && args[index + 1]) connectorClientFile = path.resolve(args[++index]);
  else throw new Error('Usage: node scripts/build-macos-app.mjs [--out PATH] [--google-client DESKTOP_JSON] [--connector-clients PUBLIC_CLIENT_JSON]');
}
let provisionedGoogleClient = null;
if (googleClientFile) {
  if (fs.statSync(googleClientFile).size > 64 * 1024) throw new Error('The Google Desktop client JSON must be smaller than 64 KB.');
  const json = JSON.parse(fs.readFileSync(googleClientFile, 'utf8'));
  const client = json?.installed;
  if (typeof client?.client_id !== 'string' || !client.client_id.trim() || client.client_id.length > 512
    || typeof client?.client_secret !== 'string' || !client.client_secret.trim() || client.client_secret.length > 1024 || json.web
    || (client.auth_uri && client.auth_uri !== 'https://accounts.google.com/o/oauth2/v2/auth')
    || (client.token_uri && client.token_uri !== 'https://oauth2.googleapis.com/token')) throw new Error('Choose an official Google Desktop OAuth client JSON.');
  // Include only registered client metadata, never tokens or account settings.
  provisionedGoogleClient = { installed: { client_id: client.client_id, client_secret: client.client_secret } };
}
if (fs.existsSync(output)) throw new Error(`Output already exists; move it aside or choose --out PATH: ${output}`);
let provisionedConnectorClients = null;
if (connectorClientFile) {
  if (fs.statSync(connectorClientFile).size > 64 * 1024) throw new Error('Connector client configuration is too large.');
  provisionedConnectorClients = publicClientConfiguration(JSON.parse(fs.readFileSync(connectorClientFile, 'utf8')));
}

const archiveName = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
const releaseBase = `https://nodejs.org/download/release/${NODE_VERSION}/`;
const checksumsUrl = `${releaseBase}SHASUMS256.txt`;
const archiveUrl = `${releaseBase}${archiveName}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-macos-app-'));
const archivePath = path.join(tempDir, archiveName);
const contents = path.join(output, 'Contents');
const resources = path.join(contents, 'Resources');
const appRoot = path.join(resources, 'app');
const nodePath = path.join(resources, 'runtime', 'node');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout || '';
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not download ${new URL(url).hostname} metadata (${response.status}).`);
  return response.text();
}

async function download(url, filename) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download the official Node runtime (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
}

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function dependencyList(binary) {
  const output = run('otool', ['-L', binary]);
  return output.split('\n').slice(1).map(line => line.trim().match(/^(.+?) \(/)?.[1]).filter(Boolean);
}

function assertSystemDependencies(dependencies) {
  const unexpected = dependencies.filter(item => !item.startsWith('/System/Library/') && !item.startsWith('/usr/lib/'));
  if (unexpected.length) throw new Error(`The packaged Node runtime has non-system dependencies: ${unexpected.join(', ')}`);
}

try {
  const sums = await fetchText(checksumsUrl);
  const match = sums.split(/\r?\n/).find(line => line.trim().endsWith(` ${archiveName}`));
  const expectedArchiveSha256 = match?.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expectedArchiveSha256 || '')) throw new Error(`The official checksum list did not include ${archiveName}.`);
  await download(archiveUrl, archivePath);
  const actualArchiveSha256 = await sha256(archivePath);
  if (actualArchiveSha256.toLowerCase() !== expectedArchiveSha256.toLowerCase()) {
    throw new Error('The official Node archive checksum did not match; the app was not built.');
  }

  fs.mkdirSync(path.dirname(nodePath), { recursive: true, mode: 0o755 });
  run('tar', ['-xzf', archivePath, '--strip-components=2', '-C', path.dirname(nodePath), `${archiveName.slice(0, -7)}/bin/node`]);
  fs.chmodSync(nodePath, 0o755);
  const nodeVersion = run(nodePath, ['--version']).trim();
  if (nodeVersion !== NODE_VERSION) throw new Error(`Packaged Node reported ${nodeVersion}, expected ${NODE_VERSION}.`);
  const binaryArchitectures = run('lipo', ['-archs', nodePath]).trim().split(/\s+/);
  if (!binaryArchitectures.includes(arch)) throw new Error(`Packaged Node does not contain the expected ${arch} architecture.`);
  const dependencies = dependencyList(nodePath);
  assertSystemDependencies(dependencies);

  fs.mkdirSync(appRoot, { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(appRoot, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(appRoot, 'public'), { recursive: true });
  for (const filename of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, filename), path.join(appRoot, filename));
  if (provisionedGoogleClient) fs.writeFileSync(path.join(appRoot, 'google-oauth-client.json'), JSON.stringify(provisionedGoogleClient) + '\n');
  if (provisionedConnectorClients) fs.writeFileSync(path.join(appRoot, 'connector-clients.json'), JSON.stringify(provisionedConnectorClients) + '\n');
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) fs.copyFileSync(lockPath, path.join(appRoot, 'package-lock.json'));

  const piPackages = ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai'];
  const piInstalled = piPackages.every(name => fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json')));
  let piHarness;
  if (piInstalled) {
    // Pi is optional at runtime, but a self-contained .app must include its
    // locked package tree so an end user never needs npm or a system Node.
    fs.cpSync(path.join(ROOT, 'node_modules'), path.join(appRoot, 'node_modules'), { recursive: true, preserveTimestamps: true });
    run(nodePath, ['--input-type=module', '-e', "await Promise.all([import('@earendil-works/pi-agent-core'),import('@earendil-works/pi-ai'),import('@earendil-works/pi-ai/api/openai-completions')])"], { cwd: appRoot });
    const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : { packages: {} };
    piHarness = {
      available: true,
      nodeEngine: '>=22.19.0',
      packages: Object.fromEntries(piPackages.map(name => [name, lock.packages?.[`node_modules/${name}`]?.version || 'unknown'])),
      runtimeImportCheck: 'passed with bundled Node runtime'
    };
  } else {
    piHarness = {
      available: false,
      packages: {},
      runtimeImportCheck: 'not run; optional Pi packages were not installed when this local app was built'
    };
  }

  const executable = path.join(contents, 'MacOS', 'Unprompted');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, `#!/bin/bash
set -u
CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES="$CONTENTS/Resources"
APP="$RESOURCES/app"
NODE="$RESOURCES/runtime/node"
DATA="${'${UNPROMPTED_CONFIG_DIR:-$HOME/Library/Application Support/Unprompted}'}"
PORT="${'${PORT:-}'}"
if [ -z "$PORT" ]; then
  PORT="$("$NODE" --input-type=module -e 'import net from "node:net"; const socket=net.createServer(); socket.on("error",()=>process.exit(1)); socket.listen(0,"127.0.0.1",()=>{console.log(socket.address().port);socket.close();});')" || exit 1
fi
mkdir -p "$DATA" || exit 1
chmod 700 "$DATA" 2>/dev/null || true
export PORT UNPROMPTED_DESKTOP_APP=1 UNPROMPTED_CONFIG_DIR="$DATA"
LOG="$DATA/server.log"
opened=0
server_pid=""
stop_server() { if [ -n "$server_pid" ]; then kill -TERM "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi; }
trap stop_server INT TERM
while true; do
  "$NODE" "$APP/server.js" >>"$LOG" 2>&1 &
  server_pid=$!
  if [ "$opened" -eq 0 ]; then
    attempts=0
    while [ "$attempts" -lt 100 ]; do
      if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
      health="$(/usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
      if "$NODE" -e 'try{const health=JSON.parse(process.argv[1]);process.exit(health.ok===true&&health.processId===Number(process.argv[2])?0:1);}catch{process.exit(1);}' "$health" "$server_pid"; then
        if [ "${'${UNPROMPTED_NO_OPEN:-0}'}" != 1 ]; then /usr/bin/open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true; fi
        opened=1
        break
      fi
      /bin/sleep 0.2
      attempts=$((attempts + 1))
    done
  fi
  wait "$server_pid"
  result=$?
  server_pid=""
  if [ "$result" -eq 75 ]; then continue; fi
  exit "$result"
done
`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Unprompted</string>
<key>CFBundleIdentifier</key><string>dev.unprompted.local</string>
<key>CFBundleName</key><string>Unprompted</string>
<key>CFBundleDisplayName</key><string>Unprompted</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>0.2.0</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  const nodeBinarySha256 = await sha256(nodePath);
  const verification = {
    runtime: 'Node.js',
    version: nodeVersion,
    architecture: arch,
    binaryArchitectures,
    archiveName,
    archiveUrl,
    checksumSource: checksumsUrl,
    archiveSha256: actualArchiveSha256,
    bundledBinarySha256: nodeBinarySha256,
    linkedLibraries: dependencies,
    linkedLibraryCheck: 'all linked libraries are in /System/Library or /usr/lib',
    packageLockIncluded: fs.existsSync(path.join(appRoot, 'package-lock.json')),
    piHarness,
    signature: 'The app bundle is unsigned and unpublished.'
  };
  fs.writeFileSync(path.join(resources, 'runtime', 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(`Built ${output}`);
  console.log(`Node ${nodeVersion} (${arch}); archive SHA-256 ${actualArchiveSha256}`);
  console.log('Bundled runtime links only to macOS system libraries. The app is unsigned and local.');
  console.log(piHarness.available ? 'Bundled Pi SDK imports passed with the packaged runtime.' : 'Pi SDK was not installed at build time; the manifest marks it unavailable.');
} catch (error) {
  fs.rmSync(output, { recursive: true, force: true });
  throw error;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
