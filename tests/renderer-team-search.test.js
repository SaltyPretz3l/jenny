'use strict';

// new-test-file: chat search is a new surface (row 123, slice 2a-6b, owner-approved mockup variant A): the
// field in the left column, the result list that replaces the lists, its states, keys and lifecycle. Real
// modules over the harness bridge; the 300 ms wait and the 3 s retry run on mocked timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, CHAN, DOT, ME, MAYA, CHAT_MEMBERS, micro, flush, msgId, message, memberTeam, snapshot, openChat, heldAnswers, liveTimers, type, key,
  pushMessages, chatPush, chatMember, searchField: field, searchMatch: match, harness, layout, chatChannel, overview } = require('./helpers/team-settings-harness');
const { dmChannelId } = require('../services/host/team-chat-schema');

const clearButton = (h) => h.view.q('.team-search__clear');
const region = (h) => h.view.q('.team-results');
const rows = (h) => h.view.qa('.team-result');
const ids = (h) => rows(h).map((el) => el.dataset.messageId);
const lists = (h) => h.view.q('[data-team-region="lists"]');
const note = (h) => h.view.q('.team-results__note').textContent.replace(/\s+/g, ' ').trim();
const count = (h) => [...h.view.q('.team-results .team-panel__label').children].map((el) => el.textContent).join(' ');
const more = (h) => h.view.q('.team-results__more');
const searchButton = (h) => h.view.q('[data-team-tab-action="search"]');
const searches = (h) => h.sent('chatSearch').map((call) => call.payload);
const found = (matches, next = null) => ({ ok: true, matches, next_cursor: next });
const refusal = (reason, code = 'CMP-TEAM-0007') => ({ ok: false, error: { code, reason } });

// Types into the search field and lets the 300 ms wait run out (timers mocked).
async function search(t, h, text, wait = 300) {
  type(h, text, field(h));
  t.mock.timers.tick(wait);
  await micro();
}
function timed(t) { t.mock.timers.enable({ apis: ['setTimeout'] }); return liveTimers(t, { keep: (ms) => ms === 300 || ms === 3000 }); } // the search's own

test('the field shows for a connected member with its header button before the bell, and not for a locked team', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  assert.equal(field(h).getAttribute('placeholder'), 'Search messages');
  assert.equal(field(h).getAttribute('aria-label'), 'Search messages');
  assert.ok(field(h).closest('nav.team-panel'), 'in the left column');
  const order = [...h.view.q('nav.team-panel').querySelectorAll('#teamTabSwitch, .team-search, .team-channels')].map((el) => el.id || el.classList[el.classList.length - 1]);
  assert.deepEqual(order, ['teamTabSwitch', 'team-search', 'team-channels'], 'under the switcher, above Channels');
  const actions = [...h.view.q('.team-head__actions').querySelectorAll('button')];
  assert.equal(actions[0].dataset.teamPins, 'open', 'the pinned button leads (2b-2)');
  assert.equal(actions[1], searchButton(h), 'before the bell');
  assert.equal(searchButton(h).title, 'Search messages (Ctrl+F)');
  assert.equal(region(h).hidden, true, 'no list while the field is empty');
  h.listeners.state({ teams: [memberTeam({ state: 'revoked' })] });
  await flush();
  assert.equal(field(h), null);
});

test('one search 300 ms after the last key, with the trimmed query; a blank field sends nothing', async (t) => {
  const { h } = await openChat({ answers: { chatSearch: found([match(1)]) } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'he', 200);
  await search(t, h, '  hello ', 299);
  assert.equal(searches(h).length, 0);
  t.mock.timers.tick(1);
  await micro();
  assert.deepEqual(searches(h), [{ team_id: OTHER, query: 'hello', limit: 20 }]);
  await search(t, h, '   ');
  assert.equal(searches(h).length, 1, 'blank: nothing sent');
  assert.equal(region(h).hidden, true);
  assert.equal(lists(h).hidden, false);
  assert.equal(field(h).getAttribute('maxlength'), '200', 'the field takes at most 200 units');
});

test('a query typed while one is out sends exactly one more call, for the latest text, and a late answer changes nothing', async (t) => {
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatSearch: gate.answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'alpha');
  await search(t, h, 'beta');
  await search(t, h, 'gamma');
  assert.deepEqual(gate.calls.map((p) => p.query), ['alpha']);
  gate.release(found([match(1, { excerpt: 'alpha one' })]));
  await micro();
  assert.deepEqual(ids(h), [], 'the answer for an older query is dropped');
  assert.deepEqual(gate.calls.map((p) => p.query), ['alpha', 'gamma'], 'only the latest waited');
  gate.release(found([match(2, { excerpt: 'gamma two' })]));
  await micro();
  assert.deepEqual(ids(h), [msgId(2)]);
  await search(t, h, ' gamma ');
  assert.equal(gate.calls.length, 2, 'the same query is not sent again');
});

test('an answer for a query typed over while the team went offline is dropped', async (t) => {
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatSearch: gate.answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'alpha');
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await micro();
  await search(t, h, 'beta');
  assert.equal(gate.calls.length, 1, 'nothing sent while not connected');
  gate.release(found([match(1, { excerpt: 'alpha one' })]));
  await micro();
  assert.deepEqual(ids(h), []);
  assert.match(note(h), /^Search needs the host\. /);
});

test('the results replace the lists while the field holds text; X and Esc bring them back unchanged, and the focus returns', async (t) => {
  const { h } = await openChat({ answers: { chatSearch: found([match(1), match(2)]) } });
  t.after(h.restore);
  timed(t);
  const before = lists(h);
  const markup = before.innerHTML;
  const composer = h.view.q('.team-composer__input');
  for (const close of ['x', 'Escape']) {
    composer.focus();
    key(h, composer, 'f', { ctrlKey: true });
    assert.equal(h.window.document.activeElement, field(h));
    await search(t, h, 'message');
    assert.equal(lists(h).hidden, true);
    assert.equal(region(h).hidden, false);
    assert.equal(region(h).getAttribute('role'), 'region');
    assert.equal(region(h).getAttribute('aria-label'), 'Search results');
    assert.equal(region(h).getAttribute('aria-live'), null, 'live only on the state sentences');
    if (close === 'x') clearButton(h).click(); else key(h, field(h), 'Escape');
    assert.equal(field(h).value, '');
    assert.equal(lists(h), before);
    assert.equal(lists(h).innerHTML, markup);
    assert.equal(lists(h).hidden, false);
    assert.equal(region(h).hidden, true);
    assert.equal(h.window.document.activeElement, composer, close + ': back to where the search began');
  }
  h.window.document.activeElement.blur();
  field(h).focus();
  await search(t, h, 'again');
  key(h, field(h), 'Escape');
  assert.equal(h.window.document.activeElement, field(h), 'began in the field: the focus stays there');
});

test('the count with "+", Load more with the cursor appends without duplicates, then End of results', async (t) => {
  const page = Array.from({ length: 20 }, (_v, i) => match(40 - i));
  let n = 0;
  const answers = [found(page, 'cur_1'), found([match(21), match(20), match(19)], null)];
  const { h } = await openChat({ answers: { chatSearch: () => answers[n++] } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  assert.equal(count(h), 'Messages 20+');
  assert.equal(rows(h).length, 20);
  assert.equal(more(h).textContent.trim(), 'Load more');
  more(h).click();
  await micro();
  assert.deepEqual(searches(h)[1], { team_id: OTHER, query: 'message', limit: 20, cursor: 'cur_1' });
  assert.equal(rows(h).length, 22, 'match 21 was on page one: no duplicate row');
  assert.equal(new Set(ids(h)).size, 22);
  assert.equal(count(h), 'Messages 22');
  assert.match(note(h), /^End of results\.$/);
  assert.equal(more(h), null);
});

test('at most 200 matches are held; the list says to narrow the search and offers no more pages', async (t) => {
  const page = Array.from({ length: 205 }, (_v, i) => match(500 - i));
  const { h } = await openChat({ answers: { chatSearch: found(page, 'cur_more') } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  assert.equal(rows(h).length, 200);
  assert.match(note(h), /narrow/i);
  assert.equal(more(h), null);
});

test('each match: author by the rows name (a former member too), day and time, "in a thread", another channel, the excerpt', async (t) => {
  const answer = found([match(3, { root_id: msgId(2) }), match(2, { author: { kind: 'member', member_id: MAYA }, channel_id: 'chan_project_web' })]);
  const { h } = await openChat({ answers: { chatSearch: answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  const [first, second] = rows(h);
  assert.equal(first.querySelector('.team-result__who').textContent, 'Dot');
  assert.match(first.querySelector('.team-result__when').textContent, /^(Today|Yesterday) \S/);
  assert.equal(first.querySelector('.team-result__where').textContent, 'in a thread');
  assert.equal(first.querySelector('.team-result__text').textContent, 'Message 3');
  assert.equal(second.querySelector('.team-result__who').textContent, 'Former member');
  assert.equal(second.querySelector('.team-result__where').textContent, '#web');
});

test('searching keeps the previous results dimmed; no matches says so with the query', async (t) => {
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatSearch: gate.answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'first');
  assert.match(note(h), /^Searching…$/);
  gate.release(found([match(1)]));
  await micro();
  await search(t, h, 'second');
  assert.deepEqual(ids(h), [msgId(1)], 'kept while the next search is out');
  assert.equal(region(h).dataset.busy, 'true');
  assert.match(note(h), /^Searching…$/);
  gate.release(found([]));
  await micro();
  assert.deepEqual(ids(h), []);
  assert.equal(note(h), 'No messages match "second". Search looks at the text of messages in the channels you can read. Deleted messages are left out.');
  assert.equal(h.view.q('.team-results__note').getAttribute('aria-live'), 'polite');
});

test('in a direct conversation the list says so, the empty note names it, and a switch to #team asks again there', async () => {
  const dm = dmChannelId([DOT, ME]);
  const h = harness({ show: false, teams: [memberTeam()], answers: {
    chatOverview: overview({ channels: [chatChannel(), chatChannel({ channel_id: dm, kind: 'dm', participants: [DOT, ME].sort() })], members: CHAT_MEMBERS }),
    chatHistory: { ok: true, messages: [], has_more: false },
    chatSearch: (p) => found(p.channel_id ? [] : [match(1)]),
  } });
  layout(h);
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  try {
    h.view.q(`[data-team-channel="${dm}"]`).click();
    await flush();
    type(h, 'zzz', field(h));
    await wait(350);
    await flush();
    assert.equal(h.view.q('.team-results__scope').textContent, 'In this conversation');
    assert.match(note(h), /^No messages match "zzz" in this conversation\./);
    h.view.q(`[data-team-channel="${CHAN}"]`).click();
    await flush();
    await wait(350);
    await flush();
    assert.equal(searches(h).length, 2, 'the same query was asked again');
    assert.equal(Object.hasOwn(searches(h)[1], 'channel_id'), false, 'in the new scope');
    assert.deepEqual(ids(h), [msgId(1)]);
    assert.equal(h.view.q('.team-results__scope'), null, 'no scope label in a channel');
  } finally { h.restore(); }
});

test('too fast: the results stay, one retry after 3 s, and the timer goes on clear and on dispose', async (t) => {
  let n = 0;
  const answers = [found([match(1)]), refusal('team_chat_rate_limit'), refusal('team_chat_rate_limit'), found([match(2)])];
  const { h } = await openChat({ answers: { chatSearch: () => answers[n++] } });
  t.after(h.restore);
  const live = timed(t);
  await search(t, h, 'one');
  await search(t, h, 'two');
  assert.deepEqual(ids(h), [msgId(1)], 'kept');
  assert.equal(note(h), 'Searching too fast. It goes on by itself in a moment.');
  assert.equal(h.view.qa('.team-toast, .inv-toast').length, 0, 'never a toast');
  t.mock.timers.tick(2_999);
  await micro();
  assert.equal(searches(h).length, 2);
  t.mock.timers.tick(1);
  await micro();
  assert.equal(searches(h).length, 3, 'exactly one retry');
  assert.equal(note(h), 'Searching too fast. It goes on by itself in a moment.', 'a second refusal waits again');
  t.mock.timers.tick(3_000);
  await micro();
  assert.deepEqual(ids(h), [msgId(2)]);
  assert.equal(searches(h).length, 4);
  answers.push(refusal('team_chat_rate_limit'));
  await search(t, h, 'three');
  assert.equal(live.size, 1, 'the retry timer');
  clearButton(h).click();
  assert.equal(live.size, 0, 'cleared with the search');
  answers.push(refusal('team_chat_rate_limit'));
  await search(t, h, 'four');
  assert.equal(live.size, 1);
  h.tab.hideTeamTab();
  assert.equal(live.size, 0, 'gone on dispose');
});

test('offline: the results stay, the host-state words show, and the search is asked once when the team reconnects', async (t) => {
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatSearch: gate.answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'one');
  gate.release(found([match(1)]));
  await micro();
  await search(t, h, 'two');
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await micro();
  gate.release(refusal('team_not_connected', 'CMP-TEAM-0001'));
  await micro();
  assert.deepEqual(ids(h), [msgId(1)]);
  assert.match(note(h), /^Search needs the host\. Reconnecting/);
  assert.equal(gate.calls.length, 2, 'nothing sent while it is not connected');
  h.listeners.state({ teams: [memberTeam()] });
  await micro();
  h.listeners.state({ teams: [memberTeam()] });
  await micro();
  assert.equal(gate.calls.length, 3, 'asked once');
  assert.equal(gate.calls[2].query, 'two');
  gate.release(found([match(2)]));
  await micro();
  assert.deepEqual(ids(h), [msgId(2)]);
});

test('a not-connected refusal that lands after the team came back offers Try again, which asks once', async (t) => {
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatSearch: gate.answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'one');
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await micro();
  h.listeners.state({ teams: [memberTeam()] });
  await micro();
  gate.release(refusal('team_not_connected', 'CMP-TEAM-0001'));
  await micro();
  assert.equal(more(h).textContent.trim(), 'Try again');
  more(h).click();
  await micro();
  assert.deepEqual(gate.calls.map((p) => p.query), ['one', 'one']);
  gate.release(found([match(1)]));
  await micro();
  assert.deepEqual(ids(h), [msgId(1)]);
  assert.equal(gate.calls.length, 2, 'no automatic re-ask');
});

test('another refusal says its reason with Try again, which asks the same query again', async (t) => {
  let n = 0;
  const answers = [refusal('team_chat_cursor_invalid', 'CMP-TEAM-0007'), found([match(1)])];
  const { h } = await openChat({ answers: { chatSearch: () => answers[n++] } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'one');
  assert.ok(note(h).length > 0);
  assert.equal(more(h).textContent.trim(), 'Try again');
  more(h).click();
  await micro();
  assert.deepEqual(searches(h).map((p) => p.query), ['one', 'one']);
  assert.deepEqual(ids(h), [msgId(1)]);
});

test('markup in an excerpt, a name, a channel and the query is text; every occurrence of the query is marked, entities intact', async (t) => {
  const members = [{ member_id: DOT, display_name: '<b>Dot</b>', role: 'member', state: 'online', last_seen_at: null }];
  let answer = found([match(1, { excerpt: '<img src=x onerror=1> a & b &amp; c', channel_id: 'chan_project_<i>x</i>' })]);
  const { h } = await openChat({ members, answers: { chatSearch: () => answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, '&');
  const row = rows(h)[0];
  assert.equal(row.querySelector('img, i, b'), null);
  assert.equal(row.querySelector('.team-result__who').textContent, '<b>Dot</b>');
  assert.equal(row.querySelector('.team-result__where').textContent, '#<i>x</i>');
  assert.equal(row.querySelector('.team-result__text').textContent, '<img src=x onerror=1> a & b &amp; c');
  assert.deepEqual([...row.querySelectorAll('mark')].map((m) => m.textContent), ['&', '&']);
  answer = found([match(2, { excerpt: 'x <b>y</b> <B>z' })]);
  await search(t, h, '<b>');
  assert.equal(rows(h)[0].querySelector('b'), null);
  assert.deepEqual([...rows(h)[0].querySelectorAll('mark')].map((m) => m.textContent), ['<b>', '<B>']);
  assert.equal(rows(h)[0].querySelector('.team-result__text').textContent, 'x <b>y</b> <B>z');
  answer = found([match(3, { excerpt: 'Hello LOW lo' })]);
  await search(t, h, 'lo');
  assert.deepEqual([...rows(h)[0].querySelectorAll('mark')].map((m) => m.textContent), ['lo', 'LO', 'lo']);
});

test('keys: Ctrl+F from the timeline and a composer, Down and Up between field and results, Esc on a result, the header button', async (t) => {
  const { h } = await openChat({ messages: [message(1), message(2)], answers: { chatSearch: found([match(2), match(1)]) } });
  t.after(h.restore);
  timed(t);
  const row = h.view.q('[data-team-region="timeline"] .team-msg[data-message-id]');
  row.focus();
  const event = key(h, row, 'f', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.window.document.activeElement, field(h));
  await search(t, h, 'message');
  const composer = h.view.q('.team-composer__input');
  composer.focus();
  key(h, composer, 'F', { ctrlKey: true });
  assert.equal(h.window.document.activeElement, field(h));
  assert.equal(field(h).selectionStart, 0);
  assert.equal(field(h).selectionEnd, 'message'.length, 'its text selected');
  key(h, field(h), 'ArrowDown');
  assert.equal(h.window.document.activeElement, rows(h)[0]);
  key(h, rows(h)[0], 'ArrowDown');
  assert.equal(h.window.document.activeElement, rows(h)[1]);
  key(h, rows(h)[1], 'ArrowUp');
  key(h, rows(h)[0], 'ArrowUp');
  assert.equal(h.window.document.activeElement, field(h));
  key(h, field(h), 'ArrowDown');
  key(h, rows(h)[0], 'Escape');
  assert.equal(field(h).value, '');
  assert.equal(lists(h).hidden, false);
  composer.focus();
  searchButton(h).click();
  assert.equal(h.window.document.activeElement, field(h));
});

test('under 720 px the button shows the list screen; a jump shows the channel and Back returns to the results', async (t) => {
  const { h } = await openChat({ narrow: true, messages: [message(1), message(2)], answers: { chatSearch: found([match(2)]) } });
  t.after(h.restore);
  timed(t);
  const shell = h.view.q('.team-shell');
  assert.equal(shell.dataset.screen, 'channel');
  searchButton(h).click();
  assert.equal(shell.dataset.screen, 'list');
  await search(t, h, 'message');
  rows(h)[0].click();
  await micro();
  assert.equal(shell.dataset.screen, 'channel');
  h.view.q('[data-team-tab-action="back"]').click();
  assert.equal(shell.dataset.screen, 'list');
  assert.deepEqual(ids(h), [msgId(2)], 'the results are still there');
  assert.equal(rows(h)[0].getAttribute('aria-current'), 'true', 'the last result jumped to');
});

test('a render that rewrites the column around the search never rewrites the search region; the field keeps caret and text', async (t) => {
  const { h } = await openChat({ messages: [message(1)] });
  t.after(h.restore);
  const input = field(h);
  input.focus();
  type(h, 'hello', input);
  input.setSelectionRange(2, 2);
  const head = h.view.q('[data-team-region="panel-head"]');
  const markup = head.innerHTML;
  const watch = new h.window.MutationObserver(() => {});
  watch.observe(h.view.q('[data-team-region="search"]'), { childList: true });
  h.listeners.state({ teams: [memberTeam({ team_name: 'Dot lab two', display_name: 'Dot again' })] });
  chatPush(h, { type: 'members', members: [...CHAT_MEMBERS, chatMember(MAYA, 'Maya Okafor')] });
  pushMessages(h, [message(2)]);
  await flush();
  assert.notEqual(head.innerHTML, markup, 'the switcher above the field was rewritten');
  assert.deepEqual(watch.takeRecords(), [], 'the search region itself was not');
  assert.equal(field(h), input, 'the same node');
  assert.equal(input.value, 'hello');
  assert.equal(input.selectionStart, 2);
  assert.equal(h.window.document.activeElement, input);
});

test('a malformed match is never drawn and wedges nothing; a match with a bad date draws without one', async (t) => {
  const bad = [match(5, { created_at: 'x' }), match(4, { created_at: undefined }), { ...match(3), message_id: undefined }, match(2, { seq: 'two' }),
    null, 'text', { ...match(6), channel_id: 7 }];
  const { h } = await openChat({ answers: { chatSearch: found([match(1), ...bad]) } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  assert.deepEqual(ids(h), [msgId(1), msgId(5), msgId(4)]);
  assert.equal(rows(h)[1].querySelector('.team-result__when').textContent, '');
  pushMessages(h, [message(1)]);
  h.listeners.state({ teams: [memberTeam({ display_name: 'Dot again' })] });
  await micro();
  assert.deepEqual(ids(h), [msgId(1), msgId(5), msgId(4)], 'a later render draws them again');
});

test('a clear while a search is out keeps one call out: the next query waits for it, and the old answer is not drawn', async (t) => {
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatSearch: gate.answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'a');
  key(h, field(h), 'Escape');
  await search(t, h, 'b');
  assert.deepEqual(gate.calls.map((p) => p.query), ['a'], 'one call out');
  gate.release(found([match(1)]));
  await micro();
  assert.deepEqual(gate.calls.map((p) => p.query), ['a', 'b'], '"b" goes when "a" answers');
  assert.deepEqual(ids(h), [], 'the answer for "a" is not drawn');
  gate.release(found([match(2)]));
  await micro();
  assert.deepEqual(ids(h), [msgId(2)]);
});

test('a query typed away and back while it is out is sent once and its answer drawn', async (t) => {
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatSearch: gate.answer } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'A');
  await search(t, h, 'B');
  await search(t, h, 'A');
  gate.release(found([match(1)]));
  await micro();
  assert.deepEqual(gate.calls.map((p) => p.query), ['A']);
  assert.deepEqual(ids(h), [msgId(1)]);
});

test('exactly one result is the tab stop: the first, then the one jumped to', async (t) => {
  const { h } = await openChat({ messages: [message(1), message(2)], answers: { chatSearch: found([match(2), match(1)]) } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  const stops = () => rows(h).filter((el) => el.tabIndex === 0).map((el) => el.dataset.messageId);
  assert.deepEqual(stops(), [msgId(2)]);
  rows(h)[1].click();
  await micro();
  assert.deepEqual(stops(), [msgId(1)]);
});

test('presence and typing changes do not redraw the results; another change does', async (t) => {
  const { h } = await openChat({ messages: [message(1)], answers: { chatSearch: found([match(2), match(1)]) } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  const drawn = [];
  const inventory = globalThis.inventory;
  const actionButton = inventory.actionButton;
  inventory.actionButton = (opts) => { if (/team-result\b/.test(opts.className || '')) drawn.push(opts); return actionButton(opts); };
  t.after(() => { inventory.actionButton = actionButton; });
  chatPush(h, { type: 'presence', member_id: DOT, state: 'away', last_seen_at: null });
  chatPush(h, { type: 'typing', channel_id: CHAN, member_id: ME });
  await micro();
  assert.equal(drawn.length, 0);
  pushMessages(h, [message(3)]);
  await micro();
  assert.ok(drawn.length > 0);
});

test('the query pattern is built once per answer, not once per row', async (t) => {
  const page = Array.from({ length: 20 }, (_v, i) => match(40 - i));
  const { h } = await openChat({ answers: { chatSearch: found(page) } });
  t.after(h.restore);
  timed(t);
  const Real = globalThis.RegExp;
  let built = 0;
  globalThis.RegExp = new Proxy(Real, { construct(target, args) { built += 1; return new target(...args); } });
  t.after(() => { globalThis.RegExp = Real; });
  await search(t, h, 'message');
  globalThis.RegExp = Real;
  assert.equal(rows(h).length, 20);
  assert.ok(built <= 2, built + ' patterns for 20 rows');
});

test('Load more while a new query waits: the latest query wins and its results are drawn', async (t) => {
  let n = 0;
  const answers = [found([match(40)], 'cur_1'), found([match(39)]), found([match(7)])];
  const { h } = await openChat({ answers: { chatSearch: () => answers[n++] } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  type(h, 'other', field(h));
  more(h).click();
  await micro();
  t.mock.timers.tick(300);
  await micro();
  assert.deepEqual(searches(h).map((p) => [p.query, p.cursor || null]), [['message', null], ['message', 'cur_1'], ['other', null]]);
  assert.deepEqual(ids(h), [msgId(7)]);
  assert.equal(field(h).value, 'other');
});

test('a Load more refused as too fast is asked again with its cursor', async (t) => {
  const page = Array.from({ length: 20 }, (_v, i) => match(40 - i));
  let n = 0;
  const answers = [found(page, 'cur_1'), refusal('team_chat_rate_limit'), found([match(1)])];
  const { h } = await openChat({ answers: { chatSearch: () => answers[n++] } });
  t.after(h.restore);
  timed(t);
  await search(t, h, 'message');
  more(h).click();
  await micro();
  t.mock.timers.tick(3_000);
  await micro();
  assert.deepEqual(searches(h)[2], { team_id: OTHER, query: 'message', limit: 20, cursor: 'cur_1' });
  assert.equal(rows(h).length, 21);
});

// Last: its mocked timers are switched per pass, and the timer counter it installs is restored only at the end.
test('a team change, a lock, `cleared` and dispose leave no search timer, listener or late answer', async (t) => {
  for (const end of ['team', 'lock', 'cleared', 'dispose']) {
    const gate = heldAnswers();
    const { h } = await openChat({ teams: [memberTeam(), snapshot()], answers: { chatSearch: gate.answer } });
    t.after(h.restore);
    const live = timed(t);
    await search(t, h, 'one');
    type(h, 'two', field(h));
    assert.equal(live.size, 1, end + ': the 300 ms wait');
    if (end === 'team') h.listeners.state({ teams: [snapshot()] });
    else if (end === 'lock') h.listeners.state({ teams: [memberTeam({ state: 'revoked' }), snapshot()] });
    else if (end === 'cleared') h.listeners.chat({ team_id: OTHER, type: 'cleared' });
    else h.tab.hideTeamTab();
    await micro();
    assert.equal(live.size, 0, end + ': no timer left');
    gate.release(found([match(1)]));
    await micro();
    t.mock.timers.tick(5_000);
    await micro();
    assert.equal(gate.calls.length, 1, end + ': nothing more asked');
    assert.equal(h.view.qa('.team-result').length, 0, end + ': the late answer draws nothing');
    if (end === 'cleared') assert.equal(field(h).value, '', 'the query is dropped');
    t.mock.timers.reset();
  }
});
