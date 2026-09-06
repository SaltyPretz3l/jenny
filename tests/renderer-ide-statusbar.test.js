'use strict';

/* W4 editor chrome: bottom status bar (Ln/Col, wrap toggle, EOL, language,
 * dirty dot) and the breadcrumb STRIP rendering (the navigable click behavior
 * lives in renderer-ide-breadcrumbs.test.js). Runs on the shared jsdom harness's
 * fallback-textarea editor path. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createHarness,
  settle,
} = require('./helpers/renderer-ide-harness');
const { createIdeStatusBar } = require('../renderer/features/renderer-ide-statusbar');

test('status bar and breadcrumbs render for the active file', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/deep/util.js': 'const x = 1;\nconst y = 2;' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const statusBar = harness.getDom().ideStatusBar;
  const breadcrumbs = harness.getDom().ideBreadcrumbs;
  assert.equal(statusBar.classList.contains('hidden'), true, 'hidden with no open tab');
  assert.equal(breadcrumbs.classList.contains('hidden'), true);

  await harness.controller.openFile('src/deep/util.js');
  await settle();
  assert.equal(statusBar.classList.contains('hidden'), false);
  // jsdom leaves the textarea caret at the buffer end after value assignment.
  assert.match(statusBar.textContent, /Ln 2, Col 13/);
  assert.match(statusBar.textContent, /Wrap: Off/);
  assert.match(statusBar.textContent, /Spaces: 2/);
  assert.match(statusBar.textContent, /LF/);
  assert.match(statusBar.textContent, /plaintext/);

  const crumbLabels = [...breadcrumbs.querySelectorAll('.ide-crumb')]
    .map((crumb) => crumb.textContent);
  assert.deepEqual(crumbLabels, ['src', 'deep', 'util.js']);
  // Ancestors are interactive; the leaf is a plain span.
  assert.equal(breadcrumbs.querySelectorAll('[data-ide-crumb-path]').length, 2);
  assert.ok(breadcrumbs.querySelector('.ide-crumb--leaf'));
});

test('wrap toggle flips persisted wordWrap and the label', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': 'hi' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.txt');
  await settle();
  const statusBar = harness.getDom().ideStatusBar;
  statusBar.querySelector('[data-ide-status-action="toggle-wrap"]').click();
  await settle();
  assert.equal(harness.state.ui.ide.wordWrap, 'on');
  assert.match(statusBar.textContent, /Wrap: On/);
  assert.equal(harness.bridge.calls.updateSettings.at(-1).wordWrap, 'on');
});

test('the leaf crumb is a button that opens its symbol outline (data-ide-crumb-leaf)', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/deep/util.js': 'const x = 1;\n' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('src/deep/util.js');
  await settle();
  const breadcrumbs = harness.getDom().ideBreadcrumbs;
  // Ancestors carry data-ide-crumb-path; the leaf now carries data-ide-crumb-leaf
  // with the FULL file path (so the nav module can target the active file).
  assert.equal(breadcrumbs.querySelectorAll('[data-ide-crumb-path]').length, 2);
  const leaf = breadcrumbs.querySelector('[data-ide-crumb-leaf]');
  assert.ok(leaf, 'leaf is an interactive crumb');
  assert.equal(leaf.dataset.ideCrumbLeaf, 'src/deep/util.js');
  assert.ok(leaf.classList.contains('ide-crumb--leaf'));
  assert.equal(leaf.getAttribute('aria-haspopup'), 'listbox');
});

test('dirty edits show the status dot and update Ln/Col after typing', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': 'one\ntwo' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.txt');
  await settle();
  const textarea = harness.getDom().ideEditorFallback;
  textarea.value = 'one\ntwo\nthree';
  textarea.selectionStart = textarea.value.length;
  textarea.selectionEnd = textarea.value.length;
  textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  await settle();
  const statusBar = harness.getDom().ideStatusBar;
  assert.ok(statusBar.querySelector('.ide-statusbar-dirty'), 'dirty dot shown');
  assert.match(statusBar.textContent, /Ln 3, Col 6/);
});

test('the bottom-panel toggle is always present and reflects + flips the open state', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': 'hi' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.txt');
  await settle();
  const statusBar = harness.getDom().ideStatusBar;
  const toggle = statusBar.querySelector('[data-ide-status-action="toggle-panel"]');
  assert.ok(toggle, 'panel toggle renders even with no diagnostics');
  assert.ok(toggle.querySelector('svg'), 'inline panel glyph is present (CSP-safe)');
  assert.equal(harness.state.ui.ide.bottomPanelOpen, false);
  assert.equal(toggle.classList.contains('ide-statusbar-action--active'), false, 'inactive while collapsed');

  // Clicking opens the panel; the statusbar re-renders so the pressed state tracks it.
  toggle.click();
  await settle();
  assert.equal(harness.state.ui.ide.bottomPanelOpen, true, 'toggle opens the bottom panel');
  const toggleOpen = harness.getDom().ideStatusBar.querySelector('[data-ide-status-action="toggle-panel"]');
  assert.equal(toggleOpen.classList.contains('ide-statusbar-action--active'), true, 'active while open');

  toggleOpen.click();
  await settle();
  assert.equal(harness.state.ui.ide.bottomPanelOpen, false, 'toggle collapses it again');
});

test('the inline-suggestions toggle appears only behind the flag and flips the persisted state', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': 'hi' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.txt');
  await settle();
  const statusBar = harness.getDom().ideStatusBar;
  // Default (flag off): no inline-suggest toggle in the status bar.
  assert.equal(statusBar.querySelector('[data-ide-status-action="toggle-inline-suggest"]'), null);

  // Turn the feature flag on; the status bar re-renders the toggle on next render.
  harness.state.features = { featureFlags: { workspace_inline_suggest: true } };
  await harness.controller.openFile('a.txt'); // re-activates + re-renders the status bar
  await settle();
  const toggle = statusBar.querySelector('[data-ide-status-action="toggle-inline-suggest"]');
  assert.ok(toggle, 'toggle renders when the flag is on');
  assert.ok(toggle.querySelector('svg'), 'inline-suggest glyph is present (CSP-safe)');
  // Defaults to enabled (the per-user quick toggle starts on).
  assert.equal(toggle.classList.contains('ide-statusbar-action--active'), true);

  toggle.click();
  await settle();
  assert.equal(harness.state.ui.ide.inlineSuggestEnabled, false, 'click disables suggestions');
  const after = statusBar.querySelector('[data-ide-status-action="toggle-inline-suggest"]');
  assert.equal(after.classList.contains('ide-statusbar-action--active'), false, 'inactive after turning off');
  assert.equal(harness.bridge.calls.updateSettings.at(-1).inlineSuggestEnabled, false, 'persisted off');
});

test('the inline-suggest caret opens the completion-model menu without flipping the toggle', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': 'hi' } } });
  t.after(() => harness.dispose());
  harness.state.features = { featureFlags: { workspace_inline_suggest: true } };
  await harness.controller.activateIde();
  await harness.controller.openFile('a.txt');
  await settle();
  const dom = harness.getDom();
  const statusBar = dom.ideStatusBar;

  const caret = statusBar.querySelector('[data-ide-status-action="inline-suggest-menu"]');
  assert.ok(caret, 'the menu caret renders beside the toggle when the flag is on');
  assert.equal(caret.getAttribute('aria-haspopup'), 'dialog', 'caret advertises a dialog popup');

  const enabledBefore = harness.state.ui.ide.inlineSuggestEnabled;
  caret.click();
  await settle();
  // Clicking the caret opens the menu; it must NOT toggle on/off (that is the
  // adjacent button's job).
  assert.equal(harness.state.ui.ide.inlineSuggestEnabled, enabledBefore, 'caret does not flip enabled state');
  const popover = dom.ideShell.querySelector('.ide-fim-popover');
  assert.ok(popover && popover.hidden === false, 'the completion-model menu opens on the shell');
});

test('status bar shows the git branch + dirty count from the store and opens the branch switcher', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'a.txt': 'hi' },
      git: { branch: 'feature/x', files: [{ path: 'a.txt', worktree: 'M', state: 'modified' }] },
    },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.txt');
  await settle(250); // let the debounced git status refresh land

  const seg = harness.getDom().ideStatusBar.querySelector('.ide-statusbar-branch');
  assert.ok(seg, 'branch chip renders from the git store');
  assert.match(seg.textContent, /feature\/x/);
  assert.match(seg.textContent, /●1/, 'live dirty count');
  assert.ok(seg.querySelector('svg'), 'inline branch glyph is present (CSP-safe)');
  assert.equal(seg, harness.getDom().ideStatusBar.firstChild, 'branch is the left-most segment');

  // Clicking the chip opens the branch switcher Quick-pick over the editor stage.
  seg.click();
  await settle();
  const picker = harness.getDom().ideEditorStage.querySelector('[data-ide-branch-picker]');
  assert.ok(picker, 'branch switcher overlay opens');
  assert.equal(picker.classList.contains('hidden'), false, 'switcher is visible');
});

test('status bar hides the branch chip when the workspace is not a git repo', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': 'hi' } } }); // no git -> available:false
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.txt');
  await settle(250);
  assert.equal(harness.getDom().ideStatusBar.querySelector('.ide-statusbar-branch'), null);
});

test('the inline-suggest group shows a warn marker when FIM is degraded', () => {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  try {
    const doc = dom.window.document;
    let degraded = true;
    const ide = { activeTabPath: 'a.js', wordWrap: 'off' };
    const statusBar = createIdeStatusBar({
      getDom: () => ({ ideStatusBar: doc.getElementById('sb'), ideBreadcrumbs: null }),
      getIde: () => ide,
      callbacks: {
        getCursorInfo: () => ({ lineNumber: 1, column: 1, selectedChars: 0 }),
        getActiveLanguageId: () => 'javascript',
        getDocumentKind: () => 'file',
        isDiffTab: () => false,
        getInlineSuggestVisible: () => true,
        getInlineSuggestEnabled: () => true,
        getInlineSuggestDegraded: () => degraded,
        getInlineSuggestComputeStatus: () => ({
          target: 'automatic', reason: 'Selected from live runtime resources.',
        }),
      },
    });
    statusBar.render();
    const warn = doc.getElementById('sb').querySelector('.ide-statusbar-inline-suggest-warn');
    assert.ok(warn, 'warn marker rendered while FIM is degraded');
    assert.ok(warn.querySelector('svg'), 'warn uses an inline (CSP-safe) glyph');
    assert.match(warn.getAttribute('aria-label') || '', /unavailable/i);
    // The toggle button title also reflects the degraded state on hover.
    const toggle = doc.getElementById('sb').querySelector('[data-ide-status-action="toggle-inline-suggest"]');
    assert.match(toggle.getAttribute('title') || '', /unavailable/i);

    // Healthy again -> the warn marker disappears.
    degraded = false;
    statusBar.render();
    assert.equal(
      doc.getElementById('sb').querySelector('.ide-statusbar-inline-suggest-warn'),
      null,
      'no warn marker when FIM is healthy'
    );
    assert.match(
      doc.getElementById('sb').querySelector('[data-ide-status-action="toggle-inline-suggest"]').title,
      /Compute: automatic.*live runtime resources/
    );
  } finally {
    globalThis.window = prevWindow;
  }
});

test('paused inline suggestions use a distinct info glyph while degraded takes precedence', () => {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  try {
    const doc = dom.window.document;
    let paused = true;
    let degraded = false;
    const statusBar = createIdeStatusBar({
      getDom: () => ({ ideStatusBar: doc.getElementById('sb'), ideBreadcrumbs: null }),
      getIde: () => ({ activeTabPath: 'a.js', wordWrap: 'off' }),
      callbacks: {
        getCursorInfo: () => ({ lineNumber: 1, column: 1, selectedChars: 0 }),
        getDocumentKind: () => 'file',
        isDiffTab: () => false,
        getInlineSuggestVisible: () => true,
        getInlineSuggestEnabled: () => true,
        getInlineSuggestPaused: () => paused,
        getInlineSuggestDegraded: () => degraded,
      },
    });
    statusBar.render();

    const marker = doc.querySelector('.ide-statusbar-inline-suggest-warn');
    const title = 'Inline suggestions paused while chat is responding.';
    assert.equal(marker.dataset.diagSeverity, 'info');
    assert.equal(marker.title, title);
    assert.equal(marker.querySelectorAll('rect').length, 2, 'paused uses the pause glyph');
    assert.equal(doc.querySelector('[data-ide-status-action="toggle-inline-suggest"]').title, title);

    degraded = true;
    statusBar.render();
    assert.equal(doc.querySelector('.ide-statusbar-inline-suggest-warn').dataset.diagSeverity, 'warning');
    assert.match(doc.querySelector('[data-ide-status-action="toggle-inline-suggest"]').title, /unavailable/i);
    assert.equal(doc.querySelector('.ide-statusbar-inline-suggest-warn rect'), null, 'degraded restores the warning glyph');
  } finally {
    globalThis.window = prevWindow;
  }
});

test('no warn marker when suggestions are disabled even if degraded', () => {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  try {
    const doc = dom.window.document;
    const ide = { activeTabPath: 'a.js', wordWrap: 'off' };
    const statusBar = createIdeStatusBar({
      getDom: () => ({ ideStatusBar: doc.getElementById('sb'), ideBreadcrumbs: null }),
      getIde: () => ide,
      callbacks: {
        getCursorInfo: () => ({ lineNumber: 1, column: 1, selectedChars: 0 }),
        getActiveLanguageId: () => 'javascript',
        getDocumentKind: () => 'file',
        isDiffTab: () => false,
        getInlineSuggestVisible: () => true,
        getInlineSuggestEnabled: () => false, // user turned suggestions off
        getInlineSuggestDegraded: () => true,
      },
    });
    statusBar.render();
    assert.equal(
      doc.getElementById('sb').querySelector('.ide-statusbar-inline-suggest-warn'),
      null,
      'a backend warn is irrelevant when the user has suggestions off'
    );
  } finally {
    globalThis.window = prevWindow;
  }
});

test('status bar explains when large-file policy overrides the minimap preference', () => {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  try {
    const statusBar = createIdeStatusBar({
      getDom: () => ({ ideStatusBar: dom.window.document.getElementById('sb'), ideBreadcrumbs: null }),
      getIde: () => ({ activeTabPath: 'large.js', wordWrap: 'off' }),
      callbacks: {
        getDocumentKind: () => 'file',
        isLargeFile: () => true,
      },
    });
    statusBar.render();
    const note = dom.window.document.querySelector('.ide-statusbar-effective-note');
    assert.equal(note.textContent, 'Minimap: Off (large file)');
    assert.match(note.title, /protect editor performance/);
  } finally {
    globalThis.window = prevWindow;
  }
});

test('the run indicator shows while a task runs and its kill button fires onKillRun', () => {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  try {
    const doc = dom.window.document;
    let running = true;
    let killed = 0;
    const ide = { activeTabPath: 'a.js', wordWrap: 'off' };
    const statusBar = createIdeStatusBar({
      getDom: () => ({ ideStatusBar: doc.getElementById('sb'), ideBreadcrumbs: null }),
      getIde: () => ide,
      callbacks: {
        getCursorInfo: () => ({ lineNumber: 1, column: 1, selectedChars: 0 }),
        getActiveLanguageId: () => 'javascript',
        getRunning: () => running,
        onKillRun: () => { killed += 1; },
        getDocumentKind: () => 'file',
        isDiffTab: () => false,
      },
    });
    statusBar.bindEvents();
    statusBar.render();
    const chip = doc.getElementById('sb').querySelector('.ide-statusbar-run');
    assert.ok(chip, 'run chip rendered while a task is running');
    assert.match(chip.textContent, /Running/);
    const kill = doc.getElementById('sb').querySelector('[data-ide-status-action="kill-run"]');
    assert.ok(kill, 'kill button present');
    assert.ok(kill.querySelector('svg'), 'kill uses an inline (CSP-safe) glyph');
    kill.click();
    assert.equal(killed, 1, 'kill button fires onKillRun');
    // Once the task ends the chip disappears.
    running = false;
    statusBar.render();
    assert.equal(doc.getElementById('sb').querySelector('.ide-statusbar-run'), null, 'chip hidden when idle');
  } finally {
    globalThis.window = prevWindow;
  }
});
