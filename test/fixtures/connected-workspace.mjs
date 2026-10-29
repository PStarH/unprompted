import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../browser/fixture-server.mjs';

export async function startConnectedFixture() {
  const controls = { githubAuthorized: false, microsoftAuthorized: false, githubClosed: false, microsoftAccount: 'ms-a', microsoftDrafts: false };
  const calls = [], at = '2026-10-26T09:00:00.000Z';
  const service = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({ path: url.pathname, method: req.method });
    const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname.startsWith('/grant/')) {
      controls[url.pathname.endsWith('/github') ? 'githubAuthorized' : 'microsoftAuthorized'] = true;
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Scripted authorization complete. Return to the app.</p>'); return;
    }
    if (url.pathname === '/google/github.com/login/device/code') return json({ device_code: 'PRIVATE_GITHUB_DEVICE', user_code: 'CODE-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (url.pathname === '/google/login.microsoftonline.com/common/oauth2/v2.0/devicecode') {
      controls.microsoftDrafts = String(new URLSearchParams(raw).get('scope')).split(/\s+/).includes('Mail.ReadWrite');
      return json({ device_code: 'PRIVATE_MS_DEVICE', user_code: 'CODE1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    }
    if (url.pathname === '/google/github.com/login/oauth/access_token') return json(controls.githubAuthorized
      ? { access_token: 'PRIVATE_GITHUB_ACCESS' } : { error: 'authorization_pending' });
    if (url.pathname === '/google/login.microsoftonline.com/common/oauth2/v2.0/token') return json(controls.microsoftAuthorized
      ? { access_token: `PRIVATE_MS_ACCESS_${controls.microsoftAccount}`, refresh_token: 'PRIVATE_MS_REFRESH', expires_in: 3600, scope: `User.Read Mail.Read offline_access${controls.microsoftDrafts ? ' Mail.ReadWrite' : ''}` } : { error: 'authorization_pending' }, controls.microsoftAuthorized ? 200 : 400);
    if (url.pathname === '/google/api.github.com/user') return json({ id: 123, login: 'reader' });
    const issue = { id: 15, number: 7, title: 'Investigate webhook retry behavior', body: 'This issue is assigned to reader. Inspect the retry policy.',
      user: { login: 'teammate' }, assignees: [{ id: 123, login: 'reader' }], state: controls.githubClosed ? 'closed' : 'open',
      updated_at: controls.githubClosed ? '2026-10-26T10:00:00.000Z' : at, repository: { full_name: 'team/project' } };
    if (url.pathname === '/google/api.github.com/issues' || url.pathname === '/google/api.github.com/repos/team/project/issues/7') return json(url.pathname.endsWith('/7') ? issue : [issue]);
    if (url.pathname === '/google/api.github.com/search/issues') return json({ items: [] });
    if (url.pathname === '/google/api.github.com/user/repos') return json([]);
    const account = req.headers.authorization?.endsWith('ms-b') ? 'ms-b' : 'ms-a';
    if (url.pathname === '/google/graph.microsoft.com/v1.0/me') return json({ id: account, mail: `${account}@example.test`, displayName: account });
    if (url.pathname === '/google/graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta') return json({
      value: url.searchParams.has('$deltatoken') ? [] : [{ id: 'message-1', conversationId: 'thread-1', subject: 'Cedar proposal',
        from: { emailAddress: { address: 'alex@example.test' } }, receivedDateTime: at, webLink: 'https://outlook.office.com/mail/inbox/id/message-1',
        body: { contentType: 'text', content: 'Please update the Cedar proposal to include sample size and conclusion and send it back.' } }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=checkpoint' });
    if (url.pathname === '/model/v1/chat/completions') {
      JSON.parse(raw);
      return json({ choices: [{ message: { content: JSON.stringify({ subjectEntity: 'Cedar', deliverable: 'proposal', intent: 'update_and_send', requiredContent: [
        { text: 'sample size', sourceQuote: 'sample size', sourceField: 'body' }, { text: 'conclusion', sourceQuote: 'conclusion', sourceField: 'body' }
      ] }) } }] });
    }
    return json({ error: 'Unscripted fixture endpoint' }, 404);
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${service.address().port}`;
  let fixture;
  try { fixture = await startFixtureServer({ ruleDemo: false, nodeArgs: ['--import', fileURLToPath(new URL('./google-fetch.mjs', import.meta.url))], serverEnv: {
    UNPROMPTED_TEST_GOOGLE_ENDPOINT: endpoint, UNPROMPTED_GITHUB_CLIENT_ID: 'registered-github-app', UNPROMPTED_MICROSOFT_CLIENT_ID: 'registered-ms-app'
  } }); }
  catch (error) { await new Promise(resolve => service.close(resolve)); throw error; }
  return { ...fixture, endpoint, controls, calls,
    close: async () => { await fixture.close(); await new Promise(resolve => service.close(resolve)); } };
}
