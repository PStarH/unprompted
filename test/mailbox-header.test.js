import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMailbox, parseMailbox } from '../src/connectors/google.js';

const roundTrip = name => {
  const formatted = formatMailbox({ address: 'x@y.com', displayName: name });
  const unfolded = formatted.replace(/\r\n[ \t]+/g, ' ');
  const decoded = unfolded.replace(/=\?UTF-8\?B\?([^?]+)\?=(?:\s+(?==\?UTF-8\?B\?))?/gi, (_word, encoded) => Buffer.from(encoded, 'base64').toString('utf8'));
  assert.equal(parseMailbox(decoded).displayName, name, formatted);
  assert.equal(parseMailbox(decoded).address, 'x@y.com');
  return formatted;
};

test('display names with header specials are quoted, escaped, and parsed back', () => {
  assert.equal(roundTrip('Ann;'), '"Ann;" <x@y.com>');
  assert.equal(roundTrip('Ann: Bob'), '"Ann: Bob" <x@y.com>');
  assert.equal(roundTrip('a@evil.com'), '"a@evil.com" <x@y.com>');
  assert.equal(roundTrip('say "hi"'), '"say \\"hi\\"" <x@y.com>');
  assert.equal(roundTrip('a\\b'), '"a\\\\b" <x@y.com>');
  assert.equal(roundTrip('Alex Chen'), 'Alex Chen <x@y.com>');
  const encoded = roundTrip('=?UTF-8?B?hi?=');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.doesNotMatch(encoded, /"=\?UTF-8/);
  assert.match(roundTrip('陈'), /^=\?UTF-8\?B\?/);
});
