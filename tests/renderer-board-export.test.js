'use strict';

// new-test-file: a new surface (row 150 slice B10): the board's export builders (SVG, Excalidraw, Markdown, the PNG step)
// in renderer/features/board/board-export.js, and the Export and Import controls on the Board page. Page-level cases live
// here because tests/renderer-board-page.test.js is at its line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const exporter = require('../renderer/features/board/board-export');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardPage } = require('../renderer/features/board/board-page');

const NOW = '2026-11-13T10:00:00.000Z';
const PROJECT = 'project_alpha';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const HOSTILE = '</text><script>alert(1)</script> " onload="x ]]>';
const MD_HOSTILE = '# heading\n![x](y)\n[a](b) and <b>bold</b>';
const ASSET = 'a'.repeat(64);
const MISSING = 'b'.repeat(64);
const PNG_B64 = 'iVBORw0KGgo=';

function hostileBoard() {
  const made = model.createBoard({ id: `board_${uid(1)}`, project_id: PROJECT, name: `Plan ${HOSTILE}`, now: NOW });
  const ops = [
    { op: 'group.add', group: { id: uid(10), title: `Group ${HOSTILE}`, x: 0, y: 400, w: 600, h: 300 } },
    { op: 'card.add', card: { id: uid(11), kind: 'note', data: { text: `${HOSTILE}\n${MD_HOSTILE}`, tone: 'amber' }, x: 20, y: 0, w: 220, h: 120 } },
    { op: 'card.add', card: { id: uid(12), kind: 'link', data: { url: 'https://example.com/a"b<c>(d)', title: `Title ${HOSTILE} [x](y)` }, x: 300, y: 0, w: 360, h: 220 } },
    { op: 'card.add', card: { id: uid(13), kind: 'file', data: { path: 'src/a`b`.js', title: '' }, x: 20, y: 460, group_id: uid(10) } },
    { op: 'card.add', card: { id: uid(14), kind: 'chat', data: { session_id: 'sess_1', message_id: null, title: 'Chat <i>', excerpt: '' }, x: 300, y: 460, group_id: uid(10) } },
    { op: 'card.add', card: { id: uid(15), kind: 'diagram', data: { scene: 'a -> b', title: 'Flow' }, x: 700, y: 0 } },
    { op: 'card.add', card: { id: uid(16), kind: 'image', data: { asset: ASSET, width: 4, height: 4, alt: 'Logo' }, x: 1000, y: 0 } },
    { op: 'card.add', card: { id: uid(17), kind: 'image', data: { asset: MISSING, width: 4, height: 4, alt: `Alt ${HOSTILE}` }, x: 1300, y: 0 } },
    { op: 'connector.add', connector: { id: uid(20), from: uid(11), to: uid(12), label: `label ${HOSTILE}` } },
    { op: 'connector.add', connector: { id: uid(21), from: uid(13), to: uid(14), label: '', style: 'dashed', ends: 'both' } },
  ];
  const applied = model.applyBatch(made.board, { batch_id: 'seed', board_id: made.board.id, actor: 'owner', ops }, { now: NOW, authority: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  return applied.board;
}

const ALLOWED = new Set(['svg', 'g', 'rect', 'text', 'tspan', 'line', 'path', 'polygon', 'image', 'defs', 'marker', 'clipPath', 'title']);

function parseSvg(text) {
  const { window } = new JSDOM('');
  const doc = new window.DOMParser().parseFromString(text, 'image/svg+xml');
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, 'the SVG parses as XML');
  return doc;
}

test('boardToSvg: every piece of board text is escaped, only the allowed elements appear, and pictures are data URIs', () => {
  const board = hostileBoard();
  const pictures = { [ASSET]: { mime: 'image/png', base64: PNG_B64 }, [MISSING]: { mime: 'image/svg+xml', base64: PNG_B64 } };
  const svg = exporter.boardToSvg(board, { palette: { background: '#101010', card: '#202020', text: 'red;" onload="x' }, pictures });
  assert.equal(svg.includes('<script'), false);
  assert.equal(svg.includes('onload="x'), false);
  assert.ok(svg.includes('&lt;/text&gt;&lt;script&gt;'));
  const doc = parseSvg(svg);
  const root = doc.documentElement;
  assert.equal(root.localName, 'svg');
  for (const el of root.getElementsByTagName('*')) {
    assert.ok(ALLOWED.has(el.localName), `element ${el.localName}`);
    for (const attr of el.attributes) {
      assert.equal(/^on/i.test(attr.name), false, `event attribute ${attr.name}`);
      if (/href$/i.test(attr.name)) assert.match(attr.value, /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/);
      if (attr.value.includes('url(')) assert.match(attr.value, /^url\(#[A-Za-z0-9_-]+\)$/);
    }
  }
  const images = root.getElementsByTagName('image');
  assert.equal(images.length, 1, 'one picture embedded; the SVG-typed one is drawn as a box');
  assert.equal(images[0].getAttribute('href'), `data:image/png;base64,${PNG_B64}`);
  assert.ok(root.textContent.includes(HOSTILE), 'the hostile text is text');
  assert.ok(root.textContent.includes('Drawing'));
  assert.ok(root.textContent.includes('src/a`b`.js'));
  assert.ok(root.textContent.includes('https://example.com/a"b<c>(d)'));
  assert.equal(root.getElementsByTagName('title')[0].textContent, `Plan ${HOSTILE}`);
  assert.ok(root.getElementsByTagName('line').length >= 2, 'a line per connector');
  assert.ok(root.querySelector('line[stroke-dasharray]'), 'the dashed connector');
  assert.ok(root.querySelector('line[marker-start][marker-end]'), 'both ends');
  assert.equal(root.querySelector('rect').getAttribute('fill'), '#101010', 'the palette colours the export');
  assert.equal(svg.includes('red;'), false, 'a palette value that is not a colour is not used');
  const viewBox = root.getAttribute('viewBox').split(' ').map(Number);
  assert.deepEqual(viewBox.slice(0, 2), [-24, -24], 'the content box plus a 24 px margin');
});

test('boardToSvg wraps a note to its width and keeps it inside its height', () => {
  const made = model.createBoard({ id: `board_${uid(1)}`, project_id: PROJECT, name: 'Wrap', now: NOW }).board;
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const board = model.applyBatch(made, { batch_id: 'w', board_id: made.id, actor: 'owner', ops: [
    { op: 'card.add', card: { id: uid(1), kind: 'note', data: { text: long }, x: 0, y: 0, w: 200, h: 80 } }] }, { now: NOW, authority: true }).board;
  const doc = parseSvg(exporter.boardToSvg(board, {}));
  const spans = [...doc.getElementsByTagName('tspan')];
  assert.ok(spans.length > 1 && spans.length < 6, `wrapped into a few lines, cut at the height (${spans.length})`);
  assert.ok(spans.every((span) => span.textContent.length <= 40));
  assert.ok(doc.querySelector('clipPath rect'), 'clipped to the card');
});

test('boardToExcalidraw is deterministic: a rectangle and bound text per card and group, a bound arrow per connector', () => {
  const board = hostileBoard();
  const first = exporter.boardToExcalidraw(board);
  assert.equal(exporter.boardToExcalidraw(model.normalizeBoard(JSON.parse(JSON.stringify(board))).board), first, 'byte-identical across runs');
  const file = JSON.parse(first);
  assert.deepEqual([file.type, file.version, file.files], ['excalidraw', 2, {}]);
  assert.ok(file.appState && typeof file.appState === 'object');
  const byId = new Map(file.elements.map((el) => [el.id, el]));
  const rects = file.elements.filter((el) => el.type === 'rectangle');
  assert.equal(rects.length, Object.keys(board.cards).length + Object.keys(board.groups).length);
  for (const rect of rects) {
    const bound = (rect.boundElements || []).filter((ref) => ref.type === 'text');
    assert.equal(bound.length, 1, `bound text for ${rect.id}`);
    assert.equal(byId.get(bound[0].id).containerId, rect.id);
    assert.ok(Number.isInteger(rect.seed) && rect.seed > 0);
  }
  const arrows = file.elements.filter((el) => el.type === 'arrow');
  assert.equal(arrows.length, 2);
  for (const arrow of arrows) {
    assert.ok(byId.get(arrow.startBinding.elementId).type === 'rectangle' && byId.get(arrow.endBinding.elementId).type === 'rectangle');
    assert.ok(byId.get(arrow.startBinding.elementId).boundElements.some((ref) => ref.id === arrow.id));
  }
  assert.ok(arrows.some((arrow) => arrow.strokeStyle === 'dashed' && arrow.startArrowhead === 'arrow' && arrow.endArrowhead === 'arrow'));
  assert.ok(file.elements.some((el) => el.id.includes(uid(11))), 'element ids derive from the item ids');
  assert.ok(file.elements.some((el) => el.type === 'text' && el.originalText === 'Picture: Logo'), 'a picture is a labelled rectangle');
  assert.ok(file.elements.some((el) => el.type === 'text' && el.originalText === 'Drawing: Flow'));
});

test('boardToMarkdown: headings, bullets in reading order, escaped text, and the connections', () => {
  const board = hostileBoard();
  const md = exporter.boardToMarkdown(board);
  const lines = md.split('\n');
  assert.ok(lines[0].startsWith('# Plan '));
  assert.deepEqual(lines.filter((line) => /^#/.test(line)).map((line) => line.split(' ')[0]), ['#', '##', '##'], 'only the board, its group and the connections are headings');
  assert.ok(lines.some((line) => line.startsWith('## Group ')));
  assert.ok(lines.includes('## Connections'));
  assert.equal(/(^|[^\\])!\[/.test(md), false, 'no image can be forged');
  assert.equal(/(^|[^\\])</.test(md.replace(/\]\(<[^<>\s]*>\)/g, '')), false, 'no unescaped < outside the link card\'s address: no tag can be forged');
  assert.ok(md.includes('\\<script\\>'), 'the tag is shown as text');
  assert.ok(md.includes('\\# heading'), 'a note cannot forge a heading');
  assert.ok(md.includes('\\[a\\]\\(b\\)'), 'nor a link');
  const links = md.match(/(^|[^\\])\]\(/g) || [];
  assert.equal(links.length, 1, 'the link card is the one link');
  assert.ok(md.includes('](<https://example.com/a%22b%3Cc%3E%28d%29>)'), 'the address is escaped');
  assert.ok(md.includes('``src/a`b`.js``') || md.includes('`` src/a`b`.js ``'), 'a file as inline code');
  const ungrouped = lines.findIndex((line) => line.includes('Keep') || line.includes('&lt;') || line.startsWith('- \\<'));
  const group = lines.findIndex((line) => line.startsWith('## Group'));
  assert.ok(ungrouped > 0 && ungrouped < group, 'cards outside a group come first');
  const connections = lines.slice(lines.indexOf('## Connections') + 1).filter(Boolean);
  assert.equal(connections.length, 2);
  assert.ok(connections.every((line) => line.startsWith('- ') && line.length < 220));
  assert.ok(connections.some((line) => line.includes(' \\<-> ')), 'a both-ends connector, its < escaped');
  assert.ok(connections.some((line) => line.includes(' -> ') && line.includes(': label ')));

  const bad = JSON.parse(JSON.stringify(board));
  bad.cards[uid(12)].data.url = 'javascript:alert(1)';
  const unsafe = exporter.boardToMarkdown(bad);
  assert.equal(/\]\(<?javascript:/i.test(unsafe), false, 'a javascript: address never becomes a link');
  assert.equal(exporter.boardToSvg(bad, {}).includes('href="javascript'), false);
});

test('svgToPngBase64 refuses a picture over 16,384 px a side or 64 megapixels, and draws through the injected image and canvas', async () => {
  let made = 0;
  const createImage = () => { made += 1; return {}; };
  assert.deepEqual(await exporter.svgToPngBase64('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="10"></svg>', { scale: 1, createImage }), { ok: false, reason: 'too_large' });
  assert.deepEqual(await exporter.svgToPngBase64('<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="9000"></svg>', { scale: 1, createImage }), { ok: false, reason: 'too_large' });
  assert.deepEqual(await exporter.svgToPngBase64('<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="10"></svg>', { scale: 4, createImage }), { ok: false, reason: 'too_large' });
  assert.equal(made, 0);
  const drawn = [];
  const image = {};
  Object.defineProperty(image, 'src', { set(value) { drawn.push(['src', value.slice(0, 26)]); setImmediate(() => image.onload()); } });
  const canvas = { getContext: () => ({ scale: (x, y) => drawn.push(['scale', x, y]), drawImage: () => drawn.push(['draw']) }), toDataURL: (type) => (type === 'image/png' ? 'data:image/png;base64,QUJD' : '') };
  const out = await exporter.svgToPngBase64('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>', { scale: 2, createImage: () => image, createCanvas: () => canvas });
  assert.deepEqual(out, { ok: true, base64: 'QUJD' });
  assert.deepEqual([canvas.width, canvas.height], [200, 100]);
  assert.deepEqual(drawn, [['src', 'data:image/svg+xml;charset'], ['scale', 2, 2], ['draw']]);
});

/* ------------------------------------------------------------------ the page */

const BRIDGE_CALLS = ['list', 'create', 'get', 'apply', 'undo', 'redo', 'rename', 'duplicate', 'delete', 'restore', 'fetchLinkTitle', 'setSelection',
  'addAsset', 'readAsset', 'resolveFile', 'openFile', 'fileStatus'];

function pageHarness(t, { transfer = true, importText = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  let tick = Date.parse(NOW);
  let seq = 0;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(++seq) });
  const calls = [];
  const bridge = { onChanged: (listener) => source.onChanged(listener) };
  for (const name of BRIDGE_CALLS) bridge[name] = (request) => { calls.push([name, request]); return source[name](request); };
  const answers = { exportFile: null };
  if (transfer) {
    bridge.exportFile = (request) => { calls.push(['exportFile', request]); return answers.exportFile || source.exportFile(request); };
    bridge.importFile = (request) => { calls.push(['importFile', request]); return importText ? source.importFile({ ...request, text: importText }) : { ok: false, reason: 'cancelled' }; };
  }
  const saved = [];
  window.jennyShell = { boards: bridge, dialog: { saveFile: async (payload) => { saved.push(payload); return { canceled: false, path: `C:\\Users\\me\\Desktop\\${payload.defaultName}`, bytesWritten: 1 }; } } };
  const toasts = [];
  const switcher = { currentProject: () => ({ id: PROJECT, name: 'Alpha' }), refresh: async () => [], onProjectsChanged: () => () => {} };
  t.after(() => window.close());
  const doc = window.document;
  return {
    window, doc, source, calls, toasts, saved, answers,
    row: (name) => [...doc.querySelectorAll('[data-board-id]')].find((el) => el.getAttribute('data-board-name') === name),
    names: () => [...doc.querySelectorAll('[data-board-id] .session-row__title-text')].map((el) => el.textContent),
    importButton: () => doc.querySelector('[data-board-list] .board-list__new [data-board-action="import"]'),
    menuItems: () => [...doc.querySelectorAll('.inv-context-menu [role="menuitem"]')],
    async start() {
      const page = createBoardPage({ container: doc.getElementById('boardView'), windowRef: window, storage: window.localStorage,
        getProjectSwitcher: async () => switcher, showToast: (message, options) => toasts.push({ message, ...options }) });
      t.after(() => page.dispose());
      await page.started;
      await flush();
      return page;
    },
  };
}

test('each board row has an Export icon button whose menu offers the five formats; the .jennyboard file goes through the source', async (t) => {
  const h = pageHarness(t);
  await h.source.create({ projectId: PROJECT, name: 'Plan' });
  await h.start();
  const button = h.row('Plan').querySelector('[data-board-action="export"]');
  assert.ok(button, 'the Export control');
  assert.equal(button.getAttribute('aria-label'), 'Export Plan');
  assert.equal(button.title, 'Export Plan');
  assert.equal(button.disabled, false);
  button.click();
  await flush();
  assert.deepEqual(h.menuItems().map((item) => item.textContent), ['Picture (PNG)', 'Drawing (SVG)', 'Excalidraw file', 'Outline (Markdown)', 'Jenny board file (.jennyboard)']);
  h.menuItems()[4].click();
  await flush();
  assert.deepEqual(h.calls.filter(([name]) => name === 'exportFile').map(([, request]) => Object.keys(request)), [['boardId']]);
  assert.equal(h.toasts.at(-1).message, 'Saved as Plan.jennyboard.');
  h.answers.exportFile = { ok: false, reason: 'cancelled' };
  const before = h.toasts.length;
  button.click();
  await flush();
  h.menuItems()[4].click();
  await flush();
  assert.equal(h.toasts.length, before, 'a closed dialog says nothing');
  h.answers.exportFile = { ok: true, name: 'x.jennyboard', missingPictures: 2 };
  button.click();
  await flush();
  h.menuItems()[4].click();
  await flush();
  assert.deepEqual(h.toasts.slice(-1).map((toast) => toast.message), ['Saved as x.jennyboard. 2 pictures could not be included.']);
});

test('the Markdown, SVG and Excalidraw exports are built in the page and saved through dialog.saveFile', async (t) => {
  const h = pageHarness(t);
  const board = (await h.source.create({ projectId: PROJECT, name: 'Plan' })).board;
  await h.source.apply({ boardId: board.id, batch: { batch_id: 'b1', board_id: board.id, ops: [{ op: 'card.add', card: { id: uid(5), kind: 'note', data: { text: 'Hello' } } }] } });
  await h.start();
  const button = h.row('Plan').querySelector('[data-board-action="export"]');
  for (const [index, ext, format] of [[3, 'md', 'markdown'], [1, 'svg', 'plain'], [2, 'excalidraw', 'plain']]) {
    button.click();
    await flush();
    h.menuItems()[index].click();
    await flush();
    const payload = h.saved.at(-1);
    assert.equal(payload.defaultName, `Plan.${ext}`);
    assert.equal(payload.format, format);
    assert.equal(payload.encoding, undefined);
    assert.ok(payload.content.includes('Hello'));
    assert.equal(h.toasts.at(-1).message, `Saved as Plan.${ext}.`, 'the base name only');
  }
  assert.ok(h.saved[0].content.startsWith('# Plan'));
  assert.ok(h.saved[1].content.startsWith('<svg'));
});

test('Import board sits beside New board, opens the imported board, and says so; a refusal is one sentence', async (t) => {
  let donorSeq = 7000;
  const donor = createMemoryBoardSource({ model, now: () => NOW, makeId: () => uid(++donorSeq) });
  const made = (await donor.create({ projectId: 'project_other', name: 'From afar' })).board;
  const text = (await donor.exportFile({ boardId: made.id })).text;
  const h = pageHarness(t, { importText: text });
  await h.source.create({ projectId: PROJECT, name: 'Plan' });
  await h.start();
  const button = h.importButton();
  assert.ok(button);
  assert.equal(button.textContent.trim(), 'Import board…');
  button.click();
  await flush();
  assert.deepEqual(h.calls.filter(([name]) => name === 'importFile').map(([, request]) => request), [{ projectId: PROJECT }]);
  assert.deepEqual(h.names(), ['Plan', 'From afar']);
  assert.equal(h.doc.querySelector('[data-board-id].active').getAttribute('data-board-name'), 'From afar', 'the imported board is open');
  assert.equal(h.toasts.at(-1).message, 'Board imported.');

  const refused = pageHarness(t);
  await refused.start();
  refused.importButton().click();
  await flush();
  assert.equal(refused.toasts.length, 0, 'a closed dialog says nothing');
  for (const [reason, sentence] of [['too_large', 'That file is larger than 64 MB.'], ['not_json', 'That file is not a Jenny board.'],
    ['format', 'That file is not a Jenny board.'], ['limit', 'This project already has 20 boards.']]) {
    assert.equal(exporter.outcomeText({ ok: false, reason, limit: reason === 'limit' ? 'boards_per_project' : undefined }, 'import'), sentence);
  }
});

test('an older bridge without the two calls: Export and Import are disabled with the reason as the tooltip, not hidden', async (t) => {
  const h = pageHarness(t, { transfer: false });
  await h.source.create({ projectId: PROJECT, name: 'Plan' });
  await h.start();
  const importButton = h.importButton();
  assert.ok(importButton, 'still there');
  assert.equal(importButton.disabled, true);
  assert.match(importButton.title, /not available/);
  const exportButton = h.row('Plan').querySelector('[data-board-action="export"]');
  assert.equal(exportButton.disabled, false, 'the four page-built exports still work');
  exportButton.click();
  await flush();
  assert.equal(h.menuItems().at(-1).disabled, true, 'the .jennyboard file needs the newer bridge');
  h.window.jennyShell.dialog = undefined;
  h.source.create({ projectId: PROJECT, name: 'Second' });
  await flush();
  const second = h.row('Second').querySelector('[data-board-action="export"]');
  assert.equal(second.disabled, true);
  assert.match(second.title, /not available/);
});
