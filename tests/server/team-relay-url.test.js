'use strict';

// Slice 5-3: the owner's relay URL validator (server/team/transport/relay-url.js,
// T11): https only, a DNS host name and an optional port, nothing else, at most
// 100 characters, one canonical form. Pure and total. The fault each test catches
// is named in its comment.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_RELAY_URL_CHARS, isCanonicalRelayUrl, isDnsHostName, parseRelayUrl,
} = require('../../server/team/transport/relay-url');

const REFUSED = { ok: false, reason: 'team_relay_url_invalid' };

// Fault: a non-canonical form kept as typed, so two spellings of one relay would differ.
test('a relay URL is accepted in one canonical form: lower case, no trailing slash, no default port', () => {
  for (const [input, url] of [
    ['https://relay.example.net', 'https://relay.example.net'],
    ['HTTPS://Relay.Example.NET/', 'https://relay.example.net'],
    ['https://relay.example.net:8443', 'https://relay.example.net:8443'],
    ['https://relay.example.net:443/', 'https://relay.example.net'],
    ['https://relay-1.example.net:1', 'https://relay-1.example.net:1'],
    ['https://relay.example.net:65535', 'https://relay.example.net:65535'],
    ['https://localhost', 'https://localhost'],
  ]) {
    assert.deepEqual(parseRelayUrl(input), { ok: true, url }, input);
    assert.equal(isCanonicalRelayUrl(url), true, url);
  }
  assert.equal(isCanonicalRelayUrl('https://Relay.example.net'), false);
  assert.equal(isCanonicalRelayUrl('https://relay.example.net/'), false);
  assert.equal(isCanonicalRelayUrl('https://relay.example.net:443'), false);
});

// Fault: accepting http, user info, a path, a query, a fragment or an address literal (T11).
test('http, user info, path, query, fragment, address literals and bad ports are refused', () => {
  for (const input of [
    'http://relay.example.net', 'wss://relay.example.net', 'relay.example.net', 'https://', 'https:///',
    'https://user@relay.example.net', 'https://user:pw@relay.example.net', 'https://relay.example.net/path',
    'https://relay.example.net//', 'https://relay.example.net?x=1', 'https://relay.example.net#frag',
    'https://relay.example.net:0', 'https://relay.example.net:65536', 'https://relay.example.net:08443',
    'https://relay.example.net:', 'https://relay.example.net:x', 'https://192.0.2.7', 'https://192.0.2.7:443',
    'https://[2001:db8::1]', 'https://[2001:db8::1]:443', 'https://relay..example.net', 'https://.relay.example.net',
    'https://relay.example.net.', 'https://-relay.example.net', 'https://relay-.example.net', 'https://relay_1.example.net',
    'https://rel ay.example.net', 'https://relay%2eexample.net', 'https://relay.example.net\\x', 'https://rélay.net',
    ` https://relay.example.net`, 'https://relay.example.net\n', `https://${'a'.repeat(64)}.net`, '', null, 42, {},
  ]) {
    assert.deepEqual(parseRelayUrl(input), REFUSED, String(input));
  }
});

// Fault: the 100-character bound dropped or off by one.
test('the 100-character limit at its edge and one past it', () => {
  const at = `https://${'r'.repeat(60)}.${'s'.repeat(27)}.net`;
  assert.equal(at.length, MAX_RELAY_URL_CHARS);
  assert.equal(parseRelayUrl(at).ok, true);
  assert.deepEqual(parseRelayUrl(`https://${'r'.repeat(60)}.${'s'.repeat(28)}.net`), REFUSED);
  // A trailing slash past the limit is refused before it could be trimmed.
  assert.deepEqual(parseRelayUrl(`${at}/`), REFUSED);
  assert.equal(isDnsHostName('a'.repeat(63)), true);
  assert.equal(isDnsHostName('a'.repeat(64)), false);
  assert.equal(isDnsHostName('team.example.net', 15), false);
  assert.equal(isDnsHostName('1.2.3.4'), false, 'an all-digit last label reads as an address');
});

// Fault: a throw or a refusal that echoes the input.
test('the validator is total: random and hostile input yields a value or the one reason', () => {
  let state = 0x1234;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const alphabet = 'abcXYZ019-.:/?#@[]%\\ _~https';
  for (let index = 0; index < 4000; index += 1) {
    let input = random() < 0.5 ? 'https://' : '';
    const length = Math.floor(random() * 120);
    for (let char = 0; char < length; char += 1) input += alphabet[Math.floor(random() * alphabet.length)];
    const result = parseRelayUrl(input);
    if (result.ok) {
      assert.match(result.url, /^https:\/\/[a-z0-9.-]+(?::[1-9]\d{0,4})?$/u);
      assert.equal(isCanonicalRelayUrl(result.url), true);
    } else {
      assert.deepEqual(result, REFUSED);
    }
  }
});

// Fault: the validator reaching for the transport library or the network (spec: pure, no transport import).
test('relay-url.js is pure: it requires nothing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'team', 'transport', 'relay-url.js'), 'utf8');
  assert.deepEqual(source.match(/require\(/gu) ?? [], []);
});

// Slice 5-3 review item 3. Fault: a hex IPv4 form (getaddrinfo reads 0x7f000001 as 127.0.0.1) accepted as a name.
test('a last label in hex or digits is an address, never a name', () => {
  for (const input of ['https://0x7f000001', 'https://0X7F000001', 'https://1.2.3.0x4', 'https://relay.0x', 'https://a.0x1f:8443']) {
    assert.deepEqual(parseRelayUrl(input), REFUSED, input);
  }
  assert.equal(parseRelayUrl('https://relay.0xbeef.net').ok, true, 'hex only matters in the last label');
});
