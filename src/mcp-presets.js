import { fileURLToPath } from 'node:url';
export const MCP_PRESETS = Object.freeze([
  {
    id: 'fetch',
    name: 'Fetch',
    category: 'web',
    auth: 'none',
    tagZh: '无需账号',
    tagEn: 'No account',
    titleZh: '网页内容提取',
    titleEn: 'Web content reader',
    descriptionZh: '使用内置运行时读取公开网页的文本，无需安装命令行工具。',
    descriptionEn: 'Reads public web pages as bounded plain text with the bundled runtime.',
    defaultEnabled: true,
    requiresAuth: false,
    config: {
      type: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-fetch-server.js', import.meta.url))]
    },
    fields: []
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'docs',
    auth: 'oauth',
    tagZh: '登录即可',
    tagEn: 'Sign in',
    titleZh: 'Notion 页面',
    titleEn: 'Notion pages',
    descriptionZh: '在 Notion 官方页面登录，查阅你有权访问的页面。不需要集成密钥，也不会自动创建任务。',
    descriptionEn: 'Sign in on Notion to look up pages you can access. No integration secret, and this does not create tasks.',
    defaultEnabled: false,
    requiresAuth: true,
    config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    fields: []
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'issues',
    auth: 'oauth',
    tagZh: '登录即可',
    tagEn: 'Sign in',
    titleZh: 'Linear 议题',
    titleEn: 'Linear issues',
    descriptionZh: '在 Linear 官方页面登录，查阅议题、项目和阻碍。不需要 API Key，也不会自动创建任务。',
    descriptionEn: 'Sign in on Linear to look up issues, projects, and blockers. No API key, and this does not create tasks.',
    defaultEnabled: false,
    requiresAuth: true,
    config: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    fields: []
  },
  {
    id: 'atlassian',
    name: 'Jira and Confluence',
    category: 'issues',
    auth: 'oauth',
    tagZh: '登录即可',
    tagEn: 'Sign in',
    titleZh: 'Jira 与 Confluence',
    titleEn: 'Jira and Confluence',
    descriptionZh: '在 Atlassian 官方页面登录，查询 Jira 和 Confluence。不需要 API Token。组织管理员可能仍要允许此应用。',
    descriptionEn: 'Sign in on Atlassian to look up Jira and Confluence. No API token. An organization admin may still need to allow the app.',
    defaultEnabled: false,
    requiresAuth: true,
    config: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2' },
    fields: []
  },
  {
    id: 'todoist',
    name: 'Todoist',
    category: 'tasks',
    auth: 'oauth',
    tagZh: '登录即可',
    tagEn: 'Sign in',
    titleZh: 'Todoist 任务',
    titleEn: 'Todoist tasks',
    descriptionZh: '在 Todoist 官方页面登录，查阅任务和项目。不需要 API Token，也不会自动创建任务。',
    descriptionEn: 'Sign in on Todoist to look up tasks and projects. No API token, and this does not create tasks.',
    defaultEnabled: false,
    requiresAuth: true,
    config: { type: 'http', url: 'https://ai.todoist.net/mcp' },
    fields: []
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    category: 'search',
    auth: 'key',
    tagZh: '需要密钥',
    tagEn: 'API key',
    titleZh: 'Brave 网页搜索',
    titleEn: 'Brave Search',
    descriptionZh: '实时网络与新闻搜索，为调查提供最新外部证据。此服务只提供 API Key。',
    descriptionEn: 'Real-time web and news search for current external evidence. This service only offers an API key.',
    defaultEnabled: false,
    requiresAuth: true,
    config: {
      type: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-key-server.js', import.meta.url)), 'brave-search']
    },
    fields: [
      {
        key: 'BRAVE_API_KEY',
        labelZh: 'Brave Search API Key',
        labelEn: 'Brave Search API Key',
        placeholder: 'BSA...',
        type: 'password',
        required: true
      }
    ]
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'search',
    auth: 'key',
    tagZh: '需要密钥',
    tagEn: 'API key',
    titleZh: 'Firecrawl 深度爬虫',
    titleEn: 'Firecrawl Web Scraper',
    descriptionZh: '深度网页抓取与站点抽取。此服务只提供 API Key。',
    descriptionEn: 'Deep web scraping and crawling. This service only offers an API key.',
    defaultEnabled: false,
    requiresAuth: true,
    config: {
      type: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-key-server.js', import.meta.url)), 'firecrawl']
    },
    fields: [
      {
        key: 'FIRECRAWL_API_KEY',
        labelZh: 'Firecrawl API Key',
        labelEn: 'Firecrawl API Key',
        placeholder: 'fc-...',
        type: 'password',
        required: true
      }
    ]
  }
]);

export function findPreset(id) {
  return MCP_PRESETS.find(item => item.id === id) || null;
}

export function publicPresetConnection(preset) {
  if (preset.auth === 'oauth' || preset.config?.url) return { type: 'http', url: preset.config.url };
  return { type: 'stdio', command: preset.config.command, args: [...preset.config.args] };
}

export function buildPresetServerConfig(id, envInput = {}) {
  const preset = findPreset(id);
  if (!preset) throw new Error(`Unknown MCP preset: ${id}`);
  if (preset.auth === 'oauth') return { type: 'http', url: preset.config.url };
  const env = {};
  for (const field of preset.fields) {
    const val = envInput[field.key];
    if (field.required && (!val || typeof val !== 'string' || !val.trim())) {
      throw new Error(`Missing required field for ${preset.name}: ${field.labelEn || field.key}`);
    }
    if (val && typeof val === 'string' && val.trim()) {
      env[field.key] = val.trim();
    }
  }
  return {
    type: preset.config.type || 'stdio',
    command: preset.config.command,
    args: [...preset.config.args],
    ...(Object.keys(env).length ? { env } : {})
  };
}
