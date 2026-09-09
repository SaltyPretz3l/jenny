const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const textField = require('../renderer/inventory/text-field');
const { buildInlineUserMessageEditorMarkup } = require('../renderer/inventory/inline-text-editor');

const ROOT = path.join(__dirname, '..');

function rendererJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

test('RTL isolation and directional icon contracts are present', () => {
  const foundation = fs.readFileSync(path.join(ROOT, 'styles/foundation.css'), 'utf8');
  assert.match(
    foundation,
    /\[dir="rtl"\]\s+:is\([^}]+\)\s*\{[^}]*direction:\s*ltr;[^}]*unicode-bidi:\s*isolate;[^}]*text-align:\s*start;[^}]*\}/s
  );
  assert.match(
    foundation,
    /\[dir="rtl"\]\s+\.icon-mirror-rtl\s*\{[^}]*transform:\s*scaleX\(-1\);[^}]*\}/s
  );

  const markerCount = rendererJavaScriptFiles(path.join(ROOT, 'renderer'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .reduce((count, source) => count + (source.match(/icon-mirror-rtl/g) || []).length, 0);
  assert.ok(markerCount >= 5, `expected at least 5 RTL-mirrored icons, found ${markerCount}`);
});

test('the static chat textarea carries automatic direction', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="chatInput" dir="auto"/);
});

test('inventory text editors use automatic direction except for passwords', () => {
  assert.match(textField({ id: 'plain' }), /type="text" dir="auto"/);
  assert.match(textField({ id: 'multiline', multiline: true }), /<textarea[^>]* dir="auto"/);
  assert.doesNotMatch(textField({ id: 'secret', type: 'password' }), /dir="auto"/);
  assert.match(
    buildInlineUserMessageEditorMarkup({ messageId: 'message-1' }),
    /<textarea[^>]* dir="auto"/
  );
});
