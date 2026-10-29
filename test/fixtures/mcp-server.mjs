import readline from 'node:readline';

export const fixtureTools = [
  { name: 'lookup', description: 'Read work context', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'slow', description: 'A slow read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'A failed read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'write_item', description: 'Modify external work', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'unannotated', description: 'Read legacy context', inputSchema: { type: 'object', properties: {} } }
];

export async function reply(message) {
  if (message.method === 'initialize') return { protocolVersion: message.params.protocolVersion, capabilities: process.env.MCP_RESOURCES_ONLY ? { resources: {} } : { tools: {} }, serverInfo: { name: 'local-fixture', version: '1.0.0' } };
  if (message.method === 'resources/list') return { resources: [{ uri: 'fixture://private/context', name: 'Project context', description: 'Project notes' }] };
  if (message.method === 'resources/read') return { contents: [{ uri: message.params.uri, mimeType: 'text/plain', text: `Resource context ${process.env.MCP_FIXTURE_SECRET || ''}` }] };
  if (message.method === 'tools/list') return { tools: fixtureTools };
  if (message.method === 'tools/call') {
    if (message.params.name === 'slow') await new Promise(resolve => setTimeout(resolve, 700));
    if (message.params.name === 'fail') return { isError: true, content: [{ type: 'text', text: 'private remote error' }] };
    return { content: [{ type: 'text', text: `Found context: ${message.params.arguments?.query || message.params.name} ${process.env.MCP_FIXTURE_SECRET || ''}` }] };
  }
  if (message.method === 'ping') return {};
  return undefined;
}

if (process.argv.includes('--stdio')) {
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', async line => {
    const message = JSON.parse(line);
    const result = await reply(message);
    if (message.id != null && result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  });
}
