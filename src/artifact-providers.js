import { createHash } from 'node:crypto';
import { providerJSON } from './connectors/http.js';
import { gmailMessageId } from './connectors/google.js';

export const ARTIFACT_ACTIONS = Object.freeze({
  google: { family: 'email.draft', kind: 'gmail-draft', label: 'Gmail drafts' },
  microsoft: { family: 'email.draft', kind: 'outlook-draft', label: 'Outlook drafts' },
  notion: { family: 'notion.page.create', kind: 'notion-page', label: 'Notion page' },
  apple_notes: { family: 'notes.note.create', kind: 'apple-note', label: 'Apple Notes' }
});

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'ARTIFACT_ACCESS_REQUIRED', status: 403 });
const canonicalId = value => /^[0-9a-f]{32}$/i.test(String(value).replace(/-/g, ''))
  ? String(value).replace(/-/g, '').toLowerCase() : null;
const graphProperty = 'String {8eccc264-3b34-4a11-91c8-83b0c67d5d84} Name UnpromptedArtifact';
const splitText = (value, size) => {
  const parts = [];
  let part = '';
  for (const character of value) {
    if (part.length + character.length > size) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
};
const richText = content => [{ type: 'text', text: { content } }];
const markerFor = key => `unprompted-artifact:${digest(key)}`;

export function artifactObservationText(connectorId, payload) {
  if (connectorId === 'apple_notes') return `${payload.title}\n${payload.body}\n${markerFor(payload.idempotencyKey)}`.replace(/\r\n?/g, '\n').trim();
  if (connectorId === 'notion') return [...splitText(payload.body, 1800), markerFor(payload.idempotencyKey)]
    .map(part => part.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()).filter(Boolean).join('\n').slice(0, 8000);
  return null;
}

export class ArtifactProvider {
  constructor(connection, targetId) {
    this.connection = connection;
    this.connector = connection.connector;
    this.targetId = targetId;
    this.kind = ARTIFACT_ACTIONS[this.connector.id]?.kind;
    this.live = true;
    this.dispatchGuard = true;
  }
  available() {
    const { connector, scopes = [] } = this.connection;
    if (!connector?.live || !this.kind || !this.connection.accountId) return false;
    if (connector.id === 'google') return this.targetId === 'drafts' && connector.config?.gmailDraftsEnabled === true
      && scopes.includes('https://www.googleapis.com/auth/gmail.compose');
    if (connector.id === 'microsoft') return this.targetId === 'drafts' && scopes.some(scope => /(?:^|\/)Mail\.ReadWrite$/i.test(scope));
    if (connector.id === 'notion') return Boolean(canonicalId(this.targetId));
    return connector.folders?.some(folder => folder.folderId === this.targetId);
  }
  async request(path, { method = 'GET', body = null, signal, beforeDispatch = null } = {}) {
    if (!this.available()) throw fail('This account or target no longer permits artifact creation.');
    signal?.throwIfAborted();
    const token = await this.connector.auth.accessToken();
    const origin = this.connector.id === 'google' ? 'https://gmail.googleapis.com'
      : this.connector.id === 'microsoft' ? 'https://graph.microsoft.com' : 'https://api.notion.com';
    return providerJSON(path, { provider: this.connector.id, origin, fetchImpl: this.connector.fetchImpl,
      method, body, signal, headers: { authorization: `Bearer ${token}`,
        ...(this.connector.id === 'notion' ? { 'Notion-Version': '2022-06-28' } : {}),
        ...(this.connector.id === 'microsoft' ? { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } : {}) },
      beforeRequest: () => { signal?.throwIfAborted(); if (!this.available()) throw fail('Artifact access was revoked.'); beforeDispatch?.(); } }).catch(error => {
        if (method === 'POST' && [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status)) error.definitiveNoEffect = true;
        throw error;
      });
  }
  async validateTarget({ signal } = {}) {
    if (!this.available()) throw fail('Authorize this account for artifact creation first.');
    if (this.connector.id === 'notion') {
      const page = await this.request(`/v1/pages/${this.targetId}`, { signal });
      if (page.object !== 'page' || canonicalId(page.id) !== canonicalId(this.targetId) || page.archived || page.in_trash) throw fail('Choose an accessible, active Notion parent page.');
    }
  }
  async create(payload, { signal, beforeDispatch } = {}) {
    if (typeof beforeDispatch !== 'function' || !this.available()) throw fail('Artifact creation needs a guarded, authorized dispatch.');
    const { title, body, to, threadId, replyToMessageId, idempotencyKey } = payload;
    let result;
    if (this.connector.id === 'google') {
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to) || /[\r\n\0]/.test(title)) throw fail('Invalid draft recipient or subject.');
      if (replyToMessageId && !/^<[^<>\s]+@[^<>\s]+>$/.test(replyToMessageId)) throw fail('The source message has no safe reply identity.');
      const subject = splitText(title, 30).map(part => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
      const raw = [`To: ${to}`, `Subject: ${subject}`, `Message-ID: ${gmailMessageId(idempotencyKey)}`,
        ...(replyToMessageId ? [`In-Reply-To: ${replyToMessageId}`, `References: ${replyToMessageId}`] : []), 'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
        Buffer.from(body).toString('base64').match(/.{1,76}/g).join('\r\n')].join('\r\n');
      result = await this.request('/gmail/v1/users/me/drafts', { method: 'POST', signal, beforeDispatch,
        body: { message: { raw: Buffer.from(raw).toString('base64url'), ...(threadId ? { threadId } : {}) } } });
    } else if (this.connector.id === 'microsoft') {
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw fail('Invalid draft recipient.');
      result = await this.request('/v1.0/me/messages', { method: 'POST', signal, beforeDispatch, body: {
        subject: title, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }],
        singleValueExtendedProperties: [{ id: graphProperty, value: markerFor(idempotencyKey) }]
      } });
    } else if (this.connector.id === 'notion') {
      result = await this.request('/v1/pages', { method: 'POST', signal, beforeDispatch, body: {
        parent: { page_id: this.targetId }, properties: { title: { type: 'title', title: richText(title) } },
        children: [...splitText(body, 1800).map(content => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(content) } })),
          { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(markerFor(idempotencyKey)) } }]
      } });
    } else {
      const folder = this.connector.folders.find(item => item.folderId === this.targetId);
      signal?.throwIfAborted();
      beforeDispatch();
      result = await this.connector.bridge.createNote(folder, { title, body, marker: markerFor(idempotencyKey) }, { signal });
    }
    if (typeof result?.id !== 'string' || !result.id || result.id.length > 4096) throw new Error('The provider did not return an artifact identity; reconcile the outcome.');
    return { id: result.id, provider: this.kind, idempotencyKey, status: 'accepted', targetId: this.targetId };
  }
  async lookup(key, { receiptId = null, payload = null, signal } = {}) {
    if (!this.available() || !receiptId || !payload) return { status: 'unknown' };
    try {
      let valid = false;
      if (this.connector.id === 'google') {
        const draft = await this.request(`/gmail/v1/users/me/drafts/${encodeURIComponent(receiptId)}?format=raw`, { signal });
        const raw = Buffer.from(draft.message?.raw || '', 'base64url').toString('utf8');
        const [headers, ...content] = raw.split('\r\n\r\n');
        const header = name => headers.replace(/\r\n[ \t]+/g, ' ').split('\r\n').find(line => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim();
        const subject = (header('subject') || '').replace(/=\?UTF-8\?B\?([^?]+)\?=(?:\s+(?==\?UTF-8\?B\?))?/gi, (_word, encoded) => Buffer.from(encoded, 'base64').toString('utf8'));
        valid = draft.id === receiptId && draft.message?.labelIds?.includes('DRAFT') && !draft.message.labelIds.includes('SENT')
          && header('message-id') === gmailMessageId(key) && header('to') === payload.to && subject === payload.title
          && (!payload.threadId || draft.message.threadId === payload.threadId)
          && (!payload.replyToMessageId || header('in-reply-to') === payload.replyToMessageId && header('references') === payload.replyToMessageId)
          && Buffer.from(content.join('\r\n\r\n'), 'base64').toString('utf8') === payload.body;
      } else if (this.connector.id === 'microsoft') {
        const query = new URLSearchParams({ '$expand': `singleValueExtendedProperties($filter=id eq '${graphProperty}')` });
        const draft = await this.request(`/v1.0/me/messages/${encodeURIComponent(receiptId)}?${query}`, { signal });
        valid = draft.id === receiptId && draft.isDraft === true && draft.subject === payload.title && draft.body?.content === payload.body
          && String(draft.body.contentType).toLowerCase() === 'text' && draft.toRecipients?.length === 1
          && draft.toRecipients[0].emailAddress?.address?.toLowerCase() === payload.to.toLowerCase()
          && draft.singleValueExtendedProperties?.some(property => property.id === graphProperty && property.value === markerFor(key));
      } else if (this.connector.id === 'notion') {
        const page = await this.request(`/v1/pages/${encodeURIComponent(receiptId)}`, { signal });
        const blocks = await this.request(`/v1/blocks/${encodeURIComponent(receiptId)}/children?page_size=100`, { signal });
        const lines = (blocks.results || []).map(block => block.paragraph?.rich_text?.map(part => part.plain_text ?? part.text?.content ?? '').join(''));
        const title = page.properties?.title?.title?.map(part => part.plain_text ?? part.text?.content ?? '').join('');
        valid = canonicalId(page.id) === canonicalId(receiptId) && !page.archived && !page.in_trash
          && canonicalId(page.parent?.page_id) === canonicalId(this.targetId) && title === payload.title
          && blocks.has_more === false && lines.pop() === markerFor(key) && lines.every(line => typeof line === 'string') && lines.join('') === payload.body;
      } else {
        const folder = this.connector.folders.find(item => item.folderId === this.targetId);
        const result = await this.connector.bridge.readNotes([folder], {}, { signal });
        const note = result.records?.find(item => item.providerId === receiptId && item.folderId === folder.folderId && item.accountId === folder.accountId && !item.unavailable);
        valid = Boolean(note && note.title === payload.title && String(note.content).replace(/\r\n?/g, '\n').trim() === `${payload.title}\n${payload.body}\n${markerFor(key)}`.replace(/\r\n?/g, '\n').trim());
      }
      return valid ? { status: 'found', receipt: { id: receiptId, idempotencyKey: key, provider: this.kind, status: 'verified', targetId: this.targetId } } : { status: 'unknown' };
    } catch { return { status: 'unknown' }; }
  }
}
