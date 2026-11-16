/** Catalog order for work sources. Apple apps are macOS capabilities, not universal recommendations. */
export const CONNECTION_ORDER = Object.freeze(['google', 'github', 'microsoft', 'slack', 'notion', 'local_files', 'apple_notes', 'apple_reminders', 'apple_calendar', 'apple_mail', 'apple_contacts', 'todoist']);
const APPLE_SOURCES = ['apple_notes', 'apple_reminders', 'apple_calendar', 'apple_mail', 'apple_contacts'];

export function showAppleNotes(localSources) {
  const notes = localSources?.apple_notes || {};
  return notes.available === true || notes.connected === true;
}

export function visibleConnectionIds(localSources) {
  return CONNECTION_ORDER.filter(id => APPLE_SOURCES.includes(id) ? localSources?.[id]?.available === true || localSources?.[id]?.connected === true : true);
}

export function homePrimaryIds(localSources) {
  return localSources?.apple_notes?.available === true
    ? ['local_files', 'apple_notes', 'google']
    : ['local_files', 'google'];
}

export function localOfferHeading(localSources) {
  return localSources?.apple_notes?.available === true
    ? '这台 Mac 可以直接连接本地文件夹和备忘录，都不需要账号。'
    : '这台电脑可以直接连接本地文件夹，不需要账号。';
}
