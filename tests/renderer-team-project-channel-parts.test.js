'use strict';

// new-test-file: the conversation parts' small controllers (copy, approvals, history; fixes T3, T7, T8) have no unit suite, and
// tests/renderer-team-project-channel.test.js would pass its 600-line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const parts = require('../renderer/team/renderer-team-project-conversation-parts');

const dom = new JSDOM('<!doctype html><body></body>');

test('createCopy: two quick clicks put back the original label and icon; a missing or refusing clipboard says the menu\'s sentence (T3)', async () => {
  const mk = () => { dom.window.document.body.innerHTML = '<button aria-label="Copy message"><svg id="orig"></svg></button>'; return dom.window.document.body.firstElementChild; };
  const timers = new Map();
  let next = 0;
  const fake = { set: (fn) => { timers.set(++next, fn); return next; }, clear: (id) => timers.delete(id) };
  const ok = parts.createCopy({ timers: fake, view: { jennyShell: { clipboard: { writeText: async () => {} } } } });
  const button = mk();
  await Promise.all([ok.copy(button, 'x'), ok.copy(button, 'x')]);
  assert.equal(button.getAttribute('aria-label'), 'Copied');
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual([button.getAttribute('aria-label'), Boolean(button.querySelector('#orig'))], ['Copy message', true]);
  const said = [];
  for (const view of [{}, { jennyShell: { clipboard: { writeText: async () => { throw new Error('no'); } } } }]) {
    const bad = parts.createCopy({ timers: fake, view, say: (text) => said.push(text) });
    const el = mk();
    await bad.copy(el, 'x');
    assert.equal(el.getAttribute('aria-label'), 'The message could not be copied.');
  }
  assert.deepEqual(said, ['The message could not be copied.', 'The message could not be copied.']);
});

const approvalsOver = (getShot) => parts.createApprovals({ snapshot: getShot, send: async () => ({ ok: false, error: {} }), me: () => 'me', mayAnswer: () => true, youOr: (id) => id, nameOf: (id) => id,
  errorText: () => 'Refused.', timeText: () => '9:00', cardHtml: (a, st) => st.note, receiptHtml: () => '', outcomeHtml: () => '', acted() {}, redraw() {}, rules: async () => null, sessionId: 's', projectName: () => 'P', offersAllow: () => true });

test('a refused approval answer keeps its sentence across a snapshot that still lists the approval, and drops it when the approval is gone or changed (T7)', async () => {
  const listed = (rev) => ({ pending_approvals: [{ approval_id: 'a1', stream_id: 's1', decision_revision: rev }] });
  let shot = listed(3);
  const approvals = approvalsOver(() => shot);
  const refuse = () => approvals.decide({ dataset: { approvalId: 'a1', action: 'approve' } });
  await refuse();
  assert.equal(approvals.cardsHtml(), 'Refused.');
  approvals.taken(listed(3));
  assert.equal(approvals.cardsHtml(), 'Refused.', 'the same approval, the same revision: the sentence stays');
  shot = listed(4);
  approvals.taken(shot);
  assert.equal(approvals.cardsHtml(), '', 'a changed revision drops it');
  shot = listed(4);
  await refuse();
  approvals.taken({ pending_approvals: [] });
  approvals.taken(shot);
  assert.equal(approvals.cardsHtml(), '', 'an approval that was gone drops it for good');
});

test('an older page that returns after a gap snapshot is dropped, not joined with a hole (T8)', async () => {
  const msg = (id) => ({ id, role: 'user', content: id });
  let release;
  const history = parts.createHistory({ cap: 400, read: () => new Promise((resolve) => { release = resolve; }), errorText: () => '' });
  history.take({ messages: [msg('m5'), msg('m6')], has_more: true, next_before_message_id: 'm5' });
  const reading = history.earlier();
  history.take({ messages: [msg('m20'), msg('m21')], has_more: true, next_before_message_id: 'm20' });
  release({ ok: true, snapshot: { messages: [msg('m3'), msg('m4')], has_more: false } });
  assert.equal(await reading, true);
  assert.deepEqual(history.messages().map((m) => m.id), ['m20', 'm21']);
  assert.equal(history.more(), true, 'the gap snapshot\'s own cursor still stands');
});

test('history.hidden() is true only when the cap cut older messages the host still has (F2)', () => {
  const many = (from, n) => Array.from({ length: n }, (_, i) => ({ id: 'm' + (from + i), role: 'user', content: 'x' }));
  const history = parts.createHistory({ cap: 4, read: async () => null, errorText: () => '' });
  history.take({ messages: many(1, 3), has_more: false });
  assert.equal(history.hidden(), false);
  history.take({ messages: many(3, 4), has_more: true, next_before_message_id: 'm3' });
  assert.equal(history.hidden(), true);
});
