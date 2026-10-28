/* W11/W13 - the hero's right side is ONE ask LINE; 2026-10-21 slimmed it to a
 * plain launcher.
 *
 * The ask line is a two-row stack: the field row holds the field alone, and
 * the meta row carries the keyboard hint and the send button. The chat's
 * model, effort and tools are the composer's own, so the line has no config
 * chip or settings popover.
 *
 * What these tests pin:
 *
 *  - The meta row holds the hint and the send button, and nothing else.
 *  - The hint element still exists at rest and is wired to the field through
 *    aria-describedby - visibility is CSS-only, so screen readers keep it.
 *  - The ask shell survives a strip repaint, and the page-menu trigger joins
 *    the stack's flex line in the same built-once region, its items keeping
 *    the exact datasets the manager's delegation depends on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const pageMenuModule = require('../renderer/features/renderer-dashboard-page-menu.js');
const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const lifecycleFormatUtils = require('../renderer/shell/renderer-lifecycle-format-utils.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

function mountStrip() {
  const dom = new JSDOM('<main><div id="homeInfoStrip" hidden></div></main>');
  const documentRef = dom.window.document;
  const strip = documentRef.getElementById('homeInfoStrip');
  const state = { homeConfig: { focusMode: false }, ui: { dashboardEditMode: false } };
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
  });
  const repaint = () => renderer.render(strip, { state });
  repaint();
  return { dom, documentRef, strip, state, repaint };
}

test('the meta row carries the hint and the send button, outside the field row', () => {
  const { documentRef, strip } = mountStrip();

  const region = strip.querySelector('.home-info-strip__ask');
  const fieldRow = region.querySelector('.home-ask__field-row');
  const meta = region.querySelector('.home-ask__meta');
  const input = documentRef.getElementById('homeAskPill');

  assert.ok(region.querySelector('.home-ask__shell') && fieldRow && meta, 'the ask block is a two-row stack');
  assert.equal(fieldRow.contains(input), true, 'the field row holds the field alone');
  assert.deepEqual(
    [...meta.children].map((child) => child.className.split(' ')[0]),
    ['inv-text-field-hint', 'home-ask__send']
  );
  assert.equal(documentRef.getElementById('homeAskConfigChip'), null, 'no config chip on the line');
  assert.equal(region.querySelector('.inv-popover'), null, 'no settings popover either');
});

test('the keyboard hint stays in the DOM and stays wired to the input', () => {
  const { documentRef, strip, repaint } = mountStrip();

  const region = strip.querySelector('.home-info-strip__ask');
  const hint = region.querySelector('.inv-text-field-hint');
  const input = documentRef.getElementById('homeAskPill');

  assert.ok(hint, 'the hint element is permanent - only its VISIBILITY is CSS');
  assert.equal(hint.textContent, widgetsCore.ASK_HINT_TEXT);
  assert.equal(hint.textContent, 'Enter to send · Shift+Enter for a new line',
    'the hint states the composer-matching contract, not the retired one');
  assert.equal(hint.id, widgetsCore.ASK_HINT_DOM_ID);
  // It rides the META row, not the field label the primitive emitted it into.
  assert.equal(region.querySelector('.home-ask__meta').contains(hint), true);
  assert.equal(region.querySelector('.home-ask__field-row').contains(hint), false);
  assert.equal(input.getAttribute('aria-describedby'), widgetsCore.ASK_HINT_DOM_ID,
    'assistive tech reads the contract regardless of the visual state');
  // Nothing here is hidden by an attribute; a `hidden` flag would take it away
  // from screen readers too, which is exactly what the CSS reveal avoids.
  assert.equal(hint.hasAttribute('hidden'), false);

  repaint();
  assert.equal(region.querySelector('.inv-text-field-hint'), hint, 'the repaint leaves it alone');
  assert.equal(documentRef.getElementById('homeAskPill'), input);
});

test('a strip repaint keeps the same ask shell', () => {
  const { strip, repaint } = mountStrip();
  const shellBefore = strip.querySelector('.home-ask__shell');
  repaint();
  assert.equal(strip.querySelector('.home-ask__shell'), shellBefore);
});

test('buildModelOptionsArray annotates a selected model missing from the catalog', () => {
  const options = lifecycleFormatUtils.buildModelOptionsArray([{ id: 'qwen3:8b' }], 'gone:7b', { compact: true });
  assert.equal(options[1].label, 'gone:7b (selected)');
  assert.equal(options[1].selected, true);
});

test('the page-menu trigger shares the built-once ask region with the pill', (t) => {
  const { dom, documentRef, strip, state, repaint } = mountStrip();
  const controller = pageMenuModule.createPageMenuController({
    documentRef,
    getState: () => state,
    inventory: { popover: inventoryPopover, actionButton: inventoryActionButton },
    actionButton: inventoryActionButton,
  });
  t.after(() => controller.dispose());

  const region = strip.querySelector('.home-info-strip__ask');
  const trigger = controller.ensure(region);
  assert.ok(trigger, 'the trigger mounts into the ask region');
  // Cluster composition: pill shell first, page menu after it — flex siblings
  // on ONE line, and neither lives in the repainted chrome.
  const childClasses = [...region.children].map((child) => child.className);
  assert.deepEqual(childClasses, ['home-ask__shell', 'home-page-menu']);
  assert.equal(strip.querySelector('.home-info-strip__chrome').contains(trigger), false);

  // Items carry the exact datasets the manager's strip delegation handles.
  trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const popover = documentRef.getElementById('homePageMenuPopover');
  assert.equal(popover.hidden, false);
  assert.ok(popover.querySelector('[data-dashboard-focus-toggle]'));
  assert.ok(popover.querySelector('[data-dashboard-edit-toggle]'));

  // The 30s chrome repaint leaves the built-once menu (and its open state)
  // alone, exactly like the pill.
  repaint();
  assert.equal(documentRef.getElementById('homePageMenuTrigger'), trigger);
  assert.equal(documentRef.getElementById('homePageMenuPopover'), popover);
  assert.equal(popover.hidden, false, 'a repaint does not slam the menu shut');
});
