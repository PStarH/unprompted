import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workbench = readFileSync(join(root, 'public/workbench.css'), 'utf8');
const redesign = readFileSync(join(root, 'public/redesign.css'), 'utf8');

function braceBalance(css) {
  return [css.split('{').length - 1, css.split('}').length - 1];
}

test('field workspace styles keep readable text and focus', () => {
  assert.equal(braceBalance(workbench)[0], braceBalance(workbench)[1]);
  assert.equal(braceBalance(redesign)[0], braceBalance(redesign)[1]);
  assert.match(workbench, /#taskContent\[data-mode="field"\] \.ws-group-empty \{[^}]*color: var\(--muted\)/);
  assert.match(workbench, /#taskContent \.ws-composer:focus-within \{[^}]*box-shadow: var\(--ring\)/);
  assert.match(workbench, /#taskContent \.ws-composer textarea::placeholder,\s*#viewHome \.task-search-wrap input::placeholder \{[^}]*opacity: 1/);
  assert.match(workbench, /@media \(max-width: 900px\) \{\s*#taskContent \.ws-composer textarea,\s*#viewHome \.task-search-wrap input,\s*#viewMemory textarea,\s*#viewMemory \.memory-scope-select,\s*#viewMemory \.collection-search input,\s*#viewSources \.collection-search input \{ font-size: 16px; \}/);
  assert.match(workbench, /#taskContent\[data-mode="field"\] \.ws-task-row\.selected \.ws-task-select:active \{[^}]*background: var\(--selected\)/);
  assert.doesNotMatch(workbench, /#taskContent\[data-mode="field"\] \.ws-task-row\.selected \.ws-task-select:active \{[^}]*color-mix/);
  assert.match(workbench, /\.ws-state-notice \{[^}]*background: var\(--surface\)/);
  assert.match(workbench, /\.ws-state-notice\[data-tone="error"\] \{[^}]*background: var\(--surface\)/);
  assert.match(workbench, /\.ws-node-state\[data-state="needs_user"\][^{]*\{[^}]*background: var\(--amber-light\)/);
  assert.match(workbench, /\.ws-node-state\[data-state="failed"\][^{]*\{[^}]*background: var\(--error-light\)/);
  assert.match(workbench, /#taskContent\[data-mode="field"\] \.ws-status-mark \{[^}]*border: 1\.5px solid var\(--muted\)/);
  assert.doesNotMatch(workbench, /data-group="attention"\]:not\(\[data-empty="true"\]\) \{[^}]*amber-light/);
  assert.match(workbench, /\.ws-shared-dep-badge:focus-visible \{[^}]*outline-offset: -2px/);
  assert.match(workbench, /@media \(max-width: 700px\) \{\s*\.ws-shared-dep-badge \{ min-height: 44px; padding: 8px 10px; \}\s*\}/);
  assert.match(workbench, /\.shared-dependency input \{[^}]*color: var\(--ink\)/);
  assert.match(workbench, /\.ws-shared-dep-badge \{[^}]*min-height: 24px/);
  assert.match(workbench, /#taskContent \.ws-shared-dep-badge:active \{[^}]*transform: none/);
  assert.match(workbench, /\.select-menu-group \{[^}]*color: var\(--muted\)/);
  assert.match(workbench, /\.ws-shared-dep-badge \{[^}]*background: var\(--amber-light\);[^}]*color: var\(--amber\)/);
  assert.doesNotMatch(workbench, /\.ws-dependency-band|\.ws-dep-expand/);
  assert.match(workbench, /#taskContent \.ws-task-row\.is-dep-highlighted \{[^}]*outline-offset: -2px/);
  assert.match(workbench, /#taskContent\[data-mode="field"\] \.ws-task-select:focus-visible \{[^}]*outline-offset: -2px/);
  assert.doesNotMatch(redesign, /ws-task-card|--border/);
});

const store = new Map([['unprompted:language', 'zh-CN']]);
const clickListeners = [];
let taskHtml = '';
let parsedFor = null;
let parsedRows = [];

function decode(value) {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function classList(initial = '') {
  const names = new Set(initial.split(/\s+/).filter(Boolean));
  return {
    add(...items) { for (const item of items) names.add(item); },
    remove(...items) { for (const item of items) names.delete(item); },
    contains(item) { return names.has(item); }
  };
}

function parseRows(html) {
  const rows = [];
  const articles = /<article class="([^"]*)" data-task-card="([^"]*)" data-state="([^"]*)">([\s\S]*?)<\/article>/g;
  for (const match of html.matchAll(articles)) {
    const row = { id: decode(match[2]), html: match[4], classList: classList(match[1]), badges: [] };
    const badges = /<button type="button" class="ws-shared-dep-badge" data-shared-dep-group="([^"]*)" aria-pressed="([^"]*)" title="([^"]*)">([^<]*)<\/button>/g;
    for (const badgeMatch of match[4].matchAll(badges)) {
      const badge = {
        dataset: { sharedDepGroup: decode(badgeMatch[1]) },
        ariaPressed: badgeMatch[2],
        label: decode(badgeMatch[4]),
        hasAttribute() { return false; },
        setAttribute(name, value) { if (name === 'aria-pressed') this.ariaPressed = value; },
        closest(selector) {
          if (selector === 'button') return badge;
          if (selector === '.ws-task-row') return row;
          return null;
        }
      };
      row.badges.push(badge);
    }
    rows.push(row);
  }
  return rows;
}

function rows() {
  if (parsedFor !== taskHtml) {
    parsedRows = parseRows(taskHtml);
    parsedFor = taskHtml;
  }
  return parsedRows;
}

function element() {
  const attrs = {};
  return {
    dataset: {},
    style: { setProperty() {} },
    innerHTML: '',
    textContent: '',
    value: 'all',
    hidden: true,
    title: '',
    classList: classList(),
    addEventListener() {},
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    querySelector(selector) { return selector === '.home-heading' ? element() : null; },
    querySelectorAll() { return []; },
    focus() {},
    showModal() {},
    close() {}
  };
}

const elements = new Map();
globalThis.localStorage = {
  getItem: key => store.has(key) ? store.get(key) : null,
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); }
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.window = { addEventListener() {} };
globalThis.location = { origin: 'http://127.0.0.1:4173' };
if (typeof globalThis.CSS?.escape !== 'function') {
  globalThis.CSS = { escape: value => String(value).replace(/(["\\])/g, '\\$1') };
}
globalThis.document = {
  documentElement: { dataset: {}, style: { setProperty() {} } },
  getElementById(id) {
    if (id === 'appearanceSettings') return null;
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  addEventListener(type, listener) {
    if (type === 'click') clickListeners.push(listener);
  },
  querySelector(selector) {
    return selector === 'meta[name="theme-color"]' ? { content: '' } : null;
  },
  querySelectorAll(selector) {
    const list = rows();
    if (selector === '#taskContent .ws-task-row.is-dep-highlighted') return list.filter(row => row.classList.contains('is-dep-highlighted'));
    if (selector === '#taskContent .ws-shared-dep-badge') return list.flatMap(row => row.badges);
    return list.flatMap(row => row.badges).filter(badge => selector === `#taskContent [data-shared-dep-group="${CSS.escape(badge.dataset.sharedDepGroup)}"]`);
  }
};

const { createWorkspace } = await import('../public/workspace.js');
const { setLocale } = await import('../public/i18n.js');

function waiting(id, ids) {
  return {
    id,
    subject: `Task ${id}`,
    status: 'waiting_for_information',
    updatedAt: '2026-10-30T01:00:00.000Z',
    management: { dependencies: [{ id: 'dep', label: 'Budget approval', condition: 'budget', taskIds: ids }] }
  };
}

function fire(target) {
  const event = {
    target,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  };
  for (const listener of clickListeners) listener(event);
  return event;
}

test('shared-wait badge is its own button, names the count, and toggles the highlight', () => {
  const workspace = createWorkspace({
    context: () => ({ state: { tasks: [], taskMemories: [], history: [] }, connections: {}, workspace: 'home', filter: 'all' }),
    update(id, html) { if (id === 'taskContent') taskHtml = html; },
    post: async () => ({}),
    applyState() {},
    notify() {},
    renderAction: () => '',
    renderManagement: () => '',
    renderDetails: () => '',
    go() {},
    refresh() {}
  });
  workspace.render({
    tasks: [waiting('a', ['a', 'b', 'c']), waiting('b', ['a', 'b', 'c']), { id: 'c', subject: 'Done', status: 'completed', updatedAt: '2026-10-30T01:00:00.000Z' }],
    emptyHTML: ''
  });

  const shared = rows().filter(row => row.badges.length);
  assert.equal(shared.length, 2);
  assert.equal(taskHtml.includes('{n}'), false);
  assert.equal(taskHtml.includes('[object Object]'), false);
  assert.equal(taskHtml.includes('</span></span></span></button>'), false);
  for (const row of shared) {
    const selectEnd = row.html.indexOf('</button>');
    assert.equal(row.html.slice(0, selectEnd).includes('ws-shared-dep-badge'), false);
    assert.equal(row.badges.length, 1);
    assert.equal(row.badges[0].label, '与2个任务共享等待');
    assert.equal(row.badges[0].dataset.sharedDepGroup, 'budget');
    assert.equal(row.badges[0].ariaPressed, 'false');
  }
  assert.equal(rows().find(row => row.id === 'c').badges.length, 0);
  assert.doesNotMatch(taskHtml, /ws-dependency-band|data-dep-expand/);

  const html = taskHtml;
  const first = fire(shared[0].badges[0]);
  assert.equal(first.prevented, true);
  assert.equal(first.stopped, true);
  assert.equal(taskHtml, html);
  assert.deepEqual(rows().filter(row => row.classList.contains('is-dep-highlighted')).map(row => row.id).sort(), ['a', 'b']);
  assert.equal(rows().flatMap(row => row.badges).every(badge => badge.ariaPressed === 'true'), true);

  fire(shared[0].badges[0]);
  assert.equal(rows().some(row => row.classList.contains('is-dep-highlighted')), false);
  assert.equal(rows().flatMap(row => row.badges).every(badge => badge.ariaPressed === 'false'), true);

  workspace.render({ tasks: [waiting('a', ['a', 'b']), waiting('b', ['a', 'b'])], emptyHTML: '' });
  assert.equal(rows()[0].badges[0].label, '与1个任务共享等待');
  setLocale('en');
  workspace.render({ tasks: [waiting('a', ['a', 'b']), waiting('b', ['a', 'b'])], emptyHTML: '' });
  assert.equal(rows()[0].badges[0].label, 'Shared wait with 1 task');
  assert.equal(taskHtml.includes('[object Object]'), false);

  workspace.setMode('index');
  assert.equal(taskHtml.includes('</span></span></span></button>'), false);
  assert.match(taskHtml, /<div class="ws-row-title"><button class="ws-task-select"/);
  assert.match(taskHtml, /<\/span><\/button><button type="button" class="ws-shared-dep-badge"[^>]*>[^<]*<\/button><\/div>/);
  assert.equal(rows().every(row => row.html.slice(0, row.html.indexOf('</button>')).includes('ws-shared-dep-badge') === false), true);
});
