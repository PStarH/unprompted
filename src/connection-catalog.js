export const OAUTH_LOOPBACK_HOST = '127.0.0.1';
export const OAUTH_REDIRECT_HOST = 'localhost';
export const OAUTH_LOOPBACK_PORT = 53682;

export const CONNECTION_PROVIDERS = Object.freeze({
  todoist: { id: 'todoist', name: 'Todoist', flow: 'token', setupUrl: 'https://app.todoist.com/app/settings/integrations/developer' },
  github: { id: 'github', name: 'GitHub', flow: 'device', clientEnv: 'UNPROMPTED_GITHUB_CLIENT_ID',
    deviceUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token',
    identityUrl: 'https://api.github.com/user', scope: '',
    verificationHosts: ['github.com'], setupUrl: 'https://github.com/settings/apps',
    docsUrl: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow' },
  microsoft: { id: 'microsoft', name: 'Microsoft Outlook', flow: 'device', clientEnv: 'UNPROMPTED_MICROSOFT_CLIENT_ID',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    deviceUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    identityUrl: 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
    scope: 'openid profile offline_access User.Read Mail.Read',
    verificationHosts: ['microsoft.com', 'www.microsoft.com', 'login.microsoft.com', 'login.microsoftonline.com'], setupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    docsUrl: 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code' },
  slack: { id: 'slack', name: 'Slack', flow: 'code', clientEnv: 'UNPROMPTED_SLACK_CLIENT_ID', secretEnv: 'UNPROMPTED_SLACK_CLIENT_SECRET',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access',
    identityUrl: 'https://slack.com/api/auth.test', apiOrigin: 'https://slack.com',
    userScope: 'im:read,im:history,mpim:read,mpim:history,users:read,channels:read,channels:history,groups:read,groups:history',
    verificationHosts: ['slack.com'], setupUrl: 'https://api.slack.com/apps',
    docsUrl: 'https://api.slack.com/authentication/oauth-v2' },
  notion: { id: 'notion', name: 'Notion', flow: 'code', clientEnv: 'UNPROMPTED_NOTION_CLIENT_ID', secretEnv: 'UNPROMPTED_NOTION_CLIENT_SECRET',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize', tokenUrl: 'https://api.notion.com/v1/oauth/token',
    apiOrigin: 'https://api.notion.com',
    verificationHosts: ['api.notion.com', 'www.notion.so', 'notion.so'], setupUrl: 'https://www.notion.so/my-integrations',
    docsUrl: 'https://developers.notion.com/docs/authorization' }
});

export function connectionProvider(id) {
  const provider = CONNECTION_PROVIDERS[id];
  if (!provider) throw new Error('Unknown connection provider.');
  return provider;
}

export function oauthRedirectUri(id, port = OAUTH_LOOPBACK_PORT) {
  const provider = connectionProvider(id);
  if (provider.flow !== 'code' && id !== 'microsoft') throw new Error('This provider does not use a loopback redirect.');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('The local authorization port is invalid.');
  return `http://${OAUTH_REDIRECT_HOST}:${port}/oauth/${id}`;
}

/** A distribution may use an HTTPS relay for Slack's public distribution.
 * The relay must be controlled by the publisher and forward only to the
 * fixed local callback. Existing installations retain the loopback default. */
export function validSlackRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost') && !url.port;
  } catch { return false; }
}

export function validPublicClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{3,512}$/.test(value)
    && !/^(?:gh[opusr]_|github_pat_|sk-|ya29\.|eyJ)/i.test(value);
}

/** Application secret for a code-flow client. User tokens and pasted PATs are rejected. */
export function validClientSecret(value) {
  return typeof value === 'string' && /^[!-~]{8,512}$/.test(value)
    && !/^(?:xox[abprs]-|ntn_|gh[opusr]_|github_pat_|ya29\.|eyJ)/i.test(value);
}

export function publicClientConfiguration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connector client configuration.');
  const result = {};
  for (const id of Object.keys(CONNECTION_PROVIDERS)) {
    if (CONNECTION_PROVIDERS[id].flow === 'token') continue;
    const entry = input[id];
    if (entry == null) continue;
    if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid connector client configuration.');
    const clientId = entry.clientId;
    if (clientId == null && entry.clientSecret == null) continue;
    if (!validPublicClientId(clientId)) throw new Error('Invalid connector application Client ID.');
    if (CONNECTION_PROVIDERS[id].flow === 'code') {
      if ((id !== 'slack' || entry.clientSecret != null) && !validClientSecret(entry.clientSecret)) throw new Error('Invalid connector application Client Secret.');
      if (id === 'slack' && entry.redirectUri != null && !validSlackRedirectUri(entry.redirectUri)) throw new Error('Slack public redirect URI must be a valid HTTPS URL.');
      result[id] = { clientId, ...(entry.clientSecret ? { clientSecret: entry.clientSecret } : {}),
        ...(id === 'slack' && entry.redirectUri ? { redirectUri: entry.redirectUri } : {}) };
    } else result[id] = { clientId };
  }
  return result;
}
