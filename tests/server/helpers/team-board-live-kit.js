'use strict';

// Row 151 slices T4 and T5: the team host with two projects and their boards, for the presence and the turn tests.
//
// Project X: Alice admin, Carl writer, Rae (a read-only team member) reader. Project Y: Bob admin, Carl reader.
// Each has one live board (`live`) holding one note (`note`) and one board in the trash (`gone`). `sX`, `sY` and
// `sG` are conversations in X, in Y and in no project.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { dataFrames } = require('./session-scope-fixture');
const { batch, must, tree } = require('./team-board-kit');
const { createTeamProjectFixture } = require('./team-project-fixture');

const UNKNOWN_BOARD = 'board_00000000-0000-4000-8000-00000000dead';
const block = (...lines) => ['Here is my proposal.', '```board', ...lines, '```', ''].join('\n');

async function until(condition, what) {
  for (let tries = 0; tries < 5000; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function setupBoards(t, options = {}) {
  const h = await createTeamProjectFixture(t, { boards: true, ...options });
  const id = (who) => h.seats[who].member_id;
  const x = await h.sharedProject('Apollo');
  const y = (await h.ok(h.send('bob', 'team.project.create', { name: 'Zephyr' }), 'create y')).project_id;
  await h.ok(h.send('bob', 'team.project.members.add', { project_id: y, member_id: id('carl'), role: 'reader' }), 'add carl');
  const boards = h.state.boards;
  const seed = async (projectId, admin, text) => {
    const live = (await must(boards.create({ projectId, actor: admin, name: 'Roadmap' }))).board.id;
    const gone = (await must(boards.create({ projectId, actor: admin, name: 'Old plan' }))).board.id;
    await must(boards.remove({ projectId, boardId: gone, actor: admin }));
    const note = crypto.randomUUID();
    await must(boards.apply({ projectId, boardId: live, actor: admin,
      batch: batch({ op: 'card.add', card: { id: note, kind: 'note', x: 0, y: 0, data: { text } } }) }));
    return { id: projectId, live, gone, note, admin };
  };
  const X = await seed(x, id('alice'), 'The plan of project X');
  const Y = await seed(y, id('bob'), 'The plan of project Y');
  const sessions = h.backend.sessionStore;
  const session = (title, projectId) => {
    const made = sessions.createSession({ title });
    if (projectId) assert.ok(sessions.updateSession(made.id, { project_id: projectId }));
    return made.id;
  };
  const root = path.join(fs.realpathSync.native(h.config.userDataPath), 'team-boards');
  // The call's refusal reason, with proof that the board files did not change.
  const refused = async (call, where) => {
    const before = tree(root);
    const answer = await call();
    assert.equal(answer.ok, false, `${where}: ${JSON.stringify(answer).slice(0, 300)}`);
    assert.deepEqual(tree(root), before, `${where} changed the disk`);
    return answer.error.reason;
  };
  const at = (p, extra = {}) => ({ project_id: p.id, board_id: p.live, ...extra });
  const board = async (p) => (await must(boards.get({ projectId: p.id, boardId: p.live }))).board;
  const frames = (response, type) => dataFrames(response.frames).filter((frame) => frame.event_type === type)
    .map(({ event_type: _type, api_version: _version, boot_epoch: _boot, cursor: _cursor, ...rest }) => rest);
  const audit = (p) => h.approvals.audit().read({ projectId: p.id }).entries.filter((entry) => entry.board_id !== null);
  return { h, id, X, Y, boards, host: h.state.boardHost, root, refused, at, board, frames, audit, session,
    sX: session('In X', x), sY: session('In Y', y), sG: session('General') };
}

module.exports = { UNKNOWN_BOARD, block, setupBoards, until };
