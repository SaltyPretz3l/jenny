// new-test-file: a new surface (renderer/inventory/note-markup.js, the Markdown subset of a board note, row 150 slice B12).
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const markup = require('../renderer/inventory/note-markup');

const { document } = new JSDOM('<!doctype html><html><body></body></html>').window;

function html(text) {
  const holder = document.createElement('div');
  holder.appendChild(markup.render(document, text));
  return holder.innerHTML;
}
function holderOf(text) {
  const holder = document.createElement('div');
  holder.appendChild(markup.render(document, text));
  return holder;
}
const link = (href, inner) => `<a class="inv-note-link" href="${href}" target="_blank" rel="noopener noreferrer" tabindex="-1" title="${href}" data-note-link="">${inner}</a>`;

const ALLOWED = { STRONG: [], EM: [], CODE: ['class'], A: ['class', 'href', 'target', 'rel', 'tabindex', 'title', 'data-note-link'], UL: ['class'], OL: ['class', 'start'], LI: ['data-depth'] };

// What must hold for anything a note says: a closed set of elements and attributes, and links that open the web only.
function assertSafe(text) {
  const holder = holderOf(text);
  for (const el of holder.querySelectorAll('*')) {
    const allowed = ALLOWED[el.tagName];
    assert.ok(allowed, `element ${el.tagName} from ${JSON.stringify(text).slice(0, 80)}`);
    for (const attr of el.getAttributeNames()) assert.ok(allowed.includes(attr), `attribute ${attr} on ${el.tagName} from ${JSON.stringify(text).slice(0, 80)}`);
    if (el.tagName === 'A') {
      const href = el.getAttribute('href');
      assert.match(href, /^https?:\/\/[^\s]+$/, 'a link opens the web only');
      assert.equal(markup.safeHref(href), href, 'the address is the parsed one');
      assert.equal(el.getAttribute('title'), href, 'the tooltip is what opens');
      assert.equal(el.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(el.getAttribute('target'), '_blank');
      const parsed = new URL(href);
      assert.ok(!parsed.username && !parsed.password);
    }
  }
  return holder;
}

test('a note with no marks is one text node, character for character', () => {
  for (const text of ['Plain words', 'two\nlines', 'a\n\n\nb\n', '  indented\ttab', 'snake_case_name and __init__', '2*3*4 = 24', 'a * b * c', 'C:\\Users\\my_folder\\x', '5 - 3', '-no space', '1.5 is a number', '']) {
    const holder = holderOf(text);
    assert.equal(holder.children.length, 0, JSON.stringify(text));
    assert.equal(holder.textContent, text);
    assert.equal(holder.childNodes.length, text ? 1 : 0);
    assert.equal(markup.plain(text), text);
  }
});

test('bold, italics, code and their nesting', () => {
  assert.equal(html('**bold** and *it* and _it_'), '<strong>bold</strong> and <em>it</em> and <em>it</em>');
  assert.equal(html('***both***'), '<strong><em>both</em></strong>');
  assert.equal(html('*a **b** c*'), '<em>a <strong>b</strong> c</em>');
  assert.equal(html('**a `b*c*` d**'), '<strong>a <code class="inv-note-code">b*c*</code> d</strong>');
  assert.equal(html('`**not bold** <b>`'), '<code class="inv-note-code">**not bold** &lt;b&gt;</code>');
  assert.equal(html('(*x*), "**y**".'), '(<em>x</em>), "<strong>y</strong>".');
  // What is not a mark stays as written.
  for (const text of ['**open', '*open', '** spaced **', 'in*word*s', 'a_b_c', '``', '`', '**', '****', '*', '_', 'x**y**z']) assert.equal(html(text), text, text);
  assert.equal(html('*one\ntwo*'), '*one\ntwo*', 'a mark never reaches across a line');
  assert.equal(html('**a\nb**'), '**a\nb**');
});

test('nesting stops at three levels and a very long text is drawn plain', () => {
  const deep = '*a **b _c *d* c_ b** a*';
  const holder = assertSafe(deep);
  let depth = 0;
  for (let el = holder.querySelector('em, strong'); el; el = el.querySelector('em, strong')) depth += 1;
  assert.equal(depth, 3);
  assert.equal(holder.textContent, '*a b c d c b a*', 'the fourth level, the outermost, stays as written');
  const long = `**bold** ${'x'.repeat(markup.MAX_CHARS)}`;
  assert.equal(holderOf(long).children.length, 0);
  assert.equal(holderOf(long).textContent, long);
  // Many openers with no closer: the work stays small (this returns at once or the test times out).
  const soup = '*a '.repeat(1300) + '[x]('.repeat(40);
  assert.equal(holderOf(soup).textContent, soup);
});

test('links: a label with a web address, and a bare web address', () => {
  assert.equal(html('see [the spec](https://example.org/spec?a=1&b=2#top).'), `see ${link('https://example.org/spec?a=1&amp;b=2#top', 'the spec')}.`);
  assert.equal(html('[**bold** label](http://example.org)'), link('http://example.org/', '<strong>bold</strong> label'));
  assert.equal(html('Read https://example.org/a_b/c, then stop.'), `Read ${link('https://example.org/a_b/c', 'https://example.org/a_b/c')}, then stop.`);
  assert.equal(html('(https://example.org/x)'), `(${link('https://example.org/x', 'https://example.org/x')})`);
  assert.equal(html('[HTTPS://EXAMPLE.ORG/Path](HTTPS://EXAMPLE.ORG/Path)'), link('https://example.org/Path', 'HTTPS://EXAMPLE.ORG/Path'), 'the label is shown as text, not opened');
  // Not links: no nesting, no address inside a word, no empty label.
  assert.equal(html('xhttps://example.org'), 'xhttps://example.org');
  assert.equal(html('[](https://example.org)').startsWith('[]('), true);
  assert.equal(holderOf('[a [b](https://example.org/1)](https://example.org/2)').querySelectorAll('a a').length, 0);
});

test('an address that is not plain http or https is never a link', () => {
  const ctl = String.fromCharCode(1);
  const sep = String.fromCharCode(0x2028);
  const refused = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
    'file:///C:/Windows/system32/calc.exe', 'jenny-sketch://frame/x', 'app://x', 'ms-settings:appsfeatures', 'mailto:a@example.org', '//evil.example/x',
    '/relative', 'index.html', '#top', 'https://', 'https:evil.example', 'https://user:pw@evil.example/', 'https://user@evil.example/',
    'https://exa mple.org', `https://example.org/${ctl}`, `https://example.org/${sep}`, `http://${'a'.repeat(2100)}.example`,
  ];
  for (const address of refused) {
    assert.equal(markup.safeHref(address), '', address);
    const text = `before [label](${address}) after`;
    const holder = assertSafe(text);
    assert.equal([...holder.querySelectorAll('a')].some((a) => a.textContent.includes('label')), false, `${address}: the label is no link`);
    assert.equal(holder.textContent, text, 'and the text stays as written');
  }
  // An address too long to check is no link at all, not a link to its first part.
  assert.equal(holderOf(`see http://${'a'.repeat(2100)}.example now`).querySelectorAll('a').length, 0);
  assert.equal(holderOf('[x](https://exa mple.org)').querySelector('a').getAttribute('href'), 'https://exa/', 'a bare address ends at a space and shows what it opens');
  // A quote in an address is carried as an attribute value, never as markup.
  const quoted = assertSafe('[x](https://example.org/?q="><img/src=x/onerror=alert(1)>) and https://example.org/"onmouseover="alert(1)');
  assert.equal(quoted.querySelectorAll('img').length, 0);
  assert.equal(quoted.querySelectorAll('a').length, 2);
  assert.equal(quoted.querySelectorAll('[onmouseover], [onerror]').length, 0);
});

test('markup in a note is text: no element, attribute or script comes from what a note says', () => {
  const hostile = [
    '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '**<b onclick="alert(1)">x</b>**', '*<svg/onload=alert(1)>*',
    '`<iframe src="https://evil.example">`', '- <a href="javascript:alert(1)">x</a>', '1. <style>*{display:none}</style>',
    '[<img src=x onerror=alert(1)>](https://example.org)', '[x](https://example.org "title" onclick=alert(1))', '&lt;script&gt;', '<!-- --><math><mtext></mtext></math>',
    '![alt](https://example.org/pixel.png)', '<a href="https://example.org" target="_top">x</a>', '# heading', '> quote', '| a | b |', '~~strike~~', '<details open ontoggle=alert(1)>',
  ];
  for (const text of hostile) {
    const holder = assertSafe(text);
    assert.equal(holder.querySelectorAll('img, script, iframe, svg, style, b, math, details, h1, blockquote, table, del').length, 0, text);
    for (const piece of ['<', '>'].filter((ch) => text.includes(ch))) assert.equal(holder.textContent.includes(piece), true, `${text}: ${piece} is shown as a character`);
  }
  assert.equal(holderOf('![alt](https://example.org/pixel.png)').querySelectorAll('a').length <= 1, true, 'a picture mark is at most a link, never a picture');
});

test('any soup of marks stays inside the closed set (seeded)', () => {
  const pieces = ['*', '**', '_', '`', '[', ']', '(', ')', 'https://example.org/a', 'javascript:alert(1)', '<img src=x onerror=1>', ' ', '\n', '- ', '1. ', 'word', '"', "'", '<', '>', '&', '\t', '  '];
  let seed = 150;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let round = 0; round < 400; round += 1) {
    let text = '';
    for (let n = 0; n < 1 + (next() % 24); n += 1) text += pieces[next() % pieces.length];
    const holder = assertSafe(text);
    assert.equal(markup.plain(text).length <= text.length, true, 'nothing is added');
    assert.equal(typeof holder.textContent, 'string');
  }
});

test('lists: bullets, numbers, a start number, indent levels, and the lines around them', () => {
  assert.equal(html('- one\n- **two**\n* three\n+ four'), '<ul class="inv-note-list"><li>one</li><li><strong>two</strong></li><li>three</li><li>four</li></ul>');
  assert.equal(html('3. c\n4) d'), '<ol class="inv-note-list" start="3"><li>c</li><li>d</li></ol>');
  assert.equal(html('1. a\n2. b'), '<ol class="inv-note-list"><li>a</li><li>b</li></ol>');
  assert.equal(html('- a\n  - b\n    - c\n      - d'), '<ul class="inv-note-list"><li>a</li><li data-depth="1">b</li><li data-depth="2">c</li><li data-depth="2">d</li></ul>');
  assert.equal(html('- a\n1. b'), '<ul class="inv-note-list"><li>a</li></ul><ol class="inv-note-list"><li>b</li></ol>');
  // The break between a line and a list belongs to the list; a blank line the person left is kept.
  assert.equal(html('Todo:\n- a\nafter'), 'Todo:<ul class="inv-note-list"><li>a</li></ul>after');
  assert.equal(html('Todo:\n\n- a\n\nafter'), 'Todo:\n\n<ul class="inv-note-list"><li>a</li></ul>\nafter');
  // Not lists.
  for (const text of ['-', '- ', '-a', '1.', '1.a', '12345678901. a', '**bold** first', '*it* first']) assert.equal(holderOf(text).querySelectorAll('ul, ol').length, 0, text);
});

test('plain() is the note without its marks, line for line', () => {
  assert.equal(markup.plain('**Risks**\n- *token* theft\n- see [the spec](https://example.org)\n`code` end'), 'Risks\ntoken theft\nsee the spec\ncode end');
  assert.equal(markup.plain('https://example.org/x.'), 'https://example.org/x.');
  assert.equal(markup.plain(null), '');
  assert.deepEqual(markup.parse(undefined), [{ type: 'text', lines: [[]] }]);
});
