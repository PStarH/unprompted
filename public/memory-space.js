import { getLocale } from './i18n.js';
import { readLocal, writeLocal } from './ux-state.js';
import { buildExplorerGraph } from './memory-space-model.js';
import { workspaceIcon } from './workspace.js';

const t = (zh, en) => getLocale() === 'en' ? en : zh;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const byId = id => document.getElementById(id);
const statusLabel = status => ({ active: t('当前有效', 'Active'), disabled: t('已停用', 'Disabled'), archived: t('已归档', 'Archived'), deleted: t('已删除', 'Deleted'), superseded: t('已被更正', 'Superseded'), expired: t('已到期', 'Expired') })[status] || status;
const relationEvidence = relation => Array.isArray(relation.evidence) ? relation.evidence : [relation.evidenceKind, relation.evidenceRef].filter(Boolean);
const relationLabel = kind => ({ belongs_to: t('同一范围', 'Same scope'), mentions: t('提及', 'Mentions'), related_to: t('已确认的关联', 'Confirmed connection'), derived_from: t('来源关联', 'Derived from'), supersedes: t('更正为', 'Supersedes'), contradicts: t('存在矛盾', 'Contradicts'), shared_scope: t('同一范围', 'Same scope'), shared_source_task: t('同一来源任务', 'Same source task'), shared_evidence: t('共同依据', 'Shared evidence') })[kind] || kind;
const relationDescription = (relation, memoryId) => relation.kind === 'supersedes' ? relation.from === memoryId ? t('替代了', 'Replaces') : t('已被替代为', 'Replaced by') : relationLabel(relation.kind);
const changeLabel = kind => kind?.startsWith('agent_') ? `${t('Agent 更新', 'Agent update')} · ${changeLabel(kind.slice(6))}` : ({ remember: t('记住', 'Remembered'), 'restore-delete': t('恢复删除的记忆', 'Restored deleted memory'), created: t('创建', 'Created'), current_snapshot: t('迁移时的当前快照', 'Current snapshot at migration'), edit: t('编辑', 'Edited'), disable: t('停用', 'Disabled'), reactivate: t('重新启用', 'Reactivated'), archive: t('归档', 'Archived'), restore: t('恢复', 'Restored'), delete: t('删除', 'Deleted'), supersede: t('更正', 'Superseded'), 'restore-version': t('恢复先前内容', 'Restored earlier content'), restore_version: t('恢复先前内容', 'Restored earlier content'), validity: t('修改有效期', 'Validity changed') })[kind] || kind;
const dateLabel = value => { if (!value) return t('未记录', 'Not recorded'); const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(); };
const scopeLabel = memory => memory.scopeType === 'global' || memory.scopeKey === '*' ? t('全局', 'Global') : memory.scope?.entity ? [memory.scope.entity, memory.scope.deliverable].filter(Boolean).join(' · ') : memory.scopeKey || t('未指定范围', 'Unscoped');
const datetimeValue = value => { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 16); };

/** One controller owns filtering, focus and mutations for both Memory views. */
export function createMemorySpace({ context, update, post, applyState, notify, go }) {
  let recordsTotal = 0;
  let lastQuery = null;
  let records = [], loadedRevision = null, loading = false, loadSequence = 0, browseSequence = 0;
  let query = '', kind = 'all', scope = 'all', status = 'remembered', sort = readLocal('unprompted:memory-space-sort', 'recent');
  let view = 'results', pageSize = 5;
  let focusId = null, referenceFocus = null, detail = null, detailId = null, detailError = null;
  let centerId = null, graphData = null, history = [], depth = 1, edgeId = null, graphSequence = 0, exploring = false;
  let graphWidth = 800, graphHeight = 500, undo = null, loadError = null, searchTimer;
  const cache = new Map();
  let editing = null, composing = false, busy = false, action = null, workspace = null;
  const dialog = byId('durableDialog');

  function current() { return cache.get(focusId) || null; }
  function remember(memory) { if (memory) cache.set(memory.id, { ...cache.get(memory.id), ...memory }); }
  function rememberDetail(result) { remember(result.memory); for (const memory of result.context?.memories || []) remember(memory); }
  function visible() { return !byId('viewMemory').hidden; }
  async function request(path, options = {}) {
    const response = await fetch(path, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(result.error || t('记忆暂时无法读取。', 'Memory is temporarily unavailable.')); error.code = result.code; error.status = response.status; throw error; }
    return result;
  }
  async function loadDetail(id) {
    const sequence = ++loadSequence;
    try {
      const result = await request(`/api/memory-space/${encodeURIComponent(id)}`);
      if (sequence !== loadSequence || focusId !== id) return;
      rememberDetail(result); detail = result; detailId = id; detailError = null; render();
    } catch (error) {
      if (focusId !== id) return;
      if (error.status === 404) {
        cache.delete(id); closeInspector({ restore: false });
        // Forget must clear cached graph content as well as the selected detail.
        centerId = null; graphData = null; history = []; view = 'results';
      } else detailError = error.message;
      render();
    }
  }
  async function load({ force = false } = {}) {
    const state = context().state;
    if (!state) return;
    if (loading) { if (force) browseSequence++; return; }
    const revision = String(state.revision ?? 0);
    if (!force && loadedRevision === revision) return;
    loading = true; render();
    const sequence = ++browseSequence;
    const parameters = new URLSearchParams({ q: query, kind, status, limit: '500' });
    if (scope !== 'all') parameters.set('scope', scope);
    if (centerId) parameters.set('focus', centerId);
    try {
      const result = await request(`/api/memory-space?${parameters}`);
      if (sequence !== browseSequence) return;
      records = result.records || []; records.forEach(remember); lastQuery = query; recordsTotal = result.total ?? records.length; loadError = null;
      loadedRevision = revision;
      // Selection and exploration are independent of the search result window.
      render();
      if (focusId) void loadDetail(focusId);
    } catch (error) { loadError = error.message; loadedRevision = revision; render(); }
    finally { loading = false; if (sequence !== browseSequence) void load({ force: true }); else render(); }
  }

  const kindLabel = value => ({ memory: t('记忆', 'Memory'), project: t('项目', 'Project'), person: t('人物', 'Person'), entity: t('实体', 'Entity'), task: t('来源任务', 'Source task') })[value] || value;
  const edgeLabel = edge => ({ in_project: t('属于此项目', 'Applies to project'), applies_to_entity: t('适用于此实体', 'Applies to this entity'), about_person: t('关于此人', 'About this person'), remembered_from: t('记住自此任务', 'Remembered from task'), supersedes: t('替代旧记忆', 'Replaces older memory'), derived_from: t('源于此记忆', 'Derived from memory'), related_to: t('已确认的关联', 'Confirmed connection'), contradicts: t('存在冲突', 'Conflicts with'), mentions: t('明确提及', 'Explicitly mentions'), belongs_to: t('已记录的归属', 'Recorded membership') })[edge.kind] || relationLabel(edge.kind);
  function evidenceExplanation(edge) {
    return ({ direct_correction: t('你明确更正了旧记忆，较新的版本替代了它。', 'You explicitly corrected the older memory. The newer memory replaces it.'), user_confirmed: t('这是你明确确认并保存的关系。', 'You explicitly confirmed and saved this relationship.'), saved_scope: t('保存时明确指定了这个适用范围。', 'This applicability scope was explicitly saved with the memory.'), recorded_task: t('来源记录将这条记忆关联到这个原始任务。', 'The origin record links this memory to the original task.'), shared_task: t('两条记忆的来源记录指向同一个具体任务。', 'Both origin records point to the same specific task.'), shared_evidence: t('两条记忆引用同一份已记录的上下文证据。', 'Both memories cite the same recorded contextual evidence.') })[edge.evidenceKind] || t('这条关系有独立保存的依据；相似文字不会自动建立关系。', 'This relationship has recorded evidence. Similar wording does not create a connection.');
  }
  function graphModel() { return buildExplorerGraph(graphData, { width: graphWidth, height: graphHeight, maxNodes: graphWidth < 450 ? 5 : 9 }); }
  function renderGraph(graph) {
    if (!graphData) return `<p class="memory-progress" role="status">${t('正在读取相关上下文…', 'Loading recorded context…')}</p>`;
    const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
    const lines = graph.edges.map(edge => {
      const from = nodesById.get(edge.from), to = nodesById.get(edge.to);
      return `<g class="memory-space-link${edge.id === edgeId ? ' is-selected' : ''}" role="button" tabindex="0" data-memory-edge="${esc(edge.id)}" aria-label="${esc(`${from.label} · ${edgeLabel(edge)} · ${to.label}`)}" aria-pressed="${edge.id === edgeId}"><line class="memory-link-hit" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/><line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/><text class="memory-link-label" x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 - 7}">${esc(edgeLabel(edge))}</text></g>`;
    }).join('');
    const nodes = graph.nodes.map(node => `<button type="button" class="memory-space-node${node.id === focusId || node.id === referenceFocus?.id ? ' is-focused' : ''}${node.id === centerId ? ' is-center' : ''}" data-node-kind="${node.kind}" ${node.kind === 'memory' ? `data-memory-focus="${esc(node.id)}"` : `data-memory-reference="${esc(node.id)}"`} style="left:${node.x / graphWidth * 100}%;top:${node.y / graphHeight * 100}%" aria-pressed="${node.id === focusId || node.id === referenceFocus?.id}" aria-label="${esc(`${kindLabel(node.kind)}: ${node.label}`)}"><small>${node.id === centerId ? t('探索中心', 'Exploration center') : kindLabel(node.kind)}</small><span>${esc(node.label)}</span></button>`).join('');
    return `<section class="memory-space-canvas" aria-label="${t('局部关系图', 'Local relationship graph')}" data-memory-center="${esc(centerId)}"><header class="memory-graph-heading"><div><span>${t('围绕这条记忆', 'Exploring around')}</span><strong>${esc((graphData.memory.content || graphData.memory.text).slice(0, 100))}</strong></div><button class="text-button" data-memory-back ${history.length ? '' : 'disabled'}>${workspaceIcon('back', 14)}${t('上一个探索中心', 'Previous center')}</button></header><div class="memory-space-graph"><svg viewBox="0 0 ${graphWidth} ${graphHeight}" aria-label="${t('选择连线查看依据', 'Select a connection for its evidence')}">${lines}</svg>${nodes}</div><footer class="memory-graph-footer"><span>${t('选择节点只查看详情，不改变探索中心。', 'Selecting a node opens its details. The exploration center stays here.')}</span><button class="text-button" data-memory-expand ${depth >= 2 || exploring ? 'disabled' : ''}>${t('展开一层关系', 'Expand one more level')}</button></footer>${!graph.edges.length ? `<p class="memory-space-no-edges">${t('没有已记录的有效关联。这不影响搜索、查看或更正这条记忆。', 'No evidenced connections are recorded. You can still find, inspect and correct this memory.')}</p>` : ''}${graph.edges.length ? `<details class="memory-space-connections"><summary>${t('关系及依据', 'Connections & evidence')}</summary><div class="memory-space-edge-list">${graph.edges.map(edge => `<button class="memory-space-edge" data-memory-edge="${esc(edge.id)}">${esc(edgeLabel(edge))}<small>${esc(nodesById.get(edge.from).label.slice(0, 45))} → ${esc(nodesById.get(edge.to).label.slice(0, 45))}</small></button>`).join('')}</div></details>` : ''}${graph.hidden ? `<p class="memory-space-overflow">${t('还有已记录的上下文。选择记忆后可明确从那里继续探索。', 'More recorded context is available. Select a memory and choose Explore from here to continue.')}</p>` : ''}</section>`;
  }
  function sourceLabel(memory) {
    return memory.sourceTasks?.[0]?.subject || memory.sourceTasks?.[0]?.title || memory.source?.title || (memory.origin === 'demo_preview' ? t('示例记录', 'Sample record') : memory.sourceKind === 'user_instruction' ? t('你保存的说明', 'Your saved instruction') : memory.sourceKind === 'task_memory' && memory.taskId ? t('任务中的明确要求', 'An explicit task instruction') : t('来源未记录', 'Origin not recorded'));
  }
  function matchLabel(reason) {
    const labels = { time: t('记住的时间符合', 'Remembered during'), content: t('内容包含', 'Text mentions'), project: t('适用范围匹配', 'Saved scope matches'), source: t('来源匹配', 'Origin matches'), correction: t('有更正记录', 'Has a recorded correction'), preference: t('明确保存的偏好', 'Saved preference'), related: t('已确认的关联记忆包含', 'A confirmed related memory mentions') };
    return `${labels[reason.kind] || ''}${['correction', 'preference'].includes(reason.kind) ? '' : ` “${reason.term}”`}`;
  }
  function memoryRow(memory) {
    const excerpt = memory.match?.excerpt || memory.content || memory.text;
    const reasons = memory.match?.reasons || [];
    const groupedReasons = [...new Map(reasons.map(reason => [reason.kind, { ...reason, term: reasons.filter(item => item.kind === reason.kind).map(item => item.term).join(', ') }])).values()];
    return `<article class="memory-search-result${memory.id === focusId ? ' is-focused' : ''}" data-memory-id="${esc(memory.id)}"><button class="memory-result-open" data-memory-focus="${esc(memory.id)}" aria-pressed="${memory.id === focusId}"><span class="memory-result-content">${esc(excerpt)}</span><span class="memory-result-source">${esc(sourceLabel(memory))} · ${esc(new Date(memory.createdAt).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN'))}${memory.status && memory.status !== 'active' ? ` · ${esc(statusLabel(memory.status))}` : ''}</span>${query && reasons.length ? `<span class="memory-match-reasons">${esc(groupedReasons.slice(0, 2).map(matchLabel).join(' · '))}</span>` : ''}<span class="memory-result-arrow" aria-hidden="true">↗</span></button></article>`;
  }
  function empty() {
    return `<section class="memory-empty"><h2>${query || scope !== 'all' ? t('没有找到相符的记忆', 'No matching memories') : t('这里会记录值得记住的事', 'A place for what matters to remember')}</h2><p>${query ? t('试试金额、人名、项目名或来源任务中的词。也可以缩短问题。', 'Try an amount, person, project, or words from the source task. A shorter query may help.') : t('Agent 会在工作中积累你选择记住的信息。你可以随时来这里寻找来源或更正内容。', 'As you work, the Agent keeps what you choose to remember. Return here to find its source or correct it.')}</p>${query || scope !== 'all' || status !== 'remembered' || kind !== 'all' ? `<button class="text-button" data-memory-clear>${t('清除搜索与筛选', 'Clear search and filters')}</button>` : ''}</section>`;
  }
  function results() {
    if (loadError) return '';
    if (loading && lastQuery !== query) return `<p class="memory-progress" role="status">${t('正在查找记忆…', 'Finding memories…')}</p>`;
    if (!records.length) return empty();
    const items = [...records];
    if (!query && sort === 'oldest') items.reverse();
    if (!query && sort === 'content') items.sort((a, b) => (a.content || a.text).localeCompare(b.content || b.text));
    return `<section class="memory-results" aria-label="${t('记忆搜索结果', 'Memory search results')}"><header class="memory-results-heading"><h2>${query ? t('搜索结果', 'Search results') : t('最近记住', 'Recently remembered')}</h2><span role="status">${query ? recordsTotal : Math.min(pageSize, records.length)}${t(' 条', query && recordsTotal === 1 ? ' result' : query ? ' results' : ' recent memories')}${recordsTotal > records.length ? t('，请缩小搜索范围', '; narrow the query for more') : ''}</span></header>${items.slice(0, pageSize).map(memoryRow).join('')}${records.length > pageSize ? `<button class="memory-more text-button" data-memory-more>${t('显示更多记忆', 'Show more memories')}</button>` : ''}</section>`;
  }
  function inspector(memory) {
    if (!memory) return '';
    const loaded = detailId === memory.id ? detail : null;
    const lifecycle = memory.lifecycleState || 'active';
    const readonly = memory.readonly || !context().state?.durable;
    const editable = ['active', 'disabled'].includes(lifecycle);
    const agentOrigin = loaded?.versions?.some(version => version.changeKind === 'agent_remember');
    const userEdited = ['edit', 'restore-version', 'restore_version'].includes(loaded?.versions?.[0]?.changeKind);
    const workUsage = [...new Map([...(loaded?.provenance?.usage || [])].reverse().map(run => [run.taskId, run])).values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const origins = memory.origin === 'demo_preview' ? t('示例记录，不代表你的真实信息。', 'A sample record, not your personal information.') : memory.sourceKind === 'user_instruction' ? t('你明确要求 Agent 记住这条说明。', 'You explicitly asked the Agent to remember this instruction.') : memory.sourceKind === 'task_memory' ? t('你在任务中选择了“记住同类”的要求。', 'You chose to remember this instruction for similar tasks.') : memory.sourceKind === 'event' && agentOrigin ? userEdited ? t('Agent 最初从任务来源中记住了这条信息，你随后更正了它。', 'The Agent originally remembered this from the task source; you have since corrected it.') : t('Agent 从任务来源中保存了这段原文。', 'The Agent saved this quotation from the task source.') : memory.sourceKind === 'task_direction' ? t('Agent 根据你在任务中的指示记住或更正了这条信息。', 'The Agent remembered or corrected this information from your task direction.') : t('这条记忆保留了原有来源；未记录的原因不会被推测补充。', 'The original provenance is preserved. An unrecorded reason is not inferred.');
    const editor = editing?.id === memory.id ? `<form class="memory-edit-form" data-memory-edit="${esc(memory.id)}"><label>${t('内容', 'Content')}<textarea name="text" maxlength="2000" required>${esc(editing.text)}</textarea></label><label>${t('类型', 'Kind')}<select name="memoryKind"><option value="fact" ${editing.memoryKind === 'fact' ? 'selected' : ''}>${t('事实', 'Fact')}</option><option value="preference" ${editing.memoryKind === 'preference' ? 'selected' : ''}>${t('偏好', 'Preference')}</option></select></label><label>${t('有效期（可选）', 'Valid until (optional)')}<input type="datetime-local" name="validUntil" value="${esc(datetimeValue(editing.validUntil))}"></label><p data-memory-edit-error role="alert"></p><div class="actions"><button type="button" class="text-button" data-memory-cancel>${t('取消', 'Cancel')}</button><button type="submit" class="primary-button" ${busy ? 'disabled' : ''}>${t('保存', 'Save')}</button></div></form>` : `<h2 class="memory-inspector-content" tabindex="-1">${esc(memory.content || memory.text)}</h2>`;
    const actions = editing?.id === memory.id ? '' : readonly ? `<p class="memory-readonly">${t('示例记录只读', 'Sample records are read-only')}</p>` : `<details class="memory-actions-menu" data-preserve="memory-actions-${esc(memory.id)}"><summary>${t('更正或管理这条记忆', 'Correct or manage this memory')}<span aria-hidden="true">···</span></summary><div>${editable ? `<button class="text-button" ${busy ? 'disabled' : ''} data-memory-operation="edit" data-memory-id="${esc(memory.id)}">${t('编辑内容', 'Edit content')}</button><button class="text-button" ${busy ? 'disabled' : ''} data-memory-operation="supersede" data-memory-id="${esc(memory.id)}">${t('用更正替代', 'Correct with replacement')}</button><button class="text-button" ${busy ? 'disabled' : ''} data-memory-operation="${lifecycle === 'active' ? 'disable' : 'reactivate'}" data-memory-id="${esc(memory.id)}">${lifecycle === 'active' ? t('停用', 'Disable') : t('重新启用', 'Reactivate')}</button><button class="text-button" ${busy ? 'disabled' : ''} data-memory-operation="archive" data-memory-id="${esc(memory.id)}">${t('归档', 'Archive')}</button>` : ['archived', 'deleted'].includes(lifecycle) ? `<button class="text-button" ${busy ? 'disabled' : ''} data-memory-operation="${lifecycle === 'deleted' ? 'restore-delete' : 'restore'}" data-memory-id="${esc(memory.id)}">${t('恢复', 'Restore')}</button>` : ''}${['active', 'disabled', 'archived'].includes(lifecycle) ? `<button class="text-button is-danger" ${busy ? 'disabled' : ''} data-memory-operation="delete" data-memory-id="${esc(memory.id)}">${t('删除（可恢复）', 'Delete (recoverable)')}</button>` : ''}<button class="text-button is-danger" data-forget-kind="${memory.sourceKind === 'task_memory' ? 'task_memory' : 'memory'}" data-forget-id="${esc(memory.id)}">${t('预览影响并永久忘记', 'Preview impact and forget permanently')}</button></div></details>`;
    const ctx = loaded?.context;
    const direct = (ctx?.relations || []).filter(edge => edge.from === memory.id || edge.to === memory.id);
    const related = direct.map(edge => {
      const id = edge.from === memory.id ? edge.to : edge.from, other = cache.get(id);
      return `<article class="memory-context-relation"><button class="text-button" data-memory-focus="${esc(id)}">${esc(relationDescription(edge, memory.id))} · ${esc(other?.content || other?.text || t('关联记忆', 'Related memory'))}</button><p>${esc(evidenceExplanation(edge))}</p></article>`;
    }).join('');
    const hasReferences = Boolean(ctx?.entities?.length || ctx?.sources?.length);
    const canExplore = Boolean(direct.length || hasReferences);
    const contextMarkup = `<section class="memory-inspector-context"><h3>${t('真正相关的上下文', 'Relevant context')}</h3>${loaded ? `${related}${!direct.length ? `<p class="muted">${hasReferences ? t('没有已确认关联的其他记忆。来源与适用范围见上方。', 'No other memories have a confirmed connection. Its origin and applicability are shown above.') : t('没有已记录的有效关联。它仍然可以被独立查找和更正。', 'No evidenced connections are recorded. This memory can still be found and corrected on its own.')}</p>` : ''}` : `<p class="muted" role="status">${detailError ? esc(detailError) : t('正在读取来源与关系…', 'Loading origin and relationships…')}</p>`}${canExplore ? `<button class="text-button memory-explore-action" data-memory-explore="${esc(memory.id)}" ${exploring || view === 'explore' && centerId === memory.id ? 'disabled' : ''}>${view === 'explore' && centerId === memory.id ? t('当前探索中心', 'Current exploration center') : view === 'explore' ? t('从这里继续探索', 'Explore from here') : t('探索这些关系', 'Explore relationships')}${workspaceIcon('arrow', 14)}</button>` : ''}</section>`;
    const activationUsage = [...new Map([...(loaded?.provenance?.activationUsage || [])].reverse().map(item => [`${item.kind}:${item.eventId}`, item])).values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const activationMarkup = activationUsage.length ? `<details class="memory-inspector-section" data-preserve="memory-activation-${esc(memory.id)}"><summary>${t('参与了哪些任务判断', 'Context used in work decisions')}</summary>${activationUsage.map(item => `<article class="memory-version-row"><p>${esc(item.subject || t('已观察到的来源', 'Observed source'))}</p><small>${esc(({ standing_intent_match: t('判断是否启动你设定的目标', 'Matching your standing goal'), situation_pair: t('理解来源之间的联系', 'Understanding connected sources'), situation_delta: t('理解已有工作的变化', 'Understanding changes to existing work') })[item.kind])} · ${esc(dateLabel(item.createdAt))}</small></article>`).join('')}</details>` : '';
    const versions = loaded?.versions || [];
    return `<aside class="memory-inspector" aria-label="${t('记忆详情', 'Memory details')}"><header><div><span>${memory.memoryKind === 'preference' ? t('偏好', 'Preference') : t('记忆', 'Memory')}</span><button class="icon-button" data-memory-close aria-label="${t('关闭详情', 'Close details')}">${workspaceIcon('close', 16)}</button></div></header><div class="memory-inspector-body">${editor}<dl class="memory-human-context"><div><dt>${t('为什么记住', 'Why it exists')}</dt><dd>${esc(origins)}</dd></div><div><dt>${t('来自哪里', 'Where it came from')}</dt><dd>${memory.sourceTasks?.length ? memory.sourceTasks.map(task => `<button class="text-button" data-open-task="${esc(task.id)}">${esc(task.subject || task.id)} ↗</button>`).join('') : esc(sourceLabel(memory))}</dd></div><div><dt>${t('适用范围', 'Where it applies')}</dt><dd>${esc(scopeLabel(memory))}${memory.status && memory.status !== 'active' ? ` · ${esc(statusLabel(memory.status))}` : ''}${memory.validUntil ? ` · ${t('有效期至', 'Until')} ${esc(dateLabel(memory.validUntil))}` : ''}</dd></div></dl>${actions}${contextMarkup}${workUsage.length ? `<section class="memory-inspector-context"><h3>${t('已用于这些工作', 'Recorded use in work')}</h3>${workUsage.map(run => `<button class="text-button" data-open-task="${esc(run.taskId)}">${esc(run.subject || t('任务', 'Task'))} · ${esc(dateLabel(run.createdAt))}</button>`).join('')}</section>` : ''}${activationMarkup}<details class="memory-inspector-section" data-preserve="memory-versions-${esc(memory.id)}"><summary>${t('版本与更正历史', 'Version & correction history')}<span>${versions.length}</span></summary>${versions.map(version => `<article class="memory-version-row"><small>${esc(changeLabel(version.changeKind))} · ${esc(dateLabel(version.createdAt))}</small><p>${esc(version.content || version.text)}</p>${!readonly && editable && (version.content || version.text) !== (memory.content || memory.text) ? `<button class="text-button" data-memory-restore-version="${esc(memory.id)}" data-memory-version-text="${esc(version.content || version.text)}">${t('恢复这段内容为新版本', 'Restore this content as a new version')}</button>` : ''}</article>`).join('')}</details></div></aside>`;
  }
  function referenceInspector(reference) {
    return `<aside class="memory-inspector memory-reference-inspector"><header><div><span>${kindLabel(reference.kind)}</span><button class="icon-button" data-memory-close aria-label="${t('关闭详情', 'Close details')}">${workspaceIcon('close', 16)}</button></div><h2 tabindex="-1">${esc(reference.label)}</h2></header><div class="memory-inspector-body"><p>${reference.kind === 'task' ? t('来源记录明确指向这个任务。它不是从相似文字推测出的关联。', 'The origin record explicitly references this task. This connection was not inferred from similar wording.') : t('这是记忆保存时明确指定的适用实体，不是自动生成的分类。', 'This entity was explicitly saved with the memory’s applicability. It is not an automatically generated category.')}</p>${reference.taskId ? `<button class="text-button" data-open-task="${esc(reference.taskId)}">${t('打开来源任务', 'Open source task')} ↗</button>` : ''}<button class="text-button" data-memory-find-reference="${esc(reference.label)}">${t('搜索相关记忆', 'Find memories about this')}</button></div></aside>`;
  }
  function edgeInspector(edge, graph) {
    const from = graph.nodes.find(node => node.id === edge.from), to = graph.nodes.find(node => node.id === edge.to);
    return `<aside class="memory-inspector memory-relationship-inspector"><header><div><span>${t('关系依据', 'Relationship evidence')}</span><button class="icon-button" data-memory-edge-close aria-label="${t('关闭关系详情', 'Close relationship details')}">${workspaceIcon('close', 16)}</button></div><h2 tabindex="-1">${esc(edgeLabel(edge))}</h2></header><div class="memory-inspector-body"><p>${esc(evidenceExplanation(edge))}</p><div class="memory-edge-endpoints">${[from, to].map(node => `<button class="text-button" ${node.kind === 'memory' ? `data-memory-focus="${esc(node.id)}"` : `data-memory-reference="${esc(node.id)}"`}>${esc(node.label)}</button>`).join('<span aria-hidden="true">↓</span>')}</div><details class="memory-inspector-section"><summary>${t('保存的依据', 'Recorded evidence')}</summary><p>${esc(edge.evidenceRef || edge.evidence?.join(' · ') || t('已记录的明确关联', 'An explicitly recorded connection'))}</p></details></div></aside>`;
  }
  function render() {
    if (!visible() || composing) return;
    const contentWidth = byId('memoryContent').clientWidth || 960;
    // Opening the graph already has an Inspector. Selecting another node never
    // changes this geometry or the center used to lay out the neighborhood.
    graphWidth = Math.max(220, innerWidth > 1100 ? (contentWidth - 24) * .64 : contentWidth);
    graphHeight = innerWidth <= 700 ? 420 : 500;
    const graph = graphModel();
    const selectedEdge = graph.edges.find(edge => edge.id === edgeId);
    const inspectorMarkup = selectedEdge ? edgeInspector(selectedEdge, graph) : referenceFocus ? referenceInspector(referenceFocus) : inspector(current());
    const scopes = [...new Set(records.map(memory => memory.scope?.entity || memory.scopeKey).filter(value => value && value !== '*'))];
    if (scope !== 'all' && !scopes.includes(scope)) scopes.push(scope);
    const toolbar = `<div class="memory-toolbar"><label class="collection-search">${workspaceIcon('search', 18)}<span class="sr-only">${t('搜索记忆', 'Search memories')}</span><input type="search" data-memory-search value="${esc(query)}" autocomplete="off" placeholder="${t('想找什么？试试预算、偏好、人名或项目', 'Ask about a budget, preference, person or project')}"></label><details class="memory-filters" data-preserve="memory-filters"><summary>${workspaceIcon('index', 14)}${t('筛选', 'Filter')}</summary><div class="memory-filter-fields"><label>${t('类型', 'Kind')}<select data-memory-kind>${[['all', t('全部记忆', 'All memories')], ['fact', t('事实', 'Facts')], ['preference', t('偏好', 'Preferences')]].map(([value, label]) => `<option value="${value}" ${kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>${t('范围', 'Scope')}<select data-memory-scope-filter><option value="all">${t('全部范围', 'All scopes')}</option>${scopes.map(value => `<option value="${esc(value)}" ${scope === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select></label><label>${t('状态', 'Status')}<select data-memory-status>${[['remembered', t('记住过的内容', 'Remembered content')], ['current', t('当前可用', 'Current')], ['disabled', t('已停用', 'Disabled')], ['archived', t('已归档', 'Archived')], ['superseded', t('已被替代', 'Superseded')], ['expired', t('已到期', 'Expired')], ['deleted', t('已删除', 'Deleted')], ['all', t('全部状态', 'All statuses')]].map(([value, label]) => `<option value="${value}" ${status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div></details>${context().state?.durable ? `<button class="text-button memory-add" data-memory-space-add>${t('记住一件事', 'Remember something')}</button>` : ''}</div>`;
    update('memoryContent', `${toolbar}${loadError ? `<p class="memory-load-error" role="alert">${esc(loadError)} <button class="text-button" data-memory-retry>${t('重试', 'Retry')}</button></p>` : ''}${undo ? `<div class="memory-undo" role="status"><span>${t('记忆已更新', 'Memory updated')}</span><button class="text-button" data-memory-undo ${busy ? 'disabled' : ''}>${t('撤销', 'Undo')}</button></div>` : ''}${view === 'explore' ? `<div class="memory-exploration-navigation"><button class="text-button" data-memory-results>${workspaceIcon('back', 14)}${t('返回搜索结果', 'Back to search results')}</button><span>${t('局部探索 · 不改变搜索条件', 'Local exploration · search context is preserved')}</span></div>` : ''}<div class="memory-browser${inspectorMarkup ? ' has-inspector' : ''}">${view === 'explore' ? renderGraph(graph) : results()}${inspectorMarkup}</div>${records.some(memory => memory.origin === 'demo_preview') ? `<p class="memory-demo-note">${t('示例记录 · 只读预览', 'Sample records · read-only preview')}</p>` : ''}`);
    update('memoryDeleted', '');
  }
  function closeInspector({ restore = true } = {}) {
    const previous = focusId;
    focusId = null; referenceFocus = null; detail = null; detailId = null; edgeId = null; editing = null; detailError = null; loadSequence++;
    if (restore && previous) byId('memoryContent').querySelector(`[data-memory-focus="${CSS.escape(previous)}"]`)?.focus({ preventScroll: true });
  }
  function focus(id) {
    referenceFocus = null; focusId = id; edgeId = null; editing = null; detail = null; detailId = null; detailError = null;
    render(); byId('memoryContent').querySelector('.memory-inspector h2')?.focus({ preventScroll: true }); void loadDetail(id);
  }
  async function exploreFrom(id, { expand = false, back = false } = {}) {
    if (exploring) return;
    const sequence = ++graphSequence;
    exploring = true; render();
    try {
      const nextDepth = expand ? 2 : 1;
      const result = await request(`/api/memory-space/${encodeURIComponent(id)}?depth=${nextDepth}`);
      if (sequence !== graphSequence) return;
      if (!back && centerId && centerId !== id) history.push({ id: centerId, depth });
      centerId = id; depth = nextDepth; graphData = result; rememberDetail(result);
      view = 'explore'; referenceFocus = null; focusId = id; detail = result; detailId = id; edgeId = null;
    } catch (error) { notify(error.message, true); }
    finally { exploring = false; render(); }
  }
  function showDialog(title, html) {
    byId('durableDialogTitle').textContent = title; byId('durableDialogBody').innerHTML = html;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('textarea,input,select')?.focus();
  }
  function addDialog() {
    action = { kind: 'create' };
    const projects = [...new Set(records.map(memory => memory.scope?.entity).filter(Boolean))];
    showDialog(t('添加记忆', 'Add memory'), `<form data-memory-space-form="create"><label>${t('记住什么', 'What to remember')}<textarea name="text" rows="4" maxlength="2000" required></textarea></label><label>${t('类型', 'Kind')}<select name="memoryKind"><option value="fact">${t('事实', 'Fact')}</option><option value="preference">${t('偏好', 'Preference')}</option></select></label><label>${t('范围', 'Scope')}<select name="scope"><option value="">${t('全局', 'Global')}</option>${projects.map(project => `<option value="${esc(project)}">${esc(project)}</option>`).join('')}</select></label><label>${t('有效期（可选）', 'Valid until (optional)')}<input type="datetime-local" name="validUntil"><small>${t('留空则长期有效，不会按年龄自动过期。', 'Blank means indefinite; memories do not expire from age.')}</small></label><p class="v12-error" id="memorySpaceFormError" role="alert"></p><div class="v12-form-actions"><button type="button" class="secondary-button" data-memory-dialog-close>${t('取消', 'Cancel')}</button><button type="submit" class="primary-button">${t('记住', 'Remember')}</button></div></form>`);
  }
  function supersedeDialog(memory) {
    action = { kind: 'supersede', id: memory.id, version: memory.expectedVersion ?? memory.updatedAt };
    showDialog(t('用更正替代这条记忆', 'Correct this memory with a replacement'), `<form data-memory-space-form="supersede"><p>${t('原记忆会保留为“已被更正”，不会继续用于新任务。', 'The original remains as Superseded and will not be used for new tasks.')}</p><label>${t('更正后的内容', 'Corrected content')}<textarea name="text" rows="4" maxlength="2000" required>${esc(memory.content || memory.text)}</textarea></label><label>${t('有效期（可选）', 'Valid until (optional)')}<input type="datetime-local" name="validUntil" value="${esc(datetimeValue(memory.validUntil))}"></label><p class="v12-error" id="memorySpaceFormError" role="alert"></p><div class="v12-form-actions"><button type="button" class="secondary-button" data-memory-dialog-close>${t('取消', 'Cancel')}</button><button type="submit" class="primary-button">${t('保存更正', 'Save correction')}</button></div></form>`);
  }
  async function mutate(id, operation, values = {}) {
    if (busy) return null;
    const memory = cache.get(id); if (!memory) return null;
    busy = true; render();
    try {
      const result = await post(`/api/memory-space/${encodeURIComponent(id)}`, { operation, expectedVersion: memory.expectedVersion ?? memory.updatedAt, version: memory.updatedAt, ...values });
      editing = null;
      const inverse = { disable: 'reactivate', reactivate: 'disable', archive: 'restore', delete: 'restore-delete' }[operation];
      undo = inverse && (memory.lifecycleState || 'active') === 'active' ? { id, operation: inverse, expectedVersion: result.memory.expectedVersion ?? result.memory.version } : null;
      detail = null; detailId = null;
      if (result.replacementId) { focusId = result.replacementId;  detail = null; detailId = null; }
      remember(result.memory); applyState(result.state); loadedRevision = null; await load({ force: true });
      if (focusId) await loadDetail(focusId);
      if (view === 'explore' && centerId) graphData = await request(`/api/memory-space/${encodeURIComponent(centerId)}?depth=${depth}`);
      notify(operation === 'delete' ? t('记忆已删除，可恢复。', 'Memory deleted; it can be restored.') : operation === 'supersede' ? t('更正已保存，原记忆保留在历史中。', 'Correction saved; the original remains in history.') : t('记忆已更新', 'Memory updated'));
      return result;
    } catch (error) { notify(error.message, true); throw error; }
    finally { busy = false; render(); }
  }
  async function relation(id, operation, targetId, relationKind) {
    const memory = cache.get(id); if (!memory || busy) return;
    busy = true;
    try {
      const result = await post(`/api/memory-space/${encodeURIComponent(id)}/relations`, { operation, targetId, kind: relationKind, expectedVersion: memory.version, status: 'established', evidenceKind: 'user_confirmed', evidenceRef: id });
      applyState(result.state); loadedRevision = null; detailId = null; await load({ force: true }); await loadDetail(id); notify(t('关系已更新；适用范围未改变。', 'Relationship updated; applicability is unchanged.'));
    } catch (error) { notify(error.message, true); }
    finally { busy = false; render(); }
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('button, [data-memory-edge]'); if (!target) return;
    if (target.hasAttribute('data-memory-more')) { pageSize += 20; render(); return; }
    if (target.hasAttribute('data-memory-results')) { view = 'results'; edgeId = null; referenceFocus = null; render(); return; }
    if (target.hasAttribute('data-memory-find-reference')) {
      query = target.dataset.memoryFindReference; view = 'results'; pageSize = query ? 20 : 5; closeInspector({ restore: false }); loadedRevision = null; void load({ force: true }); return;
    }
    if (target.hasAttribute('data-memory-reference')) {
      referenceFocus = [...(detail?.context?.entities || []), ...(detail?.context?.sources || []), ...(graphData?.context?.entities || []), ...(graphData?.context?.sources || [])].find(reference => reference.id === target.dataset.memoryReference);
      edgeId = null; render(); byId('memoryContent').querySelector('.memory-inspector h2')?.focus({ preventScroll: true }); return;
    }
    if (target.hasAttribute('data-memory-explore')) { void exploreFrom(target.dataset.memoryExplore); return; }
    if (target.hasAttribute('data-memory-retry')) { loadedRevision = null; void load({ force: true }); return; }
    if (target.hasAttribute('data-memory-undo')) {
      if (!undo || busy) return;
      const previous = undo; busy = true;
      void post(`/api/memory-space/${encodeURIComponent(previous.id)}`, previous).then(async result => {
        undo = null; detailId = null; remember(result.memory); applyState(result.state); loadedRevision = null; await load({ force: true }); if (focusId) await loadDetail(focusId); notify(t('已撤销', 'Change undone'));
      }).catch(error => notify(error.message, true)).finally(() => { busy = false; render(); }); return;
    }
    if (target.hasAttribute('data-memory-space-add')) { addDialog(); return; }
    if (target.hasAttribute('data-memory-dialog-close')) { dialog.close(); return; }
    if (target.dataset.memoryFocus) { focus(target.dataset.memoryFocus); return; }
    if (target.hasAttribute('data-memory-close')) { closeInspector(); render(); return; }

    if (target.hasAttribute('data-memory-clear')) { query = ''; kind = 'all'; scope = 'all'; status = 'remembered'; view = 'results'; pageSize = query ? 20 : 5; closeInspector({ restore: false }); loadedRevision = null; void load({ force: true }); return; }
    if (target.hasAttribute('data-memory-back')) { const previous = history.pop(); if (previous) void exploreFrom(previous.id, { back: true, expand: previous.depth === 2 }); return; }
    if (target.hasAttribute('data-memory-expand')) { if (centerId) void exploreFrom(centerId, { expand: true }); return; }
    if (target.dataset.memoryEdge) { edgeId = edgeId === target.dataset.memoryEdge ? null : target.dataset.memoryEdge; render(); return; }
    if (target.hasAttribute('data-memory-edge-close')) { edgeId = null; render(); return; }
    if (target.hasAttribute('data-memory-cancel')) { editing = null; render(); return; }
    if (target.dataset.memoryRelationRemove) { void relation(focusId, 'remove', target.dataset.memoryTarget, target.dataset.memoryRelationKind); return; }
    if (target.dataset.memoryRestoreVersion) { void mutate(target.dataset.memoryRestoreVersion, 'restore-version', { text: target.dataset.memoryVersionText }).catch(() => {}); return; }
    if (target.dataset.memoryOperation) {
      const memory = cache.get(target.dataset.memoryId), operation = target.dataset.memoryOperation; if (!memory) return;
      focusId = memory.id;
      if (operation === 'edit') { editing = { id: memory.id, text: memory.content || memory.text, memoryKind: memory.memoryKind || 'fact', validUntil: memory.validUntil || null }; render(); byId('memoryContent').querySelector('[data-memory-edit] textarea')?.focus(); }
      else if (operation === 'supersede') supersedeDialog(memory);
      else void mutate(memory.id, operation).catch(() => {});
    }
  });
  document.addEventListener('input', event => {
    if (editing && event.target.closest('[data-memory-edit]')) {
      const field = event.target.name;
      if (field === 'text' || field === 'memoryKind') editing[field] = event.target.value;
      if (field === 'validUntil') editing.validUntil = event.target.value;
      return;
    }
    if (!event.target.hasAttribute('data-memory-search')) return;
    query = event.target.value; if (loading && !composing && !event.isComposing) browseSequence++; pageSize = query ? 20 : 5; view = 'results'; closeInspector({ restore: false });
    clearTimeout(searchTimer);
    if (!composing && !event.isComposing) searchTimer = setTimeout(() => { loadedRevision = null; void load({ force: true }); }, 100);
  });
  document.addEventListener('change', event => {
    if (event.target.hasAttribute('data-memory-kind')) kind = event.target.value;
    else if (event.target.hasAttribute('data-memory-scope-filter')) scope = event.target.value;
    else if (event.target.hasAttribute('data-memory-status')) status = event.target.value;
    else if (event.target.hasAttribute('data-memory-sort')) { sort = event.target.value; writeLocal('unprompted:memory-space-sort', sort); render(); return; }
    else return;
    loadedRevision = null; void load({ force: true });
  });
  document.addEventListener('submit', async event => {
    const edit = event.target.dataset.memoryEdit, relationForm = event.target.dataset.memoryRelationForm, dialogForm = event.target.dataset.memorySpaceForm;
    if (!edit && !relationForm && !dialogForm) return;
    event.preventDefault(); if (busy) return;
    const data = new FormData(event.target), submit = event.target.querySelector('[type=submit]'); if (submit) submit.disabled = true;
    try {
      if (edit) await mutate(edit, 'edit', { text: data.get('text'), memoryKind: data.get('memoryKind'), validUntil: data.get('validUntil') ? new Date(data.get('validUntil')).toISOString() : null });
      if (relationForm) await relation(relationForm, 'add', data.get('targetId'), data.get('kind'));
      if (dialogForm === 'create') {
        if (busy) return; busy = true;
        const project = data.get('scope');
        const result = await post('/api/memory-space', { text: data.get('text'), memoryKind: data.get('memoryKind'), scopeType: project ? 'project' : 'global', scopeKey: project || '*', validUntil: data.get('validUntil') ? new Date(data.get('validUntil')).toISOString() : null });
        applyState(result.state); loadedRevision = null; dialog.close(); focusId = result.memory.id; rememberDetail(result); detail = result; detailId = result.memory.id; await load({ force: true }); notify(t('记忆已保存', 'Memory saved')); busy = false;
      }
      if (dialogForm === 'supersede') { await mutate(action.id, 'supersede', { text: data.get('text'), replacement: { validUntil: data.get('validUntil') ? new Date(data.get('validUntil')).toISOString() : null } }); dialog.close(); }
    } catch (error) { const host = byId('memorySpaceFormError') || event.target.querySelector('[data-memory-edit-error]'); if (host) host.textContent = error.message; }
    finally { busy = false; if (submit?.isConnected) submit.disabled = false; }
  });
  document.addEventListener('compositionstart', event => { if (event.target.hasAttribute('data-memory-search')) { composing = true; clearTimeout(searchTimer); } });
  document.addEventListener('compositionend', event => { if (event.target.hasAttribute('data-memory-search')) { composing = false; query = event.target.value; loadedRevision = null; void load({ force: true }); } });
  let resizeFrame;
  window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(render); });
  document.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key) && event.target.matches('.memory-space-link')) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
    if (event.key === 'Escape' && (focusId || referenceFocus || edgeId) && !event.defaultPrevented && !event.isComposing && !document.querySelector('dialog[open]') && visible()) { event.preventDefault(); closeInspector(); render(); }
  });
  dialog.addEventListener('close', () => { action = null; });

  return { render() { if (workspace !== context().workspace) { workspace = context().workspace; records = []; cache.clear(); loadedRevision = null; closeInspector({ restore: false }); history = []; centerId = null; graphData = null; view = 'results'; } if (visible() && loadedRevision !== String(context().state?.revision ?? 0) && !loading && !composing) void load(); else render(); }, reload: () => load({ force: true }), go };
}
