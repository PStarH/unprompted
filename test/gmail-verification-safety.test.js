import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleWorkspaceConnector, gmailMessageId } from '../src/connectors/google.js';
const response = value => ({ ok: true, status: 200, json: async () => value });
function connector(fetchImpl) { return new GoogleWorkspaceConnector({ config: { clientId: 'fixture', clientSecret: 'fixture', refreshToken: 'fixture', sendEnabled: true, shadow: false, maxRetries: 0 }, fetchImpl: async (url, options) => url.includes('oauth2.googleapis.com/token') ? response({ access_token: 'fixture', expires_in: 3600 }) : fetchImpl(url, options) }); }
test('Gmail operation identities cannot collide when keys differ only by punctuation', async () => {
  const messages = [];
  const provider = connector(async (_url, options) => { messages.push(Buffer.from(JSON.parse(options.body).raw, 'base64url').toString()); return response({ id: `sent-${messages.length}` }); });
  for (const key of ['operation:one', 'operation/one']) await provider.execute({ to: 'alex@example.test', subject: 'Test', body: 'Body', idempotencyKey: key });
  assert.notEqual(messages[0].match(/^Message-ID: (.*)$/m)[1], messages[1].match(/^Message-ID: (.*)$/m)[1]);
});
test('a received message or malformed sent readback cannot prove successful delivery', async () => {
  for (const labels of [['INBOX'], ['SENT']]) {
    const provider = connector(async url => url.includes('/messages?q=') ? response({ messages: [{ id: 'message' }] }) : response({ id: 'message', labelIds: labels, payload: { headers: [{ name: 'Message-ID', value: '<wrong-operation>' }] } }));
    assert.equal((await provider.verify('operation')).status, 'unknown');
    if (labels[0] === 'INBOX') assert.equal((await provider.verifyMessage('message')).status, 'unknown');
  }
});
test('Gmail search verifies the sent label and exact operation header before accepting a result', async () => {
  const urls = [], key = 'operation';
  const provider = connector(async url => { urls.push(url); return response(url.includes('/messages?q=') ? { messages: [{ id: 'message' }] } : { id: 'message', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: gmailMessageId(key) }] } }); });
  assert.equal((await provider.verify(key)).status, 'found');
  assert.match(decodeURIComponent(urls[0]), /in:sent/); assert.match(urls[0], /labelIds=SENT/);
});
test('legacy Message-ID matches remain manual unless an original provider receipt is known', async () => {
  const provider = connector(async url => response(url.includes(encodeURIComponent(gmailMessageId('operation'))) ? { messages: [] } : url.includes('/messages?q=') ? { messages: [{ id: 'legacy' }] } : { id: 'legacy', labelIds: ['SENT'] }));
  assert.equal((await provider.verify('operation')).status, 'unknown');
  assert.equal((await provider.verifyMessage('legacy')).status, 'found');
});
