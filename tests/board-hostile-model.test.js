'use strict';

// new-test-file: a new surface (row 150 hardening, slice P5-B): the hostile-content fixtures of
// tests/helpers/board-hostile-fixtures.js against the board model and the main-process modules that read board text
// (board-text, board-turn-context, board-proposal-reader, board-files, board-package, board-pin). The page side is
// tests/renderer-board-hostile.test.js. Every fixture is inert text: it is stored, parsed or compared, never run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../services/boards/board-model');
const { parseBoardText, TEXT_BUDGET } = require('../services/boards/board-text');
const { BOARD_INSTRUCTIONS, BOARD_NOW_LABEL, buildBoardContextBlock } = require('../services/boards/board-turn-context');
const { readProposal, filePaths } = require('../services/boards/board-proposal-reader');
const { createBoardFiles } = require('../services/boards/board-files');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const { createBoardAssetStore } = require('../services/boards/board-assets');
const { createBoardPins } = require('../services/boards/board-pin');
const { pack, unpack } = require('../services/boards/board-package');
const { createLinkTitleFetcher, extractTitle } = require('../services/boards/board-link-title');
const fx = require('./helpers/board-hostile-fixtures');

const { HOSTILE, FIELDS, NOW, BOARD_ID, uid } = fx;
const SERVICES = { createBoardService, createBoardStore, createBoardFiles };
const noPollution = () => { assert.equal(({}).polluted, undefined); assert.equal(Object.prototype.polluted, undefined); };
const batchOf = (ops, id = 'b1') => ({ batch_id: id, board_id: BOARD_ID, actor: 'owner', ops });
const clone = (value) => JSON.parse(JSON.stringify(value));
const FILE_REASONS = new Set(['invalid', 'no_root', 'outside', 'link', 'not_found', 'not_file']);

/** A board with one of everything the text fields can be set on. */
function kindsBoard() {
  const ops = [
    { op: 'group.add', group: { id: uid(1), title: 'G', x: 0, y: 0, w: 900, h: 300 } },
    { op: 'card.add', card: { id: uid(2), kind: 'note', data: { text: 'n' }, x: 10, y: 50, group_id: uid(1) } },
    { op: 'card.add', card: { id: uid(3), kind: 'note', data: { text: 'm' }, x: 10, y: 150 } },
    { op: 'card.add', card: { id: uid(4), kind: 'link', data: { url: 'http://example.invalid/', title: 't' }, x: 300, y: 50 } },
    { op: 'card.add', card: { id: uid(5), kind: 'file', data: { path: 'src/a.js', title: 't' }, x: 300, y: 150 } },
    { op: 'card.add', card: { id: uid(6), kind: 'image', data: { asset: fx.SHA, width: 4, height: 4, alt: 'a' }, x: 600, y: 50 } },
    { op: 'card.add', card: { id: uid(7), kind: 'chat', data: { session_id: 's1', message_id: 'm1', title: 't', excerpt: 'e' }, x: 600, y: 150 } },
    { op: 'card.add', card: { id: uid(8), kind: 'diagram', data: { scene: 'a -> b', title: 't' }, x: 900, y: 50 } },
    { op: 'connector.add', connector: { id: uid(9), from: uid(2), to: uid(3), label: 'l' } },
  ];
  const made = model.applyBatch(fx.scratchBoard(model), batchOf(ops, 'kinds'), { now: NOW, authority: true });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.board;
}

/** [path of keys] for every string a person or a file could change in a stored board. */
function slots(board) {
  const out = [['name'], ['project_id'], ['id']];
  Object.keys(board.groups).forEach((id) => out.push(['groups', id, 'title'], ['groups', id, 'alias'], ['groups', id, 'tone']));
  Object.keys(board.connectors).forEach((id) => out.push(['connectors', id, 'label'], ['connectors', id, 'style'], ['connectors', id, 'tone']));
  Object.keys(board.cards).forEach((id) => {
    ['alias', 'kind', 'created_by', 'updated_by', 'created_at'].forEach((key) => out.push(['cards', id, key]));
    Object.keys(board.cards[id].data).filter((key) => typeof board.cards[id].data[key] === 'string').forEach((key) => out.push(['cards', id, 'data', key]));
  });
  return out;
}
const setAt = (doc, keys, value) => { keys.slice(0, -1).reduce((node, key) => node[key], doc)[keys[keys.length - 1]] = value; };
const getAt = (doc, keys) => keys.reduce((node, key) => node[key], doc);

test('the fixtures are a frozen list of at least 30, and the board built from them is a valid document', () => {
  const { board, held, report } = fx.hostileBoardReport(model);
  assert.ok(HOSTILE.length >= 30 && Object.isFrozen(HOSTILE) && HOSTILE.every((entry) => Object.isFrozen(entry)));
  assert.equal(new Set(HOSTILE.map((entry) => entry.name)).size, HOSTILE.length);
  assert.equal(model.normalizeBoard(board).ok, true);
  const stored = new Set(fx.stringsOf(board));
  held.forEach((entry) => assert.ok(stored.has(entry.value), `${entry.field} ${entry.name} is on the board`));
  for (const kind of ['note', 'link', 'file', 'image', 'chat', 'diagram']) assert.ok(Object.values(board.cards).some((card) => card.kind === kind), kind);
  assert.ok(Object.keys(board.groups).length > 5 && Object.keys(board.connectors).length > 5);
  // The refusals are the model's: no field takes a NUL, a CR, a U+2028, a U+0085 or 100,000 characters; a line break is for text fields only.
  Object.keys(report).forEach((field) => ['nul_name', 'crlf_fake_header', 'line_separator', 'next_line', 'long_100k'].forEach((name) => {
    assert.ok(report[field].refused[name], `${field} refuses ${name}`);
  }));
  Object.keys(report).forEach((field) => assert.equal(Boolean(report[field].accepted.includes('lf_fake_header')),
    ['note.text', 'chat.excerpt', 'diagram.scene'].includes(field), `${field} and a line break`));
  // A link address takes only a web address: the one fixture that is one is the only one kept.
  assert.deepEqual(report['link.url'].accepted, ['bare_http_url']);
  ['js_scheme', 'js_scheme_mixed_leading_space', 'data_html', 'vbscript', 'file_url'].forEach((name) => assert.equal(report['link.url'].refused[name], 'invalid:data.url'));
});

test('every fixture offered to every field is refused with nothing changed, or kept as the same text, never a throw', () => {
  const scratch = fx.scratchBoard(model);
  const snapshot = JSON.stringify(scratch);
  const before = new Set(fx.stringsOf(scratch));
  for (const field of Object.keys(FIELDS)) {
    for (const { name, value } of HOSTILE) {
      for (const authority of [true, false]) {
        let res;
        assert.doesNotThrow(() => { res = model.applyBatch(scratch, batchOf(FIELDS[field](value)), { now: NOW, authority }); }, `${field} ${name}`);
        if (res.ok) assert.ok(fx.stringsOf(res.board).filter((s) => !before.has(s)).some((s) => s.includes(value)), `${field} ${name} is kept as it came`);
        else assert.deepEqual([typeof res.reason, res.board], ['string', undefined], `${field} ${name}`);
        assert.equal(JSON.stringify(scratch), snapshot, 'the input is never changed');
      }
    }
  }
});

test('a stored document with a fixture in any text slot is refused or read back with that exact text', () => {
  const board = kindsBoard();
  const snapshot = JSON.stringify(board);
  for (const slot of slots(board)) {
    for (const { name, value } of HOSTILE) {
      const doc = clone(board);
      setAt(doc, slot, value);
      let read;
      assert.doesNotThrow(() => { read = model.normalizeBoard(doc); }, `${slot.join('.')} ${name}`);
      if (read.ok) assert.equal(getAt(read.board, slot), value, `${slot.join('.')} ${name} comes back as it was`);
      else assert.equal(typeof read.reason, 'string');
    }
  }
  assert.equal(JSON.stringify(board), snapshot);
  for (const bad of [undefined, null, 0, 'x', [], () => {}, { schema_version: 1 }, Symbol('s')]) {
    assert.doesNotThrow(() => { model.normalizeBoard(bad); model.applyBatch(bad, bad, bad); model.applyBatch(board, bad, bad); model.applyInverse(bad, bad, bad); model.boardToText(bad); });
  }
});

test('__proto__, constructor and prototype never reach Object.prototype and never become an item', () => {
  const board = kindsBoard();
  const ids = Object.keys(board.cards).concat(Object.keys(board.groups), Object.keys(board.connectors)).sort();
  const run = (ops, context = { now: NOW, authority: true }) => { const res = model.applyBatch(board, batchOf(ops, 'p'), context); noPollution(); return res; };
  const own = (json) => JSON.parse(json);
  const card = (extra) => Object.assign({ id: uid(50), kind: 'note', data: { text: 'x' } }, extra);
  const refused = [
    ['an own __proto__ key on the card', { op: 'card.add', card: own('{"id":"' + uid(50) + '","kind":"note","data":{"text":"x"},"__proto__":{"polluted":1}}') }],
    ['an own __proto__ key in data', { op: 'card.add', card: card({ data: own('{"text":"x","__proto__":{"polluted":1}}') }) }],
    ['an own constructor key in data', { op: 'card.add', card: card({ data: own('{"text":"x","constructor":{"prototype":{"polluted":1}}}') }) }],
    ['an own __proto__ key on the op', own('{"op":"card.add","card":{"id":"' + uid(50) + '","kind":"note","data":{"text":"x"}},"__proto__":{"polluted":1}}')],
    ['an id that is a key', { op: 'card.add', card: card({ id: '__proto__' }) }],
    ['a group_id that is a key', { op: 'card.add', card: card({ group_id: 'constructor' }) }],
    ['a kind that is a key', { op: 'card.add', card: card({ kind: '__proto__' }) }],
    ['an op that is a key', { op: '__proto__' }], ['an op that is constructor', { op: 'constructor' }], ['an op that is toString', { op: 'toString' }],
    ['a connector end that is a key', { op: 'connector.add', connector: { id: uid(51), from: 'prototype', to: ids[0] } }],
    ['an edit target that is a key', { op: 'card.edit', id: '__proto__', content_rev: 0, data: { text: 'x' } }],
    ['an edit whose data is a __proto__ key', { op: 'card.edit', id: uid(2), content_rev: 0, data: own('{"__proto__":{"polluted":1}}') }],
    ['a group that holds an own __proto__ key', { op: 'group.add', group: own('{"id":"' + uid(52) + '","title":"g","__proto__":{"polluted":1}}') }],
  ];
  refused.forEach(([label, op]) => {
    for (const context of [{ now: NOW, authority: true }, { now: NOW, authority: false }]) {
      const res = run([op], context);
      assert.equal(res.ok, false, label);
      assert.equal(res.board, undefined, label);
    }
  });
  // An alias that is a key: refused for a person's batch, ignored (a fresh alias is given) for the authority.
  assert.equal(run([{ op: 'card.add', card: card({ alias: '__proto__' }) }], { now: NOW, authority: false }).ok, false);
  const aliased = run([{ op: 'card.add', card: card({ alias: 'constructor' }) }]);
  assert.equal(aliased.ok, true);
  assert.match(aliased.board.cards[uid(50)].alias, /^n[1-9][0-9]*$/);
  // The words are only text where text is allowed, and they add no item.
  const texts = run(['__proto__', 'constructor', 'prototype'].map((word, i) => ({ op: 'card.add', card: card({ id: uid(60 + i), data: { text: word } }) })));
  assert.equal(texts.ok, true);
  assert.equal(Object.keys(texts.board.cards).length, Object.keys(board.cards).length + 3);
  assert.deepEqual(Object.keys(texts.board.cards).filter((key) => !/^[0-9a-f-]{36}$/.test(key)), []);
  // A stored document that names them.
  const docs = [
    ['a __proto__ cards key', (d) => { d.cards = own('{"__proto__":' + JSON.stringify(d.cards[uid(2)]) + '}'); }],
    ['a __proto__ groups key', (d) => { d.groups = own('{"__proto__":' + JSON.stringify(d.groups[uid(1)]) + '}'); }],
    ['a __proto__ key on the document', (d) => { Object.assign(d, own('{"__proto__":{"polluted":1}}')); Object.defineProperty(d, '__proto__', { value: { polluted: 1 }, enumerable: true }); }],
    ['a __proto__ key on a card', (d) => { Object.defineProperty(d.cards[uid(2)], '__proto__', { value: { polluted: 1 }, enumerable: true }); }],
    ['a __proto__ key in data', (d) => { Object.defineProperty(d.cards[uid(2)].data, '__proto__', { value: { polluted: 1 }, enumerable: true }); }],
    ['a __proto__ recent batch', (d) => { d.recent_batches = ['__proto__']; }],
  ];
  docs.forEach(([label, change]) => {
    const doc = clone(board);
    change(doc);
    const read = model.normalizeBoard(doc);
    noPollution();
    assert.equal(read.ok, false, label);
  });
  const constructorBatch = model.normalizeBoard(Object.assign(clone(board), { recent_batches: ['constructor', 'prototype'] }));
  assert.equal(constructorBatch.ok, true, 'a token that is also a property name is only a name');
  noPollution();
});

test('a link card holds only an http or https address; every other scheme in the fixtures is refused', () => {
  const board = kindsBoard();
  const asked = HOSTILE.flatMap(({ value }) => [value, `http://example.invalid/${value}`, `${value} http://example.invalid/`])
    .concat(['HtTpS://x.y/', 'http:/x', 'http:x', 'hxxp://x', ' http://x', 'http://', 'http://\u202e', 'https://x y', 'ftp://x/', 'ws://x/', 'blob:http://x/', 'about:blank', '//x/y', 'http://x/\u0000', 'javascript://x/%0aalert(1)', 'http://[x']);
  let kept = 0;
  for (const url of asked) {
    const added = model.applyBatch(board, batchOf([{ op: 'card.add', card: { id: uid(70), kind: 'link', data: { url, title: '' } } }]), { now: NOW, authority: true });
    const edited = model.applyBatch(board, batchOf([{ op: 'card.edit', id: uid(4), content_rev: 0, data: { url } }]), { now: NOW });
    const doc = clone(board);
    doc.cards[uid(4)].data.url = url;
    for (const read of [added, edited, model.normalizeBoard(doc)]) {
      if (!read.ok) continue;
      kept += 1;
      const stored = Object.values(read.board.cards).filter((c) => c.kind === 'link').map((c) => c.data.url);
      assert.ok(stored.every((entry) => /^https?:\/\//i.test(entry)), `${JSON.stringify(url).slice(0, 80)} is kept as a web address`);
      stored.forEach((entry) => { try { assert.ok(['http:', 'https:'].includes(new URL(entry).protocol)); } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; } });
    }
  }
  assert.ok(kept > 20, 'the control case: web addresses are kept');
  for (const name of ['js_scheme', 'js_scheme_mixed_leading_space', 'data_html', 'vbscript', 'file_url', 'unc_path', 'md_link', 'md_image']) {
    assert.equal(model.applyBatch(board, batchOf([{ op: 'card.add', card: { id: uid(71), kind: 'link', data: { url: fx.byName(name), title: '' } } }]), { now: NOW, authority: true }).ok, false, name);
  }
});

test('a file card path is checked on real paths: nothing outside the project folder is read, statted or opened', async (t) => {
  const env = fx.tempProject(t);
  const { service, files } = fx.projectServices(env, SERVICES);
  const board = (await service.create({ projectId: 'project_alpha', name: 'Files' })).board;
  const extra = [env.sentinel, path.join(env.root, '..', 'outside', 'secret.txt'), 'into-outside/secret.txt', 'src/../../outside/secret.txt', 'src//app.js', 'src/../src/app.js',
    'src/app.js:stream', 'src/app.js.', 'src/app.js ', 'CON', 'src/NUL.txt', 'C:\\Windows\\win.ini', '\\\\?\\C:\\Windows\\win.ini', '/etc/passwd', `file:///${env.sentinel}`, `${env.sentinel}\u0000.js`];
  const asked = HOSTILE.map((entry) => entry.value).concat(extra, ['src/app.js']);
  const accepted = [];
  const there = new Set();
  const spy = fx.watchFs(env.root, env.base, [env.userDataPath]);
  try {
    for (const value of asked) {
      const answer = await files.resolveFile({ boardId: board.id, path: value });
      if (answer.ok) { accepted.push(answer.path); there.add(value); }
      else assert.ok(FILE_REASONS.has(answer.reason), `${JSON.stringify(value).slice(0, 60)}: ${answer.reason}`);
      assert.equal(JSON.stringify(answer).toLowerCase().includes(env.base.toLowerCase().replace(/\\/g, '\\\\')), false, 'no absolute path comes back');
    }
    // The same strings as stored cards (the model takes some of them as a path), opened and counted from the board.
    const cardOps = asked.map((value, i) => ({ op: 'card.add', card: { id: uid(300 + i), kind: 'file', data: { path: value, title: '' }, x: i * 5, y: 0 } }));
    const stored = [];
    for (const op of cardOps) {
      const applied = await service.apply({ boardId: board.id, batch: { batch_id: `f-${op.card.id}`, board_id: board.id, ops: [op] } });
      if (applied.ok) stored.push(op.card);
    }
    assert.ok(stored.length > 20 && stored.length < asked.length, 'the model takes some of these as a path and refuses others');
    const status = await files.fileStatus({ boardId: board.id });
    assert.equal(status.ok, true);
    assert.equal(status.missing.length, stored.filter((card) => !there.has(card.data.path)).length, 'a card is missing exactly when its path did not resolve');
    for (const card of stored) {
      const opened = await files.openFile({ boardId: board.id, cardId: card.id });
      if (opened.ok) accepted.push(opened.relativePath); else assert.ok(FILE_REASONS.has(opened.reason), `${card.data.path}: ${opened.reason}`);
    }
  } finally {
    spy.stop();
  }
  assert.ok(spy.touched.length > 20, 'the watch saw the file check work');
  assert.deepEqual(spy.denied, [], 'nothing outside the project folder was looked at');
  assert.equal(spy.touched.includes(env.sentinel.toLowerCase()), false);
  assert.ok(accepted.length >= 3 && accepted.every((rel) => /^(src\/app\.js|SRC\/APP\.JS)$/i.test(rel)), `kept paths are inside: ${accepted}`);
  accepted.forEach((rel) => assert.ok(fs.realpathSync.native(path.join(env.root, rel)).toLowerCase().startsWith(env.root.toLowerCase() + path.sep)));
  assert.equal(fs.readFileSync(env.sentinel, 'utf8'), 'secret\n');
});

/** The statements of a board's text, in kinds, and whether any is an error. */
function kindsOf(text) {
  const { statements } = parseBoardText(text);
  const count = {};
  statements.forEach((s) => { count[s.kind] = (count[s.kind] || 0) + 1; });
  return { statements, count };
}
const GRAMMAR_LINE = /^(board|group|note|file|link|image|chat|diagram|selected) |^[a-z][a-z0-9_-]* (->|-->|<->) [a-z][a-z0-9_-]*|^ {2}\| |^\.\.\.\(\+[\d,]+ cards? not shown\)$/;

test('boardToText: each card is one statement; a fixture can not start a line, close the fence or add a statement', () => {
  const { board } = fx.hostileBoardReport(model);
  // One fixture at a time in every field, on a board that holds one of everything, with every card sent whole.
  for (const { name, value } of HOSTILE) {
    let doc = clone(kindsBoard());
    [['name'], ['groups', uid(1), 'title'], ['connectors', uid(9), 'label'], ['cards', uid(2), 'data', 'text'], ['cards', uid(4), 'data', 'title'], ['cards', uid(5), 'data', 'path'],
      ['cards', uid(5), 'data', 'title'], ['cards', uid(6), 'data', 'alt'], ['cards', uid(7), 'data', 'title'], ['cards', uid(7), 'data', 'excerpt'], ['cards', uid(8), 'data', 'title'],
      ['cards', uid(8), 'data', 'scene'], ['cards', uid(3), 'data', 'text']].forEach((keys) => {
      const trial = clone(doc);
      setAt(trial, keys, value);
      if (model.normalizeBoard(trial).ok) doc = trial; // a slot that refuses the fixture keeps what it had
    });
    assert.equal(model.normalizeBoard(doc).ok, true, name);
    const rendered = model.boardToText(doc, { budget: TEXT_BUDGET.max, selected: Object.keys(doc.cards) });
    const { statements, count } = kindsOf(rendered.text);
    assert.deepEqual(statements.filter((s) => s.kind === 'error'), [], `${name}: no line of the text is an error`);
    assert.deepEqual(count, { board: 1, group: 1, note: 4, link: 1, file: 1, image: 1, chat: 1, diagram: 1, connect: 1, selected: 1 }, name);
    assert.equal(rendered.omitted.length, 0);
  }
  // The whole fixture board, at the default budget and sent whole: every line is grammar or a continuation, and the counts agree.
  const cardIds = Object.keys(board.cards);
  for (const options of [{}, { budget: TEXT_BUDGET.max }, { selected: cardIds.slice(0, 40) }, { selected: cardIds, budget: TEXT_BUDGET.min }]) {
    const rendered = model.boardToText(board, options);
    const { statements, count } = kindsOf(rendered.text);
    assert.deepEqual(statements.filter((s) => s.kind === 'error'), []);
    rendered.text.split('\n').forEach((line) => assert.ok(GRAMMAR_LINE.test(line), `a line that is neither grammar nor a continuation: ${JSON.stringify(line.slice(0, 60))}`));
    const cardStatements = statements.filter((s) => model.CARD_KINDS.includes(s.kind));
    assert.equal(cardStatements.length, cardIds.length - rendered.omitted.length, JSON.stringify(options));
    assert.equal(count.group, Object.keys(board.groups).length);
    assert.equal(count.board, 1);
    assert.equal(count.omitted || 0, rendered.omitted.length ? 1 : 0);
    assert.ok((count.connect || 0) <= Object.keys(board.connectors).length);
    const shownAliases = new Set(cardStatements.map((s) => s.alias));
    assert.equal(shownAliases.size, cardStatements.length, 'no card is written twice');
    const limit = options.selected ? TEXT_BUDGET.max : Math.max(options.budget || TEXT_BUDGET.default, TEXT_BUDGET.min);
    assert.ok(rendered.text.length <= limit, `${JSON.stringify(Object.keys(options))}: ${rendered.text.length} characters, budget ${limit}`);
  }
});

test('boardToText keeps its budget when every group has the longest title the model takes', () => {
  const ops = [];
  for (let i = 1; i <= 50; i += 1) ops.push({ op: 'group.add', group: { id: uid(i), title: 'G'.repeat(200), x: i * 10, y: 0, w: 100, h: 100 } });
  ops.push({ op: 'card.add', card: { id: uid(90), kind: 'note', data: { text: 'one note' }, x: 0, y: 500 } });
  const made = model.applyBatch(fx.scratchBoard(model), batchOf(ops, 'wide'), { now: NOW, authority: true });
  assert.equal(made.ok, true);
  for (const budget of [TEXT_BUDGET.min, TEXT_BUDGET.default, TEXT_BUDGET.max]) {
    const rendered = model.boardToText(made.board, { budget });
    assert.ok(rendered.text.length <= budget, `budget ${budget}: ${rendered.text.length} characters`);
    assert.equal(kindsOf(rendered.text).count.group, 50, 'every group is still named');
  }
});

test('the board section of a turn keeps the same property and its budget; the instructions stay as written', async () => {
  const { board } = fx.hostileBoardReport(model);
  const ids = Object.keys(board.cards);
  const logs = [];
  const service = (selected, budget) => ({ getBoardService: () => ({ get: async () => ({ ok: true, board, readOnly: false }) }), boardSelection: { get: () => selected },
    boardTextBudget: budget, _emitServiceLog: (...args) => logs.push(args) });
  for (const [selected, budget] of [[[], undefined], [[], TEXT_BUDGET.min], [ids.slice(0, 30), undefined], [ids, TEXT_BUDGET.max]]) {
    const block = await buildBoardContextBlock(service(selected, budget), { boardId: BOARD_ID, sessionId: 's1', streamId: 'x' });
    assert.equal(block.kind, 'board');
    assert.ok(block.content.startsWith(`${BOARD_INSTRUCTIONS}\n\n${BOARD_NOW_LABEL}\n`));
    assert.equal(block.content.split(BOARD_INSTRUCTIONS).length, 2, 'the instructions appear once, however the board reads');
    const section = block.content.slice(BOARD_INSTRUCTIONS.length + BOARD_NOW_LABEL.length + 3);
    const { statements } = kindsOf(section);
    assert.deepEqual(statements.filter((s) => s.kind === 'error'), []);
    section.split('\n').forEach((line) => assert.ok(GRAMMAR_LINE.test(line), JSON.stringify(line.slice(0, 60))));
    assert.equal(statements.filter((s) => model.CARD_KINDS.includes(s.kind)).length, ids.length - block.omitted.length);
    assert.ok(section.length <= (selected.length ? TEXT_BUDGET.max : budget || TEXT_BUDGET.default), `${section.length} characters`);
  }
});

test('a reply that carries a fixture in a note, a link title, a group title or a label yields one change, text unchanged or cut', async (t) => {
  const env = fx.tempProject(t);
  const { service, files } = fx.projectServices(env, SERVICES);
  const projectBoard = (await service.create({ projectId: 'project_alpha', name: 'F' })).board;
  const board = kindsBoard();
  let seq = 900;
  const read = async (lines) => {
    const body = lines.join('\n');
    const checked = new Map();
    for (const p of filePaths([body])) checked.set(p, await files.resolveFile({ boardId: projectBoard.id, path: p }));
    return readProposal({ board, bodies: [body], sketches: [], sentWhole: [], files: checked, makeId: () => uid(seq += 1) });
  };
  const same = (shown, value) => { const want = value.replace(/\r\n?/g, '\n').trim(); const got = String(shown).replace(/…$/, ''); return want.startsWith(got) || got === want; };
  for (const { name, value } of HOSTILE) {
    const parts = value.split(/\r\n|\r|\n/);
    const oneLine = parts.length === 1;
    const noteLines = [`note ${parts[0]}`].concat(parts.slice(1).map((line) => `  | ${line}`));
    const cases = [['note', noteLines, 'note', (c) => c.summary.text]];
    if (oneLine) {
      cases.push(['group', [`group ${value}`], 'group', (c) => c.summary.title], ['link title', [`link http://example.invalid/ ${value}`], 'link', (c) => c.summary.title],
        ['connector label', [`n1 -> m1 ${value}`.replace('m1', 'n2')], 'connect', (c) => c.summary.label]);
    }
    for (const [label, lines, type, shown] of cases) {
      const { changes } = await read(lines);
      assert.equal(changes.length, 1, `${name} as a ${label}: one change, none made by the fixture`);
      const [change] = changes;
      if (change.state === 'refused') { assert.ok(change.reason, `${name} ${label}: refused with a reason, no card or connection made`); assert.equal(change.ops, undefined); continue; }
      assert.equal(change.type, type, `${name} ${label}`);
      assert.ok(same(shown(change), value) || shown(change) === '' , `${name} as a ${label}: ${JSON.stringify(shown(change)).slice(0, 80)}`);
      assert.ok(String(shown(change)).length <= 401);
    }
    if (oneLine) {
      const { changes } = await read([`link ${value}`]);
      const web = /^https?:\/\/[^\s/?#]+\S*$/i.test(value.trim().split(/\s+/)[0] || '');
      assert.equal(changes.length, 1);
      assert.deepEqual([changes[0].state, changes[0].reason], web ? ['pending', ''] : ['refused', changes[0].reason], `${name} as an address`);
      if (!web) assert.ok(['bad_url', 'line_too_long'].includes(changes[0].reason), `${name}: ${changes[0].reason}`);
      // A file line: the project's file check refuses everything but a real file inside the folder.
      const spy = fx.watchFs(env.root, env.base, [env.userDataPath]);
      try {
        const asked = await read([`file ${value}`]);
        assert.equal(asked.changes.length, 1);
        assert.equal(asked.changes[0].state, 'refused', `${name} as a file`);
      } finally { spy.stop(); }
      assert.deepEqual(spy.denied, []);
    }
  }
  const control = await read(['file src/app.js']);
  assert.deepEqual([control.changes.length, control.changes[0].state, control.changes[0].summary.path], [1, 'pending', 'src/app.js']);
});

test('pack then unpack of the fixture board gives the same text back; an edited file is refused with the documented reason', () => {
  const { board } = fx.hostileBoardReport(model);
  const packed = pack({ board, assets: [], now: NOW });
  assert.equal(packed.ok, true, JSON.stringify(packed));
  let seq = 4000;
  const options = () => ({ makeId: () => uid(seq += 1), now: NOW, projectId: 'project_general', newBoardId: `board_${uid(8000)}` });
  const back = unpack(packed.text, options());
  assert.equal(back.ok, true, JSON.stringify(back));
  const text = (b) => model.boardToText(b, { budget: TEXT_BUDGET.max }).text;
  assert.equal(text(back.board), text(board));
  const data = (b) => Object.values(b.cards).map((c) => JSON.stringify([c.kind, c.alias, c.data])).sort();
  assert.deepEqual(data(back.board), data(board));
  assert.deepEqual(Object.values(back.board.groups).map((g) => g.title).sort(), Object.values(board.groups).map((g) => g.title).sort());
  assert.deepEqual(Object.values(back.board.connectors).map((c) => c.label).sort(), Object.values(board.connectors).map((c) => c.label).sort());
  const file = JSON.parse(packed.text);
  const firstId = Object.keys(file.board.cards)[0];
  const first = file.board.cards[firstId];
  const attempt = (mutate, raw) => { const edited = clone(file); mutate(edited); noPollution(); return unpack(raw ? raw(JSON.stringify(edited)) : JSON.stringify(edited), options()); };
  const withProto = (text) => text.replace('{"format"', '{"__proto__":{"polluted":1},"format"');
  assert.deepEqual([attempt(() => {}, withProto).ok, attempt(() => {}, withProto).reason], [false, 'unknown_key']);
  noPollution();
  const refusals = [
    ['an unknown top key', (f) => { f.extra = 1; }, 'unknown_key'], ['an unknown board key', (f) => { f.board.extra = 1; }, 'unknown_key'],
    ['an unknown asset key', (f) => { f.assets = [{ ext: 'png', base64: 'AAAA', extra: 1 }]; }, 'unknown_key'],
    ['an unknown card key', (f) => { f.board.cards[firstId].extra = 1; }, 'invalid'], ['an unknown data key', (f) => { f.board.cards[firstId].data.extra = 1; }, 'invalid'],
    ['an unknown group key', (f) => { f.board.groups[Object.keys(f.board.groups)[0]].extra = 1; }, 'invalid'],
    ['an unknown connector key', (f) => { f.board.connectors[Object.keys(f.board.connectors)[0]].extra = 1; }, 'invalid'],
    ['an own __proto__ card key', (f) => { Object.defineProperty(f.board.cards[firstId], '__proto__', { value: { polluted: 1 }, enumerable: true }); }, 'invalid'],
    ['a script link address', (f) => { Object.values(f.board.cards).filter((c) => c.kind === 'link').forEach((c) => { c.data.url = 'javascript:alert(1)'; }); }, 'invalid'],
    ['a path out of the folder', (f) => { Object.values(f.board.cards).filter((c) => c.kind === 'file').forEach((c) => { c.data.path = '../../x'; }); }, 'invalid'],
    ['a picture of the wrong type', (f) => { f.assets = [{ ext: '../x', base64: 'AAAA' }]; }, 'asset'], ['a picture that is not base64', (f) => { f.assets = [{ ext: 'png', base64: '<img>' }]; }, 'asset'],
  ];
  refusals.forEach(([label, mutate, reason]) => assert.deepEqual([label, attempt(mutate).ok, attempt(mutate).reason], [label, false, reason]));
  // A card that says the system wrote it: refused, or read with the owner as its author; never kept as `system`.
  const forged = attempt((f) => { Object.values(f.board.cards).forEach((c) => { c.created_by = 'system'; c.updated_by = 'system'; }); });
  assert.ok(!forged.ok || Object.values(forged.board.cards).every((c) => c.created_by === 'owner' && c.updated_by === 'owner'));
  assert.equal(first.created_by === 'owner' || Boolean(first.created_by), true);
  // Nesting: 16 levels pass the depth check (and meet the unknown key), 17 do not.
  const nested = (depth) => { let v = 1; for (let i = 0; i < depth; i += 1) v = { a: v }; return v; };
  assert.deepEqual([attempt((f) => { f.extra = nested(15); }).reason, attempt((f) => { f.extra = nested(17); }).reason], ['unknown_key', 'limit']);
  assert.equal(unpack(`{"format":"jennyboard","x":${'['.repeat(50000)}${']'.repeat(50000)}}`, options()).ok, false);
  assert.equal(unpack('{"__proto__":{"polluted":1}', options()).reason, 'not_json');
  noPollution();
});

test('pin: a fixture as a note, a chat, a diagram or a file is stored as inert text or refused, and one card at most is added', async (t) => {
  const env = fx.tempProject(t);
  const { service, files } = fx.projectServices(env, SERVICES);
  const pins = createBoardPins({ service, getFiles: () => files, getAssets: () => createBoardAssetStore({ userDataPath: env.userDataPath }) });
  const board = (await service.create({ projectId: 'project_alpha', name: 'Pins' })).board;
  const count = async () => Object.keys((await service.get({ boardId: board.id })).board.cards).length;
  // eslint-disable-next-line no-control-regex -- the point is to find control characters.
  const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  // eslint-disable-next-line no-control-regex -- the point is to find control characters.
  const noteControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;
  const spy = fx.watchFs(env.root, env.base, [env.userDataPath]);
  try {
    for (const { name, value } of HOSTILE) {
      const items = [{ kind: 'note', text: value }, { kind: 'chat', sessionId: 's1', messageId: 'm1', title: value, excerpt: value }, { kind: 'diagram', scene: `a -> b\n${value.slice(0, 200)}`, title: value }, { kind: 'file', path: value }];
      if (name === 'emoji_run') { // an odd prefix puts every cut in the middle of a pair
        items.push({ kind: 'note', text: `ab${value.repeat(14)}` }, { kind: 'chat', sessionId: 's1', messageId: 'm1', title: `a${value}`, excerpt: `a${value}` }, { kind: 'diagram', scene: 'a -> b', title: `a${value}` });
      }
      for (const item of items) {
        const before = await count();
        let answer;
        try { answer = await pins.pin({ boardId: board.id, item }); } catch (error) { assert.fail(`${name} ${item.kind} threw ${error.message}`); }
        const after = await count();
        if (!answer.ok) {
          assert.ok(typeof answer.reason === 'string' && after === before, `${name} ${item.kind}: ${JSON.stringify(answer)}`);
          if (item.kind === 'file') assert.ok(FILE_REASONS.has(answer.reason), `${name}: ${answer.reason}`);
          continue;
        }
        assert.notEqual(item.kind, 'file', `${name}: a file fixture was pinned`);
        assert.equal(after, before + 1);
        const card = (await service.get({ boardId: board.id })).board.cards[answer.cardId];
        const texts = Object.values(card.data).filter((v) => typeof v === 'string');
        const lines = Object.keys(card.data).filter((key) => typeof card.data[key] === 'string' && !(key === 'scene' || (item.kind === 'note' && key === 'text'))).map((key) => card.data[key]);
        lines.forEach((text) => assert.ok(!controls.test(text), `${name} ${item.kind}: control characters are gone`));
        if (item.kind === 'note') assert.ok(!noteControls.test(card.data.text), `${name} note: control characters are gone`);
        texts.forEach((text) => assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(text) || name === 'lone_surrogate', `${name} ${item.kind}: a pair was cut in two`));
      }
    }
    // Ids that are not tokens, keys that are not the kind's, and a board id that is not one.
    const bad = [{ boardId: board.id, item: { kind: 'chat', sessionId: '../x', messageId: 'm', title: 't', excerpt: 'e' } }, { boardId: board.id, item: { kind: 'chat', sessionId: '<img src=x onerror=alert(1)>', messageId: 'm', title: 't', excerpt: 'e' } },
      { boardId: board.id, item: { kind: 'chat', sessionId: 's', messageId: 'a b', title: 't', excerpt: 'e' } }, { boardId: board.id, item: { kind: 'chat', sessionId: 'x'.repeat(201), messageId: 'm', title: 't', excerpt: 'e' } },
      { boardId: board.id, item: { kind: '__proto__', text: 'x' } }, { boardId: board.id, item: { kind: 'constructor' } }, { boardId: board.id, item: { kind: 'note', text: 'x', extra: 1 } },
      { boardId: board.id, item: JSON.parse('{"kind":"note","text":"x","__proto__":{"polluted":1}}') }, { boardId: '../x', item: { kind: 'note', text: 'x' } }, { boardId: `${board.id}/../..`, item: { kind: 'note', text: 'x' } },
      JSON.parse('{"boardId":"' + board.id + '","item":{"kind":"note","text":"x"},"__proto__":{"polluted":1}}'), { boardId: board.id, item: { kind: 'note', text: 'x'.repeat(1024 * 1024 + 1) } }];
    const before = await count();
    for (const request of bad) assert.deepEqual(await pins.pin(request), { ok: false, reason: 'invalid' });
    assert.equal(await count(), before);
    noPollution();
  } finally { spy.stop(); }
  assert.deepEqual(spy.denied, []);
});

test('a fetched page title is one line of inert text however the page writes it; a hostile redirect is never followed', async () => {
  const page = (title) => `<!doctype html><title>${title}</title><p>x`;
  const encode = (v) => v.replace(/[<>&"'\s]/g, (c) => `&#x${c.codePointAt(0).toString(16)};`);
  const scratch = fx.scratchBoard(model);
  for (const { name, value } of HOSTILE) {
    for (const html of [page(value), page(encode(value)), page(`<b>${value}</b>`)]) {
      const title = extractTitle(html);
      // eslint-disable-next-line no-control-regex -- the point is to find control characters.
      assert.ok(title.length <= 200 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(title) && title === title.trim() && !/\s\s/.test(title), `${name}: ${JSON.stringify(title).slice(0, 60)}`);
      if (!title) continue;
      const put = model.applyBatch(scratch, batchOf([{ op: 'card.add', card: { id: uid(80), kind: 'link', data: { url: 'http://example.invalid/', title } } }]), { now: NOW, authority: true });
      assert.equal(put.ok, true, `${name}: the model takes the title it was handed`);
    }
  }
  const asked = [];
  const answer = (location) => async (url) => {
    asked.push(url);
    const headers = { get: (n) => (String(n).toLowerCase() === 'location' ? location : null) };
    return { status: asked.length === 1 ? 302 : 404, headers, body: (async function* () { /* nothing */ })() };
  };
  const fetchTitle = (location) => createLinkTitleFetcher({ fetch: answer(location), lookup: async () => [{ address: '93.184.216.34', family: 4 }] })({ url: 'https://example.com/a' });
  const elsewhere = ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'file:///C:/Windows/win.ini', 'ftp://example.com/x'];
  for (const location of HOSTILE.map((entry) => entry.value).concat(elsewhere)) {
    asked.length = 0;
    const done = await fetchTitle(location);
    assert.equal(done.ok, false, JSON.stringify(location).slice(0, 50));
    asked.forEach((url) => assert.ok(['http:', 'https:'].includes(new URL(url).protocol), `asked for ${url}`));
    assert.ok(asked.length <= 2);
    if (elsewhere.includes(location)) assert.deepEqual([asked.length, done.reason], [1, 'refused'], location);
  }
});

test('a hostile line of 20,000 characters is read in a few milliseconds, never a hang', () => {
  const lines = ['a'.repeat(19990) + '!', ' '.repeat(19990) + 'x', 'a' + '-'.repeat(19990), `a -> ${'b'.repeat(19990)}!`, `note ${'x as y '.repeat(2800)}`, `note ${'in g1 '.repeat(3300)}`,
    `note ${'a '.repeat(9990)}as`, `selected ${'n1 '.repeat(6600)}!`, `group ${'x '.repeat(9900)}as`, `note x ${'...(+1'.repeat(3300)}`, `note ${'\t'.repeat(19990)}x`, `  | ${' '.repeat(19990)}`];
  const started = process.hrtime.bigint();
  lines.forEach((line) => parseBoardText(line));
  parseBoardText(lines.join('\n'));
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1500, 'twelve long lines, read twice, took over a second and a half');
});
