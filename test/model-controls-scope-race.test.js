import test from 'node:test';
import assert from 'node:assert/strict';

test('changing budget scope hides stale forms and refuses old values while the new scope loads', async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  t.after(() => { globalThis.document = previous.document; globalThis.fetch = previous.fetch; });
  const handlers = new Map(), status = {};
  globalThis.document = { addEventListener: (name, fn) => handlers.set(name, fn), querySelector: () => status };
  let resolveScope, posts = 0, renders = 0;
  const scope = new Promise(resolve => { resolveScope = resolve; });
  const payload = taskId => ({ workspaceToken: 'workspace-test', taskId });
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') { posts++; throw new Error('Stale controls reached POST'); }
    const body = url.includes('?taskId=') ? await scope : url.endsWith('/routing') ? { workspaceToken: 'workspace-test' } : payload(null);
    return { ok: true, json: async () => body };
  };
  const controls = await import(`../public/model-controls.js?scope-race=${Date.now()}`);
  controls.modelControlsMarkup({ language: 'en', workspaceId: 'fixture' });
  controls.bindModelControls({ render: () => { renders++; }, connection: () => ({}) });
  await controls.refreshModelControls();
  const foreignForm = {matches:()=>false,elements:{moneyMajor:{value:'1.25'}}};
  await handlers.get('change')({target:{matches:()=>false,name:'moneyCurrency',form:foreignForm}});
  assert.equal(foreignForm.elements.moneyMajor.value,'1.25','model controls never mutate another feature form with the same field names');
  const before = renders;
  const changed = handlers.get('change')({ target: { matches: selector => selector === '[data-model-budget-task]', value: 'task-B' } });
  assert.equal(renders, before + 1, 'old scope controls are removed synchronously');
  const button = {}, error = {};
  const form = { querySelector: selector => selector.startsWith('button') ? button : error };
  await handlers.get('submit')({ target: { closest: () => form }, preventDefault() {} });
  assert.equal(posts, 0);
  assert.match(error.textContent, /scope is loading/);
  resolveScope(payload('task-B'));
  await changed;
  assert.equal(renders, before + 2);
});
