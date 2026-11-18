'use strict';

// new-test-file: the team export is a new surface (row 123, slice 2a-6c): paging history and threads, the one
// document sent to main and the Markdown and JSON main builds from it (services/team-export-format.js), one export
// at a time, and Cancel, a cancelled dialog, the team going offline, a refusal and a failed save each leaving no
// file. The module over a fake bridge call and save dialog.

const test = require('node:test');
const assert = require('node:assert/strict');

const exportModule = require('../renderer/team/renderer-team-export');
const format = require('../services/team-export-format');

const TEAM = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const ME = 'member_me';
const MAYA = 'member_maya';
const DOT = 'member_dot';
const DM = 'chan_dm_' + 'c'.repeat(64);
const TOP = Number.MAX_SAFE_INTEGER;
const id = (seq) => 'msg_' + String(seq).padStart(26, '0');
const at = (day, hh, mm) => new Date(Date.UTC(2026, 10, day, hh, mm)).toISOString();
const msg = (seq, author, created, text, over = {}) => ({ id: id(seq), channel_id: 'chan_team', seq, rev: 1, author: { kind: 'member', member_id: author }, created_at: created,
  edited_at: null, text, thread_root_id: null, reply_count: 0, mentions: [], deleted: null, ...over });
const MEMBERS = [{ member_id: ME, display_name: 'Brendan' }, { member_id: MAYA, display_name: 'Maya' }, { member_id: DOT, display_name: 'Dot' }];
const team = (state = 'online') => ({ team_id: TEAM, team_name: 'Brendan’s team', state, member_id: ME, display_name: 'Brendan', device_id: 'device_desk' });
// What main writes from the one document, as services/save-file-handler.js builds it.
const built = (save) => { const doc = format.readDocument(save.document); return { doc, markdown: format.buildMarkdown(doc, { timeZone: 'UTC' }), json: format.buildJson(doc) }; };

// #team: 5 messages over two pages (one deleted with no replies, one with a thread of two replies over two pages, one edited); a direct conversation.
function fakeBridge({ state = { team: team() } } = {}) {
  const calls = [];
  const newest = [msg(3, MAYA, at(11, 16, 58), 'Linux gate is green.'), msg(4, DOT, at(11, 17, 0), 'gone', { deleted: { by: DOT, at: 'x' } }),
    msg(5, MAYA, at(12, 9, 31), `<@${ME}> can you look before lunch?`, { edited_at: at(12, 9, 40), mentions: [ME] })];
  const older = [msg(1, MAYA, at(11, 16, 41), 'Reducer fix is up.', { reply_count: 2 }), msg(2, ME, at(11, 16, 50), 'Looking now.')];
  const answers = {
    chatOverview: () => ({ ok: true, channels: [{ channel_id: DM, kind: 'dm', participants: [ME, MAYA] }, { channel_id: 'chan_team', kind: 'team' }], members: MEMBERS }),
    chatHistory: (p) => (p.channel_id === DM ? { ok: true, messages: [msg(1, MAYA, at(12, 10, 0), 'Around this afternoon?', { channel_id: DM })], has_more: false }
      : p.before_seq === TOP ? { ok: true, messages: newest, has_more: true } : { ok: true, messages: older, has_more: false }),
    chatThread: (p) => (p.after_seq === 0
      ? { ok: true, root: older[0], replies: [msg(6, MAYA, at(11, 17, 5), 'Which test?\nThe resume one.', { thread_root_id: id(1) })], has_more: true }
      : { ok: true, root: older[0], replies: [msg(7, DOT, at(11, 17, 9), 'That one.', { thread_root_id: id(1) }), msg(8, DOT, at(11, 17, 10), 'x', { thread_root_id: id(1), deleted: { by: DOT, at: 'x' } })], has_more: false }),
  };
  const call = async (method, payload) => { calls.push({ method, payload }); await Promise.resolve(); return answers[method](payload); };
  return { calls, call, teamOf: () => state.team, state, answers };
}

function withLocale(fn) {
  const saved = globalThis.jennyI18n;
  globalThis.jennyI18n = { tag: () => 'en-GB' };
  return Promise.resolve().then(fn).finally(() => { if (saved === undefined) delete globalThis.jennyI18n; else globalThis.jennyI18n = saved; });
}

test('one conversation: every page names a top bound, threads page on, one dialog with Markdown first and JSON second, then the done line', () => withLocale(async () => {
  const bridge = fakeBridge();
  const saves = [];
  const phases = [];
  const exporter = exportModule.createExporter({ call: bridge.call, teamOf: bridge.teamOf, now: () => Date.UTC(2026, 10, 12, 14, 5),
    saveFile: async (payload) => { saves.push(payload); return { canceled: false, path: 'C:\\Users\\b\\Documents\\team jenny.md' }; } });
  exporter.subscribe((s) => phases.push(s.phase + ':' + s.count));
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'one', channelId: 'chan_team' }), true);
  assert.deepEqual(bridge.calls.map((c) => [c.method, c.payload.before_seq ?? c.payload.after_seq ?? null]), [
    ['chatOverview', null], ['chatHistory', TOP], ['chatHistory', 3], ['chatThread', 0], ['chatThread', 6]]);
  assert.equal(bridge.calls[1].payload.limit, 100);
  const counts = phases.filter((p) => p.startsWith('gathering:')).map((p) => Number(p.split(':')[1]));
  assert.ok(counts.every((n, i) => i === 0 || n >= counts[i - 1]), 'the count never goes back: ' + counts.join(','));
  assert.deepEqual([...new Set(counts)], [0, 2, 4, 5, 6], 'the count moves per page, deleted ones left out');
  assert.ok(phases.includes('saving:6'), 'saving is said before the dialog');
  assert.equal(saves.length, 1);
  const [save] = saves;
  assert.deepEqual([save.format, save.contents, save.document.kind], ['markdown', undefined, 'team-export'], 'one document, built in main');
  assert.deepEqual(save.filters, [{ name: 'Markdown, to read', extensions: ['md'] }, { name: 'JSON, for other tools', extensions: ['json'] }]);
  assert.match(save.defaultName, /^Brendan’s team team 2026-11-1\d\.md$/);
  const s = exporter.state();
  assert.deepEqual([s.phase, s.count, s.label, s.path, 'reason' in s], ['done', 6, '#team', 'C:\\Users\\b\\Documents\\team jenny.md', false]);
  assert.equal(exportModule.lineText(s), 'Exported 6 messages from #team to C:\\Users\\b\\Documents\\team jenny.md');
  const { json, markdown } = built(save);
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), ['team', 'exported_at', 'exported_by', 'conversations']);
  assert.deepEqual([parsed.team, parsed.exported_by, parsed.exported_at], ['Brendan’s team', 'Brendan', '2026-11-12T14:05:00.000Z']);
  const [conversation] = parsed.conversations;
  assert.deepEqual([conversation.name, conversation.kind], ['#team', 'channel']);
  assert.deepEqual(conversation.messages.map((m) => [m.id, m.sender, m.edited, m.replies.length]), [[id(1), 'Maya', false, 2], [id(2), 'Brendan', false, 0], [id(3), 'Maya', false, 0], [id(5), 'Maya', true, 0]]);
  assert.deepEqual(Object.keys(conversation.messages[0]), ['id', 'sender', 'sent_at', 'edited', 'text', 'replies']);
  assert.deepEqual(Object.keys(conversation.messages[0].replies[0]), ['id', 'sender', 'sent_at', 'edited', 'text']);
  assert.equal(conversation.messages[3].text, '@Brendan can you look before lunch?');
  for (const file of [JSON.stringify(save.document), json, markdown]) {
    for (const secret of [ME, MAYA, DOT, 'device_', 'jteam1_', 'gone']) assert.equal(file.includes(secret), false, secret);
  }
}));

test('the Markdown file is the approved screen: heading, facts line, a heading per day, replies quoted under their message', () => {
  const doc = format.readDocument({ kind: 'team-export', team: 'Brendan’s team', exportedAt: Date.UTC(2026, 10, 12, 14, 5), exportedBy: 'Brendan', locale: 'en-GB',
    words: { edited: ' (edited)', facts: '{team} · exported {when} by {you} · {count} messages', deleted: 'Message deleted by {name}' },
    conversations: [{ name: '#jenny', kind: 'channel', messages: [
      { id: 'a', sender: 'Maya', sent_at: at(11, 16, 41), edited: false, text: 'Reducer fix is up.', replies: [
        { id: 'b', sender: 'Maya', sent_at: at(11, 17, 5), edited: false, text: 'Which test?\nThe resume one.' }, { id: 'c', sender: 'Dot', sent_at: at(11, 17, 9), edited: false, text: 'That one.' }] },
      { id: 'd', sender: 'Maya', sent_at: at(12, 9, 31), edited: true, text: '@Brendan can you look?', replies: [] }] }] });
  assert.equal(format.buildMarkdown(doc, { timeZone: 'UTC' }), [
    '# #jenny', '', 'Brendan’s team · exported 12 Nov 2026 14:05 by Brendan · 4 messages', '', '## 11 November 2026', '', '**Maya** 16:41', 'Reducer fix is up.', '',
    '> **Maya** 17:05', '> Which test?', '> The resume one.', '>', '> **Dot** 17:09', '> That one.', '', '## 12 November 2026', '', '**Maya** 09:31 (edited)', '@Brendan can you look?', ''].join('\n'));
  assert.equal(withLocale(() => exportModule.fileName('Dot’s team: "lab"', 'jenny', new Date(Date.UTC(2026, 10, 12)), 'UTC')) instanceof Promise, true);
  assert.equal(exportModule.fileName('Dot’s team: "lab"', 'jenny', new Date(Date.UTC(2026, 10, 12)), 'UTC'), 'Dot’s team lab jenny 2026-11-12.md');
});

test('every conversation: one file, #team first, then the direct conversations by name, and the running line counts them', () => withLocale(async () => {
  const bridge = fakeBridge();
  const lines = [];
  let saved = null;
  const exporter = exportModule.createExporter({ call: bridge.call, teamOf: bridge.teamOf, saveFile: async (p) => { saved = p; return { canceled: false, path: 'D:\\x.json' }; } });
  exporter.subscribe((s) => lines.push(exportModule.lineText(s)));
  await exporter.start({ teamId: TEAM, scope: 'all' });
  assert.ok(lines.includes('Exporting: 1 of 2 conversations done, 6 messages so far'), lines.join('\n'));
  assert.deepEqual(JSON.parse(built(saved).json).conversations.map((c) => [c.name, c.kind]), [['#team', 'channel'], ['Maya', 'direct']]);
  assert.match(saved.defaultName, /^Brendan’s team 2026-11-1\d\.md$/);
  assert.equal(exportModule.lineText(exporter.state()), 'Exported 7 messages from 2 conversations to D:\\x.json');
}));

test('Cancel before and during paging, Cancel in the dialog, the team going offline, a refusal and a failed save each save nothing', async () => {
  let bridge = fakeBridge();
  const saves = [];
  const saveFile = async (p) => { saves.push(p); return { canceled: false, path: 'x' }; };
  let exporter = exportModule.createExporter({ call: bridge.call, teamOf: bridge.teamOf, saveFile });
  const running = exporter.start({ teamId: TEAM, scope: 'all' });
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'one', channelId: 'chan_team' }), false, 'one export at a time');
  assert.equal(exporter.running(), true);
  exporter.cancel();
  assert.equal(await running, false);
  assert.deepEqual([exporter.state().phase, saves.length], ['idle', 0]);
  // Cancel in the middle of paging: after the first history page, before the second.
  bridge = fakeBridge();
  exporter = exportModule.createExporter({ call: async (m, p) => { const answer = await bridge.call(m, p); if (m === 'chatHistory' && p.before_seq === TOP) exporter.cancel(); return answer; }, teamOf: bridge.teamOf, saveFile });
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'one', channelId: 'chan_team' }), false);
  assert.deepEqual([bridge.calls.map((c) => c.method), exporter.state().phase, saves.length], [['chatOverview', 'chatHistory'], 'idle', 0], 'no further page is asked');
  // The team goes offline part way: stopped, Try again, nothing saved.
  bridge = fakeBridge();
  let flipped = false;
  const call = async (method, payload) => { const answer = await bridge.call(method, payload); if (method === 'chatThread' && !flipped) { flipped = true; bridge.state.team = team('offline'); } return answer; };
  exporter = exportModule.createExporter({ call, teamOf: bridge.teamOf, saveFile });
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'one', channelId: 'chan_team' }), false);
  assert.equal(exportModule.lineText(exporter.state()), 'The export stopped: Brendan’s team went offline. Nothing was saved.');
  assert.equal(saves.length, 0);
  bridge.state.team = team();
  assert.equal(await exporter.retry(), true, 'Try again runs the same export');
  assert.equal(saves.length, 1);
  // A refusal that is not about being offline: failed, the app's sentence.
  bridge = fakeBridge();
  bridge.answers.chatThread = () => ({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_chat_not_found' } });
  exporter = exportModule.createExporter({ call: bridge.call, teamOf: bridge.teamOf, saveFile });
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'all' }), false);
  assert.deepEqual([exporter.state().phase, exportModule.lineText(exporter.state()), saves.length], ['failed', 'Export failed. Try again.', 1]);
  // Cancel in the dialog: the line closes, nothing is written (main writes only on a picked path).
  exporter = exportModule.createExporter({ call: fakeBridge().call, teamOf: () => team(), saveFile: async () => ({ canceled: true, path: '' }) });
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'all' }), false);
  assert.equal(exporter.state().phase, 'idle');
  // A failed save (main's refusal past its bound lands here too): the app's sentence.
  exporter = exportModule.createExporter({ call: fakeBridge().call, teamOf: () => team(), saveFile: async () => { throw new Error('The export is too large to write.'); } });
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'all' }), false);
  assert.equal(exportModule.lineText(exporter.state()), 'Export failed. Try again.');
});

test('the team menu entry: Export with its two choices, greyed out offline with the reason and while one runs', () => {
  const picked = [];
  const [separator, entry] = exportModule.menuItems({ team: team(), channelId: 'chan_team', onPick: (scope, channelId) => picked.push([scope, channelId]) });
  assert.equal(separator.separator, true);
  assert.deepEqual([entry.label, entry.disabled, entry.description], ['Export', false, '']);
  assert.deepEqual(entry.items.map((i) => i.label), ['This conversation…', 'Every conversation…']);
  entry.items.forEach((i) => i.action());
  assert.deepEqual(picked, [['one', 'chan_team'], ['all', '']]);
  const offline = exportModule.menuItems({ team: team('offline'), channelId: 'chan_team', onPick: () => {} })[1];
  assert.deepEqual([offline.disabled, offline.description], [true, 'Needs the team online']);
  assert.equal(exportModule.menuItems({ team: team(), channelId: 'new', onPick: () => {} })[1].items[0].disabled, true, 'the New message view is not a conversation');
});

// Fix list items 4 and 9 (2a-6c review).
const words = { edited: ' (edited)', facts: '{team} · exported {when} by {you} · {count} messages', deleted: 'Message deleted by {name}' };

test('item 4: a message or a name cannot pass for a day heading, another sender or a quoted reply', () => {
  const doc = format.readDocument({ kind: 'team-export', team: 'T', exportedAt: Date.UTC(2026, 10, 12, 14, 5), exportedBy: 'B', locale: 'en-GB', words, conversations: [{ name: '#jenny', kind: 'channel', messages: [
    { id: 'a', sender: 'Mal**lory**\n## x', sent_at: at(11, 9, 0), edited: false, text: '## 1 January 2020\n**Alice** 10:15\n# heading\n> **Bob** 10:20\nplain', replies: [
      { id: 'b', sender: 'Eve', sent_at: at(11, 9, 1), edited: false, text: '**Alice** 10:16\n## 2 January 2020' }] }] }] });
  const lines = format.buildMarkdown(doc, { timeZone: 'UTC' }).split('\n');
  assert.deepEqual(lines.filter((l) => /^#{1,6} /.test(l)), ['# #jenny', '## 11 November 2026'], 'only the real headings');
  assert.deepEqual(lines.filter((l) => /^(> )?\*\*/.test(l)), ['**Mal\\*\\*lory\\*\\* \\#\\# x** 09:00', '> **Eve** 09:01'], 'only the real sender lines');
  for (const line of ['\\## 1 January 2020', '\\**Alice** 10:15', '\\# heading', '\\> **Bob** 10:20', 'plain', '> \\**Alice** 10:16', '> \\## 2 January 2020']) assert.ok(lines.includes(line), line);
  assert.equal(JSON.parse(format.buildJson(doc)).conversations[0].messages[0].text, '## 1 January 2020\n**Alice** 10:15\n# heading\n> **Bob** 10:20\nplain', 'the JSON keeps the text as written');
});

test('item 9: a deleted message with replies is one line in the app\'s words, its replies under it, its text never written', () => withLocale(async () => {
  const answers = {
    chatOverview: () => ({ ok: true, channels: [{ channel_id: 'chan_team', kind: 'team' }], members: MEMBERS }),
    chatHistory: () => ({ ok: true, messages: [msg(1, MAYA, at(11, 9, 0), 'secret words', { deleted: { by: DOT, at: 'x' }, reply_count: 1 }), msg(3, ME, at(11, 9, 5), 'later'),
      msg(4, MAYA, at(11, 9, 6), 'also secret', { deleted: { by: MAYA, at: 'x' } })], has_more: false }),
    chatThread: () => ({ ok: true, replies: [msg(2, DOT, at(11, 9, 1), 'still here', { thread_root_id: id(1) })], has_more: false }),
  };
  let saved = null;
  const exporter = exportModule.createExporter({ call: async (m, p) => answers[m](p), teamOf: () => team(), saveFile: async (p) => { saved = p; return { canceled: false, path: 'x.md' }; } });
  await exporter.start({ teamId: TEAM, scope: 'all' });
  const { markdown, json } = built(saved);
  for (const file of [JSON.stringify(saved.document), markdown, json]) assert.equal(/secret/.test(file), false, 'a deleted message\'s text is never sent or written');
  assert.match(markdown, /\nMessage deleted by Dot\n\n> \*\*Dot\*\* 09:01\n> still here\n/);
  assert.equal(exporter.state().count, 2, 'a deleted message is not counted');
  const messages = JSON.parse(json).conversations[0].messages;
  assert.deepEqual(messages.map((m) => [m.id, m.deleted === true, m.text, m.replies.length]), [[id(1), true, '', 1], [id(3), false, 'later', 0]], 'a deleted one without replies is left out');
}));

// Row 175 item 8 (D15): "This conversation…" of an open project conversation.
test("a project conversation: prompts under their askers and Jenny's last words only, oldest first, paged back by before_message_id; no reasoning or tool row; the same status words", () => withLocale(async () => {
  const host = (mid, role, content, turn, over = {}) => ({ id: mid, role, content, status: 'complete', turn_id: turn, timestamp: at(12, 9, 30), ...over });
  const asked = (mid, content, turn, by, minute) => host(mid, 'user', content, turn, { author: { kind: 'member', member_id: by }, timestamp: at(12, 9, minute) });
  const newest = { ok: true, snapshot: { session: { session_id: 'sess_1', title: 'Hero lines' }, has_more: true, next_before_message_id: 'u2',
    messages: [asked('u2', 'Warmer, please', 't2', MAYA, 5), host('r2', 'assistant', 'read_file', 't2', { kind: 'tool_use', tool_call: { call_id: 'c1', tool_name: 'read_file', input_json: '{}' } }),
      host('x2', 'tool', '', 't2', { kind: 'tool_result', tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: 'TOOL OUTPUT' } }),
      host('a2', 'assistant', 'Come in, we are warm.', 't2', { timestamp: at(12, 9, 6), reasoning: { source: 'p', entries: [{ id: 'e', text: 'PRIVATE THOUGHT' }] } })] } };
  const older = { ok: true, snapshot: { session: { session_id: 'sess_1', title: 'Hero lines' }, has_more: false,
    messages: [asked('u1', 'Give me a hero line', 't1', ME, 1), host('a1', 'assistant', 'Less to click.', 't1', { timestamp: at(12, 9, 2) })] } };
  const bridge = fakeBridge();
  bridge.answers.conversationOpen = (p) => (p.before_message_id ? older : newest);
  const saves = [];
  const exporter = exportModule.createExporter({ call: bridge.call, teamOf: bridge.teamOf, now: () => Date.UTC(2026, 10, 12, 14, 5), saveFile: async (payload) => { saves.push(payload); return { canceled: false, path: 'C:\\x\\Hero lines.md' }; } });
  assert.equal(await exporter.start({ teamId: TEAM, scope: 'one', channelId: 'conv:sess_1' }), true);
  assert.deepEqual(bridge.calls.map((c) => [c.method, c.payload.before_message_id || null, c.payload.session_id || null]), [['chatOverview', null, null], ['conversationOpen', null, 'sess_1'], ['conversationOpen', 'u2', 'sess_1']]);
  const { markdown } = built(saves[0]);
  assert.ok(markdown.startsWith('# Hero lines\n'));
  assert.deepEqual(markdown.split('\n').filter((l) => l.startsWith('**')), ['**Brendan** 09:01', '**Jenny** 09:02', '**Maya** 09:05', '**Jenny** 09:06']);
  assert.ok(markdown.includes('**Brendan** 09:01\nGive me a hero line\n\n**Jenny** 09:02\nLess to click.\n'));
  for (const never of ['PRIVATE THOUGHT', 'TOOL OUTPUT', 'read_file']) assert.equal(markdown.includes(never) || JSON.stringify(saves[0].document).includes(never), false, never);
  const s = exporter.state();
  assert.deepEqual([s.phase, s.count, s.label], ['done', 4, 'Hero lines']);
  assert.equal(exportModule.lineText(s), 'Exported 4 messages from Hero lines to C:\\x\\Hero lines.md');
  assert.match(saves[0].defaultName, /^Brendan’s team Hero lines 2026-11-12\.md$/);
  const items = (id) => exportModule.menuItems({ team: team(), channelId: id, onPick: () => {} })[1].items[0];
  assert.deepEqual([items('conv:sess_1').disabled, items('proj:p1').disabled], [false, true], 'a conversation page exports; a project page does not');
}));
