'use strict';

// new-test-file: tests/team-board-ipc.test.js, the file of the member-side board answers, is at the 600-line cap.
// Row 151 slice T9: the host's answer to `team.board.history` as a member's Jenny rebuilds it for the page
// (services/team/board-proposal-answers.js `historyAnswer`): field by field, anything else is `team_response_invalid`.

const assert = require('node:assert/strict');
const test = require('node:test');

const { historyAnswer } = require('../services/team/board-proposal-answers');

const AT = '2026-11-15T10:42:00.000Z';
const change = (more = {}) => ({ rev: 4, actor: 'member_a', at: AT, kind: 'change', of_rev: null, ops: { 'card.remove': 23, 'connector.remove': 31 },
  takeable: true, reverted: false, ...more });

test('the history answer is rebuilt field by field, and what the host adds is dropped', () => {
  const revert = change({ rev: 5, kind: 'revert', of_rev: 4, ops: { 'card.add': 23 } });
  const old = change({ rev: 2, kind: 'proposal', ops: null, takeable: false, reverted: true });
  const answer = { ok: true, rev: 5, changes: [{ ...revert, text: 'Secret plan' }, change(), old], extra: 1 };
  assert.deepEqual(historyAnswer(answer), { ok: true, rev: 5, changes: [revert, change(), old] });
  assert.deepEqual(historyAnswer({ ok: true, rev: 0, changes: [] }), { ok: true, rev: 0, changes: [] });
});

test('one bad value refuses the whole history answer', () => {
  const bad = [{ rev: 0 }, { rev: 1.5 }, { rev: '4' }, { actor: '' }, { actor: 7 }, { actor: 'm'.repeat(161) }, { at: 'today' }, { at: 7 },
    { kind: 'undo' }, { kind: 7 }, { of_rev: 0 }, { of_rev: '3' }, { of_rev: undefined }, { ops: [] }, { ops: 'card.add' }, { ops: { 'card.add': 0 } },
    { ops: { 'card.add': 1.5 } }, { ops: { __proto__: null, constructor: 1 } }, { ops: { 'CARD.add': 1 } }, { ops: { 'card.add<b>': 1 } },
    { ops: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`card.x${'a'.repeat(i % 10)}${String.fromCharCode(97 + (i % 26))}${i > 25 ? 'z' : ''}`, 1])) },
    { takeable: 1 }, { reverted: null }];
  for (const more of bad) {
    assert.equal(historyAnswer({ ok: true, rev: 5, changes: [change(), change(more)] }).error?.reason, 'team_response_invalid', JSON.stringify(more));
  }
  for (const answer of [{ ok: true, rev: 5 }, { ok: true, rev: -1, changes: [] }, { ok: true, rev: 5, changes: {} }, { ok: true, rev: 5, changes: [null] },
    { ok: true, rev: 5, changes: Array.from({ length: 201 }, (_, i) => change({ rev: i + 1 })) }]) {
    assert.equal(historyAnswer(answer).error?.reason, 'team_response_invalid');
  }
  assert.equal(historyAnswer({ ok: true, rev: 200, changes: Array.from({ length: 200 }, (_, i) => change({ rev: i + 1 })) }).changes.length, 200);
});
