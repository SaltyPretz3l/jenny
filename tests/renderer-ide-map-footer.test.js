'use strict';

/* tests/renderer-ide-map-footer.test.js - coverage for
 * renderer/features/renderer-ide-map-footer.js: the File Map's footer row
 * (adopted findings chips, the colour key, the "N files not mapped" trigger
 * and its "Left out of the map" inventory popover). jsdom directly; always dispose via
 * t.after(), never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createMapFooter } = require('../renderer/features/renderer-ide-map-footer');

function setup() {
  const dom = new JSDOM('<div id="outside"></div><div id="host" class="ide-map-footer"></div><div id="findings">chips</div>');
  const documentRef = dom.window.document;
  return {
    dom,
    documentRef,
    hostEl: documentRef.getElementById('host'),
    outsideEl: documentRef.getElementById('outside'),
    findingsEl: documentRef.getElementById('findings'),
  };
}

function mount(t) {
  const ctx = setup();
  const footer = createMapFooter({ hostEl: ctx.hostEl, documentRef: ctx.documentRef });
  t.after(() => footer.dispose());
  return { ...ctx, footer };
}

function mix(...pairs) {
  return pairs.map(([cls, count]) => ({ cls, count }));
}

function keyItems(hostEl) {
  return [...hostEl.querySelectorAll('.ide-map-key-item')];
}

function keyLabels(hostEl) {
  return keyItems(hostEl).map((el) => el.textContent.trim());
}

function press(documentRef, key) {
  const Ctor = documentRef.defaultView.KeyboardEvent;
  documentRef.dispatchEvent(new Ctor('keydown', { key, bubbles: true }));
}

function clickOn(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}

const BUCKETS = [
  { key: 'node_modules', label: 'node_modules', count: 41873 },
  { key: '.', label: '(ignored)', count: 3 },
];

test('structure: start group, trigger and a hidden dialog popover', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  assert.ok(hostEl.querySelector('.ide-map-footer-start > .ide-map-key'));
  const trigger = hostEl.querySelector('.ide-map-footer-unmapped');
  assert.equal(trigger.tagName, 'BUTTON');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  const pop = hostEl.querySelector('.ide-map-footer-pop');
  assert.ok(pop.hidden);
  assert.equal(pop.getAttribute('role'), 'dialog');
  assert.equal(pop.getAttribute('aria-label'), 'Left out of the map');
});

test('language key: summed depth-1 mixes, count desc then class name, capped at 6', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({
    buckets: [],
    hasTests: false,
    districts: [
      { key: 'a', depth: 1, langMix: mix(['js', 5], ['css', 2], ['md', 1], ['other', 1]) },
      { key: 'b', depth: 1, langMix: mix(['ts', 6], ['py', 1], ['html', 1], ['data', 1]) },
      // Deeper districts are already counted by their depth-1 ancestor.
      { key: 'a/x', depth: 2, langMix: mix(['js', 99]) },
    ],
  });
  // js 5, ts 6, css 2, then the count-1 ties ordered by class name:
  // data, html, md, other, py -> only the first three fit under the cap.
  assert.deepEqual(keyLabels(hostEl), ['TypeScript', 'JavaScript', 'CSS', 'Data', 'HTML', 'Markdown']);
  const first = keyItems(hostEl)[0];
  assert.ok(first.classList.contains('ide-map-key--ts'));
  assert.ok(first.querySelector('.ide-map-key-dot'));
  assert.equal(first.querySelector('.ide-map-key-dot').getAttribute('aria-hidden'), 'true');
});

test('test ring item only when hasTests', (t) => {
  const { footer, hostEl } = mount(t);
  const districts = [{ key: 'a', depth: 1, langMix: mix(['js', 1]) }];
  footer.update({ buckets: [], districts, hasTests: false });
  assert.equal(hostEl.querySelectorAll('.ide-map-key--test').length, 0);
  footer.update({ buckets: [], districts, hasTests: true });
  const test_ = hostEl.querySelector('.ide-map-key--test');
  assert.ok(test_);
  assert.ok(test_.classList.contains('ide-map-key-item'));
  assert.ok(test_.querySelector('.ide-map-key-dot.is-ring'));
  assert.equal(test_.textContent.trim(), 'Test');
});

test('setHideTests drops the ring item and setHideTests(false) brings it back', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: [], districts: [{ key: 'a', depth: 1, langMix: mix(['js', 1]) }], hasTests: true });
  footer.setHideTests(true);
  assert.equal(hostEl.querySelectorAll('.ide-map-key--test').length, 0);
  assert.deepEqual(keyLabels(hostEl), ['JavaScript']);
  footer.setHideTests(false);
  assert.equal(hostEl.querySelectorAll('.ide-map-key--test').length, 1);
});

test('no key at all while no map is drawn, even with Health on', (t) => {
  const { footer, hostEl } = mount(t);
  footer.setHealth(true);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: true });
  assert.equal(keyItems(hostEl).length, 0);
  assert.ok(hostEl.querySelector('.ide-map-footer-unmapped'), 'the not-mapped trigger still shows');
});

test('health key replaces the language key with three colour items', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({
    buckets: [],
    districts: [{ key: 'a', depth: 1, langMix: mix(['js', 3]) }],
    hasTests: true,
  });
  footer.setHealth(true);
  assert.deepEqual(keyLabels(hostEl), ['Healthy', 'Near the size limit or unused', 'Over the limit or in a cycle']);
  assert.ok(hostEl.querySelector('.ide-map-key-dot.is-ok'));
  assert.ok(hostEl.querySelector('.ide-map-key-dot.is-amber'));
  assert.ok(hostEl.querySelector('.ide-map-key-dot.is-red'));
  assert.equal(hostEl.querySelectorAll('.ide-map-key--js, .ide-map-key--test').length, 0);
  footer.setHealth(false);
  assert.deepEqual(keyLabels(hostEl), ['JavaScript', 'Test']);
});

test('not-mapped trigger: hidden at zero, singular and plural copy', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: [], districts: [], hasTests: false });
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped'), null);
  footer.update({ buckets: [{ key: 'dist', label: 'dist', count: 0 }], districts: [], hasTests: false });
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped'), null);

  footer.update({ buckets: [{ key: 'dist', label: 'dist', count: 1 }], districts: [], hasTests: false });
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').textContent.trim(), '1 file not mapped');

  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  const total = (41876).toLocaleString();
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').textContent.trim(), `${total} files not mapped`);
});

test('popover rows: top-level files for ".", other dirs with a slash, then the note', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  const pop = hostEl.querySelector('.ide-map-footer-pop');
  assert.equal(pop.querySelector('.ide-map-footer-pop-title').textContent, 'Left out of the map');
  const rows = [...pop.querySelectorAll('.ide-map-footer-pop-row')];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [...row.children].map((c) => c.textContent)),
    [['node_modules/', (41873).toLocaleString()], ['Top-level files', '3']],
  );
  assert.match(pop.querySelector('.ide-map-footer-pop-note').textContent, /^Ignored by \.gitignore or the built-in skip list/);
});

test('popover rows read the buckets the real atlas layout emits (bucket nodes from the ignore service)', (t) => {
  // Contract pin: the layout's bucket shape is { key, label, count } with key =
  // the ignored dir, so the footer must never read a field the layout drops.
  const { layout } = require('../renderer/features/renderer-ide-map-atlas-layout');
  const laid = layout({ nodes: [
    { id: 'a.js', label: 'a.js' },
    { id: 'bucket:.', label: '(ignored)', dir: '.', bucket: true, count: 1 },
    { id: 'bucket:dist', label: 'dist', dir: 'dist', bucket: true, count: 4 },
  ] });
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: laid.buckets, districts: laid.districts, hasTests: false });
  const rows = [...hostEl.querySelectorAll('.ide-map-footer-pop-row')].map((row) => row.firstElementChild.textContent);
  assert.deepEqual(rows, ['dist/', 'Top-level files']);
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').textContent.trim(), '5 files not mapped');
});

test('trigger click toggles the popover and aria-expanded', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  const trigger = hostEl.querySelector('.ide-map-footer-unmapped');
  const pop = hostEl.querySelector('.ide-map-footer-pop');
  trigger.click();
  assert.equal(pop.hidden, false);
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').getAttribute('aria-expanded'), 'true');
  hostEl.querySelector('.ide-map-footer-unmapped').click();
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, true);
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').getAttribute('aria-expanded'), 'false');
});

test('Escape closes the popover and returns focus to the trigger', (t) => {
  const { footer, hostEl, documentRef } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  hostEl.querySelector('.ide-map-footer-unmapped').click();
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, false);
  press(documentRef, 'Escape');
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, true);
  assert.equal(documentRef.activeElement, hostEl.querySelector('.ide-map-footer-unmapped'));
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').getAttribute('aria-expanded'), 'false');
});

test('a click outside closes; a click inside the popover does not', (t) => {
  const { footer, hostEl, outsideEl } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  hostEl.querySelector('.ide-map-footer-unmapped').click();
  clickOn(hostEl.querySelector('.ide-map-footer-pop-row'));
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, false);
  clickOn(outsideEl);
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, true);
  // The closed state sticks across a re-render (the toggle event kept it in step).
  footer.update({ buckets: [...BUCKETS, { key: 'dist', label: 'dist', count: 1 }], districts: [], hasTests: false });
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, true);
});

test('Escape-closed state sticks across a re-render', (t) => {
  const { footer, hostEl, documentRef } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  hostEl.querySelector('.ide-map-footer-unmapped').click();
  press(documentRef, 'Escape');
  footer.update({ buckets: [...BUCKETS, { key: 'dist', label: 'dist', count: 1 }], districts: [], hasTests: false });
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, true);
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').getAttribute('aria-expanded'), 'false');
});

test('rows carry data-map-bucket and keep activity heat across a re-render', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  const rows = [...hostEl.querySelectorAll('.ide-map-footer-pop-row')];
  assert.deepEqual(rows.map((row) => row.dataset.mapBucket), ['node_modules', '.']);
  // The activity rail toggles is-heat on [data-map-bucket] directly.
  hostEl.querySelector('[data-map-bucket="node_modules"]').classList.add('is-heat');
  footer.update({ buckets: [...BUCKETS, { key: 'dist', label: 'dist', count: 1 }], districts: [], hasTests: false });
  assert.ok(hostEl.querySelector('[data-map-bucket="node_modules"]').classList.contains('is-heat'), 'heat survives');
  assert.equal(hostEl.querySelectorAll('.ide-map-footer-pop-row.is-heat').length, 1);
});

test('a re-render keeps keyboard focus on the trigger', (t) => {
  const { footer, hostEl, documentRef } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  hostEl.querySelector('.ide-map-footer-unmapped').focus();
  footer.update({ buckets: [...BUCKETS, { key: 'dist', label: 'dist', count: 1 }], districts: [], hasTests: false });
  assert.equal(documentRef.activeElement, hostEl.querySelector('.ide-map-footer-unmapped'));
});

test('an unchanged update does not rebuild the markup', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  const trigger = hostEl.querySelector('.ide-map-footer-unmapped');
  footer.update({ buckets: BUCKETS.map((b) => ({ ...b })), districts: [], hasTests: false });
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped'), trigger);
});

test('update keeps the popover open and keeps the adopted findings element', (t) => {
  const { footer, hostEl, findingsEl } = mount(t);
  footer.adoptFindings(findingsEl);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  const start = hostEl.querySelector('.ide-map-footer-start');
  assert.equal(start.firstElementChild, findingsEl, 'findings is the first child of the start group');
  hostEl.querySelector('.ide-map-footer-unmapped').click();
  footer.update({
    buckets: [...BUCKETS, { key: 'dist', label: 'dist', count: 7 }],
    districts: [{ key: 'a', depth: 1, langMix: mix(['js', 1]) }],
    hasTests: false,
  });
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, false, 'popover stays open');
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped').getAttribute('aria-expanded'), 'true');
  assert.equal(hostEl.querySelectorAll('.ide-map-footer-pop-row').length, 3);
  assert.equal(hostEl.querySelector('.ide-map-footer-start').firstElementChild, findingsEl, 'same element survives');
  assert.equal(findingsEl.textContent, 'chips');
});

test('adoptFindings after an update moves the element in as first child', (t) => {
  const { footer, hostEl, findingsEl } = mount(t);
  footer.update({ buckets: [], districts: [{ key: 'a', depth: 1, langMix: mix(['js', 1]) }], hasTests: false });
  footer.adoptFindings(findingsEl);
  assert.equal(hostEl.querySelector('.ide-map-footer-start').firstElementChild, findingsEl);
  assert.ok(hostEl.querySelector('.ide-map-footer-start > .ide-map-key'));
});

test('update with the popover open but no buckets left closes it without error', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  hostEl.querySelector('.ide-map-footer-unmapped').click();
  footer.update({ buckets: [], districts: [], hasTests: false });
  assert.equal(hostEl.querySelector('.ide-map-footer-unmapped'), null);
  assert.equal(hostEl.querySelector('.ide-map-footer-pop').hidden, true);
});

test('dispose removes listeners, clears the host and is idempotent', (t) => {
  const { footer, hostEl, documentRef, outsideEl, findingsEl } = mount(t);
  footer.adoptFindings(findingsEl);
  footer.update({ buckets: BUCKETS, districts: [], hasTests: false });
  hostEl.querySelector('.ide-map-footer-unmapped').click();
  footer.dispose();
  footer.dispose();
  assert.equal(hostEl.innerHTML, '');
  assert.doesNotThrow(() => press(documentRef, 'Escape'));
  assert.doesNotThrow(() => clickOn(outsideEl));
  assert.doesNotThrow(() => footer.update({ buckets: BUCKETS, districts: [], hasTests: false }));
  assert.equal(hostEl.innerHTML, '', 'update after dispose is a no-op');
});

test('directory names are escaped in the popover rows', (t) => {
  const { footer, hostEl } = mount(t);
  footer.update({
    buckets: [{ key: '<img src=x onerror=alert(1)>', label: 'x', count: 2 }],
    districts: [],
    hasTests: false,
  });
  const pop = hostEl.querySelector('.ide-map-footer-pop');
  assert.equal(pop.querySelector('img'), null);
  assert.equal(pop.querySelector('.ide-map-footer-pop-row').firstElementChild.textContent, '<img src=x onerror=alert(1)>/');
});
