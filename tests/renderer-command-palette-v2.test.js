'use strict';

/* Command palette V2 (docs/plans/COMMAND_PALETTE_REDESIGN_SPEC.md).
 *
 * Covers the findings the redesign fixes, each named by its spec id:
 *   C1  sessions were sliced to 8 BEFORE filtering
 *   C2  grouping re-bucketed the score-sorted list and destroyed the ranking
 *   C3  hover painted a second "selected" row the keyboard index disagreed with
 *   C4  aria-live sat on the listbox and re-announced every option per keystroke
 *   C6  Ctrl+K stole Monaco's chord prefix
 *   C7  a blocked open still swallowed the keystroke
 *   C10 the greedy scan never preferred a word-boundary start
 *   B6  scope machine (Tab / prefix / Backspace / Escape)
 *   B8  Settings provider
 *   P2  rows are reused across renders instead of rebuilt
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const paletteUtils = require('../renderer/shell/renderer-command-palette.js');
const { createCommandPaletteController, scoreMatch } = paletteUtils;

function buildPaletteDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="commandPaletteOverlay" class="hidden">'
    + '<div class="command-palette-scrim"></div>'
    + '<div class="command-palette-dialog">'
    + '<div class="command-palette-field">'
    + '<span id="commandPaletteFieldIcon"></span>'
    + '<span id="commandPaletteScope" class="hidden"></span>'
    + '<input id="commandPaletteInput" role="combobox" aria-expanded="false" />'
    + '</div>'
    + '<div id="commandPaletteList" role="listbox"></div>'
    + '<div class="command-palette-footer">'
    + '<span id="commandPaletteCount"></span><span id="commandPaletteLegend"></span>'
    + '</div>'
    + '<div id="commandPaletteStatus" role="status" aria-live="polite"></div>'
    + '</div></div>'
    + '<div class="monaco-editor"><textarea id="editorInput"></textarea></div>'
    + '</body></html>');
  const doc = dom.window.document;
  const pick = (id) => doc.getElementById(id);
  return {
    dom,
    doc,
    dialogDom: {
      commandPaletteOverlay: pick('commandPaletteOverlay'),
      commandPaletteInput: pick('commandPaletteInput'),
      commandPaletteList: pick('commandPaletteList'),
      commandPaletteScope: pick('commandPaletteScope'),
      commandPaletteCount: pick('commandPaletteCount'),
      commandPaletteLegend: pick('commandPaletteLegend'),
      commandPaletteStatus: pick('commandPaletteStatus'),
      commandPaletteFieldIcon: pick('commandPaletteFieldIcon'),
    },
  };
}

function buildState(overrides) {
  return Object.assign({
    ui: {},
    auth: { authenticated: true },
    sessions: [],
    features: { featureFlags: { command_palette: true } },
  }, overrides || {});
}

// The controller resolves documentRef off the ambient global, so the test
// document must BE the ambient one for listeners and focus bookkeeping to work
// (same pattern as tests/renderer-command-palette-uiux-020.test.js).
function withGlobalDocument(doc, fn) {
  const previousDocument = global.document;
  global.document = doc;
  try {
    return fn();
  } finally {
    global.document = previousDocument;
  }
}

function typeQuery(doc, input, value) {
  input.value = value;
  input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
}

function keydown(doc, target, key, init) {
  const event = new doc.defaultView.KeyboardEvent('keydown', Object.assign({
    key, bubbles: true, cancelable: true,
  }, init || {}));
  target.dispatchEvent(event);
  return event;
}

function rowsOf(listEl) {
  return [...listEl.querySelectorAll('.command-palette-item')];
}

function rowText(row) {
  return row.textContent.replace(/\s+/g, ' ').trim();
}

/* ── C1: every loaded chat is searchable, not just the eight most recent ── */

test('C1: a session outside the eight most recent is findable by title', () => {
  const { doc, dialogDom } = buildPaletteDom();
  const sessions = [];
  for (let i = 0; i < 20; i += 1) {
    sessions.push({
      id: 'session-' + i,
      title: 'Recent chat ' + i,
      updated_at: '2026-08-' + String(20 - i).padStart(2, '0') + 'T00:00:00Z',
      last_message_preview: '',
    });
  }
  // 15 sessions deep — comfortably past the old slice(0, 8).
  sessions[15].title = 'Zircon telemetry postmortem';

  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState({ sessions }),
      dom: dialogDom,
    });
    controller.bind();
    controller.open();
    typeQuery(doc, dialogDom.commandPaletteInput, 'zircon');

    const labels = rowsOf(dialogDom.commandPaletteList).map(rowText);
    assert.ok(
      labels.some((text) => text.includes('Zircon telemetry postmortem')),
      'a chat past the eighth most recent must still be reachable by title, got: ' + JSON.stringify(labels)
    );
  });
});

/* ── C2: one flat globally ranked list, not group-bucketed ── */

test('C2: a stronger match outranks a weaker one from a higher-scoring group', () => {
  const { doc, dialogDom } = buildPaletteDom();
  // "Archive current chat" (an Action, exact prefix on the label) must beat a
  // Session that merely mentions "archive" in its preview. Under the old
  // re-bucketing the whole Sessions group rode up on its best member.
  const sessions = [
    { id: 's1', title: 'Archive', updated_at: '2026-08-20T00:00:00Z', last_message_preview: '' },
    { id: 's2', title: 'Unrelated thread', updated_at: '2026-08-19T00:00:00Z', last_message_preview: 'archive notes' },
    { id: 's3', title: 'Another thread', updated_at: '2026-08-18T00:00:00Z', last_message_preview: 'archive plan' },
  ];
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState({ sessions, currentSessionId: 's1' }),
      dom: dialogDom,
    });
    controller.bind();
    controller.open();
    typeQuery(doc, dialogDom.commandPaletteInput, 'archive');

    const texts = rowsOf(dialogDom.commandPaletteList).map(rowText);
    const actionAt = texts.findIndex((text) => text.startsWith('Archive current chat'));
    const weakSessionAt = texts.findIndex((text) => text.startsWith('Unrelated thread'));
    assert.ok(actionAt >= 0, 'expected the Archive action row, got: ' + JSON.stringify(texts));
    assert.ok(weakSessionAt >= 0, 'expected the weak session row, got: ' + JSON.stringify(texts));
    assert.ok(
      actionAt < weakSessionAt,
      'a label-prefix match must outrank a description-only match from another group: ' + JSON.stringify(texts)
    );
  });
});

test('C2: group labels appear with no query and disappear once ranking applies', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: dialogDom,
    });
    controller.bind();
    controller.open();
    assert.ok(
      dialogDom.commandPaletteList.querySelectorAll('.command-palette-group-label').length > 0,
      'the no-query landing view is grouped'
    );
    typeQuery(doc, dialogDom.commandPaletteInput, 'chat');
    assert.equal(
      dialogDom.commandPaletteList.querySelectorAll('.command-palette-group-label').length, 0,
      'a ranked list carries no group headers to fight the ranking'
    );
  });
});

/* ── C3: pointer moves the selection rather than painting a second one ── */

test('C3: mousemove moves the active row and Enter runs that row', async () => {
  const { doc, dialogDom } = buildPaletteDom();
  const navigated = [];
  await withGlobalDocument(doc, async () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: dialogDom,
      callbacks: { setActiveView: (viewId) => navigated.push(viewId) },
    });
    controller.bind();
    controller.open();

    const rows = rowsOf(dialogDom.commandPaletteList);
    const target = rows[2];
    target.dispatchEvent(new doc.defaultView.MouseEvent('mousemove', { bubbles: true }));

    const active = dialogDom.commandPaletteList.querySelectorAll('.command-palette-item--active');
    assert.equal(active.length, 1, 'exactly one row is ever selected');
    assert.equal(active[0], target, 'the hovered row IS the selected row');
    assert.equal(dialogDom.commandPaletteInput.getAttribute('aria-activedescendant'), target.id);

    keydown(doc, dialogDom.commandPaletteInput, 'Enter');
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(navigated, ['ide'], 'Enter runs the row under the cursor, not a stale keyboard index');
  });
});

/* ── C4: the live region is a count, not the whole list ── */

test('C4: the listbox carries no aria-live and the status node reports the count', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: dialogDom,
    });
    controller.bind();
    controller.open();
    assert.equal(dialogDom.commandPaletteList.hasAttribute('aria-live'), false,
      'aria-live on the listbox re-announces every option on every keystroke');

    typeQuery(doc, dialogDom.commandPaletteInput, 'settings');
    const count = rowsOf(dialogDom.commandPaletteList).length;
    assert.match(dialogDom.commandPaletteStatus.textContent, /^\d+ results?$/);
    assert.equal(dialogDom.commandPaletteStatus.textContent, dialogDom.commandPaletteCount.textContent);
    assert.ok(count > 0, 'sanity: the query matched something');
  });
});

/* ── C6 / C7: the chord is not stolen, and a blocked open is not swallowed ── */

test('C6: Ctrl+K inside a Monaco editor neither opens the palette nor eats the key', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: dialogDom,
    });
    controller.bind();

    const event = keydown(doc, doc.getElementById('editorInput'), 'k', { ctrlKey: true });
    assert.equal(event.defaultPrevented, false, 'Monaco owns Ctrl+K as a chord prefix while focused');
    assert.equal(controller.isActive(), false, 'the palette must not open over the editor');
  });
});

test('C6: Ctrl+K from the composer still opens the palette', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: dialogDom,
    });
    controller.bind();
    const composer = doc.createElement('textarea');
    doc.body.append(composer);

    const event = keydown(doc, composer, 'k', { ctrlKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(controller.isActive(), true, 'the composer is where people reach for Ctrl+K');
  });
});

test('C7: Ctrl+K blocked by another overlay does not swallow the keystroke', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: dialogDom,
      overlayManager: { isOpen: () => true, open() {}, close() {} },
    });
    controller.bind();

    const event = keydown(doc, doc.body, 'k', { ctrlKey: true });
    assert.equal(controller.isActive(), false, 'still refuses to stack over a managed overlay');
    assert.equal(event.defaultPrevented, false,
      'preventDefault without opening is what made Ctrl+K look dead');
  });
});

/* ── B6: the scope machine ── */

test('B6: Tab cycles the scope and Shift+Tab walks it back', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({ state: buildState(), dom: dialogDom });
    controller.bind();
    controller.open();
    assert.equal(dialogDom.commandPaletteScope.textContent, '', 'opens unscoped');

    keydown(doc, dialogDom.commandPaletteInput, 'Tab');
    assert.equal(dialogDom.commandPaletteScope.textContent, 'Chats');
    keydown(doc, dialogDom.commandPaletteInput, 'Tab');
    assert.equal(dialogDom.commandPaletteScope.textContent, 'Commands');
    keydown(doc, dialogDom.commandPaletteInput, 'Tab', { shiftKey: true });
    assert.equal(dialogDom.commandPaletteScope.textContent, 'Chats');
  });
});

test('B6: a scope prefix is consumed, not inserted, and Backspace clears the scope', () => {
  const { doc, dialogDom } = buildPaletteDom();
  const sessions = [{ id: 's1', title: 'Sidecar notes', updated_at: '2026-08-20T00:00:00Z', last_message_preview: '' }];
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({ state: buildState({ sessions }), dom: dialogDom });
    controller.bind();
    controller.open();

    typeQuery(doc, dialogDom.commandPaletteInput, '#');
    assert.equal(dialogDom.commandPaletteScope.textContent, 'Chats');
    assert.equal(dialogDom.commandPaletteInput.value, '', 'the prefix character is consumed');

    typeQuery(doc, dialogDom.commandPaletteInput, 'sidecar');
    const texts = rowsOf(dialogDom.commandPaletteList).map(rowText);
    assert.ok(texts.length > 0 && texts.every((text) => text.includes('Chat')),
      'the Chats scope shows only chat rows, got: ' + JSON.stringify(texts));

    typeQuery(doc, dialogDom.commandPaletteInput, '');
    const event = keydown(doc, dialogDom.commandPaletteInput, 'Backspace');
    assert.equal(event.defaultPrevented, true);
    assert.equal(dialogDom.commandPaletteScope.textContent, '', 'Backspace on an empty query clears the scope');
  });
});

test('B6: Escape always closes, never stages behind a scope', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    // No overlayManager, so the palette owns Escape locally (UIUX-019 fallback).
    const controller = createCommandPaletteController({ state: buildState(), dom: dialogDom });
    controller.bind();
    controller.open();
    keydown(doc, dialogDom.commandPaletteInput, 'Tab');
    assert.equal(dialogDom.commandPaletteScope.textContent, 'Chats');

    keydown(doc, doc.body, 'Escape');
    assert.equal(controller.isActive(), false,
      'a staged Escape would break the one-Escape-per-overlay-layer invariant');
  });
});

/* ── B8: settings provider ── */

test('B8: a Settings field is findable and jumps to its section', async () => {
  const { doc, dialogDom } = buildPaletteDom();
  const opened = [];
  const previousSearch = global.rendererSettingsSearch;
  global.rendererSettingsSearch = {
    buildSettingsSearchIndex: () => ([
      { id: 'field:auto-archive', kind: 'field', label: 'Auto-archive after 30 days', description: '', sectionId: 'chats', sectionLabel: 'Chats' },
    ]),
  };
  try {
    await withGlobalDocument(doc, async () => {
      const controller = createCommandPaletteController({
        state: buildState(),
        dom: dialogDom,
        callbacks: { openSettingsSection: (sectionId) => opened.push(sectionId) },
      });
      controller.bind();
      controller.open();
      typeQuery(doc, dialogDom.commandPaletteInput, 'auto-archive');

      const row = dialogDom.commandPaletteList.querySelector('[data-palette-id="setting:field:auto-archive"]');
      assert.ok(row, 'the settings field is reachable from the palette');
      assert.match(rowText(row), /Setting$/, 'settings rows carry the Setting type tag');
      row.click();
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(opened, ['chats'], 'activating jumps to the field\'s host section');
    });
  } finally {
    global.rendererSettingsSearch = previousSearch;
  }
});

test('B8: an absent settings-search seam yields no Settings rows and does not throw', () => {
  const { doc, dialogDom } = buildPaletteDom();
  const previousSearch = global.rendererSettingsSearch;
  delete global.rendererSettingsSearch;
  try {
    withGlobalDocument(doc, () => {
      const controller = createCommandPaletteController({ state: buildState(), dom: dialogDom });
      controller.bind();
      controller.open();
      typeQuery(doc, dialogDom.commandPaletteInput, 'zzzz-no-such-thing');
      assert.equal(rowsOf(dialogDom.commandPaletteList).length, 0);
      assert.match(dialogDom.commandPaletteList.textContent, /No matches/);
    });
  } finally {
    if (previousSearch === undefined) delete global.rendererSettingsSearch;
    else global.rendererSettingsSearch = previousSearch;
  }
});

/* ── P2: rows are reconciled, not rebuilt ── */

test('P2: a row surviving two renders is the same element instance', () => {
  const { doc, dialogDom } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({ state: buildState(), dom: dialogDom });
    controller.bind();
    controller.open();

    typeQuery(doc, dialogDom.commandPaletteInput, 'set');
    const first = dialogDom.commandPaletteList.querySelector('[data-palette-id="nav:settings"]');
    assert.ok(first, 'the Settings nav row matches "set"');

    typeQuery(doc, dialogDom.commandPaletteInput, 'sett');
    const second = dialogDom.commandPaletteList.querySelector('[data-palette-id="nav:settings"]');
    assert.equal(second, first, 'the reconciler reuses the element instead of rebuilding the list');
  });
});

/* ── C10: word-boundary starts win ── */

test('closing immediately after open cannot let deferred focus return to the hidden palette', async () => {
  const { doc, dialogDom } = buildPaletteDom();
  const trigger = doc.getElementById('editorInput');
  const previousDocument = global.document;
  global.document = doc;
  const controller = createCommandPaletteController({ state: buildState(), dom: dialogDom });
  try {
    controller.bind();
    trigger.focus();
    controller.open(trigger);
    controller.close();

    assert.equal(dialogDom.commandPaletteOverlay.classList.contains('hidden'), true);
    assert.equal(doc.activeElement, trigger, 'close restores the trigger synchronously');
    await Promise.resolve();
    assert.equal(doc.activeElement, trigger, 'the stale open continuation must not focus the hidden input');
  } finally {
    controller.dispose();
    global.document = previousDocument;
  }
});

test('C10: a word-boundary start outscores an earlier weak match', () => {
  const boundary = scoreMatch('spec compare', 'cp');
  assert.ok(boundary, 'cp is a subsequence of "spec compare"');
  assert.equal(boundary.ranges[0][0], 5, 'the highlight starts at the c of "compare", not the c inside "spec"');

  // The pre-fix greedy scan from index 0 scored 2 (+1 per matched char, no
  // boundary or consecutive bonus) before the shorter-haystack tiebreak.
  const greedyScore = 2 + Math.max(0, 24 - 'spec compare'.length) * 0.1;
  assert.ok(boundary.score > greedyScore,
    `boundary start must beat the greedy start (${boundary.score} vs ${greedyScore})`);
});

test('C10: prefix and consecutive scoring still hold', () => {
  const prefix = scoreMatch('chat', 'chat');
  const buried = scoreMatch('a-very-long-unrelated-chat-name', 'chat');
  assert.ok(prefix.score > buried.score, 'an exact prefix still wins');
  assert.equal(scoreMatch('Format Document', 'zz'), null, 'a non-subsequence is still no match');
});

/* ── Stylesheet contract (D1/D2/D3/D4) ──
   Text/AST assertions rather than CSSOM: JSDOM does not resolve token
   color-mix() or @media matching the way a browser does, same technique as
   tests/command-palette-css-reduced-motion.test.js. */

const fs = require('node:fs');
const path = require('node:path');

const PALETTE_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'styles', 'command-palette.css'), 'utf8'
);

// Exact single-selector lookup by text, so a selector's own regex metacharacters
// never need escaping. Matching on "<selector> {" also keeps `.command-palette-item`
// from colliding with `.command-palette-item-icon` or `.command-palette-item:focus`.
function ruleBody(css, selector) {
  const needle = selector + ' {';
  const at = css.indexOf(needle);
  if (at < 0) return null;
  const start = at + needle.length;
  const end = css.indexOf('}', start);
  return end < 0 ? null : css.slice(start, end);
}

test('D1/D2: result rows carry no left accent bar and no accent-tinted fill', () => {
  const base = ruleBody(PALETTE_CSS, '.command-palette-item');
  assert.ok(base, 'expected a base .command-palette-item rule');
  assert.doesNotMatch(base, /border-left/, 'the left accent bar is the pattern the Home restyle removed');

  const active = ruleBody(PALETTE_CSS, '.command-palette-item--active');
  assert.ok(active, 'expected a .command-palette-item--active rule');
  assert.doesNotMatch(active, /--accent/, 'the selected row uses a neutral fill, not an accent tint');
  assert.match(active, /--text-primary/, 'the selected fill is derived from --text-primary');

  assert.doesNotMatch(PALETTE_CSS, /\.command-palette-item:hover/,
    'hover must not paint a second selected-looking row; the pointer moves the selection instead');
});

test('D3: the dialog uses the sharpened radius, not card chrome', () => {
  const dialog = ruleBody(PALETTE_CSS, '.command-palette-dialog');
  assert.ok(dialog, 'expected a .command-palette-dialog rule');
  assert.match(dialog, /border-radius:\s*var\(--radius-sm\)/);
  assert.doesNotMatch(dialog, /--surface-card-elevated/, 'the palette is a flat surface, not a card');
});

test('D4: the scrim is tokenized and unblurred', () => {
  const scrim = ruleBody(PALETTE_CSS, '.command-palette-scrim');
  assert.ok(scrim, 'expected a .command-palette-scrim rule');
  assert.doesNotMatch(scrim, /rgba?\(/, 'a literal colour reads as a fixed dark dim over the light palettes');
  assert.doesNotMatch(scrim, /backdrop-filter/, 'a full-viewport GPU blur repainted per keystroke earns nothing');
});

test('the stylesheet declares no literal colour values at all', () => {
  const withoutComments = PALETTE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(withoutComments, /#[0-9a-fA-F]{3,8}\b/, 'no hex literals');
  assert.doesNotMatch(withoutComments, /\brgba?\(/, 'no rgb/rgba literals');
});
