import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Rendering of the strategy layer's stop decisions.
 *
 * The established technique: pull the render
 * function out of public/app.js and evaluate it against the same shape
 * /api/state returns, rather than trusting a screenshot. "We chose not to act"
 * has to be visible in the product, and it has to be the recorded reason.
 */

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in public/app.js`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const renderParked = new Function('escapeHtml', `${extractFunction('renderParked')}\nreturn renderParked;`)(escapeHtml);
const renderMetrics = new Function('escapeHtml', `${extractFunction('renderMetrics')}\nreturn renderMetrics;`)(escapeHtml);
const renderVerification = new Function('escapeHtml', 'current', `${extractFunction('renderVerification')}\nreturn renderVerification;`)(escapeHtml, {
  documents: [{ id: 'zephyr-retrospective', title: 'Zephyr service retrospective' }]
});

const runtimeState = { shadow: true, mode: 'simulation' };
const renderApproval = new Function('escapeHtml', 'current', 'runtime', 'renderVerification', 'time',
  `${extractFunction('renderApproval')}\nreturn renderApproval;`)(escapeHtml, { documents: [] }, runtimeState, () => '', () => '12:00:00');

test('a parked decision renders with its recorded reason, and proposed ones do not', () => {
  const html = renderParked([
    {
      id: 'opportunity:extend_verification:blorf', kind: 'extend_verification', status: 'parked',
      statement: 'Add verification coverage for “blorf” so a request asking for it can be checked.',
      reason: 'The evidence is not yet sufficient to justify action.',
      nextStep: 'Define a probe for “blorf” that must cite the text it matched.'
    },
    { id: 'opportunity:x', kind: 'verify_freshness', status: 'proposed', statement: 'This one is a live decision.' }
  ]);
  assert.match(html, /Considered and not pursued \(1\)/);
  assert.match(html, /The evidence is not yet sufficient to justify action\./, 'the recorded reason is what is shown');
  assert.match(html, /If pursued later: Define a probe/);
  assert.doesNotMatch(html, /live decision/, 'proposed suggestions render as decision cards, not here');
});

test('nothing parked renders nothing', () => {
  assert.equal(renderParked([]), '');
  assert.equal(renderParked(undefined), '');
  assert.equal(renderParked([{ status: 'proposed' }, { status: 'accepted' }]), '');
});

test('the absorbed-work estimate renders with its provenance note', () => {
  const metrics = {
    discovery: { valuableRate: 1, valuable: 2, discovered: 2, unservableRate: 0, unservable: 0 },
    completion: { verifiableCompletionRate: 1, verifiedCompletions: 2, preparedActions: 2, withheldClaims: 0 },
    attention: { interruptions: 1, unresolved: 0, takeovers: 0 },
    events: { real: 3, ingested: 5 },
    sync: { failures: 0 },
    value: { estimatedManualStepsAvoided: 2, note: 'estimate' }
  };
  const html = renderMetrics(metrics);
  assert.match(html, /Follow-throughs absorbed/);
  assert.match(html, /an estimate, not wall-clock time/, 'the estimate never presents itself as measured time');
  const without = renderMetrics({ ...metrics, value: null });
  assert.doesNotMatch(without, /Follow-throughs absorbed/);
});

test('strengthened verification renders its basis and what was actually checked', () => {
  const html = renderVerification({
    id: 'request:m1',
    verification: {
      depth: 'enhanced',
      basis: [{ code: 'competing_sources', detail: 'One other plausible document exists (zephyr-retrospective); its version of the requested facts is checked independently.' }],
      checkedDocuments: ['zephyr-retrospective'],
      performed: [{ documentId: 'zephyr-retrospective', criterionId: 'incident_stats', outcome: 'conflict' }]
    }
  });
  assert.match(html, /STRENGTHENED VERIFICATION/);
  assert.match(html, /checked independently/, 'the recorded basis is what is shown');
  assert.match(html, /Zephyr service retrospective/, 'the document that was checked is named');
  assert.match(html, /disagrees on 1 point/);
});

test('baseline verification renders nothing, so an ordinary task is not decorated', () => {
  assert.equal(renderVerification({ verification: { depth: 'standard', basis: [], performed: [] } }), '');
  assert.equal(renderVerification({}), '');
});

test('the verification-depth metric renders with what it counted', () => {
  const html = renderMetrics({
    discovery: { valuableRate: 1, valuable: 1, discovered: 1, unservableRate: 0, unservable: 0 },
    completion: { verifiableCompletionRate: 1, verifiedCompletions: 1, preparedActions: 1, withheldClaims: 0 },
    attention: { interruptions: 0, unresolved: 0, takeovers: 0 },
    events: { real: 1, ingested: 1 },
    sync: { failures: 0 },
    verification: { enhanced: 1, standard: 2, corroborations: 1, sourceConflicts: 0 }
  });
  assert.match(html, /Source checks/);
  assert.match(html, /2 needed no extra check/);
  assert.match(html, /1 corroborated/);
});

test('a ready reply in the default run says why it is held and how to watch the full local loop', () => {
  const task = {
    id: 'request:m-northstar-01', status: 'ready_for_approval',
    subject: 'Northstar proposal — experiment results', sender: 'alex@example.test',
    request: { source: { kind: 'email' } },
    evidence: { criteria: [{ id: 'sample_size', status: 'satisfied', label: 'the sample size' }] },
    draft: {
      to: 'alex@example.test', subject: 'Re: Northstar proposal — experiment results',
      body: 'Hi,\n\nThe Northstar proposal has been updated as requested.',
      documentUrl: 'http://127.0.0.1:4173/documents/northstar-proposal', documentVersion: 3,
      withheldClaims: [], live: false
    }
  };
  const shadowedSimulation = renderApproval(task);
  assert.match(shadowedSimulation, /Shadow mode is read-only/, 'the refusal is stated on the card');
  assert.match(shadowedSimulation, /UNPROMPTED_SHADOW_MODE=false/, 'the default run names the opt-out that reaches approval and verification');
  assert.doesNotMatch(shadowedSimulation, /data-action="approve"/, 'no external write control is offered in shadow mode');

  runtimeState.mode = 'live';
  assert.doesNotMatch(renderApproval(task), /UNPROMPTED_SHADOW_MODE=false/, 'a live workspace is not promised a simulated restart');

  runtimeState.mode = 'simulation';
  runtimeState.shadow = false;
  const optedOut = renderApproval(task);
  assert.match(optedOut, /data-action="approve"/, 'with the documented opt-out the approval control appears');
  assert.match(optedOut, /simulated outbox only/, 'and delivery is still described as local');
  runtimeState.shadow = true;
});
