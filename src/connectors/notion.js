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
  const text = plain(rich.map(part => part?.plain_text || '').join(''), 32000);
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
  async #pageContent(id, signal) {
    const pending = [{ id, depth: 0 }], lines = [];
    let calls = 0, chars = 0;
    while (pending.length) {
      const parent = pending.shift(); let token = null;
      const seen = new Set();
      do {
        if (++calls > 20) throw new ConnectorError('Notion page exceeds the bounded block-read budget; select a smaller page.', { connectorId: this.id });
        const blocks = await this.#notion(`/v1/blocks/${parent.id}/children?${new URLSearchParams({ page_size: '50', ...(token ? { start_cursor: token } : {}) })}`, { signal });
        if (!Array.isArray(blocks?.results)) throw new ConnectorError('Notion returned an invalid page body.', { connectorId: this.id });
        for (const block of blocks.results) {
          const line = blockLine(block);
          if (line) { chars += line.length + 1; if (chars > 32000) throw new ConnectorError('Notion page exceeds the text-read budget; select a smaller page.', { connectorId: this.id }); lines.push(line); }
          if (block.has_children) {
            const child = notionId(block.id);
            if (!child || parent.depth >= 4) throw new ConnectorError('Notion nested blocks exceed the supported depth.', { connectorId: this.id });
            pending.push({ id: child, depth: parent.depth + 1 });
          }
        }
        const next = blocks.has_more ? blocks.next_cursor : null;
        if (blocks.has_more && (!next || typeof next !== 'string' || seen.has(next))) throw new ConnectorError('Notion block pagination did not advance.', { connectorId: this.id, retryable: true });
        if (next) seen.add(next);
        token = next;
      } while (token);
    }
    return lines.join('\n');
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
    // Pages seen recently, so a page that is deleted or no longer shared with
    // the integration can be noticed: search silently stops returning it.
    const known = cursor?.pages && typeof cursor.pages === 'object' && !Array.isArray(cursor.pages) ? { ...cursor.pages } : {};
    const seenNow = new Set();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const searchBody = { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 20 };
      let search;
      try { search = await this.#notion('/v1/search', { method: 'POST', signal: controller.signal, body: { ...searchBody, ...(startCursor ? { start_cursor: startCursor } : {}) } }); }
      catch (error) {
        if (!startCursor || ![400, 410].includes(error.status)) throw error;
        search = await this.#notion('/v1/search', { method: 'POST', signal: controller.signal, body: searchBody });
      }
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
        if (page.archived === true || page.in_trash === true) {
          delete known[id]; seenNow.add(id);
          records.push({ type: 'document.unavailable', providerEventId: `page-removed:${id}:${editedAt}`, at: editedAt,
            payload: { id: `notion:${id}`, title: pageTitle(page), reason: page.in_trash === true ? 'trashed' : 'archived', modifiedAt: editedAt, externalId: id } });
          continue;
        }
        let content = '';
        try {
          content = await this.#pageContent(id, controller.signal);
        } catch (error) {
          partial = true;
          errors.push({ scope: 'pages', message: error.message, retryable: error.retryable === true });
          if (error.retryable) break;
          continue;
        }
        if (!watermark || edited > Date.parse(watermark)) watermark = editedAt;
        known[id] = editedAt; seenNow.add(id);
        records.push({ type: 'document.modified', providerEventId: `page:${id}:${editedAt}`, at: editedAt,
          payload: { id: `notion:${id}`, title: pageTitle(page), kind: 'document', content, modifiedAt: editedAt, externalId: id, url: pageUrl(page, id) } });
      }
      if (partial) return { events: toNormalizedEvents(this.id, 'notion', records), cursor: cursor || { since: null }, partial, errors, hasMore: false };
      if (search.has_more && (!search.next_cursor || search.next_cursor === startCursor)) throw new ConnectorError('Notion pagination did not advance.', { connectorId: this.id, retryable: true });
      const nextCursor = !reachedOld && search.has_more === true && typeof search.next_cursor === 'string' && search.next_cursor.length <= 2048 && !/[\r\n]/.test(search.next_cursor)
        ? search.next_cursor : null;
      const tracked = Object.entries(known).filter(([key, at]) => notionId(key) === key && Number.isFinite(Date.parse(at)))
        .sort((left, right) => Date.parse(right[1]) - Date.parse(left[1])).slice(0, 200);
      const pages = Object.fromEntries(tracked);
      if (nextCursor) return { events: toNormalizedEvents(this.id, 'notion', records), cursor: { since, watermark, startCursor: nextCursor, pages, recheck: cursor?.recheck || 0 }, partial, errors, hasMore: true };
      // A bounded, rotating recheck of pages not returned this time.
      const stale = tracked.filter(([key]) => !seenNow.has(key));
      const start = stale.length ? Number(cursor?.recheck || 0) % stale.length : 0;
      for (let index = 0; index < Math.min(10, stale.length); index++) {
        const [key] = stale[(start + index) % stale.length];
        let reason = null;
        try {
          const current = await this.#notion(`/v1/pages/${key}`, { signal: controller.signal });
          if (current?.archived === true) reason = 'archived';
          if (current?.in_trash === true) reason = 'trashed';
        } catch (error) {
          if (error.status === 404) reason = 'removed_or_unshared';
          else if (error.status === 401) throw error;
          else { errors.push({ scope: 'recheck', message: error.message, retryable: error.retryable === true }); break; }
        }
        if (!reason) continue;
        delete pages[key];
        records.push({ type: 'document.unavailable', providerEventId: `page-removed:${key}:${reason}:${new Date(this.now()).toISOString()}`, at: new Date(this.now()).toISOString(),
          payload: { id: `notion:${key}`, reason, externalId: key } });
      }
      const recheck = stale.length ? (start + 10) % stale.length : 0;
      return { events: toNormalizedEvents(this.id, 'notion', records), cursor: { since: watermark || since || new Date(this.now()).toISOString(), pages, recheck }, partial: partial || errors.length > 0, errors, hasMore: false };
    } finally { clearTimeout(timer); }
  }
}
