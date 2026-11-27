'use strict';

// new-test-file: Team tab faults seen in the owner's screenshot of #team (row 123 polish, 2026-11-13): a fenced code
// block in a message drawn as one block (the markdown.css code-block rules are scoped to `.chat-bubble-markdown`, and
// the team's inline-code chip must not paint the block's code), Send greyed with its reason while the box is empty (as
// the desktop composer does), and the empty Projects line in the column's muted hint style. A new file:
// renderer-team-composer.test.js and renderer-team-timeline.test.js are at their size.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ME, TEAM, OTHER, CHAT_MEMBERS, message, msgId, openChat, type, flush, key, menu, memberTeam, snapshot, chatChannel, overview, searchField, searchMatch } = require('./helpers/team-settings-harness');
const { listAnswer, openProjects } = require('./helpers/team-project-renderer-host');

const css = (name) => fs.readFileSync(path.join(__dirname, '..', 'styles', name), 'utf8');
// The selector lists of every rule in a stylesheet whose declarations set `prop`.
const selectorsSetting = (text, prop) => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => new RegExp('(^|;)\\s*' + prop + '\\s*:').test(m[2])).map((m) => m[1].trim());

test('a fenced code block in a message is one block: header and code joined, under the markdown code-block styles', async (t) => {
  const { h } = await openChat({ messages: [message(1, { text: '<@channel>\n```\ntesting this\n```', mentions: ['channel'] })] });
  t.after(h.restore);
  const text = h.view.q(`.team-msg[data-message-id="${msgId(1)}"] .team-msg__text`);
  assert.ok(text.classList.contains('chat-bubble-markdown'), 'the message text carries the class markdown.css scopes code blocks, lists and tables to');
  const block = text.querySelector('.markdown-code-block');
  assert.ok(block, 'the fence becomes a code block');
  assert.deepEqual([...block.children].map((el) => el.className || el.nodeName), ['markdown-code-header inv-codeblock-toolbar', 'PRE']);
  assert.equal(block.querySelector('pre code').textContent.trim(), 'testing this');
  assert.ok(text.querySelector('.team-mention[data-me="true"]'), 'the @channel mention is still marked');
});

test('the team inline-code chip never paints code inside a block (no chip behind the code, no stray bar after it)', () => {
  const chips = selectorsSetting(css('team-chat.css'), 'background').filter((s) => /\.team-msg__text code/.test(s));
  assert.ok(chips.length > 0, 'the inline-code chip rule is found');
  for (const selector of chips) assert.match(selector, /code:not\(pre code\)/, selector);
});

test('Send is greyed with its reason while the box is empty, and live once there are words', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  const send = () => h.view.q('[data-team-composer="send"]');
  assert.equal(send().disabled, true, 'nothing to send');
  assert.equal(send().getAttribute('title'), 'Send. Type a message first.');
  type(h, '   ');
  assert.equal(send().disabled, true, 'blank text is nothing to send');
  type(h, 'hello');
  assert.equal(send().disabled, false);
  assert.equal(send().getAttribute('title'), 'Send (Enter)');
  assert.equal(send().getAttribute('aria-label') || send().textContent.trim(), 'Send');
  await flush();
});

// The one muted empty-list line of the left column (Projects and Direct messages share it, team-tab.css).
const EMPTY_RULE = /\.team-col-empty\s*\{[^}]*color:\s*var\(--text-muted\)[^}]*font-size:\s*var\(--font-size-footnote\)/;

test('the empty Projects line uses the column\'s muted hint style', async (t) => {
  const { h } = await openProjects({ list: listAnswer({ projects: [] }) });
  t.after(h.restore);
  const html = h.view.q('[data-team-projects]').innerHTML;
  const empty = /<p class="([^"]*)">No shared projects yet\.<\/p>/.exec(html);
  assert.ok(empty, html);
  assert.deepEqual(empty[1].split(' '), ['team-col-empty'], 'not the Settings body note, which reads at body size and colour');
  assert.match(css('team-tab.css'), EMPTY_RULE);
});

test('no direct messages: one muted line under the label and its New message plus, as Projects has', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  const section = h.view.q('[data-team-directs]');
  assert.ok(section, 'a member who may start one sees the section');
  assert.ok(section.querySelector('.team-panel__label [data-team-tab-action="dm-new"]'), 'the plus on the label');
  const empty = section.querySelector('.team-col-empty');
  assert.ok(empty, section.innerHTML);
  assert.equal(empty.textContent, 'No direct messages yet.');
  assert.equal(empty.previousElementSibling.classList.contains('team-panel__label'), true, 'right under the label, as the Projects line');
});

test('the channel header\'s search button says it searches every channel', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  const button = h.view.q('.team-head [data-team-tab-action="search"]');
  assert.equal(button.getAttribute('title'), 'Search messages (Ctrl+F)');
  assert.equal(button.getAttribute('aria-label'), 'Search messages (Ctrl+F)');
});

test('a team message\'s text stops at the desktop chat\'s measure; blocks scroll inside it, the row does not', () => {
  const rules = [...css('team-chat.css').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const text = rules.find((m) => m[1].trim() === '.team-msg__text');
  assert.ok(text, 'the message text rule');
  assert.match(text[2], /max-width:\s*var\(--chat-measure-cap\)/, 'the chat column\'s own cap (foundation.css), following the Chat width setting');
  const body = rules.find((m) => m[1].trim() === '.team-msg__body');
  assert.match(body[2], /min-width:\s*0/, 'the body may shrink, so a long code line scrolls in its block');
  assert.match(css('markdown.css'), /:is\(\.chat-bubble-markdown, \.tool-result-body\) pre \{[^}]*overflow-x:\s*auto/);
});

// ------------------------------------------------------------------ right-click message menu (owner, 2026-11-13)

const rowEl = (h, seq) => h.view.q(`.team-msg[data-message-id="${msgId(seq)}"]`);
const values = (h) => [...menu(h).querySelectorAll('.inv-context-menu-item')].map((el) => el.dataset.value);
const rightClick = (h, el, init = {}) => {
  const event = new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50, ...init });
  el.dispatchEvent(event);
  return event;
};
// What the hover toolbar offers for a row: its own buttons (Add reaction is More's first entry), then More's list.
function toolbarValues(h, seq) {
  const own = [...rowEl(h, seq).querySelectorAll('.team-acts [data-team-msg-action]')].map((el) => el.dataset.teamMsgAction)
    .filter((a) => a !== 'more' && a !== 'react-pick');
  rowEl(h, seq).querySelector('[data-team-msg-action="more"]').click();
  const more = menu(h) ? values(h) : [];
  key(h, h.window.document.activeElement, 'Escape');
  return own.concat(more.filter(Boolean));
}

for (const [name, options, seq] of [
  ['your own message', { messages: [message(1)] }, 1],
  ['another member\'s message', { messages: [message(2, { author: { kind: 'member', member_id: ME } })] }, 2],
  ['a deleted message', { messages: [message(3, { text: '', deleted: { by: ME, at: new Date().toISOString() } })] }, 3],
  ['a read-only viewer', { teams: [memberTeam({ role: 'read_only' })], messages: [message(4)] }, 4],
]) {
  test(`right-click on ${name} lists exactly what its toolbar offers`, async (t) => {
    const { h } = await openChat(options);
    t.after(h.restore);
    const expected = toolbarValues(h, seq);
    assert.equal(menu(h), null);
    const event = rightClick(h, rowEl(h, seq).querySelector('.team-msg__body'));
    assert.equal(event.defaultPrevented, true, 'the menu replaces the default one');
    assert.ok(menu(h), 'a menu opens');
    assert.deepEqual(values(h).filter(Boolean), expected);
    assert.equal(menu(h).style.left, '40px', 'at the pointer');
  });
}

test('a menu item runs the toolbar\'s own action; Escape closes and gives the row its focus back', async (t) => {
  const { h } = await openChat({ messages: [message(1)] });
  t.after(h.restore);
  rightClick(h, rowEl(h, 1).querySelector('.team-msg__text'));
  menu(h).querySelector('[data-value="edit"]').click();
  assert.ok(rowEl(h, 1).querySelector('.team-edit__input'), 'Edit opens the edit box, as More does');
  key(h, rowEl(h, 1).querySelector('.team-edit__input'), 'Escape');
  rightClick(h, rowEl(h, 1).querySelector('.team-msg__text'));
  key(h, h.window.document.activeElement, 'Escape');
  assert.equal(menu(h), null);
  assert.equal(h.window.document.activeElement, rowEl(h, 1), 'focus back on the row');
  rowEl(h, 1).focus();
  key(h, rowEl(h, 1), 'F10', { shiftKey: true });
  assert.ok(menu(h), 'Shift+F10 on a focused row opens it');
  const keyboard = values(h);
  key(h, h.window.document.activeElement, 'Escape');
  rightClick(h, rowEl(h, 1).querySelector('.team-msg__text'));
  assert.deepEqual(values(h), keyboard, 'Shift+F10 opens the same list as a right-click');
  key(h, h.window.document.activeElement, 'Escape');
});

test('a right-click on a link, a selection, a code block or the edit box keeps the default; scrolling closes the menu', async (t) => {
  const { h } = await openChat({ messages: [message(1, { text: 'see [docs](https://example.com) and\n```\ncode\n```' })] });
  t.after(h.restore);
  const text = rowEl(h, 1).querySelector('.team-msg__text');
  for (const el of [text.querySelector('a'), text.querySelector('pre code')]) {
    assert.equal(rightClick(h, el).defaultPrevented, false, el.nodeName);
    assert.equal(menu(h), null);
  }
  const selection = h.window.getSelection();
  selection.selectAllChildren(text.querySelector('p'));
  assert.equal(rightClick(h, text.querySelector('p')).defaultPrevented, false, 'selected text keeps Copy');
  assert.equal(menu(h), null);
  selection.removeAllRanges();
  rightClick(h, text.querySelector('p'));
  assert.ok(menu(h));
  h.view.q('.team-scroll').dispatchEvent(new h.window.Event('scroll'));
  assert.equal(menu(h), null, 'a scroll closes it');
});

test('the menu closes when its message leaves the timeline', async (t) => {
  const { h } = await openChat({ messages: [message(1)] });
  t.after(h.restore);
  rightClick(h, rowEl(h, 1).querySelector('.team-msg__text'));
  assert.ok(menu(h));
  rowEl(h, 1).remove();
  await flush();
  assert.equal(menu(h), null);
});

test('the hover toolbar ends where the capped text column ends, not at the far edge of a wide window', () => {
  const text = css('team-chat.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const acts = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === '.team-acts');
  // Row padding 18px + avatar 30px + gap 12px = 60px before the text, which stops at --chat-measure-cap.
  assert.match(acts[2], /inset-inline-end:\s*max\(18px,\s*calc\(100% - 60px - var\(--chat-measure-cap\)\)\)/);
  assert.match(text, /:root\[data-team-density="compact"\] \.team-acts \{\s*inset-inline-end:\s*18px;?\s*\}/, 'compact text is inline and not capped');
});

// ------------------------------------------------------------------ one frame per team (row 201: OD-10, C10.2, C9.3)

const DESIGN = 'chan_c_aaaaaaaaaaaaaaaa';
const designRow = () => chatChannel({ channel_id: DESIGN, kind: 'channel', name: 'design', topic: '', created_by: ME, archived: false, archived_by: null, changes: [], rev: 2 });
const withDesign = (answers = {}) => ({ answers: { chatOverview: overview({ channels: [chatChannel(), designRow()] }), ...answers } });
const searchWait = () => new Promise((resolve) => { setTimeout(resolve, 330); }).then(flush); // the search's own 300 ms

test('C10.2: a search hit in another channel shows that channel and keeps the query, the results and the column', async (t) => {
  const { h } = await openChat(withDesign({ chatSearch: { ok: true, matches: [searchMatch(5, { channel_id: DESIGN })], next_cursor: null } }));
  t.after(h.restore);
  const nav = h.view.q('nav.team-panel');
  type(h, 'hello', searchField(h));
  await searchWait();
  assert.equal(h.view.qa('.team-result').length, 1);
  h.view.q('.team-result').click();
  await flush();
  assert.equal(h.view.q('.team-head__name').textContent, '#design', 'the hit\'s channel is shown');
  assert.equal(h.view.q('nav.team-panel'), nav, 'the same column');
  assert.equal(searchField(h).value, 'hello', 'the query stays');
  assert.equal(h.view.q('.team-results').hidden, false, 'the results stay');
  assert.deepEqual(h.view.qa('.team-result').map((el) => el.getAttribute('aria-current')), ['true'], 'with the hit marked');
});

test('OD-10: a channel switch swaps the main pane only; the column, its search field and the focused row stay', async (t) => {
  const { h } = await openChat(withDesign());
  t.after(h.restore);
  const nav = h.view.q('nav.team-panel');
  const field = searchField(h);
  const timeline = h.view.q('[data-team-region="timeline"]');
  const row = () => h.view.q(`[data-team-channel="${DESIGN}"]`);
  row().focus();
  row().click();
  await flush();
  assert.equal(h.view.q('.team-head__name').textContent, '#design');
  assert.equal(h.view.q('nav.team-panel'), nav, 'the same column');
  assert.equal(searchField(h), field, 'the same search field');
  assert.notEqual(h.view.q('[data-team-region="timeline"]'), timeline, 'a new channel pane');
  assert.deepEqual([...h.view.q('.team-main').children].map((el) => el.dataset.teamRegion), ['head', 'banner', 'export', 'notice', 'timeline', 'composer'], 'the same structure');
  assert.equal(h.window.document.activeElement, row(), 'the focus stays on the row');
  h.view.q('[data-team-channel="chan_team"]').click();
  await flush();
  assert.equal(h.view.q('.team-head__name').textContent, '#team');
  assert.equal(h.view.q('nav.team-panel'), nav);
});

test('C9.3: hiding the tab disposes the shown project conversation and leaves none of its ids behind', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  h.view.qa('[data-team-tab-action="conv-open"]')[0].click();
  await flush();
  const box = () => h.window.document.querySelector('[data-project-input="prompt"]'); // its id may carry a per-conversation prefix
  assert.ok(box() && h.teamView.contains(box()), 'the conversation is drawn');
  h.tab.hideTeamTab();
  assert.equal(box(), null, 'no hidden duplicate for the Board');
  assert.equal(h.teamView.querySelector('[data-team-region="project"] *'), null, 'its region is empty');
});

test('OD-8 (row 201): a search hit in a project channel shows that channel, named by its project, and keeps the results', async (t) => {
  const { P1 } = require('./helpers/team-project-renderer-host');
  const { h } = await openProjects({ answers: { chatSearch: { ok: true, matches: [searchMatch(5, { channel_id: 'chan_' + P1 })], next_cursor: null } } });
  t.after(h.restore);
  type(h, 'hello', searchField(h));
  await searchWait();
  h.view.q('.team-result').click();
  await flush();
  assert.equal(h.view.q('.team-head__name').textContent, '#jenny-site', 'the project channel is shown by its project\'s name');
  assert.equal(h.view.text().includes('does not show yet'), false, 'never "not shown yet"');
  assert.equal(searchField(h).value, 'hello');
});

// ------------------------------------------------------------------ C14 (team polish 2026-11-25)

test('C14: Save in an edit whose box is empty is greyed with its reason, and live again with words', async (t) => {
  const { h } = await openChat({ messages: [message(1)] });
  t.after(h.restore);
  rowEl(h, 1).querySelector('[data-team-msg-action="more"]').click();
  menu(h).querySelector('[data-value="edit"]').click();
  const box = rowEl(h, 1).querySelector('.team-edit__input');
  const save = () => rowEl(h, 1).querySelector('[data-team-msg-action="edit-save"]');
  assert.equal(save().disabled, false);
  type(h, '   ', box);
  assert.equal(save().disabled, true);
  assert.equal(save().title, 'Type a message first.');
  type(h, 'words', box);
  assert.equal(save().disabled, false);
  assert.equal(save().hasAttribute('title'), false);
});

test('C14: a push for a team that is not shown repaints nothing', async (t) => {
  const { h } = await openChat({ teams: [memberTeam(), snapshot()], messages: [message(1)] });
  t.after(h.restore);
  const store = require('../renderer/team/renderer-team-store').getTeamStore();
  const chat = require('../renderer/team/renderer-team-chat-store').getChatStore();
  let paints = 0;
  const paint = store.setShownTeam;
  store.setShownTeam = (...args) => { paints += 1; return paint.apply(store, args); };
  t.after(() => { store.setShownTeam = paint; });
  const push = (team, body) => h.listeners.chat({ team_id: team, ...body });
  push(OTHER, { type: 'channels', partial: true, channels: [chatChannel({ unread: 3 })] });
  assert.ok(paints > 0, 'the shown team repaints');
  assert.ok(chat.team(TEAM), 'the other team is tracked, so its push reaches the tab');
  paints = 0;
  push(TEAM, { type: 'channels', partial: true, channels: [chatChannel({ unread: 5 })] });
  push(TEAM, { type: 'members', members: CHAT_MEMBERS });
  assert.equal(paints, 0, 'nothing repaints for the team that is not shown');
});
