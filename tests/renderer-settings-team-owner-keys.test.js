'use strict';

// new-test-file: renderer-settings-team-section.test.js sits at 594 lines (the ceiling is 600); these cases are a different surface.
// Settings > Team, review fixes (row 201; H20, H23 part 1, OD-7, OD-11): an owner whose own device was revoked can still
// reclaim and remove, a redraw keeps focus on a control with no id, Enter submits a form, the Deploy form gives way to a
// notice where desktop hosting cannot run, and Team chat density is hidden until there is a team. Through the real page,
// store and inventory modules over a stubbed bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, CODE, flush, pushed, snapshot, memberTeam, hostState, NONE, harness } = require('./helpers/team-settings-harness');

const key = (h, el, name) => el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const REVOKED = () => snapshot({ state: 'revoked', label: 'Desk' });

test('H20: the owner whose own device was revoked sees Get back in as the owner and Remove this team, in an owner’s words', async (t) => {
  const h = harness({ host: hostState(), teams: [REVOKED()], answers: { hostRecover: { ok: true, host: hostState() }, removeTeam: { ok: true } } });
  t.after(h.restore);
  await flush();
  assert.ok(h.headings().includes('Get back in as the owner'), 'the reclaim group shows');
  assert.ok(h.q('[data-team-action="recover"]'));
  const remove = h.q('[data-team-joined] [data-team-action="remove-team"]');
  assert.ok(remove, 'the team is listed with Remove this team');
  assert.equal(remove.textContent.trim(), 'Remove this team');
  assert.equal(h.text().includes('People are listed once this Jenny is connected'), false, 'no dead-end People placeholder');
  assert.equal(h.text().includes('ask the owner for a new invite'), false, 'the member’s advice does not fit the owner');
  assert.match(h.q('[data-team-joined]').textContent, /get back in from this PC/i);
  h.click('[data-team-action="recover"]');
  await flush();
  h.click('[data-team-action="confirm-recover"]');
  await flush();
  assert.deepEqual(h.sent('hostRecover').map((c) => c.payload), [{ display_name: 'Olive Owner', label: 'Desk' }]);
  h.click('[data-team-joined] [data-team-action="remove-team"]');
  await flush();
  assert.deepEqual(h.sent('removeTeam').map((c) => c.payload), [{ team_id: TEAM }]);
});

test('a revoked team hosted by someone else keeps the member’s page: no reclaim, the invite advice', async (t) => {
  const h = harness({ host: hostState(), teams: [snapshot(), memberTeam({ state: 'revoked' })] });
  t.after(h.restore);
  await flush();
  assert.equal(h.q('[data-team-action="recover"]'), null);
  assert.match(h.q('[data-team-joined]').textContent, /ask the owner for a new invite/);
});

test('H23: a redraw puts focus back on a button that has no id', async (t) => {
  const h = harness({ host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  await flush();
  const doc = h.window.document;
  const invite = h.q('[data-team-action="invite-create"]');
  assert.equal(invite.id, '', 'the button has no id');
  invite.focus();
  assert.equal(doc.activeElement, invite);
  h.listeners.state({ teams: [snapshot({ team_name: 'Renamed' })] });
  await pushed();
  assert.match(h.text(), /Renamed/, 'the page was redrawn');
  assert.notEqual(doc.activeElement, invite, 'the old node is gone');
  assert.equal(doc.activeElement, h.q('[data-team-action="invite-create"]'), 'focus is on the same control again');
});

test('H23: Enter in the team name and the invite code fields submits their forms', async (t) => {
  const h = harness();
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Olive');
  h.type('#teamPcName', 'Desk');
  h.type('#teamNewName', 'Studio');
  key(h, h.q('#teamNewName'), 'Enter');
  await flush();
  assert.deepEqual(h.sent('hostDeploy').map((c) => c.payload), [{ name: 'Studio', display_name: 'Olive', label: 'Desk' }]);
  h.type('#teamInviteCode', CODE);
  key(h, h.q('#teamInviteCode'), 'Enter');
  await flush();
  assert.equal(h.sent('join').length, 1, 'Enter joins');
});

test('OD-7: where desktop hosting cannot run, the Deploy form is a notice about Windows and the headless server', async (t) => {
  for (const host of [{ ...NONE, desktop_hosting: false }, { ...NONE, reason: 'team_host_platform_unavailable' }]) {
    const h = harness({ host });
    await flush();
    assert.ok(h.headings().includes('Host a team'));
    assert.equal(h.q('#teamNewName'), null, 'no name field');
    assert.equal(h.q('[data-team-action="deploy"]'), null, 'no Deploy');
    assert.match(h.q('[data-team-group="host"]').textContent, /only on Windows for now/);
    assert.match(h.q('[data-team-group="host"]').textContent, /headless server/i);
    h.restore();
  }
  const h = harness({ host: NONE });
  t.after(h.restore);
  await flush();
  assert.ok(h.q('#teamNewName') && h.q('[data-team-action="deploy"]'), 'on Windows the form stays');
});

test('OD-11: Team chat density is hidden until there is a team', async () => {
  for (const [teams, shown] of [[[], false], [[memberTeam()], true]]) {
    const h = harness({ teams });
    await flush();
    assert.equal(Boolean(h.q('[data-settings-field="appearanceTeamDensitySelect"]')), shown, `${teams.length} teams`);
    h.restore();
  }
});
