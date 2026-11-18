'use strict';

// new-test-file: renderer-team-preview.js is a new module (row 167, slice P), the read-only preview column beside
// the channel; no existing test file covers a surface that opens from `team:file-preview`.
// The preview column: opened by the event renderer-team-files.js dispatches, its text from `chatAttachmentText`
// (answered by the harness's fake bridge), its states, its Esc and Back rules, the thread it covers, the cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, CHAN, ME, DOT, flush, openChat, openThreadChat, openThreadFrom, heldAnswers, threadOf, message, msgId, key, chatChannel, memberTeam, overview } = require('./helpers/team-settings-harness');
const preview = require('../renderer/team/renderer-team-preview');

const ATT = (n) => 'att_' + String(n).padStart(26, '0');
const file = (n, name, mime = 'text/plain', size = 2048) => ({ id: ATT(n), name, mime, size_bytes: size });
const text = (body, over = {}) => ({ ok: true, text: body, truncated: false, total_bytes: Buffer.byteLength(body), ...over });
const refused = (reason) => ({ ok: false, error: { code: '', reason } });
const lines = (count) => Array.from({ length: count }, (_, i) => 'line ' + (i + 1)).join('\n');

// The event renderer-team-files.js dispatches on the control a person used (slice F's contract).
function ask(h, attachment, { from = null, teamId = OTHER, authorName = 'Dot', own = false } = {}) {
  const target = from || h.view.q('.team-msg');
  const event = new h.window.CustomEvent('team:file-preview', { bubbles: true,
    detail: { teamId, channelId: CHAN, messageId: msgId(1), attachment, authorName, own, createdAt: '2026-11-16T09:14:00.000Z' } });
  target.dispatchEvent(event);
  return target;
}
const column = (h) => h.view.q('aside.team-preview');
const body = (h) => h.view.q('.team-preview__body');
const shellOf = (h) => h.view.q('.team-shell');
const rows = (h) => h.view.qa('.team-preview__body .artifact-file-preview-row');
const names = (h) => h.view.q('.team-preview__name').textContent;
async function opened(t, answers, over = {}) {
  const chat = await openChat({ messages: [message(1)], answers: { chatAttachmentText: text('alpha\nbeta'), ...answers }, ...over });
  t.after(() => { chat.h.restore(); preview.disposeAll(); });
  return chat.h;
}

test('a team:file-preview event opens the preview column with the file\'s text', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('alpha\nbeta\ngamma') });
  ask(h, file(1, 'notes.txt'));
  await flush();
  assert.ok(column(h), 'aside.team-preview exists');
  assert.equal(shellOf(h).dataset.preview, 'side');
  assert.equal(column(h).getAttribute('aria-label'), 'Preview of notes.txt');
  assert.deepEqual(h.sent('chatAttachmentText').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, attachment_id: ATT(1), name: 'notes.txt' }]);
  assert.deepEqual(rows(h).map((r) => [r.querySelector('.artifact-file-preview-gutter').textContent, r.querySelector('code').textContent]),
    [['1', 'alpha'], ['2', 'beta'], ['3', 'gamma']]);
});

const segment = (h, value) => globalThis.inventory.segmentedControl.select(h.view.q('[data-inv-segmented="team-preview-view"]'), value);
const act = (h, name) => h.view.q(`.team-preview [data-team-preview-action="${name}"]`);
const noteText = (h) => (h.view.q('.team-preview__note') || { textContent: null }).textContent;
const stateText = (h) => h.view.q('.team-preview__state').textContent;

test('a Markdown file shows Rendered first, Source as the code list; markup in it is never an element', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('# Title\n\nsome **bold**\n\n<script>window.pwned = 1</script>\n\n<img src=x onerror="window.pwned = 2">') });
  ask(h, file(1, 'plan.md', 'text/markdown'));
  await flush();
  assert.equal(h.view.q('.team-preview__md.chat-bubble-markdown h1').textContent, 'Title');
  assert.ok(h.view.q('.team-preview__md strong'));
  assert.equal(h.view.qa('.team-preview__body script, .team-preview__body img, .team-preview__body [onerror]').length, 0);
  assert.equal(h.view.qa('.team-preview__acts [role="radio"]').map((r) => r.textContent).join(), 'Rendered,Source');
  assert.equal(rows(h).length, 0);
  segment(h, 'source');
  assert.equal(h.view.q('.team-preview__md'), null);
  assert.equal(rows(h)[0].querySelector('code').textContent, '# Title');
  segment(h, 'rendered');
  assert.ok(h.view.q('.team-preview__md h1'));
  assert.equal(h.sent('chatAttachmentText').length, 1, 'switching the view asks for nothing');
});

test('Markdown over 150 KB shows as source with a note, not rendered', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('# Big\n' + 'word '.repeat(32_000)) });
  ask(h, file(1, 'big.md', 'text/markdown'));
  await flush();
  assert.equal(h.view.q('.team-preview__md'), null);
  assert.equal(rows(h)[0].querySelector('code').textContent, '# Big');
  assert.match(h.view.q('.team-preview__note').textContent, /too long to show rendered/);
});

test('an .html or .svg file is source text only: no iframe, no drawn svg, no element from it', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('<svg onload="x()"><circle r="1"/></svg>\n<iframe src="https://x.invalid"></iframe>') });
  for (const [n, name, mime] of [[1, 'pic.svg', 'image/svg+xml'], [2, 'page.html', 'text/html']]) {
    ask(h, file(n, name, mime));
    await flush();
    assert.equal(h.view.qa('.team-preview__body iframe, .team-preview__body svg, .team-preview__body circle').length, 0, name);
    assert.equal(h.view.q('.team-preview__acts .inv-segmented'), null, 'no Rendered switch for ' + name);
    assert.equal(rows(h)[0].querySelector('code').textContent, '<svg onload="x()"><circle r="1"/></svg>');
  }
});

test('truncated text shows the note; 2,500 lines draw 2,000 rows and the note', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('a\nb', { truncated: true, total_bytes: 900 * 1024 }) });
  ask(h, file(1, 'big.log'));
  await flush();
  assert.equal(noteText(h), 'Showing the first 512 KB of 900 KB. Download it for the whole file.');
  assert.equal(rows(h).length, 2);
  const many = await opened(t, { chatAttachmentText: text(lines(2500), { truncated: true, total_bytes: 600 * 1024 }) });
  ask(many, file(2, 'many.log'));
  await flush();
  assert.equal(rows(many).length, 2000);
  assert.equal(rows(many)[1999].querySelector('.artifact-file-preview-gutter').textContent, '2000');
  assert.equal(noteText(many), 'Showing the first 2,000 lines (512 KB) of 600 KB. Download it for the whole file.');
  const short = await opened(t, { chatAttachmentText: text(lines(2500)) });
  ask(short, file(3, 'short.log'));
  await flush();
  assert.equal(rows(short).length, 2000);
  assert.match(noteText(short), /^Showing the first 2,000 lines of \d+ KB\. Download it for the whole file\.$/u);
  const whole = await opened(t, {});
  ask(whole, file(4, 'whole.txt'));
  await flush();
  assert.equal(noteText(whole), null, 'a whole file has no note');
});

test('refusals: not text, gone, and a failure whose Try again asks once more', async (t) => {
  let n = 0;
  const h = await opened(t, { chatAttachmentText: () => { n += 1; return n === 1 ? refused('team_request_timeout') : text('fine'); } });
  ask(h, file(1, 'a.txt'));
  await flush();
  assert.ok(act(h, 'retry'), 'a failure offers Try again');
  assert.ok(stateText(h).length > 'Try again'.length, 'and says why');
  act(h, 'retry').click();
  await flush();
  assert.equal(h.sent('chatAttachmentText').length, 2, 'Try again re-calls once');
  assert.equal(rows(h)[0].querySelector('code').textContent, 'fine');
  const bin = await opened(t, { chatAttachmentText: refused('team_attachment_not_text') });
  ask(bin, file(2, 'pack.bin', 'application/octet-stream'));
  await flush();
  assert.equal(bin.view.q('.team-preview__state b').textContent, 'Jenny can show text and code files here.');
  assert.match(stateText(bin), /This one is not text\. Download it to open it in another app\./u);
  assert.ok(act(bin, 'download'));
  const gone = await opened(t, { chatAttachmentText: refused('team_chat_not_found') });
  ask(gone, file(3, 'old.txt'));
  await flush();
  assert.equal(stateText(gone), 'No longer on the team server.Whoever shared it may have deleted the message.');
});

test('offline at open shows the offline words and makes no call; back online, Try again loads it', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('hello') });
  h.listeners.state({ teams: [memberTeam({ state: 'offline', since: 5 })] });
  await flush();
  ask(h, file(1, 'a.txt'));
  await flush();
  assert.equal(h.view.q('.team-preview__state b').textContent, 'This file needs the team online.');
  assert.equal(h.sent('chatAttachmentText').length, 0);
  h.listeners.state({ teams: [memberTeam()] });
  await flush();
  h.view.q('[data-team-preview-action="retry"]').click();
  await flush();
  assert.equal(h.sent('chatAttachmentText').length, 1);
  assert.equal(rows(h)[0].querySelector('code').textContent, 'hello');
});

test('the head names the file, its type, size and who shared it; the name is text', async (t) => {
  const h = await opened(t, {});
  ask(h, file(1, '<b>x.txt', 'text/plain', 3 * 1024), { authorName: 'Dot <i>' });
  await flush();
  assert.equal(h.view.q('.team-preview__name').textContent, '_b_x.txt');
  assert.equal(h.view.q('.team-preview__name').getAttribute('dir'), 'auto');
  assert.match(h.view.q('.team-preview__meta').textContent, /^Text · 3 KB · shared by Dot <i>, /u);
  assert.equal(h.view.qa('.team-preview__head b, .team-preview__head i').length, 0);
  ask(h, file(2, 'mine.txt'), { own: true });
  await flush();
  assert.match(h.view.q('.team-preview__meta').textContent, /shared by you, /u);
  assert.equal(h.view.q('.team-preview__back'), null, 'no thread, no Back');
});

test('Esc and Close close it, remove data-preview and give the focus back to the opener', async (t) => {
  const h = await opened(t, {});
  const opener = h.view.q('.team-msg');
  opener.focus();
  ask(h, file(1, 'a.txt'), { from: opener });
  await flush();
  assert.equal(h.window.document.activeElement, act(h, 'close'), 'the focus goes to Close');
  const composing = key(h, act(h, 'close'), 'Escape', { isComposing: true });
  assert.equal(composing.defaultPrevented, false, 'an IME\'s Esc is not ours');
  assert.equal(shellOf(h).dataset.preview, 'side');
  assert.equal(key(h, act(h, 'close'), 'Escape').defaultPrevented, true);
  assert.equal(shellOf(h).dataset.preview, undefined);
  assert.equal(column(h).hidden, true);
  assert.equal(h.window.document.activeElement, opener);
  ask(h, file(1, 'a.txt'), { from: opener });
  await flush();
  act(h, 'close').click();
  assert.equal(shellOf(h).dataset.preview, undefined);
  assert.equal(h.window.document.activeElement, opener);
});

test('with a thread open: it is hidden, Back/Close/Esc show the same thread; opening a thread closes the preview', async (t) => {
  const chat = await openThreadChat({ answers: { chatAttachmentText: text('x') } });
  t.after(() => { chat.h.restore(); preview.disposeAll(); });
  const h = chat.h;
  await openThreadFrom(h);
  const thread = threadOf(h);
  assert.ok(thread);
  ask(h, file(1, 'a.txt'), { from: thread.querySelector('.team-msg') });
  await flush();
  assert.equal(thread.hidden, true);
  assert.equal(threadOf(h), thread, 'the thread is covered, not replaced');
  assert.equal(shellOf(h).dataset.screen, 'preview');
  assert.ok(h.view.q('.team-preview__back'), 'Back is shown');
  for (const how of ['back', 'close', 'esc']) {
    if (how === 'esc') key(h, act(h, 'close'), 'Escape'); else act(h, how).click();
    assert.equal(thread.hidden, false, how);
    assert.equal(threadOf(h), thread, how);
    assert.equal(shellOf(h).dataset.screen, 'thread', how);
    assert.equal(shellOf(h).dataset.preview, undefined, how);
    ask(h, file(1, 'a.txt'), { from: thread.querySelector('.team-msg') });
    await flush();
    assert.equal(thread.hidden, true, how + ' again');
  }
  await openThreadFrom(h);
  assert.equal(shellOf(h).dataset.preview, undefined, 'opening a thread closes the preview first');
  assert.equal(column(h).hidden, true);
  assert.equal(threadOf(h).hidden, false);
});

test('a second file asked while the first answer is pending is the only one shown when both arrive', async (t) => {
  const gate = heldAnswers();
  const h = await opened(t, { chatAttachmentText: gate.answer });
  ask(h, file(1, 'first.txt'));
  await flush();
  ask(h, file(2, 'second.txt'));
  await flush();
  assert.equal(h.view.q('.team-preview__state b').textContent, 'Loading second.txt…');
  gate.release(text('FIRST'));
  await flush();
  assert.equal(h.view.q('.team-preview__state b').textContent, 'Loading second.txt…', 'the older answer paints nothing');
  gate.release(text('SECOND'));
  await flush();
  assert.equal(names(h), 'second.txt');
  assert.deepEqual(rows(h).map((r) => r.querySelector('code').textContent), ['SECOND']);
});

test('a channel switch closes it', async (t) => {
  const DM = 'chan_dm_' + 'a'.repeat(64);
  const dm = chatChannel({ channel_id: DM, kind: 'dm', participants: [DOT, ME].sort() });
  const h = await opened(t, { chatOverview: overview({ channels: [chatChannel(), dm] }) });
  ask(h, file(1, 'a.txt'));
  await flush();
  assert.equal(shellOf(h).dataset.preview, 'side');
  h.view.q(`[data-team-channel="${DM}"]`).click();
  await flush();
  assert.equal(h.view.q('aside.team-preview'), null, 'the frame was rebuilt without it');
  assert.equal(shellOf(h).dataset.preview, undefined);
  assert.equal(shellOf(h).dataset.screen, 'channel');
});

test('forgetTeam empties the cache so a reopen asks again', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('cached') });
  ask(h, file(1, 'a.txt'));
  await flush();
  ask(h, file(1, 'a.txt'));
  await flush();
  assert.equal(h.sent('chatAttachmentText').length, 1, 'the second open is from the cache');
  preview.forgetTeam(OTHER);
  ask(h, file(1, 'a.txt'));
  await flush();
  assert.equal(h.sent('chatAttachmentText').length, 2, 'forgotten, so asked again');
});

test('Download calls chatAttachmentSave with the attachment\'s name; Copy text writes the text', async (t) => {
  const h = await opened(t, { chatAttachmentText: text('copy me'), chatAttachmentSave: { ok: true, saved: false } });
  ask(h, file(1, 'report.txt'));
  await flush();
  act(h, 'download').click();
  await flush();
  assert.deepEqual(h.sent('chatAttachmentSave').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, attachment_id: ATT(1), name: 'report.txt' }]);
  assert.equal(h.view.q('.team-copied'), null, 'a cancelled dialog says nothing');
  act(h, 'copy').click();
  await flush();
  assert.deepEqual(h.copied, ['copy me']);
  assert.equal(h.view.q('.team-copied').textContent, 'Copied');
});

// Row 175 round 2 (D13): the column also shows a project's files (renderer-team-project-file-pane.js); an attachment asked
// for after them replaces them, and a malformed project ask opens nothing.
test('a project-files ask shows the tree in the column; an attachment after it replaces it; a bad project id opens nothing', async (t) => {
  const project = 'project_' + 'a'.repeat(12);
  const h = await opened(t, { projectFiles: { ok: true, entries: [{ path: 'a.txt', size: 3, kind: 'file' }], next_cursor: null, total: 1, capped: false } });
  const from = h.view.q('.team-msg');
  from.dispatchEvent(new h.window.CustomEvent('team:file-preview', { bubbles: true, detail: { kind: 'project-files', teamId: OTHER, projectId: 'nope' } }));
  await flush();
  assert.equal(column(h), null, 'nothing opened for a bad id');
  from.dispatchEvent(new h.window.CustomEvent('team:file-preview', { bubbles: true, detail: { kind: 'project-files', teamId: OTHER, projectId: project, projectName: 'Site' } }));
  await flush();
  assert.equal(column(h).getAttribute('aria-label'), 'Files in Site');
  assert.deepEqual(h.view.qa('.team-ftree__row').map((el) => el.dataset.ftreePath), ['a.txt']);
  ask(h, file(1, 'notes.txt'));
  await flush();
  assert.equal(h.view.q('.team-ftree'), null);
  assert.equal(names(h), 'notes.txt');
});
