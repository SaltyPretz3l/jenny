'use strict';

/* services/chat-messaging-mail-turns.js: the turns that took another chat's mail (row 87) and whether
 * that mail was only reports from chats the turn's own chat started (row 76, owner 2026-11-10). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_TRACKED_TURNS, createMailTurns } = require('../services/chat-messaging-mail-turns');

const row = (kind, source, destination = 'sess_p') => ({ session_message: { kind, source_session_id: source, destination_session_id: destination } });
const summaries = { sess_child: { spawned_from: { parent_session_id: 'sess_p' } }, sess_other: { spawned_from: null } };

test('own-child reports only: report kind, a chat this one started, addressed to this one', () => {
  const turns = createMailTurns({ getSessionSummary: (id) => summaries[id] || null });
  turns.note('t_own', [row('terminal_report', 'sess_child')]);
  turns.note('t_msg', [row('agent_message', 'sess_child')]);
  turns.note('t_stranger', [row('terminal_report', 'sess_other')]);
  turns.note('t_unknown', [row('terminal_report', 'sess_gone')]);
  turns.note('t_elsewhere', [row('terminal_report', 'sess_child', 'sess_x')]);
  turns.note('t_empty', []);
  turns.note('t_junk', [null, { session_message: null }]);
  const ids = ['t_own', 't_msg', 't_stranger', 't_unknown', 't_elsewhere', 't_empty', 't_junk', 't_none'];
  assert.deepEqual(ids.map((id) => turns.ownChildReports(id)), [true, false, false, false, false, false, false, false]);
  assert.deepEqual(ids.map((id) => turns.has(id)), [true, true, true, true, true, true, true, false]);
});

test('sticky false: other mail in a turn is never cleared by later own reports', () => {
  const turns = createMailTurns({ getSessionSummary: (id) => summaries[id] || null });
  turns.note('t', [row('terminal_report', 'sess_child')]);
  turns.note('t', [row('terminal_report', 'sess_child')]);
  assert.equal(turns.ownChildReports('t'), true);
  turns.note('t', [row('user_message', 'sess_other')]);
  turns.note('t', [row('terminal_report', 'sess_child')]);
  assert.equal(turns.ownChildReports('t'), false);
});

test('a throwing summary fails closed; bad turn ids are ignored; the newest turns are kept', () => {
  const throwing = createMailTurns({ getSessionSummary: () => { throw new Error('boom'); } });
  throwing.note('t', [row('terminal_report', 'sess_child')]);
  assert.equal(throwing.ownChildReports('t'), false);
  assert.equal(throwing.has('t'), true);
  const turns = createMailTurns();
  turns.note('');
  turns.note(null);
  assert.equal(turns.size, 0);
  for (let index = 0; index <= MAX_TRACKED_TURNS; index += 1) turns.note(`t${index}`);
  assert.equal(turns.size, MAX_TRACKED_TURNS);
  assert.equal(turns.has('t0'), false, 'the oldest falls out');
  assert.equal(turns.has(`t${MAX_TRACKED_TURNS}`), true);
});
