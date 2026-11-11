'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { inlineLinkedAssets } = require('../renderer/features/renderer-ide-preview-assets.js');

const DOMParserCtor = new JSDOM('').window.DOMParser;
const parse = (h) => new DOMParserCtor().parseFromString(h, 'text/html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString('base64');

// In-memory readers. files: { path: string }. opts: delay(p), bytes(p), reject, throwSync.
function makeFs(files, opts) {
  const o = opts || {};
  const log = { text: [], data: [], maxBytes: [], maxActive: 0 };
  let active = 0;
  async function gate(p) {
    active += 1;
    log.maxActive = Math.max(log.maxActive, active);
    try {
      const d = o.delay ? o.delay(p) : 0;
      if (d > 0) await sleep(d);
      else await Promise.resolve();
    } finally {
      active -= 1;
    }
  }
  return {
    log,
    readText: (p, max) => {
      log.text.push(p);
      log.maxBytes.push(max);
      if (o.throwSync) throw new Error('sync boom');
      return (async () => {
        await gate(p);
        if (o.reject) throw new Error('boom');
        if (!Object.prototype.hasOwnProperty.call(files, p)) return { ok: false, reason: 'not_found' };
        if (files[p].length > max) return { ok: false, reason: 'too_large' };
        return { ok: true, text: files[p] };
      })();
    },
    readDataUrl: (p) => {
      log.data.push(p);
      if (o.throwSync) throw new Error('sync boom');
      return (async () => {
        await gate(p);
        if (o.reject) throw new Error('boom');
        if (!Object.prototype.hasOwnProperty.call(files, p)) return { ok: false, reason: 'not_found' };
        const body = files[p];
        return {
          ok: true,
          dataUrl: 'data:application/octet-stream;base64,' + b64(body),
          bytes: o.bytes ? o.bytes(p) : Buffer.byteLength(body),
        };
      })();
    },
  };
}

async function run(html, files, extra) {
  const e = extra || {};
  const fs = makeFs(files || {}, e.fs);
  const r = await inlineLinkedAssets({
    html,
    path: e.path || 'index.html',
    readText: fs.readText,
    readDataUrl: fs.readDataUrl,
    DOMParser: e.DOMParser || DOMParserCtor,
    limits: e.limits,
  });
  return { r, fs };
}

const dataOf = (s) => 'data:application/octet-stream;base64,' + b64(s);

test('fast path: no link/script/img/style returns the same string and builds no parser', async () => {
  let constructed = 0;
  class Spy { constructor() { constructed += 1; } }
  const html = '<p>hello <b>world</b></p>';
  const { r, fs } = await run(html, {}, { DOMParser: Spy });
  assert.equal(constructed, 0);
  assert.equal(r.html, html);
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.notLoaded, []);
  assert.equal(r.webLinks, 0);
  assert.deepEqual(r.dependencies, []);
  assert.equal(fs.log.text.length + fs.log.data.length, 0);
});

test('fast path check is case-insensitive', async () => {
  let constructed = 0;
  class Spy {
    constructor() { constructed += 1; }
    parseFromString(h, t) { return new DOMParserCtor().parseFromString(h, t); }
  }
  await run('<LINK rel=stylesheet href=a.css>', { 'a.css': 'p{}' }, { DOMParser: Spy });
  assert.equal(constructed, 1);
});

test('nothing inlined or rewritten returns the identical string', async () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head>'
    + '<body><img src="data:image/png;base64,AAAA"><script src="//cdn.example.com/a.js"></script>'
    + '<style>p{color:red}</style><img src="gone.png"></body></html>';
  const { r } = await run(html, {});
  assert.equal(r.html, html);
  assert.equal(r.webLinks, 2);
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.notLoaded, [{ ref: 'gone.png', reason: 'not_found' }]);
  assert.deepEqual(r.dependencies, ['gone.png']);
});

test('linked stylesheet becomes a style element and keeps media', async () => {
  const html = '<html><head><link REL="Stylesheet icon" href="s/main.css" media="print and (min-width: 1px)"></head><body>x</body></html>';
  const { r } = await run(html, { 's/main.css': 'body{color:red}' });
  const doc = parse(r.html);
  assert.ok(r.html.startsWith('<html'));
  assert.equal(doc.querySelectorAll('link').length, 0);
  const styles = doc.querySelectorAll('style');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent, 'body{color:red}');
  assert.equal(styles[0].getAttribute('media'), 'print and (min-width: 1px)');
  assert.deepEqual(r.loaded, ['s/main.css']);
  assert.deepEqual(r.dependencies, ['s/main.css']);
});

test('non-stylesheet links are left alone', async () => {
  const html = '<link rel="icon" href="fav.ico"><script src="a.js"></script>';
  const { r, fs } = await run(html, { 'a.js': 'var a=1;' });
  assert.equal(fs.log.data.length, 0);
  assert.equal(parse(r.html).querySelectorAll('link[rel=icon]').length, 1);
});

test('script is inlined and loading attributes are removed', async () => {
  const html = '<body><script src="app.js" integrity="sha384-x" crossorigin="anonymous" id="k"></script></body>';
  const { r } = await run(html, { 'app.js': 'window.a = 1;' });
  const s = parse(r.html).querySelector('script');
  assert.equal(s.textContent, 'window.a = 1;');
  for (const a of ['src', 'integrity', 'crossorigin', 'defer', 'async']) assert.equal(s.hasAttribute(a), false, a);
  assert.equal(s.getAttribute('id'), 'k');
  assert.deepEqual(r.loaded, ['app.js']);
});

test('</script> and <!-- inside a JS file cannot break out of the script element', async () => {
  const js = 'var s = "</script><b id=x>boom</b>"; var t = "</SCRIPT >"; var c = "<!-- hi";';
  const { r } = await run('<body><script src="a.js"></script><p>after</p></body>', { 'a.js': js });
  const doc = parse(r.html);
  assert.equal(doc.querySelectorAll('script').length, 1);
  assert.equal(doc.querySelectorAll('b').length, 0);
  assert.equal(doc.querySelectorAll('p').length, 1);
  const text = doc.querySelector('script').textContent;
  assert.ok(text.includes('<\\/script>'));
  assert.ok(text.includes('<\\/script >'));
  assert.ok(text.includes('<\\!-- hi'));
  assert.ok(!/<\/script/i.test(text.replace(/<\\\/script/gi, '')));
});

test('</style> inside a CSS file cannot break out of the style element', async () => {
  const css = '.a::after{content:"</style><b id=x>boom</b>"} .b::after{content:"</STYLE >"}';
  const { r } = await run('<head><link rel="stylesheet" href="a.css"></head><body><p>after</p></body>', { 'a.css': css });
  const doc = parse(r.html);
  assert.equal(doc.querySelectorAll('style').length, 1);
  assert.equal(doc.querySelectorAll('b').length, 0);
  assert.equal(doc.querySelectorAll('p').length, 1);
  const text = doc.querySelector('style').textContent;
  assert.ok(text.includes('<\\/style>'));
  assert.ok(text.includes('<\\/style >'));
});

test('defer scripts move to the end of body in order, async and plain stay put', async () => {
  const html = '<html><head>'
    + '<script defer src="a.js"></script>'
    + '<script src="b.js"></script>'
    + '<script async src="c.js"></script>'
    + '<script defer async src="e.js"></script>'
    + '<script defer src="d.js"></script>'
    + '</head><body><p>x</p><script>/*inline*/</script></body></html>';
  const files = { 'a.js': '/*A*/', 'b.js': '/*B*/', 'c.js': '/*C*/', 'd.js': '/*D*/', 'e.js': '/*E*/' };
  const { r } = await run(html, files);
  const doc = parse(r.html);
  const head = Array.from(doc.head.querySelectorAll('script')).map((s) => s.textContent);
  assert.deepEqual(head, ['/*B*/', '/*C*/', '/*E*/']);
  const bodyScripts = Array.from(doc.body.querySelectorAll('script')).map((s) => s.textContent);
  assert.deepEqual(bodyScripts, ['/*inline*/', '/*A*/', '/*D*/']);
  assert.equal(doc.body.lastElementChild.textContent, '/*D*/');
  assert.equal(doc.querySelector('script[defer]'), null);
});

test('module script with static imports is left unchanged, without imports is inlined', async () => {
  const html = '<body><script type="module" src="a.mjs"></script><script type="module" src="b.mjs"></script>'
    + '<script type="module" src="c.mjs"></script></body>';
  const files = {
    'a.mjs': 'import { x } from "./x.js";\nconsole.log(x);',
    'b.mjs': 'const v = 1; console.log(v);',
    'c.mjs': 'export * from "./y.js";',
  };
  const { r } = await run(html, files);
  const scripts = Array.from(parse(r.html).querySelectorAll('script'));
  assert.equal(scripts[0].getAttribute('src'), 'a.mjs');
  assert.equal(scripts[0].textContent, '');
  assert.equal(scripts[1].hasAttribute('src'), false);
  assert.equal(scripts[1].getAttribute('type'), 'module');
  assert.equal(scripts[1].textContent, 'const v = 1; console.log(v);');
  assert.equal(scripts[2].getAttribute('src'), 'c.mjs');
  assert.deepEqual(r.loaded, ['b.mjs']);
  assert.deepEqual(r.notLoaded, [
    { ref: 'a.mjs', reason: 'module_imports' },
    { ref: 'c.mjs', reason: 'module_imports' },
  ]);
  assert.deepEqual(r.dependencies, ['a.mjs', 'b.mjs', 'c.mjs']);
});

test('img src becomes the data url', async () => {
  const { r, fs } = await run('<body><img src="pics/a.png" alt="a"></body>', { 'pics/a.png': 'PNGDATA' });
  const img = parse(r.html).querySelector('img');
  assert.equal(img.getAttribute('src'), dataOf('PNGDATA'));
  assert.equal(img.getAttribute('alt'), 'a');
  assert.deepEqual(fs.log.data, ['pics/a.png']);
  assert.deepEqual(r.loaded, ['pics/a.png']);
});

test('references resolve against the html directory and traversal stays inside the root', async () => {
  const html = '<head><link rel="stylesheet" href="../../x.css"><link rel="stylesheet" href="../b.css">'
    + '<link rel="stylesheet" href="./c/../d.css"><link rel="stylesheet" href="e.css"></head>';
  const files = { 'b.css': 'b{}', 'a/d.css': 'd{}', 'a/e.css': 'e{}' };
  const { r, fs } = await run(html, files, { path: 'a/i.html' });
  assert.deepEqual(r.loaded, ['b.css', 'a/d.css', 'a/e.css']);
  assert.deepEqual(r.notLoaded, [{ ref: '../../x.css', reason: 'outside_workspace' }]);
  assert.ok(!fs.log.text.includes('x.css'));
  assert.ok(!r.dependencies.includes('x.css'));
});

test('a/../b.css works from the root', async () => {
  const { r } = await run('<link rel="stylesheet" href="a/../b.css">', { 'b.css': 'b{}' });
  assert.deepEqual(r.loaded, ['b.css']);
});

test('backslashes, percent-encoding, query and fragment are normalised', async () => {
  const html = '<link rel="stylesheet" href="my%20dir\\s.css?v=3#frag"><img src="i%C3%A9.png#x">';
  const files = { 'my dir/s.css': 's{}', 'ié.png': 'P' };
  const { r } = await run(html, files);
  assert.deepEqual(r.loaded, ['my dir/s.css', 'ié.png']);
});

test('root-relative, drive-letter, file: and other schemes are refused without a read', async () => {
  const html = '<head><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="C:\\x\\a.css">'
    + '<link rel="stylesheet" href="file:///etc/a.css"><link rel="stylesheet" href="ftp://h/a.css">'
    + '<link rel="stylesheet" href="\\\\host\\share\\a.css"></head>'
    + '<body><img src="javascript:alert(1)"><script src="/s.js"></script></body>';
  const { r, fs } = await run(html, { 'a.css': 'x', 's.js': 'x' });
  assert.equal(fs.log.text.length + fs.log.data.length, 0);
  assert.deepEqual(r.notLoaded.map((n) => n.reason), [
    'root_relative', 'unsupported', 'unsupported', 'unsupported', 'root_relative', 'unsupported', 'root_relative',
  ]);
  assert.deepEqual(r.dependencies, []);
  assert.equal(r.html, html);
});

test('malformed percent sequences and control characters are unsupported', async () => {
  const html = '<link rel="stylesheet" href="%E0%A4%A.css"><link rel="stylesheet" href="a%00b.css">'
    + '<link rel="stylesheet" href="a%0Ab.css">';
  const { r, fs } = await run(html, {});
  assert.equal(fs.log.text.length, 0);
  assert.deepEqual(r.notLoaded.map((n) => n.reason), ['unsupported', 'unsupported', 'unsupported']);
});

test('extension allowlist: .env as a stylesheet is refused with no read', async () => {
  const html = '<link rel="stylesheet" href=".env"><link rel="stylesheet" href="app.js">'
    + '<script src="s.css"></script><img src="note.txt"><link rel="stylesheet" href="dir/">'
    + '<link rel="stylesheet" href="noext">';
  const files = { '.env': 'SECRET=1', 'app.js': 'x', 's.css': 'x', 'note.txt': 'x', noext: 'x' };
  const { r, fs } = await run(html, files);
  assert.equal(fs.log.text.length + fs.log.data.length, 0);
  assert.equal(r.notLoaded.length, 6);
  assert.ok(r.notLoaded.every((n) => n.reason === 'unsupported'));
  assert.equal(r.html, html);
});

test('css url() resolves against the css file folder; fonts and images are rewritten', async () => {
  const html = '<head><link rel="stylesheet" href="css/main.css"></head>';
  const css = '@font-face{src:url(fonts/f.woff2) format("woff2"), url(\'fonts/f.ttf\')}\n'
    + 'body{background:url("../img/bg.png?x=1#y")}';
  const files = { 'css/main.css': css, 'css/fonts/f.woff2': 'W2', 'css/fonts/f.ttf': 'TT', 'img/bg.png': 'BG' };
  const { r, fs } = await run(html, files);
  const text = parse(r.html).querySelector('style').textContent;
  assert.ok(text.includes('url("' + dataOf('W2') + '") format("woff2")'));
  assert.ok(text.includes('url("' + dataOf('TT') + '")'));
  assert.ok(text.includes('url("' + dataOf('BG') + '")'));
  assert.ok(!text.includes('fonts/f.woff2'));
  assert.deepEqual(fs.log.data.slice().sort(), ['css/fonts/f.ttf', 'css/fonts/f.woff2', 'img/bg.png']);
  assert.deepEqual(r.loaded, ['css/main.css', 'css/fonts/f.woff2', 'css/fonts/f.ttf', 'img/bg.png']);
});

test('inline style url() resolves against the html file folder', async () => {
  const html = '<style>.a{background:url(pics/a.png)} /* url(pics/commented.png) */</style>';
  const { r, fs } = await run(html, { 'site/pics/a.png': 'A' }, { path: 'site/index.html' });
  const text = parse(r.html).querySelector('style').textContent;
  assert.ok(text.includes('url("' + dataOf('A') + '")'));
  assert.ok(text.includes('url(pics/commented.png)'));
  assert.deepEqual(fs.log.data, ['site/pics/a.png']);
});

test('css url(): data, fragment and web urls are untouched; web is counted; failures are listed', async () => {
  const css = '.a{background:url(data:image/png;base64,AAAA)} .b{fill:url(#grad)} '
    + '.c{background:url(https://x.test/a.png)} .d{background:url(//x.test/b.png)} '
    + '.e{background:url(missing.png)} .f{background:url(cursor.cur)} @import url("other.css"); @import "o2.css";';
  const { r } = await run('<style>' + css + '</style>', {});
  assert.equal(r.html, '<style>' + css + '</style>');
  assert.equal(r.webLinks, 2);
  assert.deepEqual(r.notLoaded, [
    { ref: 'missing.png', reason: 'not_found' },
    { ref: 'cursor.cur', reason: 'unsupported' },
    { ref: 'other.css', reason: 'css_import' },
    { ref: 'o2.css', reason: 'css_import' },
  ]);
  assert.deepEqual(r.dependencies, ['missing.png']);
});

test('@import inside a linked css is kept and recorded while the css is still inlined', async () => {
  const { r } = await run('<link rel="stylesheet" href="a.css">', { 'a.css': '@import "b.css"; p{color:red}' });
  assert.equal(parse(r.html).querySelector('style').textContent, '@import "b.css"; p{color:red}');
  assert.deepEqual(r.notLoaded, [{ ref: 'b.css', reason: 'css_import' }]);
  assert.deepEqual(r.loaded, ['a.css']);
});

test('web links are counted, never loaded, never listed', async () => {
  const html = '<link rel="stylesheet" href="https://a.test/a.css"><link rel="stylesheet" href="HTTP://a.test/b.css">'
    + '<script src="//cdn.test/x.js"></script><img src="https://a.test/i.png"><img src="//a.test/j.png">'
    + '<link rel="stylesheet" href="local.css">';
  const { r, fs } = await run(html, { 'local.css': 'p{}' });
  assert.equal(r.webLinks, 5);
  assert.deepEqual(r.notLoaded, []);
  assert.deepEqual(fs.log.text, ['local.css']);
  assert.equal(parse(r.html).querySelectorAll('script[src]').length, 1);
});

test('missing file is listed in notLoaded and dependencies', async () => {
  const html = '<link rel="stylesheet" href="new.css"><script src="ok.js"></script>';
  const { r } = await run(html, { 'ok.js': 'var a;' });
  assert.deepEqual(r.notLoaded, [{ ref: 'new.css', reason: 'not_found' }]);
  assert.deepEqual(r.dependencies, ['new.css', 'ok.js']);
  assert.ok(parse(r.html).querySelector('link[href="new.css"]'));
});

test('reader rejection or throw becomes unavailable and never escapes', async () => {
  const html = '<link rel="stylesheet" href="a.css"><img src="b.png">';
  for (const fsOpts of [{ reject: true }, { throwSync: true }]) {
    const { r } = await run(html, { 'a.css': 'x', 'b.png': 'y' }, { fs: fsOpts });
    assert.deepEqual(r.notLoaded, [
      { ref: 'a.css', reason: 'unavailable' },
      { ref: 'b.png', reason: 'unavailable' },
    ]);
    assert.deepEqual(r.dependencies, ['a.css', 'b.png']);
    assert.equal(r.html, html);
  }
});

test('reader failure reasons pass through', async () => {
  const fs = {
    readText: async (p) => ({ ok: false, reason: p === 'big.js' ? 'too_large' : 'binary' }),
    readDataUrl: async () => ({ ok: false, reason: 'weird' }),
  };
  const r = await inlineLinkedAssets({
    html: '<script src="big.js"></script><script src="bin.js"></script><img src="x.png">',
    path: 'index.html', DOMParser: DOMParserCtor, ...fs,
  });
  assert.deepEqual(r.notLoaded.map((n) => n.reason), ['too_large', 'binary', 'unavailable']);
});

test('limits: maxAssets stops reads past the cap', async () => {
  const html = '<img src="1.png"><img src="2.png"><img src="3.png"><img src="1.png">';
  const files = { '1.png': 'a', '2.png': 'b', '3.png': 'c' };
  const { r, fs } = await run(html, files, { limits: { maxAssets: 2 } });
  assert.deepEqual(fs.log.data, ['1.png', '2.png']);
  assert.deepEqual(r.notLoaded, [{ ref: '3.png', reason: 'limit' }]);
  assert.deepEqual(r.loaded, ['1.png', '2.png']);
  assert.ok(r.dependencies.includes('3.png'));
});

test('limits: default maxAssets is 60', async () => {
  let html = '';
  for (let i = 0; i < 65; i += 1) html += '<img src="i' + i + '.png">';
  const { r, fs } = await run(html, {});
  assert.equal(fs.log.data.length, 60);
  assert.equal(r.notLoaded.filter((n) => n.reason === 'limit').length, 5);
});

test('limits: maxAssetBytes is passed to readText and enforced on data url bytes', async () => {
  const html = '<script src="a.js"></script><img src="small.png"><img src="big.png">';
  const files = { 'a.js': 'var a;', 'small.png': 'xx', 'big.png': 'xx' };
  const { r, fs } = await run(html, files, {
    limits: { maxAssetBytes: 100 },
    fs: { bytes: (p) => (p === 'big.png' ? 101 : 5) },
  });
  assert.deepEqual(fs.log.maxBytes, [100]);
  assert.deepEqual(r.notLoaded, [{ ref: 'big.png', reason: 'too_large' }]);
  assert.deepEqual(r.loaded, ['a.js', 'small.png']);
});

test('limits: default maxAssetBytes is 1,000,000', async () => {
  const { fs } = await run('<script src="a.js"></script>', { 'a.js': 'x' });
  assert.deepEqual(fs.log.maxBytes, [1000000]);
});

test('limits: maxTotalBytes applies in document order and leaves the element unchanged', async () => {
  const html = '<body><script src="s1.js"></script><script src="s2.js"></script><script src="s3.js"></script></body>';
  const files = { 's1.js': '1234567890', 's2.js': '1234567890', 's3.js': '1234567890' };
  const { r } = await run(html, files, { limits: { maxTotalBytes: 25 } });
  const scripts = Array.from(parse(r.html).querySelectorAll('script'));
  assert.equal(scripts[0].textContent, '1234567890');
  assert.equal(scripts[1].textContent, '1234567890');
  assert.equal(scripts[2].getAttribute('src'), 's3.js');
  assert.equal(scripts[2].textContent, '');
  assert.deepEqual(r.notLoaded, [{ ref: 's3.js', reason: 'too_large' }]);
  assert.deepEqual(r.loaded, ['s1.js', 's2.js']);
});

test('limits: maxTotalBytes counts data url length', async () => {
  const html = '<img src="a.png"><img src="b.png">';
  const a = dataOf('aaaa').length;
  const { r } = await run(html, { 'a.png': 'aaaa', 'b.png': 'bbbb' }, { limits: { maxTotalBytes: a + 5 } });
  assert.deepEqual(r.loaded, ['a.png']);
  assert.deepEqual(r.notLoaded, [{ ref: 'b.png', reason: 'too_large' }]);
});

test('results do not depend on read completion order', async () => {
  const html = '<head><link rel="stylesheet" href="a.css"></head><body><script src="s1.js"></script>'
    + '<img src="i.png"><script src="s2.js"></script><script src="s3.js"></script></body>';
  const files = {
    'a.css': 'body{background:url(bg.png)}', 'bg.png': 'BG', 's1.js': '1234567890', 's2.js': '1234567890',
    's3.js': '1234567890', 'i.png': 'II',
  };
  const order = ['a.css', 's1.js', 'i.png', 's2.js', 's3.js', 'bg.png'];
  const limits = { maxTotalBytes: 60 + dataOf('II').length };
  const a = await run(html, files, { limits, fs: { delay: (p) => (order.indexOf(p) + 1) * 6 } });
  const b = await run(html, files, { limits, fs: { delay: (p) => (order.length - order.indexOf(p)) * 6 } });
  const c = await run(html, files, { limits });
  assert.deepEqual(a.r, b.r);
  assert.deepEqual(a.r, c.r);
  assert.ok(a.r.notLoaded.length > 0, 'the budget should actually cut something');
});

test('at most 4 reads are in flight', async () => {
  let html = '';
  const files = {};
  for (let i = 0; i < 14; i += 1) {
    html += '<img src="i' + i + '.png">';
    files['i' + i + '.png'] = 'x' + i;
  }
  const { r, fs } = await run(html, files, { fs: { delay: () => 8 } });
  assert.equal(r.loaded.length, 14);
  assert.ok(fs.log.maxActive <= 4, 'max active ' + fs.log.maxActive);
  assert.ok(fs.log.maxActive >= 2, 'reads should overlap, got ' + fs.log.maxActive);
});

test('the same asset referenced twice is read once and loaded once', async () => {
  const html = '<head><link rel="stylesheet" href="a.css"><link rel="stylesheet" href="a.css"></head>'
    + '<body><img src="i.png"><img src="./i.png"><style>p{background:url(i.png)}</style></body>';
  const { r, fs } = await run(html, { 'a.css': 'a{}', 'i.png': 'I' });
  assert.deepEqual(fs.log.text, ['a.css']);
  assert.deepEqual(fs.log.data, ['i.png']);
  assert.deepEqual(r.loaded, ['a.css', 'i.png']);
  assert.deepEqual(r.dependencies, ['a.css', 'i.png']);
  assert.equal(parse(r.html).querySelectorAll('style').length, 3);
});

test('notLoaded ref is the original reference truncated to 200 chars', async () => {
  const long = 'x'.repeat(300) + '.css';
  const { r } = await run('<link rel="stylesheet" href="' + long + '">', {});
  assert.equal(r.notLoaded.length, 1);
  assert.equal(r.notLoaded[0].ref, long.slice(0, 200));
  assert.equal(r.notLoaded[0].ref.length, 200);
});

test('a data url with quotes cannot break out of a css url() string', async () => {
  const fs = {
    readText: async () => ({ ok: true, text: 'a{background:url(x.svg)}' }),
    readDataUrl: async () => ({ ok: true, dataUrl: 'data:image/svg+xml,<svg a="1"></svg>);evil{', bytes: 10 }),
  };
  const r = await inlineLinkedAssets({
    html: '<link rel="stylesheet" href="a.css">', path: 'index.html', DOMParser: DOMParserCtor, ...fs,
  });
  const css = parse(r.html).querySelector('style').textContent;
  assert.ok(!css.includes('"1"'));
  assert.ok(css.startsWith('a{background:url("data:image/svg+xml,'));
  assert.ok(css.endsWith('")}'));
});

test('non-data reader results are rejected as unavailable', async () => {
  const r = await inlineLinkedAssets({
    html: '<img src="a.png">', path: 'index.html', DOMParser: DOMParserCtor,
    readText: async () => ({ ok: false, reason: 'not_found' }),
    readDataUrl: async () => ({ ok: true, dataUrl: 'javascript:alert(1)', bytes: 3 }),
  });
  assert.deepEqual(r.notLoaded, [{ ref: 'a.png', reason: 'unavailable' }]);
});

test('document order is kept for loaded and the output is a full document', async () => {
  const html = '<head><link rel="stylesheet" href="b.css"></head><body><img src="a.png"><script src="c.js"></script></body>';
  const { r } = await run(html, { 'b.css': 'b{}', 'a.png': 'A', 'c.js': 'c()' }, { fs: { delay: (p) => (p === 'b.css' ? 20 : 0) } });
  assert.deepEqual(r.loaded, ['b.css', 'a.png', 'c.js']);
  assert.ok(r.html.startsWith('<html>'));
});

test('limits: the page and its files together stay inside the staging cap, counted in bytes', async () => {
  const page = `<p>${'x'.repeat(3900000)}</p><link rel="stylesheet" href="a.css">`;
  const { r } = await run(page, { 'a.css': '\u00e9'.repeat(150000) });
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.notLoaded, [{ ref: 'a.css', reason: 'too_large' }]);
});

test('reads stop once oversized files have used up the read budget', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `${i}.png`);
  const big = 'b'.repeat(2 * 1024 * 1024);
  const files = Object.fromEntries(names.map((name) => [name, big]));
  const html = names.map((name) => `<img src="${name}">`).join('');
  const { r, fs } = await run(html, files, { fs: { bytes: () => big.length } });
  assert.ok(fs.log.data.length <= 12, `read ${fs.log.data.length} files`);
  assert.equal(r.notLoaded.length, 40);
  assert.ok(r.notLoaded.every((item) => item.reason === 'too_large'));
});
