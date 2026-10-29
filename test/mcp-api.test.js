import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './browser/fixture-server.mjs';

test('MCP API configures, redacts, restores on process restart and removes real stdio connections', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-mcp-api-'));
  let fixture;
  t.after(async () => { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  fixture = await startFixtureServer({ ruleDemo: false, directory });
  const post = (pathname, data, headers = {}) => fetch(fixture.base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  assert.deepEqual((await (await fetch(fixture.base + '/api/mcp')).json()).servers, []);
  const config = { mcpServers: { tools: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--stdio'], env: { MCP_FIXTURE_SECRET: 'api-mcp-private-value' } } } };
  assert.equal((await post('/api/mcp/import', { config }, { origin: 'https://outside.test' })).status, 403);
  const response = await post('/api/mcp/import', { config, allowDeclaredRead: true });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.mcp.servers[0].status, 'connected');
  assert.equal(status.mcp.servers[0].tools.filter(tool => tool.allowed).length, 3);
  assert.ok(!JSON.stringify(status).includes('api-mcp-private-value'));
  assert.equal((await post('/api/mcp/import', { config: '{bad' })).status, 400);
  assert.equal((await post('/api/mcp/servers/tools', { allowDeclaredRead: false, readTools: ['lookup'] })).status, 200);
  const file = path.join(directory, 'config', 'mcp.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await fixture.close();
  fixture = await startFixtureServer({ ruleDemo: false, directory });
  let restored;
  for (let attempt = 0; attempt < 50; attempt++) {
    restored = await (await fetch(fixture.base + '/api/mcp')).json();
    if (restored.servers[0]?.status === 'connected') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(restored.servers[0].status, 'connected');
  assert.deepEqual(restored.servers[0].tools.filter(tool => tool.allowed).map(tool => tool.name), ['lookup']);
  assert.ok(!JSON.stringify(await (await fetch(fixture.base + '/api/setup')).json()).includes('api-mcp-private-value'));
  assert.equal((await post('/api/mcp/servers/tools', { remove: true })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});
