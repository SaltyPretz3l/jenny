'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyAddress, classifyUrl, createUrlGuard, normalizeHostname, withDefaultScheme,
} = require('../services/browser-use/url-guard');
const { cases } = require('./fixtures/browser-use-address-cases.json');

const OLLAMA = 11434;

function guardWith(answers, extra = {}) {
  const asked = [];
  const guard = createUrlGuard({
    resolveHost: async (host) => {
      asked.push(host);
      const answer = answers[host];
      if (answer instanceof Error) throw answer;
      return { endpoints: (answer || []).map(address => ({ address })) };
    },
    ...extra,
  });
  return { guard, asked };
}

for (const { ip, expected } of cases) {
  test(`classifyAddress: ${ip} is ${expected}`, () => {
    assert.equal(classifyAddress(ip), expected);
  });
}

test('classifyAddress returns null for anything that is not an IP address', () => {
  for (const text of ['example.com', '', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1::2::3', '1:2:3:4:5:6:7:8::1::2', '12345::', 'fe80::1%eth0']) {
    assert.equal(classifyAddress(text), null, text);
  }
});

test('a navigation refuses every scheme except http(s)', () => {
  for (const url of [
    'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://a.example/1',
    'chrome://settings', 'view-source:https://a.example', 'about:blank', 'ftp://a.example/x', 'ws://a.example/',
  ]) {
    const verdict = classifyUrl(url);
    assert.equal(verdict.allowed, false, url);
    assert.equal(verdict.reason, 'unsupported_scheme', url);
  }
});

test('a subresource may use inline content and sockets but never file', () => {
  for (const url of ['data:image/png;base64,AA==', 'blob:https://a.example/1', 'about:blank', 'about:srcdoc']) {
    assert.equal(classifyUrl(url, { kind: 'subresource' }).allowed, true, url);
  }
  assert.equal(classifyUrl('wss://a.example/socket', { kind: 'subresource' }).needsDns, true);
  assert.equal(classifyUrl('file:///C:/secret', { kind: 'subresource' }).reason, 'unsupported_scheme');
  assert.equal(classifyUrl('about:config', { kind: 'subresource' }).reason, 'unsupported_scheme');
});

test('credentials in a URL are refused before any host logic', () => {
  assert.equal(classifyUrl('https://user:pw@example.com/').reason, 'credentialed_url');
  assert.equal(classifyUrl('https://user@127.0.0.1:3000/').reason, 'credentialed_url');
});

test('malformed and oversized URLs are refused', () => {
  assert.equal(classifyUrl('not a url').reason, 'invalid_url');
  assert.equal(classifyUrl('').reason, 'invalid_url');
  assert.equal(classifyUrl(`https://a.example/${'x'.repeat(5000)}`).reason, 'invalid_url');
});

test('URL parsing normalises disguised addresses before they are classified', () => {
  for (const url of ['http://0x7f.0.0.1:3000/', 'http://2130706433:3000/', 'http://127.1:3000/']) {
    const verdict = classifyUrl(url);
    assert.equal(verdict.host, '127.0.0.1', url);
    assert.equal(verdict.isLoopback, true, url);
  }
  assert.equal(classifyUrl('http://0xa9.0xfe.0xa9.0xfe/').reason, 'private_address');
  assert.equal(classifyUrl('http://[::ffff:7f00:1]:3000/').reason, 'private_address');
});

test('LAN, link-local and metadata targets are refused', () => {
  for (const url of [
    'http://192.168.1.1/', 'http://10.0.0.5:8080/', 'http://169.254.169.254/latest/meta-data/',
    'http://[fe80::1]/', 'http://[fd00:ec2::254]/',
  ]) {
    assert.equal(classifyUrl(url).reason, 'private_address', url);
  }
});

test('internal-looking names are refused without DNS', () => {
  for (const url of ['http://intranet/', 'http://printer.local/', 'http://nas.lan/', 'https://svc.internal/', 'http://x.home.arpa/', 'http://abc.onion/']) {
    assert.equal(classifyUrl(url).reason, 'internal_name', url);
  }
});

test('loopback is allowed and flagged so the consent gate can ask', () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:5173/', 'http://[::1]:8000/', 'http://app.localhost:3000/']) {
    const verdict = classifyUrl(url);
    assert.equal(verdict.allowed, true, url);
    assert.equal(verdict.isLoopback, true, url);
    assert.equal(verdict.needsDns, false, url);
  }
});

test('a reserved port is refused on loopback whichever form names it', () => {
  for (const url of [`http://localhost:${OLLAMA}/api/tags`, `http://127.0.0.1:${OLLAMA}/`, `http://[::1]:${OLLAMA}/`]) {
    assert.equal(classifyUrl(url, { reservedPorts: [OLLAMA] }).reason, 'reserved_port', url);
  }
});

test('a URL with no port is held to the default port of its scheme', () => {
  assert.equal(classifyUrl('http://localhost/', { reservedPorts: [80] }).reason, 'reserved_port');
  assert.equal(classifyUrl('https://localhost/', { reservedPorts: [443] }).reason, 'reserved_port');
  assert.equal(classifyUrl('https://localhost/', { reservedPorts: [80] }).allowed, true);
  assert.equal(classifyUrl('wss://localhost/', { kind: 'subresource', reservedPorts: [443] }).reason, 'reserved_port');
});

test('a reserved port number has no meaning on a public host', () => {
  assert.equal(classifyUrl(`https://example.com:${OLLAMA}/`, { reservedPorts: [OLLAMA] }).allowed, true);
});

test('a trailing dot cannot dodge a rule', () => {
  assert.equal(normalizeHostname('LocalHost.'), 'localhost');
  assert.equal(classifyUrl('http://printer.local./').reason, 'internal_name');
  assert.equal(classifyUrl(`http://localhost.:${OLLAMA}/`, { reservedPorts: [OLLAMA] }).reason, 'reserved_port');
});

test('a public name passes once every DNS answer is public', async () => {
  const { guard } = guardWith({ 'example.com': ['93.184.216.34', '2606:4700:4700::1111'] });
  const verdict = await guard.check('https://example.com/');
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.isLoopback, false);
});

test('one private answer among several refuses the name', async () => {
  const { guard } = guardWith({ 'rebind.example': ['93.184.216.34', '192.168.1.5'] });
  assert.equal((await guard.check('https://rebind.example/')).reason, 'resolves_to_private_address');
});

test('a public name answering with loopback is refused', async () => {
  const { guard } = guardWith({ 'evil.example': ['127.0.0.1'] });
  assert.equal((await guard.check('http://evil.example:11434/')).reason, 'resolves_to_private_address');
});

test('DNS failure, an empty answer and a missing resolver all fail closed', async () => {
  const { guard } = guardWith({ 'gone.example': new Error('NXDOMAIN'), 'empty.example': [] });
  assert.equal((await guard.check('https://gone.example/')).reason, 'unresolved_host');
  assert.equal((await guard.check('https://empty.example/')).reason, 'unresolved_host');
  assert.equal((await createUrlGuard({}).check('https://a.example/')).reason, 'resolver_unavailable');
});

test('address literals and refused URLs never reach DNS', async () => {
  const { guard, asked } = guardWith({});
  await guard.check('http://127.0.0.1:3000/');
  await guard.check('https://8.8.8.8/');
  await guard.check('http://192.168.1.1/');
  await guard.check('file:///etc/passwd');
  assert.deepEqual(asked, []);
});

test('a host is looked up once inside the cache window and again after it', async () => {
  let clock = 1000;
  const { guard, asked } = guardWith({ 'example.com': ['93.184.216.34'] }, { now: () => clock });
  await guard.check('https://example.com/a');
  await guard.check('https://example.com/b');
  assert.deepEqual(asked, ['example.com']);
  clock += 31_000;
  await guard.check('https://example.com/c');
  assert.deepEqual(asked, ['example.com', 'example.com']);
});

test('concurrent checks of one host share a lookup', async () => {
  const { guard, asked } = guardWith({ 'example.com': ['93.184.216.34'] });
  await Promise.all([guard.check('https://example.com/a'), guard.check('https://example.com/b')]);
  assert.deepEqual(asked, ['example.com']);
});

test('the DNS cache is bounded', async () => {
  const { guard, asked } = guardWith(new Proxy({}, { get: () => ['93.184.216.34'] }));
  for (let index = 0; index < 300; index += 1) await guard.check(`https://h${index}.example/`);
  asked.length = 0;
  await guard.check('https://h299.example/');
  assert.equal(asked.length, 0, 'the newest entry is kept');
  await guard.check('https://h0.example/');
  assert.equal(asked.length, 1, 'the oldest entry was evicted');
});

test('reserved ports are re-read on every check', async () => {
  let ports = [];
  const guard = createUrlGuard({ resolveHost: async () => ({ endpoints: [] }), reservedPorts: () => ports });
  assert.equal((await guard.check('http://localhost:9000/')).allowed, true);
  ports = [9000];
  assert.equal((await guard.check('http://localhost:9000/')).reason, 'reserved_port');
});

test('the synchronous classify applies reserved ports without touching DNS', () => {
  const { guard, asked } = guardWith({}, { reservedPorts: () => [OLLAMA] });
  assert.equal(guard.classify(`http://localhost:${OLLAMA}/`).reason, 'reserved_port');
  assert.equal(guard.classify('https://example.com/').needsDns, true);
  assert.equal(guard.classify('data:text/html,hi').reason, 'unsupported_scheme');
  assert.equal(guard.classify('data:text/html,hi', { kind: 'subresource' }).allowed, true);
  assert.deepEqual(asked, []);
});

test('checkObservedIp withholds a public name that landed on a private address', () => {
  const { guard } = guardWith({});
  assert.equal(guard.checkObservedIp('https://example.com/', '192.168.1.5').withhold, true);
  assert.equal(guard.checkObservedIp('https://example.com/', '127.0.0.1').withhold, true);
  assert.equal(guard.checkObservedIp('https://example.com/', '[::1]').withhold, true);
});

test('checkObservedIp passes public addresses, cache hits and real loopback targets', () => {
  const { guard } = guardWith({});
  assert.equal(guard.checkObservedIp('https://example.com/', '93.184.216.34').withhold, false);
  assert.equal(guard.checkObservedIp('https://example.com/', '').withhold, false);
  assert.equal(guard.checkObservedIp('http://localhost:3000/', '127.0.0.1').withhold, false);
  assert.equal(guard.checkObservedIp('http://localhost:3000/', '[::1]').withhold, false);
});

test('checkObservedIp fails closed on an address it cannot read', () => {
  const { guard } = guardWith({});
  assert.equal(guard.checkObservedIp('https://example.com/', 'not-an-ip').withhold, true);
});

test('withDefaultScheme adds http:// only to a bare localhost or 127.0.0.1 address the guard allows with http://', () => {
  for (const [given, expected] of [
    ['localhost:3000', 'http://localhost:3000'], ['localhost', 'http://localhost'], ['localhost/a/b?c#d', 'http://localhost/a/b?c#d'],
    ['127.0.0.1:5173/', 'http://127.0.0.1:5173/'], [' localhost:3000 ', 'http://localhost:3000'],
  ]) {
    assert.equal(withDefaultScheme(given), expected, given);
    assert.equal(classifyUrl(withDefaultScheme(given)).allowed, true, given);
  }
  for (const given of [
    'http://localhost:3000', 'https://localhost:3000', 'file:///C:/x', 'javascript:alert(1)', 'data:text/html,x', 'example.com', '10.0.0.5:3000',
    '192.168.1.1', 'localhost.evil.test:3000', 'localhost@evil.test', 'localhost:3000@evil.test', 'localhost:99999999', 'localhost:', '', 7,
  ]) {
    assert.equal(withDefaultScheme(given), given, String(given));
  }
});
