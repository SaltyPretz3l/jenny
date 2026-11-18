const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatHelpOverlay, buildCatalogBodyHtml } = require('../renderer/chat/renderer-chat-help-overlay');
const { createHelpOverlay } = require('../renderer/inventory/help-overlay');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function buildEnv(extraBody) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<textarea id="composer"></textarea>'
    + (extraBody || '')
    + '</body></html>');
  return dom;
}

test('? keydown outside text inputs opens the help overlay (E7)', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
  });
  helper.attach();

  // Focus a non-text element to ensure the handler does not bail.
  dom.window.document.body.focus();
  const event = new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);

  assert.equal(helper.isOpen(), true, 'help overlay should open when ? pressed outside a text input');
  assert.equal(event.defaultPrevented, true);

  // Verify the dialog scaffolding wired through to the inventory primitive.
  const dialog = dom.window.document.querySelector('.inv-help-overlay-dialog');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('aria-labelledby'), 'chatHelpOverlayTitle');
});

test('? keydown stands down while the Workspace IDE view is active', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  let activeView = 'ide';
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
    getActiveView: () => activeView,
  });
  helper.attach();

  // IDE active: the chat overlay must NOT open (the IDE owns its own "?").
  dom.window.document.body.focus();
  let event = new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);
  assert.equal(helper.isOpen(), false, 'chat overlay suppressed on the IDE view');
  assert.equal(event.defaultPrevented, false, 'event left for the IDE handler');

  // Back on chat: the same key opens it.
  activeView = 'chat';
  event = new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);
  assert.equal(helper.isOpen(), true, 'chat overlay opens when the IDE is not active');
});

test('? keydown stands down while Diagnostics is active', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  let activeView = 'logs';
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
    getActiveView: () => activeView,
  });
  helper.attach();

  dom.window.document.body.focus();
  let event = new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);
  assert.equal(helper.isOpen(), false, 'chat overlay suppressed in Diagnostics');
  assert.equal(event.defaultPrevented, false, 'Diagnostics key handling remains unclaimed');

  activeView = 'chat';
  event = new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);
  assert.equal(helper.isOpen(), true, 'chat overlay opens when Diagnostics is not active');
});

test('attach fallback returns a detach function for the global key listener', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
  });
  const detach = helper.attach();

  assert.equal(typeof detach, 'function');
  detach();

  dom.window.document.body.focus();
  const event = new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);
  assert.equal(helper.isOpen(), false);
  assert.equal(event.defaultPrevented, false);
});

test('? keydown while textarea is focused is ignored (E7)', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
  });
  helper.attach();

  const composer = dom.window.document.getElementById('composer');
  composer.focus();
  const event = new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);

  assert.equal(helper.isOpen(), false, 'help should not open while a text input is focused');
});

test('UIUX-038: the composer help copy is honest about "?" not working while the field is focused', async (t) => {
  // The sr-only aria-describedby text used to say "Press question mark to
  // view all keyboard shortcuts" with no qualifier, but ? is explicitly
  // ignored while the composer textarea is focused (the test above) --
  // that's the correct behavior (users need to type literal "?" into
  // messages), so the copy must say so rather than promise a shortcut that
  // silently does nothing from inside the field it describes.
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  const doc = window.document;

  const composer = doc.getElementById('chatInput');
  const describedById = composer.getAttribute('aria-describedby');
  assert.ok(describedById, 'composer textarea has an aria-describedby target');
  const helpText = doc.getElementById(describedById);
  assert.ok(helpText, 'the described element exists');
  assert.match(helpText.textContent, /question mark/i, 'still documents the "?" shortcut');
  assert.match(helpText.textContent, /outside this field/i,
    'copy must not claim "?" opens shortcuts FROM the field it is attached to');

  // Behavioral cross-check in the real app: focused in the composer, "?"
  // really does nothing (matches the copy's new qualifier).
  composer.focus();
  composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
  await waitForUi(window, 20);
  assert.equal(doc.getElementById('chatHelpOverlay')?.hidden !== false, true, '"?" while composer-focused does not open shortcuts');
});

test('Ctrl+? is ignored — modifier-suppressed (E7)', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
  });
  helper.attach();

  dom.window.document.body.focus();
  const event = new dom.window.KeyboardEvent('keydown', { key: '?', ctrlKey: true, bubbles: true, cancelable: true });
  dom.window.document.dispatchEvent(event);
  assert.equal(helper.isOpen(), false);
});

function rowHtml(html, id) {
  const match = html.match(new RegExp('<div class="chat-help-overlay-row" data-shortcut="' + id + '">[\\s\\S]*?</dd></div>'));
  assert.ok(match, 'row ' + id + ' should render');
  return match[0];
}

function groupHtml(html, id) {
  const match = html.match(new RegExp('<section class="chat-help-overlay-section" data-group="' + id + '">[\\s\\S]*?</section>'));
  assert.ok(match, 'group ' + id + ' should render');
  return match[0];
}

function openOverlayEnv() {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  const helper = createChatHelpOverlay({ document: dom.window.document, helpOverlayFactory });
  return { dom, helper };
}

test('catalog renders seven groups in two columns with the app-wide chords', () => {
  const html = buildCatalogBodyHtml();
  const columns = html.split('<div class="chat-help-overlay-column">');
  assert.equal(columns.length, 3, 'two column wrappers');
  assert.match(html, /^<div class="chat-help-overlay-columns">/);
  const groupIds = (chunk) => Array.from(chunk.matchAll(/data-group="(\w+)"/g)).map((m) => m[1]);
  assert.deepEqual(groupIds(columns[1]), ['everywhere', 'find', 'editing']);
  assert.deepEqual(groupIds(columns[2]), ['composer', 'messages', 'selecting', 'team']);
  for (const id of ['commandPalette', 'quickSettings', 'splitView', 'quickCapture', 'reload']) {
    assert.ok(groupHtml(html, 'everywhere').includes('data-shortcut="' + id + '"'), id + ' lives in Everywhere');
  }
  assert.doesNotMatch(html, /Hover/);
  assert.doesNotMatch(html, /data-group="help"/);
  assert.match(rowHtml(html, 'quickCapture'), /<kbd class="chat-help-overlay-kbd">Space<\/kbd>/);
  assert.match(rowHtml(html, 'shortcuts'), /<kbd class="chat-help-overlay-kbd">\?<\/kbd>/);
  // Description is the dt, the keys are the dd.
  assert.match(rowHtml(html, 'send'), /<dt class="chat-help-overlay-description">Send<\/dt><dd class="chat-help-overlay-keys"/);
});

test('the Team group lists the Team tab keys', () => {
  const html = buildCatalogBodyHtml();
  const team = groupHtml(html, 'team');
  const kbd = (key) => '<kbd class="chat-help-overlay-kbd">' + key + '</kbd>';
  const plus = '<span class="chat-help-overlay-plus" aria-hidden="true">+</span>';
  const alt = '<span class="chat-help-overlay-alt" aria-hidden="true">/</span>';
  assert.match(team, /<h3 class="chat-help-overlay-section-heading">Team<\/h3>/);
  assert.ok(rowHtml(html, 'teamNextRegion').includes(kbd('F6')), 'F6 moves to the next region');
  assert.ok(rowHtml(html, 'teamPrevRegion').includes(kbd('Shift') + plus + kbd('F6')));
  assert.ok(rowHtml(html, 'teamSearch').includes(kbd('Ctrl') + plus + kbd('F')));
  assert.ok(rowHtml(html, 'teamRowUpDown').includes(kbd('Alt') + plus + kbd('↑') + alt + kbd('↓')));
  assert.ok(rowHtml(html, 'teamMessageMenu').includes(kbd('Shift') + plus + kbd('F10')));
  assert.match(buildCatalogBodyHtml('region'), /data-shortcut="teamNextRegion"/, 'the filter finds a Team row by its description');
});

test('headings and descriptions go through the translator', () => {
  const previous = globalThis.jennyI18n;
  const modulePath = require.resolve('../renderer/chat/renderer-chat-help-overlay');
  const cached = require.cache[modulePath];
  delete require.cache[modulePath];
  globalThis.jennyI18n = { t: (key) => '[' + key + ']' };
  try {
    const fresh = require('../renderer/chat/renderer-chat-help-overlay');
    const html = fresh.buildCatalogBodyHtml();
    for (const id of ['everywhere', 'composer', 'messages', 'find', 'editing', 'selecting', 'team']) {
      assert.match(groupHtml(html, id), new RegExp('<h3 class="chat-help-overlay-section-heading">\\[help\\.group\\.' + id + '\\]</h3>'));
    }
    assert.match(rowHtml(html, 'splitView'), /\[help\.shortcut\.splitView\]/);
  } finally {
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
    if (previous === undefined) delete globalThis.jennyI18n; else globalThis.jennyI18n = previous;
  }
});

test('chords that share their modifiers render them once', () => {
  const html = buildCatalogBodyHtml();
  const kbd = (key) => '<kbd class="chat-help-overlay-kbd">' + key + '</kbd>';
  const plus = '<span class="chat-help-overlay-plus" aria-hidden="true">+</span>';
  const alt = '<span class="chat-help-overlay-alt" aria-hidden="true">/</span>';
  const nextPrevious = rowHtml(html, 'nextPrevious');
  assert.ok(nextPrevious.includes(kbd('Alt') + plus + kbd('↓') + alt + kbd('↑')), nextPrevious);
  assert.equal(nextPrevious.split(kbd('Alt')).length, 2, 'Alt appears once');
  assert.match(nextPrevious, /aria-label="Alt\+↓ or Alt\+↑"/);
  const zoom = rowHtml(html, 'zoom');
  assert.ok(zoom.includes(kbd('Ctrl') + plus + kbd('+') + alt + kbd('−') + alt + kbd('0')), zoom);
  assert.equal(zoom.split(kbd('Ctrl')).length, 2, 'Ctrl appears once');
  const firstLast = rowHtml(html, 'firstLast');
  assert.ok(firstLast.includes(kbd('Home') + alt + kbd('End')), firstLast);
  const nextMatch = rowHtml(html, 'nextPreviousMatch');
  assert.ok(nextMatch.includes(kbd('Enter') + alt + kbd('Shift') + plus + kbd('Enter')), nextMatch);
});

test('the filter keeps matching rows, whole groups on a heading hit, and escapes the query', () => {
  const split = buildCatalogBodyHtml('split');
  assert.match(split, /data-group="everywhere"/);
  assert.match(split, /data-shortcut="splitView"/);
  assert.doesNotMatch(split, /data-shortcut="commandPalette"/);
  assert.doesNotMatch(split, /data-group="composer"/);
  assert.match(split, /<mark class="chat-help-overlay-mark">Split<\/mark> view/);

  const composer = buildCatalogBodyHtml('  COMPOSER ');
  const group = groupHtml(composer, 'composer');
  assert.equal((group.match(/data-shortcut=/g) || []).length, 6, 'a heading hit keeps the whole group');
  assert.doesNotMatch(composer, /data-group="everywhere"/);

  const hostile = buildCatalogBodyHtml('<img>');
  assert.match(hostile, /<p class="chat-help-overlay-empty">/);
  assert.match(hostile, /&lt;img&gt;/);
  assert.doesNotMatch(hostile, /<img>/);

  const none = buildCatalogBodyHtml('zzzz');
  assert.match(none, /<p class="chat-help-overlay-empty">No shortcut matches “zzzz”\.<\/p>/);
  assert.doesNotMatch(none, /data-group=/);
});

test('open() focuses the search field, filters as you type, and resets the query on reopen', () => {
  const { dom, helper } = openOverlayEnv();
  const doc = dom.window.document;
  helper.open();
  const dialog = doc.querySelector('.inv-help-overlay-dialog');
  assert.ok(dialog.classList.contains('inv-help-overlay-dialog--wide'));
  const search = doc.getElementById('chatHelpOverlaySearch');
  assert.ok(search);
  assert.equal(doc.activeElement, search, 'search field is focused on open');
  assert.equal(search.getAttribute('aria-label'), 'Search keyboard shortcuts');
  assert.equal(search.getAttribute('placeholder'), 'Search shortcuts');
  assert.ok(doc.querySelector('.inv-help-overlay-header .inv-help-overlay-header-extra #chatHelpOverlaySearch'));
  assert.ok(doc.querySelector('[data-shortcut="reload"]'));

  search.value = 'reload';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.ok(doc.querySelector('[data-shortcut="reload"]'));
  assert.equal(doc.querySelector('[data-shortcut="send"]'), null, 'body re-rendered with the filter');
  assert.equal(doc.getElementById('chatHelpOverlaySearch'), search, 'the field itself is not replaced');

  helper.close();
  helper.open();
  const reopened = doc.getElementById('chatHelpOverlaySearch');
  assert.equal(reopened.value, '');
  assert.ok(doc.querySelector('[data-shortcut="send"]'), 'the full catalog is back');
});
test('close() closes the overlay programmatically (E7)', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
  });
  helper.open();
  assert.equal(helper.isOpen(), true);
  helper.close();
  assert.equal(helper.isOpen(), false);
});

test('dispose destroys the underlying overlay (E7)', () => {
  const dom = buildEnv();
  const helpOverlayFactory = (opts) => createHelpOverlay({ document: dom.window.document, hostId: opts && opts.hostId });
  const helper = createChatHelpOverlay({
    document: dom.window.document,
    helpOverlayFactory,
  });
  helper.open();
  helper.dispose();
  // After dispose, isOpen should be false and the host element gone from DOM.
  assert.equal(helper.isOpen(), false);
});
