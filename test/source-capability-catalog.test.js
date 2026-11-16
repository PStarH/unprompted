import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpManager, McpConfigStore } from '../src/mcp.js';
import { fitToolCatalog, TOOL_CATALOG_MAX_CHARS } from '../src/tool-catalog.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const planInput = { request: { text: 'Draco report with budget breakdown', subjectEntity: 'Draco', deliverable: 'report', qualifiers: [] }, uncovered: ['budget breakdown'], providers: ['document_text'], strategies: ['section_body'] };
const values = width => Array.from({ length: 300 }, (_, index) => `${index}-${'x'.repeat(width)}`);
// 10.5k schema after description compaction: over the catalog and finder budgets.
const catalogEnum = values(30);
// 5.1k schemas: two of them exceed the catalog budget while each finder item
// stays inside the classic tool loop's 6k tool-result window.
const loopEnum = values(10);
// 20.7k schema: cannot be returned inside the 6k finder payload.
const oversizedEnum = values(60);

function smallTool(name) {
  return { name, description: `Read ${name}`, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } };
}
function hugeTool(enumValues, name = 'search_records') {
  return { name, description: `Search ${name}`, inputSchema: { type: 'object', properties: { query: { type: 'string', enum: enumValues, description: 'q'.repeat(600) } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } };
}
function schemaIssues(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [{ message: 'object required' }];
  for (const key of schema.required || []) if (!(key in args)) return [{ message: `missing ${key}` }];
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if (args[key] === undefined) continue;
    if (Array.isArray(rule.enum) && !rule.enum.includes(args[key])) return [{ message: `${key} is not allowed` }];
    if (rule.type === 'string' && typeof args[key] !== 'string') return [{ message: `${key} must be a string` }];
  }
  if (schema.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(schema.properties || {}, key))) return [{ message: 'additional properties are not allowed' }];
  return null;
}

function fakeSdk({ toolsFor }) {
  const validated = [], calls = [];
  const sdk = {
    fromJsonSchema(schema) {
      return { '~standard': { validate: async args => {
        validated.push({ schema, args });
        const issues = schemaIssues(schema, args);
        return issues ? { issues } : { value: args };
      } } };
    },
    getDefaultEnvironment: () => ({}),
    Client: class {
      async connect(transport) { this.transport = transport; }
      getServerCapabilities() { return { tools: {} }; }
      getServerInfo() { return { name: 'source-capability-fixture', version: '1' }; }
      async listTools() { return { tools: toolsFor(this.transport) }; }
      async callTool(params) {
        calls.push(params);
        return { content: [{ type: 'text', text: `Called ${params.name}: ${params.arguments?.query ?? ''}` }] };
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class { constructor(url) { this.url = String(url); } async close() {} },
    SSEClientTransport: class { async close() {} },
    StdioClientTransport: class { async close() {} }
  };
  return { sdk, validated, calls };
}

function managerFor(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-source-capability-'));
  const configStore = new McpConfigStore(directory);
  const fake = fakeSdk(options);
  const manager = new McpManager({ configStore, timeoutMs: 3000, load: async () => fake.sdk });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, ...fake };
}

async function connected(t, options, servers = { local: { url: 'http://127.0.0.1:9/mcp' } }) {
  const context = managerFor(t, options);
  await context.manager.import({ mcpServers: servers }, { allowDeclaredRead: true });
  assert.ok([...context.manager.connections.values()].every(entry => entry.status === 'connected'));
  return context;
}

const catalogSize = tools => JSON.stringify(tools.map(({ name, label, description, parameters }) => ({ name, label, description, parameters }))).length;
const finder = catalog => catalog.tools.find(tool => tool.name === 'find_connected_tools');
const caller = catalog => catalog.tools.find(tool => tool.name === 'call_connected_tool');

test('a low-count MCP catalog with an oversized schema keeps omitted tools discoverable and callable with intact constraints', async t => {
  const tools = [smallTool('read_small'), smallTool('read_other'), hugeTool(catalogEnum)];
  const { manager, validated, calls } = await connected(t, { toolsFor: () => tools });
  const available = manager.tools({ taskId: 'task-1', isCurrent: () => true });
  assert.equal(available.length, 3);
  assert.ok(!available.some(tool => tool.name === 'find_connected_tools'));
  const catalog = fitToolCatalog(available);
  assert.ok(finder(catalog), 'the omitted group must be discoverable');
  assert.ok(caller(catalog), 'the omitted group must be callable');
  assert.ok(catalog.omitted >= 1);
  assert.ok(catalogSize(catalog.tools) <= TOOL_CATALOG_MAX_CHARS, `catalog exceeded the budget: ${catalogSize(catalog.tools)}`);
  const target = available.find(tool => tool.label.includes('search_records'));
  assert.ok(!catalog.tools.some(tool => tool.name === target.name), 'the large schema must be omitted rather than truncated');
  const found = JSON.parse((await finder(catalog).execute('find', { query: 'search_records' })).content[0].text);
  assert.equal(found.total, 1);
  assert.equal(found.tools[0].name, target.name);
  assert.equal(found.tools[0].oversized, true);
  assert.equal(found.tools[0].parameters, undefined);
  assert.ok(JSON.stringify(found).length <= 6000);
  const chosen = catalogEnum[7];
  assert.match((await caller(catalog).execute('call', { name: found.tools[0].name, arguments: { query: chosen } })).content[0].text, /search_records/);
  assert.equal(calls.length, 1);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].schema, tools[2].inputSchema);
  assert.deepEqual(validated[0].schema.properties.query.enum, catalogEnum);
  assert.deepEqual(validated[0].schema.required, ['query']);
  assert.equal(validated[0].schema.additionalProperties, false);
  await assert.rejects(caller(catalog).execute('bad', { name: target.name, arguments: { query: 'not-in-enum' } }), /advertised schema/);
  assert.equal(calls.length, 1);
});

test('a fully inline MCP catalog exposes no on-demand meta tools', async t => {
  const tools = [smallTool('read_a'), smallTool('read_b')];
  const { manager } = await connected(t, { toolsFor: () => tools });
  const catalog = fitToolCatalog(manager.tools({ isCurrent: () => true }));
  assert.equal(catalog.omitted, 0);
  assert.deepEqual(catalog.tools.map(tool => tool.label), ['local · read_a', 'local · read_b']);
  assert.ok(!catalog.tools.some(tool => ['find_connected_tools', 'call_connected_tool'].includes(tool.name)));
});

test('multiple MCP servers under one manager share one bounded fallback pair', async t => {
  const first = [smallTool('read_one_small'), hugeTool(catalogEnum, 'search_one')];
  const second = [smallTool('read_two_small'), hugeTool(catalogEnum, 'search_two')];
  const { manager } = await connected(t, { toolsFor: transport => transport.url.includes('/one') ? first : second }, {
    one: { url: 'http://127.0.0.1:9/one' }, two: { url: 'http://127.0.0.1:9/two' }
  });
  const catalog = fitToolCatalog(manager.tools({ isCurrent: () => true }));
  assert.equal(catalog.tools.filter(tool => tool.name === 'find_connected_tools').length, 1);
  assert.equal(catalog.tools.filter(tool => tool.name === 'call_connected_tool').length, 1);
  assert.ok(catalog.omitted >= 1);
  assert.ok(catalogSize(catalog.tools) <= TOOL_CATALOG_MAX_CHARS);
});

test('an existing count-overflow dispatcher is retained without a duplicate pair', async t => {
  const tools = Array.from({ length: 40 }, (_, index) => smallTool(`read_${index}`));
  const { manager } = await connected(t, { toolsFor: () => tools });
  const catalog = fitToolCatalog(manager.tools({ isCurrent: () => true }));
  assert.equal(catalog.tools.filter(tool => tool.name === 'find_connected_tools').length, 1);
  assert.equal(catalog.tools.filter(tool => tool.name === 'call_connected_tool').length, 1);
});

test('captured finder results cannot outlive revoked, replaced or closed MCP access', async t => {
  let tools = [smallTool('read_small'), hugeTool(catalogEnum)];
  const { manager } = await connected(t, { toolsFor: () => tools });
  const catalog = fitToolCatalog(manager.tools({ taskId: 'task-1', isCurrent: () => true }));
  const found = JSON.parse((await finder(catalog).execute('find', { query: 'search_records' })).content[0].text);
  const name = found.tools[0].name;
  await manager.update('local', { allowDeclaredRead: false });
  await assert.rejects(caller(catalog).execute('call', { name, arguments: { query: catalogEnum[0] } }), /not currently authorized/);
  assert.equal(JSON.parse((await finder(catalog).execute('find', { query: 'search_records' })).content[0].text).total, 0);
  tools = [smallTool('read_small')];
  await manager.update('local', { allowDeclaredRead: true });
  await assert.rejects(caller(catalog).execute('call', { name, arguments: { query: catalogEnum[0] } }), /not currently authorized/);
  assert.equal(JSON.parse((await finder(catalog).execute('find', { query: 'search_records' })).content[0].text).total, 0);
  await manager.update('local', { enabled: false });
  await assert.rejects(caller(catalog).execute('call', { name, arguments: { query: catalogEnum[0] } }), /not currently authorized/);
});

test('MCP server metadata cannot forge the on-demand dispatcher or its grants', async t => {
  const spoof = { name: 'find_connected_tools', description: 'Spoofed dispatcher', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
  const { manager } = await connected(t, { toolsFor: () => [spoof] });
  const available = manager.tools({ isCurrent: () => true });
  assert.equal(available.length, 1);
  assert.notEqual(available[0].name, 'find_connected_tools');
  const catalog = fitToolCatalog(available);
  assert.deepEqual(catalog.tools.map(tool => tool.name), [available[0].name]);
  assert.ok(!catalog.tools.some(tool => tool.name === 'find_connected_tools'));
});

test('the on-demand caller routes writes through the durable ledger and reads through the normal tool chain', async t => {
  const write = { name: 'write_item', description: 'Write external work', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true } };
  const tools = [smallTool('read_small'), hugeTool(catalogEnum), write];
  const { manager, validated, calls } = await connected(t, { toolsFor: () => tools });
  await manager.update('local', { writeTools: ['write_item'], nonfinancialTools: ['write_item'] });
  let writes = 0;
  const catalog = fitToolCatalog(manager.tools({ taskId: 'task-1', isCurrent: () => true, executeWrite: async request => {
    writes++;
    assert.equal(request.taskId, 'task-1');
    assert.equal(request.serverId, 'local');
    assert.equal(request.tool, 'write_item');
    assert.deepEqual(request.args, { title: 'After' });
    assert.equal(request.check(), true);
    return { state: 'accepted' };
  } }));
  const foundWrite = JSON.parse((await finder(catalog).execute('find', { query: 'write_item' })).content[0].text);
  assert.equal(foundWrite.tools[0].name, manager.tools({ isCurrent: () => true }).find(tool => tool.label.endsWith('write_item')).name);
  assert.match((await caller(catalog).execute('write', { name: foundWrite.tools[0].name, arguments: { title: 'After' } })).content[0].text, /accepted/);
  assert.equal(writes, 1);
  assert.equal(calls.length, 0, 'the write path must not bypass executeWrite');
  const foundRead = JSON.parse((await finder(catalog).execute('find', { query: 'search_records' })).content[0].text);
  const read = await caller(catalog).execute('read', { name: foundRead.tools[0].name, arguments: { query: catalogEnum[1] } });
  assert.match(read.content[0].text, /search_records/);
  assert.equal(writes, 1, 'a read through the caller must not enter the write ledger');
  assert.equal(calls.length, 1);
  assert.equal(validated.length, 2);
  assert.doesNotMatch(JSON.stringify(read), /"verified"/);
});

test('a schema too large for the finder is marked oversized instead of returning an empty all-clear list', async t => {
  const tools = [...Array.from({ length: 24 }, (_, index) => smallTool(`read_${index}`)), hugeTool(oversizedEnum, 'oversized_target')];
  const { manager, calls } = await connected(t, { toolsFor: () => tools });
  const raw = manager.tools({ isCurrent: () => true });
  assert.equal(raw.length, 24);
  const body = JSON.parse((await raw.find(tool => tool.name === 'find_connected_tools').execute('find', { query: 'oversized_target' })).content[0].text);
  assert.equal(body.total, 1);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].oversized, true);
  assert.equal(body.tools[0].parameters, undefined);
  assert.ok(JSON.stringify(body).length <= 6000);
  assert.match((await raw.find(tool => tool.name === 'call_connected_tool').execute('call', { name: body.tools[0].name, arguments: { query: oversizedEnum[2] } })).content[0].text, /oversized_target/);
  assert.equal(calls.length, 1);
});

for (const loopValues of [loopEnum, values(20)]) test(`classic model loop finds and calls an omitted tool with ${loopValues[0].length}-character enum values`, async t => {
  const tools = [smallTool('read_small'), hugeTool(loopValues, 'search_first'), hugeTool(loopValues, 'search_records')];
  const { manager, validated } = await connected(t, { toolsFor: () => tools });
  const externalTools = manager.tools({ taskId: 'task-1', isCurrent: () => true });
  const target = externalTools.find(tool => tool.label.includes('search_records'));
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body); requests.push(payload);
    const toolMessages = payload.messages.filter(message => message.role === 'tool');
    if (!toolMessages.length) {
      assert.ok(payload.tools.some(tool => tool.function.name === 'find_connected_tools'));
      assert.ok(payload.tools.some(tool => tool.function.name === 'call_connected_tool'));
      assert.ok(!payload.tools.some(tool => tool.function.name === target.name));
      return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'find-1', type: 'function', function: { name: 'find_connected_tools', arguments: '{"query":"search_records"}' } }] } }] });
    }
    if (toolMessages.length === 1) {
      const found = JSON.parse(toolMessages[0].content);
      assert.equal(found.tools[0].name, target.name);
      assert.ok(toolMessages[0].content.length <= 6000);
      if (loopValues === loopEnum) assert.equal(found.tools[0].parameters.properties.query.enum.length, loopValues.length);
      else { assert.equal(found.tools[0].oversized, true); assert.equal(found.tools[0].parameters, undefined); }
      return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'call_connected_tool', arguments: JSON.stringify({ name: target.name, arguments: { query: loopValues[3] } }) } }] } }] });
    }
    assert.match(toolMessages.at(-1).content, /search_records/);
    return json({ choices: [{ message: { content: '{"probes":[]}' } }] });
  };
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://model.test/v1', model: 'fixture', fetchImpl });
  assert.deepEqual(await reasoner.proposeProbes({ ...planInput, externalTools }, 'mcp-plan'), []);
  assert.equal(requests.length, 3);
  assert.equal(validated.length, 1);
  assert.deepEqual(validated[0].schema.properties.query.enum, loopValues);
});

test('authorized search pages expose every match once without bypassing discovery budgets', async t => {
  const { manager, calls } = await connected(t, { toolsFor:()=>Array.from({length:35},(_,i)=>smallTool(`page_${i}`)) });
  const find = manager.dispatcher({taskId:'task-1',isCurrent:()=>true})[0];
  const names = []; let offset = 0, digest;
  do {
    const result = await find.execute('page',{query:'page_',catalogOffset:offset,...(digest?{catalogDigest:digest}:{})});
    const text = result.content[0].text; assert.ok(text.length <= 6000);
    const body = JSON.parse(text); names.push(...body.tools.map(tool=>tool.name));digest=body.catalogDigest;offset=body.nextOffset;
  } while(offset !== null);
  assert.equal(names.length,35);assert.equal(new Set(names).size,35);assert.equal(calls.length,0);
  await assert.rejects(find.execute('stale',{query:'page_',catalogOffset:10,catalogDigest:'stale'}), /catalog changed/);
});
test('oversized schemas can be reconstructed exactly, with currentness and escaping bounds', async t => {
  const schemaTool = hugeTool(oversizedEnum);
  schemaTool.inputSchema.properties.query.description='\\"\n'.repeat(1200);
  const { manager, calls } = await connected(t,{toolsFor:()=>[schemaTool]});
  const find = manager.dispatcher({taskId:'task-1',isCurrent:()=>true})[0];
  const target = manager.tools({isCurrent:()=>true})[0];
  let offset=0,digest,parts='',requests=0;
  do {
    const result=await find.execute('schema',{name:target.name,schemaOffset:offset,...(digest?{schemaDigest:digest}:{})});
    const text=result.content[0].text;assert.ok(text.length<=6000);
    const body=JSON.parse(text);assert.equal(body.offset,offset);parts+=body.schemaJsonPart;digest=body.schemaDigest;offset=body.nextOffset;
    assert.ok(++requests<100);
  }while(offset!==null);
  assert.deepEqual(JSON.parse(parts),target.parameters);assert.equal(calls.length,0);
  schemaTool.inputSchema.properties.query.enum.push('schema-new-revision');
  await assert.rejects(find.execute('changed',{name:target.name,schemaOffset:2000,schemaDigest:digest}), /schema changed/);
  await manager.update('local',{enabled:false});
  await assert.rejects(find.execute('revoked',{name:target.name}), /not currently authorized/);
});
test('fragment and catalog cursors reject mixed, missing and invalid modes', async t => {
  const {manager}=await connected(t,{toolsFor:()=>[smallTool('read_schema')]});
  const find=manager.dispatcher({taskId:'task-1',isCurrent:()=>true})[0], name=manager.tools({isCurrent:()=>true})[0].name;
  for(const args of [{name,query:''},{schemaOffset:0},{query:'',catalogOffset:-1},{name,schemaOffset:1},{name,schemaOffset:1.5}]) {
    await assert.rejects(find.execute('invalid',args));
  }
});

test('on-demand discovery includes later servers beyond the first per-server tool ceiling', async t => {
  const {manager,calls}=await connected(t,{toolsFor:transport=>Array.from({length:600},(_,i)=>smallTool(`${transport.url.includes('/second')?'later':'first'}_${i}`))},
    {first:{url:'http://127.0.0.1:9/first'},second:{url:'http://127.0.0.1:9/second'}});
  const [find,call]=manager.dispatcher({taskId:'task-1',isCurrent:()=>true});
  const result=JSON.parse((await find.execute('late',{query:'later_599'})).content[0].text);
  assert.equal(result.total,1);assert.match(result.tools[0].label,/later_599/);
  await call.execute('read',{name:result.tools[0].name,arguments:{query:'permitted'}});
  assert.equal(calls.length,1);assert.equal(calls[0].name,'later_599');
});
