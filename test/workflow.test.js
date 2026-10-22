import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { scenario } from '../src/connectors/simulated.js';

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-test-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  const store = new JsonStore(filename);
  const provider = new SimulatedMailProvider(store);
  return { filename, store, provider, engine: new WorkEngine(store, { provider }) };
}
const email = (id = 'm1', project = 'Northstar') => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: `${project} proposal — experiment results`,
    body: `Please update the ${project} project proposal with the latest experiment results and send the revised proposal by Friday.`
  }
});
const doc = (id, project, content) => ({ id, type: 'document.modified', payload: {
  id: `${project.toLowerCase()}-proposal`, kind: 'proposal', title: `${project} project proposal`, content
} });
const run = (id, completedAt, subjectEntity = 'Northstar') => ({ id: `event-run-${id}`, type: 'experiment.run.completed', payload: {
  id, label: `${subjectEntity} run ${completedAt}`, subjectEntity, completedAt, source: { kind: 'run_registry', id: 'test-registry' }
} });
const partial = project => `# ${project} project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\n`;
const complete = project => `${partial(project)}Control: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.\n`;
const task = env => env.store.state.tasks['request:m1'];
const ready = env => {
  env.engine.ingest(email());
  env.engine.ingest(doc('event-doc-complete', 'Northstar', complete('Northstar')));
  assert.equal(task(env).status, 'ready_for_approval');
};

test('independent document change discovers a completed request and prepares a linked reply', () => {
  const env = setup();
  env.engine.ingest(doc('event-initial', 'Northstar', '# Northstar project proposal\nResults pending.'));
  env.engine.ingest(email());
  assert.equal(task(env).status, 'waiting_for_information');
  env.engine.ingest(doc('event-results', 'Northstar', complete('Northstar')));
  assert.equal(task(env).status, 'ready_for_approval');
  assert.equal(env.store.state.outbox.length, 0);
  assert.match(task(env).draft.documentUrl, /\/documents\/northstar-proposal$/);
  assert.ok(task(env).assessment.evidence.some(item => item.includes('10.4%')));
  assert.ok(env.store.state.history.some(item => item.kind === 'preparation'));
});

test('incomplete results do not create an approval or falsely claim completion', () => {
  const env = setup();
  env.engine.ingest(email());
  env.engine.ingest(doc('event-partial', 'Northstar', partial('Northstar')));
  assert.equal(task(env).status, 'waiting_for_information');
  assert.equal(task(env).draft, null);
  assert.ok(task(env).assessment.missing.includes('A control-group result'));
  assert.ok(task(env).assessment.missing.includes('A stated conclusion'));
});

test('unrelated document edit is observed but does not change the task', () => {
  const env = setup();
  env.engine.ingest(email());
  const previous = task(env).assessment.checkedAt;
  const result = env.engine.ingest(doc('event-ops', 'Operations', complete('Operations')));
  assert.equal(result.disposition, 'unrelated_change');
  assert.equal(task(env).status, 'waiting_for_information');
  assert.equal(task(env).assessment.checkedAt, previous);
  assert.equal(env.store.state.outbox.length, 0);
});

test('duplicate event and approval cannot create duplicate work or mail', () => {
  const env = setup();
  ready(env);
  const before = env.store.state.revision;
  assert.equal(env.engine.ingest(doc('event-doc-complete', 'Northstar', complete('Northstar'))).duplicate, true);
  assert.equal(env.store.state.revision, before);
  assert.equal(Object.keys(env.store.state.tasks).length, 1);
  env.engine.approve('request:m1');
  assert.throws(() => env.engine.approve('request:m1'), /not ready/);
  assert.equal(env.store.state.outbox.length, 1);
});

test('sending requires explicit approval, with a verified simulated receipt after approval', () => {
  const env = setup();
  ready(env);
  assert.equal(env.store.state.outbox.length, 0);
  const result = env.engine.approve('request:m1');
  assert.equal(result.status, 'completed');
  assert.equal(result.action.permission, 'user_approved');
  assert.equal(result.action.status, 'verified_simulated');
  assert.equal(env.store.state.outbox.length, 1);
  assert.equal(env.store.state.outbox[0].status, 'accepted_simulation');
});

test('timeout after acceptance reconciles the receipt rather than sending again', () => {
  const env = setup();
  ready(env);
  const result = env.engine.approve('request:m1', { failureMode: 'timeout_after_accept' });
  assert.equal(result.status, 'completed');
  assert.equal(env.store.state.outbox.length, 1);
  env.engine.reconcile('request:m1');
  assert.equal(env.store.state.outbox.length, 1);
});

test('timeout without acceptance blocks until reconciliation, then retry uses the same key', () => {
  const env = setup();
  ready(env);
  const result = env.engine.approve('request:m1', { failureMode: 'timeout_before_accept' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.action.status, 'uncertain');
  assert.equal(env.store.state.outbox.length, 0);
  assert.throws(() => env.engine.retry('request:m1'), /confirmed absence/);
  env.engine.reconcile('request:m1');
  assert.equal(task(env).action.status, 'confirmed_absent');
  env.engine.retry('request:m1');
  assert.equal(task(env).status, 'completed');
  assert.equal(env.store.state.outbox.length, 1);
});

test('restart preserves events and tasks, and reconciles an in-flight approved action', () => {
  const env = setup();
  ready(env);
  env.store.mutate(state => {
    state.tasks['request:m1'].status = 'verifying';
    state.tasks['request:m1'].action = {
      id: 'send:request:m1:1', idempotencyKey: 'send:request:m1:1',
      permission: 'user_approved', status: 'executing'
    };
  });
  env.provider.send({ idempotencyKey: 'send:request:m1:1', to: 'alex@example.test', subject: 'Re: Northstar proposal', body: 'Prepared', documentUrl: task(env).draft.documentUrl });
  const restored = new JsonStore(env.filename);
  const after = new WorkEngine(restored);
  assert.equal(after.publicState().tasks[0].status, 'completed');
  assert.equal(after.publicState().outbox.length, 1);
  assert.equal(after.ingest(email()).duplicate, true);
  assert.equal(after.publicState().events.length, 2);
});

test('restart resumes assessment interrupted after persisting a document event', () => {
  const env = setup();
  ready(env);
  env.store.mutate(state => {
    state.tasks['request:m1'].status = 'newly_discovered';
    state.tasks['request:m1'].assessment = null;
    state.tasks['request:m1'].draft = null;
  });
  const restored = new JsonStore(env.filename);
  new WorkEngine(restored);
  assert.equal(restored.state.tasks['request:m1'].status, 'ready_for_approval');
  assert.equal(restored.state.outbox.length, 0);
});

test('restart correlates a newly persisted document even before a task was associated with it', () => {
  const env = setup();
  env.engine.ingest(email());
  env.store.mutate(state => {
    state.documents['northstar-proposal'] = {
      id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
      url: '/documents/northstar-proposal', version: 1, content: complete('Northstar')
    };
  });
  const restored = new JsonStore(env.filename);
  new WorkEngine(restored);
  assert.equal(restored.state.tasks['request:m1'].status, 'ready_for_approval');
});

test('approval refuses a stale draft when the document has changed', () => {
  const env = setup();
  ready(env);
  env.store.mutate(state => {
    state.documents['northstar-proposal'].content = partial('Northstar');
    state.documents['northstar-proposal'].version += 1;
  });
  assert.throws(() => env.engine.approve('request:m1'), /changed/);
  assert.equal(task(env).status, 'waiting_for_information');
  assert.equal(env.store.state.outbox.length, 0);
});

test('rejected draft cannot be sent', () => {
  const env = setup();
  ready(env);
  env.engine.reject('request:m1');
  assert.equal(task(env).status, 'blocked');
  assert.throws(() => env.engine.approve('request:m1'), /not ready/);
  assert.equal(env.store.state.outbox.length, 0);
});

// ---------------------------------------------------------------------------
// Phase 2 behavioural guarantees
// ---------------------------------------------------------------------------

test('a request is discovered from varied wording, deliverable and deadline, with no Northstar assumptions', () => {
  const env = setup();
  env.engine.ingest({ id: 'event-aurora', type: 'email.received', payload: {
    id: 'aurora-1', from: 'dana@example.test', subject: 'Aurora onboarding report refresh',
    body: 'Could you update the Aurora onboarding report with the newest experiment results and share it before Thursday?'
  } });
  const aurora = env.store.state.tasks['request:aurora-1'];
  assert.ok(aurora, 'the request should be discovered without any prompt');
  assert.equal(aurora.request.subjectEntity, 'Aurora');
  assert.equal(aurora.request.deliverable, 'report');
  assert.equal(aurora.request.intent, 'update_and_send');
  assert.equal(aurora.request.deadline.text.toLowerCase(), 'thursday');
  assert.equal(aurora.status, 'waiting_for_information');

  env.engine.ingest({ id: 'event-aurora-doc', type: 'document.modified', payload: {
    id: 'aurora-report', kind: 'report', title: 'Aurora onboarding report',
    content: '# Aurora onboarding report\n\n## Experiment results\nRun date: 2026-10-14\nSample size: 900\nControl: 12.0% activation\nTreatment: 15.5% activation\nConclusion: Treatment raised activation by 3.5 points.\n'
  } });
  assert.equal(aurora.status, 'ready_for_approval');
  assert.equal(env.store.state.outbox.length, 0);
});

test('an email that is not a deliverable request creates context but no work', () => {
  const env = setup();
  const result = env.engine.ingest({ id: 'event-chat', type: 'email.received', payload: {
    id: 'chat-1', from: 'sam@example.test', subject: 'Lunch on Friday?',
    body: 'Are you free for lunch on Friday? No rush.'
  } });
  assert.equal(result.disposition, 'context_only');
  assert.equal(Object.keys(env.store.state.tasks).length, 0);
  assert.equal(env.store.state.outbox.length, 0);
});

test('the latest-results claim is withheld when freshness cannot be supported', () => {
  const env = setup();
  ready(env); // no run registry is connected in this scenario
  assert.equal(task(env).assessment.freshness.status, 'unverified');
  const withheld = task(env).draft.withheldClaims.map(item => item.id);
  assert.ok(withheld.includes('results_are_latest'), 'the latest claim must be withheld');
  assert.equal(/\blatest\b/i.test(task(env).draft.body), false, 'the draft must not claim the results are latest');
  assert.ok(task(env).evidence.unknowns.some(item => item.id === 'freshness_source_of_truth'));
});

test('the latest-results claim is allowed once the run registry confirms the newest run', () => {
  const env = setup();
  env.engine.ingest(run('run-a', '2026-10-16T09:00:00.000Z'));
  ready(env);
  assert.equal(task(env).assessment.freshness.status, 'verified');
  assert.equal(task(env).draft.withheldClaims.length, 0);
  assert.match(task(env).draft.body, /\blatest\b/i);
});

test('a newer published run makes the document stale and blocks completion', () => {
  const env = setup();
  env.engine.ingest(run('run-new', '2026-10-20T09:00:00.000Z'));
  env.engine.ingest(email());
  env.engine.ingest(doc('event-doc-complete', 'Northstar', complete('Northstar')));
  assert.equal(task(env).assessment.freshness.status, 'stale');
  assert.equal(task(env).status, 'waiting_for_information');
  assert.equal(task(env).draft, null);
  assert.equal(task(env).assessment.complete, false);
  assert.ok(task(env).evidence.unknowns.some(item => item.id === 'stale_results'));
});

test('a run published after a draft was prepared withdraws that draft without any prompt', () => {
  const env = setup();
  ready(env);
  assert.equal(task(env).status, 'ready_for_approval');
  env.engine.ingest(run('run-newer', '2026-10-20T09:00:00.000Z'));
  assert.equal(task(env).status, 'waiting_for_information');
  assert.equal(task(env).draft, null);
  assert.equal(env.store.state.outbox.length, 0);
  assert.throws(() => env.engine.approve('request:m1'), /not ready/);
});

test('requested content that is absent is reported as unsatisfied, not assumed complete', () => {
  const env = setup();
  env.engine.ingest({ id: 'event-vague', type: 'email.received', payload: {
    id: 'vague-1', from: 'lee@example.test', subject: 'Vertex report',
    body: 'Please update the Vertex report with the signed customer testimonials and send it by Friday.'
  } });
  const vague = env.store.state.tasks['request:vague-1'];
  env.engine.ingest({ id: 'event-vague-doc', type: 'document.modified', payload: {
    id: 'vertex-report', kind: 'report', title: 'Vertex report', content: '# Vertex report\n\nEverything is attached.\n'
  } });
  assert.equal(vague.assessment.complete, false);
  assert.equal(vague.status, 'waiting_for_information');
  assert.equal(vague.draft, null);

  // Phase 3: the request is now *verifiable*. The system knows what customer
  // feedback content looks like, so it can state that it is absent instead of
  // only saying it cannot check.
  const criterion = vague.evidence.criteria.find(item => item.id === 'customer_feedback');
  assert.ok(criterion, 'a probe should have been derived for the requested content');
  assert.equal(criterion.status, 'not_satisfied');
  assert.equal(criterion.probe.origin, 'lexicon');
  assert.match(criterion.probe.justification, /testimonials/, 'the probe must cite the request');
});

test('a qualifier in the request keeps the criterion unverified rather than satisfied', () => {
  const env = setup();
  env.engine.ingest({ id: 'event-signed', type: 'email.received', payload: {
    id: 'signed-1', from: 'lee@example.test', subject: 'Vertex report',
    body: 'Please update the Vertex report with the signed customer testimonials and send it by Friday.'
  } });
  const task = () => env.store.state.tasks['request:signed-1'];
  env.engine.ingest({ id: 'event-signed-doc', type: 'document.modified', payload: {
    id: 'vertex-report', kind: 'report', title: 'Vertex report',
    content: '# Vertex report\n\n## Testimonials\nCustomers say the new flow is much faster to complete.\n'
  } });
  const criterion = task().evidence.criteria.find(item => item.id === 'customer_feedback');
  assert.ok(criterion, 'the testimonials section should be found');
  assert.equal(criterion.status, 'unknown', 'unsigned testimonials must not satisfy a request for signed ones');
  assert.match(criterion.note, /not marked as signed/);
  assert.equal(task().assessment.complete, false);
  assert.equal(task().draft, null);
});

test('requested content with no searchable terms stays explicitly unverifiable', () => {
  const env = setup();
  env.engine.ingest({ id: 'event-nothing', type: 'email.received', payload: {
    id: 'nothing-1', from: 'lee@example.test', subject: 'Vertex report',
    body: 'Please update the Vertex report with the thing and send it by Friday.'
  } });
  const vague = env.store.state.tasks['request:nothing-1'];
  env.engine.ingest({ id: 'event-nothing-doc', type: 'document.modified', payload: {
    id: 'vertex-report', kind: 'report', title: 'Vertex report', content: '# Vertex report\n\nEverything is attached.\n'
  } });
  assert.equal(vague.assessment.complete, false);
  assert.equal(vague.status, 'waiting_for_information');
  assert.ok(vague.evidence.unknowns.some(item => item.id === 'no_verifiable_criteria'));
});

test('two equally matching documents are reported as ambiguous rather than guessed', () => {
  const env = setup();
  env.engine.ingest(email());
  // Neither title is named verbatim in the request, so the candidates really are
  // indistinguishable and the system must refuse to choose between them.
  env.engine.ingest({ id: 'event-dup-a', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar proposal draft', content: complete('Northstar')
  } });
  env.engine.ingest({ id: 'event-dup-b', type: 'document.modified', payload: {
    id: 'northstar-proposal-revision', kind: 'proposal', title: 'Northstar proposal revision', content: complete('Northstar')
  } });
  assert.equal(task(env).assessment.complete, false);
  assert.ok(task(env).evidence.conflicts.some(item => item.id === 'ambiguous_document'));
  assert.equal(task(env).draft, null);
});

test('re-publishing the same run does not duplicate work or create new history entries', () => {
  const env = setup();
  env.engine.ingest(run('run-a', '2026-10-16T09:00:00.000Z'));
  ready(env);
  const before = env.store.state.revision;
  const duplicate = env.engine.ingest(run('run-a', '2026-10-16T09:00:00.000Z'));
  assert.equal(duplicate.duplicate, true);
  assert.equal(env.store.state.revision, before);
  assert.equal(Object.keys(env.store.state.tasks).length, 1);
});

test('the deterministic simulation scenario still produces the expected sequence end to end', () => {
  const env = setup();
  const startedAt = Date.parse('2026-10-16T09:00:00.000Z');
  const events = scenario(startedAt);
  assert.equal(events.length, 6);
  const simTask = () => env.store.state.tasks['request:mail-northstar-01'];

  env.engine.ingest(events[0].event);
  assert.equal(Object.keys(env.store.state.tasks).length, 0, 'a document alone is not a task');

  const emailResult = env.engine.ingest(events[1].event);
  assert.equal(emailResult.disposition, 'discovered_request');
  assert.equal(simTask().status, 'waiting_for_information');

  const unrelated = env.engine.ingest(events[2].event);
  assert.equal(unrelated.disposition, 'unrelated_change');
  assert.equal(env.store.state.outbox.length, 0);

  env.engine.ingest(events[3].event); // incomplete results
  assert.equal(simTask().status, 'waiting_for_information');
  assert.equal(simTask().draft, null);

  env.engine.ingest(events[4].event); // run published
  assert.equal(simTask().assessment.freshness.status, 'verified');
  assert.equal(simTask().status, 'waiting_for_information', 'still incomplete without control/treatment/conclusion');

  env.engine.ingest(events[5].event); // complete results
  assert.equal(simTask().status, 'ready_for_approval');
  assert.equal(simTask().assessment.complete, true);
  assert.equal(env.store.state.outbox.length, 0, 'nothing is sent before approval');
  assert.equal(simTask().draft.withheldClaims.length, 0);
  assert.match(simTask().draft.body, /\blatest\b/i);

  const approved = env.engine.approve('request:mail-northstar-01');
  assert.equal(approved.status, 'completed');
  assert.equal(env.store.state.outbox.length, 1);
  assert.equal(env.store.state.outbox[0].status, 'accepted_simulation');
});

test('every event carries its source so simulated activity is never presented as live', () => {
  const env = setup();
  const startedAt = Date.parse('2026-10-16T09:00:00.000Z');
  for (const entry of scenario(startedAt)) env.engine.ingest(entry.event);
  assert.ok(env.store.state.events.every(event => event.source === 'simulated'));
  assert.ok(env.store.state.events.every(event => event.connectorId === 'simulated'));
  const draft = env.store.state.tasks['request:mail-northstar-01'].draft;
  assert.equal(draft.simulationOnly, true);
  assert.equal(draft.live, false);
});
