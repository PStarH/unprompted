import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../browser/fixture-server.mjs';

export async function startGoogleFixture({ provisioned = true, directory = null, root = null } = {}) {
  const controls = { apiDisabled: false, rejectTask: false, rejectModel: false, empty: false, identityVerified: true, searchPaged: false };
  const calls = [];
  const requests = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.local');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      calls.push({ path: url.pathname, method: req.method });
      const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      const account = req.headers.authorization?.includes('reader-b') ? 'reader-b' : 'reader-a';
      if (url.pathname === '/google/oauth2.googleapis.com/token') {
        const fields = new URLSearchParams(body);
        const id = fields.get('code') === 'reader-b' || fields.get('refresh_token') === 'PRIVATE_REFRESH_reader-b' ? 'reader-b' : 'reader-a';
        return json({ access_token: `PRIVATE_ACCESS_${id}`, refresh_token: `PRIVATE_REFRESH_${id}`, expires_in: 3600,
          scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/documents' });
      }
      if (url.pathname === '/google/openidconnect.googleapis.com/v1/userinfo') return json({ sub: account, email: `${account}@example.test`, email_verified: controls.identityVerified });
      if (url.pathname === '/model/v1/chat/completions') {
        if (controls.rejectModel) return json({ error: 'scripted auth refusal' }, 401);
        const request = JSON.parse(body);
        const content = request.messages.at(-1).content;
        if (controls.rejectTask && !content.includes('connection-check')) return json({ error: 'scripted model unavailable' }, 503);
        return json({ choices: [{ message: { content: JSON.stringify({ subjectEntity: 'Cedar', deliverable: 'proposal', intent: 'update_and_send', requiredContent: [
          { text: 'sample size', sourceQuote: 'sample size', sourceField: 'body' }, { text: 'conclusion', sourceQuote: 'conclusion', sourceField: 'body' }
        ] }) } }] });
      }
      if (controls.apiDisabled && url.pathname.includes('/gmail/')) return json({ error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, 403);
      if (url.pathname.endsWith('/gmail/v1/users/me/profile')) return json({ historyId: '100', emailAddress: `${account}@example.test` });
      if (url.pathname.endsWith('/gmail/v1/users/me/history')) return json({ historyId: '100', history: [] });
      if (url.pathname.endsWith('/gmail/v1/users/me/messages')) {
        if (controls.searchPaged && url.searchParams.get('q') === 'Cedar') return json(url.searchParams.get('pageToken') === 'next'
          ? { messages: [{ id: `mail-${account}-2` }] } : { messages: [{ id: `mail-${account}` }], nextPageToken: 'next' });
        return json({ messages: controls.empty ? [] : [{ id: `mail-${account}` }] });
      }
      if (url.pathname.includes('/gmail/v1/users/me/messages/')) return json({ id: decodeURIComponent(url.pathname.split('/').at(-1)), threadId: `thread-${account}`, payload: {
        mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alex <alex@example.test>' }, { name: 'To', value: `${account}@example.test` },
          { name: 'Subject', value: 'Cedar proposal' }, { name: 'Date', value: new Date().toUTCString() }],
        body: { data: Buffer.from('Please update the Cedar proposal to include sample size and conclusion and send it back.').toString('base64url') }
      } });
      if (url.pathname.endsWith('/drive/v3/changes/startPageToken')) return json({ startPageToken: 'baseline' });
      if (url.pathname.endsWith('/drive/v3/changes')) return json({ newStartPageToken: 'baseline', changes: [] });
      if (url.pathname.endsWith('/drive/v3/files')) return json({ files: controls.empty || url.searchParams.get('q')?.includes('modifiedTime >') ? [] : [{
        id: `doc-${account}`, name: 'Cedar proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: new Date().toISOString(), version: '1'
      }] });
      if (url.pathname.endsWith('/export')) {
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Cedar proposal\nSample size: 1200\nConclusion: Proceed with the rollout.'); return;
      }
      return json({ error: 'Unscripted fixture request' }, 404);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => requests.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${requests.address().port}`;
  let fixture;
  try {
    fixture = await startFixtureServer({ ruleDemo: false, directory, root,
      nodeArgs: ['--import', fileURLToPath(new URL('./google-fetch.mjs', import.meta.url))],
      serverEnv: { UNPROMPTED_TEST_GOOGLE_ENDPOINT: endpoint, GOOGLE_MAX_RETRIES: '0',
        ...(provisioned ? { UNPROMPTED_GOOGLE_DESKTOP_CLIENT_ID: 'fixture.apps.googleusercontent.com', UNPROMPTED_GOOGLE_DESKTOP_CLIENT_SECRET: 'PRIVATE_DESKTOP_CLIENT' } : {}) }
    });
  } catch (error) { await new Promise(resolve => requests.close(resolve)); throw error; }
  return { ...fixture, endpoint, calls, controls,
    close: async () => { await fixture.close(); await new Promise(resolve => requests.close(resolve)); } };
}

export async function connectGoogle(base, { account = 'reader-a', observe = false, scopes = null, allowExternalWrites = false } = {}) {
  const response = await fetch(`${base}/api/setup/google/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scopes: scopes || { readGmail: true, readDrive: true }, observe, allowExternalWrites }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  const url = new URL(result.authorizeUrl);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', account);
  return fetch(callback);
}

export async function waitFor(read, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for the expected workspace state.');
}
