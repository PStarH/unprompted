import fs from 'node:fs';
import os from 'node:os';
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

/** mcp-server-git does not declare readOnlyHint. These names are the read grant; add, commit, reset, checkout and create_branch stay off. */
export const GIT_READ_TOOLS = Object.freeze(['git_status', 'git_log', 'git_diff', 'git_diff_unstaged', 'git_diff_staged', 'git_show', 'git_branch']);
export function isGitPresetServer(id, config) {
  return (id === 'git' || /^git-[1-9]\d*$/.test(id))
    && config?.type === 'stdio' && config.command === 'uvx' && Array.isArray(config.args) && config.args[0] === 'mcp-server-git';
}

export function isGitReadTool(name) {
  return typeof name === 'string' && GIT_READ_TOOLS.includes(name);
}

export function scopePaths(value) {
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  const items = text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  if (!items.length || items.length > 10) throw new Error('Choose 1 to 10 absolute paths.');
  let home;
  try { home = fs.realpathSync(os.homedir()); } catch { home = path.resolve(os.homedir()); }
  return items.map(item => {
    if (!path.isAbsolute(item) || item.includes('\0') || item.length > 4096) throw new Error('Each scope path must be absolute.');
    let resolved;
    try { resolved = fs.realpathSync(item); }
    catch { throw new Error('Each scope path must be an existing directory.'); }
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Each scope path must be a directory.');
    if (resolved === path.parse(resolved).root || resolved === home) throw new Error('Choose a specific directory, not the filesystem root or your home directory.');
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
    descriptionZh: '每个仓库单独启动一个只读服务，因为 Git MCP 的 --repository 只能指定一个路径。需要 uvx，不需要令牌。提交、重置等修改工具默认关闭。',
    descriptionEn: 'Each repository gets its own read-only server, because Git MCP accepts one --repository. Needs uvx. No token. Commit, reset and other modify tools stay off.',
    defaultEnabled: false,
    requiresAuth: false,
    readTools: GIT_READ_TOOLS,
    config: { type: 'stdio', command: 'uvx', args: ['mcp-server-git'] },
    fields: [{ key: 'repositories', labelZh: '仓库绝对路径', labelEn: 'Repository paths', placeholder: '/path/to/repo', type: 'paths', flag: '--repository', required: true,
      helpZh: '每行一个已存在的目录。每个仓库会单独连接。', helpEn: 'One existing directory per line. Each repository is connected separately.' }]
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
    descriptionZh: '查看你选择的目录。需要本机的 npx，不需要令牌。可修改目录的工具默认关闭，需要逐项允许。',
    descriptionEn: 'Read directories you choose. Needs npx on this computer. No token. Tools that can modify those directories stay off until you enable them.',
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
      if (field.flag && paths.length > 1) throw new Error('Each Git repository is connected as its own server.');
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
    ...(preset.readTools ? { readTools: [...preset.readTools] } : {}),
    ...(Object.keys(env).length ? { env } : {})
  };
}

function gitRepositoryArgs(config) {
  if (!config || config.type !== 'stdio' || config.command !== 'uvx' || !Array.isArray(config.args) || config.args[0] !== 'mcp-server-git') return null;
  const repos = [];
  for (let index = 1; index < config.args.length; index += 1) {
    if (config.args[index] !== '--repository' || typeof config.args[index + 1] !== 'string') return null;
    repos.push(config.args[index + 1]);
    index += 1;
  }
  return repos;
}

function gitReadToolsMatch(tools) {
  return Array.isArray(tools) && GIT_READ_TOOLS.every(name => tools.includes(name));
}

const FILESYSTEM_PREFIX = Object.freeze(['-y', '@modelcontextprotocol/server-filesystem']);

function filesystemPaths(config) {
  if (!config || config.type !== 'stdio' || config.command !== 'npx' || !Array.isArray(config.args)) return null;
  if (config.args.length <= FILESYSTEM_PREFIX.length || FILESYSTEM_PREFIX.some((arg, index) => config.args[index] !== arg)) return null;
  return config.args.slice(FILESYSTEM_PREFIX.length);
}

function nextGitId(reserved) {
  if (!reserved.has('git')) { reserved.add('git'); return 'git'; }
  for (let n = 2; n < 1000; n += 1) {
    const id = `git-${n}`;
    if (!reserved.has(id)) { reserved.add(id); return id; }
  }
  throw new Error('No free server name for a Git repository.');
}

/**
 * mcp-server-git keeps only the last --repository. One imported `git` server
 * with several paths becomes `git`, `git-2`, `git-3`, ... each with one path.
 * Returns the same object when nothing changes.
 */
export function expandImportedServers(servers) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return servers;
  let changed = false;
  const result = {};
  const failures = {};
  const reserved = new Set(Object.keys(servers));
  for (const [id, config] of Object.entries(servers)) {
    try {
      if (id === 'filesystem') {
        const paths = filesystemPaths(config);
        if (!paths?.length) { result[id] = config; continue; }
        const canonical = scopePaths(paths.join('\n'));
        if (canonical.length === paths.length && canonical.every((item, index) => item === paths[index])) { result[id] = config; continue; }
        changed = true;
        result[id] = { ...config, args: [...FILESYSTEM_PREFIX, ...canonical] };
        continue;
      }
      const repos = id === 'git' || /^git-[1-9]\d*$/.test(id) ? gitRepositoryArgs(config) : null;
      if (!repos?.length) { result[id] = config; continue; }
      const canonical = scopePaths(repos.join('\n'));
      if (id !== 'git' || canonical.length === 1) {
        const repo = canonical[0];
        if (canonical.length === 1 && repo === repos[0] && gitReadToolsMatch(config.readTools)) { result[id] = config; continue; }
        changed = true;
        result[id] = { ...config, args: ['mcp-server-git', '--repository', repo], readTools: [...GIT_READ_TOOLS] };
        continue;
      }
      changed = true;
      reserved.delete(id);
      for (const repo of canonical) {
        const serverId = nextGitId(reserved);
        result[serverId] = { ...config, args: ['mcp-server-git', '--repository', repo], readTools: [...GIT_READ_TOOLS] };
      }
    } catch (error) {
      failures[id] = error.message;
      result[id] = config;
    }
  }
  if (Object.keys(failures).length) {
    const error = new Error(Object.values(failures)[0]);
    error.serverErrors = failures;
    error.servers = changed ? result : servers;
    error.canonical = changed;
    throw error;
  }
  return changed ? result : servers;
}

/**
 * Checks preset ids only. `git-2` and later are checked when they are the
 * generated Git servers. A custom server id, even one that runs uvx
 * mcp-server-git, is not validated here.
 */
export function validatePresetConfig(id, config) {
  const generatedGit = /^git-[1-9]\d*$/.test(id) && gitRepositoryArgs(config);
  const preset = findPreset(generatedGit ? 'git' : id);
  const field = preset?.fields?.find(item => item.type === 'paths');
  if (!field || (id !== preset.id && !generatedGit)) return;
  if (config?.type !== 'stdio' || config.command !== preset.config.command) throw new Error(`${preset.name} must use its built-in ${preset.config.command} command.`);
  const prefix = preset.config.args;
  const args = config.args || [];
  if (args.length < prefix.length || prefix.some((arg, index) => args[index] !== arg)) throw new Error(`${preset.name} was given an unexpected command.`);
  const rest = args.slice(prefix.length);
  if (field.flag) {
    if (rest.length !== 2 || rest[0] !== field.flag) throw new Error(`${preset.name} accepts one repository per server.`);
    scopePaths(rest[1]);
    return;
  }
  if (!rest.length) throw new Error(`${preset.name} needs at least one directory.`);
  scopePaths(rest.join('\n'));
}
