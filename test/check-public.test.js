import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCredentialSignature } from '../scripts/check-public.mjs';

test('public credential scanner detects a key token but not an ordinary task identifier', () => {
  assert.equal(hasCredentialSignature(`apiKey = "${'sk-'}${'x'.repeat(30)}"`), true);
  assert.equal(hasCredentialSignature('field-is-default-and-task-selection-remains-visible'), false);
});
