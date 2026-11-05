#!/usr/bin/env node
// Check local distribution metadata without printing credentials or using accounts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicClientConfiguration } from '../src/connection-catalog.js';
import { readRegularFile } from '../src/local-files.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let googleFile = path.join(root, 'google-oauth-client.json'), connectorFile = path.join(root, 'connector-clients.json');
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--google-client' && args[index + 1]) googleFile = path.resolve(args[++index]);
  else if (args[index] === '--connector-clients' && args[index + 1]) connectorFile = path.resolve(args[++index]);
  else throw new Error('Usage: node scripts/check-connector-clients.mjs [--google-client PATH] [--connector-clients PATH]');
}
const results = [];
try {
  const data = JSON.parse(readRegularFile(googleFile, { maxBytes: 65536 })), client = data.installed;
  const valid = !data.web && typeof client?.client_id === 'string' && client.client_id.trim() && typeof client?.client_secret === 'string' && client.client_secret.trim()
    && (!client.auth_uri || ['https://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/auth'].includes(client.auth_uri))
    && (!client.token_uri || client.token_uri === 'https://oauth2.googleapis.com/token');
  results.push({ provider: 'google', clientConfigured: Boolean(valid), verification: 'Not checked: confirm APIs, external consent and applicable verification in Google Cloud.' });
} catch { results.push({ provider: 'google', clientConfigured: false }); }
let clients = {};
try { clients = publicClientConfiguration(JSON.parse(readRegularFile(connectorFile, { maxBytes: 65536 }))); }
catch { /* Missing or invalid metadata is reported without exposing its values. */ }
for (const id of ['github', 'microsoft', 'slack', 'notion']) results.push({ provider: id, clientConfigured: Boolean(clients[id]?.clientId),
  ...(id === 'notion' && clients[id] ? { confidentialExchange: false, note: 'Current native OAuth exchanges locally; the bundled secret is extractable.' } : {}) });
console.log(JSON.stringify({ clients: results, allClientMetadataPresent: results.every(item => item.clientConfigured), providerRegistrationVerified: false,
  personalTokensIncluded: false, note: 'This checks file shape only. It does not prove registered IDs, scopes, provider publication or real-account authorization.' }, null, 2));
if (!results.every(item => item.clientConfigured)) process.exitCode = 1;
