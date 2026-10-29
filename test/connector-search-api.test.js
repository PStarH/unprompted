import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoogleFixture, connectGoogle, waitFor } from './fixtures/google-workspace.mjs';

const get = (base, route) => fetch(base + route).then(response => response.json());
const search = (base, data) => fetch(base + '/api/connectors/google/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

test('user search uses the connected Google account and read scopes without creating tasks or writes', { timeout: 20000 }, async t => {
  const fixture = await startGoogleFixture(); t.after(fixture.close);
  const before = await search(fixture.base, { source: 'gmail', query: 'Cedar' }); assert.equal(before.status, 409);
  await connectGoogle(fixture.base);
  await waitFor(() => get(fixture.base, '/api/setup'), value => !value.google.activating && !value.monitoring.running && value.monitoring.lastOutcome);
  const stateBefore = await get(fixture.base, '/api/state');
  const mail = await search(fixture.base, { source: 'gmail', query: 'subject:Cedar', limit: 5 });
  assert.equal(mail.status, 200); assert.equal((await mail.json()).items[0].subject, 'Cedar proposal');
  const docs = await search(fixture.base, { source: 'drive', query: 'Cedar', limit: 5 });
  assert.equal(docs.status, 200); assert.equal((await docs.json()).items[0].title, 'Cedar proposal');
  const setup = await get(fixture.base, '/api/setup');
  assert.deepEqual(setup.google.capabilities.search, ['gmail.messages', 'drive.google_docs']);
  assert.equal(setup.google.capabilities.providerPush, false);
  const stateAfter = await get(fixture.base, '/api/state');
  assert.equal(stateAfter.tasks.length, stateBefore.tasks.length);
  assert.equal(stateAfter.outbox.length, 0);
  const invalid = await search(fixture.base, { source: 'gmail', query: 'Cedar', limit: 100 }); assert.equal(invalid.status, 400);
  const disconnect = await fetch(fixture.base + '/api/setup/google/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(disconnect.status, 200);
  assert.equal((await search(fixture.base, { source: 'gmail', query: 'Cedar' })).status, 409);
});
