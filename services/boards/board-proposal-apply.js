'use strict';

/**
 * services/boards/board-proposal-apply.js: the operations for the accepted part of a proposal, built
 * against the board as it stands now (plan PROJECT_BOARD_2026-11-13 section 7.5; slice C3).
 *
 * Pure: it tries the operations on the model (`applyBatch` returns a new board and never touches the
 * one it was given) and reports which changes would apply and which must be skipped, with the reason.
 * The caller applies the returned operations through the board service as ONE batch, so "Accept
 * additions" is one Undo step.
 *
 *   planAdditions(board, changes, { now, makeId }) -> { ops, applied: [n], skipped: [{ n, reason }], board }
 *     `changes` are the pending additions of one proposal, in order. Three parts, in this order:
 *       1. new groups, cards and connections, and `append` (several appends to one note become one edit
 *          of its text as it stands now). A change whose operation the model refuses is skipped and the
 *          rest is tried again, so a connection to a card that was skipped is skipped too. New cards
 *          connected in a chain are laid out as a row first (board-flow-layout.js).
 *       2. `move <card> in <group>`: the card joins the group at a free spot inside it.
 *       3. `tidy`: board-tidy.js on the board as the first two parts leave it.
 *     `board` in the answer is the board the operations lead to (for the ghost preview).
 *   checkTarget(board, change) -> null, or the reason an edit, a redraw or a removal must be skipped:
 *     `gone` (the item is no longer there) or `changed` (it was changed after the proposal was made).
 */

const model = require('./board-model');
const placement = require('./board-placement');
const tidy = require('./board-tidy');
const flow = require('./board-flow-layout');

const hasOwn = Object.prototype.hasOwnProperty;
function own(map, key) { return map && typeof key === 'string' && hasOwn.call(map, key) ? map[key] : undefined; }

function reasonOf(result) {
  const reason = result && typeof result.reason === 'string' ? result.reason : 'invalid';
  if (reason === 'missing_target') return 'gone';
  if (reason === 'stale') return 'changed';
  if (reason === 'limit' && typeof result.limit === 'string') return `limit_${result.limit}`;
  return reason;
}

function attempt(board, ops, context) {
  return model.applyBatch(board, { batch_id: `try-${context.makeId()}`, board_id: board.id, actor: 'owner', ops },
    { now: context.now, authority: true });
}

/** Part 1: [{ ops, owners: [n] }] for the changes that carry operations or an append. */
function firstPart(board, changes, skipped) {
  const units = [];
  const appends = new Map(); // card id -> unit
  for (const change of changes) {
    if (Array.isArray(change.ops)) { units.push({ ops: change.ops, owners: [change.n] }); continue; }
    if (!change.append) continue;
    const card = own(board.cards, change.append.id);
    if (!card || card.kind !== 'note') { skipped.push({ n: change.n, reason: 'gone' }); continue; }
    let unit = appends.get(card.id);
    if (!unit) {
      unit = { ops: [{ op: 'card.edit', id: card.id, content_rev: card.content_rev, data: { text: (card.data && card.data.text) || '' } }], owners: [] };
      appends.set(card.id, unit);
      units.push(unit);
    }
    const data = unit.ops[0].data;
    data.text = data.text ? `${data.text}\n${change.append.text}` : change.append.text;
    unit.owners.push(change.n);
  }
  return units;
}

function planAdditions(board, changes, context) {
  const skipped = [];
  const applied = [];
  let ops = [];
  let current = board;
  let units = firstPart(board, changes, skipped);
  // A refusal names the operation; its change is dropped and the rest is tried again.
  for (let round = 0; units.length && round <= changes.length; round++) {
    let entries = [];
    units.forEach((unit, u) => unit.ops.forEach((op) => entries.push({ op, owner: u })));
    entries = flow.arrange(board, entries, placement.DEFAULT_SIZES);
    const flat = entries.map((entry) => entry.op);
    const ownerAt = entries.map((entry) => entry.owner);
    const result = attempt(board, flat, context);
    if (result.ok) {
      current = result.board;
      ops = flat;
      units.forEach((unit) => applied.push(...unit.owners));
      break;
    }
    const at = Number.isInteger(result.op_index) && result.op_index >= 0 && result.op_index < ownerAt.length ? ownerAt[result.op_index] : units.length - 1;
    units[at].owners.forEach((n) => skipped.push({ n, reason: reasonOf(result) }));
    units = units.filter((_, u) => u !== at);
  }

  const later = (extra, change) => {
    if (!extra.length) { applied.push(change.n); return; }
    if (ops.length + extra.length > model.LIMITS.batch_ops) { skipped.push({ n: change.n, reason: 'too_many' }); return; }
    const result = attempt(current, extra, context);
    if (!result.ok) { skipped.push({ n: change.n, reason: reasonOf(result) }); return; }
    current = result.board;
    ops = ops.concat(extra);
    applied.push(change.n);
  };

  for (const change of changes) {
    if (!change.move) continue;
    const card = own(current.cards, change.move.id);
    const group = own(current.groups, change.move.group_id);
    if (!card || !group) { skipped.push({ n: change.n, reason: 'gone' }); continue; }
    if (card.group_id === group.id) { applied.push(change.n); continue; }
    const others = Object.assign({}, current.cards);
    delete others[card.id];
    const placed = placement.placeNewCards({ cards: others, groups: current.groups },
      [{ id: card.id, kind: card.kind, w: card.w, h: card.h, group_id: group.id }]);
    if (!placed.ok) { skipped.push({ n: change.n, reason: 'invalid' }); continue; }
    const spot = placed.positions[card.id];
    const extra = [{ op: 'group.assign', card_id: card.id, group_id: group.id }, { op: 'card.place', id: card.id, x: spot.x, y: spot.y }];
    const grown = own(placed.grown, group.id);
    if (grown) extra.push({ op: 'group.place', id: group.id, w: grown.w, h: grown.h });
    later(extra, change);
  }

  for (const change of changes) {
    if (!change.tidy) continue;
    const groupId = change.tidy.group_id;
    if (groupId && !own(current.groups, groupId)) { skipped.push({ n: change.n, reason: 'gone' }); continue; }
    const result = tidy.tidyOps(current, groupId ? { groupId } : {});
    if (!result.ok) { skipped.push({ n: change.n, reason: result.reason || 'invalid' }); continue; }
    later(result.ops, change);
  }
  return { ops, applied, skipped, board: current };
}

function checkTarget(board, change) {
  const target = change && change.target;
  if (!target || typeof target.id !== 'string') return 'gone';
  const item = target.group ? own(board.groups, target.id) : own(board.cards, target.id);
  if (!item) return 'gone';
  return item.content_rev === target.content_rev ? null : 'changed';
}

module.exports = { planAdditions, checkTarget, reasonOf };
