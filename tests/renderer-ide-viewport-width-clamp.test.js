'use strict';

/* Viewport-safe wide resize (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md Phase
 * 5): the persisted rail/secondary maxima widened to 600 (reconciling the old
 * 560-vs-600 persistence/drag mismatch), guarded by the viewport-aware width
 * budget in renderer-ide-layout.js. Covers the pure budget math (chat dock +
 * secondary + editor floor + font scale), the widened schema acceptance, the
 * drag-clamp injection in the rail/secondary modules, and the display-level
 * (non-mutating) clamp in applyRailGeometry. */

const test = require('node:test');
const assert = require('node:assert/strict');

const layoutUtils = require('../renderer/features/renderer-ide-layout');
const railUtils = require('../renderer/features/renderer-ide-rail');
const sidebarUtils = require('../renderer/features/renderer-ide-secondary-sidebar');
const ideState = require('../renderer/features/renderer-ide-state');
const {
  normalizeWorkspaceIde,
  WORKSPACE_IDE_RAIL_WIDTH_MAX,
  WORKSPACE_IDE_SECONDARY_WIDTH_MAX,
} = require('../services/workspace-ide-config-schema');

const { computeViewportWidthLimits } = layoutUtils;

test('persistence maxima reconcile with the UI drag ceiling at 600', () => {
  assert.equal(WORKSPACE_IDE_RAIL_WIDTH_MAX, 600);
  assert.equal(railUtils.MAX_RAIL_WIDTH, 600, 'no more 560-vs-600 disagreement');
  assert.equal(WORKSPACE_IDE_SECONDARY_WIDTH_MAX, 600);
  assert.equal(sidebarUtils.MAX_SECONDARY_WIDTH, 600);
  assert.equal(ideState.SECONDARY_WIDTH_MAX, 600, 'renderer mirror matches the service');
  assert.equal(normalizeWorkspaceIde({ railWidth: 600 }).railWidth, 600, 'a 600px rail persists');
  assert.equal(normalizeWorkspaceIde({ railWidth: 4000 }).railWidth, 600, 'clamped above the max');
  assert.equal(normalizeWorkspaceIde({ secondaryWidth: 600 }).secondaryWidth, 600);
});

test('budget math: rail + secondary + chat dock always leave the editor floor', () => {
  const ide = ideState.createIdeUiState();
  ide.railWidth = 600;
  // Plenty of room: nothing clamps.
  let limits = computeViewportWidthLimits(ide, 1920);
  assert.equal(limits.railMax >= 600, true);

  // 1000px viewport, editor floor 360 → budget 640; rail alone can take 600.
  limits = computeViewportWidthLimits(ide, 1000);
  assert.equal(limits.railMax, 640);

  // Open the secondary (300px): rail max shrinks by it.
  ide.secondaryPanelOpen = true;
  ide.secondaryWidth = 300;
  limits = computeViewportWidthLimits(ide, 1000);
  assert.equal(limits.railMax, 640 - 300);
  // Secondary max is budget minus the (clamped) rail.
  assert.equal(limits.secondaryMax, 640 - Math.min(600, 340));

  // An open chat dock eats the budget too.
  ide.chatDockOpen = true;
  ide.chatDockWidth = 380;
  limits = computeViewportWidthLimits(ide, 1000);
  assert.equal(limits.railMax, Math.max(200, 1000 - 360 - 380 - 300));

  // Tiny viewport: floors hold (the editor column takes the squeeze).
  limits = computeViewportWidthLimits(ide, 500);
  assert.equal(limits.railMax, 200);
  assert.equal(limits.secondaryMax >= 160, true);

  // Font scale raises the editor floor.
  ide.chatDockOpen = false;
  ide.secondaryPanelOpen = false;
  const at1 = computeViewportWidthLimits(ide, 1000, { fontScale: 1 });
  const at15 = computeViewportWidthLimits(ide, 1000, { fontScale: 1.5 });
  assert.equal(at15.railMax < at1.railMax, true, 'scaled UI leaves less width for the rail');

  // Unknown viewport (jsdom / pre-layout) → no dynamic bound.
  assert.equal(computeViewportWidthLimits(ide, undefined).railMax, Infinity);
  assert.equal(computeViewportWidthLimits(ide, 0).secondaryMax, Infinity);
});

test('rail keyboard resize honors the injected viewport ceiling', (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<nav id="bar"></nav><div id="resizer" tabindex="0"></div><div id="shell"></div>');
  const ide = ideState.createIdeUiState();
  ide.railWidth = 460;
  const rail = railUtils.createIdeRail({
    getDom: () => ({
      ideActivityBar: dom.window.document.getElementById('bar'),
      ideRailResizer: dom.window.document.getElementById('resizer'),
      ideShell: dom.window.document.getElementById('shell'),
    }),
    getIde: () => ide,
    getMaxRailWidth: () => 470,
  });
  t.after(() => rail.dispose());
  rail.bindEvents();
  const resizer = dom.window.document.getElementById('resizer');
  // railSide left → ArrowRight grows by 16; the 470 ceiling wins over 476.
  resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(ide.railWidth, 470, 'dynamic viewport max caps the grow step');
});

test('secondary sidebar width application clamps display to the viewport ceiling without mutating state', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="shell"></div><aside id="sec"></aside><div id="secResizer"></div><nav id="secHeader"></nav>');
  const ide = ideState.createIdeUiState();
  ide.secondaryPanelOpen = true;
  ide.panelLocations = { explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'secondary' };
  ide.secondaryWidth = 600;
  const sidebar = sidebarUtils.createIdeSecondarySidebar({
    getDom: () => ({
      ideShell: dom.window.document.getElementById('shell'),
      ideSecondarySidebar: dom.window.document.getElementById('sec'),
      ideSecondarySidebarResizer: dom.window.document.getElementById('secResizer'),
      ideSecondarySidebarHeader: dom.window.document.getElementById('secHeader'),
    }),
    getIde: () => ide,
    getMaxWidth: () => 320,
  });
  sidebar.render();
  const shell = dom.window.document.getElementById('shell');
  assert.equal(shell.style.getPropertyValue('--ide-secondary-sidebar-width'), '320px', 'displayed width is viewport-clamped');
  assert.equal(ide.secondaryWidth, 600, 'the persisted preference is preserved');
  sidebar.dispose();
});
