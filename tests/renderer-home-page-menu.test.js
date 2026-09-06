/* Home hero page menu: the [⋯] trigger + popover that absorbed the strip's
 * focus/edit toggles. Split from renderer-dashboard-widgets.test.js to keep
 * that file under the 600-line test ratchet.
 *
 * What these tests pin:
 *  - The repainted chrome carries NO page controls; they mount in the
 *    built-once ask region through the controller (the positive half that
 *    keeps the absence assertions non-vacuous).
 *  - Menu items keep the exact datasets the manager's strip delegation
 *    handles, and selecting one closes the menu.
 *  - The trigger stays lit (modifier class) while either mode is on, and a
 *    reopen rebuilds rows with fresh pressed state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const pageMenuModule = require('../renderer/features/renderer-dashboard-page-menu.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

function mountMenu(t) {
  const dom = new JSDOM('<main><div id="homeInfoStrip" hidden></div></main>');
  const documentRef = dom.window.document;
  const infoStrip = documentRef.getElementById('homeInfoStrip');
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
    textField: inventoryTextField,
  });
  const state = { homeConfig: { focusMode: false }, ui: { dashboardEditMode: false } };
  renderer.render(infoStrip, { state });
  const controller = pageMenuModule.createPageMenuController({
    documentRef,
    getState: () => state,
    inventory: { popover: inventoryPopover },
    actionButton: inventoryActionButton,
  });
  t.after(() => controller.dispose());
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return { documentRef, infoStrip, state, controller, click };
}

test('page menu: focus/edit controls fold into one trigger with labeled pressed rows', (t) => {
  const { documentRef, infoStrip, state, controller, click } = mountMenu(t);

  assert.equal(infoStrip.querySelector('.home-info-strip__chrome [data-dashboard-focus-toggle]'), null);
  assert.equal(infoStrip.querySelector('.home-info-strip__chrome [data-dashboard-edit-toggle]'), null);

  const trigger = controller.ensure(infoStrip.querySelector('.home-info-strip__ask'));
  assert.ok(trigger, 'the controller mounts its trigger into the ask region');
  assert.equal(trigger.getAttribute('aria-label'), 'Page options');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.textContent.trim(), '', 'the trigger is icon-only');
  assert.ok(trigger.querySelector('.home-info-strip__action-icon svg'));

  click(trigger);
  const popover = documentRef.getElementById('homePageMenuPopover');
  assert.equal(popover.hidden, false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');

  const focus = popover.querySelector('[data-dashboard-focus-toggle]');
  const edit = popover.querySelector('[data-dashboard-edit-toggle]');
  assert.ok(focus && edit, 'the items keep the datasets the manager delegation handles');
  assert.equal(focus.getAttribute('aria-pressed'), 'false');
  assert.match(focus.textContent, /Focus mode/);
  assert.match(focus.getAttribute('title'), /Ctrl\+Shift\+F/);
  assert.match(edit.textContent, /Edit layout/);
  assert.equal(focus.querySelector('.home-page-menu__item-check'), null, 'no check while off');

  // Selecting an item closes the menu (the manager owns the actual flip).
  click(focus);
  assert.equal(popover.hidden, true);

  // Active modes: the trigger stays lit and a reopened menu shows fresh state.
  state.homeConfig.focusMode = true;
  state.ui.dashboardEditMode = true;
  controller.sync();
  assert.ok(trigger.classList.contains('home-page-menu__trigger--active'));
  click(trigger);
  assert.equal(popover.querySelectorAll('.home-page-menu__item-check').length, 2);
  assert.equal(
    popover.querySelector('[data-dashboard-focus-toggle]').getAttribute('aria-pressed'),
    'true'
  );
  assert.match(
    popover.querySelector('[data-dashboard-edit-toggle]').getAttribute('title'),
    /Finish editing/
  );
});

test('page menu: ensure is idempotent and dispose detaches the trigger', (t) => {
  const { documentRef, infoStrip, controller, click } = mountMenu(t);
  const region = infoStrip.querySelector('.home-info-strip__ask');
  const trigger = controller.ensure(region);
  assert.equal(controller.ensure(region), trigger, 'repeat ensure reuses the mounted trigger');
  assert.equal(region.querySelectorAll('.home-page-menu').length, 1);
  // W13 renamed the ask block's shell (.home-ask-pill-shell -> .home-ask__shell)
  // and turned it into a two-row stack. The menu mounts on the REGION, so it
  // stays the stack's flex sibling rather than landing inside the ask line.
  assert.deepEqual(
    [...region.children].map((child) => child.className),
    ['home-ask__shell', 'home-page-menu']
  );
  assert.equal(region.querySelector('.home-ask__shell').contains(trigger), false);

  click(trigger);
  assert.equal(controller.isOpen(), true);
  controller.dispose();
  assert.equal(region.querySelector('.home-page-menu'), null,
    'dispose removes the controller-owned trigger and popover host');
  click(trigger);
  assert.equal(trigger.isConnected, false, 'the detached trigger cannot affect the document');
  assert.equal(documentRef.getElementById('homePageMenuPopover'), null);
  assert.equal(controller.ensure(region), null, 'a disposed controller refuses to remount');
});

test('page menu: same-document rebootstrap replaces the disposed controller host', (t) => {
  const { documentRef, infoStrip, state, controller } = mountMenu(t);
  const region = infoStrip.querySelector('.home-info-strip__ask');
  controller.ensure(region);
  controller.dispose();

  const replacement = pageMenuModule.createPageMenuController({
    documentRef,
    getState: () => state,
    inventory: { popover: inventoryPopover },
    actionButton: inventoryActionButton,
  });
  t.after(() => replacement.dispose());
  const trigger = replacement.ensure(region);

  assert.equal(region.querySelectorAll('.home-page-menu').length, 1);
  assert.equal(region.querySelectorAll('#homePageMenuTrigger').length, 1);
  assert.equal(region.querySelectorAll('#homePageMenuPopover').length, 1);
  assert.equal(trigger, region.querySelector('#homePageMenuTrigger'));
});
