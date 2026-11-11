'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  READER_WORLD_ID, VIEWPORT_CHAR_BUDGET, FULL_CHAR_BUDGET, buildReaderCall,
} = require('../services/browser-use/page-reader-script');

const SECRET = 'hunter2-SECRET-xyz';
const ch = (...codes) => String.fromCharCode(...codes);
const [ZW, BIDI_OVERRIDE, BIDI_ISOLATE_END, BIDI_ISOLATE, BOM] = [0x200B, 0x202E, 0x2069, 0x2066, 0xFEFF].map((c) => ch(c));
const INVISIBLE_RE = new RegExp(`[${ZW}-${ch(0x200F)}${ch(0x202A)}-${BIDI_OVERRIDE}${ch(0x2060)}-${BIDI_ISOLATE_END}${BOM}]`);
const NOTE_RE = /^\[cut at (\d+) chars: use find, scroll, or read with a ref\]$/;

// jsdom has no layout: elements get stub rects from data-top / data-h / data-w; html and body span the page.
function makePage(html, { url = 'https://example.com/page', innerHeight = 900, pageHeight = 4200 } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  const { window } = dom;
  const state = { scrollY: 0, pageHeight, hit: null, hitFn: null, intoView: 0 };
  const define = (target, name, descriptor) => Object.defineProperty(target, name, { configurable: true, ...descriptor });
  define(window, 'innerHeight', { value: innerHeight });
  define(window, 'scrollY', { get: () => state.scrollY });
  define(window.document.documentElement, 'scrollHeight', { get: () => state.pageHeight });
  window.scrollBy = ({ top }) => { state.scrollY = Math.max(0, Math.min(state.pageHeight - innerHeight, state.scrollY + top)); };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const num = (name, fallback) => (this.hasAttribute(name) ? Number(this.getAttribute(name)) : fallback);
    const [width, top] = [num('data-w', 100), num('data-top', 0) - state.scrollY];
    const height = num('data-h', this === window.document.body || this === window.document.documentElement ? state.pageHeight : 20);
    return { x: 0, y: top, left: 0, top, right: width, bottom: top + height, width, height };
  };
  window.Element.prototype.scrollIntoView = function scrollIntoView() {
    [state.intoView, state.scrollY] = [state.intoView + 1, Math.max(0, Number(this.getAttribute('data-top') || 0) - 100)];
  };
  window.document.elementFromPoint = (x, y) => (state.hitFn ? state.hitFn(x, y) : state.hit);
  const run = (op, args) => JSON.parse(JSON.stringify(window.eval(buildReaderCall(op, args))));
  return { dom, window, doc: window.document, state, run };
}

const lineList = (res) => res.text.split('\n');
const refOf = (res, pattern) => {
  const line = lineList(res).find((l) => /^\[r\d+\]/.test(l) && pattern.test(l));
  assert.ok(line, `no control line matching ${pattern}\n${res.text}`);
  return /^\[(r\d+)\]/.exec(line)[1];
};
const fullRead = (page) => page.run('read', { scope: 'full' });
const probeRef = (page, res, pattern) => page.run('probe', { ref: refOf(res, pattern) });

const OUTLINE_HTML = `<html><head><title>Test Page</title></head><body>
<h1>Top heading</h1><h2>Sub heading</h2><p>A paragraph   of   visible
text.</p>
<a href="https://example.com/docs">Docs</a><button>Sign in</button>
<label for="q">Search</label><input id="q" type="text" value="cats">
<input type="checkbox" id="agree" checked><label for="agree">Agree</label>
<select id="country" aria-label="Country"><option value="US" selected>US</option><option>CA</option><option>MX</option></select>
<input type="password" aria-label="Password" value="${SECRET}">
<textarea aria-label="Notes">hello notes</textarea><div contenteditable="true" aria-label="Editor">draft text</div>
<details><summary>More</summary>folded away text</details><button disabled>Nope</button>
<div role="tab" aria-selected="true">Tab one</div><div onclick="x()">Click me</div>
<input type="hidden" name="csrf" value="tok-hidden"></body></html>`;

test('read renders the header and each element type in the documented outline format', () => {
  assert.deepEqual([READER_WORLD_ID, VIEWPORT_CHAR_BUDGET, FULL_CHAR_BUDGET], [1001, 6000, 14000]);
  const page = makePage(OUTLINE_HTML);
  const res = page.run('read', { scope: 'viewport' });
  assert.equal(res.status, 'ok');
  assert.deepEqual([res.title, res.url, res.viewportHeight, res.pageHeight, res.scrollY, res.truncated],
    ['Test Page', 'https://example.com/page', 900, 4200, 0, false]);
  const lines = lineList(res);
  assert.deepEqual(lines.slice(0, 4), ['Page: Test Page', 'URL: https://example.com/page', 'Showing 0-900 px of 4200 px. Scroll or find for more.', '']);
  const expected = [
    /^# Top heading$/, /^## Sub heading$/, /^A paragraph of visible text\.$/,
    /^\[r\d+\] link "Docs" -> https:\/\/example\.com\/docs$/, /^\[r\d+\] button "Sign in"$/,
    /^\[r\d+\] textbox "Search" value="cats"$/, /^\[r\d+\] checkbox "Agree" checked$/,
    /^\[r\d+\] combobox "Country" value="US" options: US, CA, MX$/, /^\[r\d+\] password "Password" \(filled\)$/,
    /^\[r\d+\] textbox "Notes" value="hello notes"$/, /^\[r\d+\] textbox "Editor" value="draft text"$/,
    /^\[r\d+\] summary "More"/, /^\[r\d+\] button "Nope" disabled$/, /^\[r\d+\] tab "Tab one" selected$/,
    /^\[r\d+\] clickable "Click me"$/,
  ];
  let cursor = 4;
  for (const pattern of expected) {
    const at = lines.findIndex((l, i) => i >= cursor && pattern.test(l));
    assert.ok(at >= 0, `missing or out of order: ${pattern}\n${res.text}`);
    cursor = at + 1;
  }
  for (const absent of ['folded away', 'tok-hidden', SECRET]) assert.ok(!res.text.includes(absent), absent);
  assert.equal(res.refCount, 12);
});

test('a long select lists a bounded set of options in the outline and in a failed select', () => {
  const options = Array.from({ length: 40 }, (_, i) => `<option>Opt${i}</option>`).join('');
  const page = makePage(`<body><select aria-label="Pick">${options}</select></body>`);
  const res = fullRead(page);
  assert.match(res.text, /combobox "Pick" value="Opt0" options: Opt0, Opt1, .*\(\+32 more\)/);
  const { ref, fingerprint } = probeRef(page, res, /Pick/);
  const miss = page.run('select', { ref, fingerprint, value: 'nope' });
  assert.deepEqual([miss.status, miss.options.length], ['no_such_option', 20]);
});

test('overlong values, names, link targets and paragraphs are bounded', () => {
  const long = 'x'.repeat(500);
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const page = makePage(`<body><input aria-label="Field" value="${long}">
    <a href="https://example.com/${'p'.repeat(300)}">${long}</a><p>${words}</p></body>`);
  const lines = lineList(fullRead(page));
  const value = /value="([^"]*)"/.exec(lines.find((l) => l.includes('textbox "Field"')))[1];
  assert.ok(value.length <= 200 && value.startsWith('xxx'), `value length ${value.length}`);
  const link = lines.find((l) => l.includes(' link '));
  assert.ok(link.split(' -> ')[1].length <= 120 && /link "x+"/.exec(link)[0].length <= 220);
  const paragraph = lines.filter((l) => l.startsWith('word'));
  assert.ok(paragraph.length >= 2 && paragraph.every((l) => l.length <= 300));
  assert.equal(paragraph.join(' '), words);
});

test('viewport scope culls by rect, full scope does not, ref scope reads one subtree', () => {
  const page = makePage(`<body><p data-top="0">first</p><p data-top="500">second</p><p data-top="1000">third</p>
    <div id="sec" data-top="2000" data-h="300"><p data-top="2000">inner copy</p><button data-top="2050">Inner button</button></div>
    <p data-top="5000">last</p></body>`);
  const view = page.run('read', { scope: 'viewport' });
  assert.ok(view.text.includes('first') && view.text.includes('second'));
  for (const gone of ['third', 'inner copy', 'last']) assert.ok(!view.text.includes(gone), gone);
  const full = fullRead(page);
  for (const word of ['first', 'second', 'third', 'inner copy', 'Inner button', 'last']) assert.ok(full.text.includes(word), word);
  assert.match(full.text, /^Showing the full page/m);
  const sub = page.run('read', { scope: 'viewport', ref: refOf(full, /Inner button/) });
  assert.ok(sub.text.includes('Inner button') && !sub.text.includes('first') && !sub.text.includes('last'));
  page.state.scrollY = 2000;
  const scrolled = page.run('read', { scope: 'viewport' });
  assert.match(scrolled.text, /^Showing 2000-2900 px of 4200 px\./m);
  assert.ok(scrolled.text.includes('inner copy') && !scrolled.text.includes('first'));
  const spill = makePage('<body><div id="tiny" data-h="10"><p data-top="400">spilled child</p></div></body>');
  Object.defineProperty(spill.doc.getElementById('tiny'), 'scrollHeight', { value: 500 });
  spill.state.scrollY = 300;
  assert.ok(spill.run('read', { scope: 'viewport' }).text.includes('spilled child'));
});

test('truncation: viewport and full scope stay within their budget and end with the note', () => {
  const page = makePage(`<body>${Array.from({ length: 600 }, (_, i) => `<p>Paragraph number ${i} with some filler words to take space.</p>`).join('')}</body>`);
  for (const [scope, budget] of [['viewport', VIEWPORT_CHAR_BUDGET], ['full', FULL_CHAR_BUDGET]]) {
    const res = page.run('read', { scope });
    assert.equal(res.truncated, true, scope);
    assert.ok(res.text.length <= budget && res.text.length > budget - 300, `${scope} length ${res.text.length}`);
    const last = lineList(res).at(-1);
    const m = NOTE_RE.exec(last);
    assert.ok(m, `${scope} note: ${last}`);
    assert.equal(Number(m[1]), res.text.length - last.length - 1);
  }
});

test('truncation: the hard limit holds for very long lines, for a ref read, and without a cut when it fits', () => {
  const links = Array.from({ length: 100 }, (_, i) => `<a href="https://example.com/${i}">${'L'.repeat(190)}${i}</a>`).join('');
  const page = makePage(`<body><div id="d">${links}</div></body>`);
  const view = page.run('read', { scope: 'viewport' });
  assert.ok(view.text.length <= VIEWPORT_CHAR_BUDGET && view.truncated);
  const sub = page.run('read', { scope: 'viewport', ref: refOf(fullRead(page), /link/) });
  assert.ok(sub.status === 'ok' && sub.text.length <= FULL_CHAR_BUDGET);
  const small = fullRead(makePage('<body><p>tiny</p></body>'));
  assert.ok(!small.truncated && !small.text.includes('[cut at'));
});

test('truncation: the node visit budget ends the walk with truncated and the note', () => {
  const res = fullRead(makePage(`<body>${'<i></i>'.repeat(21000)}<p>never reached</p></body>`));
  assert.equal(res.truncated, true);
  assert.ok(!res.text.includes('never reached') && res.text.length <= FULL_CHAR_BUDGET);
  assert.match(lineList(res).at(-1), NOTE_RE);
});

test('refs are stable across reads and new elements continue the numbering', () => {
  const page = makePage('<body><a href="https://example.com/a">Alpha</a><button>Beta</button></body>');
  const first = fullRead(page);
  assert.deepEqual([first.text, first.refCount], [fullRead(page).text, 2]);
  assert.deepEqual([refOf(first, /Alpha/), refOf(first, /Beta/)], ['r1', 'r2']);
  page.doc.body.insertAdjacentHTML('afterbegin', '<button>Gamma</button>');
  const third = fullRead(page);
  assert.deepEqual([refOf(third, /Gamma/), refOf(third, /Alpha/)], ['r3', 'r1']);
});

test('refs differ by generation, and a ref from an earlier page never reaches a later page', () => {
  const html = '<body><button>Go</button></body>';
  const [pageA, pageB] = [makePage(html), makePage(html)];
  const [goA, goB] = [[pageA, 0], [pageB, 3]].map(([pg, generation]) => refOf(pg.run('read', { scope: 'full', generation }), /Go/));
  assert.deepEqual([goA, goB], ['r1', 'r30001']);
  for (const op of ['probe', 'verify']) assert.deepEqual(pageB.run(op, { ref: goA, fingerprint: 'x', generation: 3 }), { status: 'stale', ref: goA });
  assert.equal(refOf(pageB.run('read', { scope: 'full', generation: 9 }), /Go/), goB, 'the base is fixed by the first call of an install');
});

test('refs stop being handed out past 9999', () => {
  const page = makePage(`<body>${Array.from({ length: 10100 }, (_, i) => `<button aria-label="B${i}"></button>`).join('')}</body>`);
  assert.match(page.run('find', { query: 'B3' }).matches[0].ref, /^r\d+$/);
  const late = page.run('find', { query: 'B10099' }).matches[0];
  assert.deepEqual([late.name, late.ref, fullRead(page).refCount], ['B10099', '', 9999]);
});

test('a removed element reads as stale', () => {
  const page = makePage('<body><button id="b">Gone soon</button><p>x</p></body>');
  const ref = refOf(fullRead(page), /Gone soon/);
  page.doc.getElementById('b').remove();
  for (const [op, args] of [['probe', {}], ['read', { scope: 'full' }], ['scroll', { direction: 'down' }]]) {
    assert.deepEqual(page.run(op, { ref, ...args }), { status: 'stale', ref });
  }
  for (const [op, args] of [['focusForTyping', { clear: false }], ['select', { value: 'a' }]]) {
    assert.equal(page.run(op, { ref, fingerprint: 'x', ...args }).status, 'stale');
  }
  assert.deepEqual(page.run('probe', { ref: 'not-a-ref' }), { status: 'stale', ref: 'not-a-ref' });
  const hide = makePage('<body><button id="b">Soon hidden</button></body>');
  const hiddenRef = refOf(fullRead(hide), /Soon hidden/);
  hide.doc.getElementById('b').style.display = 'none';
  assert.deepEqual(hide.run('probe', { ref: hiddenRef }), { status: 'not_visible', ref: hiddenRef });
});

test('text hidden from users never reaches the outline', () => {
  const page = makePage(`<body><p>shown text</p><p hidden>attr hidden</p><p aria-hidden="true">aria hidden</p>
    <p style="display:none">display none</p><p style="visibility:hidden">visibility hidden</p>
    <p style="opacity:0">opacity zero</p><p data-w="0" data-h="0" style="overflow:hidden">zero size</p>
    <p data-w="1" data-h="1" style="overflow:hidden">one pixel clip</p><p style="font-size:0">font zero</p>
    <div aria-hidden="true"><button>Hidden button</button></div><div style="display:none"><p>inside none</p></div>
    <div style="font-size:0"><span style="font-size:14px">child with size</span></div></body>`);
  const res = fullRead(page);
  assert.ok(res.text.includes('shown text') && res.text.includes('child with size'));
  for (const hidden of ['attr hidden', 'aria hidden', 'display none', 'visibility hidden', 'opacity zero', 'zero size', 'one pixel clip', 'font zero', 'Hidden button', 'inside none']) assert.ok(!res.text.includes(hidden), `leaked: ${hidden}`);
});

test('zero-width and bidi control characters are removed from every returned string', () => {
  const page = makePage(`<html><head><title>T${ZW}itle${BIDI_OVERRIDE}</title></head><body>
    <p>he${ZW}llo ${BIDI_OVERRIDE}evil${BIDI_ISOLATE_END} wor${BOM}ld ${BIDI_ISOLATE}x</p>
    <button aria-label="Pay${ZW}ment${BIDI_OVERRIDE}">go</button><a href="https://example.com/a${ZW}b">Link</a></body></html>`);
  const res = fullRead(page);
  assert.equal(res.title, 'Title');
  assert.ok(res.text.includes('hello evil world x') && res.text.includes('button "Payment"'));
  assert.ok(!INVISIBLE_RE.test(res.text));
  const found = page.run('find', { query: 'payment' });
  assert.ok(found.total === 1 && !INVISIBLE_RE.test(JSON.stringify(found)));
});

test('only http(s) link targets are shown and reported', () => {
  const page = makePage(`<body><a href="javascript:alert(1)">Script link</a><a href="mailto:a@b.c">Mail link</a>
    <a href="/docs/x?a=1">Relative</a><a>No href</a></body>`);
  const res = fullRead(page);
  for (const line of ['link "Script link"', 'link "Mail link"', 'link "Relative" -> https://example.com/docs/x?a=1']) {
    assert.ok(lineList(res).some((l) => /^\[r\d+\] /.test(l) && l.endsWith(line)), line);
  }
  assert.ok(!res.text.includes('javascript:') && !/^\[r\d+\].*No href/m.test(res.text));
  const js = probeRef(page, res, /Script link/);
  assert.deepEqual([js.href, js.isAnchor, js.tag], ['', true, 'a']);
  const rel = probeRef(page, res, /Relative/);
  assert.deepEqual([rel.href, rel.role], ['https://example.com/docs/x?a=1', 'link']);
});

test('open shadow roots and same-origin iframes are walked; cross-origin frames are one line', () => {
  const page = makePage('<body><div id="host"></div><iframe id="same"></iframe><iframe id="cross" src="https://other.example/embed"></iframe></body>');
  page.doc.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>inside shadow</p><button>Shadow button</button>';
  page.doc.getElementById('same').contentDocument.body.innerHTML = '<p>inside frame</p><button>Frame button</button>';
  Object.defineProperty(page.doc.getElementById('cross'), 'contentDocument', { get() { throw new Error('Blocked a frame with origin'); } });
  const res = fullRead(page);
  assert.ok(res.text.includes('inside shadow') && res.text.includes('inside frame'));
  assert.match(res.text, /^\[r\d+\] button "Shadow button"$/m);
  assert.match(res.text, /^\[r\d+\] button "Frame button"$/m);
  assert.match(res.text, /^\[frame: other\.example\]$/m);
  assert.deepEqual(['Shadow button', 'Frame button'].map((n) => probeRef(page, res, new RegExp(n)).status), ['ready', 'ready']);
  let doc = page.doc.getElementById('same').contentDocument;
  for (const [level, next] of [['one', 'f2'], ['two', 'f3'], ['three', 'f4'], ['four', null]]) {
    doc.body.innerHTML = `<p>level ${level}</p>${next ? `<iframe id="${next}"></iframe>` : ''}`;
    if (next) doc = doc.getElementById(next).contentDocument;
  }
  const nested = fullRead(page);
  assert.ok(nested.text.includes('level three') && !nested.text.includes('level four'));
});

test('find is case-insensitive, caps at 20, lists interactive elements first and bounds snippets', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `<p>Needle paragraph ${i} ${'filler '.repeat(60)}</p>`).join('');
  const page = makePage(`<body>${rows}<button>Find the NEEDLE here</button><input aria-label="needle input"></body>`);
  const res = page.run('find', { query: 'nEeDlE' });
  assert.deepEqual([res.status, res.total, res.matches.length], ['ok', 32, 20]);
  assert.deepEqual(res.matches.slice(0, 2).map((m) => m.role), ['button', 'textbox']);
  assert.ok(res.matches.every((m) => /^r\d+$/.test(m.ref) && m.snippet.length <= 160 && typeof m.name === 'string'));
  assert.deepEqual(page.run('find', { query: 'zzz-none' }), { status: 'ok', total: 0, matches: [], fields: 1 });
  assert.equal(page.run('find', { query: '' }).total, 0);
  assert.equal(page.run('probe', { ref: res.matches[5].ref }).status, 'ready');
  const hidden = makePage('<body><p style="display:none">ghost phrase</p><p>real text</p></body>');
  assert.deepEqual([hidden.run('find', { query: 'ghost' }).total, hidden.run('find', { query: 'real' }).total], [0, 1]);
});

test('probe returns the facts shape', () => {
  const page = makePage(`<body><form method="POST" action="/login"><input id="u" name="user" aria-label="User" value="alice">
    <input type="password" aria-label="Pass" value="${SECRET}"><button>Go</button></form>
    <input type="file" aria-label="Upload"><input type="checkbox" checked aria-label="Opt"><button disabled>Off</button>
    <a href="https://example.com/z">Zed</a></body>`);
  const res = fullRead(page);
  const user = probeRef(page, res, /User/);
  assert.deepEqual([user.status, user.tag, user.role, user.inputType, user.name], ['ready', 'input', 'textbox', 'text', 'User']);
  assert.deepEqual([user.isAnchor, user.href, user.isFileInput, user.isSecret, user.isEditable, user.disabled, user.checked],
    [false, '', false, false, true, false, false]);
  assert.deepEqual(user.form, { present: true, method: 'post', action: 'https://example.com/login', hasSecretField: true });
  assert.deepEqual(Object.keys(user.rect), ['x', 'y', 'width', 'height', 'centerX', 'centerY']);
  assert.equal(user.rect.centerX, user.rect.x + user.rect.width / 2);
  assert.ok(['input', 'User', 'post', 'https://example.com/login'].every((part) => user.fingerprint.includes(part)));
  assert.equal(probeRef(page, res, /Upload/).isFileInput, true);
  assert.equal(probeRef(page, res, /Opt/).checked, true);
  assert.equal(probeRef(page, res, /Off/).disabled, true);
  const zed = probeRef(page, res, /Zed/);
  assert.deepEqual(zed.form, { present: false, method: '', action: '', hasSecretField: false });
  assert.deepEqual([zed.isAnchor, zed.href], [true, 'https://example.com/z']);
  assert.equal(probeRef(page, res, /"Go"/).form.method, 'post');
});

test('form defaults and clobbering: method defaults to get, a field named action cannot spoof it', () => {
  const page = makePage(`<body><form action="https://other.example/s"><input aria-label="Q"></form>
    <form action="/real"><input name="action" aria-label="A" value="evil"></form></body>`);
  const res = fullRead(page);
  assert.deepEqual(probeRef(page, res, /"Q"/).form, { present: true, method: 'get', action: 'https://other.example/s', hasSecretField: false });
  assert.equal(probeRef(page, res, /"A"/).form.action, 'https://example.com/real');
});

test('accessible name follows labelledby, aria-label, label, alt, title, placeholder then text', () => {
  const page = makePage(`<body><span id="lbl">From labelledby</span>
    <button aria-labelledby="lbl" aria-label="ignored">text</button><button aria-label="From aria">text</button>
    <label for="n3">From label</label><input id="n3" placeholder="ph" title="ttl"><img alt="From alt" onclick="x()">
    <input title="From title" placeholder="ph"><input placeholder="From placeholder">
    <button>  Spaced   out
      text </button><input type="submit" value="Send it"><button title="tip">Visible text</button></body>`);
  const text = fullRead(page).text;
  for (const needle of ['button "From labelledby"', 'button "From aria"', 'textbox "From label"', '"From alt"', 'textbox "From title"',
    'textbox "From placeholder"', 'button "Spaced out text"', 'button "Send it"', 'button "Visible text"']) {
    assert.ok(text.includes(needle), `${needle}\n${text}`);
  }
});

test('secret fields: every documented rule hides the value and reports only filled or empty', () => {
  const fields = [
    '<input type="password" aria-label="Plain pw">', '<input autocomplete="current-password" aria-label="AC current">',
    '<input autocomplete="new-password" aria-label="AC new">', '<input autocomplete="one-time-code" aria-label="AC otp">',
    '<input autocomplete="cc-number" aria-label="AC cc">', '<input autocomplete="section-x cc-exp" aria-label="AC exp">',
    '<input name="card_number" aria-label="Pattern card name">', '<input id="cardNumber" aria-label="Pattern card id">',
    '<input aria-label="Pattern CVV">', '<input name="cvc" aria-label="Pattern cvc name">', '<input placeholder="Security code" aria-label="Pattern sec">',
    '<input name="ssn" aria-label="Pattern ssn">', '<input aria-label="Social Security Number">', '<input name="user_passcode" aria-label="Pattern passcode">',
    '<input id="PIN" aria-label="Pattern pin id">', '<input name="login_pin" aria-label="Pattern pin name">',
    '<input placeholder="Enter your password" aria-label="Pattern ph">', '<textarea aria-label="Pattern textarea password"></textarea>',
    '<div contenteditable="true" aria-label="Editable password"></div>', '<div contenteditable="true" autocomplete="one-time-code" aria-label="CE ac"></div>',
  ].map((f) => f.replace(/^<(\w+)/, '<$1 data-s="1"'));
  const page = makePage(`<body>${fields.join('\n')}</body>`);
  page.doc.querySelectorAll('[data-s]').forEach((el, i) => {
    if (el.localName === 'input') el.value = `${SECRET}-${i}`;
    else el.textContent = `${SECRET}-${i}`;
  });
  const res = fullRead(page);
  assert.ok(!res.text.includes('hunter2'));
  const controls = lineList(res).filter((l) => l.startsWith('[r'));
  assert.equal(controls.length, fields.length);
  for (const line of controls) {
    assert.ok(line.endsWith('(filled)'), line);
    assert.equal(page.run('probe', { ref: /^\[(r\d+)\]/.exec(line)[1] }).isSecret, true, line);
  }
  page.doc.querySelector('[data-s]').value = '';
  assert.match(fullRead(page).text, /password "Plain pw" \(empty\)/);
  // Only value-holding fields are secret: a link or checkbox that mentions a password is not.
  const plain = makePage(`<body><a href="https://example.com/reset">Forgot password?</a>
    <input type="checkbox" aria-label="Show password"><input aria-label="Username" value="alice"></body>`);
  const plainRead = fullRead(plain);
  assert.match(plainRead.text, /link "Forgot password\?" -> /);
  assert.match(plainRead.text, /textbox "Username" value="alice"/);
  assert.equal(probeRef(plain, plainRead, /Forgot/).isSecret, false);
  assert.equal(probeRef(plain, plainRead, /Show password/).isSecret, false);
});

test('a password field that flips to text stays secret, even when flipped between calls', () => {
  const page = makePage(`<body><input id="pw" type="password" aria-label="Pw" value="${SECRET}"></body>`);
  assert.match(fullRead(page).text, /password "Pw" \(filled\)/);
  page.doc.getElementById('pw').setAttribute('type', 'text');
  const after = fullRead(page);
  assert.ok(!after.text.includes('hunter2'));
  assert.match(after.text, /"Pw" \(filled\)/);
  assert.equal(probeRef(page, after, /Pw/).isSecret, true);
  // A field created and flipped between two calls is caught through the mutation record.
  page.doc.body.insertAdjacentHTML('beforeend', `<input id="late" type="password" aria-label="Late" value="${SECRET}">`);
  page.doc.getElementById('late').setAttribute('type', 'text');
  const res = fullRead(page);
  assert.ok(!res.text.includes('hunter2'));
  assert.match(res.text, /"Late" \(filled\)/);
});

test('no op ever returns a secret value', () => {
  const page = makePage(`<body><form action="/pay" method="post">
    <input id="pw" type="password" aria-label="Password" value="${SECRET}">
    <input id="cc" autocomplete="cc-number" aria-label="Card" value="${SECRET}-cc">
    <textarea id="ta" aria-label="Recovery password">${SECRET}-ta</textarea>
    <div id="ce" contenteditable="true" tabindex="0" aria-label="PIN">${SECRET}-ce</div>
    <select id="sel" aria-label="Security code"><option value="${SECRET}-sel" selected>${SECRET}-opt</option><option value="b">b</option></select>
    <label>Wrapped password <input id="wrapped" type="text" value="${SECRET}-w"></label></form></body>`);
  const outputs = [];
  const call = (op, args) => { const r = page.run(op, args); outputs.push(JSON.stringify(r)); return r; };
  const read = call('read', { scope: 'full' });
  call('read', { scope: 'viewport' });
  for (const [id, label] of [['pw', 'Password'], ['cc', 'Card'], ['ta', 'Recovery password'], ['ce', 'PIN'], ['sel', 'Security code'], ['wrapped', 'Wrapped password']]) {
    const ref = refOf(read, new RegExp(`"${label}"`));
    const facts = call('probe', { ref });
    assert.equal(facts.isSecret, true, id);
    page.state.hit = page.doc.getElementById(id);
    const fingerprint = facts.fingerprint;
    for (const clear of [true, false]) call('focusForTyping', { ref, fingerprint, clear });
    call('verify', { ref, fingerprint });
    for (const value of ['b', 'not-there', '']) call('select', { ref, fingerprint, value });
    call('read', { scope: 'full', ref });
    page.doc.getElementById(id).focus();
    call('probeFocused', {});
  }
  for (const query of ['hunter', 'secret', SECRET, 'password', 'pin', 'card']) call('find', { query });
  for (const [op, args] of [['scroll', { direction: 'down' }], ['status', {}], ['secretMask', { on: true }], ['secretMask', { on: false }]]) call(op, args);
  assert.ok(outputs.length > 30);
  for (const out of outputs) assert.ok(!out.includes('hunter2') && !out.includes('SECRET-xyz'), out.slice(0, 200));
});

test('verify: ready, changed, stale and obscured', () => {
  const page = makePage(`<body><a id="a" href="https://example.com/a">Alpha</a><button id="b"><span id="bs">Buy</span></button>
    <div id="overlay" aria-label="Cookie banner" role="dialog">cover</div>
    <label for="inp" id="lab">Name</label><input id="inp"></body>`);
  const res = fullRead(page);
  const [aRef, bRef, inpRef] = [refOf(res, /Alpha/), refOf(res, /Buy/), refOf(res, /textbox "Name"/)];
  const [a, b, inp] = [aRef, bRef, inpRef].map((ref) => page.run('probe', { ref }));
  page.state.hit = page.doc.getElementById('a');
  const ready = page.run('verify', { ref: aRef, fingerprint: a.fingerprint });
  assert.deepEqual([ready.status, Object.keys(ready.rect)], ['ready', ['x', 'y', 'width', 'height', 'centerX', 'centerY']]);
  for (const [ref, facts, hit] of [[bRef, b, 'bs'], [bRef, b, null], [inpRef, inp, 'lab']]) {
    page.state.hit = hit ? page.doc.getElementById(hit) : page.doc.body;
    assert.equal(page.run('verify', { ref, fingerprint: facts.fingerprint }).status, 'ready', `descendant, ancestor or label hit ${hit}`);
  }
  page.state.hit = page.doc.getElementById('overlay');
  const obscured = page.run('verify', { ref: bRef, fingerprint: b.fingerprint });
  assert.deepEqual([obscured.status, obscured.ref], ['obscured', bRef]);
  assert.match(obscured.by, /Cookie banner/);
  page.state.hit = page.doc.getElementById('a');
  page.doc.getElementById('a').setAttribute('href', 'https://evil.example/');
  assert.deepEqual(page.run('verify', { ref: aRef, fingerprint: a.fingerprint }), { status: 'changed', ref: aRef });
  page.doc.getElementById('b').remove();
  assert.deepEqual(page.run('verify', { ref: bRef, fingerprint: b.fingerprint }), { status: 'stale', ref: bRef });
  const far = makePage('<body><button id="far" data-top="3000">Far away</button></body>');
  const farFacts = probeRef(far, fullRead(far), /Far away/);
  far.state.hitFn = () => far.doc.getElementById('far');
  const farRes = far.run('verify', { ref: farFacts.ref, fingerprint: farFacts.fingerprint });
  assert.deepEqual([farRes.status, far.state.intoView, farRes.rect.y >= 0 && farRes.rect.y < 900], ['ready', 1, true]);
});

test('focusForTyping focuses and optionally selects existing content', () => {
  const page = makePage(`<body><input id="i" aria-label="Name" value="hello world"><textarea id="t" aria-label="Memo">some memo</textarea>
    <div id="ce" contenteditable="true" tabindex="0" aria-label="Rich">rich text here</div>
    <input aria-label="Locked" readonly value="x"><button>Plain</button></body>`);
  const res = fullRead(page);
  const input = page.doc.getElementById('i');
  const refs = new Map();
  const focus = (pattern, clear, fingerprint) => {
    if (!refs.has(pattern)) refs.set(pattern, probeRef(page, res, pattern));
    const facts = refs.get(pattern);
    return page.run('focusForTyping', { ref: facts.ref, fingerprint: fingerprint || facts.fingerprint, clear });
  };
  assert.deepEqual(focus(/"Name"/, true), { status: 'ready' });
  assert.equal(page.doc.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 11]);
  input.setSelectionRange(3, 3);
  assert.equal(focus(/"Name"/, false).status, 'ready');
  assert.equal(input.selectionStart, 3);
  assert.equal(focus(/"Memo"/, true).status, 'ready');
  const ta = page.doc.getElementById('t');
  assert.equal(ta.selectionEnd - ta.selectionStart, 'some memo'.length);
  assert.equal(probeRef(page, res, /"Rich"/).isEditable, true);
  assert.equal(focus(/"Rich"/, true).status, 'ready');
  assert.equal(page.window.getSelection().toString(), 'rich text here');
  assert.deepEqual([focus(/"Locked"/, false).status, focus(/"Plain"/, false).status, focus(/"Name"/, false, 'stale|print').status],
    ['not_editable', 'not_editable', 'changed']);
  input.remove();
  assert.equal(focus(/"Name"/, false, 'whatever').status, 'stale');
});

test('probeFocused returns the focused element facts, a ref when needed, or none', () => {
  const page = makePage('<body><input id="i" aria-label="Focus me"><p>x</p></body>');
  assert.deepEqual(page.run('probeFocused', {}), { status: 'none' });
  page.doc.getElementById('i').focus();
  const facts = page.run('probeFocused', {});
  assert.deepEqual([facts.status, facts.name, page.run('probeFocused', {}).ref], ['ready', 'Focus me', facts.ref]);
  assert.match(facts.ref, /^r\d+$/);
  assert.equal(page.run('probe', { ref: facts.ref }).fingerprint, facts.fingerprint);
});

test('select picks an option by value or label and fires input and change', () => {
  const page = makePage(`<body><select id="s" aria-label="Country"><option value="">Choose</option><option value="us">United States</option>
    <option value="ca">Canada</option><option value="mx" disabled>Mexico</option></select></body>`);
  const sel = page.doc.getElementById('s');
  const events = [];
  sel.addEventListener('input', (e) => events.push(`input:${e.bubbles}`));
  sel.addEventListener('change', () => events.push('change'));
  const { ref, fingerprint } = probeRef(page, fullRead(page), /Country/);
  const pick = (value) => page.run('select', { ref, fingerprint, value });
  assert.deepEqual(pick('ca'), { status: 'selected', value: 'ca' });
  assert.deepEqual([sel.value, events], ['ca', ['input:true', 'change']]);
  assert.deepEqual(pick('United States'), { status: 'selected', value: 'us' });
  assert.equal(pick('').status, 'no_such_option');
  assert.equal(sel.value, 'us');
  const missing = pick('Narnia');
  assert.equal(missing.status, 'no_such_option');
  assert.ok(missing.options.includes('Canada'));
  assert.equal(pick('Mexico').status, 'no_such_option');
  assert.equal(page.run('select', { ref, fingerprint: 'other', value: 'ca' }).status, 'changed');
});

test('select toggles checkboxes and radios with true and false', () => {
  const page = makePage(`<body><input type="checkbox" id="c" aria-label="Agree"><input type="radio" name="g" id="r1" aria-label="One">
    <input type="radio" name="g" id="r2" aria-label="Two" checked><input type="checkbox" aria-label="Dis" disabled><button>Btn</button></body>`);
  const res = fullRead(page);
  let changes = 0;
  page.doc.getElementById('c').addEventListener('change', () => { changes += 1; });
  const set = (pattern, value) => {
    const facts = probeRef(page, res, pattern);
    return page.run('select', { ref: facts.ref, fingerprint: facts.fingerprint, value });
  };
  const checked = (id) => page.doc.getElementById(id).checked;
  for (const [value, now, count] of [['true', true, 1], ['true', true, 1], ['false', false, 2]]) {
    assert.deepEqual(set(/Agree/, value), { status: 'selected', value });
    assert.deepEqual([checked('c'), changes], [now, count]);
  }
  assert.equal(set(/Agree/, 'maybe').status, 'no_such_option');
  assert.equal(set(/"One"/, 'true').status, 'selected');
  assert.deepEqual([checked('r1'), checked('r2')], [true, false]);
  for (const [pattern, value] of [[/"One"/, 'false'], [/Dis/, 'true'], [/Btn/, 'x']]) assert.equal(set(pattern, value).status, 'not_selectable');
});

test('scroll moves the window by 85 percent of the viewport and reports the end', () => {
  const page = makePage('<body><p data-top="0">top text</p><p data-top="1000">middle text</p></body>');
  assert.deepEqual(page.run('scroll', { direction: 'down' }), { status: 'scrolled', moved: 765, atEnd: false });
  assert.equal(page.state.scrollY, 765);
  const view = page.run('read', { scope: 'viewport' });
  assert.match(view.text, /^Showing 765-1665 px of 4200 px\./m);
  assert.ok(view.text.includes('middle text') && !view.text.includes('top text'));
  assert.deepEqual(page.run('scroll', { direction: 'up' }), { status: 'scrolled', moved: 765, atEnd: true });
  page.state.scrollY = 3300;
  assert.deepEqual(page.run('scroll', { direction: 'down' }), { status: 'scrolled', moved: 0, atEnd: true });
});

test('scroll with a ref moves the nearest scrollable ancestor', () => {
  const page = makePage('<body><div id="pane" style="overflow-y:auto"><button>Inside</button></div></body>');
  const pane = page.doc.getElementById('pane');
  let top = 0;
  Object.defineProperties(pane, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 1000 },
    scrollTop: { get: () => top, set: (v) => { top = Math.max(0, Math.min(800, v)); } },
  });
  const ref = refOf(fullRead(page), /Inside/);
  assert.deepEqual(page.run('scroll', { direction: 'down', ref }), { status: 'scrolled', moved: 170, atEnd: false });
  assert.deepEqual([top, page.state.scrollY], [170, 0]);
  top = 700;
  assert.deepEqual(page.run('scroll', { direction: 'down', ref }), { status: 'scrolled', moved: 100, atEnd: true });
});

test('status reports readyState, url and time since the last mutation', async () => {
  const page = makePage('<body><p>x</p></body>');
  const first = page.run('status', {});
  assert.deepEqual([first.status, typeof first.readyState, first.url], ['ok', 'string', 'https://example.com/page']);
  assert.ok(first.msSinceMutation >= 0);
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.ok(page.run('status', {}).msSinceMutation >= 60);
  page.doc.body.appendChild(page.doc.createElement('span'));
  assert.ok(page.run('status', {}).msSinceMutation < 60);
});

test('secretMask injects one style element and removes it again', () => {
  const page = makePage(`<body><input type="password" value="${SECRET}"><input autocomplete="cc-number" value="4111">
    <input aria-label="Name" value="alice"><div contenteditable="true" aria-label="PIN">1234</div></body>`);
  const styles = () => [...page.doc.querySelectorAll('style')].filter((s) => /text-security/.test(s.textContent));
  const marked = () => [styles().length, page.doc.querySelectorAll('[data-jenny-reader-secret]').length];
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(page.run('secretMask', { on: true }), { status: 'ok', count: 3 });
    assert.deepEqual(marked(), [1, 3]);
  }
  assert.match(styles()[0].textContent, /transparent/);
  assert.equal(page.run('secretMask', { on: false }).status, 'ok');
  assert.deepEqual(marked(), [0, 0]);
});

test('buildReaderCall keeps hostile arguments as data and rejects unknown ops', () => {
  const page = makePage('<body><p>hello</p></body>');
  for (const op of ['frobnicate', 'constructor', '__proto__', 'toString']) assert.deepEqual(page.run(op, {}), { status: 'unknown_op' });
  const hostile = `"); window.__pwned = 1; //</script><script>window.__pwned = 2</script>${ch(0x2028)}'\`\${1+1}`;
  const code = buildReaderCall('find', { query: hostile, generation: 0 });
  assert.ok(!code.includes('</script>') && !code.includes(ch(0x2028)));
  assert.deepEqual(JSON.parse(JSON.stringify(page.window.eval(code))), { status: 'ok', total: 0, matches: [], fields: 0 });
  assert.deepEqual(page.run('"); window.__pwned = 3; ("', {}), { status: 'unknown_op' });
  assert.equal(page.window.__pwned, undefined);
  assert.equal(JSON.parse(JSON.stringify(page.window.eval(buildReaderCall('status')))).status, 'ok');
});

test('without any layout engine the reader falls back instead of throwing', () => {
  const dom = new JSDOM('<body><p>plain text</p><button>Press</button></body>', { runScripts: 'outside-only', url: 'https://example.com/' });
  const call = (op, args) => JSON.parse(JSON.stringify(dom.window.eval(buildReaderCall(op, args))));
  const res = call('read', { scope: 'viewport' });
  assert.ok(res.status === 'ok' && res.text.includes('plain text') && /button "Press"/.test(res.text));
  const found = call('find', { query: 'press' });
  assert.equal(found.total, 1);
  const { ref, fingerprint } = call('probe', { ref: found.matches[0].ref });
  assert.equal(call('verify', { ref, fingerprint }).status, 'ready');
});
