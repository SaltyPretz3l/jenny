const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const segmentedControl = require('../renderer/inventory/segmented-control');

const TWO_OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

const THREE_OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

/* ── Rendering ── */

test('segmentedControl renders a radiogroup with one aria-checked=true and roving tabindex', () => {
  const html = segmentedControl({ id: 'view', ariaLabel: 'View mode', value: 'b', options: THREE_OPTIONS });
  assert.ok(html.includes('role="radiogroup"'));
  assert.ok(html.includes('data-inv-segmented="view"'));
  assert.ok(html.includes('aria-label="View mode"'));

  const dom = new JSDOM(`<div>${html}</div>`);
  const options = [...dom.window.document.querySelectorAll('[role="radio"]')];
  assert.equal(options.length, 3);

  const checked = options.filter((el) => el.getAttribute('aria-checked') === 'true');
  assert.equal(checked.length, 1, 'exactly one option is checked');
  assert.equal(checked[0].getAttribute('data-value'), 'b');
  assert.ok(checked[0].classList.contains('inv-segmented-option--on'));
  assert.equal(checked[0].getAttribute('tabindex'), '0');

  const others = options.filter((el) => el.getAttribute('data-value') !== 'b');
  for (const el of others) {
    assert.equal(el.getAttribute('aria-checked'), 'false');
    assert.equal(el.getAttribute('tabindex'), '-1');
  }
});

test('segmentedControl only sets a title attribute for an explicit escaped tooltip', () => {
  const html = segmentedControl({
    value: 'a',
    options: [
      { value: 'a', label: 'A very long option label that might overflow' },
      { value: 'b', label: 'Short', tooltip: 'Short & "helpful"' },
    ],
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const options = [...dom.window.document.querySelectorAll('[role="radio"]')];
  assert.equal(options[0].hasAttribute('title'), false);
  assert.equal(options[1].getAttribute('title'), 'Short & "helpful"');
});

test('segmentedControl marks the disabled group and disabled option', () => {
  const html = segmentedControl({
    value: 'a',
    disabled: true,
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
    ],
  });
  assert.ok(html.includes('inv-segmented--disabled'));
  const dom = new JSDOM(`<div>${html}</div>`);
  const disabledOption = dom.window.document.querySelector('[data-value="b"]');
  assert.equal(disabledOption.disabled, true);
  assert.equal(disabledOption.getAttribute('aria-disabled'), 'true');
});

test('segmentedControl closed-enum guard: fewer than 2 or more than 4 options renders nothing', () => {
  assert.equal(segmentedControl({ value: 'a', options: [{ value: 'a', label: 'A' }] }), '');
  assert.equal(segmentedControl({ value: 'a', options: [] }), '');
  const fiveOptions = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: 'Opt ' + n }));
  assert.equal(segmentedControl({ value: '1', options: fiveOptions }), '');
});

test('segmentedControl accepts the boundary sizes 2 and 4', () => {
  assert.notEqual(segmentedControl({ value: 'a', options: TWO_OPTIONS }), '');
  const fourOptions = [1, 2, 3, 4].map((n) => ({ value: String(n), label: 'Opt ' + n }));
  assert.notEqual(segmentedControl({ value: '1', options: fourOptions }), '');
});

/* ── select() imperative helper ── */

function buildDom(options, value) {
  const html = segmentedControl({ id: 'view', ariaLabel: 'View mode', value, options });
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  return { dom, document, group: document.querySelector('.inv-segmented') };
}

test('value matching a disabled option: stays checked, but the tab stop moves to the first enabled option', () => {
  const html = segmentedControl({
    id: 'view',
    value: 'b',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta', disabled: true },
      { value: 'c', label: 'Gamma' },
    ],
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const options = [...dom.window.document.querySelectorAll('[role="radio"]')];
  const checked = options.filter((el) => el.getAttribute('aria-checked') === 'true');
  assert.equal(checked.length, 1);
  assert.equal(checked[0].getAttribute('data-value'), 'b');
  assert.equal(checked[0].getAttribute('tabindex'), '-1', 'disabled option must not hold the tab stop');
  const stops = options.filter((el) => el.getAttribute('tabindex') === '0');
  assert.equal(stops.length, 1, 'group keeps exactly one tab stop');
  assert.equal(stops[0].getAttribute('data-value'), 'a');
});

test('value matching nothing: no option is checked; first enabled option holds the tab stop', () => {
  const html = segmentedControl({ id: 'view', value: 'zzz', options: THREE_OPTIONS });
  const dom = new JSDOM(`<div>${html}</div>`);
  const options = [...dom.window.document.querySelectorAll('[role="radio"]')];
  assert.equal(options.filter((el) => el.getAttribute('aria-checked') === 'true').length, 0);
  assert.equal(options.filter((el) => el.classList.contains('inv-segmented-option--on')).length, 0);
  const stops = options.filter((el) => el.getAttribute('tabindex') === '0');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].getAttribute('data-value'), 'a');
});

test('select() with an unknown or disabled value is a strict no-op (tab stops untouched)', () => {
  const html = segmentedControl({
    id: 'view',
    value: 'a',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta', disabled: true },
      { value: 'c', label: 'Gamma' },
    ],
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const group = dom.window.document.querySelector('.inv-segmented');
  const events = [];
  group.addEventListener('inv-segmented-change', (event) => events.push(event.detail));

  const before = [...group.querySelectorAll('[role="radio"]')].map((el) => el.outerHTML).join('');
  segmentedControl.select(group, 'zzz');
  segmentedControl.select(group, 'b');
  const after = [...group.querySelectorAll('[role="radio"]')].map((el) => el.outerHTML).join('');
  assert.equal(after, before, 'no attribute/class mutation on no-op selects');
  assert.deepEqual(events, [], 'no inv-segmented-change dispatched');
});

test('select() updates aria-checked/tabindex/--on classes and dispatches inv-segmented-change', () => {
  const { document, group } = buildDom(THREE_OPTIONS, 'a');
  const events = [];
  document.addEventListener('inv-segmented-change', (event) => events.push(event.detail));

  segmentedControl.select(group, 'c');

  const optC = group.querySelector('[data-value="c"]');
  const optA = group.querySelector('[data-value="a"]');
  assert.equal(optC.getAttribute('aria-checked'), 'true');
  assert.equal(optC.getAttribute('tabindex'), '0');
  assert.ok(optC.classList.contains('inv-segmented-option--on'));
  assert.equal(optA.getAttribute('aria-checked'), 'false');
  assert.equal(optA.getAttribute('tabindex'), '-1');
  assert.ok(!optA.classList.contains('inv-segmented-option--on'));

  assert.deepEqual(events, [{ id: 'view', value: 'c' }]);
});

/* ── initSegmentedHandlers: click ── */

test('initSegmentedHandlers: click on an enabled option selects it', () => {
  const { document, group } = buildDom(THREE_OPTIONS, 'a');
  segmentedControl.initSegmentedHandlers(document);

  const optB = group.querySelector('[data-value="b"]');
  optB.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));

  assert.equal(optB.getAttribute('aria-checked'), 'true');
});

test('initSegmentedHandlers: re-clicking the already-selected option does not re-fire inv-segmented-change', () => {
  const { document, group } = buildDom(THREE_OPTIONS, 'a');
  segmentedControl.initSegmentedHandlers(document);
  const events = [];
  document.addEventListener('inv-segmented-change', (event) => events.push(event.detail));

  const optA = group.querySelector('[data-value="a"]');
  optA.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(events, [], 'no redundant change event for an unchanged value');
  assert.equal(optA.getAttribute('aria-checked'), 'true', 'selection untouched');
});

test('initSegmentedHandlers: click on a disabled option is a no-op', () => {
  const html = segmentedControl({
    value: 'a',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
    ],
  });
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  segmentedControl.initSegmentedHandlers(document);

  const optB = document.querySelector('[data-value="b"]');
  optB.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.equal(optB.getAttribute('aria-checked'), 'false');
});

test('initSegmentedHandlers: click inside a disabled group is a no-op', () => {
  const html = segmentedControl({ value: 'a', disabled: true, options: TWO_OPTIONS });
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  segmentedControl.initSegmentedHandlers(document);

  const optB = document.querySelector('[data-value="b"]');
  optB.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.equal(optB.getAttribute('aria-checked'), 'false');
});

/* ── initSegmentedHandlers: keyboard ── */

function dispatchKeydown(el, key) {
  const view = el.ownerDocument.defaultView;
  el.dispatchEvent(new view.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

test('ArrowRight moves selection and focus to the next option, wrapping at the end', () => {
  const { document, group } = buildDom(THREE_OPTIONS, 'c');
  segmentedControl.initSegmentedHandlers(document);

  const optC = group.querySelector('[data-value="c"]');
  optC.focus();
  dispatchKeydown(optC, 'ArrowRight');

  const optA = group.querySelector('[data-value="a"]');
  assert.equal(optA.getAttribute('aria-checked'), 'true', 'wraps from last to first');
  assert.equal(document.activeElement, optA, 'focus moved with selection');
});

test('ArrowLeft moves selection and focus to the previous option, wrapping at the start', () => {
  const { document, group } = buildDom(THREE_OPTIONS, 'a');
  segmentedControl.initSegmentedHandlers(document);

  const optA = group.querySelector('[data-value="a"]');
  optA.focus();
  dispatchKeydown(optA, 'ArrowLeft');

  const optC = group.querySelector('[data-value="c"]');
  assert.equal(optC.getAttribute('aria-checked'), 'true', 'wraps from first to last');
  assert.equal(document.activeElement, optC);
});

test('Home and End jump to the first and last option', () => {
  const { document, group } = buildDom(THREE_OPTIONS, 'b');
  segmentedControl.initSegmentedHandlers(document);

  const optB = group.querySelector('[data-value="b"]');
  optB.focus();
  dispatchKeydown(optB, 'End');
  const optC = group.querySelector('[data-value="c"]');
  assert.equal(optC.getAttribute('aria-checked'), 'true');
  assert.equal(document.activeElement, optC);

  dispatchKeydown(optC, 'Home');
  const optA = group.querySelector('[data-value="a"]');
  assert.equal(optA.getAttribute('aria-checked'), 'true');
  assert.equal(document.activeElement, optA);
});

test('keyboard navigation skips disabled options', () => {
  const html = segmentedControl({
    value: 'a',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
    ],
  });
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  segmentedControl.initSegmentedHandlers(document);

  const optA = document.querySelector('[data-value="a"]');
  optA.focus();
  dispatchKeydown(optA, 'ArrowRight');

  const optC = document.querySelector('[data-value="c"]');
  assert.equal(optC.getAttribute('aria-checked'), 'true', 'skipped the disabled middle option');
  assert.equal(document.activeElement, optC);
});

test('isComposing keydown is ignored', () => {
  const { document, group } = buildDom(THREE_OPTIONS, 'a');
  segmentedControl.initSegmentedHandlers(document);

  const optA = group.querySelector('[data-value="a"]');
  optA.focus();
  const view = document.defaultView;
  const event = new view.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'isComposing', { value: true });
  optA.dispatchEvent(event);

  assert.equal(optA.getAttribute('aria-checked'), 'true', 'selection unchanged during composition');
});

test('initSegmentedHandlers installs once per root', () => {
  const { document } = buildDom(THREE_OPTIONS, 'a');
  segmentedControl.initSegmentedHandlers(document);
  segmentedControl.initSegmentedHandlers(document);
  assert.equal(document.__invSegmentedHandlersInstalled, true);
});

/* ── Barrel wiring ── */

test('inventory barrel exposes segmentedControl with select/initSegmentedHandlers and installs handlers once', () => {
  const prevInventory = global.inventory;
  const prevDocument = global.document;
  const prevHandlersInstalled = global.__inventoryHandlersInstalled;
  const prevSegmented = global.inventorySegmentedControl;

  const dom = new JSDOM('<div></div>', { pretendToBeVisual: true });
  global.document = dom.window.document;
  global.__inventoryHandlersInstalled = false;
  global.inventorySegmentedControl = segmentedControl;

  delete require.cache[require.resolve('../renderer/inventory/index')];
  const inventory = require('../renderer/inventory/index');

  assert.equal(typeof inventory.segmentedControl, 'function', 'segmentedControl reachable via barrel');
  assert.equal(typeof inventory.segmentedControl.select, 'function');
  assert.equal(typeof inventory.segmentedControl.initSegmentedHandlers, 'function');
  assert.equal(dom.window.document.__invSegmentedHandlersInstalled, true, 'segmented delegation installed once');

  global.inventory = prevInventory;
  global.document = prevDocument;
  global.__inventoryHandlersInstalled = prevHandlersInstalled;
  global.inventorySegmentedControl = prevSegmented;
});
