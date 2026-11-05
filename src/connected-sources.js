import { TodoistConnector } from './connectors/todoist.js';
import { AppleRemindersConnector } from './connectors/apple-reminders.js';
import { GitHubConnector } from './connectors/github.js';
import { OutlookConnector } from './connectors/outlook.js';
import { SlackConnector } from './connectors/slack.js';
import { NotionConnector } from './connectors/notion.js';
import { SavedConnectionAuth } from './device-oauth.js';
import { LocalFilesConnector } from './connectors/local-files.js';
import { AppleNotesConnector } from './connectors/apple-notes.js';
import { NativeSourceBridge } from './native-sources.js';

export function connectedSources(setup, { fetchImpl = globalThis.fetch, nativeBridge = new NativeSourceBridge(), baseUrl = '' } = {}) {
  const cloud = [['github', GitHubConnector], ['microsoft', OutlookConnector], ['slack', SlackConnector], ['notion', NotionConnector], ['todoist', TodoistConnector]].flatMap(([id, Constructor]) => {
    const saved = setup.getConnection(id);
    if (!saved.accessToken || !saved.account?.id) return [];
    const connector = new Constructor({ account: saved.account, scopes: saved.scopes || [], auth: new SavedConnectionAuth(setup, id, { fetchImpl }), fetchImpl });
    // Refresh can reduce a provider grant without rebuilding the runtime. Never
    // report the old scopes, or scopes belonging to a replacement account.
    Object.defineProperty(connector, 'scopes', { configurable: true, enumerable: true, get() {
      const current = setup.getConnection(id);
      return current.account?.id === saved.account.id && Array.isArray(current.scopes) ? [...current.scopes] : [];
    } });
    return [connector];
  });
  const local = setup.getNativeSource?.('local_files');
  const notes = setup.getNativeSource?.('apple_notes');
  const reminders = setup.getNativeSource?.('apple_reminders');
  return [...cloud,
    ...(reminders?.scopeId && reminders.folders.length && nativeBridge.platform === 'darwin' ? [new AppleRemindersConnector({ ...reminders, bridge: nativeBridge, baseUrl })] : []),
    ...(local?.scopeId && local.roots.length ? [new LocalFilesConnector({ ...local, baseUrl })] : []),
    ...(notes?.scopeId && notes.folders.length && nativeBridge.platform === 'darwin' ? [new AppleNotesConnector({ ...notes, bridge: nativeBridge, baseUrl })] : [])];
}

export function sourceCounts(state, id) {
  const account = state.connectionAccounts?.[id];
  return { messages: state.inbox.filter(message => message.connectorId === id && message.accountId === account).length,
    issues: Object.values(state.tasks).filter(task => ['external_issue', 'external_review', 'external_change', 'external_check'].includes(task.kind) && task.sourceConnectorId === id && task.status !== 'cancelled').length,
    tasks: Object.values(state.tasks).filter(task => task.sourceConnectorId === id && task.status !== 'cancelled').length,
    documents: Object.values(state.documents).filter(document => document.source === id && document.available !== false).length };
}

export function sourceAccountBindings(setup) {
  return Object.fromEntries([
    ...['github', 'microsoft', 'slack', 'notion', 'todoist'].map(id => [id, setup.getConnection(id).account?.id || null]),
    ...['local_files', 'apple_notes', 'apple_reminders'].map(id => [id, setup.getNativeSource(id).scopeId || null])
  ]);
}
