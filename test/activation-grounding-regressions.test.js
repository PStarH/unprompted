import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverRequestCandidateWithReasoner } from '../src/requests.js';
import { commitmentScope, sameCommitment } from '../src/commitments.js';

const quoted = '> Forwarded: update the Atlas proposal with the latest experiment results.';
const suggestion = { deliverable: 'proposal', deliverableQuote: 'proposal', subjectEntity: 'Atlas', entityQuote: 'Atlas', intent: 'update', intentQuote: 'Please handle this for me', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results' }] };
const mail = body => ({ id: 'delegation', from: 'sam@example.test', to: 'user@example.test', subject: 'Fwd: work', body });
test('explicit active delegation retains forwarded target and requirements as source evidence', async () => {
  let observed;
  const reasoner = { available: () => true, discoverRequestCandidate: async input => { observed = input; return suggestion; } };
  const result = await recoverRequestCandidateWithReasoner(mail(`Please handle this for me.\n${quoted}`), reasoner);
  assert.ok(result);
  assert.equal(result.requiredContent[0]?.sourceQuote, 'experiment results');
  assert.match(result.text, /Forwarded: update the Atlas proposal/);
  assert.match(observed.body, /Forwarded: update the Atlas proposal/);
});
test('quoted delegation and explicit refusal never become actionable from a model claim', async () => {
  let calls = 0;
  const reasoner = { available: () => true, discoverRequestCandidate: async () => { calls++; return suggestion; } };
  for (const body of [`FYI.\n> Please handle this for me.\n${quoted}`, `Please don't handle this for me.\n${quoted}`]) {
    assert.equal(await recoverRequestCandidateWithReasoner(mail(body), reasoner), null);
  }
  assert.equal(calls, 0);
});
test('account-qualified thread commitments merge only within the same known connection', () => {
  const source = { id: 'one', threadId: 'thread', connectorId: 'google', accountId: 'account-A', from: 'sam@example.test', to: 'user@example.test' };
  const a = { source, subjectEntity: 'Atlas', deliverable: 'proposal' };
  const b = { ...a, source: { ...source, id: 'two' } };
  assert.equal(sameCommitment(a, b), true);
  const foreign = { ...b, source: { ...b.source, accountId: 'account-B' } };
  assert.equal(sameCommitment(a, foreign), false);
  assert.notEqual(commitmentScope(a).key, commitmentScope(foreign).key);
  assert.equal(sameCommitment(a, { ...b, source: { ...b.source, accountId: null } }), false);
});
