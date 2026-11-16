'use strict';

// Team tab, chat frame (row 123, slice 2a-5a): the left column (Channels, Online and Offline), the
// team menu, the channel header with its notification level, and the three screens under 720 px,
// through the real view, controller, team store, chat store and inventory modules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OTHER, ME, DOT, CHAN, flush, snapshot, memberTeam, hostState, harness, inventory, chatChannel, chatMember, overview, ROSTER } = require('./helpers/team-settings-harness');

const menuOf = (h) => h.window.document.querySelector('.inv-context-menu.team-switch-menu');
const notifyMenu = (h) => h.window.document.querySelector('.inv-context-menu.team-notify-menu');
const itemLabel = (el) => (el.querySelector('.inv-context-menu-text > span') || el.querySelector('span')).textContent;

async function open(options) {
  const h = harness({ show: false, ...options });
  h.showTab();
  await flush();
  return h;
}

test('the column: one #team channel row with its count, then Online and Offline with presence in words', async (t) => {
  const members = [
    chatMember(DOT, 'Dot', { role: 'owner' }),
    chatMember('member_arjun', 'Arjun', { state: 'away' }),
    chatMember('member_tomas', 'Tomas', { role: 'read_only', state: 'offline', last_seen_at: '2026-11-11T07:00:00.000Z' }),
    chatMember('member_yuki', '<b>Yuki</b>', { state: 'offline' }),
  ];
  const h = await open({ teams: [memberTeam()], answers: { members: { ok: true, members: [] }, chatOverview: overview({ members: members.concat(chatMember('member_zed', 'Zed')),
    channels: [chatChannel({ unread: 3, mention: true })] }) } });
  t.after(h.restore);
  const rows = h.view.qa('[data-team-channel]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.teamChannel, CHAN);
  assert.equal(rows[0].querySelector('.team-row__name').textContent, 'team');
  assert.equal(rows[0].getAttribute('aria-current'), 'true');
  assert.equal(rows[0].dataset.unread, 'true');
  const count = rows[0].querySelector('.team-count');
  assert.equal(count.textContent, '3');
  assert.equal(count.dataset.mention, 'true');
  assert.match(rows[0].getAttribute('aria-label'), /3 unread/);
  assert.match(rows[0].getAttribute('aria-label'), /mentions you/, 'the mention is said in words too');
  assert.equal(h.view.q('[data-team-people-search]'), null, 'no search field until 2a-6');
  // Slice 2d: a member who may start a conversation sees "Direct messages" with its plus and no rows yet.
  assert.deepEqual(h.view.qa('[data-team-directs] .team-panel__label').map((el) => el.textContent), ['Direct messages']);
  assert.equal(h.view.qa('.team-dm-row').length, 0);
  const labels = h.view.qa('.team-people .team-panel__label').map((el) => [...el.children].map((span) => span.textContent).join(' '));
  assert.deepEqual(labels, ['Online 3', 'Offline 2']);
  const online = h.view.qa('[data-team-presence="online"] .team-row--member');
  assert.deepEqual(online.map((row) => row.querySelector('.team-row__name').textContent), ['\u2068Dot\u2069 (you)', 'Arjun', 'Zed']);
  assert.equal(online[1].querySelector('.team-row__name').getAttribute('dir'), 'auto', 'a name sets its own direction');
  assert.deepEqual(online.map((row) => row.querySelector('.team-dot').dataset.p), ['online', 'away', 'online']);
  assert.deepEqual(online.map((row) => row.querySelector('.team-row__meta').textContent), ['Owner', 'away', '']);
  const offline = h.view.qa('[data-team-presence="offline"] .team-row--member');
  assert.equal(offline[0].querySelector('.team-row__name').textContent, '<b>Yuki</b>', 'a name with markup is text');
  assert.equal(h.view.q('[data-team-presence="offline"] b'), null);
  const seen = offline[1].querySelector('.team-row__meta').textContent;
  assert.ok(seen && seen !== 'Read-only', 'an offline member shows when they were last seen');
  assert.equal(offline[0].querySelector('.team-row__meta').textContent, '');
});

test('a channel muted to Nothing shows the muted glyph; more than 99 unread reads 99+', async (t) => {
  const h = await open({ teams: [memberTeam()], answers: { chatOverview: overview({ channels: [chatChannel({ notify: 'none', unread: 99, unread_capped: true })] }) } });
  t.after(h.restore);
  const row = h.view.q('[data-team-channel]');
  assert.ok(row.querySelector('.team-row__muted'));
  assert.equal(row.querySelector('.team-count').textContent, '99+');
  assert.equal(row.querySelector('.team-count').dataset.mention, undefined);
});

test('before the chat answers, the column still has #team and the people from the roster', async (t) => {
  const h = await open({ teams: [memberTeam()], answers: { chatOverview: () => new Promise(() => {}) } });
  t.after(h.restore);
  assert.equal(h.view.qa('[data-team-channel]').length, 1);
  assert.ok(h.view.q('[data-team-people-list]'));
});

test('team menu: teams with their mention mark, then Invite someone for an owner, Team settings and Join; each opens Settings', async (t) => {
  const h = await open({ host: hostState(), teams: [snapshot(), memberTeam()], answers: {
    chatOverview: (p) => overview({ channels: [chatChannel({ mention: p.team_id === OTHER, unread: p.team_id === OTHER ? 2 : 0 })] }) } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="switch"]').click();
  const menu = menuOf(h);
  const items = [...menu.querySelectorAll('[role^="menuitem"]')].map(itemLabel);
  assert.deepEqual(items, ['Studio', 'Dot lab', 'Invite someone', 'Share this PC’s GPU…', 'Team settings', 'Join a team with an invite', 'Export'], 'Export ends the menu (2a-6c)');
  const descriptions = [...menu.querySelectorAll('[role="menuitemradio"] .inv-context-menu-description')].map((el) => el.textContent);
  assert.match(descriptions[1], /mentions you/);
  assert.equal(/mentions you/.test(descriptions[0]), false);
  for (const value of ['invite', 'settings', 'join-invite']) {
    if (!menuOf(h)) h.view.q('[data-team-tab-action="switch"]').click();
    menuOf(h).querySelector(`[data-value="${value}"]`).click();
  }
  assert.deepEqual(h.opened, ['team', 'team', 'team']);
  assert.equal(h.view.q('.team-home'), null, 'the old main area is gone');
  assert.equal(h.view.q('[data-team-tab-action="open-settings"]'), null);
});

test('team menu: a member of a team hosted elsewhere gets no Invite someone', async (t) => {
  const h = await open({ teams: [memberTeam()] });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="switch"]').click();
  assert.equal(menuOf(h).querySelector('[data-value="invite"]'), null);
  assert.ok(menuOf(h).querySelector('[data-value="settings"]'));
});

test('channel header: #team, who is in it, and the notification level menu that calls chatSetNotify', async (t) => {
  const h = await open({ teams: [memberTeam()], answers: { chatOverview: overview({ channels: [chatChannel({ notify: 'all' })],
    members: [chatMember(ME, 'Olive'), chatMember(DOT, 'Dot'), chatMember('member_c', 'Cy')] }) } });
  t.after(h.restore);
  assert.equal(h.view.q('.team-head__name').textContent, '#team');
  assert.equal(h.view.q('.team-head__sub').textContent, 'Everyone on this team · 3 people');
  assert.equal(h.view.qa('h2').length, 1);
  const bell = h.view.q('[data-team-tab-action="notify"]');
  assert.equal(bell.getAttribute('aria-haspopup'), 'menu');
  assert.match(bell.getAttribute('aria-label'), /All messages/);
  bell.click();
  const rows = [...notifyMenu(h).querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(rows.map(itemLabel), ['All messages', 'Mentions only', 'Nothing']);
  assert.deepEqual(rows.map((row) => row.getAttribute('aria-checked')), ['true', 'false', 'false']);
  rows[2].click();
  await flush();
  assert.deepEqual(h.sent('chatSetNotify').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, level: 'none' }]);
  assert.match(h.view.q('[data-team-tab-action="notify"]').getAttribute('aria-label'), /Nothing/);
  assert.ok(h.view.q('[data-team-channel] .team-row__muted'));
});

test('a failed notification change is said under the header in words', async (t) => {
  const h = await open({ teams: [memberTeam()], answers: { chatSetNotify: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } } } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="notify"]').click();
  notifyMenu(h).querySelectorAll('[role="menuitemradio"]')[1].click();
  await flush();
  assert.match(h.view.q('[data-team-head-note]').textContent, /not connected/);
  assert.equal(/team_not_connected/.test(h.view.text()), false);
});

test('a team with only you says so in the header', async (t) => {
  const h = await open({ host: hostState(), teams: [snapshot()], answers: { members: { ok: true, members: [ROSTER[0]] },
    chatOverview: overview({ members: [chatMember(ME, 'Olive Owner', { role: 'owner' })] }) } });
  t.after(h.restore);
  assert.equal(h.view.q('.team-head__sub').textContent, 'Everyone on this team · only you so far');
});

test('under 720 px: three screens on .team-shell, Back goes to the list, a channel row comes back; no People toggle', async (t) => {
  const h = await open({ teams: [memberTeam()] });
  t.after(h.restore);
  const shell = () => h.view.q('.team-shell');
  assert.equal(shell().dataset.screen, 'channel', 'opens on the channel');
  assert.equal(shell().dataset.people, undefined);
  assert.equal(h.view.q('[data-team-tab-action="people"]'), null);
  const back = h.view.q('[data-team-tab-action="back"]');
  assert.ok(back.classList.contains('team-back'));
  assert.equal(back.getAttribute('aria-label'), 'Back to the list');
  const timeline = h.view.q('.team-scroll');
  back.click();
  assert.equal(shell().dataset.screen, 'list');
  h.view.q('[data-team-channel]').click();
  assert.equal(shell().dataset.screen, 'channel');
  assert.equal(h.view.q('.team-scroll'), timeline, 'the channel region is not rebuilt by a screen change');
});

test('Alt+Down and Alt+Up move between channel rows (one today)', async (t) => {
  const h = await open({ teams: [memberTeam()] });
  t.after(h.restore);
  const row = h.view.q('[data-team-channel]');
  row.focus();
  const event = new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true });
  row.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.window.document.activeElement, h.view.q('[data-team-channel]'));
});

// The first two-PC run: the search box asked the barrel for `textField`, which only this harness's own
// stand-in had, so the Team tab threw on open in the real app and passed here.
test('the harness inventory and every inv() call in the team files name only members the real barrel has', () => {
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const barrel = fs.readFileSync(path.join(rendererDir, 'inventory', 'index.js'), 'utf8');
  const start = barrel.indexOf('var inventory = {');
  const members = new Set(Array.from(barrel.slice(start, barrel.indexOf('};', start)).matchAll(/^\s+(\w+):/gmu), (m) => m[1]));
  assert.ok(members.has('actionButton') && members.has('statusRow') && !members.has('textField'), 'the barrel was read');
  for (const name of Object.keys(inventory())) assert.ok(members.has(name), `harness inventory: ${name}`);
  const teamDir = path.join(rendererDir, 'team');
  let calls = 0;
  for (const file of fs.readdirSync(teamDir).filter((name) => name.endsWith('.js'))) {
    for (const call of fs.readFileSync(path.join(teamDir, file), 'utf8').matchAll(/\binv\(\)\.(\w+)/gu)) {
      calls += 1;
      assert.ok(members.has(call[1]), `${file}: inv().${call[1]}`);
    }
  }
  assert.ok(calls > 20, `${calls} calls scanned`);
});

// Gate run 2026-11-13, D1: the team's name was 0 px wide. `.inv-status-row` sets width: 100% at the same specificity as
// `.team-panel__host`, so when the inventory rule came later the status took the head's whole content box (255 of
// 271 px) and the switch shrank to its padding. The status rule must outrank the inventory rule in any order, may
// shrink, and the head wraps the status under the name before the name gives way.
test('D1: the team name keeps its room in the panel head whatever order the stylesheets load in', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'team-tab.css'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(selector + ' {');
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  const head = rule('.team-panel__head');
  assert.match(head, /flex-wrap: wrap;/u, 'the status wraps under the name');
  const host = rule('.team-panel__head > .team-panel__host');
  assert.match(host, /flex: 0 1 auto;/u, 'the status may shrink');
  assert.match(host, /width: auto;/u);
  assert.match(host, /min-width: 0;/u);
  assert.equal(/\n\.team-panel__host \{/u.test(css), false, 'no bare rule the inventory row can outrank');
  assert.match(rule('.team-panel__head > .team-switch'), /max-width: 100%;/u, 'a long name ellipsizes inside the head');
  assert.match(rule('.team-panel__title'), /overflow: hidden;[\s\S]*text-overflow: ellipsis;/u);
});
