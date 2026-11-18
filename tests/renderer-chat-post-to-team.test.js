'use strict';

// new-test-file: "Post to Team..." (row 175 F12, owner decision D5) is a new surface in a new module,
// renderer/chat/renderer-chat-post-to-team.js: the destination list, the dialog's readers line and cap, the greyed-out menu
// item with its reason, and the post through the team chat call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPostToTeam, cleanText } = require('../renderer/chat/renderer-chat-post-to-team');
const stepModal = require('../renderer/inventory/step-modal');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');
const { flush } = require('./helpers/chat-messages-fixtures');

const ME = 'member_me';
const DOT = 'member_dot';
const DM = `chan_dm_${'a'.repeat(64)}`;
const LINK = 'jenny-team:team_alpha/chan_team/3/msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const team = (over = {}) => ({ team_id: 'team_alpha', team_name: 'Alpha', state: 'online', role: 'member', member_id: ME, ...over });
const CHAT = {
  team_alpha: {
    members: [{ member_id: ME, display_name: 'Me' }, { member_id: DOT, display_name: 'Dot <b>' }],
    channels: [
      { channel_id: 'chan_team', kind: 'team' },
      { channel_id: 'chan_c_abcdefghijklmnop', kind: 'channel', name: 'design' },
      { channel_id: 'chan_c_qrstuvwxyzabcdef', kind: 'channel', name: 'old', archived: true },
      { channel_id: 'chan_project_p1', kind: 'channel', name: 'a project' },
      { channel_id: DM, kind: 'dm', participants: [ME, DOT] },
    ],
  },
};

function harness(t, { teams = [team()], answers = {}, canQueue, chat = CHAT } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><button id="trigger">menu</button></main></body></html>');
  const documentRef = dom.window.document;
  const posts = [];
  const toasts = [];
  const post = (payload) => { posts.push(payload); return Promise.resolve(answers.post || { ok: true, entry_id: 'out_1' }); };
  const modal = createPostToTeam({
    documentRef, stepModal, actionButton, textField, post, canQueue,
    getTeams: () => teams,
    getChatTeam: (id) => chat[id] || null,
    failText: (answer) => (answer && answer.error ? `failed:${answer.error.reason}` : ''),
    showToast: (message, options) => toasts.push({ message, options }),
    announcer: { announce() {} },
  });
  t.after(() => { modal.dispose(); dom.window.close(); });
  const $ = (selector) => documentRef.querySelector(selector);
  const optionNodes = () => [...documentRef.querySelectorAll('[data-chat-post-option]')];
  return {
    modal, posts, toasts, documentRef, $,
    options: optionNodes,
    groups: () => [...documentRef.querySelectorAll('[data-chat-post-team]')].map((el) => el.textContent),
    pick: (key) => { optionNodes().find((el) => el.dataset.chatPostOption === key).click(); },
    postButton: () => $('[data-step-modal-action="post"]'),
  };
}

test('the menu item is "Post to Team…" and opens the dialog for the text', (t) => {
  const h = harness(t);
  const item = h.modal.menuItem({ text: 'An answer' });
  assert.equal(item.label, 'Post to Team…');
  assert.equal(item.disabled, undefined);
  assert.equal(h.modal.menuItem({ text: '   ' }), null, 'nothing to post, nothing offered');
  item.action();
  assert.equal(h.modal.isOpen(), true);
  assert.match(h.$('.inv-step-modal-title').textContent, /^Post to Team$/u);
});

test('destinations: online writable teams only, grouped by team; channels and conversations, never a project or an archived channel', (t) => {
  const teams = [team(), team({ team_id: 'team_beta', team_name: 'Beta', role: 'read_only' }), team({ team_id: 'team_gamma', team_name: 'Gamma', state: 'offline' }),
    team({ team_id: 'team_delta', team_name: 'Delta', state: 'revoked' })];
  const h = harness(t, { teams });
  h.modal.open({ text: 'Hello team' });
  assert.deepEqual(h.groups(), ['Alpha']);
  assert.deepEqual(h.options().map((el) => el.title), ['#team', '#design', 'Dot <b>']);
  assert.equal(h.documentRef.querySelector('[data-chat-post-list] b'), null, 'a name is text, never markup');
});

test('a queued team is offered only where a queue exists', (t) => {
  const offline = [team({ state: 'offline' })];
  assert.equal(harness(t, { teams: offline }).modal.destinations().length, 0);
  assert.deepEqual(harness(t, { teams: offline, canQueue: true }).modal.destinations().map((group) => group.name), ['Alpha']);
});

test('readers line: a channel names everyone in the team and the host; a conversation its people and the host', (t) => {
  const h = harness(t);
  h.modal.open({ text: 'Hello team' });
  assert.equal(h.$('[data-chat-post-readers]').textContent, '');
  assert.equal(h.postButton().disabled, true, 'nothing picked yet');
  h.pick('team_alpha|chan_team');
  assert.equal(h.$('[data-chat-post-readers]').textContent, "Everyone in Alpha and the team's host can read this.");
  assert.equal(h.postButton().disabled, false);
  h.pick(`team_alpha|${DM}`);
  assert.equal(h.$('[data-chat-post-readers]').textContent, "The people in this conversation and the team's host can read this.");
});

test('the preview shows the exact text that will be posted, read-only and escaped', (t) => {
  const h = harness(t);
  h.modal.open({ text: `<script>alert(1)</script> see ${LINK} now ![pic](file:///c:/a.png) <img src=x>` });
  const preview = h.$('[data-chat-post-preview]');
  assert.equal(preview.readOnly, true);
  assert.equal(preview.value, '<script>alert(1)</script> see  now', 'a picture or media tag is taken out, other markup stays as text');
  assert.equal(h.documentRef.querySelector('[data-step-modal] script, [data-step-modal] img'), null);
});

test('Post sends { team_id, channel_id, text } with tokens and attachments stripped, then closes with a toast', async (t) => {
  const h = harness(t);
  h.modal.open({ text: `Result ${LINK}\n![chart](attachment://1)\n\n\n\nDone` });
  h.pick('team_alpha|chan_c_abcdefghijklmnop');
  h.postButton().click();
  await flush();
  assert.deepEqual(h.posts, [{ team_id: 'team_alpha', channel_id: 'chan_c_abcdefghijklmnop', text: 'Result\n\nDone' }]);
  assert.equal(h.modal.isOpen(), false);
  assert.equal(h.toasts[0].message, 'Posted to #design in Alpha');
});

test('a refused post keeps the dialog open with the reason and can be tried again', async (t) => {
  const h = harness(t, { answers: { post: { ok: false, error: { reason: 'team_not_connected' } } } });
  h.modal.open({ text: 'Hello' });
  h.pick('team_alpha|chan_team');
  h.postButton().click();
  await flush();
  assert.equal(h.modal.isOpen(), true);
  assert.equal(h.$('[data-chat-post-error]').hidden, false);
  assert.equal(h.$('[data-chat-post-error]').textContent, 'failed:team_not_connected');
  assert.equal(h.postButton().disabled, false);
});

test('over 16,000 characters: the dialog does not open and the item says why; exactly 16,000 posts', (t) => {
  const h = harness(t);
  const long = 'x'.repeat(16001);
  const item = h.modal.menuItem({ text: long });
  assert.equal(item.disabled, true);
  assert.equal(item.description, 'Too long to post (16,000 characters at most).');
  assert.equal(h.modal.open({ text: long }), false);
  assert.equal(h.modal.menuItem({ text: 'x'.repeat(16000) }).disabled, undefined);
  assert.equal(h.modal.open({ text: 'x'.repeat(16000) }), true);
});

test('control characters other than tab and line breaks are stripped, as the store refuses them', () => {
  assert.equal(require('../renderer/chat/renderer-chat-post-to-team').cleanText('a\u001b[31mb\tc\nd\u0007'), 'a[31mb\tc\nd');
});

test('the cap counts the cleaned text, in characters, not UTF-16 units', (t) => {
  const h = harness(t);
  assert.equal(h.modal.availability('\u{1F600}'.repeat(16000)).ok, true);
  assert.equal(h.modal.availability('x'.repeat(15000) + (LINK + ' ').repeat(40)).ok, true);
});

test('never hidden: no team, a read-only team, offline each grey the item with its reason', (t) => {
  const reasonFor = (teams) => {
    const item = harness(t, { teams }).modal.menuItem({ text: 'Hello' });
    assert.equal(item.label, 'Post to Team…', 'still offered');
    assert.equal(item.disabled, true);
    assert.equal(item.title, item.description);
    item.action();
    return item.description;
  };
  assert.equal(reasonFor([]), 'Join a team to post there.');
  assert.equal(reasonFor([team({ state: 'pending' })]), 'Join a team to post there.');
  assert.equal(reasonFor([team({ role: 'read_only' })]), 'You can only read in this team.');
  assert.equal(reasonFor([team({ state: 'offline' })]), 'You are offline.');
  assert.equal(harness(t, { teams: [team({ state: 'offline' })], canQueue: true }).modal.menuItem({ text: 'Hello' }).disabled, undefined, 'queued where a queue exists');
});

test('cleanText: tokens, pictures and media tags go; the words stay', () => {
  assert.equal(cleanText(`a ${LINK} b <iframe src="x"></iframe>![i](u)`), 'a  b');
  assert.equal(cleanText(null), '');
});
