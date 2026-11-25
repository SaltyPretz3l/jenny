'use strict';

// Team connections (TEAM_CHAT_PARITY_GAPS item 14): right-click, Shift+F10 or the Menu key on a channel or direct
// conversation row in the Team column opens the context menu with Mark read, Rename, Archive and Copy link.
// Driven through the real tab, column view and channel menu over the harness bridge.
// new-test-file: a new surface (the column rows' own menu); tests/renderer-team-channels.test.js is near its line cap.

const assert = require('node:assert/strict');
const test = require('node:test');

const { dmChannelId } = require('../services/host/team-chat-schema');
const {
  OTHER, ME, DOT, MAYA, CHAN, flush, memberTeam, harness, layout, chatChannel, chatMember, message, overview, key, menu,
} = require('./helpers/team-settings-harness');

const SAM = 'member_sam';
const DESIGN = 'chan_c_aaaaaaaaaaaaaaaa';
const OLD = 'chan_c_cccccccccccccccc';
const DM = dmChannelId([ME, MAYA]);
const PEOPLE = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya'), chatMember(SAM, 'Sam', { role: 'read_only' })];
const custom = (id, name, over = {}) => chatChannel({ channel_id: id, kind: 'channel', name, topic: '', created_by: MAYA, archived: false, archived_by: null,
  changes: [], rev: 3, ...over });
const ROWS = [
  chatChannel({ name: 'team', topic: '', created_by: null, archived: false, archived_by: null, changes: [] }),
  custom(DESIGN, 'design', { last_seq: 7, unread: 2, last_read_seq: 5 }),
  custom(OLD, 'old launch', { created_by: ME, archived: true, archived_by: ME }),
  chatChannel({ channel_id: DM, kind: 'dm', participants: [ME, MAYA].sort(), last_seq: 4, unread: 1, last_read_seq: 3 }),
];
const asOwner = () => memberTeam({ role: 'owner', member_id: ME, display_name: 'Olive Owner' });
const asReader = () => memberTeam({ role: 'read_only', member_id: SAM, display_name: 'Sam' });

async function open({ team = memberTeam(), channels = ROWS, answers = {} } = {}) {
  const h = harness({ show: false, teams: [team], answers: {
    chatOverview: overview({ channels, members: PEOPLE }),
    chatHistory: (p) => ({ ok: true, messages: [message(1), message(2)].map((m) => ({ ...m, channel_id: p.channel_id })), has_more: false }),
    chatChannelUpdate: { ok: true, rev: 4 },
    chatChannelArchive: { ok: true, rev: 4 },
    chatMarkRead: { ok: true, last_read_seq: 7 },
    ...answers,
  } });
  layout(h);
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  return h;
}
const rowFor = (h, id) => h.view.q(`[data-team-channel="${id}"]`);
const context = (h, el) => el.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 14 }));
const values = (h) => [...menu(h).querySelectorAll('[role="menuitem"]')].map((el) => el.dataset.value);
const item = (h, value) => menu(h).querySelector(`[data-value="${value}"]`);
const reason = (h, value) => (item(h, value).querySelector('.inv-context-menu-description') || { textContent: '' }).textContent;
const sent = (h, method) => h.sent(method).map((call) => call.payload);

test('right-click on a channel row opens Mark read, Rename, Archive and Copy link with the head menu\'s rules', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  context(h, rowFor(h, DESIGN));
  await flush();
  assert.equal(menu(h).querySelector('.inv-context-menu-heading').textContent, '#design');
  assert.deepEqual(values(h), ['mark-read', 'rename', 'archive', 'copy-link']);
  for (const value of values(h)) assert.equal(item(h, value).disabled, false, value);
  assert.equal(h.view.q('[data-team-channel][aria-current="true"]').dataset.teamChannel, CHAN, 'the right-click does not change the shown channel');
});

test('a member who did not make the channel, #team and a read-only member find the actions disabled with their reasons', async (t) => {
  const h = await open({ team: memberTeam() });
  t.after(h.restore);
  context(h, rowFor(h, DESIGN));
  await flush();
  for (const value of ['rename', 'archive']) {
    assert.equal(item(h, value).disabled, true, value);
    assert.equal(reason(h, value), 'Only Maya, who made it, or the owner can change #design.');
  }
  assert.equal(item(h, 'copy-link').disabled, false);
  key(h, item(h, 'rename'), 'Escape');
  await flush();
  context(h, rowFor(h, CHAN));
  await flush();
  assert.equal(reason(h, 'rename'), '#team is the team’s own channel: everyone is in it and its name stays.');
  assert.equal(item(h, 'archive').disabled, true);
  assert.equal(item(h, 'copy-link').disabled, false);
  key(h, item(h, 'rename'), 'Escape');
  await flush();
  h.restore();

  const reader = await open({ team: asReader() });
  t.after(reader.restore);
  context(reader, rowFor(reader, DESIGN));
  await flush();
  assert.equal(reason(reader, 'rename'), 'Read-only members can read channels but not change them.');
  assert.equal(reason(reader, 'archive'), 'Read-only members can read channels but not change them.');
});

test('an archived channel offers Unarchive in place of Archive, owner only', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="archived-fold"]').click();
  await flush();
  context(h, rowFor(h, OLD));
  await flush();
  assert.deepEqual(values(h), ['mark-read', 'rename', 'unarchive', 'copy-link']);
  assert.equal(item(h, 'unarchive').disabled, false);
  item(h, 'unarchive').click();
  await flush();
  assert.deepEqual(sent(h, 'chatChannelArchive'), [{ team_id: OTHER, channel_id: OLD, on: false }]);
});

test('a direct conversation row has Mark read; Rename, Archive and Copy link say why they are off', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  context(h, rowFor(h, DM));
  await flush();
  assert.deepEqual(values(h), ['mark-read', 'rename', 'archive', 'copy-link']);
  assert.equal(item(h, 'mark-read').disabled, false);
  assert.equal(reason(h, 'rename'), 'This channel cannot be changed here.');
  assert.equal(reason(h, 'archive'), 'This channel cannot be changed here.');
  assert.equal(item(h, 'copy-link').disabled, true);
  assert.equal(reason(h, 'copy-link'), 'A direct conversation has no link.');
});

test('Mark read sends the newest seq; a row with nothing unread says so', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  context(h, rowFor(h, DESIGN));
  await flush();
  item(h, 'mark-read').click();
  await flush();
  assert.deepEqual(sent(h, 'chatMarkRead').filter((p) => p.channel_id === DESIGN), [{ team_id: OTHER, channel_id: DESIGN, seq: 7 }]);
  h.view.q('[data-team-tab-action="archived-fold"]').click();
  await flush();
  context(h, rowFor(h, OLD));
  await flush();
  assert.equal(item(h, 'mark-read').disabled, true);
  assert.equal(reason(h, 'mark-read'), 'Nothing unread.');
});

test('Rename shows the channel and opens the name field; Archive acts on the row it was asked of', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  context(h, rowFor(h, DESIGN));
  await flush();
  item(h, 'rename').click();
  await flush();
  const field = h.view.q('[data-chan-edit="name"]');
  assert.ok(field, 'the name field is open');
  assert.equal(field.value, 'design');
  assert.equal(h.view.q('[data-team-channel][aria-current="true"]').dataset.teamChannel, DESIGN);
  assert.equal(h.window.document.activeElement, field);
  key(h, field, 'Escape');
  await flush();
  context(h, rowFor(h, CHAN));
  await flush();
  key(h, item(h, 'rename'), 'Escape');
  await flush();
  context(h, rowFor(h, DESIGN));
  await flush();
  item(h, 'archive').click();
  await flush();
  assert.deepEqual(sent(h, 'chatChannelArchive'), [{ team_id: OTHER, channel_id: DESIGN, on: true }]);
});

test('Copy link writes the channel\'s jenny-team token', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  context(h, rowFor(h, DESIGN));
  await flush();
  item(h, 'copy-link').click();
  await flush();
  assert.deepEqual(h.copied, ['jenny-team:' + OTHER + '/' + DESIGN]);
});

test('Shift+F10 and the Menu key open the row menu, Esc closes it and the focus is back on the row', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  const row = rowFor(h, DESIGN);
  row.focus();
  key(h, row, 'F10', { shiftKey: true });
  await flush();
  assert.deepEqual(values(h), ['mark-read', 'rename', 'archive', 'copy-link']);
  key(h, item(h, 'rename'), 'Escape');
  await flush();
  assert.equal(menu(h), null);
  assert.equal(h.window.document.activeElement, rowFor(h, DESIGN), 'the focus returns to the row');
  key(h, rowFor(h, DM), 'ContextMenu');
  await flush();
  assert.equal(menu(h).querySelector('.inv-context-menu-heading').textContent.length > 0, true);
  assert.equal(item(h, 'copy-link').disabled, true);
});

// OD-8: a project channel is a first-class human channel, so its row has the same menu, named by its project.
test('a project channel row opens the menu: Mark read and Copy link work, Rename and Archive say why they are off, the heading is the project', async (t) => {
  const SITE = 'chan_project_site';
  const before = globalThis.rendererTeamProjectStore;
  globalThis.rendererTeamProjectStore = { getProjectStore: () => ({ project: (teamId, id) => (teamId === OTHER && id === 'project_site' ? { id, name: 'Site plan', role: 'writer' } : null) }) };
  t.after(() => { if (before === undefined) delete globalThis.rendererTeamProjectStore; else globalThis.rendererTeamProjectStore = before; });
  const project = chatChannel({ channel_id: SITE, kind: 'project', audience: [ME, DOT], last_seq: 6, unread: 2, last_read_seq: 4 });
  const h = await open({ team: asOwner(), channels: [...ROWS, project] });
  t.after(h.restore);
  const el = h.window.document.createElement('button');
  el.dataset.teamChannel = SITE;
  h.view.q('[data-team-region="lists"]').appendChild(el); // the projects column draws its own row; the menu reads the attribute
  context(h, el);
  await flush();
  assert.equal(menu(h).querySelector('.inv-context-menu-heading').textContent, '#Site plan');
  assert.deepEqual(values(h), ['mark-read', 'rename', 'archive', 'copy-link']);
  assert.equal(item(h, 'mark-read').disabled, false);
  assert.equal(item(h, 'rename').disabled, true);
  assert.equal(reason(h, 'rename'), 'This channel cannot be changed here.');
  assert.equal(reason(h, 'archive'), 'This channel cannot be changed here.');
  assert.equal(item(h, 'copy-link').disabled, false);
  item(h, 'copy-link').click();
  await flush();
  assert.deepEqual(h.copied, ['jenny-team:' + OTHER + '/' + SITE]);
});
