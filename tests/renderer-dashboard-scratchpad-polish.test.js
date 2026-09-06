// Definitive-polish coverage for the Home scratchpad widget: tabpanel ARIA,
// per-tab × delete (with confirm), the rename pencil + F2 + clean rename swap,
// and the roving-tabindex invariant. Split out of
// renderer-dashboard-scratchpad-actions.test.js to stay under the file-size cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScratchpadWidget } = require('../renderer/features/renderer-dashboard-widgets-scratchpad.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const { scratch, twoNotesActive, flagOnCtx } = require('./helpers/scratchpad-fixtures.js');

function makeWidget(actions, contextMenu) {
  return createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: actions === undefined ? null : actions,
    contextMenu,
  });
}

test('flag-on tabs expose aria-controls and a tabpanel wrapping the field', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget(null);

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  for (const tab of body.querySelectorAll('[data-scratchpad-tab]')) {
    assert.equal(tab.getAttribute('aria-controls'), 'homeScratchpadPanel');
  }
  const panel = body.querySelector('#homeScratchpadPanel');
  assert.ok(panel);
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.ok(panel.querySelector('#homeScratchpadInput'));
});

test('the close × is hidden at the one-note floor and present with siblings', () => {
  const widget = makeWidget(null);

  const single = new JSDOM('<section id="body"></section>').window.document.getElementById('body');
  widget.render(single, flagOnCtx(scratch('only one')));
  assert.equal(single.querySelectorAll('[data-scratchpad-close]').length, 0);

  const many = new JSDOM('<section id="body"></section>').window.document.getElementById('body');
  widget.render(many, flagOnCtx(twoNotesActive('note-1')));
  assert.equal(many.querySelectorAll('[data-scratchpad-close]').length, 2);
});

test('arrow keys cycle focus across the tab buttons only, not the hover controls', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget({ setActiveNote: async () => ({ ok: true }) });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  const first = body.querySelector('[data-scratchpad-tab="note-1"]');
  first.focus();
  first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(dom.window.document.activeElement, body.querySelector('[data-scratchpad-tab="note-2"]'));
});

test('clicking × deletes an empty note immediately but confirms a written one', async () => {
  const deleted = [];
  const menus = [];
  const widget = makeWidget(
    { deleteNote: async (id) => { deleted.push(id); return { ok: true, activeNoteId: 'note-1' }; } },
    { show: (opts) => { menus.push(opts); } }
  );
  const fixture = (note2Text) => ({
    notes: [
      { id: 'note-1', title: 'Alpha', text: 'A', updatedAt: '', appendLog: false },
      { id: 'note-2', title: 'Beta', text: note2Text, updatedAt: '', appendLog: false },
    ],
    activeNoteId: 'note-1',
    settings: { rows: 6, font: 'prose', captureMode: 'overwrite' },
  });

  // Empty note → immediate delete, no confirm menu.
  const emptyDom = new JSDOM('<section id="body"></section>');
  const emptyBody = emptyDom.window.document.getElementById('body');
  widget.render(emptyBody, flagOnCtx(fixture('')));
  emptyBody.querySelector('[data-scratchpad-close="note-2"]')
    .dispatchEvent(new emptyDom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, ['note-2']);
  assert.equal(menus.length, 0);

  // Written note → a confirm menu is shown; only its action deletes.
  deleted.length = 0;
  const writtenDom = new JSDOM('<section id="body"></section>');
  const writtenBody = writtenDom.window.document.getElementById('body');
  widget.render(writtenBody, flagOnCtx(fixture('important')));
  writtenBody.querySelector('[data-scratchpad-close="note-2"]')
    .dispatchEvent(new writtenDom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(menus.length, 1);
  assert.equal(deleted.length, 0);
  menus[0].items[0].action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, ['note-2']);
});

test('the active-tab pencil opens the inline rename (active tab only)', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget({ renameNote: async () => ({ ok: true }) });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  assert.ok(body.querySelector('[data-scratchpad-edit="note-1"]'));
  assert.equal(body.querySelector('[data-scratchpad-edit="note-2"]'), null);
  body.querySelector('[data-scratchpad-edit="note-1"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(body.querySelector('#homeScratchpadRename'));
});

test('an open inline rename survives a config-echo repaint', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget({ renameNote: async () => ({ ok: true }) });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  body.querySelector('[data-scratchpad-tab="note-1"]')
    .dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const input = body.querySelector('#homeScratchpadRename');
  assert.ok(input);
  input.value = 'half-typed';

  // A repaint (idle tick / config echo) with the same notes must not wipe it.
  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  const after = body.querySelector('#homeScratchpadRename');
  assert.ok(after);
  assert.equal(after.value, 'half-typed');
});

test('entering rename swaps the whole tab so no × / pencil lingers', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget({ renameNote: async () => ({ ok: true }) });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  body.querySelector('[data-scratchpad-edit="note-1"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const wrap = body.querySelector('#homeScratchpadRename').closest('.dashboard-scratchpad__tab-wrap');
  assert.ok(wrap);
  assert.equal(wrap.querySelector('[data-scratchpad-close]'), null);
  assert.equal(wrap.querySelector('[data-scratchpad-edit]'), null);
});

test('F2 on a focused tab opens the inline rename (keyboard parity)', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget({ renameNote: async () => ({ ok: true }) });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  const tab = body.querySelector('[data-scratchpad-tab="note-1"]');
  tab.focus();
  tab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(body.querySelector('#homeScratchpadRename'));
});

/* W8-2 auto-grow. JSDOM computes no layout, so scrollHeight is stubbed and the
 * assertions ride the JS path directly: the field takes its measured content
 * height on every input, the persisted rows attribute stays the floor, and NO
 * config write is fired (only the corner grip persists rows — C5). */
function stubScrollHeight(textarea, value) {
  Object.defineProperty(textarea, 'scrollHeight', { value, configurable: true });
}

test('the pad auto-grows to its content height on every keystroke', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget({ queueSave: () => {} });

  widget.render(body, flagOnCtx(scratch('one line')));
  const textarea = body.querySelector('#homeScratchpadInput');

  stubScrollHeight(textarea, 148);
  textarea.value = 'one line\ntwo\nthree\nfour';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(textarea.style.height, '148px');

  // More content ⇒ a taller field, from the same measurement path.
  stubScrollHeight(textarea, 260);
  textarea.value += '\nfive\nsix\nseven';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(textarea.style.height, '260px');

  // Deleting shrinks it back — the height is never latched at its high-water
  // mark (the reset-to-auto step is what makes that true).
  stubScrollHeight(textarea, 96);
  textarea.value = 'one line';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(textarea.style.height, '96px');
});

test('auto-grow keeps the grip rows as the floor and NEVER persists', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const writes = [];
  const widget = makeWidget({ queueSave: (text, id) => writes.push(['queueSave', text, id]) });

  const pad = scratch('note');
  pad.settings.rows = 11;
  widget.render(body, flagOnCtx(pad));
  const textarea = body.querySelector('#homeScratchpadInput');
  assert.equal(textarea.rows, 11, 'the persisted rows setting paints as the floor');

  stubScrollHeight(textarea, 300);
  textarea.value = 'grown';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(textarea.style.height, '300px');
  // The floor is untouched: auto-grow measures against `rows`, it never edits
  // it, so the grip's persisted value survives a session of typing.
  assert.equal(textarea.rows, 11);
  // And the ONLY thing the keystroke wrote is the note text.
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'queueSave');
  assert.equal(writes[0][1], 'grown');
});

test('an unmeasurable field (no layout) is left at auto rather than collapsed to 0', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = makeWidget({ queueSave: () => {} });

  widget.render(body, flagOnCtx(scratch('note')));
  const textarea = body.querySelector('#homeScratchpadInput');
  assert.equal(textarea.scrollHeight, 0, 'JSDOM measures nothing');

  textarea.value = 'typed';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(textarea.style.height, 'auto', 'a 0 measurement is discarded');
});

test('typing no longer paints a per-tab unsaved dot (removed in favour of the footer status)', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const saves = [];
  const widget = makeWidget({ queueSave: (text, id) => { saves.push([text, id]); } });

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  const textarea = body.querySelector('#homeScratchpadInput');
  textarea.value = 'A!';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  // The keystroke still queues a save, but never stamps a dirty marker on any
  // tab wrap (the dot was removed; the footer "Saved ·" status is the signal).
  assert.deepEqual(saves, [['A!', 'note-1']]);
  assert.equal(body.querySelector('[data-scratchpad-dirty]'), null);
});
