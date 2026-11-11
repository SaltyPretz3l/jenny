'use strict';

// Settings > Team (row 123, slice 1g-1), the actions: each control sends the payload
// services/team/ipc-methods.js accepts, once while it is in flight (double clicks,
// a confirm and its row share one busy key); a refused, rejected or empty answer
// shows a sentence and gives the control back; Remove, Make owner, Leave, Reclaim,
// removing this PC or the last device, and Stop with other people connected wait
// for the inline confirm; an invite or device code is shown once, never reaches a
// console call or localStorage, and does not survive leaving the page (or the
// Settings view); a member who is not the owner gets no owner controls; pushes and
// actions re-read the lists one at a time.

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('./helpers/team-settings-harness');

const { TEAM, OTHER, ME, DOT, MAYA, DESK, LAPTOP, CODE, DEVICE_CODE, flush, snapshot, hostState, NONE } = shared;
const device = (id, label, member = ME) => shared.device(id, label, { member_id: member });
const harness = (options = {}) => shared.harness({ host: hostState(), teams: [snapshot()], ...options });

const ownerTeams = [snapshot()];

// ----------------------------------------------------------------- payloads

test('Deploy sends the name and both names, once for a double click, and fails with a sentence that gives the button back', async (t) => {
  let release;
  const h = harness({ host: NONE, teams: [], answers: {
    hostDeploy: () => new Promise((resolve) => { release = resolve; }),
  } });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Olive Owner');
  h.type('#teamPcName', 'Desk');
  h.type('#teamNewName', 'Studio');
  h.click('[data-team-action="deploy"]');
  h.click('[data-team-action="deploy"]');
  await flush();
  assert.equal(h.sent('hostDeploy').length, 1);
  assert.deepEqual(h.sent('hostDeploy')[0].payload, { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(h.q('[data-team-action="deploy"]').disabled, true, 'disabled while in flight');
  release({ ok: false, error: { code: 'CMP-TEAM-0006', reason: 'team_host_platform_unavailable' } });
  await flush();
  assert.match(h.text(), /This PC cannot host a team yet/);
  assert.equal(h.q('[data-team-action="deploy"]').disabled, false, 'the button is given back');
  assert.equal(h.q('#teamNewName').value, 'Studio', 'the page stays usable with what was typed');
});

test('Deploy refuses an empty or too long name in the page without a call', async (t) => {
  const h = harness({ host: NONE, teams: [] });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'x'.repeat(41));
  h.type('#teamPcName', 'Desk');
  h.type('#teamNewName', '');
  h.click('[data-team-action="deploy"]');
  await flush();
  assert.equal(h.sent('hostDeploy').length, 0);
  assert.match(h.text(), /1 to 40 characters/);
});

test('an unknown failure reason shows the generic sentence plus the code, never the raw reason alone', async (t) => {
  const h = harness({ host: NONE, teams: [], answers: { hostDeploy: { ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_brand_new_reason' } } } });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Olive'); h.type('#teamPcName', 'Desk'); h.type('#teamNewName', 'Studio');
  h.click('[data-team-action="deploy"]');
  await flush();
  assert.match(h.text(), /Something went wrong \(CMP-HOST-0004\)/);
  assert.equal(h.text().includes('team_brand_new_reason'), false);
});

test('Deploy whose owner join says team_owner_recover_needed leads to Reclaim ownership', async (t) => {
  let host = NONE;
  const h = harness({ host: NONE, teams: [], answers: {
    hostStatus: () => ({ ok: true, host }),
    hostDeploy: () => { host = hostState(); return { ok: true, host, owner: { state: 'failed', error: { code: 'CMP-TEAM-0006', reason: 'team_owner_recover_needed' } } }; },
  } });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Olive'); h.type('#teamPcName', 'Desk'); h.type('#teamNewName', 'Studio');
  h.click('[data-team-action="deploy"]');
  await flush();
  assert.ok(h.q('[data-team-action="recover"]'));
  assert.match(h.text(), /lost its place in the team/);
});

test('Stop and Start: hostStop with no payload; Start deploys again with the saved name', async (t) => {
  const h = harness({ host: hostState({ state: 'stopped' }), teams: [snapshot({ state: 'offline' })] });
  t.after(h.restore);
  await flush();
  // The team is offline, so this device's label is unknown and the You group asks for it.
  assert.equal(h.q('#teamYourName').value, 'Olive Owner');
  h.type('#teamPcName', 'Desk');
  h.click('[data-team-action="start"]');
  await flush();
  assert.deepEqual(h.sent('hostDeploy').map((call) => call.payload), [{ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' }]);
  h.listeners.host(hostState());
  await flush();
  h.click('[data-team-action="stop"]');
  await flush();
  assert.equal(h.sent('hostStop').length, 1);
  assert.equal(h.sent('hostStop')[0].argc, 0);
});

test('Start with no team id prefills nothing and still deploys with the saved name', async (t) => {
  const h = harness({ host: hostState({ state: 'stopped', team_id: null }), teams: [snapshot({ team_id: OTHER, state: 'offline' })] });
  t.after(h.restore);
  await flush();
  assert.equal(h.q('#teamYourName').value, '', 'no team is picked without the id');
  h.type('#teamYourName', 'Olive'); h.type('#teamPcName', 'Desk');
  h.click('[data-team-action="start"]');
  await flush();
  assert.deepEqual(h.sent('hostDeploy')[0].payload, { name: 'Studio', display_name: 'Olive', label: 'Desk' });
});

test('Join sends the invite and names once, clears the field, and the invite reaches no log or storage', async (t) => {
  let release;
  const h = harness({ host: NONE, teams: [], answers: { join: () => new Promise((resolve) => { release = resolve; }) } });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Olive'); h.type('#teamPcName', 'Desk');
  h.type('#teamInviteCode', `  ${CODE}  `);
  h.click('[data-team-action="join"]');
  h.click('[data-team-action="join"]');
  await flush();
  assert.equal(h.sent('join').length, 1);
  assert.deepEqual(h.sent('join')[0].payload, { invite: CODE, display_name: 'Olive', label: 'Desk' });
  release({ ok: true, team: snapshot({ team_id: OTHER, state: 'pending', role: 'member' }) });
  await flush();
  assert.equal(h.q('#teamInviteCode').value, '');
  assert.equal(h.container.innerHTML.includes(CODE), false);
  assert.equal(JSON.stringify(h.section._live).includes(CODE), false);
  assert.equal(h.logged.some((line) => line.includes(CODE)), false);
  assert.equal(h.stored.some((line) => line.includes(CODE)), false);
});

test('rename, invite create then reveal, a second invite drops the first code, and revoke', async (t) => {
  let n = 0;
  const h = harness({ teams: ownerTeams, answers: {
    inviteList: () => ({ ok: true, invites: [{ invite_id: 'invite_one', kind: 'new_member', role: 'member', created_at: 1, expires_at: 5 }] }),
    inviteCreate: () => { n += 1; return { ok: true, invite_id: `invite_n${n}`, expires_at: 5 }; },
    inviteReveal: ({ invite_id: id }) => ({ ok: true, invite: `${CODE}${id}` }),
  } });
  t.after(h.restore);
  await flush();
  h.type('#teamTeamName', 'Studio Two');
  h.click('[data-team-action="rename"]');
  await flush();
  assert.deepEqual(h.sent('rename').map((c) => c.payload), [{ team_id: TEAM, name: 'Studio Two' }]);

  h.click('[data-inv-segmented="teamInviteRole"] [data-value="read_only"]');
  h.choose('#teamInviteExpiry', '604800000');
  h.click('[data-team-action="invite-create"]');
  await flush();
  assert.deepEqual(h.sent('inviteCreate')[0].payload, { team_id: TEAM, role: 'read_only', ttl_ms: 604800000 });
  assert.deepEqual(h.sent('inviteReveal')[0].payload, { team_id: TEAM, invite_id: 'invite_n1' });
  assert.equal(h.q('.team-set-code code').textContent, `${CODE}invite_n1`);
  assert.match(h.text(), /Shown once/);
  h.click('[data-team-action="invite-create"]');
  await flush();
  assert.equal(h.container.innerHTML.includes(`${CODE}invite_n1`), false, 'the first code is gone from the page');
  assert.equal(JSON.stringify(h.section._live).includes(`${CODE}invite_n1`), false, 'and from memory');
  assert.equal(h.q('.team-set-code code').textContent, `${CODE}invite_n2`);

  h.click('[data-team-action="invite-revoke"][data-invite-id="invite_one"]');
  await flush();
  assert.deepEqual(h.sent('inviteRevoke').map((c) => c.payload), [{ team_id: TEAM, invite_id: 'invite_one' }]);
  assert.equal(h.logged.some((line) => line.includes(CODE)), false);
  assert.equal(h.stored.some((line) => line.includes(CODE)), false);
});

test('leaving the section drops the shown code from the page and from memory', async (t) => {
  const h = harness({ teams: ownerTeams });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="invite-create"]');
  await flush();
  assert.ok(h.container.innerHTML.includes(CODE));
  h.section.leaveTeamSection();
  assert.equal(h.container.innerHTML.includes(CODE), false);
  assert.equal(JSON.stringify(h.section._live).includes(CODE), false);
});

test('admit and decline, once for a double click; a role change sends the role', async (t) => {
  let release;
  const h = harness({ teams: ownerTeams, answers: { memberAdmit: () => new Promise((resolve) => { release = resolve; }) } });
  t.after(h.restore);
  await flush();
  h.click(`[data-team-action="admit"][data-member-id="${MAYA}"]`);
  h.click(`[data-team-action="admit"][data-member-id="${MAYA}"]`);
  await flush();
  assert.deepEqual(h.sent('memberAdmit').map((c) => c.payload), [{ team_id: TEAM, member_id: MAYA }]);
  release({ ok: true, member_id: MAYA, state: 'active' });
  await flush();
  h.click(`[data-team-action="decline"][data-member-id="${MAYA}"]`);
  await flush();
  assert.deepEqual(h.sent('memberRevoke').map((c) => c.payload), [{ team_id: TEAM, member_id: MAYA }]);
  h.choose(`select[data-member-id="${DOT}"]`, 'read_only');
  await flush();
  assert.deepEqual(h.sent('memberSetRole').map((c) => c.payload), [{ team_id: TEAM, member_id: DOT, role: 'read_only' }]);
});

function openMenuItem(h, memberId, label) {
  h.click(`[data-team-action="more"][data-member-id="${memberId}"]`);
  const item = [...h.window.document.querySelectorAll('.inv-context-menu-item')].find((el) => el.textContent.includes(label));
  assert.ok(item, `menu item ${label}`);
  item.click();
}

test('Remove waits for the inline confirm and sends once for a double click', async (t) => {
  let release;
  const h = harness({ teams: ownerTeams, answers: { memberRevoke: () => new Promise((resolve) => { release = resolve; }) } });
  t.after(h.restore);
  await flush();
  openMenuItem(h, DOT, 'Remove from team…');
  assert.equal(h.sent('memberRevoke').length, 0, 'the menu only asks');
  assert.match(h.text(), /Remove Dot from the team\? Their devices are disconnected at once and they lose the team’s channels and shared projects\. They can only come back with a new invite\./);
  assert.equal(h.window.document.querySelector('[role="dialog"]'), null, 'inline, never a dialog');
  h.click('[data-team-action="confirm-remove"]');
  h.click('[data-team-action="confirm-remove"]');
  await flush();
  assert.deepEqual(h.sent('memberRevoke').map((c) => c.payload), [{ team_id: TEAM, member_id: DOT }]);
  release({ ok: true });
});

test('Make owner waits for the inline confirm, then sends ownerTransfer; Cancel sends nothing', async (t) => {
  const h = harness({ teams: ownerTeams });
  t.after(h.restore);
  await flush();
  openMenuItem(h, DOT, 'Make Dot the owner…');
  assert.match(h.text(), /Make Dot the owner\? You become a member\. Only the owner can invite, admit, remove people and change roles, and only Dot can hand ownership back\. The server keeps running on this PC\./);
  h.click('[data-team-action="confirm-cancel"]');
  assert.equal(h.sent('ownerTransfer').length, 0);
  openMenuItem(h, DOT, 'Make Dot the owner…');
  h.click('[data-team-action="confirm-owner"]');
  await flush();
  assert.deepEqual(h.sent('ownerTransfer').map((c) => c.payload), [{ team_id: TEAM, member_id: DOT }]);
});

test('Add another device shows the code once; removing another device is direct, the last one confirms', async (t) => {
  let devices = [device(DESK, 'Desk'), device(LAPTOP, 'Laptop')];
  const h = harness({ teams: ownerTeams, answers: { deviceList: () => ({ ok: true, devices }) } });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="device-invite"]');
  await flush();
  assert.deepEqual(h.sent('deviceInvite').map((c) => c.payload), [{ team_id: TEAM }]);
  assert.equal(h.q('.team-set-code code').textContent, DEVICE_CODE);
  assert.match(h.text(), /Paste it into Jenny on your other PC within 15 minutes\. It adds a device to you, not a new person\./);
  h.click(`[data-team-action="device-revoke"][data-device-id="${LAPTOP}"]`);
  await flush();
  assert.deepEqual(h.sent('deviceRevoke').map((c) => c.payload), [{ team_id: TEAM, device_id: LAPTOP }]);
  devices = [device(DESK, 'Desk')];
  h.listeners.state({ teams: ownerTeams });
  await flush();
  h.click(`[data-team-action="device-revoke"][data-device-id="${DESK}"]`);
  assert.equal(h.sent('deviceRevoke').length, 1, 'the last device asks first');
  assert.match(h.text(), /This is your only device in this team\. Only the owner can bring you back\./);
  h.click('[data-team-action="confirm-device"]');
  await flush();
  assert.deepEqual(h.sent('deviceRevoke')[1].payload, { team_id: TEAM, device_id: DESK });
  assert.equal(h.logged.some((line) => line.includes(DEVICE_CODE)), false);
});

test('leave (after its confirm), cancel request and remove team send the team id only', async (t) => {
  const h = harness({ host: NONE, teams: [
    snapshot({ team_id: 'team_L1', team_name: 'Lab', role: 'member' }),
    snapshot({ team_id: 'team_P1', team_name: 'Pend', role: 'member', state: 'pending' }),
    snapshot({ team_id: 'team_R1', team_name: 'Gone', role: 'member', state: 'revoked' }),
  ] });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="leave"][data-team-id="team_L1"]');
  assert.equal(h.sent('leave').length, 0);
  assert.match(h.text(), /Leave Lab\?/);
  h.click('[data-team-action="confirm-leave"]');
  await flush();
  h.click('[data-team-action="cancel-request"][data-team-id="team_P1"]');
  await flush();
  assert.deepEqual(h.sent('leave').map((c) => c.payload), [{ team_id: 'team_L1' }, { team_id: 'team_P1' }]);
  h.click('[data-team-action="remove-team"][data-team-id="team_R1"]');
  await flush();
  assert.deepEqual(h.sent('removeTeam').map((c) => c.payload), [{ team_id: 'team_R1' }]);
});

test('Reclaim ownership waits for its confirm, then sends the names; a local save failure asks to run it again', async (t) => {
  const h = harness({ teams: [], answers: { hostRecover: { ok: true, host: hostState(),
    owner: { state: 'failed', error: { code: 'CMP-TEAM-0004', reason: 'team_recover_local_save_failed' } } } } });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Olive'); h.type('#teamPcName', 'Desk');
  h.click('[data-team-action="recover"]');
  assert.equal(h.sent('hostRecover').length, 0);
  assert.match(h.text(), /Signs this Jenny in as the owner again and disconnects the owner’s other devices\. It is written to the team’s activity log\. It works only here, on the PC that runs the server\./);
  h.click('[data-team-action="confirm-recover"]');
  await flush();
  assert.deepEqual(h.sent('hostRecover').map((c) => c.payload), [{ display_name: 'Olive', label: 'Desk' }]);
  assert.match(h.text(), /Run Reclaim ownership again/);
});

test('a member who is not the owner of the hosted team sees no owner controls', async (t) => {
  const h = harness({ teams: [snapshot({ role: 'member' })] });
  t.after(h.restore);
  await flush();
  for (const action of ['invite-create', 'admit', 'decline', 'more', 'rename']) {
    assert.equal(h.q(`[data-team-action="${action}"]`), null, action);
  }
  assert.equal(h.q('#teamTeamName'), null);
  assert.equal(h.q('[data-team-people] select'), null);
  assert.equal(h.q('[data-team-activity]'), null);
  assert.equal(h.sent('auditRead').length, 0, 'the page does not ask for what the host would refuse');
  assert.equal(h.sent('inviteList').length, 0);
});

test('activity: the latest five rows in plain words, and Show all activity pages by cursor', async (t) => {
  const entries = Array.from({ length: 7 }, (_, i) => ({ seq: i + 1, at: Date.UTC(2026, 10, 9, 10, i), kind: 'role_changed',
    actor_member_id: ME, subject_member_id: DOT, subject_device_id: null, name: null, detail: 'role=read_only', applied: true }));
  const h = harness({ teams: ownerTeams, answers: { auditRead: ({ cursor = 0, limit }) => {
    const rest = entries.filter((entry) => entry.seq > cursor);
    const page = rest.slice(0, limit);
    return { ok: true, entries: page, next_cursor: rest.length > page.length ? page[page.length - 1].seq : null };
  } } });
  t.after(h.restore);
  await flush();
  const rows = h.container.querySelectorAll('[data-team-activity] li');
  assert.equal(rows.length, 5);
  assert.match(rows[0].textContent, /You changed Dot’s role/);
  h.click('[data-team-action="activity-all"]');
  await flush();
  const paged = h.sent('auditRead').slice(-1)[0].payload;
  assert.equal(paged.team_id, TEAM);
  assert.equal(paged.cursor, 0);
});

test('a state push refreshes the owner lists without a timer', async (t) => {
  const h = harness({ teams: ownerTeams });
  t.after(h.restore);
  await flush();
  const before = h.sent('members').length;
  h.listeners.state({ teams: ownerTeams });
  await flush();
  assert.equal(h.sent('members').length, before + 1);
  h.section.leaveTeamSection();
  assert.equal(h.listeners.state, null, 'unsubscribed on leave');
  assert.equal(h.listeners.host, null);
});

// --------------------------------------------------------- review round (A, B)

const deferred = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };

test('A1: a code or a read that finishes after leaving the page is dropped, and the next visit shows none', async (t) => {
  const reveal = deferred();
  let failMembers = false;
  const members = deferred();
  const h = harness({ answers: {
    inviteReveal: () => reveal.promise,
    members: () => (failMembers ? members.promise : { ok: true, team: { team_id: TEAM }, members: shared.ROSTER }),
  } });
  t.after(h.restore);
  await flush();
  failMembers = true;
  h.listeners.state({ teams: [snapshot()] });
  h.click('[data-team-action="invite-create"]');
  await flush();
  h.section.leaveTeamSection();
  reveal.release({ ok: true, invite: CODE });
  members.release({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
  await flush();
  assert.equal(h.section._live.reveal, null);
  assert.equal(h.section._live.errors.people, undefined, 'the late read wrote nothing into the new state');
  failMembers = false;
  h.section.showTeamSection({ container: h.container });
  await flush();
  assert.equal(h.section._live.reveal, null);
  assert.equal(h.container.innerHTML.includes(CODE), false);
});

test('A3: a rejected or empty answer shows a sentence; a failed reveal shows it and lists the unused invite', async (t) => {
  let invites = [];
  const h = harness({ answers: {
    memberAdmit: () => Promise.reject(new Error('bridge gone')),
    rename: () => null,
    inviteCreate: () => { invites = [{ invite_id: 'invite_x', kind: 'new_member', role: 'member', created_at: 1, expires_at: 9 }]; return { ok: true, invite_id: 'invite_x', expires_at: 9 }; },
    inviteReveal: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } },
    inviteList: () => ({ ok: true, invites }),
  } });
  t.after(h.restore);
  await flush();
  h.click(`[data-team-action="admit"][data-member-id="${MAYA}"]`);
  await flush();
  assert.match(h.q('[data-team-group="people"]').textContent, /The team server could not be reached\./);
  assert.equal(h.q(`[data-team-action="admit"][data-member-id="${MAYA}"]`).disabled, false);
  h.type('#teamTeamName', 'Studio Two');
  h.click('[data-team-action="rename"]');
  await flush();
  assert.equal(h.text().split('The team server could not be reached.').length - 1, 2, 'an answer with no ok is a failure too');
  h.click('[data-team-action="invite-create"]');
  await flush();
  assert.match(h.q('[data-team-group="invite"]').textContent, /The team server is not answering/);
  assert.ok(h.q('[data-team-action="invite-revoke"][data-invite-id="invite_x"]'), 'the unused invite can be revoked');
});

test('A3: a failed read sentence is cleared by the next good read', async (t) => {
  let fail = true;
  const h = harness({ answers: { members: () => (fail ? { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } }
    : { ok: true, team: { team_id: TEAM }, members: shared.ROSTER }) } });
  t.after(h.restore);
  await flush();
  assert.match(h.text(), /The team server is not answering/);
  fail = false;
  h.listeners.state({ teams: [snapshot()] });
  await flush();
  assert.equal(/The team server is not answering/.test(h.text()), false);
});

test('A4: overlapping refreshes run one at a time and show each activity row once', async (t) => {
  const entries = [1, 2, 3].map((seq) => ({ seq, at: Date.UTC(2026, 10, 9, 10, seq), kind: 'team_renamed', actor_member_id: ME }));
  let inFlight = 0;
  let most = 0;
  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 1));
  const h = harness({ answers: {
    members: () => { inFlight += 1; most = Math.max(most, inFlight); return later({ ok: true, team: { team_id: TEAM }, members: shared.ROSTER }).finally(() => { inFlight -= 1; }); },
    auditRead: ({ cursor = 0 }) => later({ ok: true, entries: entries.filter((entry) => entry.seq > cursor), next_cursor: null }),
  } });
  t.after(h.restore);
  await flush();
  entries.push({ seq: 4, at: Date.UTC(2026, 10, 9, 10, 4), kind: 'team_renamed', actor_member_id: ME });
  h.listeners.state({ teams: [snapshot()] });
  h.listeners.host(hostState());
  h.click(`[data-team-action="admit"][data-member-id="${MAYA}"]`);
  for (let i = 0; i < 4; i += 1) await flush();
  const rows = h.qa('[data-team-activity] li').map((li) => li.textContent);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows).size, 4, 'no row twice');
  assert.equal(most, 1, 'never two roster reads at once');
});

test('A5: removing this PC asks first even with another device; Stop asks while other people are in', async (t) => {
  const h = harness({ answers: { deviceList: () => ({ ok: true, devices: [device(DESK, 'Desk'), device(LAPTOP, 'Laptop')] }) } });
  t.after(h.restore);
  await flush();
  h.click(`[data-team-action="device-revoke"][data-device-id="${DESK}"]`);
  assert.equal(h.sent('deviceRevoke').length, 0);
  assert.match(h.text(), /This is the PC you are using now\./);
  h.click('[data-team-action="confirm-cancel"]');
  for (const where of ['[data-team-group="ownership"]', '.team-set-status']) {
    h.q(`${where} [data-team-action="stop"]`).click();
    assert.equal(h.sent('hostStop').length, 0, `${where} asks first`);
    assert.match(h.text(), /Everyone else in the team is disconnected now\. Nothing is deleted/);
    h.click('[data-team-action="confirm-cancel"]');
  }
  h.click('[data-team-group="ownership"] [data-team-action="stop"]');
  h.click('[data-team-action="confirm-stop"]');
  await flush();
  assert.equal(h.sent('hostStop').length, 1);
});

test('A5: Stop is one click when the owner is alone', async (t) => {
  const h = harness({ answers: { members: { ok: true, team: { team_id: TEAM }, members: [shared.ROSTER[0]] } } });
  t.after(h.restore);
  await flush();
  h.click('.team-set-status [data-team-action="stop"]');
  await flush();
  assert.equal(h.sent('hostStop').length, 1);
});

test('A6: a code request refused as already running keeps the visible code', async (t) => {
  const pending = deferred();
  const h = harness({ answers: { deviceInvite: () => pending.promise } });
  t.after(h.restore);
  await flush();
  h.click(`[data-team-action="device-invite"][data-team-id="${TEAM}"]`);
  h.click('[data-team-action="invite-create"]');
  await flush();
  assert.equal(h.q('.team-set-code code').textContent, CODE);
  const stale = h.q(`[data-team-action="device-invite"][data-team-id="${TEAM}"]`);
  stale.disabled = false;
  stale.click();
  assert.equal(h.section._live.reveal && h.section._live.reveal.code, CODE, 'the refused request blanked nothing');
  pending.release({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
  await flush();
});

test('A6: a confirm button is busy under the key its call runs under', async (t) => {
  const leave = deferred();
  const h = harness({ host: NONE, teams: [snapshot({ team_id: OTHER, team_name: 'Lab', role: 'member' })], answers: { leave: () => leave.promise } });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="leave"]');
  h.click('[data-team-action="confirm-leave"]');
  await flush();
  assert.equal(h.q('[data-team-action="confirm-leave"]').disabled, true, 'busy while Leave runs');
  leave.release({ ok: true });
  await flush();
});

test('B: an idle push does not rebuild the page; a roster action re-reads the lists only', async (t) => {
  const h = harness();
  t.after(h.restore);
  await flush();
  const select = h.q('#teamInviteExpiry');
  h.listeners.state({ teams: [snapshot()] });
  await flush();
  assert.equal(h.q('#teamInviteExpiry'), select, 'the same element: an open select stays open');
  const before = { host: h.sent('hostStatus').length, status: h.sent('status').length, members: h.sent('members').length };
  h.click(`[data-team-action="admit"][data-member-id="${MAYA}"]`);
  await flush();
  assert.equal(h.sent('hostStatus').length, before.host);
  assert.equal(h.sent('status').length, before.status);
  assert.equal(h.sent('members').length, before.members + 1);
});

test('B: Copy writes the code and says Copied on the same button', async (t) => {
  const h = harness();
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="invite-create"]');
  await flush();
  h.click('[data-team-action="copy-code"]');
  await flush();
  assert.deepEqual(h.copied, [CODE]);
  assert.equal(h.q('[data-team-action="copy-code"]').textContent.trim(), 'Copied');
  assert.equal(h.logged.some((line) => line.includes(CODE)), false);
});
