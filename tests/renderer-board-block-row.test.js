'use strict';

// new-test-file: a new surface (row 150 slice C3-R): the compact row a `board` code block becomes in a chat reply, and the
// loader's lazy load of it. Nothing else of the Board is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const row = require('../renderer/features/renderer-board-block-row');
const LOADER = '../renderer/features/renderer-mermaid-runtime-loader';

const BODY = 'note Decide token lifetime in g1\n\nn3 -> f2 blocks\n| a | table |\n  edit n3 New text\n';
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function codeBlock(body) {
  return `<div class="markdown-code-block inv-codeblock-wrap"><div class="markdown-code-header"><span>board</span><button type="button" class="inv-codeblock-copy">Copy</button></div><pre><code class="language-board"></code></pre></div>`.replace('<code class="language-board"></code>', `<code class="language-board">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`);
}

// A chat timeline: a user turn (stamped or not) and the reply that holds the block.
function timeline(t, { stamped = true, bodies = [BODY], dock = false, stampHtml = '' } = {}) {
  const stamp = stampHtml || (stamped ? '<span class="message-mark" data-message-mark="board">From a board</span>' : '');
  const dom = new JSDOM(`<!doctype html><body><div id="host"${dock ? ' data-board-chat-host' : ''}><div id="timeline">
    <article class="chat-entry" data-message-role="user"><div class="message-body">Rearrange</div>${stamp}</article>
    <article class="chat-entry" data-message-role="assistant"><div class="reply">${bodies.map(codeBlock).join('<p>between</p>')}</div></article>
  </div></div></body>`, { url: 'https://jenny.invalid/' });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  return { window: dom.window, doc, reply: doc.querySelector('.reply'), rows: () => [...doc.querySelectorAll('.board-block-row')], blocks: () => [...doc.querySelectorAll('.markdown-code-block')] };
}

test('the label counts the lines that are not blank and do not start with a pipe', () => {
  assert.equal(row.countLines(BODY), 3);
  assert.equal(row.countLines('one'), 1);
  assert.equal(row.countLines('\n  \n| x |\n   | y\n'), 0);
  assert.equal(row.countLines(''), 0);
  assert.equal(row.labelFor(3), 'Proposed 3 board changes');
  assert.equal(row.labelFor(1), 'Proposed 1 board change');
});

test('a board block in a reply to a turn sent from a board becomes one row; Show opens the code block under it', (t) => {
  const tl = timeline(t);
  assert.equal(row.render(tl.reply, { isStreaming: false }), 1);
  assert.equal(tl.rows().length, 1);
  const bar = tl.rows()[0];
  assert.equal(bar.querySelector('.board-block-row__label').textContent, 'Proposed 3 board changes');
  assert.equal(bar.querySelector('.board-block-row__dot').getAttribute('aria-hidden'), 'true');
  const [block] = tl.blocks();
  assert.equal(bar.nextElementSibling, block, 'the row stands right above the code block');
  assert.equal(block.hidden, true, 'closed at first');
  assert.equal(block.querySelector('code').textContent, BODY, 'the code block is kept as it was, so copy still works');
  const show = bar.querySelector('[data-board-row-act="show"]');
  assert.equal(show.textContent, 'Show');
  assert.equal(show.getAttribute('aria-expanded'), 'false');
  assert.equal(show.getAttribute('aria-controls'), block.id);
  show.click();
  assert.equal(block.hidden, false);
  assert.equal(show.getAttribute('aria-expanded'), 'true');
  assert.equal(show.textContent, 'Hide');
  show.click();
  assert.equal(block.hidden, true);
  assert.equal(show.getAttribute('aria-expanded'), 'false');
  assert.equal(tl.doc.querySelectorAll('code.language-board').length, 1, 'still in the page');
});

test('rendering again changes nothing', (t) => {
  const tl = timeline(t);
  row.render(tl.reply, {});
  tl.rows()[0].querySelector('[data-board-row-act="show"]').click();
  assert.equal(row.render(tl.reply, {}), 0);
  assert.equal(tl.rows().length, 1);
  assert.equal(tl.blocks()[0].hidden, false, 'an open block stays open');
});

test('a reply to a turn that was not sent from a board is left alone, so is an empty block', (t) => {
  const plain = timeline(t, { stamped: false });
  assert.equal(row.render(plain.reply, {}), 0);
  assert.equal(plain.rows().length, 0);
  assert.equal(plain.blocks()[0].hidden, false);
  const empty = timeline(t, { bodies: ['\n| only | a table |\n'] });
  assert.equal(row.render(empty.reply, {}), 0);
});

test('the board turn is read from the mark attribute, not from a styling class', (t) => {
  // The old pill class alone no longer counts: a restyle must not decide whether board replies collapse.
  const oldPill = timeline(t, { stampHtml: '<span class="message-skill-pill message-board-pill">Sent from a board</span>' });
  assert.equal(row.render(oldPill.reply, {}), 0);
  const skillOnly = timeline(t, { stampHtml: '<span class="message-mark" data-message-mark="skill">/one-shot</span>' });
  assert.equal(row.render(skillOnly.reply, {}), 0);
  const named = timeline(t, { stampHtml: '<button type="button" class="message-mark message-mark--link" data-message-mark="board" data-board-id="board_a">Login flow board</button>' });
  assert.equal(row.render(named.reply, {}), 1);
});

test('while the reply streams its last block is left alone, the earlier ones are not', (t) => {
  const tl = timeline(t, { bodies: [BODY, 'note Another'] });
  assert.equal(row.render(tl.reply, { isStreaming: true }), 1);
  assert.equal(tl.rows().length, 1);
  assert.equal(tl.blocks()[1].hidden, false);
  assert.equal(row.render(tl.reply, { isStreaming: false }), 1);
  assert.equal(tl.rows().length, 2);
  assert.equal(tl.rows()[1].querySelector('.board-block-row__label').textContent, 'Proposed 1 board change');
});

test('Review shows only where a Board page can reveal its Changes view, and asks for it', (t) => {
  const tl = timeline(t, { dock: true });
  const calls = [];
  const saved = globalThis.rendererBoardPage;
  t.after(() => { if (saved === undefined) delete globalThis.rendererBoardPage; else globalThis.rendererBoardPage = saved; });
  delete globalThis.rendererBoardPage;
  row.render(tl.reply, {});
  assert.equal(tl.rows()[0].querySelector('[data-board-row-act="review"]'), null, 'no page handle: no Review');
  const again = timeline(t, { dock: true });
  globalThis.rendererBoardPage = { revealChanges: () => { calls.push(1); return true; } };
  row.render(again.reply, {});
  const review = again.rows()[0].querySelector('[data-board-row-act="review"]');
  assert.equal(review.textContent, 'Review');
  review.click();
  assert.equal(calls.length, 1);
});

// ------------------------------------------------------------------ the loader

function freshLoader(t, scripts) {
  delete require.cache[require.resolve(LOADER)];
  const loader = require(LOADER);
  const saved = globalThis.scriptLoaderUtils;
  const savedRow = globalThis.rendererBoardBlockRow;
  delete globalThis.rendererBoardBlockRow;
  globalThis.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      scripts.push(src);
      if (src.endsWith('renderer-board-block-row.js')) globalThis.rendererBoardBlockRow = row;
      return Promise.resolve(Boolean(isReady()));
    },
  };
  t.after(() => {
    loader._resetForTests();
    if (saved === undefined) delete globalThis.scriptLoaderUtils; else globalThis.scriptLoaderUtils = saved;
    if (savedRow === undefined) delete globalThis.rendererBoardBlockRow; else globalThis.rendererBoardBlockRow = savedRow;
  });
  loader._resetForTests();
  return loader;
}

test('the loader loads the row module the first time a board block is found with project_boards on, and then draws it', async (t) => {
  const scripts = [];
  const loader = freshLoader(t, scripts);
  const tl = timeline(t);
  loader.setBoardBlocksEnabled(true);
  loader.renderSketchBlocks(tl.reply, { isStreaming: false });
  await flush();
  assert.deepEqual(scripts, ['renderer/features/renderer-board-block-row.js']);
  assert.equal(tl.rows().length, 1);
  loader.renderSketchBlocks(tl.reply, {});
  await flush();
  assert.equal(scripts.length, 1, 'loaded once');
  assert.equal(tl.rows().length, 1);
});

test('with the flag off, or with no board block, nothing loads and the block stays a code block', async (t) => {
  const scripts = [];
  const loader = freshLoader(t, scripts);
  const tl = timeline(t);
  loader.setBoardBlocksEnabled(false);
  loader.renderSketchBlocks(tl.reply, {});
  await flush();
  assert.deepEqual(scripts, []);
  assert.equal(tl.rows().length, 0);
  assert.equal(tl.blocks()[0].hidden, false);
  loader.setBoardBlocksEnabled(true);
  const none = new JSDOM('<div class="r"><pre><code class="language-js">x</code></pre></div>').window.document.querySelector('.r');
  loader.renderSketchBlocks(none, {});
  await flush();
  assert.deepEqual(scripts, []);
});

test('with no flag report yet, the Board tab being in the page says the flag is on', async (t) => {
  const scripts = [];
  const loader = freshLoader(t, scripts);
  const tl = timeline(t);
  loader.renderSketchBlocks(tl.reply, {});
  await flush();
  assert.deepEqual(scripts, [], 'no tab, no flag');
  tl.doc.body.insertAdjacentHTML('beforeend', '<button id="boardTopRailTab"></button>');
  loader.renderSketchBlocks(tl.reply, {});
  await flush();
  assert.equal(tl.rows().length, 1);
});

test('a row that a repaint of the reply dropped is made again: the block is never left hidden with nothing to open it', (t) => {
  const tl = timeline(t);
  row.render(tl.reply, {});
  // The chat repaints a reply by patching its nodes: the code block it knows is kept as it stands, the row it does not know goes.
  tl.rows()[0].remove();
  assert.equal(tl.blocks()[0].hidden, true);
  assert.equal(row.render(tl.reply, {}), 1);
  assert.equal(tl.rows().length, 1);
  assert.equal(tl.rows()[0].nextElementSibling, tl.blocks()[0]);
  assert.equal(tl.rows()[0].querySelector('[data-board-row-act="show"]').getAttribute('aria-expanded'), 'false');
  assert.equal(row.render(tl.reply, {}), 0, 'and once only');
});
