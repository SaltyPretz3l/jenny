'use strict';

// new-test-file: Jenny's proposed board changes (row 150 slice C3): the reader of a reply's `board` blocks,
// the stored proposals and their decisions, and the turn hook, over the real board service in a temp profile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../services/boards/board-model');
const fence = require('../services/boards/board-fence');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const { createBoardProposals } = require('../services/boards/board-proposals');
const { readProposal } = require('../services/boards/board-proposal-reader');
const { readBoardReply } = require('../services/boards/board-proposal-turn');

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const ALPHA = 'project_alpha';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const block = (...lines) => ['Here is my proposal.', '```board', ...lines, '```', ''].join('\n');

function setup(t, { files = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-proposals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'profile');
  fs.mkdirSync(userDataPath);
  const env = { seq: 1000, pseq: 5000, events: [], msg: 0 };
  env.service = createBoardService({
    store: createBoardStore({ userDataPath }), now: () => new Date(T0), makeId: () => uid(++env.seq),
    isEnabled: () => true, projectExists: () => true,
  });
  env.service.on('changed', (event) => env.events.push(event));
  env.proposals = createBoardProposals({
    service: env.service, store: createBoardStore({ userDataPath }), now: () => new Date(T0), makeId: () => uid(++env.pseq),
    getFiles: () => files,
  });
  env.file = (name) => path.join(userDataPath, 'boards', name);
  return env;
}

/** A board with a group g1, notes n2 (in g1) and n3, a file f4 and one connection n2 -> n3 "blocks". */
async function seeded(env) {
  const made = await env.service.create({ projectId: ALPHA, name: 'Plan' });
  assert.equal(made.ok, true, JSON.stringify(made));
  const id = made.board.id;
  const ops = [
    { op: 'group.add', group: { id: uid(1), title: 'Open questions' } },
    { op: 'card.add', card: { id: uid(2), kind: 'note', data: { text: 'Do we keep refresh tokens?' }, group_id: uid(1) } },
    { op: 'card.add', card: { id: uid(3), kind: 'note', data: { text: 'Ship on Friday' } } },
    { op: 'card.add', card: { id: uid(4), kind: 'file', data: { path: 'src/auth/session.ts', title: 'session.ts' } } },
    { op: 'connector.add', connector: { id: uid(5), from: uid(2), to: uid(3), label: 'blocks' } },
  ];
  const applied = await env.service.apply({ boardId: id, batch: { batch_id: 'seed', board_id: id, ops } });
  assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 300));
  const b = applied.board;
  assert.deepEqual([b.groups[uid(1)].alias, b.cards[uid(2)].alias, b.cards[uid(3)].alias, b.cards[uid(4)].alias], ['g1', 'n2', 'n3', 'f4']);
  return b;
}
const boardNow = async (env, id) => (await env.service.get({ boardId: id })).board;
let turn = 0;
const recorded = async (env, boardId, text, extra = {}) => {
  const r = await env.proposals.record({ boardId, sessionId: 'session_a', messageId: `m${++turn}`, text, sentWhole: [], ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.proposal;
};
const read = (board, lines, extra = {}) => {
  let n = 9000;
  return readProposal({ board, bodies: [lines.join('\n')], sketches: [], sentWhole: [], makeId: () => uid(++n), ...extra });
};
const states = (proposal) => proposal.changes.map((c) => `${c.n}:${c.type}:${c.state}${c.reason ? `(${c.reason})` : ''}`);

/* ---------------------------------------------------------------- the reader */

test('temporary names: `as`, an alias-shaped name the board does not have, and a group named like an alias after its card', async (t) => {
  const board = await seeded(setup(t));
  const late = read(board, ['note Later card in g8', 'group g8 Later group']);
  assert.deepEqual(late.changes.map((c) => `${c.type}:${c.state}`), ['note:pending', 'group:pending']);
  assert.equal(late.changes[0].ops[0].card.group_id, late.changes[1].ops[0].group.id);
  assert.equal(late.changes[0].ops[0].card.data.text, 'Later card');
  const out = read(board, [
    'group Decisions as dec',
    'note Decide token lifetime as lifetime in dec',
    'link l9 https://example.org/spec Token spec',
    'lifetime -> f4 reads',
    'l9 --> lifetime',
    'n3 <-> lifetime',
  ]);
  assert.deepEqual(out.changes.map((c) => `${c.type}:${c.state}`), ['group:pending', 'note:pending', 'link:pending', 'connect:pending', 'connect:pending', 'connect:pending']);
  const [group, note, link, c1, c2, c3] = out.changes;
  assert.equal(note.ops[0].card.data.text, 'Decide token lifetime');
  assert.equal(note.ops[0].card.group_id, group.ops[0].group.id, 'the note sits in the new group, named after it');
  assert.equal(c1.ops[0].connector.from, note.ops[0].card.id);
  assert.equal(c1.ops[0].connector.to, uid(4));
  assert.equal(c1.ops[0].connector.label, 'reads');
  assert.deepEqual([c2.ops[0].connector.from, c2.ops[0].connector.style], [link.ops[0].card.id, 'dashed']);
  assert.equal(c3.ops[0].connector.ends, 'both');
  assert.deepEqual(c1.summary, { from: 'Decide token lifetime', to: 'src/auth/session.ts', label: 'reads', arrow: '->' });
});

test('prose that looks like grammar goes back into the text; a made-up name does not', async (t) => {
  const board = await seeded(setup(t));
  const out = read(board, ['note Ship it as planned', 'note Review the spec as t1', 'note Check the cache in g7', 'link https://example.org/a Title in g7', 'group Risks as usual']);
  assert.equal(out.changes[0].ops[0].card.data.text, 'Ship it as planned');
  assert.equal(out.changes[1].ops[0].card.data.text, 'Review the spec');
  assert.equal(out.changes[2].ops[0].card.data.text, 'Check the cache in g7');
  assert.deepEqual([out.changes[3].state, out.changes[3].reason], ['refused', 'unknown_group']);
  assert.equal(out.changes[4].ops[0].group.title, 'Risks as usual');
});

test('lines that restate the board are ignored without a word; a changed restatement is refused; a repeated block counts once', async (t) => {
  const board = await seeded(setup(t));
  const text = M.boardToText(board).text;
  assert.match(text, /note n3 Ship on Friday/);
  assert.deepEqual(read(board, text.split('\n')).changes, [], 'the board section copied back proposes nothing');
  const out = read(board, ['board Plan', 'selected n3', 'group g1 Open questions', 'note n3 Ship on Monday', 'n2 -> n3 blocks', 'n2 -> n3 needs', '...(+3 cards not shown)']);
  assert.deepEqual(out.changes.map((c) => `${c.type}:${c.state}:${c.reason}`), ['note:refused:exists', 'connect:pending:']);
  let n = 100;
  const twice = readProposal({ board, bodies: ['note One', 'note One', 'note Two'], sketches: [], sentWhole: [], makeId: () => uid(++n) });
  assert.deepEqual(twice.changes.map((c) => c.ops[0].card.data.text), ['One', 'Two']);
});

test('a line that fails is kept with its reason and the others stand; pictures and chat cards cannot be added', async (t) => {
  const board = await seeded(setup(t));
  const out = read(board, ['note A fine note', 'frobnicate n3', 'link not-a-url Title', 'image A chart', 'chat An old chat', 'n3 -> nowhere', 'n3 -> g1', 'n3 -> n3',
    'append f4 More', 'append ghost More', 'move n3 in g9', 'remove ghost', 'tidy g9']);
  assert.deepEqual(out.changes.map((c) => `${c.type}:${c.state}:${c.reason}`), [
    'note:pending:', 'unknown:refused:unknown', 'unknown:refused:bad_url', 'image:refused:unsupported', 'chat:refused:unsupported',
    'connect:refused:unknown_name', 'connect:refused:not_a_card', 'connect:refused:invalid',
    'append:refused:not_a_note', 'append:refused:unknown_name', 'move:refused:unknown_group', 'remove:refused:unknown_name', 'tidy:refused:unknown_group']);
  assert.equal(out.changes[1].line, 'frobnicate n3');
});

test('edit needs the card sent whole; edit, move, tidy and remove wait for their own accept; append rides with additions', async (t) => {
  const board = await seeded(setup(t));
  const lines = ['edit n3 Ship on Monday', 'edit n2 Keep them', 'edit f4 nope', 'edit n3 Ship on Friday', 'append n2 Mobile needs them.', 'move n3 in g1', 'move n2 in g1', 'remove n3', 'remove g1', 'tidy g1', 'tidy'];
  const out = read(board, lines, { sentWhole: ['n3'] });
  assert.deepEqual(out.changes.map((c) => `${c.type}:${c.class}:${c.state}:${c.reason}`), [
    'edit:edit:pending:', 'edit:edit:refused:not_sent_whole', 'edit:edit:refused:not_a_note', 'append:addition:pending:', 'move:edit:pending:',
    'remove:removal:pending:', 'remove:removal:pending:', 'tidy:edit:pending:', 'tidy:edit:pending:']);
  assert.deepEqual(out.changes[0].summary, { target: 'n3', before: 'Ship on Friday', after: 'Ship on Monday' });
  assert.deepEqual(out.changes[0].target, { id: uid(3), content_rev: board.cards[uid(3)].content_rev });
  assert.deepEqual(out.changes[6].target, { id: uid(1), content_rev: board.groups[uid(1)].content_rev, group: true });
});

test('edit on a group renames it: one change with its own accept, applied as one group.edit; a bad or unchanged label changes nothing', async (t) => {
  const ctx = setup(t);
  const board = await seeded(ctx);
  const was = board.groups[uid(1)];
  const out = read(board, ['edit g1 Token risks', `edit g1 ${was.title}`, `edit g1 ${'x'.repeat(201)}`, 'group Later as later', 'edit later Sooner']);
  assert.deepEqual(out.changes.map((c) => `${c.type}:${c.class}:${c.state}:${c.reason}`),
    ['edit:edit:pending:', 'edit:edit:refused:invalid', 'group:addition:pending:', 'edit:edit:refused:not_on_board']);
  const rename = out.changes[0];
  assert.deepEqual(rename.summary, { target: 'g1', before: was.title, after: 'Token risks' });
  assert.deepEqual(rename.target, { id: uid(1), content_rev: was.content_rev, group: true });
  assert.deepEqual(rename.ops, [{ op: 'group.edit', id: uid(1), content_rev: was.content_rev, title: 'Token risks' }]);
  // Accepted, it renames the group and nothing else; additions alone never apply it.
  const proposal = await recorded(ctx, board.id, block('edit g1 Token risks'));
  const decide = (action, n) => ctx.proposals.decide({ boardId: board.id, proposalId: proposal.id, action, n });
  assert.equal((await decide('accept_additions')).reason, 'nothing_pending');
  assert.deepEqual(states((await decide('accept', 1)).proposal), ['1:edit:applied']);
  const after = await boardNow(ctx, board.id);
  assert.deepEqual([after.groups[uid(1)].title, after.cards[uid(2)].group_id], ['Token risks', uid(1)]);
});

test('a diagram takes the sketch fence of its name; one unnamed pair is matched; no drawing is refused; a redraw needs the card sent whole', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const reply = ['```board', 'diagram flow Login flow', 'diagram other Other', '```', '```sketch flow', 'a Login', 'b Token', 'a -> b', '```', '```sketch', 'x X', '```'].join('\n');
  let n = 200;
  const args = (text, extra = {}) => ({ board, bodies: fence.boardBlockBodies(text), sketches: fence.sketchBlocks(text), sentWhole: [], makeId: () => uid(++n), ...extra });
  assert.deepEqual(fence.sketchBlocks(reply), [{ name: 'flow', body: 'a Login\nb Token\na -> b' }, { name: '', body: 'x X' }]);
  const out = readProposal(args(reply));
  assert.deepEqual(out.changes.map((c) => `${c.type}:${c.state}`), ['diagram:pending', 'diagram:pending']);
  assert.deepEqual(out.changes[0].ops[0].card.data, { scene: 'a Login\nb Token\na -> b', title: 'Login flow' });
  assert.equal(out.changes[1].ops[0].card.data.scene, 'x X', 'the one line without a fence takes the one fence without a name');
  const paired = readProposal(args(['```board', 'diagram d7 Flow', '```', '```sketch', 'd7', 'a A', '```'].join('\n')));
  assert.equal(paired.changes[0].ops[0].card.data.scene, 'a A', 'a first line that only repeats the name is dropped');
  const none = readProposal(args(['```board', 'diagram one One', 'diagram two Two', '```', '```sketch', 'a A', '```'].join('\n')));
  assert.deepEqual(none.changes.map((c) => `${c.state}:${c.reason}`), ['refused:no_drawing', 'refused:no_drawing'], 'two lines and one fence: nothing is guessed');
  assert.deepEqual(fence.sketchBlocks('```sketch open\na A\n'), [], 'an unclosed fence is ignored');

  const added = await env.service.apply({ boardId: board.id, batch: { batch_id: 'd', board_id: board.id,
    ops: [{ op: 'card.add', card: { id: uid(6), kind: 'diagram', data: { scene: 'a A', title: 'Old' } } }] } });
  const alias = added.board.cards[uid(6)].alias;
  const redraw = ['```board', `diagram ${alias} New title`, '```', `\`\`\`sketch ${alias}`, 'a A', 'b B', '```'].join('\n');
  const refused = readProposal({ ...args(redraw), board: added.board });
  assert.deepEqual([refused.changes[0].type, refused.changes[0].class, refused.changes[0].reason], ['redraw', 'edit', 'not_sent_whole']);
  const allowed = readProposal({ ...args(redraw, { sentWhole: [alias] }), board: added.board });
  assert.deepEqual(allowed.changes[0].ops[0].data, { scene: 'a A\nb B', title: 'New title' });
});

test('past forty lines the rest is counted, not kept', async (t) => {
  const board = await seeded(setup(t));
  const out = read(board, Array.from({ length: 47 }, (_, i) => `note Idea ${i + 1}`));
  assert.equal(out.changes.length, M.LIMITS.proposal_ops);
  assert.equal(out.overflow, 7);
  assert.equal(out.changes[39].n, 40);
});

/* ---------------------------------------------------------------- stored proposals */

test('record stores one proposal per reply, announces it, and a second reading of the same reply changes nothing', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  assert.deepEqual(await env.proposals.record({ boardId: board.id, sessionId: 's', messageId: 'm', text: 'No block here.', sentWhole: [] }), { ok: true, proposal: null });
  assert.equal((await env.proposals.record({ boardId: board.id, sessionId: 's', messageId: 'm', text: '```board\nnote Unclosed', sentWhole: [] })).proposal, null);
  env.events.length = 0;
  const text = block('note Decide token lifetime as lifetime', 'lifetime -> n3', `note ${'x'.repeat(M.LIMITS.note_chars + 1)}`);
  const first = await env.proposals.record({ boardId: board.id, sessionId: 'session_a', messageId: 'msg_1', text, sentWhole: [] });
  assert.equal(first.proposal.id, 'session_a:msg_1:1');
  assert.deepEqual(states(first.proposal), ['1:note:pending', '2:connect:pending', '3:note:refused(invalid)'], 'what the model refuses today is refused from the start');
  assert.equal(first.proposal.changes[0].ops, undefined, 'operations never leave the main process');
  assert.deepEqual(first.proposal.counts, { total: 3, pending: 2, additions: 2, edits: 0, removals: 0, applied: 0, refused: 1, skipped: 0, rejected: 0 });
  assert.deepEqual(env.events.map((e) => e.kind), ['proposals']);
  const again = await env.proposals.record({ boardId: board.id, sessionId: 'session_a', messageId: 'msg_1', text, sentWhole: [] });
  assert.equal(again.duplicate, true);
  assert.equal(JSON.parse(fs.readFileSync(env.file(`${board.id}.proposals.json`), 'utf8')).length, 1);
  assert.equal((await boardNow(env, board.id)).rev, board.rev, 'recording changes no board');
});

test('Accept additions applies them as one batch: one Undo takes all of it back, and edits, moves, tidies and removals still wait', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const proposal = await recorded(env, board.id, block(
    'group Decisions as dec', 'note Decide token lifetime as lifetime in dec', 'lifetime -> f4', 'append n2 Mobile needs them.', 'append n2 Checked: yes.',
    'move n3 in g1', 'tidy g1', 'edit n3 Ship on Monday', 'remove f4'), { sentWhole: ['n3'] });
  assert.deepEqual([proposal.counts.additions, proposal.counts.edits], [5, 3]);
  const listed = await env.proposals.list({ boardId: board.id });
  assert.deepEqual(listed.proposals[0].preview.cards.map((c) => [c.n, c.kind]), [[2, 'note']]);
  assert.deepEqual(listed.proposals[0].preview.groups.map((g) => g.n), [1]);
  assert.deepEqual(listed.proposals[0].preview.connectors.map((c) => [c.n, c.style, c.ends, c.from.w > 0 && c.to.w > 0]), [[3, 'solid', 'end', true]], 'a new connection is in the preview with the boxes it joins');

  const done = await env.proposals.decide({ boardId: board.id, proposalId: proposal.id, action: 'accept_additions' });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual([done.applied, done.skipped], [5, 0]);
  assert.deepEqual(states(done.proposal).slice(5), ['6:move:pending', '7:tidy:pending', '8:edit:pending', '9:remove:pending']);
  assert.equal(done.proposal.state, 'partly_accepted');
  assert.equal(done.proposal.open, true);
  const after = await boardNow(env, board.id);
  assert.equal(after.rev, board.rev + 1, 'one batch');
  assert.equal(after.cards[uid(2)].data.text, 'Do we keep refresh tokens?\nMobile needs them.\nChecked: yes.');
  assert.notEqual(after.cards[uid(3)].group_id, uid(1), 'the move has not been applied');
  assert.deepEqual([after.cards[uid(3)].x, after.cards[uid(3)].y], [board.cards[uid(3)].x, board.cards[uid(3)].y], 'no card a person placed has moved');
  assert.equal(Object.keys(after.cards).length, 4);
  assert.equal(Object.keys(after.connectors).length, 2);
  assert.equal(after.cards[uid(3)].data.text, 'Ship on Friday', 'the edit has not been applied');
  const undone = await env.service.undo({ boardId: board.id });
  assert.equal(undone.ok, true);
  const plain = (items) => Object.values(items).map(({ geo_rev: _g, content_rev: _c, updated_at: _u, ...rest }) => rest);
  assert.deepEqual(plain(undone.board.cards), plain(board.cards), 'every card is back where and as it was');
  assert.deepEqual(plain(undone.board.groups), plain(board.groups));
  assert.deepEqual(Object.keys(undone.board.connectors), Object.keys(board.connectors));
});

test('a move and a tidy are each accepted on their own, one Undo step each; a move into a proposed group waits for the additions', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const proposal = await recorded(env, board.id, block('move n3 in g1', 'tidy g1', 'group Decisions as dec', 'move n2 in dec', 'tidy'));
  assert.deepEqual(states(proposal), ['1:move:pending', '2:tidy:pending', '3:group:pending', '4:move:pending', '5:tidy:pending']);
  assert.deepEqual([proposal.counts.additions, proposal.counts.edits], [1, 4]);
  const accept = (n) => env.proposals.decide({ boardId: board.id, proposalId: proposal.id, action: 'accept', n });
  assert.deepEqual(await accept(4), { ok: false, reason: 'additions_first' });
  assert.equal((await boardNow(env, board.id)).rev, board.rev);
  const moved = await accept(1);
  assert.deepEqual([moved.ok, moved.applied], [true, 1], JSON.stringify(moved));
  const after = await boardNow(env, board.id);
  assert.equal(after.rev, board.rev + 1, 'its own batch');
  assert.equal(after.cards[uid(3)].group_id, uid(1));
  const g1 = after.groups[uid(1)];
  const inside = (c) => c.x >= g1.x && c.y >= g1.y && c.x + c.w <= g1.x + g1.w && c.y + c.h <= g1.y + g1.h;
  assert.ok(inside(after.cards[uid(3)]) && inside(after.cards[uid(2)]), 'the moved card and its neighbour sit inside the group');
  assert.equal((await accept(2)).ok, true);
  assert.equal((await env.proposals.decide({ boardId: board.id, proposalId: proposal.id, action: 'accept_additions' })).applied, 1);
  const last = await accept(4);
  assert.deepEqual([last.ok, last.applied], [true, 1], JSON.stringify(last));
  assert.deepEqual(states(last.proposal), ['1:move:applied', '2:tidy:applied', '3:group:applied', '4:move:applied', '5:tidy:pending']);
  const end = await boardNow(env, board.id);
  assert.equal(end.cards[uid(2)].group_id, Object.keys(end.groups).find((id) => id !== uid(1)));
  assert.equal((await env.service.undo({ boardId: board.id })).board.cards[uid(2)].group_id, uid(1), 'one Undo takes back the last move only');
});

test('each edit and each removal is accepted on its own; a target that changed or went is skipped and says so', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const proposal = await recorded(env, board.id, block('edit n3 Ship on Monday', 'edit n2 Keep them', 'remove f4', 'remove g1'), { sentWhole: ['n2', 'n3'] });
  const decide = (action, n) => env.proposals.decide({ boardId: board.id, proposalId: proposal.id, action, n });
  assert.equal((await decide('accept_additions')).reason, 'nothing_pending');
  assert.equal((await decide('accept', 99)).reason, 'invalid');
  // n2 is changed by a person, f4 removed, after the proposal was made.
  const moved = await env.service.apply({ boardId: board.id, batch: { batch_id: 'person', board_id: board.id, ops: [
    { op: 'card.edit', id: uid(2), content_rev: board.cards[uid(2)].content_rev, data: { text: 'Changed by hand' } }, { op: 'card.remove', id: uid(4) }] } });
  assert.equal(moved.ok, true);
  const first = await decide('accept', 1);
  assert.deepEqual([first.applied, first.skipped], [1, 0]);
  assert.equal((await boardNow(env, board.id)).cards[uid(3)].data.text, 'Ship on Monday');
  assert.deepEqual([(await decide('accept', 2)).skipped, (await decide('accept', 3)).skipped], [1, 1]);
  const last = await decide('accept', 4);
  assert.deepEqual(states(last.proposal), ['1:edit:applied', '2:edit:skipped(changed)', '3:remove:skipped(gone)', '4:remove:applied']);
  assert.deepEqual([last.proposal.state, last.proposal.open], ['accepted', false]);
  const after = await boardNow(env, board.id);
  assert.equal(after.cards[uid(2)].data.text, 'Changed by hand');
  assert.equal(after.groups[uid(1)], undefined);
  assert.equal(after.cards[uid(2)].group_id, null, 'removing a group keeps its cards');
  assert.equal((await decide('reject')).reason, 'closed');
});

test('an addition whose target went is skipped while the rest applies; rejecting one line or all of them', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const proposal = await recorded(env, board.id, block('note A new idea as idea', 'idea -> f4', 'append n3 Later.', 'note Another', 'remove n2'));
  await env.service.apply({ boardId: board.id, batch: { batch_id: 'gone', board_id: board.id, ops: [{ op: 'card.remove', id: uid(4) }, { op: 'card.remove', id: uid(3) }] } });
  const decide = (action, n) => env.proposals.decide({ boardId: board.id, proposalId: proposal.id, action, n });
  assert.equal((await decide('reject', 4)).proposal.changes[3].state, 'rejected');
  const done = await decide('accept_additions');
  assert.deepEqual(states(done.proposal), ['1:note:applied', '2:connect:skipped(gone)', '3:append:skipped(gone)', '4:note:rejected', '5:remove:pending']);
  const closed = await decide('reject');
  assert.deepEqual([closed.proposal.state, closed.proposal.open, closed.proposal.changes[4].state], ['partly_accepted', false, 'rejected']);

  const second = await recorded(env, board.id, block('note Only this'));
  const rejected = await env.proposals.decide({ boardId: board.id, proposalId: second.id, action: 'reject' });
  assert.deepEqual([rejected.proposal.state, rejected.proposal.open], ['rejected', false]);
  assert.equal(Object.keys((await boardNow(env, board.id)).cards).length, 2, 'n2 and the one accepted note');
});

test('a newer proposal from the same chat supersedes the open one; another chat\'s stays; a proposal of refused lines stays open until dismissed', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const a1 = await recorded(env, board.id, block('note First'));
  const other = await env.proposals.record({ boardId: board.id, sessionId: 'session_b', messageId: 'x1', text: block('note From another chat'), sentWhole: [] });
  const a2 = await recorded(env, board.id, block('frobnicate'));
  const listed = (await env.proposals.list({ boardId: board.id })).proposals;
  assert.deepEqual(listed.map((p) => [p.id, p.state, p.open]), [[a2.id, 'pending', true], [other.proposal.id, 'pending', true], [a1.id, 'superseded', false]]);
  assert.equal((await env.proposals.decide({ boardId: board.id, proposalId: a1.id, action: 'accept_additions' })).reason, 'closed');
  const dismissed = await env.proposals.decide({ boardId: board.id, proposalId: a2.id, action: 'reject' });
  assert.deepEqual([dismissed.proposal.state, dismissed.proposal.open], ['rejected', false]);
});

test('file lines go through the file check; the twenty-first proposal pushes the oldest closed one out', async (t) => {
  const seen = [];
  const files = { resolveFile: async ({ boardId, path: p }) => { seen.push([boardId, p]); return p.startsWith('src/') ? { ok: true, path: p, title: p.split('/').pop() } : { ok: false, reason: 'outside_root' }; } };
  const env = setup(t, { files });
  const board = await seeded(env);
  const proposal = await recorded(env, board.id, block('file src/auth/tokens.ts', 'file ../../etc/passwd'));
  assert.deepEqual(states(proposal), ['1:file:pending', '2:file:refused(outside_root)']);
  assert.deepEqual(seen, [[board.id, 'src/auth/tokens.ts'], [board.id, '../../etc/passwd']]);
  await env.proposals.decide({ boardId: board.id, proposalId: proposal.id, action: 'accept_additions' });
  const card = Object.values((await boardNow(env, board.id)).cards).find((c) => c.kind === 'file' && c.data.path === 'src/auth/tokens.ts');
  assert.deepEqual(card.data, { path: 'src/auth/tokens.ts', title: 'tokens.ts' });
  for (let i = 0; i < M.LIMITS.proposals; i++) {
    await env.proposals.record({ boardId: board.id, sessionId: `chat_${i}`, messageId: 'm', text: block(`note Idea ${i}`), sentWhole: [] });
  }
  const all = (await env.proposals.list({ boardId: board.id })).proposals;
  assert.equal(all.length, M.LIMITS.proposals);
  assert.equal(all.some((p) => p.id === proposal.id), false, 'the closed one went first');
});

test('hostile calls answer invalid or not_found and never throw', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const bad = [undefined, null, 'x', [], { boardId: 'nope' }, { boardId: board.id, sessionId: 'a/b', messageId: 'm', text: 'x' }, { boardId: board.id, sessionId: 's', messageId: 'm', text: 7 }];
  for (const raw of bad) assert.equal((await env.proposals.record(raw)).ok, false);
  for (const raw of [undefined, {}, { boardId: board.id, proposalId: 'p', action: 'explode' }, { boardId: board.id, proposalId: 'p', action: 'accept', n: -1 }, { boardId: board.id, proposalId: 'p', action: 'accept', n: '1' }]) {
    assert.equal((await env.proposals.decide(raw)).reason, 'invalid');
  }
  assert.equal((await env.proposals.decide({ boardId: board.id, proposalId: 'nobody:m:1', action: 'reject' })).reason, 'not_found');
  assert.equal((await env.proposals.list({ boardId: 'board_00000000-0000-4000-8000-00000000dead' })).reason, 'not_found');
  fs.writeFileSync(env.file(`${board.id}.proposals.json`), '{not json');
  assert.deepEqual((await env.proposals.list({ boardId: board.id })).proposals, [], 'a corrupt file reads as no proposals');
});

/* ---------------------------------------------------------------- the turn hook */

test('a reply is read only for the stamped turn it answers: other turns, other boards and other streams are inert', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const calls = [];
  const messages = [
    { id: 'u1', role: 'user', content: 'Add a note', board_id: board.id },
    { id: 'a1', role: 'assistant', content: 'Thinking about the board.' },
    { id: 'a2', role: 'assistant', content: block('note From the reply') },
  ];
  const service = {
    boardProposals: { record: async (args) => { calls.push(args); return { ok: true, proposal: { id: 'p' } }; } },
    sessionStore: { getSession: () => ({ messages }) },
    getBoardService: () => env.service,
  };
  // The record is made the way a real stamped turn makes it: by building that turn's board section.
  const { buildBoardContextBlock } = require('../services/boards/board-turn-context');
  const stamp = async (streamId) => assert.ok(await buildBoardContextBlock(service, { boardId: board.id, sessionId: 'session_a', streamId }));
  assert.equal(await readBoardReply(service, { sessionId: 'session_a', streamId: 'stream_1' }), null, 'no record: the turn was not sent from a board');
  await stamp('stream_1');
  assert.equal(await readBoardReply(service, { sessionId: 'session_a', streamId: 'stream_2' }), null, 'a later turn of the same chat, sent from the Chat page');
  assert.deepEqual(await readBoardReply(service, { sessionId: 'session_a', streamId: 'stream_1' }), { id: 'p' });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].boardId, calls[0].sessionId, calls[0].messageId], [board.id, 'session_a', 'a2']);
  assert.deepEqual(calls[0].sentWhole.slice().sort(), ['f4', 'n2', 'n3'], 'the cards that turn showed whole');
  assert.match(calls[0].text, /Thinking about the board\.\n\n[\s\S]*note From the reply/);
  messages[0] = { id: 'u1', role: 'user', content: 'Add a note' };
  assert.equal(await readBoardReply(service, { sessionId: 'session_a', streamId: 'stream_1' }), null, 'the newest user message carries no stamp');
  messages[0] = { id: 'u1', role: 'user', content: 'Add a note', board_id: 'board_00000000-0000-4000-8000-00000000beef' };
  assert.equal(await readBoardReply(service, { sessionId: 'session_a', streamId: 'stream_1' }), null, 'stamped for another board');
  service.sessionStore.getSession = () => { throw new Error('gone'); };
  assert.equal(await readBoardReply(service, { sessionId: 'session_a', streamId: 'stream_1' }), null);
  assert.equal(calls.length, 1);
});

/* ---------------------------------------------------------------- Full auto (slice C4) */

// The real authority, as tests/full-auto-gate.test.js builds it: only a binding captured as an auto-run turn answers.
function captureTurn(approvalMode) {
  const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
  const project = { project_id: 'p', root_path: os.tmpdir(), root_id: 'r', root_revision: 1, device_id: 'd', inode: 'i' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (current) => current, _sessionStore: { getSessionSummary: () => ({ id: 'session_a', run_mode: 'auto', plan_mode: false }) } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  return { authority, binding: authority.captureSession('session_a', { requestId: 'req-1', mode: 'assist', approvalMode }) };
}

test('Full auto applies the additions at once on the turn\'s captured authority; edits and removals wait; armed mid-run does not apply', async (t) => {
  const env = setup(t);
  const board = await seeded(env);
  const { buildBoardContextBlock } = require('../services/boards/board-turn-context');
  const gate = { armed: true, safetyMode: 'normal' };
  const messages = [];
  const service = {
    boardProposals: { record: (args) => env.proposals.record(args), applyAuto: (args) => env.proposals.applyAuto(args) },
    sessionStore: { getSession: () => ({ messages }) },
    getBoardService: () => env.service,
    primaryFullAuto: { isArmed: (sessionId) => gate.armed && sessionId === 'session_a' },
    configService: { getChatUiState: () => ({ safetyMode: gate.safetyMode }) },
  };
  const turn = async (n, lines, executionAuthority) => {
    messages.length = 0;
    messages.push({ id: `u${n}`, role: 'user', content: 'Go', board_id: board.id }, { id: `a${n}`, role: 'assistant', content: block(...lines) });
    assert.ok(await buildBoardContextBlock(service, { boardId: board.id, sessionId: 'session_a', streamId: `stream_${n}` }));
    return readBoardReply(service, { sessionId: 'session_a', streamId: `stream_${n}`, executionAuthority });
  };
  const now = async () => (await env.service.get({ boardId: board.id })).board;
  const cards = async () => Object.keys((await now()).cards).length;

  // Auto-run was captured when the turn started and Full auto is still armed: the additions are on the board.
  const auto = captureTurn('auto_run');
  const made = await turn(1, ['note Auto one', 'note Auto two in g1', 'edit n3 Ship on Monday', 'remove f4', 'move n3 in g1', 'tidy'], auto.binding);
  assert.equal(made.auto.applied, 2);
  assert.match(made.auto.batchId, /^proposal-/);
  assert.deepEqual([made.state, made.open, made.counts.additions, made.counts.edits, made.counts.removals, made.counts.applied], ['partly_accepted', true, 0, 3, 1, 2]);
  const after = await now();
  assert.equal(Object.keys(after.cards).length, 5);
  assert.deepEqual([after.cards[uid(3)].group_id || '', after.cards[uid(3)].x, after.cards[uid(3)].y], ['', board.cards[uid(3)].x, board.cards[uid(3)].y],
    'Full auto moves no card a person placed: the move and the tidy wait');
  assert.equal(after.cards[uid(3)].data.text, 'Ship on Friday', 'the edit waits for a person');
  assert.ok(after.cards[uid(4)], 'the removal waits for a person');
  assert.equal(after.recent_batches.at(-1), made.auto.batchId, 'one batch, the newest: one Undo takes it back');
  assert.equal((await env.service.undo({ boardId: board.id })).ok, true);
  assert.equal(await cards(), 3);
  // The same reply read again is not applied again.
  const again = await readBoardReply(service, { sessionId: 'session_a', streamId: 'stream_1', executionAuthority: auto.binding });
  assert.equal(again.id, made.id);
  assert.equal(await cards(), 3);

  // Full auto armed while the turn ran: the turn's captured authority is not an auto-run one, so nothing applies.
  const asked = await turn(2, ['note Mid run'], captureTurn('prompt').binding);
  assert.deepEqual([asked.auto, asked.state, asked.counts.additions], [null, 'pending', 1]);
  assert.equal(await cards(), 3);

  // Disarmed before the reply ended; a safety mode that does not allow it; an authority already closed; none at all.
  gate.armed = false;
  assert.equal((await turn(3, ['note Disarmed'], captureTurn('auto_run').binding)).auto, null);
  gate.armed = true;
  gate.safetyMode = 'locked';
  assert.equal((await turn(4, ['note Locked'], captureTurn('auto_run').binding)).auto, null);
  gate.safetyMode = 'normal';
  const closed = captureTurn('auto_run');
  closed.authority.close(closed.binding);
  assert.equal((await turn(5, ['note Closed'], closed.binding)).auto, null);
  assert.equal((await turn(6, ['note No authority'], undefined)).auto, null);
  assert.equal((await turn(7, ['note Forged'], { authority: { capturedAutoRun: true } })).auto, null);
  assert.equal(await cards(), 3);

  // Only edits and removals: nothing to apply, and the proposal waits whole.
  const waits = await turn(8, ['remove f4'], captureTurn('auto_run').binding);
  assert.deepEqual([waits.auto, waits.state, waits.counts.removals], [null, 'pending', 1]);
  assert.equal(await cards(), 3);

  // The bridge's decide never marks a proposal as applied by Full auto, whatever it is sent.
  const byHand = await turn(9, ['note By hand'], undefined);
  const done = await env.proposals.decide({ boardId: board.id, proposalId: byHand.id, action: 'accept_additions', auto: true });
  assert.deepEqual([done.ok, done.applied, done.proposal.auto], [true, 1, null]);
});
