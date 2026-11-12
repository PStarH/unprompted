import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleConnectionIds, homePrimaryIds, localOfferHeading } from '../public/source-offers.js';

const cloud = ['google', 'github', 'microsoft', 'slack', 'notion'];

test('Apple Notes stays off the catalog and the home recommendation when this computer is not a Mac', () => {
  const localSources = { local_files: { available: true, connected: false }, apple_notes: { available: false, connected: false } };
  assert.deepEqual(visibleConnectionIds(localSources), [...cloud, 'local_files', 'todoist']);
  assert.deepEqual(homePrimaryIds(localSources), ['local_files', 'google']);
  assert.equal(localOfferHeading(localSources), '这台电脑可以直接连接本地文件夹，不需要账号。');
  assert.doesNotMatch(localOfferHeading(localSources), /备忘录/);
});

test('a Mac recommends local folders and Apple Notes ahead of Google', () => {
  const localSources = { local_files: { available: true }, apple_notes: { available: true, connected: false } };
  assert.deepEqual(visibleConnectionIds(localSources), [...cloud, 'local_files', 'apple_notes', 'todoist']);
  assert.deepEqual(homePrimaryIds(localSources), ['local_files', 'apple_notes', 'google']);
  assert.match(localOfferHeading(localSources), /备忘录/);
});

test('an existing Apple Notes connection stays visible off macOS, but is not recommended', () => {
  const localSources = { local_files: { available: true }, apple_notes: { available: false, connected: true } };
  assert.ok(visibleConnectionIds(localSources).includes('apple_notes'));
  assert.deepEqual(homePrimaryIds(localSources), ['local_files', 'google']);
  assert.doesNotMatch(localOfferHeading(localSources), /备忘录/);
});
