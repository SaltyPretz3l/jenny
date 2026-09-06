const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  DEFAULT_SCROLL_FOLLOW_THRESHOLD,
  collectLogicalRows,
  createLogicalScrollAnchorRegistry,
  deriveFollowLatestFromScroll,
  getLatestUserMessageId,
  isNearBottom,
  shouldAutoScrollThread,
} = require('../renderer/chat/chat-scroll-utils');

function setRect(node, top, bottom = top + 40) {
  node.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top });
}

test('getLatestUserMessageId returns the latest visible user-authored message id', () => {
  const messages = [
    { id: 'assistant_1', role: 'assistant' },
    { id: 'user_1', role: 'user' },
    { id: 'assistant_2', role: 'assistant' },
    { id: 'user_2', role: 'user' },
  ];

  assert.equal(getLatestUserMessageId(messages), 'user_2');
  assert.equal(getLatestUserMessageId([{ id: 'assistant_3', role: 'assistant' }]), '');
});

test('deriveFollowLatestFromScroll pauses away from bottom and resumes near the bottom threshold', () => {
  assert.equal(
    deriveFollowLatestFromScroll({
      scrollTop: 120,
      scrollHeight: 1200,
      clientHeight: 600,
    }),
    false
  );

  assert.equal(
    deriveFollowLatestFromScroll({
      scrollTop: 552,
      scrollHeight: 1200,
      clientHeight: 600,
    }),
    true
  );
});

test('isNearBottom respects the composer-aware bottom threshold boundary', () => {
  assert.equal(
    isNearBottom(
      {
        scrollTop: 352,
        scrollHeight: 1000,
        clientHeight: 600,
      },
      48
    ),
    true
  );

  assert.equal(
    isNearBottom(
      {
        scrollTop: 351,
        scrollHeight: 1000,
        clientHeight: 600,
      },
      48
    ),
    false
  );

  assert.equal(DEFAULT_SCROLL_FOLLOW_THRESHOLD, 48);
});

test('shouldAutoScrollThread requires follow mode unless forced', () => {
  assert.equal(
    shouldAutoScrollThread({
      forceBottom: false,
      followLatest: true,
      thinkingAutoScroll: true,
    }),
    true
  );

  assert.equal(
    shouldAutoScrollThread({
      forceBottom: false,
      followLatest: false,
      thinkingAutoScroll: true,
    }),
    false
  );

  assert.equal(
    shouldAutoScrollThread({
      forceBottom: false,
      followLatest: true,
      thinkingAutoScroll: false,
    }),
    false
  );

  assert.equal(
    shouldAutoScrollThread({
      forceBottom: true,
      followLatest: false,
      thinkingAutoScroll: false,
    }),
    true
  );
});

test('logical anchor restores the same row and viewport offset after reflow', () => {
  const dom = new JSDOM('<!doctype html><body><div id="scroll"><div data-row-id="r1"></div><div data-row-id="r2"></div></div></body>');
  const scroll = dom.window.document.getElementById('scroll');
  const [row1, row2] = scroll.children;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  setRect(scroll, 0, 400);
  setRect(row1, -20, 20);
  setRect(row2, 20, 60);
  scroll.scrollTop = 500;
  const registry = createLogicalScrollAnchorRegistry();

  assert.equal(registry.capture('session-1\x1fchat', scroll), true);
  scroll.scrollTop = 200;
  setRect(row1, 80, 120);

  assert.equal(registry.restore('session-1\x1fchat', scroll), 'logical');
  assert.equal(scroll.scrollTop, 300, 'row returns to its captured -20px viewport offset');
});

test('entry-preferred anchors use logarithmic geometry reads and retain the captured node', () => {
  const rowCount = 5000;
  const dom = new JSDOM('<!doctype html><body><div id="scroll"><div id="timeline"></div></div></body>');
  const scroll = dom.window.document.getElementById('scroll');
  const timeline = dom.window.document.getElementById('timeline');
  const fragment = dom.window.document.createDocumentFragment();
  let geometryReads = 0;
  for (let index = 0; index < rowCount; index += 1) {
    const entry = dom.window.document.createElement('article');
    entry.className = 'chat-entry';
    entry.dataset.messageId = `m-${index}`;
    entry.getBoundingClientRect = () => {
      geometryReads += 1;
      const top = index * 40 - scroll.scrollTop;
      return { top, bottom: top + 40, height: 40, left: 0, right: 600, width: 600 };
    };
    fragment.appendChild(entry);
  }
  timeline.appendChild(fragment);
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: rowCount * 40 },
    clientHeight: { configurable: true, value: 400 },
  });
  setRect(scroll, 0, 400);
  scroll.scrollTop = 100000;
  const registry = createLogicalScrollAnchorRegistry({ preferEntries: true });

  assert.equal(registry.capture('reader', scroll, timeline), true);
  assert.ok(geometryReads <= 16, `binary capture used ${geometryReads} geometry reads`);
  const readsAfterCapture = geometryReads;
  scroll.scrollTop = 0;
  assert.equal(registry.restore('reader', scroll, timeline), 'logical');
  assert.equal(geometryReads, readsAfterCapture + 1, 'restore measures only the retained target');
  assert.equal(scroll.scrollTop, 100000);
});

test('logical anchor falls back to the nearest row, raw scroll, and near-bottom intent', () => {
  const dom = new JSDOM('<!doctype html><body><div id="scroll"><div data-row-id="r1"></div><div data-row-id="r2"></div></div></body>');
  const scroll = dom.window.document.getElementById('scroll');
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  setRect(scroll, 0, 200);
  setRect(scroll.children[0], -10, 30);
  setRect(scroll.children[1], 30, 70);
  const registry = createLogicalScrollAnchorRegistry({ cap: 2 });
  scroll.scrollTop = 300;
  registry.capture('nearest', scroll);

  scroll.children[0].remove();
  setRect(scroll.children[0], 50, 90);
  scroll.scrollTop = 100;
  assert.equal(registry.restore('nearest', scroll), 'nearest');
  assert.equal(scroll.scrollTop, 160);

  scroll.innerHTML = '';
  scroll.scrollTop = 10;
  assert.equal(registry.restore('nearest', scroll), 'raw');
  assert.equal(scroll.scrollTop, 300);

  scroll.innerHTML = '<div data-row-id="tail"></div>';
  setRect(scroll.children[0], 160, 200);
  scroll.scrollTop = 780;
  registry.capture('bottom', scroll);
  scroll.scrollTop = 0;
  assert.equal(registry.restore('bottom', scroll), 'near_bottom');
  assert.equal(scroll.scrollTop, 800);

  registry.capture('evicts-oldest', scroll);
  assert.equal(registry.size(), 2);
  assert.equal(registry.restore('nearest', scroll), 'missing');
  registry.dispose();
  assert.equal(registry.size(), 0);
  assert.equal(registry.restore('bottom', scroll), 'unavailable');
});

test('missing virtualized row restores through its parent message instead of an unrelated nearest row', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="scroll">
    <article class="chat-entry" data-message-id="m1"><div data-row-id="r1"></div></article>
    <article class="chat-entry" data-message-id="m2"><div data-row-id="r2"></div></article>
  </div></body>`);
  const scroll = dom.window.document.getElementById('scroll');
  const [message1, message2] = scroll.children;
  const row1 = message1.firstElementChild;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  setRect(scroll, 0, 400);
  setRect(message1, -30, 30);
  setRect(row1, -20, 20);
  setRect(message2, 40, 100);
  scroll.scrollTop = 500;
  const registry = createLogicalScrollAnchorRegistry();
  registry.capture('reader', scroll);

  message1.innerHTML = '<span class="sr-only">User message summary</span>';
  setRect(message1, 50, 110);
  setRect(message2, 0, 60);
  scroll.scrollTop = 100;

  assert.equal(registry.restore('reader', scroll), 'parent');
  assert.equal(scroll.scrollTop, 170, 'the original message returns to the row offset');
});

// NOTE (2026-08-30): the two approval-gap skip tests below construct the
// registry with default options (row granularity, preferEntries: false),
// which matches the IDE chat dock registry. The MAIN chat coordinator runs
// preferEntries: true and anchors on .chat-entry articles — the skip cannot
// trigger there (see the entry-granularity test after these two).
test('logical anchor skips a visible approval gap that is removed before restore', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="scroll">
    <article class="chat-entry" data-message-id="m1">
      <div data-row-id="before"></div>
      <div data-row-id="approval" data-row-kind="approval_gap"></div>
      <div data-row-id="after"></div>
    </article>
  </div></body>`);
  const scroll = dom.window.document.getElementById('scroll');
  const message = scroll.firstElementChild;
  const [beforeRow, approvalRow, afterRow] = message.children;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  setRect(scroll, 0, 400);
  setRect(message, -250, 150);
  setRect(beforeRow, -80, -40);
  setRect(approvalRow, -20, 20);
  setRect(afterRow, 30, 70);
  scroll.scrollTop = 500;
  const registry = createLogicalScrollAnchorRegistry();

  registry.capture('reader', scroll);
  approvalRow.remove();
  setRect(message, -200, 160);
  setRect(afterRow, 80, 120);
  scroll.scrollTop = 200;

  assert.equal(registry.restore('reader', scroll), 'logical');
  assert.equal(scroll.scrollTop, 250, 'the durable row returns to its captured 30px viewport offset');
});

test('logical anchor uses the nearest durable row above when an approval gap has no durable successor', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="scroll">
    <article class="chat-entry" data-message-id="m1">
      <div data-row-id="before"></div>
      <div data-row-id="approval" data-row-kind="approval_gap"></div>
    </article>
  </div></body>`);
  const scroll = dom.window.document.getElementById('scroll');
  const [beforeRow, approvalRow] = scroll.firstElementChild.children;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  setRect(scroll, 0, 400);
  setRect(beforeRow, -60, -20);
  setRect(approvalRow, -10, 30);
  scroll.scrollTop = 500;
  const registry = createLogicalScrollAnchorRegistry();

  registry.capture('reader', scroll);
  approvalRow.remove();
  setRect(beforeRow, 20, 60);
  scroll.scrollTop = 100;

  assert.equal(registry.restore('reader', scroll), 'logical');
  assert.equal(scroll.scrollTop, 180, 'the preceding durable row keeps its captured -60px offset');
});

test('entry-granularity capture anchors the article, so approval-row removal cannot strand it', () => {
  // Main-chat configuration (preferEntries: true): the anchor is the
  // .chat-entry article, which survives the approval gap row's removal —
  // restore stays 'logical' with the article's own offset, no parent fallback.
  const dom = new JSDOM(`<!doctype html><body><div id="scroll">
    <article class="chat-entry" data-message-id="m1">
      <div data-row-id="approval" data-row-kind="approval_gap"></div>
      <div data-row-id="after"></div>
    </article>
  </div></body>`);
  const scroll = dom.window.document.getElementById('scroll');
  const message = scroll.firstElementChild;
  const [approvalRow] = message.children;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  setRect(scroll, 0, 400);
  setRect(message, 10, 150);
  scroll.scrollTop = 500;
  const registry = createLogicalScrollAnchorRegistry({ preferEntries: true });

  registry.capture('reader', scroll);
  approvalRow.remove();
  setRect(message, 40, 120);
  scroll.scrollTop = 200;

  assert.equal(registry.restore('reader', scroll), 'logical');
  assert.equal(scroll.scrollTop, 230, 'the article returns to its captured 10px viewport offset');
});

// ---- Scroll-program W2a: per-frame query cost ------------------------------
// The W0 baseline measured exactly two full-document querySelectorAll calls on
// every detached scroll frame. In the production registry config
// (preferEntries: true) the '[data-row-id]' result is discarded two lines
// later; in the row config the entry fallback is queried even when rows
// exist. W2a makes both queries lazy and memoises the row collection behind a
// caller-supplied content generation, so an unchanged timeline is scanned
// once, not once per frame. Cadence and semantics stay identical.

function makeCountingRoot(rows, entries) {
  const counts = { '[data-row-id]': 0, '.chat-entry[data-message-id]': 0 };
  return {
    counts,
    querySelectorAll(selector) {
      if (selector in counts) counts[selector] += 1;
      if (selector === '[data-row-id]') return rows;
      if (selector === '.chat-entry[data-message-id]') return entries;
      return [];
    },
  };
}

function makeLogicalRow(id, top) {
  return {
    getAttribute: (name) => (name === 'data-row-id' ? id : null),
    closest: () => null,
    getBoundingClientRect: () => ({ top, bottom: top + 40, height: 40 }),
  };
}

function makeLogicalEntry(id, top) {
  return {
    getAttribute: (name) => (name === 'data-message-id' ? id : null),
    closest: () => null,
    getBoundingClientRect: () => ({ top, bottom: top + 40, height: 40 }),
  };
}

function makeAnchorContainer() {
  return {
    scrollTop: 500,
    scrollHeight: 2400,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 }),
  };
}

test('collectLogicalRows preferEntries never runs the discarded row query', () => {
  const root = makeCountingRoot([makeLogicalRow('r1', 480)], [makeLogicalEntry('m1', 480)]);
  const rows = collectLogicalRows(root, { preferEntries: true });
  assert.equal(rows.length, 1);
  assert.equal(root.counts['[data-row-id]'], 0, 'the row query result is unused on this path and must not run');
  assert.equal(root.counts['.chat-entry[data-message-id]'], 1);
});

test('collectLogicalRows only falls back to entries when no rows exist', () => {
  const root = makeCountingRoot([makeLogicalRow('r1', 480)], [makeLogicalEntry('m1', 480)]);
  const rows = collectLogicalRows(root, {});
  assert.equal(rows.length, 1);
  assert.equal(root.counts['.chat-entry[data-message-id]'], 0, 'entries are a fallback, not a sibling scan');

  const emptyRoot = makeCountingRoot([], [makeLogicalEntry('m1', 480)]);
  const fallbackRows = collectLogicalRows(emptyRoot, {});
  assert.equal(fallbackRows.length, 1, 'the entry fallback still works when there are no rows');
  assert.equal(emptyRoot.counts['.chat-entry[data-message-id]'], 1);
});

test('capture memoises the row collection behind the content generation', () => {
  let generation = 1;
  const root = makeCountingRoot([makeLogicalRow('r1', 480), makeLogicalRow('r2', 560)], []);
  const registry = createLogicalScrollAnchorRegistry({
    cap: 2,
    getContentGeneration: () => generation,
  });
  const container = makeAnchorContainer();

  assert.equal(registry.capture('reader', container, root), true);
  assert.equal(registry.capture('reader', container, root), true);
  assert.equal(
    root.counts['[data-row-id]'],
    1,
    'an unchanged timeline is scanned once, not once per capture'
  );

  generation += 1;
  assert.equal(registry.capture('reader', container, root), true);
  assert.equal(root.counts['[data-row-id]'], 2, 'a content-generation bump invalidates the cache');
  registry.dispose();
});

test('a registry without a content-generation source scans every capture (dock semantics)', () => {
  const root = makeCountingRoot([makeLogicalRow('r1', 480)], []);
  const registry = createLogicalScrollAnchorRegistry({ cap: 2 });
  const container = makeAnchorContainer();

  registry.capture('reader', container, root);
  registry.capture('reader', container, root);
  assert.equal(
    root.counts['[data-row-id]'],
    2,
    'without a generation source there is nothing safe to cache against'
  );
  registry.dispose();
});
