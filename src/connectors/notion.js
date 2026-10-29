import { Connector, ConnectorError, toNormalizedEvents } from './connector.js';
import { providerJSON } from './http.js';

const ORIGIN = 'https://api.notion.com';
const VERSION = '2022-06-28';
const TEXT_TYPES = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'callout', 'toggle', 'code']);

function notionId(value) {
  const compact = String(value || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  return compact.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function plain(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function pageTitle(page) {
  for (const property of Object.values(page.properties || {})) {
    if (property?.type === 'title' && Array.isArray(property.title)) {
      const text = plain(property.title.map(part => part?.plain_text || '').join(''));
      if (text) return text;
    }
  }
  return 'Untitled';
}

function blockLine(block) {
  if (block?.type === 'child_page') return plain(block.child_page?.title);
  if (!TEXT_TYPES.has(block?.type)) return '';
  const value = block[block.type] || {};
  const rich = Array.isArray(value.rich_text) ? value.rich_text : [];
  const text = plain(rich.map(part => part?.plain_text || '').join(''), 4000);
  if (!text) return '';
  if (block.type === 'to_do') return `${value.checked ? '[x]' : '[ ]'} ${text}`;
  if (block.type.endsWith('_list_item')) return `- ${text}`;
  return text;
}

function pageUrl(page, id) {
  try {
    const url = new URL(page.url);
    if (url.protocol === 'https:' && ['www.notion.so', 'notion.so'].includes(url.hostname) && !url.username && !url.password) return url.href;
  } catch { /* fall through to the canonical page URL */ }
  return `https://www.notion.so/${id.replace(/-/g, '')}`;
}

export class NotionConnector extends Connector {
  constructor({ auth, account, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    super({ id: 'notion', kind: 'notion', fetchImpl });
    Object.assign(this, { auth, account, now, live: Boolean(account?.id && auth), shadow: true });
  }
  validate() { return { ok: this.live, missing: this.live ? [] : ['Notion authorization'], detail: 'Read the Notion pages selected during authorization.' }; }
  capabilities() { return { ...super.capabilities(), read: this.live ? ['notion.pages'] : [], pagination: this.live ? ['notion.search'] : [], incremental: this.live ? ['notion.pages'] : [], observation: this.live ? 'poll' : 'none' }; }
  async #notion(path, { method = 'GET', body = null, signal } = {}) {
    return providerJSON(new URL(path, ORIGIN).href, { provider: this.id, origin: ORIGIN, fetchImpl: this.fetchImpl, method, signal, body,
      headers: { authorization: `Bearer ${await this.auth.accessToken()}`, 'Notion-Version': VERSION } });
  }
  async listHistoricalEvents({ limit = 20 } = {}) {
    if (!this.live) return { events: [], networkCalls: 0, unavailable: true };
    const page = await this.pull({ cursor: null });
    return { events: (page.events || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 20))), networkCalls: 1, unavailable: false };
  }
  async pull({ cursor = null } = {}) {
    if (!this.live) throw new ConnectorError('Notion is disconnected.', { connectorId: this.id });
    const since = Number.isFinite(Date.parse(cursor?.since || '')) ? cursor.since : null;
    const startCursor = typeof cursor?.startCursor === 'string' && cursor.startCursor.length <= 2048 && !/[\r\n]/.test(cursor.startCursor) ? cursor.startCursor : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const search = await this.#notion('/v1/search', { method: 'POST', signal: controller.signal, body: {
        filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 20,
        ...(startCursor ? { start_cursor: startCursor } : {}) } });
      if (!Array.isArray(search?.results)) throw new ConnectorError('Notion returned an invalid page listing.', { connectorId: this.id });
      const records = [];
      const errors = [];
      let partial = false;
      let reachedOld = false;
      let watermark = Number.isFinite(Date.parse(cursor?.watermark || '')) ? cursor.watermark : since;
      for (const page of search.results) {
        if (page?.object !== 'page') continue;
        const id = notionId(page.id);
        const edited = Date.parse(page.last_edited_time);
        if (!id || !Number.isFinite(edited)) {
          partial = true;
          errors.push({ scope: 'pages', message: 'Notion returned an incomplete page.', retryable: false });
          continue;
        }
        if (since && edited < Date.parse(since)) { reachedOld = true; continue; }
        const editedAt = new Date(edited).toISOString();
        let content = '';
        try {
          const blocks = await this.#notion(`/v1/blocks/${id}/children?page_size=50`, { signal: controller.signal });
          if (!Array.isArray(blocks?.results)) throw new ConnectorError('Notion returned an invalid page body.', { connectorId: this.id });
          content = blocks.results.map(blockLine).filter(Boolean).join('\n').slice(0, 8000);
        } catch (error) {
          partial = true;
          errors.push({ scope: 'pages', message: error.message, retryable: error.retryable === true });
          if (error.retryable) break;
          continue;
        }
        if (!watermark || edited > Date.parse(watermark)) watermark = editedAt;
        records.push({ type: 'document.modified', providerEventId: `page:${id}:${editedAt}`, at: editedAt,
          payload: { id: `notion:${id}`, title: pageTitle(page), kind: 'document', content, modifiedAt: editedAt, externalId: id, url: pageUrl(page, id) } });
      }
      const events = toNormalizedEvents(this.id, 'notion', records);
      if (partial) return { events, cursor: cursor || { since: null }, partial, errors, hasMore: false };
      const nextCursor = !reachedOld && search.has_more === true && typeof search.next_cursor === 'string' && search.next_cursor.length <= 2048 && !/[\r\n]/.test(search.next_cursor)
        ? search.next_cursor : null;
      if (nextCursor) return { events, cursor: { since, watermark, startCursor: nextCursor }, partial, errors, hasMore: true };
      return { events, cursor: { since: watermark || since || new Date(this.now()).toISOString() }, partial, errors, hasMore: false };
    } finally { clearTimeout(timer); }
  }
}
