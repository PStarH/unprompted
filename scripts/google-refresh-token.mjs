#!/usr/bin/env node
// One-time OAuth bootstrap for the Google Workspace connector (M4).
//
// Usage:
//   node scripts/google-refresh-token.mjs ~/Downloads/client_secret_*.json
//   node scripts/google-refresh-token.mjs <json> --send     # adds gmail.send
//   node scripts/google-refresh-token.mjs <json> --print-url  # sanity check, no server
//
// Runs the installed-app (Desktop client) loopback flow on http://127.0.0.1,
// exchanges the authorization code, and prints the .env block. Never writes
// credentials to disk; the client secret stays in the JSON you point at.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const jsonPath = args.find(arg => !arg.startsWith('--'));

if (!jsonPath) {
  console.error('usage: node scripts/google-refresh-token.mjs <client_secret.json> [--write-env] [--send] [--print-url]');
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch (error) {
  console.error(`Could not read ${jsonPath}: ${error.message}`);
  process.exit(2);
}

const cfg = raw.installed;
if (!cfg) {
  console.error(raw.web
    ? 'This is a Web application client. The loopback flow here needs a Desktop (installed) client; create one in the same project.'
    : 'Not an OAuth client secret file (no "installed" section).');
  process.exit(2);
}
if (!cfg.client_id || !cfg.client_secret) {
  console.error('The JSON is missing client_id or client_secret.');
  process.exit(2);
}

const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly'
];
if (flags.has('--send')) scopes.push('https://www.googleapis.com/auth/gmail.send');

const authUri = cfg.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUri = cfg.token_uri || 'https://oauth2.googleapis.com/token';
const state = randomBytes(16).toString('hex');

function buildUrl(redirectUri) {
  const url = new URL(authUri);
  url.searchParams.set('client_id', cfg.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

if (flags.has('--print-url')) {
  console.log('OAuth client is usable. Authorization URL (port is chosen at run time):');
  console.log(buildUrl('http://127.0.0.1:PORT/'));
  console.log(`scopes: ${scopes.join(' ')}`);
  process.exit(0);
}

const respond = (res, status, title, body) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${title}</title><body style="font-family:system-ui;padding:3rem;max-width:40rem"><h2>${title}</h2><p>${body}</p></body>`);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') { respond(res, 404, 'Not found', ''); return; }
  if (url.searchParams.get('error')) {
    respond(res, 400, 'Authorization refused', 'Google reported an error. Check the terminal for details.');
    console.error(`Authorization error: ${url.searchParams.get('error')}`);
    server.close(() => process.exit(1));
    return;
  }
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    respond(res, 400, 'Bad callback', 'Missing code or state mismatch. Close this tab and re-run the script.');
    return;
  }
  try {
    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        redirect_uri: `http://127.0.0.1:${server.address().port}/`,
        grant_type: 'authorization_code'
      }).toString()
    });
    const token = await response.json();
    if (token.error || !token.refresh_token) {
      throw new Error(token.error_description || token.error || 'The response carried no refresh_token. Revoke the app at https://myaccount.google.com/permissions and re-run.');
    }
    let accountEmail = '';
    try {
      const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
      if (profile.ok) accountEmail = (await profile.json()).emailAddress || '';
    } catch { /* the email is a convenience; the refresh token is the deliverable */ }

    respond(res, 200, 'Authorization complete', 'You can close this tab and return to the terminal.');
    const pairs = [
      ['GOOGLE_CLIENT_ID', cfg.client_id],
      ['GOOGLE_CLIENT_SECRET', cfg.client_secret],
      ['GOOGLE_REFRESH_TOKEN', token.refresh_token],
      ...(accountEmail ? [['GOOGLE_ACCOUNT_EMAIL', accountEmail]] : [])
    ];
    if (flags.has('--write-env')) {
      writeEnv(pairs);
      console.log(`\nAuthorized${accountEmail ? ` as ${accountEmail}` : ''}. Wrote ${pairs.map(([key]) => key).join(', ')} to .env (mode 600; values not printed).`);
    } else {
      console.log('\nAuthorized' + (accountEmail ? ` as ${accountEmail}` : '') + '. Paste this into .env (never commit it):\n');
      for (const [key, value] of pairs) console.log(`${key}=${value}`);
    }
    console.log('Keep GOOGLE_SEND_ENABLED=false until read-only sync is verified.');
    console.log('Note: while the consent screen is in "Testing" status the refresh token expires after 7 days.');
    server.close(() => process.exit(0));
  } catch (error) {
    respond(res, 500, 'Token exchange failed', 'Check the terminal for details.');
    console.error(`Token exchange failed: ${error.message}`);
    server.close(() => process.exit(1));
  }
});

function writeEnv(pairs) {
  let lines;
  try {
    lines = readFileSync('.env', 'utf8').split('\n');
  } catch {
    lines = ['# Local credentials — gitignored. Created by scripts/google-refresh-token.mjs.'];
  }
  for (const [key, value] of pairs) {
    const index = lines.findIndex(line => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync('.env', lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  chmodSync('.env', 0o600);
}

server.listen(0, '127.0.0.1', () => {
  const url = buildUrl(`http://127.0.0.1:${server.address().port}/`);
  console.log(`Scopes: ${scopes.join(' ')}`);
  console.log(`If the browser does not open, visit:\n\n${url}\n`);
  console.log('Waiting for Google\'s callback on 127.0.0.1... (Ctrl-C to abort)');
  try {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const browser = spawn(command, [url], { stdio: 'ignore', detached: true });
    browser.on('error', () => { /* The printed URL supports manual authorization. */ });
    browser.unref();
  } catch { /* printed URL is enough */ }
});
