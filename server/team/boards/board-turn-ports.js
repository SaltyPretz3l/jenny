'use strict';

// Team boards T5 (row 151, plan PROJECT_BOARD_2026-11-13 section 8.5): a turn sent from beside a team board.
//
// The desktop's chain is used as it is (services/boards/board-turn-stamp.js checks the stamp, board-turn-context.js
// builds the board section, board-proposal-turn.js reads the reply). It asks the backend for three things, and on a
// team host this module is what answers:
//
//   getBoardService(sessionId)   the boards of that conversation's own team project, and no other: `list` answers
//                                only for that project and `get` reads only (that project, board id). A conversation
//                                in no team project gets no board service, so its stamp is dropped as `disabled`.
//   boardProposals.record(...)   stores the proposal on the board of the conversation's project, under the member
//                                who sent the turn. There is no `applyAuto`: nothing is applied without a member.
//   boardTurnsEnabled            tells the session runtime to read a completed turn's reply for `board` blocks.
//
// So the board section of a turn is built by the host from its own copy. Nothing a member sends is board text:
// `chat.send` carries a board id only (its schema is closed), and `admitChat` accepts that id only as (the
// conversation's project, board id), for a sender the one authorization function lets read that project's boards.
// Anything else is the store's "not found".

const { isBoardId } = require('../../../services/boards/board-ids');
const { memberAuthor } = require('../../../services/backend/message-author');
const { routeDenial } = require('../route-guard');
const { safeLogger } = require('../safe-logger');
const { isTeamProjectId } = require('./board-host-files');
const { answers } = require('./board-host-load');

const READ_ACTION = 'board.read';

/**
 * boards: the host board store. proposals: board-proposals-host.js. sessionProject(id): the project a conversation is
 * in, or null. Answers { admitChat(command, context), attach(backend) }.
 */
function createBoardTurnPorts({ boards, proposals, sessionProject, logger = null } = {}) {
  if (!boards || typeof boards.get !== 'function' || typeof boards.list !== 'function') {
    throw new TypeError('createBoardTurnPorts requires the board store.');
  }
  if (!proposals || typeof proposals.record !== 'function' || typeof sessionProject !== 'function') {
    throw new TypeError('createBoardTurnPorts requires the proposals and sessionProject.');
  }
  const log = safeLogger(logger);

  function teamProjectOf(sessionId) {
    let projectId;
    try { projectId = sessionProject(sessionId); } catch { projectId = null; }
    return isTeamProjectId(projectId) ? projectId : null;
  }

  // `chat.send` with a board id: { ok: true, boardId } or the refusal. The caller (the router) has authorized the
  // sender to write in the conversation; this adds the board's own row.
  async function admitChat(command, context) {
    const boardId = command?.params?.board_id;
    const projectId = teamProjectOf(command?.session_id);
    if (!projectId || !isBoardId(boardId)) return answers.NOT_FOUND();
    const denied = routeDenial({ guard: context?.guard, requestId: command.request_id }, READ_ACTION,
      { kind: 'project', id: projectId }, { guardRequired: true });
    if (denied) return denied;
    const got = await boards.get({ projectId, boardId });
    if (got?.ok !== true) return answers.NOT_FOUND();
    return { ok: true, boardId };
  }

  function boardServiceFor(sessionId) {
    const projectId = teamProjectOf(sessionId);
    if (!projectId) return null;
    return {
      list: async (args) => {
        if (args?.projectId !== projectId) return { ok: false, reason: 'not_found' };
        const listed = await boards.list({ projectId });
        return listed?.ok === true ? { ok: true, boards: listed.boards } : { ok: false, reason: 'io' };
      },
      get: async (args) => {
        const got = await boards.get({ projectId, boardId: args?.boardId });
        return got?.ok === true ? { ok: true, board: got.board, readOnly: got.read_only === true } : { ok: false, reason: 'not_found' };
      },
    };
  }

  // The member who sent the newest user message of the conversation, when that message is stamped with this board.
  function prompterOf(backend, sessionId, boardId) {
    try {
      const store = backend.sessionStore;
      const messages = typeof store.peekSessionMessages === 'function' ? store.peekSessionMessages(sessionId)
        : store.getSession(sessionId)?.messages;
      const sent = (messages || []).findLast((row) => row?.role === 'user');
      return sent?.board_id === boardId ? memberAuthor(sent.author?.member_id)?.member_id ?? null : null;
    } catch {
      return null;
    }
  }

  // Hands the backend its three ports. Answers the function that takes them back.
  function attach(backend) {
    if (!backend || typeof backend !== 'object') throw new TypeError('attach requires the backend.');
    const ports = {
      getBoardService: (sessionId) => boardServiceFor(sessionId),
      boardProposals: Object.freeze({
        record: async (args) => {
          const projectId = teamProjectOf(args?.sessionId);
          const prompter = projectId ? prompterOf(backend, args.sessionId, args.boardId) : null;
          if (!prompter) {
            log('INFO', 'team_board.proposal_not_recorded', { reason: projectId ? 'no_prompter' : 'no_project' });
            return { ok: false, reason: 'invalid' };
          }
          return proposals.record({ projectId, boardId: args.boardId, sessionId: args.sessionId, messageId: args.messageId,
            text: args.text, sentWhole: args.sentWhole, prompter });
        },
      }),
      boardTurnsEnabled: true,
    };
    Object.assign(backend, ports);
    return () => { for (const key of Object.keys(ports)) if (backend[key] === ports[key]) delete backend[key]; };
  }

  return Object.freeze({ admitChat, attach });
}

module.exports = { createBoardTurnPorts };
