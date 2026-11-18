'use strict';

// new-test-file: renderer-team-attachments.test.js is at 551 of its 600 lines. These are the slice 2c fix list's
// cases (row 123): the pictures cache driven through the rows with more pictures in view than it holds, the fetch
// only near the viewport (once per frame, a queued fetch dropped when its row leaves view), no rebuild or second
// decode on an unrelated redraw, "From you", the offline sentence, the teardown on leave, revoke and Force local with
// its listeners, and the composer fixes (a file added while a post is out, a file the host lost, an empty file or a
// folder, the dialog closing on a team let go, accessible names, the tray's redraws and the empty stashes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OTHER, CHAN, flush, memberTeam, message, msgId, openChat, heldAnswers, type, key, harness, shell, chatPush, pushMessages,
  openThreadFrom } = require('./helpers/team-settings-harness');

const MiB = 1024 * 1024;
const ATT = (n) => 'att_' + String(n).padStart(26, '0');
const DATA = 'data:image/png;base64,iVBORw0KGgo=';
// A real 4 MiB picture's data: URL is this long (fix list T11), so the 64 MiB cache holds 11 of them.
const BIG = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((4 * MiB) / 3) * 4);
const pic = (n, size = 4 * MiB) => ({ id: ATT(n), name: `p${n}.png`, mime: 'image/png', size_bytes: size, kind: 'image' });
const fake = (name, size = 2048, kind = 'application/pdf') => ({ name, type: kind, size, arrayBuffer: async () => new ArrayBuffer(4) });
let ids = 0;
const uploaded = (p) => ({ ok: true, attachment: { id: ATT(900 + (ids += 1)), name: p.name, mime: p.type, size_bytes: 2048, kind: 'file' } });
const refused = (reason) => ({ ok: false, error: { code: '', reason } });
const row = (h, seq) => h.view.q(`.team-msg[data-message-id="${msgId(seq)}"]`);
const input = (h) => h.view.q('[data-team-region="composer"] .team-composer__input');
const chips = (h) => h.view.qa('[data-team-region="composer"] .team-staged .attachment-chip')
  .map((chip) => [chip.querySelector('.attachment-chip-name').textContent, chip.querySelector('.attachment-chip-meta').firstChild.textContent]);
const frame = () => new Promise((resolve) => { setTimeout(resolve, 40); }); // past jsdom's animation frame
function paste(h, files, target = input(h)) {
  const event = new h.window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { files };
  target.dispatchEvent(event);
}
// Held calls still waiting at the end are answered, so the store's call bounds do not keep the process alive.
function held(t) {
  const gate = heldAnswers();
  t.after(async () => {
    for (let found = true; found;) {
      found = false;
      for (;;) { try { gate.release(refused('team_not_connected')); found = true; } catch { break; } }
      await flush();
    }
  });
  return gate;
}
function stubUrls(t) {
  const made = [];
  const revoked = [];
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => { const url = 'blob:jenny/' + (made.length + 1); made.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  t.after(() => { URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke; });
  return { made, revoked };
}
// The data: URL characters the drawn pictures hold: what the cache holds for the rows on the page.
const drawnBytes = (h) => h.view.qa('img[data-team-src][src]').reduce((n, img) => n + img.getAttribute('src').length, 0);
function cached(files, id) {
  const view = files.createFiles({ teamId: OTHER, channelId: CHAN, scroll: null, ctx: () => ({ online: true }) });
  const block = view.row(message(99, { attachments: [pic(Number(id.slice(4)), 10)] }), { online: true });
  view.dispose();
  return block.html.includes('data-team-file="open"');
}

// ------------------------------------------------------------------ the cache (M2, T2, T11)

test('more pictures in view than the cache holds: 11 are fetched and drawn, the rest wait with their size, and the fetches settle', async (t) => {
  const gate = held(t);
  const { h } = await openChat({ messages: Array.from({ length: 20 }, (_, i) => message(i + 1, { attachments: [pic(i + 1)] })), answers: { chatAttachmentImage: gate.answer } });
  t.after(h.restore);
  const files = require('../renderer/team/renderer-team-files');
  let peak = 0;
  // Each answer in turn; a refetch loop would keep a call waiting forever, so the answers are capped at 60.
  for (let answered = 0; answered < 60; answered += 1) {
    try { gate.release({ ok: true, data_url: BIG }); } catch { break; }
    await flush();
    peak = Math.max(peak, drawnBytes(h)); // after each answer: what the cache holds then, never above its bound
  }
  assert.ok(gate.calls.length < 60, `the fetches settle (${gate.calls.length} asked)`);
  assert.ok(peak <= files.CACHE_MAX, `peak ${peak} within ${files.CACHE_MAX}`);
  assert.equal(h.view.qa('button.team-img img[src]').length, 11);
  assert.equal(gate.calls.length, 11, 'a picture that would not fit is not fetched');
  pushMessages(h, [message(21)]);
  h.view.q('.team-scroll').dispatchEvent(new h.window.Event('scroll'));
  await frame();
  await flush();
  assert.equal(gate.calls.length, 11, 'a redraw and a scroll fetch nothing more: no loop');
  const waiting = h.view.qa('.team-img[data-state="waiting"]');
  assert.equal(waiting.length, 9);
  assert.equal(waiting[0].querySelector('.team-img__words span').textContent, 'Picture · 4 MB');
  const show = waiting[0].querySelector('[data-team-file="fetch"]');
  assert.equal(show.getAttribute('aria-label'), 'Show picture p12.png');
  show.click();
  await flush();
  assert.equal(gate.calls.length, 12, 'a click fetches that one');
  gate.release({ ok: true, data_url: BIG });
  await flush();
  assert.ok(row(h, 12).querySelector('button.team-img img[src]'), 'the clicked picture is drawn');
  assert.equal(row(h, 1).querySelector('.team-img').dataset.state, 'waiting', 'the picture longest out of view made room');
  assert.ok(drawnBytes(h) <= files.CACHE_MAX);
  await flush();
  assert.equal(gate.calls.length, 12, 'and nothing more is fetched');
});

// ------------------------------------------------------------------ near the viewport (S6, T8)

test('a picture far from the viewport is not fetched until a scroll brings it near; scrolls are looked at once per frame', async (t) => {
  const gate = held(t);
  const { h } = await openChat({ messages: [message(1, { attachments: [pic(1, 10)] })], answers: { chatAttachmentImage: gate.answer } });
  t.after(h.restore);
  const proto = h.window.HTMLElement.prototype;
  const real = proto.getBoundingClientRect;
  const far = new Set([ATT(2), ATT(6)]);
  let looks = 0;
  proto.getBoundingClientRect = function rect() {
    if (this.classList.contains('team-scroll')) looks += 1;
    if (this.dataset.teamAtt && far.has(this.dataset.teamAtt)) return { top: 5000, bottom: 5220, left: 0, right: 0, width: 0, height: 220 };
    return real.call(this);
  };
  t.after(() => { proto.getBoundingClientRect = real; });
  pushMessages(h, [message(2, { attachments: [pic(2, 10)] })]);
  await flush();
  assert.deepEqual(gate.calls.map((c) => c.attachment_id), [ATT(1)], 'the far picture is not fetched');
  assert.equal(row(h, 2).querySelector('.team-img').dataset.state, 'loading');
  far.delete(ATT(2));
  looks = 0;
  for (let i = 0; i < 5; i += 1) h.view.q('.team-scroll').dispatchEvent(new h.window.Event('scroll'));
  await frame();
  assert.equal(looks, 1, 'five scrolls in one frame are one look');
  assert.deepEqual(gate.calls.map((c) => c.attachment_id), [ATT(1), ATT(2)], 'near now: fetched');
  // A fetch waiting for a slot whose row leaves view is dropped, and asked again when it comes back.
  pushMessages(h, [message(3, { attachments: [pic(3, 10)] }), message(4, { attachments: [pic(4, 10)] })]);
  await flush();
  assert.equal(gate.calls.length, 3, 'three at once; the fourth waits');
  far.add(ATT(4));
  h.view.q('.team-scroll').dispatchEvent(new h.window.Event('scroll'));
  await frame();
  gate.release({ ok: true, data_url: DATA });
  await flush();
  assert.equal(gate.calls.some((c) => c.attachment_id === ATT(4)), false, 'out of view when its turn came');
  far.delete(ATT(4));
  h.view.q('.team-scroll').dispatchEvent(new h.window.Event('scroll'));
  await frame();
  await flush();
  assert.equal(gate.calls.filter((c) => c.attachment_id === ATT(4)).length, 1, 'back in view: fetched');
});

// ------------------------------------------------------------------ no rebuild (M3)

test('an unrelated message, typing, presence or a read mark never rebuilds a picture, decodes it again or escapes its bytes', async (t) => {
  const strings = require('../renderer/shared/string-utils');
  const escape = strings.escapeHtml;
  const escaped = [];
  strings.escapeHtml = (value) => { escaped.push(String(value)); return escape(value); };
  t.after(() => { strings.escapeHtml = escape; });
  const { h } = await openChat({ messages: [message(1, { attachments: [pic(1, 10)] })], answers: { chatAttachmentImage: { ok: true, data_url: DATA } } });
  t.after(h.restore);
  const img = row(h, 1).querySelector('img');
  assert.equal(img.getAttribute('src'), DATA);
  assert.equal(img.getAttribute('decoding'), 'async', 'S9');
  const proto = h.window.HTMLImageElement.prototype;
  const src = Object.getOwnPropertyDescriptor(proto, 'src');
  let sets = 0;
  Object.defineProperty(proto, 'src', { configurable: true, get: src.get, set(value) { sets += 1; src.set.call(this, value); } });
  t.after(() => { Object.defineProperty(proto, 'src', src); });
  escaped.length = 0;
  pushMessages(h, [message(2)]);
  chatPush(h, { type: 'typing', channel_id: CHAN, thread_root_id: null, member_id: 'member_me' });
  chatPush(h, { type: 'presence', member_id: 'member_me', state: 'away', last_seen_at: null });
  chatPush(h, { type: 'channels', channels: [{ channel_id: CHAN, kind: 'team', archived: false, rev: 2, last_seq: 2, floor_seq: 1, last_read_seq: 2, notify: 'all', unread: 0, unread_capped: false, mention: false }] });
  await flush();
  assert.equal(row(h, 1).querySelector('img'), img, 'the picture node is the same');
  assert.equal(sets, 0, 'no src was set again');
  assert.equal(escaped.some((value) => value === 'p1.png' || value.startsWith('data:')), false, 'the row was not built again and bytes are never escaped');
  assert.equal(h.sent('chatAttachmentImage').length, 1);
});

// ------------------------------------------------------------------ words (T7, T9)

test('your own picture opens as "From you"; offline, a picture not fetched yet says it needs the team online', async (t) => {
  const gate = held(t);
  const opened = [];
  const saved = globalThis.rendererImageViewerController;
  globalThis.rendererImageViewerController = { open: (arg) => { opened.push(arg); return Promise.resolve(true); } };
  t.after(() => { if (saved === undefined) delete globalThis.rendererImageViewerController; else globalThis.rendererImageViewerController = saved; });
  const pics = [1, 2, 3, 4].map((n) => pic(n, 1536));
  const { h } = await openChat({ messages: [message(1, { attachments: pics })], answers: { chatAttachmentImage: gate.answer } });
  t.after(h.restore);
  assert.equal(gate.calls.length, 3, 'the fourth waits for a slot');
  gate.release({ ok: true, data_url: DATA });
  await flush();
  row(h, 1).querySelector('button.team-img').click();
  await flush();
  assert.match(opened[0].items[0].caption, /^From you · .+ · 2 KB$/);
  h.listeners.state({ teams: [memberTeam({ state: 'offline', since: 5 })] });
  await flush();
  const waiting = [...row(h, 1).querySelectorAll('.team-img[data-state="offline"]')];
  assert.ok(waiting.length >= 1);
  assert.equal(waiting[0].querySelector('.team-img__words span').textContent, 'This picture needs the team online.');
});

// ------------------------------------------------------------------ teardown (S3, T3, T10)

async function gated(t, urls) {
  const h = harness({ show: false, teams: [memberTeam()], answers: { chatUpload: uploaded,
    chatHistory: { ok: true, messages: [message(1, { attachments: [pic(1, 10)] })], has_more: false }, chatAttachmentImage: { ok: true, data_url: DATA } } });
  t.after(h.restore);
  const proto = h.window.EventTarget.prototype;
  const real = { add: proto.addEventListener, remove: proto.removeEventListener };
  const counts = {};
  const count = (kind, n) => { counts[kind] = (counts[kind] || 0) + n; };
  proto.addEventListener = function add(kind, ...rest) { count(kind, 1); return real.add.call(this, kind, ...rest); };
  proto.removeEventListener = function remove(kind, ...rest) { count(kind, -1); return real.remove.call(this, kind, ...rest); };
  t.after(() => { proto.addEventListener = real.add; proto.removeEventListener = real.remove; });
  const s = shell(h, { activeView: 'team' });
  await flush();
  await flush();
  paste(h, [fake('p.png', 10, 'image/png'), fake('q.pdf')], h.view.q('.team-composer__input'));
  await flush();
  assert.equal(urls.made.length, 1);
  return { h, s, counts, attach: h.window.rendererTeamAttach, files: h.window.rendererTeamFiles };
}
for (const [end, state] of [['a leave or Remove team', null], ['a revoke', 'revoked'], ['a Force local hold', 'force_local']]) {
  test(`${end} drops the team's waiting files, revokes their object URLs and empties the pictures cache`, async (t) => {
    const urls = stubUrls(t);
    const { h, attach, files } = await gated(t, urls);
    assert.equal(attach._state().stashes, 1);
    assert.equal(cached(files, ATT(1)), true);
    h.listeners.state({ teams: state ? [memberTeam({ state })] : [] });
    await flush();
    assert.equal(attach._state().stashes, 0, 'no stash');
    assert.equal(attach._state().timer, false, 'no expiry timer');
    assert.deepEqual(urls.revoked, urls.made, 'every object URL revoked');
    assert.equal(cached(files, ATT(1)), false, 'no cached picture');
  });
}

test('the drag, paste and scroll listeners the Team tab adds are all removed at its teardown', async (t) => {
  const urls = stubUrls(t);
  const { s, counts } = await gated(t, urls);
  const kinds = ['dragenter', 'dragover', 'dragleave', 'drop', 'paste', 'scroll'];
  assert.ok(kinds.filter((kind) => counts[kind] > 0).length >= 5, JSON.stringify(counts));
  s.controller.dispose();
  for (const kind of kinds) assert.equal(counts[kind] || 0, 0, `${kind} listeners left: ${counts[kind]}`);
});

// ------------------------------------------------------------------ the composer (S2, S4, S5, S10, S11, S14, S16)

test('a file added while a post is out stays in the tray after the post answers (S2, T5)', async (t) => {
  const post = held(t);
  const { h } = await openChat({ answers: { chatUpload: uploaded, chatPost: post.answer } });
  t.after(h.restore);
  paste(h, [fake('a.pdf')]);
  await flush();
  type(h, 'here');
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(post.calls.length, 1);
  paste(h, [fake('b.pdf')]);
  await flush();
  post.release({ ok: true, message_id: msgId(9), seq: 9, rev: 1 });
  await flush();
  assert.deepEqual(chips(h).map(([name]) => name), ['b.pdf']);
});

test('a post refused because the host lost fresh files marks them for a new upload, and Retry uploads them again (S11, T12)', async (t) => {
  const { h } = await openChat({ answers: { chatUpload: uploaded, chatPost: refused('team_chat_not_found') } });
  t.after(h.restore);
  paste(h, [fake('fresh.pdf')]);
  await flush();
  type(h, 'now');
  key(h, input(h), 'Enter');
  await flush();
  assert.deepEqual(chips(h)[0], ['fresh.pdf', 'Waited more than an hour, so the team server let it go. Attach it again.']);
  const retry = h.view.q('[data-team-composer="attach-retry"]');
  assert.equal(retry.getAttribute('aria-label'), 'Retry fresh.pdf', 'S16: Retry names its file');
  retry.click();
  await flush();
  assert.equal(h.sent('chatUpload').length, 2);
  assert.equal(chips(h)[0][1], 'PDF · 2 KB');
});

test('an empty file or a folder is refused before any object URL is made; files picked after the team is let go are not added (S4)', async (t) => {
  const urls = stubUrls(t);
  const pick = held(t);
  const { h } = await openChat({ answers: { chatUpload: uploaded, chatAttachPick: pick.answer } });
  t.after(h.restore);
  paste(h, [fake('empty.png', 0, 'image/png'), fake('folder', 0, '')]);
  await flush();
  assert.deepEqual(chips(h).map(([, line]) => line), ['Empty: this file has nothing in it, or it is a folder.', 'Empty: this file has nothing in it, or it is a folder.']);
  assert.equal(urls.made.length, 0);
  assert.equal(h.sent('chatUpload').length, 0);
  h.view.qa('[data-team-composer="attach-remove"]').forEach((el) => el.click());
  await flush();
  h.view.q('[data-team-composer="attach"]').click();
  await flush();
  h.listeners.state({ teams: [] });
  await flush();
  pick.release({ ok: true, files: [{ name: 'late.png', type: 'image/png', size: 4, bytes: new Uint8Array([1, 2, 3, 4]) }], not_added: 0 });
  await flush();
  assert.equal(h.sent('chatUpload').length, 0, 'nothing uploaded');
  assert.equal(urls.made.length, 0, 'no object URL');
});

test('the paperclip names its reason, the tray is a group, typing never rewrites the tray, and an empty tray is not drawn (S5, S10, S16)', async (t) => {
  const { h } = await openChat({ answers: { chatUpload: uploaded } });
  t.after(h.restore);
  const tray = h.view.q('.team-staged');
  assert.equal(tray.getAttribute('role'), 'group');
  assert.equal(tray.getAttribute('aria-label'), 'Files to send');
  paste(h, [fake('a.pdf')]);
  await flush();
  const proto = h.window.Element.prototype;
  const inner = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
  let writes = 0;
  Object.defineProperty(tray, 'innerHTML', { configurable: true, get() { return inner.get.call(this); }, set(value) { writes += 1; inner.set.call(this, value); } });
  for (const text of ['h', 'he', 'hel', 'hell', 'hello']) type(h, text);
  await flush();
  assert.equal(writes, 0, 'nothing in the tray changed');
  h.listeners.state({ teams: [memberTeam({ state: 'offline', since: 5 })] });
  await flush();
  assert.equal(h.view.q('[data-team-composer="attach"]').getAttribute('aria-label'), 'Attach files. Needs the team online');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'team-chat.css'), 'utf8');
  assert.match(css, /\.team-staged\[hidden\] \{ display: none; \}/, 'chat-composer.css gives .attachment-tray display: flex');
});

test('a thread composer opened and closed leaves no empty stash behind (S14)', async (t) => {
  const root = message(2, { reply_count: 1, last_reply_at: new Date().toISOString() });
  const { h } = await openChat({ messages: [message(1), root], answers: { chatThread: { ok: true, root, replies: [], has_more: false } } });
  t.after(h.restore);
  const attach = require('../renderer/team/renderer-team-attach');
  assert.equal(attach._state().stashes, 1);
  await openThreadFrom(h, 2);
  assert.equal(attach._state().stashes, 2);
  h.view.q('[data-team-thread-action="close"]').click();
  await flush();
  assert.equal(attach._state().stashes, 1);
});

// ------------------------------------------------------------------ file previews (row 167): GIFs, the name button, the peek

const doc = (n, name, size = 2048, mime = 'text/markdown') => ({ id: ATT(n), name, mime, size_bytes: size, kind: 'file' });
const LINES = ['# Release notes', 'Two fixes and a note', 'for the team.'];

test('a .md attachment shows a peek of its first three lines once near the viewport', async (t) => {
  const { h } = await openChat({ messages: [message(1, { attachments: [doc(1, 'notes.md')] })], answers: { chatAttachmentText: { ok: true, lines: LINES } } });
  t.after(h.restore);
  const line = row(h, 1).querySelector('.team-file');
  assert.equal(line.querySelector('.team-file__open').textContent, 'notes.md');
  assert.equal(row(h, 1).querySelector('.team-peek').textContent, LINES.join('\n'));
  assert.deepEqual(h.sent('chatAttachmentText').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, attachment_id: ATT(1), peek: true, name: 'notes.md' }]);
});

test('the peek has its place before its lines arrive; a .zip has no name button or peek, and a 600,000-byte .log has the button but no peek and no fetch', async (t) => {
  const gate = held(t);
  const { h } = await openChat({ messages: [message(1, { attachments: [doc(1, 'notes.md')] }),
    message(2, { attachments: [doc(2, 'bundle.zip', 2048, 'application/zip')] }), message(3, { attachments: [doc(3, 'big.log', 600000, 'text/plain')] })],
  answers: { chatAttachmentText: gate.answer } });
  t.after(h.restore);
  assert.equal(row(h, 1).querySelector('.team-peek').textContent, '', 'empty, but there');
  assert.equal(row(h, 1).querySelector('.team-peek').getAttribute('aria-label'), 'Preview notes.md');
  assert.equal(row(h, 2).querySelector('.team-file__open, .team-peek'), null);
  assert.equal(row(h, 2).querySelector('.team-file__name').textContent, 'bundle.zip');
  assert.equal(row(h, 3).querySelector('.team-file__open').textContent, 'big.log');
  assert.equal(row(h, 3).querySelector('.team-peek'), null);
  assert.deepEqual(gate.calls.map((c) => c.attachment_id), [ATT(1)], 'only the small text file is asked about');
  gate.release({ ok: true, lines: LINES });
  await flush();
  assert.equal(row(h, 1).querySelector('.team-peek').textContent, LINES.join('\n'));
  assert.equal(h.sent('chatAttachmentText').length, 1, 'once');
});

test('peek lines are text, never markup, with control characters out; a failed peek is not drawn and is not asked again', async (t) => {
  const { h } = await openChat({ messages: [message(1, { attachments: [doc(1, 'a.html', 100, 'text/html'), doc(2, 'b.txt', 100, 'text/plain')] })],
    answers: { chatAttachmentText: (p) => (p.attachment_id === ATT(1) ? { ok: true, lines: ['<img src=x onerror=alert(1)>', 'tab\u0007bell', 'c'] } : refused('team_not_connected')) } });
  t.after(h.restore);
  const peeks = row(h, 1).querySelectorAll('.team-peek');
  assert.equal(peeks.length, 1, 'the failed one is not drawn');
  assert.equal(peeks[0].querySelector('img'), null);
  assert.equal(peeks[0].textContent, ['<img src=x onerror=alert(1)>', 'tabbell', 'c'].join('\n'));
  assert.equal(row(h, 1).querySelectorAll('.team-file__open').length, 2, 'the names stay');
  h.view.q('.team-scroll').dispatchEvent(new h.window.Event('scroll'));
  await frame();
  await flush();
  assert.equal(h.sent('chatAttachmentText').length, 2, 'not asked again');
});

test('a refusal as not text removes the peek and the name button; gone is the file line as for a picture', async (t) => {
  const { h } = await openChat({ messages: [message(1, { attachments: [doc(1, 'data.txt', 100, 'text/plain'), doc(2, 'old.txt', 100, 'text/plain')] })],
    answers: { chatAttachmentText: (p) => refused(p.attachment_id === ATT(1) ? 'team_attachment_not_text' : 'team_chat_not_found') } });
  t.after(h.restore);
  assert.equal(row(h, 1).querySelector('.team-peek'), null);
  assert.equal(row(h, 1).querySelector('.team-file__open'), null);
  assert.deepEqual([...row(h, 1).querySelectorAll('.team-file__name')].map((el) => el.textContent), ['data.txt', 'old.txt']);
  assert.equal(row(h, 1).querySelectorAll('.team-file')[1].dataset.gone, 'true');
  assert.equal(h.sent('chatAttachmentText').length, 2);
});

test('offline, a text file has its name button and no peek, and nothing is fetched', async (t) => {
  const { h } = await openChat({ messages: [message(1)], answers: { chatAttachmentText: { ok: true, lines: LINES } } });
  t.after(h.restore);
  h.listeners.state({ teams: [memberTeam({ state: 'offline', since: 5 })] });
  await flush();
  pushMessages(h, [message(2, { attachments: [doc(1, 'notes.md')] })]);
  await flush();
  assert.ok(row(h, 2).querySelector('.team-file__open'));
  assert.equal(row(h, 2).querySelector('.team-peek'), null);
  assert.equal(h.sent('chatAttachmentText').length, 0);
});

test('a peek already read stays when the team goes offline', async (t) => {
  const { h } = await openChat({ messages: [message(1, { attachments: [doc(1, 'notes.md')] })], answers: { chatAttachmentText: { ok: true, lines: LINES } } });
  t.after(h.restore);
  const text = LINES.join('\n');
  assert.equal(row(h, 1).querySelector('.team-peek').textContent, text);
  h.listeners.state({ teams: [memberTeam({ state: 'offline', since: 5 })] });
  await flush();
  assert.equal(row(h, 1).querySelector('.team-peek').textContent, text, 'still there offline');
  assert.equal(h.sent('chatAttachmentText').length, 1);
});

test('the name button and the peek each send one team:file-preview event, with who, when and which file', async (t) => {
  const { h } = await openChat({ messages: [message(1, { attachments: [doc(1, 'notes.md', 4096)] }),
    message(2, { author: { kind: 'member', member_id: 'member_me' }, attachments: [doc(2, 'mine.py', 10, 'text/x-python')] })],
  answers: { chatAttachmentText: { ok: true, lines: LINES } } });
  t.after(h.restore);
  const seen = [];
  h.view.q('.team-scroll').parentElement.addEventListener('team:file-preview', (event) => { seen.push({ target: event.target, detail: event.detail }); });
  const name = row(h, 1).querySelector('.team-file__open');
  name.click();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, name);
  assert.deepEqual(seen[0].detail, { teamId: OTHER, channelId: CHAN, messageId: msgId(1), attachment: { id: ATT(1), name: 'notes.md', mime: 'text/markdown', size_bytes: 4096 },
    authorName: 'Dot', own: true, createdAt: message(1).created_at });
  const peek = row(h, 1).querySelector('.team-peek');
  peek.click();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].target, peek);
  assert.deepEqual(seen[1].detail, seen[0].detail);
  row(h, 2).querySelector('.team-file__open').click();
  assert.equal(seen[2].detail.own, false);
  assert.equal(seen[2].detail.authorName, 'Olive Owner');
  assert.equal(seen[2].detail.attachment.id, ATT(2));
  assert.equal(seen.length, 3, 'nothing else sends it');
});

test('a GIF the host kept as a file is drawn as a picture; one main refuses is a file line; the viewer offers no Copy for it', async (t) => {
  const opened = [];
  const saved = globalThis.rendererImageViewerController;
  globalThis.rendererImageViewerController = { open: (arg) => { opened.push(arg); return Promise.resolve(true); } };
  t.after(() => { if (saved === undefined) delete globalThis.rendererImageViewerController; else globalThis.rendererImageViewerController = saved; });
  const gif = (n) => ({ id: ATT(n), name: `g${n}.gif`, mime: 'image/gif', size_bytes: 2048, kind: 'file' });
  const png = { id: ATT(9), name: 'p.png', mime: 'image/png', size_bytes: 2048, kind: 'image' };
  const GIF_URL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const { h } = await openChat({ messages: [message(1, { attachments: [gif(1), gif(2), png] })],
    answers: { chatAttachmentImage: (p) => (p.attachment_id === ATT(2) ? refused('team_attachment_not_image') : { ok: true, data_url: p.attachment_id === ATT(9) ? DATA : GIF_URL }) } });
  t.after(h.restore);
  assert.equal(h.sent('chatAttachmentImage').length, 3);
  assert.equal(row(h, 1).querySelectorAll('button.team-img').length, 2, 'two pictures drawn');
  assert.equal(row(h, 1).querySelector('button.team-img img').getAttribute('src'), GIF_URL);
  assert.equal(row(h, 1).querySelector('.team-file__name').textContent, 'g2.gif', 'the refused one is a file line');
  assert.equal(row(h, 1).querySelector('.team-file__open, .team-peek'), null);
  row(h, 1).querySelector('button.team-img').click();
  await flush();
  assert.deepEqual(opened[0].items.map((i) => [i.title, Object.keys(i.actions)]), [['g1.gif', ['save-as']], ['p.png', ['save-as', 'copy']]]);
});

test('at most 3 fetches are out at once across 2 pictures and 5 peeks, oldest first', async (t) => {
  let out = 0;
  let most = 0;
  const waiting = [];
  const order = [];
  const answer = (kind) => (p) => new Promise((resolve) => {
    out += 1;
    most = Math.max(most, out);
    order.push(`${kind}:${p.attachment_id}`);
    waiting.push(() => { out -= 1; resolve(kind === 'image' ? { ok: true, data_url: DATA } : { ok: true, lines: LINES }); });
  });
  t.after(() => { while (waiting.length) waiting.shift()(); });
  const { h } = await openChat({ messages: [message(1, { attachments: [pic(1, 10), pic(2, 10), ...[3, 4, 5, 6, 7].map((n) => doc(n, `n${n}.md`))] })],
    answers: { chatAttachmentImage: answer('image'), chatAttachmentText: answer('text') } });
  t.after(h.restore);
  assert.equal(out, 3);
  for (let i = 0; i < 20 && waiting.length; i += 1) { waiting.shift()(); await flush(); }
  assert.equal(most, 3, 'never more than 3 out');
  assert.deepEqual(order, [`image:${ATT(1)}`, `image:${ATT(2)}`, ...[3, 4, 5, 6, 7].map((n) => `text:${ATT(n)}`)]);
  assert.equal(row(h, 1).querySelectorAll('.team-peek').length, 5);
  assert.equal([...row(h, 1).querySelectorAll('.team-peek')].every((el) => el.textContent === LINES.join('\n')), true);
});
