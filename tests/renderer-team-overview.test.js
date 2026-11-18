'use strict';

// new-test-file: the Team tab's Overview page (row 168, slice S2) is a new surface with its own module
// (renderer/team/renderer-team-overview.js), and renderer-team-tab.test.js is near its line cap.
//
// The Overview: one column of what needs the owner, the server, seats, joining, GPU sharing, the people and the
// latest activity. Through the real Team tab, stores and inventory modules over a stubbed bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, ME, DOT, MAYA, CODE, flush, pushed, snapshot, memberTeam, hostState, ROSTER, device, harness, chatMember, overview } = require('./helpers/team-settings-harness');

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const SOLO_ROSTER = [ROSTER[0]];
const SOLO_MEMBERS = [chatMember(ME, 'Olive Owner', { role: 'owner' })];
const ACTIVE_ROSTER = ROSTER.filter((member) => member.state === 'active'); // me and Dot, nobody waiting
const NO_READ = { ok: false, error: { code: 'CMP-TEAM-0001', reason: '' } };
const node = (over = {}) => ({ node_id: 'node_AAAAAAAAAAAAAAAA', member_id: DOT, label: 'Tower', online: true, paused: false, busy_slots: 0, slots: 1,
  models: [{ name: 'qwen3.8-27b', context_length: 32768, vision: false, thinking: false }], ...over });
const entry = (seq, over = {}) => ({ seq, at: Date.UTC(2026, 10, 9, 8, seq), kind: 'invite_created', actor_member_id: ME, subject_member_id: null, name: null, ...over });

// The owner's Team tab for a team hosted here. `solo`: only this person in it.
async function open(t, { solo = false, answers = {}, teams = [snapshot()], host = hostState(), show = true } = {}) {
  const roster = solo ? SOLO_ROSTER : ROSTER;
  const h = harness({ show: false, host, teams, answers: {
    members: { ok: true, members: roster },
    chatOverview: overview(solo ? { members: SOLO_MEMBERS } : {}),
    ...answers,
  } });
  t.after(h.restore);
  h.showTab();
  await flush();
  if (show && !h.view.q('[data-team-region="overview"]')) { h.view.click('[data-team-tab-action="overview"]'); await flush(); }
  return h;
}

const rowOf = (h) => h.view.q('[data-team-tab-action="overview"]');
const page = (h) => h.view.q('[data-team-region="overview"]');
const fact = (h, key) => h.view.q(`[data-ov-key="${key}"]`);
const main = (h, key) => text(fact(h, key)?.querySelector('.team-ov-fact__main'));
const sub = (h, key) => text(fact(h, key)?.querySelector('.team-ov-fact__sub'));
const sec = (h, key) => h.view.q(`[data-ov-sec="${key}"]`);
const act = (h, action, within = h.view) => within.q(`[data-team-action="${action}"]`);
const calls = (h) => h.calls.map((call) => call.method);

// ---------------------------------------------------------------- the column row and the page

test('a connected team: an Overview row above Channels; it shows the page, is current, and its id never reaches the host', async (t) => {
  const h = await open(t, { show: false });
  const row = rowOf(h);
  assert.ok(row, 'the row is in the column');
  assert.equal(text(row.querySelector('.team-row__name')), 'Overview');
  assert.ok(row.classList.contains('team-row--link'));
  assert.equal(row.getAttribute('aria-current'), 'false');
  const channels = h.view.q('.team-channels .team-panel__label');
  assert.equal(row.compareDocumentPosition(channels) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, h.window.Node.DOCUMENT_POSITION_FOLLOWING, 'above Channels');
  assert.equal(page(h), null, 'a team that is not alone opens on #team');
  assert.ok(h.view.q('[data-team-region="timeline"]'));
  const before = h.calls.length;
  row.click();
  await flush();
  assert.ok(page(h), 'the page is shown');
  assert.equal(h.view.q('[data-team-region="timeline"]'), null, 'in place of the timeline');
  assert.equal(h.view.q('[data-team-region="composer"]'), null);
  assert.equal(rowOf(h).getAttribute('aria-current'), 'true');
  assert.equal(h.view.q('[data-team-channel][aria-current="true"]'), null, 'no channel is current');
  assert.equal(text(h.view.q('.team-head__name')), 'Overview');
  assert.equal(text(h.view.q('.team-head__sub')), 'Studio · hosted on this PC');
  h.view.click('.team-head [data-team-tab-action="open-settings"]');
  assert.deepEqual(h.opened, ['team'], 'Team settings opens Settings > Team');
  // The pseudo id is never sent, marked read or persisted.
  for (const call of h.calls.slice(before)) assert.notEqual(call.payload && call.payload.channel_id, 'overview', call.method);
  assert.equal(h.sent('chatMarkRead').filter((call) => call.payload.channel_id !== 'chan_team').length, 0);
  assert.equal(h.stored.filter((line) => line.includes('overview')).length, 0);
  // Back to a channel.
  h.view.click('[data-team-channel="chan_team"]');
  await flush();
  assert.equal(page(h), null);
  assert.equal(rowOf(h).getAttribute('aria-current'), 'false');
});

test('which page the tab opens on: Overview for a solo owner; #team for an owner with people and for a member', async (t) => {
  const solo = await open(t, { solo: true, show: false });
  assert.ok(page(solo), 'a solo owner opens on Overview');
  assert.equal(rowOf(solo).getAttribute('aria-current'), 'true');
  const busy = await open(t, { show: false });
  assert.equal(page(busy), null);
  assert.ok(busy.view.q('[data-team-region="timeline"]'));
  const member = await open(t, { teams: [memberTeam()], host: { state: 'stopped', team_id: null, team_name: null, deployed: false, reason: null, since: 1 }, show: false,
    answers: { members: { ok: true, members: SOLO_ROSTER.map(({ devices: _d, ...m }) => ({ ...m, role: 'owner' })) } } });
  assert.equal(page(member), null, 'a member of a team hosted elsewhere opens where it did');
  assert.ok(member.view.q('[data-team-region="timeline"]'));
});

test('a pick the person made is kept: the default applies once per team', async (t) => {
  const h = await open(t, { solo: true, show: false });
  assert.ok(page(h));
  h.view.click('[data-team-channel="chan_team"]');
  await flush();
  h.listeners.state({ teams: [snapshot()] });
  await pushed();
  assert.equal(page(h), null, 'a push does not take the person back to Overview');
});

// ---------------------------------------------------------------- the owner's facts

test('owner facts: Server, Seats, Joining, This PC’s GPU, Team GPUs and Your devices, each with what the stores hold', async (t) => {
  const sharing = { team_id: TEAM, state: 'idle', serving_since: null, models: [], engine: 'llama-server', node_id: 'node_AAAAAAAAAAAAAAAA' };
  const h = await open(t, { host: hostState({ internet: null }), answers: {
    status: { ok: true, teams: [snapshot({ label: 'Desk' })], sharing, pools: { [TEAM]: { nodes: [node(), node({ node_id: 'node_BBBBBBBBBBBBBBBB', paused: true, label: 'Studio' })], team_model: null, automatic_model: null } } },
    deviceList: { ok: true, devices: [device('device_desk', 'Desk'), device('device_laptop', 'Laptop')] } } });
  assert.equal(text(sec(h, 'facts').querySelector('.team-ov__h')), 'Server and sharing');
  assert.equal(main(h, 'server'), 'Running on this PC');
  assert.equal(sub(h, 'server'), 'runs while Jenny is open');
  assert.equal(text(act(h, 'stop', fact(h, 'server') && { q: (s) => fact(h, 'server').querySelector(s) })), 'Stop');
  assert.equal(main(h, 'seats'), '3 of 8');
  assert.equal(sub(h, 'seats'), '1 waiting to be let in');
  assert.equal(text(fact(h, 'seats').querySelector('[data-team-action="ov-invite"]')), 'Invite someone');
  assert.equal(main(h, 'joining'), 'This network only');
  assert.equal(text(fact(h, 'joining').querySelector('button')), 'Network settings');
  assert.equal(main(h, 'gpu'), 'Shared with the team');
  assert.equal(fact(h, 'gpu').querySelector('[data-inv-toggle="teamOvShare"]').getAttribute('aria-checked'), 'true');
  assert.equal(main(h, 'gpus'), '2 shared');
  assert.equal(sub(h, 'gpus'), 'Tower (this PC) · ready');
  assert.equal(main(h, 'devices'), '2 of 3');
  assert.equal(sub(h, 'devices'), 'Desk (this PC)');
  assert.equal(text(fact(h, 'devices').querySelector('button')), 'Manage');
  fact(h, 'devices').querySelector('button').click();
  fact(h, 'joining').querySelector('button').click();
  assert.deepEqual(h.opened, ['team', 'team'], 'the links open Settings > Team');
  assert.deepEqual([...h.view.qa('[data-ov-sec="facts"] > ul > li')].map((li) => li.dataset.ovKey), ['server', 'seats', 'joining', 'gpu', 'gpus', 'devices']);
});

test('a fact whose data is not read yet is not shown; nothing is guessed', async (t) => {
  const h = await open(t, { answers: { deviceList: NO_READ, status: { ok: true, teams: [snapshot()] } } });
  assert.equal(fact(h, 'devices'), null, 'devices unread');
  assert.equal(fact(h, 'gpus'), null, 'no GPU list read');
  assert.ok(fact(h, 'server'));
  assert.equal(main(h, 'gpu'), 'Not shared');
  const none = await open(t, { answers: { status: { ok: true, teams: [snapshot()], pools: { [TEAM]: { nodes: [], team_model: null, automatic_model: null } } } } });
  assert.equal(main(none, 'gpus'), 'None shared');
  const alone = await open(t, { solo: true });
  assert.equal(main(alone, 'seats'), '1 of 8');
  assert.equal(sub(alone, 'seats'), 'only you so far');
  assert.ok(fact(alone, 'seats').querySelector('[data-team-action="ov-invite"]').className.includes('primary'), 'primary when solo');
});

// ---------------------------------------------------------------- Needs you

test('Needs you lists who waits, Admit and Decline send what the tab’s Wants to join sends, and the count is on the row', async (t) => {
  const h = await open(t);
  const needs = sec(h, 'needs');
  assert.ok(needs);
  assert.match(text(needs.querySelector('.team-ov__h')), /^Needs you\s*1$/);
  assert.match(text(needs), /Maya Okafor/);
  assert.match(text(needs), /wants to join as Member · Maya laptop · key 7F3A 91C2 05/);
  assert.equal(text(rowOf(h).querySelector('.team-count')), '1');
  assert.match(rowOf(h).getAttribute('aria-label'), /1 waiting/);
  const section = { q: (s) => needs.querySelector(s) };
  assert.equal(text(act(h, 'admit', section)), 'Admit');
  assert.equal(text(act(h, 'decline', section)), 'Decline');
  act(h, 'admit', section).click();
  act(h, 'admit', section).click();
  await flush();
  assert.equal(h.sent('memberAdmit').length, 1, 'one call');
  assert.deepEqual(h.sent('memberAdmit')[0].payload, { team_id: TEAM, member_id: MAYA });
  act(h, 'decline', { q: (s) => sec(h, 'needs').querySelector(s) }).click();
  await flush();
  assert.deepEqual(h.sent('memberRevoke')[0].payload, { team_id: TEAM, member_id: MAYA });
  assert.ok(h.sent('members').length >= 2, 'the roster is read again after an answer');
});

test('no one waiting: no Needs you section and no count; a failed Admit says why under the section', async (t) => {
  const quiet = await open(t, { answers: { members: { ok: true, members: ACTIVE_ROSTER } } });
  assert.equal(sec(quiet, 'needs'), null);
  assert.equal(rowOf(quiet).querySelector('.team-count'), null);
  const h = await open(t, { answers: { memberAdmit: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_member_gone' } } } });
  const needs = () => sec(h, 'needs');
  needs().querySelector('[data-team-action="admit"]').click();
  await flush();
  assert.ok(needs().querySelector('.team-set-note'), 'one sentence under the section');
  assert.equal(needs().querySelector('[data-team-action="admit"]').disabled, false, 'the control is given back');
});

// ---------------------------------------------------------------- invite

test('Invite someone: the options open under Seats, a push keeps the choice and the focus, Create shows the code once, leaving drops it', async (t) => {
  const h = await open(t, { solo: true });
  assert.equal(fact(h, 'invite'), null);
  fact(h, 'seats').querySelector('[data-team-action="ov-invite"]').click();
  await flush();
  const row = fact(h, 'invite');
  assert.ok(row, 'the options row');
  assert.equal(row.previousElementSibling, fact(h, 'seats'), 'right under Seats');
  const labels = [...row.querySelectorAll('.inv-segmented-option')].map(text);
  assert.deepEqual(labels, ['Member', 'Read-only']);
  assert.deepEqual([...row.querySelectorAll('option')].map(text), ['Expires in 1 hour', 'Expires in 1 day', 'Expires in 7 days']);
  assert.equal(row.querySelector('select').value, '86400000', 'one day by default');
  // The choice, then a push while the row is open.
  [...row.querySelectorAll('.inv-segmented-option')][1].click();
  const select = row.querySelector('select');
  select.value = '604800000';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  select.focus();
  const same = fact(h, 'invite');
  h.listeners.state({ teams: [snapshot({ since: 2 })] });
  await pushed();
  assert.equal(fact(h, 'invite'), same, 'the options row is not rewritten by a push');
  assert.equal(h.window.document.activeElement, select, 'focus stays');
  assert.equal(fact(h, 'invite').querySelector('select').value, '604800000');
  assert.equal([...fact(h, 'invite').querySelectorAll('.inv-segmented-option')][1].getAttribute('aria-checked'), 'true');
  // Create.
  act(h, 'invite-create').click();
  await flush();
  assert.deepEqual(h.sent('inviteCreate')[0].payload, { team_id: TEAM, role: 'read_only', ttl_ms: 604_800_000 });
  assert.deepEqual(h.sent('inviteReveal')[0].payload, { team_id: TEAM, invite_id: 'invite_one' });
  assert.ok(calls(h).indexOf('inviteCreate') < calls(h).indexOf('inviteReveal'), 'create, then reveal');
  assert.equal(text(h.view.q('.team-set-code code')), CODE);
  assert.equal(h.view.qa('.team-set-code').length, 1);
  assert.match(text(h.view.q('.team-set-code__note')), /Shown once/);
  act(h, 'copy-code').click();
  await flush();
  assert.deepEqual(h.copied, [CODE]);
  assert.equal(h.logged.filter((line) => line.includes(CODE)).length, 0, 'never logged');
  assert.equal(h.stored.filter((line) => line.includes(CODE)).length, 0, 'never stored');
  // Leaving the page and coming back: no code, and the options are closed.
  h.view.click('[data-team-channel="chan_team"]');
  await flush();
  assert.equal(h.view.q('.team-set-code'), null);
  assert.equal(h.view.text().includes(CODE), false, 'the code is nowhere in the view');
  rowOf(h).click();
  await flush();
  assert.equal(h.view.q('.team-set-code'), null);
  assert.equal(fact(h, 'invite'), null);
  assert.equal(h.view.text().includes(CODE), false);
});

test('a second invite replaces the first code, Cancel closes the row and drops the code', async (t) => {
  let n = 0;
  const h = await open(t, { solo: true, answers: { inviteCreate: () => ({ ok: true, invite_id: 'invite_' + (n += 1), expires_at: 5 }), inviteReveal: (p) => ({ ok: true, invite: 'jteam1_CODE_' + p.invite_id }) } });
  fact(h, 'seats').querySelector('[data-team-action="ov-invite"]').click();
  await flush();
  act(h, 'invite-create').click();
  await flush();
  assert.match(text(h.view.q('.team-set-code code')), /CODE_invite_1/);
  act(h, 'invite-create').click();
  await flush();
  assert.equal(h.view.qa('.team-set-code').length, 1);
  assert.match(text(h.view.q('.team-set-code code')), /CODE_invite_2/);
  assert.equal(h.view.text().includes('CODE_invite_1'), false);
  act(h, 'ov-invite-cancel').click();
  await flush();
  assert.equal(fact(h, 'invite'), null);
  assert.equal(h.view.q('.team-set-code'), null);
});

// ---------------------------------------------------------------- Stop

test('Stop asks first while another member is in the team, and sends hostStop only after the confirm; cancel sends nothing', async (t) => {
  const h = await open(t);
  const stop = () => fact(h, 'server').querySelector('[data-team-action="stop"]');
  stop().click();
  await flush();
  assert.equal(h.sent('hostStop').length, 0, 'asks first');
  const confirm = h.view.q('[data-ov-sec="facts"] .team-set-confirm');
  assert.ok(confirm);
  assert.match(text(confirm), /Stop the server\? Everyone else in the team is disconnected now/);
  act(h, 'confirm-cancel').click();
  await flush();
  assert.equal(h.view.q('[data-ov-sec="facts"] .team-set-confirm'), null);
  assert.equal(h.sent('hostStop').length, 0, 'cancel sends nothing');
  stop().click();
  await flush();
  act(h, 'confirm-stop').click();
  await flush();
  assert.equal(h.sent('hostStop').length, 1);
  assert.equal(h.sent('hostStop')[0].argc, 0);
});

test('Stop with nobody else in the team stops at once', async (t) => {
  const h = await open(t, { solo: true });
  fact(h, 'server').querySelector('[data-team-action="stop"]').click();
  await flush();
  assert.equal(h.sent('hostStop').length, 1);
  assert.equal(h.view.q('.team-set-confirm'), null);
});

// ---------------------------------------------------------------- GPU

test('the GPU switch turns sharing on and off with shareSet; a choice only Settings asks for opens Settings at the switch', async (t) => {
  const h = await open(t, { answers: { status: { ok: true, teams: [snapshot()], sharing: null, pools: {} } } });
  const toggle = () => fact(h, 'gpu').querySelector('[data-inv-toggle="teamOvShare"]');
  assert.equal(toggle().getAttribute('aria-checked'), 'false');
  assert.equal(toggle().disabled, false);
  toggle().click();
  await flush();
  assert.deepEqual(h.sent('shareSet')[0].payload, { team_id: TEAM, on: true, confirmed: false });
  const g = await open(t, { answers: { status: { ok: true, teams: [snapshot()], sharing: null, pools: {} },
    shareSet: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_share_confirm_needed' } } } });
  fact(g, 'gpu').querySelector('[data-inv-toggle="teamOvShare"]').click();
  await flush();
  assert.deepEqual(g.opened, ['team'], 'the first-time notice is Settings’');
  assert.equal(text(fact(g, 'gpu').querySelector('.team-set-note')), '', 'no error sentence for a question');
  const sharing = { team_id: TEAM, state: 'idle', serving_since: null, models: [], engine: 'llama-server', node_id: 'node_AAAAAAAAAAAAAAAA' };
  const on = await open(t, { answers: { status: { ok: true, teams: [snapshot()], sharing, pools: {} } } });
  fact(on, 'gpu').querySelector('[data-inv-toggle="teamOvShare"]').click();
  await flush();
  assert.deepEqual(on.sent('shareSet')[0].payload, { team_id: TEAM, on: false });
});

test('a member: You in this team, no Invite, Stop, Needs you or Recent activity; a read-only member’s GPU switch is disabled with its reason', async (t) => {
  const roster = ACTIVE_ROSTER.map(({ devices: _d, ...member }) => member);
  const h = await open(t, { teams: [memberTeam({ role: 'read_only' })], host: { state: 'stopped', team_id: null, team_name: null, deployed: false, reason: null, since: 1 },
    answers: { members: { ok: true, members: roster }, chatOverview: overview({ members: [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot')] }) } });
  assert.equal(text(sec(h, 'facts').querySelector('.team-ov__h')), 'You in this team');
  assert.deepEqual([...h.view.qa('[data-ov-sec="facts"] > ul > li')].map((li) => li.dataset.ovKey), ['connection', 'role', 'gpu', 'devices']);
  assert.equal(main(h, 'connection'), 'Connected');
  assert.equal(sub(h, 'connection'), 'hosted by Olive Owner');
  assert.equal(main(h, 'role'), 'Read-only');
  const toggle = fact(h, 'gpu').querySelector('[data-inv-toggle="teamOvShare"]');
  assert.equal(toggle.disabled, true);
  assert.match(toggle.closest('label').getAttribute('title'), /Read-only members cannot share a GPU/);
  assert.equal(h.view.q('[data-team-action="ov-invite"]'), null);
  assert.equal(h.view.q('[data-team-action="stop"]'), null);
  assert.equal(sec(h, 'needs'), null);
  assert.equal(sec(h, 'activity'), null);
  assert.equal(text(h.view.q('.team-head__sub')), 'Dot lab · hosted by Olive Owner');
  assert.equal(h.sent('inviteList').length + h.sent('auditRead').length, 0, 'a member asks for none of the owner’s lists');
});

// ---------------------------------------------------------------- people and activity

test('People: the count, the presence dot and quiet fact of each person; the owner has the link to Settings', async (t) => {
  const h = await open(t);
  const people = sec(h, 'people');
  assert.match(text(people.querySelector('.team-ov__h')), /^People 3 of 8 · 1 waiting/);
  assert.deepEqual([...people.querySelectorAll('.team-row--member .team-row__name')].map(text).map((s) => s.replace(/[⁨⁩]/g, '')), ['Olive Owner (you)', 'Dot']);
  assert.equal(people.querySelectorAll('.team-dot').length, 2);
  assert.equal(text(people.querySelector('.team-ov__h button')), 'Roles and removal');
  people.querySelector('.team-ov__h button').click();
  assert.deepEqual(h.opened, ['team']);
});

test('Recent activity: the latest five entries, newest first, with All activity; "Nothing has happened yet." when empty; owners only', async (t) => {
  const entries = [1, 2, 3, 4, 5, 6, 7].map((seq) => entry(seq, seq === 7 ? { kind: 'member_admitted', subject_member_id: DOT } : {}));
  const h = await open(t, { answers: { auditRead: { ok: true, entries, next_cursor: null } } });
  const log = [...sec(h, 'activity').querySelectorAll('.team-ov-log li')];
  assert.equal(log.length, 5);
  assert.match(text(log[0]), /You let Dot in/);
  assert.match(text(log[1]), /You created an invite/);
  assert.equal(text(sec(h, 'activity').querySelector('.team-ov__h button')), 'All activity');
  const empty = await open(t);
  assert.equal(text(sec(empty, 'activity').querySelector('.team-ov__empty')), 'Nothing has happened yet.');
});

// ---------------------------------------------------------------- what it holds

test('what the page asks the store for is held while it is shown and released when it is left', async (t) => {
  const h = await open(t, { show: false });
  const wants = [];
  const use = h.store.use;
  h.store.use = (wanted) => { const release = use(wanted); wants.push({ wanted, released: false }); const at = wants.length - 1; return () => { wants[at].released = true; release(); }; };
  rowOf(h).click();
  await flush();
  assert.equal(wants.length, 1, 'one hold');
  assert.deepEqual(wants[0].wanted, { rosters: 'hosted', devices: true, ownerLists: true });
  assert.equal(wants[0].released, false);
  assert.ok(h.sent('deviceList').length >= 1 && h.sent('inviteList').length >= 1 && h.sent('auditRead').length >= 1, 'read for the page');
  h.view.click('[data-team-channel="chan_team"]');
  await flush();
  assert.equal(wants[0].released, true, 'released when Overview is left');
  rowOf(h).click();
  await flush();
  h.tab.hideTeamTab();
  assert.equal(wants.length, 2);
  assert.equal(wants[1].released, true, 'and when the tab is hidden');
});

// ---------------------------------------------------------------- narrow

test('under 720 px Overview is a channel: the list first, then the page with Back', async (t) => {
  const h = await open(t, { show: false });
  const shell = () => h.view.q('.team-shell');
  rowOf(h).click();
  await flush();
  assert.equal(shell().dataset.screen, 'channel');
  const back = h.view.q('.team-head [data-team-tab-action="back"]');
  assert.ok(back, 'the page has Back');
  assert.equal(back.getAttribute('aria-label'), 'Back to the list');
  back.click();
  await flush();
  assert.equal(shell().dataset.screen, 'list');
  assert.ok(page(h), 'the page stays for when it is picked again');
  rowOf(h).click();
  await flush();
  assert.equal(shell().dataset.screen, 'channel');
});

test('a push rewrites only what changed: an untouched fact keeps its element', async (t) => {
  const h = await open(t);
  const server = fact(h, 'server');
  const people = sec(h, 'people');
  h.listeners.state({ teams: [snapshot({ since: 9 })] });
  await pushed();
  assert.equal(fact(h, 'server'), server);
  assert.equal(sec(h, 'people'), people);
});

test('hiding the tab drops the invite code from the markup it leaves behind', async (t) => {
  const h = await open(t, { solo: true });
  fact(h, 'seats').querySelector('[data-team-action="ov-invite"]').click();
  await flush();
  act(h, 'invite-create').click();
  await flush();
  assert.ok(h.view.text().includes(CODE));
  h.tab.hideTeamTab();
  assert.equal(h.view.text().includes(CODE), false, 'the hidden view keeps no code');
  assert.equal(h.view.q('.team-set-code'), null);
});

test('Force local greys the GPU switch with its reason', async (t) => {
  const h = await open(t, { answers: { status: { ok: true, teams: [snapshot()], force_local: true } } });
  const toggle = fact(h, 'gpu').querySelector('[data-inv-toggle="teamOvShare"]');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.closest('label').getAttribute('title'), sub(h, 'gpu'));
  toggle.click();
  await flush();
  assert.equal(h.sent('shareSet').length, 0);
});
