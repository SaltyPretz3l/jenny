'use strict';

// new-test-file: row 151 slice T5 puts Jenny on a team board, a new surface of the team router: `chat.send` with a
// board id, the backend's board ports, the proposal operations, the revert and the audit of board changes. The
// proposal host on its own is in tests/server/team-board-proposals.test.js.
//
// Through the real router, authorizer, member store, project audit and event stream
// (helpers/team-board-live-kit.js). The gate of the slice: a stamp naming another project's board is not found; one
// decision wins; audit first; board text sent by a client is ignored.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { hostFailure } = require('../../server/api-contract');
const { ProjectAudit } = require('../../server/team/project-audit');
const { memberAuthor } = require('../../services/backend/message-author');
const { readBoardReply } = require('../../services/boards/board-proposal-turn');
const { buildBoardContextBlock } = require('../../services/boards/board-turn-context');
const { resolveBoardStamp } = require('../../services/boards/board-turn-stamp');
const { batch, must, note } = require('./helpers/team-board-kit');
const { UNKNOWN_BOARD, block, setupBoards, until } = require('./helpers/team-board-live-kit');

// One `chat.send` as a member's client sends it: the lease, the revision, then the turn.
async function chat(s, who, sessionId, params) {
  const lease = (await s.h.ok(s.h.send(who, 'control.acquire', { takeover: true }, { session_id: sessionId }), 'lease')).lease;
  return s.h.send(who, 'chat.send', params, { session_id: sessionId, control_generation: lease.generation,
    expected_revision: s.h.core.router.snapshot(sessionId).session.revision });
}

// A completed turn `who` sent from beside X's board, whose reply holds a `board` block: stored as the backend
// stores it (the stamp and the author on the user row), then read as the session runtime reads a completed turn.
let turns = 0;
async function propose(s, who, lines, { boardId = s.X.live, sessionId = s.sX } = {}) {
  const sessions = s.h.backend.sessionStore;
  const n = ++turns;
  const streamId = `stream_board_${n}`;
  assert.ok(sessions.appendMessage(sessionId, { id: `user_${n}`, role: 'user', content: 'Plan this', board_id: boardId,
    author: memberAuthor(s.id(who)) }));
  const section = await buildBoardContextBlock(s.h.backend, { boardId, sessionId, streamId });
  assert.ok(sessions.appendMessage(sessionId, { id: `reply_${n}`, role: 'assistant', content: block(...lines) }));
  const proposal = await readBoardReply(s.h.backend, { sessionId, streamId });
  return { section, proposal, id: `${sessionId}:reply_${n}:1` };
}

const decide = (s, who, verb, proposalId, n, p = s.X) => s.h.send(who, `team.board.proposal.${verb}`,
  { ...s.at(p), proposal_id: proposalId, ...(n === undefined ? {} : { n }) });
const view = (s, who, p = s.X) => s.h.ok(s.h.send(who, 'team.board.view', s.at(p)), `${who} views`);
const kinds = (entries) => entries.map((entry) => entry.kind);

test('T5: chat.send takes a board id only as (the conversation\'s project, board id), and never any board text', async (t) => {
  const s = await setupBoards(t);
  const { X, Y } = s;
  const submitted = [];
  const submit = s.h.backend.runtimeApplicationService.submit;
  s.h.backend.runtimeApplicationService.submit = (payload, options) => { submitted.push(payload); return submit(payload, options); };

  const sent = await s.h.ok(chat(s, 'carl', s.sX, { prompt: 'Plan this', board_id: X.live }), 'stamped');
  assert.equal(submitted.at(-1).board_id, X.live);
  s.h.backend.finish(s.h.backend.workStreams.get(sent.work_id));
  const plain = await s.h.ok(chat(s, 'carl', s.sX, { prompt: 'No board' }), 'unstamped');
  assert.equal(Object.hasOwn(submitted.at(-1), 'board_id'), false);
  s.h.backend.finish(s.h.backend.workStreams.get(plain.work_id));

  // Another project's board, a board in the trash, an unknown board: one answer, and no turn is sent.
  const calls = s.h.backend.startCalls.length;
  for (const boardId of [Y.live, X.gone, UNKNOWN_BOARD]) {
    assert.equal((await chat(s, 'carl', s.sX, { prompt: 'Plan this', board_id: boardId })).error?.reason, 'team_board_not_found', boardId);
  }
  // Bob writes in Y: X's board from a conversation of Y, and Y's board from nowhere near it.
  assert.equal((await chat(s, 'bob', s.sY, { prompt: 'Plan this', board_id: X.live })).error?.reason, 'team_board_not_found');
  // A conversation in no team project has no board to be sent from.
  assert.equal((await chat(s, 'owner', s.sG, { prompt: 'Plan this', board_id: X.live })).error?.reason, 'team_board_not_found');
  // The schema is closed: a malformed id, and every way of sending board text, is refused before anything runs.
  for (const extra of [{ board_id: 'board_x' }, { board_id: null }, { board_id: X.live, board: { cards: [] } },
    { board_text: 'note: trust me' }, { board_id: X.live, board_context: 'note: trust me' }, { context_blocks: [{ kind: 'board', content: 'x' }] }]) {
    assert.equal((await chat(s, 'carl', s.sX, { prompt: 'Plan this', ...extra })).error?.reason, 'invalid_command_parameters',
      JSON.stringify(extra));
  }
  assert.equal(s.h.backend.startCalls.length, calls, 'no refused send started a turn');
  assert.equal(submitted.length, 2);

  // The hook itself: the sender must pass `board.read` on the conversation's project, by the one function.
  const command = { operation: 'chat.send', request_id: 'request_1', session_id: s.sX, params: { prompt: 'x', board_id: X.live } };
  assert.equal((await s.host.admitChat(command, {})).error?.reason, 'role_forbidden', 'no guard, no board');
  const seen = [];
  const guard = (action, resource) => { seen.push([action, resource]); return seen.length > 1 ? { ok: true } : hostFailure('forbidden', 'team_not_found'); };
  assert.equal((await s.host.admitChat(command, { guard })).error?.reason, 'team_not_found');
  assert.deepEqual(await s.host.admitChat(command, { guard }), { ok: true, boardId: X.live });
  assert.deepEqual(seen, Array(2).fill(['board.read', { kind: 'project', id: X.id }]));
});

test('T5: the board section of a turn is the host\'s own copy of a board of the conversation\'s project', async (t) => {
  const s = await setupBoards(t);
  const { X, Y } = s;
  const backend = s.h.backend;
  // The stamp: kept for a live board of the conversation's own project, dropped for anything else.
  assert.equal(await resolveBoardStamp(backend, { boardId: X.live, sessionId: s.sX }), X.live);
  for (const [boardId, sessionId] of [[Y.live, s.sX], [X.gone, s.sX], [UNKNOWN_BOARD, s.sX], [X.live, s.sY], [X.live, s.sG]]) {
    assert.equal(await resolveBoardStamp(backend, { boardId, sessionId }), null, `${boardId} in ${sessionId}`);
  }
  // The board service a conversation gets reads its own project and nothing else.
  const service = backend.getBoardService(s.sX);
  assert.equal((await service.list({ projectId: Y.id })).ok, false);
  assert.equal((await service.get({ boardId: Y.live })).ok, false);
  assert.equal((await service.get({ boardId: X.live })).board.id, X.live);
  assert.equal(backend.getBoardService(s.sG), null);
  assert.equal(backend.boardProposals.applyAuto, undefined, 'no Full auto on a team board');

  const stream = s.h.attach('alice');
  const outside = s.h.attach('bob');
  const turn = await propose(s, 'carl', ['note Decide token lifetime', `edit n1 Changed by Jenny`]);
  assert.match(turn.section.content, /The plan of project X/u);
  assert.equal(turn.section.content.includes('The plan of project Y'), false);
  assert.equal(await buildBoardContextBlock(backend, { boardId: Y.live, sessionId: s.sX, streamId: 'stream_x' }), null);
  assert.equal(turn.proposal.id, turn.id);
  // The proposal is stored on the host, under the member who sent the turn, and the project is told to read again.
  const listed = await s.h.ok(s.h.send('rae', 'team.board.proposal.list', s.at(X)));
  assert.deepEqual(listed.proposals.map((entry) => [entry.id, entry.prompterMemberId, entry.open]), [[turn.id, s.id('carl'), true]]);
  assert.deepEqual(s.frames(stream, 'team_board_proposals_changed'), [{ project_id: X.id, board_id: X.live }]);
  assert.equal(outside.frames.join('').includes('team_board_proposals_changed'), false);
  assert.equal((await s.board(X)).rev, 1, 'a proposal changes nothing on the board');
  // A reply to a turn nobody of the team wrote stores nothing.
  const sessions = backend.sessionStore;
  assert.ok(sessions.appendMessage(s.sX, { id: 'user_anon', role: 'user', content: 'Plan', board_id: X.live }));
  await buildBoardContextBlock(backend, { boardId: X.live, sessionId: s.sX, streamId: 'stream_anon' });
  assert.ok(sessions.appendMessage(s.sX, { id: 'reply_anon', role: 'assistant', content: block('note From nobody') }));
  assert.equal(await readBoardReply(backend, { sessionId: s.sX, streamId: 'stream_anon' }), null);
  assert.equal((await s.h.ok(s.h.send('rae', 'team.board.proposal.list', s.at(X)))).proposals.length, 1);
});

test('T5: a writer viewing the board decides; every decision is audited with prompter and approver; one decision wins', async (t) => {
  const s = await setupBoards(t);
  const { X, Y } = s;
  const { id } = await propose(s, 'carl', ['note Decide token lifetime', 'note Another idea', 'edit n1 Changed by Jenny', 'remove n1']);
  // Who may read the proposals, and who may decide.
  for (const [who, p, reason] of [['bob', X, 'team_not_found'], ['owner', X, 'team_not_found'], ['pia', X, 'member_pending']]) {
    assert.equal(await s.refused(() => s.h.send(who, 'team.board.proposal.list', s.at(p)), who), reason, who);
    assert.equal(await s.refused(() => decide(s, who, 'accept', id, undefined, p), who), reason, who);
  }
  assert.equal(await s.refused(() => decide(s, 'rae', 'accept', id), 'a reader'), 'role_forbidden');
  assert.equal(await s.refused(() => decide(s, 'carl', 'reject', id, 3, { id: Y.id, live: X.live }), 'a reader of Y'), 'team_project_read_only');
  assert.equal(await s.refused(() => s.h.send('bob', 'team.board.proposal.list', { project_id: Y.id, board_id: X.live }), 'forged'),
    'team_board_not_found');
  // A writer who is not viewing the board is refused; so is one viewing another board.
  for (const verb of ['accept', 'reject']) assert.equal(await s.refused(() => decide(s, 'carl', verb, id), verb), 'team_board_not_viewing');
  await view(s, 'bob', Y);
  assert.equal(await s.refused(() => decide(s, 'bob', 'accept', id, undefined, { id: Y.id, live: X.live }), 'bob'), 'team_board_not_found');
  for (const params of [{ proposal_id: '' }, { proposal_id: id, n: 0 }, { proposal_id: id, n: 1.5 }, { proposal_id: id, action: 'accept' },
    { proposal_id: id, member_id: s.id('alice') }, {}]) {
    assert.equal((await s.h.send('carl', 'team.board.proposal.accept', { ...s.at(X), ...params })).error?.reason,
      'invalid_command_parameters', JSON.stringify(params));
  }

  await view(s, 'carl');
  await view(s, 'alice');
  const stream = s.h.attach('rae');
  const added = await s.h.ok(decide(s, 'alice', 'accept', id), 'additions');
  assert.deepEqual([added.applied, added.skipped, added.proposal.prompterMemberId], [2, 0, s.id('carl')]);
  assert.equal(Object.keys((await s.board(X)).cards).length, 3);
  assert.equal(s.frames(stream, 'team_board_changed').at(-1).batch.actor, s.id('alice'), 'the member who accepted is the actor');
  // Two members decide the same edit at once: one wins, the other reads closed, and the edit landed once.
  const [first, second] = await Promise.all([decide(s, 'carl', 'accept', id, 3), decide(s, 'alice', 'reject', id, 3)]);
  assert.deepEqual([first.ok, second.error?.reason], [true, 'team_board_proposal_closed']);
  assert.equal((await s.board(X)).cards[X.note].data.text, 'Changed by Jenny');
  await s.h.ok(decide(s, 'carl', 'reject', id, 4), 'reject the removal');
  assert.ok((await s.board(X)).cards[X.note]);
  assert.equal((await decide(s, 'carl', 'reject', id)).error?.reason, 'team_board_proposal_closed');
  assert.equal((await decide(s, 'carl', 'accept', `${s.sX}:nobody:1`)).error?.reason, 'team_board_proposal_not_found');

  const base = { project_id: X.id, session_id: s.sX, board_id: X.live, prompter_member_id: s.id('carl'), tool_name: null, decision: null };
  assert.deepEqual(s.audit(X).map(({ seq: _seq, at: _at, ...entry }) => entry), [
    { ...base, kind: 'board_proposal_accepted', actor_member_id: s.id('alice'), detail: { change: 0, count: 2 } },
    { ...base, kind: 'board_proposal_accepted', actor_member_id: s.id('carl'), detail: { change: 3, count: 1 } },
    { ...base, kind: 'board_proposal_rejected', actor_member_id: s.id('carl'), detail: { change: 4, count: 1 } },
  ]);
  assert.equal(s.frames(stream, 'team_board_proposals_changed').length, 3);
  // A project admin reads the entries with the rest of the project's audit.
  const read = await s.h.ok(s.h.send('alice', 'team.project.audit.read', { project_id: X.id }));
  assert.deepEqual(kinds(read.entries.filter((entry) => entry.board_id === X.live)),
    ['board_proposal_accepted', 'board_proposal_accepted', 'board_proposal_rejected']);
});

test('T5: a decision that waited is checked again inside the board\'s queue', async (t) => {
  const hold = {};
  const wrapBoards = (store) => ({ ...store, readProposals: async (args) => {
    const out = await store.readProposals(args);
    if (hold.gate) { hold.entered = true; await hold.gate; }
    return out;
  } });
  const s = await setupBoards(t, { wrapBoards });
  const { X } = s;
  const { id } = await propose(s, 'carl', ['note One', 'edit n1 Changed by Jenny']);
  const setRole = (role) => s.h.ok(s.h.send('alice', 'team.project.members.setRole', { project_id: X.id, member_id: s.id('carl'), role }));
  const cases = [
    ['demoted to reader', () => setRole('reader'), 'team_project_read_only', () => setRole('writer')],
    ['left the board', () => s.h.ok(s.h.send('carl', 'team.board.leave', s.at(X))), 'team_board_not_viewing', async () => {}],
    ['removed from the project', () => s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: X.id, member_id: s.id('carl') })),
      'team_not_found', () => s.h.ok(s.h.send('alice', 'team.project.members.add', { project_id: X.id, member_id: s.id('carl'), role: 'writer' }))],
  ];
  for (const [label, change, reason, undo] of cases) {
    for (const [verb, n] of [['accept', undefined], ['accept', 2], ['reject', 2]]) {
      await view(s, 'carl');
      let release;
      Object.assign(hold, { gate: new Promise((resolve) => { release = resolve; }), entered: false });
      const before = s.audit(X).length;
      const waiting = s.refused(() => decide(s, 'carl', verb, id, n), `${verb} ${label}`);
      await until(() => hold.entered, 'the decision');
      await change();
      hold.gate = null;
      release();
      assert.equal(await waiting, reason, `${verb} after ${label}`);
      assert.equal(s.audit(X).length, before, 'a refused decision writes no audit entry');
      await undo();
    }
  }
  assert.equal((await s.board(X)).rev, 1);
});

test('T5: revert is a project admin\'s; revert, delete, restore and a bulk removal are audited, and need the audit', async (t) => {
  const gate = { fail: false };
  const createAudit = (options) => {
    const real = new ProjectAudit(options);
    return new Proxy(real, { get: (target, key) => {
      if (key === 'append') return (entry) => (gate.fail && entry.board_id ? { ok: false } : target.append(entry));
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
  };
  const s = await setupBoards(t, { createAudit });
  const { X, Y } = s;
  const apply = (who, ...ops) => s.h.send(who, 'team.board.apply', s.at(X, { batch: batch(...ops) }));
  const many = Array.from({ length: 21 }, (_, index) => note(`n${index}`, index));
  const ids = many.map((op) => op.card.id);
  await s.h.ok(apply('carl', ...many));
  // 19 removals are a batch like any other; 20 or more write an entry first.
  await s.h.ok(apply('carl', { op: 'card.remove', id: ids[0] }));
  assert.deepEqual(s.audit(X), []);
  gate.fail = true;
  assert.equal(await s.refused(() => apply('carl', ...ids.slice(1).map((cardId) => ({ op: 'card.remove', id: cardId }))), 'bulk'),
    'team_audit_unavailable');
  gate.fail = false;
  const removed = await s.h.ok(apply('carl', ...ids.slice(1).map((cardId) => ({ op: 'card.remove', id: cardId }))));
  const actor = (who, kind, detail = null) => ({ kind, project_id: X.id, session_id: null, board_id: X.live, actor_member_id: s.id(who),
    prompter_member_id: null, tool_name: null, decision: null, detail });
  const entries = () => s.audit(X).map(({ seq: _seq, at: _at, ...entry }) => entry);
  assert.deepEqual(entries(), [actor('carl', 'board_bulk_removed', { items: 20 })]);

  // Revert: an admin's, by (project, board, rev); a writer, a forged board and a rev the journal lacks are refused.
  const revert = (who, rev, p = X, extra = {}) => s.h.send(who, 'team.board.revert', { ...s.at(p), rev }, extra);
  assert.equal(await s.refused(() => revert('carl', removed.rev), 'writer'), 'role_forbidden');
  assert.equal(await s.refused(() => revert('rae', removed.rev), 'reader'), 'role_forbidden');
  assert.equal(await s.refused(() => revert('bob', removed.rev, { id: Y.id, live: X.live }), 'forged'), 'team_board_not_found');
  assert.equal(await s.refused(() => revert('alice', 999), 'no such rev'), 'team_board_not_found');
  assert.equal((await revert('alice', 0)).error?.reason, 'invalid_command_parameters');
  gate.fail = true;
  assert.equal(await s.refused(() => revert('alice', removed.rev), 'no audit'), 'team_audit_unavailable');
  gate.fail = false;
  const fixed = { request_id: `request_${crypto.randomUUID()}` };
  const back = await s.h.ok(revert('alice', removed.rev, X, fixed), 'revert');
  assert.deepEqual(back, { ok: true, rev: removed.rev + 1, reverted: 20, skipped: 0 });
  assert.equal(Object.keys((await s.board(X)).cards).length, 21);
  assert.equal((await must(s.boards.since({ projectId: X.id, boardId: X.live, afterRev: removed.rev }))).batches[0].actor, s.id('alice'));
  assert.deepEqual(await revert('alice', removed.rev, X, fixed), back, 'an exact retry answers as the first did');
  assert.equal((await s.board(X)).rev, back.rev);
  assert.deepEqual(entries().slice(1), [actor('alice', 'board_batch_reverted', { rev: removed.rev })]);
  // The restored cards keep the member who first added them.
  assert.equal((await s.board(X)).cards[ids[5]].created_by, s.id('carl'));

  // A revert may not bring back a chat card whose conversation has left the project.
  const pinned = await s.h.ok(apply('carl', { op: 'card.add', card: { id: crypto.randomUUID(), kind: 'chat', x: 0, y: 0,
    data: { session_id: s.sX, title: 'In X' } } }));
  const unpinned = await s.h.ok(apply('carl', { op: 'card.remove', id: pinned.applied.ops[0].card.id }));
  assert.ok(s.h.backend.sessionStore.updateSession(s.sX, { project_id: Y.id }));
  assert.equal(await s.refused(() => revert('alice', unpinned.rev), 'chat card'), 'team_board_chat_outside_project');

  // Delete and restore: each refused without the audit, each one entry.
  gate.fail = true;
  assert.equal(await s.refused(() => s.h.send('alice', 'team.board.delete', s.at(X)), 'delete'), 'team_audit_unavailable');
  assert.equal(await s.refused(() => s.h.send('alice', 'team.board.restore', { project_id: X.id, board_id: X.gone }), 'restore'),
    'team_audit_unavailable');
  gate.fail = false;
  await s.h.ok(s.h.send('alice', 'team.board.delete', s.at(X)));
  await s.h.ok(s.h.send('alice', 'team.board.restore', s.at(X)));
  assert.deepEqual(kinds(s.audit(X)).slice(2), ['board_deleted', 'board_restored']);
  assert.deepEqual((await must(s.boards.list({ projectId: X.id }))).boards.map((entry) => entry.id), [X.live]);
});

test('T9: the history of a board is every project member\'s to read, newest first, in counts; a member\'s batch cannot pose as the host\'s', async (t) => {
  const s = await setupBoards(t);
  const { X, Y } = s;
  const apply = (who, ...ops) => s.h.send(who, 'team.board.apply', s.at(X, { batch: batch(...ops) }));
  const history = (who, p = X, extra = {}) => s.h.send(who, 'team.board.history', { ...s.at(p), ...extra });
  const [first, second] = [note('Secret plan', 0), note('Other', 1)];
  const added = await s.h.ok(apply('carl', first, second));
  const removed = await s.h.ok(apply('carl', { op: 'card.remove', id: first.card.id }));
  const back = await s.h.ok(s.h.send('alice', 'team.board.revert', { ...s.at(X), rev: removed.rev }), 'revert');
  await view(s, 'carl');
  const made = await propose(s, 'carl', ['note Idea from Jenny']);
  await s.h.ok(decide(s, 'carl', 'accept', made.id), 'accept');
  const head = (await s.board(X)).rev;
  assert.equal(head, back.rev + 1);
  // Rae only reads in X: the list is hers too. Four batches, newest first.
  const read = await s.h.ok(history('rae'), 'a reader reads the history');
  assert.equal(read.rev, head);
  for (const change of read.changes) assert.match(change.at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  const change = (rev, who, kind, ofRev, ops, reverted) => ({ rev, actor: s.id(who), kind, of_rev: ofRev, ops, takeable: true, reverted });
  assert.deepEqual(read.changes.slice(0, 4).map(({ at: _at, ...rest }) => rest), [
    change(head, 'carl', 'proposal', null, { 'card.add': 1 }, false),
    change(back.rev, 'alice', 'revert', removed.rev, { 'card.add': 1 }, false),
    change(removed.rev, 'carl', 'change', null, { 'card.remove': 1 }, true),
    change(added.rev, 'carl', 'change', null, { 'card.add': 2 }, false),
  ]);
  assert.equal(read.changes.length, head - (await must(s.boards.since({ projectId: X.id, boardId: X.live, afterRev: head }))).rev + read.changes.length);
  assert.equal(JSON.stringify(read).includes('Secret plan'), false, 'counts only, no board text');
  assert.deepEqual((await s.h.ok(history('alice'))).changes, read.changes);
  // Another project's id with this board, a board in the trash, and an unknown field.
  assert.equal(await s.refused(() => history('bob', { id: Y.id, live: X.live }), 'forged'), 'team_board_not_found');
  assert.equal(await s.refused(() => history('alice', { id: X.id, live: X.gone }), 'trash'), 'team_board_not_found');
  assert.equal((await history('alice', X, { limit: 5 })).error?.reason, 'invalid_command_parameters');
  // A member's batch may not carry an id only the host writes: it would mark a change as taken back, or as Jenny's.
  for (const batchId of [`revert-${added.rev}-forged`, 'revert-x', 'proposal-forged']) {
    const forged = { ...batch(note('mine')), batch_id: batchId };
    assert.equal(await s.refused(() => s.h.send('carl', 'team.board.apply', s.at(X, { batch: forged })), batchId), 'team_board_batch_id_reserved');
  }
  assert.deepEqual((await s.h.ok(history('rae'))).changes, read.changes, 'nothing was written, nothing reads as taken back');
});
