// Navigation hides presentation only; application-owned hidden states stay intact.
const chinese = () => document.documentElement.lang.startsWith('zh');
// Reserve the artifact panel before asynchronous setup renders its content.
if (document.querySelector('#connectorContent') && !document.getElementById('artifactPermissions')) {
  const artifacts = document.createElement('section');
  artifacts.id = 'artifactPermissions';
  artifacts.className = 'source-group';
  artifacts.hidden = true;
  document.querySelector('#connectorContent').after(artifacts);
}
const groups = [
  ['#homeRecord', [
    ['来源动态', 'Source activity', '[data-stream=events]'],
    ['跟进记录', 'Agent follow-up', '[data-stream=events]'],
    ['后续事项', 'Follow-ups', '.followups-surface'],
    ['工作效果', 'Outcomes', '.metrics-details']]],
  ['#viewMemory', [
    ['记忆探索', 'Explore', '#memoryContent, #memoryDeleted'],
    ['规则与经验', 'Rules & experience', '.memory-advanced']]],
  ['#viewPreferences .settings-page', [
    ['模型', 'Model', '#settingsModelHost'],
    ['自动跟进', 'Follow-up', '.settings-section:has(#grantContent), #durableSettingsContent'],
    ['外观', 'Appearance', '.ws-appearance, #appearanceSettings'],
    ['工作台', 'Workspace', '.workspace-view-setting']]],
  ['#viewSources', [
    ['工具连接', 'Connections', '#connectorContent'],
    ['MCP', 'MCP', '#mcpContent'],
    ['搜索', 'Search', '#googleSearchPanel'],
    ['观察', 'Observation', '#observationPanel, #googleSetupPanel, #contextContent'],
    ['保存位置', 'Destinations', '#artifactPermissions']]]
];
// Session storage is optional: private/embedded browsers may disable it.
const recall = key => { try { return sessionStorage.getItem(`page-focus:${key}`); } catch { return null; } };
const remember = (key, value) => { try { sessionStorage.setItem(`page-focus:${key}`, value); } catch { /* navigation still works */ } };
function addPager(nav, select, current, count) {
  const shell = document.createElement('div');
  shell.className = 'page-focus-navigation';
  nav.before(shell);
  shell.append(nav);
  const pager = document.createElement('div');
  pager.className = 'page-focus-pager';
  const previous = document.createElement('button');
  const next = document.createElement('button');
  const position = document.createElement('span');
  position.className = 'page-focus-position';
  position.setAttribute('aria-hidden', 'true');
  for (const [button, step, glyph] of [[previous, -1, '←'], [next, 1, '→']]) {
    button.type = 'button';
    button.textContent = glyph;
    button.addEventListener('click', () => select((current() + step + count) % count));
  }
  pager.append(previous, position, next);
  shell.append(pager);
  return () => {
    previous.setAttribute('aria-label', chinese() ? '上一个分区' : 'Previous section');
    next.setAttribute('aria-label', chinese() ? '下一个分区' : 'Next section');
    position.textContent = `${current() + 1} / ${count}`;
  };
}
for (const [selector, definitions] of groups) {
  const host = document.querySelector(selector);
  if (!host) continue;
  const nav = document.createElement('div');
  nav.className = 'page-focus-nav';
  nav.setAttribute('role', 'tablist');
  const entries = definitions.map(([zh, en, query], index) => {
    const panels = [...host.querySelectorAll(query)];
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `focus-${host.id || 'settings'}-${index}`;
    button.setAttribute('role', 'tab');
    panels.forEach((panel, i) => {
      panel.id ||= `${button.id}-panel-${i}`;
      panel.setAttribute('aria-labelledby', button.id);
      panel.setAttribute('role', 'tabpanel');
      panel.tabIndex = 0;
      panel.classList.add('page-focus-panel');
    });
    button.setAttribute('aria-controls', panels.map(p => p.id).join(' '));
    nav.append(button);
    return { button, panels, zh, en };
  });
  let selected = Math.max(0, definitions.findIndex(([, en]) => en === recall(selector)));
  let updatePager = () => {};
  const empty = document.createElement('p');
  empty.className = 'page-focus-empty';
  host.append(empty);
  function render() {
    nav.setAttribute('aria-label', chinese() ? '页面分区' : 'Page sections');
    updatePager();
    if (selector === '#homeRecord') {
      host.querySelector('.activity-toolbar').classList.toggle('page-focus-inactive', selected > 1);
      host.querySelector('.activity-layout').classList.toggle('page-focus-inactive', selected > 1);
    }
    entries.forEach(({ button, panels, zh, en }, i) => {
      button.textContent = chinese() ? zh : en;
      button.setAttribute('aria-selected', String(i === selected));
      button.tabIndex = i === selected ? 0 : -1;
      panels.forEach(panel => {
        const active = entries[selected].panels.includes(panel);
        panel.classList.toggle('page-focus-inactive', !active);
        if (active) panel.setAttribute('aria-labelledby', entries[selected].button.id);
        if (panel.tagName === 'DETAILS') panel.open = active;
      });
    });
  }
  function updateEmpty() {
    const { panels } = entries[selected];
    const hasContent = panels.some(panel => !panel.hidden && (panel.children.length ? [...panel.children].some(child => !child.hidden && child.textContent.trim()) : panel.textContent.trim()));
    if (empty.hidden !== Boolean(hasContent)) empty.hidden = Boolean(hasContent);
    const message = chinese() ? '这里暂时没有可显示的内容。连接状态或工作记录更新后会自动出现。' : 'Nothing here yet. This section updates automatically as your workspace changes.';
    if (empty.textContent !== message) empty.textContent = message;
  }
  new MutationObserver(updateEmpty).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  function select(index) {
    selected = index;
    remember(selector, definitions[index][1]);
    if (selector === '#homeRecord' && index < 2) {
      host.querySelector(`[data-activity-filter="${index === 0 ? 'events' : 'history'}"]`)?.click();
    }
    render();
    updateEmpty();
  }
  entries.forEach(({ button }, i) => {
    button.addEventListener('click', () => select(i));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      selected = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (selected + (event.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length;
      select(selected);
      entries[selected].button.focus();
      entries[selected].button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });
  const heading = host.querySelector(':scope > .page-heading');
  heading ? heading.after(nav) : host.prepend(nav);
  updatePager = addPager(nav, select, () => selected, entries.length);
  host.classList.add('page-focus-host');
  // Existing links can reveal a hidden tab's content without losing their target.
  host.addEventListener('focusin', event => {
    if (entries[selected].panels.some(panel => panel.contains(event.target))) return;
    const index = entries.findIndex(({ panels }) => panels.some(panel => panel.contains(event.target)));
    if (index >= 0 && index !== selected) select(index);
  });
  if (selector === '#viewMemory') {
    const advanced = host.querySelector('.memory-advanced');
    new MutationObserver(() => { if (advanced.open && selected !== 1) select(1); }).observe(advanced, { attributes: true, attributeFilter: ['open'] });
  }
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  select(selected);
}

// Field groups are replaced on refresh. Restore the selected category without
// moving application-owned nodes or interfering with task selection handlers.
let fieldGroup = recall('tasks');
const taskHost = document.querySelector('#taskContent');
let fieldFilter = null;
function focusField() {
  const field = taskHost?.querySelector('.ws-field');
  if (!field || field.querySelector('.field-focus-nav')) return;
  const sections = [...field.querySelectorAll(':scope > .ws-task-group')];
  if (!sections.length) return;
  const filter = JSON.stringify([document.querySelector('#taskStatusFilter')?.value, document.querySelector('#taskSearch')?.value]);
  const filterChanged = fieldFilter !== null && fieldFilter !== filter;
  fieldFilter = filter;
  if (filterChanged || !sections.some(section => section.dataset.group === fieldGroup)) {
    fieldGroup = sections.find(section => section.dataset.empty !== 'true')?.dataset.group || sections[0].dataset.group;
  }
  const nav = document.createElement('div');
  nav.className = 'page-focus-nav field-focus-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', chinese() ? '任务状态' : 'Task status');
  let updatePager = () => {};
  function select(index, focus = false) {
    fieldGroup = sections[index].dataset.group;
    remember('tasks', fieldGroup);
    sections.forEach((section, i) => {
      section.classList.toggle('page-focus-inactive', i !== index);
      nav.children[i].setAttribute('aria-selected', String(i === index));
      nav.children[i].tabIndex = i === index ? 0 : -1;
    });
    updatePager();
    if (focus) {
      nav.children[index].focus();
      nav.children[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  sections.forEach((section, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    const emptyState = section.querySelector('.ws-group-empty');
    if (emptyState) {
      emptyState.textContent = chinese() ? '这个分区暂时没有事项。新进展会自动出现在这里。' : 'No tasks in this section. New work will appear here automatically.';
      emptyState.removeAttribute('aria-label');
    }
    button.textContent = [...section.querySelector('h3').childNodes].map(node => node.nodeType === 3 ? node.textContent : node.tagName === 'SPAN' ? ` (${node.textContent})` : '').join('').trim();
    section.id = `field-panel-${section.dataset.group}`;
    button.id = `${section.id}-tab`;
    button.setAttribute('aria-controls', section.id);
    section.setAttribute('aria-labelledby', button.id);
    section.setAttribute('role', 'tabpanel');
    section.tabIndex = 0;
    button.addEventListener('click', () => select(index));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
      select(next, true);
    });
    nav.append(button);
  });
  field.prepend(nav);
  updatePager = addPager(nav, select, () => sections.findIndex(section => section.dataset.group === fieldGroup), sections.length);
  select(sections.findIndex(section => section.dataset.group === fieldGroup));
}
if (taskHost) {
  new MutationObserver(focusField).observe(taskHost, { childList: true, subtree: true });
  focusField();
}

// Detail views are rendered on demand and refreshed independently of page tabs.
// Presentation-only navigation for live detail views. Keep application nodes,
// forms and delegated handlers intact; never synthesize an application action.
const zh = () => document.documentElement.lang.startsWith('zh');
const selections = new Map();
const controllers = new WeakMap();
let serial = 0;

function focusDetails(host, { key, anchor = host, entries, before = null }) {
  if (controllers.has(host)) return;
  const sections = entries.map(([cn, en, nodes]) => ({ cn, en, nodes: Array.from(nodes) }));
  if (sections.length < 2) return;
  const prefix = `detail-focus-${++serial}`;
  const shell = document.createElement('div');
  shell.className = 'page-focus-navigation detail-focus-navigation';
  const nav = document.createElement('div');
  nav.className = 'page-focus-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', zh() ? '详情分区' : 'Detail sections');
  const pager = document.createElement('div');
  pager.className = 'page-focus-pager';
  const prev = document.createElement('button');
  const next = document.createElement('button');
  const position = document.createElement('span');
  position.className = 'page-focus-position';
  position.setAttribute('aria-hidden', 'true');
  [prev, next].forEach(button => { button.type = 'button'; });
  prev.textContent = '←'; next.textContent = '→';
  prev.setAttribute('aria-label', zh() ? '上一个详情分区' : 'Previous detail section');
  next.setAttribute('aria-label', zh() ? '下一个详情分区' : 'Next detail section');
  pager.append(prev, position, next);
  shell.append(nav, pager);
  anchor.insertBefore(shell, before);
  host.classList.add('detail-focus-host');
  const empty = document.createElement('p');
  empty.className = 'detail-focus-empty';
  empty.textContent = zh() ? '这里暂时没有记录。新进展会自动出现在这里。' : 'No records yet. Updates will appear here automatically.';
  empty.hidden = true;
  anchor.append(empty);
  let selected = Math.max(0, sections.findIndex(section => section.en === selections.get(key)));
  const buttons = sections.map((section, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${prefix}-tab-${index}`;
    button.setAttribute('role', 'tab');
    button.textContent = zh() ? section.cn : section.en;
    button.title = button.textContent;
    section.nodes.forEach((node, i) => {
      node.id ||= `${prefix}-panel-${index}-${i}`;
      node.classList.add('detail-focus-panel');
      node.setAttribute('role', 'tabpanel');
      node.setAttribute('aria-labelledby', button.id);
      node.tabIndex = 0;
    });
    button.setAttribute('aria-controls', section.nodes.map(node => node.id).join(' ') || `${prefix}-empty`);
    button.addEventListener('click', () => select(index));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      // Task arrows switch tasks elsewhere; arrows on these tabs switch sections.
      event.stopPropagation();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
      select(target);
      buttons[target].focus({ preventScroll: true });
      buttons[target].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    nav.append(button);
    return button;
  });
  empty.id = `${prefix}-empty`;
  empty.setAttribute('role', 'tabpanel');
  empty.tabIndex = 0;
  function select(index) {
    selected = index;
    selections.set(key, sections[index].en);
    sections.forEach((section, i) => {
      buttons[i].setAttribute('aria-selected', String(index === i));
      buttons[i].tabIndex = index === i ? 0 : -1;
      section.nodes.forEach(node => {
        node.classList.toggle('detail-focus-inactive', index !== i);
        if (node.tagName === 'DETAILS' && !node.classList.contains('memory-actions-menu') && index === i) node.open = true;
      });
    });
    empty.hidden = sections[index].nodes.length > 0;
    empty.setAttribute('aria-labelledby', buttons[index].id);
    position.textContent = `${index + 1} / ${sections.length}`;
  }
  prev.addEventListener('click', () => select((selected - 1 + sections.length) % sections.length));
  next.addEventListener('click', () => select((selected + 1) % sections.length));
  // Validation errors in a form reveal its section without submitting it again.
  host.addEventListener('invalid', event => {
    const index = sections.findIndex(section => section.nodes.some(node => node.contains(event.target)));
    if (index >= 0) select(index);
  }, true);
  controllers.set(host, { select, translate() {
    nav.setAttribute('aria-label', zh() ? '详情分区' : 'Detail sections');
    prev.setAttribute('aria-label', zh() ? '上一个详情分区' : 'Previous detail section');
    next.setAttribute('aria-label', zh() ? '下一个详情分区' : 'Next detail section');
    sections.forEach((section, i) => {
      buttons[i].textContent = zh() ? section.cn : section.en;
      buttons[i].title = buttons[i].textContent;
    });
    empty.textContent = zh() ? '这里暂时没有记录。新进展会自动出现在这里。' : 'No records yet. Updates will appear here automatically.';
  } });
  select(selected);
}

function enhanceDetails(root) {
  for (const host of root.querySelectorAll('.ws-inspector[data-inspector-task]')) {
    const anchor = host.querySelector('.ws-inspector-context');
    if (!anchor) continue;
    if (controllers.has(host)) continue;
    const evidence = host.querySelector('[data-preserve^="full-evidence-"]');
    const structured = evidence?.querySelector('.task-evidence');
    if (structured) {
      evidence.open = true;
      evidence.classList.add('detail-focus-unwrapped');
      structured.classList.add('detail-focus-unwrapped');
    }
    focusDetails(host, { key: `task:${host.dataset.inspectorTask}`, anchor, before: anchor.querySelector('.ws-detail-columns'), entries: [
      ['概览', 'Overview', host.querySelectorAll('.ws-detail-main, .ws-checklist, .task-evidence > .patch-review')],
      ['来源依据', 'Evidence', host.querySelectorAll(structured ? '.ws-sources-bar, .ws-artifact-records, .ws-evidence-explanation, .task-evidence > .assessment-box, .task-evidence > .text-link' : '.ws-sources-bar, .ws-artifact-records, [data-preserve^="full-evidence-"]')],
      ...(structured ? [['判断与未知', 'Assessment', structured.querySelectorAll(':scope > .claim-block, :scope > .unknown-block')]] : []),
      ['经过', 'History', host.querySelectorAll('.ws-timeline')],
      ['跟进设置', 'Follow-up', host.querySelectorAll('[data-preserve^="ws-management-"], .task-evidence > .review-row')]
    ] });
  }
  for (const host of root.querySelectorAll('.memory-inspector:not(.memory-reference-inspector):not(.memory-relationship-inspector)')) {
    const anchor = host.querySelector('.memory-inspector-body');
    if (!anchor) continue;
    const version = host.querySelector('[data-preserve^="memory-versions-"]');
    focusDetails(host, { key: version?.dataset.preserve || 'memory', anchor, before: anchor.querySelector('.memory-human-context'), entries: [
      ['概览', 'Overview', anchor.querySelectorAll(':scope > .memory-human-context, :scope > .memory-actions-menu')],
      ['关联', 'Related', anchor.querySelectorAll(':scope > .memory-inspector-context')],
      ['历史', 'History', anchor.querySelectorAll(':scope > .memory-inspector-section')]
    ] });
  }
  for (const host of root.querySelectorAll('.connection-inspector:not([hidden])')) {
    const card = host.querySelector('[data-connection-card]:not([hidden])');
    const permission = host.querySelector(':scope > .connection-card-form');
    if (card) {
      const status = card.querySelector(':scope > .source-detail-grid');
      const account = [...card.children].filter(node => !node.matches('.source-connection-heading, .source-detail-grid'));
      const entries = [['账号与连接', 'Account', account]];
      if (status) entries.push(['连接状态', 'Status', [status]]);
      if (permission) entries.push(['行动权限', 'Permissions', [permission]]);
      focusDetails(host, { key: `connection:${card.dataset.connectionCard}`, anchor: card, before: card.querySelector('.source-connection-heading')?.nextSibling || null, entries });
    }
  }
  const context = root.id === 'taskContextContent' ? root : null;
  if (context) {
    const refs = [...context.querySelectorAll(':scope > .ws-source-reference')];
    if (refs.length > 1) focusDetails(context, { key: `sources:${document.querySelector('#taskContextSubtitle')?.textContent}`, before: refs[0], entries: refs.map((ref, i) => {
      const title = ref.querySelector('h3')?.textContent || `${i + 1}`;
      return [title, title, [ref]];
    }) });
  }
}
for (const id of ['taskContent', 'attentionContent', 'memoryContent', 'connectorContent', 'taskContextContent']) {
  const root = document.getElementById(id);
  if (!root) continue;
  // A persistent dialog body can receive new application markup.
  new MutationObserver(() => {
    if (controllers.has(root) && !root.querySelector('.detail-focus-navigation')) controllers.delete(root);
    enhanceDetails(root);
  }).observe(root, { childList: true, subtree: true });
  enhanceDetails(root);
}


new MutationObserver(() => {
  document.querySelectorAll('.detail-focus-host').forEach(host => controllers.get(host)?.translate());
}).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
