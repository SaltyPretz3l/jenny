'use strict';

/* Workspace IDE secondary sidebar (the second side container opposite the
 * primary rail), the "Move View" model. Covers the header (a tab per panel
 * LOCATED in the secondary sidebar + the active marker + a per-tab hover ⇄ move
 * control + the collapse control), switching the active secondary panel, the
 * open-state gate (closed/empty = no header churn) + the [data-secondary-open]
 * shell attribute that drives the CSS grid, the width CSS var, and the side-aware
 * resize drag (pointer + keyboard, clamped). Standalone JSDOM. The module is
 * chrome-only; panel CONTENT is mounted by the panels' own instances, so this
 * test asserts no content rendering. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeSecondarySidebar,
  MIN_SECONDARY_WIDTH,
  MAX_SECONDARY_WIDTH,
} = require('../renderer/features/renderer-ide-secondary-sidebar');

function setup(opts = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="ideShell" data-rail-side="${opts.railSide || 'left'}">
      <aside id="ideSecondarySidebar" class="hidden">
        <div id="ideSecondarySidebarResizer" class="hidden"></div>
        <nav id="ideSecondarySidebarHeader"></nav>
        <div id="ideSecondarySidebarPanel"></div>
      </aside>
    </div>
  </body>`);
  const doc = dom.window.document;
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  const byId = (id) => doc.getElementById(id);
  const ide = {
    secondaryPanelOpen: opts.open !== false,
    secondaryPanel: 'secondaryPanel' in opts ? opts.secondaryPanel : 'search',
    secondaryWidth: opts.width || 260,
    railSide: opts.railSide || 'left',
    // Default: search + changes live in the secondary sidebar; explorer +
    // source-control stay in the primary rail.
    panelLocations: opts.locations || {
      explorer: 'primary',
      search: 'secondary',
      changes: 'secondary',
      'source-control': 'primary',
    },
  };
  const calls = { render: 0, persist: 0, moves: [] };
  const sidebar = createIdeSecondarySidebar({
    getDom: () => ({
      ideShell: byId('ideShell'),
      ideSecondarySidebar: byId('ideSecondarySidebar'),
      ideSecondarySidebarResizer: byId('ideSecondarySidebarResizer'),
      ideSecondarySidebarHeader: byId('ideSecondarySidebarHeader'),
      ideSecondarySidebarPanel: byId('ideSecondarySidebarPanel'),
    }),
    getIde: () => ide,
    requestRender: () => { calls.render += 1; sidebar.render(); },
    schedulePersist: () => { calls.persist += 1; },
    onMovePanel: (id, target) => { calls.moves.push([id, target]); },
  });
  sidebar.bindEvents();
  sidebar.render();
  function dispose() {
    sidebar.dispose();
    globalThis.window = prevWindow;
  }
  return { dom, doc, byId, ide, calls, sidebar, dispose };
}

test('renders an activity-bar button per SECONDARY-LOCATED panel + collapse, marks the active panel', (t) => {
  const h = setup();
  t.after(() => h.dispose());
  const header = h.byId('ideSecondarySidebarHeader');
  const tabs = [...header.querySelectorAll('[data-ide-secondary-panel]')];
  // Only the located panels (search + changes), in RAIL_PANELS order.
  assert.deepEqual(tabs.map((b) => b.dataset.ideSecondaryPanel), ['search', 'changes']);
  // The header mirrors the rail activity bar: .ide-activity-button per panel.
  assert.ok(tabs.every((b) => b.classList.contains('ide-activity-button')), 'buttons mirror the activity bar');
  // ...including the tab semantics inside the role="tablist" header.
  assert.ok(tabs.every((b) => b.getAttribute('role') === 'tab'), 'panel buttons are tabs');
  assert.ok(tabs.every((b) => !b.hasAttribute('aria-pressed')), 'no toggle-button semantics');
  // The Jenny-edits panel uses the same label as the rail ("Jenny's Changes").
  const changesTab = tabs.find((b) => b.dataset.ideSecondaryPanel === 'changes');
  assert.match(changesTab.getAttribute('aria-label') || changesTab.textContent, /Jenny's Changes/);
  // Moving a panel is a right-click action now, not an inline header control.
  assert.equal(header.querySelector('[data-ide-move-panel]'), null, 'no inline move control');
  assert.ok(header.querySelector('[data-ide-secondary-collapse]'), 'collapse control rendered');
  const active = tabs.filter((b) => b.classList.contains('ide-activity-button--active'));
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.ideSecondaryPanel, 'search');
  // Chrome only: the module never paints the content host.
  assert.equal(h.byId('ideSecondarySidebarPanel').innerHTML, '', 'module does not mount panel content');
});

test('panel tabs sit in a role=tablist of ONLY tabs (collapse outside) with a roving tabindex', (t) => {
  const h = setup(); // search (active) + changes located secondary
  t.after(() => h.dispose());
  const header = h.byId('ideSecondarySidebarHeader');
  const tablist = header.querySelector('[role="tablist"]');
  assert.ok(tablist, 'an inner tablist wraps the panel tabs');
  // Invalid ARIA was a tablist holding the non-tab collapse button; the tablist
  // now contains ONLY role=tab children.
  assert.ok([...tablist.children].every((el) => el.getAttribute('role') === 'tab'), 'tablist holds only tabs');
  assert.equal(tablist.querySelector('[data-ide-secondary-collapse]'), null, 'collapse is not inside the tablist');
  assert.ok(header.querySelector('[data-ide-secondary-collapse]'), 'collapse still rendered (toolbar sibling)');
  // Roving tabindex: only the active (search) tab is in the Tab order.
  const tabs = [...header.querySelectorAll('[data-ide-secondary-panel]')];
  const inOrder = tabs.filter((b) => b.getAttribute('tabindex') === '0');
  assert.equal(inOrder.length, 1, 'one tab in the Tab order');
  assert.equal(inOrder[0].dataset.ideSecondaryPanel, 'search');
  assert.equal(
    tabs.find((b) => b.dataset.ideSecondaryPanel === 'changes').getAttribute('tabindex'),
    '-1',
    'the inactive tab leaves the Tab order',
  );
});

test('secondary header arrow keys move focus AND activate the focused panel (Home/End jump)', (t) => {
  const h = setup({ secondaryPanel: 'search' }); // search + changes located secondary
  t.after(() => h.dispose());
  const header = h.byId('ideSecondarySidebarHeader');
  const arrowOn = (el, key) => el.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const search = header.querySelector('[data-ide-secondary-panel="search"]');
  search.focus();

  // ArrowDown -> next panel (changes): activates + focus follows + roving 0 moves.
  arrowOn(search, 'ArrowDown');
  assert.equal(h.ide.secondaryPanel, 'changes', 'ArrowDown activates the next panel');
  let focused = h.doc.activeElement;
  assert.equal(focused?.dataset?.ideSecondaryPanel, 'changes', 'focus follows the activation');
  assert.equal(focused.getAttribute('tabindex'), '0', 'the newly active tab takes the roving tabindex');

  // Home -> first panel (search).
  arrowOn(focused, 'Home');
  assert.equal(h.ide.secondaryPanel, 'search', 'Home jumps to the first panel');
  assert.equal(h.doc.activeElement?.dataset?.ideSecondaryPanel, 'search', 'focus moved to the first tab');

  // ArrowUp wraps from the first panel to the last (changes).
  arrowOn(h.doc.activeElement, 'ArrowUp');
  assert.equal(h.ide.secondaryPanel, 'changes', 'ArrowUp wraps to the last panel');
});

test('open() drives [data-secondary-open] on the shell and shows the container + resizer', (t) => {
  const h = setup({ open: false });
  t.after(() => h.dispose());
  assert.equal(h.byId('ideShell').getAttribute('data-secondary-open'), 'false');
  assert.equal(h.byId('ideSecondarySidebar').classList.contains('hidden'), true);
  h.sidebar.open();
  assert.equal(h.ide.secondaryPanelOpen, true);
  assert.equal(h.byId('ideShell').getAttribute('data-secondary-open'), 'true');
  assert.equal(h.byId('ideSecondarySidebar').classList.contains('hidden'), false, 'container shown when open');
  assert.equal(h.byId('ideSecondarySidebarResizer').classList.contains('hidden'), false, 'resizer shown when open');
});

test('clicking a tab switches the active secondary panel and persists', (t) => {
  const h = setup({ secondaryPanel: 'search' });
  t.after(() => h.dispose());
  h.byId('ideSecondarySidebarHeader').querySelector('[data-ide-secondary-panel="changes"]').click();
  assert.equal(h.ide.secondaryPanel, 'changes');
  assert.equal(h.ide.secondaryPanelOpen, true);
  assert.ok(h.calls.persist >= 1, 'switch persisted');
  const active = [...h.byId('ideSecondarySidebarHeader').querySelectorAll('.ide-activity-button--active')];
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.ideSecondaryPanel, 'changes');
});

test('clicking the already-active tab while open is a no-op (no extra persist)', (t) => {
  const h = setup({ secondaryPanel: 'search' });
  t.after(() => h.dispose());
  const persistBefore = h.calls.persist;
  h.byId('ideSecondarySidebarHeader').querySelector('[data-ide-secondary-panel="search"]').click();
  assert.equal(h.ide.secondaryPanel, 'search', 'active panel unchanged');
  assert.equal(h.calls.persist, persistBefore, 'clicking the active tab does not persist again');
});

test("right-clicking a tab raises onMovePanel(id, 'primary') and does not switch the tab", (t) => {
  const h = setup({ secondaryPanel: 'search' });
  t.after(() => h.dispose());
  const persistBefore = h.calls.persist;
  const tab = h.byId('ideSecondarySidebarHeader').querySelector('[data-ide-secondary-panel="changes"]');
  tab.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
  const item = h.doc.body.querySelector('.inv-context-menu-item');
  assert.ok(item, 'right-click opens the move menu');
  assert.equal(item.textContent, 'Move to Primary Sidebar');
  item.click();
  assert.deepEqual(h.calls.moves, [['changes', 'primary']]);
  assert.equal(h.ide.secondaryPanel, 'search', 'move does not switch the active tab');
  assert.equal(h.calls.persist, persistBefore, 'the module does not persist - onMovePanel owns that');
});

test('the collapse control closes the sidebar (hides container, clears shell attribute)', (t) => {
  const h = setup();
  t.after(() => h.dispose());
  h.byId('ideSecondarySidebarHeader').querySelector('[data-ide-secondary-collapse]').click();
  assert.equal(h.ide.secondaryPanelOpen, false);
  assert.equal(h.byId('ideSecondarySidebar').classList.contains('hidden'), true, 'container hidden when closed');
  assert.equal(h.byId('ideSecondarySidebarResizer').classList.contains('hidden'), true, 'resizer hidden when closed');
  assert.equal(h.byId('ideShell').getAttribute('data-secondary-open'), 'false');
});

test('toggle flips open/closed; open(panel) targets a located panel', (t) => {
  const h = setup({ open: false });
  t.after(() => h.dispose());
  assert.equal(h.ide.secondaryPanelOpen, false);
  h.sidebar.toggle();
  assert.equal(h.ide.secondaryPanelOpen, true);
  h.sidebar.toggle();
  assert.equal(h.ide.secondaryPanelOpen, false);
  h.sidebar.open('changes'); // changes IS located secondary
  assert.equal(h.ide.secondaryPanelOpen, true);
  assert.equal(h.ide.secondaryPanel, 'changes');
});

test('setPanel ignores ids not located in the secondary sidebar', (t) => {
  const h = setup({ secondaryPanel: 'search' });
  t.after(() => h.dispose());
  const persistBefore = h.calls.persist;
  h.sidebar.setPanel('source-control'); // located in the primary rail
  assert.equal(h.ide.secondaryPanel, 'search', 'unchanged for a primary-located id');
  h.sidebar.setPanel('terminal'); // not a rail panel at all
  assert.equal(h.ide.secondaryPanel, 'search', 'unchanged for an unknown id');
  assert.equal(h.calls.persist, persistBefore, 'no persist for invalid targets');
});

test('an empty secondary side renders as closed even if the open flag is stale', (t) => {
  const h = setup({ open: true, locations: { explorer: 'primary', search: 'primary', changes: 'primary', 'source-control': 'primary' } });
  t.after(() => h.dispose());
  // Nothing is located here, so the container is hidden + the attribute false,
  // and the header is not painted.
  assert.equal(h.byId('ideShell').getAttribute('data-secondary-open'), 'false');
  assert.equal(h.byId('ideSecondarySidebar').classList.contains('hidden'), true);
  assert.equal(h.byId('ideSecondarySidebarHeader').innerHTML, '', 'no header paint while empty');
});

test('a closed sidebar skips header rendering', (t) => {
  const h = setup({ open: false });
  t.after(() => h.dispose());
  assert.equal(h.byId('ideSecondarySidebarHeader').innerHTML, '', 'no header paint while closed');
  assert.equal(h.byId('ideSecondarySidebar').classList.contains('hidden'), true);
});

test('applyWidthVar writes the persisted width to the --ide-secondary-sidebar-width CSS var', (t) => {
  const h = setup({ width: 300 });
  t.after(() => h.dispose());
  assert.equal(
    h.byId('ideShell').style.getPropertyValue('--ide-secondary-sidebar-width'),
    '300px'
  );
});

test('keyboard resize is side-aware (rail left -> sidebar right -> ArrowLeft grows) and clamps', (t) => {
  const h = setup({ width: 260, railSide: 'left' }); // sidebar docks RIGHT; grab edge on its left
  t.after(() => h.dispose());
  const resizer = h.byId('ideSecondarySidebarResizer');
  const arrow = (key) => resizer.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  arrow('ArrowLeft');
  assert.equal(h.ide.secondaryWidth, 284, 'ArrowLeft grows the right-docked sidebar (matches drag-left-grows)');
  assert.equal(
    h.byId('ideShell').style.getPropertyValue('--ide-secondary-sidebar-width'),
    '284px'
  );
  arrow('ArrowRight');
  assert.equal(h.ide.secondaryWidth, 260, 'ArrowRight shrinks it back');
  for (let i = 0; i < 100; i += 1) { arrow('ArrowLeft'); }
  assert.equal(h.ide.secondaryWidth, MAX_SECONDARY_WIDTH);
  for (let i = 0; i < 100; i += 1) { arrow('ArrowRight'); }
  assert.equal(h.ide.secondaryWidth, MIN_SECONDARY_WIDTH);
  assert.ok(h.calls.persist >= 1, 'keyboard resize persisted');
});

test('keyboard resize flips with the side (rail right -> sidebar left -> ArrowRight grows)', (t) => {
  const h = setup({ width: 260, railSide: 'right' }); // sidebar docks LEFT; grab edge on its right
  t.after(() => h.dispose());
  const resizer = h.byId('ideSecondarySidebarResizer');
  const arrow = (key) => resizer.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  arrow('ArrowRight');
  assert.equal(h.ide.secondaryWidth, 284, 'ArrowRight grows the left-docked sidebar');
  arrow('ArrowLeft');
  assert.equal(h.ide.secondaryWidth, 260, 'ArrowLeft shrinks it back');
});

test('pointer drag (rail left -> sidebar right): drag LEFT widens and clamps', (t) => {
  const h = setup({ width: 260, railSide: 'left' });
  t.after(() => h.dispose());
  const win = h.dom.window;
  const resizer = h.byId('ideSecondarySidebarResizer');
  resizer.dispatchEvent(new win.MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 460 })); // dragged left 40px
  assert.equal(h.ide.secondaryWidth, 300, 'wider by the drag delta');
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: -5000 })); // wild drag clamps
  assert.equal(h.ide.secondaryWidth, MAX_SECONDARY_WIDTH);
  win.dispatchEvent(new win.MouseEvent('pointerup', { clientX: -5000 }));
  // Listeners detach on release: a further move changes nothing.
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 600 }));
  assert.equal(h.ide.secondaryWidth, MAX_SECONDARY_WIDTH);
  assert.ok(h.calls.persist >= 1, 'drag release persisted');
});

test('pointer drag (rail right -> sidebar left): drag RIGHT widens', (t) => {
  const h = setup({ width: 260, railSide: 'right' });
  t.after(() => h.dispose());
  const win = h.dom.window;
  const resizer = h.byId('ideSecondarySidebarResizer');
  resizer.dispatchEvent(new win.MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 540 })); // dragged right 40px
  assert.equal(h.ide.secondaryWidth, 300, 'wider by the drag delta on the opposite side');
  win.dispatchEvent(new win.MouseEvent('pointerup', { clientX: 540 }));
  assert.ok(h.calls.persist >= 1, 'drag release persisted on the rail-right side');
});
