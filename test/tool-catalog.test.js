import test from 'node:test';
import assert from 'node:assert/strict';
import { fitToolCatalog } from '../src/tool-catalog.js';

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
