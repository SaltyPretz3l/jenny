'use strict';

/* Row 82 slice K (plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md sections 5.1, 6.1):
 * the registry-driven Workspace keymap. Every section 6.1 chord resolves to its
 * command; Ctrl+Shift+P / F1 open the palette in the '>' scope from Monaco and the
 * terminal; two-step chords stay with Monaco inside its editors; terminal
 * passthrough; the "?" catalog lists every binding; the Monaco binder; the global
 * shortcut changes for picks O1-O3; Zen Mode. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeCommands, createViewKeydownHandler } = require('../renderer/features/renderer-ide-commands');
const { bindMonacoKeymap, monacoChord, TERMINAL_PASSTHROUGH } = require('../renderer/features/renderer-ide-keymap');
const { buildIdeShortcutsHtml } = require('../renderer/features/renderer-ide-shortcuts');
const { createGlobalShortcutsController } = require('../renderer/shell/renderer-global-shortcuts.js');
const { createCommandPaletteController, getActive } = require('../renderer/shell/renderer-command-palette.js');
const { createIdeWorkbenchWiring } = require('../renderer/features/renderer-ide-workbench-wiring');

function buildDom() {
  const dom = new JSDOM('<!doctype html><body>'
    + '<main id="ideView"><div id="ideShell">'
    + '<div class="monaco-editor" id="ed"><textarea id="edInput"></textarea></div>'
    + '<div class="monaco-diff-editor"><div class="monaco-editor"><textarea id="diffInput"></textarea></div></div>'
    + '<div class="ide-terminal-panel"><div class="xterm"><textarea id="term"></textarea></div></div>'
    + '<input id="search" data-ide-search-input /><input id="replace" data-ide-replace-input />'
    + '<div id="tree" tabindex="0"></div>'
    + '<div class="ide-statusbar" id="ideStatusBar"></div>'
    + '</div></main><textarea id="outside"></textarea></body>');
  const doc = dom.window.document;
  const el = (id) => doc.getElementById(id);
  return { dom, doc, el };
}

function press(handler, key, mods = {}, target = null, code = '') {
  const event = {
    key,
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  handler(event);
  return event;
}

// A full set of fake deps that records every call by name.
function buildKeymap(overrides = {}) {
  const { doc } = overrides.domBundle || buildDom();
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return true; };
  const zen = { on: false };
  const workbenchWiring = {
    showPanel: rec('showPanel'),
    togglePrimarySide: rec('togglePrimarySide'),
    toggleZen: () => { zen.on = !zen.on; calls.push(['toggleZen', zen.on]); return zen.on; },
    isZen: () => zen.on,
    workbench: { hostFor: () => null, collapseStackOf: rec('collapseStackOf') },
  };
  const editorGroups = {
    groupOfTarget: () => '',
    splitActive: rec('splitActive'),
    getElement: () => null,
    getFocusedGroup: () => '',
    focusNextGroup: () => false,
    saveActive: rec('groupSave'),
    closeActive: rec('groupClose'),
    cycle: rec('groupCycle'),
  };
  const ide = { activeTabPath: 'src/a.js', openTabs: [{ path: 'src/a.js' }], dirtyByPath: {} };
  const state = { ui: { activeView: 'ide' } };
  const ideCommands = createIdeCommands({
    document: doc,
    getActiveView: () => state.ui.activeView,
    getIde: () => ide,
    editorHost: { runAction: rec('runAction') },
    helpOverlayFactory: () => ({ open: rec('helpOpen'), isOpen: () => false, destroy() {} }),
    buildShortcutsHtml: (registry) => buildIdeShortcutsHtml(registry),
  });
  const deps = {
    state,
    getIde: () => ide,
    ideCommands,
    windowRef: { document: doc },
    editorHost: { getMonaco: () => ({}), triggerGoToLine: rec('goToLine'), focus: rec('editorFocus'), runAction: rec('runAction'), isDirty: () => false },
    workbenchWiring,
    editorGroups,
    quickOpen: { toggle: rec('quickOpen'), toggleRecent: rec('recent') },
    tabsController: { closeActiveTab: rec('closeTab'), cycleTab: rec('cycleTab') },
    bottomPanel: { toggle: rec('panelToggle'), open: rec('panelOpen'), close: rec('panelClose') },
    chatDock: { toggle: rec('chatToggle'), toggleChangesTab: rec('chatChanges') },
    isChatDockEnabled: () => true,
    saveActiveFile: rec('save'),
    saveFile: rec('saveFile'),
    reopenClosedTab: rec('reopen'),
    navBack: rec('back'),
    navForward: rec('forward'),
    workspaceSymbolPicker: rec('symbols'),
    toggleBookmark: rec('bm'), nextBookmark: rec('bmNext'), prevBookmark: rec('bmPrev'), listBookmarks: rec('bmList'),
    newTerminal: rec('newTerminal'),
    revealInExplorer: rec('revealInExplorer'),
    previewActiveFile: rec('preview'),
    openCommandPalette: rec('palette'),
    chooseWorkspaceRoot: rec('chooseRoot'),
    getCloseOrchestrator: () => ({ requestCloseAll: rec('closeAll'), requestCloseOthers: rec('closeOthers'), requestCloseSaved: rec('closeSaved') }),
    problemsPanel: { nextProblem: rec('nextProblem'), previousProblem: rec('previousProblem') },
    runScripts: { runBuildTask: rec('build'), runActiveFile: rec('runFile'), pickAndRunScript: rec('pickScript') },
    showPanel: rec('showPanel'),
    chipPicker: { registerCommands: (registry) => registry.register({ id: 'ide:change-language-mode', label: 'Change Language Mode', keys: ['ctrl+k m'], run: rec('languagePicker') }) },
    ...overrides.deps,
  };
  const handler = createViewKeydownHandler(deps);
  return { handler, calls, registry: ideCommands.registry, ideCommands, state, ide, zen, deps, doc };
}

// --- the red run of the slice: Ctrl+Shift+P from Monaco -----------------------------

test('Ctrl+Shift+P on a .monaco-editor target opens the palette in the commands scope', () => {
  const bundle = buildDom();
  const { handler, calls } = buildKeymap({ domBundle: bundle });
  const event = press(handler, 'P', { ctrl: true, shift: true }, bundle.el('edInput'), 'KeyP');
  assert.deepEqual(calls.filter((c) => c[0] === 'palette').length, 1, 'the palette opens');
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true, 'Monaco never sees it (its own quick command stays shut)');
  const f1 = press(handler, 'F1', {}, bundle.el('term'), 'F1');
  assert.equal(calls.filter((c) => c[0] === 'palette').length, 2, 'F1 from the terminal opens it too');
  assert.equal(f1.stopped, true, 'the shell never receives F1');
});

test('the default palette opener asks the bound palette for the commands scope', () => {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="o" class="hidden"></div><input id="i" /><div id="l"></div><span id="s"></span></body>');
  const doc = dom.window.document;
  const previous = global.document;
  global.document = doc;
  try {
    const controller = createCommandPaletteController({
      state: { ui: {}, auth: { authenticated: true }, sessions: [], features: { featureFlags: { command_palette: true } } },
      dom: { commandPaletteOverlay: doc.getElementById('o'), commandPaletteInput: doc.getElementById('i'), commandPaletteList: doc.getElementById('l'), commandPaletteScope: doc.getElementById('s') },
    });
    assert.equal(getActive(), null, 'no live palette before bind');
    controller.bind();
    assert.equal(getActive(), controller, 'the bound palette is the live one');
    const { handler } = buildKeymap({ deps: { openCommandPalette: undefined } });
    press(handler, 'P', { ctrl: true, shift: true }, null, 'KeyP');
    assert.equal(controller.isActive(), true, 'Ctrl+Shift+P opened it');
    assert.match(doc.getElementById('s').textContent, /Commands/, 'in the > commands scope');
    controller.dispose();
    assert.equal(getActive(), null, 'dispose clears the live palette');
  } finally {
    global.document = previous;
  }
});

// --- every section 6.1 chord ------------------------------------------------------

const SINGLE_STEP = [
  // [key, mods, code, command id, recorded call]
  ['P', { ctrl: true, shift: true }, 'KeyP', 'ide:command-palette', 'palette'],
  ['F1', {}, 'F1', 'ide:command-palette', 'palette'],
  ['p', { ctrl: true }, 'KeyP', 'ide:quick-open', 'quickOpen'],
  ['g', { ctrl: true }, 'KeyG', 'ide:go-to-line', 'goToLine'],
  ['b', { ctrl: true }, 'KeyB', 'ide:toggle-primary-side', 'togglePrimarySide'],
  ['b', { ctrl: true, alt: true }, 'KeyB', 'ide:toggle-chat', 'chatToggle'],
  ['j', { ctrl: true }, 'KeyJ', 'ide:toggle-panel', 'panelToggle'],
  ['`', { ctrl: true }, 'Backquote', 'ide:toggle-terminal', 'panelOpen'],
  ['~', { ctrl: true, shift: true }, 'Backquote', 'ide:new-terminal', 'newTerminal'],
  ['E', { ctrl: true, shift: true }, 'KeyE', 'ide:focus-explorer', 'revealInExplorer'],
  ['F', { ctrl: true, shift: true }, 'KeyF', 'ide:find-in-files', 'showPanel'],
  ['H', { ctrl: true, shift: true }, 'KeyH', 'ide:replace-in-files', 'showPanel'],
  ['G', { ctrl: true, shift: true }, 'KeyG', 'ide:focus-source-control', 'showPanel'],
  ['g', { ctrl: true, alt: true }, 'KeyG', 'ide:chat-dock-switch', 'chatChanges'],
  ['M', { ctrl: true, shift: true }, 'KeyM', 'ide:focus-problems', 'showPanel'],
  ['D', { ctrl: true, shift: true }, 'KeyD', 'ide:focus-run', 'showPanel'],
  ['\\', { ctrl: true }, 'Backslash', 'ide:split-editor-right', 'splitActive'],
  ['2', { ctrl: true }, 'Digit2', 'ide:focus-group-2', 'splitActive'],
  ['w', { ctrl: true }, 'KeyW', 'ide:close-editor', 'closeTab'],
  ['F4', { ctrl: true }, 'F4', 'ide:close-editor', 'closeTab'],
  ['n', { ctrl: true }, 'KeyN', 'ide:new-file', 'showPanel'],
  ['T', { ctrl: true, shift: true }, 'KeyT', 'ide:reopen-closed-tab', 'reopen'],
  ['PageUp', { ctrl: true }, 'PageUp', 'ide:previous-editor', 'cycleTab'],
  ['PageDown', { ctrl: true }, 'PageDown', 'ide:next-editor', 'cycleTab'],
  ['ArrowLeft', { alt: true }, 'ArrowLeft', 'ide:go-back', 'back'],
  ['ArrowRight', { alt: true }, 'ArrowRight', 'ide:go-forward', 'forward'],
  ['F8', {}, 'F8', 'ide:next-problem', 'nextProblem'],
  ['F8', { shift: true }, 'F8', 'ide:previous-problem', 'previousProblem'],
  ['B', { ctrl: true, shift: true }, 'KeyB', 'ide:run-build-task', 'build'],
  ['F5', { ctrl: true }, 'F5', 'ide:run-active-file', 'runFile'],
  ['V', { ctrl: true, shift: true }, 'KeyV', 'ide:preview-active-file', 'preview'],
  ['s', { ctrl: true }, 'KeyS', 'ide:save', 'save'],
];

const TWO_STEP = [
  // [second key, mods, code, id, recorded call]
  ['\\', { ctrl: true }, 'Backslash', 'ide:split-editor-down', 'splitActive'],
  ['w', { ctrl: true }, 'KeyW', 'ide:close-all-editors', 'closeAll'],
  ['s', {}, 'KeyS', 'ide:save-all', null],
  ['o', { ctrl: true }, 'KeyO', 'ide:open-folder', 'chooseRoot'],
  ['z', {}, 'KeyZ', 'ide:toggle-zen', 'toggleZen'],
  ['m', {}, 'KeyM', 'ide:change-language-mode', 'languagePicker'],
  ['v', {}, 'KeyV', 'ide:preview-to-the-side', 'preview'],
  ['s', { ctrl: true }, 'KeyS', 'ide:keyboard-shortcuts', 'helpOpen'],
];

test('every single-step chord of section 6.1 resolves to its command and runs it', () => {
  for (const [key, mods, code, id, call] of SINGLE_STEP) {
    const bundle = buildDom();
    const { handler, calls, registry } = buildKeymap({ domBundle: bundle });
    const event = { key, code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false };
    assert.deepEqual(registry.resolveChord(event, null, { activeView: 'ide', hasActiveFile: true }), { id }, `${code} ${JSON.stringify(mods)} -> ${id}`);
    const pressed = press(handler, key, mods, bundle.el('tree'), code);
    assert.equal(pressed.defaultPrevented, true, `${id} consumes the key`);
    assert.ok(calls.some((c) => c[0] === call), `${id} ran (${call}); calls: ${JSON.stringify(calls.map((c) => c[0]))}`);
  }
});

test('every two-step Ctrl+K chord resolves outside Monaco and runs on the second key', () => {
  for (const [key, mods, code, id, call] of TWO_STEP) {
    const bundle = buildDom();
    const { handler, calls, registry } = buildKeymap({ domBundle: bundle });
    const ctx = { activeView: 'ide', hasActiveFile: true };
    const first = { key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    assert.deepEqual(registry.resolveChord(first, null, ctx), { pending: 'ctrl+k' });
    const second = { key, code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false };
    assert.deepEqual(registry.resolveChord(second, 'ctrl+k', ctx), { id }, `Ctrl+K ${code} -> ${id}`);
    const prefix = press(handler, 'k', { ctrl: true }, bundle.el('tree'), 'KeyK');
    assert.equal(prefix.defaultPrevented, true, 'the prefix is held');
    press(handler, key, mods, bundle.el('tree'), code);
    if (call) assert.ok(calls.some((c) => c[0] === call), `${id} ran (${call})`);
  }
});

test('Ctrl+1..4 focus editor groups: an existing group by the ring, a missing one by splitting right', () => {
  const groups = { focused: '', live: ['', 'editor-2'] };
  const { handler, calls } = buildKeymap({
    deps: {
      editorGroups: {
        groupOfTarget: () => '',
        getElement: (id) => (groups.live.includes(id) ? {} : null),
        getFocusedGroup: () => groups.focused,
        focusNextGroup: () => { const i = groups.live.indexOf(groups.focused); groups.focused = groups.live[(i + 1) % groups.live.length]; return true; },
        splitActive: (dir) => { calls.push(['split', dir]); return true; },
      },
    },
  });
  press(handler, '2', { ctrl: true }, null, 'Digit2');
  assert.equal(groups.focused, 'editor-2', 'Ctrl+2 focuses group 2');
  press(handler, '1', { ctrl: true }, null, 'Digit1');
  assert.equal(groups.focused, '', 'Ctrl+1 focuses the primary group');
  press(handler, '3', { ctrl: true }, null, 'Digit3');
  assert.deepEqual(calls.filter((c) => c[0] === 'split'), [['split', 'right']], 'Ctrl+3 creates the next group');
});

// --- two-step chords, Monaco and the terminal -----------------------------------------

test('inside a Monaco editor Ctrl+K passes through and Monaco runs the pair', () => {
  const bundle = buildDom();
  const { handler, calls } = buildKeymap({ domBundle: bundle });
  const prefix = press(handler, 'k', { ctrl: true }, bundle.el('edInput'), 'KeyK');
  assert.equal(prefix.defaultPrevented, false, "Monaco keeps its own Ctrl+K prefix (Ctrl+K Ctrl+C still comments)");
  const second = press(handler, 'z', {}, bundle.el('edInput'), 'KeyZ');
  assert.equal(second.defaultPrevented, false, 'the dispatcher leaves the pair to the Monaco action');
  assert.equal(calls.some((c) => c[0] === 'toggleZen'), false);
});

test('a diff editor (no keymap actions) gets the Ctrl+K prefix stopped and the pair run by the dispatcher', () => {
  const bundle = buildDom();
  const { handler, calls } = buildKeymap({ domBundle: bundle });
  const prefix = press(handler, 'k', { ctrl: true }, bundle.el('diffInput'), 'KeyK');
  assert.equal(prefix.defaultPrevented, true);
  assert.equal(prefix.stopped, true, 'the diff editor never enters its own chord mode');
  press(handler, 'z', {}, bundle.el('diffInput'), 'KeyZ');
  assert.ok(calls.some((c) => c[0] === 'toggleZen'));
});

test('a pending Ctrl+K expires after 1.5 s', (t) => {
  const bundle = buildDom();
  const { handler, calls } = buildKeymap({ domBundle: bundle });
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  press(handler, 'k', { ctrl: true }, bundle.el('tree'), 'KeyK');
  now += 1600;
  const late = press(handler, 'z', {}, bundle.el('tree'), 'KeyZ');
  assert.equal(late.defaultPrevented, false);
  assert.equal(calls.some((c) => c[0] === 'toggleZen'), false, 'a late second key types normally');
});

test('the terminal keeps its readline chords and Ctrl+K; workbench chords still win there', () => {
  const bundle = buildDom();
  const { handler, calls } = buildKeymap({ domBundle: bundle });
  const term = bundle.el('term');
  for (const [key, mods, code] of [['w', { ctrl: true }, 'KeyW'], ['n', { ctrl: true }, 'KeyN'], ['g', { ctrl: true }, 'KeyG'], ['ArrowLeft', { alt: true }, 'ArrowLeft']]) {
    const event = press(handler, key, mods, term, code);
    assert.equal(event.defaultPrevented, false, `${code} goes to the shell`);
  }
  assert.equal(press(handler, 'k', { ctrl: true }, term, 'KeyK').defaultPrevented, false, "Ctrl+K is the shell's kill-line");
  const ctrlB = press(handler, 'b', { ctrl: true }, term, 'KeyB');
  assert.equal(ctrlB.defaultPrevented, true);
  assert.equal(ctrlB.stopped, true, 'the shell never receives a workbench chord');
  const ctrlBacktick = press(handler, '`', { ctrl: true }, term, 'Backquote');
  assert.ok(calls.some((c) => c[0] === 'panelClose'), 'Ctrl+` from a focused terminal hides the panel');
  assert.equal(ctrlBacktick.stopped, true);
  assert.ok(TERMINAL_PASSTHROUGH.has('ctrl+w'));
});

test('an event another listener already handled, or one off the Workspace, is left alone', () => {
  const bundle = buildDom();
  const { handler, calls, state } = buildKeymap({ domBundle: bundle });
  const handled = { key: 'b', code: 'KeyB', ctrlKey: true, target: bundle.el('edInput'), defaultPrevented: true, preventDefault() {}, stopPropagation() {} };
  handler(handled);
  assert.equal(calls.some((c) => c[0] === 'togglePrimarySide'), false, 'the global Ctrl+B already ran');
  state.ui.activeView = 'chat';
  press(handler, 'P', { ctrl: true, shift: true }, null, 'KeyP');
  assert.equal(calls.some((c) => c[0] === 'palette'), false);
});

test('Esc Esc leaves Zen Mode; a single Esc does not', (t) => {
  const bundle = buildDom();
  const { handler, zen } = buildKeymap({ domBundle: bundle });
  let now = 5000;
  t.mock.method(Date, 'now', () => now);
  zen.on = true;
  const first = press(handler, 'Escape', {}, bundle.el('edInput'));
  assert.equal(first.defaultPrevented, false, 'the first Esc still reaches Monaco (closes its widgets)');
  assert.equal(zen.on, true);
  now += 300;
  press(handler, 'Escape', {}, bundle.el('edInput'));
  assert.equal(zen.on, false, 'the second Esc within 500 ms restores the layout');
});

// --- catalog, palette rows, Monaco binder -----------------------------------------

test('the "?" catalog lists every registry binding with its chord', () => {
  const { registry, ideCommands, calls } = buildKeymap();
  const html = buildIdeShortcutsHtml(registry);
  const ids = new Set(registry.bindings().map((b) => b.id));
  for (const id of ids) {
    const label = registry.get(id).label.replace(/&/g, '&amp;');
    assert.ok(html.includes(label), `catalog lists ${id} (${label})`);
  }
  assert.match(html, /<kbd class="chat-help-overlay-kbd">F1<\/kbd>/);
  assert.match(html, /then/, 'two-step chords render their steps');
  assert.match(html, /Move line up/, 'the Monaco built-ins follow');
  ideCommands.openHelpOverlay();
  assert.ok(calls.some((c) => c[0] === 'helpOpen'));
});

// Row 82 cleanup G7: Alt+F5 / Shift+Alt+F5 walk the gutter's changes, as in VS Code.
test('G7: Alt+F5 and Shift+Alt+F5 resolve to Go to Next / Previous Change inside a repo', () => {
  const moves = [];
  const { registry } = buildKeymap({ deps: { gutterDecorations: { goToChange: (direction) => moves.push(direction) } } });
  const repoCtx = { activeView: 'ide', isRepo: true, hasActiveFile: true };
  const alt = { key: 'F5', code: 'F5', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false };
  assert.deepEqual(registry.resolveChord(alt, null, repoCtx), { id: 'ide:git-next-change' });
  assert.deepEqual(registry.resolveChord({ ...alt, shiftKey: true }, null, repoCtx), { id: 'ide:git-previous-change' });
  assert.equal(registry.resolveChord(alt, null, { ...repoCtx, isRepo: false }), null, 'outside a repo the chord is not taken');
  registry.run('ide:git-next-change', repoCtx);
  registry.run('ide:git-previous-change', repoCtx);
  assert.deepEqual(moves, [1, -1]);
});

test('palette rows carry their chord hints and section 6.2 labels', () => {
  const { ideCommands } = buildKeymap();
  const byId = Object.fromEntries(ideCommands.getCommandItems().map((row) => [row.id, row]));
  assert.equal(byId['ide:command-palette'].hint, 'Ctrl+Shift+P');
  assert.equal(byId['ide:toggle-primary-side'].label, 'View: Toggle Primary Side Bar');
  assert.equal(byId['ide:toggle-zen'].hint, 'Ctrl+K Z');
  assert.equal(byId['ide:focus-explorer'].group, 'Navigate');
  assert.ok(byId['ide:save-all'], 'slice C rows join the same registry');
  assert.ok(byId['ide:change-language-mode'], 'slice S rows join the same registry');
});

test('bindMonacoKeymap binds the two-step chords as editor actions that run the registry command', () => {
  const { registry, calls } = buildKeymap();
  const KeyCode = { KeyK: 41, KeyZ: 56, KeyW: 53, KeyS: 49, KeyO: 45, KeyM: 43, KeyV: 52, Backslash: 93 };
  const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, chord: (a, b) => (a | (b << 16)) >>> 0 };
  const monacoApi = { KeyCode, KeyMod };
  assert.equal(monacoChord('ctrl+k z', monacoApi), KeyMod.chord(2048 | 41, 56));
  assert.equal(monacoChord('ctrl+shift+p', monacoApi), null, 'single steps stay with the dispatcher');
  const actions = [];
  const count = bindMonacoKeymap(registry, { editorHost: { addEditorAction: (a) => actions.push(a) }, monacoApi, getContext: () => ({ activeView: 'ide', hasActiveFile: true }) });
  assert.equal(count, actions.length);
  const zen = actions.find((a) => a.id === 'jenny.keymap.toggle-zen');
  assert.deepEqual(zen.keybindings, [KeyMod.chord(2048 | 41, 56)]);
  assert.equal(zen.label, 'View: Toggle Zen Mode');
  zen.run();
  assert.ok(calls.some((c) => c[0] === 'toggleZen'), 'the Monaco action runs the same command');
  assert.ok(actions.every((a) => a.keybindings.every((k) => k > 0xffff)), 'only chords are bound');
});

// --- global shortcuts (picks O1, O2, O3) --------------------------------------------

function globalHarness(bundle) {
  const calls = [];
  const controller = createGlobalShortcutsController({
    windowRef: bundle.dom.window,
    documentRef: bundle.doc,
    callbacks: {
      setActiveView: (id) => calls.push(['view', id]),
      newChat: () => calls.push(['newChat']),
      togglePanel: () => { calls.push(['togglePanel']); return true; },
    },
  });
  const fire = (target, init) => {
    target.focus?.();
    const event = new bundle.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    controller.handleKeydown(Object.defineProperty(event, 'target', { value: target }));
    return event;
  };
  return { calls, fire };
}

test('O1: Ctrl+1..5 stand down inside the Workspace; Ctrl+Alt+1..5 switch views from anywhere', () => {
  const bundle = buildDom();
  const { calls, fire } = globalHarness(bundle);
  const inside = fire(bundle.el('tree'), { key: '1', code: 'Digit1', ctrlKey: true });
  assert.equal(inside.defaultPrevented, false, 'the Workspace keymap owns Ctrl+1');
  assert.deepEqual(calls, []);
  fire(bundle.doc.body, { key: '1', code: 'Digit1', ctrlKey: true });
  assert.deepEqual(calls.pop(), ['view', 'home'], 'outside the Workspace Ctrl+1 still switches views');
  const alt = fire(bundle.el('edInput'), { key: '3', code: 'Digit3', ctrlKey: true, altKey: true });
  assert.equal(alt.defaultPrevented, true);
  assert.deepEqual(calls.pop(), ['view', 'ide'], 'Ctrl+Alt+3 works even from the editor');
  fire(bundle.el('outside'), { key: '2', code: 'Digit2', ctrlKey: true, altKey: true });
  assert.deepEqual(calls.pop(), ['view', 'chat']);
});

test('O2: Ctrl+N inside the Workspace is the IDE keymap\'s; outside it is a new chat', () => {
  const bundle = buildDom();
  const { calls, fire } = globalHarness(bundle);
  fire(bundle.el('tree'), { key: 'n', code: 'KeyN', ctrlKey: true });
  assert.deepEqual(calls, []);
  fire(bundle.doc.body, { key: 'n', code: 'KeyN', ctrlKey: true });
  assert.deepEqual(calls, [['newChat']]);
});

test('Ctrl+B fires from the Workspace Monaco editor; other text fields keep it', () => {
  const bundle = buildDom();
  const { calls, fire } = globalHarness(bundle);
  const fromEditor = fire(bundle.el('edInput'), { key: 'b', code: 'KeyB', ctrlKey: true });
  assert.equal(fromEditor.defaultPrevented, true);
  assert.deepEqual(calls, [['togglePanel']]);
  fire(bundle.el('outside'), { key: 'b', code: 'KeyB', ctrlKey: true });
  assert.deepEqual(calls, [['togglePanel']], 'a textarea outside the Workspace still owns Ctrl+B');
});

// --- Zen Mode in the workbench wiring ------------------------------------------------

test('Zen Mode prunes every view from the visible layout, marks #ideShell and leaves on any reveal', () => {
  const bundle = buildDom();
  let captured = null;
  let renders = 0;
  const revealed = [];
  const wiring = createIdeWorkbenchWiring({
    getDom: () => ({ ideShell: bundle.el('ideShell') }),
    requestRender: () => { renders += 1; },
    focusEditor: () => true,
    workbenchUtils: {
      createIdeWorkbench: (opts) => {
        captured = opts;
        return { revealView: (id) => { revealed.push(id); return true; }, hostFor: () => null, isViewVisible: () => false, getActiveView: () => null, toggleViewStack() {}, collapseStackOf() {}, dispose() {} };
      },
    },
  });
  assert.equal(captured.isViewAvailable('explorer'), true);
  assert.equal(wiring.toggleZen(), true);
  assert.equal(captured.isViewAvailable('explorer'), false, 'views drop out of the visible layout');
  assert.equal(bundle.el('ideShell').getAttribute('data-ide-zen'), 'true');
  assert.equal(wiring.isZen(), true);
  assert.ok(renders >= 1);
  wiring.showPanel('search', { focus: true });
  assert.equal(wiring.isZen(), false, 'revealing a view leaves Zen Mode');
  assert.equal(bundle.el('ideShell').hasAttribute('data-ide-zen'), false);
  assert.deepEqual(revealed, ['search']);
  wiring.toggleZen();
  assert.equal(wiring.togglePrimarySide(), true);
  assert.equal(wiring.isZen(), false, 'Ctrl+B in Zen Mode brings the layout back');
});

test('Ctrl+Alt+B falls through while the chat dock flag is disabled and binds after hydration (O3)', () => {
  let enabled = false;
  let toggles = 0;
  const splits = [];
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    chatDock: { toggle: () => { toggles += 1; } },
    isChatDockEnabled: () => enabled,
    editorHost: { getMonaco: () => ({}) },
    editorGroups: { splitActive: (dir) => splits.push(dir), groupOfTarget: () => '' },
  });

  const disabledEvent = press(handler, 'b', { ctrl: true, alt: true });
  assert.equal(disabledEvent.defaultPrevented, false, 'flag-off does not consume the shortcut');
  assert.equal(toggles, 0);

  enabled = true;
  const enabledEvent = press(handler, 'b', { ctrl: true, alt: true });
  assert.equal(enabledEvent.defaultPrevented, true, 'late flag hydration enables the shortcut');
  assert.equal(toggles, 1);

  press(handler, '\\', { ctrl: true });
  assert.deepEqual(splits, ['right'], 'Ctrl+\\ is Split Editor Right now');
  assert.equal(toggles, 1, 'and no longer toggles the chat');
});
