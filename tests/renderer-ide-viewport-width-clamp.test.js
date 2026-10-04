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

test('rail drag and keyboard steps start from the SHOWN (viewport-clamped) width (no dead zone)', (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<nav id="bar"></nav><div id="resizer" tabindex="0"></div><div id="shell"></div>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window; // the rail binds pointermove/up on window
  const ide = ideState.createIdeUiState();
  ide.railSide = 'left';
  ide.railWidth = 600; // saved preference; a narrow window shows 400
  const rail = railUtils.createIdeRail({
    getDom: () => ({
      ideActivityBar: dom.window.document.getElementById('bar'),
      ideRailResizer: dom.window.document.getElementById('resizer'),
      ideShell: dom.window.document.getElementById('shell'),
    }),
    getIde: () => ide,
    getMaxRailWidth: () => 400,
  });
  t.after(() => { rail.dispose(); globalThis.window = prevWindow; });
  rail.bindEvents();
  const win = dom.window;
  const resizer = dom.window.document.getElementById('resizer');

  // A press without movement never rewrites the saved preference.
  resizer.dispatchEvent(new win.MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
  win.dispatchEvent(new win.MouseEvent('pointerup', { clientX: 500 }));
  assert.equal(ide.railWidth, 600, 'saved width untouched by a click');

  // Left rail: dragging LEFT 50px shrinks the SHOWN 400 to 350 immediately.
  resizer.dispatchEvent(new win.MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 450 }));
  assert.equal(ide.railWidth, 350, 'the first pixels of drag already resize');
  win.dispatchEvent(new win.MouseEvent('pointerup', { clientX: 450 }));

  // Keyboard: saved 600 again; one shrink step lands at 400 - 16.
  ide.railWidth = 600;
  resizer.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(ide.railWidth, 384, 'a keyboard step moves from the shown width');
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

// 2026-09-27 GUI gate (F2): window 1440, secondary open, chat dock saved at 628
// (above its clamp). The dock clamp is derived from the side panels, so budgeting
// the rail against the dock's CLAMPED width was circular: railMax always equalled
// the rail's current width and ArrowRight never grew it back.
function gateIde() {
  const ide = ideState.createIdeUiState();
  ide.railSide = 'left';
  ide.railWidth = 316;
  ide.secondaryPanelOpen = true;
  ide.secondaryWidth = 300;
  ide.chatDockOpen = true;
  ide.chatDockWidth = 628;
  return ide;
}

test('an over-clamp chat dock does not pin railMax / secondaryMax to their current widths', () => {
  const ide = gateIde();
  const limits = computeViewportWidthLimits(ide, 1440);
  // 1440 - editor 360 - dock floor 320 - secondary 300.
  assert.equal(limits.railMax, 460, 'the rail can grow until the dock reaches its floor');
  assert.equal(limits.secondaryMax, 1440 - 360 - 320 - 316, 'the secondary likewise');
  assert.equal(limits.chatDockMax, 1440 - 360 - 316 - 300, 'the dock still takes what the side panels leave');

  // At the rail's max the three columns plus the editor floor fit exactly.
  ide.railWidth = 460;
  const atMax = computeViewportWidthLimits(ide, 1440);
  assert.equal(atMax.railMax, 460);
  assert.equal(atMax.chatDockMax, 320, 'the dock yields down to its floor');
  assert.equal(460 + 300 + atMax.chatDockMax + 360, 1440);

  // A saved rail wider than the viewport allows is display-only: the dock is
  // budgeted against the SHOWN rail, not starved by the saved 600.
  ide.railWidth = 600;
  const saved = computeViewportWidthLimits(ide, 1440);
  assert.equal(saved.chatDockMax, 320, 'dock sized against the shown 460 rail');
});

function mountRail(ide, getMaxRailWidth) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<nav id="bar"></nav><div id="resizer" tabindex="0"></div><div id="shell"></div>');
  const rail = railUtils.createIdeRail({
    getDom: () => ({
      ideActivityBar: dom.window.document.getElementById('bar'),
      ideRailResizer: dom.window.document.getElementById('resizer'),
      ideShell: dom.window.document.getElementById('shell'),
    }),
    getIde: () => ide,
    getMaxRailWidth,
  });
  rail.bindEvents();
  const resizer = dom.window.document.getElementById('resizer');
  const press = (key) => resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const shown = () => dom.window.document.getElementById('shell').style.getPropertyValue('--ide-rail-width');
  return { rail, press, shown };
}

test('the rail resizer grows back after shrinking at 1440 with an over-clamp dock (real budget)', (t) => {
  const ide = gateIde();
  const { rail, press } = mountRail(ide, () => computeViewportWidthLimits(ide, 1440).railMax);
  t.after(() => rail.dispose());
  press('ArrowLeft');
  press('ArrowLeft');
  assert.equal(ide.railWidth, 284, '316 -> 300 -> 284');
  press('ArrowRight');
  press('ArrowRight');
  press('ArrowRight');
  assert.equal(ide.railWidth, 332, '284 -> 300 -> 316 -> 332: it grows back past where it started');
});

test('a step clamped only by the viewport never overwrites the saved rail width', (t) => {
  const ide = gateIde();
  let vw = 909;
  const { rail, press, shown } = mountRail(ide, () => computeViewportWidthLimits(ide, vw).railMax);
  t.after(() => rail.dispose());
  // 909 - 360 - 320 - 300 < floor: the rail shows at its 200 floor.
  press('ArrowRight');
  assert.equal(ide.railWidth, 316, 'the saved 316 survives a grow step pinned at the ceiling');
  assert.equal(shown(), '200px', 'the shown width is the saved width through the clamp');
  vw = 1440;
  press('ArrowRight');
  assert.equal(ide.railWidth, 332, 'back on a wide window the rail steps from the saved 316');

  // A shrink inside the ceiling IS the user's new choice (no dead zone at the clamp).
  vw = 1000; // 1000 - 360 - 320 - 300 -> floor 200 again
  ide.secondaryPanelOpen = false; // now 1000 - 360 - 320 = 320
  press('ArrowLeft');
  assert.equal(ide.railWidth, 304, 'shrinks from the shown 320, not the saved 332');
});

test('secondary sidebar steps past the viewport ceiling keep the saved width', (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="shell"></div><aside id="sec"></aside><div id="secResizer" tabindex="0"></div><nav id="secHeader"></nav>');
  const ide = ideState.createIdeUiState();
  ide.railSide = 'right'; // sidebar on the left -> ArrowRight grows
  ide.secondaryPanelOpen = true;
  ide.panelLocations = { explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'secondary' };
  ide.secondaryWidth = 500;
  let max = 320;
  const sidebar = sidebarUtils.createIdeSecondarySidebar({
    getDom: () => ({
      ideShell: dom.window.document.getElementById('shell'),
      ideSecondarySidebar: dom.window.document.getElementById('sec'),
      ideSecondarySidebarResizer: dom.window.document.getElementById('secResizer'),
      ideSecondarySidebarHeader: dom.window.document.getElementById('secHeader'),
    }),
    getIde: () => ide,
    getMaxWidth: () => max,
  });
  t.after(() => sidebar.dispose());
  sidebar.bindEvents();
  const resizer = dom.window.document.getElementById('secResizer');
  const press = (key) => resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  press('ArrowRight');
  assert.equal(ide.secondaryWidth, 500, 'grow step pinned at the ceiling keeps the saved 500');
  press('ArrowLeft');
  assert.equal(ide.secondaryWidth, 296, 'a shrink steps from the shown 320');
  max = 600;
  press('ArrowRight');
  assert.equal(ide.secondaryWidth, 320);
});

// ---- Astra review: the other columns are budgeted against the SHOWN rail /
// sidebar, so a gesture must re-apply them, and syncWidth re-reads the clamp.
test('a rail step re-applies the dependent columns (onWidthApplied); syncWidth shows the saved width through a new clamp', (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<nav id="bar"></nav><div id="resizer" tabindex="0"></div><div id="shell"></div>');
  const ide = gateIde();
  let applied = 0;
  let max = computeViewportWidthLimits(ide, 1440).railMax;
  const rail = railUtils.createIdeRail({
    getDom: () => ({
      ideActivityBar: dom.window.document.getElementById('bar'),
      ideRailResizer: dom.window.document.getElementById('resizer'),
      ideShell: dom.window.document.getElementById('shell'),
    }),
    getIde: () => ide,
    getMaxRailWidth: () => max,
    onWidthApplied: () => { applied += 1; },
  });
  rail.bindEvents();
  t.after(() => rail.dispose());
  const shown = () => dom.window.document.getElementById('shell').style.getPropertyValue('--ide-rail-width');
  dom.window.document.getElementById('resizer').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(applied, 1, 'one step, one dependent re-apply');
  assert.equal(shown(), '332px');
  max = 300; // another column grew: the rail's ceiling dropped
  rail.syncWidth();
  assert.equal(shown(), '300px', 'syncWidth shows the saved width through the new clamp');
  assert.equal(ide.railWidth, 332, 'without touching the saved preference');
  assert.equal(applied, 1, 'syncWidth itself never re-notifies (no ping-pong between columns)');
});

test('a secondary sidebar step re-applies the dependent columns (onWidthApplied); syncWidth re-reads the clamp', (t) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="shell"></div><aside id="sec"></aside><div id="secResizer" tabindex="0"></div><nav id="secHeader"></nav>');
  const ide = ideState.createIdeUiState();
  ide.railSide = 'right';
  ide.secondaryPanelOpen = true;
  ide.panelLocations = { explorer: 'primary', search: 'primary', changes: 'secondary', 'source-control': 'secondary' };
  ide.secondaryWidth = 400;
  let applied = 0;
  let max = 600;
  const sidebar = sidebarUtils.createIdeSecondarySidebar({
    getDom: () => ({
      ideShell: dom.window.document.getElementById('shell'),
      ideSecondarySidebar: dom.window.document.getElementById('sec'),
      ideSecondarySidebarResizer: dom.window.document.getElementById('secResizer'),
      ideSecondarySidebarHeader: dom.window.document.getElementById('secHeader'),
    }),
    getIde: () => ide,
    getMaxWidth: () => max,
    onWidthApplied: () => { applied += 1; },
  });
  sidebar.bindEvents();
  t.after(() => sidebar.dispose());
  const shown = () => dom.window.document.getElementById('shell').style.getPropertyValue('--ide-secondary-sidebar-width');
  dom.window.document.getElementById('secResizer').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(applied, 1);
  assert.equal(ide.secondaryWidth, 424, 'one 24px keyboard step');
  max = 380;
  sidebar.syncWidth();
  assert.equal(shown(), '380px', 'the saved 424 shows through the new clamp');
  assert.equal(ide.secondaryWidth, 424);
  assert.equal(applied, 1, 'syncWidth never re-notifies');
});
