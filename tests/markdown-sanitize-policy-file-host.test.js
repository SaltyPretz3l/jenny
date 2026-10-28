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
