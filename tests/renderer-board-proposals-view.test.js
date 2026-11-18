'use strict';

// new-test-file: a new surface (row 150 slice C3-R): the Board page's view of Jenny's proposals, that is the bar over the
// canvas, the review list in the Changes view and the ghosts on the canvas. The data sources are in renderer-board-source.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const { createProposalsView } = require('../renderer/features/board/board-proposals-view');
const text = require('../renderer/features/board/board-proposal-text');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardPage } = require('../renderer/features/board/board-page');
const cardKinds = require('../renderer/features/board/board-card-kinds');
const model = require('../services/boards/board-model');

const BOARD = 'board_00000000-0000-4000-8000-000000000001';
const OTHER = 'board_00000000-0000-4000-8000-000000000002';
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const HOSTILE = '<img src=x onerror=1>"><script>alert(1)</script>';

const change = (n, type, cls, summary, extra = {}) => ({ n, line: `${type} line ${n}`, type, class: cls, state: 'pending', reason: '', summary, ...extra });
function proposal(id, changes, extra = {}) {
  const counts = { total: changes.length, pending: 0, additions: 0, edits: 0, removals: 0, applied: 0, refused: 0, skipped: 0, rejected: 0 };
  for (const c of changes) {
    if (c.state === 'pending') { counts.pending += 1; counts[{ addition: 'additions', edit: 'edits', removal: 'removals' }[c.class]] += 1; } else counts[c.state] += 1;
  }
  return { id, sessionId: 's1', messageId: id, state: 'pending', open: true, createdAt: '2026-11-13T10:00:00.000Z', madeAgainstRev: 1, overflow: 0, counts, changes, preview: null, ...extra };
}
const add = (n, text) => change(n, 'note', 'addition', { text, group: '' });
const edit = (n, target, before, after) => change(n, 'edit', 'edit', { target, before, after });
const removal = (n, target, label) => change(n, 'remove', 'removal', { target, kind: 'note', label });

function harness(t, { proposals = [], withBoard = true } = {}) {
  const { window } = new JSDOM('<!doctype html><body><div class="centre"><div class="canvas"><div class="layer"></div></div></div><div id="host"></div></body>', { url: 'https://jenny.invalid/' });
  const doc = window.document;
  const centre = doc.querySelector('.centre');
  const host = doc.getElementById('host');
  const layer = doc.querySelector('.layer');
  const lists = new Map([[BOARD, proposals]]);
  const listeners = new Set();
  const editorListeners = new Set();
  const editor = {
    board: withBoard ? { id: BOARD } : null,
    getBoard() { return this.board; },
    onChange(fn) { editorListeners.add(fn); return () => editorListeners.delete(fn); },
    show(id) { this.board = id ? { id } : null; editorListeners.forEach((fn) => fn({ kind: 'board' })); },
  };
  const source = {
    listCalls: [], decideCalls: [], hold: null, decideImpl: async () => ({ ok: true }),
    async listProposals(request) {
      source.listCalls.push(request);
      const answer = { ok: true, proposals: lists.get(request.boardId) || [] };
      if (source.hold) await source.hold;
      return answer;
    },
    async decideProposal(request) { source.decideCalls.push(request); return source.decideImpl(request); },
    onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) { listeners.forEach((fn) => fn(event)); },
  };
  const notes = [];
  const revealed = [];
  const part = createProposalsView({
    document: doc, windowRef: window, editor, source, notify: (message) => notes.push(message), log: () => {}, actionButton,
    surface: { element: centre.querySelector('.canvas'), layer },
    context: { getChangesHost: () => host, revealChanges: () => { revealed.push(1); return true; } },
  });
  t.after(() => { part.dispose(); window.close(); });
  const h = {
    window, doc, host, layer, centre, lists, source, notes, revealed, editor, part,
    bar: () => centre.querySelector('[data-board-proposal-bar]'),
    barText: () => (h.bar() ? h.bar().querySelector('.board-proposal-bar__text').textContent : null),
    barButtons: () => (h.bar() ? [...h.bar().querySelectorAll('button')].map((b) => b.textContent) : []),
    act: (root, act, n) => root.querySelector(`button[data-board-act="${act}"]${n === undefined ? '' : `[data-n="${n}"]`}`),
    section: (kind) => host.querySelector(`[data-board-changes-sec="${kind}"]`),
    sections: () => [...host.querySelectorAll('[data-board-changes-sec]')].map((s) => s.querySelector('h3').textContent),
    row: (n) => host.querySelector(`[data-board-change][data-n="${n}"]`),
    ghosts: () => [...layer.querySelectorAll('[data-board-ghost]')], ghosting: () => centre.hasAttribute('data-board-ghosting'), // the empty-board hint steps aside (board-proposals.css)
    async settle() { await flush(); },
    async click(button) { button.click(); await flush(); },
  };
  return h;
}

// ------------------------------------------------------------------ the bar

test('the bar says how many changes and offers Accept additions first while additions wait', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A'), add(2, 'B'), edit(3, 'n3', 'old', 'new')])] });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposes 3 changes');
  assert.deepEqual(h.barButtons(), ['Accept additions', 'Review', 'Reject']);
  const buttons = [...h.bar().querySelectorAll('button')];
  assert.equal(buttons[0].classList.contains('btn--primary'), true);
  assert.equal(buttons[1].classList.contains('btn--primary'), false);
  assert.equal(h.bar().querySelectorAll('.btn--primary').length, 1);
  assert.deepEqual(h.source.listCalls, [{ boardId: BOARD }]);
});

test('one change reads "1 change"; only edits and removals make Review the primary button', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A')])] });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposes 1 change');
  h.lists.set(BOARD, [proposal('p2', [edit(1, 'n3', 'a', 'b'), removal(2, 'n4', 'Gone')])]);
  h.source.emit({ boardId: BOARD, projectId: 'p', kind: 'proposals', rev: 2 });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposes 2 changes that need your review');
  assert.deepEqual(h.barButtons(), ['Review', 'Reject']);
  assert.equal(h.bar().querySelector('button').classList.contains('btn--primary'), true);
  h.lists.set(BOARD, [proposal('p3', [edit(1, 'n3', 'a', 'b')])]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposes 1 change that needs your review');
});

test('only refused lines: the bar says they could not be used and offers Review and Dismiss', async (t) => {
  const refused = (n) => change(n, 'unknown', 'addition', {}, { state: 'refused', reason: 'unknown' });
  const h = harness(t, { proposals: [proposal('p1', [refused(1), refused(2)])] });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposed 2 changes that could not be used');
  assert.deepEqual(h.barButtons(), ['Review', 'Dismiss']);
  h.lists.set(BOARD, [proposal('p2', [refused(1)])]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposed 1 change that could not be used');
});

test('no open proposal: no bar, no ghost, and the Changes view says so; the newest open one shows, then the next', async (t) => {
  const h = harness(t, { proposals: [proposal('old', [add(1, 'A')], { open: false, state: 'rejected' })] });
  await h.settle();
  assert.equal(h.bar(), null);
  assert.equal(h.ghosts().length, 0);
  assert.equal(h.host.querySelector('[data-board-changes-empty]').textContent, 'Jenny has not proposed any changes to this board.');
  assert.equal(h.host.querySelector('[data-board-changes-title]').getAttribute('tabindex'), '-1');
  h.lists.set(BOARD, [proposal('new', [add(1, 'A'), add(2, 'B')]), proposal('mid', [add(1, 'C')]), proposal('old', [add(1, 'A')], { open: false })]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposes 2 changes');
  assert.equal(h.host.querySelectorAll('[data-board-change]').length, 2);
  h.lists.set(BOARD, [proposal('new', [add(1, 'A'), add(2, 'B')], { open: false, state: 'accepted' }), proposal('mid', [add(1, 'C')])]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposes 1 change', 'the next open proposal shows when the newest closes');
  h.lists.set(BOARD, []);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.bar(), null);
});

test('Review reveals the Changes view', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A')])] });
  await h.settle();
  await h.click(h.act(h.bar(), 'review'));
  assert.equal(h.revealed.length, 1);
  assert.equal(h.source.decideCalls.length, 0);
});

// ------------------------------------------------------------------ decisions

test('the bar and the rows send the documented decisions', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A'), add(2, 'B'), edit(3, 'n3', 'a', 'b'), edit(4, 'n4', 'c', 'd'), removal(5, 'n5', 'X'), removal(6, 'n6', 'Y')])] });
  await h.settle();
  await h.click(h.act(h.bar(), 'accept-additions'));
  await h.click(h.act(h.bar(), 'reject-all'));
  await h.click(h.act(h.row(3), 'accept'));
  await h.click(h.act(h.row(4), 'reject'));
  await h.click(h.act(h.row(5), 'accept'));
  await h.click(h.act(h.row(6), 'reject'));
  await h.click(h.act(h.row(2), 'reject'));
  await h.click(h.act(h.section('addition'), 'accept-additions'));
  assert.deepEqual(h.source.decideCalls, [
    { boardId: BOARD, proposalId: 'p1', action: 'accept_additions' },
    { boardId: BOARD, proposalId: 'p1', action: 'reject' },
    { boardId: BOARD, proposalId: 'p1', action: 'accept', n: 3 },
    { boardId: BOARD, proposalId: 'p1', action: 'reject', n: 4 },
    { boardId: BOARD, proposalId: 'p1', action: 'accept', n: 5 },
    { boardId: BOARD, proposalId: 'p1', action: 'reject', n: 6 },
    { boardId: BOARD, proposalId: 'p1', action: 'reject', n: 2 },
    { boardId: BOARD, proposalId: 'p1', action: 'accept_additions' },
  ]);
  assert.deepEqual(h.row(3).querySelectorAll('button').length, 2);
  assert.equal(h.act(h.row(3), 'accept').textContent, 'Accept');
  assert.equal(h.act(h.row(4), 'reject').textContent, 'Skip');
  assert.equal(h.act(h.row(5), 'accept').textContent, 'Remove');
  assert.equal(h.act(h.row(6), 'reject').textContent, 'Keep');
  assert.equal(h.act(h.row(1), 'reject').textContent, 'Reject');
});

test('Dismiss sends reject without n', async (t) => {
  const refused = change(1, 'unknown', 'addition', {}, { state: 'refused', reason: 'unknown' });
  const h = harness(t, { proposals: [proposal('p1', [refused])] });
  await h.settle();
  await h.click(h.act(h.bar(), 'dismiss'));
  assert.deepEqual(h.source.decideCalls, [{ boardId: BOARD, proposalId: 'p1', action: 'reject' }]);
});

test('every button is disabled while a decision is in flight, and a second click sends nothing', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A'), edit(2, 'n2', 'a', 'b')])] });
  await h.settle();
  let release;
  h.source.decideImpl = () => new Promise((resolve) => { release = resolve; });
  const accept = h.act(h.bar(), 'accept-additions');
  accept.click();
  await h.settle();
  const all = () => [...h.centre.querySelectorAll('button'), ...h.host.querySelectorAll('button')];
  assert.ok(all().length >= 6);
  assert.equal(all().every((button) => button.disabled), true);
  h.act(h.bar(), 'accept-additions').click();
  h.act(h.row(2), 'accept').click();
  await h.settle();
  assert.equal(h.source.decideCalls.length, 1);
  h.lists.set(BOARD, []);
  release({ ok: true, applied: 1, skipped: 0 });
  await h.settle();
  assert.equal(h.bar(), null);
});

test('a refused decision says why in one plain sentence and reloads the list', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A')])] });
  await h.settle();
  const cases = [['closed', 'That proposal is no longer open.'], ['read_only', 'This board cannot be changed.'], ['io', 'Could not apply the changes. Try again.'], ['limit', 'Could not apply the changes. Try again.']];
  for (const [reason, sentence] of cases) {
    const before = h.source.listCalls.length;
    h.source.decideImpl = async () => ({ ok: false, reason });
    await h.click(h.act(h.bar(), 'accept-additions'));
    assert.equal(h.notes.at(-1), sentence, reason);
    assert.ok(h.source.listCalls.length > before, `${reason}: the list is read again`);
    assert.equal(h.act(h.bar(), 'accept-additions').disabled, false, 'the buttons come back');
  }
  assert.equal(h.notes.length, 4);
});

test('skipped changes after Accept additions are announced once', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A'), add(2, 'B')])] });
  await h.settle();
  h.source.decideImpl = async () => ({ ok: true, applied: 1, skipped: 2 });
  await h.click(h.act(h.bar(), 'accept-additions'));
  assert.deepEqual(h.notes, ['2 changes were skipped. Review shows why.']);
  h.source.decideImpl = async () => ({ ok: true, applied: 1, skipped: 1 });
  await h.click(h.act(h.bar(), 'accept-additions'));
  assert.equal(h.notes.at(-1), '1 change was skipped. Review shows why.');
  h.source.decideImpl = async () => ({ ok: true, applied: 2, skipped: 0 });
  await h.click(h.act(h.bar(), 'accept-additions'));
  assert.equal(h.notes.length, 2, 'nothing skipped, nothing said');
});

// ------------------------------------------------------------------ the review list

test('three sections in order, each only when it has rows, with the rows shown as the count', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [removal(1, 'n9', 'Old'), edit(2, 'n3', 'a', 'b'), add(3, 'A'), add(4, 'B'), add(5, 'C')])] });
  await h.settle();
  assert.deepEqual(h.sections(), ['Additions (3)', 'Edits (1)', 'Removals (1)']);
  assert.equal(h.section('addition').querySelectorAll('[data-board-change]').length, 3);
  assert.equal(h.host.querySelector('[data-board-changes-empty]'), null);
  h.lists.set(BOARD, [proposal('p1', [removal(1, 'n9', 'Old'), edit(2, 'n3', 'a', 'b')], { })]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.deepEqual(h.sections(), ['Edits (1)', 'Removals (1)']);
  assert.equal(h.section('addition'), null);
});

test('each type reads in plain words', async (t) => {
  const rows = [
    change(1, 'note', 'addition', { text: 'Decide token lifetime', group: 'Decisions' }),
    change(2, 'connect', 'addition', { from: 'Decide token lifetime', to: 'src/auth/session.ts', label: 'reads', arrow: '->' }),
    change(3, 'append', 'addition', { target: 'n3', label: 'Ship', text: 'Checked with mobile: yes.' }),
    change(4, 'move', 'edit', { target: 'n3', label: 'Ship', group: 'Decisions' }),
    change(5, 'tidy', 'edit', { group: 'Decisions' }),
    change(6, 'tidy', 'edit', { group: '' }),
    change(7, 'diagram', 'addition', { title: 'Login flow', lines: 12 }),
    change(8, 'link', 'addition', { url: 'https://example.com/spec', title: 'Token spec', group: '' }),
    change(9, 'file', 'addition', { path: 'src/auth/tokens.ts', group: '' }),
    change(10, 'group', 'addition', { title: 'Decisions' }),
    change(11, 'redraw', 'edit', { target: 'n7', title: 'Login flow', lines: 1 }),
    change(12, 'remove', 'removal', { target: 'n3', kind: 'note', label: 'Ship on Friday' }),
    change(13, 'link', 'addition', { url: 'https://example.com/a', title: '', group: '' }),
    change(14, 'note', 'addition', { text: 'first line\nsecond line', group: '' }),
  ];
  const h = harness(t, { proposals: [proposal('p1', rows)] });
  await h.settle();
  const said = (n) => h.row(n).querySelector('.board-change__text').textContent;
  assert.equal(said(1), 'New note: "Decide token lifetime" in Decisions');
  assert.equal(said(2), 'New connection: Decide token lifetime to src/auth/session.ts (reads)');
  assert.equal(said(3), 'Add to n3: "Checked with mobile: yes."');
  assert.equal(said(4), 'Move n3 into Decisions');
  assert.equal(said(5), 'Tidy Decisions');
  assert.equal(said(6), 'Tidy the whole board');
  assert.equal(said(7), 'New diagram: Login flow (12 lines)');
  assert.equal(said(8), 'New link: Token spec');
  assert.equal(said(9), 'New file card: src/auth/tokens.ts');
  assert.equal(said(10), 'New group: Decisions');
  assert.equal(said(11), 'Redraw Login flow (1 line)');
  assert.equal(said(12), 'Remove note n3: "Ship on Friday"');
  assert.equal(said(13), 'New link: https://example.com/a');
  assert.equal(said(14), 'New note: "first line"');
});

test('an edit shows the target, the text before struck through and the text after, line breaks kept', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [edit(1, 'n3', 'Ship\non Friday', 'Ship\non Monday')])] });
  await h.settle();
  const row = h.row(1);
  assert.equal(row.querySelector('.board-change__target').textContent, 'n3');
  assert.equal(row.querySelector('.board-change__before').textContent, 'Ship\non Friday');
  assert.equal(row.querySelector('.board-change__after').textContent, 'Ship\non Monday');
  assert.equal(row.querySelector('.board-change__before').tagName, 'DEL');
});

test('a row that is no longer pending shows its outcome instead of buttons', async (t) => {
  const done = (c, state, reason = '') => ({ ...c, state, reason });
  const rows = [
    done(add(1, 'A'), 'applied'), done(add(2, 'B'), 'rejected'), done(add(3, 'C'), 'skipped', 'gone'),
    done(change(4, 'unknown', 'addition', {}, { line: 'wibble wobble' }), 'refused', 'unknown'),
    done(edit(5, 'n5', 'a', 'b'), 'applied'), done(removal(6, 'n6', 'X'), 'applied'), done(removal(7, 'n7', 'Y'), 'rejected'),
    done(edit(8, 'n8', 'a', 'b'), 'skipped', 'changed'), done(change(9, 'edit', 'edit', { target: 'n9', before: '', after: '' }, { line: 'edit n9 hello' }), 'refused', 'not_sent_whole'),
    add(10, 'still pending'),
  ];
  const h = harness(t, { proposals: [proposal('p1', rows)] });
  await h.settle();
  const outcome = (n) => h.row(n).querySelector('.board-change__outcome')?.textContent;
  assert.equal(outcome(1), 'Added');
  assert.equal(outcome(2), 'Rejected');
  assert.equal(outcome(3), 'It is no longer on the board.');
  assert.equal(outcome(5), 'Changed');
  assert.equal(outcome(6), 'Removed');
  assert.equal(outcome(7), 'Rejected');
  assert.equal(outcome(8), 'It was changed after Jenny read the board.');
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.equal(h.row(n).querySelectorAll('button').length, 0, `row ${n} has no buttons`);
  const refused = h.row(4);
  assert.equal(refused.querySelector('.board-change__line').textContent, 'wibble wobble');
  assert.equal(refused.querySelector('.board-change__line').tagName, 'DEL');
  assert.equal(refused.querySelector('.board-change__reason').textContent, 'This line is not a board change.');
  assert.equal(h.row(9).querySelector('.board-change__reason').textContent, 'Jenny had not seen this whole card, so she cannot rewrite it. Select the card and ask again.');
  assert.equal(h.row(10).querySelectorAll('button').length, 1);
  assert.deepEqual([h.act(h.section('addition'), 'accept-additions').disabled, h.section('addition').querySelector('button') === h.act(h.section('addition'), 'accept-additions'), h.row(10).querySelector('button').classList.contains('btn--ghost')], [false, true, false], 'Accept additions stands on the heading line, first in its section; a row button is outlined, not ghost');
});

test('Accept additions in the section is disabled, with its reason, when no addition is pending', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [{ ...add(1, 'A'), state: 'applied' }, edit(2, 'n2', 'a', 'b')])] });
  await h.settle();
  const button = h.act(h.section('addition'), 'accept-additions');
  assert.equal(button.disabled, true);
  assert.ok(button.getAttribute('title'));
});

test('every reason maps to its own sentence and anything else to the fallback', () => {
  const expected = {
    unknown: 'This line is not a board change.', bad_url: 'The link is not an http or https address.',
    missing_text: 'The line is missing its text.', missing_path: 'The line is missing its text.', missing_name: 'The line is missing its text.',
    unsupported: 'Jenny cannot add pictures or chat cards.', unknown_name: 'It names a card that is not on this board.',
    unknown_group: 'It names a group that is not on this board.', not_a_card: 'A connection needs a card at both ends.',
    not_a_note: "Only a note's text can be changed this way.",
    not_sent_whole: 'Jenny had not seen this whole card, so she cannot rewrite it. Select the card and ask again.',
    exists: 'That card already exists. To change it Jenny has to say edit.', no_drawing: 'No drawing came with this line.',
    gone: 'It is no longer on the board.', changed: 'It was changed after Jenny read the board.', too_many: 'That is too much to arrange at once.',
    limit_cards: 'The board is full.', limit_groups: 'The board is full.', outside_root: "The file is not in this project's folder.",
    not_found: "The file is not in this project's folder.", no_root: "The file is not in this project's folder.",
    unavailable: "The file is not in this project's folder.", invalid: 'The board did not accept this change.',
  };
  for (const [reason, sentence] of Object.entries(expected)) assert.equal(text.reasonText(reason), sentence, reason);
  for (const odd of ['', 'surprise', undefined, null, 'limit']) assert.equal(text.reasonText(odd), 'This change could not be used.', String(odd));
});

test('more than forty lines say how many were not read', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A')], { overflow: 7 })] });
  await h.settle();
  assert.equal(h.host.querySelector('[data-board-changes-overflow]').textContent, '7 more lines were not read: a proposal holds at most 40.');
  h.lists.set(BOARD, [proposal('p1', [add(1, 'A')], { overflow: 0 })]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.host.querySelector('[data-board-changes-overflow]'), null);
});

// ------------------------------------------------------------------ model output is text

test('a line, a note, a group title and a link title holding markup appear as that text and make no element', async (t) => {
  const rows = [
    change(1, 'note', 'addition', { text: HOSTILE, group: HOSTILE }),
    change(2, 'group', 'addition', { title: HOSTILE }),
    change(3, 'link', 'addition', { url: 'https://example.com', title: HOSTILE, group: '' }),
    change(4, 'unknown', 'addition', {}, { state: 'refused', reason: 'unknown', line: HOSTILE }),
    edit(5, HOSTILE, HOSTILE, HOSTILE),
    removal(6, HOSTILE, HOSTILE),
  ];
  const h = harness(t, { proposals: [proposal('p1', rows, { preview: { cards: [{ n: 1, kind: 'note', x: 0, y: 0, w: 10, h: 10, groupId: '' }], groups: [{ n: 2, id: 'g', x: 0, y: 0, w: 10, h: 10 }] } })] });
  await h.settle();
  assert.equal(h.row(4).querySelector('.board-change__line').textContent, HOSTILE);
  assert.equal(h.row(5).querySelector('.board-change__before').textContent, HOSTILE);
  assert.ok(h.row(2).querySelector('.board-change__text').textContent.includes(HOSTILE));
  assert.ok(h.row(3).querySelector('.board-change__text').textContent.includes(HOSTILE));
  assert.equal(h.ghosts().length, 2);
  for (const root of [h.host, h.layer, h.centre]) {
    assert.equal(root.querySelectorAll('img, script').length, 0);
  }
});

// ------------------------------------------------------------------ ghosts

const preview = { cards: [{ n: 1, kind: 'note', x: 40, y: 50, w: 200, h: 90, groupId: '', text: '**Decide** [token](https://example.com/) lifetime\nfor a week' }, { n: 2, kind: 'file', x: 300, y: 50, w: 220, h: 70, groupId: '' }], groups: [{ n: 3, id: 'g', x: -10, y: -20, w: 500, h: 300 }],
  connectors: [{ n: 4, from: { x: 40, y: 50, w: 200, h: 90 }, to: { x: 300, y: 50, w: 220, h: 70 }, label: 'blocks', style: 'solid', ends: 'end' }] };
test('a ghost is drawn at each preview place and size, above the canvas content, and takes nothing', async (t) => {
  const rows = [add(1, 'Decide token lifetime'), change(2, 'file', 'addition', { path: 'src/a.ts', group: '' }), change(3, 'group', 'addition', { title: 'Decisions' })];
  const h = harness(t, { proposals: [proposal('p1', rows, { preview })] });
  await h.settle();
  const ghosts = h.ghosts();
  assert.deepEqual([ghosts.length, h.layer.querySelectorAll('.board-ghosts [data-connector-id][data-ghost]').length], [3, 1], 'three outlines and the new connection');
  const box = (g) => [g.style.left, g.style.top, g.style.width, g.style.height];
  assert.deepEqual(box(ghosts[0]), ['40px', '50px', '200px', '90px']);
  assert.deepEqual(box(ghosts[1]), ['300px', '50px', '220px', '70px']);
  assert.deepEqual(box(ghosts[2]), ['-10px', '-20px', '500px', '300px']);
  assert.deepEqual([ghosts[0].querySelector('[data-card-body]').textContent, ghosts[0].hasAttribute('data-ghost'), ghosts[0].querySelector('strong').textContent], ['Decide token lifetime\nfor a week', true, 'Decide'], 'a note is shown whole, as the card it will be');
  assert.equal(ghosts[1].textContent, 'src/a.ts');
  assert.equal(ghosts[2].textContent, 'Decisions');
  const holder = h.layer.querySelector('.board-ghosts');
  assert.equal(holder.getAttribute('aria-hidden'), 'true');
  assert.equal(holder.parentElement, h.layer);
  for (const g of ghosts) {
    assert.equal(g.hasAttribute('tabindex'), false);
    assert.equal(g.querySelectorAll('button, a, input, [tabindex]').length, 0);
  }
});

test('ghosts are redrawn with the list and removed when the proposal closes, another board opens, or the view is disposed', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A'), add(2, 'B')], { preview })] });
  await h.settle();
  assert.deepEqual([h.ghosts().length, h.ghosting()], [3, true], 'drawn ghosts mark the centre, so the empty-board hint does not sit through them');
  h.lists.set(BOARD, [proposal('p1', [add(1, 'A')], { preview: { cards: [preview.cards[0]], groups: [] } })]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.ghosts().length, 1);
  h.lists.set(BOARD, [proposal('p1', [add(1, 'A')], { open: false, state: 'accepted' })]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.deepEqual([h.ghosts().length, h.ghosting()], [0, false], 'closed');
  h.lists.set(BOARD, [proposal('p2', [add(1, 'A')], { preview })]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.ghosts().length, 3);
  h.lists.set(BOARD, [proposal('p2', [add(1, 'A')], { preview: { cards: [{ ...preview.cards[0], x: 400 }], groups: [] } })]);
  h.source.emit({ boardId: BOARD, kind: 'applied' });
  await h.settle();
  assert.deepEqual(h.ghosts().map((g) => g.style.left), ['400px'], 'an applied event reads the list again: the places depend on the board');
  h.lists.set(BOARD, [proposal('p2', [add(1, 'A')], { preview })]);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  h.editor.show(OTHER);
  await h.settle();
  assert.deepEqual([h.ghosts().length, h.ghosting()], [0, false], 'another board');
  assert.equal(h.bar(), null);
  h.editor.show(BOARD);
  await h.settle();
  assert.equal(h.ghosts().length, 3);
  h.part.dispose();
  assert.deepEqual([h.ghosts().length, h.ghosting()], [0, false], 'disposed');
  assert.equal(h.bar(), null);
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.ghosts().length, 0);
});

// ------------------------------------------------------------------ events

test('a proposals event reloads the open board only, and a slow answer for a board no longer open is dropped', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A')], { preview })] });
  await h.settle();
  const before = h.source.listCalls.length;
  h.source.emit({ boardId: OTHER, kind: 'proposals' });
  h.source.emit({ boardId: BOARD, kind: 'renamed' });
  await h.settle();
  assert.equal(h.source.listCalls.length, before, 'another board, another kind: nothing is read');
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  assert.equal(h.source.listCalls.length, before + 1);
  // A slow answer for the board that was open when it was asked.
  let release;
  h.source.hold = new Promise((resolve) => { release = resolve; });
  h.source.emit({ boardId: BOARD, kind: 'proposals' });
  await h.settle();
  h.source.hold = null;
  h.editor.show(OTHER);
  await h.settle();
  assert.equal(h.bar(), null);
  release();
  await h.settle();
  assert.equal(h.bar(), null, 'the late answer for the first board changes nothing');
  assert.equal(h.ghosts().length, 0);
});

test('a board that is not open shows nothing, and the view reads nothing until one opens', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [add(1, 'A')])], withBoard: false });
  await h.settle();
  assert.equal(h.source.listCalls.length, 0);
  assert.equal(h.bar(), null);
  h.editor.show(BOARD);
  await h.settle();
  assert.equal(h.barText(), 'Jenny proposes 1 change');
});

// ------------------------------------------------------------------ the page

function pageHarness(t) {
  const { window } = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  let seq = 0;
  const source = createMemoryBoardSource({ model, makeId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` });
  const calls = [];
  const bridge = new Proxy({}, {
    get: (_target, name) => (name === 'onChanged' ? (listener) => source.onChanged(listener) : (request) => { calls.push(name); return source[name](request); }),
  });
  window.jennyShell = { boards: bridge };
  const switcher = { currentProject: () => ({ id: 'project_alpha', name: 'Alpha' }), refresh: async () => [], onProjectsChanged: () => () => {} };
  const toasts = [];
  cardKinds.register('proposals', createProposalsView);
  const page = createBoardPage({
    container: window.document.getElementById('boardView'), windowRef: window, storage: window.localStorage, allowMemorySource: true,
    getProjectSwitcher: async () => switcher, showToast: (message) => toasts.push(message),
  });
  t.after(() => { page.dispose(); window.close(); });
  return { window, doc: window.document, source, calls, toasts, page };
}

test('on the page: the bar sits with the toolbar, the list fills the Changes view, a proposals event reloads proposals and not the board list', async (t) => {
  const h = pageHarness(t);
  const board = (await h.source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  await h.page.started;
  await flush();
  assert.equal(h.doc.querySelector('[data-board-changes-host] [data-board-changes-empty]').textContent, 'Jenny has not proposed any changes to this board.');
  const listCalls = () => h.calls.filter((name) => name === 'list').length;
  const lists = listCalls();
  const asked = () => h.calls.filter((name) => name === 'listProposals').length;
  const before = asked();
  h.source.setProposals(board.id, [proposal('p1', [add(1, 'Decide'), edit(2, 'n3', 'a', 'b')], { preview })]);
  await flush();
  assert.equal(asked(), before + 1, 'the proposals event read the proposals');
  assert.equal(listCalls(), lists, 'and did not read the board list');
  assert.equal(h.doc.querySelector('[data-board-chrome] [data-board-proposal-bar] .board-proposal-bar__text').textContent, 'Jenny proposes 2 changes');
  assert.equal(h.doc.querySelectorAll('.inv-board-layer [data-board-ghost]').length, 3);
  assert.equal(h.doc.querySelectorAll('[data-board-changes-host] [data-board-change]').length, 2);
  h.doc.querySelector('[data-board-proposal-bar] [data-board-act="review"]').click();
  await flush();
  assert.equal(h.doc.activeElement && h.doc.activeElement.hasAttribute('data-board-changes-title'), true, 'Review puts focus on the Changes heading');
  h.page.dispose();
  assert.equal(h.doc.querySelectorAll('[data-board-ghost], [data-board-proposal-bar]').length, 0);
});

// ------------------------------------------------------------------ Full auto (slice C4)
const applied = (n, text) => ({ ...add(n, text), state: 'applied' });
const barTexts = (h) => [...h.bar().querySelectorAll('.board-proposal-bar__text')].map((span) => span.textContent);

test('under Full auto the bar says what Jenny made, with Undo while her batch is the newest change, then what is left', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [applied(1, 'A'), applied(2, 'B'), edit(3, 'n3', 'a', 'b')], { auto: { applied: 2, batchId: 'batch_9' } })] });
  h.editor.board = { id: BOARD, recent_batches: ['batch_1', 'batch_9'] };
  let undone = 0;
  h.editor.undo = async () => { undone += 1; h.editor.board = { id: BOARD, recent_batches: ['batch_1', 'batch_9', 'undo_1'] }; };
  await h.settle();
  assert.deepEqual(barTexts(h), ['Jenny made 2 changes.', '1 more needs your review.']);
  assert.deepEqual(h.barButtons(), ['Undo', 'Review', 'Reject']);
  h.act(h.bar(), 'undo').focus();
  await h.click(h.act(h.bar(), 'undo'));
  assert.equal(undone, 1);
  assert.deepEqual(barTexts(h), ['Jenny proposes 1 change that needs your review'], 'after the Undo it is an ordinary proposal again');
  assert.deepEqual(h.barButtons(), ['Review', 'Reject']);
  assert.equal(h.doc.activeElement, h.act(h.bar(), 'review'), 'focus stays in the bar, not on the body');
});

test('a closed Full auto proposal keeps its line until Dismiss or the next change of the board', async (t) => {
  const done = proposal('p1', [applied(1, 'A')], { open: false, state: 'applied', auto: { applied: 1, batchId: 'batch_9' } });
  const h = harness(t, { proposals: [done] });
  h.editor.board = { id: BOARD, recent_batches: ['batch_9'] };
  await h.settle();
  assert.deepEqual(barTexts(h), ['Jenny made 1 change.']);
  assert.deepEqual(h.barButtons(), ['Undo', 'Dismiss']);
  h.editor.show(BOARD); // the board changed again: the harness's fresh board has no ring
  assert.equal(h.bar(), null, 'her batch is no longer the newest change');
  h.editor.board = { id: BOARD, recent_batches: ['batch_9'] };
  h.source.emit({ boardId: BOARD, projectId: 'p', kind: 'proposals', rev: 3 });
  await h.settle();
  await h.click(h.act(h.bar(), 'close'));
  assert.equal(h.bar(), null);
  h.source.emit({ boardId: BOARD, projectId: 'p', kind: 'proposals', rev: 4 });
  await h.settle();
  assert.equal(h.bar(), null, 'a dismissed line does not come back');
  assert.deepEqual(h.source.decideCalls, [], 'Dismiss on a closed proposal decides nothing');
});

test('no Full auto line without a kept batch id, and a decision returns focus to the part it was made in', async (t) => {
  const h = harness(t, { proposals: [proposal('p1', [applied(1, 'A'), edit(2, 'n3', 'a', 'b'), removal(3, 'n4', 'Old')], { auto: { applied: 1, batchId: '' } })] });
  h.editor.board = { id: BOARD, recent_batches: ['batch_9'] };
  await h.settle();
  assert.deepEqual(h.barButtons(), ['Review', 'Reject']);
  h.source.decideImpl = async () => { h.lists.set(BOARD, [proposal('p1', [applied(1, 'A'), { ...edit(2, 'n3', 'a', 'b'), state: 'applied' }, removal(3, 'n4', 'Old')])]); return { ok: true }; };
  h.act(h.row(2), 'accept', 2).focus();
  await h.click(h.act(h.row(2), 'accept', 2));
  assert.equal(h.host.contains(h.doc.activeElement), true, 'focus is still inside the Changes list');
  assert.equal(h.doc.activeElement.tagName, 'BUTTON');
});

test('a file line refused by the file check reads as the file sentence, whatever its code', () => {
  for (const code of ['invalid', 'io', 'read_only', 'not_found', 'no_root']) assert.equal(text.reasonText(code, 'file'), "The file is not in this project's folder.", code);
  assert.equal(text.reasonText('invalid', 'note'), 'The board did not accept this change.');
  assert.equal(text.outcomeText({ state: 'refused', reason: 'io', type: 'file' }), "The file is not in this project's folder.");
});
