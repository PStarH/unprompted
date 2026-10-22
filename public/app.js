const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const time = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
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
let busy = false;
let toastTimer = null;

function toast(message, isError = false) {
  const element = byId('toast');
  element.textContent = message;
  element.className = `toast visible${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.className = 'toast', 4500);
}

/** A source reference must always show where a fact came from. */
function sourceLabel(source) {
  if (!source) return 'source unavailable';
  return [source.id, source.version != null ? `v${source.version}` : null, source.locator, source.timestamp ? time(source.timestamp) : null]
    .filter(Boolean).join(' · ');
}

function renderCriteria(task) {
  const criteria = task.evidence?.criteria || [];
  if (!criteria.length) {
    return `<p class="mini-note">No verifiable content criteria were derived from this request yet.</p>`;
  }
  return criteria.map(item => {
    const met = item.status === 'satisfied';
    const evidence = item.evidence?.[0];
    return `<div class="criterion ${met ? 'met' : 'unmet'}">
      <span class="criterion-mark" aria-hidden="true">${met ? '✓' : '○'}</span>
      <div class="criterion-body">
        <strong>${escapeHtml(item.label)}</strong>
        ${met && evidence
          ? `<p class="criterion-value">“${escapeHtml(evidence.excerpt || evidence.detail || '')}”</p><small class="source-ref">${escapeHtml(sourceLabel(evidence.source))}</small>`
          : `<p class="criterion-value muted">Not found in the document.</p>${item.note ? `<small class="source-ref">${escapeHtml(item.note)}</small>` : ''}`}
      </div></div>`;
  }).join('');
}

function renderClaims(task) {
  const claims = task.evidence?.claims || [];
  if (!claims.length) return '';
  return `<div class="claim-block"><div class="mini-heading">STATEMENTS THE REPLY WOULD MAKE</div>${claims.map(item => `
    <div class="claim ${item.supported ? 'supported' : 'withheld'}">
      <span class="claim-mark" aria-hidden="true">${item.supported ? '✓' : '—'}</span>
      <div><strong>${escapeHtml(item.text)}</strong><small>${item.supported ? 'Supported by evidence' : escapeHtml(item.note || 'Not supported by evidence, so it was withheld.')}</small></div>
    </div>`).join('')}</div>`;
}

function renderUnknowns(task) {
  const unknowns = task.evidence?.unknowns || [];
  const conflicts = task.evidence?.conflicts || [];
  if (!unknowns.length && !conflicts.length) return '';
  return `<div class="unknown-block"><div class="mini-heading">EXPLICITLY UNKNOWN</div>
    ${conflicts.map(item => `<div class="unknown-item conflict"><strong>${escapeHtml(item.detail)}</strong></div>`).join('')}
    ${unknowns.map(item => `<div class="unknown-item"><strong>${escapeHtml(item.question)}</strong><small>${escapeHtml(item.reason)} ${escapeHtml(item.whatWouldResolveIt || '')}</small></div>`).join('')}</div>`;
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
      count('corroborated') ? `agrees on ${count('corroborated')} point(s)` : null,
      count('conflict') ? `disagrees on ${count('conflict')} point(s)` : null,
      count('superseded') ? `reports an older reading on ${count('superseded')} point(s)` : null
    ].filter(Boolean);
    return `<div class="unknown-item"><strong>Checked “${escapeHtml(title)}” as a competing source</strong><small>${escapeHtml(parts.join('; ') || 'no comparable content found')}</small></div>`;
  }).join('');
  return `<div class="unknown-block"><div class="mini-heading">STRENGTHENED VERIFICATION</div>
    <div class="unknown-item"><strong>Why more than the baseline checks</strong><small>${escapeHtml(basis || 'A competing plausible source exists.')}</small></div>
    ${summaries}</div>`;
}

function renderFreshness(task) {
  const freshness = task.evidence?.freshness;
  if (!freshness || freshness.status === 'not_required') return '';
  return `<div class="freshness ${escapeHtml(freshness.status)}"><span class="freshness-badge">${escapeHtml(freshnessNames[freshness.status] || freshness.status)}</span>
    <p>${escapeHtml(freshness.reason)}</p>
    ${freshness.documentRunDate ? `<small class="source-ref">Document run date: ${escapeHtml(freshness.documentRunDate)}${freshness.newestRun ? ` · newest known run: ${escapeHtml(freshness.newestRun)}` : ''}</small>` : ''}</div>`;
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
    ['useful', 'Useful'],
    ['not_useful', 'Not useful'],
    ['wrong_association', 'Wrong link']
  ];
  const buttons = choices.map(([value, text]) =>
    `<button type="button" class="secondary-button${currentLabel === value ? ' review-chosen' : ''}" data-feedback="${value}" data-id="${escapeHtml(task.id)}">${text}</button>`).join('');
  const note = currentLabel
    ? `Judged ${currentLabel.replaceAll('_', ' ')}.${feedback?.reason ? ` ${feedback.reason}` : ' No reason recorded.'}`
    : 'Not yet judged. That is neither useful nor not useful, and it is not an unknown outcome.';
  return `<div class="review-row"><span class="review-label">YOUR JUDGEMENT</span>${buttons}<label class="reason-field">Reason, optional<input type="text" maxlength="280" data-reason-for="${escapeHtml(task.id)}" value="${escapeHtml(feedback?.reason || '')}"></label><small>${escapeHtml(note)}</small></div>`;
}

function renderWork(task) {
  const document = current.documents.find(item => item.id === task.documentId);
  const found = Boolean(document);
  const request = task.request;
  const status = statusNames[task.status] || task.status;
  const documents = task.evidence?.documents?.[0];
  const correlation = documents ? `${documents.correlationScore >= 0.7 ? 'Strong' : documents.correlationScore >= 0.6 ? 'Plausible' : 'Weak'} match` : 'No match yet';
  const whyLinked = (documents?.correlationReasons || []).filter(Boolean).join(' ');
  const deadline = request.deadline
    ? request.deadline.ambiguous
      ? `${request.deadline.text} (ambiguous — could be ${(request.deadline.candidates || []).join(' or ')})`
      : `${request.deadline.text} (${request.deadline.kind.replaceAll('_', ' ')})`
    : 'not specified';
  const origin = (current.events || []).find(event => event.type === 'email.received' && (event.relations || []).includes(task.id));
  const sourceLine = origin
    ? `<p class="work-description">Source <strong>${escapeHtml(origin.source)}</strong> via ${escapeHtml(origin.connectorId || 'unknown')}.${origin.source === 'simulated' ? ' Simulated — not a live provider.' : ' Read from the provider.'}</p>`
    : '';
  return `<article class="work-card">
    <div class="work-topline"><span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(status)}</span><span class="work-date">Discovered ${time(task.createdAt)}</span></div>
    <h3>${escapeHtml(request.subjectEntity)} ${escapeHtml(request.deliverable)} follow-through</h3>
    <p class="work-description">Requested action: <strong>${escapeHtml(request.intent.replaceAll('_', ' '))}</strong>. Deadline: ${escapeHtml(deadline)}. Interpreted ${escapeHtml(interpretationNames[task.evidence?.interpretation] || task.evidence?.interpretation || 'deterministically')}.</p>
    ${sourceLine}
    <div class="source-row"><span class="source-symbol">@</span><div><strong>Request from ${escapeHtml(task.sender)}</strong><small>${escapeHtml(task.subject)} · email id ${escapeHtml(request.source.id)}</small></div></div>
    <div class="progress-path">
      <div class="progress-step"><strong>Request noticed</strong>Extracted from the incoming email without being asked to look.</div>
      <div class="progress-step ${found ? '' : 'muted'}"><strong>${found ? 'Context connected' : 'Looking for the right document'}</strong>${found ? `Matched “${escapeHtml(document.title)}”. ${escapeHtml(whyLinked || correlation)}` : 'No document with an identity link has been observed yet. That does not prove the work is incomplete.'}</div>
      <div class="progress-step ${task.assessment?.complete ? '' : 'muted'}"><strong>${task.assessment?.complete ? 'Evidence checked' : 'Checking completion'}</strong>${task.assessment?.complete ? 'Every requested field is present in the document.' : 'The requested work cannot yet be shown to be complete.'}</div>
    </div>
    <div class="assessment-box">
      <div class="assessment-head"><span>EVIDENCE PER REQUIREMENT</span><span>${escapeHtml(correlation)}</span></div>
      ${renderCriteria(task)}
      ${renderFreshness(task)}
    </div>
    ${renderClaims(task)}
    ${renderUnknowns(task)}
    ${renderVerification(task)}
    ${found ? `<a class="text-link" href="${escapeHtml(document.url)}" target="_blank" rel="noopener">Inspect source document · ${escapeHtml(document.externalId || document.id)} · modified ${escapeHtml(time(document.modifiedAt))} · version ${escapeHtml(document.version)} <span aria-hidden="true">↗</span></a>` : ''}
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
      'Noticing the request in the inbox',
      linked || draft.documentUrl ? 'Finding the matching document' : null,
      satisfied.length ? `Checking ${satisfied.length} required field${satisfied.length === 1 ? '' : 's'} against the source` : 'Checking the source against the request',
      'Drafting the reply from that evidence'
    ].filter(Boolean);
    return `<div class="approval-ready"><div class="approval-kicker">READY FOR YOUR REVIEW</div><h3>Reply to ${escapeHtml(draft.to)}</h3>
    <p class="approval-intro">A reply is prepared from the linked document and the email. Nothing has been sent.</p>
    <ol class="advance-chain" aria-label="What already happened">
      <li><strong>Noticed</strong><span>${escapeHtml(task.subject || 'Incoming request')} · ${escapeHtml(task.request?.source?.kind || 'email')}</span></li>
      <li><strong>Linked</strong><span>${escapeHtml(linked?.title || 'Document')}${linkReasons.length ? ` · ${escapeHtml(linkReasons[0])}` : ''}</span></li>
      <li><strong>Verified</strong><span>${satisfied.length ? satisfied.map(item => escapeHtml(item.label || item.id)).join(' · ') : 'No criterion recorded'}</span></li>
      <li><strong>Prepared</strong><span>Draft ready. Not sent.</span></li>
    </ol>
    ${renderVerification(task)}
    <div class="saved-work"><div class="mini-heading">WHAT YOU DID NOT HAVE TO DO</div><ul>${saved.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
    <div class="mail-preview"><div class="mail-headers"><div><span>TO</span><strong>${escapeHtml(draft.to)}</strong></div><div><span>SUBJECT</span><strong>${escapeHtml(draft.subject)}</strong></div></div><div class="mail-body">${escapeHtml(draft.body)}</div></div>
    <div class="permission-row"><span class="permission-chip">execute_external</span><span>${runtime?.shadow ? 'Shadow mode blocks this write.' : runtime?.mode === 'simulation' ? 'Approval records a local simulated receipt only.' : 'Requires your approval before any external effect.'}</span></div>
    <div class="approval-evidence"><span>✓</span> Checked against ${escapeHtml(String(criteria.length))} criteria · <a class="text-link" style="margin:0" href="${escapeHtml(draft.documentUrl)}" target="_blank" rel="noopener">view version ${escapeHtml(draft.documentVersion)} ↗</a></div>
    ${withheld.length ? `<div class="withheld-note"><strong>Withheld from this reply</strong><ul>${withheld.map(item => `<li>${escapeHtml(item.text)} — ${escapeHtml(item.reason || 'unsupported by evidence')}</li>`).join('')}</ul></div>` : ''}
    ${runtime?.shadow
      ? `<p class="fine-print">Shadow mode is read-only. This reply stays on this machine. Approving cannot send, edit, or delete anything outside it.${runtime.mode === 'simulation' ? ' Restart with UNPROMPTED_SHADOW_MODE=false to watch approval through verification in this local demonstration.' : ''}</p>`
      : `<div class="approval-buttons"><button class="primary-button" data-action="approve" data-id="${escapeHtml(task.id)}">${live ? 'Approve and send via Gmail' : 'Approve simulated send'}</button><button class="secondary-button" data-action="reject" data-id="${escapeHtml(task.id)}">Reject</button></div>
    <p class="fine-print">${live ? 'Approval sends a real email through Gmail, then verifies it with the provider.' : 'Approval writes to a simulated outbox only. No external service is contacted and the link is not reachable from outside this machine.'}</p>`}</div>`;
  }
  if (task.status === 'completed') {
    const verifiedLive = task.action?.status === 'verified_live';
    return `<div class="approval-done"><span class="status-pill completed">Verified complete</span><h3>Action confirmed</h3><p>${verifiedLive ? 'Gmail confirmed the message exists. The result came from the provider, not from a local record.' : 'After approval the simulated provider accepted the reply. The result was verified by receipt lookup, not assumed from the send attempt.'}</p><div class="receipt">Receipt ${escapeHtml(task.action?.receiptId)} · ${verifiedLive ? 'live provider' : 'simulated delivery'} · ${time(task.action?.verifiedAt)}</div></div>`;
  }
  if (task.status === 'blocked' && task.action) {
    return `<div class="approval-blocked"><span class="status-pill blocked">Outcome needs attention</span><h3>Delivery not confirmed</h3><p>${escapeHtml(task.reason)}</p><div class="receipt">No automatic retry. The provider is checked before any further attempt.</div><div class="approval-buttons"><button class="secondary-button" data-action="reconcile" data-id="${escapeHtml(task.id)}">Reconcile outcome</button>${task.action.status === 'confirmed_absent' && !runtime?.shadow ? `<button class="primary-button" data-action="retry" data-id="${escapeHtml(task.id)}">Retry after confirmed absence</button>` : ''}</div></div>`;
  }
  if (task.status === 'blocked') return `<div class="approval-blocked"><span class="status-pill blocked">Not sent</span><h3>Draft declined</h3><p>${escapeHtml(task.reason)}</p></div>`;
  if (task.status === 'cancelled') return `<div class="approval-blocked"><span class="status-pill cancelled">Closed</span><h3>Request closed</h3><p>${escapeHtml(task.reason)}</p></div>`;
  const unknowns = task.evidence?.unknowns || [];
  return `<div class="empty-state compact"><span class="empty-orbit approval-orbit"></span><h3>${task.status === 'verifying' ? 'Checking the outcome' : 'Waiting for enough evidence'}</h3><p>${task.status === 'verifying' ? 'A provider receipt is being verified.' : 'A draft appears only when the right document contains every requested result.'}</p>${unknowns.length ? `<div class="unknown-block"><div class="mini-heading">WHAT IS MISSING</div>${unknowns.map(item => `<div class="unknown-item"><strong>${escapeHtml(item.question)}</strong><small>${escapeHtml(item.reason)}</small></div>`).join('')}</div>` : ''}</div>`;
}

/**
 * A decision card always shows what happened, why it matters, what was
 * already checked, the evidence, what is still uncertain, and what to decide.
 */
function renderNotification(item) {
  const evidence = (item.evidence || []).filter(Boolean);
  return `<article class="decision-card ${escapeHtml(item.kind)}">
    <div class="decision-topline"><span class="decision-kind ${escapeHtml(item.kind)}">${escapeHtml(item.kind)}</span><span class="decision-priority">${escapeHtml(item.priority)} priority</span></div>
    <h3>${escapeHtml(item.headline)}</h3>
    <dl class="decision-fields">
      <div><dt>What happened</dt><dd>${escapeHtml(item.what)}</dd></div>
      <div><dt>Why it matters</dt><dd>${escapeHtml(item.why)}</dd></div>
      <div><dt>Checked</dt><dd><ul>${(item.checked || []).map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul></dd></div>
      ${evidence.length ? `<div><dt>Evidence</dt><dd><ul>${evidence.map(entry => `<li>${escapeHtml(entry.detail || '')}${entry.source ? ` <small class="source-ref">${escapeHtml(sourceLabel(entry.source))}</small>` : ''}</li>`).join('')}</ul></dd></div>` : ''}
      ${(item.uncertainty || []).length ? `<div><dt>Uncertain</dt><dd><ul>${item.uncertainty.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul></dd></div>` : ''}
      ${item.nextStep ? `<div><dt>Next step</dt><dd>${escapeHtml(item.nextStep)}</dd></div>` : ''}
      <div class="decision-ask"><dt>Your decision</dt><dd>${escapeHtml(item.decision)}</dd></div>
    </dl>
    ${renderDecisionButtons(item)}</article>`;
}

function renderDecisionButtons(item) {
  const options = item.options || [];
  if (item.clarificationId && options.length) {
    // Any calibration question — a permission, or how a date is read — is
    // answered through the same clarification route.
    return `<div class="approval-buttons">${options.map(option => `<button class="${option.value === 'allow' ? 'primary-button' : 'secondary-button'}" data-decision="answer" data-clarification="${escapeHtml(item.clarificationId)}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`).join('')}</div>`;
  }
  if (item.kind === 'opportunity' && item.opportunityId) {
    return `<div class="approval-buttons">${options.map(option => `<button class="${option.value === 'accept' ? 'primary-button' : 'secondary-button'}" data-decision="opportunity" data-opportunity="${escapeHtml(item.opportunityId)}" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`).join('')}</div>`;
  }
  if (item.kind === 'blocker') {
    // A stalled request offers the decision it actually needs: supply the
    // information, or close the request. An unclear action outcome offers
    // reconciliation instead.
    if (options.some(option => option.value === 'close') && item.taskId) {
      return `<div class="approval-buttons"><button class="primary-button" data-decision="cancel" data-task="${escapeHtml(item.taskId)}">Close this request</button><button class="secondary-button" data-decision="ack" data-notification="${escapeHtml(item.id)}">Keep waiting</button></div>`;
    }
    return `<div class="approval-buttons"><button class="primary-button" data-decision="reconcile" data-task="${escapeHtml(item.taskId || '')}">Reconcile the outcome</button><button class="secondary-button" data-decision="ack" data-notification="${escapeHtml(item.id)}">Leave it blocked</button></div>`;
  }
  return options.length
    ? `<div class="approval-buttons">${options.map(option => `<button class="secondary-button" data-decision="ack" data-notification="${escapeHtml(item.id)}">${escapeHtml(option.label)}</button>`).join('')}</div>`
    : '';
}

function renderDecisions(state) {
  const items = state.notifications || [];
  const cards = items.length
    ? items.map(renderNotification).join('')
    : '<div class="empty-state compact"><span class="empty-orbit approval-orbit"></span><h3>Nothing needs your decision</h3><p>Low-risk work is completed quietly. Anything that needs you appears here with the evidence behind it.</p></div>';
  return cards + renderParked(state.opportunities);
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
  return `<details class="held-work parked-work"><summary>Considered and not pursued (${parked.length})</summary>
    ${parked.map(item => `<article class="parked-row"><strong>${escapeHtml(item.statement)}</strong><small>${escapeHtml(item.reason || 'Not pursued.')} · ${escapeHtml(String(item.kind || '').replaceAll('_', ' '))}</small>${item.nextStep ? `<small class="parked-next">If pursued later: ${escapeHtml(item.nextStep)}</small>` : ''}</article>`).join('<hr class="task-divider">')}
  </details>`;
}

/** The value readout is derived from the engine's own records, not asserted. */
function renderMetrics(metrics) {
  if (!metrics) return '';
  const pct = value => (value == null ? 'n/a' : `${Math.round(value * 100)}%`);
  const rows = [
    ['Prepared from evidence', pct(metrics.discovery.valuableRate), `${metrics.discovery.valuable} of ${metrics.discovery.discovered} reached a prepared action. This is not your judgement.`],
    ['Unservable suggestions', pct(metrics.discovery.unservableRate), `${metrics.discovery.unservable} surfaced but not actionable`],
    ['Verified completion', pct(metrics.completion.verifiableCompletionRate), `${metrics.completion.verifiedCompletions} of ${metrics.completion.preparedActions} prepared`],
    ['Withheld claims', String(metrics.completion.withheldClaims), 'unsupported statements never sent'],
    ['Interruptions', String(metrics.attention.interruptions), `${metrics.attention.unresolved} still open`],
    ['Your takeovers', String(metrics.attention.takeovers), 'rejections, retries, corrections']
  ];
  if (metrics.review) {
    rows.push(
      ['Not yet judged', String(metrics.review.unevaluated ?? metrics.review.unreviewed), 'not useful, not useless, not unknown'],
      ['Labelled useful', String(metrics.review.useful), 'your judgement, not an automatic score'],
      ['Not useful', String(metrics.review.notUseful ?? 0), 'a negative judgement'],
      ['Wrong link', String(metrics.review.wrongAssociation ?? 0), 'a negative judgement, counted apart from not useful'],
      ['Recorded misses', String(metrics.review.misses ?? 0), 'work you saw and the system did not'],
      ['Time saved', metrics.review.unknown?.timeSaved || 'unknown', 'not observed'],
      ['Real events', String(metrics.events?.real ?? 0), `${metrics.events?.ingested ?? 0} ingested · ${metrics.sync?.failures ?? 0} sync failures`]
    );
  }
  if (metrics.value) {
    rows.push(['Follow-throughs absorbed', String(metrics.value.estimatedManualStepsAvoided ?? 0), 'verified completions you did not have to perform — an estimate, not wall-clock time']);
  }
  if (metrics.verification) {
    rows.push(['Source checks', String(metrics.verification.enhanced), `${metrics.verification.standard} needed no extra check · ${metrics.verification.corroborations} corroborated · ${metrics.verification.sourceConflicts} conflicting`]);
  }
  return `<div class="value-grid">${rows.map(([label, value, foot]) => `<div class="value-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(foot)}</small></div>`).join('')}</div>`;
}

function eventIcon(event) {
  if (event.type === 'email.received') return '@';
  if (event.type === 'experiment.run.completed') return '↺';
  return '◇';
}

function eventDetail(event) {
  if (event.disposition === 'related_change') return `Connected to ${event.relations.length} outstanding request${event.relations.length === 1 ? '' : 's'}`;
  if (event.disposition === 'unrelated_change') return 'No matching request · no action taken';
  if (event.disposition === 'stale_change') return 'Older revision ignored · newer version kept';
  if (event.disposition === 'discovered_request') return 'New request discovered from context';
  // An ignored message says which check declined it, so silence is auditable.
  if (event.rejection?.detail) return `Not a request · ${event.rejection.detail}`;
  if (event.type === 'document.modified') return 'Document available for future requests';
  return 'Observed without a supported task';
}

function renderEvents(events) {
  if (!events.length) return '<p class="empty-trace">Waiting for the first environmental event.</p>';
  return [...events].reverse().slice(0, 8).map(event => `<div class="trace-row"><span class="trace-icon ${escapeHtml(event.disposition)}">${eventIcon(event)}</span><div class="trace-text"><strong>${escapeHtml(event.summary)}</strong><small>${escapeHtml(eventDetail(event))} · ${escapeHtml(event.source)}${event.source === 'simulated' ? ' (not a real service)' : ''}</small></div><span class="trace-time">${time(event.at)}</span></div>`).join('');
}

function renderHistory(history) {
  if (!history.length) return '<p class="empty-trace">Decisions and checks will appear as work advances.</p>';
  return history.slice(0, 8).map(item => `<div class="trace-row"><span class="trace-icon ${escapeHtml(item.kind)}">${item.kind === 'verification' ? '✓' : item.kind === 'uncertain' ? '!' : item.kind === 'rejection' ? '—' : '·'}</span><div class="trace-text"><strong>${escapeHtml(item.text)}</strong><small>${escapeHtml(item.kind.replaceAll('_', ' '))}</small></div><span class="trace-time">${time(item.at)}</span></div>`).join('');
}

function renderContext(state) {
  const documents = state.documents || [];
  const runs = state.runRecords || [];
  if (!documents.length && !runs.length) return '<p class="empty-trace">No context observed yet.</p>';
  const docRows = documents.map(document => `<div class="context-row"><span class="context-kind">DOC</span><div><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.id)} · v${escapeHtml(document.version)} · ${escapeHtml(document.source)}${document.source === 'simulated' ? ' (simulated)' : ''} · ${time(document.modifiedAt)}</small></div></div>`).join('');
  const runRows = runs.map(run => `<div class="context-row"><span class="context-kind run">RUN</span><div><strong>${escapeHtml(run.label)}</strong><small>${escapeHtml(run.id)} · completed ${escapeHtml(String(run.completedAt).slice(0, 10))}${run.subjectEntity ? ` · ${escapeHtml(run.subjectEntity)}` : ''}</small></div></div>`).join('');
  return docRows + runRows;
}

function renderRuntime(report) {
  runtime = report;
  const live = report.mode === 'live';
  byId('modeTitle').textContent = live ? 'Live workspace' : 'Simulation workspace';
  byId('modeDetail').textContent = report.note;
  byId('modeBeacon').className = `sim-beacon${live ? ' live' : ''}`;
  const notice = byId('demoNotice');
  // The demonstration copy and its replay control only belong to a workspace
  // where the simulation is actually running.
  if (notice) notice.hidden = live || report.simulationRunning === false;
  byId('workspaceMark').textContent = live ? 'G' : 'S';
  byId('workspaceName').textContent = live ? 'This workspace' : 'Local simulation';
  byId('workspaceMeta').textContent = live ? 'Google events, read only' : 'No real account is connected';
  const footer = byId('footerMode');
  if (footer) footer.textContent = live ? 'LIVE READ-ONLY · NOTHING IS SENT' : 'LOCAL SIMULATION · NO REAL SEND';
  const chip = document.querySelector('.mode-chip');
  if (chip) chip.textContent = live ? 'LIVE PROVIDERS' : 'SIMULATED ENVIRONMENT';
  const missingGoogleCredentials = report.google?.missing || [];
  // A clean simulation intentionally has no Google credentials. Surface setup
  // guidance only when someone has begun configuring that optional connector.
  const pending = missingGoogleCredentials.length > 0 && missingGoogleCredentials.length < 3
    ? missingGoogleCredentials
    : [];
  const providerNote = live ? (report.google?.sendEnabled ? 'send enabled' : 'read-only') : 'local outbox only';
  const writeNote = live
    ? report.shadow ? 'Shadow mode blocks external writes.' : 'External actions require your approval.'
    : 'Approval records a local simulated receipt only.';
  byId('runtimeBanner').className = `runtime-banner ${live ? 'live' : 'simulated'}`;
  byId('runtimeBanner').innerHTML = `<strong>${live ? 'Live mode' : 'Simulated mode'}</strong>
    <span>Outbound mail: ${escapeHtml(report.mailProvider)} · ${escapeHtml(providerNote)}</span>
    <span>${escapeHtml(writeNote)}</span>
    <span>${live ? 'Events come from Google Workspace.' : 'Events come from the deterministic local scenario.'}</span>
    ${pending.length ? `<span class="pending-config">Still needs configuration: ${escapeHtml(pending.join(', '))}</span>` : ''}`;
}

function render(state) {
  if (current && state.simulation?.startedAt === current.simulation?.startedAt && state.revision < current.revision) return;
  current = state;
  const tasks = [...state.tasks].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const pending = tasks.filter(task => task.status === 'ready_for_approval');
  const held = tasks.filter(task => task.status === 'waiting_for_information' && !task.draft);
  const shown = tasks.filter(task => !held.includes(task));
  const openDecisions = (state.notifications || []).length;
  byId('metricEvents').textContent = state.events.length;
  byId('metricTasks').textContent = tasks.length;
  byId('metricApproval').textContent = pending.length;
  byId('navWorkCount').textContent = tasks.length;
  byId('navApprovalCount').textContent = pending.length;
  byId('approvalCount').textContent = `${pending.length} pending`;
  byId('lastUpdated').textContent = state.events.length ? `Latest observation ${time(state.events.at(-1).at)}` : 'Waiting for the first event';
  const heldHtml = held.length
    ? `<details class="held-work"><summary>Checked and left alone (${held.length})</summary>${held.map(renderWork).join('<hr class="task-divider">')}</details>`
    : '';
  byId('workContent').innerHTML = (shown.length ? shown.map(renderWork).join('<hr class="task-divider">') : '') + heldHtml
    || '<div class="empty-state"><span class="empty-orbit"></span><h3>Listening for what matters</h3><p>Relevant requests will appear here as environmental events arrive.</p></div>';
  const quiet = byId('quietStatus');
  if (!pending.length && !openDecisions) {
    quiet.className = 'quiet-status calm';
    quiet.innerHTML = `<strong>Nothing needs you.</strong><p>Watched ${state.events.length} event${state.events.length === 1 ? '' : 's'}. No new action met the evidence threshold, so nothing was sent automatically. An unjudged discovery is not a verdict.</p>`;
  } else {
    quiet.className = 'quiet-status attention';
    const actionNote = runtime?.mode === 'simulation'
      ? runtime?.shadow
        ? 'This simulation stays local, and shadow mode blocks even simulated approval writes.'
        : 'Approval writes a simulated receipt to a local outbox only; no external service is contacted.'
      : runtime?.shadow
        ? 'Shadow mode blocks external writes.'
        : 'Any configured external action still requires your approval.';
    quiet.innerHTML = `<strong>${pending.length} prepared action${pending.length === 1 ? '' : 's'} waiting${openDecisions ? `, plus ${openDecisions} open decision${openDecisions === 1 ? '' : 's'}` : ''}.</strong><p>New actions are never sent automatically. ${actionNote}</p>${pending.length ? '<a class="status-action-link" href="#approval">Review the prepared reply <span aria-hidden="true">↓</span></a>' : ''}`;
  }
  const actionTask = pending[0] || tasks.find(task => ['verifying', 'blocked', 'completed'].includes(task.status));
  byId('approvalContent').innerHTML = actionTask ? renderApproval(actionTask) : '<div class="empty-state compact"><span class="empty-orbit approval-orbit"></span><h3>Nothing to approve yet</h3><p>When evidence supports an action, a proposed reply will appear here for your decision.</p></div>';
  byId('eventContent').innerHTML = renderEvents(state.events);
  byId('historyContent').innerHTML = renderHistory(state.history);
  byId('contextContent').innerHTML = renderContext(state);
  byId('decisionsContent').innerHTML = renderDecisions(state);
  byId('metricsContent').innerHTML = renderMetrics(state.metrics);
  byId('navDecisionCount').textContent = (state.notifications || []).length;
  const misses = state.misses || [];
  const missList = byId('missList');
  if (missList) {
    missList.innerHTML = misses.length
      ? misses.slice().reverse().map(item => `<article class="miss-row"><strong>${escapeHtml(item.note)}</strong><small>Revision ${escapeHtml(item.revision)} · ${escapeHtml(time(item.at))}${item.sourceHint ? ` · ${escapeHtml(item.sourceHint)}` : ''}</small></article>`).join('')
      : '<p class="empty-trace">No missed item has been recorded. That does not mean nothing was missed.</p>';
  }
}

async function post(path) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-feedback]');
  if (!button || busy) return;
  busy = true;
  button.disabled = true;
  try {
    const reasonField = document.querySelector(`[data-reason-for="${CSS.escape(button.dataset.id)}"]`);
    const response = await fetch(`/api/tasks/${encodeURIComponent(button.dataset.id)}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: button.dataset.feedback, reason: reasonField?.value || '' })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save the label');
    toast('Label saved.');
    render(result.state);
  } catch (error) { toast(error.message, true); }
  finally { busy = false; button.disabled = false; }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const action = button.dataset.action;
  if (action === 'reject' && !confirm('Reject this prepared reply? Nothing will be sent.')) return;
  busy = true;
  button.disabled = true;
  try {
    const result = await post(`/api/tasks/${encodeURIComponent(button.dataset.id)}/${action}`);
    const messages = {
      approve: result.status === 'completed' ? 'Approved and verified with the provider.' : 'Approved; the delivery outcome needs reconciliation.',
      reject: 'Draft rejected. Nothing was sent.',
      retry: 'Retry outcome checked against the provider.',
      reconcile: 'Provider outcome reconciled.'
    };
    toast(messages[action] || 'Done.');
    const response = await fetch('/api/state');
    render(await response.json());
  } catch (error) { toast(error.message, true); }
  finally { busy = false; button.disabled = false; }
});

const decisionMessages = {
  answer: 'Recorded. The system will act only within that scope.',
  opportunity: 'Decision recorded. Nothing was started on your behalf.',
  reconcile: 'Provider outcome reconciled.',
  cancel: 'Request closed. Nothing was sent.',
  ack: 'Acknowledged.'
};

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-decision]');
  if (!button || busy) return;
  const kind = button.dataset.decision;
  const path = kind === 'answer' ? `/api/clarifications/${encodeURIComponent(button.dataset.clarification)}/answer`
    : kind === 'opportunity' ? `/api/opportunities/${encodeURIComponent(button.dataset.opportunity)}/${encodeURIComponent(button.dataset.value)}`
      : kind === 'reconcile' ? `/api/tasks/${encodeURIComponent(button.dataset.task)}/reconcile`
        : kind === 'cancel' ? `/api/tasks/${encodeURIComponent(button.dataset.task)}/cancel`
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

byId('missForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const note = new FormData(form).get('note');
  const sourceHint = new FormData(form).get('sourceHint');
  busy = true;
  try {
    const response = await fetch('/api/misses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note, sourceHint })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not record the miss');
    form.reset();
    toast('Miss recorded. No task was created.');
    render(result.state);
  } catch (error) { toast(error.message, true); }
  finally { busy = false; }
});

byId('restartDemo').addEventListener('click', async () => {
  if (busy || !confirm('Replay the local simulation? This clears its simulated requests, events, and outbox.')) return;
  busy = true;
  try { render(await post('/api/demo/restart')); toast('Scenario restarted. New events will arrive automatically.'); }
  catch (error) { toast(error.message, true); }
  finally { busy = false; }
});

(async () => {
  try {
    const [stateResponse, runtimeResponse] = await Promise.all([fetch('/api/state'), fetch('/api/runtime')]);
    renderRuntime(await runtimeResponse.json());
    render(await stateResponse.json());
  } catch (error) { toast(`Could not load workspace: ${error.message}`, true); }
  const stream = new EventSource('/api/stream');
  stream.onopen = () => { byId('connectionDot').classList.add('connected'); byId('connectionText').textContent = 'Connected'; };
  stream.onmessage = message => { try { render(JSON.parse(message.data)); } catch (error) { console.error('Invalid state event', error); } };
  stream.onerror = () => { byId('connectionDot').classList.remove('connected'); byId('connectionText').textContent = 'Reconnecting'; };
})();
