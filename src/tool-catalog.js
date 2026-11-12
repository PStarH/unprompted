// Reserve the rest of the model window for the task and tool results. Schema
// constraints remain intact; only descriptions are shortened when necessary.
export const TOOL_CATALOG_MAX_CHARS = 10000;

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

export function fitToolCatalog(tools) {
  const workspace = tools.filter(isTaskTool);
  const external = tools.filter(tool => !isTaskTool(tool));
  const ordered = [...workspace, ...external];
  if (catalogSize(ordered) <= TOOL_CATALOG_MAX_CHARS) return { tools: ordered, omitted: 0 };
  let compact = ordered;
  for (const max of [240, 80, 0]) {
    compact = ordered.map(tool => isTaskTool(tool) ? tool : {
      ...tool, label: typeof tool.label === 'string' ? tool.label.slice(0, 160) : tool.label,
      description: typeof tool.description === 'string' && tool.description.length > max ? max ? `${tool.description.slice(0, max)}…` : '' : tool.description,
      parameters: compactDescriptions(tool.parameters, max)
    });
    if (catalogSize(compact) <= TOOL_CATALOG_MAX_CHARS) return { tools: compact, omitted: 0 };
  }
  const selected = [];
  for (const tool of compact) {
    if (catalogSize([...selected, tool]) <= TOOL_CATALOG_MAX_CHARS) selected.push(tool);
    else if (isTaskTool(tool)) throw Object.assign(new Error('The task tool catalog exceeds the model context budget.'), { code: 'TOOL_CATALOG_TOO_LARGE' });
  }
  return { tools: selected, omitted: compact.length - selected.length };
}
