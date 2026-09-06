'use strict';

/* Tier 1.5: IDE palette command source + the "?" shortcuts overlay
 * (renderer-ide-commands). Unit-tests the command list gating and run-dispatch
 * with a fake editor host, plus the overlay open path on the real inventory
 * help-overlay primitive under jsdom. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeCommands,
  createViewKeydownHandler,
} = require('../renderer/features/renderer-ide-commands');
const { createHelpOverlay } = require('../renderer/inventory/help-overlay');
const { buildIdeShortcutsHtml } = require('../renderer/features/renderer-ide-shortcuts');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');

function fakeEditorHost() {
  const calls = { runAction: [], toggleMinimap: 0 };
  return {
    calls,
    runAction: (id) => { calls.runAction.push(id); return true; },
    toggleMinimap: () => { calls.toggleMinimap += 1; return false; },
  };
}

function buildCommands(overrides) {
  const host = fakeEditorHost();
  const reopenCalls = [];
  const openFileMapCalls = [];
  let activeView = 'ide';
  const commands = createIdeCommands({
    getActiveView: () => activeView,
    editorHost: host,
    toggleMinimap: () => host.toggleMinimap(),
    reopenClosedTab: () => { reopenCalls.push(true); },
    openFileMap: () => { openFileMapCalls.push(true); },
    ...overrides,
  });
  return {
    commands,
    openFileMapCalls,
    host,
    reopenCalls,
    setActiveView: (v) => { activeView = v; },
  };
}

test('getCommandItems is empty unless the IDE view is active', () => {
  const { commands, setActiveView } = buildCommands();
  assert.ok(commands.getCommandItems().length > 0, 'populated on the IDE view');
  setActiveView('chat');
  assert.deepEqual(commands.getCommandItems(), [], 'empty off the IDE view');
  setActiveView('home');
  assert.deepEqual(commands.getCommandItems(), []);
});

test('getCommandItems lists the Workspace commands when on the IDE view', () => {
  const { commands } = buildCommands();
  const items = commands.getCommandItems();
  const ids = items.map((i) => i.id);
  assert.deepEqual(ids, [
    'ide:format-document',
    'ide:go-to-symbol',
    'ide:go-to-symbol-workspace',
    'ide:find-references',
    'ide:find-in-files',
    'ide:open-file-map',
    'ide:reveal-in-map',
    'ide:show-blast-radius',
    'ide:toggle-minimap',
    'ide:reopen-closed-tab',
    'ide:toggle-bookmark',
    'ide:next-bookmark',
    'ide:prev-bookmark',
    'ide:list-bookmarks',
  ]);
  assert.ok(items.every((i) => i.group === 'Workspace'), 'all rows are in the Workspace group');
});

test('command run() dispatches to the right editor-host action ids', () => {
  const { commands, host, reopenCalls } = buildCommands();
  const byId = Object.fromEntries(commands.getCommandItems().map((i) => [i.id, i]));

  byId['ide:format-document'].run();
  byId['ide:go-to-symbol'].run();
  byId['ide:find-references'].run();
  assert.deepEqual(host.calls.runAction, [
    'editor.action.formatDocument',
    'editor.action.quickOutline',
    'editor.action.referenceSearch.trigger',
  ]);

  byId['ide:toggle-minimap'].run();
  assert.equal(host.calls.toggleMinimap, 1);

  byId['ide:reopen-closed-tab'].run();
  assert.deepEqual(reopenCalls, [true]);
});

test('ide:open-file-map run() dispatches to the openFileMap thunk', () => {
  const { commands, openFileMapCalls } = buildCommands();
  const byId = Object.fromEntries(commands.getCommandItems().map((i) => [i.id, i]));
  byId['ide:open-file-map'].run();
  assert.deepEqual(openFileMapCalls, [true]);
});

test('openHelpOverlay renders the shortcuts catalog and Esc closes it', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const { commands } = buildCommands({
    document: doc,
    helpOverlayFactory: createHelpOverlay,
    buildShortcutsHtml: buildIdeShortcutsHtml,
  });

  commands.openHelpOverlay();
  const host = doc.getElementById('ideHelpOverlay');
  assert.ok(host && !host.hidden, 'the IDE help overlay opens on its own host');
  assert.equal(commands.isHelpOpen(), true);
  assert.match(host.textContent, /Reopen the last closed tab/);
  assert.match(host.textContent, /Open this shortcuts overlay/);
  // Chip 7 discoverability entries: Find in Files, the Quick Open :line / @symbol
  // modes, and the double-click-to-pin gesture must all appear in the catalog.
  assert.match(host.textContent, /Find in Files/);
  assert.match(host.textContent, /jump to a line/);
  assert.match(host.textContent, /jump to a symbol in the file/);
  assert.match(host.textContent, /Pin or unpin a tab/);

  // A second open is idempotent (no duplicate hosts / stacked listeners).
  commands.openHelpOverlay();
  assert.equal(doc.querySelectorAll('#ideHelpOverlay').length, 1);

  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(commands.isHelpOpen(), false);
  assert.equal(host.hidden, true);
});

test('openHelpOverlay is a no-op without an overlay factory', () => {
  const { commands } = buildCommands();
  assert.doesNotThrow(() => commands.openHelpOverlay());
  assert.equal(commands.isHelpOpen(), false);
});

// ── View keydown handler bindings (Ctrl+P / Ctrl+E) ───────────────────────────

function fakeKeyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
}

test('Ctrl+Backslash falls through while the chat dock flag is disabled and binds after hydration', () => {
  let enabled = false;
  let toggles = 0;
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    chatDock: { toggle: () => { toggles += 1; } },
    isChatDockEnabled: () => enabled,
  });

  const disabledEvent = fakeKeyEvent('\\', { ctrl: true });
  handler(disabledEvent);
  assert.equal(disabledEvent.defaultPrevented, false, 'flag-off does not consume the shortcut');
  assert.equal(toggles, 0);

  enabled = true;
  const enabledEvent = fakeKeyEvent('\\', { ctrl: true });
  handler(enabledEvent);
  assert.equal(enabledEvent.defaultPrevented, true, 'late flag hydration enables the shortcut');
  assert.equal(toggles, 1);
});

test('Ctrl+E opens the recently-edited jump list (and Ctrl+P stays Quick Open)', () => {
  const calls = { toggle: 0, toggleRecent: 0 };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    quickOpen: {
      toggle: () => { calls.toggle += 1; },
      toggleRecent: () => { calls.toggleRecent += 1; },
    },
  });

  const ctrlE = fakeKeyEvent('e', { ctrl: true });
  handler(ctrlE);
  assert.equal(calls.toggleRecent, 1, 'Ctrl+E opens the MRU picker');
  assert.equal(calls.toggle, 0, 'Ctrl+E does not open Quick Open');
  assert.equal(ctrlE.defaultPrevented, true, 'the binding consumes the event');

  // Ctrl+P remains Quick Open; the two stay distinct.
  handler(fakeKeyEvent('p', { ctrl: true }));
  assert.equal(calls.toggle, 1);
  assert.equal(calls.toggleRecent, 1);

  // Modifier variants of Ctrl+E are NOT bound (Shift/Alt fall through).
  handler(fakeKeyEvent('e', { ctrl: true, shift: true }));
  handler(fakeKeyEvent('e', { ctrl: true, alt: true }));
  assert.equal(calls.toggleRecent, 1, 'only plain Ctrl+E is bound');

  // Off the IDE view the handler stands down entirely.
  const offView = createViewKeydownHandler({
    state: { ui: { activeView: 'chat' } },
    quickOpen: { toggleRecent: () => { calls.toggleRecent += 1; } },
  });
  offView(fakeKeyEvent('e', { ctrl: true }));
  assert.equal(calls.toggleRecent, 1, 'no MRU picker off the IDE view');
});

test('Ctrl+Tab / Ctrl+Shift+Tab drive the MRU switcher; t vs tab do not collide', () => {
  const calls = { tab: [], reopen: 0, symbol: 0 };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    mruSwitcher: { handleTabKey: (forward) => calls.tab.push(forward) },
    reopenClosedTab: () => { calls.reopen += 1; },
    workspaceSymbolPicker: () => { calls.symbol += 1; },
  });

  const ctrlTab = fakeKeyEvent('Tab', { ctrl: true });
  handler(ctrlTab);
  assert.deepEqual(calls.tab, [true], 'Ctrl+Tab steps forward');
  assert.equal(ctrlTab.defaultPrevented, true, 'the binding consumes the event');

  handler(fakeKeyEvent('Tab', { ctrl: true, shift: true }));
  assert.deepEqual(calls.tab, [true, false], 'Ctrl+Shift+Tab steps backward');

  // The 't' letter branches are untouched: Ctrl+Shift+T reopens, Ctrl+T = symbols.
  handler(fakeKeyEvent('t', { ctrl: true, shift: true }));
  handler(fakeKeyEvent('t', { ctrl: true }));
  assert.equal(calls.reopen, 1, 'Ctrl+Shift+T still reopens a closed tab');
  assert.equal(calls.symbol, 1, 'Ctrl+T still opens the symbol picker');
  assert.deepEqual(calls.tab, [true, false], 'the t branches never call the switcher');

  // Ctrl+Alt+Tab (a Windows system hotkey) and plain Tab are no-ops.
  handler(fakeKeyEvent('Tab', { ctrl: true, alt: true }));
  handler(fakeKeyEvent('Tab', {}));
  assert.deepEqual(calls.tab, [true, false], 'altKey + no-ctrl variants are ignored');

  // Off the IDE view the switcher is never invoked.
  const offView = createViewKeydownHandler({
    state: { ui: { activeView: 'chat' } },
    mruSwitcher: { handleTabKey: (forward) => calls.tab.push(forward) },
  });
  offView(fakeKeyEvent('Tab', { ctrl: true }));
  assert.deepEqual(calls.tab, [true, false], 'no switcher off the IDE view');
});

test('Alt+Left / Alt+Right dispatch Go Back / Go Forward', () => {
  const calls = { back: 0, forward: 0 };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    navBack: () => { calls.back += 1; },
    navForward: () => { calls.forward += 1; },
  });

  const altLeft = fakeKeyEvent('ArrowLeft', { alt: true });
  handler(altLeft);
  assert.equal(calls.back, 1, 'Alt+Left goes back');
  assert.equal(altLeft.defaultPrevented, true, 'the binding consumes the event');

  const altRight = fakeKeyEvent('ArrowRight', { alt: true });
  handler(altRight);
  assert.equal(calls.forward, 1, 'Alt+Right goes forward');
  assert.equal(altRight.defaultPrevented, true);

  // Modifier variants are NOT bound: plain arrows, and Ctrl/Shift+Alt arrows
  // fall through so they keep their editor/selection meaning.
  handler(fakeKeyEvent('ArrowLeft'));
  handler(fakeKeyEvent('ArrowRight'));
  handler(fakeKeyEvent('ArrowLeft', { alt: true, ctrl: true }));
  handler(fakeKeyEvent('ArrowRight', { alt: true, shift: true }));
  assert.equal(calls.back, 1, 'only plain Alt+Left is bound');
  assert.equal(calls.forward, 1, 'only plain Alt+Right is bound');

  // Off the IDE view the handler stands down entirely.
  const offView = createViewKeydownHandler({
    state: { ui: { activeView: 'chat' } },
    navBack: () => { calls.back += 1; },
    navForward: () => { calls.forward += 1; },
  });
  offView(fakeKeyEvent('ArrowLeft', { alt: true }));
  offView(fakeKeyEvent('ArrowRight', { alt: true }));
  assert.equal(calls.back, 1, 'no Go Back off the IDE view');
  assert.equal(calls.forward, 1, 'no Go Forward off the IDE view');
});

test('Ctrl+Alt+K/L/J/P dispatch toggle/next/prev/list bookmark', () => {
  const calls = { toggle: 0, next: 0, prev: 0, list: 0 };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    toggleBookmark: () => { calls.toggle += 1; },
    nextBookmark: () => { calls.next += 1; },
    prevBookmark: () => { calls.prev += 1; },
    listBookmarks: () => { calls.list += 1; },
  });

  const ctrlAltK = fakeKeyEvent('k', { ctrl: true, alt: true });
  handler(ctrlAltK);
  assert.equal(calls.toggle, 1, 'Ctrl+Alt+K toggles a bookmark');
  assert.equal(ctrlAltK.defaultPrevented, true);

  handler(fakeKeyEvent('l', { ctrl: true, alt: true }));
  handler(fakeKeyEvent('j', { ctrl: true, alt: true }));
  handler(fakeKeyEvent('p', { ctrl: true, alt: true }));
  assert.deepEqual([calls.next, calls.prev, calls.list], [1, 1, 1]);

  // Plain Ctrl+P must NOT trigger the bookmark list (it stays Quick Open), and
  // plain Ctrl+K (no Alt) must NOT toggle a bookmark.
  handler(fakeKeyEvent('p', { ctrl: true }));
  handler(fakeKeyEvent('k', { ctrl: true }));
  assert.deepEqual([calls.toggle, calls.list], [1, 1], 'only the Ctrl+Alt combos are bound');

  // Shift+Ctrl+Alt variants fall through (not bound).
  handler(fakeKeyEvent('k', { ctrl: true, alt: true, shift: true }));
  assert.equal(calls.toggle, 1);

  // Off the IDE view the handler stands down.
  const offView = createViewKeydownHandler({
    state: { ui: { activeView: 'chat' } },
    toggleBookmark: () => { calls.toggle += 1; },
  });
  offView(fakeKeyEvent('k', { ctrl: true, alt: true }));
  assert.equal(calls.toggle, 1, 'no bookmark toggle off the IDE view');
});

// ── Escape exits the Preview stage surface (scoped to preview only) ──────────

test('Escape calls exitStageSurface only when the Preview surface is active', () => {
  const calls = { exit: 0 };
  let surface = 'preview';
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    getStageSurface: () => surface,
    exitStageSurface: () => { calls.exit += 1; },
  });

  const esc = fakeKeyEvent('Escape');
  handler(esc);
  assert.equal(calls.exit, 1, 'Escape exits the Preview surface');
  assert.equal(esc.defaultPrevented, true, 'the binding consumes the event');

  surface = 'file_map';
  handler(fakeKeyEvent('Escape'));
  assert.equal(calls.exit, 1, 'Escape does nothing while the File Map surface is active');

  surface = 'editor';
  handler(fakeKeyEvent('Escape'));
  assert.equal(calls.exit, 1, 'Escape does nothing on the plain editor cluster');
});

test('Escape does not exit Preview when a text input is focused', () => {
  const calls = { exit: 0 };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    getStageSurface: () => 'preview',
    exitStageSurface: () => { calls.exit += 1; },
    keyboardUtils: { isTextInputFocused: () => true },
  });

  handler(fakeKeyEvent('Escape'));
  assert.equal(calls.exit, 0, 'a focused text input suppresses the Escape exit');
});

test('Escape with modifiers or off the IDE view does not exit Preview', () => {
  const calls = { exit: 0 };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    getStageSurface: () => 'preview',
    exitStageSurface: () => { calls.exit += 1; },
  });
  handler(fakeKeyEvent('Escape', { ctrl: true }));
  handler(fakeKeyEvent('Escape', { alt: true }));
  handler(fakeKeyEvent('Escape', { shift: true }));
  assert.equal(calls.exit, 0, 'modifier variants are not bound');

  const offView = createViewKeydownHandler({
    state: { ui: { activeView: 'chat' } },
    getStageSurface: () => 'preview',
    exitStageSurface: () => { calls.exit += 1; },
  });
  offView(fakeKeyEvent('Escape'));
  assert.equal(calls.exit, 0, 'off the IDE view the handler stands down');
});

// ── Preview stage-surface palette entries (isPreviewSurfaceEnabled) ──────────

test('ide:open-preview / ide:preview-active-file are present when isPreviewSurfaceEnabled is true, absent when false', () => {
  const calls = { open: 0, previewActive: 0 };
  let previewOn = false;
  const commands = createIdeCommands({
    getActiveView: () => 'ide',
    editorHost: fakeEditorHost(),
    isPreviewSurfaceEnabled: () => previewOn,
    openPreviewSurface: () => { calls.open += 1; },
    previewActiveFile: () => { calls.previewActive += 1; },
  });

  const idsOff = commands.getCommandItems().map((c) => c.id);
  assert.equal(idsOff.includes('ide:open-preview'), false, 'Open Preview absent when flag is off');
  assert.equal(idsOff.includes('ide:preview-active-file'), false, 'Preview Active File absent when flag is off');

  previewOn = true;
  const itemsOn = commands.getCommandItems();
  const byId = Object.fromEntries(itemsOn.map((i) => [i.id, i]));
  assert.ok(byId['ide:open-preview'], 'Open Preview present when flag is on');
  assert.ok(byId['ide:preview-active-file'], 'Preview Active File present when flag is on');
  assert.equal(byId['ide:open-preview'].group, 'Workspace');
  assert.equal(byId['ide:preview-active-file'].group, 'Workspace');

  byId['ide:open-preview'].run();
  byId['ide:preview-active-file'].run();
  assert.deepEqual(calls, { open: 1, previewActive: 1 });
});

test('bookmark palette commands run() dispatch to their callbacks', () => {
  const calls = { toggle: 0, next: 0, prev: 0, list: 0 };
  const commands = createIdeCommands({
    getActiveView: () => 'ide',
    editorHost: fakeEditorHost(),
    toggleBookmark: () => { calls.toggle += 1; },
    nextBookmark: () => { calls.next += 1; },
    prevBookmark: () => { calls.prev += 1; },
    listBookmarks: () => { calls.list += 1; },
  });
  const byId = Object.fromEntries(commands.getCommandItems().map((i) => [i.id, i]));
  byId['ide:toggle-bookmark'].run();
  byId['ide:next-bookmark'].run();
  byId['ide:prev-bookmark'].run();
  byId['ide:list-bookmarks'].run();
  assert.deepEqual(calls, { toggle: 1, next: 1, prev: 1, list: 1 });
});

// ── Ctrl+Shift+F / Find in Files (DOM-driven, controller-free) ────────────────

// A minimal document stand-in: querySelector returns the Search rail button and
// the search input, each a spy. The shared openSearchPanel() clicks the button
// then focuses the input, so the spies record both halves of the open path.
function fakeSearchDoc() {
  const railButton = { clicks: 0, click() { this.clicks += 1; } };
  const input = { focuses: 0, focus() { this.focuses += 1; } };
  const doc = {
    railButton,
    input,
    querySelector(selector) {
      if (selector === '[data-ide-rail-panel="search"]') return railButton;
      if (selector === '[data-ide-search-input]') return input;
      return null;
    },
  };
  return doc;
}

test('Ctrl+Shift+F opens the Search panel via the rail button + input focus', () => {
  const doc = fakeSearchDoc();
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    windowRef: { document: doc },
  });

  const ctrlShiftF = fakeKeyEvent('F', { ctrl: true, shift: true });
  handler(ctrlShiftF);
  assert.equal(doc.railButton.clicks, 1, 'activates the Search rail button');
  assert.equal(doc.input.focuses, 1, 'focuses the search input');
  assert.equal(ctrlShiftF.defaultPrevented, true, 'the binding consumes the event');

  // Modifier variants fall through: plain Ctrl+F (Monaco find), Ctrl+Shift+Alt+F.
  handler(fakeKeyEvent('f', { ctrl: true }));
  handler(fakeKeyEvent('f', { ctrl: true, shift: true, alt: true }));
  assert.equal(doc.railButton.clicks, 1, 'only plain Ctrl+Shift+F is bound');

  // Off the IDE view the handler stands down entirely.
  const offDoc = fakeSearchDoc();
  const offView = createViewKeydownHandler({
    state: { ui: { activeView: 'chat' } },
    windowRef: { document: offDoc },
  });
  offView(fakeKeyEvent('F', { ctrl: true, shift: true }));
  assert.equal(offDoc.railButton.clicks, 0, 'no Find in Files off the IDE view');
});

test('Ctrl+Shift+F degrades gracefully when the Search input is not mounted', () => {
  // Search moved to a closed secondary sidebar: no rail button, no input. The
  // open path must not throw - it is a best-effort no-op.
  const doc = { querySelector: () => null };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    windowRef: { document: doc },
  });
  const evt = fakeKeyEvent('F', { ctrl: true, shift: true });
  assert.doesNotThrow(() => handler(evt));
  assert.equal(evt.defaultPrevented, true, 'the Ctrl+Shift+F branch consumed the event even with no DOM elements');
});

test('the Find in Files palette command opens Search through the same DOM path', () => {
  const doc = fakeSearchDoc();
  const { commands } = buildCommands({ document: doc });
  const byId = Object.fromEntries(commands.getCommandItems().map((i) => [i.id, i]));
  const find = byId['ide:find-in-files'];
  assert.ok(find, 'the palette lists Find in Files');
  assert.equal(find.hint, 'Ctrl+Shift+F', 'the row advertises the shortcut');

  find.run();
  assert.equal(doc.railButton.clicks, 1, 'palette run() activates the Search rail button');
  assert.equal(doc.input.focuses, 1, 'palette run() focuses the search input');
});

// ── Integration through the controller (harness, Monaco-null fallback) ────────

test('controller surfaces IDE command items only on the IDE view', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const ids = harness.controller.getIdeCommandItems().map((i) => i.id);
  assert.ok(ids.includes('ide:reopen-closed-tab'), 'items present on the IDE view');

  harness.state.ui.activeView = 'chat';
  assert.deepEqual(harness.controller.getIdeCommandItems(), [], 'empty off the IDE view');
});

test('"?" opens the IDE shortcuts overlay; a focused editor still types it', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();
  const doc = harness.dom.window.document;

  // Focus inside the editor (fallback textarea): "?" must type, not overlay.
  harness.getDom().ideEditorFallback.focus();
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: '?', bubbles: true, cancelable: true,
  }));
  await settle();
  assert.equal(doc.getElementById('ideHelpOverlay'), null, 'no overlay while the editor owns focus');

  // Drop editor focus (activeElement -> body) and press "?": the overlay opens.
  harness.getDom().ideEditorFallback.blur();
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: '?', bubbles: true, cancelable: true,
  }));
  await settle();
  const host = doc.getElementById('ideHelpOverlay');
  assert.ok(host && !host.hidden, 'overlay opens when no input is focused');
  assert.match(host.textContent, /Reopen the last closed tab/);
});

test('Ctrl+Shift+F switches the rail to Search and focuses the input (end-to-end)', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;

  assert.notEqual(harness.state.ui.ide.railPanel, 'search', 'starts off the Search panel');
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();

  assert.equal(harness.state.ui.ide.railPanel, 'search', 'the rail switches to the Search panel');
  const input = doc.querySelector('[data-ide-search-input]');
  assert.ok(input, 'the Search input is rendered');
  assert.equal(doc.activeElement, input, 'focus lands in the Search input');
});
