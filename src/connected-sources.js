import { GitHubConnector } from './connectors/github.js';
import { OutlookConnector } from './connectors/outlook.js';
import { SavedConnectionAuth } from './device-oauth.js';
import { LocalFilesConnector } from './connectors/local-files.js';
import { AppleNotesConnector } from './connectors/apple-notes.js';
import { NativeSourceBridge } from './native-sources.js';

export function connectedSources(setup, { fetchImpl = globalThis.fetch, nativeBridge = new NativeSourceBridge(), baseUrl = '' } = {}) {
  const cloud = [['github', GitHubConnector], ['microsoft', OutlookConnector]].flatMap(([id, Constructor]) => {
    const saved = setup.getConnection(id);
    if (!saved.accessToken || !saved.account?.id) return [];
    return [new Constructor({ account: saved.account, auth: new SavedConnectionAuth(setup, id, { fetchImpl }), fetchImpl })];
  });
  const local = setup.getNativeSource?.('local_files');
  const notes = setup.getNativeSource?.('apple_notes');
  return [...cloud,
    ...(local?.scopeId && local.roots.length ? [new LocalFilesConnector({ ...local, baseUrl })] : []),
    ...(notes?.scopeId && notes.folders.length && nativeBridge.platform === 'darwin' ? [new AppleNotesConnector({ ...notes, bridge: nativeBridge, baseUrl })] : [])];
}

export function sourceCounts(state, id) {
  const account = state.connectionAccounts?.[id];
  return { messages: state.inbox.filter(message => message.connectorId === id && message.accountId === account).length,
    issues: Object.values(state.tasks).filter(task => task.kind === 'external_issue' && task.sourceConnectorId === id && task.status !== 'cancelled').length,
    tasks: Object.values(state.tasks).filter(task => task.sourceConnectorId === id && task.status !== 'cancelled').length,
    documents: Object.values(state.documents).filter(document => document.source === id && document.available !== false).length };
}

export function sourceAccountBindings(setup) {
  return Object.fromEntries([
    ...['github', 'microsoft'].map(id => [id, setup.getConnection(id).account?.id || null]),
    ...['local_files', 'apple_notes'].map(id => [id, setup.getNativeSource(id).scopeId || null])
  ]);
}
