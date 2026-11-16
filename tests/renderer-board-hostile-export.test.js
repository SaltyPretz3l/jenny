'use strict';

/* eslint-disable no-control-regex -- the point of these tests is to hand control characters to the builders and find them again. */

// new-test-file: a new surface (row 150 hardening, slice P5-B): what the board's export builders write for a board whose every
// text field holds a hostile fixture (tests/helpers/board-hostile-fixtures.js): SVG, Markdown, Excalidraw, the PNG's source
// and the suggested file name. The page itself is tests/renderer-board-hostile.test.js. Fixtures are inert text here.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const { JSDOM } = require('jsdom');
const { marked } = require('marked');

const model = require('../services/boards/board-model');
const exporter = require('../renderer/features/board/board-export');
const fx = require('./helpers/board-hostile-fixtures');

const { NOW, uid } = fx;
const clone = (value) => JSON.parse(JSON.stringify(value));
const SVG_NAMES = ['svg', 'g', 'rect', 'text', 'tspan', 'line', 'path', 'polygon', 'image', 'defs', 'marker', 'clipPath', 'title'];
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const window = new JSDOM('<!doctype html><body></body>').window;
const FORBIDDEN = 'script, iframe, object, embed, link, style, meta, base';
// What a markup-free export may hold when read as HTML: the tags below are the ones the outline needs.
const MARKDOWN_TAGS = new Set(['h1', 'h2', 'ul', 'li', 'p', 'a', 'code']);

/** Strings an export writer is most likely to mishandle, on top of the fixtures: XML non-characters and every lone half of a pair. */
const XML_TRAPS = ['a￾b￿c', 'x\udc00\udc00y', 'x\ud83d', '\ude00x', 'x\ud83d😀', '\ud83d\ud83d', 'a\u0001b'.replace('\u0001', ' ')];

function boardWith(texts) {
  const made = model.createBoard({ id: fx.BOARD_ID, project_id: 'project_general', name: texts[0], now: NOW });
  assert.equal(made.ok, true);
  const ops = [{ op: 'group.add', group: { id: uid(1), title: texts[0], x: 0, y: 0, w: 600, h: 300 } },
    { op: 'card.add', card: { id: uid(2), kind: 'note', data: { text: `${texts[0]}\n${texts[1]}` }, x: 10, y: 50, group_id: uid(1) } },
    { op: 'card.add', card: { id: uid(3), kind: 'link', data: { url: 'http://example.invalid/', title: texts[1] }, x: 300, y: 50 } },
    { op: 'card.add', card: { id: uid(4), kind: 'chat', data: { session_id: 's1', message_id: null, title: texts[2], excerpt: texts[2] }, x: 10, y: 400 } },
    { op: 'connector.add', connector: { id: uid(5), from: uid(2), to: uid(3), label: texts[2] } }];
  const applied = model.applyBatch(made.board, { batch_id: 'b', board_id: fx.BOARD_ID, actor: 'owner', ops }, { now: NOW, authority: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  return applied.board;
}

function parseXml(svg) {
  const doc = new window.DOMParser().parseFromString(svg, 'image/svg+xml');
  assert.equal(doc.querySelector('parsererror'), null, `the SVG is not XML: ${(doc.querySelector('parsererror') || {}).textContent}`);
  return doc;
}

function auditSvg(svg, label) {
  const doc = parseXml(svg);
  const names = new Set([...doc.querySelectorAll('*')].map((el) => el.localName));
  assert.deepEqual([...names].filter((name) => !SVG_NAMES.includes(name)), [], `${label}: only the elements the header lists`);
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of el.attributes) {
      assert.ok(!/^on/i.test(attr.name), `${label}: ${el.localName} ${attr.name}`);
      if (/(^|:)href$/i.test(attr.name)) assert.match(attr.value, /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, `${label}: an address that is not a picture`);
    }
  });
  return doc;
}

test('the SVG of the fixture board is XML with only its listed elements, no handler and no address but a picture', () => {
  const { board, held } = fx.hostileBoardReport(model);
  const svg = exporter.boardToSvg(board, { palette: {}, pictures: {} });
  const doc = auditSvg(svg, 'fixture board');
  const texts = [...doc.querySelectorAll('text, tspan, title')].map((el) => el.textContent).join('\n');
  assert.ok(texts.includes(board.name), 'the board name is the title, as text');
  // Every group title and connector label that fits is there as text, and a long one is cut with an ellipsis, never dropped.
  held.filter((entry) => entry.field === 'connector.label' && entry.value.length <= 60 && !/[\u0000-\u001f\ud800-\udfff￾￿]/.test(entry.value)).forEach((entry) => assert.ok(texts.includes(entry.value), `${entry.name} is a label`));
  // A picture is the one thing that may carry an address, and only as a data URI of the four picture types.
  const picture = (extra) => exporter.boardToSvg(board, { pictures: { [fx.SHA]: Object.assign({ mime: 'image/png', base64: PNG_1X1 }, extra) } });
  assert.ok(auditSvg(picture(), 'a picture').querySelectorAll('image').length > 0);
  for (const bad of [{ mime: 'image/svg+xml' }, { mime: 'text/html' }, { mime: 'image/png"onload="x' }, { base64: 'AAAA"onload="alert(1)' }, { base64: 'AAAA<script>' }, { base64: '' }]) {
    assert.equal(auditSvg(picture(bad), JSON.stringify(bad).slice(0, 40)).querySelectorAll('image').length, 0, 'a picture that is not one is drawn as a box');
  }
  // The colours come from the theme: only a hex colour is used, so a hostile value falls back to the default.
  const coloured = auditSvg(exporter.boardToSvg(board, { palette: { background: '#fff" onload="x', text: 'url(javascript:alert(1))', card: 'red', border: '</svg>' } }), 'palette');
  assert.equal(coloured.querySelector('[fill*="javascript"], [stroke*="javascript"], [fill*="onload"]'), null);
});

test('the SVG stays XML for every fixture and every lone half of a surrogate pair, in every text slot', () => {
  const traps = fx.HOSTILE.map((entry) => entry.value).concat(XML_TRAPS);
  let checked = 0;
  traps.forEach((value, i) => {
    const slot = [value, traps[(i + 1) % traps.length], traps[(i + 2) % traps.length]];
    const doc = clone(boardWith(['x', 'y', 'z']));
    doc.name = slot[0] && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(slot[0]) ? slot[0] : 'x';
    // Straight into the builder: it is also handed documents that never passed the model (an older bridge, a test double).
    Object.values(doc.cards).forEach((card) => {
      if (card.kind === 'note') card.data.text = `${slot[0]}\n${slot[1]}`;
      if (card.kind === 'link') card.data.title = slot[1];
      if (card.kind === 'chat') { card.data.title = slot[2]; card.data.excerpt = slot[2]; }
    });
    Object.values(doc.groups).forEach((group) => { group.title = slot[0]; });
    Object.values(doc.connectors).forEach((con) => { con.label = slot[2]; });
    auditSvg(exporter.boardToSvg(doc, {}), `trap ${i}`);
    checked += 1;
  });
  assert.equal(checked, traps.length);
});

/** Every link token of a marked token tree. */
function collectLinks(tokens, out = []) {
  for (const token of tokens || []) {
    if (token.type === 'link') out.push(token);
    collectLinks(token.tokens, out);
    collectLinks(token.items, out);
  }
  return out;
}

/** The destination of a link as CommonMark reads it: a backslash escape is the character, an entity is decoded, and nothing else changes. */
function destinationOf(link) {
  const written = /^\[[\s\S]*\]\((?:<([^>]*)>|([^\s)]*))/.exec(link.raw);
  const dest = written ? (written[1] !== undefined ? written[1] : written[2]) : link.href;
  const area = window.document.createElement('textarea');
  return dest.replace(/\\([!-/:-@[-`{-~])|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (all, escaped) => {
    if (escaped !== undefined) return escaped;
    area.innerHTML = all;
    return area.value;
  });
}

test('the Markdown of the fixture board holds no link or image the board did not have and no heading but its own', () => {
  const { board, held } = fx.hostileBoardReport(model);
  const md = exporter.boardToMarkdown(board);
  const html = marked.parse(md, { gfm: true, async: false });
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  assert.equal(doc.querySelectorAll(FORBIDDEN).length, 0);
  assert.deepEqual([...new Set([...doc.body.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()))].filter((tag) => !MARKDOWN_TAGS.has(tag)), [], 'no element the outline does not need');
  doc.querySelectorAll('*').forEach((el) => { for (const attr of el.attributes) assert.ok(!/^on/i.test(attr.name), `${el.tagName} ${attr.name}`); });
  assert.equal(doc.querySelectorAll('img').length, 0, 'a picture card is a line of text');
  // Links: a link card's address as a link, or a web address a person wrote out, shown as itself. Nothing else.
  const plain = (url) => { const href = new URL(url).href; try { return decodeURIComponent(href); } catch (_error) { return href; } };
  const linkCards = new Set(Object.values(board.cards).filter((card) => card.kind === 'link').map((card) => plain(card.data.url)));
  // The destinations are read as CommonMark reads them (the repository's marked leaves an entity in an address undecoded in its
  // own HTML, so its HTML cannot tell an address that says `&lt;` from one that says `<`).
  const links = collectLinks(marked.lexer(md));
  assert.ok(links.length >= 1 && doc.querySelectorAll('a').length <= links.length, 'the HTML has no link the text does not'); // marked draws none for an address it cannot encode (a lone half of a pair)
  links.forEach((link) => {
    const href = destinationOf(link);
    assert.match(href, /^https?:\/\//i, `a link to ${href}`);
    const written = link.text === href || `http://${link.text}` === href;
    assert.ok(linkCards.has(plain(href)) || written, `a link that is neither a link card nor the address as written: ${link.text.slice(0, 50)} -> ${href.slice(0, 50)}`);
  });
  // Headings: the board's name, each group's title, and Connections; each one's text is the string as it was.
  const heads = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => [el.tagName.toLowerCase(), el.textContent]);
  const lead = (text) => text.replace(/^\s+/, '');
  const groupTitles = Object.values(board.groups).sort((a, b) => Number(a.alias.slice(1)) - Number(b.alias.slice(1)) || (a.y - b.y) || (a.x - b.x)).map((group) => lead(group.title).trim());
  assert.deepEqual(heads.map(([tag]) => tag), ['h1'].concat(groupTitles.map(() => 'h2'), ['h2']));
  assert.equal(heads[0][1].trim(), lead(board.name).trim());
  assert.deepEqual(heads.slice(1, -1).map(([, text]) => text.trim()), groupTitles);
  assert.equal(heads[heads.length - 1][1], 'Connections');
  // Every fixture a card holds is still readable in the text (escaped, not removed).
  const text = doc.body.textContent;
  held.filter((entry) => ['note.text', 'chat.title', 'link.title'].includes(entry.field) && !/[\r\n]/.test(entry.value) && entry.value.length < 55 && entry.value.trim() === entry.value && entry.value.length > 5)
    .forEach((entry) => assert.ok(text.includes(entry.value), `${entry.field} ${entry.name} reads as it was`));
});

test('the Markdown of one fixture at a time: one list item, no block or inline markup the fixture could start', () => {
  for (const { name, value } of fx.HOSTILE) {
    const parts = value.split(/\r\n|\r|\n/);
    const made = clone(boardWith(['x', 'y', 'z']));
    Object.values(made.cards).forEach((card) => {
      if (card.kind === 'note') card.data.text = parts.join('\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ');
      if (card.kind === 'chat') card.data.excerpt = parts.join('\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ');
    });
    const doc = new JSDOM(`<!doctype html><body>${marked.parse(exporter.boardToMarkdown(made), { gfm: true, async: false })}</body>`).window.document;
    const tags = [...new Set([...doc.body.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()))].filter((tag) => !MARKDOWN_TAGS.has(tag));
    assert.deepEqual(tags, [], `${name}: ${tags}`);
    // The board's own items: a note, a link, a chat in the group's list or outside it; the connection list holds one item.
    const items = doc.querySelectorAll('li').length;
    assert.ok(items >= 3 && items <= 4, `${name}: ${items} list items`);
    assert.equal(doc.querySelectorAll('h1, h2, h3, h4, h5, h6').length, 3, `${name}: its own three headings`);
    assert.equal(doc.querySelectorAll('pre, blockquote, table, hr, img, script, iframe').length, 0, name);
  }
});

test('the Excalidraw text is JSON whose only board strings are in text and originalText', () => {
  const { board, held } = fx.hostileBoardReport(model);
  const raw = exporter.boardToExcalidraw(board);
  const file = JSON.parse(raw);
  assert.equal(file.type, 'excalidraw');
  assert.ok(Object.keys(file).every((key) => ['type', 'version', 'elements', 'appState', 'files'].includes(key)));
  const needles = held.map((entry) => entry.value).filter((value) => value.length >= 6 && value.trim().length >= 6);
  const keys = new Set();
  const leaks = [];
  const walk = (value, key, owner) => {
    if (typeof value === 'string') { if (!['text', 'originalText'].includes(key) && needles.some((needle) => value.includes(needle))) leaks.push(`${owner}.${key}`); return; }
    if (Array.isArray(value)) { value.forEach((item) => walk(item, key, owner)); return; }
    if (value && typeof value === 'object') Object.keys(value).forEach((k) => { keys.add(k); walk(value[k], k, owner || key); });
  };
  walk(file, '', '');
  assert.deepEqual(leaks, [], 'a board string outside text and originalText');
  assert.deepEqual([...keys].filter((key) => key === '__proto__' || key === 'constructor' || key === 'prototype'), []);
  const originals = new Set(file.elements.filter((el) => el.type === 'text').map((el) => el.originalText));
  held.filter((entry) => ['note.text', 'group.title', 'connector.label'].includes(entry.field)).forEach((entry) => assert.ok(originals.has(entry.value), `${entry.field} ${entry.name} is a text element`));
  file.elements.forEach((el) => { assert.match(el.id, /^(group|card|arrow)-[0-9a-f-]{36}(-text)?$/); assert.equal(el.link, null); });
});

test('the PNG is drawn from the SVG as one encoded data address, and a saved file name is one plain name', async () => {
  const { board } = fx.hostileBoardReport(model);
  const svg = exporter.boardToSvg(board, {});
  let given = '';
  const done = await exporter.svgToPngBase64(svg, { timeoutMs: 20, createImage: () => ({ set src(value) { given = value; } }), createCanvas: () => ({}) });
  assert.deepEqual(done, { ok: false, reason: 'failed' }, 'the stand-in image never loads');
  assert.ok(given.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.equal(decodeURIComponent(given.slice('data:image/svg+xml;charset=utf-8,'.length)), svg);
  assert.doesNotMatch(given, /[<>"'\s]/, 'nothing of the drawing is left unencoded');
  // The name the Save dialog is offered, for every board name a fixture can make, in every format.
  const names = fx.hostileBoardReport(model).report['board.create'].accepted.map((name) => fx.byName(name)).concat(['CON', 'a/b', 'a\\b', '..', ' . ', 'x'.repeat(200)]);
  const payloads = [];
  const source = { get: async ({ boardId }) => ({ ok: true, board: boards.get(boardId) }) };
  const boards = new Map();
  names.forEach((name, i) => { const id = `board_${uid(3000 + i)}`; boards.set(id, Object.assign(clone(board), { id, name })); });
  const shell = { saveFile: async (payload) => { payloads.push(payload); return { canceled: true }; } };
  const actions = exporter.createBoardTransferActions({ windowRef: { jennyShell: { dialog: shell } }, source, notify: () => {} });
  for (const id of boards.keys()) { await actions.exportAs('markdown', id); await actions.exportAs('excalidraw', id); }
  assert.equal(payloads.length, names.length * 2);
  payloads.forEach((payload) => {
    const base = payload.defaultName;
    assert.doesNotMatch(base, /[\u0000-\u001f<>:"/\\|?*]/, `a separator or reserved character in ${JSON.stringify(base).slice(0, 60)}`);
    assert.equal(nodePath.win32.basename(base), base);
    assert.equal(nodePath.posix.basename(base), base);
    assert.ok(!/^\.+$|^\.+\./.test(base) || /^\.\w+$/.test(base) === false, `${base} is not a dot name`);
    assert.match(base, /\.(md|excalidraw)$/);
    assert.equal(typeof payload.content, 'string');
  });
});
