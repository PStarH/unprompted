import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicClientConfiguration } from '../src/connection-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-macos-app.mjs');
const DISTRIBUTION_CLIENTS = path.join(ROOT, 'scripts', 'distribution-clients.mjs');
// Loaded dynamically so the builder regression below still runs against the
// old builder, whose distribution metadata came straight from the parser.
const loadDistributionClients = () => import(pathToFileURL(DISTRIBUTION_CLIENTS).href);

const PREFLIGHT_CHILD = `import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [builderPath, connectorFile, outputPath, networkMarker] = process.argv.slice(2);
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
if (process.arch !== 'arm64' && process.arch !== 'x64') {
  fs.writeSync(2, 'unsupported architecture for the builder preflight test: ' + process.arch + '\\n');
  process.exit(70);
}
process.argv = ['node', builderPath, '--connector-clients', connectorFile, '--out', outputPath];
globalThis.fetch = () => {
  fs.writeFileSync(networkMarker, 'network attempted\\n');
  throw new Error('Network access is disabled in the builder preflight test.');
};
try {
  await import(pathToFileURL(builderPath).href);
  fs.writeSync(2, 'the builder did not reject the Notion confidential client\\n');
  process.exit(71);
} catch (error) {
  fs.writeSync(2, 'builder-error-code=' + (error?.code ?? 'none') + '\\n');
  fs.writeSync(2, String(error?.message ?? error) + '\\n');
  process.exit(error?.code === 'ERR_NOTION_CONFIDENTIAL_CLIENT' ? 0 : 72);
}
`;

const fakeSecret = parts => ['fake', ...parts, 'secret'].join('-');

test('distribution metadata rejects a Notion confidential client without echoing credentials', async () => {
  const { distributionClientConfiguration } = await loadDistributionClients();
  const notionSecret = fakeSecret(['notion', 'confidential', 'client']);
  const input = {
    notion: {
      clientId: 'fake-notion-confidential-client',
      clientSecret: notionSecret,
      accessToken: 'FAKE-NOTION-ACCESS-TOKEN',
      refreshToken: 'FAKE-NOTION-REFRESH-TOKEN'
    }
  };
  const before = structuredClone(input);
  let firstError;
  assert.throws(() => distributionClientConfiguration(input), error => {
    firstError = error;
    assert.equal(error.code, 'ERR_NOTION_CONFIDENTIAL_CLIENT');
    assert.match(error.message, /Notion confidential OAuth clients cannot be distributed/);
    assert.match(error.message, /local runtime configuration/);
    assert.equal(error.message.includes(notionSecret), false);
    assert.equal(error.message.includes('FAKE-NOTION-ACCESS-TOKEN'), false);
    assert.equal(error.message.includes('FAKE-NOTION-REFRESH-TOKEN'), false);
    return true;
  });
  const otherSecret = fakeSecret(['other', 'notion']);
  let secondError;
  assert.throws(() => distributionClientConfiguration({ notion: { clientId: 'other-fake-notion-client', clientSecret: otherSecret } }), error => {
    secondError = error;
    return true;
  });
  assert.equal(secondError.code, firstError.code);
  assert.equal(secondError.message, firstError.message);
  assert.equal(secondError.message.includes(otherSecret), false);
  assert.deepEqual(input, before);
});

test('distribution metadata strips optional Slack and device secrets while keeping public fields', async () => {
  const { distributionClientConfiguration } = await loadDistributionClients();
  const input = {
    github: { clientId: 'fake-github-client', clientSecret: 'FAKE-GITHUB-SECRET', accessToken: 'FAKE-GITHUB-ACCESS-TOKEN' },
    microsoft: { clientId: 'fake-microsoft-client', clientSecret: 'FAKE-MICROSOFT-SECRET' },
    slack: {
      clientId: '12345.67890',
      clientSecret: 'FAKE-SLACK-SECRET',
      redirectUri: 'https://oauth.example.test/slack/callback',
      accessToken: 'FAKE-SLACK-ACCESS-TOKEN'
    }
  };
  const before = structuredClone(input);
  const result = distributionClientConfiguration(input);
  assert.deepEqual(result, {
    github: { clientId: 'fake-github-client' },
    microsoft: { clientId: 'fake-microsoft-client' },
    slack: { clientId: '12345.67890', redirectUri: 'https://oauth.example.test/slack/callback' }
  });
  assert.deepEqual(input, before);
  assert.notEqual(result.slack, input.slack);
  result.slack.clientId = 'mutated-after-return';
  assert.equal(input.slack.clientId, '12345.67890');
  assert.doesNotMatch(JSON.stringify(result), /FAKE-(?:SLACK|GITHUB|MICROSOFT)/);
});

test('the owner-private connector parser still retains Notion credentials for local runtime use', () => {
  const input = { notion: { clientId: 'fake-owner-private-notion-client', clientSecret: 'FAKE-OWNER-PRIVATE-NOTION-SECRET' } };
  assert.deepEqual(publicClientConfiguration(input), input);
  assert.equal(publicClientConfiguration(input).notion.clientSecret, 'FAKE-OWNER-PRIVATE-NOTION-SECRET');
});

test('the macOS builder rejects a Notion confidential client before any network or output work', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-distribution-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secret = fakeSecret(['builder', 'preflight']);
  const connectorFile = path.join(directory, 'connector-clients.json');
  fs.writeFileSync(connectorFile, `${JSON.stringify({ notion: { clientId: 'fake-notion-preflight-client', clientSecret: secret } })}\n`, { mode: 0o600 });
  const output = path.join(directory, 'Unprompted-preflight.app');
  const networkMarker = path.join(directory, 'network-attempt.txt');
  const child = path.join(directory, 'builder-preflight-child.mjs');
  fs.writeFileSync(child, PREFLIGHT_CHILD, { mode: 0o600 });
  const result = spawnSync(process.execPath, [child, BUILDER, connectorFile, output, networkMarker], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TMPDIR: directory }
  });
  const combined = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, combined);
  assert.match(combined, /ERR_NOTION_CONFIDENTIAL_CLIENT/);
  assert.match(combined, /Notion confidential OAuth clients cannot be distributed/);
  assert.equal(fs.existsSync(networkMarker), false, 'the builder attempted network access');
  assert.equal(fs.existsSync(output), false, 'the builder created the output bundle');
  assert.equal(combined.includes(secret), false, 'the builder echoed the fake secret');
});
