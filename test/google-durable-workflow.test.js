import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { GoogleWorkspaceConnector } from '../src/connectors/google.js';
import { GoogleDocsWriteProvider } from '../src/document-delivery.js';
import { GoogleMailAdapter } from '../src/providers.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore } from '../src/connectors/connector.js';

const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('Google Docs patch and Gmail reply use durable approved writes and reconcile an accepted timeout', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-google-durable-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const auth = { configured: () => true, headers: async () => ({ authorization: 'Bearer PRIVATE_FIXTURE' }) };
  let content = '# Cedar project proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n';
  let revision = 'rev-1', sent = 0, messageId = null, patches = 0;
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (url.hostname === 'docs.googleapis.com') {
      if (options.method === 'POST') {
        const execution = store.db.prepare("SELECT * FROM tool_executions WHERE action_family='document.patch'").get();
        assert.equal(execution.status, 'dispatched'); assert.equal(store.db.inTransaction, false);
        const request = JSON.parse(options.body); assert.equal(request.writeControl.requiredRevisionId, 'rev-1');
        for (const change of request.requests) { const offset = change.insertText.location.index - 1; content = content.slice(0, offset) + change.insertText.text + content.slice(offset); }
        revision = 'rev-2'; patches++;
      }
      return reply({ documentId: 'cedar-doc', title: 'Cedar project proposal', revisionId: revision, body: { content: [{ startIndex: 1, endIndex: content.length + 1, paragraph: { elements: [{ textRun: { content } }] } }] } });
    }
    if (url.pathname.endsWith('/messages/send')) {
      const execution = store.db.prepare("SELECT * FROM tool_executions WHERE action_family='email.send'").get();
      assert.equal(execution.status, 'dispatched'); assert.equal(store.db.inTransaction, false);
      const raw = Buffer.from(JSON.parse(options.body).raw, 'base64url').toString('utf8');
      messageId = raw.match(/^Message-ID: (.+)$/m)?.[1]?.trim(); assert.ok(messageId);
      sent++;
      throw Object.assign(new Error('connection lost after remote acceptance'), { code: 'ECONNRESET' });
    }
    if (url.pathname.endsWith('/profile')) return reply({ historyId: '100', emailAddress: 'reader@example.test' });
    if (url.pathname.endsWith('/messages')) {
      if (url.searchParams.get('q')?.startsWith('newer_than:')) return reply({ messages: [{ id: 'm1' }] });
      return reply({ messages: sent ? [{ id: 'mail-sent' }] : [] });
    }
    if (url.pathname.endsWith('/messages/m1')) return reply({ id: 'm1', threadId: 'thread-m1', payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'alex@example.test' }, { name: 'To', value: 'reader@example.test' }, { name: 'Subject', value: 'Cedar proposal' },
      { name: 'Date', value: new Date().toUTCString() }
    ], body: { data: Buffer.from('Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.').toString('base64url') } } });
    if (url.pathname.endsWith('/messages/mail-sent')) return reply({ id: 'mail-sent', threadId: 'thread-m1', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: messageId }] } });
    if (url.pathname.endsWith('/changes/startPageToken')) return reply({ startPageToken: 'drive-1' });
    if (url.pathname.endsWith('/drive/v3/files')) return reply({ files: [{ id: 'cedar-doc', name: 'Cedar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: new Date().toISOString(), version: '1' }] });
    if (url.pathname.endsWith('/files/cedar-doc/export')) return new Response(content, { headers: { 'content-type': 'text/plain' } });
    throw new Error(`Unexpected fixture URL: ${url.pathname}`);
  };
  const connector = new GoogleWorkspaceConnector({ auth, config: { accountEmail: 'reader@example.test', shadow: false, sendEnabled: true, readGmail: true, readDrive: true, docsWriteEnabled: true, maxRetries: 0 }, fetchImpl });
  const documentProvider = new GoogleDocsWriteProvider({ connector, enabled: true, shadow: false, fetchImpl });
  const engine = new WorkEngine(store, { provider: new GoogleMailAdapter(connector), documentProvider, reasoner: new NullReasoner() });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine });
  const observed = await sync.run();
  assert.equal(observed.results[0].ingested, 2); assert.equal(observed.results[0].failed, false);
  await engine.whenSettled();
  const taskId = 'request:m1';
  const patch = await engine.taskServices.prepareDocumentPatch(taskId, { provider: 'google', changes: [{ type: 'append', text: 'latest experiment results', source: { kind: 'email', id: 'm1', quote: 'latest experiment results' } }] });
  assert.equal(patch.status, 'prepared');
  const applied = await engine.taskServices.applyDocumentPatch(taskId, { patchId: patch.id, authorization: { kind: 'explicit', taskId, patchId: patch.id, baseDocumentVersion: patch.baseDocument.version, confirmed: true } });
  assert.equal(applied.patch.status, 'applied'); assert.equal(patches, 1);
  await engine.whenSettled();
  const task = engine.publicState().tasks.find(row => row.id === taskId);
  assert.equal(task.status, 'ready_for_approval');
  await engine.approve(taskId, { reviewToken: task.reviewToken }); await engine.whenSettled();
  assert.equal(sent, 1);
  assert.equal(store.tasks.get(taskId).status, 'completed');
  assert.deepEqual(runtime.ledger.list({ taskId }).filter(row => row.is_write).map(row => row.status).sort(), ['verified', 'verified']);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM resource_claims WHERE claim_state!='free'").get().n, 0);
});
