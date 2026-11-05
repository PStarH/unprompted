import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { digest } from './local-snapshot.js';
import { NativeAccessError, NativeSourceBridge } from '../native-sources.js';

export const CALENDAR_WINDOW = Object.freeze({ pastDays: 14, futureDays: 60, maxEvents: 500 });
const text = (value, max) => typeof value === 'string' && value.length <= max;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Selected calendars only. Descriptions are evidence, not invented to-dos. */
export function calendarSnapshot({ scopeId, records, cursor = null, complete = true, windowStart, now = Date.now, baseUrl = '', errors = [], lossReason = null }) {
  const previous = { ...(cursor?.documents || {}) }, next = { ...previous }, seen = new Set(), produced = [];
  const at = new Date(now()).toISOString();
  const emit = (id, known, type, payload, revision) => produced.push({ type, providerEventId: `calendar:${id}`, providerRevision: `${revision}:${payload.reason || payload.modifiedAt}`, operation: type === 'document.unavailable' ? 'delete' : 'upsert', at: payload.modifiedAt || at, payload });
  for (const item of records) {
    const id = `apple_calendar:${scopeId}:${digest(item.id)}`;
    seen.add(id);
    const known = previous[id];
    const content = [item.title, item.description || '', `Start: ${item.start}`, `End: ${item.end}`, item.location || '', item.allDay ? 'All day' : '', item.status || 'none'].filter(Boolean).join('\n').slice(0, 32000);
    const version = digest(`${item.title}\0${content}\0${item.status}\0${item.start}\0${item.end}`);
    if (item.status === 'cancelled') {
      if (!known || known.unavailable) continue;
      const revision = (known.observationRevision || 0) + 1;
      emit(id, known, 'document.unavailable', { id, title: known.title || item.title, reason: 'cancelled', modifiedAt: item.updatedAt || at, sourceObservationRevision: revision }, revision);
      next[id] = { ...known, unavailable: 'cancelled', observationRevision: revision, version };
      continue;
    }
    if (known?.version === version && !known.unavailable) continue;
    const revision = (known?.observationRevision || 0) + 1;
    const url = `${baseUrl}/api/local-sources/documents/${encodeURIComponent(id)}`;
    emit(id, known, 'document.modified', { id, title: item.title, content, kind: 'calendar_event', modifiedAt: item.updatedAt || at, sourceObservationRevision: revision, externalId: id, url }, revision);
    next[id] = { providerId: item.id, folderId: item.folderId, accountId: item.accountId, title: item.title, start: item.start, version, observationRevision: revision, unavailable: null };
  }
  if (complete) for (const [id, known] of Object.entries(previous)) {
    if (seen.has(id) || known.unavailable) continue;
    const aged = !lossReason && stamp(known.start) && stamp(windowStart) && Date.parse(known.start) < Date.parse(windowStart);
    const revision = (known.observationRevision || 0) + 1;
    const reason = lossReason || (aged ? 'outside_observed_window' : 'removed_or_cancelled');
    emit(id, known, 'document.unavailable', { id, title: known.title, reason, modifiedAt: at, sourceObservationRevision: revision }, revision);
    next[id] = { ...known, unavailable: reason, observationRevision: revision };
  }
  return { events: toNormalizedEvents('apple_calendar', 'apple_calendar', produced), cursor: { documents: next, counts: { documents: Object.keys(next).length } }, partial: !complete || errors.length > 0, errors };
}

export class AppleCalendarConnector extends Connector {
  constructor({ scopeId, folders = [], bridge = new NativeSourceBridge(), baseUrl = '', now = Date.now } = {}) {
    super({ id: 'apple_calendar', kind: 'apple_calendar' });
    Object.assign(this, { scopeId, folders, bridge, baseUrl, now, live: Boolean(scopeId && folders.length && bridge.platform === 'darwin'), shadow: true,
      account: { id: scopeId, label: 'Selected Apple calendars' } });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Selected calendar'], detail: 'Read upcoming and recent events in selected calendars. Modify is off.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['calendar.selected'] : [], observation: this.live ? 'poll' : 'none', write: [] }; }
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: null });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 0, unavailable: false };
  }
  #window() {
    const start = new Date(this.now() - CALENDAR_WINDOW.pastDays * 86400_000).toISOString();
    const end = new Date(this.now() + CALENDAR_WINDOW.futureDays * 86400_000).toISOString();
    return { start, end };
  }
  async pull({ cursor = null, signal } = {}) {
    if (!this.live) throw new ConnectorError('No calendar is connected.', { connectorId: this.id });
    const window = this.#window();
    let result;
    try { result = await this.bridge.readCalendar(this.folders, window, { signal }); }
    catch (error) {
      const message = error instanceof NativeAccessError ? error.message : 'Calendar could not be read. Check Automation access and try again.';
      const known = Object.values(cursor?.documents || {}).some(doc => !doc.unavailable);
      return calendarSnapshot({ scopeId: this.scopeId, records: [], cursor, complete: known, windowStart: window.start, now: this.now, baseUrl: this.baseUrl,
        lossReason: known ? 'permission_or_access_lost' : null, errors: [{ scope: 'calendar', message, retryable: true }] });
    }
    if (!Array.isArray(result.records) || !Array.isArray(result.errors) || typeof result.complete !== 'boolean') throw new ConnectorError('Calendar did not return a valid read result.', { connectorId: this.id });
    const allowed = new Map(this.folders.map(folder => [folder.folderId, folder]));
    const records = [];
    for (const item of result.records) {
      const folder = allowed.get(item.folderId);
      if (!folder || item.accountId !== folder.accountId || !text(item.id, 4096) || !item.id || !text(item.title, 500) || !item.title || !stamp(item.start) || !stamp(item.end) || !stamp(item.updatedAt) || !['confirmed', 'tentative', 'cancelled', 'none'].includes(item.status) || item.description != null && !text(item.description, 8000)) throw new ConnectorError('Calendar returned a record outside the selected calendars or with incomplete metadata.', { connectorId: this.id });
      records.push(item);
    }
    let complete = result.complete;
    if (records.length > CALENDAR_WINDOW.maxEvents) { records.length = CALENDAR_WINDOW.maxEvents; complete = false; }
    return calendarSnapshot({ scopeId: this.scopeId, records, cursor, complete, windowStart: window.start, now: this.now, baseUrl: this.baseUrl,
      errors: result.errors.map(() => ({ scope: 'calendar', message: 'Some selected calendars could not be read completely. Check access or choose fewer calendars.', retryable: true })) });
  }
}
