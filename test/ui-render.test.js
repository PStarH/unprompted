import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { visibleAttentionItems } from '../public/ux-state.js';
import { taskState, workspaceConnections } from '../public/workspace-model.js';
import { copy as localizedCopy, ui as localizedUi, setLocale } from '../public/i18n.js';

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
  return `const copy = (value, params = {}) => value.replace(/\\{(\\w+)\\}/g, (match, key) => params[key] ?? match); const ui = (parts, ...values) => parts.reduce((result, part, index) => result + part + (index < values.length ? values[index] : ''), ''); const actionErrors = new Map(); const snoozes = {}; const isSnoozed = () => false; const isClosedTask = task => ['completed', 'cancelled'].includes(task.status) || (task.status === 'blocked' && !task.action);\n` + source.slice(start, end === -1 ? undefined : end);
}

function extractRawFunction(name) {
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
const renderPatchReview = new Function('escapeHtml', 'current', 'runtime', 'copy', 'ui',
  `${extractRawFunction('findDocumentPatch')}\n${extractRawFunction('renderPatchReview')}\nreturn renderPatchReview;`)(escapeHtml, {
  documentPatches: [{ id: 'patch-1', taskId: 'task-7', provider: 'local', status: 'prepared', baseDocument: { version: 3 }, changes: [{ text: 'source-backed content' }] }]
}, { shadow: false }, (value, params = {}) => String(value).replace(/\{(\w+)\}/g, (match, key) => params[key] ?? match), (parts, ...values) => parts.reduce((result, part, index) => result + part + (index < values.length ? values[index] : ''), ''));
const patchApplyTaskId = new Function(extractRawFunction('patchApplyTaskId') + '\nreturn patchApplyTaskId;')();
const renderTaskManagement = new Function('escapeHtml', 'current', 'copy', 'ui', 'isClosedTask', 'formatDate', 'formatTime', [
  'managementActionLabel', 'managementWakeCondition', 'priorityReasonLabel', 'managementReasonLabel', 'renderTaskManagement'
].map(extractRawFunction).join('\n') + '\nreturn renderTaskManagement;')(
  escapeHtml, { documents: [] }, localizedCopy, localizedUi,
  task => ['completed', 'cancelled'].includes(task.status) || (task.status === 'blocked' && !task.action),
  value => new Date(value).toISOString().slice(0, 10), value => new Date(value).toISOString().slice(11, 16)
);

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

test('a prepared patch keeps its owning task ID through the review and apply control', () => {
  const html = renderPatchReview({ id: 'task-7', documentId: 'doc-1', documentPatches: ['patch-1'], status: 'waiting_for_information' });
  assert.match(html, /data-patch-apply="task-7" data-patch-id="patch-1"/);
  assert.equal(patchApplyTaskId({ dataset: { patchApply: 'task-7' } }), 'task-7');
  assert.equal(patchApplyTaskId({ dataset: { patchId: 'patch-1' } }), null, 'the patch ID is not mistaken for its owning task ID');
});

test('management summaries translate fixed labels but preserve source dates', () => {
  setLocale('zh-CN');
  try {
    const html = renderTaskManagement({
      id: 'task-1', status: 'waiting_for_information',
      request: { deadline: { text: 'October 30' } },
      management: {
        owner: { label: 'You' },
        nextAction: { kind: 'assess', label: 'Check current source documents against the request', reason: 'The task has not yet completed its evidence assessment.' },
        dependencies: [],
        wake: { kind: 'time', at: '2026-10-30T23:59:00Z', status: 'scheduled' },
        priority: { level: 'high', score: 90, reasons: ['Deadline is within 1 day (2026-10-30).'] }
      }
    });
    assert.match(html, /责任人: 你/);
    assert.match(html, /对照请求检查当前来源文档/);
    assert.match(html, /在截止时间前重新核对：October 30/);
    assert.match(html, /截止日期将在 1 天内（2026-10-30）/);
    assert.doesNotMatch(html, /Check current source documents|Recheck before the deadline|Deadline is within 1 day/);
  } finally { setLocale('en'); }
});

test('the overview gives a next step without asking users to configure every task', () => {
  setLocale('en');
  const task = { id: 'waiting', status: 'waiting_for_information', management: {
    wake: { kind: 'reply' }, nextAction: { kind: 'wait' }, priority: { score: 50 }
  } };
  const html = renderTaskManagement(task, { compact: true });
  assert.match(html, /Recheck when the email thread gets a reply/);
  assert.match(html, /Adjust follow-up/);
  assert.doesNotMatch(html, /<form|<select|<input|\(50\)/);
});

test('a saved time wait shows the chosen time rather than the request deadline', () => {
  setLocale('en');
  const task = { id: 'timed', status: 'waiting_for_information', request: { deadline: { text: 'Friday' } },
    wait: { kind: 'time', status: 'active', until: '2026-10-28T12:30:00Z' },
    management: { wake: { kind: 'time', waitId: 'wait:timed:1', at: '2026-10-28T12:30:00Z', status: 'active' } }
  };
  const html = renderTaskManagement(task);
  assert.match(html, /Check again at 2026-10-28 12:30/);
  assert.doesNotMatch(html, /Friday/);
  assert.match(html, /value="time" selected/);
  assert.match(html, /data-wait-until="timed" value="2026-10-28T/);
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

const isClosedTask = task => ['completed', 'cancelled'].includes(task.status) || (task.status === 'blocked' && !task.action);
const needsTaskDecision = task => task.status === 'ready_for_approval' || (task.status === 'blocked' && Boolean(task.action));
const attentionItems = new Function('visibleAttentionItems', `${extractFunction('attentionItems')}\nreturn attentionItems;`)(visibleAttentionItems);
const agentPresentation = new Function('needsTaskDecision', 'attentionItems',
  `${extractFunction('agentPresentation')}\nreturn agentPresentation;`)(needsTaskDecision, attentionItems);
const taskPresentation = new Function(`${extractFunction('taskPresentation')}\nreturn taskPresentation;`)();
const taskTitle = new Function(`${extractFunction('taskTitle')}\nreturn taskTitle;`)();
const renderTaskAction = new Function('escapeHtml', 'runtime', 'taskTitle', 'taskState', 'workspaceConnections', 'setupState', 'nativeCopy', 'safeLink', 'current', 'sourceFollow',
  `${extractFunction('renderTaskAction')}\nreturn renderTaskAction;`)(escapeHtml, runtimeState, taskTitle, taskState, workspaceConnections, null, zh => zh, value => value, { durable: true },
  task => task?.kind === 'observed_task' || ['external_issue', 'external_review', 'external_change', 'external_check'].includes(task?.kind));

test('an offline workspace never claims to be idle, working or up to date', () => {
  for (const status of ['completed', 'investigating', 'waiting_for_information', 'ready_for_approval']) {
    const presentation = agentPresentation({ tasks: [{ status }] }, false);
    assert.equal(presentation.tone, 'offline');
    assert.match(presentation.description, /上次收到的进展/);
  }
});

test('waiting for evidence has no working state and explains what will resume it', () => {
  const task = { status: 'waiting_for_information', evidence: { criteria: [{ status: 'satisfied' }, { status: 'unverified' }] } };
  assert.equal(taskPresentation(task).tone, 'waiting');
  assert.match(taskPresentation(task).description, /1 项要求缺少证据/);
  assert.equal(agentPresentation({ tasks: [task] }, true).tone, 'waiting');
  assert.equal(agentPresentation({ tasks: [{ status: 'verifying' }] }, true).tone, 'working');
  assert.equal(agentPresentation({ tasks: [{ status: 'completed' }] }, true).tone, 'idle');
});

test('delivery uncertainty offers reconciliation rather than unconfirmed duplicate sending', () => {
  const task = { id: 'request:uncertain', status: 'blocked', action: { status: 'unknown' } };
  const html = renderTaskAction(task);
  assert.match(html, /data-action="reconcile"/);
  assert.doesNotMatch(html, /data-action="(?:approve|retry)"|data-automate/);
  assert.equal(isClosedTask(task), false);
  assert.equal(isClosedTask({ status: 'blocked' }), true);
  assert.equal(attentionItems({ tasks: [task], notifications: [{ kind: 'blocker', taskId: task.id }] }).length, 0);
  assert.equal(agentPresentation({ tasks: [task], notifications: [{ kind: 'blocker', taskId: task.id }] }, true).title, '1 个选择需要你，其余的我来照看。');
});

test('standing authority is offered only with a named scope, standard evidence and writable runtime', () => {
  const task = { id: 'request:scoped', status: 'ready_for_approval', request: { subjectEntity: 'Northstar', deliverable: 'proposal' }, draft: { to: 'alex@example.test', subject: 'Follow up', body: 'Prepared reply', live: false } };
  assert.doesNotMatch(renderTaskAction(task), /data-action="approve"|data-automate/);
  runtimeState.shadow = false;
  try {
    assert.match(renderTaskAction(task), /data-automate="request:scoped"/);
    assert.match(renderTaskAction(task), /仅适用于 Northstar · proposal/);
    assert.doesNotMatch(renderTaskAction({ ...task, request: {} }), /data-automate/);
    assert.doesNotMatch(renderTaskAction({ ...task, verification: { depth: 'enhanced' } }), /data-automate/);
    assert.match(renderTaskAction({ ...task, verification: { depth: 'enhanced' } }), /data-action="approve"/);
  } finally { runtimeState.shadow = true; }
});

test('the compact draft escapes sender content, scope and task identifiers', () => {
  const html = renderTaskAction({ id: '\" onclick=\"alert(1)', status: 'ready_for_approval', request: { subjectEntity: '<script>bad()</script>', deliverable: 'proposal' }, draft: { to: '<img src=x onerror=bad()>', subject: '<script>bad()</script>', body: '<iframe src=x></iframe>' } });
  assert.doesNotMatch(html, /<script>|<img|<iframe|data-preserve="[^\"]*" onclick=/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;iframe/);
});

test('a stale user-edited draft remains visible for explicit review without an approval action', () => {
  const html = renderTaskAction({ id: 'request:one', status: 'waiting_for_information', userDraftStale: true, inputVersion: 1, processedInputVersion: 1, assessment: { complete: true }, draft: { userEdited: true, body: '<script>user text</script>' } });
  assert.match(html, /data-edit-draft="request:one"/);
  assert.match(html, /&lt;script&gt;user text&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|data-action="approve"/);
});

test('first-use empty states follow the selected language across overview, activity, context and agreements', () => {
  const cases = [
    ['renderEvents', []], ['renderHistory', []],
    ['renderContext', { documents: [], runs: [] }],
    ['renderGrants', { calibrations: [] }], ['renderConnectors', undefined]
  ];
  try {
    for (const locale of ['en', 'zh-CN']) {
      setLocale(locale);
      for (const [name, input] of cases) {
        const render = new Function('copy', 'ui', 'runtime', 'escapeHtml', `${extractRawFunction(name)}\nreturn ${name};`)(localizedCopy, localizedUi, null, escapeHtml);
        const html = render(input);
        if (locale === 'en') assert.doesNotMatch(html, /\p{Script=Han}/u, name);
        else assert.match(html, /\p{Script=Han}/u, name);
      }
    }
  } finally { setLocale('en'); }
});
