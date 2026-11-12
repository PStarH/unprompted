#!/usr/bin/env node
// Check local distribution metadata without printing credentials or using accounts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientConfigurationStates } from '../src/connection-catalog.js';
import { readRegularFile } from '../src/local-files.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let googleFile = path.join(root, 'google-oauth-client.json'), connectorFile = path.join(root, 'connector-clients.json');
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--google-client' && args[index + 1]) googleFile = path.resolve(args[++index]);
  else if (args[index] === '--connector-clients' && args[index + 1]) connectorFile = path.resolve(args[++index]);
  else throw new Error('Usage: node scripts/check-connector-clients.mjs [--google-client PATH] [--connector-clients PATH]');
}
// A read failure is only "missing" when the file is absent; unreadable or
// unparseable metadata exists but is "invalid".
const readMetadata = filename => {
  try { return { state: 'present', value: JSON.parse(readRegularFile(filename, { maxBytes: 65536 })) }; }
  catch (error) { return { state: error?.code === 'ENOENT' ? 'missing' : 'invalid', value: undefined }; }
};
const googleClientState = value => {
  const client = value && typeof value === 'object' && !Array.isArray(value) ? value.installed : null;
  const valid = value && typeof value === 'object' && !Array.isArray(value) && !value.web
    && typeof client?.client_id === 'string' && Boolean(client.client_id.trim()) && client.client_id.length <= 512
    && typeof client?.client_secret === 'string' && Boolean(client.client_secret.trim()) && client.client_secret.length <= 1024
    && (!client.auth_uri || ['https://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/auth'].includes(client.auth_uri))
    && (!client.token_uri || client.token_uri === 'https://oauth2.googleapis.com/token');
  return valid ? 'configured' : 'invalid';
};
const googleMetadata = readMetadata(googleFile);
const googleState = googleMetadata.state === 'missing' ? 'missing'
  : googleMetadata.state === 'invalid' ? 'invalid' : googleClientState(googleMetadata.value);
const connectorMetadata = readMetadata(connectorFile);
const connectorStates = connectorMetadata.state === 'missing'
  ? clientConfigurationStates({})
  : clientConfigurationStates(connectorMetadata.value);
const results = [{ provider: 'google', clientState: googleState, clientConfigured: googleState === 'configured',
  verification: 'Not checked: confirm APIs, external consent and applicable verification in Google Cloud.' }];
for (const id of ['github', 'microsoft', 'slack', 'notion']) {
  const clientState = connectorStates[id];
  results.push({ provider: id, clientState, clientConfigured: clientState === 'configured',
    ...(id === 'notion' && clientState === 'configured' ? { confidentialExchange: false, note: 'Current native OAuth exchanges locally; the bundled secret is extractable.' } : {}) });
}
console.log(JSON.stringify({ clients: results, allClientMetadataPresent: results.every(item => item.clientConfigured), providerRegistrationVerified: false,
  personalTokensIncluded: false, note: 'This checks file shape only. It does not prove registered IDs, scopes, provider publication or real-account authorization.' }, null, 2));
if (!results.every(item => item.clientConfigured)) process.exitCode = 1;
