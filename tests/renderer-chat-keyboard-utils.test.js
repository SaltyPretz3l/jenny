const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createChatKeyboardController,
  wireChatAccessibility,
} = require('../renderer/chat/renderer-chat-keyboard-utils');

function buildDom(messageIds) {
  const entries = (messageIds || ['m1', 'm2', 'm3'])
    .map((id) => (
      '<article class="chat-entry" data-message-id="' + id + '" tabindex="-1">'
        + '<div class="chat-bubble">' + id + '</div>'
        + '</article>'
    ))
    .join('');
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div class="chat-timeline" id="chatTimeline" role="feed">'
      + entries
      + '</div></body></html>'
  );
  return dom;
}

function dispatchKey(target, key, init) {
  const event = new target.ownerDocument.defaultView.KeyboardEvent('keydown', Object.assign({
    key,
    bubbles: true,
    cancelable: true,
  }, init || {}));
  target.dispatchEvent(event);
  return event;
}

test('controller exposes the expected surface (E3)', () => {
  const dom = buildDom();
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const controller = createChatKeyboardController({ chatTimeline, document: dom.window.document });
  assert.equal(typeof controller.attach, 'function');
  assert.equal(typeof controller.syncTabindex, 'function');
  assert.equal(typeof controller.focusEntryAtIndex, 'function');
  assert.equal(typeof controller.getActiveMessageId, 'function');
});

test('Alt+ArrowDown advances focus to the next chat-entry and updates tabindex (E3)', () => {
  const dom = buildDom();
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const controller = createChatKeyboardController({ chatTimeline, document: window.document });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  // Start: focus the first entry to seed the roving index.
  entries[0].focus();
  const event = dispatchKey(chatTimeline, 'ArrowDown', { altKey: true });
  assert.equal(event.defaultPrevented, true, 'Alt+Down should be consumed');
  assert.equal(window.document.activeElement, entries[1], 'focus should move to entries[1]');
  assert.equal(entries[1].getAttribute('tabindex'), '0', 'new active entry gets tabindex=0');
  assert.equal(entries[0].getAttribute('tabindex'), '-1', 'old active entry gets tabindex=-1');
});

test('attach fallback returns a detach function for direct listeners', () => {
  const dom = buildDom();
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const controller = createChatKeyboardController({ chatTimeline, document: window.document });
  const detach = controller.attach();

  assert.equal(typeof detach, 'function');
  detach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[0].focus();
  const event = dispatchKey(chatTimeline, 'ArrowDown', { altKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(window.document.activeElement, entries[0]);
});

test('Alt+ArrowUp moves focus to the previous chat-entry (E3)', () => {
  const dom = buildDom();
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const controller = createChatKeyboardController({ chatTimeline, document: window.document });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[2].focus();
  const event = dispatchKey(chatTimeline, 'ArrowUp', { altKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(window.document.activeElement, entries[1]);
});

test('Home / End jump to the first / last entry when no text input is focused (E3)', () => {
  const dom = buildDom();
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const controller = createChatKeyboardController({ chatTimeline, document: window.document });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[1].focus();
  dispatchKey(chatTimeline, 'Home');
  assert.equal(window.document.activeElement, entries[0]);
  dispatchKey(chatTimeline, 'End');
  assert.equal(window.document.activeElement, entries[entries.length - 1]);
});

test('Home / End are ignored when focus is inside a textarea (E3)', () => {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body>'
      + '<textarea id="composer"></textarea>'
      + '<div class="chat-timeline" id="chatTimeline" role="feed">'
      + '<article class="chat-entry" data-message-id="m1" tabindex="-1"></article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1"></article>'
      + '</div></body></html>'
  );
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const composer = window.document.getElementById('composer');
  const controller = createChatKeyboardController({ chatTimeline, document: window.document });
  controller.attach();

  composer.focus();
  // Dispatching directly on the timeline (the registered listener target) —
  // the controller should check document.activeElement and skip when it's a textarea.
  dispatchKey(chatTimeline, 'Home');
  assert.equal(window.document.activeElement, composer, 'focus should remain in the composer');
});

test('focusin from an external click promotes the clicked entry to tabindex=0 (E3)', () => {
  const dom = buildDom(['a', 'b', 'c']);
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const controller = createChatKeyboardController({ chatTimeline, document: window.document });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  // Simulate a real focus event bubble from the second entry.
  entries[1].focus();
  // A focusin event must have fired and been handled — verify the roving state.
  assert.equal(entries[1].getAttribute('tabindex'), '0');
  assert.equal(entries[0].getAttribute('tabindex'), '-1');
  assert.equal(entries[2].getAttribute('tabindex'), '-1');
  assert.equal(controller.getActiveMessageId(), 'b');
});

test('wireChatAccessibility wires keyboard, help-overlay, and search-overlay when factories are provided (E3+E7+F1)', () => {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body>'
      + '<div id="chatView">'
      + '<div id="chatTimeline" class="chat-timeline" role="feed">'
      + '<article class="chat-entry" data-message-id="m1" tabindex="-1"></article>'
      + '</div>'
      + '</div>'
      + '</body></html>'
  );
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  // Stub overlay modules — the wire-up should accept and call them.
  const helpOverlayCalls = [];
  const searchOverlayCalls = [];
  const helpOverlayUtils = {
    createChatHelpOverlay: (opts) => {
      helpOverlayCalls.push(opts);
      return { attach: () => {}, dispose: () => {} };
    },
  };
  const searchOverlayUtils = {
    createChatSearchOverlay: (opts) => {
      searchOverlayCalls.push(opts);
      return { attach: () => {}, dispose: () => {} };
    },
  };

  const result = wireChatAccessibility({
    chatTimeline,
    document: window.document,
    helpOverlayUtils,
    searchOverlayUtils,
  });

  assert.equal(typeof result.keyboardController.attach, 'function');
  assert.ok(result.helpOverlay);
  assert.ok(result.searchOverlay);
  assert.equal(helpOverlayCalls.length, 1);
  assert.equal(searchOverlayCalls.length, 1);
  // Search overlay receives the keyboardController for E3 integration.
  assert.equal(searchOverlayCalls[0].keyboardController, result.keyboardController);
});

test('wireChatAccessibility tolerates missing search-overlay module (F1)', () => {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body>'
      + '<div id="chatTimeline" class="chat-timeline" role="feed"></div>'
      + '</body></html>'
  );
  const window = dom.window;
  const result = wireChatAccessibility({
    chatTimeline: window.document.getElementById('chatTimeline'),
    document: window.document,
    helpOverlayUtils: { createChatHelpOverlay: () => ({ attach: () => {}, dispose: () => {} }) },
    // No searchOverlayUtils provided.
  });
  assert.equal(result.searchOverlay, null);
  assert.ok(result.keyboardController);
});

test('syncTabindex restores the active entry by data-message-id after a re-render (E3)', () => {
  const dom = buildDom(['x1', 'x2', 'x3']);
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const controller = createChatKeyboardController({ chatTimeline, document: window.document });
  controller.attach();

  // Activate the middle entry.
  chatTimeline.querySelectorAll('.chat-entry')[1].focus();
  assert.equal(controller.getActiveMessageId(), 'x2');

  // Simulate a re-render that wipes tabindex back to -1 across entries.
  chatTimeline.querySelectorAll('.chat-entry').forEach((entry) => {
    entry.setAttribute('tabindex', '-1');
  });

  controller.syncTabindex();
  // The matching message-id entry is restored to tabindex=0.
  const restored = Array.from(chatTimeline.querySelectorAll('.chat-entry'))
    .find((entry) => entry.getAttribute('data-message-id') === 'x2');
  assert.equal(restored.getAttribute('tabindex'), '0');
});

test('B5: focusEntryAtIndex calls ensureMounted on a virtualized entry before focus', () => {
  const dom = buildDom(['v1', 'v2', 'v3']);
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');

  const calls = [];
  const ensureMounted = (entryEl) => {
    calls.push(entryEl.getAttribute('data-message-id'));
    // Drop the marker so the subsequent focus() lands on a "mounted" entry.
    entryEl.removeAttribute('data-virtualized');
  };
  const controller = createChatKeyboardController({
    chatTimeline,
    document: window.document,
    ensureMounted,
  });

  // Mark the second entry virtualized.
  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[1].setAttribute('data-virtualized', 'true');

  controller.focusEntryAtIndex(1);
  assert.deepEqual(calls, ['v2'], 'ensureMounted invoked for the virtualized target');
  assert.equal(entries[1].getAttribute('data-virtualized'), null);
  assert.equal(window.document.activeElement, entries[1]);
});

test('B5: focusEntryAtIndex skips ensureMounted on a non-virtualized entry', () => {
  const dom = buildDom(['n1', 'n2']);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  let calls = 0;
  const controller = createChatKeyboardController({
    chatTimeline,
    document: dom.window.document,
    ensureMounted: () => { calls += 1; },
  });
  controller.focusEntryAtIndex(0);
  assert.equal(calls, 0, 'ensureMounted not called when target lacks data-virtualized');
});

// F2 — Enter-on-focused-user-row opens inline edit mode

function buildDomWithRoles(entries) {
  const items = entries
    .map((entry) => (
      '<article class="chat-entry" data-message-id="' + entry.id + '" data-message-role="' + entry.role + '" tabindex="-1">'
        + '<div class="chat-bubble">' + entry.id + '</div>'
        + '</article>'
    ))
    .join('');
  return new JSDOM(
    '<!DOCTYPE html><html><body><div class="chat-timeline" id="chatTimeline" role="feed">'
      + items
      + '</div></body></html>'
  );
}

test('F2: Enter on a focused user .chat-entry invokes onEnterEditFromKeyboard with the message id', () => {
  const dom = buildDomWithRoles([
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
  ]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const calls = [];
  const controller = createChatKeyboardController({
    chatTimeline,
    document: dom.window.document,
    onEnterEditFromKeyboard: (id) => calls.push(id),
  });
  controller.attach();
  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[0].focus();
  const event = dispatchKey(entries[0], 'Enter');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ['u1']);
});

test('F2: Enter on a focused assistant .chat-entry does NOT invoke the callback', () => {
  const dom = buildDomWithRoles([
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
  ]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const calls = [];
  const controller = createChatKeyboardController({
    chatTimeline,
    document: dom.window.document,
    onEnterEditFromKeyboard: (id) => calls.push(id),
  });
  controller.attach();
  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[1].focus();
  const event = dispatchKey(entries[1], 'Enter');
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(calls, []);
});

test('F2: Enter with any modifier does NOT trigger edit (Ctrl/Shift/Alt/Meta reserved for other shortcuts)', () => {
  const dom = buildDomWithRoles([{ id: 'u1', role: 'user' }]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const calls = [];
  const controller = createChatKeyboardController({
    chatTimeline,
    document: dom.window.document,
    onEnterEditFromKeyboard: (id) => calls.push(id),
  });
  controller.attach();
  const entry = chatTimeline.querySelector('.chat-entry');
  entry.focus();
  dispatchKey(entry, 'Enter', { ctrlKey: true });
  dispatchKey(entry, 'Enter', { shiftKey: true });
  dispatchKey(entry, 'Enter', { altKey: true });
  dispatchKey(entry, 'Enter', { metaKey: true });
  assert.deepEqual(calls, []);
});

test('F2: wireChatAccessibility threads messageEditController.enterEdit into the keyboard controller', () => {
  const dom = buildDomWithRoles([{ id: 'u1', role: 'user' }]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const enterEditCalls = [];
  const fakeEditController = {
    enterEdit: (id) => enterEditCalls.push(id),
  };
  const wired = wireChatAccessibility({
    chatTimeline,
    document: dom.window.document,
    messageEditController: fakeEditController,
  });
  assert.ok(wired.keyboardController);
  const entry = chatTimeline.querySelector('.chat-entry');
  entry.focus();
  dispatchKey(entry, 'Enter');
  assert.deepEqual(enterEditCalls, ['u1']);
});

test('F3: Ctrl+Shift+B on a focused message invokes onBranchFromKeyboard', () => {
  const dom = buildDomWithRoles([
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
  ]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const calls = [];
  const controller = createChatKeyboardController({
    chatTimeline,
    document: dom.window.document,
    onBranchFromKeyboard: (id) => calls.push(id),
  });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[1].focus();
  const event = dispatchKey(entries[1], 'B', { ctrlKey: true, shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ['a1']);
});

test('F3: wireChatAccessibility threads messageBranchController.branchFromMessage into keyboard shortcut', () => {
  const dom = buildDomWithRoles([{ id: 'u1', role: 'user' }]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const branchCalls = [];
  const fakeBranchController = {
    branchFromMessage: (id) => branchCalls.push(id),
  };
  const wired = wireChatAccessibility({
    chatTimeline,
    document: dom.window.document,
    messageBranchController: fakeBranchController,
  });

  assert.ok(wired.keyboardController);
  const entry = chatTimeline.querySelector('.chat-entry');
  entry.focus();
  dispatchKey(entry, 'b', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(branchCalls, ['u1']);
});

test('F10: Ctrl+Shift+U invokes the first-unread jump callback', () => {
  const dom = buildDomWithRoles([{ id: 'a1', role: 'assistant' }]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const calls = [];
  const controller = createChatKeyboardController({
    chatTimeline,
    document: dom.window.document,
    onJumpToFirstUnread: () => calls.push('jump'),
  });
  controller.attach();

  const entry = chatTimeline.querySelector('.chat-entry');
  entry.focus();
  const event = dispatchKey(entry, 'u', { ctrlKey: true, shiftKey: true });

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ['jump']);
});

test('F10: wireChatAccessibility threads unread controller into shortcut and scroll cleanup', () => {
  const dom = buildDomWithRoles([{ id: 'a1', role: 'assistant' }]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const scroll = dom.window.document.createElement('div');
  const calls = [];
  const listeners = [];
  const unreadOrientationController = {
    jumpToFirstUnread: () => calls.push('jump'),
    handleScroll: () => calls.push('scroll'),
    attachAffordance: () => calls.push('attachAffordance'),
  };

  const wired = wireChatAccessibility({
    chatTimeline,
    chatThreadScroll: scroll,
    document: dom.window.document,
    unreadOrientationController,
    registerListener(target, eventName, handler) {
      listeners.push({ target, eventName, handler });
      target.addEventListener?.(eventName, handler);
    },
  });

  assert.ok(wired.keyboardController);
  assert.deepEqual(calls, ['attachAffordance']);

  const entry = chatTimeline.querySelector('.chat-entry');
  entry.focus();
  dispatchKey(entry, 'U', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(calls, ['attachAffordance', 'jump']);

  const scrollListener = listeners.find((entry) => entry.target === scroll && entry.eventName === 'scroll');
  assert.ok(scrollListener);
  scrollListener.handler();
  assert.deepEqual(calls, ['attachAffordance', 'jump', 'scroll']);
});

test('coordinator mode keeps unread shortcuts but registers no duplicate native scroll listener', () => {
  const dom = buildDomWithRoles([{ id: 'a1', role: 'assistant' }]);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const scroll = dom.window.document.createElement('div');
  const calls = [];
  const listeners = [];
  const unreadOrientationController = {
    jumpToFirstUnread: () => calls.push('jump'),
    handleScroll: () => calls.push('scroll'),
    attachAffordance: () => calls.push('attachAffordance'),
  };

  wireChatAccessibility({
    chatTimeline,
    chatThreadScroll: scroll,
    chatScrollCoordinator: {},
    document: dom.window.document,
    unreadOrientationController,
    registerListener(target, eventName, handler) {
      listeners.push({ target, eventName, handler });
      target.addEventListener?.(eventName, handler);
    },
  });

  assert.deepEqual(calls, ['attachAffordance']);
  assert.equal(
    listeners.some((entry) => entry.target === scroll && entry.eventName === 'scroll'),
    false
  );
  const entry = chatTimeline.querySelector('.chat-entry');
  entry.focus();
  dispatchKey(entry, 'U', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(calls, ['attachAffordance', 'jump']);
});

test('F12: wireChatAccessibility threads citation jump controller deps and cleanup', () => {
  const dom = buildDom(['m1']);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const calls = [];
  const cleanups = [];
  const deps = {
    getCurrentSessionMessages: () => [{ id: 'm1' }],
    scrollMessageIntoView: () => true,
    focusEntryByMessageId: () => true,
    appendClientLog: () => {},
  };
  const citationJumpUtils = {
    createCitationJumpController(options) {
      calls.push(options);
      return {
        attach() { calls.push('attach'); return () => calls.push('detach'); },
        dispose() { calls.push('dispose'); },
      };
    },
  };

  const wired = wireChatAccessibility({
    chatTimeline,
    document: dom.window.document,
    citationJumpUtils,
    getCurrentSessionMessages: deps.getCurrentSessionMessages,
    scrollMessageIntoView: deps.scrollMessageIntoView,
    focusEntryByMessageId: deps.focusEntryByMessageId,
    appendClientLog: deps.appendClientLog,
    addCleanup(fn) { cleanups.push(fn); },
  });

  assert.equal(wired.citationJumpController !== null, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].getCurrentSessionMessages, deps.getCurrentSessionMessages);
  assert.equal(calls[0].scrollMessageIntoView, deps.scrollMessageIntoView);
  assert.equal(calls[0].focusEntryByMessageId, deps.focusEntryByMessageId);
  assert.equal(calls[0].appendClientLog, deps.appendClientLog);
  assert.deepEqual(calls.slice(1), ['attach']);

  cleanups.forEach((fn) => fn());
  assert.deepEqual(calls.slice(1), ['attach', 'detach', 'dispose']);
});

test('B5: wireChatAccessibility threads timelineVirtualizer into keyboard + search', () => {
  const dom = buildDom(['w1', 'w2']);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const ensureMountedCalls = [];
  const pauseCalls = [];
  const fakeVirtualizer = {
    ensureMounted: (entryEl) => ensureMountedCalls.push(entryEl.getAttribute('data-message-id')),
    pause: (reason) => pauseCalls.push(reason),
    resume: () => {},
  };
  // We don't need a real search overlay module here — just confirm
  // wireChatAccessibility threads ensureMounted into the keyboard
  // controller. The search overlay path is exercised in the
  // search-overlay test file.
  const wired = wireChatAccessibility({
    chatTimeline,
    document: dom.window.document,
    timelineVirtualizer: fakeVirtualizer,
  });
  assert.ok(wired.keyboardController, 'keyboard controller returned');

  // Mark an entry virtualized and trigger focusEntryAtIndex via the
  // returned keyboardController — confirms the ensureMounted callback
  // was wired through.
  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[0].setAttribute('data-virtualized', 'true');
  wired.keyboardController.focusEntryAtIndex(0);
  assert.deepEqual(ensureMountedCalls, ['w1'], 'ensureMounted reaches the keyboard controller via wire');
});

/* ── F4/F5/F6: selection-mode keyboard shortcuts ── */

test('F4: Ctrl+A fires onSelectAllFromKeyboard only when selection mode is active', () => {
  const dom = buildDom();
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  let selectModeActive = false;
  let selectAllCalls = 0;
  const controller = createChatKeyboardController({
    chatTimeline,
    document: window.document,
    onSelectAllFromKeyboard: () => { selectAllCalls += 1; },
    isSelectionModeActive: () => selectModeActive,
  });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[0].focus();

  // Mode off → Ctrl+A is ignored by the timeline handler (browser default).
  let event = dispatchKey(chatTimeline, 'a', { ctrlKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(selectAllCalls, 0);

  // Mode on → Ctrl+A fires the callback.
  selectModeActive = true;
  event = dispatchKey(chatTimeline, 'a', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(selectAllCalls, 1);
});

test('F4: Delete fires onDeleteFromSelection only when selection mode is active', () => {
  const dom = buildDom();
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  let selectModeActive = true;
  let deleteCalls = 0;
  const controller = createChatKeyboardController({
    chatTimeline,
    document: window.document,
    onDeleteFromSelection: () => { deleteCalls += 1; },
    isSelectionModeActive: () => selectModeActive,
  });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[0].focus();

  // Active mode → Delete fires.
  let event = dispatchKey(chatTimeline, 'Delete');
  assert.equal(event.defaultPrevented, true);
  assert.equal(deleteCalls, 1);

  // Mode off → no fire.
  selectModeActive = false;
  dispatchKey(chatTimeline, 'Delete');
  assert.equal(deleteCalls, 1);
});

test('F4: Delete with modifiers does not trigger the bulk delete callback', () => {
  const dom = buildDom();
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  let deleteCalls = 0;
  const controller = createChatKeyboardController({
    chatTimeline,
    document: window.document,
    onDeleteFromSelection: () => { deleteCalls += 1; },
    isSelectionModeActive: () => true,
  });
  controller.attach();

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[0].focus();

  dispatchKey(chatTimeline, 'Delete', { shiftKey: true });
  dispatchKey(chatTimeline, 'Delete', { ctrlKey: true });
  assert.equal(deleteCalls, 0);
});

test('F4: wireChatAccessibility threads selectionController + bulkActionsController into the keyboard controller', () => {
  const dom = buildDom();
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  let selectAllCalls = 0;
  let deleteCalls = 0;
  const selectionController = {
    isSelectMode: () => true,
    selectAll: () => { selectAllCalls += 1; },
    exitSelectMode: () => {},
    attach: () => () => {},
    getSelectedMessageIds: () => ['m1'],
  };
  const bulkActionsController = {
    deleteFromHere: () => { deleteCalls += 1; },
  };
  const wired = wireChatAccessibility({
    chatTimeline,
    document: dom.window.document,
    selectionController,
    bulkActionsController,
  });
  assert.ok(wired.keyboardController);
  assert.equal(wired.selectionController, selectionController);
  assert.equal(wired.bulkActionsController, bulkActionsController);

  const entries = chatTimeline.querySelectorAll('.chat-entry');
  entries[0].focus();
  dispatchKey(chatTimeline, 'a', { ctrlKey: true });
  assert.equal(selectAllCalls, 1);
  dispatchKey(chatTimeline, 'Delete');
  assert.equal(deleteCalls, 1);
});
