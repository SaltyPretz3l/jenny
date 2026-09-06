'use strict';

/* UIUX-020: command palette combobox semantics + navigation focus handoff.
 * See UI_UX_COMPREHENSIVE_AUDIT_2026-07-12.md UIUX-020: "Command-palette
 * options have no IDs and the input does not update aria-activedescendant.
 * Palette ... restore[s] old focus before navigation, leaving focus in
 * hidden/inert content or on body." */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCommandPaletteController } = require('../renderer/shell/renderer-command-palette.js');

function buildPaletteDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="commandPaletteOverlay" class="hidden"></div>'
    + '<input id="commandPaletteInput" role="combobox" aria-expanded="false" />'
    + '<div id="commandPaletteList" role="listbox"></div>'
    + '</body></html>');
  const doc = dom.window.document;
  for (const el of doc.querySelectorAll('button, input, a, select, textarea, [tabindex]')) {
    Object.defineProperty(el, 'offsetParent', { value: {}, configurable: true });
  }
  return {
    dom,
    doc,
    commandPaletteOverlay: doc.getElementById('commandPaletteOverlay'),
    commandPaletteInput: doc.getElementById('commandPaletteInput'),
    commandPaletteList: doc.getElementById('commandPaletteList'),
  };
}

function buildState() {
  return {
    ui: {},
    auth: { authenticated: true },
    sessions: [],
    features: { featureFlags: { command_palette: true } },
  };
}

// renderer-command-palette.js resolves documentRef/windowRef off the ambient
// global (`typeof document !== 'undefined' ? document : null`), not an
// injected dep -- true in the real renderer, but bind()'s document-level
// listener + open()/close() focus bookkeeping are no-ops in a bare Node test
// unless the ambient global points at the SAME document under test (see
// tests/renderer-overlay-manager.test.js for the same pattern).
function withGlobalDocument(doc, fn) {
  const previousDocument = global.document;
  global.document = doc;
  try {
    return fn();
  } finally {
    global.document = previousDocument;
  }
}

test('UIUX-020: input carries combobox semantics that flip with open/close', () => {
  const { doc, commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
    });

    assert.equal(commandPaletteInput.getAttribute('role'), 'combobox');
    assert.equal(commandPaletteInput.getAttribute('aria-expanded'), 'false');

    controller.open();
    assert.equal(commandPaletteInput.getAttribute('aria-expanded'), 'true', 'combobox reports expanded while open');

    controller.close();
    assert.equal(commandPaletteInput.getAttribute('aria-expanded'), 'false', 'combobox reports collapsed once closed');
  });
});

test('UIUX-020: every rendered option has a stable, unique id', () => {
  const { doc, commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
    });
    controller.open();

    const rows = [...commandPaletteList.querySelectorAll('.command-palette-item')];
    assert.ok(rows.length > 0, 'palette renders at least the default Navigate/Actions/Help groups');
    const ids = rows.map((row) => row.id);
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), 'every option row carries a non-empty id');
    assert.equal(new Set(ids).size, ids.length, 'option ids are unique');
  });
});

test('UIUX-020: aria-activedescendant tracks the highlighted option through arrow navigation', () => {
  const { doc, commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  withGlobalDocument(doc, () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
    });
    controller.bind();
    controller.open();

    const rows = [...commandPaletteList.querySelectorAll('.command-palette-item')];
    assert.ok(rows.length >= 2, 'need at least two rows to prove tracking, not a static value');

    assert.equal(commandPaletteInput.getAttribute('aria-activedescendant'), rows[0].id,
      'activedescendant seeds to the first option on open');

    commandPaletteInput.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', {
      key: 'ArrowDown', bubbles: true, cancelable: true,
    }));
    assert.equal(commandPaletteInput.getAttribute('aria-activedescendant'), rows[1].id,
      'ArrowDown advances activedescendant to the next option');

    commandPaletteInput.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', {
      key: 'ArrowUp', bubbles: true, cancelable: true,
    }));
    assert.equal(commandPaletteInput.getAttribute('aria-activedescendant'), rows[0].id,
      'ArrowUp moves activedescendant back');

    controller.close();
    assert.equal(commandPaletteInput.hasAttribute('aria-activedescendant'), false,
      'activedescendant is cleared once the listbox is gone');
  });
});

test('UIUX-020: activating a Navigate item lands focus on the destination toprail tab, not stale focus', async () => {
  const { doc, commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const focusCalls = [];
  // Same absent-safe globalThis seam the palette already uses for the Quick
  // Settings action item (see the file header note + renderer-quick-settings
  // -modal.test.js) -- window.rendererTopNavShellController is the real
  // front door in production (renderer-app-lifecycle-composition.js).
  const previousStash = global.rendererTopNavShellController;
  global.rendererTopNavShellController = {
    focusActiveViewTab: (viewId) => focusCalls.push(viewId),
  };

  const setActiveViewCalls = [];
  try {
    await withGlobalDocument(doc, async () => {
      const controller = createCommandPaletteController({
        state: buildState(),
        dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
        callbacks: {
          setActiveView: (viewId) => setActiveViewCalls.push(viewId),
        },
      });
      controller.bind();
      controller.open();

      const ideRow = [...commandPaletteList.querySelectorAll('.command-palette-item')]
        .find((row) => row.textContent.includes('Workspace'));
      assert.ok(ideRow, 'the Navigate > Workspace item is present');
      ideRow.click();

      // executeActiveItem() runs item.run() inside a microtask.
      await Promise.resolve();
      await Promise.resolve();

      assert.deepEqual(setActiveViewCalls, ['ide'], 'the navigate item still switches the view');
      assert.deepEqual(focusCalls, ['ide'],
        'focus must land on the destination toprail tab after navigation, not the stale pre-open focus target');
    });
  } finally {
    global.rendererTopNavShellController = previousStash;
  }
});

test('C4: slash command metadata keeps Run and Insert behavior explicit', async () => {
  const { doc, commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const calls = [];
  await withGlobalDocument(doc, async () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
      callbacks: {
        listSlashCommands: () => [
          { name: '/context', description: 'Show context', action: 'run', actionLabel: 'Run' },
          { name: '/note', description: 'Save a note', action: 'insert', actionLabel: 'Insert' },
        ],
        tryExecuteSlashCommand: (name) => calls.push(['run', name]),
        insertSlashCommand: (name) => calls.push(['insert', name]),
      },
    });
    controller.bind();
    controller.open();
    commandPaletteInput.value = '/context';
    commandPaletteInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    const contextRow = [...commandPaletteList.querySelectorAll('.command-palette-item')]
      .find((row) => row.textContent.includes('/context'));
    assert.match(contextRow.textContent, /Run/);
    commandPaletteInput.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    await Promise.resolve();

    controller.open();
    commandPaletteInput.value = '/note';
    commandPaletteInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    const noteRow = [...commandPaletteList.querySelectorAll('.command-palette-item')]
      .find((row) => row.textContent.includes('/note'));
    assert.match(noteRow.textContent, /Insert/);
    commandPaletteInput.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    await Promise.resolve();

    assert.deepEqual(calls, [['run', '/context'], ['insert', '/note']]);
  });
});

test('unavailable slash commands remain discoverable but do not execute', async () => {
  const { doc, commandPaletteOverlay, commandPaletteInput, commandPaletteList } = buildPaletteDom();
  const calls = [];
  await withGlobalDocument(doc, async () => {
    const controller = createCommandPaletteController({
      state: buildState(),
      dom: { commandPaletteOverlay, commandPaletteInput, commandPaletteList },
      callbacks: {
        listSlashCommands: () => [{
          name: '/context', description: 'Show context', action: 'run', actionLabel: 'Run',
          available: false, unavailableReason: 'Start a conversation first.',
        }],
        tryExecuteSlashCommand: () => calls.push('executed'),
        showToastMessage: (...args) => calls.push(args),
      },
    });
    controller.bind();
    controller.open();
    commandPaletteInput.value = '/context';
    commandPaletteInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    const row = commandPaletteList.querySelector('[data-palette-id="slash:/context"]');
    assert.equal(row.getAttribute('aria-disabled'), 'true');
    row.click();
    await Promise.resolve();
    assert.equal(calls.includes('executed'), false);
    assert.match(calls[0][0], /Start a conversation/);
    assert.equal(commandPaletteOverlay.classList.contains('hidden'), false, 'disabled activation keeps discovery open');
  });
});
