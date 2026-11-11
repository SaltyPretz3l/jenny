const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* Static contract over index.html's Content-Security-Policy. The IDE PDF
 * sidebar thumbnails (renderer-ide-pdf-thumbnails.js) and the IDE image
 * preview (renderer-ide-image-memory.js) hand <img> elements object URLs from
 * URL.createObjectURL, so img-src must allow blob:. Without it every thumbnail
 * was refused and the Pages sidebar showed bare page numbers (2026-11-03
 * pre-screen). The rest of the policy stays as strict as before. */
function readPolicy() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(meta, 'index.html declares a Content-Security-Policy meta tag');
  return new Map(meta[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...sources] = part.split(/\s+/);
    return [name, sources];
  }));
}

test('img-src allows blob: object URLs for PDF thumbnails and IDE image previews', () => {
  assert.deepEqual(readPolicy().get('img-src'), ["'self'", 'data:', 'file:', 'blob:']);
});

test('script, connect and object sources stay locked down', () => {
  const policy = readPolicy();
  assert.deepEqual(policy.get('script-src'), ["'self'"]);
  assert.deepEqual(policy.get('connect-src'), ["'self'"]);
  assert.deepEqual(policy.get('object-src'), ["'none'"]);
  assert.deepEqual(policy.get('default-src'), ["'self'"]);
});
