import { createInteractions } from './interactions.js';
import { createWorkspace } from './workspace.js';
import { createMcpPanel } from './mcp.js';
import { createDurablePanel } from './durable.js';
import { createArtifactPanel } from './artifacts.js';
import { taskState, stateGroup, workspaceConnections } from './workspace-model.js';
import { preserveInteraction } from './dom-state.js';
import { copy, ui, getLocale, setLocale, applyLanguage, formatTime, formatDate } from './i18n.js';
import { readLocal, writeLocal, workspaceKey, taskFingerprint, isSnoozed, workspaceSnapshot, changesSince, stableTaskOrder, matchesTask, visibleAttentionItems } from './ux-state.js';
const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const safeLink = value => { try { if (!value) return null; const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
const time = formatTime;
const statusNames = {
  newly_discovered: 'Newly discovered', investigating: 'Investigating',
  waiting_for_information: 'Waiting for evidence', ready_for_approval: 'Ready for approval',
  verifying: 'Verifying', completed: 'Verified complete', blocked: 'Needs attention',
  cancelled: 'Closed'
};
const freshnessNames = {
  verified: 'Freshness verified', stale: 'Stale evidence', unverified: 'Freshness unverified', contradictory: 'Contradictory evidence'
};
let current = null;
let runtime = null;
let artifactUI = null;
let busy = false;
let toastTimer = null;
let lastToast = null;
let stateStream = null;
const expandedTasks = new Set();
const nativeCopy = (zh, en) => getLocale() === 'en' ? en : zh;
const googleSearch = { account: null, sequence: 0, next: null, source: null, query: null };

function updateGoogleSearchAvailability() {
  const panel = byId('googleSearchPanel'), form = byId('googleSearchForm');
  const google = setupState?.google, options = google?.capabilities?.search || [];
  const account = google?.configuredThisRun && !google.runtimeDisabled ? `${setupState.workspace?.id || ''}:${google.accountEmail || ''}` : null;
  if (googleSearch.account !== account) {
    googleSearch.account = account; googleSearch.sequence++; googleSearch.next = null;
    form.reset(); byId('googleSearchResults').replaceChildren(); byId('googleSearchStatus').textContent = '';
    form.querySelector('[type=submit]').disabled = false; byId('googleSearchMore').disabled = false; byId('googleSearchMore').hidden = true;
  }
  panel.hidden = !account || !options.length;
  for (const option of form.elements.source.options) option.disabled = !options.includes(option.value === 'gmail' ? 'gmail.messages' : 'drive.google_docs');
  if (form.elements.source.selectedOptions[0]?.disabled) form.elements.source.value = options.includes('gmail.messages') ? 'gmail' : 'drive';
}

async function searchGoogle(more = false) {
  const form = byId('googleSearchForm'), source = more ? googleSearch.source : form.elements.source.value;
  const query = more ? googleSearch.query : form.elements.query.value.trim();
  if (!query || !googleSearch.account || more && !googleSearch.next) return;
  const sequence = ++googleSearch.sequence, account = googleSearch.account;
  const pageToken = more ? googleSearch.next : null;
  if (!more) { googleSearch.source = source; googleSearch.query = query; googleSearch.next = null; byId('googleSearchResults').replaceChildren(); }
  const button = form.querySelector('[type=submit]'), moreButton = byId('googleSearchMore');
  button.disabled = true; moreButton.disabled = true;
  byId('googleSearchStatus').textContent = nativeCopy('正在搜索…', 'Searching…');
  try {
    const result = await postJSON('/api/connectors/google/search', { source, query, ...(pageToken ? { pageToken } : {}) });
    if (sequence !== googleSearch.sequence || account !== googleSearch.account) return;
    const root = byId('googleSearchResults');
    for (const item of result.items) {
      if (source === 'gmail') {
        const details = document.createElement('details'), summary = document.createElement('summary'), sender = document.createElement('small'), body = document.createElement('pre');
        summary.textContent = item.subject || nativeCopy('无主题', 'No subject'); sender.textContent = item.from || ''; body.textContent = item.body || '';
        details.append(summary, sender, body); root.append(details);
      } else {
        const link = document.createElement('a');
        const url = new URL(item.url);
        if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') continue;
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.title;
        root.append(link);
      }
    }
    googleSearch.next = result.nextPageToken; moreButton.hidden = !googleSearch.next;
    byId('googleSearchStatus').textContent = root.childElementCount ? '' : nativeCopy('没有找到结果。', 'No results found.');
  } catch {
    if (sequence === googleSearch.sequence) byId('googleSearchStatus').textContent = nativeCopy('搜索未完成，请检查连接后重试。', 'Search failed. Check your connection and try again.');
  } finally {
    if (sequence === googleSearch.sequence) { button.disabled = false; moreButton.disabled = false; }
  }
}

byId('googleSearchForm').addEventListener('submit', event => { event.preventDefault(); void searchGoogle(); });
byId('googleSearchForm').addEventListener('input', () => { googleSearch.sequence++; googleSearch.next = null; byId('googleSearchMore').hidden = true; byId('googleSearchForm').querySelector('[type=submit]').disabled = false; byId('googleSearchStatus').textContent = ''; });
byId('googleSearchMore').addEventListener('click', () => { void searchGoogle(true); });

function toast(message, isError = false, action = null) {
  const element = byId('toast');
  lastToast = { message, isError, action };
  element.replaceChildren(document.createTextNode(copy(message)));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = copy(action.label);
    button.dataset.toastReopen = action.taskId;
    element.append(button);
  }
  element.className = ui`toast visible${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.className = 'toast', action || isError ? 12000 : 4500);
}

/** A source reference must always show where a fact came from. */
function sourceLabel(source) {
  if (!source) return copy('source unavailable');
  return [source.id, source.version != null ? ui`v${source.version}` : null, source.locator, source.timestamp ? time(source.timestamp) : null]
    .filter(Boolean).join(' · ');
}

function renderCriteria(task) {
  const criteria = task.evidence?.criteria || [];
  if (!criteria.length) {
    return ui`<p class="mini-note">No verifiable content criteria were derived from this request yet.</p>`;
  }
  return criteria.map(item => {
    const met = item.status === 'satisfied';
    const evidence = item.evidence?.[0];
    return ui`<div class="criterion ${met ? 'met' : 'unmet'}">
      <span class="criterion-mark" aria-hidden="true">${met ? '✓' : '○'}</span>
      <div class="criterion-body">
        <strong>${escapeHtml(item.label)}</strong>
        ${met && evidence
          ? ui`<p class="criterion-value">“${escapeHtml(evidence.excerpt || evidence.detail || '')}”</p><small class="source-ref">${escapeHtml(sourceLabel(evidence.source))}</small>`
          : ui`<p class="criterion-value muted">Not found in the document.</p>${item.note ? ui`<small class="source-ref">${escapeHtml(item.note)}</small>` : ''}`}
      </div></div>`;
  }).join('');
}

function renderClaims(task) {
  const claims = task.evidence?.claims || [];
  if (!claims.length) return '';
  return ui`<div class="claim-block"><div class="mini-heading">STATEMENTS THE REPLY WOULD MAKE</div>${claims.map(item => ui`
    <div class="claim ${item.supported ? 'supported' : 'withheld'}">
      <span class="claim-mark" aria-hidden="true">${item.supported ? '✓' : '—'}</span>
      <div><strong>${escapeHtml(item.text)}</strong><small>${item.supported ? copy('Supported by evidence') : escapeHtml(item.note || copy('Not supported by evidence, so it was withheld.'))}</small></div>
    </div>`).join('')}</div>`;
}

function renderUnknowns(task) {
  const unknowns = task.evidence?.unknowns || [];
  const conflicts = task.evidence?.conflicts || [];
  if (!unknowns.length && !conflicts.length) return '';
  return ui`<div class="unknown-block"><div class="mini-heading">EXPLICITLY UNKNOWN</div>
    ${conflicts.map(item => ui`<div class="unknown-item conflict"><strong>${escapeHtml(item.detail)}</strong></div>`).join('')}
    ${unknowns.map(item => ui`<div class="unknown-item"><strong>${escapeHtml(item.question)}</strong><small>${escapeHtml(item.reason)} ${escapeHtml(item.whatWouldResolveIt || '')}</small></div>`).join('')}</div>`;
}

/**
 * When a decision needs more than the baseline checks, record why and what was
 * actually performed — not just which level was assigned.
 */
function renderVerification(task) {
  const verification = task.verification;
  if (!verification || verification.depth !== 'enhanced') return '';
  const basis = (verification.basis || []).map(item => item.detail).join(' ');
  const performed = verification.performed || [];
  const checked = [...new Set(verification.checkedDocuments || [])];
  const summaries = checked.map(id => {
    const title = (current?.documents || []).find(document => document.id === id)?.title || id;
    const count = outcome => performed.filter(entry => entry.documentId === id &&
      (outcome === 'conflict' ? entry.outcome.startsWith('conflict') : entry.outcome === outcome)).length;
    const parts = [
      count('corroborated') ? ui`agrees on ${count('corroborated')} point(s)` : null,
      count('conflict') ? ui`disagrees on ${count('conflict')} point(s)` : null,
      count('superseded') ? ui`reports an older reading on ${count('superseded')} point(s)` : null
    ].filter(Boolean);
    return ui`<div class="unknown-item"><strong>Checked “${escapeHtml(title)}” as a competing source</strong><small>${escapeHtml(parts.join('; ') || 'no comparable content found')}</small></div>`;
  }).join('');
  return ui`<div class="unknown-block"><div class="mini-heading">STRENGTHENED VERIFICATION</div>
    <div class="unknown-item"><strong>Why more than the baseline checks</strong><small>${escapeHtml(basis || copy('A competing plausible source exists.'))}</small></div>
    ${summaries}</div>`;
}

function renderFreshness(task) {
  const freshness = task.evidence?.freshness;
  if (!freshness || freshness.status === 'not_required') return '';
  return ui`<div class="freshness ${escapeHtml(freshness.status)}"><span class="freshness-badge">${escapeHtml(copy(freshnessNames[freshness.status] || freshness.status))}</span>
    <p>${escapeHtml(freshness.reason)}</p>
    ${freshness.documentRunDate ? ui`<small class="source-ref">Document run date: ${escapeHtml(freshness.documentRunDate)}${freshness.newestRun ? ui` · newest known run: ${escapeHtml(freshness.newestRun)}` : ''}</small>` : ''}</div>`;
}

const interpretationNames = {
  deterministic: 'deterministically',
  'deterministic+model': 'deterministically, with model help',
  model: 'by the model provider',
  migrated: 'from an earlier record, re-derived on startup'
};

function renderReview(task) {
  const feedback = task.feedback;
  const currentLabel = feedback?.label || '';
  const choices = [
    ['useful', copy('Useful')],
    ['not_useful', copy('Not useful')]
  ];
  const buttons = choices.map(([value, text]) =>
    ui`<button type="button" class="secondary-button${currentLabel === value ? ' review-chosen' : ''}" data-feedback="${value}" data-id="${escapeHtml(task.id)}">${text}</button>`).join('');
  const corrections = [
    ['not_mine', copy('Not mine')], ['duplicate', copy('Duplicate')],
    ['already_handled', copy('Already handled')], ['wrong_association', copy('Wrong document link')]
  ];
  const correctionButtons = corrections.map(([value, text]) =>
    ui`<button type="button" class="subtle-button" data-feedback="${value}" data-id="${escapeHtml(task.id)}">${text}</button>`).join('');
  const relatedTasks = (current?.tasks || []).filter(item => item.id !== task.id);
  const relatedSelect = relatedTasks.length ? ui`<label class="reason-field">${copy('If duplicate, link it to')}<select data-related-task-for="${escapeHtml(task.id)}"><option value="">${copy('Choose related task')}</option>${relatedTasks.map(item => ui`<option value="${escapeHtml(item.id)}">${escapeHtml(taskTitle(item))}</option>`).join('')}</select></label>` : '';
  const correction = task.feedbackCorrection;
  const note = currentLabel ? copy('反馈已记录。') : copy('记录这次跟进是否有帮助，便于回看和改进。');
  return ui`<div class="review-row"><span class="review-label">${copy('这次跟进有帮助吗？')}</span>${buttons}<label class="reason-field">${copy('原因，可选')}<input type="text" maxlength="280" data-reason-for="${escapeHtml(task.id)}" value="${escapeHtml(feedback?.reason || '')}"></label><small>${escapeHtml(note)}</small>
    <span class="review-label">${copy('纠正后续发现')}</span>${correctionButtons}${relatedSelect}
    ${correction?.id && !correction.undoneAt ? ui`<small>${copy('此纠正只影响匹配范围')}: ${escapeHtml(correction.label)}</small><button type="button" class="text-button" data-undo-feedback="${escapeHtml(correction.id)}">${copy('撤销这项纠正')}</button>` : ''}
  </div>`;
}

function patchCandidates(task) {
  const unique = new Map();
  for (const criterion of task.evidence?.criteria || []) for (const item of criterion.evidence || []) {
    const source = item.source;
    const quote = item.excerpt;
    if (!source || !['document', 'email'].includes(source.kind) || !source.id || !quote || quote.length > 5000 || quote.endsWith('…')) continue;
    const candidate = {
      source: { kind: source.kind, id: source.id, ...(source.version != null ? { version: source.version } : {}), quote },
      label: criterion.label || criterion.id || copy('source excerpt')
    };
    unique.set(JSON.stringify(candidate.source), candidate);
  }
  return [...unique.values()];
}

function findDocumentPatch(state, patchId) {
  const patches = state?.documentPatches;
  return Array.isArray(patches) ? patches.find(patch => patch.id === patchId) : patches?.[patchId];
}

function patchApplyTaskId(button) {
  return button?.dataset?.patchApply || null;
}

function renderPatchReview(task) {
  const patches = (task.documentPatches || []).map(id => findDocumentPatch(current, id)).filter(Boolean);
  const rows = patches.map(patch => {
    const content = (patch.changes || []).map(change => change.text).join('\n');
    const stateLabel = copy(`patch:${patch.status}`);
    const statusTone = patch.status === 'applied' ? 'done' : ['blocked', 'stale', 'failed'].includes(patch.status) ? 'offline' : 'waiting';
    return ui`<article class="patch-review-row"><div class="patch-review-heading"><strong>${copy('文档补丁')} · ${escapeHtml(patch.provider)}</strong><span class="state-badge ${statusTone}">${escapeHtml(stateLabel)}</span></div>
      <p>${copy('基础版本')} v${escapeHtml(patch.baseDocument?.version)} · ${copy('来源')} ${escapeHtml((patch.changes || []).length)} ${copy('条')}</p><blockquote>${escapeHtml(content || patch.blockers?.join(' ') || copy('没有可应用的来源文本。'))}</blockquote>
      ${(patch.blockers || []).length ? ui`<ul class="patch-blockers">${patch.blockers.map(item => ui`<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      ${patch.status === 'prepared' ? ui`<label class="patch-consent"><input type="checkbox" data-patch-confirm="${escapeHtml(patch.id)}" data-preserve-context="${escapeHtml(JSON.stringify([patch.baseDocument, patch.changes]))}">${runtime?.shadow ? copy('我已审阅这段内容；只做只读核对，不改动文档。') : copy('我已审阅准确内容，并授权应用到此版本。')}</label><button type="button" class="${runtime?.shadow ? 'secondary-button' : 'primary-button'}" data-patch-apply="${escapeHtml(task.id)}" data-patch-id="${escapeHtml(patch.id)}" data-patch-mode="${runtime?.shadow ? 'shadow_read_only' : 'explicit'}" disabled>${runtime?.shadow ? copy('只读复核补丁') : copy('应用此补丁并读回核验')}</button>` : ''}
      ${patch.result?.readbackVerified ? ui`<small>${copy('应用后已读回核验')} · ${copy(patch.simulated ? '本地模拟' : 'Google Docs')}</small>` : ''}
    </article>`;
  }).join('');
  if ((!task.documentId || ['completed', 'cancelled'].includes(task.status)) && !patches.length) return '';
  return ui`<section class="patch-review" aria-label="${copy('文档补丁审阅入口')}"><div class="mini-heading">${copy('文档补丁审阅入口')}</div>
    <p>${copy('我会从当前缺少的要求中寻找有来源的原文片段。没有直接证据、来源冲突或版本过期时会明确阻止；准备不会修改文档。')}</p>
    ${task.documentId && !['completed', 'cancelled'].includes(task.status) ? ui`<form class="patch-prepare-form" data-patch-form="${escapeHtml(task.id)}"><button type="submit" class="secondary-button">${copy('根据证据准备补丁供审阅')}</button></form>` : ''}
    ${rows}
  </section>`;
}

function renderWork(task) {
  const document = current.documents.find(item => item.id === task.documentId);
  const found = Boolean(document);
  const request = task.request;
  const status = copy(statusNames[task.status] || task.status);
  const documents = task.evidence?.documents?.[0];
  const correlation = documents ? ui`${documents.correlationScore >= 0.7 ? 'Strong' : documents.correlationScore >= 0.6 ? 'Plausible' : 'Weak'} match` : copy('No match yet');
  const whyLinked = (documents?.correlationReasons || []).filter(Boolean).join(' ');
  const deadline = request.deadline
    ? request.deadline.ambiguous
      ? ui`${request.deadline.text} (ambiguous — could be ${(request.deadline.candidates || []).join(' or ')})`
      : ui`${request.deadline.text} (${request.deadline.kind.replaceAll('_', ' ')})`
    : 'not specified';
  const origin = (current.events || []).find(event => event.type === 'email.received' && (event.relations || []).includes(task.id));
  const sourceLine = origin
    ? ui`<p class="work-description">Source <strong>${escapeHtml(origin.source)}</strong> via ${escapeHtml(origin.connectorId || 'unknown')}.${origin.source === 'simulated' ? ' Simulated — not a live provider.' : ' Read from the provider.'}</p>`
    : '';
  return ui`<article class="work-card">
    <div class="work-topline"><span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(status)}</span><span class="work-date">Discovered ${time(task.createdAt)}</span></div>
    <h3>${escapeHtml(request.subjectEntity)} ${escapeHtml(request.deliverable)} follow-through</h3>
    <p class="work-description">Requested action: <strong>${escapeHtml(request.intent.replaceAll('_', ' '))}</strong>. Deadline: ${escapeHtml(deadline)}. Interpreted ${escapeHtml(interpretationNames[task.evidence?.interpretation] || task.evidence?.interpretation || 'deterministically')}.</p>
    ${sourceLine}
    <div class="source-row"><span class="source-symbol">@</span><div><strong>Request from ${escapeHtml(task.sender)}</strong><small>${escapeHtml(task.subject)} · email id ${escapeHtml(request.source.id)}</small></div></div>
    <div class="progress-path">
      <div class="progress-step"><strong>Request noticed</strong>Extracted from the incoming email without being asked to look.</div>
      <div class="progress-step ${found ? '' : 'muted'}"><strong>${found ? copy('Context connected') : copy('Looking for the right document')}</strong>${found ? ui`Matched “${escapeHtml(document.title)}”. ${escapeHtml(whyLinked || correlation)}` : copy('No document with an identity link has been observed yet. That does not prove the work is incomplete.')}</div>
      <div class="progress-step ${task.assessment?.complete ? '' : 'muted'}"><strong>${task.assessment?.complete ? copy('Evidence checked') : copy('Checking completion')}</strong>${task.assessment?.complete ? copy('Every requested field is present in the document.') : copy('The requested work cannot yet be shown to be complete.')}</div>
    </div>
    <div class="assessment-box">
      <div class="assessment-head"><span>EVIDENCE PER REQUIREMENT</span><span>${escapeHtml(correlation)}</span></div>
      ${renderCriteria(task)}
      ${renderFreshness(task)}
    </div>
    ${renderClaims(task)}
    ${renderUnknowns(task)}
    ${renderVerification(task)}
    ${found ? ui`<a class="text-link" href="${escapeHtml(document.url)}" target="_blank" rel="noopener">Inspect source document · ${escapeHtml(document.externalId || document.id)} · modified ${escapeHtml(time(document.modifiedAt))} · version ${escapeHtml(document.version)} <span aria-hidden="true">↗</span></a>` : ''}
    ${renderPatchReview(task)}
    ${renderReview(task)}
  </article>`;
}

function renderApproval(task) {
  const draft = task.draft;
  const live = Boolean(draft?.live);
  const withheld = draft?.withheldClaims || [];
  if (task.status === 'ready_for_approval' && draft) {
    const criteria = task.evidence?.criteria || [];
    const satisfied = criteria.filter(item => item.status === 'satisfied');
    const linked = (current?.documents || []).find(item => item.id === (draft.documentId || task.documentId));
    const linkReasons = (task.assessment?.correlationReasons || task.evidence?.documents?.[0]?.correlationReasons || []).filter(Boolean);
    const saved = [
      copy('Noticing the request in the inbox'),
      linked || draft.documentUrl ? copy('Finding the matching document') : null,
      satisfied.length ? ui`Checking ${satisfied.length} required field${satisfied.length === 1 ? '' : 's'} against the source` : copy('Checking the source against the request'),
      copy('Drafting the reply from that evidence')
    ].filter(Boolean);
    return ui`<div class="approval-ready"><div class="approval-kicker">READY FOR YOUR REVIEW</div><h3>Reply to ${escapeHtml(draft.to)}</h3>
    <p class="approval-intro">A reply is prepared from the linked document and the email. Nothing has been sent.</p>
    <ol class="advance-chain" aria-label="What already happened">
      <li><strong>Noticed</strong><span>${escapeHtml(task.subject || 'Incoming request')} · ${escapeHtml(task.request?.source?.kind || 'email')}</span></li>
      <li><strong>Linked</strong><span>${escapeHtml(linked?.title || 'Document')}${linkReasons.length ? ui` · ${escapeHtml(linkReasons[0])}` : ''}</span></li>
      <li><strong>Verified</strong><span>${satisfied.length ? satisfied.map(item => escapeHtml(item.label || item.id)).join(' · ') : copy('No criterion recorded')}</span></li>
      <li><strong>Prepared</strong><span>Draft ready. Not sent.</span></li>
    </ol>
    ${renderVerification(task)}
    <div class="saved-work"><div class="mini-heading">WHAT YOU DID NOT HAVE TO DO</div><ul>${saved.map(item => ui`<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
    <div class="mail-preview"><div class="mail-headers"><div><span>TO</span><strong>${escapeHtml(draft.to)}</strong></div><div><span>SUBJECT</span><strong>${escapeHtml(draft.subject)}</strong></div></div><div class="mail-body">${escapeHtml(draft.body)}</div>${current?.durable ? `<button class="text-button" data-edit-draft="${escapeHtml(task.id)}">${copy('编辑草稿')}</button>` : ''}</div>
    <div class="permission-row"><span class="permission-chip">execute_external</span><span>${runtime?.shadow ? copy('Shadow mode blocks this write.') : runtime?.mode === 'simulation' ? copy('Approval records a local simulated receipt only.') : copy('Requires your approval before any external effect.')}</span></div>
    <div class="approval-evidence"><span>✓</span> Checked against ${escapeHtml(String(criteria.length))} criteria · <a class="text-link" style="margin:0" href="${escapeHtml(draft.documentUrl)}" target="_blank" rel="noopener">view version ${escapeHtml(draft.documentVersion)} ↗</a></div>
    ${withheld.length ? ui`<div class="withheld-note"><strong>Withheld from this reply</strong><ul>${withheld.map(item => ui`<li>${escapeHtml(item.text)} — ${escapeHtml(item.reason || copy('unsupported by evidence'))}</li>`).join('')}</ul></div>` : ''}
    ${runtime?.shadow || draft.canSend === false || runtime?.mode === 'live' && (draft.providerKind !== 'gmail' || runtime.google?.sendEnabled !== true)
      ? ui`<p class="fine-print">Shadow mode is read-only. This reply stays on this machine. Approving cannot send, edit, or delete anything outside it.${runtime.mode === 'simulation' ? ' Restart with UNPROMPTED_SHADOW_MODE=false to watch approval through verification in this local demonstration.' : ''}</p>`
      : ui`<div class="approval-buttons"><button class="primary-button" data-action="approve" data-id="${escapeHtml(task.id)}" data-review-token="${escapeHtml(task.reviewToken || '')}">${live ? copy('Approve and send via Gmail') : copy('Approve simulated send')}</button><button class="secondary-button" data-action="reject" data-id="${escapeHtml(task.id)}">Reject</button></div>
    <p class="fine-print">${live ? copy('Approval sends a real email through Gmail, then verifies it with the provider.') : copy('Approval writes to a simulated outbox only. No external service is contacted and the link is not reachable from outside this machine.')}</p>`}</div>`;
  }
  if (task.status === 'completed') {
    const verifiedLive = task.action?.status === 'verified_live';
    return ui`<div class="approval-done"><span class="status-pill completed">Verified complete</span><h3>Action confirmed</h3><p>${verifiedLive ? copy('Gmail confirmed the message exists. The result came from the provider, not from a local record.') : copy('After approval the simulated provider accepted the reply. The result was verified by receipt lookup, not assumed from the send attempt.')}</p><div class="receipt">Receipt ${escapeHtml(task.action?.receiptId)} · ${verifiedLive ? 'live provider' : 'simulated delivery'} · ${time(task.action?.verifiedAt)}</div></div>`;
  }
  if (task.status === 'blocked' && task.action) {
    return ui`<div class="approval-blocked"><span class="status-pill blocked">Outcome needs attention</span><h3>Delivery not confirmed</h3><p>${escapeHtml(task.reason)}</p><div class="receipt">No automatic retry. The provider is checked before any further attempt.</div><div class="approval-buttons"><button class="secondary-button" data-action="reconcile" data-id="${escapeHtml(task.id)}">Reconcile outcome</button>${task.action.status === 'confirmed_absent' && !runtime?.shadow ? ui`<button class="primary-button" data-action="retry" data-id="${escapeHtml(task.id)}">Retry after confirmed absence</button>` : ''}</div></div>`;
  }
  if (task.status === 'blocked') return ui`<div class="approval-blocked"><span class="status-pill blocked">Not sent</span><h3>Draft declined</h3><p>${escapeHtml(task.reason)}</p></div>`;
  if (task.status === 'cancelled') return ui`<div class="approval-blocked"><span class="status-pill cancelled">Closed</span><h3>Request closed</h3><p>${escapeHtml(task.reason)}</p></div>`;
  const unknowns = task.evidence?.unknowns || [];
  return ui`<div class="empty-state compact"><span class="empty-orbit approval-orbit"></span><h3>${task.status === 'verifying' ? copy('Checking the outcome') : copy('Waiting for enough evidence')}</h3><p>${task.status === 'verifying' ? copy('A provider receipt is being verified.') : copy('A draft appears only when the right document contains every requested result.')}</p>${unknowns.length ? ui`<div class="unknown-block"><div class="mini-heading">WHAT IS MISSING</div>${unknowns.map(item => ui`<div class="unknown-item"><strong>${escapeHtml(item.question)}</strong><small>${escapeHtml(item.reason)}</small></div>`).join('')}</div>` : ''}</div>`;
}

function renderDecisionButtons(item) {
  const options = item.options || [];
  if (item.clarificationId && options.length) {
    // Any calibration question — a permission, or how a date is read — is
    // answered through the same clarification route.
    return ui`<div class="approval-buttons">${options.map(option => ui`<button class="${option.value === 'allow' ? 'primary-button' : 'secondary-button'}" data-decision="answer" data-clarification="${escapeHtml(item.clarificationId)}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`).join('')}</div>`;
  }
  if (item.kind === 'opportunity' && item.opportunityId) {
    return ui`<div class="approval-buttons">${options.map(option => ui`<button class="${option.value === 'accept' ? 'primary-button' : 'secondary-button'}" data-decision="opportunity" data-opportunity="${escapeHtml(item.opportunityId)}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`).join('')}</div>`;
  }
  if (item.kind === 'blocker') {
    // A stalled request offers the decision it actually needs: supply the
    // information, or close the request. An unclear action outcome offers
    // reconciliation instead.
    if (options.some(option => option.value === 'close') && item.taskId) {
      return ui`<div class="approval-buttons"><button class="primary-button" data-decision="cancel" data-task="${escapeHtml(item.taskId)}">Close this request</button><button class="secondary-button" data-decision="ack" data-notification="${escapeHtml(item.id)}">Keep waiting</button></div>`;
    }
    return ui`<div class="approval-buttons"><button class="primary-button" data-decision="reconcile" data-task="${escapeHtml(item.taskId || '')}">Reconcile the outcome</button><button class="secondary-button" data-decision="ack" data-notification="${escapeHtml(item.id)}">Leave it blocked</button></div>`;
  }
  return options.length
    ? ui`<div class="approval-buttons">${options.map(option => ui`<button class="secondary-button" data-decision="ack" data-notification="${escapeHtml(item.id)}">${escapeHtml(option.label)}</button>`).join('')}</div>`
    : '';
}

/**
 * What was considered and deliberately not pursued.
 *
 * Parking is a decision too. Rendering the parked suggestions with their
 * recorded reasons is what makes "we chose not to act" visible instead of
 * silent — and the reason is the recorded one, not a re-write.
 */
function renderParked(opportunities) {
  const parked = (opportunities || []).filter(item => item.status === 'parked');
  if (!parked.length) return '';
  return ui`<details class="held-work parked-work"><summary>Considered and not pursued (${parked.length})</summary>
    ${parked.map(item => ui`<article class="parked-row"><strong>${escapeHtml(item.statement)}</strong><small>${escapeHtml(item.reason || copy('Not pursued.'))} · ${escapeHtml(String(item.kind || '').replaceAll('_', ' '))}</small>${item.nextStep ? ui`<small class="parked-next">If pursued later: ${escapeHtml(item.nextStep)}</small>` : ''}</article>`).join('<hr class="task-divider">')}
  </details>`;
}

/** The value readout is derived from the engine's own records, not asserted. */
function renderMetrics(metrics) {
  if (!metrics) return '';
  const pct = value => (value == null ? 'n/a' : ui`${Math.round(value * 100)}%`);
  const rows = [
    [copy('Prepared from evidence'), pct(metrics.discovery.valuableRate), ui`${metrics.discovery.valuable} of ${metrics.discovery.discovered} reached a prepared action. This is not your judgement.`],
    [copy('Unservable suggestions'), pct(metrics.discovery.unservableRate), ui`${metrics.discovery.unservable} surfaced but not actionable`],
    [copy('Verified completion'), pct(metrics.completion.verifiableCompletionRate), ui`${metrics.completion.verifiedCompletions} of ${metrics.completion.preparedActions} prepared`],
    [copy('Withheld claims'), String(metrics.completion.withheldClaims), 'unsupported statements never sent'],
    [copy('Interruptions'), String(metrics.attention.interruptions), ui`${metrics.attention.unresolved} still open`],
    [copy('Your takeovers'), String(metrics.attention.takeovers), 'rejections, retries, corrections']
  ];
  if (metrics.review) {
    rows.push(
      [copy('Not yet judged'), String(metrics.review.unevaluated ?? metrics.review.unreviewed), 'not useful, not useless, not unknown'],
      [copy('Labelled useful'), String(metrics.review.useful), 'your judgement, not an automatic score'],
      [copy('Not useful'), String(metrics.review.notUseful ?? 0), 'a negative judgement'],
      [copy('Wrong link'), String(metrics.review.wrongAssociation ?? 0), 'a negative judgement, counted apart from not useful'],
      [copy('Recorded misses'), String(metrics.review.misses ?? 0), 'work you saw and the system did not'],
      [copy('Time saved'), metrics.review.unknown?.timeSaved || 'unknown', copy('No wall-clock time measurement is collected.')],
      [copy('Real events'), String(metrics.events?.real ?? 0), ui`${metrics.events?.ingested ?? 0} ingested · ${metrics.sync?.failures ?? 0} sync failures`]
    );
  }
  if (metrics.outcomes) {
    rows.push(
      [copy('Verified live deliveries'), String(metrics.outcomes.verifiedDeliveries?.real ?? 0), copy('Provider receipts confirmed for real Google Workspace actions.')],
      [copy('Verified simulated deliveries'), String(metrics.outcomes.verifiedDeliveries?.simulated ?? 0), copy('Local simulation receipts; these are not real sends.')],
      [copy('User-recognized live deliveries'), String(metrics.outcomes.recognizedVerifiedDeliveries?.real ?? 0), copy('A verified delivery explicitly labelled useful by you.')],
      [copy('Verified document patches'), ui`${metrics.outcomes.verifiedDocumentPatches?.real ?? 0} real · ${metrics.outcomes.verifiedDocumentPatches?.simulated ?? 0} simulated`, copy('Applied patches with a successful provider read-back.')],
      [copy('User-recognized document patches'), ui`${metrics.outcomes.recognizedVerifiedDocumentPatches?.real ?? 0} real · ${metrics.outcomes.recognizedVerifiedDocumentPatches?.simulated ?? 0} simulated`, copy('Verified patches explicitly labelled useful by you.')]
    );
  }
  if (metrics.management) {
    rows.push(
      [copy('Pending decisions'), String(metrics.management.pendingDecisions ?? 0), copy('Unresolved notices and approvals, counted once.')],
      [copy('Active days'), ui`${metrics.management.activeDays?.last7 ?? 0} / 7 · ${metrics.management.activeDays?.last30 ?? 0} / 30`, copy('Days with an explicit decision or correction, not page views.')],
      [copy('Recorded misses'), String(metrics.management.missedItems ?? 0), copy('Items you reported as missed; this is not a recall rate.')],
      [copy('Explicit approvals'), String(metrics.attention?.explicitApprovals ?? 0), copy('Approved outbound actions and document patches.')],
      [copy('Corrective feedback'), String(metrics.attention?.takeoverBreakdown?.corrections ?? 0), copy('Recorded scope corrections; these remain user controlled.')]
    );
  }
  if (metrics.value) {
    rows.push([copy('Follow-throughs absorbed'), String(metrics.value.estimatedManualStepsAvoided ?? 0), copy('Legacy activity proxy. This is an estimate, not wall-clock time or user value.')]);
  }
  if (metrics.verification) {
    rows.push([copy('Source checks'), String(metrics.verification.enhanced), ui`${metrics.verification.standard} needed no extra check · ${metrics.verification.corroborations} corroborated · ${metrics.verification.sourceConflicts} conflicting`]);
  }
  return ui`<div class="value-grid">${rows.map(([label, value, foot]) => ui`<div class="value-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(foot)}</small></div>`).join('')}</div>`;
}

function eventIcon(event) {
  if (event.type === 'email.received') return '@';
  if (event.type === 'experiment.run.completed') return '↺';
  return '◇';
}

function eventDetail(event) {
  if (event.disposition === 'related_change') return ui`Connected to ${event.relations.length} outstanding request${event.relations.length === 1 ? '' : 's'}`;
  if (event.disposition === 'unrelated_change') return copy('No matching request · no action taken');
  if (event.disposition === 'stale_change') return copy('Older revision ignored · newer version kept');
  if (event.disposition === 'discovered_request') return copy('New request discovered from context');
  // An ignored message says which check declined it, so silence is auditable.
  if (event.rejection?.detail) return ui`Not a request · ${event.rejection.detail}`;
  if (event.type === 'document.modified') return copy('Document available for future requests');
  return copy('Observed without a supported task');
}

function traceKindLabel(kind) {
  const labels = {
    observation: copy('来源观察'), preparation: copy('准备行动'), assessment: copy('结果判断'),
    verification: copy('结果核验'), rejection: copy('未采纳'), discovery: copy('发现请求'),
    delivery: copy('交付'), memory: copy('记忆'), guidance: copy('方向调整'),
    task_direction: copy('方向调整'), memory_delete: copy('记忆已删除'), memory_restore: copy('记忆已恢复'), memory_edit: copy('记忆已更新'),
    followup: copy('后续跟进'), wait: copy('等待条件'), approval: copy('批准行动')
  };
  if (labels[kind]) return labels[kind];
  const key = `trace:${kind}`;
  const translated = copy(key);
  return translated === key ? kind.replaceAll('_', ' ') : translated;
}

function coalesceTrace(items, text, kind) {
  const groups = new Map();
  for (const item of items) {
    const date = new Date(item.at);
    const day = Number.isNaN(date.getTime()) ? '' : date.toDateString();
    const key = `${day}|${text(item)}|${kind(item)}`;
    if (groups.has(key)) groups.get(key).count += 1;
    else groups.set(key, { ...item, count: 1 });
  }
  return [...groups.values()];
}

function traceGroups(items, renderRow) {
  const groups = new Map();
  for (const item of items) {
    const date = new Date(item.at);
    const key = Number.isNaN(date.getTime()) ? '' : date.toDateString();
    if (!groups.has(key)) groups.set(key, { at: item.at, rows: [] });
    groups.get(key).rows.push(item);
  }
  const today = new Date().toDateString();
  return [...groups.values()].map(group => {
    const date = new Date(group.at);
    const label = Number.isNaN(date.getTime()) ? copy('更早') : date.toDateString() === today ? copy('今天') : formatDate(group.at);
    return ui`<div class="trace-day">${escapeHtml(label)}</div>${group.rows.map(renderRow).join('')}`;
  }).join('');
}

function renderEvents(events, emptyMessage = copy('等待第一条来源变化。')) {
  if (!events.length) return ui`<p class="empty-trace">${escapeHtml(emptyMessage)}</p>`;
  const ordered = coalesceTrace([...events].reverse().slice(0, 30), event => event.summary, event => event.disposition);
  return traceGroups(ordered, event => ui`<div class="trace-row"><span class="trace-sign ${escapeHtml(event.disposition)}" aria-hidden="true">${eventIcon(event)}</span><div class="trace-copy"><strong>${escapeHtml(event.summary)}${event.count > 1 ? `<span class="trace-count" title="${escapeHtml(copy('相同变化合并显示'))}">×${event.count}</span>` : ''}</strong><small>${escapeHtml(eventDetail(event))}${event.source && !['simulated', 'local'].includes(event.source) ? ` · ${escapeHtml(event.source)}` : ''}</small></div><time class="trace-time" datetime="${escapeHtml(event.at)}">${time(event.at)}</time></div>`);
}

// One chronological record: what changed in the environment and what the agent
// did about it, interleaved, so cause and response read top to bottom.
function renderRecord(events, history, emptyMessage) {
  if (!events.length && !history.length) return ui`<p class="empty-trace">${escapeHtml(emptyMessage || copy('等待第一条来源变化。'))}</p>`;
  const sourceRows = coalesceTrace([...events].reverse().slice(0, 40), event => event.summary, event => event.disposition).map(event => ({ ...event, origin: 'source' }));
  const agentRows = coalesceTrace(history.slice(0, 40), item => item.text, item => item.kind).map(item => ({ ...item, origin: 'agent' }));
  const rows = [...sourceRows, ...agentRows].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 60);
  const sign = item => item.origin === 'source' ? eventIcon(item) : item.kind === 'verification' ? '✓' : item.kind === 'uncertain' ? '!' : item.kind === 'rejection' ? '—' : '·';
  return traceGroups(rows, item => {
    const title = item.origin === 'source' ? item.summary : copy(item.text);
    const detail = item.origin === 'source' ? eventDetail(item) : traceKindLabel(item.kind);
    const task = item.origin === 'agent' && item.taskId && current?.tasks?.some(task => task.id === item.taskId) ? item.taskId : null;
    return ui`<div class="trace-row" data-origin="${item.origin}"><span class="trace-sign ${escapeHtml(item.origin === 'source' ? item.disposition : item.kind)}" aria-hidden="true">${sign(item)}</span><div class="trace-copy"><strong>${escapeHtml(title)}${item.count > 1 ? `<span class="trace-count" title="${escapeHtml(copy('相同变化合并显示'))}">×${item.count}</span>` : ''}</strong><small><span class="trace-origin">${item.origin === 'source' ? copy('来源') : 'Agent'}</span> · ${escapeHtml(detail)}${task ? ui` · <button type="button" class="text-button trace-task" data-select-task="${escapeHtml(task)}" data-select-event="record">${copy('查看任务')}</button>` : ''}</small></div><time class="trace-time" datetime="${escapeHtml(item.at)}">${time(item.at)}</time></div>`;
  });
}

function renderHistory(history, emptyMessage = copy('决策和核对记录会随着工作推进出现在这里。')) {
  if (!history.length) return ui`<p class="empty-trace">${escapeHtml(emptyMessage)}</p>`;
  const ordered = coalesceTrace(history.slice(0, 30), item => item.text, item => item.kind);
  return traceGroups(ordered, item => ui`<div class="trace-row"><span class="trace-sign ${escapeHtml(item.kind)}" aria-hidden="true">${item.kind === 'verification' ? '✓' : item.kind === 'uncertain' ? '!' : item.kind === 'rejection' ? '—' : '·'}</span><div class="trace-copy"><strong>${escapeHtml(item.text)}${item.count > 1 ? `<span class="trace-count" title="${escapeHtml(copy('相同记录合并显示'))}">×${item.count}</span>` : ''}</strong><small>${escapeHtml(traceKindLabel(item.kind))}</small></div><time class="trace-time" datetime="${escapeHtml(item.at)}">${time(item.at)}</time></div>`);
}

function renderContext(state) {
  const documents = state.documents || [];
  const runs = state.runRecords || [];
  const messages = (state.inbox || []).slice(-10).reverse();
  const issues = (state.tasks || []).filter(task => githubWorkKinds.includes(task.kind)).slice(-10).reverse();
  if (!documents.length && !runs.length && !messages.length && !issues.length) return ui`<p class="empty-trace">No context observed yet.</p>`;
  const sourceRows = messages.map(message => ui`<div class="context-row"><span class="context-kind">${message.connectorId === 'microsoft' ? 'OUTLOOK' : message.connectorId === 'slack' ? 'SLACK' : 'MAIL'}</span><div><strong>${escapeHtml(message.subject)}</strong><small>${escapeHtml(message.from)} · ${time(message.receivedAt)}</small></div></div>`).join('')
    + issues.map(task => ui`<div class="context-row"><span class="context-kind">GITHUB</span><div><strong>${escapeHtml(task.subject)}</strong><small>${escapeHtml(task.externalSource.repository)} #${Number(task.externalSource.number)} · ${escapeHtml(task.externalSource.state)}</small></div></div>`).join('');
  const docRows = documents.map(document => ui`<div class="context-row"><span class="context-kind">DOC</span><div><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.id)} · v${escapeHtml(document.version)} · ${escapeHtml(document.source)}${document.source === 'simulated' ? ' (simulated)' : ''} · ${time(document.modifiedAt)}</small></div></div>`).join('');
  const runRows = runs.map(run => ui`<div class="context-row"><span class="context-kind run">RUN</span><div><strong>${escapeHtml(run.label)}</strong><small>${escapeHtml(run.id)} · completed ${escapeHtml(String(run.completedAt).slice(0, 10))}${run.subjectEntity ? ui` · ${escapeHtml(run.subjectEntity)}` : ''}</small></div></div>`).join('');
  return sourceRows + docRows + runRows;
}

// The interface reflects recorded engine states, never an animated guess at work.
let selectedFilter = 'all';
let connected = false;
let openTaskId = null;
let taskDialogTrigger = null;
let currentView = 'home';
const viewScrollPositions = new Map();
let searchQuery = '';
let localWorkspace = null;
let snoozes = {};
let visitBaseline = null;
let taskOrder = [];
let composingElement = null;
const pendingTasks = new Set();
const actionErrors = new Map();
let interactions = null;
let workspaceUI = null;
let mcpUI = null;
let durableUI = null;
const viewNames = { home: '工作台', attention: '需要你', memory: '记忆', sources: '连接', preferences: '设置' };
const isClosedTask = task => ['completed', 'cancelled'].includes(task.status) || (task.status === 'blocked' && !task.action);
const needsTaskDecision = task => !task.control?.paused && (task.status === 'ready_for_approval' || (task.status === 'blocked' && Boolean(task.action)));

function taskTitle(task) {
  return task.subject || [task.request?.subjectEntity, task.request?.deliverable].filter(Boolean).join(' · ') || copy('待跟进的请求');
}

function taskPresentation(task) {
  const missing = (task.evidence?.criteria || []).filter(item => item.status !== 'satisfied').length;
  const presentations = {
    newly_discovered: ['working', copy('刚刚发现'), copy('从收到的请求中发现了值得跟进的事，正在关联上下文。')],
    investigating: ['working', copy('正在核对'), copy('正在关联相关文档，核对这次请求需要的结果。')],
    waiting_for_information: ['waiting', copy('等待变化'), missing ? copy('还有 {count} 项要求缺少证据。文档更新后，我会继续核对。', { count: missing }) : copy('还没有足够的证据。相关内容更新后，我会接着跟进。')],
    ready_for_approval: ['attention', copy('需要你'), copy('内容已核对，回复已备好。你可以直接发送，或约定今后的自动跟进。')],
    verifying: ['working', copy('核验结果中'), copy('行动已经发起，正在向提供方核实结果。尚未标记完成。')],
    completed: ['done', copy('已核验完成'), task.action?.status === 'verified_live' ? copy('已向 Gmail 核实发送结果，这件事已跟进完成。') : copy('回复已进入本地模拟发件箱，并核验了模拟回执。')],
    blocked: ['attention', copy('需要判断'), copy('行动结果尚未确认，需要先核实，再决定下一步。')],
    cancelled: ['waiting', copy('已关闭'), copy('这件事已停止跟进，没有发送回复。')]
  };
  if (task.status === 'blocked' && !task.action) return { tone: 'waiting', label: copy('已搁下'), description: copy('你已放下这份回复，没有发送。') };
  const [tone, label, description] = presentations[task.status] || ['waiting', copy('状态待核实'), copy('查看记录，了解当前进展。')];
  return { tone, label, description };
}

function managementActionLabel(action, dependencies) {
  const labels = {
    done: '查看已核验结果', closed: '无需后续操作', wait: '等待条件触发后继续',
    reassess: '等待条件已满足，重新核对', approve: '审阅并批准已准备的结果',
    verify: '向提供方核实结果', decide: '查看中断原因并决定下一步',
    recheck: '重新核对共同依赖', provide_information: '补充缺失信息或来源',
    assess: '对照请求检查当前来源文档'
  };
  if (action?.kind === 'resolve_dependency') {
    return copy('提供共同依赖信息：{label}', { label: dependencies[0]?.label || '' });
  }
  return copy(labels[action?.kind] || action?.label || '等待重新评估');
}

function managementWakeCondition(task) {
  const wake = task.management?.wake || {};
  if (wake.kind === 'document') {
    const documentId = task.wait?.condition?.documentId || task.documentId;
    const title = current?.documents?.find(item => item.id === documentId)?.title;
    return title ? copy('文档更新后重新核对：{title}', { title }) : copy('相关文档有新版本时重新核对');
  }
  if (wake.kind === 'reply') return copy('邮件线程收到回复时重新核对');
  if (wake.kind === 'time') {
    if (wake.waitId && wake.at) return copy('到 {when} 时重新核对', { when: `${formatDate(wake.at)} ${formatTime(wake.at)}` });
    const when = task.request?.deadline?.text || wake.at || '';
    return copy('在截止时间前重新核对：{when}', { when });
  }
  if (wake.kind === 'interruption') return copy('风险变化打断了等待，需要你查看下一步。');
  if (wake.status === 'scheduled' && task.request?.deadline?.text) {
    return copy('在截止时间前重新核对：{when}', { when: task.request.deadline.text });
  }
  return copy('相关证据或回复到达时重新检查');
}

function priorityReasonLabel(reason) {
  let match = String(reason || '').match(/^Deadline passed (\d+) day\(s\) ago \((.+)\)\.$/);
  if (match) return copy('截止日期已过 {days} 天（{date}）。', { days: match[1], date: match[2] });
  match = String(reason || '').match(/^Deadline is within (1|3|7) day(?:s)? \((.+)\)\.$/);
  if (match) return copy('截止日期将在 {days} 天内（{date}）。', { days: match[1], date: match[2] });
  match = String(reason || '').match(/^Deadline is (\d+) days away \((.+)\)\.$/);
  if (match) return copy('距离截止日期还有 {days} 天（{date}）。', { days: match[1], date: match[2] });
  match = String(reason || '').match(/^(\d+) evidence conflict\(s\) need review\.$/);
  if (match) return copy('有 {count} 处证据冲突需要复核。', { count: match[1] });
  match = String(reason || '').match(/^The evidence has not changed for (\d+) day\(s\)\.$/);
  if (match) return copy('证据已有 {days} 天没有变化。', { days: match[1] });
  return copy(reason);
}

function managementReasonLabel(reason) {
  const raw = String(reason || '');
  let match = raw.match(/^(\d+) active task\(s\) share this unmet requirement\.$/);
  if (match) return copy('有 {count} 件事项共享这项未满足的要求。', { count: match[1] });
  return copy(raw);
}

function renderTaskManagement(task, { compact = false } = {}) {
  const management = task.management;
  if (!management) return '';
  const owner = copy(management.owner?.label || management.owner?.id || '未指定责任人');
  const dependencies = management.dependencies || [];
  const next = managementActionLabel(management.nextAction, dependencies);
  const wake = managementWakeCondition(task);
  const priority = management.priority || {};
  const reasons = (priority.reasons || []).filter(Boolean);
  if (compact) return ui`<div class="task-next"><span>${copy(task.status === 'waiting_for_information' ? '接下来' : '下一步')}</span><p>${escapeHtml(task.status === 'waiting_for_information' ? wake : next)}</p><button class="text-button" data-open-task="${escapeHtml(task.id)}">${copy(isClosedTask(task) ? '查看结果' : '调整跟进')}</button></div>`;
  const hasDocumentWaitTarget = Boolean(task.documentId && current?.documents?.some(document => document.id === task.documentId && document.available !== false));
  const hasReplyWaitTarget = Boolean(task.request?.source?.threadId || current?.inbox?.find(item => item.id === task.sourceEmailId)?.threadId);
  const savedWait = task.wait?.status === 'active' ? task.wait : null;
  const waitKind = savedWait?.kind || (hasDocumentWaitTarget ? 'document' : hasReplyWaitTarget ? 'reply' : 'time');
  const date = savedWait?.until ? new Date(savedWait.until) : null;
  const localUntil = date && Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  return ui`<section class="task-management" aria-label="${copy('下一步与责任')}">
    <div class="management-line"><span>${copy('下一步')}</span><strong>${escapeHtml(next)}</strong></div>
    <div class="management-meta"><span>${copy('责任人')}: ${escapeHtml(owner)}</span><span>${copy('等待条件')}: ${escapeHtml(wake)}</span></div>
    <details class="management-explanation" data-preserve="priority-${escapeHtml(task.id)}"><summary>${copy('优先级与依据')} · ${escapeHtml(copy(priority.level || 'normal'))}</summary>
      ${reasons.length ? ui`<ul>${reasons.map(reason => ui`<li>${escapeHtml(priorityReasonLabel(reason))}</li>`).join('')}</ul>` : `<p>${copy('当前排序保持现有任务顺序，优先级依据尚未提供。')}</p>`}
      ${management.nextAction?.reason ? ui`<p>${escapeHtml(managementReasonLabel(management.nextAction.reason))}</p>` : ''}
      ${dependencies.length ? ui`<p>${copy('共同依赖')}: ${dependencies.map(item => escapeHtml(item.label)).join(' · ')}</p>` : ''}
    </details>
    ${!isClosedTask(task) ? ui`<form class="wait-form" data-wait-form="${escapeHtml(task.id)}"><label>${copy('等待条件')} <select data-wait-kind="${escapeHtml(task.id)}"><option value="document" ${waitKind === 'document' ? 'selected' : ''} ${hasDocumentWaitTarget ? '' : 'disabled'}>${copy('文档有新版本时')}</option><option value="reply" ${waitKind === 'reply' ? 'selected' : ''} ${hasReplyWaitTarget ? '' : 'disabled'}>${copy('邮件线程收到回复时')}</option><option value="time" ${waitKind === 'time' ? 'selected' : ''}>${copy('到指定时间时')}</option></select></label><input type="datetime-local" data-wait-until="${escapeHtml(task.id)}" value="${escapeHtml(localUntil)}" ${waitKind === 'time' ? '' : 'hidden'} aria-label="${copy('重新核对的时间')}"><button class="secondary-button" type="submit">${copy('保存等待条件')}</button></form>` : ''}
  </section>`;
}

function renderCommonDependencies(state) {
  const unique = new Map();
  for (const task of state.tasks || []) for (const dependency of task.management?.dependencies || []) {
    if (dependency.status !== 'open' || (dependency.taskIds || []).length < 2) continue;
    unique.set(dependency.id, dependency);
  }
  const dependencies = [...unique.values()];
  const section = byId('sharedDependencySection');
  section.hidden = !dependencies.length || selectedFilter === 'done';
  return dependencies.map(dependency => {
    const tasks = (dependency.taskIds || []).map(id => state.tasks.find(task => task.id === id)).filter(Boolean);
    return ui`<article class="shared-dependency"><div><span class="eyebrow">${copy('一项决定，解开多件事')}</span><h3>${escapeHtml(dependency.label)}</h3><details data-preserve="dependency-${escapeHtml(dependency.id)}"><summary>${copy('{count} 件事在等这个条件', { count: tasks.length })}</summary><ul>${tasks.map(task => ui`<li><button class="text-button" data-open-task="${escapeHtml(task.id)}">${escapeHtml(taskTitle(task))}</button></li>`).join('')}</ul></details>${dependency.source ? ui`<small>${copy('来源')}: ${escapeHtml(sourceLabel(dependency.source))}</small>` : ''}</div><form data-dependency-form="${escapeHtml(dependency.id)}"><label class="sr-only" for="${escapeHtml(dependency.id)}-answer">${copy('共同依赖的答案')}</label><input id="${escapeHtml(dependency.id)}-answer" maxlength="1000" data-dependency-answer="${escapeHtml(dependency.id)}" placeholder="${copy('给出信息或来源位置')}" required><button class="primary-button" type="submit">${copy('一次回答并重新核对')}</button></form></article>`;
  }).join('');
}

function attentionItems(state) {
  return visibleAttentionItems(state);
}

function agentPresentation(state, online) {
  if (!online) return { tone: 'offline', label: copy('状态待同步'), title: copy('连接暂时中断，正在重新同步。'), description: copy('下方保留上次收到的进展，连接恢复后会自动更新。') };
  const tasks = state.tasks || [];
  const working = tasks.filter(task => !task.control?.paused && ['newly_discovered', 'investigating', 'verifying'].includes(task.status));
  const waiting = tasks.filter(task => !task.control?.paused && task.status === 'waiting_for_information');
  const decisions = tasks.filter(needsTaskDecision).length + attentionItems(state).length;
  if (working.length) return { tone: 'working', label: copy('处理中'), title: copy('我在推进 {count} 件事。', { count: working.length }), description: decisions ? copy('另有 {count} 个选择需要你，已放在「需要你」。', { count: decisions }) : copy('正在核对上下文和结果，你可以先忙自己的。') };
  if (decisions) return { tone: 'needs', label: copy('等待你'), title: copy('{count} 个选择需要你，其余的我来照看。', { count: decisions }), description: copy('上下文和下一步已经备好，不用从头了解。') };
  if (waiting.length) return { tone: 'waiting', label: copy('等待变化'), title: copy('我在等 {count} 件事的下一步变化。', { count: waiting.length }), description: copy('现在没有正在执行的动作。证据更新后会继续，不需要你催。') };
  return { tone: 'idle', label: copy('空闲 · Idle'), title: copy('现在没有待推进的事，安心忙你的。'), description: copy('工作空间有值得跟进的变化时，我会再接着做。') };
}

function workspacePresentation(state, online) {
  const normal = agentPresentation(state, online);
  if (!online || runtime?.mode !== 'live') return normal;
  const monitoring = setupState?.monitoring || runtime?.monitoring;
  const lastSuccess = monitoring?.lastSuccessAt ? formatTime(monitoring.lastSuccessAt) : copy('尚无成功观察');
  if (!monitoring?.enabled) return {
    tone: 'offline', label: copy('自动观察已关闭'), title: copy('当前不会自动留意 已连接来源的变化。'),
    description: copy('最后成功观察：{time}。重新开启自动观察或手动同步后，我会核对新变化。', { time: lastSuccess })
  };
  if (['failed', 'expired', 'needs_connection'].includes(monitoring.status)) return {
    tone: 'offline', label: monitoring.status === 'expired' ? copy('观察已过期') : copy('观察需要检查'),
    title: copy('我无法确认 已连接来源的最新状态。'),
    description: monitoring.status === 'expired'
      ? copy('最后成功观察：{time}。新变化未知；下次同步成功后才会恢复正常照看。', { time: lastSuccess })
      : copy('最近一次观察失败。保留已有记录；自动观察会在下个周期重试。')
  };
  if (monitoring.status === 'starting' || monitoring.status === 'syncing') return {
    tone: 'working', label: copy('正在同步'), title: copy('正在检查 已连接来源的最新变化。'),
    description: copy('首次同步完成后会按设置间隔继续观察。')
  };
  return normal;
}

function emptyState(title, description) {
  return ui`<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✓</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>`;
}

function renderTaskAction(task) {
  const id = escapeHtml(task.id);
  const error = actionErrors.get(task.id);
  const errorHTML = error?.code === 'REVIEW_CHANGED'
    ? ui`<div class="action-error" role="status"><p>回复已更新，这次没有发送。</p><p>请看过新内容后再发送。</p></div>`
    : error ? ui`<div class="action-error" role="alert"><p>还没确认这次操作的结果。</p><p>先同步进展，再决定下一步，避免重复操作。</p><details><summary>查看具体原因</summary><p>${escapeHtml(error.message || error)}</p></details><button class="secondary-button" data-sync-state>同步状态</button></div>` : '';
  if (task.status === 'waiting_for_information' && task.draft?.userEdited && task.userDraftStale) {
    const canReview = Boolean(current?.durable && task.assessment?.complete && !task.control?.paused && !task.action && !task.dirty && task.inputVersion === task.processedInputVersion);
    return `<div class="task-action"><h4>${nativeCopy('你的草稿已保留', 'Your draft is preserved')}</h4><p>${nativeCopy('来源发生了变化。请先核对最新依据，再决定是否更新草稿。', 'The source changed. Review the current evidence before updating your draft.')}</p><p class="draft-excerpt">${escapeHtml(task.draft.body)}</p><button class="text-button" data-copy-draft="${id}">${nativeCopy('复制草稿', 'Copy draft')}</button>${canReview ? `<button class="secondary-button" data-edit-draft="${id}">${nativeCopy('核对并保存草稿', 'Review and save draft')}</button>` : ''}${errorHTML}</div>`;
  }
  if (task.status === 'completed') return ui`<div class="task-action">${renderApproval(task)}${errorHTML}</div>`;
  const presentationState = taskState(task, workspaceConnections(setupState));
  if (presentationState === 'source_disconnected') return `<div class="task-action"><button class="secondary-button" data-go="sources">${nativeCopy('重新连接来源', 'Reconnect source')}</button>${errorHTML}</div>`;
  if (presentationState === 'failed') {
    const work = task.reasoningWork;
    const retryable = work && Number(work.attempts) < Number(work.maxAttempts || 2) && !task.reasoning?.budgetExhausted;
    return `<div class="task-action"><div class="action-row">${retryable ? `<button class="secondary-button" data-reasoning-retry="${id}">${nativeCopy('重新核对', 'Recheck task')}</button>` : ''}<button class="text-button" data-go="preferences">${nativeCopy('检查模型连接', 'Check model connection')}</button></div>${errorHTML}</div>`;
  }
  if (sourceFollow(task) && task.status === 'waiting_for_information') {
    const source = task.externalSource || {};
    const url = safeLink(source.url);
    return `<div class="task-action"><div class="action-row">${url ? `<a class="secondary-button" href="${escapeHtml(url)}" target="_blank" rel="noopener">${nativeCopy('查看来源', 'View source')} ↗</a>` : ''}<button class="subtle-button" data-action="cancel" data-id="${id}">${nativeCopy('停止跟进', 'Stop following')}</button></div>${errorHTML}</div>`;
  }
  if (isClosedTask(task)) {
    const external = sourceFollow(task);
    const canRestore = !external || task.externalSource?.state === 'open' && task.externalSource?.assigned !== false && workspaceConnections(setupState)[task.sourceConnectorId]?.connected;
    return ui`<div class="task-action">${task.draft?.userEdited ? `<p>${nativeCopy('你的草稿已保留。', 'Your draft is preserved.')}</p><p class="draft-excerpt">${escapeHtml(task.draft.body)}</p><button class="text-button" data-copy-draft="${id}">${nativeCopy('复制草稿', 'Copy draft')}</button>` : ''}${canRestore ? `<button class="secondary-button" data-action="reopen" data-id="${id}">${copy('恢复跟进')}</button>` : `<span class="muted">${nativeCopy('来源已关闭或断开', 'Source closed or disconnected')}</span>`}${errorHTML}</div>`;
  }
  if (isSnoozed(task, snoozes)) return ui`<div class="snooze-note"><div><span>稍后再看 · ${time(snoozes[task.id].until)}</span><small>只暂收起这台设备上的提醒，Agent 仍会照看。</small></div><button class="text-button" data-unsnooze="${id}">现在查看</button></div>`;
  if (task.status === 'ready_for_approval' && task.draft) {
    const draft = task.draft;
    const shadow = runtime?.shadow !== false || draft.canSend === false || runtime?.mode === 'live' && (draft.providerKind !== 'gmail' || runtime.google?.sendEnabled !== true);
    const enhanced = task.verification?.depth === 'enhanced';
    const scope = [task.request?.subjectEntity, task.request?.deliverable].filter(Boolean).join(' · ');
    const hasScope = Boolean(task.request?.subjectEntity && task.request?.deliverable);
    return ui`<div class="task-action"><h4>${shadow ? copy('回复已经准备好') : copy('回复备好了，要发出去吗？')}</h4><p>${shadow ? copy('当前为只读模式，回复保留在这里。') : draft.live ? copy('将通过 Gmail 发送给下方收件人。') : copy('这次发送只写入本地模拟发件箱。')}</p>
      <div class="draft-recipient">收件人：${escapeHtml(draft.to)}</div>
      <p class="draft-excerpt">${escapeHtml(draft.body?.replace(/\n\s*\n/g, '\n'))}</p>
      ${current?.durable ? `<button class="text-button" data-edit-draft="${id}">${copy('编辑草稿')}</button>` : ''}<details class="draft-details" data-preserve="draft-${id}"><summary>看一眼回复内容</summary><div class="draft-recipient">主题：${escapeHtml(draft.subject)}</div><div class="draft-body">${escapeHtml(draft.body)}</div></details>
      ${shadow ? ui`<div class="action-row"><button class="secondary-button" data-copy-draft="${id}">${copy('复制回复草稿')}</button><button class="text-button" data-go="sources">${copy(task.draft?.providerKind === 'outlook' ? '管理 Outlook 连接' : runtime?.mode === 'live' ? '开启经你批准的 Gmail 发送' : '查看当前连接方式')} ↗</button><button class="subtle-button" data-action="reject" data-id="${id}">${copy('这次不用了')}</button></div>` : ui`<div class="action-row"><button class="primary-button" data-action="approve" data-id="${id}" data-review-token="${escapeHtml(task.reviewToken || '')}">${draft.live ? copy('发送这次回复') : copy('发送模拟回复')} <span aria-hidden="true">↗</span></button>${hasScope && !enhanced ? ui`<button class="secondary-button" data-automate="${id}" data-review-token="${escapeHtml(task.reviewToken || '')}">本次发送，今后自动</button>` : ''}<button class="subtle-button" data-snooze="${id}" title="30 分钟后再看">稍后再看</button><button class="subtle-button" data-action="reject" data-id="${id}">这次不用了</button></div>${hasScope && !enhanced ? ui`<p class="auto-explain">「今后自动」仅适用于 ${escapeHtml(scope)} 的后续回复，可在「相处方式」收回。</p>` : ''}${enhanced ? '<p class="auto-explain">存在多个可能的来源，这次需要单独判断。</p>' : ''}`}
    ${errorHTML}</div>`;
  }
  if (task.status === 'blocked' && task.action) {
    return ui`<div class="task-action"><h4>先确认上次行动的结果</h4><p>${escapeHtml(task.reason || copy('提供方尚未确认结果，我没有自动重试。'))}</p><div class="action-row"><button class="primary-button" data-action="reconcile" data-id="${id}">核实发送结果</button>${task.action.status === 'confirmed_absent' && !runtime?.shadow ? ui`<button class="secondary-button" data-action="retry" data-id="${id}">已确认未发送，重试</button>` : ''}</div>${errorHTML}</div>`;
  }
  return errorHTML;
}

const githubCardCopy = {
  external_issue: { label: '跟进已分配的 issue', open: '这个 issue 当前分配给你。我会留意状态和负责人变化。', marker: issue => `${issue.repository} #${issue.number}`, who: issue => issue.assignee },
  external_review: { label: '跟进需要你处理的 PR', open: '这个 pull request 需要你评审，或需要你处理别人的评审意见。', marker: issue => `${issue.repository} #${issue.number}`, who: issue => issue.author },
  external_change: { label: '跟进仓库内容变化', open: '仓库有新的提交。这里保留提交说明和变更的文件路径。', marker: issue => `${issue.repository} · ${issue.marker}`, who: issue => issue.author },
  external_check: { label: '跟进 GitHub Actions', open: '这条 Actions 运行有变化，需要你处理。', marker: issue => `${issue.repository} · ${issue.marker}`, who: issue => issue.author }
};
function renderIssueCard(task, { detailed = false } = {}) {
  const issue = task.externalSource || {}, id = escapeHtml(task.id), copyFor = githubCardCopy[task.kind] || githubCardCopy.external_issue;
  const closed = task.status === 'cancelled';
  const label = closed ? copy('已停止跟进') : copy(copyFor.label);
  const canResume = closed && issue.state === 'open' && issue.assigned !== false && issue.active !== false && setupState?.connections?.github?.connected;
  return ui`<article class="task-card ${detailed ? 'work-card' : ''}" data-task-card="${id}"><div class="task-main"><div class="task-topline"><span class="task-category">GitHub · ${escapeHtml(copyFor.marker(issue))}</span><span class="state-badge waiting">${label}</span></div><button class="task-title-button" data-open-task="${id}"><h3>${escapeHtml(task.subject)}</h3></button><p class="task-description">${closed ? copy('来源状态或你的选择已停止本次跟进；这不代表 Agent 完成了工作。') : copy(copyFor.open)}</p><div class="task-meta"><span>${copy('负责人')} · ${escapeHtml(copyFor.who(issue) || '')}</span><span>${time(issue.updatedAt)}</span></div>${detailed ? `<div class="issue-source-body">${escapeHtml(issue.body || '')}</div>${issue.bodyTruncated ? `<p class="setup-note">${copy('此处保留前 8000 个字符，完整正文请在 GitHub 查看。')}</p>` : ''}` : ''}</div><div class="task-action"><div class="action-row"><a class="secondary-button" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">${copy('在 GitHub 查看')} ↗</a>${!closed ? ui`<button class="subtle-button" data-action="cancel" data-id="${id}">${copy('暂不跟进')}</button>` : canResume ? ui`<button class="text-button" data-action="reopen" data-id="${id}">${copy('恢复跟进')}</button>` : ''}</div><p class="setup-note">${copy('连接器只读，不会评论、合并、修改文件或重跑 Actions。')}</p>${detailed ? renderReview(task) : ''}</div></article>`;
}

function renderTaskCard(task) {
  if (githubWorkKinds.includes(task.kind)) return renderIssueCard(task);
  if (task.kind === 'observed_task') return renderObservedCard(task);
  const presentation = taskPresentation(task);
  const id = escapeHtml(task.id);
  const criteria = task.evidence?.criteria || [];
  const satisfied = criteria.filter(item => item.status === 'satisfied').length;
  const found = (current?.documents || []).some(item => item.id === task.documentId);
  const isComplete = task.status === 'completed';
  const steps = [[copy('发现请求'), true], [copy('关联上下文'), found], [isComplete ? copy('结果已核验') : copy('核对要求'), isComplete || Boolean(task.assessment?.complete)]];
  const summary = criteria.length ? ui`${satisfied} / ${criteria.length} 项要求已核对` : copy('正在了解请求的上下文');
  const change = interactions?.delta(task);
  const changeChip = change?.hasChanges ? ui`<button class="change-lens" data-proof-changes="${id}" aria-haspopup="dialog" aria-controls="evidencePeek" aria-expanded="false"><span aria-hidden="true">↳</span>${escapeHtml(interactions.deltaLabel(change))}</button>` : '';
  return ui`<article class="task-card" data-task-card="${id}"><div class="task-main"><div class="task-topline"><span class="task-category"><span aria-hidden="true">↳</span>主动发现 · 持续跟进</span><span class="state-badge ${presentation.tone}">${presentation.label}</span></div>
    <button class="task-title-button" data-expand-task="${id}" aria-expanded="${expandedTasks.has(task.id)}"><h3>${escapeHtml(taskTitle(task))}</h3></button><p class="task-description">${escapeHtml(presentation.description)}</p>${changeChip}<div class="task-meta"><span class="meta-source">${task.sourceConnectorId === 'microsoft' ? 'Outlook' : task.sourceConnectorId === 'slack' ? 'Slack' : copy('来自邮件')}</span><span class="meta-dot"></span><span>${escapeHtml(task.sender || copy('已观察的请求'))}</span><span class="meta-dot"></span><span>${time(task.updatedAt)}</span></div>
    <div class="task-progress" aria-label="任务进展">${steps.map(([label, met]) => ui`<div class="${met ? 'met' : ''}"><span class="step-dot" aria-hidden="true">${met ? '✓' : '·'}</span>${label}</div>`).join('')}</div></div>
    <div class="task-bottom"><button class="task-summary proof-trigger" data-proof="${id}" aria-haspopup="dialog" aria-label="${escapeHtml(summary)} · ${copy('查看依据')}" aria-controls="evidencePeek" aria-expanded="false"><span>${escapeHtml(summary)}</span></button><div class="action-row">${task.status === 'waiting_for_information' && !task.action ? ui`<button class="text-button" data-action="cancel" data-id="${id}">${copy('暂不跟进')}</button>` : ''}<button class="text-button" data-expand-task="${id}" aria-expanded="${expandedTasks.has(task.id)}">${nativeCopy('调整','Adjust')}</button><button class="text-button" data-open-task="${id}">${nativeCopy('记录','History')}</button></div></div>${renderTaskAction(task)}${expandedTasks.has(task.id) ? `<div class="inline-task-controls">${renderTaskManagement(task)}</div>` : ''}</article>`;
}

function renderObservedCard(task, { detailed = false } = {}) {
  const source = task.externalSource || {}, id = escapeHtml(task.id), closed = task.status === 'cancelled';
  const provider = task.sourceConnectorId === 'apple_notes' ? nativeCopy('备忘录', 'Apple Notes') : nativeCopy('本地文件', 'Local files');
  const canResume = closed && source.state === 'open' && setupState?.localSources?.[task.sourceConnectorId]?.connected;
  return `<article class="task-card" data-task-card="${id}"><div class="task-main"><div class="task-topline"><span class="task-category">${provider} · ${escapeHtml(source.documentTitle)}</span><span class="state-badge waiting">${closed ? copy('已停止跟进') : nativeCopy('观察中', 'Following')}</span></div><h3>${escapeHtml(task.subject)}</h3>${detailed ? `<p class="setup-note">${nativeCopy('跟随来源中的明确待办。勾选或移除待办不会计为 Agent 完成。', 'Following an explicit source to-do. Checking it off or removing it does not count as an agent completion.')}</p>` : ''}</div><div class="task-bottom"><a class="text-button" href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${nativeCopy('查看原文', 'View source')} ↗</a>${!closed ? `<button class="text-button" data-action="cancel" data-id="${id}">${copy('暂不跟进')}</button>` : canResume ? `<button class="text-button" data-action="reopen" data-id="${id}">${copy('恢复跟进')}</button>` : ''}</div></article>`;
}

function renderQuietDecision(item) {
  const labels = { risk: copy('风险判断'), deadline: copy('时间安排'), calibration: copy('了解你的习惯'), opportunity: copy('值得考虑'), permission: copy('约定跟进范围'), blocker: copy('下一步怎么做') };
  return ui`<article class="decision-card"><div class="decision-topline"><span class="decision-kind">${labels[item.kind] || copy('一个选择')}</span><span>${item.priority === 'high' ? copy('优先看看') : copy('方便时看看')}</span></div><h3>${escapeHtml(item.headline)}</h3><p class="decision-lead">${escapeHtml(item.decision)}</p><details data-preserve="notice-${escapeHtml(item.id)}"><summary class="muted">为什么需要我？</summary><dl class="decision-fields"><div><dt>发生了什么</dt><dd>${escapeHtml(item.what)}</dd></div><div><dt>为什么值得关注</dt><dd>${escapeHtml(item.why)}</dd></div><div><dt>已经核对</dt><dd>${(item.checked || []).map(escapeHtml).join('<br>')}</dd></div>${(item.evidence || []).length ? ui`<div><dt>依据</dt><dd>${item.evidence.map(entry => ui`${escapeHtml(entry.detail || '')}${entry.source ? ui`<small class="source-ref">${escapeHtml(sourceLabel(entry.source))}</small>` : ''}`).join('<br>')}</dd></div>` : ''}${(item.uncertainty || []).length ? ui`<div><dt>仍不确定</dt><dd>${item.uncertainty.map(escapeHtml).join('<br>')}</dd></div>` : ''}</dl></details>${renderDecisionButtons(item)}</article>`;
}

function renderFollowUps(state) {
  const followUps = Object.values(state.followUps || {});
  if (!followUps.length) return `<p class="empty-trace">${copy('接受建议后，责任人、下一步和完成条件会留在这里。')}</p>`;
  return followUps.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => ui`<article class="followup-row"><div><span class="state-badge ${item.status === 'completed' ? 'done' : 'waiting'}">${escapeHtml(copy(`followup:${item.status}`))}</span><strong>${escapeHtml(item.nextAction?.label || copy('检查已接受的建议'))}</strong><p>${copy('责任人')}: ${escapeHtml(copy(item.owner?.label || '尚未指定'))}</p><small>${copy('完成条件')}: ${escapeHtml(item.completionCondition || copy('等待明确完成条件'))}</small></div></article>`).join('');
}

function renderGrants(state) {
  const grants = (state.calibrations || []).filter(item => item.key === 'permission:send_automation' && item.value === 'allow' && item.source === 'user_stated' && item.confidence === 'stated' && item.scope?.entity);
  return grants.length ? grants.map(item => ui`<div class="grant-row"><div><strong>${escapeHtml([item.scope.entity, item.scope.deliverable || copy('该项目的全部交付物')].join(' · '))}</strong><p>${copy('证据充分时自动发送后续回复 · {time} 约定', { time: time(item.updatedAt || item.at) })}</p></div><button class="secondary-button" data-revoke="${escapeHtml(item.id)}">${copy('改为逐次确认')}</button></div>`).join('') : ui`<p class="empty-trace">还没有自动发送的约定。准备好的回复里，可以选择「本次发送，今后自动」。</p>`;
}

let selectedConnection = null;
let connectionQuery = '';
let connectionFilter = 'all';
let activityQuery = '';
let activityFilter = 'all';
const connectionPopups = new Map();
const providerNames = { google: 'Google Workspace', github: 'GitHub', microsoft: 'Microsoft Outlook', slack: 'Slack', notion: 'Notion' };
const cloudCopy = { google: '读取 Gmail 和 Google Docs，关联邮件请求与文档证据。', github: '跟进分配给你的 issue、需要你处理的 PR、仓库提交和 Actions 变化。', microsoft: '读取 Outlook 收件箱，从邮件中发现需要跟进的工作。', slack: '读取你参与的私信和群组私信，从对话里发现需要跟进的事。', notion: '读取你在授权时选中的 Notion 页面。' };
const cloudAccess = { github: 'issue、PR、提交和 Actions', microsoft: '收件箱邮件', slack: '私信', notion: '选中的页面' };
const githubWorkKinds = ['external_issue', 'external_review', 'external_change', 'external_check'];
const sourceFollow = task => task?.kind === 'observed_task' || githubWorkKinds.includes(task?.kind);
const cloudMark = { google: 'G', github: 'GH', microsoft: 'M', slack: 'S', notion: 'Nt' };

function connectionState(id) {
  if (['local_files', 'apple_notes'].includes(id)) {
    const source = setupState?.localSources?.[id] || {};
    return source.connected ? source.healthy === false || source.lastError ? 'attention' : 'connected' : 'available';
  }
  const google = setupState?.google || {};
  const source = id === 'google' ? { connected: google.configuredThisRun && !google.runtimeDisabled, healthy: google.connectionStatus === 'sync_failed' ? false : null, lastError: google.lastValidationError } : setupState?.connections?.[id] || {};
  const phase = source.oauth?.phase || (id === 'google' ? setupState?.oauth?.phase : '');
  return ['failed', 'expired', 'activation_failed'].includes(phase) || source.healthy === false || source.lastError ? 'attention' : source.connected ? 'connected' : 'available';
}

function connectionMatches(id) {
  const names = { google: 'Google Workspace Gmail Docs', github: 'GitHub issues pull requests commits Actions PR 评审 提交', microsoft: 'Microsoft Outlook mail', slack: 'Slack direct messages', notion: 'Notion pages', local_files: nativeCopy('本地文件夹', 'Local folders'), apple_notes: nativeCopy('备忘录', 'Apple Notes') };
  const source = setupState?.localSources?.[id] || setupState?.connections?.[id] || {};
  const scopes = Array.isArray(source.scopes) ? source.scopes : [];
  const searchable = [names[id], source.account?.label, id === 'google' ? setupState?.google?.accountEmail : '',
    ...scopes.flatMap(scope => typeof scope === 'string' ? [scope] : [scope?.label, scope?.account])]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  return (connectionFilter === 'all' || connectionState(id) === connectionFilter) &&
    (!connectionQuery.trim() || searchable.includes(connectionQuery.trim().toLocaleLowerCase()));
}

function renderNativeCard(id) {
  const source = setupState.localSources?.[id] || {}, notes = id === 'apple_notes';
  const title = notes ? nativeCopy('备忘录', 'Apple Notes') : nativeCopy('本地文件夹', 'Local folders');
  const state = connectionState(id);
  const folderVerb = notes
    ? nativeCopy(source.connected ? '添加备忘录文件夹' : '选择备忘录文件夹', source.connected ? 'Add Notes folders' : 'Choose Notes folders')
    : nativeCopy(source.connected ? '添加文件夹' : '选择文件夹', source.connected ? 'Add folder' : 'Choose folders');
  const select = `<button class="secondary-button" data-native-operation="select" data-native-source="${id}" ${source.available === false ? 'disabled' : ''}>${folderVerb}</button>`;
  const fallback = !notes && source.nativePicker === false ? `<form data-native-path-form><label class="setup-field">${nativeCopy('文件夹绝对路径', 'Absolute folder path')}<input name="path" required autocomplete="off" placeholder="/path/to/work"></label><button class="secondary-button" type="submit">${nativeCopy('连接', 'Connect')}</button></form>` : select;
  const badge = source.available === false ? nativeCopy('需要 macOS', 'Requires macOS') : source.connected ? source.readOnly === false ? copy('已连接 · 按授权行动') : copy('已连接 · 只读') : copy('尚未连接');
  const scopes = source.connected ? `<ul class="native-scope-list">${(source.scopes || []).map(item => `<li><span>${escapeHtml(item.account ? item.account + ' / ' : '')}${escapeHtml(item.label)}</span><button class="text-button" data-native-operation="remove-scope" data-native-source="${id}" data-scope-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(nativeCopy('移除', 'Remove') + ' ' + item.label)}">×</button></li>`).join('')}</ul>` : '';
  const counts = source.connected ? `<p class="connection-card-counts">${source.counts?.documents || 0} ${nativeCopy('份文档', 'documents')} · ${source.counts?.tasks || 0} ${nativeCopy('项待办', 'to-dos')}${source.lastSyncAt ? ' · ' + time(source.lastSyncAt) : ''}</p>` : '';
  const detail = source.connected ? `<div class="source-connection-detail">${scopes}${counts}<div class="actions">${fallback}${source.connected ? `<button class="text-button" data-native-operation="forget" data-native-source="${id}">${copy('断开连接')}</button><button type="button" class="text-button danger-button" data-native-purge="true" data-native-source="${id}">${copy('断开并清除本机副本')}</button>` : ''}</div></div>` : '';
  return { id, state, html: ui`<article class="source-connection-card" data-connection-card="${id}" data-state="${state}"><div class="source-connection-heading"><span class="source-monogram" aria-hidden="true">${notes ? 'N' : 'F'}</span><div class="source-connection-copy"><h3>${title}</h3><p>${notes ? nativeCopy('仅所选文件夹的文本；首次连接由 macOS 授权。', 'Text in selected folders. macOS requests access on first connection.') : nativeCopy('只读所选文件夹中的 Markdown 和文本文件。', 'Read Markdown and text in selected folders only.')}</p></div><span class="state-badge ${source.healthy === false ? 'offline' : source.connected ? 'done' : 'waiting'}">${badge}</span>${source.connected ? '' : `<div class="source-connection-actions">${fallback}</div>`}</div>${detail}${source.lastError ? `<p class="setup-error" role="status">${escapeHtml(source.lastError)}</p>` : ''}</article>` };
}

function renderCloudCard(id, { home = false } = {}) {
  const google = setupState.google || {};
  const source = id === 'google' ? { connected: google.configuredThisRun && !google.runtimeDisabled, configured: google.hasClient,
    account: google.accountEmail ? { label: google.accountEmail } : null, oauth: setupState.oauth || {},
    readOnly: !setupState.artifacts?.enabled || !setupState.artifacts.grants?.some(grant => grant.connectorId === 'google' && grant.status === 'active' && grant.available),
    healthy: google.connectionStatus === 'sync_failed' ? false : google.connectionStatus === 'sync_ok' ? true : null,
    lastSyncAt: google.lastSyncAt, lastError: google.lastValidationError, counts: setupState.workspace?.observed || {} } : setupState.connections?.[id] || {};
  const oauth = source.oauth || {}, waiting = ['starting', 'authorizing', 'verifying', 'connecting'].includes(oauth.phase);
  const failed = ['failed', 'expired', 'activation_failed'].includes(oauth.phase) || source.healthy === false;
  const state = connectionState(id);
  const selected = selectedConnection === id;
  const code = source.flow === 'code';
  const label = waiting ? copy('等待完成授权') : failed ? copy('连接需要处理') : source.connected ? copy(source.readOnly === false || id === 'google' && google.allowExternalWrites ? '已连接 · 按授权行动' : '已连接 · 只读') : copy('尚未连接');
  const description = copy(cloudCopy[id] || cloudCopy.microsoft);
  const stateMessages = { failed: '授权没有完成，可以重新连接。', expired: '授权码已过期，重新连接会生成新的授权码。',
    cancelled: '本次授权已取消，已有连接与工作记录保留。', activation_failed: '授权已保存，重试应用连接即可，无需重新登录。' };
  const notice = stateMessages[oauth.phase] ? ui`<p class="setup-note" role="status">${copy(stateMessages[oauth.phase])}</p>` : '';
  const device = id !== 'google' && !code && waiting ? ui`<div class="device-authorization" role="status"><p>${copy('复制授权码，在官方页面粘贴并确认。完成后会自动开始观察。')}</p>${oauth.userCode ? ui`<div class="device-code-row"><code>${escapeHtml(oauth.userCode)}</code><button class="text-button" data-copy-device-code="${id}">${copy('复制授权码')}</button></div><a class="primary-button" href="${escapeHtml(oauth.authorizeUrl)}" target="_blank" rel="noopener">${copy('打开官方授权页面')} ↗</a>` : ui`<p>${copy('正在确认账号身份并应用连接。')}</p>`}<button class="text-button" data-provider-operation="cancel" data-provider="${id}">${copy('取消连接')}</button></div>` : '';
  const browser = code && waiting ? ui`<div class="device-authorization" role="status"><p>${copy('在浏览器中登录你自己的账号并授权。完成后会自动开始观察。')}</p>${oauth.authorizeUrl ? ui`<a class="primary-button" href="${escapeHtml(oauth.authorizeUrl)}" target="_blank" rel="noopener">${copy('打开官方授权页面')} ↗</a>` : ui`<p>${copy('正在确认账号身份并应用连接。')}</p>`}<button type="button" class="text-button" data-provider-operation="cancel" data-provider="${id}">${copy('取消连接')}</button></div>` : '';
  const showCodeCredentials = code && !source.connected && (!source.configured || ['failed', 'expired'].includes(oauth.phase));
  const codeFields = showCodeCredentials ? ui`<label class="setup-field">${copy('应用 Client ID')}<input name="clientId" required maxlength="512" autocomplete="off" value="${escapeHtml(source.clientId || '')}" placeholder="Client ID"></label><label class="setup-field">${copy('应用 Client Secret')}<input name="clientSecret" type="password" ${source.configured ? '' : 'required'} maxlength="512" autocomplete="off" value=""></label><p class="setup-note">${copy('发行版尚未预置此应用。自托管时填写一次 Client ID 和 Client Secret，它们只保存在这台电脑上。')}</p>` : '';
  const deviceFields = !code && !source.configured ? ui`<label class="setup-field">${copy('应用 Client ID')}<input name="clientId" required maxlength="512" autocomplete="off" value="${escapeHtml(source.clientId || '')}" placeholder="${id === 'github' ? 'GitHub App client ID' : 'Microsoft application (client) ID'}"></label><p class="setup-note">${copy('发行版尚未预置此应用。自托管时只需填写一次注册应用的公开 Client ID，不需要访问令牌或 Client Secret。')}</p>` : '';
  const form = selected && id !== 'google' && !waiting && !source.connected ? ui`<div class="connection-card-form"><form data-connection-form="${id}" data-preserve="connection-${id}">${code ? codeFields : deviceFields}<label class="setup-toggle"><input name="observe" type="checkbox" checked><span><strong>${copy('连接后持续观察')}</strong><small>${copy('立即检查一次，之后默认每 5 分钟检查变化，可以随时暂停。')}</small></span></label><p class="connection-disclosure">${copy('此连接只读取内容，不发送或修改。工作上下文可能交给你选择的模型理解。')}</p><button class="primary-button" type="submit">${code ? nativeCopy('连接', 'Connect') : copy('获取授权码')} ${providerNames[id]}</button><p class="setup-error" data-provider-error="${id}" role="alert" ${connectionErrors.has(id) ? '' : 'hidden'}>${escapeHtml(connectionErrors.get(id) || '')}</p></form></div>` : '';
  const access = copy(cloudAccess[id] || '邮件与文档');
  const write = source.readOnly === false || google.allowExternalWrites && id === 'google' ? copy('按你的授权行动') : copy('不修改来源');
  const detail = selected && !home ? `<div class="source-detail-grid"><div><h4>${copy('访问路径')}</h4><div class="connection-access-path"><div><strong>${providerNames[id]}</strong><small>${escapeHtml(source.account?.label || copy('尚未授权账号'))}</small></div><span aria-hidden="true">→</span><div><strong>Unprompted</strong><small>${copy('只读观察')}</small></div><span aria-hidden="true">→</span><div><strong>${copy('工作与任务')}</strong><small>${write}</small></div></div><div class="connection-permissions"><span>${escapeHtml(access)} · ${copy('读取')}</span><span>${write}</span></div></div><div><h4>${copy('最近观察')}</h4><p class="connection-last-observed"><i aria-hidden="true"></i>${source.lastSyncAt ? copy('最近成功观察 {time}', { time: time(source.lastSyncAt) }) : copy('尚未完成一次观察')}</p><p>${copy('观察只读取授权范围；断开后停止。')}</p></div></div>` : '';
  const connectVerb = id !== 'google' && source.configured && !code ? copy('获取授权码') : nativeCopy('连接', 'Connect');
  const observed = id === 'google' ? source.counts : null;
  const countLine = source.connected && observed ? ui`<p class="connection-card-counts">${copy('已读取 {emails} 封邮件 · {documents} 份文档', { emails: Number(observed.emails || 0), documents: Number(observed.documents || 0) })}</p>` : '';
  const actions = !waiting ? ui`<div class="source-connection-actions">${source.connected ? ui`<button class="text-button" data-select-connection="${id}" aria-expanded="${selected && !home}">${selected && !home ? copy('收起设置') : copy('管理连接')}</button>${selected && id !== 'google' ? ui`<button class="text-button" data-provider-operation="forget" data-provider="${id}">${copy('断开连接')}</button><button type="button" class="text-button danger-button" data-provider-purge="true" data-provider="${id}">${copy('断开并清除本机副本')}</button>` : ''}` : ui`<button class="secondary-button" data-select-connection="${id}">${copy(connectVerb)} ${providerNames[id]}</button>`}${oauth.phase === 'activation_failed' && id !== 'google' ? ui`<button class="text-button" data-provider-operation="activate" data-provider="${id}">${copy('应用已保存的连接')}</button>` : ''}</div>` : '';
  const headingActions = source.connected ? '' : actions;
  const footerActions = source.connected ? actions : '';
  return {
    id, state,
    html: ui`<article class="source-connection-card${selected ? ' selected' : ''}" data-connection-card="${id}" data-state="${state}" data-selected="${selected}"><div class="source-connection-heading"><span class="source-monogram" aria-hidden="true">${cloudMark[id] || '·'}</span><div class="source-connection-copy"><h3>${providerNames[id]}</h3><p>${source.account?.label ? `${escapeHtml(source.account.label)} · ` : ''}${explanationForCloud(id, description)}</p>${countLine}</div><span class="state-badge ${failed ? 'offline' : source.connected ? 'done' : 'waiting'}">${label}</span>${headingActions}</div>${detail}${notice}${device}${browser}${form}${footerActions}</article>`
  };
}

function explanationForCloud(id, description) {
  if (id === 'google') return description;
  return description;
}

// The demo observes simulated sources only. Show exactly what they produced,
// with access stated plainly, instead of an empty catalog of real providers.
function renderDemoSources() {
  const state = current || {};
  const rows = [
    { mark: '@', name: nativeCopy('模拟邮箱', 'Simulated mail'), items: (state.inbox || []).length, unit: nativeCopy('封邮件', 'messages'), write: nativeCopy('仅写入本地模拟发件箱', 'Writes to the local simulated outbox only') },
    { mark: '◇', name: nativeCopy('模拟文档', 'Simulated documents'), items: (state.documents || []).length, unit: nativeCopy('份文档', 'documents'), write: nativeCopy('修改关闭', 'Modify off') },
    { mark: '↺', name: nativeCopy('模拟实验记录', 'Simulated experiment runs'), items: (state.runRecords || []).length, unit: nativeCopy('条运行记录', 'run records'), write: nativeCopy('修改关闭', 'Modify off') }
  ];
  const latest = at => { const items = (state.events || []).filter(event => event.type?.startsWith(at)); return items[0]?.at ? formatTime(items[0].at) : nativeCopy('尚未观察到', 'Not observed yet'); };
  const latestFor = ['email', 'document', 'experiment'];
  return ui`<div class="demo-sources"><header class="demo-sources-head"><h2>${nativeCopy('演示来源', 'Demo sources')}</h2><p>${nativeCopy('本地模拟，不会联系任何真实账号。', 'Local simulation. No real account is contacted.')}</p></header><ul class="demo-source-list">${rows.map((row, index) => ui`<li><span class="source-monogram" aria-hidden="true">${row.mark}</span><span class="demo-source-copy"><strong>${row.name}</strong><small>${String(row.items)} ${row.unit} · ${nativeCopy('最近', 'Latest')} ${latest(latestFor[index])}</small></span><span class="demo-source-access"><span data-access="on">${nativeCopy('读取 开', 'Read on')}</span><span data-access="off">${row.write}</span></span></li>`).join('')}</ul><section class="demo-next"><h3>${copy('开始照看你自己的工作')}</h3><p>${runtime.demo?.disposable ? copy('这是用完即清理的演示空间。退出演示，启动个人工作区后再连接账号，设置才会保留。') : nativeCopy('这是示例工作区。请在个人工作区连接你的来源。', 'This is a sample workspace. Connect your sources in your personal workspace.')}</p><code>npm start</code></section></div>`;
}

function renderConnectors({ home = false } = {}) {
  if (!runtime || !setupState) return `<p class="empty-trace">${copy('正在读取本地连接设置。')}</p>`;
  if (runtime.demo?.disposable || runtime.demo?.ruleBased) return home ? '' : renderDemoSources();
  const order = ['google', 'github', 'microsoft', 'slack', 'notion', 'local_files', 'apple_notes'];
  const cards = order.map(id => ['local_files', 'apple_notes'].includes(id) ? renderNativeCard(id) : renderCloudCard(id, { home }))
    .filter(card => home || connectionMatches(card.id));
  const allIds = order;
  const connectedCount = allIds.filter(id => connectionState(id) === 'connected').length;
  const attentionCount = allIds.filter(id => connectionState(id) === 'attention').length;
  const availableCount = allIds.filter(id => connectionState(id) === 'available').length;

  if (home) {
    const content = `<div class="source-connection-list">${cards.map(card => card.html).join('')}</div>`;
    const modelStillOnHome = byId('modelOnboarding')?.parentElement?.id === 'homeModelHost' && !byId('modelOnboarding').hidden && !modelConnectionVerified();
    const facts = !setupState.workspace?.ready && !modelStillOnHome ? privacyFacts() : '';
    const heading = `<div class="connection-catalog-heading"><div><h2>${copy('连接工作来源')}</h2><p>${copy('先连一个来源。读取默认开启，发送和修改要单独允许。')}</p>${facts}</div></div>`;
    if (setupState.workspace?.ready) return `<details class="home-connections" data-preserve="home-connections"><summary>${copy('工作来源')} · ${connectedCount} ${copy('个已连接')}</summary>${content}</details>`;
    return heading + content;
  }

  const toolbar = ui`<div class="connection-overview"><span data-tone="connected"><strong>${connectedCount}</strong>${copy('个已连接')}</span><span data-tone="attention"><strong>${attentionCount}</strong>${copy('个需处理')}</span><span data-tone="available"><strong>${availableCount}</strong>${copy('个可连接')}</span></div><div class="connection-toolbar"><label class="collection-search"><span class="sr-only">${copy('搜索连接')}</span>${workspaceSearchIcon()}<input type="search" data-connection-search value="${escapeHtml(connectionQuery)}" placeholder="${copy('搜索来源或账号')}"></label><div class="collection-filters" role="group" aria-label="${copy('筛选连接')}">${[['all','全部'],['connected','已连接'],['attention','需处理'],['available','可连接']].map(([value,label]) => ui`<button data-connection-filter="${value}" aria-pressed="${connectionFilter === value}">${copy(label)}</button>`).join('')}</div></div>`;

  const empty = `<div class="source-connection-empty"><h3>${copy('没有相符的连接')}</h3><p>${copy('换个关键词，或清除状态筛选。')}</p><button class="secondary-button" data-clear-connections>${copy('清除筛选')}</button></div>`;
  const summaries = [['attention', copy('需要处理')], ['connected', copy('已连接')], ['available', copy('可连接')]].map(([state, label]) => {
    const matches = cards.filter(card => card.state === state);
    if (!matches.length) return '';
    return `<section class="connection-summary-group"><h3>${label}<span>${matches.length}</span></h3>${matches.map(card => {
      const local = ['local_files', 'apple_notes'].includes(card.id);
      const source = local ? setupState.localSources?.[card.id] || {} : setupState.connections?.[card.id] || {};
      const name = providerNames[card.id] || (card.id === 'local_files' ? nativeCopy('本地文件夹', 'Local folders') : nativeCopy('备忘录', 'Apple Notes'));
      const account = card.id === 'google' ? setupState.google?.accountEmail : source.account?.label;
      const scope = local ? (source.scopes || []).map(item => item.label).join(' · ') : account;
      const detail = scope || (local ? nativeCopy('所选文件夹中的内容', 'Content in selected folders') : copy(cloudAccess[card.id] || '邮件与文档'));
      const status = card.state === 'connected' ? copy('已连接') : card.state === 'attention' ? copy('需处理') : copy('尚未连接');
      return `<button type="button" class="connection-summary-row${selectedConnection === card.id ? ' is-selected' : ''}" data-inspect-connection="${card.id}" aria-pressed="${selectedConnection === card.id}"><span class="source-monogram" aria-hidden="true">${cloudMark[card.id] || (card.id === 'local_files' ? 'F' : 'N')}</span><span class="connection-summary-copy"><strong>${name}</strong><small>${escapeHtml(detail)}</small></span><span class="connection-summary-state" data-state="${card.state}">${status}</span><span class="connection-summary-arrow" aria-hidden="true">↗</span></button>`;
    }).join('')}</section>`;
  }).join('');
  const activeCard = cards.some(card => card.id === selectedConnection);
  const details = cards.map(card => card.html.replace('<article ', `<article ${card.id === selectedConnection ? '' : 'hidden '} `)).join('');
  const placeholder = activeCard ? '' : `<div class="connection-inspector-empty">${workspaceSearchIcon()}<h2>${nativeCopy('选择一个连接', 'Choose a connection')}</h2><p>${nativeCopy('查看账号、访问范围与最近一次观察。', 'Inspect its account, access and latest observation.')}</p><span>${nativeCopy('读取与修改分别授权', 'Read and modify access are separate')}</span></div>`;
  return toolbar + `<div class="connection-workbench" data-inspecting="${activeCard}"><div class="connection-source-index"><header><h2>${nativeCopy('工作来源', 'Work sources')}</h2><span>${cards.length}</span></header>${summaries || empty}</div><aside class="connection-inspector"${activeCard ? '' : ' hidden'} aria-label="${nativeCopy('访问与权限', 'Access and permissions')}"><div class="connection-inspector-label"><span>${nativeCopy('访问与权限', 'Access and permissions')}</span>${activeCard ? `<button type="button" class="icon-button" data-close-connection-inspector aria-label="${nativeCopy('收起连接详情', 'Close connection details')}">×</button>` : ''}</div>${placeholder}${details}</aside></div>`;
}

function workspaceSearchIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
}


function renderObservation() {
  const monitoring = setupState?.monitoring || {};
  const labels = { off: '自动观察已暂停', syncing: '正在同步变化', watching: '持续观察中', failed: '最近一次观察失败', expired: '观察状态已过期', starting: '正在进行首次观察' };
  return ui`<h2>${copy('持续观察')}</h2><p class="setup-note" role="status">${copy(labels[monitoring.status] || '需要先连接工作来源')}${monitoring.lastSuccessAt ? ' · ' + copy('最近成功观察') + ' ' + time(monitoring.lastSuccessAt) : ''}</p><form data-monitor-form class="monitoring-config" data-preserve="observation-settings"><label class="setup-toggle"><input name="enabled" type="checkbox" ${monitoring.enabled ? 'checked' : ''}><span><strong>${copy('持续观察变化')}</strong><small>${copy('关闭网页后继续运行；退出本地服务后暂停。')}</small></span></label><label class="setup-field">${copy('检查间隔')}<select name="intervalMs">${[[60000,'1 分钟'],[300000,'5 分钟'],[900000,'15 分钟'],[3600000,'1 小时']].map(([value,label]) => ui`<option value="${value}" ${Number(monitoring.intervalMs || 300000) === value ? 'selected' : ''}>${copy(label)}</option>`).join('')}</select></label><button type="submit" class="secondary-button">${copy('保存观察设置')}</button><button type="button" class="text-button" data-sync-now ${monitoring.running ? 'disabled' : ''}>${copy('现在检查')}</button></form>${monitoring.lastError ? ui`<details class="connection-advanced" data-preserve="source-sync-error"><summary>${copy('查看最近一次同步错误')}</summary><p class="setup-error">${escapeHtml(monitoring.lastError)}</p></details>` : ''}`;
}

let setupState = null;
let setupRefreshTimer = null;
let oauthPollTimer = null;
let setupBusy = false;
let forgetBusy = false;

const connectionErrors = new Map();
let oauthPopup = null;
let oauthCallbackOrigin = null;

async function startSourceAuthorization(id, form = null) {
  const popup = window.open('about:blank', '_blank', 'popup,width=600,height=760');
  if (popup) connectionPopups.set(id, popup);
  const data = form ? new FormData(form) : null;
  try {
    const result = await postJSON(`/api/setup/connections/${id}/authorize`, {
      clientId: data?.get('clientId') || undefined, clientSecret: data?.get('clientSecret') || undefined, observe: data ? data.has('observe') : true, drafts: data?.has('drafts') === true
    });
    connectionErrors.delete(id);
    if (result.oauth.userCode) {
      try { await navigator.clipboard.writeText(result.oauth.userCode); toast(copy('授权码已复制，在官方页面粘贴即可。')); }
      catch { /* the explicit Copy code control remains available */ }
    }
    if (popup && !popup.closed && result.oauth.authorizeUrl) popup.location.href = result.oauth.authorizeUrl;
    else if (popup && !result.oauth.authorizeUrl) popup.close();
    await refreshSetup({ quiet: true });
  } catch (error) {
    popup?.close(); connectionPopups.delete(id);
    connectionErrors.set(id, copy(error.message)); renderDashboard(); throw error;
  }
}

document.addEventListener('click', async event => {
  const expand = event.target.closest('[data-expand-task]');
  if (expand) { const id = expand.dataset.expandTask; if (expandedTasks.has(id)) expandedTasks.delete(id); else expandedTasks.add(id); renderDashboard(); return; }
  const button = event.target.closest('[data-native-operation], [data-native-purge]');
  if (!button || setupBusy) return;
  const purge = button.hasAttribute('data-native-purge');
  if (purge && !window.confirm(copy('断开并清除会删除这个来源在本机的收件、任务、快照和衍生内容。此操作不能撤销。'))) return;
  setupBusy = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    const result = await postJSON(`/api/setup/local-sources/${button.dataset.nativeSource}/${purge ? 'forget' : button.dataset.nativeOperation}`, { locale: getLocale() === 'en' ? 'en' : 'zh-CN', id: button.dataset.scopeId, ...(purge ? { purgeLocal: true } : {}) });
    if (!result.cancelled) { await refreshSetup({ quiet: true }); await refreshState(); if (purge) toast(copy('这个来源已断开，本机副本已清除。')); }
  } catch (error) { toast(copy(error.message), true); }
  finally { setupBusy = false; button.disabled = false; button.removeAttribute('aria-busy'); }
});
document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-native-path-form]'); if (!form) return;
  event.preventDefault(); if (setupBusy) return; setupBusy = true;
  const button = form.querySelector('button'); button.disabled = true;
  try { await postJSON('/api/setup/local-sources/local_files/select', { path: new FormData(form).get('path') }); await refreshSetup({ quiet: true }); await refreshState(); }
  catch (error) { toast(copy(error.message), true); }
  finally { setupBusy = false; button.disabled = false; }
});

document.addEventListener('click', async event => {
  const closeInspector = event.target.closest('[data-close-connection-inspector]');
  if (closeInspector) {
    const previous = selectedConnection;
    selectedConnection = null; renderDashboard(); updateContent('setupContent', renderSetupPanel());
    const row = document.querySelector(`[data-inspect-connection="${CSS.escape(previous)}"]`);
    row?.focus({ preventScroll: true });
    if (matchMedia('(max-width: 1000px)').matches) row?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const inspect = event.target.closest('[data-inspect-connection]');
  if (inspect) {
    selectedConnection = inspect.dataset.inspectConnection; renderDashboard(); updateContent('setupContent', renderSetupPanel());
    if (matchMedia('(max-width: 1000px)').matches) requestAnimationFrame(() => document.querySelector('.connection-inspector')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
    return;
  }
  const selected = event.target.closest('[data-select-connection]');
  const operation = event.target.closest('[data-provider-operation], [data-provider-purge]');
  const code = event.target.closest('[data-copy-device-code]');
  if (!selected && !operation && !code) return;
  if (code) {
    const value = setupState?.connections?.[code.dataset.copyDeviceCode]?.oauth?.userCode;
    if (value) try { await navigator.clipboard.writeText(value); toast(copy('授权码已复制，在官方页面粘贴即可。')); } catch { toast(copy('请选择上方授权码并复制。')); }
    return;
  }
  if (setupBusy) return;
  if (selected) {
    const id = selected.dataset.selectConnection;
    const connected = id === 'google' ? setupState.google?.configuredThisRun && !setupState.google?.runtimeDisabled : setupState.connections?.[id]?.connected;
    if (currentView === 'sources' && selectedConnection === id && connected) {
      selectedConnection = null; renderDashboard(); updateContent('setupContent', renderSetupPanel()); return;
    }
    selectedConnection = id; renderDashboard(); updateContent('setupContent', renderSetupPanel());
    if (id === 'google') {
      const target = currentView === 'sources' ? byId('googleSetupPanel') : byId('workspaceOnboarding');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
    }
    const phase = setupState.connections?.[id]?.oauth?.phase;
    if (setupState.connections?.[id]?.configured && !setupState.connections[id].connected && !(setupState.connections[id].flow === 'code' && ['failed', 'expired'].includes(phase))) {
      setupBusy = true;
      try { await startSourceAuthorization(id); } catch (error) { toast(copy(error.message), true); }
      finally { setupBusy = false; }
    }
    return;
  }
  const purge = operation.hasAttribute('data-provider-purge');
  if (purge && !window.confirm(copy('断开并清除会删除这个来源在本机的收件、任务、快照和衍生内容。此操作不能撤销。'))) return;
  setupBusy = true; operation.disabled = true;
  try {
    await postJSON(`/api/setup/connections/${operation.dataset.provider}/${purge ? 'forget' : operation.dataset.providerOperation}`, purge ? { purgeLocal: true } : {});
    await refreshSetup({ quiet: true }); await refreshState();
    if (purge) toast(copy('这个来源已断开，本机副本已清除。'));
  } catch (error) { toast(copy(error.message), true); }
  finally { setupBusy = false; operation.disabled = false; }
});

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-connection-form]');
  if (!form) return;
  event.preventDefault(); if (setupBusy) return;
  setupBusy = true; const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try { await startSourceAuthorization(form.dataset.connectionForm, form); }
  catch (error) { toast(copy(error.message), true); }
  finally { setupBusy = false; button.disabled = false; }
});

function connectionProblem() {
  const code = setupState?.google?.issue?.code || setupState?.oauth?.code;
  const messages = {
    GOOGLE_RECONNECT: 'Google 授权已失效。重新连接即可继续，已有工作记录会保留。',
    GOOGLE_API_DISABLED: 'Google 项目尚未开启所需 API。开启后点击「重试同步」。',
    GOOGLE_ACCESS_DENIED: 'Google 拒绝读取部分内容。检查所选权限，以及组织管理员是否允许此应用。',
    GOOGLE_RATE_LIMITED: 'Google 暂时限制了请求。稍后会再次观察，也可以手动重试。',
    GOOGLE_UNREACHABLE: '暂时无法连接 Google。检查网络后重试，已有记录会保留。',
    GOOGLE_SYNC_FAILED: '这次观察未完成。可以重试，或展开详情查看原因。',
    GOOGLE_SCOPE_MISSING: 'Google 没有授予全部所选权限。重新连接并勾选需要的读取权限。',
    GOOGLE_IDENTITY_FAILED: '未能确认 Google 账号身份。请重新选择账号并授权。',
    GOOGLE_REFRESH_MISSING: 'Google 未提供持续访问授权。请在 Google 账号中移除旧授权后重新连接。',
    GOOGLE_EXCHANGE_FAILED: 'Google 授权交换未完成。检查网络与客户端配置后重新连接。',
    GOOGLE_ADMIN_BLOCKED: '组织管理员限制了此应用。请联系管理员允许所需的 Google 访问。',
    GOOGLE_CONSENT_CANCELLED: '你取消了这次授权。准备好后可以继续连接。'
  };
  return messages[code] ? copy(messages[code]) : '';
}

function renderSetupPanel({ home = false } = {}) {
  if (runtime?.demo?.disposable) return ui`<section class="demo-next"><h3>${copy('开始照看你自己的工作')}</h3><p>${copy('这是用完即清理的演示空间。退出演示，启动个人工作区后再连接账号，设置才会保留。')}</p><code>npm start</code></section>`;
  if (!setupState) return `<p class="empty-trace">${copy('正在读取本地连接设置。')}</p>`;
  const google = setupState.google || {};
  const monitoring = setupState.monitoring || {};
  const oauth = setupState.oauth || {};
  const ready = google.configuredThisRun === true && google.runtimeDisabled !== true;
  const connecting = google.activating || ['authorizing', 'connecting'].includes(oauth.phase);
  const problem = connectionProblem();
  const observed = setupState.workspace?.observed || {};
  const pending = setupState.workspace?.reasoning?.pending || 0;
  const failedReasoning = setupState.workspace?.reasoning?.failed || 0;
  const phase = connecting ? 'connecting' : !ready ? 'not_connected' : monitoring.running ? 'syncing'
    : problem ? 'failed' : pending ? 'reasoning' : failedReasoning ? 'model_failed'
      : !monitoring.lastRunAt ? 'not_checked' : !monitoring.enabled ? 'paused' : monitoring.expired ? 'expired' : 'watching';
  const labels = { connecting: '正在连接 Google', not_connected: '等待连接 Google', syncing: '正在读取你的工作环境', failed: '连接需要处理',
    reasoning: '正在核对发现的工作', model_failed: '模型读取需要处理', not_checked: '等待首次检查', paused: '自动观察已暂停', expired: '观察状态已过期', watching: '正在照看你的工作' };
  const tone = ['failed', 'expired', 'model_failed'].includes(phase) ? 'offline' : phase === 'watching' ? 'done' : 'waiting';
  const stats = ready ? ui`<dl class="connection-stats"><div><dt>${copy('已读取邮件')}</dt><dd>${Number(observed.emails || 0)}</dd></div><div><dt>${copy('已读取文档')}</dt><dd>${Number(observed.documents || 0)}</dd></div><div><dt>${copy('发现的工作')}</dt><dd>${Number(observed.tasks || 0)}</dd></div></dl>` : '';
  const summary = ui`<div class="connection-heading"><div><span class="connection-step">${copy('连接自己的工作环境')}</span><h2>${ready ? escapeHtml(google.accountEmail || 'Google Workspace') : copy('连接 Google，让 Agent 从你的工作中发现事情。')}</h2></div><span class="state-badge ${tone}" role="status">${copy(labels[phase])}</span></div>${stats}`;
  const issue = problem ? ui`<div class="connection-issue" role="status"><p>${escapeHtml(problem)}</p>${google.issue?.action === 'enable_api' ? ui`<p><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">${copy('开启 Gmail API')} ↗</a> · <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">${copy('开启 Drive API')} ↗</a></p>` : ''}</div>` : '';
  const outcome = ready && !monitoring.running && !pending && monitoring.lastSuccessAt ? ui`<p class="connection-outcome">${observed.tasks ? copy('发现的工作已经放在下方。你可以查看来源和下一步。') : copy('已检查目前读取到的内容，暂未发现有依据的待办。有新变化时会继续核对。')}</p>` : '';
  const busyStatus = connecting ? ui`<div class="connection-progress" role="status"><span class="connection-pulse" aria-hidden="true"></span><p>${copy(oauth.phase === 'authorizing' ? '在 Google 窗口选择账号并允许读取，完成后这里会自动连接。' : '正在切换到你的真实工作空间，无需重启。')}</p>${oauth.authorizeUrl ? ui`<a class="text-button" href="${escapeHtml(oauth.authorizeUrl)}" target="_blank" rel="noopener">${copy('继续 Google 授权')} ↗</a>` : ''}${oauth.phase === 'authorizing' ? ui`<button class="text-button" data-google-cancel>${copy('取消连接')}</button>` : ''}</div>` : '';
  const oauthNote = oauth.phase === 'expired' ? copy('Google 授权已过期。准备好后重新连接即可。')
    : oauth.phase === 'cancelled' ? copy('你取消了这次授权。准备好后可以继续连接。')
      : oauth.phase === 'activation_failed' ? copy('授权已保存。点击应用连接后继续。') : '';
  const error = connectionErrors.get('google');
  const errorLine = `<p class="setup-error" data-connection-error role="alert" ${error ? '' : 'hidden'}>${escapeHtml(error || '')}</p>${oauthNote ? `<p class="setup-note" role="status">${escapeHtml(oauthNote)}</p>` : ''}`;
  if (home && ready && !connecting) return summary + errorLine + issue + (phase === 'not_checked' ? ui`<button class="secondary-button" data-sync-now>${copy('开始首次检查')}</button>` : '') + (problem ? ui`<button class="secondary-button" ${google.issue?.action === 'reauthorize' ? 'data-google-reconnect' : 'data-sync-now'}>${copy(google.issue?.action === 'reauthorize' ? '重新连接 Google' : '重试同步')}</button>` : '') + outcome + (failedReasoning ? ui`<p class="setup-error">${copy('部分工作未完成模型读取。检查模型连接后可以重新核对。')}</p><button class="text-button" data-reasoning-retry>${copy('重新核对工作')}</button>` : '') + ui`<div class="connection-footer"><p>${monitoring.lastSuccessAt ? copy('最近成功观察') + ' · ' + time(monitoring.lastSuccessAt) : copy('首次观察正在开始。')}${monitoring.enabled ? ' · ' + copy('关闭页面后仍会观察，本地服务需要保持运行。') : ''}</p><button class="text-button" data-go="sources">${copy('管理连接与观察')}</button></div>`;
  const scope = google.requestedScopes || { readGmail: true, readDrive: true, docsWrite: false, gmailSend: false };
  const permissionChoices = ui`<fieldset class="connection-scopes"><legend>${copy('让 Agent 读取什么？')}</legend><label><input type="checkbox" name="readGmail" ${scope.readGmail ? 'checked' : ''}><span><strong>Gmail</strong><small>${copy('首次读取最近 3 天的邮件，之后跟进新邮件。')}</small></span></label><label><input type="checkbox" name="readDrive" ${scope.readDrive ? 'checked' : ''}><span><strong>Google Docs</strong><small>${copy('首次读取最多 20 份近期文档，之后跟进变化。')}</small></span></label></fieldset>`;
  const observeChoice = ui`<label class="setup-toggle"><input name="observe" type="checkbox" ${ready ? monitoring.enabled ? 'checked' : '' : 'checked'}><span><strong>${copy('连接后持续观察')}</strong><small>${copy('立即检查一次，之后默认每 5 分钟检查变化，可以随时暂停。')}</small></span></label>`;
  const disclosure = ui`<p class="connection-disclosure">${copy('读取的工作内容会交给你选择的模型理解。首次只申请读取，发送邮件和修改文档另行开启。')}</p>`;
  const cloudGuide = ui`<div class="google-client-guide"><h3>${copy('首次自托管：准备 Google 连接')}</h3><p>${copy('当前发行版没有预置 Google 客户端。完成下面一次性设置后，后续只需选择账号。')}</p><ol><li><strong>${copy('开启所需 API')}</strong><p><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API ↗</a> · <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Drive API ↗</a></p></li><li><strong>${copy('设置使用者')}</strong><p><a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">${copy('打开 OAuth 使用者设置')} ↗</a> · ${copy('外部测试应用需要将自己的 Google 账号加入测试用户。')}</p></li><li><strong>${copy('下载桌面客户端')}</strong><p><a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">${copy('创建 OAuth 客户端')} ↗</a> · ${copy('应用类型选择 Desktop app，下载 JSON 后回到这里。')}</p></li></ol><details data-preserve="google-cloud-help"><summary>${copy('遇到 Google 设置问题？')}</summary><p>${copy('请在同一个 Google Cloud 项目中完成以上设置。测试状态的授权可能在 7 天后需要重新连接。')}</p><a href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noopener">${copy('Google 官方连接说明')} ↗</a></details></div>`;
  const initialForm = google.credentialsConfiguredExternally ? ui`<p class="setup-note">${copy('Google 连接由启动环境管理。账号、权限和访问范围以启动设置为准。')}</p>` : !ready
    ? ui`${google.hasClient ? '' : cloudGuide}<form ${google.hasClient ? 'data-scope-form' : 'data-google-client-form'} data-preserve="google-connect-${home ? 'home' : 'settings'}">${!google.hasClient ? ui`<label class="google-client-drop" data-client-drop><strong>${copy('选择或拖入客户端 JSON')}</strong><span>${copy('只读取 Google Desktop 客户端配置，文件保留在你的设备上。')}</span><input type="file" name="clientJson" accept="application/json,.json" required></label>` : ''}${permissionChoices}${observeChoice}${disclosure}<div class="action-row"><button type="submit" class="primary-button" data-google-authorize ${connecting ? 'disabled' : ''}>${copy(google.hasClient ? '连接 Google' : '导入并连接 Google')}</button></div></form>` : '';
  const granted = new Set(google.grantedScopes || []);
  const writeForm = ready && !google.credentialsConfiguredExternally ? ui`<details class="connection-advanced" data-preserve="google-write-access"><summary>${copy('发送与文档修改权限')}</summary><form class="google-scopes" data-scope-form data-enable-writes="true"><input type="hidden" name="readGmail" ${scope.readGmail ? '' : 'disabled'}><input type="hidden" name="readDrive" ${scope.readDrive ? '' : 'disabled'}><input type="hidden" name="observe" ${monitoring.enabled ? '' : 'disabled'}><label><input type="checkbox" name="gmailSend" ${scope.gmailSend ? 'checked' : ''}>${copy('允许申请 Gmail 发送权限')}</label><label><input type="checkbox" name="docsWrite" ${scope.docsWrite ? 'checked' : ''}>${copy('允许申请 Google Docs 修改权限')}</label><p class="setup-note">${copy('开启后只执行你在具体行动中批准或约定的操作。Google Docs 修改需要同时保留文档读取权限。')}</p><button type="submit" class="secondary-button">${copy('开启所选行动权限')}</button></form>${granted.has('https://www.googleapis.com/auth/gmail.send') || granted.has('https://www.googleapis.com/auth/documents') ? ui`<form data-write-permission-form><label class="setup-toggle"><input name="allowExternalWrites" type="checkbox" ${google.allowExternalWrites ? 'checked' : ''}><span><strong>${copy('允许执行我已授权的发送与修改')}</strong><small>${copy('立即生效；每次执行仍会核对授权范围和最新证据。')}</small></span></label><button type="submit" class="secondary-button">${copy('保存行动权限')}</button></form>` : ''}<a class="text-button" href="https://console.cloud.google.com/apis/library/docs.googleapis.com" target="_blank" rel="noopener">${copy('开启 Google Docs API')} ↗</a></details>` : '';
  const readScopeForm = ready && !google.credentialsConfiguredExternally ? ui`<details class="connection-advanced" data-preserve="google-read-access"><summary>${copy('调整读取来源')}</summary><form data-scope-form data-preserve="read-source-settings">${permissionChoices}${observeChoice}<p class="setup-note">${copy('更新读取来源会恢复只读。需要发送或修改时，可以重新开启行动权限。')}</p><button type="submit" class="secondary-button">${copy('更新读取范围')}</button></form></details>` : '';
  const recovery = !ready && google.hasRefreshToken && !connecting ? ui`<button class="secondary-button" data-google-activate>${copy('应用已保存的 Google 连接')}</button>` : '';
  const details = ready ? ui`<details class="connection-advanced" data-preserve="google-diagnostics"><summary>${copy('连接详情与诊断')}</summary><dl class="setup-dates"><div><dt>${copy('最近成功观察')}</dt><dd>${monitoring.lastSuccessAt ? time(monitoring.lastSuccessAt) : copy('尚无成功记录')}</dd></div><div><dt>${copy('最近一次错误')}</dt><dd>${escapeHtml(monitoring.lastError || copy('无失败记录'))}</dd></div></dl><button type="button" class="text-button" data-google-validate>${copy('检查账号授权')}</button>${!google.credentialsConfiguredExternally ? ui`<button type="button" class="text-button" data-google-reconnect>${copy('重新连接 Google')}</button>` : ''}</details>` : '';
  return summary + busyStatus + issue + errorLine + outcome + recovery + initialForm + readScopeForm + writeForm + details
    + (google.hasRefreshToken ? ui`<div class="connection-footer"><p>${copy('断开后停止读取和执行，已观察到的本机工作记录会保留。要删除本机副本，使用「断开并清除」。')}</p><span class="connection-footer-actions"><button type="button" class="text-button" data-google-forget>${copy('断开 Google')}</button><button type="button" class="text-button danger-button" data-google-purge>${copy('断开并清除本机副本')}</button></span></div>` : '');
}

async function refreshSetup({ quiet = false } = {}) {
  try {
    const requestedWorkspace = current && workspaceKey(current);
    const response = await fetch('/api/setup');
    if (!response.ok) throw new Error('Local setup is unavailable.');
    const nextSetup = await response.json();
    if (requestedWorkspace && current && requestedWorkspace !== workspaceKey(current)
      && nextSetup.workspace?.id !== (current.runtime?.workspaceId || current.mode)) return;
    setupState = nextSetup;
    if (runtime && (runtime.mode !== setupState.workspace?.mode || runtime.googleRuntimeDisabled !== setupState.google.runtimeDisabled && Boolean(runtime.googleRuntimeDisabled))) {
      const response = await fetch('/api/runtime');
      if (response.ok) renderRuntime(await response.json(), { refresh: false });
    }
    if (runtime) runtime.monitoring = setupState.monitoring;
    updateContent('setupContent', renderSetupPanel());
    updateContent('observationContent', renderObservation());
    if (current) renderDashboard();
    if (['authorizing', 'connecting'].includes(setupState.oauth?.phase) || Object.values(setupState.connections || {}).some(source => ['starting', 'authorizing', 'verifying'].includes(source.oauth?.phase)) || setupState.monitoring?.running || setupState.workspace?.reasoning?.pending) {
      if (!oauthPollTimer) oauthPollTimer = setInterval(() => { void refreshSetup({ quiet: true }); }, 1000);
    } else if (oauthPollTimer) { clearInterval(oauthPollTimer); oauthPollTimer = null; }
    for (const [id, popup] of connectionPopups) {
      if (['connected', 'cancelled', 'expired', 'failed', 'activation_failed'].includes(setupState.connections?.[id]?.oauth?.phase)) { if (!popup.closed) popup.close(); connectionPopups.delete(id); }
    }
    if (setupState.oauth?.phase === 'connected' && oauthPopup && !oauthPopup.closed) { oauthPopup.close(); oauthPopup = null; }
  } catch (error) { if (!quiet) toast(error.message, true); }
}

document.addEventListener('click', event => {
  const connection = event.target.closest('[data-connection-filter]');
  const activity = event.target.closest('[data-activity-filter]');
  const clearConnections = event.target.closest('[data-clear-connections]');
  if (connection) { connectionFilter = connection.dataset.connectionFilter; renderDashboard(); }
  if (clearConnections) { connectionFilter = 'all'; connectionQuery = ''; renderDashboard(); }
  if (activity) {
    activityFilter = activity.dataset.activityFilter;
    document.querySelectorAll('[data-activity-filter]').forEach(button => button.setAttribute('aria-pressed', String(button === activity)));
    renderDashboard();
  }
});
document.addEventListener('input', event => {
  if (event.target.hasAttribute('data-connection-search')) { connectionQuery = event.target.value; renderDashboard(); }
  if (event.target.id === 'activitySearch') { activityQuery = event.target.value; renderDashboard(); }
});

// Preserve expanded content, focused controls and text through streaming updates.
function updateContent(id, html) {
  updateElement(byId(id), html);
}

function updateElement(root, html) {
  if (!root || root._renderedHTML === html) return;
  preserveInteraction(root, () => { root.innerHTML = html; });
  root._renderedHTML = html;
}

function renderDemoJourney() {
  const root = byId('demoJourney');
  if (!root) return;
  root.hidden = !runtime?.demo?.enabled;
  if (root.hidden || !current) return;
  const task = current.tasks[0];
  const verified = task?.status === 'completed' && task.action?.status === 'verified_simulated' && task.action?.receiptId;
  const ready = task?.status === 'ready_for_approval';
  const stopped = task && isClosedTask(task) && task.status !== 'completed';
  const blocked = task?.status === 'blocked';
  const phase = verified ? 'verified' : ready ? 'ready' : stopped ? 'stopped' : blocked ? 'blocked' : task ? 'checking' : 'watching';
  root.dataset.phase = phase;
  const title = verified ? '回复已发送，模拟回执已核验。' : ready ? '证据齐了。看过回复，再决定是否发送。' : stopped ? '已按你的选择停止，不会替你发送。' : blocked ? '结果还没确认，我会保留不确定性。' : task ? '发现了该跟进的事，正在等齐证据。' : '不用给我任务。看看接下来会发生什么。';
  const detail = verified ? '这是模拟回执，不是真实发送。你可以查看结果、换个场景，或开始自己的工作区。' : ready ? '文档由演示环境更新。我核对了要求和最新结果，并准备好回复。' : stopped ? '你随时可以选择不做。重播演示可以重新体验完整过程。' : blocked ? '先核对执行结果，再决定下一步。不会盲目重试。' : task ? '没有让你补写提示词，也不会因为文档有变化就直接宣布完成。' : '约 15 秒：一封请求到来，文档逐渐更新，我会自己关联和核对。';
  const step = verified ? 3 : ready || blocked ? 2 : task ? 1 : 0;
  const labels = ['主动发现', '核对证据', '核验结果'];
  const action = verified
    ? ui`<button class="secondary-button" data-open-task="${escapeHtml(task.id)}">${copy('查看核验结果')} ↗</button>`
    : ready ? ui`<button class="primary-button" data-go="attention">${copy('查看准备好的回复')} →</button>` : '';
  updateContent('demoJourney', ui`<div class="demo-journey-copy"><span class="demo-caption">${copy(runtime.demo?.disposable ? '本地演示 · 无需连接账号' : '示例工作区 · 使用已连接的模型')}</span><h2>${copy(title)}</h2><p>${copy(detail)}</p></div><div class="demo-journey-bottom"><ol class="demo-steps">${labels.map((label, index) => `<li class="${index < step ? 'complete' : index === step ? 'current' : ''}"${index === step ? ' aria-current="step"' : ''}><span aria-hidden="true">${index < step ? '✓' : index + 1}</span>${copy(label)}</li>`).join('')}</ol>${action}</div>${verified || stopped ? ui`<div class="demo-next-links"><button class="text-button" data-go="sources">${copy('开始自己的工作区')}</button><a class="text-button" href="https://github.com/PStarH/unprompted/blob/main/docs/EXTENDING.md" target="_blank" rel="noopener">${copy('开发者：运行第一个场景')} ↗</a><button class="text-button" data-demo-replay>${copy('再体验一次')}</button></div>` : ''}`);
}

function privacyFacts() {
  return ui`<ul class="privacy-facts"><li>${copy('邮件、文档和任务内容会发送给你选择的模型。')}</li><li>${copy('本机数据库和密钥不加密，请只在你自己的电脑上运行。')}</li><li>${copy('断开连接会停止读取，但不会删除已保存的记录。要删除本机副本，使用「断开并清除」。')}</li></ul>`;
}

function modelConnectionVerified() {
  const config = setupState?.model || {};
  const model = current?.reasoner || config.runtime || runtime?.reasoner || {};
  return Boolean(model.available && !model.lastError && config.lastValidation?.status === 'verified' && config.model === model.model && config.baseUrl === model.baseUrl);
}

function renderModelPanel() {
  const root = byId('modelOnboarding');
  root.hidden = !runtime || runtime.demo?.disposable || runtime.demo?.ruleBased;
  if (root.hidden) return;
  const config = setupState?.model || {};
  const model = current?.reasoner || config.runtime || runtime.reasoner || {};
  const verified = model.available && !model.lastError && config.lastValidation?.status === 'verified' && config.model === model.model && config.baseUrl === model.baseUrl;
  const active = model.available === true;
  const title = model.lastError ? copy('模型请求失败，请检查连接。') : verified ? copy('模型已连接') : active ? copy('模型已配置，尚未通过连接验证') : copy('先连接你的模型，开始真正的 Agent 体验。');
  const form = config.externallyConfigured
    ? ui`<p class="setup-note">${copy('模型由启动环境配置。修改环境变量并重启，或移除它们后在这里连接。')}</p>`
    : ui`<form data-model-form data-preserve="model-connection"><div class="model-fields"><label>${copy('接口地址')}<input name="baseUrl" type="url" required value="${escapeHtml(config.baseUrl || '')}" placeholder="https://your-provider.example/v1" autocomplete="off"></label><label>${copy('模型 ID')}<input name="model" required maxlength="200" value="${escapeHtml(config.model || '')}" placeholder="your-model-id" autocomplete="off"></label><label>API Key <small>${copy('本地模型可留空')}</small><input name="apiKey" type="password" autocomplete="new-password" placeholder="${config.hasApiKey ? copy('已保存在本机，留空保持不变') : copy('粘贴提供方的 API Key')}" maxlength="8192"></label></div><details class="model-advanced" data-preserve="model-advanced"><summary>${copy('高级选项')}</summary><label>${copy('推理内核')}<select name="harness"><option value="classic" ${config.harness !== 'pi' ? 'selected' : ''}>Standard</option><option value="pi" ${config.harness === 'pi' ? 'selected' : ''}>Pi · read tools</option></select></label></details><p class="setup-note">${copy('Key 只保存在本机。测试使用虚构内容；连接后，任务上下文会发送给所选模型。')}</p><div class="action-row"><button class="primary-button" type="submit">${copy('验证并连接模型')}</button>${active ? ui`<button class="text-button" type="button" data-model-forget>${copy('移除本机模型连接')}</button>` : ''}</div><p class="model-error" role="alert" data-model-error hidden></p></form>`;
  updateContent('modelOnboarding', ui`<div class="model-heading"><div><span class="connection-step">${copy('连接用于理解工作的模型')}</span><h2>${title}</h2>${active ? `<p>${escapeHtml(model.model)} · ${Number(model.calls || 0)} ${copy('次模型请求')}</p>` : ui`<p>${copy('支持兼容接口和本地模型。连接后，再选择让 Agent 读取的工作环境。')}</p>`}${verified ? '' : privacyFacts()}</div><span class="state-badge ${model.lastError ? 'offline' : verified ? 'done' : 'waiting'}">${model.lastError ? copy('模型请求需要检查') : verified ? copy('真实请求已验证') : copy('等待连接')}</span></div>${active ? `<details data-preserve="edit-model"><summary>${copy('更换模型或连接设置')}</summary>${form}</details>` : form}`);
}

function renderDashboard() {
  if (!current || composingElement?.isConnected) return;
  updateGoogleSearchAvailability();
  if (runtime?.demo?.enabled || runtime?.demo?.ruleBased || runtime?.mode === 'simulation') byId('connectionText').textContent = copy('本地模拟');
  const state = current;
  mcpUI?.render();
  durableUI?.render();
  const memoryAdvanced = document.querySelector('#viewMemory .memory-advanced');
  if (memoryAdvanced) memoryAdvanced.hidden = !['durableMemoryContent', 'policyContent', 'experienceContent'].some(id => {
    const host = byId(id);
    return host && !host.hidden && host.childElementCount > 0;
  });
  const modelHost = byId(currentView === 'preferences' || state.reasoner?.available ? 'settingsModelHost' : 'homeModelHost');
  if (byId('modelOnboarding').parentElement !== modelHost) modelHost.append(byId('modelOnboarding'));
  renderModelPanel();
  renderDemoJourney();
  const workspaceOnboarding = byId('workspaceOnboarding');
  const explicitDemo = runtime?.demo?.disposable || runtime?.demo?.ruleBased;
  byId('connectionCatalogHome').hidden = !runtime || explicitDemo;
  updateContent('connectionCatalogHome', explicitDemo ? '' : renderConnectors({ home: true }));
  workspaceOnboarding.hidden = !runtime || explicitDemo || selectedConnection !== 'google';
  // In the demo the source list already carries the next step; no second panel.
  byId('googleSetupPanel').hidden = Boolean(explicitDemo) || selectedConnection !== 'google';
  byId('observationPanel').hidden = !setupState?.workspace?.ready;
  if (setupState?.workspace?.ready) updateContent('observationContent', renderObservation());
  if (!workspaceOnboarding.hidden) updateContent('workspaceOnboarding', renderSetupPanel({ home: true }));
  const firstSetup = !runtime?.demo?.ruleBased && !setupState?.workspace?.ready && !state.tasks.length;
  byId('viewHome').classList.toggle('setting-up', firstSetup);
  byId('viewHome').querySelector('.page-heading h1 span').textContent = copy('工作台');
  interactions?.prepare();
  for (const id of Object.keys(snoozes)) {
    const task = state.tasks.find(item => item.id === id);
    if (!task || !isSnoozed(task, snoozes)) delete snoozes[id];
  }
  scheduleSnoozes();
  const tasks = stableTaskOrder(state.tasks, taskOrder);
  taskOrder = tasks.map(task => task.id);
  const snoozedTasks = tasks.filter(task => needsTaskDecision(task) && isSnoozed(task, snoozes));
  const active = tasks.filter(task => !isClosedTask(task));
  const decisionTasks = tasks.filter(task => needsTaskDecision(task) && !isSnoozed(task, snoozes));
  const recoveryTasks = tasks.filter(task => !needsTaskDecision(task) && !task.control?.paused && ['failed', 'source_disconnected', 'unknown'].includes(taskState(task, workspaceConnections(setupState))));
  const done = tasks.filter(isClosedTask);
  const notices = attentionItems(state);
  const count = decisionTasks.length + recoveryTasks.filter(task => !decisionTasks.some(item => item.id === task.id)).length + notices.length;
  const status = workspacePresentation(state, connected);
  if (connected && runtime && !state.reasoner?.available && !runtime.demo?.ruleBased) Object.assign(status, {
    tone: 'waiting', label: copy('等待模型连接'), title: copy('连接模型后，才会开始理解上下文。'),
    description: copy('当前没有运行模型推理。请先完成上方连接。')
  });
  else if (connected && runtime && !runtime.demo?.ruleBased && !setupState?.workspace?.ready) Object.assign(status, {
    tone: 'waiting', label: copy('等待工作环境'), title: copy('模型已准备好，下一步连接你的工作环境。'),
    description: copy('连接一个工作来源后，我会读取授权内容并发现值得跟进的事情。')
  });
  if (connected && snoozedTasks.length && !count && status.tone === 'needs') Object.assign(status, { tone: 'waiting', label: copy('稍后处理'), title: copy('已备好，按你的安排稍后再看。'), description: copy('暂收起的任务仍在照看，相关内容变化时会重新出现。') });
  const agent = byId('agentStatus');
  agent.className = ui`agent-status ${status.tone}`;
  const journeyVisible = !byId('demoJourney').hidden;
  const statusAction = !connected
    ? ui`<button class="secondary-button" data-sync-state>${copy('重新同步')}</button>`
    : status.tone === 'offline'
      ? ui`<button class="secondary-button" data-go="sources">${copy('检查连接与观察')}</button>`
      : count && !journeyVisible ? ui`<button class="primary-button" data-go="attention">${count === 1 ? copy('处理这个选择') : copy('处理 {count} 个选择', { count })}<span aria-hidden="true"> →</span></button>` : '';
  updateContent('agentStatus', ui`<span class="agent-mark" aria-hidden="true"></span><div class="status-message"><strong title="${escapeHtml(status.description)}">${escapeHtml(status.label)}</strong>${!connected ? `<p>${escapeHtml(status.description)}</p>` : ''}</div>${statusAction}`);
  const modelSetupVisible = Boolean(byId('modelOnboarding').offsetParent);
  const sourceSetupVisible = Boolean(byId('workspaceOnboarding').offsetParent);
  const onboardingVisible = journeyVisible || modelSetupVisible || sourceSetupVisible;
  agent.hidden = onboardingVisible && !statusAction;
  const sidebarStatus = byId('sidebarStatus');
  if (sidebarStatus) sidebarStatus.textContent = status.label;
  const sidebarDot = byId('sidebarDot');
  if (sidebarDot) sidebarDot.dataset.tone = status.tone === 'needs' ? 'needs' : ['offline', 'waiting'].includes(status.tone) ? 'offline' : 'active';
  const sidebarMode = byId('sidebarMode');
  if (sidebarMode) sidebarMode.textContent = byId('footerMode')?.textContent || copy('本地工作区');
  byId('taskTotal').textContent = tasks.length;
  byId('attentionCount').textContent = active.filter(task => stateGroup(taskState(task, workspaceConnections(setupState))) === 'attention' && !isSnoozed(task, snoozes)).length;
  byId('workingCount').textContent = active.filter(task => taskState(task, workspaceConnections(setupState)) === 'working').length;
  byId('waitingCount').textContent = active.filter(task => taskState(task, workspaceConnections(setupState)) === 'waiting_external').length;
  byId('doneCount').textContent = done.length;
  // Counts double as filters; zero groups stay visible as plain text so the
  // whole system state is legible without opening anything.
  const countGroups = [['attention', copy('待你处理'), byId('attentionCount').textContent], ['working', copy('正在处理'), byId('workingCount').textContent], ['waiting', copy('等待回复或资料'), byId('waitingCount').textContent], ['done', copy('已结束'), done.length]];
  updateContent('homeCounts', countGroups.map(([key, label, value]) => ui`<button type="button" class="home-count" data-count-filter="${key}" data-zero="${Number(value) === 0}" aria-pressed="${selectedFilter === key}"><strong>${String(value)}</strong><span>${label}</span></button>`).join('') + (selectedFilter !== 'all' ? ui`<button type="button" class="text-button home-count-clear" data-count-filter="all">${copy('全部')}</button>` : ''));
  byId('navDecisionCount').textContent = count;
  byId('navDecisionCount').className = ui`nav-count${count ? '' : ' zero'}`;
  byId('navDecisionCount').hidden = !count;
  const filtered = selectedFilter === 'attention' ? active.filter(task => stateGroup(taskState(task, workspaceConnections(setupState))) === 'attention' && !isSnoozed(task, snoozes)) : selectedFilter === 'done' ? done : selectedFilter === 'working' ? active.filter(task => taskState(task, workspaceConnections(setupState)) === 'working') : selectedFilter === 'waiting' ? active.filter(task => taskState(task, workspaceConnections(setupState)) === 'waiting_external') : selectedFilter === 'active' ? active : tasks;
  const shown = filtered.filter(task => matchesTask(task, searchQuery));
  const empty = !runtime?.demo?.ruleBased && !setupState?.workspace?.ready ? [copy('连接后，你的真实工作会出现在这里。'), copy('无需手动创建任务；Agent 会从授权环境中发现值得跟进的事。')] : selectedFilter === 'attention' ? [copy('这些任务暂时不需要你'), copy('需要判断时，我会把上下文一起带来。')] : selectedFilter === 'done' ? [copy('完成的事会留在这里'), copy('每次行动核验结果后，才会标记完成。')] : [copy('现在没有待推进的事'), copy('我会留意工作空间里的变化。你不需要为了让我工作而找事。')];
  workspaceUI?.render({ tasks: shown, allTasks: tasks, emptyHTML: searchQuery ? emptyState(copy('没有找到相符的任务'), copy('试试项目名或联系人，也可以清空搜索。')) : emptyState(...empty) });
  byId('clearSearch').hidden = !searchQuery;
  byId('taskSearch').hidden = false;
  updateTaskList('attentionTaskContent', decisionTasks, '');
  updateContent('sharedDependencyContent', renderCommonDependencies(state));
  updateContent('attentionNotices', notices.map(notice => `<details class="home-notice" data-preserve="notice-${escapeHtml(notice.id)}"><summary>${escapeHtml(notice.headline || notice.title || nativeCopy('建议待确认', 'Suggestion to review'))}</summary>${renderQuietDecision(notice)}</details>`).join(''));
  updateContent('attentionRecoveryContent', recoveryTasks.map(task => workspaceUI.recoveryCard(task)).join(''));
  updateContent('attentionEmpty', !decisionTasks.length && !notices.length && !recoveryTasks.length ? emptyState(copy('现在没有需要你的事'), copy('该跟进的我会继续跟进。你可以放心离开这里。')) : '');
  updateContent('parkedContent', renderParked(state.opportunities));
  interactions?.renderQueue(decisionTasks, notices);
  const changes = changesSince(state, visitBaseline);
  const hasChanges = changes && (changes.discovered || changes.completed || changes.ready);
  updateContent('returnDigest', hasChanges ? ui`<div><strong>${copy('自上次离开以来')}</strong><p>${changes.completed ? ui`<span><b>${changes.completed}</b> ${copy('已完成')}</span>` : ''}${changes.ready ? ui`<span><b>${changes.ready}</b> ${copy('准备就绪')}</span>` : ''}${changes.discovered ? ui`<span><b>${changes.discovered}</b> ${copy('新增任务')}</span>` : ''}</p></div><button class="text-button" data-dismiss-digest>${copy('知道了')}</button>` : '');
  byId('returnDigest').hidden = !hasChanges;
  updateContent('snoozedSummary', snoozedTasks.length ? ui`<span>${copy('已设置稍后处理')} · ${snoozedTasks.length}</span><button class="text-button" data-show-snoozed>${copy('现在查看')}</button>` : '');
  byId('snoozedSummary').hidden = !snoozedTasks.length;
  if (!document.hidden) writeLocal(ui`${localWorkspace}:visit`, workspaceSnapshot(state));
  const activityNeedle = activityQuery.trim().toLocaleLowerCase();
  const matchesActivity = value => !activityNeedle || JSON.stringify(value).toLocaleLowerCase().includes(activityNeedle);
  const activityEvents = activityFilter === 'history' ? [] : (state.events || []).filter(matchesActivity);
  const activityHistory = activityFilter === 'events' ? [] : (state.history || []).filter(matchesActivity);
  const noActivityMatch = activityQuery.trim() || activityFilter !== 'all' ? activityQuery.trim() ? copy('没有相符的动态。换个关键词或清除筛选。') : copy('当前筛选下暂无记录。') : undefined;
  updateContent('eventContent', renderRecord(activityEvents, activityHistory, noActivityMatch));
  updateContent('historyContent', '');
  byId('eventCount').textContent = activityEvents.length ? String(activityEvents.length) : '';
  byId('historyCount').textContent = activityHistory.length ? String(activityHistory.length) : '';
  byId('eventCount').textContent = String(activityEvents.length + activityHistory.length || '');
  byId('historyContent').closest('.activity-stream').hidden = true;
  const environmentNote = byId('activityEnvironmentNote');
  const demoEnvironment = Boolean(runtime?.demo?.enabled);
  environmentNote.hidden = !demoEnvironment;
  if (demoEnvironment) environmentNote.textContent = copy('本地模拟 · 这里的来源变化与发送均为模拟，不会联系真实账号。');
  updateContent('followUpContent', renderFollowUps(state));
  // An empty record is one line, not three placeholder sections.
  const recordEmpty = !(state.events || []).length && !(state.history || []).length;
  byId('homeRecord').dataset.empty = String(recordEmpty);
  byId('followUpContent').closest('.activity-stream').hidden = !Object.keys(state.followUps || {}).length;
  updateContent('contextContent', renderContext(state));
  updateContent('metricsContent', renderMetrics(state.metrics));
  updateContent('grantContent', renderGrants(state));
  updateContent('connectorContent', renderConnectors());
  artifactUI?.render();
  if (openTaskId && byId('taskDialog').open) renderTaskDialog();
  syncPendingControls();
}

function renderRuntime(report, { refresh = true } = {}) {
  runtime = report;
  if (setupState) runtime.monitoring = setupState.monitoring;
  const live = report.mode === 'live';
  const sourceNames = (report.connectors || []).filter(source => source.live).map(source => providerNames[source.id] || source.id);
  const disconnected = report.googleRuntimeDisabled === true && !sourceNames.length;
  const setup = report.mode === 'setup';
  byId('footerMode').textContent = disconnected ? nativeCopy('来源已断开', 'Source disconnected') : live ? (report.shadow ? nativeCopy('只读工作区', 'Read-only workspace') : nativeCopy('真实工作区', 'Live workspace')) : setup ? nativeCopy('等待连接', 'Awaiting connection') : nativeCopy('本地模拟', 'Local simulation');
  if (refresh) void refreshSetup({ quiet: true });
}

function render(state, { allowWorkspaceChange = false } = {}) {
  const key = workspaceKey(state);
  // Stream ordering owns live account transitions. A slow response from the
  // previously connected account must not replace the new account's workspace.
  if (current && key !== workspaceKey(current) && (current.mode === 'live' || state.mode === 'live') && !allowWorkspaceChange) return;
  if (current && key === workspaceKey(current) && state.revision < current.revision) return;
  if (state.runtime && JSON.stringify(current?.runtime) !== JSON.stringify(state.runtime)) renderRuntime({ ...runtime, ...state.runtime,
    googleRuntimeDisabled: state.runtime.google?.disconnectedThisRun === true });
  if (localWorkspace !== key) {
    if (byId('taskDialog').open) byId('taskDialog').close();
    openTaskId = null;
    localWorkspace = key;
    snoozes = readLocal(ui`${key}:snoozes`, {});
    if (!snoozes || typeof snoozes !== 'object' || Array.isArray(snoozes)) snoozes = {};
    visitBaseline = readLocal(ui`${key}:visit`);
    searchQuery = ''; byId('taskSearch').value = '';
    taskOrder = [];
    actionErrors.clear();
  }
  current = state;
  for (const id of actionErrors.keys()) {
    if (state.tasks.find(task => task.id === id)?.status === 'completed') actionErrors.delete(id);
  }
  renderDashboard();
}

function setView(name, navigate = true) {
  // Activity is part of Work: the record sits below the tasks it explains.
  if (name === 'activity') {
    setView('home', navigate);
    if (location.hash === '#activity') history.replaceState(null, '', '#home');
    byId('homeRecord')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    return;
  }
  if (name === 'attention') {
    name = 'home';
    selectedFilter = 'attention';
    workspaceUI?.select(null);
    if (location.hash === '#attention') history.replaceState(null, '', '#home');
  } else if (name === 'home') selectedFilter = 'all';
  if (!Object.hasOwn(viewNames, name)) name = 'home';
  if (name !== currentView) viewScrollPositions.set(currentView, window.scrollY);
  for (const [key, label] of Object.entries(viewNames)) {
    byId(ui`view${key[0].toUpperCase()}${key.slice(1)}`).hidden = key !== name;
    const link = document.querySelector(ui`[data-view="${key}"]`);
    link?.classList.toggle('active', key === name);
    if (key === name) link?.setAttribute('aria-current', 'page'); else link?.removeAttribute('aria-current');
  }
  byId('pageCrumb').textContent = copy(viewNames[name]);
  currentView = name;
  if (current) renderDashboard();
  if (navigate) {
    const heading = byId(`view${name[0].toUpperCase()}${name.slice(1)}`).querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    window.scrollTo({ top: viewScrollPositions.get(name) || 0, behavior: 'instant' });
  }
  if (navigate && location.hash !== ui`#${name}`) location.hash = name;
}

function setFilter(filter) {
  selectedFilter = filter;
  for (const button of document.querySelectorAll('[data-filter]')) {
    const selected = button.dataset.filter === filter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) byId('taskContent').setAttribute('aria-labelledby', button.id);
  }
  renderDashboard();
}

byId('taskStatusFilter').addEventListener('change', event => setFilter(event.target.value));
byId('homeCounts').addEventListener('click', event => {
  const button = event.target.closest('[data-count-filter]');
  if (!button) return;
  const next = button.dataset.countFilter === selectedFilter ? 'all' : button.dataset.countFilter;
  byId('taskStatusFilter').value = next;
  setFilter(next);
});

function renderTaskDialog() {
  const task = current?.tasks.find(item => item.id === openTaskId);
  if (!task) { byId('taskDialog').close(); openTaskId = null; return; }
  byId('taskDialogTitle').textContent = taskTitle(task);
  updateContent('taskDialogContent', workspaceUI.inspector(task, { record: true }));

}

function openTask(id) {
  if (!byId('taskDialog').open) taskDialogTrigger = { id, element: document.activeElement };
  openTaskId = id;
  renderTaskDialog();
  if (openTaskId && !byId('taskDialog').open) byId('taskDialog').showModal();
}

async function postJSON(path, payload = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || copy('操作未完成，请稍后再试。'));
  return result;
}

async function post(path, payload = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), { code: result.code, status: response.status });
  return result;
}

document.addEventListener('change', event => {
  const waitKind = event.target.closest('[data-wait-kind]');
  if (waitKind) {
    const input = waitKind.closest('form')?.querySelector('[data-wait-until]');
    if (input) input.hidden = waitKind.value !== 'time';
  }
  const sourceSelect = event.target.closest('[data-patch-source]');
  if (sourceSelect) {
    const option = sourceSelect.selectedOptions[0];
    const preview = document.querySelector(`[data-patch-preview="${CSS.escape(sourceSelect.dataset.patchSource)}"]`);
    try { if (preview) preview.textContent = JSON.parse(option.dataset.patchSourceJson).quote; } catch { if (preview) preview.textContent = ''; }
  }
  const confirmation = event.target.closest('[data-patch-confirm]');
  if (confirmation) {
    const button = document.querySelector(`[data-patch-apply][data-patch-id="${CSS.escape(confirmation.dataset.patchConfirm)}"]`);
    if (button) button.disabled = !confirmation.checked;
  }
  const docsWrite = event.target.closest('input[name="docsWrite"]');
  if (docsWrite?.checked) {
    const driveRead = document.querySelector('input[name="readDrive"]');
    if (driveRead) driveRead.checked = true;
  }
  const driveRead = event.target.closest('input[name="readDrive"]');
  if (driveRead && !driveRead.checked) {
    const docsWriteInput = document.querySelector('input[name="docsWrite"]');
    if (docsWriteInput) docsWriteInput.checked = false;
  }
});

document.addEventListener('submit', async event => {
  const waitForm = event.target.closest('[data-wait-form]');
  const dependencyForm = event.target.closest('[data-dependency-form]');
  const patchForm = event.target.closest('[data-patch-form]');
  if (!waitForm && !dependencyForm && !patchForm) return;
  event.preventDefault();
  if (setupBusy) return;
  setupBusy = true;
  const form = event.target;
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (waitForm) {
      const taskId = waitForm.dataset.waitForm;
      const kind = waitForm.querySelector(`[data-wait-kind="${CSS.escape(taskId)}"]`).value;
      const untilValue = waitForm.querySelector(`[data-wait-until="${CSS.escape(taskId)}"]`).value;
      if (kind === 'time' && !untilValue) throw new Error(copy('选择等待时间。'));
      const payload = { kind, interruptOnRisk: true };
      const task = current?.tasks.find(item => item.id === taskId);
      if (kind === 'document' && task?.documentId) payload.dependsOn = { documentId: task.documentId };
      if (kind === 'reply') {
        const threadId = task?.request?.source?.threadId || current?.inbox?.find(item => item.id === task?.sourceEmailId)?.threadId;
        if (threadId) payload.dependsOn = { threadId };
      }
      if (kind === 'time') payload.until = new Date(untilValue).toISOString();
      const result = await postJSON(ui`/api/tasks/${encodeURIComponent(taskId)}/wait`, payload);
      waitForm.reset();
      render(result.state || await (await fetch('/api/state')).json());
      toast(copy('等待条件已保存；风险变化仍会提前提醒。'));
    } else if (dependencyForm) {
      const id = dependencyForm.dataset.dependencyForm;
      const input = dependencyForm.querySelector(`[data-dependency-answer="${CSS.escape(id)}"]`);
      const result = await postJSON(ui`/api/dependencies/${encodeURIComponent(id)}/resolve`, { decision: 'provided', value: input.value });
      dependencyForm.reset();
      render(result.state || await (await fetch('/api/state')).json());
      toast(copy('一次回答已记录；所有相关事项都会重新核对证据。'));
    } else {
      const taskId = patchForm.dataset.patchForm;
      const result = await postJSON(ui`/api/tasks/${encodeURIComponent(taskId)}/patch/prepare`, {});
      render(result.state || await (await fetch('/api/state')).json());
      toast(result.patch?.status === 'prepared' ? copy('来源补丁已准备，文档尚未修改。请审阅后再决定。') : copy('没有可安全准备的来源补丁；请查看阻塞原因。'), result.patch?.status !== 'prepared');
    }
  } catch (error) { toast(error.message, true); }
  finally { setupBusy = false; if (submit) submit.disabled = false; }
});

document.addEventListener('submit', async event => {
  const modelForm = event.target.closest('[data-model-form]');
  if (!modelForm) return;
  event.preventDefault();
  if (setupBusy) return;
  setupBusy = true;
  const button = modelForm.querySelector('button[type="submit"]');
  const errorNode = modelForm.querySelector('[data-model-error]');
  button.disabled = true; button.textContent = copy('正在发送测试请求…');
  errorNode.hidden = true;
  try {
    const data = new FormData(modelForm);
    const input = { baseUrl: data.get('baseUrl'), model: data.get('model'), harness: data.get('harness') };
    if (data.get('apiKey')) input.apiKey = data.get('apiKey');
    const result = await postJSON('/api/setup/model', input);
    modelForm.querySelector('[name="apiKey"]').value = '';
    for (const field of document.querySelectorAll('#modelOnboarding [name="apiKey"]')) field.value = '';
    setupState = result.setup;
    const report = await fetch('/api/runtime');
    if (report.ok) renderRuntime(await report.json());
    render(result.state);
    toast(copy('模型真实请求已验证，连接已生效。'));
  } catch (error) {
    errorNode.textContent = copy(error.message); errorNode.hidden = false;
  } finally { setupBusy = false; button.disabled = false; button.textContent = copy('验证并连接模型'); }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-model-forget]');
  if (!button || setupBusy) return;
  setupBusy = true; button.disabled = true;
  try {
    const result = await postJSON('/api/setup/model/forget');
    setupState = result.setup; render(result.state);
    const response = await fetch('/api/runtime');
    if (response.ok) renderRuntime(await response.json());
    toast(copy('本机模型连接已移除。'));
  } catch (error) { toast(copy(error.message), true); }
  finally { setupBusy = false; button.disabled = false; }
});

async function beginGoogleAuthorization(form, { importClient = false } = {}) {
  const data = new FormData(form);
  const scopes = { readGmail: data.has('readGmail'), readDrive: data.has('readDrive'), docsWrite: data.has('docsWrite'), gmailSend: data.has('gmailSend'), gmailDrafts: data.has('gmailDrafts') };
  if (!scopes.readGmail && !scopes.readDrive) throw new Error(copy('至少选择一个读取来源。'));
  const fileInput = form.querySelector('input[type="file"]');
  const file = fileInput?.files?.[0];
  if (importClient && (!file || file.size > 64 * 1024)) throw new Error(copy('请选择小于 64 KB 的 Google Desktop 客户端 JSON。'));
  // Open while the click still has browser activation. A blocked popup has an
  // inline, ordinary link fallback; users do not need to change browser settings.
  oauthPopup?.close();
  oauthPopup = window.open('about:blank', '_blank', 'popup,width=560,height=760');
  try {
    if (importClient) {
      const clientJson = await file.text();
      await postJSON('/api/setup/google/client', { clientJson });
      fileInput.value = '';
      for (const field of document.querySelectorAll('[name="clientJson"]')) field.value = '';
    }
    const result = await postJSON('/api/setup/google/authorize', { scopes, observe: data.has('observe'),
      allowExternalWrites: form.dataset.enableWrites === 'true' && (scopes.gmailSend || scopes.docsWrite), locale: getLocale() });
    oauthCallbackOrigin = new URL(new URL(result.authorizeUrl).searchParams.get('redirect_uri')).origin;
    if (oauthPopup && !oauthPopup.closed) oauthPopup.location.href = result.authorizeUrl;
    connectionErrors.delete('google');
    await refreshSetup({ quiet: true });
  } catch (error) { oauthPopup?.close(); oauthPopup = null; throw error; }
}

function showConnectionError(error) {
  let message = error.message;
  if (/Web OAuth client/.test(message)) message = copy('这是 Web 类型的客户端。请创建 Desktop app 类型并重新下载 JSON。');
  else if (/valid JSON|installed Desktop|official authorization|valid Google Desktop/.test(message)) message = copy('文件不是有效的 Google Desktop 客户端配置。请重新下载 Desktop app JSON。');
  connectionErrors.set('google', copy(message));
  updateContent('setupContent', renderSetupPanel());
  renderDashboard();
}

document.addEventListener('submit', async event => {
  const monitorForm = event.target.closest('[data-monitor-form]');
  const clientForm = event.target.closest('[data-google-client-form]');
  const scopeForm = event.target.closest('[data-scope-form]');
  const writeForm = event.target.closest('[data-write-permission-form]');
  if (!monitorForm && !clientForm && !scopeForm && !writeForm) return;
  event.preventDefault();
  if (setupBusy) return;
  setupBusy = true;
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  connectionErrors.delete('google');
  try {
    if (monitorForm) {
      const result = await postJSON('/api/setup/monitoring', {
        enabled: form.querySelector('[name="enabled"]').checked,
        intervalMs: Number(form.querySelector('[name="intervalMs"]').value)
      });
      await refreshSetup({ quiet: true });
      toast(result.monitoring.enabled ? copy('自动观察已开启，正在立即进行首轮同步。') : copy('自动观察已关闭；最后同步状态仍会保留。'));
    } else if (clientForm || scopeForm) {
      await beginGoogleAuthorization(form, { importClient: Boolean(clientForm) });
    } else {
      await postJSON('/api/setup/google/permissions', { allowExternalWrites: form.querySelector('[name="allowExternalWrites"]').checked });
      await refreshSetup({ quiet: true });
      toast(copy('行动权限已更新并立即生效。'));
    }
  } catch (error) { showConnectionError(error); }
  finally {
    setupBusy = false;
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    updateContent('setupContent', renderSetupPanel()); renderDashboard();
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy-draft]');
  if (!button) return;
  const task = current?.tasks.find(task => task.id === button.dataset.copyDraft);
  if (!task?.draft?.body) return;
  try { await navigator.clipboard.writeText(task.draft.body); toast(copy('回复草稿已复制。')); }
  catch { toast(copy('浏览器无法自动复制，请在回复正文中选择并复制。'), true); }
});

window.addEventListener('message', event => {
  if (event.source !== oauthPopup || event.origin !== oauthCallbackOrigin || event.data?.type !== 'unprompted:google-connection') return;
  void refreshSetup({ quiet: true });
});

document.addEventListener('dragover', event => {
  if (!event.target.closest('[data-client-drop]')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', event => {
  const drop = event.target.closest('[data-client-drop]');
  if (!drop) return;
  event.preventDefault();
  if (event.dataTransfer.files.length !== 1) { showConnectionError(new Error(copy('每次请选择一个客户端 JSON 文件。'))); return; }
  drop.querySelector('input[type="file"]').files = event.dataTransfer.files;
  drop.closest('form').requestSubmit();
});

document.addEventListener('click', async event => {
  const action = event.target.closest('[data-google-cancel], [data-google-activate], [data-google-reconnect], [data-reasoning-retry]');
  if (!action || setupBusy) return;
  setupBusy = true; action.disabled = true;
  try {
    if (action.hasAttribute('data-google-cancel')) {
      await postJSON('/api/setup/google/cancel'); oauthPopup?.close(); oauthPopup = null;
    } else if (action.hasAttribute('data-google-activate')) {
      await postJSON('/api/setup/google/activate', { observe: true });
    } else if (action.hasAttribute('data-reasoning-retry')) {
      await postJSON('/api/reasoning/retry', action.dataset.reasoningRetry ? { taskId: action.dataset.reasoningRetry } : {});
    } else {
      const form = document.createElement('form');
      for (const [name, enabled] of Object.entries({ ...setupState.google.requestedScopes, observe: setupState.monitoring.enabled })) {
        if (enabled) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; form.append(input); }
      }
      await beginGoogleAuthorization(form);
    }
    await refreshSetup({ quiet: true });
  } catch (error) { showConnectionError(error); }
  finally { setupBusy = false; action.disabled = false; renderDashboard(); }
});

document.addEventListener('click', async event => {
  const syncButton = event.target.closest('[data-sync-now]');
  const validateButton = event.target.closest('[data-google-validate]');
  const forgetButton = event.target.closest('[data-google-forget], [data-google-purge]');
  const restartButton = event.target.closest('[data-setup-restart]');
  const undoFeedback = event.target.closest('[data-undo-feedback]');
  const applyPatch = event.target.closest('[data-patch-apply]');
  if (!syncButton && !validateButton && !forgetButton && !restartButton && !undoFeedback && !applyPatch) return;
  const purgeGoogle = forgetButton?.hasAttribute('data-google-purge');
  if (purgeGoogle && !window.confirm(copy('断开并清除会删除这个来源在本机的收件、任务、快照和衍生内容。此操作不能撤销。'))) return;
  if (forgetButton ? forgetBusy : setupBusy) return;
  if (forgetButton) forgetBusy = true;
  else setupBusy = true;
  const button = event.target.closest('button');
  if (button) button.disabled = true;
  try {
    if (syncButton) {
      const outcome = await post('/api/connectors/sync');
      await Promise.all([refreshState(), refreshSetup({ quiet: true })]);
      toast(outcome.results?.some(item => item.failed || item.partial) ? copy('同步有失败，查看连接状态和最后错误。') : copy('同步已完成；只显示提供方实际返回的结果。'), Boolean(outcome.results?.some(item => item.failed || item.partial)));
    } else if (validateButton) {
      const result = await post('/api/setup/google/validate');
      await refreshSetup({ quiet: true });
      toast(result.status || copy('Google token 验证完成。'));
    } else if (forgetButton) {
      const result = await post('/api/setup/google/forget', purgeGoogle ? { purgeLocal: true } : {});
      const runtimeResponse = await fetch('/api/runtime');
      if (runtimeResponse.ok) renderRuntime(await runtimeResponse.json());
      await refreshSetup({ quiet: true });
      toast(copy(purgeGoogle ? 'Google 已断开，这个来源的本机副本已清除。' : 'Google 已断开，读取和执行均已停止。可以随时重新连接。'));
    } else if (restartButton) {
      await post('/api/setup/restart');
      toast(copy('Unprompted 正在重启，授权完成后会自动重新连接。'));
    } else if (undoFeedback) {
      const result = await postJSON(ui`/api/feedback/${encodeURIComponent(undoFeedback.dataset.undoFeedback)}/undo`);
      render(result.state || await (await fetch('/api/state')).json());
      toast(copy('纠正已撤销，后续发现会恢复原来的匹配范围。'));
    } else {
      const id = patchApplyTaskId(applyPatch);
      if (!id) throw new Error(copy('找不到补丁所属任务，请重新打开任务后再试。'));
      const patchId = applyPatch.dataset.patchId;
      const confirmed = document.querySelector(`[data-patch-confirm="${CSS.escape(patchId)}"]`)?.checked;
      if (!confirmed) throw new Error(copy('审阅并勾选确认后才能继续。'));
      const patch = findDocumentPatch(current, patchId);
      const baseDocumentVersion = patch?.baseDocument?.version;
      if (baseDocumentVersion == null) throw new Error(copy('找不到补丁对应的基础版本，请重新准备。'));
      const result = await postJSON(ui`/api/tasks/${encodeURIComponent(id)}/patch/apply`, {
        patchId,
        authorization: { kind: applyPatch.dataset.patchMode, taskId: id, patchId, baseDocumentVersion, confirmed: true }
      });
      render(result.state || await (await fetch('/api/state')).json());
      toast(result.result?.readbackVerified ? copy('补丁应用后已读回核验。') : copy('补丁已进行只读复核；没有更改文档。'));
    }
  } catch (error) { toast(error.message, true); }
  finally {
    if (forgetButton) forgetBusy = false;
    else setupBusy = false;
    if (button) button.disabled = false;
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-feedback]');
  if (!button || busy) return;
  busy = true;
  button.disabled = true;
  try {
    const task = current?.tasks.find(item => item.id === button.dataset.id);
    if (!task) throw new Error(copy('这件事已更新，请重新打开后操作。'));
    const reasonField = button.closest('.work-card').querySelector(ui`[data-reason-for="${CSS.escape(button.dataset.id)}"]`);
    const label = button.dataset.feedback;
    const corrections = ['not_mine', 'duplicate', 'already_handled', 'wrong_association'];
    const scope = {};
    const threadId = task.request?.source?.threadId || current.inbox?.find(item => item.id === task.sourceEmailId)?.threadId;
    if (threadId) scope.threadId = threadId;
    if (task.sender) scope.sender = task.sender;
    if (task.request?.subjectEntity) scope.subjectEntity = task.request.subjectEntity;
    if (task.request?.deliverable) scope.deliverable = task.request.deliverable;
    if (label === 'wrong_association' && task.documentId) scope.documentId = task.documentId;
    const relatedTaskId = label === 'duplicate'
      ? button.closest('.work-card').querySelector(`[data-related-task-for="${CSS.escape(button.dataset.id)}"]`)?.value : null;
    if (label === 'duplicate' && !relatedTaskId) throw new Error(copy('选择要关联的已有事项后，再保存重复纠正。'));
    if (label === 'wrong_association' && !scope.documentId) throw new Error(copy('当前任务没有可撤销的文档关联。'));
    const payload = { label, reason: reasonField?.value || '' };
    if (corrections.includes(label)) Object.assign(payload, { scope, relatedTaskId });
    const response = await fetch(ui`/api/tasks/${encodeURIComponent(button.dataset.id)}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save the label');
    toast(corrections.includes(label) ? copy('纠正已记录，可在同一事项中撤销。') : copy('反馈已记录。'));
    render(result.state);
  } catch (error) { toast(error.message, true); }
  finally { busy = false; button.disabled = false; }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button || pendingTasks.has(button.dataset.id)) return;
  if (!connected) { toast(copy('连接暂时中断，正在重新同步。'), true); return; }
  const action = button.dataset.action;
  const fromRelay = Boolean(button.closest('#decisionDeckCurrent, #decisionReceipt'));
  pendingTasks.add(button.dataset.id);
  actionErrors.delete(button.dataset.id);
  syncPendingControls();
  try {
    const result = await post(ui`/api/tasks/${encodeURIComponent(button.dataset.id)}/${action}`, action === 'approve' ? { reviewToken: button.dataset.reviewToken } : {});
    interactions?.noteResult(button.dataset.id, action, result);
    const messages = {
      approve: result.status === 'completed' ? copy('回复已发送，结果已核验。') : copy('已发起发送，结果仍需核实。'),
      reject: copy('已搁下这次回复，没有发送。'),
      retry: copy('已重试并向提供方核实结果。'),
      reconcile: copy('已向提供方核实结果。'),
      cancel: copy('已关闭这件事，没有发送回复。'),
      reopen: copy('已恢复跟进，已重新核对当前证据。没有发送回复。')
    };
    if (!fromRelay) toast(messages[action] || 'Done.', false, ['reject', 'cancel'].includes(action) ? { label: copy('撤销'), taskId: button.dataset.id } : null);
    const response = await fetch('/api/state');
    render(await response.json());
  } catch (error) { actionErrors.set(button.dataset.id, { message: error.message, code: error.code }); toast(copy(error.code === 'REVIEW_CHANGED' ? '回复已更新，这次没有发送。' : '还没确认这次操作的结果。'), true); try { render(await (await fetch('/api/state')).json()); } catch {} }
  finally {
    pendingTasks.delete(button.dataset.id); renderDashboard();
    if (fromRelay && currentView === 'attention' && !byId('taskDialog').open) {
      const recovery = byId('decisionDeckCurrent').querySelector('[data-sync-state]');
      const next = byId('decisionDeck').hidden ? byId('viewAttention').querySelector('h1') : byId('decisionDeckTitle');
      (recovery || next).focus({ preventScroll: true });
    }
  }
});

const decisionMessages = {
  answer: '约定已记录，会在明确的范围内行动。',
  opportunity: '选择已记录，尚未自动启动新工作。',
  reconcile: '已向提供方核实结果。',
  cancel: '已关闭这件事，没有发送回复。',
  ack: '已记下你的选择。'
};

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-decision]');
  if (!button || busy) return;
  const kind = button.dataset.decision;
  const path = kind === 'answer' ? ui`/api/clarifications/${encodeURIComponent(button.dataset.clarification)}/answer`
    : kind === 'opportunity' ? ui`/api/opportunities/${encodeURIComponent(button.dataset.opportunity)}/${encodeURIComponent(button.dataset.value)}`
      : kind === 'reconcile' ? ui`/api/tasks/${encodeURIComponent(button.dataset.task)}/reconcile`
        : kind === 'cancel' ? ui`/api/tasks/${encodeURIComponent(button.dataset.task)}/cancel`
          : '/api/notifications/read';
  const payload = kind === 'answer' ? { value: button.dataset.value }
    : kind === 'ack' ? { ids: [button.dataset.notification] } : {};
  busy = true;
  button.disabled = true;
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Request failed');
    toast(decisionMessages[kind] || 'Done.');
    render(result.state || await (await fetch('/api/state')).json());
  } catch (error) { toast(error.message, true); }
  finally { busy = false; button.disabled = false; }
});

async function restartDemo() {
  if (busy) return;
  busy = true;
  try { render(await post('/api/demo/restart')); toast(copy('演示已重新开始，新的变化会自动出现。')); }
  catch (error) { toast(error.message, true); }
  finally { busy = false; }
}
byId('demoJourney').addEventListener('click', event => {
  if (event.target.closest('[data-demo-replay]')) void restartDemo();
});

// Navigation, task details and optional scoped autonomy stay within this workspace.
document.addEventListener('click', async event => {
  const close = event.target.closest('[data-close-dialog]');
  if (close) { close.closest('dialog').close(); return; }
  const go = event.target.closest('[data-go], [data-view]');
  if (go) { event.preventDefault(); setView(go.dataset.go || go.dataset.view); return; }
  const filter = event.target.closest('[data-filter]');
  if (filter) { setFilter(filter.dataset.filter); return; }
  const taskButton = event.target.closest('[data-open-task]');
  if (taskButton) { openTask(taskButton.dataset.openTask); return; }
  const automate = event.target.closest('[data-automate]');
  const revoke = event.target.closest('[data-revoke]');
  if ((!automate && !revoke) || busy) return;
  const button = automate || revoke;
  const pendingId = automate?.dataset.automate;
  if (pendingId && pendingTasks.has(pendingId)) return;
  if (!connected) { toast(copy('连接暂时中断，正在重新同步。'), true); return; }
  if (pendingId) pendingTasks.add(pendingId);
  syncPendingControls();
  busy = true;
  button.disabled = true;
  let sent = false;
  try {
    if (automate) {
      const task = current.tasks.find(item => item.id === automate.dataset.automate);
      if (!task?.request?.subjectEntity || !task.request.deliverable) throw new Error(copy('这件事的自动跟进范围还不够明确。'));
      const scope = { entity: task.request.subjectEntity, deliverable: task.request.deliverable };
      // First complete this action. A failed delivery never creates a standing grant.
      const result = await postJSON(ui`/api/tasks/${encodeURIComponent(task.id)}/approve`, { reviewToken: automate.dataset.reviewToken });
      interactions?.noteResult(task.id, 'approve', result);
      if (result.status !== 'completed') {
        render(await (await fetch('/api/state')).json());
        toast(copy('发送结果尚未确认，暂未开启今后的自动跟进。'), true);
        return;
      }
      sent = true;
      const saved = await postJSON('/api/calibrations', { key: 'permission:send_automation', kind: 'permission', value: 'allow', scope });
      render(saved.state);
      toast(copy('本次已发送并核验，今后会在约定范围内自动跟进。'));
    } else {
      const grant = current.calibrations.find(item => item.id === revoke.dataset.revoke);
      if (!grant) throw new Error(copy('这项约定已更新，请刷新后查看。'));
      const saved = await postJSON('/api/calibrations', { key: grant.key, kind: 'permission', value: 'ask_each_time', scope: grant.scope, instruction: 'correct' });
      render(saved.state);
      toast(copy('这项约定已改为逐次确认。'));
    }
  } catch (error) {
    toast(sent ? ui`本次已发送，但自动跟进未保存：${error.message}` : error.message, true);
    try { render(await (await fetch('/api/state')).json()); } catch {}
  } finally { busy = false; button.disabled = false; if (pendingId) pendingTasks.delete(pendingId); renderDashboard(); }
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
}
byId('taskDialog').addEventListener('close', () => {
  openTaskId = null;
  const trigger = taskDialogTrigger;
  taskDialogTrigger = null;
  renderDashboard();
  // A re-render may replace the opener; return focus to the same kind of control.
  const kinds = ['openTask', 'taskRecord', 'selectTask'];
  const triggerKind = kinds.find(kind => trigger?.element?.dataset?.[kind]);
  const candidates = [...document.querySelectorAll('[data-open-task], [data-task-record], [data-select-task]')].filter(button => kinds.some(kind => button.dataset[kind] === trigger?.id) && button.checkVisibility());
  const fallback = candidates.find(button => triggerKind && button.dataset[triggerKind] === trigger?.id) || candidates[0];
  const target = trigger?.element?.isConnected && trigger.element.checkVisibility() ? trigger.element : fallback;
  (target || byId('mainContent')).focus({ preventScroll: true });
});
byId('openShortcuts').addEventListener('click', () => byId('shortcutDialog').showModal());
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (next !== currentView) setView(next, false);
});
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]')) return;
  const tab = event.target.closest('[role="tab"]');
  if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-filter]')];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setFilter(tabs[index].dataset.filter); tabs[index].focus(); return;
  }
  if (event.key === '/') { event.preventDefault(); setView('home'); byId('taskSearch').hidden = false; byId('taskSearch').focus(); return; }
  if (event.key.toLowerCase() === 'z') {
    const undo = document.querySelector('#decisionReceipt [data-action="reopen"]');
    if (undo?.checkVisibility()) undo.click();
    else if (byId('toast').classList.contains('visible')) byId('toast').querySelector('[data-toast-reopen]')?.click();
    return;
  }
  if (event.key.toLowerCase() === 'g') setView('home');
  if (event.key.toLowerCase() === 'n') setView('attention');
});
interactions = createInteractions({
  context: () => ({ state: current, workspace: localWorkspace, visitBaseline }),
  renderTask: renderTaskCard, renderNotice: renderQuietDecision, update: updateContent,
  refresh: renderDashboard, escape: escapeHtml, title: taskTitle, sourceLabel, time
});
mcpUI = createMcpPanel({ update: updateContent, post: postJSON,
  context: () => ({ mcp: setupState?.mcp, demo: runtime?.demo?.disposable || runtime?.demo?.ruleBased }),
  refresh: () => refreshSetup({ quiet: true }), notify: toast });
durableUI = createDurablePanel({ context: () => ({ state: current }), update: updateContent, post: postJSON, applyState: render,
  refresh: refreshState, notify: toast, openTask });
artifactUI = createArtifactPanel({ context: () => ({ setup: setupState }), post: postJSON, refresh: () => refreshSetup({ quiet: true }),
  applyState: render, notify: toast, language: getLocale, authorizeGoogle: form => beginGoogleAuthorization(form), authorizeSource: startSourceAuthorization });
workspaceUI = createWorkspace({
  context: () => ({ state: current, workspace: localWorkspace, setup: setupState, connections: workspaceConnections(setupState), filter: selectedFilter }),
  update: updateContent, post: postJSON, applyState: render, notify: toast,
  renderAction: renderTaskAction, renderManagement: renderTaskManagement,
  renderDetails: task => githubWorkKinds.includes(task.kind) ? renderIssueCard(task, { detailed: true }) : task.kind === 'observed_task' ? renderObservedCard(task, { detailed: true }) : renderWork(task),
  go: setView, refresh: renderDashboard
});
applyLanguage();
byId('languageSelect').value = getLocale();
byId('todayDate').textContent = formatDate();
setView(location.hash.slice(1), false);
void refreshSetup({ quiet: true });
setupRefreshTimer = setInterval(() => { if (!document.hidden) void refreshSetup({ quiet: true }); }, 15_000);

function syncPendingControls() {
  for (const button of document.querySelectorAll('button[data-action], button[data-automate]')) {
    const id = button.dataset.id || button.dataset.automate;
    const pending = pendingTasks.has(id);
    button.disabled = pending || !connected || (actionErrors.has(id) && actionErrors.get(id).code !== 'REVIEW_CHANGED');
    button.setAttribute('aria-busy', String(pending));
    if (pending && !button.dataset.idleLabel) {
      button.dataset.idleLabel = button.textContent;
      button.textContent = copy('正在处理…');
    } else if (!pending && button.dataset.idleLabel) {
      button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
    }
  }
}

function updateTaskList(id, tasks, emptyHTML) {
  const root = byId(id);
  if (!tasks.length) { updateContent(id, emptyHTML); return; }
  if ([...root.children].some(child => !child.matches('[data-task-card]'))) root.replaceChildren();
  const keep = new Set(tasks.map(task => task.id));
  for (const child of [...root.children]) if (!keep.has(child.dataset.taskCard)) child.remove();
  let cursor = root.firstElementChild;
  for (const task of tasks) {
    let card = [...root.children].find(node => node.dataset.taskCard === task.id);
    const html = renderTaskCard(task);
    if (!card || card._cardHTML !== html) {
      const template = document.createElement('template');
      template.innerHTML = html;
      const next = template.content.firstElementChild;
      if (card) updateElement(card, next.innerHTML);
      else card = next;
      card._cardHTML = html;
    }
    if (card !== cursor) root.insertBefore(card, cursor);
    cursor = card.nextElementSibling;
  }
  root._renderedHTML = null;
}

function saveSnoozes() {
  if (!writeLocal(ui`${localWorkspace}:snoozes`, snoozes)) toast(copy('无法保存本机偏好，当前会话仍可使用。'), true);
}

let snoozeTimer = null;
function scheduleSnoozes() {
  clearTimeout(snoozeTimer);
  const now = Date.now();
  const next = Math.min(...Object.values(snoozes).map(entry => entry?.until).filter(until => Number.isFinite(until) && until > now));
  if (Number.isFinite(next)) snoozeTimer = setTimeout(() => renderDashboard(), Math.min(next - now + 50, 60_000));
}

async function refreshState() {
  const [response, report] = await Promise.all([fetch('/api/state'), fetch('/api/runtime')]);
  if (!response.ok || !report.ok) throw new Error(copy('服务暂时没有返回工作空间。'));
  renderRuntime(await report.json());
  render(await response.json());
}

function applyLocale() {
  applyLanguage();
  byId('languageSelect').value = getLocale();
  byId('todayDate').textContent = formatDate();
  byId('connectionText').textContent = copy(connected ? (runtime?.demo?.enabled ? '本地模拟' : '实时连接') : '重新连接中');
  setView(currentView, false);
  if (runtime) renderRuntime(runtime);
  if (setupState) updateContent('setupContent', renderSetupPanel());
  if (lastToast && byId('toast').classList.contains('visible')) toast(lastToast.message, lastToast.isError, lastToast.action);
  renderDashboard();
}

document.addEventListener('click', async event => {
  const snooze = event.target.closest('[data-snooze]');
  const unsnooze = event.target.closest('[data-unsnooze]');
  if (snooze) {
    const task = current?.tasks.find(item => item.id === snooze.dataset.snooze);
    if (!task || pendingTasks.has(task.id)) return;
    snoozes[task.id] = { until: Date.now() + 30 * 60_000, fingerprint: taskFingerprint(task) };
    saveSnoozes(); renderDashboard();
    toast(copy('已暂收起，30 分钟后再显示。')); return;
  }
  if (unsnooze) { delete snoozes[unsnooze.dataset.unsnooze]; saveSnoozes(); renderDashboard(); return; }
  if (event.target.closest('[data-show-snoozed]')) { snoozes = {}; saveSnoozes(); renderDashboard(); return; }
  if (event.target.closest('[data-dismiss-digest]')) { visitBaseline = workspaceSnapshot(current); renderDashboard(); return; }
  const undo = event.target.closest('[data-toast-reopen]');
  if (undo) {
    const task = current?.tasks.find(item => item.id === undo.dataset.toastReopen);
    if (!task) return;
    const button = document.createElement('button');
    button.dataset.action = 'reopen'; button.dataset.id = task.id; button.hidden = true;
    document.body.append(button); button.click(); button.remove(); return;
  }
  if (event.target.closest('[data-sync-state]')) {
    try { await refreshState(); connectStateStream(true); actionErrors.clear(); renderDashboard(); toast(copy('当前进展已同步。')); } catch (error) { toast(error.message, true); }
  }
});
byId('languageSelect').addEventListener('change', event => { setLocale(event.target.value); applyLocale(); });
byId('taskSearch').addEventListener('input', event => { searchQuery = event.target.value; renderDashboard(); });
document.addEventListener('compositionstart', event => { composingElement = event.target; });
document.addEventListener('compositionend', () => { composingElement = null; renderDashboard(); });
byId('clearSearch').addEventListener('click', () => { searchQuery = ''; byId('taskSearch').value = ''; renderDashboard(); });
document.addEventListener('visibilitychange', () => {
  if (!current) return;
  if (document.hidden) { visitBaseline = workspaceSnapshot(current); writeLocal(`${localWorkspace}:visit`, visitBaseline); }
  else renderDashboard();
});

function connectStateStream(force = false) {
  if (stateStream && !force && stateStream.readyState !== EventSource.CLOSED) return;
  stateStream?.close();
  const stream = new EventSource('/api/stream');
  stateStream = stream;
  stream.onopen = () => {
    connected = true;
    byId('connectionDot').className = 'connection-dot connected';
    byId('connectionText').textContent = copy(runtime?.demo?.enabled ? '本地模拟' : '实时连接');
    renderDashboard();
    // Recover a failed initial runtime fetch without requiring a page reload.
    if (!runtime?.demo) fetch('/api/runtime').then(response => {
      if (!response.ok) throw new Error('Runtime unavailable');
      return response.json();
    }).then(report => { renderRuntime(report); renderDashboard(); }).catch(() => {});
  };
  stream.onmessage = message => {
    try {
      const state = JSON.parse(message.data);
      connected = true;
      byId('connectionDot').className = 'connection-dot connected';
      byId('connectionText').textContent = copy(runtime?.demo?.enabled ? '本地模拟' : '实时连接');
      render(state, { allowWorkspaceChange: true });
    } catch (error) { console.error('Invalid state event', error); toast(copy('收到的状态无法读取，正在等待下一次更新。'), true); }
  };
  stream.onerror = () => {
    connected = false;
    byId('connectionDot').className = 'connection-dot failed';
    byId('connectionText').textContent = copy('重新连接中');
    renderDashboard();
    if (!current) byId('agentStatus').innerHTML = ui`<span class="agent-mark" aria-hidden="true"><i></i><i></i></span><div><strong>暂时无法连接工作空间</strong><p>服务恢复后会自动重试。请确认本地服务仍在运行。</p></div><button class="secondary-button" data-sync-state>${copy('重新同步')}</button>`;
  };
}

(async () => {
  try {
    await refreshState();
    connected = true;
    renderDashboard();
  } catch (error) { toast(ui`无法载入工作空间：${error.message}`, true); }
  connectStateStream();
})();
