import { copy, getLocale, formatTime } from './i18n.js';
import { readLocal, writeLocal } from './ux-state.js';
import { createAppearance } from './appearance.js';
import { WORKSPACE_MODES, taskState, stateGroup, isFinished, taskSources, taskSteps, activityEntries, nextQueueId } from './workspace-model.js';

const t = (zh, en) => getLocale() === 'en' ? en : zh;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const paths = {
  field: '<path d="M4 5h16M8 5v14m8-14v14M4 19h16"/><circle cx="8" cy="10" r="2"/><circle cx="16" cy="14" r="2"/>',
  index: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  lanes: '<path d="M4 5v14m8-14v14m8-14v14M4 9h8m0 6h8"/><circle cx="4" cy="9" r="2"/><circle cx="12" cy="15" r="2"/>',
  spotlight: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><circle cx="12" cy="12" r="3"/>',
  pulse: '<path d="M2 12h5l3-7 4 14 3-7h5"/>',
  pause: '<path d="M8 5v14m8-14v14"/>', resume: '<path d="m9 5 10 7-10 7Z"/>',
  source: '<path d="M9 15 15 9m-7 3-2 2a4 4 0 0 0 6 6l2-2m-2-12 2-2a4 4 0 0 1 6 6l-2 2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z"/>',
  memory: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 11v5m4-5v5"/>',
};
export const workspaceIcon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.field}</svg>`;

const modeLabel = mode => ({ field: t('全局', 'Field'), index: t('列表', 'List'), lanes: t('并行', 'Lanes'), spotlight: t('专注', 'Focus'), pulse: t('变更', 'Changes') })[mode];
const shortMoment = value => {
  if (!value) return '';
  const date = new Date(value), now = new Date();
  if (Number.isNaN(date.getTime())) return '';
  if (date.toLocaleDateString() === now.toLocaleDateString()) return formatTime(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};
const stateLabel = state => ({
  needs_user: t('需要你', 'Needs you'), working: t('正在处理', 'Working'), waiting_external: t('等待外部变化', 'Waiting externally'),
  observing: t('观察中', 'Observing'), paused_by_user: t('已暂停', 'Paused'), paused_by_policy: t('因规则暂停', 'Paused by a rule'), source_disconnected: t('来源已断开', 'Source disconnected'),
  failed: t('处理失败', 'Failed'), result_unverified: t('结果待核实', 'Result unverified'), verified: t('已核验', 'Verified'),
  closed: t('已停止跟进', 'Stopped following'), user_accepted: t('你已接受', 'Accepted by you'), unknown: t('状态待确认', 'State unknown')
})[state];
const groupLabel = group => ({ attention: t('需要你', 'Needs you'), working: t('进行中', 'In motion'), waiting: t('等待中', 'Waiting'), quiet: t('观察 · 暂停 · 已结束', 'Watching · paused · done') })[group];
const stepLabel = key => ({ review: t('等待你审阅', 'Awaiting your review'), reviewed: t('你已接受', 'Accepted by you'), source: t('读取来源', 'Read sources'), evidence: t('核对要求', 'Check requirements'), prepare: t('准备结果', 'Prepare result'), verify: t('核实结果', 'Verify result'), verified: t('结果已核验', 'Result verified'), observe: t('跟进来源状态', 'Observe source state'), source_change: t('等待来源变化', 'Wait for a change') })[key];
const safeURL = value => { try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };

export function createWorkspace({ context, update, post, applyState, notify, renderAction, renderManagement, renderDetails, go, refresh }) {
  let mode = readLocal('unprompted:workspace-default', 'field');
  if (!WORKSPACE_MODES.includes(mode)) mode = 'field';
  const appearance = createAppearance({ icon: workspaceIcon });
  let selected = null, selectedEvent = null, workspace = null, lastRender = null, composing = false;
  let returnMode = mode === 'spotlight' ? 'field' : mode;
  const drafts = new Map(), pending = new Set(), errors = new Map();
  let contextPanel = null, contextTrigger = null, restoreContextFocus = true;
  const byId = id => document.getElementById(id);
  // Same admission context the decision queue uses. A persisted wait often
  // lives on state.taskWaits rather than on the task itself.
  function admissionContext() {
    const view = context();
    return { connections: view.connections, taskWaits: view.state?.taskWaits };
  }

  function scopedMemories(task) {
    const normal = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    if (!task.request?.subjectEntity || !task.request?.deliverable) return [];
    return (context().state.taskMemories || []).filter(memory => !memory.deletedAt &&
      normal(memory.scope.entity) === normal(task.request.subjectEntity) && normal(memory.scope.deliverable) === normal(task.request.deliverable));
  }

  function renderContextDialog() {
    if (!contextPanel) return;
    const task = context().state.tasks.find(task => task.id === contextPanel.id);
    if (!task) { byId('taskContextDialog').close(); return; }
    const { kind } = contextPanel;
    byId('taskContextTitle').textContent = kind === 'sources' ? t('任务来源', 'Task sources') : t('任务记忆', 'Task memory');
    byId('taskContextSubtitle').textContent = task.subject || '';
    let html;
    if (kind === 'sources') {
      const refs = taskSources(task, context().state);
      html = refs.map((ref, index) => {
        const doc = context().state.documents?.find(item => item.id === ref.id);
        const message = context().state.inbox?.find(item => item.id === ref.id);
        const unavailable = doc?.available === false;
        const excerpt = unavailable ? '' : doc?.content || message?.body || '';
        const url = !unavailable && ref.url && safeURL(ref.url);
        return `<article class="ws-source-reference"><div class="ws-reference-heading"><span class="ws-source-chip">${esc(ref.provider === 'Simulation' ? t('模拟来源', 'Simulation') : ref.provider)}</span>${doc?.version ? `<span>${t('版本', 'Version')} ${esc(doc.version)}</span>` : ''}${url ? `<a id="context-source-${index}" class="text-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t('打开原文', 'Open source')} ↗</a>` : ''}</div><h3>${esc(ref.label)}</h3>${excerpt ? `<blockquote>${esc(excerpt.slice(0, 2500))}${excerpt.length > 2500 ? '…' : ''}</blockquote>` : `<p class="muted">${t('此来源的状态保留在任务记录中。', 'The source state is retained in the task record.')}</p>`}</article>`;
      }).join('') + (task.mcpCalls || []).slice().reverse().map(call => `<article class="ws-source-reference"><div class="ws-reference-heading"><span class="ws-source-chip">MCP · ${esc(call.serverId)}</span><span>${call.status === 'completed' ? t('已读取', 'Read') : t('调用失败', 'Call failed')}</span></div><h3>${esc(call.tool)}</h3><small>${esc(new Date(call.finishedAt).toLocaleString())}</small>${call.text ? `<blockquote>${esc(call.text)}</blockquote>` : `<p class="muted">${esc(call.error || '')}</p>`}</article>`).join('') + `<button class="text-button ws-context-navigation" data-context-page="sources">${t('管理所有连接', 'Manage all connections')} ${workspaceIcon('arrow', 14)}</button>${context().state.durable ? `<button class="text-button" data-forget-kind="task" data-forget-id="${esc(task.id)}">${t('忘记任务与关联数据', 'Forget task and related data')}</button>` : ''}`;
    } else {
      const draft = drafts.get(task.id) || { text: '', scope: 'task' };
      const editable = !isFinished(task) && !task.action && task.status !== 'verifying';
      const similar = Boolean(task.request?.subjectEntity && task.request?.deliverable);
      html = editable ? `<section class="ws-memory-scope-options"><h3>${t('这次纠偏用于', 'Apply this correction to')}</h3><button class="ws-scope-option" data-memory-scope="task" aria-pressed="${draft.scope === 'task'}"><span><strong>${t('仅这件事', 'This task only')}</strong><small>${t('不创建共享记忆', 'Do not create shared memory')}</small></span><i>${draft.scope === 'task' ? '✓' : ''}</i></button><button class="ws-scope-option" data-memory-scope="similar" aria-pressed="${draft.scope === 'similar'}" ${similar ? '' : 'disabled'}><span><strong>${t('记住，用于同类任务', 'Remember for similar tasks')}</strong><small>${similar ? esc(`${task.request.subjectEntity} · ${task.request.deliverable}`) : t('需要明确的项目与交付物', 'Requires an identified project and deliverable')}</small></span><i>${draft.scope === 'similar' ? '✓' : ''}</i></button></section>` : '';
      const memories = scopedMemories(task);
      if (editable) html += `<label>${t('如何应用这次要求', 'Apply this direction')}<select data-direction-operation="${esc(task.id)}"><option value="append">${t('补充原要求', 'Add to the original requirements')}</option><option value="replace" ${draft.operation === 'replace' ? 'selected' : ''} ${draft.scope === 'similar' ? 'disabled' : ''}>${t('替换本任务的内容要求', 'Replace this task’s content requirements')}</option></select></label>`;
      const linked = memories.find(memory => memory.id === task.guidance?.memoryId && memory.text === task.guidance?.text);
      const additional = memories.filter(memory => memory.id !== linked?.id);
      const manifest = task.contextManifest;
      if (manifest) html += `<section class="ws-context-memories"><h3>${t('本次采用的上下文', 'Context used in this run')}</h3>${manifest.selected.map(item => `<article><small>${item.kind === 'memory' ? t('记忆', 'Memory') : t('经验', 'Experience')} · ${esc(item.scopeKey || '')}</small><p>${esc(item.text || item.instruction)}</p></article>`).join('')}${manifest.deferred.length ? `<p>${t('以下上下文需读取全文：', 'Full reads required: ')}${manifest.deferred.map(item => esc(item.id)).join(', ')}</p>` : ''}${manifest.overridden.length ? `<p>${t('已被更高优先级要求覆盖：', 'Overridden by higher priority guidance: ')}${manifest.overridden.map(item => esc(item.id)).join(', ')}</p>` : ''}${manifest.conflicts.length ? `<p>${t('存在待澄清的冲突', 'Conflicting guidance needs clarification')}</p>` : ''}</section>`;
      html += `<section class="ws-context-memories"><h3>${t('与这件事有关的记忆', 'Related memories')}</h3>${task.guidance ? `<article><small>${linked ? t('当前要求 · 已记住用于同类任务', 'Current direction · remembered for similar tasks') : t('当前任务的要求', 'Current task direction')}</small><p>${esc(task.guidance.text)}</p></article>` : ''}${additional.length ? additional.map(memory => `<article><small>${esc(memory.scope.entity)} · ${esc(memory.scope.deliverable)}</small><p>${esc(memory.text)}</p></article>`).join('') : linked ? '' : `<p class="ws-empty-inline">${t('还没有相关的共享记忆。', 'No related shared memories yet.')}</p>`}</section><button class="text-button ws-context-navigation" data-context-page="memory">${t('管理全部记忆', 'Manage all memories')} ${workspaceIcon('arrow', 14)}</button>`;
    }
    const body = byId('taskContextContent'), scroll = body.scrollTop;
    update('taskContextContent', html);
    body.scrollTop = scroll;
  }

  function openContext(kind, id, trigger) {
    contextPanel = { kind, id, composer: Boolean(trigger.closest('.ws-composer')) };
    contextTrigger = trigger;
    restoreContextFocus = true;
    renderContextDialog();
    if (!byId('taskContextDialog').open) byId('taskContextDialog').showModal();
  }

  byId('taskContextDialog').addEventListener('close', () => {
    const panel = contextPanel, trigger = contextTrigger;
    contextPanel = null; contextTrigger = null;
    if (!restoreContextFocus || !panel) return;
    const fallback = document.querySelector(`#taskContent ${panel.composer ? '.ws-composer' : '.ws-sources-bar'} [data-task-context="${panel.kind}"][data-task-id="${CSS.escape(panel.id)}"]`);
    (trigger?.isConnected ? trigger : fallback)?.focus({ preventScroll: true });
  });

  function summary(task) {
    if (task.preparedWork?.acceptedAt) return t('你已接受这次准备的内容', 'You accepted this preparation');
    if (task.preparedWork) return task.preparedWork.kind === 'draft' ? t('草稿已备好 · 请按目标审阅', 'Draft ready · review against your goal') : t('来源简报已备好 · 请按目标审阅', 'Source brief ready · review against your goal');
    const status = taskState(task, admissionContext());
    if (status === 'paused_by_user') return t('由你暂停，恢复后继续核对', 'Paused by you. Resume to continue checks.');
    if (status === 'failed') return task.reasoning?.detail || task.reason || t('检查连接后重新核对', 'Check the connection, then recheck.');
    if (status === 'source_disconnected') return t('重新连接来源后继续', 'Reconnect the source to continue.');
    if (status === 'result_unverified') return t('行动已发起，提供方尚未确认结果', 'An action started; its result is not yet confirmed.');
    if (status === 'verified') return task.action?.status === 'verified_simulated' ? t('本地模拟回执已核验', 'Local simulated receipt verified') : t('提供方回执已核验', 'Provider receipt verified');
    if (status === 'closed') return t('保留记录，不再跟进', 'History retained. No further checks.');
    if (status === 'needs_user' && (task.reconciliation_inconclusive || task.attestationRequest || task.action?.close === 'reconciliation_inconclusive' || task.action?.close === 'attestation_request')) return t('结果仍未确认 — 请说明它是否已经送达', 'Result still unconfirmed — say whether it arrived');
    if (status === 'needs_user' && task.status === 'ready_for_approval') return task.draft ? t('草稿已备好', 'Draft ready') : t('准备好的结果需要审阅', 'Prepared result is ready for review');
    if (status === 'needs_user' && task.management?.nextAction?.kind === 'provide_information') {
      const missingFacts = (task.assessment?.missing || []).filter(Boolean);
      return missingFacts.length ? t(`请补充：${missingFacts.join('、')}`, `Provide ${missingFacts.join(', ')}`) : t('请补充缺少的信息或来源', 'Provide the missing information or source');
    }
    if (status === 'needs_user' && (task.wait?.status === 'interrupted' || task.management?.wake?.status === 'interrupted')) return t('等待被打断，请决定下一步', 'The wait was interrupted. Choose what happens next.');
    if (status === 'needs_user') return task.management?.nextAction?.label || task.reason || t('请决定下一步', 'Choose the next step');
    if (task.guidance) return task.guidance.text;
    if (status === 'working') return t('正在关联来源并核对要求', 'Linking sources and checking requirements');
    const provider = task.sourceConnectorId || task.externalSource?.provider;
    const sourceDown = Boolean(provider && context().connections?.[provider]?.connected === false);
    if (status === 'observing' && sourceDown) return t('来源已断开，仍在观察', 'Source disconnected. Still watching.');
    if (status === 'observing' && task.mcpInvestigation?.nextStep) return `${t('建议：', 'Suggested: ')}${task.mcpInvestigation.nextStep}`;
    if (status === 'observing' && task.kind === 'external_issue') return `GitHub · ${task.externalSource.repository} #${task.externalSource.number} · ${t('跟进已分配的 issue', 'Following assigned issue')}`;
    if (status === 'observing' && task.kind === 'external_review') return `GitHub · ${task.externalSource.repository} #${task.externalSource.number} · ${t('跟进待评审的 PR', 'Following a pull request')}`;
    if (status === 'observing' && task.kind === 'external_change') return `GitHub · ${task.externalSource.repository} · ${task.externalSource.marker} · ${t('跟进仓库内容变化', 'Following a repository change')}`;
    if (status === 'observing' && task.kind === 'external_check') return `GitHub · ${task.externalSource.repository} · ${task.externalSource.marker} · ${t('跟进 GitHub Actions', 'Following a GitHub Actions run')}`;
    if (status === 'observing') return t('只读跟进，不会修改来源', 'Read-only monitoring. Source unchanged.');
    const missing = (task.evidence?.criteria || []).filter(item => item.status !== 'satisfied');
    if (missing.length) return t(`等待 ${missing.length} 项要求的证据`, `Waiting for evidence for ${missing.length} requirement${missing.length === 1 ? '' : 's'}`);
    if (task.wait?.status === 'active') return task.wait.condition?.label || t('等待已设置的触发条件', 'Waiting for the saved trigger');
    return status === 'waiting_external' ? t('来源有变化时继续核对', 'Recheck when the source changes') : t('关联来源并核对内容', 'Linking sources and checking content');
  }

  function badge(task) {
    const state = taskState(task, admissionContext());
    return `<span class="ws-state" data-state="${state}"><i aria-hidden="true"></i>${stateLabel(state)}</span>`;
  }

  function steps(task, compact = false) {
    return `<ol class="ws-path${compact ? ' compact' : ''}" aria-label="${t('执行路径', 'Execution path')}">${taskSteps(task).map((step, index) => `<li data-step-state="${step.status}"${step.status === 'current' ? ' aria-current="step"' : ''}><span class="ws-step-mark">${step.status === 'done' ? workspaceIcon('check', 11) : index + 1}</span><span>${stepLabel(step.key)}</span></li>`).join('')}</ol>`;
  }

  function sourceChips(task) {
    const sources = taskSources(task, context().state);
    const names = [...new Set(sources.map(item => ['simulation', 'simulated'].includes(String(item.provider).toLowerCase()) ? 'Simulation' : item.provider))];
    return names.map(name => `<span class="ws-source-chip">${esc(name === 'Simulation' ? t('模拟来源', 'Simulation') : name === 'Local files' ? t('本地文件', 'Local files') : name)}</span>`).join('');
  }

  function controls(task, { close = false, page = false } = {}) {
    const disabled = isFinished(task);
    const paused = task.control?.paused;
    return `<div class="ws-task-controls">${!disabled && !(page && paused) ? `<button class="icon-button" data-task-control="${paused ? 'resume' : 'pause'}" data-task-id="${esc(task.id)}" aria-label="${paused ? t('恢复任务', 'Resume task') : t('暂停任务', 'Pause task')}" title="${paused ? t('恢复任务', 'Resume task') : t('暂停任务', 'Pause task')}" ${pending.has(task.id) ? 'disabled' : ''}>${workspaceIcon(paused ? 'resume' : 'pause', 16)}</button>` : ''}${mode !== 'spotlight' && !page ? `<button class="icon-button" data-focus-task="${esc(task.id)}" aria-label="${t('专注这件事', 'Focus this task')}" title="${t('专注这件事', 'Focus this task')}">${workspaceIcon('spotlight', 16)}</button>` : ''}${close ? `<button class="icon-button" data-close-inspector aria-label="${t('收起任务', 'Collapse task')}">${workspaceIcon('close', 16)}</button>` : ''}</div>`;
  }

  function composer(task, page = false) {
    if (isFinished(task) || task.action || task.status === 'verifying') return '';
    const draft = drafts.get(task.id) || { text: '', scope: 'task' };
    const busy = pending.has(task.id);
    const inputId = `direction-${task.id}`;
    const form = `<form class="ws-composer" data-task-direction="${esc(task.id)}"><label class="sr-only" for="${esc(inputId)}">${t('纠正这件事的方向', 'Change this task’s direction')}</label><textarea id="${esc(inputId)}" name="direction" data-direction-input="${esc(task.id)}" rows="2" maxlength="2000" placeholder="${t('这件事，换个方向…', 'Steer this task…')}" required ${busy ? 'readonly' : ''}>${esc(draft.text)}</textarea><div class="ws-composer-bottom"><div class="ws-scope"><input type="hidden" name="scope" data-direction-scope="${esc(task.id)}" value="${draft.scope}"><button type="button" class="text-button ws-memory-trigger" data-task-context="memory" data-task-id="${esc(task.id)}" aria-haspopup="dialog" ${busy ? 'disabled' : ''}>${workspaceIcon('memory', 14)}${draft.scope === 'similar' ? t('记住同类', 'Remember similar') : t('仅这件事', 'This task only')}</button></div><button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${busy ? t('正在更新…', 'Updating…') : t('更新方向', 'Apply direction')}${workspaceIcon('arrow', 14)}</button></div>${errors.has(task.id) ? `<p class="ws-inline-error" role="alert">${esc(errors.get(task.id))}</p>` : ''}</form>`;
    if (!page || task.status === 'ready_for_approval' || task.preparedWork || draft.text || errors.has(task.id)) return form;
    return `<details class="ws-direction-disclosure" data-direction-disclosure data-preserve="direction-${esc(task.id)}"><summary>${t('调整方向', 'Adjust direction')}</summary>${form}</details>`;
  }

  function receipt(task) {
    if (!task.guidance || isFinished(task)) return '';
    const canUndo = !isFinished(task) && !task.action;
    const remembered = context().state.taskMemories?.some(memory => memory.id === task.guidance.memoryId && !memory.deletedAt);
    return `<div class="ws-direction-receipt" role="status"><div>${workspaceIcon('check', 15)}<span>${t('要求已更新，按新计划核对', 'Requirements updated; checking the new plan')}<small>${remembered ? t('已记住：同一项目与交付物', 'Remembered for the same project and deliverable') : t('仅当前任务 · 未保存为记忆', 'This task only · no memory saved')}</small></span></div>${canUndo ? `<button class="text-button" data-undo-direction="${esc(task.guidance.id)}" data-task-id="${esc(task.id)}" ${pending.has(task.id) ? 'disabled' : ''}>${t('撤销方向', 'Undo direction')}</button>` : ''}</div>`;
  }

  function sources(task) {
    const refs = taskSources(task, context().state);
    const artifactNames = { google: 'Gmail', microsoft: 'Outlook', notion: 'Notion', apple_notes: 'Apple Notes' };
    const artifactLabels = { queued: t('等待保存', 'Queued'), executing: t('正在保存', 'Saving'), verified: t('已保存并核验', 'Saved and verified'), unknown: t('保存结果需要核对', 'Outcome needs checking'), blocked: t('已暂停保存，请检查权限或任务变化', 'Save paused; check permissions or task changes') };
    const artifacts = (task.artifactRequests || []).slice(-5);
    const saved = artifacts.length ? `<div class="ws-artifact-records" role="status">${artifacts.map(artifact => `<p>${workspaceIcon(artifact.status === 'verified' ? 'check' : 'source', 14)} ${esc(artifactNames[artifact.connectorId] || artifact.connectorId)} · ${esc(artifactLabels[artifact.status] || artifact.status)}</p>`).join('')}</div>` : '';
    if (!refs.length && !task.mcpCalls?.length) return saved;
    const memories = scopedMemories(task);
    return `${saved}<div class="ws-sources-bar"><button class="text-button ws-source-trigger" data-task-context="sources" data-task-id="${esc(task.id)}" aria-haspopup="dialog">${workspaceIcon('source', 14)}${t('来源', 'Sources')}<span>${refs.length + (task.mcpCalls?.length || 0)}</span></button><div class="ws-source-chips">${sourceChips(task)}</div><button class="text-button ws-linked-memory" data-task-context="memory" data-task-id="${esc(task.id)}" aria-haspopup="dialog">${workspaceIcon('memory', 14)}${t('记忆', 'Memory')}${memories.length ? ` ${memories.length}` : ''}</button></div>`;
  }

  function inspector(task, { inline = false, compact = false, page = false } = {}) {
    if (!task) return '';
    const heading = compact
      ? `<header class="ws-inspector-heading ws-compact-heading"><span class="ws-compact-label">${t('任务详情', 'Task details')}</span><h2 class="sr-only" tabindex="-1">${esc(task.subject || task.request?.subjectEntity || t('待跟进的事', 'Work to follow up'))}</h2>${controls(task, { close: !page, page })}</header>`
      : `<header class="ws-inspector-heading"><div>${badge(task)}<${page ? 'h1' : 'h2'} tabindex="-1">${esc(task.subject || task.request?.subjectEntity || t('待跟进的事', 'Work to follow up'))}</${page ? 'h1' : 'h2'}></div>${controls(task, { close: !page, page })}</header><p class="ws-task-update">${esc(summary(task))}</p>`;
    return `<section class="ws-inspector${inline ? ' inline' : ''}" data-inspector-task="${esc(task.id)}" aria-label="${t('任务详情', 'Task details')}">${heading}${task.guidance && summary(task) !== task.guidance.text ? `<blockquote class="ws-direction-quote">${esc(task.guidance.text)}</blockquote>` : ''}<div class="ws-inspector-body"><div class="ws-inspector-context">${steps(task)}<div class="ws-detail-columns"><div class="ws-detail-main">${stateNotice(task)}${task.control?.paused ? `<div class="ws-paused-note">${workspaceIcon('pause', 15)}<span>${task.action ? t('已停止后续动作，已经发出的请求仍需核验。', 'Further actions stopped. Already dispatched requests still need verification.') : task.control.pauseReason === 'state_delta_uncertain' ? t('有新信息需要核对。查看后可恢复跟进。', 'New evidence is waiting. Resume after checking it.') : t('你已暂停这件事。恢复后会重新核对最新来源。', 'You paused this task. Resume to check the latest sources.')}</span><button class="text-button" data-task-control="resume" data-task-id="${esc(task.id)}">${t('恢复', 'Resume')}</button></div>` : task.preparedWork ? preparedWork(task) : renderAction(task)}${receipt(task)}${composer(task, page)}</div><div class="ws-detail-side">${checklist(task, { collapseSatisfied: page && task.status !== 'ready_for_approval' && !task.preparedWork })}${sources(task)}${timeline(task)}${page ? `<details class="ws-execution-details" data-preserve="ws-management-${esc(task.id)}"><summary>${t('跟进设置', 'Follow-up settings')}</summary>${renderManagement(task)}</details><details class="ws-execution-details" data-preserve="full-evidence-${esc(task.id)}"><summary>${t('要求与来源依据', 'Requirements and source evidence')}</summary><p class="ws-evidence-explanation">${t('原始请求的要求，以及来源中的对应内容，用来解释 Agent 为什么准备或执行下一步。', 'The original requirements and matching source excerpts explain why the agent prepared or took the next step.')}</p>${renderDetails(task)}</details>` : ''}</div></div></div></div></section>`;
  }

  // States where the visible result is not final say so first, in words.
  function stateNotice(task) {
    const status = taskState(task, admissionContext());
    if (status === 'paused_by_policy') {
      const policyId = task.activationHold?.policyIds?.[0] || '';
      return `<div class="ws-state-notice" role="status"><span><strong>${t('因规则暂停', 'Paused by a rule')}</strong>${t('修改或停用对应规则后，会重新核对来源并继续准备。', 'Update or disable the matching rule to recheck sources and continue preparation.')}</span><button type="button" class="text-button" data-open-rules="${esc(policyId)}">${t('查看这条规则', 'Open this rule')}</button></div>`;
    }
    if (status === 'needs_user' && (task.reconciliation_inconclusive || task.attestationRequest || ['reconciliation_inconclusive', 'attestation_request'].includes(task.action?.close))) return `<div class="ws-state-notice" role="status"><span><strong>${t('结果仍未确认', 'Result still unconfirmed')}</strong>${t('自动核对已经结束。请核对它是否送达，或确认这次没有发出。不会再次发送同一次尝试。', 'Automatic checks are finished. Say whether it arrived, or confirm this attempt was not sent. That attempt will not be posted again.')}</span></div>`;
    if (status === 'result_unverified') return `<div class="ws-state-notice" role="status"><span><strong>${t('结果尚未确认', 'Result not confirmed')}</strong>${t('行动已发起，提供方还没确认结果。正在自动核对，不会显示为完成。', 'The action started; the provider has not confirmed it. Automatic checks are still running, and it is not shown as done.')}</span></div>`;
    if (status === 'failed') return `<div class="ws-state-notice" data-tone="error" role="status"><span><strong>${t('处理失败', 'Failed')}</strong>${esc(task.reason || t('没有执行任何对外操作。', 'No external action was taken.'))}</span>${task.kind === 'standing_intent' ? `<button class="secondary-button" data-retry-prepared="${esc(task.id)}" ${pending.has(task.id) ? 'disabled' : ''}>${t('重试准备', 'Retry preparation')}</button>` : ''}</div>`;
    if (status === 'source_disconnected') return `<div class="ws-state-notice" data-tone="error" role="status"><span><strong>${t('来源已断开', 'Source disconnected')}</strong>${t('重新连接前，这件事不会继续更新。', 'This task will not update until the source is reconnected.')}</span></div>`;
    if (status === 'unknown') return `<div class="ws-state-notice" role="status"><span><strong>${t('状态待确认', 'State unknown')}</strong>${t('记录不足以判断当前状态，未执行对外操作。', 'The record is not enough to determine the state. No external action was taken.')}</span></div>`;
    return '';
  }

  function preparedWork(task) {
    if (!task.preparedWork) return '';
    const accepted = Boolean(task.preparedWork.acceptedAt);
    return `<section class="ws-context-memories"><h3>${accepted ? t('已接受的内容', 'Accepted preparation') : task.preparedWork.kind === 'draft' ? t('草稿 · 待审阅', 'Draft · review required') : t('来源简报 · 待审阅', 'Source brief · review required')}</h3><p>${t('请按目标核对内容与来源。', 'Review the content and sources against your goal.')}</p><pre style="white-space:pre-wrap;font:inherit">${esc(task.preparedWork.body)}</pre>${!accepted && !task.activationHold ? `<button class="primary-button" data-accept-prepared="${esc(task.id)}" ${pending.has(task.id) ? 'disabled' : ''}>${t('接受内容并结束这次跟进', 'Accept and finish this follow-up')}</button>` : ''}${errors.has(task.id) ? `<p class="ws-inline-error" role="alert">${esc(errors.get(task.id))}</p>` : ''}</section>`;
  }

  // Requirements and their evidence, visible in place: what was asked, what was
  // found and where. Missing items are never hidden behind a disclosure.
  function checklist(task, { collapseSatisfied = false } = {}) {
    const criteria = task.evidence?.criteria || [];
    if (!criteria.length) return '';
    const met = criteria.filter(item => item.status === 'satisfied').length;
    const mark = item => item.status === 'satisfied' ? 'met' : item.status === 'unverifiable' ? 'unknown' : 'missing';
    const label = { met: t('已满足', 'Met'), missing: t('缺少', 'Missing'), unknown: t('无法确认', 'Unverifiable') };
    const row = item => { const state = mark(item); const proof = item.evidence?.find(entry => entry.excerpt); return `<li data-check="${state}"><span class="ws-check-mark" aria-hidden="true">${state === 'met' ? workspaceIcon('check', 11) : state === 'missing' ? '—' : '?'}</span><span class="ws-check-copy"><strong>${esc(item.label || item.id)}</strong>${proof ? `<q>${esc(proof.excerpt)}</q>` : `<small>${label[state]}</small>`}</span></li>`; };
    const satisfied = criteria.filter(item => item.status === 'satisfied');
    const outstanding = criteria.filter(item => item.status !== 'satisfied');
    const collapse = collapseSatisfied && satisfied.length && outstanding.length;
    const visible = collapse ? outstanding : criteria;
    const completed = collapse ? `<details class="ws-satisfied-evidence" data-satisfied-evidence data-preserve="satisfied-${esc(task.id)}"><summary>${t(`已满足 ${satisfied.length} 项`, `${satisfied.length} satisfied`)}</summary><ul>${satisfied.map(row).join('')}</ul></details>` : '';
    return `<section class="ws-checklist" aria-label="${t('要求核对', 'Requirement check')}"><h3>${t('要求', 'Requirements')}<span>${met}/${criteria.length}</span></h3><ul>${visible.map(row).join('')}</ul>${completed}</section>`;
  }

  // This task's own history, newest first, so the drawer explains how the
  // current state was reached without a trip to a separate activity page.
  function timeline(task) {
    const entries = (context().state.history || []).filter(item => item.taskId === task.id);
    if (!entries.length) return '';
    const seen = new Set();
    const rows = entries.filter(item => { const key = `${item.kind}:${item.text}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 12);
    return `<section class="ws-timeline" aria-label="${t('这件事的经过', 'What happened')}"><h3>${t('经过', 'What happened')}<span>${entries.length}</span></h3><ol>${rows.map(item => `<li data-kind="${esc(item.kind)}"><time datetime="${esc(item.at)}">${esc(shortMoment(item.at))}</time><span>${esc(copy(item.text))}</span></li>`).join('')}</ol></section>`;
  }

  function recoveryCard(task) {
    return `<article class="ws-recovery-card"><div>${badge(task)}<h3>${esc(task.subject)}</h3><p>${esc(summary(task))}</p></div><div class="action-row">${renderAction(task)}<button class="text-button" data-open-task="${esc(task.id)}">${t('调整这件事', 'Adjust task')} ↗</button></div></article>`;
  }

  function sharedWaitBadge(task) {
    const shared = (task.management?.dependencies || []).filter(dep => dep.taskIds?.length > 1);
    if (!shared.length) return '';
    const dep = shared[0];
    const key = dep.condition || dep.label || 'shared-wait';
    const others = dep.taskIds.length - 1;
    const label = others === 1
      ? t('与1个任务共享等待', 'Shared wait with 1 task')
      : t(`与${others}个任务共享等待`, `Shared wait with ${others} tasks`);
    return `<button type="button" class="ws-shared-dep-badge" data-shared-dep-group="${esc(key)}" aria-pressed="false" title="${esc(dep.label || key)}">${label}</button>`;
  }

  function row(task, lanes = false) {
    const status = taskState(task, admissionContext());
    const title = task.subject || task.request?.subjectEntity || t('待跟进的事', 'Work to follow up');
    const active = task.id === selected;
    const moment = shortMoment(task.updatedAt || task.createdAt || task.action?.at);
    const depBadge = sharedWaitBadge(task);
    if (mode === 'field') {
      // A field node answers two things: what it is and what is happening now.
      const mixed = ['attention', 'quiet'].includes(stateGroup(status));
      return `<article class="ws-task-row${active ? ' selected' : ''}" data-task-card="${esc(task.id)}" data-state="${status}"><button class="ws-task-select" data-select-task="${esc(task.id)}" aria-expanded="${active}"><span class="ws-node-head"><span class="ws-status-mark" data-state="${status}" aria-hidden="true"></span><strong>${esc(title)}</strong>${mixed ? `<span class="ws-node-state" data-state="${status}">${esc(stateLabel(status))}</span>` : `<span class="sr-only">${esc(stateLabel(status))}</span>`}</span><span class="ws-node-sub">${esc(summary(task))}</span></button>${depBadge}</article>`;
    }
    return `<article class="ws-task-row${active ? ' selected' : ''}" data-task-card="${esc(task.id)}" data-state="${status}"><div class="ws-row-main"><div class="ws-row-title"><button class="ws-task-select" data-select-task="${esc(task.id)}" aria-expanded="${active}"><span class="ws-status-mark" data-state="${status}" aria-hidden="true"></span><span class="ws-row-copy"><strong>${esc(title)}</strong><span>${esc(summary(task))}</span></span></button>${depBadge}</div>${steps(task, true)}<div class="ws-row-meta">${lanes ? badge(task) : `<span class="ws-row-state" data-state="${status}">${esc(stateLabel(status))}</span>`}${sourceChips(task)}${moment ? `<time datetime="${esc(task.updatedAt || task.createdAt || '')}">${esc(moment)}</time>` : ''}</div></div></article>`;
  }

  // The order matches the field: needs you, in motion, waiting, then the quiet
  // end of the workspace. Arrow keys and page steppers use the same order.
  function orderedTasks(tasks) {
    const admission = admissionContext();
    return ['attention', 'working', 'waiting', 'quiet'].flatMap(group =>
      tasks.filter(task => stateGroup(taskState(task, admission)) === group));
  }

  function taskPage(task, tasks) {
    const order = orderedTasks(tasks);
    const index = order.findIndex(item => item.id === task.id);
    const position = index >= 0 ? t(`第 ${index + 1} / ${order.length} 件`, `${index + 1} of ${order.length}`) : '';
    const prev = index > 0 ? order[index - 1] : null;
    const next = index >= 0 && index + 1 < order.length ? order[index + 1] : null;
    const step = (delta, target, label, icon) => `<button class="icon-button ws-task-step" data-task-step="${delta}" aria-label="${esc(label)}" title="${esc(label)}" ${target ? '' : 'disabled'}>${workspaceIcon(icon, 16)}</button>`;
    return `<div class="ws-task-page"><article class="ws-detail-drawer is-page" tabindex="-1" aria-label="${t('任务详情', 'Task details')}" aria-keyshortcuts="ArrowLeft ArrowRight"><div class="ws-task-page-bar"><button class="text-button ws-task-back" data-close-inspector>${workspaceIcon('back', 14)}${t('返回工作台', 'Back to workspace')}</button><span class="ws-task-position" aria-live="polite">${esc(position)}</span><div class="ws-task-stepper" role="group" aria-label="${t('切换任务', 'Switch task')}">${step(-1, prev, t('上一个任务', 'Previous task'), 'back')}${step(1, next, t('下一个任务', 'Next task'), 'arrow')}</div></div>${inspector(task, { page: true })}</article></div>`;
  }

  function grouped(tasks) {
    // The actionable shared-wait card lives above the workspace. Task badges
    // retain the related-task highlighting without a second dependency panel.
    return ['attention', 'working', 'waiting', 'quiet'].map(group => {
      const matches = tasks.filter(task => stateGroup(taskState(task, admissionContext())) === group);
      if (!matches.length && mode !== 'field') return '';
      return `<section class="ws-task-group" data-group="${group}" data-empty="${!matches.length}"><h3><i aria-hidden="true"></i>${groupLabel(group)}<span>${matches.length}</span></h3><div>${matches.map(task => row(task)).join('') || '<p class="ws-group-empty" aria-label="' + t('暂无', 'None') + '">—</p>'}</div></section>`;
    }).join('');
  }

  function pulse(tasks, state) {
    const ids = new Set(tasks.map(item => item.id));
    const entries = activityEntries(state).filter(item => ids.has(item.taskId));
    if (!entries.some(entry => entry.id === selectedEvent && entry.taskId === selected)) selectedEvent = entries.find(entry => entry.taskId === selected)?.id || null;
    const names = {
      memory_edit: t('记忆已更新', 'Memory updated'), memory_delete: t('记忆已删除', 'Memory deleted'), memory_restore: t('记忆已恢复', 'Memory restored'),
      task_direction: t('方向已更新', 'Direction updated'), task_direction_undo: t('方向已撤销', 'Direction undone'),
      task_paused: t('你暂停了这件事', 'You paused this task'), task_resumed: t('已恢复跟进', 'Following resumed'),
      assessment: t('核对结果已更新', 'Evidence check updated'), discovery: t('发现了新的工作', 'New work discovered'),
      completion: t('结果已核验', 'Result verified'), approval: t('你批准了这次行动', 'You approved an action'),
      reasoning_failure: t('模型处理失败', 'Model request failed'), cancellation: t('已停止跟进', 'Stopped following'),
      preparation: t('回复已准备好', 'Draft prepared'), verified: t('结果已核验', 'Result verified')
    };
    return `<div class="ws-pulse-feed"><div class="ws-pulse-heading"><h2>${t('发生的变化', 'Changes')}</h2><span>${entries.length} ${t('条记录', 'updates')}</span></div>${entries.length ? entries.map(entry => { const item = tasks.find(item => item.id === entry.taskId); return `<button class="ws-pulse-event${entry.id === selectedEvent ? ' selected' : ''}" data-select-task="${esc(entry.taskId)}" data-select-event="${esc(entry.id)}"><time datetime="${esc(entry.at)}">${esc(formatTime(entry.at))}</time><span class="ws-pulse-spine" aria-hidden="true"><i></i></span><span class="ws-pulse-copy"><strong>${esc(names[entry.kind] || entry.text || entry.detail || t('任务已更新', 'Task updated'))}</strong><span>${esc(item.subject)}</span></span></button>`; }).join('') : `<p class="ws-empty-inline">${t('还没有任务变化。新记录会留在这里。', 'No task changes yet. New updates will appear here.')}</p>`}</div>`;
  }

  function render({ tasks, emptyHTML, allTasks = tasks }) {
    if (composing) return;
    lastRender = { tasks, emptyHTML, allTasks };
    const ctx = context();
    if (workspace !== ctx.workspace) { workspace = ctx.workspace; selected = null; drafts.clear(); errors.clear(); }
    if (selected && !allTasks.some(task => task.id === selected)) selected = null;
    const task = tasks.find(item => item.id === selected);
    const storedMode = readLocal('unprompted:workspace-default', 'field');
    const defaultMode = WORKSPACE_MODES.includes(storedMode) ? storedMode : 'field';
    update('workspaceViewOptions', WORKSPACE_MODES.map(item => `<option value="${item}"${defaultMode === item ? ' selected' : ''}>${modeLabel(item)}${item === 'field' ? t(' · 默认', ' · default') : ''}</option>`).join(''));
    byId('currentWorkspaceView').textContent = modeLabel(mode);
    const filter = byId('taskStatusFilter');
    if (filter) filter.value = context().filter || 'all';
    byId('taskContent').dataset.mode = mode;
    byId('taskContent').dataset.taskCount = String(tasks.length);
    if (!byId('viewHome').hidden) byId('pageCrumb').textContent = task ? t('任务详情', 'Task details') : t('工作台', 'Overview');
    byId('viewHome').querySelector('.home-heading').hidden = Boolean(task);
    let html = '';
    if (!tasks.length) html = emptyHTML;
    else if (task) html = taskPage(task, tasks);
    else if (mode === 'field') html = `<div class="ws-field">${grouped(tasks)}</div>`;
    else if (mode === 'index') html = `<div class="ws-index">${grouped(tasks)}</div>`;
    else if (mode === 'lanes') html = `<div class="ws-lanes"><div class="ws-lanes-header"><span>${t('任务', 'Task')}</span><span>${t('执行路径', 'Execution path')}</span><span>${t('状态', 'State')}</span></div>${tasks.map(task => row(task, true)).join('')}</div>`;
    else if (mode === 'spotlight') html = `<div class="ws-focus"><button class="text-button ws-back" data-workspace-return>${workspaceIcon('back', 14)}${t('回到工作台', 'Back to workspace')}</button><div class="ws-focus-index">${grouped(tasks)}</div></div>`;
    else html = `<div class="ws-pulse">${pulse(tasks, ctx.state)}</div>`;
    update('taskContent', html);
    update('workspaceSuggestion', '');
    renderContextDialog();
    appearance.refresh();
  }

  function select(id, { focus = false, toggle = true } = {}) {
    selected = toggle && selected === id ? null : id;
    if (lastRender) render(lastRender);
    if (focus) {
      const drawer = byId('taskContent').querySelector('.ws-detail-drawer');
      if (drawer) {
        drawer.tabIndex = -1;
        drawer.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: 'auto' });
      } else byId('taskContent').querySelector('.ws-inspector h2')?.focus({ preventScroll: true });
    }
  }

  // ← and → move between the cards in the same order the workspace shows
  // them, without returning to the overview.
  function stepTask(delta, { focus = true } = {}) {
    const order = orderedTasks(lastRender?.tasks || []);
    const index = order.findIndex(item => item.id === selected);
    const next = order[index + delta];
    if (!next) return false;
    select(next.id, { toggle: false, focus });
    return true;
  }

  const needsIds = () => [...new Set([...byId('taskContent').querySelectorAll('[data-task-card]')].filter(row => stateGroup(row.dataset.state) === 'attention').map(row => row.dataset.taskCard))];
  function queueIds() { return needsIds(); }
  function selection() { return selected; }

  function focusDecision(id) {
    select(id, { focus: true, toggle: false });
    return true;
  }

  // The status button always opens the first remaining item. N uses openRelative.
  function openFirstDecision() {
    const ids = needsIds();
    if (!ids.length) return false;
    return focusDecision(ids[0]);
  }

  function openAfter(before, finishedId) {
    const next = nextQueueId(before, needsIds(), finishedId);
    if (!next) return false;
    return focusDecision(next);
  }

  // N moves to the following item and stays on the last one. It does not wrap.
  function openRelative(currentId) {
    const ids = needsIds();
    if (!ids.length) return false;
    const index = currentId == null ? -1 : ids.indexOf(currentId);
    if (index >= 0 && index + 1 < ids.length) return focusDecision(ids[index + 1]);
    if (index >= 0) return focusDecision(ids[index]);
    return focusDecision(ids[0]);
  }

  function setMode(next, { persist = true } = {}) {
    if (!WORKSPACE_MODES.includes(next)) return;
    if (next === 'spotlight' && mode !== 'spotlight') returnMode = mode;
    mode = next;
    if (persist) writeLocal('unprompted:workspace-default', mode);
    if (lastRender) render(lastRender);
  }

  async function command(taskId, operation, payload = {}, advanceQueue = false) {
    if (pending.has(taskId)) return;
    const before = advanceQueue ? queueIds() : null;
    pending.add(taskId); errors.delete(taskId);
    refresh();
    let advance = false;
    try {
      const result = await post(`/api/tasks/${encodeURIComponent(taskId)}/${operation}`, payload);
      if (operation === 'direction') drafts.delete(taskId);
      applyState(result.state);
      advance = advanceQueue;
      notify(operation === 'prepared-work/accept' ? t('已接受内容，本次跟进已结束', 'Preparation accepted; this follow-up is complete') : operation === 'prepared-work/retry' ? t('正在重新准备内容', 'Retrying preparation') : operation === 'pause' ? t('已暂停', 'Task paused') : operation === 'resume' ? t('已恢复，正在核对最新来源', 'Resumed; checking the latest sources') : operation === 'undo-direction' ? t('已恢复之前的要求', 'Previous requirements restored') : t('要求已更新，尚未执行对外操作', 'Requirements updated. No external action taken.'));
    } catch (error) { errors.set(taskId, copy(error.message)); notify(error.message, true); }
    finally {
      pending.delete(taskId);
      refresh();
      if (advance) openAfter(before, taskId);
    }
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.retryPrepared) { const task = context().state.tasks.find(item => item.id === target.dataset.retryPrepared); if (task) void command(task.id, 'prepared-work/retry', { inputVersion: task.inputVersion }); return; }
    if (target.dataset.acceptPrepared) { const task = context().state.tasks.find(item => item.id === target.dataset.acceptPrepared); if (task) void command(task.id, 'prepared-work/accept', { reviewToken: task.preparedWorkReviewToken }, Boolean(target.closest('#taskContent'))); return; }
    if (target.dataset.sharedDepGroup) {
      const groupKey = target.dataset.sharedDepGroup;
      const badges = [...document.querySelectorAll(`#taskContent [data-shared-dep-group="${CSS.escape(groupKey)}"]`)];
      const rows = badges.map(badge => badge.closest('.ws-task-row')).filter(Boolean);
      const already = rows.length > 0 && rows.every(row => row.classList.contains('is-dep-highlighted'));
      document.querySelectorAll('#taskContent .ws-task-row.is-dep-highlighted').forEach(row => row.classList.remove('is-dep-highlighted'));
      document.querySelectorAll('#taskContent .ws-shared-dep-badge').forEach(badge => badge.setAttribute('aria-pressed', 'false'));
      if (!already) {
        rows.forEach(row => row.classList.add('is-dep-highlighted'));
        badges.forEach(badge => badge.setAttribute('aria-pressed', 'true'));
      }
      event.preventDefault();
      event.stopPropagation();
    } else if (target.dataset.taskContext) openContext(target.dataset.taskContext, target.dataset.taskId, target);
    else if (target.hasAttribute('data-context-close')) byId('taskContextDialog').close();
    else if (target.dataset.memoryScope && contextPanel) {
      const taskId = contextPanel.id;
      const original = drafts.get(taskId) || { text: '', scope: 'task' };
      drafts.set(taskId, { ...original, scope: target.dataset.memoryScope, operation: target.dataset.memoryScope === 'similar' ? 'append' : original.operation || 'append' });
      refresh();
      byId('taskContextDialog').close();
    } else if (target.dataset.contextPage) {
      restoreContextFocus = false;
      byId('taskContextDialog').close();
      go(target.dataset.contextPage);
    } else if (target.dataset.workspaceMode) setMode(target.dataset.workspaceMode);
    else if (target.dataset.taskStep) { event.preventDefault(); stepTask(Number(target.dataset.taskStep)); }
    else if (target.dataset.selectTask) { selectedEvent = target.dataset.selectEvent || null; select(target.dataset.selectTask, { focus: true, toggle: !target.dataset.selectEvent }); }
    else if (target.dataset.focusTask) { selected = target.dataset.focusTask; setMode('spotlight', { persist: false }); }
    else if (target.hasAttribute('data-workspace-return')) setMode(returnMode, { persist: false });
    else if (target.hasAttribute('data-close-inspector')) { const previous = selected; selected = null; byId('taskContent').dataset.collapsed = 'true'; if (lastRender) render(lastRender); byId('taskContent').querySelector(`[data-select-task="${CSS.escape(previous)}"]`)?.focus({ preventScroll: true }); }
    else if (target.dataset.taskControl) void command(target.dataset.taskId, target.dataset.taskControl);
    else if (target.dataset.undoDirection) void command(target.dataset.taskId, 'undo-direction', { id: target.dataset.undoDirection });
  });
  // Keep drafts in memory, but let the browser warn before discarding them.
  window.addEventListener('beforeunload', event => {
    if ([...drafts.values()].some(draft => draft.text?.trim())) event.preventDefault();
  });
  document.addEventListener('input', event => {
    const id = event.target.dataset.directionInput;
    if (id) {
      drafts.set(id, { ...drafts.get(id), text: event.target.value, scope: event.target.closest('form').elements.scope.value });
      // Live rendering preserves the draft and caret through the same state map.
      for (const input of document.querySelectorAll('[data-direction-input]')) {
        if (input !== event.target && input.dataset.directionInput === id) input.value = event.target.value;
      }
    }
  });
  document.addEventListener('change', event => {
    if (event.target.dataset.directionOperation) { const id = event.target.dataset.directionOperation; drafts.set(id, { text: '', scope: 'task', ...drafts.get(id), operation: event.target.value }); return; }
    if (event.target.id === 'workspaceViewOptions') { setMode(event.target.value); return; }
  });
  document.addEventListener('submit', event => {
    const direction = event.target.dataset.taskDirection;
    if (!direction) return;
    event.preventDefault();
    void command(direction, 'direction', { text: event.target.elements.direction.value, scope: event.target.elements.scope.value, operation: drafts.get(direction)?.operation || 'append' });
  });
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !document.querySelector('dialog[open]') && !document.querySelector('.evidence-peek:not([hidden])')) {
      const close = byId('taskContent').querySelector('[data-close-inspector]');
      if (close && !byId('viewHome').hidden) { event.preventDefault(); close.click(); }
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[1-5]$/.test(event.code) && !event.target.closest('input,textarea,select,[contenteditable="true"]')) {
      event.preventDefault(); go('home'); setMode(WORKSPACE_MODES[Number(event.code.slice(-1)) - 1]);
    }
    // On an open task page, ← and → move between cards without leaving it.
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && selected && !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && !byId('viewHome').hidden && byId('taskContent').querySelector('.ws-task-page') && !document.querySelector('dialog[open]') && !document.querySelector('.evidence-peek:not([hidden])') && !event.target.closest('input,textarea,select,[contenteditable="true"]')) {
      event.preventDefault();
      stepTask(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    // J/K step through tasks that need the user, in on-screen order. Only an
    // explicit keypress moves the selection; updates never do.
    if (['j', 'k'].includes(event.key.toLowerCase()) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && !byId('viewHome').hidden && !document.querySelector('dialog[open]') && !event.target.closest('input,textarea,select,[contenteditable="true"]')) {
      const ids = needsIds();
      if (ids.length) {
        event.preventDefault();
        const index = ids.indexOf(selected);
        const next = index < 0 ? (event.key.toLowerCase() === 'j' ? 0 : ids.length - 1) : Math.max(0, Math.min(index + (event.key.toLowerCase() === 'j' ? 1 : -1), ids.length - 1));
        select(ids[next], { focus: true, toggle: false });
        byId('taskContent').querySelector(`[data-task-card="${CSS.escape(ids[next])}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && event.target.dataset.directionInput && !event.isComposing) {
      event.preventDefault(); event.target.closest('form').requestSubmit();
    }
  });
  return { render, select, stepTask, openFirstDecision, openAfter, openRelative, queueIds, selection, setMode, inspector, recoveryCard, getMode: () => mode };
}
