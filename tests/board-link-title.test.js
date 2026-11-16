'use strict';

// new-test-file: a new surface (services/boards/board-link-title.js, the main-process "Fetch title" for a link card); the network and DNS are injected, so no test leaves the machine.
// Every refusal of the contract, the guard on each redirect hop, the title cleaning, the body cap, the clock, and the pinned
// connection (against a server on this machine, with a name that no resolver knows).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createLinkTitleFetcher, extractTitle, pinnedFetch, LIMITS } = require('../services/boards/board-link-title');

const PUBLIC_IP = '93.184.216.34';

function reply({ status = 200, type = 'text/html; charset=utf-8', location, body = '', chunks } = {}) {
  const headers = { 'content-type': type, location };
  const list = chunks || [Buffer.from(body)];
  return {
    status,
    headers: { get: (name) => (headers[String(name).toLowerCase()] === undefined ? null : headers[String(name).toLowerCase()]) },
    body: (async function* stream() { for (const chunk of list) yield chunk; }()),
  };
}

function rig({ answers, hosts = {}, timeoutMs } = {}) {
  const calls = [];
  const lookups = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = typeof answers === 'function' ? answers(url, init, calls.length) : answers[Math.min(calls.length - 1, answers.length - 1)];
    return next;
  };
  const lookup = async (host) => {
    lookups.push(host);
    const found = host in hosts ? hosts[host] : [PUBLIC_IP];
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { calls, lookups, run: createLinkTitleFetcher({ fetch, lookup, timeoutMs }) };
}

const page = (title) => reply({ body: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>x</body></html>` });

test('a public page gives its title, and only the title leaves the module', async () => {
  const r = rig({ answers: [page('Example Domain')] });
  assert.deepEqual(await r.run({ url: 'https://example.com/a?b=1#c' }), { ok: true, title: 'Example Domain' });
  assert.equal(r.calls.length, 1);
  const { init } = r.calls[0];
  assert.equal(init.redirect, 'manual');
  assert.equal(init.method, 'GET');
  assert.ok(init.signal, 'a signal for the clock');
  assert.equal(init.address, PUBLIC_IP, 'the connection is pinned to the address the guard checked');
  const names = Object.keys(init.headers).map((name) => name.toLowerCase()).sort();
  assert.deepEqual(names, ['accept', 'accept-encoding', 'user-agent']);
  assert.match(init.headers['User-Agent'], /^[A-Za-z0-9 ./();:_-]+$/, 'a fixed plain agent');
  assert.equal(/brend|jenny-wt|@/i.test(init.headers['User-Agent']), false, 'no personal detail');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.deepEqual(r.lookups, ['example.com']);
});

test('addresses the guard refuses never reach the network: loopback, private, link-local, metadata, unique-local, unspecified, mapped, decimal and hex', async () => {
  const refused = [
    'http://127.0.0.1/', 'http://127.0.0.1:8080/x', 'http://localhost/', 'http://LOCALHOST:3000/', 'http://10.0.0.5/', 'http://192.168.1.1/',
    'http://172.16.0.9/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
    'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://[::]/',
    'http://printer/', 'http://nas.local/', 'http://app.localhost/', 'https://user:secret@example.com/',
  ];
  for (const url of refused) {
    const r = rig({ answers: [page('no')] });
    assert.deepEqual(await r.run({ url }), { ok: false, reason: 'refused' }, url);
    assert.equal(r.calls.length, 0, `${url}: nothing was fetched`);
  }
});

test('a public name that resolves to a private address, or to a mix with one, is refused before any connection', async () => {
  for (const addresses of [['10.0.0.9'], ['127.0.0.1'], ['93.184.216.34', '192.168.0.4'], ['::1'], ['fd12::7'], ['::ffff:7f00:1']]) {
    const r = rig({ answers: [page('no')], hosts: { 'rebind.example.com': addresses } });
    assert.deepEqual(await r.run({ url: 'https://rebind.example.com/' }), { ok: false, reason: 'refused' }, addresses.join(','));
    assert.equal(r.calls.length, 0);
  }
  const unresolved = rig({ answers: [page('no')], hosts: { 'gone.example.com': [] } });
  assert.deepEqual(await unresolved.run({ url: 'https://gone.example.com/' }), { ok: false, reason: 'failed' });
});

test('every redirect hop goes through the same checks: public to private is refused, a relative hop is followed, four hops fail', async () => {
  const toPrivate = rig({ answers: [reply({ status: 302, location: 'http://internal.example.com/admin' }), page('secret')], hosts: { 'internal.example.com': ['10.0.0.9'] } });
  assert.deepEqual(await toPrivate.run({ url: 'https://example.com/' }), { ok: false, reason: 'refused' });
  assert.equal(toPrivate.calls.length, 1, 'the private hop was never requested');
  const toLoopback = rig({ answers: [reply({ status: 301, location: 'http://127.0.0.1:9/' }), page('secret')] });
  assert.deepEqual(await toLoopback.run({ url: 'https://example.com/' }), { ok: false, reason: 'refused' });
  const toFile = rig({ answers: [reply({ status: 302, location: 'file:///etc/passwd' }), page('secret')] });
  assert.deepEqual(await toFile.run({ url: 'https://example.com/' }), { ok: false, reason: 'refused' });

  const relative = rig({ answers: [reply({ status: 302, location: '/next' }), reply({ status: 307, location: 'https://other.example.com/final' }), page('Final')] });
  assert.deepEqual(await relative.run({ url: 'https://example.com/start' }), { ok: true, title: 'Final' });
  assert.deepEqual(relative.calls.map((c) => c.url), ['https://example.com/start', 'https://example.com/next', 'https://other.example.com/final']);
  assert.deepEqual(relative.lookups, ['example.com', 'example.com', 'other.example.com'], 'each hop resolves again');

  const three = rig({ answers: [reply({ status: 302, location: '/1' }), reply({ status: 302, location: '/2' }), reply({ status: 302, location: '/3' }), page('Third')] });
  assert.deepEqual(await three.run({ url: 'https://example.com/' }), { ok: true, title: 'Third' }, 'three redirects are allowed');
  const four = rig({ answers: [reply({ status: 302, location: '/1' }), reply({ status: 302, location: '/2' }), reply({ status: 302, location: '/3' }), reply({ status: 302, location: '/4' }), page('Fourth')] });
  assert.deepEqual(await four.run({ url: 'https://example.com/' }), { ok: false, reason: 'failed' });
  assert.equal(four.calls.length, 4);
  const noLocation = rig({ answers: [reply({ status: 302 })] });
  assert.deepEqual(await noLocation.run({ url: 'https://example.com/' }), { ok: false, reason: 'failed' });
});

test('an address that is not http or https is invalid, and nothing is resolved', async () => {
  for (const url of ['ftp://example.com/', 'javascript:alert(1)', 'data:text/html,<title>x</title>', 'not a url', '', '   ', 'http://', 42, null, undefined, `https://example.com/${'a'.repeat(5000)}`]) {
    const r = rig({ answers: [page('no')] });
    assert.deepEqual(await r.run({ url }), { ok: false, reason: 'invalid' }, String(url).slice(0, 40));
    assert.equal(r.calls.length + r.lookups.length, 0);
  }
  assert.deepEqual(await rig({ answers: [page('no')] }).run(), { ok: false, reason: 'invalid' }, 'no request at all');
});

test('the title is the first title element: entities decoded, controls removed, white space collapsed, cut at 200', () => {
  assert.equal(extractTitle('<html><head><TITLE lang="en">  Fish &amp; Chips\n\t&lt;b&gt; &#39;ok&#39; &#x1F600; &nbsp;done </TITLE></head></html>'), "Fish & Chips <b> 'ok' \u{1F600} done");
  assert.equal(extractTitle('<title>a\u0000b\u0007c d\u0085e</title>'), 'abc de', 'controls are dropped, a line separator is white space');
  assert.equal(extractTitle('<!-- <title>hidden</title> --><title>Shown</title><title>Second</title>'), 'Shown');
  assert.equal(extractTitle(`<title>${'x'.repeat(500)}</title>`).length, 200);
  assert.equal(extractTitle(`<title>${'\u{1F600}'.repeat(150)}</title>`).length <= 200, true);
  assert.equal(/[\ud800-\udbff]$/.test(extractTitle(`<title>${'a'.repeat(199)}\u{1F600}</title>`)), false, 'never ends on half a pair');
  assert.equal(extractTitle('<title>&#0;&#xD800;&#99999999;&bogus;</title>'), '&bogus;', 'bad numbers are dropped, unknown names stay');
  assert.equal(extractTitle('<title>   \n  </title>'), '');
  assert.equal(extractTitle('<p>no title here</p>'), '');
  assert.equal(extractTitle('<title>unclosed'), '');
  assert.equal(extractTitle('<titlebar>no</titlebar><title>Yes</title>'), 'Yes');
  assert.equal(extractTitle('<title>before</title><!-- never closed <title>after</title>'), 'before');
  // A hostile page of unclosed comments or titles is read in one pass (it took seconds when each one cost a scan to the end).
  const started = Date.now();
  assert.equal(extractTitle('<title>'.repeat(36000)), '');
  assert.equal(extractTitle('<!--'.repeat(60000) + '<title>x</title>'), '');
  assert.ok(Date.now() - started < 1000, `hostile pages took ${Date.now() - started} ms`);
  const clean = extractTitle('<title>\u0001\u0002 x \u007f \u009f y</title>');
  assert.equal(clean, 'x y');
});

test('a page with no title, an empty one, or not a web page gives its own reason', async () => {
  assert.deepEqual(await rig({ answers: [reply({ body: '<html><body>nothing</body></html>' })] }).run({ url: 'https://example.com/' }), { ok: false, reason: 'no_title' });
  assert.deepEqual(await rig({ answers: [page('   ')] }).run({ url: 'https://example.com/' }), { ok: false, reason: 'no_title' });
  for (const type of ['application/json', 'text/plain', 'image/png', 'application/pdf', '']) {
    const r = rig({ answers: [reply({ type, body: '<title>looks like html</title>' })] });
    assert.deepEqual(await r.run({ url: 'https://example.com/' }), { ok: false, reason: 'not_html' }, type || 'no type');
  }
  assert.deepEqual(await rig({ answers: [reply({ type: 'application/xhtml+xml', body: '<html><title>X</title></html>' })] }).run({ url: 'https://example.com/' }), { ok: true, title: 'X' });
  assert.deepEqual(await rig({ answers: [reply({ type: 'TEXT/HTML; Charset=ISO-8859-1', body: Buffer.from('<title>caf\xe9</title>', 'latin1') })] }).run({ url: 'https://example.com/' }), { ok: true, title: 'café' });
});

test('only the first 256 KiB is read: an early title still works and stops the read, a late one is too_large', async () => {
  assert.equal(LIMITS.maxBodyBytes, 256 * 1024);
  let pulled = 0;
  const endless = (head) => (async function* stream() {
    yield Buffer.from(head);
    for (;;) { pulled += 1; yield Buffer.alloc(64 * 1024, 0x20); }
  }());
  const early = rig({ answers: () => ({ ...reply({}), body: endless('<title>Early</title>') }) });
  assert.deepEqual(await early.run({ url: 'https://example.com/' }), { ok: true, title: 'Early' });
  assert.ok(pulled <= 5, `read stopped near the cap (${pulled} chunks)`);
  pulled = 0;
  const late = rig({ answers: () => ({ ...reply({}), body: endless('<html><head>') }) });
  assert.deepEqual(await late.run({ url: 'https://example.com/' }), { ok: false, reason: 'too_large' });
  assert.ok(pulled <= 5, 'and it stopped reading');
  const justOver = Buffer.concat([Buffer.alloc(LIMITS.maxBodyBytes, 0x20), Buffer.from('<title>After the cap</title>')]);
  assert.deepEqual(await rig({ answers: [reply({ chunks: [justOver] })] }).run({ url: 'https://example.com/' }), { ok: false, reason: 'too_large' });
});

test('an error status, a throwing fetch and a broken stream are failed, and nothing rejects', async () => {
  for (const status of [204, 400, 403, 404, 500, 503]) {
    assert.deepEqual(await rig({ answers: [reply({ status, body: '<title>x</title>' })] }).run({ url: 'https://example.com/' }), { ok: false, reason: 'failed' }, String(status));
  }
  const throwing = createLinkTitleFetcher({ fetch: async () => { throw new Error('ECONNRESET'); }, lookup: async () => [{ address: PUBLIC_IP, family: 4 }] });
  assert.deepEqual(await throwing({ url: 'https://example.com/' }), { ok: false, reason: 'failed' });
  const noLookup = createLinkTitleFetcher({ fetch: async () => page('x'), lookup: async () => { throw new Error('ENOTFOUND'); } });
  assert.deepEqual(await noLookup({ url: 'https://example.com/' }), { ok: false, reason: 'failed' });
  const broken = rig({ answers: [{ ...reply({}), body: (async function* stream() { yield Buffer.from('<ti'); throw new Error('reset'); }()) }] });
  assert.deepEqual(await broken.run({ url: 'https://example.com/' }), { ok: false, reason: 'failed' });
});

test('a slow answer times out: a fetch that ignores its signal, one that honours it, and a body that stalls', async () => {
  const ignoring = rig({ timeoutMs: 40, answers: () => new Promise((resolve) => setTimeout(() => resolve(page('late')), 400)) });
  const started = Date.now();
  assert.deepEqual(await ignoring.run({ url: 'https://example.com/' }), { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 300, 'it did not wait for the slow server');
  const honouring = rig({ timeoutMs: 40, answers: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.deepEqual(await honouring.run({ url: 'https://example.com/' }), { ok: false, reason: 'timeout' });
  const stalled = rig({ timeoutMs: 40, answers: () => ({ ...reply({}), body: (async function* stream() { yield Buffer.from('<html>'); await new Promise((resolve) => setTimeout(resolve, 400)); yield Buffer.from('<title>x</title>'); }()) }) });
  assert.deepEqual(await stalled.run({ url: 'https://example.com/' }), { ok: false, reason: 'timeout' });
  assert.equal(LIMITS.timeoutMs, 8000);
});

test('the pinned connection goes to the address it was given whatever the name says, sends no cookie or referrer, and stops at the signal', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, headers: req.headers, url: req.url });
    if (req.url === '/redirect') { res.writeHead(302, { location: '/there' }); res.end(); return; }
    if (req.url === '/hang') return;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Pinned</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const headers = { 'User-Agent': 'Test/1', Accept: 'text/html', 'Accept-Encoding': 'identity' };
  const answer = await pinnedFetch(`http://never-resolved.invalid:${port}/page`, { method: 'GET', headers, address: '127.0.0.1', family: 4, signal: new AbortController().signal });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-type'), 'text/html');
  const chunks = [];
  for await (const chunk of answer.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '<title>Pinned</title>');
  assert.equal(seen[0].host, `never-resolved.invalid:${port}`, 'the Host header keeps the name');
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.referer, undefined);
  assert.equal(seen[0].headers['user-agent'], 'Test/1');
  const redirect = await pinnedFetch(`http://never-resolved.invalid:${port}/redirect`, { method: 'GET', headers, address: '127.0.0.1', family: 4, signal: new AbortController().signal });
  assert.equal(redirect.status, 302, 'a redirect is returned, not followed');
  assert.equal(redirect.headers.get('location'), '/there');
  for await (const chunk of redirect.body) assert.ok(chunk);
  const controller = new AbortController();
  const pending = pinnedFetch(`http://never-resolved.invalid:${port}/hang`, { method: 'GET', headers, address: '127.0.0.1', family: 4, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending);
});
