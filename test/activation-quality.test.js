import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURE_PATH, runEval } from '../eval/activation-quality.js';
import {
  BRIDGE_VERSION,
  MAX_MODEL_REQUESTS,
  createClaudeCliTransport,
  createFetchBridge
} from './fixtures/activation-quality-bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLD_PATH = path.join(ROOT, '.internal/agents/codex/2026-11-12-central/56-activation-quality-gold.json');
const KNOWN_DETERMINISTIC_FAILURES = [];
const KNOWN_CONTRACT_FAILURES = [];
const KNOWN_GAPS = [];

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function stableCaseView(report) {
  return report.cases.map(entry => ({
    id: entry.id,
    execution: entry.execution,
    judgment: entry.judgment,
    mismatches: entry.mismatches,
    actual: {
      activation: entry.actual.activation,
      grouping: entry.actual.grouping,
      externalWrites: entry.actual.externalWrites,
      duplicates: entry.actual.duplicates
    },
    contract: entry.contract,
    modelCalls: entry.modelCalls
  }));
}

function stableAggregation(report) {
  const { latencyMs, ...rest } = report.aggregation;
  return rest;
}

let first;
let second;
let fixtureBefore;
let goldBefore;

test.before(async () => {
  fixtureBefore = fs.readFileSync(FIXTURE_PATH);
  goldBefore = fs.existsSync(GOLD_PATH) ? fs.readFileSync(GOLD_PATH) : null;
  first = await runEval();
  second = await runEval();
});

test('fixture keeps all 30 central cases verbatim', async t => {
  assert.equal(first.fixtureIntegrity.ok, true, first.fixtureIntegrity.errors.join('; '));
  assert.equal(first.fixture.cases, 30);
  assert.equal(first.fixture.sha256, sha256(fixtureBefore));
  assert.equal(fs.readFileSync(FIXTURE_PATH).equals(fixtureBefore), true, 'eval mutated the fixture');
  assert.equal(fs.existsSync(GOLD_PATH) ? fs.readFileSync(GOLD_PATH).equals(goldBefore) : true, true, 'eval mutated the gold file');
  if (!goldBefore) {
    t.diagnostic('central gold file is absent in this checkout; verbatim comparison skipped');
    return;
  }
  const fixture = JSON.parse(fixtureBefore.toString('utf8'));
  const gold = JSON.parse(goldBefore.toString('utf8'));
  assert.equal(fixture.oracleVersion, gold.oracleVersion);
  assert.equal(fixture.provenance.sourceGoldSha256, sha256(goldBefore));
  assert.equal(first.goldFile.matchesFixtureProvenance, true);
  assert.equal(fixture.cases.length, gold.cases.length);
  for (const goldCase of gold.cases) {
    const fixtureCase = fixture.cases.find(entry => entry.id === goldCase.id);
    assert.ok(fixtureCase, `missing ${goldCase.id}`);
    assert.equal(fixtureCase.axis, goldCase.axis, `${goldCase.id} axis changed`);
    assert.equal(fixtureCase.description, goldCase.description, `${goldCase.id} description changed`);
    assert.deepEqual(fixtureCase.expected, goldCase.expected, `${goldCase.id} expected changed`);
    assert.equal(fixtureCase.notes, goldCase.notes, `${goldCase.id} notes changed`);
  }
});

test('harness makes no network calls and performs no external writes', () => {
  assert.deepEqual(first.networkRequests, []);
  assert.equal(first.environment.networkGuard, 'globalThis.fetch throws on any call');
  assert.equal(first.gate.networkRequests, 0);
  assert.equal(first.gate.externalWritesTotal, 0);
  for (const entry of first.cases) {
    assert.equal(entry.actual.externalWrites, 0, `${entry.id} recorded an external write`);
    assert.equal(entry.error, null, `${entry.id} threw: ${entry.error}`);
  }
  assert.deepEqual(second.networkRequests, []);
});

test('machine gate requires every deterministic and safety contract case; semantic G1 stays open', () => {
  assert.equal(first.gate.status, 'FAIL');
  assert.deepEqual([...first.gate.knownGapIds].sort(), [...KNOWN_GAPS].sort());
  assert.deepEqual(first.gate.unexpectedFailureIds, []);
  assert.deepEqual(first.gate.notExecuted, ['G1']);
  assert.equal(first.gate.semanticGate, 'not_executed');
  assert.equal(first.gate.deterministic.total, 25);
  assert.deepEqual([...first.gate.deterministic.failed].sort(), [...KNOWN_DETERMINISTIC_FAILURES].sort());
  assert.equal(first.gate.proposalContract.total, 4);
  assert.deepEqual([...first.gate.proposalContract.failed].sort(), [...KNOWN_CONTRACT_FAILURES].sort());
});

test('deterministic cases match the unchanged independent gold', () => {
  const expected = {
    D1: ['once', 'unchanged'],
    D2: ['once', 'unchanged'],
    D3: ['once', 'unchanged'],
    D4: ['no_new', 'unchanged'],
    U1: ['latest', 'same'],
    U2: ['withdrawn', 'same'],
    U3: ['withdrawn', 'same'],
    U4: ['latest', 'same'],
    G2: ['actionable', 'distinct'],
    G3: ['actionable', 'distinct'],
    G4: ['actionable', 'distinct'],
    G5: ['actionable', 'distinct'],
    G6: ['actionable', 'distinct'],
    G7: ['actionable', 'same'],
    A1: ['actionable', 'not_applicable'],
    A2: ['no_new', 'not_applicable'],
    A3: ['no_new', 'not_applicable'],
    A5: ['no_new', 'not_applicable'],
    A6: ['suppressed', 'not_applicable'],
    A7: ['suppressed', 'not_applicable'],
    A8: ['deferred', 'not_applicable'],
    N1: ['priority_high_first', 'not_applicable'],
    N2: ['bounded_low_service', 'not_applicable'],
    N3: ['deduped_notice', 'not_applicable'],
    N4: ['no_interruption', 'not_applicable']
  };
  for (const [id, [activation, grouping]] of Object.entries(expected)) {
    const entry = first.cases.find(item => item.id === id);
    assert.equal(entry.actual.activation, activation, `${id} activation`);
    assert.equal(entry.actual.grouping, grouping, `${id} grouping`);
    if (KNOWN_DETERMINISTIC_FAILURES.includes(id)) assert.equal(entry.judgment, 'fail', `${id} should expose a known gap`);
    else assert.equal(entry.judgment, 'pass', `${id} should pass`);
  }
  assert.equal(first.aggregation.duplicateSurvived.length, 0);
  assert.deepEqual(first.aggregation.resurrectionObserved, []);
  assert.deepEqual(first.aggregation.falseActivation, []);
  assert.deepEqual(first.aggregation.missedActivation, []);
});

test('proposal-contract cases distinguish defence behaviour from semantic quality', () => {
  const g8 = first.cases.find(entry => entry.id === 'G8');
  const a10 = first.cases.find(entry => entry.id === 'A10');
  const a4 = first.cases.find(entry => entry.id === 'A4');
  const a9 = first.cases.find(entry => entry.id === 'A9');
  assert.equal(g8.judgment, 'pass');
  assert.equal(g8.actual.activation, 'review_required');
  assert.equal(g8.actual.grouping, 'same');
  assert.equal(g8.contract.actualCalls.extractSituationDelta, 1);
  assert.equal(a10.judgment, 'pass');
  assert.equal(a10.actual.activation, 'review_or_reject');
  assert.equal(a10.actual.grouping, 'distinct');
  assert.equal(a10.contract.actualCalls.assessSituationPair, 0);
  assert.equal(a4.judgment, 'pass');
  assert.equal(a4.actual.activation, 'actionable');
  assert.equal(a4.contract.actualCalls.discoverRequestCandidate, 1);
  assert.equal(a9.judgment, 'pass');
  assert.equal(a9.actual.activation, 'unknown');
  assert.equal(a9.contract.actualCalls.assessStandingIntent, 0);
  for (const entry of [g8, a10, a4, a9]) {
    assert.equal(entry.provenance, 'proposal_contract');
    assert.equal(entry.semanticQuality, 'unknown');
    assert.equal(entry.contract.matched, true);
  }
  assert.deepEqual(first.aggregation.modelCalls, {
    assessSituationPair: 0,
    extractSituationDelta: 1,
    assessStandingIntent: 0,
    discoverRequestCandidate: 1
  });
  assert.equal(first.aggregation.tokenUsage, 'unknown');
});

test('G1 is not_executed and keeps the baseline fact separate from semantic quality', () => {
  const g1 = first.cases.find(entry => entry.id === 'G1');
  assert.equal(g1.execution, 'not_executed');
  assert.equal(g1.judgment, 'not_executed');
  assert.equal(g1.semanticQuality, 'unknown');
  assert.equal(g1.actual.activation, 'actionable');
  assert.equal(g1.actual.grouping, 'distinct');
  assert.equal(g1.expected.grouping, 'same');
  assert.match(g1.executionReason, /Semantic same-Situation grouping/);
  assert.equal(first.actualModel.executed, false);
  assert.equal(first.actualModel.usedRequests, 0);
  assert.equal(first.actualModel.maxRequests, 8);
  assert.deepEqual(first.actualModel.plannedCases, ['G1', 'G2', 'G3', 'A1', 'A3', 'A4']);
  assert.equal(first.actualModel.tokenUsage, 'unknown');
});

test('pairwise and cost metrics are computed from measured events, not constants', () => {
  const pairwise = first.aggregation.pairwise;
  assert.equal(pairwise.truePositive, 2);
  assert.equal(pairwise.falsePositive, 0);
  assert.equal(pairwise.falseNegative, 0);
  assert.equal(pairwise.notExecutedPairs, 1);
  assert.equal(pairwise.precision, 1);
  assert.equal(pairwise.recall, 1);
  assert.deepEqual(pairwise.pairs.filter(pair => pair.merged && pair.expected === 'distinct').map(pair => pair.case).sort(), []);
  assert.deepEqual(first.aggregation.counterfactual, {
    method: 'call_count_only',
    case: 'D1',
    baselineEvents: 3,
    dedupedModelRequests: 0,
    naiveModelRequests: 3,
    difference: 3,
    tokenDifference: 'unknown'
  });
  assert.equal(first.aggregation.tokenUsage, 'unknown');
  assert.equal(first.aggregation.currency, 'unknown');
});

test('negative controls force the grouping, activation and counting gates to fail', () => {
  assert.equal(first.negativeControls.length, 3);
  for (const control of first.negativeControls) {
    assert.equal(control.detected, true, `${control.name} did not detect its injected fault`);
    assert.ok(control.failures.includes(control.target), `${control.name} did not flag ${control.target}`);
  }
});

test('two isolated runs reproduce the same machine judgement', () => {
  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.deepEqual(stableCaseView(first), stableCaseView(second));
  assert.deepEqual(stableAggregation(first), stableAggregation(second));
  assert.deepEqual(first.gate, second.gate);
  assert.equal(first.fixture.sha256, second.fixture.sha256);
  assert.deepEqual(first.sourceHashes, second.sourceHashes);
  assert.deepEqual(first.negativeControls, second.negativeControls);
});

test('bridge wraps Anthropic, chat-completion and responses payloads without exposing prompts', async () => {
  const seen = [];
  const transport = {
    kind: 'fake',
    cliVersion: 'fake-cli-1',
    async call({ system, prompt, index }) {
      seen.push({ system, prompt, index });
      return {
        text: `answer-${index}`,
        usage: { input_tokens: 10 + index, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
        modelAlias: 'claude-test-alias',
        cliVersion: 'fake-cli-1'
      };
    }
  };
  const bridge = createFetchBridge({ transport, maxRequests: 5 });
  const body = JSON.stringify({ system: 'production system', messages: [{ role: 'user', content: 'synthetic event' }] });
  const messageResponse = await bridge.fetchImpl('https://model.example.test/v1/messages', { method: 'POST', body });
  const messageBody = await messageResponse.json();
  assert.equal(messageResponse.ok, true);
  assert.equal(messageBody.content[0].text, 'answer-1');
  assert.equal(messageBody.usage.input_tokens, 11);
  assert.equal(messageBody.usage.cache_read_input_tokens, 1);

  const chatResponse = await bridge.fetchImpl('https://model.example.test/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'system', content: 'production system' }, { role: 'user', content: 'synthetic event' }] })
  });
  const chatBody = await chatResponse.json();
  assert.equal(chatBody.choices[0].message.content, 'answer-2');
  assert.equal(chatBody.usage.prompt_tokens, 12);

  const responsesResponse = await bridge.fetchImpl('https://model.example.test/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ instructions: 'production system', input: 'synthetic event' })
  });
  const responsesBody = await responsesResponse.json();
  assert.equal(responsesBody.output_text, 'answer-3');
  assert.equal(responsesBody.output[0].content[0].text, 'answer-3');

  const report = bridge.report();
  assert.equal(report.version, BRIDGE_VERSION);
  assert.equal(report.maxRequests, 5);
  assert.equal(report.usedRequests, 3);
  assert.equal(report.remainingRequests, 2);
  assert.equal(report.providerFailures, 0);
  assert.equal(report.authInArgv, false);
  assert.equal(report.contextLeakCheck, 'marker_scan');
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('production system'), false);
  assert.equal(serialized.includes('synthetic event'), false);
  assert.equal(serialized.includes('answer-1'), false);
  for (const request of report.requests) {
    assert.equal(request.responseValid, true);
    assert.equal(request.modelAlias, 'claude-test-alias');
    assert.match(request.requestDigest, /^[a-f0-9]{64}$/);
    assert.match(request.userDigest, /^[a-f0-9]{64}$/);
    assert.match(request.resultDigest, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(seen.map(item => [item.system, item.prompt, item.index]), [
    ['production system', 'synthetic event', 1],
    ['production system', 'synthetic event', 2],
    ['production system', 'synthetic event', 3]
  ]);
});

test('bridge enforces the eight-request ceiling, context isolation and provider-failure reporting', async () => {
  let calls = 0;
  const bridge = createFetchBridge({
    transport: { kind: 'fake', async call() { calls += 1; return { text: 'ok', usage: null, modelAlias: null }; } },
    maxRequests: 2
  });
  const request = () => bridge.fetchImpl('https://model.example.test/v1/messages', {
    method: 'POST', body: JSON.stringify({ system: 's', messages: [{ role: 'user', content: 'u' }] })
  });
  await request();
  await request();
  await assert.rejects(() => request(), error => error.code === 'BRIDGE_BUDGET_EXHAUSTED');
  assert.equal(calls, 2);
  assert.equal(bridge.report().usedRequests, 2);
  assert.equal(bridge.report().remainingRequests, 0);
  assert.equal(MAX_MODEL_REQUESTS, 8);

  const leakBridge = createFetchBridge({ transport: { kind: 'fake', async call() { throw new Error('must not run'); } } });
  await assert.rejects(
    () => leakBridge.fetchImpl('https://model.example.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ system: 'central-activation-gold expected', messages: [{ role: 'user', content: 'u' }] })
    }),
    error => error.code === 'BRIDGE_CONTEXT_LEAK'
  );
  assert.equal(leakBridge.report().usedRequests, 0);

  const failureBridge = createFetchBridge({
    transport: {
      kind: 'fake',
      async call() {
        const error = new Error('provider down');
        error.code = 'PROVIDER_400';
        throw error;
      }
    }
  });
  const failure = await failureBridge.fetchImpl('https://model.example.test/v1/messages', {
    method: 'POST', body: JSON.stringify({ system: 's', messages: [{ role: 'user', content: 'u' }] })
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.status, 502);
  assert.equal(failureBridge.report().providerFailures, 1);
  assert.equal(failureBridge.report().requests[0].responseValid, false);
  assert.equal(failureBridge.report().requests[0].errorClass, 'PROVIDER_400');
});

test('CLI transport runs one bounded child in a clean cwd with no auth in argv', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-bridge-contract-'));
  const scriptDir = path.join(tempRoot, 'script');
  const cwdDir = path.join(tempRoot, 'cwd');
  fs.mkdirSync(scriptDir);
  fs.mkdirSync(cwdDir);
  const script = path.join(scriptDir, 'fake-cli.mjs');
  fs.writeFileSync(script, `
import process from 'node:process';
const args = process.argv.slice(2);
const required = ['--bare','--print','--system-prompt','--tools','--output-format','--no-session-persistence','--strict-mcp-config'];
if (!required.every(flag => args.includes(flag))) process.exit(3);
if (args.some(value => value.includes('ANTHROPIC') || value.includes('sk-test-secret'))) process.exit(4);
if (args[args.indexOf('--system-prompt') + 1] !== 'You are a test system.') process.exit(5);
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) process.exit(6);
if (!String(process.env.NODE_OPTIONS || '').includes('--max-old-space-size=512')) process.exit(7);
if (process.cwd() === ${JSON.stringify(ROOT)}) process.exit(8);
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input !== 'Hello synthetic event') process.exit(9);
  process.stdout.write(JSON.stringify({
    result: 'WORLD',
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 },
    modelUsage: { 'claude-test-alias': {} },
    version: 'fake-cli-1'
  }));
});
`);
  const transport = createClaudeCliTransport({
    cliPath: process.execPath,
    cliArgsPrefix: [script],
    cwd: cwdDir,
    timeoutMs: 5000,
    envAllowlist: ['PATH', 'HOME', 'TMPDIR']
  });
  const bridge = createFetchBridge({ transport });
  try {
    const response = await bridge.fetchImpl('https://model.example.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ system: 'You are a test system.', messages: [{ role: 'user', content: 'Hello synthetic event' }] })
    });
    assert.equal(response.ok, true);
    const body = await response.json();
    assert.equal(body.content[0].text, 'WORLD');
    assert.equal(body.usage.input_tokens, 3);
    assert.equal(body.usage.output_tokens, 2);
    assert.equal(body.model, 'claude-test-alias');
    const report = bridge.report();
    assert.equal(report.usedRequests, 1);
    assert.equal(report.requests[0].usage.input_tokens, 3);
    assert.equal(report.requests[0].modelAlias, 'claude-test-alias');
    assert.equal(report.requests[0].cliVersion, 'fake-cli-1');
    assert.equal(report.authInArgv, false);
    assert.equal(report.transportDescription.isolation.cleanCwd, true);
    assert.equal(report.transportDescription.isolation.systemPromptMode, 'explicit_cli_system_prompt');
    assert.equal(report.transportDescription.isolation.tools, 'none');
    assert.deepEqual(report.transportDescription.envKeys.sort(), ['HOME', 'PATH', 'TMPDIR'].filter(key => process.env[key] != null).sort());
  } finally {
    bridge.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI transport bounds a hanging child and reports a provider failure', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-bridge-timeout-'));
  const script = path.join(tempRoot, 'hang.mjs');
  fs.writeFileSync(script, `
setInterval(() => {}, 1000);
process.stdin.resume();
`);
  const transport = createClaudeCliTransport({
    cliPath: process.execPath,
    cliArgsPrefix: [script],
    cwd: tempRoot,
    timeoutMs: 300,
    envAllowlist: ['PATH', 'HOME', 'TMPDIR']
  });
  const bridge = createFetchBridge({ transport });
  const started = Date.now();
  try {
    const response = await bridge.fetchImpl('https://model.example.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ system: 's', messages: [{ role: 'user', content: 'u' }] })
    });
    assert.equal(response.ok, false);
    assert.equal(response.status, 502);
    assert.equal(bridge.report().providerFailures, 1);
    assert.equal(bridge.report().requests[0].errorClass, 'BRIDGE_TIMEOUT');
    assert.ok(Date.now() - started < 5000, 'timeout was not bounded');
  } finally {
    bridge.dispose();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a successful natural-exit CLI child releases the bridge process promptly', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-bridge-natural-exit-'));
  const fakeCli = path.join(tempRoot, 'fake-cli.mjs');
  const runner = path.join(tempRoot, 'runner.mjs');
  const proofPath = path.join(tempRoot, 'proof.json');
  const fixtureUrl = pathToFileURL(path.join(ROOT, 'test/fixtures/activation-quality-bridge.mjs')).href;
  fs.writeFileSync(fakeCli, `
import process from 'node:process';
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    result: 'NATURAL-EXIT',
    usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 1 },
    modelUsage: { 'fake-natural-exit-alias': {} },
    version: 'fake-natural-exit-1'
  }));
});
`);
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import process from 'node:process';
const { createClaudeCliTransport } = await import(${JSON.stringify(fixtureUrl)});
const transport = createClaudeCliTransport({
  cliPath: process.execPath,
  cliArgsPrefix: [${JSON.stringify(fakeCli)}],
  cwd: ${JSON.stringify(tempRoot)},
  timeoutMs: 30000,
  envAllowlist: ['PATH', 'HOME', 'TMPDIR']
});
const result = await transport.call({ system: 'natural exit system', prompt: 'natural exit prompt', index: 1 });
transport.dispose();
fs.writeFileSync(${JSON.stringify(proofPath)}, JSON.stringify({
  text: result.text,
  usage: result.usage,
  modelAlias: result.modelAlias,
  cliVersion: result.cliVersion,
  exitCode: result.exitCode
}));
`);
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR']
    .filter(key => process.env[key] != null)
    .map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, [runner], { cwd: tempRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const started = Date.now();
  let timedOut = false;
  try {
    const outcome = await new Promise(resolve => {
      let settled = false;
      let deadline;
      const done = value => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      };
      deadline = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 5000);
      child.on('error', error => done({ error }));
      child.on('close', (code, signal) => done({ code, signal }));
    });
    const elapsed = Date.now() - started;
    assert.equal(timedOut, false, `natural-exit runner stayed alive past its 5000ms parent deadline (elapsed ${elapsed}ms): a successful child must clear the bridge budget timer. stderr: ${stderr}`);
    assert.equal(outcome.error, undefined, `natural-exit runner failed to start: ${outcome.error?.message}`);
    assert.equal(outcome.code, 0, `natural-exit runner exited with code ${outcome.code} signal ${outcome.signal}. stderr: ${stderr}`);
    assert.ok(elapsed < 5000, `natural-exit runner took ${elapsed}ms`);
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    assert.equal(proof.text, 'NATURAL-EXIT');
    assert.equal(proof.usage.input_tokens, 5);
    assert.equal(proof.usage.output_tokens, 3);
    assert.equal(proof.usage.cache_read_input_tokens, 1);
    assert.equal(proof.modelAlias, 'fake-natural-exit-alias');
    assert.equal(proof.cliVersion, 'fake-natural-exit-1');
    assert.equal(proof.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('owned CLI workdir is removed on dispose', () => {
  const transport = createClaudeCliTransport({ cliPath: 'claude' });
  const workdir = transport.workdir;
  assert.equal(fs.existsSync(workdir), true);
  transport.dispose();
  assert.equal(fs.existsSync(workdir), false);
});
