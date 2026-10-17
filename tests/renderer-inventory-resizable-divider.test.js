'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createResizableDivider } = require('../renderer/inventory/resizable-divider');

function fixture(t) {
  const dom = new JSDOM('<div id="host"></div>');
  let value = 60;
  let enabled = true;
  const divider = createResizableDivider({
    host: dom.window.document.getElementById('host'), label: 'Resize metrics', controls: 'metrics',
    min: 40, max: 75, getValue: () => value, setValue: (next) => { value = next; },
    measureSize: () => 500, isEnabled: () => enabled,
  });
  const node = divider.element;
  let captured;
  node.setPointerCapture = (id) => { captured = id; };
  node.hasPointerCapture = (id) => captured === id;
  node.releasePointerCapture = () => { captured = undefined; };
  const pointer = (type, y, id = 1) => {
    const event = new dom.window.Event(type, { cancelable: true });
    Object.assign(event, { button: 0, clientY: y, pointerId: id });
    node.dispatchEvent(event);
  };
  const key = (name) => node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, cancelable: true }));
  t.after(() => { divider.dispose(); dom.window.close(); });
  return { divider, node, pointer, key, value: () => value, disable: () => { enabled = false; }, captured: () => captured };
}

test('divider exposes its bounds and controlled pane, supports keyboard steps and clamps', (t) => {
  const f = fixture(t);
  assert.equal(f.node.getAttribute('role'), 'separator');
  assert.equal(f.node.getAttribute('aria-controls'), 'metrics');
  assert.equal(f.node.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(f.node.getAttribute('aria-valuemin'), '40');
  assert.equal(f.node.getAttribute('aria-valuemax'), '75');
  f.key('ArrowDown'); assert.equal(f.value(), 65);
  f.key('ArrowUp'); assert.equal(f.value(), 60);
  f.key('End'); f.key('ArrowDown'); assert.equal(f.value(), 75);
  f.key('Home'); f.key('ArrowUp'); assert.equal(f.value(), 40);
  assert.equal(f.node.getAttribute('aria-valuenow'), '40');
  f.disable(); f.key('End'); assert.equal(f.value(), 40);
});

test('modified keys are left to the app and never resize', (t) => {
  const f = fixture(t);
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    const event = new f.node.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'End', [modifier]: true, cancelable: true });
    f.node.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, modifier);
  }
  assert.equal(f.value(), 60);
});

test('pointer resizing uses the starting size, ignores other pointers and applies pointerup position', (t) => {
  const f = fixture(t);
  f.pointer('pointerdown', 300);
  assert.equal(f.node.hasAttribute('data-resizing'), true);
  f.pointer('pointermove', 350, 2); assert.equal(f.value(), 60);
  f.pointer('pointermove', 350); assert.equal(f.value(), 70);
  f.pointer('pointerup', 1000); assert.equal(f.value(), 75);
  assert.equal(f.captured(), undefined);
  assert.equal(f.node.hasAttribute('data-resizing'), false, 'the drag highlight clears');
  assert.equal(f.node.getAttribute('aria-valuenow'), '75', 'a drag keeps the announced value in sync');
  f.pointer('pointermove', 0); assert.equal(f.value(), 75);
});

for (const cancellation of ['Escape', 'pointercancel', 'dispose', 'disable']) {
  test(`divider ${cancellation} cancels a drag and releases capture`, (t) => {
    const f = fixture(t);
    f.pointer('pointerdown', 300); f.pointer('pointermove', 350);
    if (cancellation === 'Escape') f.key('Escape');
    else if (cancellation === 'dispose') f.divider.dispose();
    else if (cancellation === 'disable') { f.disable(); f.pointer('pointermove', 400); }
    else f.pointer(cancellation, 350);
    assert.equal(f.value(), 60);
    assert.equal(f.captured(), undefined);
    if (cancellation === 'dispose') { f.key('End'); assert.equal(f.value(), 60); }
  });
}

test('lost capture finishes the last applied size and disposal is idempotent', (t) => {
  const f = fixture(t);
  f.pointer('pointerdown', 300); f.pointer('pointermove', 350); f.pointer('lostpointercapture', 350);
  assert.equal(f.value(), 70);
  f.divider.dispose(); f.divider.dispose(); f.key('Home');
  assert.equal(f.value(), 70);
});
