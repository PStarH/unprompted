import { getLocale } from './i18n.js';

const t = (zh, en) => getLocale() === 'en' ? en : zh;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function createMcpPanel({ update, post, context, refresh, notify }) {
  let busy = false, error = '', mode = 'url';
  const dialog = document.getElementById('mcpDialog');
  if (!dialog) return { render() {} };
  function render() {
    const panel = document.getElementById('mcpContent');
    const setup = context();
    panel.hidden = setup.demo === true;
    const servers = setup.mcp?.servers || [];
    const status = value => ({ connected: t('已连接', 'Connected'), connecting: t('连接中', 'Connecting'), failed: t('连接失败', 'Connection failed'), disconnected: t('已断开', 'Disconnected') })[value] || value;
    update('mcpContent', `<div class="mcp-heading"><h2>MCP</h2><button class="secondary-button" data-mcp-add>${t('添加服务', 'Add server')}</button></div>${!servers.length ? `<p class="muted">${t('连接外部工具，让 Agent 在任务中使用。', 'Connect external tools for the agent to use in tasks.')}</p>` : ''}${servers.map(server => `<article class="mcp-server" data-mcp-server="${esc(server.id)}"><div class="mcp-server-heading"><div><strong>${esc(server.id)}</strong><small>${esc(server.type === 'stdio' ? t('本机进程', 'Local process') : server.endpoint)} · ${server.tools.filter(tool => tool.allowed).length}/${server.tools.length} ${t('工具可用', 'tools enabled')}</small></div><span class="mcp-status" data-status="${esc(server.status)}">${server.enabled ? status(server.status) : t('已停用', 'Disabled')}</span><button class="text-button" data-mcp-action="${server.enabled ? 'disable' : 'enable'}" data-mcp-id="${esc(server.id)}" ${busy ? 'disabled' : ''}>${server.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}</button><button class="icon-button" data-mcp-action="reconnect" data-mcp-id="${esc(server.id)}" aria-label="${t('重新连接', 'Reconnect')} ${esc(server.id)}" title="${t('重新连接', 'Reconnect')}" ${busy || !server.enabled ? 'disabled' : ''}>↻</button></div>${server.lastError ? `<p class="mcp-error" role="status">${esc(localError(server.lastError))}</p>` : ''}${server.status === 'connected' && !server.tools.length && !server.resources?.length ? `<p class="muted">${t('此服务没有提供工具或资源。', 'This server exposes no tools or resources.')}</p>` : ''}${server.tools.length ? `<details data-preserve="mcp-tools-${esc(server.id)}"><summary>${t('工具与权限', 'Tools and access')}</summary><p class="muted mcp-note">${t('仅授权你确认用于读取的工具。', 'Enable only tools you trust to read data.')}</p>${server.tools.map(tool => `<label class="mcp-tool"><input type="checkbox" data-mcp-tool="${esc(tool.name)}" data-mcp-id="${esc(server.id)}" ${tool.allowed ? 'checked' : ''} ${busy || !server.enabled || tool.writeTool ? 'disabled' : ''}><span><strong>${esc(tool.name)}</strong><small>${esc(tool.description)}</small><small>${tool.writeTool ? t('写入工具暂未开放', 'Write tools are not enabled') : tool.declaredReadOnly ? t('服务声明：只读', 'Server declares: read only') : t('未声明只读 · 勾选即授权为读取工具', 'Read only not declared · checking grants read access')}</small></span></label>`).join('')}</details>` : ''}${server.resources?.length ? `<details data-preserve="mcp-resources-${esc(server.id)}"><summary>${t('资源与权限', 'Resources and access')}</summary><p class="muted mcp-note">${t('选择允许 Agent 在任务中读取的资源。资源内容会发送给已配置的模型。', 'Select resources the agent may read during tasks. Content can be sent to your configured model.')}</p>${server.resources.map(resource => `<label class="mcp-tool"><input type="checkbox" data-mcp-resource="${esc(resource.id)}" data-mcp-id="${esc(server.id)}" ${resource.allowed ? 'checked' : ''} ${busy || !server.enabled ? 'disabled' : ''}><span><strong>${esc(resource.name)}</strong><small>${esc(resource.description)}</small></span></label>`).join('')}</details>` : ''}<div class="mcp-server-footer"><button class="text-button" data-mcp-action="replace" data-mcp-id="${esc(server.id)}">${t('替换配置', 'Replace config')}</button><button class="text-button" data-mcp-action="remove" data-mcp-id="${esc(server.id)}" ${busy ? 'disabled' : ''}>${t('移除', 'Remove')}</button></div></article>`).join('')}${error ? `<p class="mcp-error" role="alert">${esc(error)}</p>` : ''}`);
    if (!dialog.open) renderForm();
  }
  function renderForm() {
    update('mcpFormContent', `<div class="mcp-tabs" role="group" aria-label="${t('配置方式', 'Setup method')}"><button type="button" class="text-button" data-mcp-mode="url" aria-pressed="${mode === 'url'}">${t('远程地址', 'Server URL')}</button><button type="button" class="text-button" data-mcp-mode="json" aria-pressed="${mode === 'json'}">${t('粘贴配置', 'Paste config')}</button></div><form id="mcpConnectForm">${mode === 'url' ? `<label>${t('服务名称', 'Server name')}<input name="name" maxlength="64" placeholder="notion" autocomplete="off" required></label><label>${t('MCP 地址', 'MCP URL')}<input name="url" type="url" placeholder="https://example.com/mcp" autocomplete="off" required></label><label>${t('访问令牌（可选）', 'Access token (optional)')}<input name="token" type="password" autocomplete="new-password" placeholder="Bearer token"></label>` : `<label>${t('MCP 配置', 'MCP config')}<textarea name="config" rows="9" maxlength="131072" spellcheck="false" autocomplete="off" placeholder='{"mcpServers":{"my-server":{"command":"npx","args":["-y","package-name"]}}}' required></textarea></label><p class="muted mcp-note">${t('支持 mcpServers 格式。本机命令以你的用户权限运行，请使用可信服务。', 'Accepts mcpServers config. Local commands run as your user; use trusted servers.')}</p>`}<label class="mcp-consent"><input name="read" type="checkbox" checked><span>${t('允许 Agent 自动使用此服务声明的只读工具', 'Let the agent use tools this server declares read only')}</span></label><p id="mcpFormError" class="mcp-error" role="alert"></p><div class="mcp-form-actions"><button class="secondary-button" type="button" data-mcp-close>${t('取消', 'Cancel')}</button><button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${busy ? t('连接中…', 'Connecting…') : t('连接', 'Connect')}</button></div></form>`);
  }
  function open(nextMode = 'url', id = '') {
    mode = nextMode; renderForm();
    dialog.showModal();
    if (id && mode === 'json') {
      const field = dialog.querySelector('[name=config]');
      field.placeholder = JSON.stringify({ mcpServers: { [id]: { url: 'https://example.com/mcp' } } }, null, 2);
    }
    dialog.querySelector('input,textarea')?.focus();
  }
  function localError(message) {
    const messages = {
      'MCP request failed. Check the server configuration and reconnect.': 'MCP 请求失败，请检查服务配置后重连。',
      'MCP authentication failed. Check the authorization header or server credentials.': '认证失败，请检查访问令牌或服务凭据。',
      'MCP executable not found. Check the command and installation.': '找不到本机命令，请检查安装和命令路径。',
      'MCP connection timed out. Check the server and reconnect.': '连接超时，请检查服务后重连。',
      'MCP SDK unavailable. Run npm ci --include=optional and restart.': 'MCP 依赖未安装，请运行 npm ci --include=optional 后重启。',
      'Invalid MCP JSON.': '配置不是有效的 JSON。'
    };
    return getLocale() === 'en' ? message : messages[message] || message;
  }
  async function mutate(id, body) {
    if (busy) return;
    busy = true; error = ''; render();
    try { await post(`/api/mcp/servers/${encodeURIComponent(id)}`, body); await refresh(); }
    catch (cause) { error = localError(cause.message); notify(error, true); }
    finally { busy = false; render(); }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-mcp-add')) return open();
    if (button.hasAttribute('data-mcp-close') && !busy) return dialog.close();
    if (button.dataset.mcpMode && !busy) { mode = button.dataset.mcpMode; renderForm(); return; }
    const action = button.dataset.mcpAction;
    if (!action || busy) return;
    const id = button.dataset.mcpId;
    if (action === 'replace') return open('json', id);
    void mutate(id, action === 'remove' ? { remove: true } : action === 'reconnect' ? { reconnect: true } : { enabled: action === 'enable' });
  });
  document.addEventListener('change', event => {
    const resourceInput = event.target.closest('[data-mcp-resource]');
    if (resourceInput && !busy) {
      const server = context().mcp?.servers.find(item => item.id === resourceInput.dataset.mcpId);
      if (!server) return;
      const allowed = new Set(server.resources.filter(resource => resource.allowed).map(resource => resource.id));
      if (resourceInput.checked) allowed.add(resourceInput.dataset.mcpResource); else allowed.delete(resourceInput.dataset.mcpResource);
      void mutate(server.id, { readResources: [...allowed] });
      return;
    }
    const input = event.target.closest('[data-mcp-tool]');
    if (!input || busy) return;
    const server = context().mcp?.servers.find(item => item.id === input.dataset.mcpId);
    if (!server) return;
    const allowed = new Set(server.tools.filter(tool => tool.allowed).map(tool => tool.name));
    if (input.checked) allowed.add(input.dataset.mcpTool); else allowed.delete(input.dataset.mcpTool);
    void mutate(server.id, { allowDeclaredRead: false, readTools: [...allowed] });
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.querySelector('form')?.reset();
    document.querySelector('[data-mcp-add]')?.focus();
  });
  dialog.addEventListener('submit', async event => {
    if (event.target.id !== 'mcpConnectForm') return;
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.target);
    const config = mode === 'json' ? form.get('config') : { mcpServers: { [String(form.get('name')).trim()]: { url: String(form.get('url')).trim(), ...(form.get('token') ? { headers: { Authorization: `Bearer ${String(form.get('token')).trim().replace(/^Bearer\s+/i, '')}` } } : {}) } } };
    busy = true;
    const submit = event.target.querySelector('[type=submit]'); submit.disabled = true; submit.textContent = t('连接中…', 'Connecting…');
    document.getElementById('mcpFormError').textContent = '';
    try {
      const result = await post('/api/mcp/import', { config, allowDeclaredRead: form.has('read') });
      event.target.reset();
      dialog.close(); renderForm(); await refresh();
      const failed = result.mcp.servers.some(server => server.enabled && server.status === 'failed');
      notify(failed ? t('配置已保存，请检查连接错误。', 'Config saved. Review the connection error.') : t('MCP 已连接', 'MCP connected'), failed);
    } catch (cause) { document.getElementById('mcpFormError').textContent = localError(cause.message); }
    finally { busy = false; if (submit.isConnected) { submit.disabled = false; submit.textContent = t('连接', 'Connect'); } render(); }
  });
  return { render };
}
