import { copy, getLocale, formatTime } from './i18n.js';
import { readLocal, writeLocal } from './ux-state.js';
import { createAppearance } from './appearance.js';
import { WORKSPACE_MODES, taskState, stateGroup, isFinished, taskSources, taskSteps, activityEntries } from './workspace-model.js';

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
  needs_user: t('待你确认', 'Awaiting review'), working: t('正在处理', 'Working'), waiting_external: t('等待外部变化', 'Waiting externally'),
  observing: t('观察中', 'Observing'), paused_by_user: t('已暂停', 'Paused'), source_disconnected: t('来源已断开', 'Source disconnected'),
  failed: t('处理失败', 'Failed'), result_unverified: t('结果待核实', 'Result unverified'), verified: t('已核验', 'Verified'),
  closed: t('已停止跟进', 'Stopped following'), unknown: t('状态待确认', 'State unknown')
})[state];
const groupLabel = group => ({ attention: t('待你处理', 'To review'), working: t('正在处理', 'In progress'), waiting: t('等待回复或资料', 'Waiting for input'), quiet: t('其他事项', 'Other tasks') })[group];
const stepLabel = key => ({ source: t('读取来源', 'Read sources'), evidence: t('核对要求', 'Check requirements'), prepare: t('准备结果', 'Prepare result'), verify: t('核实结果', 'Verify result'), verified: t('结果已核验', 'Result verified'), observe: t('跟进来源状态', 'Observe source state'), source_change: t('等待来源变化', 'Wait for a change') })[key];
const safeURL = value => { try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };

export function createWorkspace({ context, update, post, applyState, notify, renderAction, renderManagement, renderDetails, go, refresh }) {
  let mode = readLocal('unprompted:workspace-default', 'field');
  if (!WORKSPACE_MODES.includes(mode)) mode = 'field';
  const appearance = createAppearance({ icon: workspaceIcon });
  let selected = null, selectedEvent = null, workspace = null, lastRender = null, composing = false;
  let returnMode = mode === 'spotlight' ? 'field' : mode;
  const drafts = new Map(), pending = new Set(), errors = new Map();
  let editingMemory = null;
  let memoryQuery = '';
  let memoryScope = 'all';
  let memoryView = readLocal('unprompted:memory-view', 'space');
  if (!['space', 'library'].includes(memoryView)) memoryView = 'space';
  let selectedMemoryScope = 'all';
  let contextPanel = null, contextTrigger = null, restoreContextFocus = true;
  const byId = id => document.getElementById(id);

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
      const linked = memories.find(memory => memory.id === task.guidance?.memoryId && memory.text === task.guidance?.text);
      const additional = memories.filter(memory => memory.id !== linked?.id);
      html += `<section class="ws-context-memories"><h3>${t('与这件事有关的记忆', 'Related memories')}</h3>${task.guidance ? `<article><small>${linked ? t('当前要求 · 已记住用于同类任务', 'Current direction · remembered for similar tasks') : t('当前任务的要求', 'Current task direction')}</small><p>${esc(task.guidance.text)}</p></article>` : ''}${additional.length ? additional.map(memory => `<article><small>${esc(memory.scope.entity)} · ${esc(memory.scope.deliverable)}</small><p>${esc(memory.text)}</p></article>`).join('') : linked ? '' : `<p class="ws-empty-inline">${t('还没有相关的共享记忆。', 'No related shared memories yet.')}</p>`}</section><button class="text-button ws-context-navigation" data-context-page="memory">${t('管理全部记忆', 'Manage all memories')} ${workspaceIcon('arrow', 14)}</button>`;
    }
    const body = byId('taskContextContent'), scroll = body.scrollTop;
    update('taskContextContent', html);
    body.scrollTop = scroll;
  }

  function openContext(kind, id, trigger) {
    contextPanel = { kind, id, record: Boolean(trigger.closest('#taskDialog')), composer: Boolean(trigger.closest('.ws-composer')) };
    contextTrigger = trigger;
    restoreContextFocus = true;
    renderContextDialog();
    if (!byId('taskContextDialog').open) byId('taskContextDialog').showModal();
  }

  byId('taskContextDialog').addEventListener('close', () => {
    const panel = contextPanel, trigger = contextTrigger;
    contextPanel = null; contextTrigger = null;
    if (!restoreContextFocus || !panel) return;
    const fallback = document.querySelector(`${panel.record ? '#taskDialog' : '#taskContent'} ${panel.composer ? '.ws-composer' : '.ws-sources-bar'} [data-task-context="${panel.kind}"][data-task-id="${CSS.escape(panel.id)}"]`);
    (trigger?.isConnected ? trigger : fallback)?.focus({ preventScroll: true });
  });

  function summary(task) {
    const status = taskState(task, context().connections);
    if (status === 'paused_by_user') return t('由你暂停，恢复后继续核对', 'Paused by you. Resume to continue checks.');
    if (status === 'failed') return task.reasoning?.detail || task.reason || t('检查连接后重新核对', 'Check the connection, then recheck.');
    if (status === 'source_disconnected') return t('重新连接来源后继续', 'Reconnect the source to continue.');
    if (status === 'result_unverified') return t('行动已发起，提供方尚未确认结果', 'An action started; its result is not yet confirmed.');
    if (status === 'verified') return task.action?.status === 'verified_simulated' ? t('本地模拟回执已核验', 'Local simulated receipt verified') : t('提供方回执已核验', 'Provider receipt verified');
    if (status === 'closed') return t('保留记录，不再跟进', 'History retained. No further checks.');
    if (status === 'needs_user') return task.draft ? t('回复草稿已备好 · 点击审阅', 'Draft ready · review reply') : task.reason || t('点击查看待确认事项', 'Open to review the next step');
    if (task.guidance) return task.guidance.text;
    if (status === 'working') return t('正在关联来源并核对要求', 'Linking sources and checking requirements');
    if (status === 'observing' && task.mcpInvestigation?.nextStep) return `${t('建议：', 'Suggested: ')}${task.mcpInvestigation.nextStep}`;
    if (status === 'observing' && task.kind === 'external_issue') return `GitHub · ${task.externalSource.repository} #${task.externalSource.number} · ${t('跟进已分配的 issue', 'Following assigned issue')}`;
    if (status === 'observing' && task.kind === 'external_review') return `GitHub · ${task.externalSource.repository} #${task.externalSource.number} · ${t('跟进需要你处理的 PR', 'Following a pull request that needs you')}`;
    if (status === 'observing' && task.kind === 'external_change') return `GitHub · ${task.externalSource.repository} · ${task.externalSource.marker} · ${t('跟进仓库内容变化', 'Following a repository change')}`;
    if (status === 'observing' && task.kind === 'external_check') return `GitHub · ${task.externalSource.repository} · ${task.externalSource.marker} · ${t('跟进 GitHub Actions', 'Following a GitHub Actions run')}`;
    if (status === 'observing') return t('只读跟进，不会修改来源', 'Read-only monitoring. Source unchanged.');
    const missing = (task.evidence?.criteria || []).filter(item => item.status !== 'satisfied');
    if (missing.length) return t(`等待 ${missing.length} 项要求的证据`, `Waiting for evidence for ${missing.length} requirement${missing.length === 1 ? '' : 's'}`);
    if (task.wait?.status === 'active') return task.wait.condition?.label || t('等待已设置的触发条件', 'Waiting for the saved trigger');
    return status === 'waiting_external' ? t('来源有变化时继续核对', 'Recheck when the source changes') : t('关联来源并核对内容', 'Linking sources and checking content');
  }

  function badge(task) {
    const state = taskState(task, context().connections);
    return `<span class="ws-state" data-state="${state}"><i aria-hidden="true"></i>${stateLabel(state)}</span>`;
  }

  function steps(task, compact = false) {
    return `<ol class="ws-path${compact ? ' compact' : ''}" aria-label="${t('执行路径', 'Execution path')}">${taskSteps(task).map((step, index) => `<li data-step-state="${step.status}"${step.status === 'current' ? ' aria-current="step"' : ''}><span class="ws-step-mark">${step.status === 'done' ? workspaceIcon('check', 11) : index + 1}</span><span>${stepLabel(step.key)}</span></li>`).join('')}</ol>`;
  }

  function sourceChips(task) {
    const sources = taskSources(task, context().state);
    const names = [...new Set(sources.map(item => item.provider))];
    return names.map(name => `<span class="ws-source-chip">${esc(name === 'Simulation' ? t('模拟来源', 'Simulation') : name === 'Local files' ? t('本地文件', 'Local files') : name)}</span>`).join('');
  }

  function controls(task, { close = false, record = false } = {}) {
    const disabled = isFinished(task);
    const paused = task.control?.paused;
    return `<div class="ws-task-controls">${!disabled ? `<button class="icon-button" data-task-control="${paused ? 'resume' : 'pause'}" data-task-id="${esc(task.id)}" aria-label="${paused ? t('恢复任务', 'Resume task') : t('暂停任务', 'Pause task')}" title="${paused ? t('恢复任务', 'Resume task') : t('暂停任务', 'Pause task')}" ${pending.has(task.id) ? 'disabled' : ''}>${workspaceIcon(paused ? 'resume' : 'pause', 16)}</button>` : ''}${!record ? `<button class="icon-button" data-open-task="${esc(task.id)}" aria-label="${t('完整记录与等待设置', 'Full history and wait settings')}" title="${t('完整记录与等待设置', 'Full history and wait settings')}">${workspaceIcon('source', 16)}</button>` : ''}${mode !== 'spotlight' && !record ? `<button class="icon-button" data-focus-task="${esc(task.id)}" aria-label="${t('专注这件事', 'Focus this task')}" title="${t('专注这件事', 'Focus this task')}">${workspaceIcon('spotlight', 16)}</button>` : ''}${close ? `<button class="icon-button" data-close-inspector aria-label="${t('收起任务', 'Collapse task')}">${workspaceIcon('close', 16)}</button>` : ''}</div>`;
  }

  function composer(task, record = false) {
    if (isFinished(task) || task.action || task.status === 'verifying') return '';
    const draft = drafts.get(task.id) || { text: '', scope: 'task' };
    const busy = pending.has(task.id);
    const inputId = `direction-${task.id}${record ? '-record' : ''}`;
    return `<form class="ws-composer" data-task-direction="${esc(task.id)}"><label class="sr-only" for="${esc(inputId)}">${t('纠正这件事的方向', 'Change this task’s direction')}</label><textarea id="${esc(inputId)}" name="direction" data-direction-input="${esc(task.id)}" rows="2" maxlength="2000" placeholder="${t('这件事，换个方向…', 'Steer this task…')}" required ${busy ? 'readonly' : ''}>${esc(draft.text)}</textarea><div class="ws-composer-bottom"><div class="ws-scope"><input type="hidden" name="scope" data-direction-scope="${esc(task.id)}" value="${draft.scope}"><button type="button" class="text-button ws-memory-trigger" data-task-context="memory" data-task-id="${esc(task.id)}" aria-haspopup="dialog" ${busy ? 'disabled' : ''}>${workspaceIcon('memory', 14)}${draft.scope === 'similar' ? t('记住同类', 'Remember similar') : t('仅这件事', 'This task only')}</button></div><button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${busy ? t('正在更新…', 'Updating…') : t('更新方向', 'Apply direction')}${workspaceIcon('arrow', 14)}</button></div>${errors.has(task.id) ? `<p class="ws-inline-error" role="alert">${esc(errors.get(task.id))}</p>` : ''}</form>`;
  }

  function receipt(task) {
    if (!task.guidance || isFinished(task)) return '';
    const canUndo = !isFinished(task) && !task.action;
    const remembered = context().state.taskMemories?.some(memory => memory.id === task.guidance.memoryId && !memory.deletedAt);
    return `<div class="ws-direction-receipt" role="status"><div>${workspaceIcon('check', 15)}<span>${t('要求已更新，按新计划核对', 'Requirements updated; checking the new plan')}<small>${remembered ? t('已记住：同一项目与交付物', 'Remembered for the same project and deliverable') : t('仅当前任务 · 未保存为记忆', 'This task only · no memory saved')}</small></span></div>${canUndo ? `<button class="text-button" data-undo-direction="${esc(task.guidance.id)}" data-task-id="${esc(task.id)}" ${pending.has(task.id) ? 'disabled' : ''}>${t('撤销', 'Undo')}</button>` : ''}</div>`;
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

  function inspector(task, { record = false, inline = false, compact = false } = {}) {
    if (!task) return '';
    const heading = compact
      ? `<header class="ws-inspector-heading ws-compact-heading"><span class="ws-compact-label">${t('任务详情', 'Task details')}</span><h2 class="sr-only" tabindex="-1">${esc(task.subject || task.request?.subjectEntity || t('待跟进的事', 'Work to follow up'))}</h2>${controls(task, { close: !record, record })}</header>`
      : `<header class="ws-inspector-heading"><div>${badge(task)}<h2 tabindex="-1">${esc(task.subject || task.request?.subjectEntity || t('待跟进的事', 'Work to follow up'))}</h2></div>${controls(task, { close: !record, record })}</header><p class="ws-task-update">${esc(summary(task))}</p>`;
    return `<section class="ws-inspector${inline ? ' inline' : ''}" data-inspector-task="${esc(task.id)}" aria-label="${t('任务详情', 'Task details')}">${heading}${task.guidance && summary(task) !== task.guidance.text ? `<blockquote class="ws-direction-quote">${esc(task.guidance.text)}</blockquote>` : ''}<div class="ws-inspector-body"><div class="ws-inspector-context">${steps(task)}${task.control?.paused ? `<div class="ws-paused-note">${workspaceIcon('pause', 15)}<span>${task.action ? t('已停止后续动作，已经发出的请求仍需核验。', 'Further actions stopped. Already dispatched requests still need verification.') : task.control.pauseReason === 'state_delta_uncertain' ? t('新信息需要你核对。查看后可恢复跟进。', 'New evidence needs your review. Resume after checking it.') : t('你已暂停这件事。恢复后会重新核对最新来源。', 'You paused this task. Resume to check the latest sources.')}</span><button class="text-button" data-task-control="resume" data-task-id="${esc(task.id)}">${t('恢复', 'Resume')}</button></div>` : renderAction(task)}${receipt(task)}${checklist(task)}${sources(task)}${timeline(task)}${record ? `<details class="ws-execution-details" data-preserve="ws-management-${esc(task.id)}" open><summary>${t('跟进设置', 'Follow-up settings')}</summary>${renderManagement(task)}</details><details class="ws-execution-details" data-preserve="full-evidence-${esc(task.id)}"><summary>${t('完整来源、证据与行动记录', 'Full sources, evidence and action history')}</summary>${renderDetails(task)}</details>` : `<div class="ws-detail-links">${task.evidence?.criteria?.length ? `<button class="text-button" data-proof="${esc(task.id)}">${t('核对依据', 'Check evidence')} ↗</button>` : ''}<button class="text-button" data-open-task="${esc(task.id)}">${t('记录与跟进设置', 'History & follow-up settings')} ↗</button></div>`}</div>${composer(task, record)}</div></section>`;
  }

  // Requirements and their evidence, visible in place: what was asked, what was
  // found and where. Missing items are never hidden behind a disclosure.
  function checklist(task) {
    const criteria = task.evidence?.criteria || [];
    if (!criteria.length) return '';
    const met = criteria.filter(item => item.status === 'satisfied').length;
    const mark = item => item.status === 'satisfied' ? 'met' : item.status === 'unverifiable' ? 'unknown' : 'missing';
    const label = { met: t('已满足', 'Met'), missing: t('缺少', 'Missing'), unknown: t('无法确认', 'Unverifiable') };
    return `<section class="ws-checklist" aria-label="${t('要求核对', 'Requirement check')}"><h3>${t('要求', 'Requirements')}<span>${met}/${criteria.length}</span></h3><ul>${criteria.map(item => { const state = mark(item); const proof = item.evidence?.find(entry => entry.excerpt); return `<li data-check="${state}"><span class="ws-check-mark" aria-hidden="true">${state === 'met' ? workspaceIcon('check', 11) : state === 'missing' ? '—' : '?'}</span><span class="ws-check-copy"><strong>${esc(item.label || item.id)}</strong>${proof ? `<q>${esc(proof.excerpt)}</q>` : `<small>${label[state]}</small>`}</span></li>`; }).join('')}</ul></section>`;
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

  function row(task, lanes = false) {
    const status = taskState(task, context().connections);
    const title = task.subject || task.request?.subjectEntity || t('待跟进的事', 'Work to follow up');
    const active = task.id === selected;
    const moment = shortMoment(task.updatedAt || task.createdAt || task.action?.at);
    // One row answers: what, which state, what changed or comes next, where it came from.
    return `<article class="ws-task-row${active ? ' selected' : ''}" data-task-card="${esc(task.id)}" data-state="${status}"><div class="ws-row-main"><button class="ws-task-select" data-select-task="${esc(task.id)}" aria-expanded="${active}"><span class="ws-status-mark" data-state="${status}" aria-hidden="true"></span><span class="ws-row-copy"><strong>${esc(title)}</strong><span>${esc(summary(task))}</span></span></button>${steps(task, true)}<div class="ws-row-meta">${lanes ? badge(task) : `<span class="ws-row-state" data-state="${status}">${esc(stateLabel(status))}</span>`}${sourceChips(task)}${moment ? `<time datetime="${esc(task.updatedAt || task.createdAt || '')}">${esc(moment)}</time>` : ''}</div></div></article>`;
  }

  function grouped(tasks) {
    return ['attention', 'working', 'waiting', 'quiet'].map(group => {
      const matches = tasks.filter(task => stateGroup(taskState(task, context().connections)) === group);
      // Empty groups are omitted; the status line already reports zero counts.
      if (!matches.length) return '';
      return `<section class="ws-task-group" data-group="${group}"><h3><i aria-hidden="true"></i>${groupLabel(group)}<span>${matches.length}</span></h3><div>${matches.map(task => row(task)).join('')}</div></section>`;
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
    if (workspace !== ctx.workspace) { workspace = ctx.workspace; selected = null; selectedMemoryScope = 'all'; editingMemory = null; drafts.clear(); errors.clear(); }
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
    let html = '';
    if (!tasks.length) html = emptyHTML;
    else if (mode === 'field') html = `<div class="ws-workbench"><div class="ws-workbench-list"><div class="ws-field">${grouped(tasks)}</div></div></div>`;
    else if (mode === 'index') html = `<div class="ws-index">${grouped(tasks)}</div>`;
    else if (mode === 'lanes') html = `<div class="ws-lanes"><div class="ws-lanes-header"><span>${t('任务', 'Task')}</span><span>${t('执行路径', 'Execution path')}</span><span>${t('状态', 'State')}</span></div>${tasks.map(task => row(task, true)).join('')}</div>`;
    else if (mode === 'spotlight') html = `<div class="ws-focus"><button class="text-button ws-back" data-workspace-return>${workspaceIcon('back', 14)}${t('回到工作台', 'Back to workspace')}</button>${task ? inspector(task) : `<div class="ws-focus-index">${grouped(tasks)}</div>`}${task && tasks.length > 1 ? `<div class="ws-other-tasks"><span>${t('其他任务', 'Other tasks')}</span><div>${tasks.filter(item => item.id !== selected).map(item => `<button data-select-task="${esc(item.id)}">${badge(item)}<strong>${esc(item.subject)}</strong>${workspaceIcon('arrow', 12)}</button>`).join('')}</div></div>` : ''}</div>`;
    else html = `<div class="ws-pulse">${pulse(tasks, ctx.state)}</div>`;
    if (task && mode !== 'spotlight') html += `<aside class="ws-detail-drawer" aria-label="${t('任务详情', 'Task details')}">${inspector(task)}</aside>`;
    update('taskContent', html);
    update('workspaceSuggestion', '');
    renderMemories();
    renderContextDialog();
    appearance.refresh();
  }

  function select(id, { focus = false, toggle = true } = {}) {
    selected = toggle && selected === id ? null : id;
    if (lastRender) render(lastRender);
    if (focus) byId('taskContent').querySelector('.ws-inspector h2')?.focus({ preventScroll: true });
  }

  function setMode(next, { persist = true } = {}) {
    if (!WORKSPACE_MODES.includes(next)) return;
    if (next === 'spotlight' && mode !== 'spotlight') returnMode = mode;
    mode = next;
    if (persist) writeLocal('unprompted:workspace-default', mode);
    if (lastRender) render(lastRender);
  }

  async function command(taskId, operation, payload = {}) {
    if (pending.has(taskId)) return;
    pending.add(taskId); errors.delete(taskId);
    refresh();
    try {
      const result = await post(`/api/tasks/${encodeURIComponent(taskId)}/${operation}`, payload);
      if (operation === 'direction') drafts.delete(taskId);
      applyState(result.state);
      notify(operation === 'pause' ? t('已暂停', 'Task paused') : operation === 'resume' ? t('已恢复，正在核对最新来源', 'Resumed; checking the latest sources') : operation === 'undo-direction' ? t('已恢复之前的要求', 'Previous requirements restored') : t('要求已更新，尚未执行对外操作', 'Requirements updated. No external action taken.'));
    } catch (error) { errors.set(taskId, copy(error.message)); notify(error.message, true); }
    finally { pending.delete(taskId); refresh(); }
  }

  function renderMemories() {
    const state = context().state;
    if (!state) return;
    const memories = state.taskMemories || [];
    const active = memories.filter(memory => !memory.deletedAt);
    const deleted = memories.filter(memory => memory.deletedAt);
    const scopes = [...new Set(active.map(memory => memory.scope?.entity).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (memoryScope !== 'all' && !scopes.includes(memoryScope)) memoryScope = 'all';
    const query = memoryQuery.trim().toLocaleLowerCase();
    const visible = active.filter(memory => (memoryScope === 'all' || memory.scope?.entity === memoryScope) &&
      (!query || [memory.text, memory.scope?.entity, memory.scope?.deliverable].join(' ').toLocaleLowerCase().includes(query)));
    const groups = new Map();
    for (const memory of visible) {
      const entity = memory.scope?.entity || t('未指定范围', 'Unscoped');
      if (!groups.has(entity)) groups.set(entity, []);
      groups.get(entity).push(memory);
    }
    const scopeEntries = [...groups.entries()];
    const focusedScope = selectedMemoryScope !== 'all' && groups.has(selectedMemoryScope) ? selectedMemoryScope : null;
    const focusedMemories = focusedScope ? groups.get(focusedScope) || [] : [];

    const memoryAction = (memory, operation, icon, label, { danger = false, forget = false } = {}) => {
      const labelled = memoryView === 'library';
      const attrs = forget
        ? `data-forget-kind="task_memory" data-forget-id="${esc(memory.id)}"`
        : `data-memory-operation="${operation}" data-memory-id="${esc(memory.id)}"`;
      return `<button class="${labelled ? `text-button memory-row-action${danger ? ' is-danger' : ''}` : 'icon-button'}" ${attrs} aria-label="${label}" title="${label}">${workspaceIcon(icon, labelled ? 13 : 14)}${labelled ? `<span>${label}</span>` : ''}</button>`;
    };
    const memoryRow = memory => `<article class="ws-memory" data-memory-id="${esc(memory.id)}"><div class="ws-memory-content"><small>${esc(memory.scope?.deliverable || t('全部交付物', 'All deliverables'))}${memory.updatedAt ? ` · ${esc(shortMoment(memory.updatedAt))}` : ''}</small>${editingMemory?.id === memory.id ? `<form class="memory-edit-form" data-memory-edit="${esc(memory.id)}" aria-busy="${pending.has(memory.id)}"><label class="sr-only" for="memory-edit-${esc(memory.id)}">${t('编辑记忆', 'Edit memory')}</label><textarea id="memory-edit-${esc(memory.id)}" name="text" maxlength="2000" required ${pending.has(memory.id) ? 'readonly' : ''}>${esc(editingMemory.text)}</textarea><div class="actions"><button class="text-button" type="button" data-memory-cancel>${t('取消', 'Cancel')}</button><button class="primary-button" type="submit" ${pending.has(memory.id) ? 'disabled' : ''}>${t('保存', 'Save')}</button></div></form>` : `<p>${esc(memory.text)}</p>`}${memory.taskId ? `<button class="text-button" data-open-task="${esc(memory.taskId)}">${t('来源任务', 'Source task')} ↗</button>` : `<span class="memory-origin-label">${t('示例记忆', 'Sample memory')}</span>`}</div><div class="ws-memory-actions">${memoryAction(memory, 'edit', 'edit', t('编辑', 'Edit'))}${memoryAction(memory, 'delete', 'trash', t('删除', 'Delete'), { danger: true })}${state.durable ? memoryAction(memory, '', 'back', t('永久忘记', 'Forget'), { forget: true }) : ''}</div></article>`;

    const stats = `<div class="memory-summary" aria-label="${t('记忆概览', 'Memory overview')}">
      <button class="memory-stat${!query && memoryScope === 'all' ? ' is-active' : ''}" data-memory-clear><strong>${active.length}</strong><span><b>${t('全部记忆', 'All memories')}</b><small>${t('清除筛选', 'Clear filters')}</small></span></button>
      <div class="memory-stat memory-stat-fact"><strong>${scopes.length}</strong><span><b>${t('工作范围', 'Work scopes')}</b><small>${t('按已保存的范围分组', 'Grouped by saved scope')}</small></span></div>
      <button class="memory-stat" data-memory-stat="deleted" ${deleted.length ? '' : 'disabled aria-disabled="true"'}><strong>${deleted.length}</strong><span><b>${t('已删除', 'Deleted')}</b><small>${deleted.length ? t('可恢复', 'Recoverable') : t('没有已删除项', 'Nothing deleted')}</small></span></button>
    </div>`;

    const toolbar = `<div class="memory-toolbar">
      <label class="collection-search"><span class="sr-only">${t('搜索记忆', 'Search memories')}</span>${workspaceIcon('search', 15)}<input type="search" data-memory-search value="${esc(memoryQuery)}" placeholder="${t('搜索内容、项目或交付物', 'Search content, project or deliverable')}"></label>
      <label class="memory-scope-label"><span class="sr-only">${t('筛选工作范围', 'Filter work scope')}</span><select class="memory-scope-select" data-memory-scope-filter><option value="all">${t('全部范围', 'All scopes')}</option>${scopes.map(scope => `<option value="${esc(scope)}" ${scope === memoryScope ? 'selected' : ''}>${esc(scope)}</option>`).join('')}</select></label>
      ${query || memoryScope !== 'all' ? `<button class="text-button memory-clear" data-memory-clear>${t('清除筛选', 'Clear filters')}</button>` : ''}
      <div class="memory-view-toggle" role="group" aria-label="${t('记忆视图', 'Memory view')}">${[['space', t('空间', 'Space')], ['library', t('资料库', 'Library')]].map(([view, label]) => `<button type="button" data-memory-view="${view}" aria-pressed="${memoryView === view}">${label}</button>`).join('')}</div>
    </div>`;

    const noMatches = `<div class="empty-state"><span class="empty-mark" aria-hidden="true">${workspaceIcon('search', 22)}</span><h2>${t('没有相符的记忆', 'No matching memories')}</h2><p>${t('换个关键词，或清除范围筛选。', 'Try another search or clear the scope filter.')}</p><button class="secondary-button" data-memory-clear>${t('清除筛选', 'Clear filters')}</button></div>`;

    const clusterMarkup = scopeEntries.map(([entity, items]) => {
      const deliverables = [...new Set(items.map(memory => memory.scope?.deliverable).filter(Boolean))].slice(0, 3);
      const latest = items.map(memory => memory.updatedAt).filter(Boolean).sort().at(-1);
      return `<button class="memory-cluster${entity === focusedScope ? ' is-selected' : ''}" data-memory-cluster="${esc(entity)}" aria-pressed="${entity === focusedScope}"><span class="memory-node-icon" aria-hidden="true">${workspaceIcon('memory', 18)}</span><span><h3>${esc(entity)}</h3><span class="memory-cluster-meta">${items.length} ${t('条记忆', items.length === 1 ? 'memory' : 'memories')}${latest ? ` · ${esc(shortMoment(latest))}` : ''}</span></span><span class="memory-cluster-preview">${items.slice(0, 3).map(memory => `<span>${esc(memory.text)}</span>`).join('')}${items.length > 3 ? `<small>${t(`还有 ${items.length - 3} 条`, `${items.length - 3} more`)}</small>` : ''}</span><span class="memory-cluster-scopes">${deliverables.map(item => `<span>${esc(item)}</span>`).join('')}</span></button>`;
    }).join('');

    const space = `<div class="memory-browser">
      <section class="memory-space" aria-label="${t('按工作范围查看记忆', 'Memories by work scope')}">
        <header class="memory-space-header"><div><h2>${t('记忆空间', 'Memory space')}</h2><p>${t('项目与交付物', 'Projects and deliverables')}</p></div><span>${visible.length} ${t('条', visible.length === 1 ? 'memory' : 'memories')}</span></header>
        ${scopeEntries.length ? `<div class="memory-clusters">${clusterMarkup}</div>` : noMatches}
        
      </section>
      ${focusedScope ? `<aside class="memory-inspector" aria-label="${t('记忆范围详情', 'Scope details')}"><header><div class="memory-inspector-top"><span class="memory-kicker">${t('记忆范围', 'Memory scope')}</span><button type="button" class="icon-button" data-memory-close aria-label="${t('收起记忆详情', 'Close memory details')}">${workspaceIcon('close', 16)}</button></div><h2 tabindex="-1">${esc(focusedScope)}</h2><p>${focusedMemories.length} ${t('条记忆', focusedMemories.length === 1 ? 'memory' : 'memories')} · ${t('只在这些交付物中生效', 'Applies only to these deliverables')}</p><div class="memory-scope-chips">${[...new Set(focusedMemories.map(memory => memory.scope?.deliverable).filter(Boolean))].map(item => `<span class="ws-source-chip">${esc(item)}</span>`).join('')}</div></header><div class="memory-inspector-list">${focusedMemories.map(memoryRow).join('')}</div></aside>` : ''}
    </div>`;

    const library = `<div class="memory-library active">${scopeEntries.length ? scopeEntries.map(([entity, items]) => `<section class="memory-group"><h3>${esc(entity)}<span>${items.length}</span></h3><div>${items.map(memory => `<details class="memory-record" data-preserve="memory-record-${esc(memory.id)}"><summary><span>${esc(memory.text)}</span><small>${esc(memory.scope?.deliverable || '')}</small></summary>${memoryRow(memory)}</details>`).join('')}</div></section>`).join('') : noMatches}</div>`;

    const empty = `<div class="empty-state memory-empty"><span class="empty-mark" aria-hidden="true">${workspaceIcon('memory', 22)}</span><h2>${t('还没有保存的记忆', 'No saved memories yet')}</h2><p>${t('纠偏一件事时选择“记住”，并限定项目与交付物，记忆才会出现在这里。', 'Choose “Remember” while steering a task, with a project and deliverable, and it will appear here.')}</p><button class="secondary-button" data-memory-empty-action="home">${t('去看看需要你的事', 'See what needs you')}</button></div>`;

    const demoNote = active.some(memory => memory.origin === 'demo_preview') ? `<p class="memory-demo-note">${t('示例记忆 · 仅用于演示预览', 'Sample memories · preview data only')}</p>` : '';
    update('memoryContent', active.length ? demoNote + stats + toolbar + (memoryView === 'library' ? library : space) : empty);
    update('memoryDeleted', deleted.length ? `<details><summary>${t('已删除', 'Deleted')} · ${deleted.length}</summary><div class="memory-deleted-list">${deleted.map(memory => `<div class="ws-memory-deleted memory-deleted-row"><p>${esc(memory.text)}</p><small>${esc(memory.scope?.entity || '')}</small><button class="text-button" data-memory-operation="restore" data-memory-id="${esc(memory.id)}">${t('恢复', 'Restore')}</button>${state.durable ? `<button class="text-button" data-forget-kind="task_memory" data-forget-id="${esc(memory.id)}">${t('永久忘记', 'Forget permanently')}</button>` : ''}</div>`).join('')}</div></details>` : '');
  }

  async function memoryCommand(id, operation, text) {
    if (pending.has(id)) return;
    const memory = context().state.taskMemories?.find(item => item.id === id);
    if (!memory) return;
    pending.add(id);
    renderMemories();
    try {
      const result = await post(`/api/memories/${encodeURIComponent(id)}`, { operation, text, version: operation === 'edit' ? editingMemory?.version : memory.updatedAt });
      editingMemory = null; applyState(result.state);
      notify(operation === 'delete' ? t('记忆已删除，可在“已删除”中恢复', 'Memory deleted. Restore it under Deleted.') : t('记忆已更新', 'Memory updated'));
    } catch (error) { notify(error.message, true); }
    finally { pending.delete(id); renderMemories(); }
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.taskContext) openContext(target.dataset.taskContext, target.dataset.taskId, target);
    else if (target.hasAttribute('data-context-close')) byId('taskContextDialog').close();
    else if (target.dataset.memoryScope && contextPanel) {
      const taskId = contextPanel.id;
      const original = drafts.get(taskId) || { text: '', scope: 'task' };
      drafts.set(taskId, { ...original, scope: target.dataset.memoryScope });
      refresh();
      byId('taskContextDialog').close();
    } else if (target.dataset.contextPage) {
      restoreContextFocus = false;
      byId('taskContextDialog').close();
      if (byId('taskDialog').open) byId('taskDialog').close();
      go(target.dataset.contextPage);
    } else if (target.dataset.workspaceMode) setMode(target.dataset.workspaceMode);
    else if (target.dataset.selectTask) { selectedEvent = target.dataset.selectEvent || null; select(target.dataset.selectTask, { focus: true, toggle: !target.dataset.selectEvent }); }
    else if (target.dataset.focusTask) { selected = target.dataset.focusTask; setMode('spotlight', { persist: false }); }
    else if (target.hasAttribute('data-workspace-return')) setMode(returnMode, { persist: false });
    else if (target.hasAttribute('data-close-inspector')) { const previous = selected; selected = null; byId('taskContent').dataset.collapsed = 'true'; if (lastRender) render(lastRender); byId('taskContent').querySelector(`[data-select-task="${CSS.escape(previous)}"]`)?.focus({ preventScroll: true }); }
    else if (target.dataset.taskControl) void command(target.dataset.taskId, target.dataset.taskControl);
    else if (target.dataset.undoDirection) void command(target.dataset.taskId, 'undo-direction', { id: target.dataset.undoDirection });
    else if (target.dataset.memoryOperation) {
      if (target.dataset.memoryOperation === 'edit') { const memory = context().state.taskMemories.find(item => item.id === target.dataset.memoryId); if (!memory) return; editingMemory = { id: memory.id, version: memory.updatedAt, text: memory.text }; renderMemories(); byId(`memory-edit-${editingMemory.id}`)?.focus(); }
      else void memoryCommand(target.dataset.memoryId, target.dataset.memoryOperation);
    } else if (target.dataset.memoryView) {
      memoryView = target.dataset.memoryView;
      writeLocal('unprompted:memory-view', memoryView);
      renderMemories();
    } else if (target.dataset.memoryStat === 'deleted') {
      const details = byId('memoryDeleted').querySelector('details');
      if (details) { details.open = true; details.scrollIntoView({ block: 'nearest' }); }
    } else if (target.dataset.memoryCluster) {
      selectedMemoryScope = selectedMemoryScope === target.dataset.memoryCluster ? 'all' : target.dataset.memoryCluster;
      renderMemories();
      byId('memoryContent').querySelector('.memory-inspector h2')?.focus({ preventScroll: true });
    } else if (target.hasAttribute('data-memory-close')) {
      const previous = selectedMemoryScope;
      selectedMemoryScope = 'all'; renderMemories();
      byId('memoryContent').querySelector(`[data-memory-cluster="${CSS.escape(previous)}"]`)?.focus({ preventScroll: true });
    } else if (target.dataset.memoryEmptyAction) go(target.dataset.memoryEmptyAction);
    else if (target.hasAttribute('data-memory-cancel')) { editingMemory = null; renderMemories(); }
    else if (target.hasAttribute('data-memory-clear')) { memoryQuery = ''; memoryScope = 'all'; selectedMemoryScope = 'all'; renderMemories(); }
  });
  document.addEventListener('input', event => {
    if (event.target.hasAttribute('data-memory-search')) { memoryQuery = event.target.value; if (!composing && !event.isComposing) renderMemories(); return; }
    const id = event.target.dataset.directionInput;
    if (id) {
      drafts.set(id, { text: event.target.value, scope: event.target.closest('form').elements.scope.value });
      // The inspector and record dialog edit one draft. Keep their DOM values
      // in sync before native dialog focus/close events or live preservation
      // can restore an older visible copy over the current draft.
      for (const input of document.querySelectorAll('[data-direction-input]')) {
        if (input !== event.target && input.dataset.directionInput === id) input.value = event.target.value;
      }
    }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'workspaceViewOptions') { setMode(event.target.value); return; }
    if (event.target.hasAttribute('data-memory-scope-filter')) { memoryScope = event.target.value; renderMemories(); return; }
  });
  document.addEventListener('submit', event => {
    const direction = event.target.dataset.taskDirection, memory = event.target.dataset.memoryEdit;
    if (!direction && !memory) return;
    event.preventDefault();
    if (direction) void command(direction, 'direction', { text: event.target.elements.direction.value, scope: event.target.elements.scope.value });
    if (memory) void memoryCommand(memory, 'edit', event.target.elements.text.value);
  });
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', event => {
    composing = false;
    if (event.target.hasAttribute('data-memory-search')) {
      memoryQuery = event.target.value;
      renderMemories();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !document.querySelector('dialog[open]') && !document.querySelector('.evidence-peek:not([hidden])')) {
      const memoryClose = byId('memoryContent').querySelector('[data-memory-close]');
      if (memoryClose && !byId('viewMemory').hidden) { event.preventDefault(); memoryClose.click(); return; }
      const close = byId('taskContent').querySelector('[data-close-inspector]');
      if (close && !byId('viewHome').hidden) { event.preventDefault(); close.click(); }
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[1-5]$/.test(event.code) && !event.target.closest('input,textarea,select,[contenteditable="true"]')) {
      event.preventDefault(); go('home'); setMode(WORKSPACE_MODES[Number(event.code.slice(-1)) - 1]);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && event.target.dataset.directionInput && !event.isComposing) {
      event.preventDefault(); event.target.closest('form').requestSubmit();
    }
  });
  return { render, select, setMode, inspector, recoveryCard, renderMemories, getMode: () => mode };
}
