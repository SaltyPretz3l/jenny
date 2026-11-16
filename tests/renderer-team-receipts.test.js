'use strict';

// Team chat slice 2b-2: a message's earlier versions behind "edited" and "Seen by" under your own latest message
// (acceptance [8], [9]). Real modules over the harness bridge. In these tests this member is Dot (DOT).

const test = require('node:test');
const assert = require('node:assert/strict');
const { dmChannelId } = require('../services/host/team-chat-schema');
const { OTHER, TEAM, ME, DOT, MAYA, CHAN, flush, memberTeam, chatChannel, chatMember, message, overview, openChat, heldAnswers, key, harness, layout } = require('./helpers/team-settings-harness');

const MIN = 60_000;
const at = (ms) => new Date(ms).toISOString();
const own = (seq, over = {}) => message(seq, { author: { kind: 'member', member_id: DOT }, ...over });
const THREE = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya Okafor')];
const FOUR = THREE.concat(chatMember('member_lena', 'Lena'), chatMember('member_arjun', 'Arjun'));

async function open({ messages = [message(1), own(2)], channel = {}, members, role = 'member', answers = {}, ...rest } = {}) {
  return openChat({ messages, teams: [memberTeam({ role })], members, ...rest, answers: {
    chatOverview: overview({ channels: [chatChannel(channel)], members: members || THREE, reaction_emoji: ['👍'] }),
    ...answers,
  } });
}
const row = (h, seq) => h.view.q(`.team-scroll .team-msg[data-message-id="msg_${String(seq).padStart(26, '0')}"]`);
const edited = (h, seq) => row(h, seq).querySelector('.team-msg__edited');
const hist = (h) => h.view.q('.team-pop--hist');
const versions = (h) => [...hist(h).querySelectorAll('.team-ver')].map((el) => [el.querySelector('.team-ver__when').textContent, el.querySelector('.team-ver__text').textContent.trim()]);
const seen = (h, seq = 2) => row(h, seq).querySelector('.team-seen');
const created = (seq) => message(seq).created_at;

test('[8] edited is a button with its tooltip; it opens Earlier versions with the approved line, oldest first, the first Original only at created_at', async (t) => {
  const stamp = created(2);
  const gate = heldAnswers({ ok: true, rev: 4, trimmed: false, edits: [{ text: 'first draft', edited_at: stamp }, { text: 'second **draft**', edited_at: at(Date.parse(stamp) + 5 * MIN) }] });
  const { h } = await open({ messages: [own(2, { edited_at: at(Date.parse(stamp) + 9 * MIN), text: 'now' })], answers: { chatEdits: gate.answer } });
  t.after(h.restore);
  assert.equal(edited(h, 2).tagName, 'BUTTON');
  assert.equal(edited(h, 2).textContent, 'edited');
  assert.match(edited(h, 2).title, /^Edited .+\. Show earlier versions\.$/);
  const before = h.view.q('.team-scroll').scrollTop;
  edited(h, 2).click();
  assert.equal(hist(h).getAttribute('role'), 'dialog');
  assert.equal(hist(h).getAttribute('aria-label'), 'Earlier versions');
  assert.match(hist(h).textContent, /Loading earlier versions…/);
  assert.deepEqual(gate.calls, [{ team_id: OTHER, channel_id: CHAN, message_id: row(h, 2).dataset.messageId }]);
  gate.release();
  await flush();
  assert.match(hist(h).textContent, /Everyone who can read this conversation can see these\./);
  const list = versions(h);
  assert.match(list[0][0], /^Original, /);
  assert.match(list[1][0], /^Edited /);
  assert.equal(list[0][1], 'first draft');
  assert.equal(list[1][1], 'second draft', 'through the Markdown path');
  assert.ok(hist(h).querySelector('strong'), 'sanitized Markdown');
  assert.equal(h.view.q('.team-scroll').scrollTop, before, 'the timeline does not move');
  key(h, hist(h), 'Escape');
  assert.equal(hist(h), null);
  assert.equal(h.window.document.activeElement, edited(h, 2), 'focus returns to the word');
});

test('[8] ten versions without the original, a trimmed list, a failure with Try again; an earlier version is never markup', async (t) => {
  const stamp = Date.parse(created(2));
  const ten = Array.from({ length: 10 }, (_, i) => ({ text: 'v' + i, edited_at: at(stamp + (i + 1) * MIN) }));
  const { h } = await open({ messages: [own(2, { edited_at: at(stamp + 20 * MIN) })], answers: { chatEdits: { ok: true, rev: 3, trimmed: false, edits: ten } } });
  t.after(h.restore);
  edited(h, 2).click();
  await flush();
  assert.equal(versions(h).length, 10);
  assert.ok(versions(h).every(([when]) => /^Edited /.test(when)), 'none is the original');
  assert.match(hist(h).textContent, /A message keeps its last 10 versions\. Older ones are gone\./);
  const cut = await open({ messages: [own(2, { edited_at: at(stamp + 20 * MIN) })], answers: { chatEdits: { ok: true, rev: 3, trimmed: true, edits: [{ text: '<img src=x onerror=alert(1)> **x**', edited_at: created(2) }] } } });
  cut.h.view.q('.team-msg__edited').click();
  await flush();
  assert.match(cut.h.view.q('.team-pop--hist').textContent, /Older versions are too long to show here\./);
  assert.equal(cut.h.view.q('.team-pop--hist img'), null);
  assert.match(cut.h.view.q('.team-pop--hist .team-ver__when').textContent, /^Edited /, 'a trimmed list never claims the original');
  cut.h.restore();
  const bad = await open({ messages: [own(2, { edited_at: at(stamp + 20 * MIN) })], answers: { chatEdits: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } } } });
  bad.h.view.q('.team-msg__edited').click();
  await flush();
  assert.match(bad.h.view.q('.team-pop--hist').textContent, /The earlier versions could not be loaded\. The team server is not answering\. Try again in a moment\./);
  bad.h.view.q('.team-pop--hist [data-team-hist-action="retry"]').click();
  await flush();
  assert.equal(bad.h.sent('chatEdits').length, 2);
  bad.h.restore();
});

test('[8] an open versions popover survives a redraw of its row, closes on a click away, and is removed with the frame; offline the word is greyed', async (t) => {
  const stamp = Date.parse(created(2));
  const { h } = await open({ messages: [own(2, { edited_at: at(stamp + MIN) })], answers: { chatEdits: { ok: true, rev: 3, trimmed: false, edits: [{ text: 'a', edited_at: created(2) }] } } });
  t.after(h.restore);
  edited(h, 2).click();
  await flush();
  h.listeners.chat({ team_id: OTHER, type: 'messages', channel_id: CHAN, reset: false, messages: [own(2, { rev: 50, edited_at: at(stamp + MIN), reactions: { '👍': [ME] } })] });
  await flush();
  assert.ok(hist(h) && hist(h).isConnected, 'survives the redraw');
  h.window.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
  assert.equal(hist(h), null);
  edited(h, 2).click();
  await flush();
  h.tab.hideTeamTab();
  assert.equal(h.window.document.querySelector('.team-pop'), null);
  const off = await open({ messages: [own(2, { edited_at: at(stamp + MIN) })] });
  off.h.listeners.state({ teams: [memberTeam({ state: 'offline' })], host: { state: 'stopped' } });
  await flush();
  const word = off.h.view.q('.team-msg__edited');
  assert.equal(word.disabled, true);
  assert.match(word.title, /^Edited .+\. Earlier versions need the team online\.$/);
  word.click();
  assert.equal(off.h.view.q('.team-pop--hist'), null);
  assert.equal(off.h.sent('chatEdits').length, 0);
  off.h.restore();
});

test('[9] team channel: Seen by n of m with m = listed members minus you, everyone when all have, nothing when none has; live from a channels push', async (t) => {
  const { h } = await open({ members: FOUR, channel: { reads: [{ member_id: ME, seq: 2 }] } });
  t.after(h.restore);
  assert.equal(seen(h).textContent, 'Seen by 1 of 4', 'four others');
  assert.equal(seen(h, 1), null, 'only your own latest message');
  const push = (reads) => h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ reads })] });
  push([{ member_id: ME, seq: 2 }, { member_id: MAYA, seq: 5 }, { member_id: 'member_lena', seq: 1 }]);
  await flush();
  assert.equal(seen(h).textContent, 'Seen by 2 of 4', 'a position below the message does not count');
  push([ME, MAYA, 'member_lena', 'member_arjun'].map((member_id) => ({ member_id, seq: 2 })));
  await flush();
  assert.equal(seen(h).textContent, 'Seen by everyone');
  push([{ member_id: ME, seq: 1 }]);
  await flush();
  assert.equal(seen(h), null, 'nothing when none has');
  push([{ member_id: ME, seq: 2 }]);
  await flush();
  push([{ member_id: ME, seq: 1 }]);
  await flush();
  assert.equal(seen(h), null, 'a position can move down and the number falls');
});

test('[9] the button opens Seen by and Not yet, closes on Esc and a click away; a pending or removed person is not in m', async (t) => {
  const { h } = await open({ members: FOUR, channel: { reads: [{ member_id: ME, seq: 2 }, { member_id: MAYA, seq: 2 }] } });
  t.after(h.restore);
  seen(h).click();
  const pop = h.view.q('.team-pop--seen');
  assert.equal(pop.getAttribute('role'), 'dialog');
  const lines = [...pop.querySelectorAll('p')].map((p) => p.textContent);
  assert.deepEqual(lines, ['Seen by Olive Owner and Maya Okafor', 'Not yet Lena and Arjun']);
  key(h, pop, 'Escape');
  assert.equal(h.view.q('.team-pop--seen'), null);
  assert.equal(h.window.document.activeElement, seen(h));
  seen(h).click();
  h.window.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
  assert.equal(h.view.q('.team-pop--seen'), null);
  // The chat store lists active members only: a person who is not in `members` (pending, removed) is not counted.
  const three = await open({ members: THREE, channel: { reads: [{ member_id: ME, seq: 2 }, { member_id: 'member_gone', seq: 2 }] } });
  assert.equal(three.h.view.q('.team-seen').textContent, 'Seen by 1 of 2');
  three.h.restore();
});

test('[9] a project channel reads names, three at most; one-to-one reads Seen', async (t) => {
  const reads = [ME, MAYA, 'member_lena', 'member_arjun'].map((member_id) => ({ member_id, seq: 2 }));
  const project = await open({ members: FOUR, channel: { kind: 'project', reads } });
  t.after(project.h.restore);
  assert.equal(project.h.view.q('.team-seen').textContent, 'Seen by Olive Owner, Maya Okafor and 2 others');
  project.h.view.q('.team-seen').click();
  assert.deepEqual([...project.h.view.qa('.team-pop--seen p')].map((p) => p.textContent), ['Seen by Olive Owner, Maya Okafor, Lena, and Arjun'], 'no Not yet where the audience is unknown');
  const few = await open({ members: FOUR, channel: { kind: 'project', reads: reads.slice(0, 3) } });
  assert.equal(few.h.view.q('.team-seen').textContent, 'Seen by Olive Owner, Maya Okafor, and Lena');
  few.h.restore();
});

// Slice 2b-3: a project row that names its audience gets 2b-2's n of m; m leaves out you and anyone not listed.
test('[9] a project channel with an audience reads n of m over its other listed members', async (t) => {
  const reads = [ME, MAYA].map((member_id) => ({ member_id, seq: 2 }));
  const audience = [DOT, ME, MAYA, 'member_lena', 'member_arjun'].sort();
  const five = await open({ members: FOUR, channel: { kind: 'project', audience, reads } });
  t.after(five.h.restore);
  assert.equal(five.h.view.q('.team-seen').textContent, 'Seen by 2 of 4');
  five.h.view.q('.team-seen').click();
  assert.deepEqual([...five.h.view.qa('.team-pop--seen p')].map((p) => p.textContent), ['Seen by Olive Owner and Maya Okafor', 'Not yet Lena and Arjun']);
  const gone = await open({ members: FOUR, channel: { kind: 'project', audience: [DOT, ME, MAYA, 'member_gone'].sort(), reads } });
  assert.equal(gone.h.view.q('.team-seen').textContent, 'Seen by everyone', 'a member no longer listed is not in m');
  gone.h.restore();
  const none = await open({ members: FOUR, channel: { kind: 'project', reads } });
  assert.equal(none.h.view.q('.team-seen').textContent, 'Seen by Olive Owner and Maya Okafor', 'no audience: names');
  none.h.restore();
});

test('[9] one-to-one reads plain Seen (not a button); a conversation of three reads n of m over the other two', async (t) => {
  const two = dmChannelId([DOT, ME]);
  const three = dmChannelId([DOT, MAYA, ME]);
  const rowFor = (id, participants, reads) => chatChannel({ channel_id: id, kind: 'dm', participants: [...participants].sort(), last_seq: 2, reads });
  const h = harness({ show: false, teams: [memberTeam()], answers: {
    chatOverview: overview({ channels: [chatChannel(), rowFor(two, [DOT, ME], [{ member_id: ME, seq: 2 }]), rowFor(three, [DOT, MAYA, ME], [{ member_id: MAYA, seq: 2 }])], members: THREE }),
    chatHistory: (p) => ({ ok: true, messages: p.channel_id === CHAN ? [] : [message(1, { channel_id: p.channel_id }), own(2, { channel_id: p.channel_id })], has_more: false }),
  } });
  t.after(h.restore);
  layout(h);
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  h.view.q(`[data-team-channel="${two}"]`).click();
  await flush();
  assert.equal(h.view.q('.team-seen').textContent, 'Seen');
  assert.equal(h.view.q('.team-seen').tagName, 'SPAN', 'plain words, not a button');
  h.view.q(`[data-team-channel="${three}"]`).click();
  await flush();
  assert.equal(h.view.q('.team-seen').textContent, 'Seen by 1 of 2');
  assert.equal(h.view.q('.team-seen').tagName, 'BUTTON');
});

// ---------------------------------------------------------------- fix round (orchestrator's list, items 11, 13)
// `c.people` (what the audience of a team channel is made of) is the tab's `presenceOf(team, roster)`: the chat
// overview's `members` (the host lists active members only, read-only ones included) plus any ACTIVE roster member the
// chat has not heard of yet (drawn offline). A pending or removed person is in neither, whatever their read position.

const LENA = 'member_lena';
const PEND = 'member_pending';
const GONE = 'member_removed';
const RO = 'member_readonly';
const rosterRow = (member_id, display_name, over = {}) => ({ member_id, display_name, role: 'member', state: 'active', devices: [], ...over });

test('[9] who is in m, built the way the tab builds it: chat members (a read-only one too) plus the active roster; pending and removed people are not', async (t) => {
  const chatMembers = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(RO, 'Rae Reader', { role: 'read_only' })];
  const roster = [rosterRow(ME, 'Olive Owner', { role: 'owner' }), rosterRow(DOT, 'Dot'), rosterRow(RO, 'Rae Reader', { role: 'read_only' }), rosterRow(LENA, 'Lena'),
    rosterRow(PEND, 'Pat Pending', { state: 'pending' }), rosterRow(GONE, 'Gus Gone', { state: 'removed' })];
  const reads = [{ member_id: ME, seq: 2 }, { member_id: PEND, seq: 2 }, { member_id: GONE, seq: 2 }];
  const { h } = await open({ members: chatMembers, channel: { reads }, answers: {
    members: () => ({ ok: true, team: { team_id: TEAM, name: 'Studio' }, members: roster }),
    chatOverview: overview({ channels: [chatChannel({ reads })], members: chatMembers, reaction_emoji: ['👍'] }) } });
  t.after(h.restore);
  // m = Olive, Rae (read-only, in the chat list) and Lena (active in the roster, not yet in the chat list): 3 people besides Dot.
  // The pending and the removed person each have a read position and are in neither list: they count for nothing.
  assert.equal(h.view.q('.team-seen').textContent, 'Seen by 1 of 3');
  h.view.q('.team-seen').click();
  assert.deepEqual([...h.view.qa('.team-pop--seen p')].map((p) => p.textContent), ['Seen by Olive Owner', 'Not yet Rae Reader and Lena']);
  assert.doesNotMatch(h.view.q('.team-pop--seen').textContent, /Pat|Gus|Former/);
});

test('[9] a removed member shown as Former member: in a project channel their read is named; in a team channel it is not counted', async (t) => {
  const reads = [{ member_id: GONE, seq: 2 }, { member_id: ME, seq: 2 }];
  const project = await open({ members: THREE, channel: { kind: 'project', reads } });
  t.after(project.h.restore);
  assert.equal(project.h.view.q('.team-seen').textContent, 'Seen by Former member and Olive Owner', 'the audience is unknown, so the name is what the roster knows: nothing');
  const team = await open({ members: THREE, channel: { reads } });
  t.after(team.h.restore);
  assert.equal(team.h.view.q('.team-seen').textContent, 'Seen by 1 of 2', 'in the team channel the removed person is outside m');
});

test('[9] a conversation whose other person was removed: participants still holds them, so m still counts them and they read as Former member', async (t) => {
  const GHOST = 'member_ghost';
  const two = dmChannelId([DOT, GHOST]);
  const three = dmChannelId([DOT, MAYA, GHOST]);
  const rowFor = (id, participants, reads) => chatChannel({ channel_id: id, kind: 'dm', participants: [...participants].sort(), last_seq: 2, reads });
  const h = harness({ show: false, teams: [memberTeam()], answers: {
    chatOverview: overview({ channels: [chatChannel(), rowFor(two, [DOT, GHOST], [{ member_id: GHOST, seq: 2 }]), rowFor(three, [DOT, MAYA, GHOST], [{ member_id: MAYA, seq: 2 }])], members: THREE }),
    chatHistory: (p) => ({ ok: true, messages: p.channel_id === CHAN ? [] : [message(1, { channel_id: p.channel_id }), own(2, { channel_id: p.channel_id })], has_more: false }),
  } });
  t.after(h.restore);
  layout(h);
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  h.view.q(`[data-team-channel="${two}"]`).click();
  await flush();
  assert.equal(h.view.q('.team-seen').textContent, 'Seen', 'one other participant, removed or not: plain Seen');
  h.view.q(`[data-team-channel="${three}"]`).click();
  await flush();
  assert.equal(h.view.q('.team-seen').textContent, 'Seen by 1 of 2');
  h.view.q('.team-seen').click();
  assert.deepEqual([...h.view.qa('.team-pop--seen p')].map((p) => p.textContent), ['Seen by Maya Okafor', 'Not yet Former member']);
});

test('names in the Seen by lists and the versions failure line are text', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const { h } = await open({ members: [chatMember(ME, evil, { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, '<b>m</b>')],
    channel: { reads: [{ member_id: ME, seq: 3 }] }, messages: [message(1), own(2), own(3, { edited_at: new Date().toISOString(), rev: 2 })],
    answers: { chatEdits: { ok: false, error: { code: evil, reason: '<b>boom</b>' } } } });
  t.after(h.restore);
  seen(h, 3).click();
  assert.equal(h.view.q('.team-pop--seen').querySelector('img'), null, 'a name draws no markup');
  assert.match(h.view.q('.team-pop--seen').textContent, /^Seen by <img src=x onerror=alert\(1\)>/);
  row(h, 3).querySelector('.team-msg__edited').click();
  await flush();
  assert.equal(hist(h).querySelector('img, b'), null, 'a failure reason draws no markup');
  assert.match(hist(h).textContent, /The earlier versions could not be loaded\. /);
});

test('the edited word and Seen by toggle their lists shut with a real mouse (pointerdown, then click), also after the row was redrawn', async (t) => {
  const stamp = new Date().toISOString();
  const { h } = await open({ messages: [message(1), own(2, { edited_at: stamp, rev: 2 })], channel: { reads: [{ member_id: ME, seq: 2 }] },
    answers: { chatEdits: { ok: true, edits: [{ text: 'first words', edited_at: created(2) }, { text: 'second words', edited_at: stamp }], trimmed: false } } });
  t.after(h.restore);
  const press = (el) => { el.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true })); el.click(); };
  const word = () => row(h, 2).querySelector('.team-msg__edited');
  const old = word();
  press(old);
  await flush();
  assert.ok(hist(h), 'edited opens the versions');
  h.listeners.chat({ team_id: OTHER, type: 'messages', channel_id: CHAN, reset: false, messages: [own(2, { edited_at: stamp, rev: 3, reactions: { '👍': [ME] } })] });
  await flush();
  assert.notEqual(word(), old, 'the redraw replaced the word');
  assert.ok(hist(h), 'the list survives it');
  press(word());
  assert.equal(hist(h), null, 'a real press closes it');
  assert.equal(h.sent('chatEdits').length, 1, 'and asked nothing more');
  press(seen(h));
  assert.ok(h.view.q('.team-pop--seen'), 'Seen by opens');
  h.listeners.chat({ team_id: OTHER, type: 'messages', channel_id: CHAN, reset: false, messages: [own(2, { edited_at: stamp, rev: 4, reactions: { '👍': [ME, DOT] } })] });
  await flush();
  press(seen(h));
  assert.equal(h.view.q('.team-pop--seen'), null, 'a real press on Seen by closes it');
});
