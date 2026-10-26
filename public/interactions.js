import { copy, ui } from './i18n.js';
import { readLocal, writeLocal, evidenceFacts, evidenceDelta, decisionQueue, decisionCursor } from './ux-state.js';

export function createInteractions({ context, renderTask, renderNotice, update, refresh, escape, title, sourceLabel, time }) {
  const byId = id => document.getElementById(id);
  let workspace = null;
  let reviewed = {};
  let mode = readLocal('unprompted:decision-view', 'focus') === 'list' ? 'list' : 'focus';
  let queue = [];
  let selected = null;
  let previousIndex = 0;
  let receipt = null;
  let proof = null;
  let press = null;
  let suppressedClickUntil = 0;
  let pendingProofRefresh = false;

  function prepare() {
    const { state, workspace: key, visitBaseline } = context();
    if (!state) return;
    if (workspace !== key) {
      closeProof(false);
      workspace = key;
      reviewed = readLocal(`${key}:evidence-seen`, {});
      if (!reviewed || typeof reviewed !== 'object' || Array.isArray(reviewed)) reviewed = {};
      selected = null;
      previousIndex = 0;
      receipt = null;
    }
    for (const task of state.tasks) {
      if (!Object.hasOwn(reviewed, task.id)) reviewed[task.id] = visitBaseline?.facts?.[task.id] || evidenceFacts(task);
    }
    if (proof) {
      const task = state.tasks.find(item => item.id === proof.taskId);
      // An open peek never silently changes the facts being read.
      if (!task || JSON.stringify(evidenceFacts(task)) !== JSON.stringify(proof.facts)) closeProof(false);
    }
  }

  function delta(task) {
    return evidenceDelta(task, reviewed[task.id]);
  }

  function deltaLabel(change) {
    if (!change?.hasChanges) return '';
    if (change.changed.length) return copy('{count} 项核对结果有变化', { count: change.changed.length });
    if (change.versionChanged) return copy('文档版本有更新');
    if (change.freshnessChanged) return copy('证据时效有变化');
    if (change.conflictsChanged) return copy('来源情况有变化');
    return copy('核对范围有变化');
  }

  function unitTitle(item) {
    return item.kind === 'task' ? title(item.value) : item.value.headline;
  }

  function renderQueue(tasks, notices) {
    queue = decisionQueue(tasks, notices);
    const oldKey = selected;
    selected = decisionCursor(queue, selected, previousIndex);
    previousIndex = Math.max(0, queue.findIndex(item => item.key === selected));
    const focused = byId('decisionDeckCurrent').contains(document.activeElement);
    byId('decisionModebar').hidden = !queue.length;
    byId('decisionList').hidden = mode === 'focus' && Boolean(queue.length);
    byId('decisionDeck').hidden = mode !== 'focus' || !queue.length;
    for (const button of document.querySelectorAll('[data-decision-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.decisionMode === mode));
    }
    const current = queue[previousIndex];
    const announcement = current ? `${copy('第 {index} 件，共 {total} 件', { index: previousIndex + 1, total: queue.length })} · ${unitTitle(current)}` : '';
    if (byId('decisionAnnouncer').textContent !== announcement) byId('decisionAnnouncer').textContent = announcement;
    byId('decisionPosition').textContent = current ? copy('第 {index} 件，共 {total} 件', { index: previousIndex + 1, total: queue.length }) : '';
    byId('previousDecision').disabled = previousIndex === 0;
    byId('nextDecision').disabled = previousIndex >= queue.length - 1;
    if (current) {
      update('decisionDeckCurrent', current.kind === 'task' ? renderTask(current.value) : renderNotice(current.value));
      const upcoming = queue.slice(previousIndex + 1, previousIndex + 3);
      update('decisionUpcoming', upcoming.map((item, index) => ui`<button class="decision-preview" data-queue-key="${escape(item.key)}" style="--depth:${index}"><span>${index ? copy('再下一件') : copy('下一件')}</span><strong>${escape(unitTitle(item))}</strong><span aria-hidden="true">↗</span></button>`).join(''));
      byId('decisionUpcoming').hidden = !upcoming.length;
    } else {
      update('decisionDeckCurrent', '');
      update('decisionUpcoming', '');
    }
    if (oldKey && oldKey !== selected && focused && current && mode === 'focus') byId('decisionDeckTitle').focus({ preventScroll: true });
    renderReceipt();
  }

  function renderReceipt() {
    byId('decisionReceipt').hidden = !receipt;
    if (!receipt) return;
    byId('decisionReceipt').dataset.status = receipt.kind;
    const labels = {
      verified: copy('已完成，并已核验结果'), declined: copy('已搁下，没有发送'),
      closed: copy('已关闭，没有发送'), restored: copy('已恢复跟进，没有发送'),
      uncertain: copy('结果仍待核实')
    };
    update('decisionReceipt', ui`<span class="receipt-mark" aria-hidden="true">${receipt.kind === 'uncertain' ? '·' : '✓'}</span><div><strong>${labels[receipt.kind]}</strong><p>${escape(receipt.title)}</p></div>${['declined', 'closed'].includes(receipt.kind) ? ui`<button class="text-button" data-action="reopen" data-id="${escape(receipt.taskId)}">撤销</button>` : ''}<button class="icon-button" data-clear-receipt aria-label="收起这条回执">×</button>`);
  }

  function noteResult(taskId, action, result) {
    let kind = null;
    if (['approve', 'retry', 'reconcile'].includes(action)) {
      if (result.status === 'completed' && ['verified_live', 'verified_simulated'].includes(result.action?.status)) kind = 'verified';
      else if (['blocked', 'verifying'].includes(result.status)) kind = 'uncertain';
    }
    if (action === 'reject' && result.status === 'blocked' && !result.action) kind = 'declined';
    if (action === 'cancel' && result.status === 'cancelled') kind = 'closed';
    if (action === 'reopen' && ['ready_for_approval', 'waiting_for_information'].includes(result.status)) kind = 'restored';
    if (!kind) return;
    const task = context().state?.tasks.find(item => item.id === taskId) || result;
    receipt = { kind, taskId, title: title(task) };
    renderReceipt();
  }

  function sourceURL(value) {
    if (!value) return null;
    try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  }

  function proofRows(task, change, changesOnly) {
    let rows = task.evidence?.criteria || [];
    if (changesOnly) rows = rows.filter(item => change?.changed.includes(item.id));
    if (!rows.length) return ui`<div class="proof-empty"><strong>${changesOnly ? copy('核对结果没有变化') : copy('还没有可核对的具体要求')}</strong><p>${changesOnly ? copy('版本或来源情况已更新，可以切换查看全部要求。') : copy('我会等到有可引用的证据再判断。')}</p></div>`;
    return rows.map((item, index) => {
      const met = item.status === 'satisfied';
      const evidence = item.evidence?.[0];
      const excerpt = evidence?.excerpt || evidence?.detail;
      const changed = change?.changed.includes(item.id);
      return ui`<details class="proof-row ${met ? 'met' : 'unmet'}" ${index < 2 ? 'open' : ''}><summary><span class="proof-mark" aria-hidden="true">${met ? '✓' : '·'}</span><strong>${escape(item.label || item.id)}</strong>${changed ? ui`<span class="proof-new">有变化</span>` : ''}<span class="proof-row-state">${met ? copy('有证据') : copy('等待证据')}</span></summary><div class="proof-row-body">${excerpt ? ui`<blockquote>${escape(excerpt)}</blockquote>${evidence.source ? ui`<small>${escape(sourceLabel(evidence.source))}</small>` : ''}` : ui`<p>${met ? copy('已记录为满足，暂未附带可引用的片段。') : escape(item.note || copy('当前文档中尚未找到足够证据。'))}</p>`}</div></details>`;
    }).join('');
  }

  function renderProof() {
    if (!proof) return;
    const { task, change, changesOnly } = proof;
    const doc = context().state?.documents.find(item => item.id === task.documentId);
    const risk = ['stale', 'contradictory', 'unverified'].includes(task.evidence?.freshness?.status) || Boolean(task.evidence?.conflicts?.length);
    const changes = [];
    if (change?.versionChanged) changes.push(copy('文档版本：{before} → {after}', { before: change.fromVersion ?? '—', after: change.toVersion ?? '—' }));
    if (change?.gained.length) changes.push(copy('新增证据支持 {count} 项要求', { count: change.gained.length }));
    if (change?.lost.length) changes.push(copy('{count} 项要求不再满足', { count: change.lost.length }));
    if (change?.removed.length) changes.push(copy('核对范围减少了 {count} 项', { count: change.removed.length }));
    if (change?.freshnessChanged) changes.push(copy('证据时效状态发生变化'));
    if (change?.conflictsChanged) changes.push(copy('来源冲突情况发生变化'));
    byId('evidencePeekTitle').textContent = title(task);
    const url = sourceURL(doc?.url);
    const historical = doc?.version != null && proof.facts.version != null && doc.version !== proof.facts.version;
    update('evidencePeekContent', ui`<div class="proof-source"><span>${escape(doc?.title || copy('尚未关联文档'))}</span>${proof.facts.version != null ? ui`<strong>v${escape(proof.facts.version)}</strong>` : ''}${url ? ui`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>` : ''}</div>${historical ? ui`<p class="proof-historical">这里引用核对时的版本，原文链接可能已更新。</p>` : ''}${change?.hasChanges ? ui`<div class="proof-changes"><div class="proof-change-title">从上次查看之后</div>${changes.map(line => ui`<p>${escape(line)}</p>`).join('')}</div><div class="proof-mode" role="group" aria-label="证据显示方式"><button data-proof-mode="changes" aria-pressed="${changesOnly}">只看变化</button><button data-proof-mode="all" aria-pressed="${!changesOnly}">全部要求</button></div>` : ''}${risk ? ui`<p class="proof-caution">证据仍有待核实，不能仅凭核对数量判断已完成。</p>` : ''}<div class="proof-rows">${proofRows(task, change, changesOnly)}</div><div class="proof-footer"><span>${proof.ephemeral ? copy('松手收起') : copy('点击外部或 Esc 收起')}</span><button class="text-button" data-open-task="${escape(task.id)}">完整记录 ↗</button></div>`);
  }

  function positionProof() {
    if (!proof) return;
    const panel = byId('evidencePeek');
    if (innerWidth <= 700) { panel.style.left = '12px'; panel.style.right = '12px'; panel.style.top = 'auto'; panel.style.bottom = '12px'; return; }
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    const anchor = proof.anchor.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const left = Math.max(16, Math.min(anchor.left, innerWidth - bounds.width - 16));
    const top = anchor.bottom + bounds.height + 10 <= innerHeight - 16 ? anchor.bottom + 10 : Math.max(16, anchor.top - bounds.height - 10);
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }

  function openProof(button, changesOnly = false, ephemeral = false) {
    const taskId = button.dataset.proof || button.dataset.proofChanges;
    const task = context().state?.tasks.find(item => item.id === taskId);
    if (!task) return;
    if (proof) closeProof(false);
    proof = { taskId, task, anchor: button, facts: evidenceFacts(task), change: delta(task), changesOnly, ephemeral };
    button.setAttribute('aria-expanded', 'true');
    byId('evidencePeek').hidden = false;
    renderProof(); positionProof();
    if (!ephemeral) byId('evidencePeek').focus({ preventScroll: true });
  }

  function closeProof(updateCards = true, restoreFocus = false) {
    if (!proof) return;
    const prior = proof;
    proof = null;
    prior.anchor?.setAttribute('aria-expanded', 'false');
    byId('evidencePeek').hidden = true;
    // The exact snapshot that was shown is what gets marked read, even if newer evidence arrived.
    reviewed[prior.taskId] = prior.facts;
    if (workspace) writeLocal(`${workspace}:evidence-seen`, reviewed);
    if (updateCards) refresh();
    if (restoreFocus) [...document.querySelectorAll('[data-proof]')].find(button => button.dataset.proof === prior.taskId && button.checkVisibility())?.focus({ preventScroll: true });
  }

  document.addEventListener('pointerdown', event => {
    const button = event.target.closest('[data-proof], [data-proof-changes]');
    if (proof && !byId('evidencePeek').contains(event.target) && !button) { closeProof(false); pendingProofRefresh = true; }
    if (!button || button.dataset.proofChanges || event.button !== 0) return;
    press = { button, pointerId: event.pointerId, timer: setTimeout(() => {
      if (press?.button === button) { press.opened = true; openProof(button, false, true); }
    }, 260) };
  });
  function releasePress() {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.opened) { suppressedClickUntil = Date.now() + 600; closeProof(true); }
    press = null;
  }
  document.addEventListener('pointerup', releasePress);
  document.addEventListener('pointercancel', releasePress);
  document.addEventListener('contextmenu', event => { if (event.target.closest('[data-proof]')) event.preventDefault(); });
  document.addEventListener('click', event => {
    if (pendingProofRefresh) { pendingProofRefresh = false; refresh(); }
    const trigger = event.target.closest('[data-proof], [data-proof-changes]');
    if (trigger) {
      if (Date.now() < suppressedClickUntil) { event.preventDefault(); return; }
      if (proof?.anchor === trigger) closeProof(true, true);
      else openProof(trigger, Boolean(trigger.dataset.proofChanges));
      return;
    }
    if (event.target.closest('[data-close-proof]')) { closeProof(true, true); return; }
    const proofMode = event.target.closest('[data-proof-mode]');
    if (proofMode && proof) { proof.changesOnly = proofMode.dataset.proofMode === 'changes'; renderProof(); positionProof(); return; }
    if (event.target.closest('[data-view], [data-go], [data-open-task]')) closeProof(false);
    const viewMode = event.target.closest('[data-decision-mode]');
    if (viewMode) { mode = viewMode.dataset.decisionMode; writeLocal('unprompted:decision-view', mode); refresh(); return; }
    const step = event.target.closest('[data-queue-step]');
    const pick = event.target.closest('[data-queue-key]');
    if (step || pick) {
      closeProof(false);
      selected = pick?.dataset.queueKey || queue[Math.max(0, Math.min(previousIndex + Number(step.dataset.queueStep), queue.length - 1))]?.key;
      refresh(); return;
    }
    if (event.target.closest('[data-clear-receipt]')) { receipt = null; renderReceipt(); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && proof) { event.preventDefault(); closeProof(true, true); return; }
    if (event.target.closest('input, textarea, select, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]') || proof) return;
    if (mode === 'focus' && !byId('viewAttention').hidden && ['j', 'k'].includes(event.key.toLowerCase()) && queue.length) {
      event.preventDefault();
      selected = queue[Math.max(0, Math.min(previousIndex + (event.key.toLowerCase() === 'j' ? 1 : -1), queue.length - 1))].key;
      refresh();
    }
  });
  window.addEventListener('resize', () => { if (proof) positionProof(); });
  window.addEventListener('scroll', event => {
    if (!proof || byId('evidencePeek').contains(event.target)) return;
    const bounds = proof.anchor.getBoundingClientRect();
    // A scroll already queued before opening must not immediately dismiss it.
    if (proof.anchor.isConnected && bounds.bottom > 0 && bounds.top < innerHeight) positionProof();
    else closeProof(false);
  }, { capture: true, passive: true });
  window.addEventListener('blur', releasePress);
  document.addEventListener('focusin', event => {
    if (proof && !proof.ephemeral && !byId('evidencePeek').contains(event.target) && event.target !== proof.anchor) closeProof(false);
  });
  window.addEventListener('hashchange', () => closeProof(true));
  return { prepare, delta, deltaLabel, renderQueue, noteResult, closeProof };
}
