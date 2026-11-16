'use strict';

// new-test-file: renderer-chats-strip.test.js would pass 600 lines with these cases (test_files_over_600 ratchet)
/**
 * tests/renderer-chats-strip-needs-you.test.js
 *
 * Row 158 gate -- the collapsed strip's Needs you mark, the waiting chips that
 * lead it, and the chip dots that agree with the inbox. These build the strip
 * alone (no app boot), so the inbox snapshot is whatever each case says; the
 * strip's other behaviour (chips, peek, expand, New chat) stays in
 * tests/renderer-chats-strip.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const inventoryPopover = require('../renderer/inventory/popover');
const { createChatsStripController } = require('../renderer/shell/renderer-chats-strip');
const chromeUtils = require('../renderer/shell/renderer-workspace-chrome-utils');

function buildSidebarSession(id, title, updatedAt, extra = {}) {
  return {
    id,
    title,
    message_count: 1,
    last_message_preview: `${title} preview`,
    preferred_model: 'gpt-test',
    updated_at: updatedAt,
    created_at: updatedAt,
    pinned: false,
    archived_at: null,
    ...extra,
  };
}

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function needsYouSnapshot(entries, answerable = entries.length) {
  const states = new Map(entries);
  return {
    answerable,
    waitingSessionIds: entries.map(([id]) => id),
    states,
    key: `${answerable}|${entries.map(([id, value]) => `${id}:${value}`).join(',')}`,
  };
}

function needsYouHarness(t, { sessions, snapshot = null }) {
  const dom = new JSDOM('<!doctype html><html><body><aside id="panel"></aside></body></html>', { pretendToBeVisual: true });
  const previous = {
    button: global.inventoryActionButton, popover: global.inventoryPopover, chrome: global.rendererWorkspaceChromeUtils,
  };
  global.inventoryActionButton = actionButton;
  global.inventoryPopover = inventoryPopover;
  global.rendererWorkspaceChromeUtils = chromeUtils;
  const calls = { toggle: [], close: 0, logs: [] };
  const harness = { snapshot, calls };
  t.after(() => {
    global.inventoryActionButton = previous.button;
    global.inventoryPopover = previous.popover;
    global.rendererWorkspaceChromeUtils = previous.chrome;
    dom.window.close();
  });
  const controller = createChatsStripController({
    state: {
      sessions, currentSessionId: '', ui: { pendingSessionDeletes: [] }, workspace: { openSessionIds: [] },
      pendingToolApprovals: new Map(),
    },
    documentRef: dom.window.document,
    dom: { viewPanel: dom.window.document.getElementById('panel') },
    callbacks: {
      getNeedsYou: () => harness.snapshot,
      toggleNeedsYou: (mark) => calls.toggle.push(mark),
      closeNeedsYou: () => { calls.close += 1; },
      appendClientLog: (...args) => calls.logs.push(args),
    },
  });
  Object.assign(harness, {
    controller,
    document: dom.window.document,
    window: dom.window,
    mark: () => dom.window.document.getElementById('chatsStripNeedsYou'),
    chipIds: () => [...dom.window.document.querySelectorAll('#chatsStripChips [data-strip-session-id]')]
      .map((chip) => chip.dataset.stripSessionId),
    layout: () => [...dom.window.document.getElementById('chatsStripChips').children].map((node) => {
      if (node.classList.contains('chats-strip__break')) return '|';
      return node.dataset.stripSessionId || (node.dataset.stripMore ? '+more' : '?');
    }),
  });
  return harness;
}

test('the Needs you mark sits between New chat and the chips, hides at zero and counts otherwise', (t) => {
  const h = needsYouHarness(t, { sessions: [buildSidebarSession('a', 'Alpha', minutesAgoIso(1))] });
  h.controller.sync({ visible: true });
  const mark = h.mark();
  assert.ok(mark, 'the mark is built with the strip');
  assert.equal(mark.hidden, true, 'no snapshot: nothing waits');
  assert.equal(mark.previousElementSibling.id, 'chatsStripNewChat');
  assert.equal(mark.nextElementSibling.id, 'chatsStripChips');
  assert.equal(mark.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(mark.getAttribute('aria-controls'), 'attentionInboxFlyout');
  assert.equal(mark.getAttribute('aria-expanded'), 'false');

  h.snapshot = needsYouSnapshot([['a', 'approval']], 1);
  h.controller.patchRuntimeState();
  assert.equal(mark.hidden, false);
  assert.equal(mark.querySelector('.chats-strip__needs-count').textContent, '1');
  assert.equal(mark.getAttribute('aria-label'), '1 thing needs you');
  h.snapshot = needsYouSnapshot([['a', 'approval']], 3);
  h.controller.patchRuntimeState();
  assert.equal(mark.querySelector('.chats-strip__needs-count').textContent, '3');
  assert.equal(mark.getAttribute('aria-label'), '3 things need you');
  h.snapshot = needsYouSnapshot([], 0);
  h.controller.patchRuntimeState();
  assert.equal(mark.hidden, true, 'back to nothing: the mark leaves');
  h.controller.dispose();
});

test('clicking the Needs you mark toggles the flyout with the mark, closes the peek and logs the count', (t) => {
  const h = needsYouHarness(t, {
    sessions: [buildSidebarSession('a', 'Alpha', minutesAgoIso(1))],
    snapshot: needsYouSnapshot([['a', 'approval']], 2),
  });
  h.controller.sync({ visible: true });
  const chip = h.document.querySelector('[data-strip-session-id="a"]');
  chip.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(h.document.getElementById('chatsStripPeek').hidden, false, 'precondition: the peek is open');
  h.mark().click();
  assert.deepEqual(h.calls.toggle, [h.mark()]);
  assert.equal(h.document.getElementById('chatsStripPeek').hidden, true);
  assert.deepEqual(h.calls.logs.at(-1), ['INFO', 'nav.chats_strip_needs_you', { count: 2 }]);
  h.controller.dispose();
});

test('waiting chats lead the chips, one older than the cap still gets a chip, and breaks separate the groups', (t) => {
  const sessions = [];
  for (let i = 1; i <= 15; i += 1) sessions.push(buildSidebarSession(`r${i}`, `Recent ${i}`, minutesAgoIso(i)));
  sessions.push(buildSidebarSession('pin', 'Pinned', minutesAgoIso(900), { pinned: true }));
  sessions.push(buildSidebarSession('old-wait', 'Old wait', minutesAgoIso(5000)));
  sessions.push(buildSidebarSession('gone', 'Archived wait', minutesAgoIso(3), { archived_at: minutesAgoIso(1) }));
  const h = needsYouHarness(t, {
    sessions,
    snapshot: needsYouSnapshot([['old-wait', 'approval'], ['r3', 'input_needed'], ['gone', 'approval'], ['missing', 'approval']], 4),
  });
  h.controller.sync({ visible: true });
  assert.deepEqual(h.layout(), [
    'old-wait', 'r3', '|', 'pin', '|', 'r1', 'r2', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', '+more',
  ], 'waiting in snapshot order (archived and unknown ids skipped), then pinned, then recent, 12 chips in all');
  assert.equal(h.document.querySelector('[data-strip-more]').textContent.trim(), '+5', '+N counts what is left of the 17 live chats');
  h.controller.dispose();

  const crowded = needsYouHarness(t, {
    sessions: Array.from({ length: 14 }, (_v, i) => buildSidebarSession(`w${i}`, `Wait ${i}`, minutesAgoIso(i + 1))),
    snapshot: needsYouSnapshot(Array.from({ length: 14 }, (_v, i) => [`w${13 - i}`, 'approval'])),
  });
  crowded.controller.sync({ visible: true });
  assert.equal(crowded.chipIds().length, 12, 'waiting chips are capped at 12 too');
  assert.equal(crowded.chipIds()[0], 'w13');
  assert.equal(crowded.document.querySelector('[data-strip-more]').textContent.trim(), '+2');
  crowded.controller.dispose();
});

test('breaks appear only between non-empty groups', (t) => {
  const sessions = [
    buildSidebarSession('a', 'Alpha', minutesAgoIso(1)),
    buildSidebarSession('b', 'Beta', minutesAgoIso(2)),
    buildSidebarSession('p', 'Pinned', minutesAgoIso(3), { pinned: true }),
  ];
  const none = needsYouHarness(t, { sessions: sessions.filter((entry) => !entry.pinned) });
  none.controller.sync({ visible: true });
  assert.deepEqual(none.layout(), ['a', 'b'], 'one group: no break');
  none.controller.dispose();

  const waitingOnly = needsYouHarness(t, { sessions: [sessions[0]], snapshot: needsYouSnapshot([['a', 'approval']]) });
  waitingOnly.controller.sync({ visible: true });
  assert.deepEqual(waitingOnly.layout(), ['a'], 'only waiting chats: no break');
  waitingOnly.controller.dispose();

  const pinnedAndRecent = needsYouHarness(t, { sessions });
  pinnedAndRecent.controller.sync({ visible: true });
  assert.deepEqual(pinnedAndRecent.layout(), ['p', '|', 'a', 'b']);
  assert.equal(pinnedAndRecent.document.querySelector('.chats-strip__break').getAttribute('aria-hidden'), 'true');
  pinnedAndRecent.controller.dispose();

  const waitingAndRecent = needsYouHarness(t, { sessions, snapshot: needsYouSnapshot([['b', 'input_needed']]) });
  waitingAndRecent.controller.sync({ visible: true });
  assert.deepEqual(waitingAndRecent.layout(), ['b', '|', 'p', '|', 'a']);
  waitingAndRecent.controller.dispose();
});

test('a snapshot state gives an idle chip its dot', (t) => {
  const h = needsYouHarness(t, {
    sessions: [buildSidebarSession('a', 'Alpha', minutesAgoIso(1)), buildSidebarSession('b', 'Beta', minutesAgoIso(2))],
    snapshot: needsYouSnapshot([['a', 'input_needed']]),
  });
  h.controller.sync({ visible: true });
  const chip = (id) => h.document.querySelector(`[data-strip-session-id="${id}"]`);
  assert.equal(chip('a').dataset.sessionDominantState, 'input_needed', 'a question or failed send shows on the chip');
  assert.equal(chip('b').dataset.sessionDominantState, 'idle');
  assert.match(chip('a').getAttribute('aria-label'), /Status: /, 'and the label says so');
  h.controller.dispose();
});

test('a runtime patch re-renders the chips when the snapshot key moves, and only then', (t) => {
  const h = needsYouHarness(t, {
    sessions: [buildSidebarSession('a', 'Alpha', minutesAgoIso(1)), buildSidebarSession('b', 'Beta', minutesAgoIso(2))],
  });
  h.controller.sync({ visible: true });
  assert.deepEqual(h.chipIds(), ['a', 'b']);
  const first = h.document.querySelector('[data-strip-session-id="a"]');
  h.controller.patchRuntimeState();
  assert.equal(h.document.querySelector('[data-strip-session-id="a"]'), first, 'an unchanged key patches in place');
  h.snapshot = needsYouSnapshot([['b', 'approval']]);
  h.controller.patchRuntimeState();
  assert.deepEqual(h.chipIds(), ['b', 'a'], 'the waiting chat leads without waiting for a sessions render');
  assert.equal(h.document.querySelector('[data-strip-session-id="b"]').dataset.sessionDominantState, 'approval');
  const second = h.document.querySelector('[data-strip-session-id="b"]');
  h.controller.patchRuntimeState();
  assert.equal(h.document.querySelector('[data-strip-session-id="b"]'), second);
  h.controller.dispose();
});

test('hiding the strip closes the Needs you flyout', (t) => {
  const h = needsYouHarness(t, {
    sessions: [buildSidebarSession('a', 'Alpha', minutesAgoIso(1))],
    snapshot: needsYouSnapshot([['a', 'approval']]),
  });
  h.controller.sync({ visible: true });
  assert.equal(h.calls.close, 0);
  h.controller.sync({ visible: false });
  assert.equal(h.calls.close, 1);
  assert.equal(h.document.getElementById('chatsStrip').hidden, true);
  h.controller.dispose();
});
