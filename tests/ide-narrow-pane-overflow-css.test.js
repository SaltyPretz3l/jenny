'use strict';

// Squeezing the Workspace editor column by widening the chat dock (or the
// dock itself by narrowing it) must not let content escape its column:
// - the PDF/DOCX/image toolbars wrapped only on a narrow WINDOW, so in a narrow
//   editor column they painted over the chat dock;
// - the user bubble's row list took the ~400px min-content of its nowrap
//   hover-row meta, overflowed the capped article and was clipped on the left.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function readStyle(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'styles', name), 'utf8');
}

function getRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Every top-level rule whose selector list ends with `selector`, joined.
  const bodies = Array.from(css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g')), (m) => m[1]);
  assert.ok(bodies.length > 0, `missing ${selector} rule`);
  return bodies.join('\n');
}

test('document panes clip to the editor column', () => {
  const panes = [
    ['ide-pdf-pane.css', '.ide-pdf-pane'],
    ['ide-docx-pane.css', '.ide-docx-pane'],
    ['ide-chrome.css', '.ide-image-pane'],
  ];
  for (const [file, selector] of panes) {
    assert.match(getRuleBody(readStyle(file), selector), /overflow:\s*hidden;/, `${selector} must clip`);
  }
});

test('PDF and DOCX toolbars wrap by pane width, not window width', () => {
  const pdf = readStyle('ide-pdf-pane.css');
  assert.match(getRuleBody(pdf, '.ide-pdf-pane'), /container:\s*ide-pdf\s*\/\s*inline-size;/);
  assert.match(getRuleBody(pdf, '.ide-pdf-toolbar-row'), /flex-wrap:\s*wrap;/);
  assert.match(pdf, /@container ide-pdf \(max-width: 900px\)/);
  assert.doesNotMatch(pdf, /@media[^{]*max-width/, 'a viewport query misses a dock-squeezed pane');
  assert.match(getRuleBody(pdf, '.ide-pdf-note'), /min-width:\s*0;/);

  assert.match(getRuleBody(readStyle('ide-docx-pane.css'), '.ide-docx-toolbar'), /flex-wrap:\s*wrap;/);
  assert.match(getRuleBody(readStyle('ide-chrome.css'), '.ide-image-meta'), /min-width:\s*0;/);
});

test('every child of a rendered user article is capped to the article width', async (t) => {
  const css = readStyle('chat-thread.css');
  const guard = css.match(/((?:\.chat-entry\.user > [\w.-]+,?\s*)+)\{\s*max-width:\s*100%;\s*\}/);
  assert.ok(guard, 'missing the user-article child max-width guard');
  const guardedClasses = guard[1].split(',').map((part) => part.trim().replace('.chat-entry.user > .', ''));

  const app = await loadRendererApp();
  t.after(async () => {
    await app.dispose();
  });
  const { window } = app;
  const input = window.document.getElementById('chatInput');
  input.value = 'x C4 update check: reply with the single word ok.';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 30);

  const article = window.document.querySelector('#chatTimeline .chat-entry.user');
  assert.ok(article, 'user article rendered');
  const children = Array.from(article.children);
  assert.ok(children.length > 0);
  for (const child of children) {
    assert.ok(
      guardedClasses.some((name) => child.classList.contains(name)),
      `unguarded user-article child .${Array.from(child.classList).join('.')} can spill left of a narrow transcript`
    );
  }
});
