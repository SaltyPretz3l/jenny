'use strict';

// new-test-file: renderer-team-attach.js and renderer-team-files.js are new modules (row 123, slice 2c renderer), and
// TEAM_CHAT_SPEC.md names this file for them; renderer-team-composer.test.js is at 588 lines of its 600.
// Files in the Team tab: the paperclip, paste and drop; the chips and their states; the upload queue; the Send
// rules; pictures and file lines in a message, their states, Download and the viewer request; untrusted names;
// the flag-off teardown. Real modules over the harness bridge (owner picks 2026-11-13). The 2c fix list's cases (the
// cache bound, near-viewport fetches, no rebuilds, teardown on leave, revoke and Force local) are in
// renderer-team-pictures.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OTHER, ME, CHAN, flush, memberTeam, message, msgId, openChat, heldAnswers, type, key, openThreadChat, openThreadFrom, threadOf,
  harness, shell } = require('./helpers/team-settings-harness');

const MiB = 1024 * 1024;
const ATT = (n) => 'att_' + String(n).padStart(26, '0');
const DATA = 'data:image/png;base64,iVBORw0KGgo=';
const fake = (name, size = 2048, type = 'application/pdf') => ({ name, type, size, arrayBuffer: async () => new ArrayBuffer(4) });
const item = (n, name, size = 2048, mime = 'application/pdf', kind = 'file') => ({ id: ATT(n), name, mime, size_bytes: size, kind });
let ids = 0;
const uploaded = (p) => ({ ok: true, attachment: { id: ATT((ids += 1)), name: p.name, mime: p.type, size_bytes: 2048, kind: 'file' } });
const refused = (reason) => ({ ok: false, error: { code: '', reason } });
// Held calls still waiting at the end are answered, so the store's call bounds (90 s) do not keep the process alive.
function held(t) {
  const gate = heldAnswers();
  // A release may start the next queued call, so answer until a round finds none waiting.
  t.after(async () => {
    for (let found = true; found;) {
      found = false;
      for (;;) { try { gate.release(refused('team_not_connected')); found = true; } catch { break; } }
      await flush();
    }
  });
  return gate;
}
const byOlive = (seq, over = {}) => message(seq, { author: { kind: 'member', member_id: ME }, ...over });

const input = (h, scope = h.view.q('[data-team-region="composer"]')) => scope.querySelector('.team-composer__input');
const hint = (h) => h.view.q('[data-team-region="composer"] .team-composer__hint').textContent;
const sendButton = (h) => h.view.q('[data-team-region="composer"] [data-team-composer="send"]');
const chips = (h, scope = h.view.q('[data-team-region="composer"]')) => [...scope.querySelectorAll('.team-staged .attachment-chip')]
  .map((chip) => [chip.querySelector('.attachment-chip-name').textContent, chip.querySelector('.attachment-chip-meta').firstChild.textContent]);
const note = (h) => h.view.q('[data-team-region="composer"] .team-staged__note');
const paste = (h, files, target = input(h)) => {
  const event = new h.window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { files };
  target.dispatchEvent(event);
  return event;
};
const drag = (h, el, kind, files = [], types = ['Files']) => {
  const event = new h.window.Event(kind, { bubbles: true, cancelable: true });
  event.dataTransfer = { types, files, dropEffect: 'none' };
  el.dispatchEvent(event);
  return event;
};
const offline = async (h) => { h.listeners.state({ teams: [memberTeam({ state: 'offline', since: 5 })] }); await flush(); };
const row = (h, seq) => h.view.q(`.team-msg[data-message-id="${msgId(seq)}"]`);
// Whether the shown team's cache holds a picture, asked through the module's own rows: a held one draws as a button.
function cached(files, id) {
  const view = files.createFiles({ teamId: OTHER, channelId: CHAN, scroll: null, ctx: () => ({ online: true }) });
  const block = view.row(message(99, { attachments: [item(Number(id.slice(4)), 'x.png', 10, 'image/png', 'image')] }), { online: true });
  view.dispose();
  return block.html.includes('data-team-file="open"');
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
function stubViewer(t) {
  const opened = [];
  const saved = globalThis.rendererImageViewerController;
  globalThis.rendererImageViewerController = { open: (arg) => { opened.push(arg); return Promise.resolve(true); } };
  t.after(() => { if (saved === undefined) delete globalThis.rendererImageViewerController; else globalThis.rendererImageViewerController = saved; });
  return opened;
}

// ------------------------------------------------------------------ the ways in (criterion 1)

test('the paperclip asks main for files and adds them; its name and tooltip; each file uploads with its own fields', async (t) => {
  const { h } = await openChat({ answers: { chatUpload: uploaded,
    chatAttachPick: { ok: true, files: [{ name: 'notes.pdf', type: 'application/pdf', size: 2048, bytes: new Uint8Array([1, 2, 3]) }], not_added: 0 } } });
  t.after(h.restore);
  const clip = h.view.q('[data-team-composer="attach"]');
  assert.equal(clip.getAttribute('aria-label'), 'Attach files');
  assert.equal(clip.title, 'Attach files (up to 8, 4 MB each)');
  assert.equal(clip.previousElementSibling.dataset.teamComposer, 'code', 'after Mention and Code');
  clip.click();
  await flush();
  assert.deepEqual(h.sent('chatAttachPick').map((c) => c.payload), [{ team_id: OTHER, room: 8 }]);
  const [call] = h.sent('chatUpload');
  assert.deepEqual({ ...call.payload, bytes: [...call.payload.bytes] }, { team_id: OTHER, channel_id: CHAN, upload_id: call.payload.upload_id, name: 'notes.pdf', type: 'application/pdf', bytes: [1, 2, 3] });
  assert.match(call.payload.upload_id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(chips(h), [['notes.pdf', 'PDF · 2 KB']]);
});

test('a paste of files adds them (a nameless picture is named by the time and its type, anything else nameless is "file"); pasted text stays text', async (t) => {
  const urls = stubUrls(t);
  const { h } = await openChat({ answers: { chatUpload: uploaded } });
  t.after(h.restore);
  assert.equal(paste(h, []).defaultPrevented, false, 'text is left to the text area');
  assert.equal(paste(h, [fake('image.png', 1000, 'image/png'), fake('', 1000, 'image/png'), fake('', 10, ''), fake('', 1000, 'image/jpeg')]).defaultPrevented, true);
  await flush();
  const names = chips(h).map(([name]) => name);
  assert.match(names[0], /^Pasted picture \d\d-\d\d\.png$/);
  assert.match(names[1], /^Pasted picture \d\d-\d\d\.png$/);
  assert.equal(names[2], 'file', 'a nameless file that is not a picture (fix list S15)');
  assert.match(names[3], /^Pasted picture \d\d-\d\d\.jpg$/, 'a JPEG is named .jpg');
  assert.equal(urls.made.length, 3, 'a picture shows its own bytes in its chip');
  assert.deepEqual([h.sent('chatUpload')[2].payload.name, h.sent('chatUpload')[2].payload.type], ['file', 'application/octet-stream'], 'no usable type sends octet-stream');
});

test('a drop anywhere over the channel shows the overlay and adds to its composer; a drag without files shows nothing', async (t) => {
  const { h } = await openChat({ answers: { chatUpload: uploaded } });
  t.after(h.restore);
  const timeline = h.view.q('.team-timeline');
  drag(h, timeline, 'dragenter', [], ['text/plain']);
  assert.equal(h.view.q('.team-drop'), null);
  drag(h, timeline, 'dragenter');
  drag(h, h.view.q('.team-scroll'), 'dragenter');
  drag(h, timeline, 'dragleave');
  const overlay = h.view.q('.team-main > .team-drop');
  assert.ok(overlay, 'counted: a leave from a child keeps it');
  assert.equal(overlay.dataset.blocked, 'false');
  assert.equal(overlay.querySelector('strong').textContent, 'Drop to attach to #team');
  assert.equal(overlay.querySelector('span').textContent, 'Up to 8 files, 4 MB each. Pictures show in the message; other files are downloaded.');
  assert.equal(drag(h, timeline, 'dragover').defaultPrevented, true);
  drag(h, timeline, 'drop', [fake('a.pdf'), fake('b.txt', 10, 'text/plain')]);
  await flush();
  assert.equal(h.view.q('.team-drop'), null);
  assert.deepEqual(chips(h), [['a.pdf', 'PDF · 2 KB'], ['b.txt', 'Text · 1 KB']]);
});

test('offline the overlay says files need the team online and a drop adds nothing; the paperclip is greyed with its reason', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  await offline(h);
  const clip = h.view.q('[data-team-composer="attach"]');
  assert.equal(clip.disabled, true);
  assert.equal(clip.title, 'Attach files. Needs the team online');
  drag(h, h.view.q('.team-timeline'), 'dragenter');
  const overlay = h.view.q('.team-drop');
  assert.equal(overlay.dataset.blocked, 'true');
  assert.equal(overlay.textContent, 'Files need the team online');
  drag(h, h.view.q('.team-timeline'), 'drop', [fake('a.pdf')]);
  paste(h, [fake('b.pdf')]);
  await flush();
  assert.deepEqual(chips(h), []);
  assert.equal(h.sent('chatUpload').length, 0);
});

test('a drop over an open thread goes to the thread composer, not the channel behind it', async (t) => {
  const { h } = await openThreadChat({ answers: { chatUpload: uploaded } });
  t.after(h.restore);
  await openThreadFrom(h);
  const aside = threadOf(h);
  drag(h, aside, 'dragenter');
  assert.ok(aside.querySelector(':scope > .team-drop'));
  assert.equal(h.view.q('.team-main > .team-drop'), null);
  drag(h, aside, 'drop', [fake('reply.pdf')]);
  await flush();
  assert.deepEqual(chips(h, aside.querySelector('[data-team-region="thread-composer"]')), [['reply.pdf', 'PDF · 2 KB']]);
  assert.deepEqual(chips(h), [], 'the channel composer has none');
});

// ------------------------------------------------------------------ chips, the queue and the limits (criteria 2, 3)

test('no more than 3 upload at once; the rest wait; × removes a file at any point and cancels its upload', async (t) => {
  const gate = held(t);
  const { h } = await openChat({ answers: { chatUpload: gate.answer } });
  t.after(h.restore);
  paste(h, ['a', 'b', 'c', 'd', 'e'].map((n) => fake(n + '.pdf')));
  await flush();
  assert.equal(gate.calls.length, 3);
  assert.deepEqual(chips(h).map(([, line]) => line), ['Uploading…', 'Uploading…', 'Uploading…', 'Waiting to upload', 'Waiting to upload'], 'no number that never moves (S12)');
  gate.release(uploaded(gate.calls[0]));
  await flush();
  assert.equal(gate.calls.length, 4, 'a slot freed starts the next');
  assert.equal(chips(h)[0][1], 'PDF · 2 KB');
  const remove = h.view.q('[data-team-composer="attach-remove"][data-team-upload="' + gate.calls[1].upload_id + '"]');
  assert.equal(remove.getAttribute('aria-label'), 'Remove b.pdf');
  assert.equal(remove.title, 'Remove b.pdf');
  remove.click();
  await flush();
  assert.deepEqual(h.sent('chatUploadCancel').map((c) => c.payload), [{ team_id: OTHER, upload_id: gate.calls[1].upload_id }]);
  assert.deepEqual(chips(h).map(([name]) => name), ['a.pdf', 'c.pdf', 'd.pdf', 'e.pdf']);
  assert.equal(h.view.q('.attachment-chip-clear'), null, 'no Clear all');
});

test('a file over 4 MiB is refused before anything is sent; a ninth is not added and the note says how many', async (t) => {
  const { h } = await openChat({ answers: { chatUpload: uploaded } });
  t.after(h.restore);
  paste(h, [fake('huge.zip', 4 * MiB + 1, 'application/zip')].concat(Array.from({ length: 9 }, (_, i) => fake(`f${i}.pdf`))));
  await flush();
  assert.equal(chips(h).length, 8);
  assert.deepEqual(chips(h)[0], ['huge.zip', 'Too large: files can be up to 4 MB.']);
  assert.equal(h.view.q('[data-team-composer="attach-retry"]'), null, 'no Retry for a size refusal');
  assert.equal(h.sent('chatUpload').some((c) => c.payload.name === 'huge.zip'), false);
  assert.equal(note(h).textContent, 'A message can carry up to 8 files. 2 were not added.');
  const clip = h.view.q('[data-team-composer="attach"]');
  assert.equal(clip.disabled, true);
  assert.equal(clip.title, 'Attach files. A message can carry up to 8 files.');
  h.view.q('[data-team-composer="attach-remove"]').click();
  paste(h, [fake('x.pdf'), fake('y.pdf')]);
  await flush();
  assert.equal(note(h).textContent, 'A message can carry up to 8 files. 1 was not added.');
});

test('the upload refusals read their approved sentences, with Retry where the table shows it (criterion 11)', async (t) => {
  const reasons = ['team_not_connected', 'team_upload_limit', 'team_chat_storage_limit', 'disk_pressure', 'display_name_invalid', 'attachment_size_limit', 'team_chat_not_found'];
  let n = 0;
  const { h } = await openChat({ answers: { chatUpload: () => refused(reasons[n++]) } });
  t.after(h.restore);
  for (const reason of reasons) { paste(h, [fake(reason + '.pdf')]); await flush(); }
  const lines = [...h.view.qa('.team-staged .attachment-chip')].map((chip) => [chip.querySelector('.attachment-chip-meta').firstChild.textContent,
    Boolean(chip.querySelector('[data-team-composer="attach-retry"]'))]);
  assert.deepEqual(lines, [
    ['Not uploaded. This Jenny is not connected to the team right now.', true],
    ['Not uploaded. You have 16 files waiting to be sent, the most there can be. Send or remove some first.', true],
    ['Not uploaded. The team’s chat storage is full. Ask the owner to make room.', true],
    ['Not uploaded. The team server is low on disk space, so nothing can be added right now.', true],
    ['Not uploaded. Jenny cannot send a file with this name. Rename it and try again.', false],
    ['Too large: files can be up to 4 MB.', false],
    ['That conversation is not available.', false],
  ]);
  assert.equal(h.view.text().includes('The team server refused this change.'), false);
  h.view.q('[data-team-composer="attach-retry"]').click();
  await flush();
  assert.equal(h.sent('chatUpload').length, reasons.length + 1, 'Retry uploads again');
});

// ------------------------------------------------------------------ Send (criteria 4, 5)

test('Send is greyed with its reason in the hint and tooltip while files upload or failed; Enter does nothing', async (t) => {
  const gate = held(t);
  const { h } = await openChat({ answers: { chatUpload: gate.answer } });
  t.after(h.restore);
  type(h, 'see attached');
  paste(h, [fake('a.pdf'), fake('b.pdf')]);
  await flush();
  assert.equal(hint(h), 'Waiting for 2 files to finish uploading');
  assert.equal(h.view.q('.team-composer__hint').dataset.tone, 'blocked');
  assert.equal(sendButton(h).disabled, true);
  assert.equal(sendButton(h).title, 'Send. Waiting for 2 files to finish uploading');
  gate.release(uploaded(gate.calls[0]));
  await flush();
  assert.equal(hint(h), 'Waiting for 1 file to finish uploading');
  gate.release(refused('team_not_connected'));
  await flush();
  assert.equal(hint(h), 'Remove or retry the files that did not upload');
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(h.sent('chatPost').length, 0);
});

test('files and no words ask for words and send nothing; with words the post carries the ids in chip order and the chips clear', async (t) => {
  const { h } = await openChat({ answers: { chatUpload: uploaded, chatPost: { ok: true, message_id: msgId(9) } } });
  t.after(h.restore);
  ids = 0;
  paste(h, [fake('first.pdf'), fake('second.pdf')]);
  await flush();
  assert.equal(hint(h), 'Add a few words to send these files');
  sendButton(h).click();
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(h.sent('chatPost').length, 0, 'the host keeps its text rule');
  type(h, 'two files');
  assert.equal(hint(h), 'Markdown · Enter to send');
  assert.equal(sendButton(h).disabled, false);
  assert.equal(sendButton(h).getAttribute('title'), 'Send (Enter)');
  key(h, input(h), 'Enter');
  await flush();
  assert.deepEqual(h.sent('chatPost').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, text: 'two files', attachment_ids: [ATT(1), ATT(2)] }]);
  assert.deepEqual(chips(h), []);
  assert.equal(input(h).value, '');
});

test('a file staged more than an hour ago is expired; a post refused not found expires the stale file instead of the generic words', async (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const gate = held(t);
  const { h } = await openChat({ answers: { chatUpload: gate.answer, chatPost: refused('team_chat_not_found') } });
  t.after(h.restore);
  paste(h, [fake('old.pdf'), fake('stale.pdf'), fake('extra.pdf')]);
  await flush();
  Date.now = () => realNow() - 3_600_000;
  gate.release(uploaded(gate.calls[0]));
  await flush();
  Date.now = () => realNow() - 56 * 60_000;
  gate.release(uploaded(gate.calls[1]));
  await flush();
  Date.now = realNow;
  // Removing a file re-arms the one expiry timer from the real clock: the hour-old file goes at once.
  h.view.q('[data-team-composer="attach-remove"][data-team-upload="' + gate.calls[2].upload_id + '"]').click();
  await flush();
  assert.deepEqual(chips(h)[0], ['old.pdf', 'Waited more than an hour, so the team server let it go. Attach it again.']);
  assert.equal(hint(h), 'Attach the expired file again, or remove it');
  h.view.q('[data-team-composer="attach-remove"]').click();
  type(h, 'here');
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(h.sent('chatPost').length, 1);
  assert.deepEqual(chips(h)[0], ['stale.pdf', 'Waited more than an hour, so the team server let it go. Attach it again.'], 'the chips come back');
  assert.equal(hint(h), 'Attach the expired file again, or remove it');
});

test('offline with files waiting Send is greyed with the offline sentence; removed, the text queues as before', async (t) => {
  const { h } = await openChat({ answers: { chatUpload: uploaded } });
  t.after(h.restore);
  paste(h, [fake('a.pdf')]);
  await flush();
  type(h, 'hello');
  await offline(h);
  assert.equal(hint(h), 'Files need the team online. Remove them to send the text now.');
  assert.equal(sendButton(h).title, 'Send. Files need the team online. Remove them to send the text now.');
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(h.sent('chatPost').length, 0, 'a message with files is never queued');
  h.view.q('[data-team-composer="attach-remove"]').click();
  await flush();
  assert.equal(hint(h), 'Sends when the host is back');
  key(h, input(h), 'Enter');
  await flush();
  assert.deepEqual(h.sent('chatPost').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, text: 'hello' }]);
});

// ------------------------------------------------------------------ files in a message (criteria 6 to 10)

test('one picture is a button with its name and size; several are drawn 140 px each; at most 3 fetch at once', async (t) => {
  const gate = held(t);
  const pics = (from, count) => Array.from({ length: count }, (_, i) => item(from + i, `p${from + i}.png`, 217088, 'image/png', 'image'));
  const { h } = await openChat({ messages: [byOlive(1, { attachments: pics(1, 1) }), byOlive(2, { attachments: pics(2, 4) })], answers: { chatAttachmentImage: gate.answer } });
  t.after(h.restore);
  assert.equal(gate.calls.length, 3);
  assert.deepEqual(gate.calls[0], { team_id: OTHER, channel_id: CHAN, attachment_id: ATT(1) });
  const loading = row(h, 2).querySelector('.team-img[data-state="loading"]');
  assert.equal(loading.getAttribute('role'), 'status');
  assert.equal(loading.textContent, 'Loading p2.png…');
  assert.equal(row(h, 1).querySelector('.team-imgs').dataset.many, 'false');
  assert.equal(row(h, 2).querySelector('.team-imgs').dataset.many, 'true');
  const scrolled = h.view.q('.team-scroll').scrollTop;
  gate.release({ ok: true, data_url: DATA });
  await flush();
  const button = row(h, 1).querySelector('button.team-img');
  assert.equal(button.getAttribute('aria-label'), 'p1.png, picture, 212 KB. Open larger');
  assert.equal(button.title, 'p1.png');
  assert.equal(button.querySelector('img').getAttribute('src'), DATA);
  assert.equal(h.view.q('.team-scroll').scrollTop, scrolled, 'the place holds');
  assert.equal(gate.calls.length, 4, 'a slot freed fetches the next');
  const files = row(h, 1).querySelector('.team-msg__body > .team-files');
  assert.ok(files.previousElementSibling.classList.contains('team-msg__text'), 'between the text and the foot');
});

test('a picture opens the image viewer on the message pictures, with its name, who, when and size', async (t) => {
  const opened = stubViewer(t);
  const { h } = await openChat({ messages: [byOlive(1, { attachments: [item(1, 'a.png', 2048, 'image/png', 'image'), item(2, 'b.webp', 3 * MiB / 2, 'image/webp', 'image')] })],
    answers: { chatAttachmentImage: { ok: true, data_url: DATA }, chatAttachmentSave: { ok: true, saved: false } } });
  t.after(h.restore);
  const second = row(h, 1).querySelectorAll('button.team-img')[1];
  second.click();
  await flush();
  assert.equal(opened.length, 1);
  const { items, index, contextNode } = opened[0];
  assert.equal(index, 1);
  assert.equal(contextNode, second, 'Esc returns focus to the picture');
  assert.deepEqual(items.map((i) => [i.kind, i.src, i.title]), [['source', DATA, 'a.png'], ['source', DATA, 'b.webp']]);
  assert.match(items[1].caption, /^From Olive Owner · .+ · 1\.5 MB$/);
  assert.equal(await items[0].actions['save-as']().then((r) => r.canceled), true, 'cancelling Save as says nothing');
  assert.deepEqual(h.sent('chatAttachmentSave').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, attachment_id: ATT(1), name: 'a.png' }]);
});

test('loading, failed, gone and offline pictures keep their frame and say why; Try again fetches again', async (t) => {
  let answer = refused('team_not_connected');
  const { h } = await openChat({ messages: [byOlive(1, { attachments: [item(1, 'f.png', 10, 'image/png', 'image'), item(2, 'g.png', 10, 'image/png', 'image')] })],
    answers: { chatAttachmentImage: (p) => (p.attachment_id === ATT(2) ? refused('team_chat_not_found') : answer) } });
  t.after(h.restore);
  const [failed, gone] = row(h, 1).querySelectorAll('.team-img');
  assert.equal(failed.dataset.state, 'failed');
  assert.match(failed.textContent, /^This picture could not be loaded\. .+Try again$/);
  assert.equal(gone.dataset.state, 'gone');
  assert.equal(gone.textContent, 'g.pngThis picture is no longer on the team server.');
  answer = { ok: true, data_url: DATA };
  failed.querySelector('[data-team-file="retry"]').click();
  await flush();
  assert.ok(row(h, 1).querySelector('button.team-img img'));
});

test('offline, a picture not fetched says it needs the team online, a fetched one stays, and Download is greyed with the reason', async (t) => {
  const gate = held(t);
  const { h } = await openChat({ messages: [byOlive(1, { attachments: [item(1, 'a.png', 10, 'image/png', 'image'), item(2, 'b.png', 10, 'image/png', 'image'), item(3, 'r.pdf')] })],
    answers: { chatAttachmentImage: gate.answer } });
  t.after(h.restore);
  gate.release({ ok: true, data_url: DATA });
  await offline(h);
  gate.release(refused('team_not_connected'));
  await flush();
  assert.ok(row(h, 1).querySelector('button.team-img img'), 'a fetched picture stays visible offline');
  const late = row(h, 1).querySelector('.team-img[data-state]');
  assert.equal(late.dataset.state, 'failed');
  const dl = row(h, 1).querySelector('[data-team-file="download"]');
  assert.equal(dl.disabled, true);
  assert.equal(dl.title, 'Download. Needs the team online');
  assert.equal(h.sent('chatAttachmentImage').length, 2);
});

test('a file is one line with its type and size; Download moves through Downloading, Saved to, Show in folder, and a failure', async (t) => {
  const gate = held(t);
  const { h } = await openChat({ messages: [byOlive(1, { attachments: [item(1, 'release-notes-1.7.1.pdf', 86016)] })], answers: { chatAttachmentSave: gate.answer } });
  t.after(h.restore);
  const line = () => row(h, 1).querySelector('.team-file');
  assert.equal(line().querySelector('.team-file__name').textContent, 'release-notes-1.7.1.pdf');
  assert.equal(line().querySelector('.team-file__name').getAttribute('dir'), 'auto');
  assert.equal(line().querySelector('.team-file__text .team-file__meta').textContent, 'PDF · 84 KB');
  const dl = line().querySelector('[data-team-file="download"]');
  assert.equal(dl.title, 'Download release-notes-1.7.1.pdf. Jenny does not check what is inside a file.');
  dl.click();
  await flush();
  assert.deepEqual(gate.calls, [{ team_id: OTHER, channel_id: CHAN, attachment_id: ATT(1), name: 'release-notes-1.7.1.pdf' }]);
  assert.equal(line().querySelector('.team-file__dl [role="status"]').textContent, 'Downloading…');
  assert.equal(line().querySelector('[data-team-file="download"]').disabled, true);
  gate.release({ ok: true, saved: true, folder: 'Documents' });
  await flush();
  assert.equal(line().querySelector('.team-file__dl [role="status"]').textContent, 'Saved to Documents');
  line().querySelector('[data-team-file="reveal"]').click();
  await flush();
  // Fix list M5: main declares this method without a channel; the harness runs every payload through main's check.
  assert.deepEqual(h.sent('chatAttachmentReveal').map((c) => c.payload), [{ team_id: OTHER, attachment_id: ATT(1) }]);
  line().querySelector('[data-team-file="download"]').click();
  await flush();
  gate.release(refused('team_download_write_failed'));
  await flush();
  assert.match(line().querySelector('.team-file__dl [data-tone="danger"]').textContent, /^Not downloaded\. /);
  line().querySelector('[data-team-file="download"]').click();
  await flush();
  gate.release({ ok: true, saved: false });
  await flush();
  assert.equal(line().querySelector('.team-file__dl [role="status"]'), null, 'cancelling the dialog says nothing');
});

test('a file the host no longer has keeps its line with the words and a greyed Download', async (t) => {
  const { h } = await openChat({ messages: [byOlive(1, { attachments: [item(1, 'gone.pdf')] })], answers: { chatAttachmentSave: refused('team_chat_not_found') } });
  t.after(h.restore);
  row(h, 1).querySelector('[data-team-file="download"]').click();
  await flush();
  const line = row(h, 1).querySelector('.team-file');
  assert.equal(line.dataset.gone, 'true');
  assert.equal(line.querySelector('.team-file__text .team-file__meta').textContent, 'No longer on the team server');
  const dl = line.querySelector('[data-team-file="download"]');
  assert.equal(dl.disabled, true);
  assert.equal(dl.title, 'Download. No longer on the team server');
});

test('an SVG, a web page, a .png the host kept as a file and a spoofed image type are never drawn (criteria 8, 15)', async (t) => {
  const attachments = [item(1, 'logo.svg', 10, 'image/svg+xml'), item(2, 'page.html', 10, 'text/html'), item(3, 'cat.png', 10, 'image/png', 'file'),
    item(4, 'trick.svg', 10, 'image/svg+xml', 'image')];
  const { h } = await openChat({ messages: [byOlive(1, { attachments })] });
  t.after(h.restore);
  assert.equal(row(h, 1).querySelector('.team-img, img'), null);
  assert.equal(h.sent('chatAttachmentImage').length, 0);
  assert.deepEqual([...row(h, 1).querySelectorAll('.team-file__text .team-file__meta')].map((el) => el.textContent),
    ['SVG image · 1 KB', 'Web page · 1 KB', 'Picture · 1 KB', 'SVG image · 1 KB']);
});

test('a deleted message shows only its tombstone', async (t) => {
  const { h } = await openChat({ messages: [byOlive(1, { attachments: [item(1, 'a.pdf')], deleted: { by: ME, at: new Date().toISOString() }, text: 'x' })] });
  t.after(h.restore);
  assert.equal(row(h, 1).querySelector('.team-files'), null);
});

test('a read-only member has nothing to attach, and opens pictures and downloads files (criterion 10)', async (t) => {
  const opened = stubViewer(t);
  const { h } = await openChat({ teams: [memberTeam({ role: 'read_only' })], messages: [byOlive(1, { attachments: [item(1, 'a.png', 10, 'image/png', 'image'), item(2, 'b.pdf')] })],
    answers: { chatAttachmentImage: { ok: true, data_url: DATA }, chatAttachmentSave: { ok: true, saved: true, folder: 'Downloads' } } });
  t.after(h.restore);
  assert.equal(h.view.q('[data-team-composer="attach"]'), null);
  assert.match(h.view.q('.team-composer--closed').textContent, /and download its files\. Ask .+ for write access to post or attach files\.$/);
  drag(h, h.view.q('.team-timeline'), 'dragenter');
  assert.equal(h.view.q('.team-drop'), null, 'no drop target');
  row(h, 1).querySelector('button.team-img').click();
  row(h, 1).querySelector('[data-team-file="download"]').click();
  await flush();
  assert.equal(opened.length, 1);
  assert.equal(h.sent('chatAttachmentSave').length, 1);
});

// ------------------------------------------------------------------ untrusted names (criterion 15)

test('an untrusted name (markup, bidi, path separators, 255 characters) is drawn as text and reaches no attribute, selector or log', async (t) => {
  const name = ('<img src=x onerror=alert(1)>‮evil/..\\' + 'n'.repeat(300)).slice(0, 255);
  const { h } = await openChat({ messages: [byOlive(1, { attachments: [item(1, name)] })], answers: { chatUpload: uploaded } });
  t.after(h.restore);
  paste(h, [fake(name)]);
  await flush();
  const line = row(h, 1).querySelector('.team-file__name');
  // Fix list S8: the row draws the name the save dialog suggests (main's saveName): no bidi or path, no markup run.
  assert.equal(line.textContent, require('../services/team/chat-attachments').saveName(name));
  assert.equal(/[\u202e/\\<>]/u.test(line.textContent), false);
  assert.equal(h.view.q('.team-chip img[src="x"], .team-msg img[src="x"], .team-staged img[src="x"]'), null);
  assert.equal(chips(h)[0][0], name);
  for (const el of h.view.qa('[data-team-upload], [data-team-att]')) {
    assert.match(el.dataset.teamUpload || el.dataset.teamAtt, /^(up[a-z0-9]+|att_[0-9A-Z]{26})$/, 'ids only in data attributes');
  }
  assert.equal(h.logged.some((line2) => line2.includes('onerror') || line2.includes('evil')), false);
});

// ------------------------------------------------------------------ bounds and teardown (criterion 16)

test('the renderer teardown leaves no waiting file, object URL, expiry timer or cached picture', async (t) => {
  const urls = stubUrls(t);
  const h = harness({ show: false, teams: [memberTeam()], answers: { chatUpload: uploaded,
    chatHistory: { ok: true, messages: [byOlive(1, { attachments: [item(1, 'a.png', 10, 'image/png', 'image')] })], has_more: false },
    chatAttachmentImage: { ok: true, data_url: DATA } } });
  t.after(h.restore);
  const s = shell(h, { activeView: 'team' });
  await flush();
  await flush();
  const attach = h.window.rendererTeamAttach;
  const files = h.window.rendererTeamFiles;
  assert.ok(attach && files, 'loaded with the Team tab');
  paste(h, [fake('p.png', 10, 'image/png'), fake('q.pdf')], h.view.q('.team-composer__input'));
  await flush();
  assert.equal(attach._state().stashes, 1);
  assert.equal(attach._state().timer, true, 'the hour is armed');
  assert.equal(cached(files, ATT(1)), true);
  s.controller.dispose();
  assert.deepEqual(attach._state(), { running: 0, queued: 0, stashes: 0, timer: false });
  assert.deepEqual(urls.revoked, urls.made);
  assert.equal(cached(files, ATT(1)), false, 'the pictures cache is empty');
});

// ------------------------------------------------------------------ styles (criteria 6, 12)

test('team-chat.css draws pictures at a fixed height and carries none of the declined forks', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'team-chat.css'), 'utf8');
  assert.match(css, /\.team-img \{[^}]*block-size: 220px;/);
  assert.match(css, /\.team-imgs\[data-many="true"\] \.team-img \{ block-size: 140px;/);
  assert.match(css, /\.team-img img \{[^}]*object-fit: contain;/);
  assert.match(css, /\.team-drop \{ position: absolute; inset: 8px;/);
  for (const declined of ['.team-imgs--grid', '.team-img__more', '.team-files__gone', '.team-staged--rows', '.team-staged__row', 'data-greyed']) {
    assert.equal(css.includes(declined), false, declined);
  }
  assert.equal(/(?:margin|padding|border)-(?:left|right)|[^-]left:|[^-]right:/.test(css.slice(css.indexOf('Slice 2c renderer'))), false, 'logical properties only');
});
