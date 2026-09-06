/* Composer V2 attachment tray preview pill — DOM-observation renderer that mirrors
 * `state.attachments.queued` count via MutationObserver on the legacy `#attachmentTray`. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createComposerAttachmentTrayPreviewRenderer } = require('../renderer/chat/renderer-composer-v2-render');

function buildHarness(t) {
  const dom = new JSDOM('<!doctype html><body>'
    + '<div id="composerAttachmentPreviewPill" class="hidden"></div>'
    + '<div id="attachmentTray"></div>'
    + '</body>');
  const doc = dom.window.document;
  const pill = doc.getElementById('composerAttachmentPreviewPill');
  const tray = doc.getElementById('attachmentTray');
  return { dom, doc, pill, tray };
}

function renderTrayChips(tray, count, { withClearAll = false } = {}) {
  let html = '';
  for (let i = 0; i < count; i += 1) {
    html += '<div class="attachment-chip" data-attachment-id="a' + i + '"></div>';
  }
  if (withClearAll && count > 1) {
    html += '<button class="attachment-chip attachment-chip-clear" type="button">Clear all</button>';
  }
  tray.innerHTML = html;
}

function waitMicrotask(win) {
  return new Promise((resolve) => win.setTimeout(resolve, 0));
}

test('preview pill hidden when no attachments queued', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerAttachmentTrayPreviewRenderer({
    tray: harness.tray,
    pill: harness.pill,
  });
  t.after(() => renderer.destroy());
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.pill.classList.contains('hidden'), true);
  assert.equal(harness.pill.textContent, '');
});

test('preview pill renders "Queued (1)" when one attachment is queued', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerAttachmentTrayPreviewRenderer({
    tray: harness.tray,
    pill: harness.pill,
  });
  t.after(() => renderer.destroy());
  renderTrayChips(harness.tray, 1);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.pill.textContent, 'Queued (1)');
  assert.equal(harness.pill.classList.contains('hidden'), false);
});

test('preview pill renders "Queued (3)" with three attachments (ignoring clear-all button)', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerAttachmentTrayPreviewRenderer({
    tray: harness.tray,
    pill: harness.pill,
  });
  t.after(() => renderer.destroy());
  renderTrayChips(harness.tray, 3, { withClearAll: true });
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.pill.textContent, 'Queued (3)');
});

test('preview pill updates when chips removed', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerAttachmentTrayPreviewRenderer({
    tray: harness.tray,
    pill: harness.pill,
  });
  t.after(() => renderer.destroy());
  renderTrayChips(harness.tray, 2);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.pill.textContent, 'Queued (2)');
  renderTrayChips(harness.tray, 0);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.pill.classList.contains('hidden'), true);
});

test('preview pill refresh() works without DOM mutation', (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerAttachmentTrayPreviewRenderer({
    tray: harness.tray,
    pill: harness.pill,
  });
  t.after(() => renderer.destroy());
  // Bypass observer by directly populating innerHTML before refresh
  harness.tray.innerHTML = '<div class="attachment-chip"></div><div class="attachment-chip"></div>';
  renderer.refresh();
  assert.equal(harness.pill.textContent, 'Queued (2)');
});

test('preview pill destroy() disconnects observer and hides pill', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerAttachmentTrayPreviewRenderer({
    tray: harness.tray,
    pill: harness.pill,
  });
  renderTrayChips(harness.tray, 2);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.pill.textContent, 'Queued (2)');
  renderer.destroy();
  assert.equal(harness.pill.classList.contains('hidden'), true);
  assert.equal(harness.pill.textContent, '');
  // Subsequent mutations should not update the pill
  renderTrayChips(harness.tray, 5);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.pill.classList.contains('hidden'), true);
});

test('preview pill throws clear errors when deps are missing', () => {
  assert.throws(() => createComposerAttachmentTrayPreviewRenderer({}), /tray is required/);
  assert.throws(
    () => createComposerAttachmentTrayPreviewRenderer({ tray: {} }),
    /pill is required/,
  );
});
