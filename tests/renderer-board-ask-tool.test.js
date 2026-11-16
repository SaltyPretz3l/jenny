'use strict';

// new-test-file: a new surface (row 150 slice C5): the "Ask Jenny" toolbar tool, a helper part of the card kinds seam
// (renderer/features/board/board-ask-tool.js); it names no card kind and draws nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const cardKinds = require('../renderer/features/board/board-card-kinds');
const { createAskPart } = require('../renderer/features/board/board-ask-tool');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function context({ selection = [uid(1)], cards = [uid(1), uid(2)], openChat } = {}) {
  const told = [];
  const opened = [];
  const ctx = {
    editor: { getSelection: () => selection.slice(), getBoard: () => ({ id: 'board_x', cards: Object.fromEntries(cards.map((id) => [id, { id }])) }) },
    notify: (message, extra) => told.push([message, extra]),
    context: { openChat: openChat === undefined ? () => { opened.push('chat'); return true; } : openChat },
  };
  return { ctx, told, opened };
}

test('one tool, Ask Jenny, after the others on the toolbar', () => {
  const part = createAskPart(context().ctx);
  assert.equal(part.kind, undefined, 'a helper part: it names no kind');
  assert.deepEqual(part.tools.map(({ id, label, title, order }) => ({ id, label, title, order })),
    [{ id: 'ask', label: 'Ask Jenny', title: 'Ask Jenny about the selected cards', order: 70 }]);
});

test('with cards selected, running it opens the docked chat once and says nothing', async () => {
  const { ctx, told, opened } = context({ selection: [uid(1), uid(2)] });
  await createAskPart(ctx).tools[0].run();
  assert.deepEqual([opened, told], [['chat'], []]);
});

test('with nothing selected, or only cards that are gone, it says to select first and opens nothing', async () => {
  for (const selection of [[], [uid(9)]]) {
    const { ctx, told, opened } = context({ selection });
    await createAskPart(ctx).tools[0].run();
    assert.deepEqual(opened, []);
    assert.equal(told.length, 1);
    assert.equal(told[0][0], 'Select one or more cards first');
  }
});

test('a page whose chat dock could not be built says so rather than failing silently', async () => {
  for (const openChat of [() => false, null]) {
    const { ctx, told } = context({ openChat });
    await createAskPart(ctx).tools[0].run();
    assert.deepEqual(told.map(([message]) => message), ['The chat is not available here.']);
  }
  const noContext = { editor: context().ctx.editor, notify: () => {}, context: undefined };
  await assert.doesNotReject(async () => createAskPart(noContext).tools[0].run());
  assert.equal(createAskPart({}), null, 'no editor: no part');
});

test('through the card kinds seam it is one toolbar tool and a run reaches the page\'s hook', async () => {
  const { ctx, opened } = context();
  const kinds = cardKinds.createBoardCardKinds({ ...ctx, factories: new Map([['ask', createAskPart]]) });
  assert.deepEqual(kinds.tools().map((tool) => [tool.id, tool.order]), [['ask', 70]]);
  await kinds.tools()[0].run();
  assert.deepEqual(opened, ['chat']);
});

test('the module registers itself with the seam when it loads where the seam exists', () => {
  const registered = [];
  const saved = globalThis.rendererBoardCardKinds;
  const path = require.resolve('../renderer/features/board/board-ask-tool');
  globalThis.rendererBoardCardKinds = { register: (name, factory) => registered.push([name, typeof factory]) };
  try {
    delete require.cache[path];
    require(path);
  } finally {
    if (saved === undefined) delete globalThis.rendererBoardCardKinds; else globalThis.rendererBoardCardKinds = saved;
    delete require.cache[path];
  }
  assert.deepEqual(registered, [['ask', 'function']]);
});
