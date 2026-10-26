export const CONNECTION_PROVIDERS = Object.freeze({
  github: { id: 'github', name: 'GitHub', clientEnv: 'UNPROMPTED_GITHUB_CLIENT_ID',
    deviceUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token',
    identityUrl: 'https://api.github.com/user', scope: '',
    verificationHosts: ['github.com'], setupUrl: 'https://github.com/settings/apps',
    docsUrl: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow' },
  microsoft: { id: 'microsoft', name: 'Microsoft Outlook', clientEnv: 'UNPROMPTED_MICROSOFT_CLIENT_ID',
    deviceUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    identityUrl: 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
    scope: 'openid profile offline_access User.Read Mail.Read',
    verificationHosts: ['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'], setupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    docsUrl: 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code' }
});

export function connectionProvider(id) {
  const provider = CONNECTION_PROVIDERS[id];
  if (!provider) throw new Error('Unknown connection provider.');
  return provider;
}

export function validPublicClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{3,512}$/.test(value)
    && !/^(?:gh[opusr]_|github_pat_|sk-|ya29\.|eyJ)/i.test(value);
}

export function publicClientConfiguration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connector client configuration.');
  const result = {};
  for (const id of Object.keys(CONNECTION_PROVIDERS)) {
    const clientId = input[id]?.clientId;
    if (clientId == null) continue;
    if (!validPublicClientId(clientId)) throw new Error('Invalid connector application Client ID.');
    result[id] = { clientId };
  }
  return result;
}
