import { getLocale } from './i18n.js?v=ix2';
const t = (zh, en) => getLocale() === 'en' ? en : zh;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const byId = id => document.getElementById(id);

/** Only a successfully loaded detail for the same Experience revision and
 * case-set version may be appended to. The list summary intentionally carries
 * no `cases` array, so falling back to it would replace every saved scenario
 * with only the newly added one. */
export function loadedCaseSet({ detail, experience }) {
  if (!detail?.experience || !experience) return null;
  const loaded = detail.experience;
  if (loaded.id !== experience.id || loaded.revision !== experience.revision) return null;
  const caseSet = loaded.caseSet;
  if (!caseSet || caseSet.invalid === true || !Array.isArray(caseSet.cases)) return null;
  const summary = experience.caseSet;
  if (summary && Number(summary.version) !== Number(caseSet.version)) return null;
  if (summary?.digest && caseSet.digest && summary.digest !== caseSet.digest) return null;
  return caseSet;
}

/** Build the append-only save body from the currently loaded detail. A null
 * result means the form must stay open and no request may be sent. */
export function trialCaseSubmission({ detail, experience, action, nextCase }) {
  const caseSet = loadedCaseSet({ detail, experience });
  if (!caseSet || !experience || !action || action.experienceId !== experience.id || action.revision !== experience.revision
    || action.caseSet?.version !== caseSet.version) return null;
  return { expectedRevision: experience.revision, expectedCaseSetVersion: caseSet.version, cases: [...caseSet.cases, nextCase] };
}

export function createDurablePanel({ context, update, post, applyState, refresh, notify, openTask }) {
  const dialog = byId('durableDialog');
  let experiences = [], policies = [], loaded = '', fetching = false, busy = false, action = null, evaluation = null;
  const details = new Map();
  let openDetails = '';
  const statusName = status => ({ candidate: t('候选', 'Candidate'), active: t('已启用', 'Active'), cooldown: t('已暂停', 'Cooling down'), needs_revalidation: t('待重新验证', 'Revalidation needed'), retired: t('已停用', 'Retired'), draft: t('待确认身份', 'Identity needed'), disabled: t('已停用', 'Disabled') })[status] || status;
  const trialStateName = state => ({ passed: t('通过', 'Passed'), failed: t('失败', 'Failed'), unknown: t('未知', 'Unknown'), expired: t('已到期', 'Expired'), superseded: t('已失效', 'Superseded') })[state] || state;
  const trialReasonName = reason => ({ pass_expired: t('评估已过期', 'pass expired'), stored_expired: t('已失效（历史原因未记录）', 'stored as expired (historical reason not recorded)'),
    fixture_or_policy_changed: t('评估规则已更新', 'evaluation rules changed'), positive_candidate_evidence_missing: t('缺少候选正向证据', 'positive candidate evidence missing'),
    case_set_changed: t('场景已更改', 'scenarios changed'), revision_changed: t('经验版本已更改', 'revision changed') })[reason] || reason;
  const trialState = trial => trial?.effectiveState || (trial?.state === 'passed' && trial.expiresAt && Date.parse(trial.expiresAt) <= Date.now() ? 'expired' : trial?.state);
  const when = value => value ? new Date(value).toLocaleString(getLocale() === 'en' ? 'en' : 'zh-CN') : '';
  const categorySummary = trial => {
    if (!trial) return '';
    const categories = trial.categories || {};
    return [
      categories.guard?.total ? `${t('防护','guards')} ${categories.guard.passed}/${categories.guard.total}` : null,
      categories.behavior?.total ? `${t('行为','behavior')} ${categories.behavior.passed}/${categories.behavior.total}${categories.behavior.positive != null ? ` · ${t('正向','positive')} ${categories.behavior.positive}` : ''}` : t('缺少独立行为样例','no independent behavior case'),
      categories.authorization?.required ? `${t('授权','authorization')} ${categories.authorization.status}` : null
    ].filter(Boolean).join(' · ');
  };
  const differenceText = difference => {
    if (!difference) return '';
    const actual = difference.actual ? ` · ${t('实际', 'actual')}: ${JSON.stringify(difference.actual)}` : '';
    const expected = difference.expected ? ` · ${t('预期', 'expected')}: ${JSON.stringify(difference.expected)}` : '';
    return `${difference.caseId || ''}${difference.category ? ` [${difference.category}]` : ''} · ${trialStateName(difference.status)}${difference.reason ? ` · ${difference.reason}` : ''}${expected}${actual}`.slice(0, 320);
  };
  const ADOPTABLE = ['archive_destination', 'notification_behavior', 'review_requirements', 'step_behavior'];
  const CASE_TYPES = ['draft_format', ...ADOPTABLE];
  const EFFECT_INPUTS = {
    draft_format: [{ name: 'format', label: t('格式', 'Format'), options: ['plain', 'markdown', 'table', 'json'] }],
    archive_destination: [{ name: 'provider', label: t('目标来源', 'Provider') }, { name: 'resourceId', label: t('精确目标', 'Exact target') }],
    notification_behavior: [{ name: 'mode', label: t('提醒方式', 'Mode'), options: ['silent', 'digest', 'interactive'] }],
    review_requirements: [{ name: 'required', label: t('需要复核', 'Review required'), options: ['true', 'false'] }],
    step_behavior: [{ name: 'stepKind', label: t('步骤类型', 'Step kind') }, { name: 'operation', label: t('操作', 'Operation'), options: ['include', 'omit'] }]
  };
  const effectInputs = (type, prefix) => (EFFECT_INPUTS[type] || []).map(field => `<label>${esc(field.label)}${field.options
    ? `<select name="${prefix}_${field.name}">${field.options.map(option => `<option value="${option}">${option}</option>`).join('')}</select>`
    : `<input name="${prefix}_${field.name}" maxlength="200" autocomplete="off">`}</label>`).join('');
  async function addCase(id) {
    const experience = experiences.find(item => item.id === id);
    if (!experience || !CASE_TYPES.includes(experience.effect?.type)) return;
    if (!details.has(id) && !(await loadDetail(id))) return;
    const caseSet = loadedCaseSet({ detail: details.get(id), experience });
    if (!caseSet) {
      notify(t('已保存场景尚未加载或已变化，请重试；不会用空集覆盖已有场景。', 'Saved cases are not loaded or have changed. Retry; an empty set will not replace saved cases.'), true);
      return;
    }
    action = { kind: 'case', experienceId: id, revision: experience.revision, caseSet };
    const existing = caseSet.cases.length;
    show(t('添加独立行为场景', 'Add an independent behavior case'), `<form data-durable-form="case"><input type="hidden" name="revision" value="${experience.revision}"><p class="muted">${t('场景是你自己写的预期，只作为数据参与真实 predicate 与仲裁比较；它不是授权，也不会被当作已通过。','A scenario is your own written expectation. It is data compared against the real predicate and arbitration; it is not a grant and is never treated as already passed.')}</p><label>${t('作用范围类型', 'Scope type')}<select name="scopeType">${['global', 'task_family', 'project', 'entity', 'resource'].map(type => `<option value="${type}" ${type === experience.scope_type ? 'selected' : ''}>${type}</option>`).join('')}</select></label><label>${t('作用范围值', 'Scope key')}<input name="scopeKey" maxlength="200" required value="${esc(experience.scope_key)}"></label><label>${t('匹配事实（每行一个 feature=value）', 'Matching facts (one feature=value per line)')}<textarea name="features" rows="4" maxlength="4000" placeholder="event.provider=google"></textarea></label><label>${t('这个场景是否适用', 'Does this scenario apply')}<select name="applies"><option value="true">${t('适用', 'Applies')}</option><option value="false">${t('不适用', 'Does not apply')}</option></select></label><label>${t('预期决定', 'Expected decision')}<select name="winner"><option value="candidate">${t('候选经验', 'Candidate')}</option><option value="user">${t('当前用户指示优先', 'Current user direction')}</option><option value="none">${t('无决定', 'No decision')}</option></select></label><fieldset><legend>${t('候选经验的字面预期效果', 'Literal expected candidate effect')}</legend>${effectInputs(experience.effect.type, 'expected')}</fieldset><fieldset><legend>${t('用户指示的字面效果（仅用户优先时）', 'Literal user-direction effect (user precedence only)')}</legend>${effectInputs(experience.effect.type, 'user')}</fieldset><label>${t('来源类型（可选）', 'Source kind (optional)')}<select name="sourceKind"><option value="">${t('无', 'None')}</option>${['event', 'task', 'memory', 'task_memory', 'feedback'].map(kind => `<option value="${kind}">${kind}</option>`).join('')}</select></label><label>${t('来源 ID（可选）', 'Source id (optional)')}<input name="sourceId" maxlength="200" autocomplete="off"></label><label class="v12-toggle"><input name="confirmed" type="checkbox" required><span>${t('我确认这是我自己写的独立场景，不是从候选效果复制的预期，也不是权限或已通过结果。', 'I confirm this is my own independent scenario, not an expectation copied from the candidate effect, a grant, or a passed result.')}</span></label><p class="muted">${t(`将保存为场景集 v${Number(caseSet.version || 0) + 1}；旧评估立即失效。已有 ${existing} 个场景。`, `Saved as case set v${Number(caseSet.version || 0) + 1}; earlier evaluations are invalidated. ${existing} cases already saved.`)}</p>${actions(t('保存场景', 'Save case'))}</form>`);
  }
  function caseEffect(data, prefix, type) {
    const effect = { type };
    for (const field of EFFECT_INPUTS[type] || []) {
      const raw = String(data.get(`${prefix}_${field.name}`) || '').trim();
      if (!raw) throw new Error(t('请填写完整的预期效果。', 'Enter the complete expected effect.'));
      effect[field.name] = field.name === 'required' ? raw === 'true' : raw;
    }
    return effect;
  }
  const canAdopt = experience => experience.status === 'candidate' && ADOPTABLE.includes(experience.effect?.type) && experience.scope_type !== 'global'
    && !experience.negative_evidence_count && !experience.last_negative_at && trialState(experience.latestTrial) === 'passed'
    && experience.latestTrial.revision === experience.revision
    && (!experience.authorization?.required || experience.authorization.status === 'authorized');
  async function load() {
    if (fetching) return;
    fetching = true; const revision = String(context().state?.revision);
    try {
      const responses = await Promise.all([fetch('/api/experiences'), fetch('/api/policies')]);
      if (responses.some(response => !response.ok)) { loaded = revision; return; }
      const data = await Promise.all(responses.map(response => response.json()));
      experiences = data[0].experiences; policies = data[1].policies; evaluation = data[0].evaluation || null;
      details.clear();
      if (openDetails && !experiences.some(experience => experience.id === openDetails)) openDetails = '';
      loaded = revision;
    } catch { loaded = revision; /* The connection status owns transport errors. */ }
    finally { fetching = false; render(); if (openDetails && !details.has(openDetails)) void loadDetail(openDetails); }
  }
  async function loadDetail(id) {
    try {
      const response = await fetch(`/api/experiences/${encodeURIComponent(id)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('评估详情不可用。', 'Evaluation details are unavailable.'));
      details.set(id, data); render(); return true;
    } catch (error) { notify(error.message, true); return false; }
  }
  async function experienceAction(id, operation, body = {}) {
    try {
      await mutate(`/api/experiences/${encodeURIComponent(id)}/${operation}`, body);
      openDetails = id; details.delete(id); await loadDetail(id);
    } catch { /* mutate already reported the exact server error. */ }
  }
  function render() {
    const state = context().state, enabled = Boolean(state?.durable);
    for (const id of ['policyContent', 'experienceContent', 'durableSettingsContent', 'durableDigestContent', 'standingIntentContent', 'rsiProposalContent']) if (byId(id)) byId(id).hidden = !enabled;
    if (!enabled) return;
    renderIntentControls(state);
    const visible = !byId('viewMemory').hidden || !byId('viewPreferences').hidden;
    if (visible && loaded !== String(state.revision) && !fetching) void load();
    update('policyContent', `<div class="v12-heading"><h2>${t('规则', 'Rules')}</h2><button class="secondary-button" data-durable-add="policy">${t('添加规则', 'Add rule')}</button></div>${policies.map(policy => `<article class="v12-row" data-policy-id="${esc(policy.id)}"><div><small>${statusName(policy.status)}</small><p>${esc(policy.instruction_text)}</p></div><div class="v12-row-actions">${policy.status !== 'disabled' ? `<button class="text-button" data-policy-disable="${esc(policy.id)}" data-version="${policy.version}" ${busy ? 'disabled' : ''}>${t('停用', 'Disable')}</button>` : ''}<button class="text-button" data-forget-kind="policy" data-forget-id="${esc(policy.id)}">${t('忘记', 'Forget')}</button></div></article>`).join('')}${!policies.length ? `<p class="muted">${t('决定何时跟进、何时提醒。', 'Choose when to follow up and notify.')}</p>` : ''}`);
    const current = experiences.filter(experience => experience.status !== 'retired');
    const evaluationSummary = experience => {
      const trial = experience.latestTrial, state = trialState(trial), caseSet = experience.caseSet || { version: 0, count: 0 };
      if (!trial) return `<small>${t('离线评估','Offline evaluation')}: ${t('未评估','Not evaluated')} · ${caseSet.count ? t(`${caseSet.count} 个已保存场景`, `${caseSet.count} saved cases`) : t('先添加独立行为样例','add an independent behavior case first')}</small>`;
      const stale = trial.revision !== experience.revision;
      return `<small>${t('离线评估','Offline evaluation')}: ${stale ? t('旧版本结果，需重新评估','Previous revision; re-evaluate') : trialStateName(state)}${trial.effectiveReason && state !== 'passed' ? ` (${trialReasonName(trial.effectiveReason)})` : ''} · ${trial.counts.passed}/${trial.counts.total} ${t('场景','cases')} · ${categorySummary(trial)} · ${t('有效至','Valid until')} ${trial.expiresAt ? esc(when(trial.expiresAt)) : t('不适用','n/a')}</small>`;
    };
    const experienceDetails = experience => {
      const trial = experience.latestTrial, state = trialState(trial), detail = details.get(experience.id);
      const stale = trial && trial.revision !== experience.revision;
      const detailTrial = trial && detail?.trials?.find(row => row.id === trial.id);
      const differences = (detailTrial?.differences || []).filter(difference => difference.status !== 'pass').slice(0, 8);
      const history = detail?.experience?.contentVersions || experience.contentVersions || [];
      const caseSet = detail?.experience?.caseSet || experience.caseSet || { version: 0, count: 0, cases: [] };
      const saved = Array.isArray(caseSet.cases) ? caseSet.cases : [];
      const savedText = saved.length ? `<div class="v12-impact">${saved.slice(0, 8).map(item => `<p class="v12-status-row">${esc(item.id)} · ${esc(item.scope.map(scope => `${scope.type}:${scope.key}`).join(', '))} · ${item.expected.applies ? esc(item.expected.winner) : t('不适用','not applicable')}</p>`).join('')}</div>` : '';
      const versions = history.map(row => `<div class="v12-status-row"><span>r${row.revision} · ${esc(row.changeKind)} · ${esc(row.effectType)} · ${esc(when(row.createdAt))}</span>${row.revision < experience.revision ? `<button class="text-button" data-experience-rollback="${esc(experience.id)}" data-version="${experience.revision}" data-target="${row.revision}" ${busy ? 'disabled' : ''}>${t('回退到此版本','Roll back to this version')}</button>` : ''}</div>`).join('');
      const authorization = experience.authorization?.required ? `<p class="muted">${t('目标授权','Target authorization')}: ${esc(experience.authorization.status)} · ${esc(experience.authorization.reason || '')}</p>` : '';
      const caseButton = CASE_TYPES.includes(experience.effect?.type)
        ? `<button class="text-button" data-experience-case-add="${esc(experience.id)}" data-version="${experience.revision}" ${busy ? 'disabled' : ''}>${t('添加场景','Add case')}</button>` : '';
      return `<details data-experience-eval="${esc(experience.id)}" ${openDetails === experience.id ? 'open' : ''}><summary>${t('评估与版本','Evaluation & versions')}</summary>${trial ? `<p class="v12-status-row">${trialStateName(state)}${trial.effectiveReason && state !== 'passed' ? ` · ${esc(trialReasonName(trial.effectiveReason))}` : ''} · ${trial.counts.passed}/${trial.counts.total} ${t('场景','cases')}${trial.counts.failed ? ` · ${trial.counts.failed} ${t('失败','failed')}` : ''}${trial.counts.unknown ? ` · ${trial.counts.unknown} ${t('未知','unknown')}` : ''} · ${t('有效至','Valid until')} ${trial.expiresAt ? esc(when(trial.expiresAt)) : t('不适用','n/a')}</p><small>${categorySummary(trial)} · ${t('场景集','Case set')} v${trial.caseSetVersion} · ${t('场景','Fixture')} ${esc(trial.fixtureVersion)} · r${trial.revision}${trial.testedRevision !== trial.revision ? ` · ${t('测试于','tested at')} r${trial.testedRevision}` : ''}</small>${stale ? `<p class="muted">${t('此结果属于旧 revision，不能用于采纳。','This result belongs to an older revision and cannot be adopted.')}</p>` : ''}` : `<p class="muted">${t('尚未评估。没有独立行为样例时结果保持未知。','Not evaluated yet. Without an independent behavior case the result stays unknown.')}</p>`}${authorization}${detail ? differences.length ? `<div class="v12-impact">${differences.map(difference => `<p class="v12-status-row">${esc(differenceText(difference))}</p>`).join('')}</div>` : trial && state === 'passed' ? `<p class="muted">${t('没有差异。','No differences.')}</p>` : '' : trial ? `<p class="muted">${t('展开后加载差异。','Differences load when expanded.')}</p>` : ''}${evaluation ? `<small>${t('评估策略','Evaluation policy')} ${esc(evaluation.fixtureVersion)} · ${esc(String(evaluation.policyDigest || '').slice(0, 12))} · ${t('截止','deadline')} ${Number(evaluation.deadlineMs)}ms</small>` : ''}<div class="v12-impact"><strong>${t('已保存的独立场景','Saved independent cases')} · v${caseSet.version} (${caseSet.count || 0})</strong>${caseButton}${savedText}</div><div class="v12-version-history"><strong>${t('历史版本','Version history')}</strong>${versions || `<p class="muted">${t('没有历史版本。','No version history.')}</p>`}</div></details>`;
    };
    update('experienceContent', `<div class="v12-heading"><h2>${t('经验', 'Experiences')}</h2><small>${state.durable.learning.autoPromote ? t('低风险经验可自动晋升', 'Low-risk promotion enabled') : t('自动晋升已关闭', 'Automatic promotion off')}</small></div>${current.map(experience => `<article class="v12-row"><div><small>${statusName(experience.status)} · ${esc(experience.scope_key)}</small><p>${esc(experience.instruction_text)}</p><small>${t('独立验证成功', 'Independent verified successes')} ${experience.verified_success_count} · ${t('负面证据', 'Negative evidence')} ${experience.negative_evidence_count}</small>${evaluationSummary(experience)}${experienceDetails(experience)}<div class="v12-row-actions">${experience.status !== 'retired' ? `<button class="text-button" data-experience-evaluate="${esc(experience.id)}" data-version="${experience.revision}" ${busy ? 'disabled' : ''}>${t('隔离评估','Evaluate offline')}</button>` : ''}${canAdopt(experience) ? `<button class="text-button" data-experience-adopt="${esc(experience.id)}" data-version="${experience.revision}" ${busy ? 'disabled' : ''}>${t('采纳经验','Adopt')}</button>` : ''}${['candidate', 'active'].includes(experience.status) && experience.effect?.type === 'draft_format' ? `<button class="text-button" data-experience-trial="${esc(experience.id)}">${t('监督试用', 'Try under review')}</button>` : ''}${experience.status === 'candidate' && experience.kind === 'execution_hint' && experience.scope_type !== 'global' && experience.effect?.type === 'draft_format' && experience.verified_success_count >= state.durable.learning.mechanicalSuccesses && !experience.negative_evidence_count ? `<button class="text-button" data-experience-promote="${esc(experience.id)}" data-version="${experience.revision}">${t('启用经验', 'Activate')}</button>` : ''}${experience.status === 'needs_revalidation' ? `<button class="text-button" data-experience-revalidate="${esc(experience.id)}" data-version="${experience.revision}">${t('重新验证', 'Revalidate')}</button>` : ''}<button class="text-button" data-experience-retire="${esc(experience.id)}" data-version="${experience.revision}">${t('停用', 'Retire')}</button><button class="text-button" data-forget-kind="experience" data-forget-id="${esc(experience.id)}">${t('忘记', 'Forget')}</button></div></div></article>`).join('')}${!current.length ? `<p class="muted">${t('经验会从可追溯的反馈与结果中积累。', 'Experiences accumulate from traceable feedback and outcomes.')}</p>` : ''}`);
    const durable = state.durable;
    update('durableSettingsContent', `<div class="v12-heading"><h2>${t('提醒与学习', 'Notifications & learning')}</h2></div><form data-attention-settings><label>${t('每小时最多主动询问', 'Interactive notifications per hour')}<input type="number" name="hourly" min="0" max="100" value="${durable.attention.policy.maxInteractivePerHour}"></label><label>${t('最短提醒间隔（分钟）', 'Minimum interruption interval (minutes)')}<input type="number" name="interval" min="0" max="1440" value="${durable.attention.policy.minIntervalMs / 60000}"></label><label>${t('免打扰开始', 'Quiet hours start')}<input type="number" name="quietStart" min="0" max="23" placeholder="22" value="${durable.attention.policy.quietHours?.startHour ?? ''}"></label><label>${t('结束', 'End')}<input type="number" name="quietEnd" min="0" max="23" placeholder="8" value="${durable.attention.policy.quietHours?.endHour ?? ''}"></label><button type="submit" class="secondary-button" ${busy ? 'disabled' : ''}>${t('保存', 'Save')}</button></form><label class="v12-toggle"><input type="checkbox" data-learning-promotion data-version="${durable.learning.version}" ${durable.learning.autoPromote ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>${t('达到证据门槛后，自动启用低风险格式经验', 'Activate low-risk formatting guidance after the evidence threshold')}</span></label><details data-preserve="v12-execution-status"><summary>${t('运行记录', 'Execution status')}</summary><p class="muted">SQLite ${esc(durable.storage.sqliteVersion)} · WAL · FULL</p>${durable.jobs.filter(job => ['recovery_required', 'dead'].includes(job.state)).map(job => `<p class="v12-status-row">${esc(job.job_type)} · ${esc(job.state)}${job.last_error_class ? ` · ${esc(job.last_error_class)}` : ''}</p>`).join('') || `<p class="muted">${t('没有待恢复的任务。', 'No jobs need recovery.')}</p>`}${(durable.deletion || []).map(request => `<div class="v12-status-row"><span>${t('删除仍待完成', 'Deletion pending')}: ${request.status.pendingExternal.length ? t('外部操作待核验', 'External result unresolved') : t('保留数据待清理', 'Retention cleanup pending')}</span> <button class="text-button" data-deletion-retry="${esc(request.id)}">${t('重新检查', 'Check again')}</button></div>`).join('')}${(durable.executions || []).filter(execution => ['unknown', 'accepted', 'dispatched'].includes(execution.status)).map(execution => `<div class="v12-status-row"><span>${esc(execution.provider)} · ${esc(execution.action_family)} · ${esc(execution.status)}</span> <button class="text-button" data-execution-reconcile="${esc(execution.id)}">${t('核验结果', 'Reconcile result')}</button></div>`).join('')}</details>`);
    const digests = durable.attention.digests || [];
    byId('durableDigestContent').hidden = !digests.length;
    update('durableDigestContent', digests.length ? `<div class="v12-heading"><h2>${t('汇总待看', 'Queued digest')}</h2><small>${t('提醒预算允许后送达', 'Delivered when your interruption budget allows')}</small></div>${digests.map(group => `<article class="v12-row"><div><p>${esc(group.headlines[0])}</p><small>${group.ids.length} ${t('项相关变化', 'related updates')}</small>${(group.taskIds || []).map(id => `<button class="text-button" data-digest-task="${esc(id)}">${t('查看任务', 'View task')}</button>`).join('')}</div></article>`).join('')}` : '');
  }
  function section(id, after) {
    if (!byId(id) && byId(after)) { const element = document.createElement('section'); element.id = id; element.className = 'v12-section'; byId(after).after(element); }
    return byId(id);
  }
  const sourceLabel = id => ({ google: 'Gmail / Drive', microsoft: 'Outlook', github: 'GitHub', slack: 'Slack', notion: 'Notion', local_files: t('本地文件', 'Local files'), apple_notes: 'Apple Notes', apple_calendar: 'Apple Calendar', apple_mail: 'Apple Mail', apple_contacts: 'Apple Contacts' })[id] || id;
  const eventLabel = type => ({ 'email.received': t('新消息', 'New message'), 'document.modified': t('文档变化', 'Document changes'), 'issue.updated': t('Issue 更新', 'Issue updates'), 'pull_request.updated': t('PR 更新', 'Pull request updates'), 'content.changed': t('仓库内容变化', 'Repository changes'), 'workflow.updated': t('工作流结果', 'Workflow results'), 'task.observed': t('待办变化', 'To-do changes') })[type] || type;
  const intentStatus = value => ({ active: t('已启用', 'Active'), paused: t('已暂停', 'Paused'), disabled: t('已关闭', 'Disabled'), proposed: t('待确认', 'Proposed'), expired: t('已到期', 'Expired') })[value] || value;
  const parameterLabel = value => ({ pairWindowMs: t('关联时间范围（毫秒）', 'Association window (ms)'), maxPairCandidates: t('最大关联候选数', 'Association candidate limit'), maxInteractivePerHour: t('每小时主动提醒上限', 'Hourly interruption limit'), minIntervalMs: t('最短提醒间隔（毫秒）', 'Minimum interruption interval (ms)') })[value] || value;
  function renderIntentControls(state) {
    if (section('standingIntentContent', 'policyContent')) update('standingIntentContent', `<div class="v12-heading"><h2>${t('持续留意', 'Keep watching')}</h2><button class="secondary-button" data-durable-add="intent">${t('添加关注目标', 'Add a standing goal')}</button></div>${(state.durable.intents || []).map(intent => `<article class="v12-row"><div><small>${esc(intentStatus(intent.status))} · ${esc(intent.prefilter.connectorIds.map(sourceLabel).join(', '))}</small><h3>${esc(intent.description)}</h3><p>${esc(intent.desiredOutcome)}</p><small>${intent.autonomy.maxAutonomy === 'prepare' ? t('整理来源简报供审阅', 'Prepare a source brief for review') : t('持续观察', 'Observe changes')} · ${t('不执行外部写入', 'No external writes')}</small></div><div class="v12-row-actions">${['active', 'paused'].includes(intent.status) ? `<button class="text-button" data-intent-edit="${esc(intent.id)}">${t('编辑', 'Edit')}</button><button class="text-button" data-intent-transition="${esc(intent.id)}" data-operation="${intent.status === 'paused' ? 'resume' : 'pause'}" data-version="${intent.version}">${intent.status === 'paused' ? t('恢复', 'Resume') : t('暂停', 'Pause')}</button><button class="text-button" data-intent-transition="${esc(intent.id)}" data-operation="disable" data-version="${intent.version}">${t('关闭', 'Disable')}</button>` : ''}</div></article>`).join('') || `<p class="muted">${t('告诉我需要持续留意的目标、来源和变化。', 'Choose a goal, source and changes to watch.')}</p>`}`);
    if (section('rsiProposalContent', 'durableSettingsContent')) update('rsiProposalContent', `<div class="v12-heading"><h2>${t('经过对照验证的调整', 'Evaluated adjustments')}</h2></div>${(state.durable.rsi || []).map(proposal => `<article class="v12-row"><div><strong>${esc(parameterLabel(proposal.parameter))}</strong><p>${esc(proposal.previous)} → ${esc(proposal.proposed)} · ${esc(intentStatus(proposal.status))}</p><small>${t('仅验证本地策略，不代表整体任务效果', 'Local policy evaluation; general task value is unverified')}</small></div>${['proposed', 'approved'].includes(proposal.status) ? `<button class="secondary-button" data-rsi-id="${esc(proposal.id)}" data-operation="${proposal.status === 'proposed' ? 'apply' : 'rollback'}" data-version="${proposal.version}">${proposal.status === 'proposed' ? t('应用调整', 'Apply adjustment') : t('回滚', 'Roll back')}</button>` : ''}</article>`).join('') || `<p class="muted">${t('暂无通过对照验证的调整。', 'No evaluated adjustments yet.')}</p>`}`);
  }
  function editIntent(intent = null) {
    action = { kind: 'intent', intent };
    const sources = ['google', 'microsoft', 'github', 'slack', 'notion', 'local_files', 'apple_notes', 'apple_calendar', 'apple_mail', 'apple_contacts'];
    const types = ['email.received', 'document.modified', 'issue.updated', 'pull_request.updated', 'content.changed', 'workflow.updated', 'task.observed'];
    show(t('持续留意一个目标', 'Watch a standing goal'), `<form data-durable-form="intent"><label>${t('名称', 'Name')}<input name="description" maxlength="500" required value="${esc(intent?.description || '')}"></label><label>${t('想达到什么结果', 'Desired outcome')}<textarea name="outcome" maxlength="300" required>${esc(intent?.desiredOutcome || '')}</textarea></label><label>${t('来源', 'Source')}<select name="connector">${sources.map(id => `<option value="${id}" ${intent?.prefilter.connectorIds.includes(id) ? 'selected' : ''}>${esc(sourceLabel(id))}</option>`).join('')}</select></label><label>${t('留意哪些变化', 'Event type')}<select name="eventType">${types.map(type => `<option value="${type}" ${intent?.prefilter.eventTypes.includes(type) ? 'selected' : ''}>${esc(eventLabel(type))}</option>`).join('')}</select></label><label>${t('必须包含的关键词（空格分隔）', 'Required keywords (space separated)')}<input name="tokens" value="${esc(intent?.prefilter.tokens.join(' ') || '')}" maxlength="300"></label><label>${t('进一步匹配条件（可选）', 'Additional matching condition (optional)')}<textarea name="predicate" maxlength="300">${esc(intent?.predicate || '')}</textarea></label><label>${t('匹配后', 'When matched')}<select name="autonomy"><option value="observe">${t('观察并记录', 'Observe and record')}</option><option value="prepare" ${intent?.autonomy.maxAutonomy === 'prepare' ? 'selected' : ''}>${t('整理来源简报供审阅', 'Prepare a source brief for review')}</option></select></label>${actions(t('保存关注目标', 'Save standing goal'))}</form>`);
  }
  function show(title, html) { byId('durableDialogTitle').textContent = title; byId('durableDialogBody').innerHTML = html; if (!dialog.open) dialog.showModal(); dialog.querySelector('input:not([type=hidden]),textarea,select')?.focus(); }
  const actions = submit => `<p class="v12-error" id="durableFormError" role="alert"></p><div class="v12-form-actions"><button type="button" class="secondary-button" data-durable-close>${t('取消', 'Cancel')}</button><button type="submit" class="primary-button">${submit}</button></div>`;
  function add(kind) {
    action = { kind };
    show(t('添加规则', 'Add rule'), `<form data-durable-form="policy"><label>${t('工作来源', 'Work source')}<select name="provider"><option value="google">Google</option><option value="microsoft">Outlook</option><option value="github">GitHub</option><option value="slack">Slack</option><option value="notion">Notion</option><option value="local_files">${t('本地文件', 'Local files')}</option><option value="apple_notes">Apple Notes</option><option value="apple_calendar">Apple Calendar</option><option value="apple_mail">Apple Mail</option><option value="apple_contacts">Apple Contacts</option></select></label><label>${t('匹配', 'Match')}<select name="match" data-policy-match><option value="sender">${t('指定邮箱或账号', 'Exact mailbox or account')}</option><option value="all">${t('该来源全部任务', 'All work from this source')}</option></select></label><label data-policy-identity>${t('邮箱或账号', 'Mailbox or account')}<input name="identity" autocomplete="off" maxlength="200" placeholder="li@example.com" required></label><label>${t('执行规则', 'Behavior')}<select name="effect"><option value="priority">${t('优先处理', 'Prioritize')}</option><option value="suppress">${t('不主动跟进', 'Do not activate')}</option><option value="require_review">${t('继续前先让我确认', 'Require my review')}</option><option value="digest">${t('合并提醒', 'Digest notifications')}</option></select></label><label class="v12-toggle" data-policy-identity><input name="confirmed" type="checkbox" required><span>${t('确认这是要匹配的准确身份', 'This is the exact identity to match')}</span></label>${actions(t('保存规则', 'Save rule'))}</form>`);
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
    if (button.dataset.durableAdd === 'intent') return editIntent();
    if (button.dataset.intentEdit) return editIntent(context().state.durable.intents.find(intent => intent.id === button.dataset.intentEdit));
    if (button.dataset.intentTransition) { void mutate(`/api/standing-intents/${encodeURIComponent(button.dataset.intentTransition)}/${button.dataset.operation}`, { expectedVersion: Number(button.dataset.version) }).catch(() => {}); return; }
    if (button.dataset.rsiId) { void mutate(`/api/activation/rsi/${encodeURIComponent(button.dataset.rsiId)}/${button.dataset.operation}`, { expectedVersion: Number(button.dataset.version) }).catch(() => {}); return; }
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
    if (button.dataset.experienceCaseAdd) { void addCase(button.dataset.experienceCaseAdd); return; }
    if (button.dataset.experiencePromote || button.dataset.experienceRevalidate || button.dataset.experienceRetire) {
      const id = button.dataset.experiencePromote || button.dataset.experienceRevalidate || button.dataset.experienceRetire;
      const operation = button.dataset.experiencePromote ? 'promote' : button.dataset.experienceRevalidate ? 'revalidate' : 'retire';
      void mutate(`/api/experiences/${encodeURIComponent(id)}/${operation}`, { expectedRevision: Number(button.dataset.version) }).catch(() => {}); return;
    }
    if (button.dataset.experienceEvaluate) {
      void experienceAction(button.dataset.experienceEvaluate, 'evaluate', { expectedRevision: Number(button.dataset.version) }); return;
    }
    if (button.dataset.experienceAdopt) {
      void experienceAction(button.dataset.experienceAdopt, 'adopt', { expectedRevision: Number(button.dataset.version) }); return;
    }
    if (button.dataset.experienceRollback) {
      void experienceAction(button.dataset.experienceRollback, 'rollback', { expectedRevision: Number(button.dataset.version), targetRevision: Number(button.dataset.target) }); return;
    }
    if (button.dataset.experienceTrial) {
      action = { kind: 'trial', experienceId: button.dataset.experienceTrial };
      const tasks = (context().state.tasks || []).filter(task => task.draft && !task.action && !task.control?.paused);
      show(t('监督试用', 'Try under review'), `<form data-durable-form="trial"><label>${t('选择已有草稿', 'Choose an existing draft')}<select name="taskId" required>${tasks.map(task => `<option value="${esc(task.id)}">${esc(task.subject)}</option>`).join('')}</select></label><p class="muted">${t('先更新草稿，由你检查后决定是否发送。', 'Prepare a draft for your review before any send.')}</p>${tasks.length ? actions(t('准备草稿', 'Prepare draft')) : `<p>${t('当前没有可试用的草稿。', 'No draft is currently available.')}</p><button type="button" class="secondary-button" data-durable-close>${t('关闭', 'Close')}</button>`}</form>`);
    }
  });
  document.addEventListener('toggle', event => {
    const element = event.target;
    if (!element?.matches?.('details[data-experience-eval]')) return;
    const id = element.dataset.experienceEval;
    if (!element.open) { if (openDetails === id) openDetails = ''; return; }
    openDetails = id;
    if (!details.has(id)) void loadDetail(id);
  }, true);
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
      if (kind === 'intent') {
        const original = action.intent;
        const body = { description: data.get('description'), desiredOutcome: data.get('outcome'), predicate: data.get('predicate') || null,
          prefilter: { connectorIds: [data.get('connector')], eventTypes: [data.get('eventType')], roles: original?.prefilter.roles || ['DIRECT_ACTOR', 'UNKNOWN'], accountIds: original?.prefilter.accountIds || [], tokens: String(data.get('tokens')).split(/\s+/u).filter(Boolean) },
          autonomy: { maxAutonomy: data.get('autonomy') }, prohibited: ['external_write'], confirmed: true,
          ...(original ? { expectedVersion: original.version, scope: original.scope, budget: original.budget, expiresAt: original.expiresAt } : {}) };
        await mutate(original ? `/api/standing-intents/${encodeURIComponent(original.id)}` : '/api/standing-intents', body);
      }
      if (kind === 'draft') { await mutate(`/api/tasks/${encodeURIComponent(action.taskId)}/draft`, { body: data.get('body'), reviewToken: action.reviewToken }); }
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
      if (kind === 'case') {
        const features = {};
        for (const line of String(data.get('features') || '').split('\n').map(value => value.trim()).filter(Boolean)) {
          const split = line.indexOf('=');
          if (split < 1) throw new Error(t('每行事实必须是 feature=value。', 'Each fact line must be feature=value.'));
          const key = line.slice(0, split).trim(), raw = line.slice(split + 1).trim();
          features[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
        }
        const winner = data.get('applies') === 'false' ? 'none' : String(data.get('winner'));
        const type = action.caseSetType || experiences.find(item => item.id === action.experienceId)?.effect?.type;
        const sourceKind = String(data.get('sourceKind') || ''), sourceId = String(data.get('sourceId') || '').trim();
        if (Boolean(sourceKind) !== Boolean(sourceId)) throw new Error(t('来源类型和来源 ID 必须同时填写。', 'Source kind and source id must be provided together.'));
        const nextCase = { id: `case-${Date.now().toString(36)}`, scope: [{ type: String(data.get('scopeType')), key: String(data.get('scopeKey') || '').trim() }], features,
          expected: { applies: data.get('applies') === 'true', winner, ...(winner === 'candidate' ? { effect: caseEffect(data, 'expected', type) } : {}) },
          ...(winner === 'user' ? { userEffect: caseEffect(data, 'user', type) } : {}),
          ...(sourceKind ? { source: { kind: sourceKind, id: sourceId } } : {}) };
        const experience = action && experiences.find(item => item.id === action.experienceId);
        const submission = trialCaseSubmission({ detail: action && details.get(action.experienceId), experience, action, nextCase });
        if (!submission) throw new Error(t('已保存场景尚未加载或已变化，请重新打开后再保存；不会覆盖最新场景集。',
          'Saved cases are not loaded or have changed. Reopen and save again; the latest set will not be overwritten.'));
        await mutate(`/api/experiences/${encodeURIComponent(action.experienceId)}/cases`, submission);
        notify(t('场景已保存；请重新评估。', 'Case saved. Evaluate again.'));
        await loadDetail(action.experienceId);
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
