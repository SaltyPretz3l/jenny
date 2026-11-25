'use strict';

// new-test-file: the Computer group of Settings > Tools is a new surface with its own module (row 196, C12).
// Stubs the window.jennyShell.computerUse bridge; the group mounts into the static host in index.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createComputerSettingsController } = require('../renderer/shell/renderer-computer-settings');

const CHORD = 'Ctrl+Alt+Shift+F12';
const PROGRAMS = [
  { name: 'demo-game', path: 'D:\\Work\\demo-game\\target\\release\\demo-game.exe' },
  { name: 'level-editor', path: 'D:\\Work\\demo-game\\target\\release\\editor.exe' },
];

function makeDom() {
  return new JSDOM(`<!doctype html><html><body>
    <section class="settings-card tools-card" data-settings-section="tools">
      <div class="settings-group cu-settings-group" role="group" aria-labelledby="toolsComputerHeading">
        <h4 id="toolsComputerHeading">Computer</h4>
        <p class="settings-group-copy">Jenny uses the real mouse and keyboard, only in programs you allow in each chat. Windows only.</p>
        <div id="toolsComputerList"></div>
        <div id="toolsComputerExtra"></div>
      </div>
    </section>
  </body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeBridge(overrides) {
  const calls = { status: 0, listPrograms: 0, removeProgram: [], renameProgram: [], addProgram: 0 };
  const bridge = {
    calls,
    statusListeners: [],
    status: async () => { calls.status += 1; return { ok: true, available: true, reason: null, stopChord: CHORD, stopChordRegistered: true }; },
    listPrograms: async () => { calls.listPrograms += 1; return { ok: true, programs: PROGRAMS.map((p) => ({ ...p })) }; },
    addProgram: async () => { calls.addProgram += 1; return { ok: false, reason: 'cancelled' }; },
    renameProgram: async (payload) => { calls.renameProgram.push(payload); return { ok: true }; },
    removeProgram: async (payload) => { calls.removeProgram.push(payload); return { ok: true, removed: true }; },
    onStatus(callback) { bridge.statusListeners.push(callback); return () => {}; },
    ...overrides,
  };
  return bridge;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// Opens the Tools card the way the settings nav does: the section-active class flips.
async function openTools(dom) {
  dom.window.document.querySelector('.settings-card').classList.add('settings-section-active');
  await settle();
}

async function mount(t, { bridge, platform } = {}) {
  const dom = makeDom();
  const stub = bridge === undefined ? makeBridge() : bridge;
  const windowRef = Object.assign(dom.window, { jennyShell: stub ? { computerUse: stub } : {} });
  if (platform) Object.defineProperty(windowRef.navigator, 'platform', { value: platform, configurable: true });
  const controller = createComputerSettingsController({ windowRef, documentRef: dom.window.document, appendClientLog: () => {} });
  t.after(() => controller.dispose());
  controller.bind();
  controller.render();
  await openTools(dom);
  const doc = dom.window.document;
  return { dom, doc, bridge: stub, controller, host: doc.getElementById('toolsComputerExtra'), group: doc.querySelector('.cu-settings-group') };
}

const rows = (doc) => Array.from(doc.querySelectorAll('.knowledge-folders-row'));
const note = (doc) => doc.querySelector('.settings-note[aria-live="polite"]');
const press = (doc, el, key) => el.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

test('reads status and programs only once the Tools section is shown', async (t) => {
  const dom = makeDom();
  const bridge = makeBridge();
  const windowRef = Object.assign(dom.window, { jennyShell: { computerUse: bridge } });
  const controller = createComputerSettingsController({ windowRef, documentRef: dom.window.document, appendClientLog: () => {} });
  t.after(() => controller.dispose());
  controller.bind();
  controller.render();
  await settle();
  assert.equal(bridge.calls.status, 0);
  assert.equal(bridge.calls.listPrograms, 0);
  await openTools(dom);
  assert.equal(bridge.calls.status, 1);
  assert.equal(bridge.calls.listPrograms, 1);
});

test('renders the Stop key row, the subheading, the copy and the Add button', async (t) => {
  const { host } = await mount(t);
  assert.match(host.textContent, /Stop key/);
  assert.match(host.textContent, /Press it anywhere to stop Jenny at once, even over an administrator\u2019s window\. Touching the mouse or a key pauses it\./);
  assert.equal(host.querySelector('kbd').textContent, CHORD);
  assert.doesNotMatch(host.textContent, /Another program holds this key/);
  assert.equal(host.querySelector('.cu-subheading').textContent, 'Your programs');
  assert.match(host.textContent, /Programs with no Start menu entry, such as your own builds\. Jenny may start only these and Start menu programs, and still asks first\./);
  assert.match(host.querySelector('.settings-primary').textContent, /Add program\u2026/);
  assert.equal(host.querySelector('input'), null, 'the Stop key is shown, never editable');
});

test('falls back to the default chord when status carries none', async (t) => {
  const bridge = makeBridge({ status: async () => ({ ok: true, available: true, reason: null }) });
  const { host } = await mount(t, { bridge });
  assert.equal(host.querySelector('kbd').textContent, CHORD);
});

test('stopChordRegistered false adds the second sentence, and onStatus refreshes the line', async (t) => {
  const bridge = makeBridge({
    status: async () => ({ ok: true, available: true, reason: null, stopChord: CHORD, stopChordRegistered: false }),
  });
  const { host } = await mount(t, { bridge });
  assert.match(host.textContent, /Another program holds this key right now\. Use Stop on the pill\./);
  bridge.statusListeners[0]({ ok: true, available: true, reason: null, stopChord: 'Ctrl+Alt+F11', stopChordRegistered: true });
  assert.equal(host.querySelector('kbd').textContent, 'Ctrl+Alt+F11');
  assert.doesNotMatch(host.textContent, /Another program holds this key/);
});

test('lists each program with its name, an ellipsis path with the full path in title, and Remove', async (t) => {
  const { doc } = await mount(t);
  const list = rows(doc);
  assert.equal(list.length, 2);
  assert.match(list[0].querySelector('.settings-field-label').textContent, /demo-game/);
  const path = list[0].querySelector('.knowledge-folders-row-path');
  assert.equal(path.textContent, PROGRAMS[0].path);
  assert.equal(path.getAttribute('title'), PROGRAMS[0].path);
  assert.match(path.className, /cu-program-path/);
  assert.equal(list[1].querySelector('.settings-secondary').textContent.trim(), 'Remove');
});

test('Remove calls removeProgram with the path and drops the row at once', async (t) => {
  const { doc, bridge } = await mount(t);
  rows(doc)[0].querySelector('.settings-secondary').click();
  assert.equal(rows(doc).length, 1, 'dropped before the bridge answers');
  await settle();
  assert.deepEqual(bridge.calls.removeProgram, [{ path: PROGRAMS[0].path }]);
  assert.match(rows(doc)[0].textContent, /level-editor/);
});

test('an empty list says so', async (t) => {
  const bridge = makeBridge({ listPrograms: async () => ({ ok: true, programs: [] }) });
  const { host } = await mount(t, { bridge });
  assert.match(host.textContent, /No programs of your own yet\./);
});

test('clicking the name edits it; Enter saves through renameProgram', async (t) => {
  const { doc, bridge } = await mount(t);
  rows(doc)[0].querySelector('[data-cu-action="rename"]').click();
  const input = doc.querySelector('.inv-text-field-control');
  assert.equal(input.value, 'demo-game');
  input.value = '  My game  ';
  press(doc, input, 'Enter');
  await settle();
  assert.deepEqual(bridge.calls.renameProgram, [{ path: PROGRAMS[0].path, name: 'My game' }]);
  assert.equal(doc.querySelector('.inv-text-field-control'), null);
  assert.match(rows(doc)[0].querySelector('.settings-field-label').textContent, /My game/);
});

test('blur saves once, even when it fires twice', async (t) => {
  const { doc, bridge } = await mount(t);
  rows(doc)[1].querySelector('[data-cu-action="rename"]').click();
  const input = doc.querySelector('.inv-text-field-control');
  input.value = 'Editor';
  input.dispatchEvent(new doc.defaultView.FocusEvent('focusout', { bubbles: true }));
  input.dispatchEvent(new doc.defaultView.FocusEvent('focusout', { bubbles: true }));
  await settle();
  assert.deepEqual(bridge.calls.renameProgram, [{ path: PROGRAMS[1].path, name: 'Editor' }]);
});

test('Escape cancels a rename; an empty or over-long name keeps the old one', async (t) => {
  const { doc, bridge } = await mount(t);
  const edit = (index) => rows(doc)[index].querySelector('[data-cu-action="rename"]').click();
  edit(0);
  let input = doc.querySelector('.inv-text-field-control');
  input.value = 'Other';
  press(doc, input, 'Escape');
  assert.equal(doc.querySelector('.inv-text-field-control'), null);
  edit(0);
  input = doc.querySelector('.inv-text-field-control');
  input.value = '   ';
  press(doc, input, 'Enter');
  edit(0);
  input = doc.querySelector('.inv-text-field-control');
  input.value = 'x'.repeat(121);
  press(doc, input, 'Enter');
  await settle();
  assert.deepEqual(bridge.calls.renameProgram, []);
  assert.match(rows(doc)[0].querySelector('.settings-field-label').textContent, /demo-game/);
});

test('a failed rename puts the old name back and says so', async (t) => {
  const bridge = makeBridge({ renameProgram: async () => ({ ok: false, reason: 'write_failed' }) });
  const { doc } = await mount(t, { bridge });
  rows(doc)[0].querySelector('[data-cu-action="rename"]').click();
  const input = doc.querySelector('.inv-text-field-control');
  input.value = 'Renamed';
  press(doc, input, 'Enter');
  await settle();
  assert.match(rows(doc)[0].querySelector('.settings-field-label').textContent, /demo-game/);
  assert.match(note(doc).textContent, /That name could not be saved\./);
});

test('Add program: ok adds the row, cancelled does nothing', async (t) => {
  const added = { name: 'tool', path: 'D:\\tool.exe' };
  let answer = { ok: true, program: added };
  const bridge = makeBridge({ addProgram: async () => answer });
  const { doc } = await mount(t, { bridge });
  const add = () => doc.querySelector('[data-cu-action="add"]').click();
  add();
  await settle();
  assert.equal(rows(doc).length, 3);
  assert.equal(rows(doc)[2].querySelector('.knowledge-folders-row-path').textContent, 'D:\\tool.exe');
  assert.equal(note(doc).textContent, '');
  answer = { ok: false, reason: 'cancelled' };
  add();
  await settle();
  assert.equal(rows(doc).length, 3);
  assert.equal(note(doc).textContent, '');
});

test('Add program: too_many and other failures say why in the live note', async (t) => {
  let answer = { ok: false, reason: 'too_many' };
  const bridge = makeBridge({ addProgram: async () => answer });
  const { doc } = await mount(t, { bridge });
  doc.querySelector('[data-cu-action="add"]').click();
  await settle();
  assert.equal(note(doc).textContent, 'Your program list is full. Remove one first.');
  answer = { ok: false, reason: 'unreadable' };
  doc.querySelector('[data-cu-action="add"]').click();
  await settle();
  assert.equal(note(doc).textContent, 'That program could not be added.');
  assert.equal(rows(doc).length, 2);
});

test('not_windows keeps the group visible but greyed, with the note', async (t) => {
  const bridge = makeBridge({ status: async () => ({ ok: true, available: false, reason: 'not_windows', stopChord: CHORD, stopChordRegistered: null }) });
  const { doc, group, host } = await mount(t, { bridge });
  assert.equal(group.getAttribute('aria-disabled'), 'true');
  assert.match(note(doc).textContent, /Windows only for now\./);
  assert.ok(host.querySelectorAll('button').length > 0);
  for (const button of host.querySelectorAll('button')) assert.equal(button.disabled, true);
});

test('a missing bridge shows the group without programs and a not-available note', async (t) => {
  const { doc, host } = await mount(t, { bridge: null, platform: 'Win32' });
  assert.equal(host.querySelector('.cu-subheading'), null);
  assert.equal(rows(doc).length, 0);
  assert.equal(note(doc).textContent, 'Not available in this version.');
  assert.match(host.textContent, /Stop key/);
});

test('a missing bridge on another platform says Windows only', async (t) => {
  const { doc } = await mount(t, { bridge: null, platform: 'Linux x86_64' });
  assert.equal(note(doc).textContent, 'Windows only for now.');
});
