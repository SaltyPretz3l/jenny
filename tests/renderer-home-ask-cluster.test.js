/* W11/W13 - the hero's right side becomes ONE cluster, then ONE ask LINE.
 *
 * Owner screenshot feedback: the focus/edit toggles, the ask pill, the config
 * chip, and a standing keyboard-hint line read as four disconnected objects,
 * and the chip's model label truncated to something that identified nothing.
 * W13 then dropped the capsule idiom entirely: a two-row stack, the model name
 * as plain text on the meta row rather than a chip parked inside the field.
 *
 * What these tests pin:
 *
 *  - formatModelDisplayName strips a RECOGNIZED quantization tail and nothing
 *    else. An unfamiliar suffix is kept, an id with no tag is untouched, and
 *    the full id is never what the trigger's title/aria-label loses.
 *  - The model trigger lives on `.home-ask__meta`, OUTSIDE the field row: it
 *    no longer sits inside the typing lane, and no longer reserves one.
 *  - The hint element still exists at rest and is wired to the field through
 *    aria-describedby - visibility is CSS-only, so screen readers keep it.
 *  - The trigger still survives a strip repaint, and the page-menu trigger
 *    joins the stack's flex line in the same built-once region, its items
 *    keeping the exact datasets the manager's delegation depends on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const askConfigModule = require('../renderer/features/renderer-dashboard-ask-config.js');
const pageMenuModule = require('../renderer/features/renderer-dashboard-page-menu.js');
const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const composerV2Model = require('../renderer/chat/renderer-composer-v2-model.js');
const reasoningEffortProfiles = require('../reasoning-effort-profiles.js');
const lifecycleFormatUtils = require('../renderer/shell/renderer-lifecycle-format-utils.js');
const inventoryChip = require('../renderer/inventory/chip.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventorySelectField = require('../renderer/inventory/select-field.js');
const inventoryToggleSwitchModule = require('../renderer/inventory/toggle-switch.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

const { formatModelDisplayName } = askConfigModule;

function buildInventory() {
  const toggleSwitch = inventoryToggleSwitchModule.toggleSwitch;
  toggleSwitch.toggle = inventoryToggleSwitchModule.toggle;
  toggleSwitch.setChecked = inventoryToggleSwitchModule.setChecked;
  toggleSwitch.initToggleHandlers = inventoryToggleSwitchModule.initToggleHandlers;
  return {
    chip: inventoryChip,
    popover: inventoryPopover,
    selectField: inventorySelectField,
    actionButton: inventoryActionButton,
    toggleSwitch,
  };
}

function mountStrip(t, options = {}) {
  const dom = new JSDOM('<main><div id="homeInfoStrip" hidden></div></main>');
  const documentRef = dom.window.document;
  const strip = documentRef.getElementById('homeInfoStrip');
  const state = {
    homeConfig: { focusMode: options.focusMode === true },
    ui: { dashboardEditMode: options.editMode === true },
  };
  const renderer = widgetsCore.createInfoStripRenderer({
    nowProvider: () => new Date(2026, 5, 11, 8, 5),
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
  });
  const repaint = () => renderer.render(strip, { state });
  repaint();

  const controller = askConfigModule.createAskConfigController({
    documentRef,
    shell: { models: { list: async () => ({ data: [] }) } },
    getState: () => ({ features: { tools: {} } }),
    getRuntimePreferences: () => ({
      preferredModel: options.preferredModel || '',
      reasoningEffort: options.reasoningEffort || 'default',
    }),
    inventory: buildInventory(),
    modules: { composerV2Model, reasoningEffortProfiles, lifecycleFormatUtils },
  });
  t.after(() => controller.dispose());
  controller.ensure(strip.querySelector('.home-info-strip__ask'));

  return { dom, documentRef, strip, controller, repaint };
}

// The models catalog read is lazy; let it settle before reading the chip.
async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('formatModelDisplayName drops a recognized quantization tail and never guesses', () => {
  // The owner's screenshot case: the tail is the part the chip truncated away.
  assert.equal(formatModelDisplayName('qwen3.8:27b-q3-k-s'), 'qwen3.8:27b');
  // Unsloth dynamic i-quants anchor on IQ<n>, not Q<n> - the installed
  // qwen3.8 build and muse-glimmer both land here.
  assert.equal(formatModelDisplayName('qwen3.8:27b-ud-iq3-s'), 'qwen3.8:27b');
  assert.equal(formatModelDisplayName('muse-glimmer:30b-iq2-xs'), 'muse-glimmer:30b');
  // Anchor plus the build marker that only ever precedes one.
  assert.equal(formatModelDisplayName('qwen3.6:35b-a3b-ud-q4_k_xl'), 'qwen3.6:35b-a3b');
  // A context-length suffix is NOT a quantization tail - it identifies the
  // build, so it stays. This is the "never guess" half of the contract.
  assert.equal(formatModelDisplayName('ornith:9b-48k'), 'ornith:9b-48k');
  // No tag at all: hosted ids are returned byte-identical.
  assert.equal(formatModelDisplayName('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(formatModelDisplayName(''), '');

  // Guards around the edges of the rule.
  assert.equal(formatModelDisplayName('qwen3:8b'), 'qwen3:8b', 'a plain size tag is already the name');
  assert.equal(formatModelDisplayName('llama3.1:8b-instruct-q4_0'), 'llama3.1:8b-instruct',
    'instruct is part of the identity, only the quant tail goes');
  assert.equal(formatModelDisplayName('foo:q4_k_m'), 'foo:q4_k_m',
    'a tag that is NOTHING but a quant tail is kept whole rather than emptied');
  assert.equal(formatModelDisplayName('bar:8b-m'), 'bar:8b-m',
    'a lone modifier with no anchor behind it is not a quant tail');
  assert.equal(formatModelDisplayName(null), '');
});

test('the trigger labels the short name while title and aria-label keep the full id', async (t) => {
  const { documentRef } = mountStrip(t, { preferredModel: 'qwen3.8:27b-q3-k-s' });
  await settle();

  const chip = documentRef.getElementById('homeAskConfigChip');
  assert.equal(chip.querySelector('.home-ask__model-label').textContent, 'qwen3.8:27b');
  assert.match(chip.getAttribute('aria-label'), /Ask settings: qwen3\.8:27b-q3-k-s/,
    'nothing is actually hidden - the full id is the accessible name');
  assert.match(chip.getAttribute('title'), /qwen3\.8:27b-q3-k-s/);
  // Still a real popover trigger after losing the chip chrome.
  assert.equal(chip.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(chip.getAttribute('aria-controls'), 'homeAskConfigPopover');
  assert.equal(chip.tagName, 'BUTTON');
  // It is PLAIN text now, not a chip: no inventory chip chrome comes with it,
  // which is what lets the model name read as information rather than a control.
  assert.equal(chip.classList.contains('inv-chip'), false);
  assert.equal(chip.classList.contains('btn'), false);
  assert.equal(chip.classList.contains('home-ask__model'), true);
});

test('the model trigger lives on the meta row, outside the field row', async (t) => {
  const { documentRef, strip } = mountStrip(t, { preferredModel: 'qwen3:8b' });
  await settle();

  const region = strip.querySelector('.home-info-strip__ask');
  const shell = region.querySelector('.home-ask__shell');
  const fieldRow = region.querySelector('.home-ask__field-row');
  const meta = region.querySelector('.home-ask__meta');
  const chip = documentRef.getElementById('homeAskConfigChip');
  const input = documentRef.getElementById('homeAskPill');

  assert.ok(shell && fieldRow && meta, 'the ask block is a two-row stack');
  assert.equal(fieldRow.contains(input), true, 'the field row holds the field alone');
  assert.equal(fieldRow.contains(chip), false,
    'the trigger no longer sits inside the typing lane');
  assert.equal(meta.contains(chip), true, 'it is a meta-row control');
  // FIRST on the row: the model name is information and leads it; the hint and
  // the send button follow at the row's right end.
  assert.equal(meta.firstElementChild.classList.contains('home-ask-config'), true);
  assert.deepEqual(
    [...meta.children].map((child) => child.className.split(' ')[0]),
    ['home-ask-config', 'inv-text-field-hint', 'home-ask__send']
  );
  // It is still inside the BUILT-ONCE region (C6): not in the repainted chrome.
  assert.equal(region.contains(chip), true);
  assert.equal(strip.querySelector('.home-info-strip__chrome').contains(chip), false);
});

test('the keyboard hint stays in the DOM and stays wired to the input', async (t) => {
  const { documentRef, strip, repaint } = mountStrip(t);
  await settle();

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

test('a strip repaint keeps the same trigger node inside the same ask shell', async (t) => {
  const { documentRef, strip, repaint } = mountStrip(t, { preferredModel: 'qwen3:8b' });
  await settle();

  const chipBefore = documentRef.getElementById('homeAskConfigChip');
  const shellBefore = strip.querySelector('.home-ask__shell');
  repaint();

  assert.equal(documentRef.getElementById('homeAskConfigChip'), chipBefore, 'the SAME trigger survives');
  assert.equal(strip.querySelector('.home-ask__shell'), shellBefore);
  assert.equal(shellBefore.contains(chipBefore), true, 'and it is still on the ask line');
});

test('buildModelOptionsArray keeps the missing-selected annotation unless a caller opts out', () => {
  const models = [{ id: 'qwen3:8b' }];
  const annotated = lifecycleFormatUtils.buildModelOptionsArray(models, 'gone:7b', { compact: true });
  assert.equal(annotated[1].label, 'gone:7b (selected)',
    'the Settings default stays byte-identical');
  const plain = lifecycleFormatUtils.buildModelOptionsArray(models, 'gone:7b', {
    compact: true,
    annotateMissingSelected: false,
  });
  assert.equal(plain[1].label, 'gone:7b', 'the opt-out drops only the state suffix');
  assert.equal(plain[1].selected, true, 'selection state is untouched');
});

test('the ask panel shows a missing selected model without the state suffix', async (t) => {
  const { dom, documentRef } = mountStrip(t, { preferredModel: 'gone:7b' });
  await settle();
  documentRef.getElementById('homeAskConfigChip')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const select = documentRef.querySelector('[data-ask-config="model"]');
  assert.ok(select, 'the panel renders the model select');
  const option = [...select.querySelectorAll('option')].find((opt) => opt.value === 'gone:7b');
  assert.equal(option.textContent, 'gone:7b',
    'the closed select IS the selection display — no "(selected)" leak');
  assert.equal(option.selected, true);
});

test('the page-menu trigger shares the built-once ask region with the pill', (t) => {
  const { dom, documentRef, strip, repaint } = mountStrip(t);
  const state = { homeConfig: { focusMode: false }, ui: { dashboardEditMode: false } };
  const controller = pageMenuModule.createPageMenuController({
    documentRef,
    getState: () => state,
    inventory: buildInventory(),
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
  // alone, exactly like the pill and the chip.
  repaint();
  assert.equal(documentRef.getElementById('homePageMenuTrigger'), trigger);
  assert.equal(documentRef.getElementById('homePageMenuPopover'), popover);
  assert.equal(popover.hidden, false, 'a repaint does not slam the menu shut');
});
