'use strict';

// Team channels (row 173, renderer slice): the Channels list with its folded Archived group, the New channel view, the
// header's topic line and options menu, in-place rename and topic, change lines in the timeline, the archived channel's
// closed composer and the delete confirmation. Through the real tab, view, channels module, form, menu, timeline and
// composer over the harness bridge (tests/helpers/team-settings-harness.js); the host's answers are stubbed.
// new-test-file: a new surface (channel management UI); the tab, view and timeline tests keep their own surfaces.

const assert = require('node:assert/strict');
const test = require('node:test');

const { dmChannelId } = require('../services/host/team-chat-schema');
const channelMenu = require('../renderer/team/renderer-team-channel-menu');
const {
  OTHER, ME, DOT, MAYA, CHAN, flush, memberTeam, harness, layout, chatChannel, chatMember, message, overview, key, type, menu, searchField, searchMatch,
} = require('./helpers/team-settings-harness');

const SAM = 'member_sam';
const DESIGN = 'chan_c_aaaaaaaaaaaaaaaa';
const RANDOM = 'chan_c_bbbbbbbbbbbbbbbb';
const OLD = 'chan_c_cccccccccccccccc';
const NEWID = 'chan_c_dddddddddddddddd';
const PEOPLE = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya'), chatMember(SAM, 'Sam', { role: 'read_only' })];
const AT = Date.UTC(2026, 10, 2, 12);
const custom = (id, name, over = {}) => chatChannel({ channel_id: id, kind: 'channel', name, topic: '', created_by: MAYA, archived: false, archived_by: null,
  changes: [], rev: 3, ...over });
const teamRow = (over = {}) => chatChannel({ name: 'team', topic: '', created_by: null, archived: false, archived_by: null, changes: [], ...over });
const DESIGN_ROW = custom(DESIGN, 'design', { topic: 'Homepage and brand work' });
const ARCHIVED_ROW = custom(OLD, 'old launch', { topic: 'Spring launch, done', created_by: ME, archived: true, archived_by: ME,
  changes: [{ kind: 'archived', by: ME, at: AT, seq_after: 1 }] });
const ROWS = [teamRow(), DESIGN_ROW, custom(RANDOM, 'random', { created_by: DOT }), ARCHIVED_ROW,
  custom('chan_c_eeeeeeeeeeeeeeee', 'q3 retro', { archived: true, archived_by: MAYA })];
const asOwner = () => memberTeam({ role: 'owner', member_id: ME, display_name: 'Olive Owner' });
const asMaya = () => memberTeam({ role: 'member', member_id: MAYA, display_name: 'Maya' });
const asSam = () => memberTeam({ role: 'read_only', member_id: SAM, display_name: 'Sam' });
const FAILURE = (reason) => ({ ok: false, error: { code: 'CMP-HOST-0001', reason } });

async function open({ team = memberTeam(), channels = ROWS, answers = {}, messages = [message(1), message(2)], stored = null } = {}) {
  const h = harness({ show: false, teams: [team], answers: {
    chatOverview: overview({ channels, members: PEOPLE }),
    chatHistory: (p) => ({ ok: true, messages: messages.map((m) => ({ ...m, channel_id: p.channel_id })), has_more: false }),
    chatChannelCreate: { ok: true, channel_id: NEWID, rev: 1 },
    chatChannelUpdate: { ok: true, rev: 4 },
    chatChannelArchive: { ok: true, rev: 4 },
    chatChannelDelete: { ok: true },
    ...answers,
  } });
  layout(h);
  h.cleanups.push(h.chat.use());
  globalThis.inventory.stepModal = require('../renderer/inventory/step-modal');
  if (stored) h.window.localStorage.setItem('jenny.teamShown.v1', JSON.stringify(stored));
  h.showTab();
  await flush();
  return h;
}
const rowFor = (h, id) => h.view.q(`[data-team-channel="${id}"]`);
const names = (h) => h.view.qa('.team-channels [data-team-channel] .team-row__name').map((el) => el.textContent);
const show = async (h, id) => { rowFor(h, id).click(); await flush(); };
const head = (h) => h.view.q('[data-team-region="head"]');
const sub = (h) => head(h).querySelector('.team-head__sub').textContent;
const fold = (h) => h.view.q('[data-team-tab-action="archived-fold"]');
const optionsButton = (h) => head(h).querySelector('[data-team-tab-action="channel-menu"]');
const item = (h, value) => menu(h).querySelector(`[data-value="${value}"]`);
const itemReason = (h, value) => (item(h, value).querySelector('.inv-context-menu-description') || { textContent: '' }).textContent;
const sentOf = (h, method) => h.sent(method).map((call) => call.payload);
const field = (h, which) => h.view.q(`[data-chan-field="${which}"]`);
const help = (h) => field(h, 'name').closest('label').querySelector('.inv-text-field-hint');
const create = (h) => h.view.q('[data-chan-form="create"]');
async function openMenu(h) { optionsButton(h).click(); await flush(); }
async function pick(h, value) { item(h, value).click(); await flush(); }

test('the Channels list: #team, the live channels in order, and a folded Archived count that unfolds', async (t) => {
  const h = await open();
  t.after(h.restore);
  assert.deepEqual(names(h), ['team', 'design', 'random']);
  assert.equal(h.view.q('.team-channels .team-panel__label span').textContent, 'Channels');
  assert.equal(fold(h).textContent.trim(), 'Archived · 2');
  assert.equal(fold(h).getAttribute('aria-expanded'), 'false');
  assert.equal(h.view.qa('.team-row--archived').length, 0, 'folded by default: no archived row is drawn');
  fold(h).click();
  await flush();
  assert.equal(fold(h).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.view.qa('.team-row--archived .team-row__name').map((el) => el.textContent), ['old launch', 'q3 retro']);
  rowFor(h, DESIGN).click();
  await flush();
  assert.equal(fold(h).getAttribute('aria-expanded'), 'true', 'the fold is remembered while the tab stays');
  fold(h).click();
  await flush();
  assert.equal(h.view.qa('.team-row--archived').length, 0);
});

test('a channel row names itself from the host, escaped, and a team with none archived shows no fold', async (t) => {
  const h = await open({ channels: [teamRow(), custom(DESIGN, '<b>x</b> & y')] });
  t.after(h.restore);
  assert.deepEqual(names(h), ['team', '<b>x</b> & y']);
  assert.equal(h.view.qa('.team-channels b').length, 0, 'markup in a name is text');
  assert.equal(fold(h), null);
  // Everything that names a channel by its id alone (the palette, notifications, the export) reads the name the row gives.
  const channels = require('../renderer/team/renderer-team-channels');
  assert.equal(channels.channelName(DESIGN), '<b>x</b> & y');
  assert.equal(channels.channelName('chan_project_p1'), 'p1', 'a project channel is still named by its id');
});

test('the plus on Channels is a control for a member who may post', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  const plus = h.view.q('.team-channels [data-team-tab-action="channel-new"]');
  assert.equal(plus.disabled, false);
  assert.equal(plus.getAttribute('aria-label'), 'New channel');
  assert.equal(plus.getAttribute('title'), 'New channel');
});

test('the plus is disabled with the reason for a read-only member', async (t) => {
  const ro = await open({ team: asSam() });
  t.after(ro.restore);
  const off = ro.view.q('.team-channels [data-team-tab-action="channel-new"]');
  assert.equal(off.disabled, true);
  assert.equal(off.getAttribute('title'), 'Read-only members can read channels but not change them.');
  assert.equal(off.getAttribute('aria-label'), 'Read-only members can read channels but not change them.');
});

test('channelActions: who may do what on a live custom channel, an archived one and #team', () => {
  const mine = (id) => ({ role: 'member', member_id: id });
  const owner = { role: 'owner', member_id: ME };
  const readonly = { role: 'read_only', member_id: SAM };
  const who = (id) => ({ [MAYA]: 'Maya', [ME]: 'Olive Owner' }[id] || '');
  const allowed = (actions) => Object.entries(actions).filter(([, why]) => why === null).map(([name]) => name).sort();
  // A live channel Maya made.
  assert.deepEqual(allowed(channelMenu.channelActions(DESIGN_ROW, owner, who)), ['archive', 'create', 'rename', 'topic']);
  assert.deepEqual(allowed(channelMenu.channelActions(DESIGN_ROW, mine(MAYA), who)), ['archive', 'create', 'rename', 'topic']);
  const other = channelMenu.channelActions(DESIGN_ROW, mine(DOT), who);
  assert.deepEqual(allowed(other), ['create']);
  assert.equal(other.rename, 'Only Maya, who made it, or the owner can change #design.');
  assert.equal(other.delete, 'Only the owner can delete a channel.');
  assert.equal(channelMenu.channelActions(DESIGN_ROW, owner, who).delete, 'Archive it first. A live channel cannot be deleted in one step.');
  assert.equal(channelMenu.channelActions(DESIGN_ROW, owner, who).unarchive, 'It is not archived.');
  const none = channelMenu.channelActions(DESIGN_ROW, readonly, who);
  assert.deepEqual(allowed(none), []);
  assert.equal(none.create, 'Read-only members can read channels but not change them.');
  assert.equal(none.rename, none.create);
  // An archived one the owner made: only the owner brings it back or deletes it.
  assert.deepEqual(allowed(channelMenu.channelActions(ARCHIVED_ROW, owner, who)), ['create', 'delete', 'unarchive']);
  const mineArchived = channelMenu.channelActions(ARCHIVED_ROW, mine(MAYA), who);
  assert.equal(mineArchived.unarchive, 'Only the owner can bring an archived channel back.');
  assert.equal(mineArchived.delete, 'Only the owner can delete a channel.');
  assert.equal(channelMenu.channelActions(ARCHIVED_ROW, owner, who).rename, 'It is archived. Unarchive it to change it.');
  // #team: only its topic, only for the owner.
  const fixed = (team) => channelMenu.channelActions(teamRow(), team, who);
  assert.deepEqual(allowed(fixed(owner)), ['create', 'topic']);
  assert.deepEqual(allowed(fixed(mine(DOT))), ['create']);
  assert.equal(fixed(mine(DOT)).topic, 'Only the owner sets #team’s topic.');
  assert.equal(fixed(owner).rename, '#team is the team’s own channel: everyone is in it and its name stays.');
  assert.equal(fixed(owner).delete, fixed(owner).rename);
  // A creator the roster no longer knows: the owner is named instead.
  assert.equal(channelMenu.channelActions(custom(RANDOM, 'random', { created_by: 'member_gone' }), mine(DOT), () => '').rename,
    'Only the owner can change #random.');
});

test('New channel opens in the main area; the name is checked as it is typed and Create is off until it is valid', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="channel-new"]').click();
  await flush();
  assert.equal(head(h).querySelector('.team-head__name').textContent, 'New channel');
  assert.ok(h.view.q('[data-team-region="picker"]'), 'it takes the place of the timeline and composer');
  assert.equal(h.view.q('[data-team-region="timeline"]'), null);
  assert.match(h.view.q('.team-newchan__who').textContent, /^Everyone on this team can read and post in it, people who join later included\. Read-only members can read it\. You can rename or archive it later; the owner can too\.$/u);
  assert.equal(create(h).disabled, true, 'nothing typed yet');
  const say = (text) => { type(h, text, field(h, 'name')); return help(h); };
  assert.equal(say('Random').textContent, 'There is already a #random.');
  assert.equal(create(h).disabled, true);
  assert.equal(say('OLD LAUNCH').textContent, 'An archived channel is named #old launch. Unarchive it, or pick another name.');
  assert.equal(say('x'.repeat(41)).textContent, 'Up to 40 characters.');
  assert.equal(say('#lunch').textContent, 'Do not start the name with #.');
  assert.equal(say('   ').dataset.error, undefined, 'blank is not an error, only not yet valid');
  assert.equal(create(h).disabled, true);
  assert.equal(say('lunch plans').dataset.error, undefined);
  assert.equal(create(h).disabled, false);
});

test('a refused Create keeps the form and says why under the field', async (t) => {
  const h = await open({ team: asOwner(), answers: { chatChannelCreate: FAILURE('team_chat_channel_name_taken') } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="channel-new"]').click();
  await flush();
  type(h, '  lunch plans  ', field(h, 'name'));
  type(h, ' where we eat ', field(h, 'topic'));
  create(h).click();
  await flush();
  assert.deepEqual(sentOf(h, 'chatChannelCreate'), [{ team_id: OTHER, name: 'lunch plans', topic: 'where we eat' }]);
  assert.equal(help(h).textContent, 'There is already a channel with that name.');
  assert.equal(help(h).dataset.error, 'true');
  assert.equal(head(h).querySelector('.team-head__name').textContent, 'New channel', 'a refusal keeps the form');
  assert.equal(field(h, 'name').value, '  lunch plans  ', 'and what was typed');
});

test('Create sends the trimmed name, Enter in the name field creates, and the new channel is shown by its name until its row arrives', async (t) => {
  const ok = await open({ team: asOwner() });
  t.after(ok.restore);
  ok.view.q('[data-team-tab-action="channel-new"]').click();
  await flush();
  type(ok, 'lunch plans', field(ok, 'name'));
  key(ok, field(ok, 'name'), 'Enter');
  await flush();
  assert.deepEqual(sentOf(ok, 'chatChannelCreate'), [{ team_id: OTHER, name: 'lunch plans' }], 'no topic key when none was typed');
  assert.equal(head(ok).querySelector('.team-head__name').textContent, '#lunch plans', 'shown at once, by the name it was made with');
  ok.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [custom(NEWID, 'lunch plans', { created_by: ME })] });
  await flush();
  assert.equal(rowFor(ok, NEWID).getAttribute('aria-current'), 'true');
  assert.ok(ok.sent('chatHistory').some((c) => c.payload.channel_id === NEWID), 'the timeline opened it');
});

test('Esc and Cancel close the New channel view and send nothing', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  await show(h, DESIGN);
  h.view.q('[data-team-tab-action="channel-new"]').click();
  await flush();
  type(h, 'lunch', field(h, 'name'));
  key(h, field(h, 'name'), 'Escape');
  await flush();
  assert.equal(head(h).querySelector('.team-head__name').textContent, '#design', 'back to the channel shown before');
  assert.equal(h.window.document.activeElement, h.view.q('[data-team-tab-action="channel-new"]'), 'the focus is back on the plus');
  h.view.q('[data-team-tab-action="channel-new"]').click();
  await flush();
  h.view.q('[data-chan-form="cancel"]').click();
  await flush();
  assert.equal(head(h).querySelector('.team-head__name').textContent, '#design');
  assert.deepEqual(h.sent('chatChannelCreate'), []);
});

test('the header leads with the topic; an archived channel leads with who archived it and when', async (t) => {
  const h = await open({ team: memberTeam() });
  t.after(h.restore);
  assert.equal(sub(h), 'Everyone on this team · 4 people', '#team has no topic here');
  await show(h, DESIGN);
  assert.equal(sub(h), 'Homepage and brand work · Everyone on this team · 4 people');
  assert.equal(head(h).querySelector('.team-head__topic').getAttribute('dir'), 'auto');
  await show(h, RANDOM);
  assert.equal(sub(h), 'Everyone on this team · 4 people', 'no topic, no empty lead');
  fold(h).click();
  await flush();
  await show(h, OLD);
  assert.match(sub(h), /^Archived .+ by Olive Owner · Spring launch, done · Everyone on this team · 4 people$/u);
  assert.equal(head(h).querySelector('.team-head__name').textContent, '#old launch');
});

test('the options button names itself and opens the menu with a #name heading; a conversation has none', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  await show(h, DESIGN);
  assert.equal(optionsButton(h).getAttribute('aria-label'), 'Channel options');
  assert.equal(optionsButton(h).getAttribute('title'), 'Channel options');
  await openMenu(h);
  assert.equal(menu(h).querySelector('.inv-context-menu-heading').textContent, '#design');
  assert.equal(optionsButton(h).getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...menu(h).querySelectorAll('[role="menuitem"]')].map((el) => el.dataset.value), ['rename', 'topic', 'archive', 'delete']);
  assert.equal(item(h, 'rename').disabled, false);
  assert.equal(item(h, 'archive').disabled, false);
  assert.equal(item(h, 'delete').disabled, true);
  assert.equal(itemReason(h, 'delete'), 'Archive it first. A live channel cannot be deleted in one step.');
  key(h, item(h, 'rename'), 'Escape');
  await flush();
  assert.equal(menu(h), null);
  assert.equal(h.window.document.activeElement, optionsButton(h), 'the focus returns to the opener');
  const dm = dmChannelId([ME, MAYA]);
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ channel_id: dm, kind: 'dm', participants: [ME, MAYA].sort() })] });
  await flush();
  await show(h, dm);
  assert.equal(optionsButton(h), null, 'a conversation has no channel options');
});

test('the menu for a member who did not make it, #team and an archived channel keeps every action with its reason', async (t) => {
  const h = await open({ team: memberTeam() });
  t.after(h.restore);
  await show(h, DESIGN);
  await openMenu(h);
  for (const value of ['rename', 'topic', 'archive']) {
    assert.equal(item(h, value).disabled, true, value);
    assert.equal(itemReason(h, value), 'Only Maya, who made it, or the owner can change #design.');
  }
  assert.equal(itemReason(h, 'delete'), 'Only the owner can delete a channel.');
  key(h, item(h, 'rename'), 'Escape');
  await flush();
  await show(h, CHAN);
  await openMenu(h);
  assert.equal(itemReason(h, 'topic'), 'Only the owner sets #team’s topic.');
  assert.equal(itemReason(h, 'rename'), '#team is the team’s own channel: everyone is in it and its name stays.');
  assert.equal(item(h, 'archive').disabled, true);
  key(h, item(h, 'topic'), 'Escape');
  await flush();
  fold(h).click();
  await flush();
  await show(h, OLD);
  await openMenu(h);
  assert.deepEqual([...menu(h).querySelectorAll('[role="menuitem"]')].map((el) => el.dataset.value), ['unarchive', 'delete']);
  assert.equal(itemReason(h, 'unarchive'), 'Only the owner can bring an archived channel back.');
  assert.equal(item(h, 'delete').classList.contains('inv-context-menu-item--danger'), true);
});

test('Rename turns the name into a field: Enter sends the update with the row revision, Esc sends nothing', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  await show(h, DESIGN);
  await openMenu(h);
  await pick(h, 'rename');
  const edit = head(h).querySelector('[data-chan-edit="name"]');
  assert.equal(edit.value, 'design');
  assert.equal(h.window.document.activeElement, edit);
  assert.equal(head(h).querySelector('.team-head__hint').textContent, 'Enter saves · Esc cancels');
  type(h, 'visual', edit);
  key(h, edit, 'Escape');
  await flush();
  assert.deepEqual(h.sent('chatChannelUpdate'), [], 'Esc sends nothing');
  assert.equal(head(h).querySelector('[data-chan-edit]'), null);
  assert.equal(head(h).querySelector('.team-head__name').textContent, '#design');
  assert.equal(h.window.document.activeElement, optionsButton(h));
  await openMenu(h);
  await pick(h, 'rename');
  const again = head(h).querySelector('[data-chan-edit="name"]');
  type(h, '  visual  ', again);
  key(h, again, 'Enter');
  await flush();
  assert.deepEqual(sentOf(h, 'chatChannelUpdate'), [{ team_id: OTHER, channel_id: DESIGN, name: 'visual', expected_rev: 3 }]);
  assert.equal(head(h).querySelector('[data-chan-edit]'), null, 'success closes the field; the push renames the row');
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [{ ...DESIGN_ROW, name: 'visual', rev: 4 }] });
  await flush();
  assert.equal(head(h).querySelector('.team-head__name').textContent, '#visual');
  assert.deepEqual(names(h), ['team', 'visual', 'random']);
});

test('Edit topic turns the sub line into a field; a refusal keeps it open with the reason, a name that did not change sends nothing', async (t) => {
  const h = await open({ team: asOwner(), answers: { chatChannelUpdate: FAILURE('team_chat_stale') } });
  t.after(h.restore);
  await show(h, DESIGN);
  await openMenu(h);
  await pick(h, 'topic');
  const edit = head(h).querySelector('[data-chan-edit="topic"]');
  assert.equal(edit.value, 'Homepage and brand work');
  key(h, edit, 'Enter');
  await flush();
  assert.deepEqual(h.sent('chatChannelUpdate'), [], 'an unchanged topic is not sent');
  assert.equal(head(h).querySelector('[data-chan-edit]'), null);
  await openMenu(h);
  await pick(h, 'topic');
  const field2 = head(h).querySelector('[data-chan-edit="topic"]');
  type(h, 'Brand and web', field2);
  key(h, field2, 'Enter');
  await flush();
  assert.deepEqual(sentOf(h, 'chatChannelUpdate'), [{ team_id: OTHER, channel_id: DESIGN, topic: 'Brand and web', expected_rev: 3 }]);
  const kept = head(h).querySelector('[data-chan-edit="topic"]');
  assert.ok(kept, 'the field stays open');
  assert.equal(kept.value, 'Brand and web', 'with what was typed');
  assert.match(head(h).querySelector('.team-head__hint').textContent, /^This channel changed while you were editing\./u);
});

test('Archive sends on: true; Unarchive from the closed composer sends on: false and is disabled with its reason for a member', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  await show(h, DESIGN);
  await openMenu(h);
  await pick(h, 'archive');
  assert.deepEqual(sentOf(h, 'chatChannelArchive'), [{ team_id: OTHER, channel_id: DESIGN, on: true }]);
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [{ ...DESIGN_ROW, archived: true, archived_by: ME, rev: 4 }] });
  await flush();
  assert.equal(h.view.q('.team-composer__input'), null, 'nobody can post in it');
  const closed = h.view.q('.team-composer--closed');
  assert.match(closed.textContent, /#design is archived\. Its messages stay readable; nobody can post in it\./u);
  const unarchive = closed.querySelector('[data-chan-composer="unarchive"]');
  assert.equal(unarchive.disabled, false);
  unarchive.click();
  await flush();
  assert.deepEqual(sentOf(h, 'chatChannelArchive').at(-1), { team_id: OTHER, channel_id: DESIGN, on: false });
});

test('Unarchive is disabled with its reason for a member who is not the owner', async (t) => {
  const dot = await open({ team: memberTeam() });
  t.after(dot.restore);
  fold(dot).click();
  await flush();
  await show(dot, OLD);
  const off = dot.view.q('[data-chan-composer="unarchive"]');
  assert.equal(off.disabled, true);
  assert.equal(off.getAttribute('title'), 'Only the owner can bring an archived channel back.');
  assert.deepEqual(dot.sent('chatChannelArchive'), []);
});

test('F16: the shown channel is kept per team and is the selection the next time the team is shown; a gone one falls back to #team without a word', async (t) => {
  const stored = () => JSON.parse(h.window.localStorage.getItem('jenny.teamShown.v1') || '{}');
  let h = await open({ team: asOwner() });
  t.after(() => h.restore());
  await show(h, DESIGN);
  assert.deepEqual(stored(), { [OTHER]: DESIGN });
  await show(h, CHAN);
  assert.deepEqual(stored(), {}, '#team is the default: nothing is kept');
  h.restore();
  h = await open({ team: asOwner(), stored: { [OTHER]: DESIGN } });
  assert.equal(h.view.q('[data-team-channel][aria-current="true"]').dataset.teamChannel, DESIGN, 'restored');
  assert.equal(head(h).querySelector('.team-head__title, h2, .team-head__name').textContent.includes('design'), true);
  h.restore();
  h = await open({ team: asOwner(), stored: { [OTHER]: 'chan_c_zzzzzzzzzzzzzzzz' } });
  assert.equal(h.view.q('[data-team-channel][aria-current="true"]').dataset.teamChannel, CHAN, 'a channel that is gone falls back');
  assert.deepEqual(stored(), {}, 'and the preference is dropped');
  assert.equal(h.view.q('.team-head__note, [role="alert"]'), null, 'with no note');
  h.restore();
  h = await open({ team: asOwner(), stored: { [OTHER]: 'not a channel id' } });
  assert.equal(h.view.q('[data-team-channel][aria-current="true"]').dataset.teamChannel, CHAN, 'a value that is not an id is ignored');
});

test('change lines sit after the message they follow: made, renamed, topic, archived, brought back', async (t) => {
  const changes = [
    { kind: 'created', by: MAYA, at: AT, seq_after: 0 },
    { kind: 'renamed', by: ME, at: AT, seq_after: 1, from: 'a', to: 'design' },
    { kind: 'topic', by: DOT, at: AT, seq_after: 2 },
    { kind: 'archived', by: ME, at: AT, seq_after: 2 },
    { kind: 'unarchived', by: ME, at: AT, seq_after: 3 },
  ];
  const h = await open({ team: asOwner(), channels: [teamRow(), custom(DESIGN, 'design', { changes })], messages: [message(1), message(2), message(3)] });
  t.after(h.restore);
  await show(h, DESIGN);
  const log = h.view.q('[data-team-region="timeline"] .team-scroll');
  const flow = [...log.children].filter((el) => el.classList.contains('team-msg') || el.classList.contains('team-chan-event'))
    .map((el) => (el.classList.contains('team-msg') ? 'msg' + el.dataset.seq : el.textContent));
  assert.deepEqual(flow, [
    'Maya made #a · Everyone on this team can read it', 'msg1', // row 173: the name it was made with, not today's
    'You renamed the channel from #a to #design', 'msg2',
    'Dot changed the topic', 'You archived the channel',
    'msg3', 'You brought the channel back',
  ]);
  assert.equal(log.querySelector('.team-chan-event b').textContent, 'Maya');
});

test('in a channel with no messages yet the channel\'s start comes first, then its change lines', async (t) => {
  // Live run 2026-11-16: "You made #design" sat above "#design · Everyone on the team can read and post here."
  const changes = [{ kind: 'created', by: MAYA, at: AT, seq_after: 0 }, { kind: 'topic', by: MAYA, at: AT, seq_after: 0 }];
  const h = await open({ team: asOwner(), channels: [teamRow(), custom(DESIGN, 'design', { changes })], messages: [] });
  t.after(h.restore);
  await show(h, DESIGN);
  const log = h.view.q('[data-team-region="timeline"] .team-scroll');
  const flow = [...log.children].filter((el) => el.classList.contains('team-chan-event') || el.querySelector('b') && /read and post here/.test(el.textContent))
    .map((el) => (el.classList.contains('team-chan-event') ? el.textContent : 'start'));
  assert.deepEqual(flow, ['start', 'Maya made #design · Everyone on this team can read it', 'Maya changed the topic']);
});

test('a change line past an unloaded page waits for it, and a name in one is text', async (t) => {
  const changes = [{ kind: 'created', by: MAYA, at: AT, seq_after: 0 }, { kind: 'renamed', by: MAYA, at: AT, seq_after: 1, from: '<i>a</i>', to: 'design' }];
  const h = await open({ team: asOwner(), channels: [teamRow(), custom(DESIGN, 'design', { changes })], messages: [message(5), message(6)],
    answers: { chatHistory: (p) => ({ ok: true, messages: [message(5, { channel_id: p.channel_id }), message(6, { channel_id: p.channel_id })], has_more: true }) } });
  t.after(h.restore);
  await show(h, DESIGN);
  const log = h.view.q('[data-team-region="timeline"] .team-scroll');
  assert.equal(log.querySelectorAll('.team-chan-event').length, 0, 'older messages are not loaded: where the lines go is not known');
  assert.equal(log.querySelectorAll('i').length, 0);
});

test('Delete channel… asks first; Cancel and Esc send nothing, Delete channel sends and #team is shown', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  fold(h).click();
  await flush();
  await show(h, OLD);
  await openMenu(h);
  await pick(h, 'delete');
  const dialog = () => h.window.document.querySelector('[data-step-modal="team-channel-delete"] [role="dialog"], [data-step-modal="team-channel-delete"] [role="alertdialog"]');
  assert.ok(dialog(), 'a modal asks first');
  assert.equal(dialog().querySelector('.inv-step-modal-title').textContent, 'Delete #old launch?');
  assert.equal(dialog().querySelector('.inv-step-modal-summary').textContent, 'Its messages, files and pins are removed from the host for every member. Nobody can get them back.');
  assert.match(dialog().querySelector('.inv-step-modal-body').textContent, /export it first/u);
  assert.deepEqual([...dialog().querySelectorAll('[data-step-modal-action]')].map((el) => el.textContent), ['Export first…', 'Cancel', 'Delete channel']);
  assert.equal(dialog().classList.contains('inv-step-modal--danger'), true);
  dialog().querySelector('[data-step-modal-action="cancel"]').click();
  await flush();
  assert.equal(dialog(), null);
  assert.deepEqual(h.sent('chatChannelDelete'), [], 'Cancel deletes nothing');
  await openMenu(h);
  await pick(h, 'delete');
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flush();
  assert.equal(dialog(), null);
  assert.deepEqual(h.sent('chatChannelDelete'), [], 'Esc deletes nothing');
  assert.equal(h.window.document.activeElement, optionsButton(h), 'the focus returns to the opener');
  await openMenu(h);
  await pick(h, 'delete');
  dialog().querySelector('[data-step-modal-action="delete"]').click();
  await flush();
  assert.deepEqual(sentOf(h, 'chatChannelDelete'), [{ team_id: OTHER, channel_id: OLD }]);
  h.listeners.chat({ team_id: OTHER, type: 'channels', channels: ROWS.filter((row) => row.channel_id !== OLD) });
  await flush();
  assert.equal(head(h).querySelector('.team-head__name').textContent, '#team');
  assert.equal(rowFor(h, OLD), null);
});

test('a refused delete says why in the dialog and keeps it open', async (t) => {
  const h = await open({ team: asOwner(), answers: { chatChannelDelete: FAILURE('team_chat_channel_live') } });
  t.after(h.restore);
  fold(h).click();
  await flush();
  await show(h, OLD);
  await openMenu(h);
  await pick(h, 'delete');
  h.window.document.querySelector('[data-step-modal-action="delete"]').click();
  await flush();
  const dialog = h.window.document.querySelector('[data-step-modal="team-channel-delete"]');
  assert.ok(dialog, 'still open');
  assert.match(dialog.querySelector('[role="alert"]').textContent, /Archive the channel first\./u);
});

test('a push while a field is open keeps what was typed and the keyboard focus', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  await show(h, DESIGN);
  await openMenu(h);
  await pick(h, 'rename');
  const edit = head(h).querySelector('[data-chan-edit="name"]');
  type(h, 'vis', edit);
  const before = head(h).innerHTML;
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [{ ...DESIGN_ROW, notify: 'none' }] });
  await flush();
  assert.notEqual(head(h).innerHTML, before, 'the header was drawn again');
  const again = head(h).querySelector('[data-chan-edit="name"]');
  assert.equal(again.value, 'vis');
  assert.equal(h.window.document.activeElement, again);
  key(h, again, 'Enter');
  await flush();
  assert.deepEqual(sentOf(h, 'chatChannelUpdate'), [{ team_id: OTHER, channel_id: DESIGN, name: 'vis', expected_rev: 3 }]);
});

test('switching channel while a field is open drops it without sending', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  await show(h, DESIGN);
  await openMenu(h);
  await pick(h, 'topic');
  assert.ok(head(h).querySelector('[data-chan-edit="topic"]'));
  await show(h, RANDOM);
  assert.equal(head(h).querySelector('[data-chan-edit]'), null);
  assert.deepEqual(h.sent('chatChannelUpdate'), []);
});

test('a search result in a custom channel shows that channel first', async (t) => {
  const h = await open({ team: asOwner(), answers: { chatSearch: { ok: true, matches: [searchMatch(1, { channel_id: DESIGN })], next_cursor: null } } });
  t.after(h.restore);
  type(h, 'message', searchField(h));
  await new Promise((resolve) => { setTimeout(resolve, 350); });
  await flush();
  h.view.q('.team-result').click();
  await flush();
  assert.equal(head(h).querySelector('.team-head__name').textContent, '#design');
});

test('Export first… closes the dialog and starts the existing export of that channel, deleting nothing', async (t) => {
  const h = await open({ team: asOwner() });
  t.after(h.restore);
  fold(h).click();
  await flush();
  await show(h, OLD);
  await openMenu(h);
  await pick(h, 'delete');
  const asked = h.sent('chatOverview').length;
  h.window.document.querySelector('[data-step-modal-action="export"]').click();
  await flush();
  assert.equal(h.window.document.querySelector('[data-step-modal="team-channel-delete"]'), null);
  assert.ok(h.sent('chatOverview').length > asked, 'the export read the team to name and gather the channel');
  assert.deepEqual(h.sent('chatChannelDelete'), []);
});

// Each team script captures its dependencies' globals once, when it is evaluated, and a script already loaded by an
// earlier group is not evaluated again; so in every group that loads the channels module, the channel menu and the
// team words it reads come first (the chat group loads before the tab's).
test('script groups load the channel menu and the team words before the channels module', () => {
  const manifest = require('../renderer/shell/renderer-settings-script-manifest');
  for (const group of ['teamChat', 'teamTab', 'teamSection']) {
    const list = manifest[group].map(([src]) => src);
    const channels = list.indexOf('renderer/team/renderer-team-channels.js');
    if (channels < 0) continue;
    const menu = list.indexOf('renderer/team/renderer-team-channel-menu.js');
    const words = list.indexOf('renderer/shell/renderer-settings-team-strings.js');
    assert.ok(menu >= 0 && menu < channels, `${group}: the channel menu loads before the channels module`);
    assert.ok(words >= 0 && words < menu, `${group}: the team words load before the channel menu`);
  }
});
