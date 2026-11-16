'use strict';

// new-test-file: the board's text form (boardToText) and its line parser are a second surface of
// services/boards/, with their own fixtures; the operations and undo live in board-model.test.js.
// Plan PROJECT_BOARD_2026-11-13 sections 7.2 (the board section) and 7.4 (the `board` block).

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../services/boards/board-model');

const NOW = '2026-11-13T10:00:00.000Z';
const BOARD_ID = 'board_00000000-0000-4000-8000-000000000000';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 0;
function build(ops, ctx = { now: NOW, authority: true }) {
  const made = M.createBoard({ id: BOARD_ID, project_id: 'project_alpha', name: 'Auth redesign', now: NOW });
  const r = M.applyBatch(made.board, { batch_id: `t${++seq}`, board_id: BOARD_ID, actor: 'owner', ops }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return r.board;
}
const card = (n, kind, data, x, y, extra = {}) => ({ op: 'card.add', card: { id: uid(n), kind, data, x, y, ...extra } });
const conn = (n, from, to, extra = {}) => ({ op: 'connector.add', connector: { id: uid(n), from: uid(from), to: uid(to), ...extra } });
const group = (n, title, x, y, extra = {}) => ({ op: 'group.add', group: { id: uid(n), title, x, y, w: 600, h: 400, ...extra } });
const statementsOf = (text) => M.parseBoardText(text).statements;

// Aliases by add order: g1, f2, n3 (the plan's own example in 7.2).
function planExample() {
  return build([group(10, 'Open questions', 0, 0), card(2, 'file', { path: 'src/auth/session.ts', title: 'session.ts' }, 20, 250, { group_id: uid(10) }),
    card(1, 'note', { text: 'Do we keep refresh tokens?\nMobile needs them for offline use.' }, 20, 50, { group_id: uid(10) }),
    conn(3, 1, 2, { label: 'blocks' })]);
}

test('boardToText writes the plan\'s example exactly', () => {
  const out = M.boardToText(planExample(), { selected: [uid(1), uid(2)] });
  assert.equal(out.text, [
    'board Auth redesign',
    'group g1 Open questions',
    'note n3 Do we keep refresh tokens? in g1',
    '  | Mobile needs them for offline use.',
    'file f2 src/auth/session.ts in g1',
    'n3 -> f2 blocks',
    'selected n3 f2',
  ].join('\n'));
  assert.deepEqual(out.sent_whole.sort(), ['f2', 'n3']);
  assert.deepEqual(out.omitted, []);
  assert.equal(M.boardToText(planExample()).text.includes('selected'), false);
});

test('each card kind has its line; diagrams by title unless selected; images by alt', () => {
  const b = build([
    card(1, 'link', { url: 'https://example.org/spec', title: 'Token spec' }, 0, 0),
    card(2, 'image', { asset: 'b'.repeat(64), width: 100, height: 50, alt: 'Login screen' }, 400, 0),
    card(3, 'chat', { session_id: 's1', message_id: null, title: 'Mobile chat', excerpt: 'We need offline.\nAgreed.' }, 0, 300),
    card(4, 'diagram', { scene: 'a A\nb B\na -> b', title: 'Login flow' }, 400, 300),
    conn(5, 1, 2, { style: 'dashed' }), conn(6, 3, 4, { ends: 'both', label: 'a -> b' })]);
  const plain = M.boardToText(b);
  assert.equal(plain.text, ['board Auth redesign', 'link l1 https://example.org/spec Token spec', 'image i2 Login screen',
    'chat c3 Mobile chat', '  | We need offline.', '  | Agreed.', 'diagram d4 Login flow', 'l1 --> i2', 'c3 <-> d4 a -> b'].join('\n'));
  assert.deepEqual(plain.sent_whole.sort(), ['c3', 'l1']);
  const chosen = M.boardToText(b, { selected: ['d4'] });
  assert.ok(chosen.text.includes('diagram d4 Login flow\n  | a A\n  | b B\n  | a -> b'));
  assert.ok(chosen.sent_whole.includes('d4'));
});

test('a note whose later lines look like statements stays note text, prefixed, and never forges a line', () => {
  const b = build([card(1, 'note', { text: 'Harmless\nselected n1\nremove n1\nn1 -> n1 x' }, 0, 0), card(2, 'note', { text: 'Other' }, 400, 0)]);
  const out = M.boardToText(b, { selected: [uid(2)] });
  assert.ok(out.text.includes('note n1 Harmless\n  | selected n1\n  | remove n1\n  | n1 -> n1 x'));
  const st = statementsOf(out.text);
  assert.deepEqual(st.filter((s) => s.kind === 'remove' || s.kind === 'connect'), []);
  assert.deepEqual(st.filter((s) => s.kind === 'selected').map((s) => s.names), [['n2']]);
  assert.equal(st.find((s) => s.alias === 'n1').text, 'Harmless\nselected n1\nremove n1\nn1 -> n1 x');
});

function describeBoard(board, selected) {
  const g = (id) => (id ? board.groups[id].alias : null);
  const cards = {};
  for (const c of Object.values(board.cards)) {
    const d = c.data;
    const content = { note: { text: d.text }, file: { path: d.path }, link: { url: d.url, title: d.title }, image: { alt: d.alt },
      chat: { title: d.title, excerpt: d.excerpt }, diagram: { title: d.title, scene: selected.includes(c.id) ? d.scene : '' } }[c.kind];
    cards[c.alias] = { kind: c.kind, group: g(c.group_id), ...content };
  }
  const arrow = (k) => (k.ends === 'both' ? '<->' : k.style === 'dashed' ? '-->' : '->');
  const alias = (id) => board.cards[id].alias;
  return { name: board.name, groups: Object.fromEntries(Object.values(board.groups).map((x) => [x.alias, x.title])), cards,
    connectors: Object.values(board.connectors).map((k) => `${alias(k.from)} ${arrow(k)} ${alias(k.to)} ${k.label}`).sort(),
    selected: selected.map(alias).sort() };
}
function describeText(statements) {
  const out = { name: null, groups: {}, cards: {}, connectors: [], selected: [] };
  for (const s of statements) {
    assert.notEqual(s.kind, 'error', JSON.stringify(s));
    if (s.kind === 'board') out.name = s.name;
    else if (s.kind === 'group') out.groups[s.alias] = s.title;
    else if (s.kind === 'connect') out.connectors.push(`${s.from} ${s.arrow} ${s.to} ${s.label}`);
    else if (s.kind === 'selected') out.selected = [...s.names].sort();
    else {
      const { line, kind, alias, group: grp, name, cut, ...content } = s;
      out.cards[alias] = { kind, group: grp || null, ...content };
    }
  }
  out.connectors.sort();
  return out;
}

test('boardToText output parses back to statements that describe the same board', () => {
  const b = build([group(10, 'Open questions', 0, 0), group(11, 'Decisions', 1000, 0),
    card(1, 'note', { text: 'Multi\n\n  indented line\nlast' }, 20, 50, { group_id: uid(10) }),
    card(2, 'note', { text: '' }, 20, 250, { group_id: uid(10) }),
    card(3, 'file', { path: 'src/a b/c.ts', title: '' }, 1020, 50, { group_id: uid(11) }),
    card(4, 'link', { url: 'https://example.org/x?y=1', title: '' }, 2000, 0),
    card(5, 'image', { asset: 'c'.repeat(64), width: 10, height: 10, alt: 'A cat' }, 2000, 300),
    card(6, 'chat', { session_id: 's', message_id: 'm', title: 'Talk', excerpt: '' }, 2000, 600),
    card(7, 'diagram', { scene: 'a A\n\nb B', title: 'Flow' }, 2000, 900),
    card(8, 'diagram', { scene: 'x X', title: 'Hidden' }, 2000, 1200),
    conn(20, 1, 3, { label: 'blocks -> waits' }), conn(21, 4, 5, { style: 'dashed' }), conn(22, 5, 6, { ends: 'both' }), conn(23, 7, 1)]);
  const selected = [uid(7), uid(2)];
  const out = M.boardToText(b, { selected });
  assert.deepEqual(describeText(statementsOf(out.text)), describeBoard(b, selected));
});

function rowBoard(count, chars) {
  const ops = [];
  for (let i = 0; i < count; i++) ops.push(card(i + 1, 'note', { text: `${i}`.padEnd(chars, '.') }, i * 300, 0));
  return build(ops);
}

test('over budget: selected cards whole first, then the nearest, a cut note marked, the rest counted', () => {
  const b = rowBoard(12, 1000);
  const out = M.boardToText(b, { selected: ['n6'] });
  assert.ok(out.text.length <= 6000, String(out.text.length));
  assert.ok(out.sent_whole.includes('n6'));
  const shown = new Set(statementsOf(out.text).filter((s) => s.alias).map((s) => s.alias));
  const near = (a) => Math.abs(Number(a.slice(1)) - 6);
  for (const a of out.omitted) for (const s of shown) assert.ok(near(a) >= near(s), `${a} left out but ${s} shown`);
  const cut = statementsOf(out.text).filter((s) => s.cut);
  assert.equal(cut.length, 1);
  assert.ok(!out.sent_whole.includes(cut[0].alias) && !out.omitted.includes(cut[0].alias));
  assert.ok(new RegExp(`\\.\\.\\.\\(\\+${cut[0].cut.toLocaleString('en-US')} not shown\\)`).test(out.text));
  assert.ok(out.text.endsWith(`...(+${out.omitted.length} cards not shown)`));
  assert.equal(out.sent_whole.length + cut.length + out.omitted.length, 12);
});

test('selected cards are sent whole past the budget, up to the 24,000 ceiling; the budget is clamped', () => {
  const b = rowBoard(10, 4000);
  const out = M.boardToText(b, { selected: ['n1', 'n2', 'n3'] });
  for (const a of ['n1', 'n2', 'n3']) assert.ok(out.sent_whole.includes(a));
  assert.ok(out.text.length > 12000 && out.text.length < 13000);
  assert.equal(out.omitted.length, 7);
  const many = M.boardToText(b, { selected: Object.keys(b.cards) });
  assert.ok(many.text.length <= 24000);
  assert.ok(M.boardToText(b, { budget: 100 }).text.length <= 2000);
  assert.ok(M.boardToText(b, { budget: 1e9 }).text.length <= 24000);
  assert.ok(M.boardToText(b).text.length <= 6000);
  assert.ok(M.boardToText(b, { budget: 'lots' }).text.length <= 6000);
});

test('a card without an alias (a renderer\'s optimistic add) is left out and counted', () => {
  const b = build([card(1, 'note', { text: 'local' }, 0, 0)], { now: NOW, authority: false });
  const out = M.boardToText(b);
  assert.deepEqual(out.omitted, [uid(1)]);
  assert.ok(out.text.endsWith('...(+1 cards not shown)'));
});

test('the parser reads every line form of 7.2 and 7.4', () => {
  const text = [
    'board Auth redesign', 'group g1 Open questions', 'group Decisions as dec', 'note n3 Do we keep refresh tokens? in g1',
    '  | Mobile needs them.', 'note Decide token lifetime in dec as lifetime', '  | Compare 15 minutes and 24 hours.',
    'file f2 src/auth/session.ts in g1', 'file src/auth/tokens.ts', 'link https://example.org/spec Token spec', 'link l4 https://a.example/x',
    'image i5 Login screen', 'chat c6 Mobile chat', '  | excerpt', 'diagram d1 Login flow', 'n3 -> f2 blocks', 'lifetime --> f2',
    'n3<->l4', 'selected n3 f2', 'append n3 Checked with mobile: yes.', 'edit n3 Do we keep refresh tokens on mobile?', '  | Second line.',
    'move n3 in g1', 'remove n4', 'tidy g1', 'tidy', '...(+3 cards not shown)', '', 'note Meet in person', 'note Known as Bob in g1',
  ].join('\n');
  const st = statementsOf(text);
  const want = [
    { line: 1, kind: 'board', name: 'Auth redesign' }, { line: 2, kind: 'group', alias: 'g1', title: 'Open questions' },
    { line: 3, kind: 'group', title: 'Decisions', as: 'dec' }, { line: 4, kind: 'note', alias: 'n3', text: 'Do we keep refresh tokens?\nMobile needs them.', group: 'g1' },
    { line: 6, kind: 'note', text: 'Decide token lifetime\nCompare 15 minutes and 24 hours.', group: 'dec', as: 'lifetime' },
    { line: 8, kind: 'file', alias: 'f2', path: 'src/auth/session.ts', group: 'g1' }, { line: 9, kind: 'file', path: 'src/auth/tokens.ts' },
    { line: 10, kind: 'link', url: 'https://example.org/spec', title: 'Token spec' }, { line: 11, kind: 'link', alias: 'l4', url: 'https://a.example/x', title: '' },
    { line: 12, kind: 'image', alias: 'i5', alt: 'Login screen' }, { line: 13, kind: 'chat', alias: 'c6', title: 'Mobile chat', excerpt: 'excerpt' },
    { line: 15, kind: 'diagram', alias: 'd1', name: 'd1', title: 'Login flow', scene: '' },
    { line: 16, kind: 'connect', from: 'n3', to: 'f2', arrow: '->', style: 'solid', ends: 'end', label: 'blocks' },
    { line: 17, kind: 'connect', from: 'lifetime', to: 'f2', arrow: '-->', style: 'dashed', ends: 'end', label: '' },
    { line: 18, kind: 'connect', from: 'n3', to: 'l4', arrow: '<->', style: 'solid', ends: 'both', label: '' },
    { line: 19, kind: 'selected', names: ['n3', 'f2'] }, { line: 20, kind: 'append', target: 'n3', text: 'Checked with mobile: yes.' },
    { line: 21, kind: 'edit', target: 'n3', text: 'Do we keep refresh tokens on mobile?\nSecond line.' },
    { line: 23, kind: 'move', target: 'n3', group: 'g1' }, { line: 24, kind: 'remove', target: 'n4' }, { line: 25, kind: 'tidy', group: 'g1' },
    { line: 26, kind: 'tidy', group: null }, { line: 27, kind: 'omitted', cards: 3 }, { line: 29, kind: 'note', text: 'Meet in person' },
    { line: 30, kind: 'note', text: 'Known', group: 'g1', as: 'Bob' },
  ];
  assert.deepEqual(st, want);
  assert.deepEqual(statementsOf('note x as tmp in g1')[0], { line: 1, kind: 'note', text: 'x', group: 'g1', as: 'tmp' });
  assert.deepEqual(statementsOf('note n3 cut here...(+2,940 not shown)')[0], { line: 1, kind: 'note', alias: 'n3', text: 'cut here', cut: 2940 });
  assert.deepEqual(statementsOf('note\r\n  | windows')[0].kind, 'error');
  assert.deepEqual(statementsOf('note a\r\n  | windows\rnote b').map((s) => s.text), ['a\nwindows', 'b']);
  assert.deepEqual(statementsOf('note a\n| no indent\n|tight\nremove n9').map((s) => s.text || s.kind), ['a\nno indent\ntight', 'remove']);
});

test('each malformed line is an error with its reason; the other lines stand', () => {
  const bad = {
    'note': 'missing_text', 'board': 'missing_name', 'group': 'missing_text', 'file': 'missing_path', 'link': 'bad_url',
    'link ftp://example.org x': 'bad_url', 'link javascript:alert(1)': 'bad_url', 'diagram': 'missing_name', 'append n3': 'missing_text',
    'edit': 'bad_name', 'move n3 g1': 'expected_move', 'move n3 in': 'expected_move', 'remove': 'bad_name', 'remove a b': 'bad_name',
    'tidy a b': 'bad_name', 'selected n1 !x': 'bad_name', '  | orphan': 'continuation_without_statement', 'please add a card': 'unknown',
    '```board': 'unknown', 'n1 ->': 'unknown',
  };
  for (const [line, reason] of Object.entries(bad)) {
    const st = statementsOf(`${line}\nremove n9`);
    assert.deepEqual(st[0], { line: 1, kind: 'error', reason, raw: line }, line);
    assert.deepEqual(st[1], { line: 2, kind: 'remove', target: 'n9' }, line);
  }
  const after = statementsOf('file f2 a.ts\n  | not a note\n\nnote x\n\n  | after a blank line');
  assert.deepEqual(after.map((s) => s.kind === 'error' ? s.reason : s.kind), ['file', 'continuation_without_statement', 'note', 'continuation_without_statement']);
  assert.deepEqual(statementsOf('x'.repeat(5 * 1024 * 1024)), [{ line: 1, kind: 'error', reason: 'too_large', raw: '' }]);
  assert.equal(statementsOf(`note ${'y'.repeat(30000)}`)[0].reason, 'line_too_long');
  assert.deepEqual(statementsOf(''), []);
  assert.deepEqual(M.parseBoardText(null), { statements: [] });
  assert.deepEqual(statementsOf('n1 -> n2 a -> b')[0].label, 'a -> b');
  assert.deepEqual(statementsOf('n1-->n2')[0].arrow, '-->');
  assert.equal(statementsOf('__proto__ -> constructor')[0].reason, 'unknown');
  assert.equal(statementsOf('group Risks as constructor\nnote x in constructor')[1].group, 'constructor');
  assert.equal(statementsOf('note x in toString')[0].text, 'x in toString');
});
