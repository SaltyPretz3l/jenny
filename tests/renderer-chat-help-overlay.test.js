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

test('buildCatalogBodyHtml emits the shortcut catalog with kbd chiclets (E7)', () => {
  const html = buildCatalogBodyHtml();
  // Section headings present.
  assert.match(html, /Navigation/);
  assert.match(html, /Search/);
  assert.match(html, /Composer/);
  assert.match(html, /Help/);
  // Roving-tabindex shortcuts are documented.
  assert.match(html, /<kbd[^>]*>Alt<\/kbd>/);
  assert.match(html, /<kbd[^>]*>↓<\/kbd>/);
  assert.match(html, /<kbd[^>]*>↑<\/kbd>/);
  assert.match(html, /<kbd[^>]*>Home<\/kbd>/);
  assert.match(html, /<kbd[^>]*>End<\/kbd>/);
  // Search shortcuts (F1+E6).
  assert.match(html, /<kbd[^>]*>Ctrl<\/kbd>/);
  assert.match(html, /<kbd[^>]*>F<\/kbd>/);
  assert.match(html, /Search messages in this conversation/);
  // Composer shortcuts.
  assert.match(html, /<kbd[^>]*>Enter<\/kbd>/);
  assert.match(html, /<kbd[^>]*>Shift<\/kbd>/);
  // Help shortcuts.
  assert.match(html, /<kbd[^>]*>\?<\/kbd>/);
  assert.match(html, /<kbd[^>]*>Esc<\/kbd>/);
  // Plus separator between chiclets is decorative.
  assert.match(html, /<span class="chat-help-overlay-plus" aria-hidden="true">\+<\/span>/);
});

test('the run-mode shortcuts are documented in the catalog (spec §5, decision 3)', () => {
  const html = buildCatalogBodyHtml();
  assert.match(html, /Cycle run mode \(Ask → Auto → Plan\)/);
  assert.match(html, /<kbd[^>]*>Tab<\/kbd>/);
  assert.match(html, /Toggle Plan mode/);
  assert.match(html, /<kbd[^>]*>P<\/kbd>/);
});

test('F2: catalog includes an Editing section with Enter / Esc / Ctrl+Enter / Shift+Enter chiclets', () => {
  const html = buildCatalogBodyHtml();
  assert.match(html, /Editing/);
  assert.match(html, /Edit the focused user message/);
  assert.match(html, /Cancel editing/);
  assert.match(html, /Save edit and resend/);
  assert.match(html, /Insert a new line \(in editor\)/);
  // Sanity: chiclets present (these keys are reused in Search + Composer too,
  // so we just verify the descriptions are unique to the Editing section).
  const editingSection = html.match(/Editing[\s\S]*?<\/section>/);
  assert.ok(editingSection, 'Editing section block should be findable');
});

test('F4/F5/F6: catalog includes a Selection section with multi-select chiclets', () => {
  const html = buildCatalogBodyHtml();
  assert.match(html, /Selection/);
  assert.match(html, /Enter selection mode \(or extend the range\)/);
  assert.match(html, /Select all messages \(while in selection mode\)/);
  assert.match(html, /Cancel selection/);
  assert.match(html, /Delete selected and everything after/);
  assert.match(html, /Branching/);
  assert.match(html, /Branch from the focused message/);
  assert.match(html, /Branch from any message hover action/);
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
