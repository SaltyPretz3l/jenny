const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const {
  computeCommandPopoverPosition,
  createSettingsOverlayRenderer,
} = require('../renderer/shell/renderer-settings-overlays');

function createHarness(commands) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<button id="trigger" aria-expanded="false"></button>'
    + '<div id="popover" class="composer-popover hidden"><div id="list"></div></div>'
    + '</body></html>', { pretendToBeVisual: true });
  const documentRef = dom.window.document;
  const trigger = documentRef.getElementById('trigger');
  const popover = documentRef.getElementById('popover');
  const list = documentRef.getElementById('list');
  trigger.getBoundingClientRect = () => ({ top: 500, bottom: 540, right: 760, width: 40, height: 40 });
  popover.getBoundingClientRect = () => ({ width: 320, height: 280 });
  Object.defineProperty(dom.window, 'innerWidth', { value: 800, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 600, configurable: true });
  dom.window.inventoryActionButton = actionButton;
  dom.window.requestAnimationFrame = (callback) => { callback(); return 0; };

  let writes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(list, 'innerHTML', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) { writes += 1; descriptor.set.call(this, value); },
  });
  const state = { ui: { commandPopoverOpen: true }, backend: { phase: 'ready' } };
  const renderer = createSettingsOverlayRenderer({
    state,
    windowRef: dom.window,
    dom: {
      composerCommandPopover: popover,
      composerCommandPopoverList: list,
      composerTerminalShortcut: trigger,
    },
    callbacks: { listSlashCommands: () => commands, escapeHtml: actionButton.escapeHtml },
  });
  return { dom, list, popover, renderer, state, trigger, writes: () => writes };
}

test('command popover renders once and resize-only positioning preserves focused rows', () => {
  const harness = createHarness([
    { name: '/context', description: 'Show context', action: 'run', actionLabel: 'Run', available: true },
    { name: '/note', description: 'Save note', action: 'insert', actionLabel: 'Insert', available: true },
  ]);
  harness.renderer.renderCommandPopover();
  const note = harness.list.querySelector('[data-command-name="/note"]');
  note.focus();
  harness.renderer.renderCommandPopover();
  harness.renderer.renderCommandPopover({ positionOnly: true });
  assert.equal(harness.writes(), 1);
  assert.equal(harness.dom.window.document.activeElement, note);
  assert.equal(note.isConnected, true);
  assert.equal(harness.trigger.getAttribute('aria-expanded'), 'true');
  harness.renderer.dispose();
  harness.dom.window.close();
});

test('command popover exposes menu action and unavailable metadata', () => {
  const harness = createHarness([
    {
      name: '/context', description: 'Show context', action: 'run', actionLabel: 'Run',
      available: false, unavailableReason: 'Start a conversation first.',
    },
  ]);
  harness.renderer.renderCommandPopover();
  const item = harness.list.querySelector('[data-command-name="/context"]');
  assert.equal(item.getAttribute('role'), 'menuitem');
  assert.equal(item.getAttribute('aria-disabled'), 'true');
  assert.equal(item.dataset.commandAction, 'run');
  assert.match(item.textContent, /Run/);
  assert.match(item.getAttribute('aria-label'), /Start a conversation first/);
  harness.renderer.dispose();
  harness.dom.window.close();
});

test('command popover positioning clamps both axes and bounds short viewports', () => {
  const result = computeCommandPopoverPosition(
    { top: 70, bottom: 100, right: 310 },
    { width: 320, height: 400 },
    { width: 300, height: 220 }
  );
  assert.ok(result.left >= 16);
  assert.ok(result.top >= 16);
  assert.ok(result.maxHeight >= 96);
  assert.ok(result.maxHeight <= 104);
});
