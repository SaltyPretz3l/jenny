'use strict';

/* Command palette: the PRODUCTION boot path.
 *
 * Every other palette test requires the three modules, which takes the
 * CommonJS branch of their UMD wrapper. index.html takes the other branch --
 * plain <script> tags evaluated against one shared global object, each module
 * publishing itself onto it (`root.rendererCommandPaletteRender = factory()`)
 * and reading its dependencies back off it. Nothing in the suite covered that
 * branch, which is how the defect below shipped.
 *
 * The defect: the render module builds rows with document.createElement (the
 * pre-split renderer assigned innerHTML, which needs no document). It took its
 * document from the controller, which resolves it from the ambient global. A
 * harness that mounts the palette in a JSDOM document WITHOUT also assigning
 * globalThis.document therefore handed it null, render() bailed at its own
 * guard, and the palette drew zero rows with no error -- see
 * tests/renderer-quick-settings-modal.test.js, whose palette-seam test mounts
 * exactly that way and only noticed via an unrelated assertion. The fix is
 * renderer-command-palette-render.js resolving `listEl.ownerDocument` first.
 *
 * So: the sandbox below deliberately has NO `document`, and neither does the
 * Node global. That absence IS the regression guard -- do not "fix" this test
 * by adding sandbox.document or by assigning global.document. If the
 * ownerDocument resolution is reverted, the row-count assertion goes red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

// Production order, from index.html: result sources, then row DOM + the keyed
// reconciler, then the controller that consumes both.
const SCRIPTS = [
  'renderer/shared/async-fence.js',
  'renderer/shell/renderer-command-palette-providers.js',
  'renderer/shell/renderer-command-palette-render.js',
  'renderer/shell/renderer-command-palette.js',
];

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

/* An explicit allowlist, not a copy of the window: `document` must stay out,
 * and so must `module`/`require` (their absence is what selects the browser
 * branch of the UMD wrapper). None of the three modules touches console,
 * setTimeout, window, or navigator, so this is the whole surface they need --
 * the DOM they operate on arrives through deps, not through globals. */
function buildBrowserContext(window) {
  const sandbox = {
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Event: window.Event,
    console,
  };
  sandbox.globalThis = sandbox;
  return { sandbox, context: vm.createContext(sandbox) };
}

function loadPaletteScripts(context) {
  for (const src of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), context, { filename: src });
  }
}

function buildState() {
  return {
    ui: {},
    auth: { authenticated: true },
    sessions: [
      {
        id: 'session-boot',
        title: 'Boot path chat',
        last_message_preview: 'preview',
        updated_at: '2026-08-20T08:00:00.000Z',
      },
    ],
    features: { featureFlags: { command_palette: true } },
  };
}

test('script-tag boot: all three palette modules publish onto the shared global in production order', () => {
  const { dom } = buildPaletteDom();
  const { sandbox, context } = buildBrowserContext(dom.window);
  loadPaletteScripts(context);

  assert.equal(typeof sandbox.rendererCommandPaletteProviders?.createPaletteProviders, 'function');
  assert.equal(typeof sandbox.rendererCommandPaletteRender?.createPaletteRenderer, 'function');
  assert.equal(typeof sandbox.rendererCommandPaletteUtils?.createCommandPaletteController, 'function');

  // The controller resolved its collaborators off the shared global, not via
  // require: SCOPES came from the providers module, so scope state is live.
  assert.ok(Array.isArray(sandbox.rendererCommandPaletteProviders.SCOPES));
  assert.ok(sandbox.rendererCommandPaletteProviders.SCOPES.length > 1);
});

test('script-tag boot: the palette renders rows with NO ambient document anywhere (ownerDocument guard)', () => {
  const { dom, dialogDom } = buildPaletteDom();
  const { sandbox, context } = buildBrowserContext(dom.window);

  // Preconditions, asserted so this guard cannot rot into a passing no-op: the
  // JSDOM document is reachable ONLY through dom.commandPaletteList, never as a
  // global on either side of the vm boundary.
  assert.equal(typeof global.document, 'undefined', 'the Node global must not carry a document');
  assert.equal(
    Object.prototype.hasOwnProperty.call(sandbox, 'document'),
    false,
    'the sandbox must not carry a document'
  );
  loadPaletteScripts(context);
  assert.equal(
    vm.runInContext('typeof document', context),
    'undefined',
    'the module scope must not see a document'
  );

  const controller = sandbox.rendererCommandPaletteUtils.createCommandPaletteController({
    state: buildState(),
    dom: dialogDom,
  });
  controller.open();

  const rows = dialogDom.commandPaletteList.querySelectorAll('.command-palette-item');
  assert.ok(
    rows.length > 0,
    'rows must render from listEl.ownerDocument -- a null ambient document made render() bail silently'
  );
  assert.equal(rows[0].getAttribute('role'), 'option');
  assert.equal(rows[0].id, 'command-palette-option-0');

  controller.close();
});

test('script-tag boot: field icon, footer count, and legend are written', () => {
  const { dom, dialogDom } = buildPaletteDom();
  const { sandbox, context } = buildBrowserContext(dom.window);
  loadPaletteScripts(context);

  const controller = sandbox.rendererCommandPaletteUtils.createCommandPaletteController({
    state: buildState(),
    dom: dialogDom,
  });
  controller.open();

  assert.ok(
    dialogDom.commandPaletteFieldIcon.querySelector('svg'),
    'the search glyph is inline SVG, written into the field icon span at construction'
  );
  assert.match(dialogDom.commandPaletteCount.textContent, /^\d+ results?$/);
  assert.ok(dialogDom.commandPaletteLegend.textContent.length > 0, 'the footer legend is written');

  controller.close();
});
