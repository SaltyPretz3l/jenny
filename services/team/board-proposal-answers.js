'use strict';

// Team boards on a member's Jenny (row 151 slice T5): the host's answers about Jenny's proposals and about a
// reverted batch, rebuilt field by field before the renderer sees them.
//
// A proposal has the desktop's own shape (services/boards/board-proposals.js `publicProposal`) and one more field,
// `prompterMemberId`: the member whose turn produced it. `auto` is always null: a team board has no Full auto.
// One value that fails its check refuses the whole answer as `team_response_invalid`; a field the host adds is
// dropped. This module is checks only: it sends nothing and keeps nothing.

const model = require('../boards/board-model');
const { isId, isSessionId } = require('../../server/team/ids');
const { teamFailure } = require('./team-errors');

const ID_MAX = 500;
const TEXT_MAX = 8192;
const KEYS_MAX = 12;
const CHANGES_MAX = 1024;
const WORD = /^[a-z][a-z0-9_]{0,79}$/u;
const KEY = /^[a-z][A-Za-z0-9_]{0,39}$/u;

const invalid = () => teamFailure('CONNECTION_FAILED', 'team_response_invalid');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isText = (value, max = TEXT_MAX) => typeof value === 'string' && value.length <= max;
const isWord = (value) => typeof value === 'string' && WORD.test(value);

// A small flat object: at most KEYS_MAX plain keys, each value passing `test`. Null when it is anything else.
function flat(value, test) {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > KEYS_MAX || !keys.every((key) => KEY.test(key) && test(value[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

const shown = (value) => isText(value) || Number.isFinite(value) || typeof value === 'boolean';

function changeOf(value) {
  if (!isObject(value) || !Number.isSafeInteger(value.n) || value.n < 1 || !isText(value.line)) return null;
  if (!isWord(value.type) || !isWord(value.class) || !isWord(value.state)) return null;
  if (value.reason !== '' && !isWord(value.reason)) return null;
  const summary = flat(value.summary, shown);
  return summary ? { n: value.n, line: value.line, type: value.type, class: value.class, state: value.state,
    reason: value.reason, summary } : null;
}

// Where an accepted addition would land: numbers only, a kind word and ids the page compares, never reads as markup.
function placed(value, text, words) {
  if (!isObject(value) || !Number.isSafeInteger(value.n) || value.n < 1) return null;
  if (!['x', 'y', 'w', 'h'].every((key) => Number.isFinite(value[key]))) return null;
  if (!text.every((key) => isText(value[key], ID_MAX)) || !words.every((key) => isWord(value[key]))) return null;
  return Object.fromEntries(['n', 'x', 'y', 'w', 'h', ...text, ...words].map((key) => [key, value[key]]));
}

function listOf(value, max, one) {
  if (!Array.isArray(value) || value.length > max) return null;
  const out = value.map(one);
  return out.includes(null) ? null : out;
}

function previewOf(value) {
  if (value === null || value === undefined) return { preview: null };
  if (!isObject(value)) return null;
  const cards = listOf(value.cards, model.LIMITS.cards, (card) => placed(card, ['groupId'], ['kind']));
  const groups = listOf(value.groups, model.LIMITS.groups, (group) => placed(group, ['id'], []));
  return cards && groups ? { preview: { cards, groups } } : null;
}

function proposalOf(value) {
  if (!isObject(value) || !isText(value.id, ID_MAX) || value.id.length === 0 || !isSessionId(value.sessionId)) return null;
  if (!isText(value.messageId, ID_MAX) || !isWord(value.state) || typeof value.open !== 'boolean') return null;
  if (!isText(value.createdAt, 40) || !isCount(value.madeAgainstRev) || !isCount(value.overflow)) return null;
  if (value.prompterMemberId !== null && !isId('member', value.prompterMemberId)) return null;
  const counts = flat(value.counts, isCount);
  const changes = listOf(value.changes, CHANGES_MAX, changeOf);
  const preview = previewOf(value.preview);
  if (!counts || !changes || !preview) return null;
  return { id: value.id, sessionId: value.sessionId, messageId: value.messageId, state: value.state, open: value.open,
    createdAt: value.createdAt, madeAgainstRev: value.madeAgainstRev, overflow: value.overflow, counts, auto: null, changes,
    preview: preview.preview, prompterMemberId: value.prompterMemberId };
}

/** `team.board.proposal.list`: { ok, proposals } newest first. */
function proposalsAnswer(answer) {
  const proposals = listOf(answer.proposals, model.LIMITS.proposals, proposalOf);
  return proposals ? { ok: true, proposals } : invalid();
}

/** `team.board.proposal.accept` and `.reject`: the proposal as it is now, and how many changes were applied and skipped. */
function decisionAnswer(answer) {
  const proposal = proposalOf(answer.proposal);
  return proposal && isCount(answer.applied) && isCount(answer.skipped)
    ? { ok: true, proposal, applied: answer.applied, skipped: answer.skipped } : invalid();
}

/** `team.board.revert`: the new rev, and how many operations were written back and skipped. */
function revertAnswer(answer) {
  return Number.isSafeInteger(answer.rev) && answer.rev >= 1 && isCount(answer.reverted) && isCount(answer.skipped)
    ? { ok: true, rev: answer.rev, reverted: answer.reverted, skipped: answer.skipped } : invalid();
}

// `team.board.history` (slice T9): the board's changes, newest first. The host's journal keeps at most 200.
const HISTORY_MAX = 200;
const HISTORY_KINDS = new Set(['change', 'proposal', 'revert']);
const OP_NAME = /^[a-z]{1,16}\.[a-z_]{1,16}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const isRevAbove = (value) => Number.isSafeInteger(value) && value >= 1;

function historyChangeOf(value) {
  if (!isObject(value) || !isRevAbove(value.rev) || !isText(value.actor, 160) || !value.actor || !isText(value.at, 30)
    || !ISO.test(value.at) || !HISTORY_KINDS.has(value.kind) || (value.of_rev !== null && !isRevAbove(value.of_rev))
    || typeof value.takeable !== 'boolean' || typeof value.reverted !== 'boolean') return null;
  let ops = null;
  if (value.ops !== null) {
    if (!isObject(value.ops)) return null;
    const names = Object.keys(value.ops);
    if (names.length > 32 || names.some((name) => !OP_NAME.test(name) || !isRevAbove(value.ops[name]))) return null;
    ops = Object.fromEntries(names.map((name) => [name, value.ops[name]]));
  }
  return { rev: value.rev, actor: value.actor, at: value.at, kind: value.kind, of_rev: value.of_rev, ops,
    takeable: value.takeable, reverted: value.reverted };
}

/** `team.board.history`: the board's rev and its changes in counts, each rebuilt. */
function historyAnswer(answer) {
  const changes = listOf(answer.changes, HISTORY_MAX, historyChangeOf);
  return changes && isCount(answer.rev) ? { ok: true, rev: answer.rev, changes } : invalid();
}

module.exports = { decisionAnswer, historyAnswer, proposalsAnswer, revertAnswer };
