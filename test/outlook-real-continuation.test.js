import test from 'node:test';
import assert from 'node:assert/strict';
import { OutlookConnector } from '../src/connectors/outlook.js';

const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

test('Outlook follows the quoted inbox delta link returned by Microsoft Graph', async () => {
  const link = "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=checkpoint";
  const calls = [];
  const connector = new OutlookConnector({
    auth: { accessToken: async () => 'test-token' }, account: { id: 'test-account' },
    fetchImpl: async url => {
      calls.push(String(url));
      return String(url).includes('/mailFolders/inbox?') ? response({ id: 'actual-inbox-id' }) : response({ value: [], '@odata.deltaLink': link });
    }
  });
  const first = await connector.pull();
  assert.equal(first.cursor.resumeUrl, link);
  await connector.pull({ cursor: first.cursor });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], link);
  await assert.rejects(connector.pull({ cursor: { resumeUrl: "https://graph.microsoft.com/v1.0/me/mailFolders('deleteditems')/messages/delta" } }), /invalid/);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes('/mailFolders/inbox?'));
});
