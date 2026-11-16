'use strict';

// new-test-file: a new surface (row 150 slice B7): the picture, file and chat card kinds and paste and drop, as kind
// modules on the card kinds seam, driven through the real canvas, editor and in-memory source.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardEditor } = require('../renderer/features/board/board-editor');
const { createBoardCanvasView } = require('../renderer/features/board/board-canvas-view');
const interactions = require('../renderer/features/board/board-canvas-interactions');
const toolbar = require('../renderer/features/board/board-canvas-toolbar');
const cardEditing = require('../renderer/features/board/board-card-editing');
const cardKinds = require('../renderer/features/board/board-card-kinds');
const media = require('../renderer/features/board/board-card-media');
const fileKind = require('../renderer/features/board/board-card-file');
const chatKind = require('../renderer/features/board/board-card-chat');
const dropPaste = require('../renderer/features/board/board-drop-paste');
const actionButton = require('../renderer/inventory/action-button');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');
const fileInput = require('../renderer/inventory/file-input');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const FACTORIES = new Map([['image', media.createMediaPart], ['file', fileKind.createFilePart], ['chat', chatKind.createChatPart], ['drop-paste', dropPaste.createDropPastePart]]);

function pngBytes(width, height) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

async function env(t, { readOnly = false, files = { root: 'C:/work/proj', paths: ['src/app.js', 'docs/plan.md'] }, seed = [], sessions = [], readFails = false, pageContext = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  let urlSeq = 0;
  const made = [];
  const revoked = [];
  window.URL.createObjectURL = (blob) => { made.push(blob.type); return `blob:jenny/${++urlSeq}`; };
  window.URL.revokeObjectURL = (url) => revoked.push(url);
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  let ids = 5000;
  let mine = 0;
  const source = createMemoryBoardSource({ model, files, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(ids++) });
  if (readFails) source.readAsset = async () => ({ ok: false, reason: 'not_found' });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const assets = [];
  for (const [w, h] of [[640, 480], [100, 50]]) assets.push((await source.addAsset({ boardId: created.id, bytes: pngBytes(w, h) })).asset);
  const ops = seed.map((item, i) => ({ op: 'card.add', card: Object.assign({ id: uid(900 + i), x: 100 + i * 300, y: 100, w: 200, h: 120 }, item(assets)) }));
  const seeded = ops.length ? await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops } }) : await source.get({ boardId: created.id });
  const notes = [];
  const notify = (message) => notes.push(message);
  const actions = [];
  const state = { sessions, ui: { pendingSessionDeletes: [] }, harness: { agentActions: {
    setActiveView: (view) => actions.push(`view:${view}`), openSession: async (id) => { actions.push(`open:${id}`); return true; },
  } } };
  const editor = createBoardEditor({ model, source, notify, log: () => {}, makeId: () => uid(++mine), now: () => '2026-11-13T12:00:00.000Z' });
  const canvas = createBoardCanvasView({ document: doc, actionButton, canvasSurface, boardCard, connectorLayer });
  doc.body.appendChild(canvas.element);
  canvas.surface.element.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: 800, height: 600, right: 800, bottom: 600 });
  canvas.setEditor(editor, {
    source, notify, log: () => {}, context: { state, getProjectId: () => 'project_alpha', ...pageContext },
    modules: { interactions, toolbar, cardEditing, cardKinds: { createBoardCardKinds: (ctx) => cardKinds.createBoardCardKinds({ ...ctx, factories: FACTORIES }) } },
  });
  canvas.show(seeded.board, { canUndo: false, canRedo: false, readOnly });
  await flush();
  t.after(() => { canvas.dispose(); window.close(); });
  const fire = (type, init) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, init);
    Object.keys(init).forEach((key) => Object.defineProperty(event, key, { value: init[key] }));
    canvas.surface.element.dispatchEvent(event);
    return event;
  };
  return {
    window, doc, source, editor, canvas, notes, actions, state, made, revoked, assets, id: created.id,
    el: (id) => doc.querySelector(`[data-card-id="${id}"]`),
    tool: (name) => doc.querySelector(`[data-board-tool="${name}"]`),
    server: async () => (await source.get({ boardId: created.id })).board,
    added: async (kind) => Object.values((await source.get({ boardId: created.id })).board.cards).filter((card) => card.kind === kind),
    key: (target, key) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    file: (bytes, name, type) => new window.File([bytes], name, { type }),
    drop: (items, at = { clientX: 400, clientY: 300 }) => fire('drop', { clientX: at.clientX, clientY: at.clientY, dataTransfer: transfer(items) }),
    paste: (items, target) => {
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer(items) });
      (target || canvas.surface.element).dispatchEvent(event);
      return event;
    },
    dragover: (items) => fire('dragover', { dataTransfer: transfer(items) }),
  };
}
function transfer({ files = [], text = '', uris = '' } = {}) {
  const types = (files.length ? ['Files'] : []).concat(text ? ['text/plain'] : [], uris ? ['text/uri-list'] : []);
  return { files, types, dropEffect: 'none', getData: (type) => (type === 'text/plain' ? text : type === 'text/uri-list' ? uris : '') };
}
const picture = (index, alt = 'A chart') => (assets) => ({ kind: 'image', data: { asset: assets[index], width: 640, height: 480, alt } });
const fileCard = (path) => () => ({ kind: 'file', data: { path, title: '' } });
const chatCard = (id) => () => ({ kind: 'chat', data: { session_id: id, message_id: null, title: 'Kickoff', excerpt: '' } });

/* ------------------------------------------------------------------ pictures */

test('a picture card shows an <img> from one shared blob URL with its alt; the URL is revoked on release and dispose', async (t) => {
  const h = await env(t, { seed: [picture(0), picture(0, 'Same picture'), picture(1)] });
  const img = (n) => h.el(uid(900 + n)).querySelector('[data-card-media] img[data-board-picture]');
  assert.equal(img(0).getAttribute('src'), 'blob:jenny/1');
  assert.equal(img(0).alt, 'A chart');
  assert.equal(img(1).getAttribute('src'), 'blob:jenny/1', 'one URL per picture, shared by its cards');
  assert.equal(img(1).alt, 'Same picture');
  assert.equal(img(2).getAttribute('src'), 'blob:jenny/2');
  assert.deepEqual(h.made, ['image/png', 'image/png']);
  h.editor.select([uid(900)]);
  await h.editor.removeSelected();
  await flush();
  assert.deepEqual(h.revoked, [], 'another card still shows it');
  h.editor.select([uid(901)]);
  await h.editor.removeSelected();
  await flush();
  assert.deepEqual(h.revoked, ['blob:jenny/1'], 'revoked when no card shows it');
  h.canvas.dispose();
  assert.deepEqual(h.revoked, ['blob:jenny/1', 'blob:jenny/2'], 'and every URL on dispose');
});

test('a picture that cannot be read shows one quiet line instead', async (t) => {
  const h = await env(t, { seed: [picture(0)], readFails: true });
  const slot = h.el(uid(900)).querySelector('[data-card-media]');
  assert.equal(slot.querySelector('img').hidden, true);
  const line = slot.querySelector('[data-board-picture-missing]');
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, 'This picture could not be shown.');
  assert.deepEqual(h.made, []);
});

test('Enter on a picture opens its description field: Enter saves through the editor, Esc cancels, focus returns', async (t) => {
  const h = await env(t, { seed: [picture(0)] });
  const card = h.el(uid(900));
  assert.equal(h.canvas.startEdit(uid(900)), true);
  const field = card.querySelector('[data-board-field="alt"]');
  assert.equal(h.doc.activeElement, field);
  assert.equal(field.value, 'A chart');
  field.value = 'Sales by month\nfor 2026';
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(field.value, 'Sales by month for 2026', 'one line');
  h.key(field, 'Enter');
  await flush();
  assert.equal((await h.server()).cards[uid(900)].data.alt, 'Sales by month for 2026');
  assert.equal(card.querySelector('[data-board-editor]'), null);
  assert.equal(h.doc.activeElement, card, 'focus is back on the card');
  assert.equal(card.querySelector('img').alt, 'Sales by month for 2026');
  h.canvas.startEdit(uid(900));
  const again = card.querySelector('[data-board-field="alt"]');
  again.value = 'Thrown away';
  h.key(again, 'Escape');
  await flush();
  assert.equal((await h.server()).cards[uid(900)].data.alt, 'Sales by month for 2026');
  assert.equal(h.doc.activeElement, card);
});

test('the Picture tool stores the chosen file and adds a 320 px wide card named after the file; refusals are told', async (t) => {
  const h = await env(t);
  let chosen = null;
  h.window.inventoryFileInput = (doc, options) => {
    const input = fileInput(doc, options);
    input.click = () => { Object.defineProperty(input, 'files', { value: [chosen] }); input.dispatchEvent(new h.window.Event('change')); };
    return input;
  };
  const button = h.tool('kind-picture');
  assert.equal(button.textContent.trim(), 'Picture');
  chosen = h.file(pngBytes(800, 400), 'Quarterly chart.final.png', 'image/png');
  button.click();
  await flush();
  const [card] = await h.added('image');
  assert.deepEqual([card.w, card.h, card.data.width, card.data.height, card.data.alt], [320, 160, 800, 400, 'Quarterly chart.final']);
  chosen = h.file(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.png', 'image/png');
  button.click();
  await flush();
  chosen = { name: 'huge.png', type: 'image/png', size: 10 * 1024 * 1024 + 1, arrayBuffer: () => { throw new Error('must not be read'); } };
  button.click();
  await flush();
  assert.deepEqual(h.notes, ['Only PNG, JPEG, WebP and GIF pictures can go on a board.', 'That picture is larger than 10 MB.']);
  assert.equal((await h.added('image')).length, 1);
  for (const reason of ['dimensions', 'full', 'read_only', 'not_found', 'disabled']) assert.notEqual(media.refusalText(reason), media.refusalText('io'), reason);
});

/* ------------------------------------------------------------------ files */

test('the File tool adds a resolved file card, says why a path is refused, and says when the project has no folder', async (t) => {
  const h = await env(t);
  h.tool('kind-file').click();
  await flush();
  const form = h.doc.querySelector('[data-board-file-form]');
  const field = form.querySelector('textarea');
  assert.equal(h.doc.activeElement, field);
  assert.equal(form.querySelector('[data-board-file-choose]').disabled, true, 'no chooser here: disabled, with its reason');
  assert.match(form.querySelector('[data-board-file-choose]').title, /not available/);
  field.value = 'C:/elsewhere/secret.txt';
  h.key(field, 'Enter');
  await flush();
  assert.equal(form.querySelector('[data-board-file-error]').textContent, 'That file is outside this project’s folder.');
  field.value = 'C:\\work\\proj\\src\\app.js';
  form.querySelector('[data-board-file-add]').click();
  await flush();
  assert.equal(h.doc.querySelector('[data-board-file-form]'), null);
  const [card] = await h.added('file');
  assert.deepEqual(card.data, { path: 'src/app.js', title: '' });

  const bare = await env(t, { files: null });
  bare.tool('kind-file').click();
  await flush();
  assert.equal(bare.doc.querySelector('[data-board-file-form]'), null);
  assert.deepEqual(bare.notes, ['This project has no folder, so its boards cannot hold files. Choose a folder for the project first.']);
  for (const reason of ['link', 'not_found', 'not_file', 'invalid']) assert.notEqual(fileKind.refusalText(reason), fileKind.refusalText('io'), reason);
});

test('a missing file is marked after fileStatus, and asked again when the window regains focus', async (t) => {
  const files = { root: 'C:/work/proj', paths: ['src/app.js'] };
  const h = await env(t, { files, seed: [fileCard('src/app.js'), fileCard('docs/gone.md')] });
  assert.equal(h.el(uid(900)).hasAttribute('data-missing'), false);
  assert.equal(h.el(uid(901)).hasAttribute('data-missing'), true);
  files.paths = ['docs/gone.md'];
  h.window.dispatchEvent(new h.window.Event('focus'));
  await flush();
  assert.equal(h.el(uid(900)).hasAttribute('data-missing'), true);
  assert.equal(h.el(uid(901)).hasAttribute('data-missing'), false);
});

test('Enter opens a file in the Workspace through openFile, and a chat on the Chat page; refusals are told', async (t) => {
  const sessions = [{ id: 'sess_1', title: 'Kickoff', project_id: 'project_alpha', updated_at: '2026-11-12T00:00:00Z' }];
  const h = await env(t, { sessions, seed: [fileCard('src/app.js'), fileCard('docs/gone.md'), chatCard('sess_1'), chatCard('sess_gone')] });
  const opened = [];
  h.window.addEventListener('ide:open-file-at-line', (event) => { opened.push(event.detail); event.preventDefault(); });
  h.canvas.startEdit(uid(900));
  await flush();
  assert.deepEqual(opened, [{ path: 'src/app.js', line: null, column: null, preferIde: true, projectId: 'project_alpha' }]);
  h.canvas.activate(uid(901), 'outline');
  await flush();
  assert.deepEqual(h.notes, ['That file is not there.']);
  h.canvas.startEdit(uid(902));
  await flush();
  assert.deepEqual(h.actions, ['view:chat', 'open:sess_1']);
  h.canvas.startEdit(uid(903));
  await flush();
  assert.deepEqual(h.notes.slice(1), ['That chat is no longer here.']);
});

test('a chat card opens through the openSession of the page with its chat and, when it names one, its message', async (t) => {
  const sessions = [{ id: 'sess_1', title: 'Kickoff', project_id: 'project_alpha', updated_at: '2026-11-12T00:00:00Z' }];
  const calls = [];
  const named = () => ({ kind: 'chat', data: { session_id: 'sess_1', message_id: 'msg_7', title: 'Kickoff', excerpt: 'Move the check' } });
  const h = await env(t, { sessions, seed: [chatCard('sess_1'), named], pageContext: { openSession: async (target) => { calls.push(target); } } });
  h.canvas.startEdit(uid(900));
  h.canvas.startEdit(uid(901));
  await flush();
  assert.deepEqual(calls, [{ sessionId: 'sess_1', messageId: null }, { sessionId: 'sess_1', messageId: 'msg_7' }]);
  assert.deepEqual(h.actions, [], 'the opener of the page is used instead of the app opener');
  assert.deepEqual(h.notes, []);
});

/* ------------------------------------------------------------------ chats */

test('the Chat tool lists this project\'s chats newest first, at most 30, and adds the one picked', async (t) => {
  const sessions = Array.from({ length: 35 }, (_, i) => ({ id: `sess_${i}`, title: `Chat ${i}`, project_id: 'project_alpha', updated_at: `2026-11-${String(10 + (i % 3)).padStart(2, '0')}T00:00:${String(i).padStart(2, '0')}Z` }))
    .concat([{ id: 'sess_other', title: 'Elsewhere', project_id: 'project_beta', updated_at: '2026-12-01T00:00:00Z' },
      { id: 'sess_old', title: 'Archived', project_id: 'project_alpha', archived_at: '2026-11-01', updated_at: '2026-12-01T00:00:00Z' }]);
  const h = await env(t, { sessions });
  h.tool('kind-chat').click();
  await flush();
  const rows = Array.from(h.doc.querySelectorAll('.inv-context-menu-item'));
  assert.equal(rows.length, chatKind.CHAT_MENU_MAX);
  assert.equal(rows[0].textContent, 'Chat 32', 'newest first');
  assert.equal(rows.some((row) => /Elsewhere|Archived/.test(row.textContent)), false);
  rows[0].click();
  await flush();
  const [card] = await h.added('chat');
  assert.deepEqual(card.data, { session_id: 'sess_32', message_id: null, title: 'Chat 32', excerpt: '' });
  const empty = await env(t, { sessions: [] });
  empty.tool('kind-chat').click();
  await flush();
  assert.deepEqual(empty.notes, ['This project has no chats yet. Start one, then add it here.']);
});

/* ------------------------------------------------------------------ paste and drop */

test('a dropped picture lands at the drop point, a dropped file becomes a file card, several are offset in order', async (t) => {
  const h = await env(t);
  h.window.jennyShell = { attachments: { getPathForFile: (file) => `C:\\work\\proj\\${file.name === 'app.js' ? 'src\\app.js' : file.name}` } };
  h.drop({ files: [h.file(pngBytes(320, 320), 'shot.png', 'image/png'), h.file('x', 'app.js', 'text/javascript'), h.file('x', 'nope.txt', 'text/plain')] }, { clientX: 400, clientY: 300 });
  await flush();
  const [image] = await h.added('image');
  assert.deepEqual([image.x + image.w / 2, image.y + image.h / 2], [400, 300]);
  const [file] = await h.added('file');
  assert.equal(file.data.path, 'src/app.js');
  assert.deepEqual([file.x + file.w / 2, file.y + file.h / 2], [424, 324], 'the second item is offset');
  assert.deepEqual(h.notes, ['That file is not there.']);
  assert.equal(h.dragover({ files: [1] }).dataTransfer.dropEffect, 'copy');
});

test('pasted text: one web address becomes a link, other text a note cut to the limit; a field keeps its paste', async (t) => {
  const h = await env(t);
  assert.equal(h.paste({ text: '  https://example.com/a?b=1  ' }).defaultPrevented, true);
  await flush();
  const [link] = await h.added('link');
  assert.equal(link.data.url, 'https://example.com/a?b=1');
  h.paste({ text: `line one\r\nline\u0007 two ${'x'.repeat(5000)}` });
  await flush();
  const [note] = await h.added('note');
  assert.equal(note.data.text.length, 4000);
  assert.ok(note.data.text.startsWith('line one\nline two'));
  h.tool('kind-file').click();
  await flush();
  const field = h.doc.querySelector('[data-board-file-form] textarea');
  field.focus();
  assert.equal(h.paste({ text: 'https://example.com/' }, field).defaultPrevented, false, 'the field takes its own paste');
  h.paste({ text: 'https://example.com/b' });
  await flush();
  assert.equal((await h.added('link')).length, 1, 'focus in a field: the board is left alone');
  h.paste({ files: [h.file(pngBytes(10, 10), 'clip.png', 'image/png')] });
  await flush();
  assert.equal((await h.added('image')).length, 0, 'still in the field');
  field.blur();
  h.paste({ files: [h.file(pngBytes(10, 10), 'clip.png', 'image/png')] });
  await flush();
  const [pasted] = await h.added('image');
  // A paste has no place of its own: the board's next free place, not the middle of the view, where it covered what was there.
  const others = [...await h.added('link'), ...await h.added('note')];
  const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  assert.ok(others.length > 0 && others.every((card) => apart(card, pasted)), 'a paste covers no card that is already there');
  assert.deepEqual([pasted.w, pasted.h], [10, 10], 'a picture narrower than 320 px keeps its size');
});

test('a read-only board takes no paste or drop and says so once; a drop of eleven adds ten and counts the rest', async (t) => {
  const locked = await env(t, { readOnly: true });
  locked.paste({ text: 'hello' });
  locked.drop({ files: [locked.file(pngBytes(5, 5), 'a.png', 'image/png')] });
  await flush();
  assert.deepEqual(locked.notes, ['This board cannot be changed, so nothing was added.', 'This board cannot be changed, so nothing was added.']);
  assert.deepEqual(Object.keys((await locked.server()).cards), []);
  assert.equal(locked.dragover({ files: [1] }).dataTransfer.dropEffect, 'none');

  const h = await env(t);
  h.drop({ files: Array.from({ length: 11 }, (_, i) => h.file(pngBytes(10 + i, 10), `p${i}.png`, 'image/png')) });
  await flush();
  const images = await h.added('image');
  assert.equal(images.length, 10);
  assert.deepEqual(images.map((card) => card.data.width).sort((a, b) => a - b), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(h.notes, ['1 more items were not added: a board takes at most 10 at a time.']);
  h.canvas.dispose();
  h.paste({ text: 'after dispose' });
  await flush();
  assert.equal((await h.added('note')).length, 0, 'listeners are gone');
});

test('at most 64 picture URLs are kept: the oldest is revoked when a 65th is made', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { window } = dom;
  const revoked = [];
  let seq = 0;
  window.URL.createObjectURL = () => `blob:x/${++seq}`;
  window.URL.revokeObjectURL = (url) => revoked.push(url);
  const part = media.createMediaPart({
    document: window.document, windowRef: window, boardCard, editor: { getBoard: () => ({ id: 'board_x' }) },
    source: { readAsset: async () => ({ ok: true, bytes: new Uint8Array([1]), mime: 'image/png' }) },
  });
  for (let i = 0; i <= media.URL_CACHE; i += 1) {
    const element = boardCard({ id: uid(i), kind: 'image', x: 0, y: 0, w: 10, h: 10 }, { document: window.document });
    part.decorate(element, { id: uid(i), kind: 'image', data: { asset: String(i).padStart(64, '0'), alt: '' } });
    await flush();
  }
  assert.deepEqual(revoked, ['blob:x/1']);
  part.dispose();
  assert.equal(revoked.length, media.URL_CACHE + 1, 'dispose revokes the rest');
  window.close();
});
