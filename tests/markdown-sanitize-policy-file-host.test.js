'use strict';

// Model-authored Markdown images render inside the app's file:// page. A
// protocol-relative or UNC-style source resolves to file://host/..., which
// Chromium on Windows fetches over SMB and leaks the user's NTLM hash, so the
// shared sanitizer policy (renderer/shared/markdown-sanitize-policy.js) drops
// any image source that could reach a file host.

const test = require('node:test');
const assert = require('node:assert/strict');

const markdown = require('../renderer/shared/markdown-utils');
const policy = require('../renderer/shared/markdown-sanitize-policy');

const B = '\\';

function imageSrc(input) {
  const html = markdown.renderMarkdown(input);
  assert.match(html, /<img\b/, `an <img> is still rendered for ${JSON.stringify(input)}`);
  const match = /<img\b[^>]*\ssrc="([^"]*)"/.exec(html);
  return match ? match[1] : null;
}

test('image sources that would reach a file host lose their src', () => {
  for (const input of [
    '![x](//203.0.113.7/share/x.png)',
    `![x](${B}${B}host${B}share${B}x.png)`,
    `![x](${B}${B}${B}${B}host${B}${B}share${B}${B}x.png)`,
    `![x](/${B}203.0.113.7/share/x.png)`,
    '![x](file://host/share/x.png)',
    '<img src="//203.0.113.7/share/x.png">',
    `<img src="${B}${B}203.0.113.7${B}share${B}x.png">`,
    '<img src=" \t//203.0.113.7/share/x.png">',
    '<img src="/%5C203.0.113.7/share/x.png">',
    '<img src="//attacker.example@SSL/dav/x.png">',
  ]) {
    assert.equal(imageSrc(input), null, `src dropped for ${JSON.stringify(input)}`);
  }
});

test('data:, relative, root-relative and https image sources keep their src', () => {
  assert.equal(imageSrc('![x](data:image/png;base64,AAAA)'), 'data:image/png;base64,AAAA');
  assert.equal(imageSrc('![x](images/x.png)'), 'images/x.png');
  assert.equal(imageSrc('![x](./images/x.png)'), './images/x.png');
  assert.equal(imageSrc('![x](/images/x.png)'), '/images/x.png');
  assert.equal(imageSrc('![x](https://example.com/x.png)'), 'https://example.com/x.png');
});

test('reachesFileHost classifies raw values the way the URL parser resolves them', () => {
  for (const value of [
    '//host/x.png', `${B}${B}host${B}x.png`, `/${B}host/x.png`, `${B}/host/x.png`, '%5C%5Chost/x.png',
    'file://host/share/x.png', 'file:////host/share/x.png', `file:${B}${B}host${B}x.png`, '\n//host/x.png', '  //host/x.png',
  ]) {
    assert.equal(policy.reachesFileHost(value), true, JSON.stringify(value));
  }
  for (const value of [
    'images/x.png', '/images/x.png', 'data:image/png;base64,AAAA', 'blob:file:///abc',
    'https://example.com/x.png', 'file:///C:/x.png', 'file://localhost/C:/x.png',
  ]) {
    assert.equal(policy.reachesFileHost(value), false, JSON.stringify(value));
  }
});

// Security review item 15: a link resolves against the same file:// page, so a
// protocol-relative, UNC-style or host-bearing file: href would open an SMB share
// on click. Such anchors keep their text and lose the href, like javascript: links.
function anchor(input) {
  const html = markdown.renderMarkdown(input);
  const match = /<a\b([^>]*)>([\s\S]*?)<\/a>/.exec(html);
  assert.ok(match, `an <a> is still rendered for ${JSON.stringify(input)}`);
  const href = /\shref="([^"]*)"/.exec(match[1]);
  return { href: href ? href[1] : null, text: match[2] };
}

test('link hrefs that would reach a file host are dropped and the text kept', () => {
  for (const input of [
    '[share](//203.0.113.7/share)',
    `[share](${B}${B}host${B}share)`,
    `<a href="${B}/host/share">share</a>`,
    `[share](/${B}host/share)`,
    '[share](file://host/share/x.txt)',
    '[share](file:////host/share/x.txt)',
    '<a href="//203.0.113.7/share">share</a>',
    `<a href="${B}${B}203.0.113.7${B}share">share</a>`,
    '<a href=" \t//203.0.113.7/share">share</a>',
    '<a href="/%5C203.0.113.7/share">share</a>',
  ]) {
    const result = anchor(input);
    assert.equal(result.href, null, `href dropped for ${JSON.stringify(input)}`);
    assert.equal(result.text, 'share', `text kept for ${JSON.stringify(input)}`);
  }
});

test('https, http, mailto, in-page and relative link hrefs are unchanged', () => {
  for (const [input, href] of [
    ['[x](https://example.com/a?b=1)', 'https://example.com/a?b=1'],
    ['[x](http://example.com/)', 'http://example.com/'],
    ['[x](mailto:someone@example.com)', 'mailto:someone@example.com'],
    ['[x](#section-2)', '#section-2'],
    ['[x](docs/readme.md)', 'docs/readme.md'],
    ['[x](./docs/readme.md)', './docs/readme.md'],
    ['[x](/docs/readme.md)', '/docs/readme.md'],
  ]) {
    assert.equal(anchor(input).href, href, JSON.stringify(input));
  }
});
