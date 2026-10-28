'use strict';

// Row 65 W1: pane keys, find options, and page/zoom restore.

const test = require('node:test');
const assert = require('node:assert/strict');

const { keyAction } = require('../renderer/features/renderer-ide-pdf-toolbar');
const { FakePDFViewer, click, keydown, loadFixture, makePane } = require('./helpers/ide-pdf-pane-harness');

async function shownPane(t) {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const pdfViewer = FakePDFViewer.instances[0];
  return { env, pdfViewer, eventBus: pdfViewer.options.eventBus, paneEl: env.host.querySelector('.ide-pdf-pane') };
}

test('keyAction names pane actions and leaves IDE chords alone', () => {
  const target = { closest: () => null, matches: () => false };
  const key = (init) => keyAction({ target, ...init });
  assert.equal(key({ key: 's', ctrlKey: true }), 'save');
  assert.equal(key({ key: 'f', ctrlKey: true }), 'find-focus');
  assert.equal(key({ key: 'F', ctrlKey: true, shiftKey: true }), null, 'Ctrl+Shift+F is workspace search');
  assert.equal(key({ key: 'S', ctrlKey: true, shiftKey: true }), null);
  assert.equal(key({ key: '=', ctrlKey: true }), 'zoom-in');
  assert.equal(key({ key: '+', ctrlKey: true, shiftKey: true }), 'zoom-in');
  assert.equal(key({ key: '-', ctrlKey: true }), 'zoom-out');
  assert.equal(key({ key: '0', ctrlKey: true }), 'fit-width');
  assert.equal(key({ key: 'PageDown', ctrlKey: true }), null, 'Ctrl+PageDown switches tabs');
  assert.equal(key({ key: 'PageDown' }), 'page-next');
  assert.equal(key({ key: 'PageUp' }), 'page-prev');
  assert.equal(key({ key: 'Home' }), 'page-first');
  assert.equal(key({ key: 'End' }), 'page-last');
  assert.equal(key({ key: 'F3' }), 'find-next');
  assert.equal(key({ key: 'F3', shiftKey: true }), 'find-prev');
  assert.equal(key({ key: 'F4' }), 'sidebar');
  assert.equal(key({ key: 'Escape' }), null, 'Esc outside the find field is not taken');
  assert.equal(key({ key: 'Escape', target: { closest: () => null, matches: () => true } }), 'find-close');
  assert.equal(key({ key: '=', ctrlKey: true, altKey: true }), null);
  assert.equal(key({ key: 'PageDown', isComposing: true }), null);
  const editable = { closest: () => ({}), matches: () => false };
  assert.equal(keyAction({ key: 'End', target: editable }), null, 'caret keys stay in fields and FreeText editors');
});

test('page and zoom keys drive the viewer and keep the app zoom handler out', async (t) => {
  const { env, pdfViewer, paneEl } = await shownPane(t);
  const scroller = env.host.querySelector('.ide-pdf-viewer-scroll');
  assert.equal(scroller.getAttribute('tabindex'), '0', 'the pages take focus so the keys reach the pane');

  keydown(env, scroller, { key: 'End' });
  assert.equal(pdfViewer.currentPageNumber, 2);
  keydown(env, scroller, { key: 'Home' });
  assert.equal(pdfViewer.currentPageNumber, 1);
  keydown(env, scroller, { key: 'PageDown' });
  assert.equal(pdfViewer.currentPageNumber, 2);

  pdfViewer.currentScaleValue = 2;
  const zoom = keydown(env, scroller, { key: '=', ctrlKey: true });
  assert.equal(pdfViewer.currentScaleValue, 2.5);
  assert.equal(zoom.defaultPrevented, true, 'a prevented event is skipped by the app zoom handler');
  keydown(env, scroller, { key: '0', ctrlKey: true });
  assert.equal(pdfViewer.currentScaleValue, 'page-width');

  const pageField = env.host.querySelector('[data-ide-pdf-page]');
  const inField = keydown(env, pageField, { key: 'Home' });
  assert.equal(inField.defaultPrevented, false, 'Home moves the caret in the page field');
  assert.equal(pdfViewer.currentPageNumber, 2);

  const search = keydown(env, paneEl, { key: 'F', ctrlKey: true, shiftKey: true });
  assert.equal(search.defaultPrevented, false);
});

test('F3 steps through matches, focuses an empty find field, and Esc closes find', async (t) => {
  const { env, eventBus, paneEl } = await shownPane(t);
  const findField = env.host.querySelector('[data-ide-pdf-find]');

  keydown(env, paneEl, { key: 'F3' });
  assert.equal(env.dom.window.document.activeElement, findField);
  assert.equal(eventBus.events.filter((event) => event.name === 'find').length, 0);

  findField.value = 'needle';
  keydown(env, paneEl, { key: 'F3' });
  keydown(env, paneEl, { key: 'F3', shiftKey: true });
  const finds = eventBus.events.filter((event) => event.name === 'find');
  assert.deepEqual(finds.map((event) => [event.detail.type, event.detail.findPrevious]), [['', false], ['again', true]]);

  eventBus.dispatch('updatefindmatchescount', { matchesCount: { current: 1, total: 3 } });
  keydown(env, findField, { key: 'Escape' });
  assert.ok(eventBus.events.some((event) => event.name === 'findbarclose'));
  assert.equal(env.pane.getState('docs/text.pdf').findMatch, null);
});

test('find options toggle, show pressed, and ride on every find', async (t) => {
  const { env, eventBus } = await shownPane(t);
  const findField = env.host.querySelector('[data-ide-pdf-find]');
  findField.value = 'Needle';
  const caseButton = click(env, '[data-ide-pdf-action="find-case"]');
  assert.equal(caseButton.getAttribute('aria-pressed'), 'true');
  click(env, '[data-ide-pdf-action="find-word"]');
  click(env, '[data-ide-pdf-action="find-accents"]');
  click(env, '[data-ide-pdf-action="find-accents"]');
  const last = eventBus.events.filter((event) => event.name === 'find').at(-1).detail;
  assert.equal(last.query, 'Needle');
  assert.equal(last.caseSensitive, true);
  assert.equal(last.entireWord, true);
  assert.equal(last.matchDiacritics, false);
  assert.equal(last.highlightAll, true);
  assert.equal(env.host.querySelector('[data-ide-pdf-action="find-accents"]').getAttribute('aria-pressed'), 'false');
});

test('view position is reported and restored before and after a document loads', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  assert.equal(env.pane.restoreViewPosition('docs/text.pdf', { page: 0, zoom: 'huge' }), false);
  assert.equal(env.pane.restoreViewPosition('docs/text.pdf', { page: 2, zoom: 1.5 }), true);
  await loadFixture(env);
  const pdfViewer = FakePDFViewer.instances[0];
  env.pane.show('docs/text.pdf');
  assert.equal(pdfViewer.currentPageNumber, 2);
  assert.equal(pdfViewer.currentScaleValue, 1.5);
  assert.deepEqual(env.pane.getViewPosition('docs/text.pdf'), { page: 2, zoom: 1.5 });

  // A restore on the visible document applies at once; a page past the end clamps.
  assert.equal(env.pane.restoreViewPosition('docs/text.pdf', { page: 9, zoom: 'page-fit' }), true);
  assert.equal(pdfViewer.currentPageNumber, 2);
  assert.equal(pdfViewer.currentScaleValue, 'page-fit');
  assert.equal(env.pane.getViewPosition('docs/missing.pdf'), null);
});

test('typed find text survives a search and a page change', async (t) => {
  const { env, eventBus } = await shownPane(t);
  const findField = env.host.querySelector('[data-ide-pdf-find]');
  findField.value = 'first';
  keydown(env, findField, { key: 'Enter' });
  findField.value = 'second';
  keydown(env, findField, { key: 'Enter' });
  assert.equal(findField.value, 'second', 'a new search keeps the new query in the field');
  findField.value = 'third, not yet searched';
  eventBus.dispatch('pagechanging', { pageNumber: 2 });
  assert.equal(findField.value, 'third, not yet searched');
});

// ── Review fixes (2026-10-19) ──

test('a restored view not yet shown is the reported position', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  // A background tab: loaded and restored, never shown.
  assert.equal(env.pane.restoreViewPosition('docs/text.pdf', { page: 2, zoom: 'page-fit' }), true);
  assert.deepEqual(env.pane.getViewPosition('docs/text.pdf'), { page: 2, zoom: 'page-fit' });
  // A reload before it is shown keeps it.
  await loadFixture(env);
  assert.deepEqual(env.pane.getViewPosition('docs/text.pdf'), { page: 2, zoom: 'page-fit' });
  env.pane.show('docs/text.pdf');
  assert.equal(FakePDFViewer.instances.at(-1).currentPageNumber, 2);
});

test('a reload of a hidden document keeps reporting the page the reader was on', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  click(env, '[data-ide-pdf-action="next"]');
  env.pane.hide();
  await loadFixture(env);
  assert.equal(env.pane.getViewPosition('docs/text.pdf').page, 2);
});

test('Home and End in the sidebar stay with the sidebar', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const inside = env.dom.window.document.createElement('button');
  env.host.querySelector('.ide-pdf-sidebar').appendChild(inside);
  for (const key of ['Home', 'End', 'PageDown', 'PageUp']) {
    assert.equal(keyAction({ key, target: inside }), null, key);
  }
  const event = keydown(env, inside, { key: 'End' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(env.pane.getState('docs/text.pdf').pageNumber, 1);
});
