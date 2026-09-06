'use strict';

// Coverage for renderer/features/renderer-ide-active-file-context.js — the
// explicit one-send active-file capture module + transparent composer chip. Direct
// JSDOM, injected deps; no full IDE harness (the module is controller-free).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createActiveFileContextController,
  computeActiveSlice,
  forwardClientLog,
} = require('../renderer/features/renderer-ide-active-file-context');
const actionButton = require('../renderer/inventory/action-button');

function buildDom() {
  return new JSDOM(
    '<!doctype html><html><body><div id="composerWrap"></div><div id="composerActiveFileActionHost" class="hidden"></div></body></html>',
    { url: 'https://jenny.local/' }
  );
}

// A mutable fake of the editor host's window reader.
function makeReader(initial) {
  const state = Object.assign({
    path: 'renderer/foo.js',
    kind: 'file',
    cursor: { lineNumber: 2, column: 1, selectedChars: 0 },
    value: 'line1\nline2\nline3',
    languageId: 'javascript',
  }, initial || {});
  return {
    state,
    getActivePath: () => state.path,
    getDocumentKind: () => state.kind,
    getCursorInfo: () => state.cursor,
    getValue: () => state.value,
    getActiveLanguageId: () => state.languageId,
  };
}

function makeController(dom, { enabled = true, reader } = {}) {
  const win = dom.window;
  const doc = win.document;
  const r = reader || makeReader();
  const controller = createActiveFileContextController({
    document: doc,
    window: win,
    getComposerWrap: () => doc.getElementById('composerWrap'),
    getReader: () => r,
    actionButton,
    isEnabled: () => enabled,
  });
  return { controller, win, doc, reader: r };
}

function dispatchActive(win, path) {
  win.dispatchEvent(new win.CustomEvent('ide:active-file-changed', { detail: { path } }));
}

function chip(doc) {
  return doc.getElementById('activeFileContextChip');
}

function clickActiveFileArm(doc) {
  doc.querySelector('[data-active-file-arm]').click();
}

test('computeActiveSlice bounds the slice around the cursor and skips non-file docs', () => {
  const reader = makeReader({ value: Array.from({ length: 300 }, (_, i) => `L${i + 1}`).join('\n'), cursor: { lineNumber: 100, column: 1 } });
  const info = computeActiveSlice(reader, 10);
  assert.equal(info.path, 'renderer/foo.js');
  assert.equal(info.startLine, 90);
  assert.equal(info.endLine, 110);
  assert.equal(info.totalLines, 300);

  reader.state.kind = 'image';
  assert.equal(computeActiveSlice(reader, 10), null);
});

test('computeActiveSlice keeps a wide-line cursor inside the character budget and reports the included lines', () => {
  const lines = Array.from({ length: 1100 }, (_, index) => `LINE-${index + 1}-${'x'.repeat(190)}`);
  const info = computeActiveSlice(makeReader({
    value: lines.join('\n'),
    cursor: { lineNumber: 1000, column: 1 },
  }), 60);

  assert.ok(info.slice.includes('LINE-1000-'), 'the cursor line remains inside the capped slice');
  assert.equal(info.slice.length, 8000);
  assert.equal(info.endLine - info.startLine, (info.slice.match(/\n/g) || []).length);
  assert.ok(info.startLine <= 1000 && info.endLine >= 1000, 'reported lines contain the cursor');
});

test('an activation offers an explicit action and does not arm the file by default', () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();
  dispatchActive(win, 'renderer/foo.js');

  const host = doc.getElementById('composerActiveFileActionHost');
  assert.equal(host.classList.contains('hidden'), false);
  assert.match(host.textContent, /Add Active File/);
  assert.match(host.textContent, /foo\.js/);
  assert.equal(chip(doc), null, 'sharing chip is absent until explicit opt-in');
  assert.equal(controller.readActiveFileContextForTurn({}), null);

  host.querySelector('[data-active-file-arm]').click();
  const el = chip(doc);
  assert.ok(el, 'chip mounted');
  assert.equal(el.classList.contains('hidden'), false);
  assert.match(el.querySelector('.active-file-context-chip-label').textContent, /Jenny can see foo\.js/);
  const dismiss = el.querySelector('[data-active-file-dismiss]');
  assert.ok(dismiss, 'dismiss control present (inventory button)');
  assert.equal(dismiss.title, 'Stop sharing the active file with Jenny');
});

test('readActiveFileContextForTurn returns the live slice and dedupes', () => {
  const dom = buildDom();
  const { controller, doc } = makeController(dom);
  controller.attach();
  clickActiveFileArm(doc);

  const info = controller.readActiveFileContextForTurn({});
  assert.ok(info);
  assert.equal(info.path, 'renderer/foo.js');

  // Already @-mentioned -> send once -> null.
  assert.equal(controller.readActiveFileContextForTurn({ mentionedPaths: ['renderer/foo.js'] }), null);
  // Already attached (absolute path ending with the workspace-relative path) -> null.
  assert.equal(
    controller.readActiveFileContextForTurn({ attachedPaths: ['C:/Projects/jenny/renderer/foo.js'] }),
    null
  );
  // A same-basename-but-different-dir attachment does NOT dedupe.
  assert.ok(controller.readActiveFileContextForTurn({ attachedPaths: ['C:/other/bbfoo.js'] }));
  // Text attachments carry only a display name (no path); a basename match dedupes.
  assert.equal(controller.readActiveFileContextForTurn({ attachedNames: ['foo.js'] }), null);
  // A non-matching attachment name leaves the slice intact.
  assert.ok(controller.readActiveFileContextForTurn({ attachedNames: ['other.js'] }));
});

test('dismissing disarms and switching files never transfers consent', () => {
  const dom = buildDom();
  const { controller, win, doc, reader } = makeController(dom);
  controller.attach();
  dispatchActive(win, 'renderer/foo.js');
  clickActiveFileArm(doc);

  chip(doc).querySelector('[data-active-file-dismiss]').click();
  assert.equal(chip(doc).classList.contains('hidden'), true, 'chip hidden after dismiss');
  assert.equal(controller.readActiveFileContextForTurn({}), null, 'dismissed file is not sent');

  // Switching files offers the new file, but does not arm it.
  reader.state.path = 'renderer/bar.js';
  dispatchActive(win, 'renderer/bar.js');
  assert.equal(chip(doc).classList.contains('hidden'), true, 'chip stays hidden for the new file');
  assert.equal(controller.readActiveFileContextForTurn({}), null);
  assert.match(doc.getElementById('composerActiveFileActionHost').textContent, /bar\.js/);
});

test('accepted-send clearing is path-bound and preserves consent on mismatched failures', () => {
  const dom = buildDom();
  const { controller, doc } = makeController(dom);
  controller.attach();
  clickActiveFileArm(doc);
  assert.equal(controller.markTurnAccepted('renderer/other.js'), false);
  assert.ok(controller.readActiveFileContextForTurn({}), 'mismatched acceptance cannot consume consent');
  assert.equal(controller.markTurnAccepted('renderer/foo.js'), true);
  assert.equal(controller.readActiveFileContextForTurn({}), null);
  assert.equal(chip(doc).classList.contains('hidden'), true);
});

test('JCA-005: consent never transfers to the same relative path in another workspace root', () => {
  // Arm README-like consent under root A, commit root B whose restored tab has
  // the SAME relative path: the live reader still reports 'renderer/foo.js',
  // but the consent was granted for root A's file and must be cleared by the
  // committed root transition (broadcast on the window by the IDE controller).
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();
  clickActiveFileArm(doc);
  assert.ok(controller.readActiveFileContextForTurn({}), 'armed under root A');

  win.dispatchEvent(new win.CustomEvent('ide:workspace-root-committed', {
    detail: { context: { root_path: 'G:/root-b', root_id: 'root-b', generation: 2 } },
  }));

  assert.equal(controller.readActiveFileContextForTurn({}), null,
    'a root-B same-relative-path file is not sent under root-A consent');
  const el = chip(doc);
  assert.ok(!el || el.classList.contains('hidden'), 'the sharing chip is gone after the transition');
});

test('with the flag off the module is inert: no chip, no context', () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom, { enabled: false });
  controller.attach();
  dispatchActive(win, 'renderer/foo.js');

  assert.equal(chip(doc), null, 'no chip rendered when disabled');
  assert.equal(doc.getElementById('composerActiveFileActionHost').classList.contains('hidden'), true);
  assert.equal(controller.readActiveFileContextForTurn({}), null);
});

// ── Large-file guard (Deliverable 2) + token-cost chip (Deliverable 3) ──

test('computeActiveSlice excludes a too-large file and never reads its value', () => {
  let getValueCalls = 0;
  const reader = {
    ...makeReader(),
    isLargeFile: () => true,
    getValue: () => { getValueCalls += 1; return 'x'; },
  };
  assert.equal(computeActiveSlice(reader, 10), null, 'too-large file is excluded');
  assert.equal(getValueCalls, 0, 'getValue is short-circuited for a huge file');
});

test('the chip shows an approximate token-cost indicator', () => {
  const dom = buildDom();
  const { controller, win, doc } = makeController(dom);
  controller.attach();
  dispatchActive(win, 'renderer/foo.js');
  clickActiveFileArm(doc);

  const budget = chip(doc).querySelector('.active-file-context-chip-budget');
  assert.ok(budget, 'budget span rendered');
  assert.match(budget.textContent, /~\d+ tokens/);
});

test('the chip recomputes the slice on every refresh (no stale cache)', () => {
  const dom = buildDom();
  let getValueCalls = 0;
  const reader = {
    ...makeReader(),
    getValue: () => { getValueCalls += 1; return 'line1\nline2\nline3'; },
  };
  const { controller, win } = makeController(dom, { reader });
  controller.attach(); // attach() calls refreshChip once -> first compute
  assert.equal(getValueCalls, 1, 'computed once on attach');
  // No cache: every refresh/activation recomputes so the token count is always
  // fresh (an in-place edit changes the value with no activation event).
  controller.refreshChip();
  controller.refreshChip();
  assert.equal(getValueCalls, 3, 'recomputed on each refresh');
  dispatchActive(win, 'renderer/foo.js');
  assert.equal(getValueCalls, 4, 'recomputed on activation too');
});

test('the token-cost label refreshes after an in-place edit (composer focus)', () => {
  const dom = buildDom();
  const reader = makeReader();
  const { controller, win, doc } = makeController(dom, { reader });
  controller.attach();
  dispatchActive(win, 'renderer/foo.js');
  clickActiveFileArm(doc);
  const before = chip(doc).querySelector('.active-file-context-chip-budget').textContent;

  // Simulate an in-place edit: the active file grows but the editor host fires
  // no activation event for an edit, so only a composer-focus refresh can catch it.
  reader.state.value = Array.from({ length: 200 }, (_, i) => `grown line ${i + 1}`).join('\n');

  const wrap = doc.getElementById('composerWrap');
  wrap.dispatchEvent(new win.Event('focusin', { bubbles: true }));

  const after = chip(doc).querySelector('.active-file-context-chip-budget').textContent;
  assert.notEqual(after, before, 'token-cost label recomputed after the edit (cache dropped on focus)');
});

test('the chip stays hidden for a too-large file (never claims Jenny can see it)', () => {
  const dom = buildDom();
  const reader = { ...makeReader(), isLargeFile: () => true };
  const { controller, win, doc } = makeController(dom, { reader });
  controller.attach();
  dispatchActive(win, 'renderer/foo.js');

  const el = chip(doc);
  assert.ok(!el || el.classList.contains('hidden'), 'no visible chip for a too-large file');
  assert.equal(controller.readActiveFileContextForTurn({}), null, 'and nothing is sent');
});

test('installed appendClientLog forwards to logs.clientAppend, not the dead logs.append', () => {
  // The self-install closure logged via root.jennyShell.logs.append, a bridge
  // method that never existed — 100% of this feature's telemetry was silently
  // dropped. It must route through logs.clientAppend as a { entries,
  // dropped_count } batch instead.
  const clientBatches = [];
  const appendCalls = [];
  const root = {
    jennyShell: {
      logs: {
        append: (...args) => appendCalls.push(args),
        clientAppend: (batch) => clientBatches.push(batch),
      },
    },
  };

  forwardClientLog(root, 'INFO', 'chat.active_file_context_dismissed', { file_name: 'foo.js' });

  assert.equal(appendCalls.length, 0, 'the nonexistent logs.append path is never used');
  assert.equal(clientBatches.length, 1);
  const batch = clientBatches[0];
  assert.equal(batch.dropped_count, 0);
  assert.equal(batch.entries.length, 1);
  const entry = batch.entries[0];
  assert.equal(entry.event, 'chat.active_file_context_dismissed');
  assert.equal(entry.source, 'renderer');
  assert.equal(entry.component, 'renderer.ide.active_file');
  assert.deepEqual(entry.data, { file_name: 'foo.js' });
});

test('appendClientLog forwarding never resurrects logs.append and is a safe no-op without clientAppend', () => {
  const appendCalls = [];
  const root = { jennyShell: { logs: { append: (...args) => appendCalls.push(args) } } };
  assert.doesNotThrow(() => forwardClientLog(root, 'INFO', 'chat.active_file_context_dismissed', { path: 'x' }));
  assert.equal(appendCalls.length, 0, 'must not fall back to the dead logs.append path');
  assert.doesNotThrow(() => forwardClientLog(null, 'INFO', 'x', {}));
});
