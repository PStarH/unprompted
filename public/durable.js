import { getLocale } from './i18n.js';
const t = (zh, en) => getLocale() === 'en' ? en : zh;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const byId = id => document.getElementById(id);

export function createDurablePanel({ context, update, post, applyState, refresh, notify, openTask }) {
  const dialog = byId('durableDialog');
  let experiences = [], policies = [], loaded = '', fetching = false, busy = false, action = null;
  const statusName = status => ({ candidate: t('候选', 'Candidate'), active: t('已启用', 'Active'), cooldown: t('已暂停', 'Cooling down'), needs_revalidation: t('待重新验证', 'Revalidation needed'), retired: t('已停用', 'Retired'), draft: t('待确认身份', 'Identity needed'), disabled: t('已停用', 'Disabled') })[status] || status;
  async function load() {
    if (fetching) return;
    fetching = true; const revision = String(context().state?.revision);
    try {
      const responses = await Promise.all([fetch('/api/experiences'), fetch('/api/policies')]);
      if (responses.some(response => !response.ok)) { loaded = revision; return; }
      const data = await Promise.all(responses.map(response => response.json()));
      experiences = data[0].experiences; policies = data[1].policies;
      loaded = revision;
    } catch { loaded = revision; /* The connection status owns transport errors. */ }
    finally { fetching = false; render(); }
  }
  function render() {
    const state = context().state, enabled = Boolean(state?.durable);
    for (const id of ['durableMemoryContent', 'policyContent', 'experienceContent', 'durableSettingsContent', 'durableDigestContent']) if (byId(id)) byId(id).hidden = !enabled;
    if (!enabled) return;
    const visible = !byId('viewMemory').hidden || !byId('viewPreferences').hidden;
    if (visible && loaded !== String(state.revision) && !fetching) void load();
    const memories = (state.groundedMemories || []).filter(memory => memory.source_kind !== 'task_memory');
    update('durableMemoryContent', `<div class="v12-heading"><h2>${t('事实与偏好', 'Facts & preferences')}</h2><button class="secondary-button" data-durable-add="fact">${t('添加记忆', 'Add memory')}</button></div>${memories.map(memory => `<article class="v12-row"><div><small>${memory.scope_type === 'global' ? t('全局', 'Global') : esc(memory.scope_key)}</small><p>${esc(memory.content)}</p></div><button class="text-button" data-forget-kind="memory" data-forget-id="${esc(memory.id)}">${t('忘记', 'Forget')}</button></article>`).join('')}${!memories.length ? `<p class="muted">${t('可以记住你的偏好，供之后的任务参考。', 'Keep preferences for future tasks.')}</p>` : ''}`);
    update('policyContent', `<div class="v12-heading"><h2>${t('规则', 'Rules')}</h2><button class="secondary-button" data-durable-add="policy">${t('添加规则', 'Add rule')}</button></div>${policies.map(policy => `<article class="v12-row"><div><small>${statusName(policy.status)}</small><p>${esc(policy.instruction_text)}</p></div><div class="v12-row-actions">${policy.status !== 'disabled' ? `<button class="text-button" data-policy-disable="${esc(policy.id)}" data-version="${policy.version}" ${busy ? 'disabled' : ''}>${t('停用', 'Disable')}</button>` : ''}<button class="text-button" data-forget-kind="policy" data-forget-id="${esc(policy.id)}">${t('忘记', 'Forget')}</button></div></article>`).join('')}${!policies.length ? `<p class="muted">${t('决定何时跟进、何时提醒。', 'Choose when to follow up and notify.')}</p>` : ''}`);
    const current = experiences.filter(experience => experience.status !== 'retired');
    update('experienceContent', `<div class="v12-heading"><h2>${t('经验', 'Experiences')}</h2><small>${state.durable.learning.autoPromote ? t('低风险经验可自动晋升', 'Low-risk promotion enabled') : t('自动晋升已关闭', 'Automatic promotion off')}</small></div>${current.map(experience => `<article class="v12-row"><div><small>${statusName(experience.status)} · ${esc(experience.scope_key)}</small><p>${esc(experience.instruction_text)}</p><small>${t('独立验证成功', 'Independent verified successes')} ${experience.verified_success_count} · ${t('负面证据', 'Negative evidence')} ${experience.negative_evidence_count}</small><div class="v12-row-actions">${['candidate', 'active'].includes(experience.status) && experience.effect?.type === 'draft_format' ? `<button class="text-button" data-experience-trial="${esc(experience.id)}">${t('监督试用', 'Try under review')}</button>` : ''}${experience.status === 'candidate' && experience.kind === 'execution_hint' && experience.scope_type !== 'global' && experience.effect?.type === 'draft_format' && experience.verified_success_count >= state.durable.learning.mechanicalSuccesses && !experience.negative_evidence_count ? `<button class="text-button" data-experience-promote="${esc(experience.id)}" data-version="${experience.revision}">${t('启用经验', 'Activate')}</button>` : ''}<button class="text-button" data-experience-retire="${esc(experience.id)}" data-version="${experience.revision}">${t('停用', 'Retire')}</button><button class="text-button" data-forget-kind="experience" data-forget-id="${esc(experience.id)}">${t('忘记', 'Forget')}</button></div></div></article>`).join('')}${!current.length ? `<p class="muted">${t('经验会从可追溯的反馈与结果中积累。', 'Experiences accumulate from traceable feedback and outcomes.')}</p>` : ''}`);
    const durable = state.durable;
    update('durableSettingsContent', `<div class="v12-heading"><h2>${t('提醒与学习', 'Notifications & learning')}</h2></div><form data-attention-settings><label>${t('每小时最多主动询问', 'Interactive notifications per hour')}<input type="number" name="hourly" min="0" max="100" value="${durable.attention.policy.maxInteractivePerHour}"></label><label>${t('最短提醒间隔（分钟）', 'Minimum interruption interval (minutes)')}<input type="number" name="interval" min="0" max="1440" value="${durable.attention.policy.minIntervalMs / 60000}"></label><label>${t('免打扰开始', 'Quiet hours start')}<input type="number" name="quietStart" min="0" max="23" placeholder="22" value="${durable.attention.policy.quietHours?.startHour ?? ''}"></label><label>${t('结束', 'End')}<input type="number" name="quietEnd" min="0" max="23" placeholder="8" value="${durable.attention.policy.quietHours?.endHour ?? ''}"></label><button type="submit" class="secondary-button" ${busy ? 'disabled' : ''}>${t('保存', 'Save')}</button></form><label class="v12-toggle"><input type="checkbox" data-learning-promotion data-version="${durable.learning.version}" ${durable.learning.autoPromote ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>${t('达到证据门槛后，自动启用低风险格式经验', 'Activate low-risk formatting guidance after the evidence threshold')}</span></label><details data-preserve="v12-execution-status"><summary>${t('运行记录', 'Execution status')}</summary><p class="muted">SQLite ${esc(durable.storage.sqliteVersion)} · WAL · FULL</p>${durable.jobs.filter(job => ['recovery_required', 'dead'].includes(job.state)).map(job => `<p class="v12-status-row">${esc(job.job_type)} · ${esc(job.state)}${job.last_error_class ? ` · ${esc(job.last_error_class)}` : ''}</p>`).join('') || `<p class="muted">${t('没有待恢复的任务。', 'No jobs need recovery.')}</p>`}${(durable.deletion || []).map(request => `<div class="v12-status-row"><span>${t('删除仍待完成', 'Deletion pending')}: ${request.status.pendingExternal.length ? t('外部操作待核验', 'External result unresolved') : t('保留数据待清理', 'Retention cleanup pending')}</span> <button class="text-button" data-deletion-retry="${esc(request.id)}">${t('重新检查', 'Check again')}</button></div>`).join('')}${(durable.executions || []).filter(execution => ['unknown', 'accepted', 'dispatched'].includes(execution.status)).map(execution => `<div class="v12-status-row"><span>${esc(execution.provider)} · ${esc(execution.action_family)} · ${esc(execution.status)}</span> <button class="text-button" data-execution-reconcile="${esc(execution.id)}">${t('核验结果', 'Reconcile result')}</button></div>`).join('')}</details>`);
    const digests = durable.attention.digests || [];
    byId('durableDigestContent').hidden = !digests.length;
    update('durableDigestContent', digests.length ? `<div class="v12-heading"><h2>${t('汇总待看', 'Queued digest')}</h2><small>${t('提醒预算内再送达', 'Delivered within your interruption budget')}</small></div>${digests.map(group => `<article class="v12-row"><div><p>${esc(group.headlines[0])}</p><small>${group.ids.length} ${t('项相关变化', 'related updates')}</small>${(group.taskIds || []).map(id => `<button class="text-button" data-digest-task="${esc(id)}">${t('查看任务', 'View task')}</button>`).join('')}</div></article>`).join('')}` : '');
  }
  function show(title, html) { byId('durableDialogTitle').textContent = title; byId('durableDialogBody').innerHTML = html; if (!dialog.open) dialog.showModal(); dialog.querySelector('input:not([type=hidden]),textarea,select')?.focus(); }
  const actions = submit => `<p class="v12-error" id="durableFormError" role="alert"></p><div class="v12-form-actions"><button type="button" class="secondary-button" data-durable-close>${t('取消', 'Cancel')}</button><button type="submit" class="primary-button">${submit}</button></div>`;
  function add(kind) {
    action = { kind };
    const projects = [...new Set((context().state.tasks || []).map(task => task.request?.subjectEntity).filter(Boolean))];
    if (kind === 'fact') show(t('添加记忆', 'Add memory'), `<form data-durable-form="fact"><label>${t('记住什么', 'What to remember')}<textarea name="text" rows="4" maxlength="2000" required placeholder="${t('例如：周报先列结果，再列风险。', 'For example: Lead weekly reports with results, then risks.')}" autofocus></textarea></label><label>${t('范围', 'Scope')}<select name="scope"><option value="">${t('全局', 'Global')}</option>${projects.map(project => `<option value="${esc(project)}">${esc(project)}</option>`).join('')}</select></label>${actions(t('记住', 'Remember'))}</form>`);
    else show(t('添加规则', 'Add rule'), `<form data-durable-form="policy"><label>${t('工作来源', 'Work source')}<select name="provider"><option value="google">Google</option><option value="microsoft">Outlook</option><option value="github">GitHub</option><option value="slack">Slack</option><option value="notion">Notion</option><option value="local_files">${t('本地文件', 'Local files')}</option><option value="apple_notes">Apple Notes</option></select></label><label>${t('匹配', 'Match')}<select name="match" data-policy-match><option value="sender">${t('指定邮箱或账号', 'Exact mailbox or account')}</option><option value="all">${t('该来源全部任务', 'All work from this source')}</option></select></label><label data-policy-identity>${t('邮箱或账号', 'Mailbox or account')}<input name="identity" autocomplete="off" maxlength="200" placeholder="li@example.com" required></label><label>${t('执行规则', 'Behavior')}<select name="effect"><option value="priority">${t('优先处理', 'Prioritize')}</option><option value="suppress">${t('不主动跟进', 'Do not activate')}</option><option value="require_review">${t('继续前先让我确认', 'Require my review')}</option><option value="digest">${t('合并提醒', 'Digest notifications')}</option></select></label><label class="v12-toggle" data-policy-identity><input name="confirmed" type="checkbox" required><span>${t('确认这是要匹配的准确身份', 'This is the exact identity to match')}</span></label>${actions(t('保存规则', 'Save rule'))}</form>`);
  }
  async function forget(kind, id) {
    try {
      const result = await post('/api/privacy/preview', { kind, id }); action = { kind: 'forget', target: { kind, id } };
      for (const open of document.querySelectorAll('dialog[open]')) if (open !== dialog) open.close();
      show(t('忘记这条信息', 'Forget this information'), `<form data-durable-form="forget"><p>${t('会清理关联数据，并停止依赖它的任务。', 'Remove related data and stop tasks that depend on it.')}</p><div class="v12-impact">${result.counts.task || 0} ${t('个任务', 'tasks')} · ${result.counts.experience || 0} ${t('条经验', 'experiences')} · ${result.counts.job || 0} ${t('个作业', 'jobs')}</div>${result.counts.execution ? `<p class="muted">${t('已发起的外部操作会继续核验，无法通过本地删除撤回。', 'Started external operations will be reconciled; local deletion cannot undo them.')}</p>` : ''}<p class="muted">${t('已发送给模型或连接器的副本，仍受各提供方的保留政策约束。', 'Copies already sent to a model or connector follow its retention policy.')}</p>${actions(t('忘记并清理', 'Forget and remove'))}</form>`);
    } catch (error) { notify(error.message, true); }
  }
  async function mutate(path, body) {
    if (busy) return; busy = true;
    try { const result = await post(path, body); if (result.state) applyState(result.state); loaded = ''; await refresh(); await load(); return result; }
    catch (error) { notify(error.message, true); throw error; }
    finally { busy = false; render(); }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || busy) return;
    if (button.dataset.editDraft) {
      const task = context().state.tasks.find(item => item.id === button.dataset.editDraft); if (!task?.draft) return;
      action = { kind: 'draft', taskId: task.id, reviewToken: task.reviewToken };
      for (const open of document.querySelectorAll('dialog[open]')) if (open !== dialog) open.close();
      show(t('编辑草稿', 'Edit draft'), `<form data-durable-form="draft"><label>${t('回复内容', 'Reply content')}<textarea name="body" rows="12" maxlength="64000" required>${esc(task.draft.body)}</textarea></label>${actions(t('保存草稿', 'Save draft'))}</form>`); return;
    }
    if (button.dataset.digestTask) return openTask(button.dataset.digestTask);
    if (button.dataset.durableAdd) return add(button.dataset.durableAdd);
    if (button.hasAttribute('data-durable-close')) return dialog.close();
    if (button.dataset.forgetKind) { void forget(button.dataset.forgetKind, button.dataset.forgetId); return; }
    if (button.dataset.deletionRetry) { void mutate(`/api/privacy/requests/${encodeURIComponent(button.dataset.deletionRetry)}/retry`, {}).catch(() => {}); return; }
    if (button.dataset.executionReconcile) { void mutate(`/api/executions/${encodeURIComponent(button.dataset.executionReconcile)}/reconcile`, {}).catch(() => {}); return; }
    if (button.dataset.policyDisable) { void mutate(`/api/policies/${encodeURIComponent(button.dataset.policyDisable)}/disable`, { expectedVersion: Number(button.dataset.version) }).catch(() => {}); return; }
    if (button.dataset.experiencePromote || button.dataset.experienceRetire) {
      const id = button.dataset.experiencePromote || button.dataset.experienceRetire, operation = button.dataset.experiencePromote ? 'promote' : 'retire';
      void mutate(`/api/experiences/${encodeURIComponent(id)}/${operation}`, { expectedRevision: Number(button.dataset.version) }).catch(() => {}); return;
    }
    if (button.dataset.experienceTrial) {
      action = { kind: 'trial', experienceId: button.dataset.experienceTrial };
      const tasks = (context().state.tasks || []).filter(task => task.draft && !task.action && !task.control?.paused);
      show(t('监督试用', 'Try under review'), `<form data-durable-form="trial"><label>${t('选择已有草稿', 'Choose an existing draft')}<select name="taskId" required>${tasks.map(task => `<option value="${esc(task.id)}">${esc(task.subject)}</option>`).join('')}</select></label><p class="muted">${t('先更新草稿，由你检查后决定是否发送。', 'Prepare a draft for your review before any send.')}</p>${tasks.length ? actions(t('准备草稿', 'Prepare draft')) : `<p>${t('当前没有可试用的草稿。', 'No draft is currently available.')}</p><button type="button" class="secondary-button" data-durable-close>${t('关闭', 'Close')}</button>`}</form>`);
    }
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-policy-match]')) {
      const form = event.target.form, sender = event.target.value === 'sender';
      for (const label of form.querySelectorAll('[data-policy-identity]')) { label.hidden = !sender; label.querySelector('input').required = sender; }
    }
    if (event.target.matches('[data-learning-promotion]')) void mutate('/api/experiences/policy', { expectedVersion: Number(event.target.dataset.version), autoPromote: event.target.checked }).catch(() => {});
  });
  document.addEventListener('submit', async event => {
    if (event.target.matches('[data-attention-settings]')) {
      event.preventDefault(); const data = new FormData(event.target);
      await mutate('/api/experiences/attention-policy', { maxInteractivePerHour: Number(data.get('hourly')), minIntervalMs: Number(data.get('interval')) * 60000, quietHours: data.get('quietStart') !== '' && data.get('quietEnd') !== '' ? { startHour: Number(data.get('quietStart')), endHour: Number(data.get('quietEnd')), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null }).catch(() => {}); return;
    }
    const kind = event.target.dataset.durableForm; if (!kind) return;
    event.preventDefault(); if (busy) return;
    const data = new FormData(event.target), submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
    try {
      if (kind === 'draft') { await mutate(`/api/tasks/${encodeURIComponent(action.taskId)}/draft`, { body: data.get('body'), reviewToken: action.reviewToken }); }
      if (kind === 'fact') await mutate('/api/instructions', { kind: 'fact', text: data.get('text'), scopeType: data.get('scope') ? 'project' : 'global', scopeKey: data.get('scope') || '*' });
      if (kind === 'policy') {
        const provider = data.get('provider'), identity = String(data.get('identity') || '').trim(), effectType = data.get('effect');
        const args = [{ op: 'eq', feature: 'event.provider', value: provider }];
        if (data.get('match') === 'sender') args.push({ op: 'eq', feature: 'sender.identity', value: identity });
        const effect = effectType === 'priority' ? { type: 'priority', value: 90 } : effectType === 'digest' ? { type: 'notification', class: 'digest' } : { type: effectType };
        await mutate('/api/policies', { instruction: `${event.target.elements.effect.selectedOptions[0].text}: ${identity || provider}`, predicate: { op: 'all', args }, effect,
          identities: data.get('match') === 'sender' ? [{ provider, providerId: identity, confirmedByUser: data.has('confirmed') }] : [] });
      }
      if (kind === 'forget') {
        const result = await mutate('/api/privacy/forget', action.target);
        notify(result.deletion.state === 'completed' ? t('本地关联数据已清理', 'Related local data removed') : t('本地数据已清理，外部核验或保留清理仍在进行', 'Local data removed; reconciliation or retention cleanup is pending'));
      }
      if (kind === 'trial') {
        const task = context().state.tasks.find(task => task.id === data.get('taskId'));
        await mutate(`/api/experiences/${encodeURIComponent(action.experienceId)}/trial`, { taskId: task.id, reviewToken: task.reviewToken });
        dialog.close(); openTask(task.id); return;
      }
      event.target.reset(); dialog.close();
    } catch (error) { if (byId('durableFormError')) byId('durableFormError').textContent = error.message; }
    finally { if (submit?.isConnected) submit.disabled = false; }
  });
  dialog.addEventListener('close', () => { dialog.querySelector('form')?.reset(); action = null; });
  return { render, reload: load };
}
