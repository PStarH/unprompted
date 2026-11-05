/** Bounded read tools for API-key presets, using the bundled Node runtime. */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { providerJSON } from './connectors/http.js';
const tools = {
  'brave-search': { name: 'brave_web_search', description: 'Search the web with Brave Search. Uses the connected API key and its usage quota.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 600 }, count: { type: 'integer', minimum: 1, maximum: 10, default: 5 } }, required: ['query'], additionalProperties: false } },
  firecrawl: { name: 'firecrawl_scrape', description: 'Read a public webpage as Markdown using Firecrawl. Uses the connected API key and its usage quota.', inputSchema: { type: 'object', properties: { url: { type: 'string', maxLength: 4096 } }, required: ['url'], additionalProperties: false } }
};
export async function keyRpc(provider, request, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const tool = tools[provider];
  if (!tool) throw new Error('Unknown provider.');
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `unprompted-${provider}`, version: '1.0.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools: [{ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }] };
  if (request.method === 'resources/list') return { resources: [] };
  if (request.method !== 'tools/call' || request.params?.name !== tool.name) throw new Error('Unknown method or tool.');
  const args = request.params.arguments || {};
  try {
    let text;
    if (provider === 'brave-search') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 600 || !Number.isInteger(args.count ?? 5) || (args.count ?? 5) < 1 || (args.count ?? 5) > 10) throw new Error('Invalid search arguments.');
      if (!env.BRAVE_API_KEY) throw new Error('Set your Brave Search API key.');
      const origin = 'https://api.search.brave.com';
      const data = await providerJSON(`${origin}/res/v1/web/search?${new URLSearchParams({ q: args.query, count: String(args.count || 5) })}`, { provider, origin, fetchImpl, headers: { 'X-Subscription-Token': env.BRAVE_API_KEY }, timeoutMs: 12000, maxChars: 500000 });
      if (data?.web?.results != null && !Array.isArray(data.web.results)) throw new Error('Search returned an invalid result.');
      text = (data.web?.results || []).slice(0, args.count || 5).map(item => `${item.title || ''}\n${item.url || ''}\n${item.description || ''}`).join('\n\n');
    } else {
      if (typeof args.url !== 'string' || args.url.length > 4096) throw new Error('Enter a public webpage URL.');
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter a public webpage URL.');
      if (!env.FIRECRAWL_API_KEY) throw new Error('Set your Firecrawl API key.');
      const origin = 'https://api.firecrawl.dev';
      const data = await providerJSON(`${origin}/v2/scrape`, { provider, origin, fetchImpl, method: 'POST', headers: { authorization: `Bearer ${env.FIRECRAWL_API_KEY}` }, body: { url: url.href, formats: ['markdown'], onlyMainContent: true, timeout: 10000 }, timeoutMs: 12000, maxChars: 1000000 });
      if (data?.success !== true || typeof data.data?.markdown !== 'string') throw new Error('Firecrawl did not return page text.');
      text = data.data.markdown;
    }
    return { content: [{ type: 'text', text: text.slice(0, 20000) || 'No matching content.' }] };
  } catch { return { isError: true, content: [{ type: 'text', text: 'The provider could not complete this read. Check the API key, quota, URL or query and retry.' }] }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (line.length > 64 * 1024) return;
    let request; try { request = JSON.parse(line); } catch { return; }
    if (request.id == null) return;
    void keyRpc(process.argv[2], request).then(result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'), () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid request.' } }) + '\n'));
  });
}
