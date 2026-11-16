import test from 'node:test';
import assert from 'node:assert/strict';
import { fitToolCatalog, registerToolFallback, TOOL_CATALOG_MAX_CHARS } from '../src/tool-catalog.js';

test('large external schemas cannot displace task source or authorized artifact tools', () => {
  const invoke = async () => {};
  const source = { name: 'read_task_source', contextProvider: 'workspace', description: 'Read the task source.', parameters: { type: 'object' }, execute: invoke };
  const artifact = { name: 'create_work_artifact', description: 'Destination grant: project-notes.', parameters: { type: 'object', properties: { grantId: { enum: ['grant-1'] } }, required: ['grantId'] }, execute: invoke };
  const large = { name: 'mcp_huge', description: 'Large remote schema.', parameters: { type: 'object', properties: { query: { enum: Array.from({ length: 300 }, (_, index) => `${index}-${'x'.repeat(60)}`) } } }, execute: invoke };
  const example = { description: 'value'.repeat(120) };
  const remote = { name: 'mcp_small', description: 'd'.repeat(1000), parameters: { type: 'object', properties: { description: { type: 'string', description: 'q'.repeat(600), maxLength: 40 }, metadata: { enum: [example], default: example, examples: [example], 'x-constraint': example } }, required: ['description'], additionalProperties: false }, execute: invoke };
  const catalog = fitToolCatalog([large, remote, artifact, source]);
  assert.deepEqual(catalog.tools.map(tool => tool.name), ['create_work_artifact', 'read_task_source', 'mcp_small']);
  assert.equal(catalog.omitted, 1);
  assert.deepEqual(catalog.tools.find(tool => tool.name === 'create_work_artifact').parameters, artifact.parameters);
  assert.equal(catalog.tools.find(tool => tool.name === 'create_work_artifact').description, artifact.description);
  assert.equal(catalog.tools.find(tool => tool.name === 'mcp_small').parameters.properties.description.maxLength, 40);
  assert.deepEqual(catalog.tools.find(tool => tool.name === 'mcp_small').parameters.required, ['description']);
  assert.deepEqual(catalog.tools.find(tool => tool.name === 'mcp_small').parameters.properties.metadata, remote.parameters.properties.metadata);
  assert.equal(catalog.tools.find(tool => tool.name === 'mcp_small').execute, invoke);
  assert.equal(remote.parameters.properties.description.description.length, 600);
});

const invoke = async () => {};
const workspaceTool = (name, description = name) => ({ name, contextProvider: 'workspace', description, parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: invoke });
const hugeExternal = () => ({ name: 'mcp_omitted', description: 'Remote schema.', parameters: { type: 'object', properties: { query: { type: 'string', enum: Array.from({ length: 300 }, (_, index) => `${index}-${'x'.repeat(60)}`), description: 'q'.repeat(600) } }, required: ['query'], additionalProperties: false }, execute: invoke });
const sizeOf = tools => JSON.stringify(tools.map(({ name, label, description, parameters }) => ({ name, label, description, parameters }))).length;

function fallbackGroup(builds) {
  const owner = {};
  return { owner, group: { owner, build: () => { builds.count++; return [workspaceTool('find_connected_tools', 'Find omitted tools.'), workspaceTool('call_connected_tool', 'Call an omitted tool.')]; } } };
}

test('an omitted registered MCP group gains one bounded finder and caller without losing task tools', () => {
  const source = { name: 'read_task_source', contextProvider: 'workspace', description: 'Read the task source.', parameters: { type: 'object' }, execute: invoke };
  const artifact = { name: 'create_work_artifact', description: 'Destination grant: project-notes.', parameters: { type: 'object', properties: { grantId: { enum: ['grant-1'] } }, required: ['grantId'] }, execute: invoke };
  const huge = hugeExternal();
  const builds = { count: 0 }, { group } = fallbackGroup(builds);
  registerToolFallback([huge], group);
  const catalog = fitToolCatalog([artifact, source, huge]);
  const names = catalog.tools.map(tool => tool.name);
  assert.ok(names.includes('create_work_artifact'));
  assert.ok(names.includes('read_task_source'));
  assert.ok(names.includes('find_connected_tools'));
  assert.ok(names.includes('call_connected_tool'));
  assert.equal(names.filter(name => name === 'find_connected_tools').length, 1);
  assert.ok(catalog.omitted >= 1);
  assert.ok(sizeOf(catalog.tools) <= TOOL_CATALOG_MAX_CHARS);
  assert.equal(builds.count, 1);
  assert.deepEqual(catalog.tools.find(tool => tool.name === 'create_work_artifact').parameters, artifact.parameters);
  assert.equal(catalog.tools.find(tool => tool.name === 'create_work_artifact').description, artifact.description);
});

test('the fallback pair is bounded and reused for repeated tools from the same manager', () => {
  const builds = { count: 0 }, { group } = fallbackGroup(builds);
  const first = hugeExternal(), second = { ...hugeExternal(), name: 'mcp_other' };
  registerToolFallback([first, second], group);
  const catalog = fitToolCatalog([first, second, workspaceTool('read_task_source')]);
  assert.equal(builds.count, 1);
  assert.equal(catalog.tools.filter(tool => tool.name === 'find_connected_tools').length, 1);
  assert.equal(catalog.tools.filter(tool => tool.name === 'call_connected_tool').length, 1);
  assert.ok(sizeOf(catalog.tools) <= TOOL_CATALOG_MAX_CHARS);
});

test('no dispatcher is added when the catalog fits or only unregistered tools are omitted', () => {
  const builds = { count: 0 }, { group } = fallbackGroup(builds);
  const fits = { name: 'mcp_small', description: 'Small.', parameters: { type: 'object' }, execute: invoke };
  registerToolFallback([fits], group);
  assert.deepEqual(fitToolCatalog([fits, workspaceTool('read_task_source')]).tools.map(tool => tool.name), ['read_task_source', 'mcp_small']);
  assert.equal(builds.count, 0);
  assert.equal(fitToolCatalog([hugeExternal()]).tools.some(tool => tool.name === 'find_connected_tools'), false);
  assert.equal(builds.count, 0);
});

test('an existing count-overflow dispatcher is kept and not duplicated', () => {
  const builds = { count: 0 }, { group } = fallbackGroup(builds);
  const huge = hugeExternal();
  registerToolFallback([huge], group);
  const find = workspaceTool('find_connected_tools'), call = workspaceTool('call_connected_tool');
  const catalog = fitToolCatalog([find, call, huge]);
  assert.equal(builds.count, 0);
  assert.equal(catalog.tools.filter(tool => tool.name === 'find_connected_tools').length, 1);
  assert.equal(catalog.tools.filter(tool => tool.name === 'call_connected_tool').length, 1);
  assert.equal(catalog.tools.find(tool => tool.name === 'find_connected_tools'), find);
  assert.ok(sizeOf(catalog.tools) <= TOOL_CATALOG_MAX_CHARS);
});
