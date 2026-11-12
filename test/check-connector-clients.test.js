import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-connector-clients.mjs', import.meta.url));
const googleClient = JSON.stringify({ installed: {
  client_id: 'google-client-id.apps.googleusercontent.com',
  client_secret: 'google-client-secret',
  auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_uri: 'https://oauth2.googleapis.com/token'
} });
const connectorClients = JSON.stringify({
  github: { clientId: 'github-client-id' },
  microsoft: { clientId: 'microsoft-client-id' },
  slack: { clientId: 'slack-client-id' },
  notion: { clientId: 'notion-client-id', clientSecret: 'notion-client-secret' }
});

function check(t, { google, connector } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-connector-clients-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const googleFile = path.join(directory, 'google-oauth-client.json');
  const connectorFile = path.join(directory, 'connector-clients.json');
  if (google !== undefined) fs.writeFileSync(googleFile, google);
  if (connector !== undefined) fs.writeFileSync(connectorFile, connector);
  const child = spawnSync(process.execPath, [script, '--google-client', googleFile, '--connector-clients', connectorFile], { encoding: 'utf8' });
  return { status: child.status, stderr: child.stderr, output: child.stdout, report: JSON.parse(child.stdout) };
}

const states = report => Object.fromEntries(report.clients.map(item => [item.provider, item.clientState]));
const googleClientWith = (clientIdLength, clientSecretLength) => JSON.stringify({ installed: {
  client_id: 'a'.repeat(clientIdLength),
  client_secret: 's'.repeat(clientSecretLength),
  auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_uri: 'https://oauth2.googleapis.com/token'
} });

test('connector client check reports every provider as configured and keeps exit 0', t => {
  const { status, output, report } = check(t, { google: googleClient, connector: connectorClients });
  assert.equal(status, 0);
  assert.equal(report.allClientMetadataPresent, true);
  assert.deepEqual(states(report), { google: 'configured', github: 'configured', microsoft: 'configured', slack: 'configured', notion: 'configured' });
  for (const item of report.clients) assert.equal(item.clientConfigured, item.clientState === 'configured');
  assert.equal(report.clients.find(item => item.provider === 'notion').confidentialExchange, false);
  for (const value of ['google-client-id', 'google-client-secret', 'github-client-id', 'microsoft-client-id', 'slack-client-id', 'notion-client-id', 'notion-client-secret']) {
    assert.equal(output.includes(value), false, `output must not contain ${value}`);
  }
});

test('connector client check distinguishes absent files as missing with exit 1', t => {
  const { status, report } = check(t);
  assert.equal(status, 1);
  assert.equal(report.allClientMetadataPresent, false);
  assert.deepEqual(states(report), { google: 'missing', github: 'missing', microsoft: 'missing', slack: 'missing', notion: 'missing' });
  for (const item of report.clients) assert.equal(item.clientConfigured, false);
});

test('connector client check reports unparseable files as invalid, not missing', t => {
  const { status, report } = check(t, { google: 'not json', connector: 'not json' });
  assert.equal(status, 1);
  assert.deepEqual(states(report), { google: 'invalid', github: 'invalid', microsoft: 'invalid', slack: 'invalid', notion: 'invalid' });
});

test('connector client check classifies each provider entry independently without leaking values', t => {
  const secret = ['xoxb', 'definitely-not-a-real-token'].join('-');
  const connector = JSON.stringify({
    github: { clientId: 'github-client-id' },
    microsoft: null,
    slack: { clientId: 'slack-client-id', clientSecret: secret },
    notion: {}
  });
  const { status, output, report } = check(t, { google: JSON.stringify({ installed: {} }), connector });
  assert.equal(status, 1);
  assert.deepEqual(states(report), { google: 'invalid', github: 'configured', microsoft: 'missing', slack: 'invalid', notion: 'invalid' });
  assert.equal(report.clients.find(item => item.provider === 'github').clientConfigured, true);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('github-client-id'), false);
});

test('connector client check treats a non-object top-level connector file as invalid for every provider', t => {
  const { status, report } = check(t, { google: googleClient, connector: '[]' });
  assert.equal(status, 1);
  assert.deepEqual(states(report), { google: 'configured', github: 'invalid', microsoft: 'invalid', slack: 'invalid', notion: 'invalid' });
});

test('Google client length boundaries match the desktop client consumer', async t => {
  for (const { field, length, clientState } of [
    { field: 'client_id', length: 512, clientState: 'configured' },
    { field: 'client_id', length: 513, clientState: 'invalid' },
    { field: 'client_secret', length: 1024, clientState: 'configured' },
    { field: 'client_secret', length: 1025, clientState: 'invalid' }
  ]) {
    await t.test(`${field} length ${length} is ${clientState}`, subtest => {
      const clientIdLength = field === 'client_id' ? length : 24, clientSecretLength = field === 'client_secret' ? length : 24;
      const clientId = 'a'.repeat(clientIdLength), clientSecret = 's'.repeat(clientSecretLength);
      const { status, output, report } = check(subtest, { google: googleClientWith(clientIdLength, clientSecretLength), connector: connectorClients });
      const google = report.clients.find(item => item.provider === 'google');
      assert.equal(status, clientState === 'configured' ? 0 : 1);
      assert.equal(google.clientState, clientState);
      assert.equal(google.clientConfigured, clientState === 'configured');
      assert.equal(report.allClientMetadataPresent, clientState === 'configured');
      assert.deepEqual(Object.fromEntries(report.clients.filter(item => item.provider !== 'google').map(item => [item.provider, item.clientState])),
        { github: 'configured', microsoft: 'configured', slack: 'configured', notion: 'configured' });
      assert.equal(output.includes(clientId), false, 'output must not contain the client_id value');
      assert.equal(output.includes(clientSecret), false, 'output must not contain the client_secret value');
    });
  }
});
