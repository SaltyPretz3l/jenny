'use strict';

/**
 * services/boards/board-proposal-turn.js: when a turn sent from a board's docked chat ends, its reply is
 * read once for `board` blocks (plan PROJECT_BOARD_2026-11-13 sections 7.1 and 7.5; slice C3).
 *
 * Called by the session runtime's chat adapter after a turn COMPLETED; a cancelled or failed reply is
 * never handed here. A block proposes something only when all of this holds, and is inert otherwise:
 *   - the turn carried the board section: `boardTurnRecord` has a record for this chat whose stream id is
 *     this turn's (an unstamped turn, a turn on the Chat page and a turn resumed after a restart have none);
 *   - the newest user message of the chat is stamped with that same board;
 *   - the reply has a closed `board` block (board-proposals.js reads it; an unclosed fence is ignored).
 * Never throws: a reply that cannot be read proposes nothing.
 *
 * Full auto (slice C4, plan 7.5): the additions of the proposal just stored are applied at once when the
 * existing gate says so for this turn (full-auto-gate.js: auto-run was captured when the turn started AND
 * Full auto is still armed, in a safety mode that allows it). The gate is asked first, in the caller's own
 * tick, because the turn's authority is closed as soon as the adapter returns. Arming Full auto while the
 * turn runs changes nothing: the captured authority does not change. Edits and removals always wait for a
 * person (D16), and a reply recorded a second time is never applied again.
 */

const { boardTurnRecord } = require('./board-turn-context');
const { fullAutoApproves } = require('../backend/full-auto-gate');

const AUTO_SCOPE = 'board_additions'; // what the gate is asked about; it only refuses `exit_plan_mode` by name

function replyAfterStampedTurn(messages, boardId) {
  const list = Array.isArray(messages) ? messages : [];
  let start = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user') { start = i; break; }
  }
  if (start < 0 || list[start].board_id !== boardId) return null;
  const replies = list.slice(start + 1).filter((message) => message && message.role === 'assistant'
    && typeof message.content === 'string' && message.content.trim() !== '' && message.id);
  if (!replies.length) return null;
  return { text: replies.map((message) => message.content).join('\n\n'), messageId: String(replies[replies.length - 1].id) };
}

async function readBoardReply(service, { sessionId, streamId, executionAuthority } = {}) {
  let auto;
  try { auto = fullAutoApproves(service, { toolName: AUTO_SCOPE, sessionId, executionAuthority }) === true; } catch (_error) { auto = false; }
  try {
    const proposals = service && service.boardProposals;
    if (!proposals || typeof proposals.record !== 'function' || !sessionId || !streamId) return null;
    const record = boardTurnRecord(service, sessionId);
    if (!record || !record.streamId || record.streamId !== String(streamId)) return null;
    const session = service.sessionStore.getSession(sessionId);
    const reply = replyAfterStampedTurn(session && session.messages, record.boardId);
    if (!reply || reply.text.toLowerCase().indexOf('board') < 0) return null;
    const result = await proposals.record({ boardId: record.boardId, sessionId: String(sessionId), messageId: reply.messageId,
      text: reply.text, sentWhole: record.sentWhole });
    if (!result || result.ok !== true) return null;
    const fresh = result.duplicate !== true && result.proposal && result.proposal.counts && result.proposal.counts.additions > 0;
    if (auto && fresh && typeof proposals.applyAuto === 'function') {
      const applied = await proposals.applyAuto({ boardId: record.boardId, proposalId: result.proposal.id });
      if (applied && applied.ok === true) return applied.proposal;
    }
    return result.proposal;
  } catch (_error) {
    return null;
  }
}

module.exports = { readBoardReply, replyAfterStampedTurn };
