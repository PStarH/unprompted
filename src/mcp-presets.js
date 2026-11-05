import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localTimeZone = (() => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && /^[A-Za-z0-9_+-]{1,64}(?:\/[A-Za-z0-9_+-]{1,64}){0,2}$/.test(zone) ? zone : 'UTC';
  } catch { return 'UTC'; }
})();

export const RUNTIME_HINTS = Object.freeze({
  uvx: {
    hintZh: '未找到 uvx。安装 uv 后即可连接，不需要 API Key 或 OAuth 应用。参见 https://docs.astral.sh/uv/getting-started/installation/',
    hintEn: 'uvx was not found. Install uv, then retry. No API key or OAuth app is required.'
  },
  npx: {
    hintZh: '未找到 npx。安装 Node.js 后即可连接，不需要 API Key。',
    hintEn: 'npx was not found. Install Node.js, then retry. No API key is required.'
  }
});

export function scopePaths(value) {
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  const items = text.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean);
  if (!items.length || items.length > 10) throw new Error('Choose 1 to 10 absolute paths.');
  return items.map(item => {
    if (!path.isAbsolute(item) || item.includes('\0') || item.length > 4096) throw new Error('Each scope path must be absolute.');
    const resolved = path.resolve(item);
    if (resolved === path.parse(resolved).root) throw new Error('Choose a specific directory, not the filesystem root.');
    return resolved;
  });
}
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
    id: 'git',
    name: 'Git',
    category: 'code',
    auth: 'none',
    runtime: 'uvx',
    tagZh: '无需账号',
    tagEn: 'No account',
    titleZh: '本地 Git 仓库',
    titleEn: 'Local Git repositories',
    descriptionZh: '只读查看你选择的仓库。需要本机的 uvx，不需要令牌。修改默认关闭。',
    descriptionEn: 'Read repositories you choose. Needs uvx on this computer. No token. Modify stays off.',
    defaultEnabled: false,
    requiresAuth: false,
    config: { type: 'stdio', command: 'uvx', args: ['mcp-server-git'] },
    fields: [{ key: 'repositories', labelZh: '仓库绝对路径', labelEn: 'Repository paths', placeholder: '/path/to/repo', type: 'paths', flag: '--repository', required: true,
      helpZh: '每行一个绝对路径。只读取这些仓库。', helpEn: 'One absolute path per line. Only these repositories are read.' }]
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'files',
    auth: 'none',
    runtime: 'npx',
    tagZh: '无需账号',
    tagEn: 'No account',
    titleZh: '本地文件夹',
    titleEn: 'Local directories',
    descriptionZh: '只读查看你选择的目录。需要本机的 npx，不需要令牌。修改默认关闭。',
    descriptionEn: 'Read directories you choose. Needs npx on this computer. No token. Modify stays off.',
    defaultEnabled: false,
    requiresAuth: false,
    config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    fields: [{ key: 'directories', labelZh: '目录绝对路径', labelEn: 'Directory paths', placeholder: '/path/to/notes', type: 'paths', required: true,
      helpZh: '每行一个绝对路径。服务器不能读到这些目录之外。', helpEn: 'One absolute path per line. The server cannot read outside them.' }]
  },
  {
    id: 'time',
    name: 'Time',
    category: 'utility',
    auth: 'none',
    runtime: 'uvx',
    tagZh: '无需账号',
    tagEn: 'No account',
    titleZh: '当前时间',
    titleEn: 'Current time',
    descriptionZh: '提供这台电脑的当前时间。需要 uvx，不需要配置。只读。',
    descriptionEn: 'Provides the current time on this computer. Needs uvx and no other configuration. Read only.',
    defaultEnabled: false,
    requiresAuth: false,
    config: { type: 'stdio', command: 'uvx', args: ['mcp-server-time', '--local-timezone', localTimeZone] },
    fields: []
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'docs',
    auth: 'none',
    tagZh: '无需账号',
    tagEn: 'No account',
    titleZh: '公开仓库文档',
    titleEn: 'Public repository docs',
    descriptionZh: '连接 DeepWiki 的公开 MCP 服务，查阅公开仓库文档。不需要登录或密钥。只读。',
    descriptionEn: 'Connects to DeepWiki’s public MCP service for public repository documentation. No sign-in and no key. Read only.',
    defaultEnabled: false,
    requiresAuth: false,
    config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
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
  if (preset.config?.url) return { type: preset.config.type || 'http', url: preset.config.url };
  const env = {};
  const extraArgs = [];
  for (const field of preset.fields) {
    const val = envInput[field.key];
    if (field.type === 'paths') {
      if (field.required && (typeof val !== 'string' || !val.trim()) && !Array.isArray(val)) throw new Error(`Missing required field for ${preset.name}: ${field.labelEn || field.key}`);
      const paths = scopePaths(val);
      if (field.flag) for (const item of paths) extraArgs.push(field.flag, item);
      else extraArgs.push(...paths);
      continue;
    }
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
    args: [...preset.config.args, ...extraArgs],
    ...(Object.keys(env).length ? { env } : {})
  };
}

/** Preset ids keep their built-in command. User-chosen paths must be absolute. */
export function validatePresetConfig(id, config) {
  const preset = findPreset(id);
  const field = preset?.fields?.find(item => item.type === 'paths');
  if (!field) return;
  if (config?.type !== 'stdio' || config.command !== preset.config.command) throw new Error(`${preset.name} must use its built-in ${preset.config.command} command.`);
  const prefix = preset.config.args;
  const args = config.args || [];
  if (args.length < prefix.length || prefix.some((arg, index) => args[index] !== arg)) throw new Error(`${preset.name} was given an unexpected command.`);
  const rest = args.slice(prefix.length);
  const paths = [];
  if (field.flag) {
    if (rest.length % 2) throw new Error(`${preset.name} scope paths are incomplete.`);
    for (let index = 0; index < rest.length; index += 2) {
      if (rest[index] !== field.flag) throw new Error(`${preset.name} scope paths must use ${field.flag}.`);
      paths.push(rest[index + 1]);
    }
  } else paths.push(...rest);
  scopePaths(paths);
}
