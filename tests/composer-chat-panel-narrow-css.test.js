const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* Static contract over styles/chat-composer-shell-v2.css. The composer Tools
 * panel opens from the chip's start edge at up to 384 px wide; in a narrow
 * composer (700 px window with the Chats sidebar, a split pane, the IDE dock)
 * that ran past the window edge (2026-11-03 pre-screen: 715 px in a 700 px
 * viewport, "Tool settings" cut off). The composer is a size container, and
 * below the threshold the panel spans the composer instead of the chip. */
const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-composer-shell-v2.css'), 'utf8');

function blockAfter(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${header}`);
}

test('the composer box is an inline-size container named composer', () => {
  const rule = blockAfter(css, '.composer {');
  assert.match(rule, /container-type:\s*inline-size;/);
  assert.match(rule, /container-name:\s*composer;/);
});

test('the Tools list shrinks on a short window so the panel stays below the app header', () => {
  // 2026-11-08 pre-screen: at 700 x 818 CSS px with a taller composer, the 440 px
  // list pushed the panel under the header and hid its title and tally.
  const rule = blockAfter(css, '.composer-chat-list {');
  assert.match(rule, /max-height:\s*min\(56vh,\s*440px,\s*max\(200px,\s*calc\(100vh - 500px\)\)\);/);
});

test('a narrow composer anchors the Tools panel to the composer, not the chip', () => {
  const query = blockAfter(css, '@container composer (max-width: 480px)');
  // The id selector beats the base `#composerToolToggleSlot { position: relative }`.
  assert.match(query, /:is\(#composerToolToggleSlot, \.composer-toggle-slot\)\s*{\s*position:\s*static;\s*}/);
  assert.match(query, /\.composer-chat-panel\s*{[^}]*inset-inline:\s*0;[^}]*width:\s*auto;[^}]*}/);
});
