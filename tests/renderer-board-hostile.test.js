'use strict';

// new-test-file: a new surface (row 150 hardening, slice P5-B): the real Board page, boards list, find box, Ctrl+K palette rows
// and the Pin menu, drawn over jsdom from a board whose every text field holds a hostile fixture
// (tests/helpers/board-hostile-fixtures.js). The export builders are tests/renderer-board-hostile-export.test.js.
// Every fixture is inert text: the test only reads what the page drew.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const boardPage = require('../renderer/features/board/board-page');
const boardPalette = require('../renderer/features/board/board-palette');
const pinMenu = require('../renderer/features/board/board-pin-menu');
const contextMenu = require('../renderer/inventory/context-menu');
const paletteRender = require('../renderer/shell/renderer-command-palette-render');
const paletteUtils = require('../renderer/shell/renderer-command-palette');
const { escapeHtml } = require('../renderer/shared/string-utils');
const fx = require('./helpers/board-hostile-fixtures');
const noteMarkup = require('../renderer/inventory/note-markup');

const { HOSTILE, NOW, uid } = fx;
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const FORBIDDEN = 'script, iframe, object, embed, link, style, meta, base';
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data'];
const SCHEME_BAD = /^(javascript:|vbscript:|data:text\/html|file:)/;
// A half of a surrogate pair on its own, leaving out the one fixture that is a lone half on purpose.
const LONE_HALF = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
const withoutLoneFixture = (text) => text.split(fx.byName('lone_surrogate')).join('');
const CANARY = 'img[src="x"], x, [onerror], [onload], [onmouseover], [onclick]';

/** The boards of a project named by every fixture a board name takes (the model's own refusals leave the rest out). */
function namedBoards() {
  const { report } = fx.hostileBoardReport(model);
  return report['board.create'].accepted.map((name, i) => {
    const made = model.createBoard({ id: `board_${uid(2000 + i)}`, project_id: 'project_general', name: fx.byName(name), now: NOW });
    assert.equal(made.ok, true);
    return made.board;
  });
}

async function bringUp(t, { seed } = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const baseline = doc.querySelectorAll(FORBIDDEN).length;
  let seq = 100;
  const boards = createMemoryBoardSource({ model, makeId: () => uid(++seq), seed });
  window.jennyShell = { boards };
  const map = new Map();
  const logs = [];
  const page = boardPage.showBoardPage({
    container: doc.getElementById('boardView'), windowRef: window, storage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); } },
    appendClientLog: (...args) => logs.push(args), getProjectSwitcher: async () => null,
  });
  t.after(() => { boardPage.hideBoardPage(); boardPalette.reset(); contextMenu.hide({ restoreFocus: false }); window.close(); });
  await page.started;
  await flush();
  return { window, doc, page, boards, baseline, logs, q: (selector) => doc.querySelector(selector),
    key: (target, init) => { const event = new window.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init)); target.dispatchEvent(event); return event; } };
}

/** Everything the contract names, asserted on a document as it stands. */
function audit(h, label) {
  const { doc } = h;
  assert.equal(doc.querySelectorAll(FORBIDDEN).length, h.baseline, `${label}: no script, frame, object, embed, link, style, meta or base element appeared`);
  assert.equal(doc.querySelector(CANARY), null, `${label}: no element a fixture's markup would make`);
  const needles = HOSTILE.map((entry) => entry.value.trim().toLowerCase()).filter((value) => value.length >= 6 && value.length < 400);
  doc.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      assert.ok(!name.startsWith('on'), `${label}: <${tag}> has ${attr.name}`);
      if (!URL_ATTRS.includes(name)) continue;
      const value = attr.value.trim().toLowerCase();
      assert.ok(!SCHEME_BAD.test(value), `${label}: <${tag} ${name}="${value.slice(0, 40)}">`);
      // The one address a fixture may give (slice B12, D21): a note's own web link, made by note-markup.js, whose href is
      // exactly what the URL parser made of a plain http(s) address with no user or password. Everything else: none.
      if (tag === 'a' && name === 'href' && el.hasAttribute('data-note-link')) {
        assert.equal(noteMarkup.safeHref(attr.value), attr.value, `${label}: a note link is a checked web address`);
        assert.equal(el.closest('[data-card-kind="note"] [data-card-text]') !== null, true, `${label}: a note link stands in a note's text`);
        assert.deepEqual(el.getAttributeNames().sort(), ['class', 'data-note-link', 'href', 'rel', 'tabindex', 'target', 'title'], `${label}: a note link has its own attributes only`);
        continue;
      }
      assert.ok(!needles.some((needle) => value.includes(needle)), `${label}: <${tag} ${name}> carries a fixture`);
    }
    if (tag === 'a') assert.match(el.getAttribute('href') || '', /^https?:\/\//i, `${label}: an anchor is a web address`);
  });
}

const textOf = (el) => el.textContent;

test('the canvas draws the fixture board: no markup, no script, no address; every string is on a card as text', async (t) => {
  const { board, held } = fx.hostileBoardReport(model);
  const h = await bringUp(t, { seed: [board] });
  assert.equal(h.page.getOpenBoardId(), board.id);
  assert.deepEqual(h.logs.filter(([level]) => level === 'WARN' || level === 'ERROR'), []);
  assert.equal(h.doc.querySelectorAll('.inv-board-card').length, Object.keys(board.cards).length + Object.keys(board.groups).length);
  audit(h, 'canvas');
  const centre = textOf(h.q('[data-board-centre]'));
  held.filter((entry) => entry.field !== 'board.name').forEach((entry) => assert.ok(centre.includes(entry.value), `${entry.field} ${entry.name} is on the canvas as text`));
  // The board's own name is a heading in the page, as text. A note is named for the screen reader by its first line: an attribute value, never markup.
  assert.ok(textOf(h.doc.body).includes(board.name));
  const firstLine = (text) => text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
  const named = Object.values(board.cards).filter((card) => card.kind === 'note' && !card.data.title && firstLine(card.data.text).length > 0 && firstLine(card.data.text).length <= 120);
  assert.ok(named.length > 30);
  named.forEach((card) => assert.equal(h.q(`[data-card-id="${card.id}"]`).getAttribute('aria-label'), firstLine(card.data.text)));
  // Cards and connectors: text nodes only. A card element holds the glyph svg and its own parts, never an element from a fixture.
  h.doc.querySelectorAll('.inv-board-card').forEach((card) => {
    // A note's text may hold what note-markup.js builds (slice B12), and only there.
    const inNote = (el) => ['strong', 'em', 'code', 'a', 'ul', 'ol', 'li'].includes(el.tagName.toLowerCase()) && el.closest('[data-card-kind="note"] [data-card-text]') !== null;
    assert.deepEqual([...card.querySelectorAll('*')].filter((el) => !inNote(el)).map((el) => el.tagName.toLowerCase()).filter((tag) => !['div', 'span', 'p', 'svg', 'path', 'button', 'img', 'circle', 'rect', 'g'].includes(tag)), []);
  });
  const connectorTexts = [...h.doc.querySelectorAll('.inv-board-connectors text')].map((el) => el.textContent);
  Object.values(board.connectors).filter((con) => con.label).forEach((con) => assert.ok(connectorTexts.includes(con.label), `connector label ${con.label.slice(0, 30)}`));
});

test('the outline, the find box and the view switch draw the same fixtures as text, and a query for each fixture adds nothing to the page', async (t) => {
  const { board, held } = fx.hostileBoardReport(model);
  const h = await bringUp(t, { seed: [board] });
  h.q('[data-board-view-switch] [data-value="outline"]').click();
  await flush();
  const outline = textOf(h.q('.board-outline'));
  // The outline shows a note by its first line and a link by its host: everything else is whole.
  held.filter((entry) => !['board.name', 'link.url', 'link.url_prefixed'].includes(entry.field)).forEach((entry) => {
    assert.ok(outline.includes(entry.value.split(/\r?\n/)[0]), `${entry.field} ${entry.name} is in the outline`);
  });
  audit(h, 'outline');
  // Find: every fixture a field holds, typed in, matches a card, and the page does not change shape.
  h.q('[data-board-view-switch] [data-value="canvas"]').click();
  await flush();
  assert.equal(h.key(h.q('[data-board-centre] .inv-board-canvas'), { key: 'f', ctrlKey: true }).defaultPrevented, true);
  const input = h.q('[data-board-find-input]');
  const count = h.q('[data-board-find-count]');
  const elements = h.doc.querySelectorAll('*').length;
  const searched = held.filter((entry) => ['note.text', 'link.title', 'file.title', 'chat.title', 'group.title', 'diagram.title', 'image.alt'].includes(entry.field) && !/[\r\n]/.test(entry.value));
  assert.ok(searched.length > 100);
  for (const entry of searched) {
    input.value = entry.value;
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.match(count.textContent, /^\d+ of \d+ cards?$/, `${entry.field} ${entry.name}: found`);
    assert.ok(h.doc.querySelectorAll('.inv-board-card:not([data-board-dim])').length >= 1, `${entry.field} ${entry.name}: a card stays lit`);
  }
  assert.equal(h.doc.querySelectorAll('*').length, elements, 'searching adds and removes no element');
  input.value = fx.byName('img_onerror');
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  audit(h, 'find');
});

test('the boards list and the Ctrl+K palette show every board name a fixture can make, as text and as attribute values', async (t) => {
  const named = namedBoards();
  assert.ok(named.length > 30 && named.length <= 41);
  const { board } = fx.hostileBoardReport(model);
  const h = await bringUp(t, { seed: [board].concat(named) });
  const rows = [...h.doc.querySelectorAll('[data-board-id]')];
  assert.equal(rows.length, named.length + 1);
  named.forEach((entry) => {
    const row = rows.find((candidate) => candidate.getAttribute('data-board-id') === entry.id);
    assert.ok(row, entry.name);
    assert.equal(row.getAttribute('data-board-name'), entry.name);
    assert.equal(row.querySelector('.session-row__title-text').textContent, entry.name);
    assert.equal(row.querySelector('[data-board-action="open"]').getAttribute('title'), entry.name);
    assert.equal(row.querySelector('[data-board-action="open"]').getAttribute('aria-label'), `Open ${entry.name}`);
    assert.equal(row.querySelector('[data-board-action="rename"]').getAttribute('aria-label'), `Rename ${entry.name}`);
    assert.equal(row.querySelector('[data-board-action="delete"]').getAttribute('title'), `Delete ${entry.name}`);
  });
  audit(h, 'boards list');
  // The palette: rows built by the real palette renderer, with and without a query that highlights part of the name.
  const doc = h.doc;
  const list = doc.createElement('div');
  doc.body.appendChild(list);
  const renderer = paletteRender.createPaletteRenderer({ listEl: list, documentRef: doc, escapeHtml, highlightRanges: paletteUtils.highlightRanges });
  for (let from = 0; from < named.length; from += 20) {
    const source = createMemoryBoardSource({ model, makeId: () => uid(9000), seed: named.slice(from, from + 20) });
    h.window.jennyShell = { boards: source };
    boardPalette.reset();
    await boardPalette.refresh({ windowRef: h.window, getProjectSwitcher: async () => null });
    const items = boardPalette.paletteItems({ navigate: () => {}, windowRef: h.window, getProjectSwitcher: async () => null });
    assert.deepEqual(items.map((item) => item.label), named.slice(from, from + 20).map((entry) => entry.name));
    for (const query of ['', 'a', 'x']) {
      const entries = items.map((item) => ({ item, match: query ? paletteUtils.scoreMatch(item.label, query) : { ranges: [] } })).filter((entry) => entry.match)
        .map((entry) => ({ item: entry.item, labelRanges: entry.match.ranges, descriptionRanges: [] }));
      renderer.render({ entries, grouped: true, query, totalCount: entries.length });
      const drawn = [...list.querySelectorAll('.command-palette-item-label')];
      assert.equal(drawn.length, entries.length);
      drawn.forEach((label, i) => {
        assert.equal(label.textContent, entries[i].item.label, 'the label is the name, as text');
        assert.deepEqual([...label.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()).filter((tag) => tag !== 'mark'), [], `${entries[i].item.label.slice(0, 30)}: only a highlight is markup`);
      });
      audit(h, `palette ${from}/${query}`);
    }
  }
});

test('the Pin menu lists a board named by any fixture as a label only, and "On board" lines too', async (t) => {
  const named = namedBoards();
  const dom = new JSDOM('<!doctype html><body><button id="anchor">Pin</button><div id="root"></div></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const baseline = doc.querySelectorAll(FORBIDDEN).length;
  t.after(() => { contextMenu.hide({ restoreFocus: false }); window.close(); });
  const refs = named.slice(0, 5).map((entry) => ({ messageId: 'm1', boardId: entry.id, boardName: entry.name, cardId: uid(1) }));
  const bridge = {
    list: async () => ({ ok: true, boards: named.map((entry) => ({ id: entry.id, name: entry.name })) }),
    chatRefs: async () => ({ ok: true, refs }), pin: async () => ({ ok: true, boardName: named[0].name, boardId: named[0].id, cardId: uid(2) }),
  };
  const toasts = [];
  const deps = { state: { features: { featureFlags: { project_boards: true } } }, windowRef: window, boards: bridge, menu: contextMenu, toast: (...args) => toasts.push(args) };
  const shown = await pinMenu.open({ anchorEl: doc.getElementById('anchor'), rootEl: doc.getElementById('root'), projectId: 'project_general', sessionId: 's1', messageId: 'm1', item: { kind: 'note', text: 'x' }, deps });
  assert.equal(shown, true);
  const labels = [...doc.querySelectorAll('.inv-context-menu .inv-context-menu-item')].map((row) => row.textContent);
  assert.deepEqual(labels, refs.map((ref) => `On board: ${ref.boardName}`).concat(named.map((entry) => entry.name)));
  doc.querySelectorAll('.inv-context-menu-item').forEach((row) => assert.deepEqual([...row.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()).filter((tag) => tag !== 'span'), [], 'a row holds no element a name could make'));
  assert.equal(doc.querySelectorAll(FORBIDDEN).length, baseline);
  assert.equal(doc.querySelector(CANARY), null);
  doc.querySelectorAll('*').forEach((el) => { for (const attr of el.attributes) assert.ok(!/^on/i.test(attr.name), `${el.tagName} ${attr.name}`); });
  // Choosing a line pins and says the name in a toast as plain text (the toast gets a string, never markup).
  [...doc.querySelectorAll('.inv-context-menu-item')].find((row) => row.textContent === named[3].name).click();
  await flush();
  assert.equal(toasts.length, 1);
  assert.equal(typeof toasts[0][0], 'string');
  assert.ok(toasts[0][0].includes(named[0].name));
});

// A cut in the middle of a pair leaves half a character: the screen reader reads a replacement mark.
test('no title or aria-label is cut in the middle of a surrogate pair', async (t) => {
  const { board } = fx.hostileBoardReport(model);
  const h = await bringUp(t, { seed: [board].concat(namedBoards()) });
  h.q('[data-board-view-switch] [data-value="outline"]').click();
  await flush();
  const found = [];
  h.doc.querySelectorAll('*').forEach((el) => {
    for (const name of ['title', 'aria-label', 'alt', 'placeholder', 'data-board-name']) {
      const value = el.getAttribute(name);
      if (value !== null && LONE_HALF.test(withoutLoneFixture(value))) found.push(`${el.tagName.toLowerCase()}.${el.className} ${name}=${JSON.stringify(value.slice(-10))}`);
    }
  });
  assert.deepEqual(found, []);
});

test('the audit itself sees what it is for: each poisoned page is refused', () => {
  const poison = [
    ['a script element', '<script>1</script>'], ['an iframe', '<iframe></iframe>'], ['a style element', '<style>x{}</style>'], ['a base element', '<base href="https://x.invalid/">'],
    ['an on attribute', '<p onclick="1">x</p>'], ['a script address, with space and case', '<a href="  JaVaScRiPt:alert(1)">x</a>'], ['a file address', '<img src="file:///C:/x">'],
    ['an html data address', '<a href="data:text/html,x">x</a>'], ['a fixture in an address', '<img src="https://x.invalid/?q=<img src=x onerror=alert(1)>">'],
    ['an element a fixture makes', '<img src=x>'], ['an anchor that is not a web address', '<a href="mailto:x@y.invalid">x</a>'],
  ];
  for (const [label, markup] of poison) {
    const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
    assert.throws(() => audit({ doc, baseline: 0 }, label), undefined, label);
  }
  assert.doesNotThrow(() => audit({ doc: new JSDOM('<!doctype html><body><a href="https://example.com/">x</a><p>&lt;img src=x onerror=alert(1)&gt;</p></body>').window.document, baseline: 0 }, 'clean'));
});
