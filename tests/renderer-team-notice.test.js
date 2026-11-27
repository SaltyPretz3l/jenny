'use strict';

// Someone wants to join (row 123, slice 2a-5a, plan row E40): the app's notice look centred over the
// top of the timeline, one person at a time with "1 of N", Admit and Decline for the person shown,
// Later setting them aside under "Wants to join" in the column. Real modules over the harness bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, DOT, flush, snapshot, memberTeam, hostState, device, ROSTER, harness, layout } = require('./helpers/team-settings-harness');

const waiting = (id, name, created) => ({ member_id: id, display_name: name, role: 'member', state: 'pending',
  devices: [device('device_' + id, name + ' laptop', { member_id: id, created_at: created, fingerprint: '4f2a91c3aa' })] });
const SAM = waiting('member_sam', 'Sam', 10);
const PRIYA = waiting('member_priya', 'Priya', 20);
const LEE = waiting('member_lee', 'Lee', 30);
const active = ROSTER.filter((member) => member.state === 'active');

// The owner of the team hosted here, with `people` waiting; an answered person leaves the roster.
async function openOwner(people, answers = {}) {
  const answered = new Set();
  const h = harness({ show: false, host: hostState(), teams: [snapshot()], answers: {
    members: () => ({ ok: true, members: active.concat(people.filter((p) => !answered.has(p.member_id))) }),
    memberAdmit: (p) => { answered.add(p.member_id); return { ok: true }; },
    memberRevoke: (p) => { answered.add(p.member_id); return { ok: true }; },
    ...answers,
  } });
  layout(h);
  h.showTab();
  await flush();
  return h;
}
const notice = (h) => h.view.q('.team-notice .inv-toast');
// The name is wrapped in direction isolates (U+2068 ... U+2069) inside its sentence.
const shownName = (h) => notice(h).querySelector('.inv-toast__message').textContent.replace(/[⁨⁩]/g, '');
const counter = (h) => notice(h).querySelector('.team-notice__count')?.textContent || '';
const act = (h, name) => notice(h).querySelector(`[data-team-notice="${name}"]`);

test('one person waiting: the app notice with the person, device and key, Admit <name>, Decline and Later', async (t) => {
  const h = await openOwner([SAM]);
  t.after(h.restore);
  const toast = notice(h);
  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.getAttribute('aria-live'), 'polite');
  assert.equal(toast.querySelector('.inv-toast__eyebrow').textContent, 'Wants to join');
  assert.match(shownName(h), /Sam/);
  assert.match(shownName(h), /Sam laptop/);
  assert.match(shownName(h), /4F2A 91C3 AA/);
  assert.match(toast.querySelector('.team-notice__hint').textContent, /They see the same key on their screen\./);
  const admit = toast.querySelector('[data-team-action="admit"]');
  assert.equal(admit.textContent, 'Admit \u2068Sam\u2069', 'the name is isolated in the sentence');
  assert.ok(admit.classList.contains('inv-toast__action--primary'));
  assert.equal(admit.dataset.memberId, 'member_sam');
  assert.equal(toast.querySelector('[data-team-action="decline"]').textContent, 'Decline');
  assert.equal(act(h, 'later').getAttribute('aria-label'), 'Later');
  assert.ok(act(h, 'later').classList.contains('inv-toast__dismiss'));
  assert.equal(counter(h), '', 'no pager for one person');
  assert.equal(h.view.q('[data-team-wants]'), null, 'nobody set aside yet');
  // Tab order: the notice comes right after the channel header and before the timeline.
  const main = h.view.q('.team-main');
  const order = [...main.querySelectorAll('.team-head, .team-notice, .team-scroll')].map((el) => el.className.split(' ')[0]);
  assert.deepEqual(order, ['team-head', 'team-notice', 'team-scroll']);
});

test('the notice never takes focus, and it never times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness({ show: false, host: hostState(), teams: [snapshot()], answers: { members: { ok: true, members: active.concat(SAM) } } });
  t.after(h.restore);
  layout(h);
  const doc = h.window.document;
  h.showTab();
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  const before = doc.activeElement;
  assert.ok(notice(h));
  assert.equal(notice(h).contains(doc.activeElement), false);
  t.mock.timers.tick(600_000);
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  assert.ok(notice(h), 'still there after ten minutes');
  assert.equal(doc.activeElement, before);
});

test('two and three waiting: one notice, one person at a time in the order they asked, with paging', async (t) => {
  const two = await openOwner([PRIYA, SAM]);
  try {
    assert.match(shownName(two), /^Sam/, 'the first to ask is shown first');
    assert.equal(counter(two), '1 of 2');
  } finally {
    two.restore();
  }
  const h = await openOwner([LEE, SAM, PRIYA]);
  t.after(h.restore);
  assert.equal(h.view.qa('.team-notice .inv-toast').length, 1);
  assert.equal(counter(h), '1 of 3');
  act(h, 'next').click();
  assert.equal(counter(h), '2 of 3');
  assert.match(shownName(h), /^Priya/);
  assert.equal(notice(h).querySelector('[data-team-action="admit"]').textContent, 'Admit \u2068Priya\u2069');
  act(h, 'prev').click();
  act(h, 'prev').click();
  assert.equal(counter(h), '3 of 3', 'previous wraps');
  assert.match(shownName(h), /^Lee/);
  act(h, 'next').click();
  act(h, 'next').click();
  notice(h).querySelector('[data-team-action="admit"]').click();
  await flush();
  assert.deepEqual(h.sent('memberAdmit').map((call) => call.payload), [{ team_id: TEAM, member_id: 'member_priya' }], 'Admit answers only the person shown');
  assert.equal(counter(h), '2 of 2');
  assert.match(shownName(h), /^Lee/);
  notice(h).querySelector('[data-team-action="decline"]').click();
  assert.equal(h.sent('memberRevoke').length, 0, 'Decline asks first');
  assert.match(notice(h).textContent, /Their invite is used up/);
  notice(h).querySelector('[data-team-action="confirm-decline"]').click();
  await flush();
  assert.deepEqual(h.sent('memberRevoke').map((call) => call.payload), [{ team_id: TEAM, member_id: 'member_lee' }]);
  assert.match(shownName(h), /^Sam/);
  assert.equal(counter(h), '');
});

test('Later sets the person shown aside under "Wants to join" in the column, with their own Admit and Decline', async (t) => {
  const h = await openOwner([SAM, PRIYA]);
  t.after(h.restore);
  act(h, 'later').click();
  assert.match(shownName(h), /^Priya/);
  assert.equal(counter(h), '');
  const wants = h.view.q('[data-team-wants]');
  assert.match(wants.querySelector('.team-panel__label').textContent, /Wants to join\s*1/);
  assert.match(wants.querySelector('.team-set-person').textContent, /Sam/);
  const panel = h.view.q('nav.team-panel [data-team-region="lists"]'); // the column's lists (its slot since 2a-6b)
  const kids = [...panel.children];
  assert.ok(kids.indexOf(wants) < kids.indexOf(panel.querySelector('.team-people')), 'above the people lists');
  act(h, 'later').click();
  assert.equal(notice(h), null, 'everyone set aside: no notice');
  assert.equal(h.view.qa('[data-team-wants] .team-set-person').length, 2);
  wants.ownerDocument.querySelector('[data-team-wants] [data-team-action="admit"][data-member-id="member_sam"]').click();
  await flush();
  assert.deepEqual(h.sent('memberAdmit').map((call) => call.payload), [{ team_id: TEAM, member_id: 'member_sam' }]);
  assert.equal(h.view.qa('[data-team-wants] .team-set-person').length, 1);
});

test('a failed Admit keeps the person in the notice and says why there', async (t) => {
  const h = await openOwner([SAM], { memberAdmit: { ok: false, error: { code: 'invalid_request', reason: 'team_member_limit' } } });
  t.after(h.restore);
  notice(h).querySelector('[data-team-action="admit"]').click();
  await flush();
  assert.match(shownName(h), /^Sam/);
  assert.match(notice(h).querySelector('.team-notice__error').textContent, /The team is full/);
  assert.equal(notice(h).querySelector('[data-team-action="admit"]').disabled, false);
  assert.equal(/team_member_limit/.test(h.view.text()), false);
});

for (const [name, options] of [
  ['a member of the team hosted here', { host: hostState(), teams: [snapshot({ role: 'member', member_id: DOT })] }],
  ['a member of a team hosted elsewhere', { teams: [memberTeam()] }],
  ['an owner whose server is not running here', { teams: [snapshot()] }],
]) {
  test(`${name} never sees the notice, even when the roster carries someone waiting`, async (t) => {
    const h = harness({ show: false, ...options, answers: { members: { ok: true, members: active.concat(SAM) } } });
    t.after(h.restore);
    layout(h);
    h.showTab();
    await flush();
    assert.equal(notice(h), null);
    assert.equal(h.view.q('[data-team-action="admit"]'), null);
  });
}

test('F6 moves between the column, the notice, the timeline and the composer', async (t) => {
  const h = await openOwner([SAM]);
  t.after(h.restore);
  const doc = h.window.document;
  const f6 = (shift = false) => doc.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'F6', shiftKey: shift, bubbles: true, cancelable: true }));
  h.view.q('[data-team-channel]').focus();
  f6();
  assert.ok(h.view.q('.team-notice').contains(doc.activeElement), 'to the notice');
  f6();
  assert.ok(h.view.q('.team-scroll').contains(doc.activeElement) || doc.activeElement === h.view.q('.team-scroll'), 'to the timeline');
  f6();
  assert.equal(doc.activeElement, h.view.q('.team-composer__input'), 'to the composer');
  f6();
  assert.ok(h.view.q('nav.team-panel').contains(doc.activeElement), 'back to the column');
  f6(true);
  assert.equal(doc.activeElement, h.view.q('.team-composer__input'), 'Shift+F6 goes back');
});

// ---------------------------------------------------------- review round (2a-5a)

test('Admit cannot be sent twice: the button stays busy until the roster refresh is in', async (t) => {
  const answered = new Set();
  let release = null;
  let hold = false;
  const roster = () => ({ ok: true, members: active.concat([SAM, PRIYA].filter((p) => !answered.has(p.member_id))) });
  const h = await openOwner([SAM, PRIYA], {
    members: () => (hold ? new Promise((done) => { release = () => done(roster()); }) : roster()),
    memberAdmit: (p) => { answered.add(p.member_id); return { ok: true }; },
  });
  t.after(h.restore);
  hold = true;
  notice(h).querySelector('[data-team-action="admit"]').click();
  await flush();
  assert.equal(h.sent('memberAdmit').length, 1);
  const again = notice(h).querySelector('[data-team-action="admit"]');
  assert.equal(again.dataset.memberId, 'member_sam', 'the refresh is still out');
  again.click();
  await flush();
  assert.equal(h.sent('memberAdmit').length, 1, 'no second call');
  assert.equal(notice(h).querySelector('.team-notice__error'), null);
  hold = false;
  release();
  await flush();
  assert.match(shownName(h), /^Priya/);
  assert.equal(notice(h).querySelector('[data-team-action="admit"]').disabled, false);
});

test('a person set aside with Later stays aside after a roster refresh', async (t) => {
  const h = await openOwner([SAM, PRIYA]);
  t.after(h.restore);
  act(h, 'later').click();
  notice(h).querySelector('[data-team-action="admit"]').click(); // Priya: the roster is read again
  await flush();
  assert.ok(h.sent('members').length >= 2, 'the roster was read again');
  assert.equal(notice(h), null);
  assert.deepEqual(h.view.qa('[data-team-wants] .team-set-person').map((row) => row.querySelector('.team-set-person__name').textContent), ['Sam']);
});
