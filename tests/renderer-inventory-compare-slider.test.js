const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const compareSlider = require('../renderer/inventory/compare-slider');

const BASE = {
  beforeSrc: 'file:///tmp/before.png',
  afterSrc: 'file:///tmp/after.png',
  beforeLabel: 'Before this turn',
  afterLabel: 'After',
  handleLabel: 'Before and after',
};

function mount(overrides, install = true) {
  const html = compareSlider(Object.assign({}, BASE, overrides));
  const dom = new JSDOM(`<!doctype html><html><body><div id="host">${html}</div></body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  const host = document.getElementById('host');
  if (install) compareSlider.initCompareSliderHandlers(host);
  const root = host.querySelector('.inv-compare');
  const events = [];
  root.addEventListener('inventory-compare-slider-change', (event) => events.push(event.detail.position));
  return {
    dom,
    document,
    host,
    root,
    events,
    handle: root.querySelector('.inv-compare-handle'),
    stage: root.querySelector('.inv-compare-stage'),
    snapBefore: root.querySelector('[data-compare-snap="100"]'),
    snapAfter: root.querySelector('[data-compare-snap="0"]'),
  };
}

function key(el, name, extra) {
  const view = el.ownerDocument.defaultView;
  const event = new view.KeyboardEvent('keydown', Object.assign({ key: name, bubbles: true, cancelable: true }, extra));
  el.dispatchEvent(event);
  return event;
}

function pointer(el, type, clientX, extra) {
  const view = el.ownerDocument.defaultView;
  const event = new view.MouseEvent(type, Object.assign({ clientX, bubbles: true, cancelable: true, button: 0 }, extra));
  Object.defineProperty(event, 'pointerId', { value: 7 });
  el.dispatchEvent(event);
  return event;
}

function rect(left, width) {
  return () => ({ left, right: left + width, width, top: 0, bottom: 100, height: 100, x: left, y: 0 });
}

/* ── Builder ── */

test('builder renders the stage, two pictures, a slider handle and two snap buttons', () => {
  const { root, stage, handle, snapBefore, snapAfter } = mount({ alt: 'Home page', id: 'cmp1', className: 'extra  bad!class' });
  assert.ok(root.hasAttribute('data-compare-slider'));
  assert.equal(root.id, 'cmp1');
  assert.equal(root.getAttribute('data-vp'), 'desktop');
  assert.equal(root.style.getPropertyValue('--pos'), '50%');
  assert.equal(root.className, 'inv-compare extra');

  const imgs = stage.querySelectorAll('img.inv-compare-img');
  assert.equal(imgs.length, 2);
  assert.ok(imgs[0].classList.contains('inv-compare-img--before'));
  assert.ok(imgs[1].classList.contains('inv-compare-img--after'));
  assert.equal(imgs[0].getAttribute('src'), BASE.beforeSrc);
  assert.equal(imgs[1].getAttribute('src'), BASE.afterSrc);
  assert.equal(imgs[0].getAttribute('alt'), 'Home page');
  assert.equal(imgs[1].getAttribute('alt'), '', 'second picture has an empty alt');
  assert.equal(imgs[0].getAttribute('draggable'), 'false');

  assert.equal(handle.getAttribute('role'), 'slider');
  assert.equal(handle.getAttribute('tabindex'), '0');
  assert.equal(handle.getAttribute('aria-label'), 'Before and after');
  assert.equal(handle.getAttribute('aria-valuemin'), '0');
  assert.equal(handle.getAttribute('aria-valuemax'), '100');
  assert.equal(handle.getAttribute('aria-valuenow'), '50');
  assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
  assert.ok(handle.querySelector('.inv-compare-grip[aria-hidden="true"]'));

  assert.equal(snapBefore.textContent, 'Before this turn');
  assert.equal(snapAfter.textContent, 'After');
  assert.equal(snapBefore.getAttribute('type'), 'button');
  assert.equal(snapBefore.getAttribute('aria-pressed'), 'false');
  assert.equal(snapAfter.getAttribute('aria-pressed'), 'false');
  assert.ok(root.querySelector('.inv-compare-caps .inv-compare-grow'));
});

test('builder escapes every string it writes', () => {
  const nasty = '"><script>alert(1)</script>';
  const html = compareSlider(Object.assign({}, BASE, {
    beforeSrc: 'https://example.test/a.png?x="1"&y=<2>',
    beforeLabel: nasty,
    afterLabel: '<b>After</b>',
    handleLabel: nasty,
    alt: nasty,
    id: nasty,
  }));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>After'));
  const dom = new JSDOM(`<div>${html}</div>`);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('script').length, 0);
  assert.equal(doc.querySelector('.inv-compare-img--before').getAttribute('src'), 'https://example.test/a.png?x="1"&y=<2>');
  assert.equal(doc.querySelector('.inv-compare-img--before').getAttribute('alt'), nasty);
  assert.equal(doc.querySelector('.inv-compare-handle').getAttribute('aria-label'), nasty);
  assert.equal(doc.querySelector('[data-compare-snap="100"]').textContent, nasty);
  assert.equal(doc.querySelector('[data-compare-snap="0"]').textContent, '<b>After</b>');
});

test('builder writes data-vp, the starting position and the aspect ratio', () => {
  const phone = mount({ viewport: 'phone', position: 30, width: 390, height: 844 });
  assert.equal(phone.root.getAttribute('data-vp'), 'phone');
  assert.equal(phone.root.style.getPropertyValue('--pos'), '30%');
  assert.equal(phone.handle.getAttribute('aria-valuenow'), '30');
  assert.equal(phone.stage.style.aspectRatio.replace(/\s+/g, ''), '390/844');

  const unknown = mount({ viewport: 'tablet' });
  assert.equal(unknown.root.getAttribute('data-vp'), 'desktop');
  assert.equal(unknown.stage.getAttribute('style'), null, 'no inline ratio without a size');

  assert.equal(mount({ width: 1200 }).stage.getAttribute('style'), null, 'width alone sets no ratio');
  assert.equal(mount({ width: 0, height: 800 }).stage.getAttribute('style'), null);
  assert.equal(mount({ width: -4, height: 800 }).stage.getAttribute('style'), null);
  assert.equal(mount({ width: 'wide', height: 800 }).stage.getAttribute('style'), null);
});

test('builder clamps and defaults the starting position', () => {
  assert.equal(mount({ position: 250 }).handle.getAttribute('aria-valuenow'), '100');
  assert.equal(mount({ position: -5 }).handle.getAttribute('aria-valuenow'), '0');
  assert.equal(mount({ position: 'nope' }).handle.getAttribute('aria-valuenow'), '50');
  const atStart = mount({ position: 100 });
  assert.equal(atStart.snapBefore.getAttribute('aria-pressed'), 'true');
  assert.equal(atStart.snapAfter.getAttribute('aria-pressed'), 'false');
});

test('builder returns an empty string for a missing or disallowed source', () => {
  assert.equal(compareSlider({}), '');
  assert.equal(compareSlider(), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { beforeSrc: undefined })), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { afterSrc: '' })), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { afterSrc: 42 })), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { beforeSrc: 'javascript:alert(1)' })), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { afterSrc: ' JavaScript:alert(1)' })), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { afterSrc: 'http://example.test/a.png' })), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { afterSrc: 'data:text/html;base64,AAAA' })), '');
  assert.equal(compareSlider(Object.assign({}, BASE, { afterSrc: '/relative/a.png' })), '');
  for (const src of ['FILE:///a.png', 'blob:null/1234', 'data:image/png;base64,AAAA', 'HTTPS://example.test/a.png']) {
    assert.notEqual(compareSlider(Object.assign({}, BASE, { beforeSrc: src, afterSrc: src })), '', src);
  }
});

/* ── setPosition / getPosition ── */

test('setPosition clamps, updates --pos, aria-valuenow and both aria-pressed flags', () => {
  const { root, handle, snapBefore, snapAfter } = mount();
  const pressed = () => [snapBefore.getAttribute('aria-pressed'), snapAfter.getAttribute('aria-pressed')];

  assert.equal(compareSlider.getPosition(root), 50);
  assert.deepEqual(pressed(), ['false', 'false']);

  assert.equal(compareSlider.setPosition(root, 0), 0);
  assert.equal(root.style.getPropertyValue('--pos'), '0%');
  assert.equal(handle.getAttribute('aria-valuenow'), '0');
  assert.deepEqual(pressed(), ['false', 'true']);

  assert.equal(compareSlider.setPosition(root, 100), 100);
  assert.equal(root.style.getPropertyValue('--pos'), '100%');
  assert.equal(handle.getAttribute('aria-valuenow'), '100');
  assert.deepEqual(pressed(), ['true', 'false']);

  assert.equal(compareSlider.setPosition(root, 50), 50);
  assert.deepEqual(pressed(), ['false', 'false']);

  assert.equal(compareSlider.setPosition(root, 140), 100);
  assert.equal(compareSlider.setPosition(root, -20), 0);
  assert.equal(compareSlider.getPosition(root), 0);

  // The pressed thresholds are 99 and 1.
  compareSlider.setPosition(root, 99);
  assert.deepEqual(pressed(), ['true', 'false']);
  compareSlider.setPosition(root, 98);
  assert.deepEqual(pressed(), ['false', 'false']);
  compareSlider.setPosition(root, 1);
  assert.deepEqual(pressed(), ['false', 'true']);
  compareSlider.setPosition(root, 2);
  assert.deepEqual(pressed(), ['false', 'false']);
});

test('setPosition keeps fractional drag positions but rounds the spoken value', () => {
  const { root, handle } = mount();
  assert.equal(compareSlider.setPosition(root, 33.333333), 33.33);
  assert.equal(handle.getAttribute('aria-valuenow'), '33');
  assert.equal(compareSlider.getPosition(root), 33.33);
});

test('setPosition ignores a non-numeric value and a missing root', () => {
  const { root, events } = mount();
  assert.equal(compareSlider.setPosition(root, 'abc'), 50);
  assert.equal(compareSlider.setPosition(null, 10), 0);
  assert.deepEqual(events, []);
});

test('the change event fires once per real change and not when the value is unchanged', () => {
  const { root, events } = mount();
  compareSlider.setPosition(root, 50);
  assert.deepEqual(events, [], 'same value: no event');
  compareSlider.setPosition(root, 80);
  compareSlider.setPosition(root, 80);
  compareSlider.setPosition(root, 500);
  compareSlider.setPosition(root, 100);
  compareSlider.setPosition(root, 20);
  assert.deepEqual(events, [80, 100, 20]);
});

test('the change event bubbles to the container', () => {
  const { root, host } = mount();
  const seen = [];
  host.addEventListener('inventory-compare-slider-change', (event) => seen.push(event.detail.position));
  compareSlider.setPosition(root, 10);
  assert.deepEqual(seen, [10]);
});

/* ── Keyboard ── */

test('ArrowLeft and ArrowRight move by 2, or by 10 with Shift, and prevent default', () => {
  const { root, handle } = mount();
  let event = key(handle, 'ArrowRight');
  assert.equal(compareSlider.getPosition(root), 52);
  assert.equal(event.defaultPrevented, true);
  event = key(handle, 'ArrowLeft');
  assert.equal(compareSlider.getPosition(root), 50);
  assert.equal(event.defaultPrevented, true);
  key(handle, 'ArrowRight', { shiftKey: true });
  assert.equal(compareSlider.getPosition(root), 60);
  key(handle, 'ArrowLeft', { shiftKey: true });
  key(handle, 'ArrowLeft', { shiftKey: true });
  assert.equal(compareSlider.getPosition(root), 40);
});

test('Home, End, PageDown and PageUp', () => {
  const { root, handle } = mount();
  assert.equal(key(handle, 'End').defaultPrevented, true);
  assert.equal(compareSlider.getPosition(root), 100);
  assert.equal(key(handle, 'Home').defaultPrevented, true);
  assert.equal(compareSlider.getPosition(root), 0);
  assert.equal(key(handle, 'PageUp').defaultPrevented, true);
  assert.equal(compareSlider.getPosition(root), 10);
  assert.equal(key(handle, 'PageUp').defaultPrevented, true);
  assert.equal(compareSlider.getPosition(root), 20);
  assert.equal(key(handle, 'PageDown').defaultPrevented, true);
  assert.equal(compareSlider.getPosition(root), 10);
  key(handle, 'PageDown');
  key(handle, 'PageDown');
  assert.equal(compareSlider.getPosition(root), 0, 'clamped at the low end');
});

test('other keys are left alone', () => {
  const { root, handle, events } = mount();
  const event = key(handle, 'a');
  assert.equal(event.defaultPrevented, false);
  assert.equal(key(handle, 'Tab').defaultPrevented, false);
  assert.equal(compareSlider.getPosition(root), 50);
  assert.deepEqual(events, []);
});

test('a key pressed on a snap button is not handled as a slider key', () => {
  const { root, snapBefore } = mount();
  assert.equal(key(snapBefore, 'ArrowRight').defaultPrevented, false);
  assert.equal(compareSlider.getPosition(root), 50);
});

test('in a right-to-left document the arrow keys swap', () => {
  const { root, handle } = mount();
  root.style.direction = 'rtl';
  key(handle, 'ArrowRight');
  assert.equal(compareSlider.getPosition(root), 48);
  key(handle, 'ArrowLeft', { shiftKey: true });
  assert.equal(compareSlider.getPosition(root), 58);
  key(handle, 'Home');
  assert.equal(compareSlider.getPosition(root), 0, 'Home is not swapped');
});

test('keys pressed with Ctrl, Alt or Meta are left to the browser', () => {
  const { root, handle } = mount();
  assert.equal(key(handle, 'ArrowLeft', { altKey: true }).defaultPrevented, false);
  assert.equal(key(handle, 'ArrowRight', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(key(handle, 'Home', { metaKey: true }).defaultPrevented, false);
  assert.equal(compareSlider.getPosition(root), 50);
});

/* ── Snap buttons ── */

test('the snap buttons set the position and move focus to the handle', () => {
  const { document, root, handle, snapBefore, snapAfter, events } = mount();
  snapBefore.focus();
  snapBefore.click();
  assert.equal(compareSlider.getPosition(root), 100);
  assert.equal(snapBefore.getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, handle);

  snapAfter.focus();
  snapAfter.click();
  assert.equal(compareSlider.getPosition(root), 0);
  assert.equal(snapAfter.getAttribute('aria-pressed'), 'true');
  assert.equal(snapBefore.getAttribute('aria-pressed'), 'false');
  assert.equal(document.activeElement, handle);
  assert.deepEqual(events, [100, 0]);
});

test('clicking the snap button for the current side still focuses the handle without a change event', () => {
  const { document, root, handle, snapBefore, events } = mount({ position: 100 });
  snapBefore.focus();
  snapBefore.click();
  assert.equal(compareSlider.getPosition(root), 100);
  assert.equal(document.activeElement, handle);
  assert.deepEqual(events, []);
});

/* ── Pointer ── */

test('a pointer drag follows the pointer across the stage and then stops', () => {
  const { root, stage, events } = mount();
  stage.getBoundingClientRect = rect(100, 200);
  let captured = null;
  let released = null;
  stage.setPointerCapture = (id) => { captured = id; };
  stage.releasePointerCapture = (id) => { released = id; };

  pointer(stage, 'pointerdown', 150);
  assert.equal(captured, 7);
  assert.equal(compareSlider.getPosition(root), 25);

  pointer(stage, 'pointermove', 250);
  assert.equal(compareSlider.getPosition(root), 75);
  pointer(stage, 'pointermove', 10);
  assert.equal(compareSlider.getPosition(root), 0, 'clamped left of the stage');
  pointer(stage, 'pointermove', 900);
  assert.equal(compareSlider.getPosition(root), 100, 'clamped right of the stage');

  pointer(stage, 'pointerup', 900);
  assert.equal(released, 7);
  pointer(stage, 'pointermove', 200);
  assert.equal(compareSlider.getPosition(root), 100, 'moves after pointerup are ignored');
  assert.deepEqual(events, [25, 75, 0, 100]);
});

test('pointercancel ends a drag', () => {
  const { root, stage } = mount();
  stage.getBoundingClientRect = rect(0, 100);
  pointer(stage, 'pointerdown', 40);
  pointer(stage, 'pointercancel', 40);
  pointer(stage, 'pointermove', 90);
  assert.equal(compareSlider.getPosition(root), 40);
});

test('pointer down on an image or the handle drags too', () => {
  const { root, stage, handle } = mount();
  stage.getBoundingClientRect = rect(0, 100);
  pointer(stage.querySelector('img'), 'pointerdown', 10);
  assert.equal(compareSlider.getPosition(root), 10);
  pointer(stage, 'pointerup', 10);
  pointer(handle, 'pointerdown', 60);
  assert.equal(compareSlider.getPosition(root), 60);
});

test('only the primary button starts a drag', () => {
  const { root, stage } = mount();
  stage.getBoundingClientRect = rect(0, 100);
  pointer(stage, 'pointerdown', 10, { button: 2 });
  pointer(stage, 'pointermove', 20);
  assert.equal(compareSlider.getPosition(root), 50);
});

test('a stage with zero width is ignored', () => {
  const { root, stage, events } = mount();
  stage.getBoundingClientRect = rect(0, 0);
  pointer(stage, 'pointerdown', 10);
  pointer(stage, 'pointermove', 20);
  assert.equal(compareSlider.getPosition(root), 50);
  assert.deepEqual(events, []);
});

test('a drag works when pointer capture throws', () => {
  const { root, stage } = mount();
  stage.getBoundingClientRect = rect(0, 100);
  stage.setPointerCapture = () => { throw new Error('no such pointer'); };
  stage.releasePointerCapture = () => { throw new Error('no such pointer'); };
  pointer(stage, 'pointerdown', 30);
  pointer(stage, 'pointermove', 70);
  pointer(stage, 'pointerup', 70);
  assert.equal(compareSlider.getPosition(root), 70);
});

test('in a right-to-left document the drag position is measured from the right edge', () => {
  const { root, stage } = mount();
  root.style.direction = 'rtl';
  stage.getBoundingClientRect = rect(0, 100);
  pointer(stage, 'pointerdown', 80);
  assert.equal(compareSlider.getPosition(root), 20);
});

test('pointer events outside any stage are ignored', () => {
  const { document, host, root, events } = mount();
  const outside = document.createElement('div');
  host.appendChild(outside);
  pointer(outside, 'pointerdown', 10);
  pointer(outside, 'pointermove', 20);
  assert.equal(compareSlider.getPosition(root), 50);
  assert.deepEqual(events, []);
});

/* ── Install once ── */

test('initCompareSliderHandlers called twice does not double-fire', () => {
  const { host, root, handle, stage, snapAfter, events } = mount();
  compareSlider.initCompareSliderHandlers(host);
  compareSlider.initCompareSliderHandlers(host);

  key(handle, 'ArrowRight');
  assert.equal(compareSlider.getPosition(root), 52, 'one step, not three');
  assert.deepEqual(events, [52]);

  snapAfter.click();
  assert.deepEqual(events, [52, 0]);

  stage.getBoundingClientRect = rect(0, 100);
  pointer(stage, 'pointerdown', 40);
  pointer(stage, 'pointerup', 40);
  assert.deepEqual(events, [52, 0, 40]);
});

test('initCompareSliderHandlers leaves a missing or listener-less container alone', () => {
  assert.equal(compareSlider.initCompareSliderHandlers(null), undefined);
  const bare = {};
  compareSlider.initCompareSliderHandlers(bare);
  assert.deepEqual(bare, {}, 'nothing is marked as installed on an object that cannot listen');
});

test('two sliders in one container move independently', () => {
  const html = compareSlider(BASE) + compareSlider(BASE);
  const dom = new JSDOM(`<!doctype html><html><body><div id="host">${html}</div></body></html>`);
  const host = dom.window.document.getElementById('host');
  compareSlider.initCompareSliderHandlers(host);
  const [a, b] = host.querySelectorAll('.inv-compare');
  key(a.querySelector('.inv-compare-handle'), 'End');
  assert.equal(compareSlider.getPosition(a), 100);
  assert.equal(compareSlider.getPosition(b), 50);
});
