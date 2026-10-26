#!/usr/bin/env node
// Compare existing task contracts through Pi's real loop with scripted model output.
import { fileURLToPath } from 'node:url';
import { PiReasoner, NullReasoner } from '../src/reasoning.js';
import { piSupported } from '../src/pi-runtime.js';
import { SCENARIOS } from './scenarios.js';
import { runFixture, checkExpectation } from './harness.js';

export async function evaluatePi() {
  if (!piSupported()) throw new Error('Pi evaluation requires Node.js 22.19+.');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const results = [];
  for (const fixture of SCENARIOS) {
    const config = fixture.reasoner || {};
    const reasoner = config.available === false ? new NullReasoner() : new PiReasoner({
      baseUrl: 'https://scripted.invalid/v1', model: 'scripted',
      runtimeOptions: { streamFn: (model, context) => {
        if (config.fail) throw config.fail;
        const stream = createAssistantMessageEventStream();
        const interpretation = String(context.messages[0].content).includes('extract structured facts');
        const toolResults = context.messages.filter(message => message.role === 'toolResult');
        let content;
        if (!interpretation && config.probes?.length && toolResults.length === 0) {
          content = [{ type: 'toolCall', id: 'find', name: 'search_documents', arguments: {} }];
        } else if (!interpretation && config.probes?.length && toolResults.length === 1 && JSON.parse(toolResults[0].content[0].text).documents[0]) {
          content = [{ type: 'toolCall', id: 'read', name: 'read_document', arguments: { id: JSON.parse(toolResults[0].content[0].text).documents[0].id } }];
        } else content = [{ type: 'text', text: JSON.stringify(interpretation ? config.interpretation || {} : { probes: config.probes || [] }) }];
        const message = {
          role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now()
        };
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
        return stream;
      } }
    });
    const { observations, outcome, resources } = await runFixture({ ...fixture, engineOptions: { ...fixture.engineOptions, reasoner } });
    const failures = observations.flatMap(observation => checkExpectation(observation.expect, observation.observed));
    failures.push(...checkExpectation(fixture.outcomeExpect, outcome));
    results.push({ id: fixture.id, passed: failures.length === 0, failures, modelCalls: resources.modelCalls, tools: reasoner.status().runtime?.recent.flatMap(run => run.tools).length || 0 });
  }
  return { kind: 'pi-scripted-contracts', total: results.length, passed: results.filter(result => result.passed).length, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await evaluatePi();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed === report.total ? 0 : 1;
}
