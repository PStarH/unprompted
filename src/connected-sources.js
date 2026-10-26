import { GitHubConnector } from './connectors/github.js';
import { OutlookConnector } from './connectors/outlook.js';
import { SavedConnectionAuth } from './device-oauth.js';

export function connectedSources(setup, { fetchImpl = globalThis.fetch } = {}) {
  return [['github', GitHubConnector], ['microsoft', OutlookConnector]].flatMap(([id, Constructor]) => {
    const saved = setup.getConnection(id);
    if (!saved.accessToken || !saved.account?.id) return [];
    return [new Constructor({ account: saved.account, auth: new SavedConnectionAuth(setup, id, { fetchImpl }), fetchImpl })];
  });
}

export function sourceCounts(state, id) {
  const account = state.connectionAccounts?.[id];
  return { messages: state.inbox.filter(message => message.connectorId === id && message.accountId === account).length,
    issues: Object.values(state.tasks).filter(task => task.kind === 'external_issue' && task.sourceConnectorId === id && task.status !== 'cancelled').length,
    tasks: Object.values(state.tasks).filter(task => task.sourceConnectorId === id && task.status !== 'cancelled').length };
}
