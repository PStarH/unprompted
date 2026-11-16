// Reserve the rest of the model window for the task and tool results. Schema
// constraints remain intact; only descriptions are shortened when necessary.
export const TOOL_CATALOG_MAX_CHARS = 10000;

// A dispatcher shared by every tool from one MCP manager. The key is a private
// symbol, so it never reaches JSON/provider payloads, and an MCP server cannot
// forge it from tool metadata. It is enumerable because the runtime wraps read
// tools with object spread; the brand must survive that wrapper.
const FALLBACK = Symbol('unprompted.toolCatalogFallback');
const DISPATCHER_NAMES = new Set(['find_connected_tools', 'call_connected_tool']);

export function registerToolFallback(tools, group) {
  if (!group || typeof group.build !== 'function') return;
  for (const tool of Array.isArray(tools) ? tools : [tools]) {
    if (!tool || typeof tool !== 'object') continue;
    Object.defineProperty(tool, FALLBACK, { value: group, enumerable: true, configurable: true, writable: true });
  }
}

function fallbackFor(tool) {
  return tool && typeof tool === 'object' ? tool[FALLBACK] : undefined;
}

function compactDescriptions(value, max) {
  if (Array.isArray(value)) return value.map(item => compactDescriptions(item, max));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['enum', 'const', 'default', 'examples', 'example'].includes(key) || key.startsWith('x-') ? item
      : key === 'description' && typeof item === 'string' && item.length > max
      ? max ? `${item.slice(0, max)}…` : ''
      : compactDescriptions(item, max)]));
}

function catalogSize(tools) {
  return JSON.stringify(tools.map(({ name, label, description, parameters }) => ({ name, label, description, parameters }))).length;
}

const isTaskTool = tool => tool.contextProvider === 'workspace' || tool.name === 'create_work_artifact';

function compactTool(tool, max) {
  return isTaskTool(tool) ? tool : {
    ...tool, label: typeof tool.label === 'string' ? tool.label.slice(0, 160) : tool.label,
    description: typeof tool.description === 'string' && tool.description.length > max ? max ? `${tool.description.slice(0, max)}…` : '' : tool.description,
    parameters: compactDescriptions(tool.parameters, max)
  };
}

// Fit once, reporting which original tools could not stay inline. Callers use
// the identity of omitted tools to find a bounded on-demand catalog.
function fitOnce(tools) {
  const workspace = tools.filter(isTaskTool);
  const external = tools.filter(tool => !isTaskTool(tool));
  const ordered = [...workspace, ...external];
  if (catalogSize(ordered) <= TOOL_CATALOG_MAX_CHARS) return { tools: ordered, omitted: 0, omittedTools: [] };
  let compact = ordered;
  for (const max of [240, 80, 0]) {
    compact = ordered.map(tool => compactTool(tool, max));
    if (catalogSize(compact) <= TOOL_CATALOG_MAX_CHARS) return { tools: compact, omitted: 0, omittedTools: [] };
  }
  const selected = [], selectedIndexes = new Set();
  for (let index = 0; index < compact.length; index++) {
    const tool = compact[index];
    if (catalogSize([...selected, tool]) <= TOOL_CATALOG_MAX_CHARS) { selected.push(tool); selectedIndexes.add(index); }
    else if (isTaskTool(tool)) throw Object.assign(new Error('The task tool catalog exceeds the model context budget.'), { code: 'TOOL_CATALOG_TOO_LARGE' });
  }
  return { tools: selected, omitted: compact.length - selected.length,
    omittedTools: ordered.filter((_tool, index) => !selectedIndexes.has(index)) };
}

export function fitToolCatalog(tools) {
  const initial = fitOnce(tools);
  if (!initial.omitted) return { tools: initial.tools, omitted: 0 };
  // A count-overflow catalog already carries one dispatcher for its manager.
  if (tools.some(tool => DISPATCHER_NAMES.has(tool.name))) return { tools: initial.tools, omitted: initial.omitted };
  const groups = new Map();
  for (const tool of initial.omittedTools) {
    const group = fallbackFor(tool);
    if (group && !groups.has(group.owner)) groups.set(group.owner, group);
  }
  if (!groups.size) return { tools: initial.tools, omitted: initial.omitted };
  const names = new Set(tools.map(tool => tool.name)), mandatory = [];
  for (const group of groups.values()) {
    for (const tool of group.build()) {
      if (tool && !names.has(tool.name)) { mandatory.push(tool); names.add(tool.name); }
    }
  }
  // Keep the bounded finder/caller as workspace-level entries, then re-fit the
  // rest. Their group tools may stay omitted because the pair makes them
  // reachable with current permissions and the untouched server schema.
  const next = fitOnce([...mandatory, ...tools]);
  return { tools: next.tools, omitted: next.omitted };
}
