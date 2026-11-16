'use strict';

// new-test-file: row 151 slice T5 adds Jenny's proposals on a team board (server/team/boards/board-proposals-host.js),
// a new host surface. The proposal rules themselves are the desktop's and keep their tests in
// tests/board-proposals.test.js; the store's audit hook and `revert` are at the end of this file.
//
// Over the real host board store and the real project audit in a temp profile: a reply's `board` block is stored
// under the member who sent the turn; every decision names the member who made it and writes one audit entry
// before its first write; one of two decisions wins; a decision whose audit cannot be written changes nothing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hostFailure } = require('../../server/api-contract');
const { createHostProposals } = require('../../server/team/boards/board-proposals-host');
const { createTeamBoards } = require('../../server/team/boards/team-boards');
const { PROJECT_AUDIT_FILE, ProjectAudit } = require('../../server/team/project-audit');
const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { batch, must, note } = require('./helpers/team-board-kit');

const P = 'project_alpha';
const Q = 'project_beta';
const ALICE = 'member_alice';
const BOB = 'member_bob';
const CAROL = 'member_carol';
const SESSION = 'sess_1800000000000_aaaaaaaaaaaa';
const START = Date.UTC(2026, 10, 15, 9, 0, 0);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const block = (...lines) => ['Here is my proposal.', '```board', ...lines, '```', ''].join('\n');
const reasonOf = (answer) => answer?.error?.reason;
const allow = () => null;

async function setup(t) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-proposals-')));
  t.after(() => removeTreeSync(profile));
  const clock = { now: START };
  const boards = createTeamBoards({ userDataPath: profile, clock: () => clock.now });
  const log = new ProjectAudit({ filePath: path.join(profile, PROJECT_AUDIT_FILE), clock: () => clock.now, logger: () => {} });
  const h = { profile, boards, log, clock, auditFails: false, seen: [], announced: [], turn: 0, rule: () => null, ruled: [] };
  const board = (await must(boards.create({ projectId: P, actor: ALICE, name: 'Plan' }), 'create')).board;
  h.board = board;
  h.docFile = path.join(profile, 'team-boards', P, `${board.id}.json`);
  h.proposalsFile = path.join(profile, 'team-boards', P, `${board.id}.proposals.json`);
  const diskRev = () => JSON.parse(fs.readFileSync(h.docFile, 'utf8')).rev;
  const diskProposals = () => (fs.existsSync(h.proposalsFile) ? fs.readFileSync(h.proposalsFile, 'utf8') : '');
  h.diskRev = diskRev;
  // The audit as the host gives it: what is on disk when the entry is written is kept beside the entry.
  const audit = (entry) => {
    if (h.auditFails) return { ok: false };
    const written = log.append(entry);
    if (written?.ok === true) h.seen.push({ kind: entry.kind, rev: diskRev(), proposals: diskProposals() });
    return written;
  };
  const batchRefusal = (applied, scope) => { h.ruled.push({ ...scope, ops: applied.ops.length }); return h.rule(applied, scope); };
  h.proposals = createHostProposals({ boards, audit, batchRefusal,
    announce: (projectId, boardId) => h.announced.push(`${projectId}/${boardId}`), clock: () => clock.now });
  // A group g1, the notes n2 (in g1) and n3.
  await must(boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(
    { op: 'group.add', group: { id: uid(1), title: 'Open questions' } },
    { op: 'card.add', card: { id: uid(2), kind: 'note', data: { text: 'Do we keep refresh tokens?' }, group_id: uid(1) } },
    { op: 'card.add', card: { id: uid(3), kind: 'note', data: { text: 'Ship on Friday' } } }) }), 'seed');
  h.record = async (text, extra = {}) => {
    const out = await h.proposals.record({ projectId: P, boardId: board.id, sessionId: SESSION, messageId: `m${++h.turn}`, text,
      sentWhole: ['n2', 'n3'], prompter: ALICE, ...extra });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.proposal;
  };
  h.decide = (proposalId, action, n, actor = BOB, extra = {}) => h.proposals.decide({ projectId: P, boardId: board.id, proposalId,
    action, ...(n === undefined ? {} : { n }), actor, recheck: allow, ...extra });
  h.get = async () => (await must(boards.get({ projectId: P, boardId: board.id }), 'get')).board;
  h.entries = () => log.read({ projectId: P }).entries;
  return h;
}

const states = (proposal) => proposal.changes.map((change) => `${change.n}:${change.type}:${change.state}`);

test('a reply is stored under the member who sent the turn, on a board of that project only', async (t) => {
  const h = await setup(t);
  const proposal = await h.record(block('note A new idea', 'edit n3 Ship on Monday', 'remove n2', 'file src/auth/tokens.ts'));
  assert.equal(proposal.id, `${SESSION}:m1:1`);
  assert.equal(proposal.prompterMemberId, ALICE);
  assert.deepEqual(states(proposal), ['1:note:pending', '2:edit:pending', '3:remove:pending', '4:file:refused'],
    'a file line is refused on a team board');
  assert.equal(JSON.parse(fs.readFileSync(h.proposalsFile, 'utf8')).proposals?.[0]?.prompter_member_id
    ?? JSON.parse(fs.readFileSync(h.proposalsFile, 'utf8'))[0]?.prompter_member_id, ALICE);
  assert.deepEqual(h.announced, [`${P}/${h.board.id}`]);
  assert.equal((await h.get()).rev, 1, 'recording writes nothing to the board');
  assert.deepEqual(h.entries(), [], 'recording writes no audit entry');

  const listed = await must(h.proposals.list({ projectId: P, boardId: h.board.id }));
  assert.deepEqual(listed.proposals.map((entry) => [entry.id, entry.prompterMemberId, entry.open]), [[proposal.id, ALICE, true]]);
  assert.deepEqual(await h.proposals.record({ projectId: P, boardId: h.board.id, sessionId: SESSION, messageId: 'm1',
    text: block('note A new idea'), sentWhole: [], prompter: ALICE }).then((out) => [out.ok, out.duplicate, out.proposal.prompterMemberId]),
  [true, true, ALICE], 'the same reply read twice stores one proposal');

  // No member author, another project's board, a reply with no block.
  const before = fs.readFileSync(h.proposalsFile, 'utf8');
  for (const prompter of [undefined, null, '', 'owner', 'member_']) {
    assert.deepEqual(await h.proposals.record({ projectId: P, boardId: h.board.id, sessionId: SESSION, messageId: 'mx',
      text: block('note X'), sentWhole: [], prompter }), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(await h.proposals.record({ projectId: Q, boardId: h.board.id, sessionId: SESSION, messageId: 'mq',
    text: block('note X'), sentWhole: [], prompter: ALICE }), { ok: false, reason: 'team_board_not_found' });
  assert.equal(reasonOf(await h.proposals.list({ projectId: Q, boardId: h.board.id })), 'team_board_not_found');
  assert.deepEqual(await h.proposals.record({ projectId: P, boardId: h.board.id, sessionId: SESSION, messageId: 'mp',
    text: 'No board block here.', sentWhole: [], prompter: ALICE }), { ok: true, proposal: null });
  assert.equal(fs.readFileSync(h.proposalsFile, 'utf8'), before);
});

test('each decision is the deciding member\'s batch and one audit entry, written before the board or the proposal', async (t) => {
  const h = await setup(t);
  const proposal = await h.record(block('note A new idea', 'note Another', 'edit n3 Ship on Monday', 'remove n2'));
  const stored = fs.readFileSync(h.proposalsFile, 'utf8');

  const added = await must(h.decide(proposal.id, 'accept_additions'), 'additions');
  assert.deepEqual([added.applied, added.skipped, added.proposal.prompterMemberId], [2, 0, ALICE]);
  assert.deepEqual(h.seen, [{ kind: 'board_proposal_accepted', rev: 1, proposals: stored }],
    'the entry was written while the board and the proposal were still as before');
  let board = await h.get();
  assert.equal(board.rev, 2, 'the additions are one batch');
  assert.equal(Object.keys(board.cards).length, 4);
  const since = await must(h.boards.since({ projectId: P, boardId: h.board.id, afterRev: 1 }));
  assert.deepEqual(since.batches.map((item) => item.actor), [BOB], 'the member who accepted is the batch\'s actor');

  const edited = await must(h.decide(proposal.id, 'accept', 3, CAROL), 'edit');
  assert.deepEqual([edited.applied, states(edited.proposal)[2]], [1, '3:edit:applied']);
  board = await h.get();
  assert.equal(board.cards[uid(3)].data.text, 'Ship on Monday');

  const afterEdit = fs.readFileSync(h.proposalsFile, 'utf8');
  const rejected = await must(h.decide(proposal.id, 'reject', 4), 'reject');
  assert.deepEqual([rejected.applied, states(rejected.proposal)[3], rejected.proposal.open], [0, '4:remove:rejected', false]);
  assert.ok((await h.get()).cards[uid(2)], 'a rejected removal removes nothing');
  assert.deepEqual(h.seen[2], { kind: 'board_proposal_rejected', rev: 3, proposals: afterEdit });

  const base = { project_id: P, session_id: SESSION, board_id: h.board.id, prompter_member_id: ALICE, tool_name: null, decision: null };
  assert.deepEqual(h.entries().map(({ seq: _seq, at: _at, ...entry }) => entry), [
    { ...base, kind: 'board_proposal_accepted', actor_member_id: BOB, detail: { change: 0, count: 2 } },
    { ...base, kind: 'board_proposal_accepted', actor_member_id: CAROL, detail: { change: 3, count: 1 } },
    { ...base, kind: 'board_proposal_rejected', actor_member_id: BOB, detail: { change: 4, count: 1 } },
  ]);
  assert.equal(h.announced.length, 4, 'the record and each decision are announced');
  assert.equal(reasonOf(await h.decide(proposal.id, 'reject')), 'team_board_proposal_closed');
});

test('one of two decisions on the same change wins, and the other reads closed', async (t) => {
  const h = await setup(t);
  const proposal = await h.record(block('edit n3 Ship on Monday', 'remove n2'));
  const [first, second] = await Promise.all([h.decide(proposal.id, 'accept', 2, BOB), h.decide(proposal.id, 'reject', 2, CAROL)]);
  assert.equal(first.ok, true);
  assert.equal(reasonOf(second), 'team_board_proposal_closed');
  assert.equal((await h.get()).cards[uid(2)], undefined, 'the removal was accepted once');
  assert.deepEqual(h.entries().map((entry) => [entry.kind, entry.actor_member_id]), [['board_proposal_accepted', BOB]]);

  // A whole-proposal reject and an accept of its last change, the other way round.
  const [rejectAll, late] = await Promise.all([h.decide(proposal.id, 'reject', undefined, CAROL), h.decide(proposal.id, 'accept', 1, BOB)]);
  assert.equal(rejectAll.ok, true);
  assert.equal(reasonOf(late), 'team_board_proposal_closed');
  assert.equal((await h.get()).cards[uid(3)].data.text, 'Ship on Friday');
  assert.equal(h.entries().length, 2);
});

test('a decision whose audit entry cannot be written changes nothing, and can be made again', async (t) => {
  const h = await setup(t);
  const proposal = await h.record(block('note A new idea', 'remove n2'));
  const stored = fs.readFileSync(h.proposalsFile, 'utf8');
  h.auditFails = true;
  for (const [action, n] of [['accept_additions'], ['accept', 2], ['reject', 2], ['reject']]) {
    assert.equal(reasonOf(await h.decide(proposal.id, action, n)), 'team_audit_unavailable', action);
  }
  assert.equal(h.diskRev(), 1);
  assert.equal(fs.readFileSync(h.proposalsFile, 'utf8'), stored);
  assert.deepEqual(h.entries(), []);
  h.auditFails = false;
  assert.equal((await must(h.decide(proposal.id, 'accept', 2))).applied, 1);
  assert.equal(h.entries().length, 1);
});

test('the caller\'s check runs again before each write, and a decision is checked before any of it', async (t) => {
  const h = await setup(t);
  const proposal = await h.record(block('note A new idea', 'remove n2'));
  const stored = fs.readFileSync(h.proposalsFile, 'utf8');
  const denied = () => hostFailure('forbidden', 'role_forbidden');
  for (const [action, n] of [['accept_additions'], ['accept', 2], ['reject', 2]]) {
    assert.equal(reasonOf(await h.decide(proposal.id, action, n, BOB, { recheck: denied })), 'role_forbidden', action);
  }
  // The batch rule of a team board (chat cards, note locks) is asked about every accepted batch, as the acting member.
  h.rule = () => hostFailure('forbidden', 'team_board_note_locked');
  assert.equal(reasonOf(await h.decide(proposal.id, 'accept', 2, CAROL)), 'team_board_note_locked');
  assert.deepEqual(h.ruled, [{ projectId: P, boardId: h.board.id, actor: CAROL, ops: 1 }]);
  h.rule = () => null;
  assert.equal(h.diskRev(), 1);
  assert.equal(fs.readFileSync(h.proposalsFile, 'utf8'), stored);
  assert.deepEqual(h.entries(), [], 'a refused decision writes no audit entry');

  const ask = (overrides) => h.proposals.decide({ projectId: P, boardId: h.board.id, proposalId: proposal.id, action: 'reject',
    actor: BOB, recheck: allow, ...overrides });
  for (const bad of [{ action: 'frobnicate' }, { action: 'accept' }, { action: 'accept_additions', n: 1 }, { n: 0 }, { n: 1.5 },
    { proposalId: '' }, { proposalId: 'x'.repeat(501) }, { proposalId: 7 }]) {
    assert.equal(reasonOf(await ask(bad)), 'team_board_invalid', JSON.stringify(bad));
  }
  assert.equal(reasonOf(await ask({ actor: 'owner' })), 'role_forbidden');
  assert.equal(reasonOf(await ask({ recheck: undefined })), 'role_forbidden', 'a decision without the caller\'s check is refused');
  assert.equal(reasonOf(await ask({ proposalId: `${SESSION}:nobody:1` })), 'team_board_proposal_not_found');
  assert.equal(reasonOf(await ask({ projectId: Q })), 'team_board_not_found');
  assert.equal(reasonOf(await ask({ n: 99 })), 'team_board_proposal_closed');
  assert.deepEqual(h.entries(), []);
  assert.deepEqual(h.proposals.resources(), { lines: 0 });
});

test('an accept the board no longer takes is skipped and writes no audit entry', async (t) => {
  const h = await setup(t);
  const proposal = await h.record(block('edit n3 Ship on Monday'));
  await must(h.boards.apply({ projectId: P, boardId: h.board.id, actor: ALICE,
    batch: batch({ op: 'card.remove', id: uid(3) }) }), 'remove');
  const out = await must(h.decide(proposal.id, 'accept', 1));
  assert.deepEqual([out.applied, out.skipped, states(out.proposal)], [0, 1, ['1:edit:skipped']]);
  assert.deepEqual(h.entries(), []);
});

test('an accept that landed is written to its proposal whatever the check says afterwards, and counts what it applied (wave 10 review)', async (t) => {
  const h = await setup(t);
  const proposal = await h.record(block('note A new idea as idea', 'idea -> n3', 'append n3 Later.', 'append n2 More.'));
  await must(h.boards.apply({ projectId: P, boardId: h.board.id, actor: ALICE, batch: batch({ op: 'card.remove', id: uid(3) }) }), 'remove');
  // The member is demoted between the board's write and the proposal's.
  let asked = 0;
  const once = () => { asked += 1; return asked === 1 ? null : hostFailure('forbidden', 'role_forbidden'); };
  const out = await must(h.decide(proposal.id, 'accept_additions', undefined, BOB, { recheck: once }), 'accept');
  assert.deepEqual([out.applied, out.skipped, states(out.proposal)], [2, 2,
    ['1:note:applied', '2:connect:skipped', '3:append:skipped', '4:append:applied']]);
  assert.equal(asked, 1, 'the proposal is written without asking again: its change is on the board');
  assert.equal((await h.get()).cards[uid(2)].data.text, 'Do we keep refresh tokens?\nMore.');
  assert.equal(reasonOf(await h.decide(proposal.id, 'accept_additions')), 'team_board_proposal_closed', 'nothing is offered twice');
  assert.equal(h.diskRev(), 3);
  assert.deepEqual(h.entries().map((entry) => entry.detail), [{ change: 0, count: 2 }], 'two of the four additions were accepted');

  // A proposals write that fails once is tried again; one that fails twice is logged and answered as it failed.
  const logs = [];
  const fails = { left: 0, calls: 0 };
  const flaky = { ...h.boards, writeProposals: (args) => { fails.calls += 1;
    if (fails.left > 0) { fails.left -= 1; return Promise.resolve(hostFailure('unavailable', 'team_board_unavailable', '', true)); }
    return h.boards.writeProposals(args); } };
  const second = createHostProposals({ boards: flaky, audit: () => ({ ok: true }), batchRefusal: () => null, clock: () => h.clock.now,
    logger: (level, event, data) => logs.push({ level, event, data }) });
  const decide = (id) => second.decide({ projectId: P, boardId: h.board.id, proposalId: id, action: 'accept_additions', actor: BOB, recheck: allow });
  const again = await h.record(block('note Tried twice'));
  Object.assign(fails, { left: 1, calls: 0 });
  assert.equal((await must(decide(again.id), 'retried')).applied, 1);
  assert.deepEqual([fails.calls, logs.length], [2, 0]);
  const behind = await h.record(block('note Left behind'));
  Object.assign(fails, { left: 2, calls: 0 });
  assert.equal(reasonOf(await decide(behind.id)), 'team_board_unavailable');
  assert.deepEqual([fails.calls, logs.map((entry) => [entry.level, entry.event, entry.data])],
    [2, [['WARN', 'team_board.proposals_behind', { project_id: P, board_id: h.board.id }]]]);
  // A record's list write (nothing landed on the board) is not retried.
  Object.assign(fails, { left: 1, calls: 0 });
  const refused = await second.record({ projectId: P, boardId: h.board.id, sessionId: SESSION, messageId: 'flaky', text: block('note X'),
    sentWhole: [], prompter: ALICE });
  assert.deepEqual([refused.ok, fails.calls, logs.length], [false, 1, 1]);
});

test('the store\'s audit hook runs before the first write of an apply, a delete, a restore and a revert', async (t) => {
  const h = await setup(t);
  const calls = [];
  const audit = (event) => { calls.push({ ...event, rev: h.diskRev() }); return null; };
  const args = { projectId: P, boardId: h.board.id, actor: BOB };
  await must(h.boards.apply({ ...args, audit, batch: batch(note('one'), { op: 'card.remove', id: uid(2) }, { op: 'group.remove', id: uid(1) }) }));
  assert.deepEqual(calls, [{ kind: 'apply', removed: 2, rev: 1 }]);

  // An audit that refuses, throws or answers nonsense stops the write.
  const refusal = hostFailure('unavailable', 'team_audit_unavailable');
  for (const [bad, reason] of [[() => refusal, 'team_audit_unavailable'], [() => { throw new Error('x'); }, 'team_board_unavailable'],
    [() => true, 'team_board_unavailable'], [() => ({ ok: true }), 'team_board_unavailable']]) {
    assert.equal(reasonOf(await h.boards.apply({ ...args, audit: bad, batch: batch(note('two')) })), reason);
    assert.equal(reasonOf(await h.boards.revert({ ...args, audit: bad, rev: 2 })), reason);
    assert.equal(reasonOf(await h.boards.remove({ ...args, audit: bad })), reason);
  }
  assert.equal(reasonOf(await h.boards.apply({ ...args, audit: 'yes', batch: batch(note('two')) })), 'team_board_invalid');
  assert.equal(h.diskRev(), 2);

  // Revert: the batch that made rev 2 is taken back as one new batch under the caller's name.
  calls.length = 0;
  const reverted = await must(h.boards.revert({ ...args, actor: CAROL, audit, rev: 2 }), 'revert');
  assert.deepEqual([reverted.rev, reverted.skipped], [3, []]);
  assert.deepEqual(calls, [{ kind: 'revert', rev: 2 }].map((call) => ({ ...call, rev: 2 })));
  const board = await h.get();
  assert.deepEqual([Object.keys(board.cards).sort(), Object.keys(board.groups)], [[uid(2), uid(3)], [uid(1)]]);
  assert.equal((await must(h.boards.since({ projectId: P, boardId: h.board.id, afterRev: 2 }))).batches[0].actor, CAROL);
  assert.equal(reasonOf(await h.boards.revert({ ...args, rev: 99 })), 'team_board_not_found');
  assert.equal(reasonOf(await h.boards.revert({ ...args, rev: 0 })), 'team_board_invalid');
  assert.equal(reasonOf(await h.boards.revert({ ...args, projectId: Q, rev: 2 })), 'team_board_not_found');

  // A revert whose items have since gone names what it skipped and writes nothing when nothing is left.
  await must(h.boards.apply({ ...args, batch: batch({ op: 'card.edit', id: uid(3), content_rev: board.cards[uid(3)].content_rev,
    data: { text: 'Changed' } }) }));
  await must(h.boards.apply({ ...args, batch: batch({ op: 'card.remove', id: uid(3) }) }));
  calls.length = 0;
  const nothing = await must(h.boards.revert({ ...args, audit, rev: 4 }), 'stale revert');
  assert.deepEqual([nothing.rev, nothing.applied, nothing.skipped.length, calls.length], [5, null, 1, 0]);

  calls.length = 0;
  await must(h.boards.remove({ ...args, audit }));
  await must(h.boards.restore({ ...args, audit }));
  assert.deepEqual(calls.map((call) => call.kind), ['remove', 'restore']);
});

test('a decision made again after its list was left behind applies nothing twice (P5)', async (t) => {
  const h = await setup(t);
  const fails = { left: 0 };
  const flaky = { ...h.boards, writeProposals: (args) => {
    if (fails.left > 0) { fails.left -= 1; return Promise.resolve(hostFailure('unavailable', 'team_board_unavailable', '', true)); }
    return h.boards.writeProposals(args); } };
  const second = createHostProposals({ boards: flaky, audit: (entry) => h.log.append(entry), batchRefusal: () => null,
    clock: () => h.clock.now, logger: () => {} });
  const decide = (id, action, n) => second.decide({ projectId: P, boardId: h.board.id, proposalId: id, action,
    ...(n === undefined ? {} : { n }), actor: BOB, recheck: allow });
  const textOf = async (n) => (await h.get()).cards[uid(n)].data.text;

  // Additions: the board takes the batch, the list cannot be written twice, the change is still offered.
  const proposal = await h.record(block('append n2 More.', 'note A new idea'));
  fails.left = 2;
  assert.equal(reasonOf(await decide(proposal.id, 'accept_additions')), 'team_board_unavailable');
  const rev = h.diskRev();
  const cards = Object.keys((await h.get()).cards).length;
  assert.equal(await textOf(2), 'Do we keep refresh tokens?\nMore.');
  // The same decision again: the board's journal knows the batch, so nothing is applied and the list is written.
  await must(decide(proposal.id, 'accept_additions'), 'again');
  assert.deepEqual([h.diskRev(), Object.keys((await h.get()).cards).length, await textOf(2)],
    [rev, cards, 'Do we keep refresh tokens?\nMore.'], 'no second append and no second note');
  assert.equal(h.entries().length, 1, 'one accepted batch, one audit entry');
  assert.equal(reasonOf(await decide(proposal.id, 'accept_additions')), 'team_board_proposal_closed');

  // Two decisions of one proposal have two ids: the second is not taken for the first.
  const two = await h.record(block('edit n3 Ship on Monday', 'remove n2'));
  await must(decide(two.id, 'accept', 1), 'edit');
  await must(decide(two.id, 'accept', 2), 'remove');
  const after = await h.get();
  assert.deepEqual([after.cards[uid(3)].data.text, Object.hasOwn(after.cards, uid(2))], ['Ship on Monday', false]);
});
