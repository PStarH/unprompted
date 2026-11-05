import { getLocale } from './i18n.js';

const t = (zh, en) => getLocale() === 'en' ? en : zh;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const DEFAULT_PRESETS = [
  {
    id: 'fetch', name: 'Fetch', auth: 'none', tagZh: '无需账号', tagEn: 'No account',
    titleZh: '网页内容提取', titleEn: 'Web content reader',
    descriptionZh: '抓取任意网页并自动转为大模型易读的 Markdown，开箱即用。',
    descriptionEn: 'Fetches web pages and converts them to clean Markdown for LLMs.',
    defaultEnabled: true, connection: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }, fields: []
  },
  {
    id: 'notion', name: 'Notion', auth: 'oauth', tagZh: '登录即可', tagEn: 'Sign in',
    titleZh: 'Notion 页面', titleEn: 'Notion pages',
    descriptionZh: '在 Notion 官方页面登录，查阅你有权访问的页面。不需要集成密钥，也不会自动创建任务。',
    descriptionEn: 'Sign in on Notion to look up pages you can access. No integration secret, and this does not create tasks.',
    connection: { type: 'http', url: 'https://mcp.notion.com/mcp' }, fields: []
  },
  {
    id: 'linear', name: 'Linear', auth: 'oauth', tagZh: '登录即可', tagEn: 'Sign in',
    titleZh: 'Linear 议题', titleEn: 'Linear issues',
    descriptionZh: '在 Linear 官方页面登录，查阅议题、项目和阻碍。不需要 API Key，也不会自动创建任务。',
    descriptionEn: 'Sign in on Linear to look up issues, projects, and blockers. No API key, and this does not create tasks.',
    connection: { type: 'http', url: 'https://mcp.linear.app/mcp' }, fields: []
  },
  {
    id: 'atlassian', name: 'Jira and Confluence', auth: 'oauth', tagZh: '登录即可', tagEn: 'Sign in',
    titleZh: 'Jira 与 Confluence', titleEn: 'Jira and Confluence',
    descriptionZh: '在 Atlassian 官方页面登录，查询 Jira 和 Confluence。不需要 API Token。组织管理员可能仍要允许此应用。',
    descriptionEn: 'Sign in on Atlassian to look up Jira and Confluence. No API token. An organization admin may still need to allow the app.',
    connection: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2' }, fields: []
  },
  {
    id: 'todoist', name: 'Todoist', auth: 'oauth', tagZh: '登录即可', tagEn: 'Sign in',
    titleZh: 'Todoist 任务', titleEn: 'Todoist tasks',
    descriptionZh: '在 Todoist 官方页面登录，查阅任务和项目。不需要 API Token，也不会自动创建任务。',
    descriptionEn: 'Sign in on Todoist to look up tasks and projects. No API token, and this does not create tasks.',
    connection: { type: 'http', url: 'https://ai.todoist.net/mcp' }, fields: []
  },
  {
    id: 'brave-search', name: 'Brave Search', auth: 'key', tagZh: '需要密钥', tagEn: 'API key',
    titleZh: 'Brave 网页搜索', titleEn: 'Brave Search',
    descriptionZh: '实时网络与新闻搜索，为调查提供最新外部证据。此服务只提供 API Key。',
    descriptionEn: 'Real-time web and news search for current external evidence. This service only offers an API key.',
    connection: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
    fields: [{ key: 'BRAVE_API_KEY', labelZh: 'Brave Search API Key', labelEn: 'Brave Search API Key', placeholder: 'BSA...', type: 'password', required: true }]
  },
  {
    id: 'firecrawl', name: 'Firecrawl', auth: 'key', tagZh: '需要密钥', tagEn: 'API key',
    titleZh: 'Firecrawl 深度爬虫', titleEn: 'Firecrawl Web Scraper',
    descriptionZh: '深度网页抓取与站点抽取。此服务只提供 API Key。',
    descriptionEn: 'Deep web scraping and crawling. This service only offers an API key.',
    connection: { type: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp'] },
    fields: [{ key: 'FIRECRAWL_API_KEY', labelZh: 'Firecrawl API Key', labelEn: 'Firecrawl API Key', placeholder: 'fc-...', type: 'password', required: true }]
  }
];

const presetAuth = preset => preset.auth || (preset.fields?.length ? 'key' : 'none');
const presetRecipe = preset => preset.connection || (preset.command ? { type: 'stdio', command: preset.command, args: preset.args || [] } : null);

export function createMcpPanel({ update, post, context, refresh, notify }) {
  let busy = false, error = '', mode = 'url', targetPresetId = '';
  const signingIn = new Set(), polls = new Map();
  const dialog = document.getElementById('mcpDialog');
  if (!dialog) return { render() {} };

  function render() {
    const panel = document.getElementById('mcpContent');
    const setup = context();
    panel.hidden = setup.demo === true;
    const servers = setup.mcp?.servers || [];
    const presets = setup.mcp?.presets || DEFAULT_PRESETS;
    const status = value => ({ connected: t('已连接', 'Connected'), connecting: t('连接中', 'Connecting'), failed: t('连接失败', 'Connection failed'), disconnected: t('已断开', 'Disconnected') })[value] || value;

    const card = preset => {
      const configured = servers.find(server => server.id === preset.id);
      const auth = presetAuth(preset);
      const phase = preset.oauthPhase || configured?.oauthPhase;
      let actions = '';
      if (auth === 'oauth') {
        if (phase === 'authorizing' && preset.authorizeUrl) {
          actions = `<a class="secondary-button" href="${esc(preset.authorizeUrl)}" target="_blank" rel="noopener noreferrer">${t('打开登录页', 'Open sign-in')}</a><button type="button" class="text-button" data-mcp-oauth-cancel="${esc(preset.id)}">${t('取消', 'Cancel')}</button>`;
        } else {
          const label = preset.signedIn ? t('重新登录', 'Sign in again') : t('登录并连接', 'Sign in and connect');
          actions = `${configured ? `<span class="mcp-status" data-status="${esc(configured.status)}">${configured.enabled ? status(configured.status) : t('已停用', 'Disabled')}</span>` : ''}<button type="button" class="secondary-button" data-mcp-oauth="${esc(preset.id)}" ${busy || signingIn.has(preset.id) ? 'disabled' : ''}>${label}</button>`;
        }
      } else if (configured) {
        actions = `<span class="mcp-status" data-status="${esc(configured.status)}">${configured.enabled ? status(configured.status) : t('已停用', 'Disabled')}</span><button type="button" class="text-button" data-mcp-preset-open="${esc(preset.id)}">${t('修改', 'Configure')}</button>`;
      } else if (preset.id === 'fetch') {
        actions = `<button type="button" class="secondary-button" data-mcp-preset-quick="fetch" ${busy ? 'disabled' : ''}>${t('开启 Fetch', 'Enable Fetch')}</button>`;
      } else {
        actions = `<button type="button" class="text-button" data-mcp-preset-open="${esc(preset.id)}">${t('配置', 'Configure')}</button>`;
      }
      const oauthError = preset.oauthError || configured?.oauthError;
      return `
        <article class="mcp-preset-card" data-mcp-preset="${esc(preset.id)}" data-auth="${esc(auth)}">
          <div>
            <span class="mcp-preset-tag">${esc(t(preset.tagZh || '内置推荐', preset.tagEn || 'Preset'))}</span>
            <div><strong>${esc(preset.name)}</strong> · <small>${esc(t(preset.titleZh, preset.titleEn))}</small></div>
            <p>${esc(t(preset.descriptionZh, preset.descriptionEn))}</p>
            ${oauthError ? `<p class="mcp-error" role="status">${esc(localError(oauthError))}</p>` : ''}
          </div>
          <div class="mcp-preset-card-footer">${actions}</div>
        </article>`;
    };
    const groups = [
      ['none', t('无需账号', 'No account'), ''],
      ['oauth', t('登录即可', 'Sign in'), t('打开服务商的登录页，不需要 Client Secret 或 API Token。这些连接用来查阅已有工作，不会自动发现新任务。', 'Sign in on the vendor page. No client secret or API token. These lookups do not discover new tasks.')],
      ['key', t('需要密钥', 'Needs a key'), t('这些服务只提供 API Key。密钥只保存在这台电脑上。', 'These services only offer an API key. The key stays on this computer.')]
    ];
    const presetsHtml = `
      <div class="mcp-presets-bar">
        ${groups.map(([auth, title, note]) => {
          const items = presets.filter(preset => presetAuth(preset) === auth);
          if (!items.length) return '';
          return `<h3 class="mcp-preset-group-title">${title}</h3>${note ? `<p class="muted mcp-preset-group-note">${note}</p>` : ''}${items.map(card).join('')}`;
        }).join('')}
      </div>
    `;

    update('mcpContent', `
      <div class="mcp-heading">
        <div>
          <h2>MCP</h2>
          <p class="muted mcp-subheading">${t('Notion、Linear、Jira / Confluence 和 Todoist 点登录即可。Brave 和 Firecrawl 仍需要密钥。', 'Sign in for Notion, Linear, Jira / Confluence, and Todoist. Brave and Firecrawl still need a key.')}</p>
        </div>
        <div class="mcp-heading-actions">
          <button class="secondary-button" data-mcp-presets-open>${t('内置推荐服务', 'Preset services')}</button>
          <button class="secondary-button" data-mcp-add>${t('添加服务', 'Add server')}</button>
        </div>
      </div>
      ${presetsHtml}
      ${!servers.length ? `<p class="muted">${t('尚未连接自定义 MCP 服务。可使用上方推荐预置或手动添加。', 'No custom MCP servers connected. Use the presets above or add manually.')}</p>` : ''}
      ${servers.map(server => `
        <article class="mcp-server" data-mcp-server="${esc(server.id)}">
          <div class="mcp-server-heading">
            <div>
              <strong>${esc(server.id)}</strong>
              <small>${esc(server.type === 'stdio' ? t('本机进程', 'Local process') : server.endpoint)} · ${server.tools.filter(tool => tool.allowed).length}/${server.tools.length} ${t('工具可用', 'tools enabled')}</small>
            </div>
            <span class="mcp-status" data-status="${esc(server.status)}">${server.enabled ? status(server.status) : t('已停用', 'Disabled')}</span>
            <button class="text-button" data-mcp-action="${server.enabled ? 'disable' : 'enable'}" data-mcp-id="${esc(server.id)}" ${busy ? 'disabled' : ''}>${server.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}</button>
            <button class="icon-button" data-mcp-action="reconnect" data-mcp-id="${esc(server.id)}" aria-label="${t('重新连接', 'Reconnect')} ${esc(server.id)}" title="${t('重新连接', 'Reconnect')}" ${busy || !server.enabled ? 'disabled' : ''}>↻</button>
          </div>
          ${server.lastError ? `<p class="mcp-error" role="status">${esc(localError(server.lastError))}</p>` : ''}
          ${server.status === 'connected' && !server.tools.length && !server.resources?.length ? `<p class="muted">${t('此服务没有提供工具或资源。', 'This server exposes no tools or resources.')}</p>` : ''}
          ${server.tools.length ? `
            <details data-preserve="mcp-tools-${esc(server.id)}">
              <summary>${t('工具与权限', 'Tools and access')}</summary>
              <p class="muted mcp-note">${t('勾选工具即允许 Agent 在当前任务中使用它；操作工具可修改服务中的数据，可随时撤销。', 'Selected tools may be used for current tasks. Action tools can change service data. You can revoke access at any time.')}</p>
              ${server.tools.map(tool => `
                <label class="mcp-tool">
                  <input type="checkbox" data-mcp-tool="${esc(tool.name)}" data-mcp-write="${tool.writeTool ? 'true' : 'false'}" data-mcp-id="${esc(server.id)}" ${tool.allowed ? 'checked' : ''} ${busy || !server.enabled ? 'disabled' : ''}>
                  <span>
                    <strong>${esc(tool.name)}</strong>
                    <small>${esc(tool.description)}</small>
                    <small>${tool.writeTool ? t('操作权限 · 允许该工具执行修改或其他操作', 'Action access · allows this tool to make changes or perform other operations') : tool.declaredReadOnly ? t('服务声明：只读', 'Server declares: read only') : t('未声明只读 · 勾选即授权为读取工具', 'Read only not declared · checking grants read access')}</small>
                  </span>
                </label>
              `).join('')}
            </details>
          ` : ''}
          ${server.resources?.length ? `
            <details data-preserve="mcp-resources-${esc(server.id)}">
              <summary>${t('资源与权限', 'Resources and access')}</summary>
              <p class="muted mcp-note">${t('选择允许 Agent 在任务中读取的资源。资源内容会发送给已配置的模型。', 'Select resources the agent may read during tasks. Content can be sent to your configured model.')}</p>
              ${server.resources.map(resource => `
                <label class="mcp-tool">
                  <input type="checkbox" data-mcp-resource="${esc(resource.id)}" data-mcp-id="${esc(server.id)}" ${resource.allowed ? 'checked' : ''} ${busy || !server.enabled ? 'disabled' : ''}>
                  <span>
                    <strong>${esc(resource.name)}</strong>
                    <small>${esc(resource.description)}</small>
                  </span>
                </label>
              `).join('')}
            </details>
          ` : ''}
          <div class="mcp-server-footer">
            <button class="text-button" data-mcp-action="replace" data-mcp-id="${esc(server.id)}">${t('替换配置', 'Replace config')}</button>
            <button class="text-button" data-mcp-action="remove" data-mcp-id="${esc(server.id)}" ${busy ? 'disabled' : ''}>${t('移除', 'Remove')}</button>
          </div>
        </article>
      `).join('')}
      ${error ? `<p class="mcp-error" role="alert">${esc(error)}</p>` : ''}
    `);
    if (!dialog.open) renderForm();
  }

  function renderForm() {
    const setup = context();
    const servers = setup.mcp?.servers || [];
    const presets = setup.mcp?.presets || DEFAULT_PRESETS;

    const tabsHtml = `
      <div class="mcp-tabs" role="group" aria-label="${t('配置方式', 'Setup method')}">
        <button type="button" class="text-button" data-mcp-mode="presets" aria-pressed="${mode === 'presets'}">${t('内置推荐', 'Built-in presets')}</button>
        <button type="button" class="text-button" data-mcp-mode="url" aria-pressed="${mode === 'url'}">${t('远程地址', 'Server URL')}</button>
        <button type="button" class="text-button" data-mcp-mode="json" aria-pressed="${mode === 'json'}">${t('粘贴配置', 'Paste config')}</button>
      </div>
    `;

    let formBody = '';
    if (mode === 'url') {
      formBody = `
        <label>${t('服务名称', 'Server name')}<input name="name" maxlength="64" placeholder="notion" autocomplete="off" required></label>
        <label>${t('MCP 地址', 'MCP URL')}<input name="url" type="url" placeholder="https://example.com/mcp" autocomplete="off" required></label>
        <label>${t('传输', 'Transport')}<select name="transport"><option value="http" selected>Streamable HTTP</option><option value="sse">SSE</option></select></label>
        <label>${t('访问令牌（可选）', 'Access token (optional)')}<input name="token" type="password" autocomplete="new-password" placeholder="Bearer token"></label>
      `;
    } else if (mode === 'json') {
      formBody = `
        <label>${t('MCP 配置', 'MCP config')}<textarea name="config" rows="9" maxlength="131072" spellcheck="false" autocomplete="off" placeholder='{"mcpServers":{"my-server":{"command":"npx","args":["-y","package-name"]}}}' required></textarea></label>
        <p class="muted mcp-note">${t('支持 mcpServers 格式。本机命令以你的用户权限运行，请使用可信服务。', 'Accepts mcpServers config. Local commands run as your user; use trusted servers.')}</p>
      `;
    } else {
      const formPresets = presets.filter(preset => presetAuth(preset) !== 'oauth');
      const oauthNames = presets.filter(preset => presetAuth(preset) === 'oauth').map(preset => preset.name).join('、');
      formBody = `
        <p class="muted mcp-note">${t(`${oauthNames} 请在卡片上选择「登录并连接」，这里不填写密钥。`, `${oauthNames.replaceAll('、', ', ')} use Sign in and connect on the card. This form does not ask for a token.`)}</p>
        <div class="mcp-preset-form-list">
          ${formPresets.map(preset => {
            const configured = servers.find(s => s.id === preset.id);
            const isChecked = configured ? configured.enabled : (preset.defaultEnabled || preset.id === targetPresetId);
            return `
              <div class="mcp-preset-form-item" data-preset-item="${esc(preset.id)}">
                <label class="mcp-preset-checkbox-label">
                  <input type="checkbox" name="preset_${esc(preset.id)}" data-preset-toggle="${esc(preset.id)}" ${isChecked ? 'checked' : ''}>
                  <div>
                    <strong>${esc(preset.name)}</strong> · <span>${esc(t(preset.titleZh, preset.titleEn))}</span>
                    <small class="muted">${esc(t(preset.descriptionZh, preset.descriptionEn))}</small>
                  </div>
                </label>
                ${preset.fields && preset.fields.length ? `
                  <div class="mcp-preset-fields" data-preset-fields="${esc(preset.id)}" ${isChecked ? '' : 'hidden'}>
                    ${preset.fields.map(f => `
                      <label>
                        <span>${esc(t(f.labelZh || f.label, f.labelEn || f.label))}</span>
                        <input name="field_${esc(preset.id)}_${esc(f.key)}" type="${esc(f.type || 'text')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">
                      </label>
                    `).join('')}
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    update('mcpFormContent', `
      ${tabsHtml}
      <form id="mcpConnectForm">
        ${formBody}
        <label class="mcp-consent">
          <input name="read" type="checkbox" checked>
          <span>${t('允许 Agent 自动使用此服务声明的只读工具', 'Let the agent use tools this server declares read only')}</span>
        </label>
        <p id="mcpFormError" class="mcp-error" role="alert"></p>
        <div class="mcp-form-actions">
          <button class="secondary-button" type="button" data-mcp-close>${t('取消', 'Cancel')}</button>
          <button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${busy ? t('连接中…', 'Connecting…') : (mode === 'presets' ? t('保存并连接所选服务', 'Save and connect') : t('连接', 'Connect'))}</button>
        </div>
      </form>
    `);
  }

  function open(nextMode = 'url', id = '') {
    mode = nextMode;
    targetPresetId = (mode === 'presets' && id) ? id : '';
    renderForm();
    dialog.showModal();
    if (id && mode === 'json') {
      const field = dialog.querySelector('[name=config]');
      if (field) field.placeholder = JSON.stringify({ mcpServers: { [id]: { url: 'https://example.com/mcp' } } }, null, 2);
    }
    dialog.querySelector('input:not([type=checkbox]),textarea')?.focus();
  }

  function localError(message) {
    const messages = {
      'MCP request failed. Check the server configuration and reconnect.': 'MCP 请求失败，请检查服务配置后重连。',
      'MCP authentication failed. Check the authorization header or server credentials.': '认证失败，请检查访问令牌或服务凭据。',
      'MCP executable not found. Check the command and installation.': '找不到本机命令，请检查安装和命令路径。',
      'MCP connection timed out. Check the server and reconnect.': '连接超时，请检查服务后重连。',
      'MCP SDK unavailable. Run npm ci --include=optional and restart.': 'MCP 依赖未安装，请运行 npm ci --include=optional 后重启。',
      'Invalid MCP JSON.': '配置不是有效的 JSON。',
      'The local authorization port is already in use. Close the other Unprompted window and try again.': '本机登录端口已被占用。请关闭另一个 Unprompted 窗口后再试。',
      'This service does not support one-click sign-in.': '这个服务不支持一键登录。',
      'Sign-in could not start.': '登录没能开始。',
      'Sign-in could not be completed.': '登录没有完成。',
      'Sign-in required. Use Sign in and connect.': '需要重新登录。请使用「登录并连接」。',
      'Unknown MCP sign-in.': '没有这个一键登录服务。',
      'MCP sign-in uses the built-in service address.': '登录使用内置服务地址，不能改成其他地址。'
    };
    return getLocale() === 'en' ? message : messages[message] || message;
  }

  async function mutate(id, body) {
    if (busy) return;
    busy = true; error = ''; render();
    try {
      await post(`/api/mcp/servers/${encodeURIComponent(id)}`, body);
      await refresh();
    } catch (cause) {
      error = localError(cause.message);
      notify(error, true);
    } finally {
      busy = false;
      render();
    }
  }

  function watchSignIn(id) {
    if (polls.has(id)) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      try { await refresh(); } catch { /* The card keeps the sign-in link until this stops. */ }
      render();
      const preset = (context().mcp?.presets || []).find(item => item.id === id);
      const phase = preset?.oauthPhase;
      if (phase === 'authorized' || phase === 'failed' || Date.now() - started > 90_000) {
        clearInterval(timer);
        polls.delete(id);
        if (phase === 'authorized') notify(t(`${preset.name} 已登录并连接`, `${preset.name} is signed in`));
        if (phase === 'failed') notify(localError(preset.oauthError || 'Sign-in could not be completed.'), true);
      }
    }, 1500);
    polls.set(id, timer);
  }

  async function signIn(id) {
    if (busy || signingIn.has(id)) return;
    // Open while the click is still a browser user gesture; OAuth discovery can
    // take long enough that opening after the network request is blocked.
    const popup = window.open('about:blank', '_blank', 'popup,width=600,height=760');
    if (popup) { try { popup.opener = null; } catch { /* browser isolation may already apply */ } }
    signingIn.add(id);
    error = '';
    render();
    try {
      const result = await post(`/api/mcp/oauth/${encodeURIComponent(id)}`, {});
      const authorizeUrl = result.oauth?.authorizeUrl;
      if (authorizeUrl && popup && !popup.closed) popup.location.href = authorizeUrl;
      else if (!authorizeUrl && popup && !popup.closed) popup.close();
      await refresh();
      if (result.oauth?.phase === 'authorized') notify(t('已登录并连接', 'Signed in'));
      else watchSignIn(id);
    } catch (cause) {
      if (popup && !popup.closed) popup.close();
      notify(localError(cause.message), true);
    } finally {
      signingIn.delete(id);
      render();
    }
  }

  async function cancelSignIn(id) {
    const timer = polls.get(id);
    if (timer) { clearInterval(timer); polls.delete(id); }
    try {
      await post(`/api/mcp/oauth/${encodeURIComponent(id)}`, { cancel: true });
      await refresh();
    } catch (cause) {
      notify(localError(cause.message), true);
    }
    render();
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-mcp-add')) return open('url');
    if (button.hasAttribute('data-mcp-presets-open')) return open('presets');
    if (button.dataset.mcpPresetOpen) return open('presets', button.dataset.mcpPresetOpen);
    if (button.hasAttribute('data-mcp-close') && !busy) return dialog.close();
    if (button.dataset.mcpMode && !busy) {
      mode = button.dataset.mcpMode;
      renderForm();
      return;
    }
    if (button.dataset.mcpPresetQuick === 'fetch') {
      if (busy) return;
      busy = true;
      try {
        const preset = (context().mcp?.presets || DEFAULT_PRESETS).find(item => item.id === 'fetch');
        const recipe = presetRecipe(preset) || { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] };
        const config = { mcpServers: { fetch: recipe.type === 'http' ? { url: recipe.url } : { command: recipe.command, args: recipe.args } } };
        await post('/api/mcp/import', { config, allowDeclaredRead: true });
        await refresh();
        notify(t('Fetch 网页提取已连接', 'Fetch tool connected'));
      } catch (cause) {
        notify(localError(cause.message), true);
      } finally {
        busy = false;
        render();
      }
      return;
    }
    if (button.dataset.mcpOauth) {
      void signIn(button.dataset.mcpOauth);
      return;
    }
    if (button.dataset.mcpOauthCancel) {
      void cancelSignIn(button.dataset.mcpOauthCancel);
      return;
    }
    const action = button.dataset.mcpAction;
    if (!action || busy) return;
    const id = button.dataset.mcpId;
    if (action === 'replace') return open('json', id);
    void mutate(id, action === 'remove' ? { remove: true } : action === 'reconnect' ? { reconnect: true } : { enabled: action === 'enable' });
  });

  document.addEventListener('change', event => {
    const toggle = event.target.closest('[data-preset-toggle]');
    if (toggle) {
      const presetId = toggle.dataset.presetToggle;
      const fields = dialog.querySelector(`[data-preset-fields="${presetId}"]`);
      if (fields) fields.hidden = !toggle.checked;
      return;
    }
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
    const reads = new Set(server.tools.filter(tool => tool.allowed && !tool.writeTool).map(tool => tool.name));
    const writes = new Set(server.tools.filter(tool => tool.allowed && tool.writeTool).map(tool => tool.name));
    const allowed = input.dataset.mcpWrite === 'true' ? writes : reads;
    if (input.checked) allowed.add(input.dataset.mcpTool); else allowed.delete(input.dataset.mcpTool);
    void mutate(server.id, { allowDeclaredRead: false, readTools: [...reads], writeTools: [...writes] });
  });

  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.querySelector('form')?.reset();
    document.querySelector('[data-mcp-add]')?.focus();
  });

  dialog.addEventListener('submit', async event => {
    if (event.target.id !== 'mcpConnectForm') return;
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.target);
    const setup = context();
    const presets = setup.mcp?.presets || DEFAULT_PRESETS;
    const servers = setup.mcp?.servers || [];
    let config;

    if (mode === 'presets') {
      const mcpServers = {};
      for (const preset of presets) {
        if (presetAuth(preset) === 'oauth' || !form.has(`preset_${preset.id}`)) continue;
        const recipe = presetRecipe(preset);
        if (!recipe?.command && !recipe?.url) {
          document.getElementById('mcpFormError').textContent = t(`${preset.name} 缺少连接方式。`, `${preset.name} has no connection recipe.`);
          return;
        }
        if (recipe.type === 'http' || recipe.url) {
          mcpServers[preset.id] = { url: recipe.url };
          continue;
        }
        const env = {};
        for (const f of (preset.fields || [])) {
          const val = String(form.get(`field_${preset.id}_${f.key}`) || '').trim();
          if (!val) {
            const existing = servers.find(s => s.id === preset.id);
            if (!existing) {
              const err = t(`请填写 ${preset.name} 的 ${f.labelZh || f.label}`, `Please provide ${f.labelEn || f.label} for ${preset.name}`);
              document.getElementById('mcpFormError').textContent = err;
              return;
            }
          } else {
            env[f.key] = val;
          }
        }
        mcpServers[preset.id] = {
          command: recipe.command,
          args: recipe.args,
          ...(Object.keys(env).length ? { env } : {})
        };
      }
      if (!Object.keys(mcpServers).length) {
        document.getElementById('mcpFormError').textContent = t('请至少勾选一个要启用的服务。', 'Please select at least one service to enable.');
        return;
      }
      config = { mcpServers };
    } else if (mode === 'json') {
      config = form.get('config');
    } else {
      config = {
        mcpServers: {
          [String(form.get('name')).trim()]: {
            type: form.get('transport') === 'sse' ? 'sse' : 'http',
            url: String(form.get('url')).trim(),
            ...(form.get('token') ? { headers: { Authorization: `Bearer ${String(form.get('token')).trim().replace(/^Bearer\s+/i, '')}` } } : {})
          }
        }
      };
    }

    busy = true;
    const submit = event.target.querySelector('[type=submit]');
    submit.disabled = true;
    submit.textContent = t('连接中…', 'Connecting…');
    document.getElementById('mcpFormError').textContent = '';
    try {
      const result = await post('/api/mcp/import', { config, allowDeclaredRead: form.has('read') });
      event.target.reset();
      dialog.close();
      renderForm();
      await refresh();
      const failed = result.mcp.servers.some(server => server.enabled && server.status === 'failed');
      notify(failed ? t('配置已保存，请检查连接错误。', 'Config saved. Review the connection error.') : t('MCP 已连接', 'MCP connected'), failed);
    } catch (cause) {
      document.getElementById('mcpFormError').textContent = localError(cause.message);
    } finally {
      busy = false;
      if (submit.isConnected) {
        submit.disabled = false;
        submit.textContent = mode === 'presets' ? t('保存并连接所选服务', 'Save and connect') : t('连接', 'Connect');
      }
      render();
    }
  });

  return { render };
}
