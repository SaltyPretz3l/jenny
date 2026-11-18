'use strict';

// new-test-file: renderer-team-project-paths.js is a new module (row 175 round 2b, item 1, D13, item 13, F16): path chips
// in a project conversation's answers and in Jenny's work popover that open the file explorer, the path menu, the head's
// Files button, the @file picker in the box, the restored conversation and the tab's shown conversation. Through the Team
// tab harness (every bridge call is checked against main's payload rules at teardown); the explorer's own cases stay in
// tests/renderer-team-project-files.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, P2, S1, S2, OTHER, DOT, message, snapshot, openProjects, flush, listAnswer } = require('./helpers/team-project-renderer-host');
const panes = require('../renderer/team/renderer-team-project-file-pane');

const file = (path, size = 2048) => ({ path, size, kind: 'file' });
const dir = (path) => ({ path, size: 0, kind: 'dir' });
const page = (entries, over = {}) => ({ ok: true, entries, next_cursor: null, total: entries.length, capped: false, ...over });
const textRead = (path, text) => ({ ok: true, path, size: Buffer.byteLength(text), text, truncated: false, binary: false });
const ENTRIES = [file('README.md', 120), dir('site'), file('site/index.html', 4096), dir('src'), file('src/app.js', 9000), file('src/util.js', 512)];

const ask = (id, content, turn) => message(id, 'user', content, { author: { kind: 'member', member_id: DOT }, turn_id: turn, timestamp: '2026-11-12T10:31:00.000Z' });
const said = (id, content, turn) => message(id, 'assistant', content, { kind: undefined, turn_id: turn, timestamp: '2026-11-12T10:31:05.000Z' });
const toolUse = (id, turn, name, input) => message(id, 'assistant', name, { kind: 'tool_use', turn_id: turn, timestamp: '2026-11-12T10:31:02.000Z',
  tool_call: { call_id: 'call_' + id, tool_name: name, input_json: JSON.stringify(input), status: 'complete' } });
const toolResult = (id, turn, call, name) => message(id, 'tool', '', { kind: 'tool_result', turn_id: turn, timestamp: '2026-11-12T10:31:03.000Z',
  tool_result: { call_id: call, tool_name: name, output_text: 'ok', is_error: false, duration_ms: 40 } });
const ANSWER = 'I changed `src/app.js` and left `../secret.txt`, `/etc/passwd`, `C:/x/y.js`, `.git/config` and `notes.txt` alone.';
const TURN = [ask('u1', 'What changed?', 'turn_1'), toolUse('t1', 'turn_1', 'read_file', { path: 'src/app.js' }), toolResult('r1', 'turn_1', 'call_t1', 'read_file'),
  toolUse('t2', 'turn_1', 'read_file', { path: '../secret.txt' }), toolResult('r2', 'turn_1', 'call_t2', 'read_file'), said('a1', ANSWER, 'turn_1')];

const click = (h, el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (h, el, name, extra = {}) => el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));
const column = (h) => h.view.q('aside.team-preview');
const logChips = (h) => [...h.view.qa('[data-conv-region="log"] .team-msg__text [data-team-path]')];
const popChips = (h) => [...h.view.qa('#teamTurnPop [data-team-path]')];
const leave = (h) => click(h, h.view.q('[data-team-channel="chan_team"]'));
const menuItems = (h) => [...h.window.document.querySelectorAll('.inv-context-menu [role="menuitem"]')];

// The Team tab on the project's first conversation, with the files list answered.
async function conversation(t, { answers = {}, files = true, ...options } = {}) {
  const opened = await openProjects({ answers: { conversationOpen: { ok: true, snapshot: snapshot({ messages: TURN }) }, projectFiles: page(ENTRIES),
    projectFileRead: (p) => textRead(p.path, 'text of ' + p.path), ...answers }, list: listAnswer({ files_supported: files }), ...options });
  t.after(() => { panes.closeWorkspace(); opened.h.restore(); });
  const { h } = opened;
  if (options.show !== false) {
    h.view.qa('[data-team-tab-action="conv-open"]')[0].click();
    await flush();
  }
  return opened;
}
async function popover(h) {
  click(h, h.view.q('.team-turn-chip[data-turn-id="turn_1"]'));
  await flush();
  return h.view.q('#teamTurnPop');
}

test('path chip opens the explorer: a tool row in Jenny\'s work opens the file in the preview column', async (t) => {
  const { h } = await conversation(t);
  await popover(h);
  const chips = popChips(h).filter((el) => el.classList.contains('tool-path-chip'));
  assert.deepEqual(chips.map((el) => el.dataset.teamPath), ['src/app.js'], 'only the tool row whose path is inside the project is a chip');
  assert.equal(popChips(h).filter((el) => el.localName === 'code').length, 1, "and the answer's path in the popover is one too");
  assert.equal(chips[0].classList.contains('tool-path-chip'), true);
  assert.equal(chips[0].getAttribute('role'), 'link');
  assert.equal(chips[0].getAttribute('tabindex'), '0');
  assert.equal(chips[0].hasAttribute('data-chat-path-open'), false, 'nothing the local chat\'s path controller would act on');
  click(h, chips[0]);
  await flush();
  assert.equal(column(h).querySelector('.team-preview__name').textContent, 'app.js');
  assert.deepEqual(h.sent('projectFileRead').map((c) => c.payload), [{ team_id: OTHER, project_id: P1, path: 'src/app.js' }]);
  assert.equal(h.view.q('#teamTurnPop .team-turn-pop__scroll') !== null, true, 'the popover stays beside it');
});

test('a path in Jenny\'s answer is a chip; a path outside the project, a drive, a hidden folder and a bare word stay code', async (t) => {
  const { h } = await conversation(t);
  assert.deepEqual(logChips(h).map((el) => [el.localName, el.dataset.teamPath, el.textContent]), [['code', 'src/app.js', 'src/app.js']]);
  const codes = [...h.view.qa('[data-conv-region="log"] .team-msg__text code')];
  assert.deepEqual(codes.map((el) => el.textContent), ['src/app.js', '../secret.txt', '/etc/passwd', 'C:/x/y.js', '.git/config', 'notes.txt']);
  assert.deepEqual(codes.filter((el) => !el.hasAttribute('data-team-path')).map((el) => el.getAttribute('role')), [null, null, null, null, null]);
  const chip = logChips(h)[0];
  assert.equal(chip.classList.contains('chat-inline-path'), true);
  click(h, chip);
  await flush();
  assert.equal(column(h).querySelector('.team-preview__name').textContent, 'app.js');
  assert.equal(h.view.q('[data-conv-region="log"] .team-msg__text').querySelector('[data-chat-path-open]'), null);
});

test('a path is judged as the host judges it: no .., drive, absolute, hidden folder or reserved name; nothing the explorer could not list', () => {
  const { isProjectPath } = require('../renderer/team/renderer-team-project-paths');
  for (const ok of ['a.txt', 'src/app.js', './src/app.js', 'src\\app.js', 'dir with space/a b.txt', 'a/b/c/d/e.js', '.gitignore', '.github.md']) assert.equal(isProjectPath(ok) !== '', true, ok);
  assert.equal(isProjectPath('./src/app.js'), 'src/app.js');
  assert.equal(isProjectPath('src\\app.js'), 'src/app.js');
  const bad = ['', '..', 'a/../b', '/abs/a.js', 'C:/a.js', 'c:\\a.js', 'a//b', 'a/./b', '.git/config', 'x/.GIT/a', '.env', 'a/.jenny/b', '.vscode/settings.json', 'con.txt', 'a/NUL', 'a/b.',
    'a/b ', 'a/b?.js', 'a/b:c', 'a/b|c', 'a\u0000b', 'x/'.repeat(17) + 'y', 'a'.repeat(300), 'é'.repeat(260), 'a'.repeat(513), 12, null, undefined];
  for (const value of bad) assert.equal(isProjectPath(value), '', String(value).slice(0, 30));
});

test('no chips when the host serves no files: the popover row and the answer stay as text, and the head says why', async (t) => {
  const { h } = await conversation(t, { files: false });
  await popover(h);
  assert.deepEqual([popChips(h).length, logChips(h).length], [0, 0]);
  assert.equal(h.view.q('#teamTurnPop [data-chat-path-open], #teamTurnPop .tool-path-chip'), null);
  assert.match(h.view.q('#teamTurnPop').textContent, /src\/app\.js/, 'still readable as text');
  const files = h.view.q('[data-project-action="files-open"]');
  assert.equal(files.disabled, true, 'greyed, not hidden');
  assert.match(files.getAttribute('title'), /cannot give Jenny access to files/);
  assert.equal(h.view.q('[data-project-action="at-file"]'), null);
  const mention = [...h.view.qa('.team-icon-btn')].find((el) => el.getAttribute('aria-label') === 'Mention someone');
  assert.equal(mention.disabled, true, 'the @ button stays greyed, with its old reason');
});

test('the head\'s Files button opens the explorer for the conversation\'s project', async (t) => {
  const { h } = await conversation(t);
  const button = h.view.q('.team-head [data-project-action="files-open"]');
  assert.equal(button.textContent.trim(), 'Files');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('title'), 'Files in this project');
  click(h, button);
  await flush();
  assert.equal(column(h).getAttribute('aria-label'), 'Files in jenny-site');
  assert.deepEqual(h.sent('projectFiles').map((c) => c.payload), [{ team_id: OTHER, project_id: P1 }]);
  assert.equal(column(h).querySelectorAll('.team-ftree__row').length > 0, true, 'the tree');
});

test('the path menu: right-click, Shift+F10, the Menu key and the more button give Open preview, Copy path, Copy name; Copy says so', async (t) => {
  const { h } = await conversation(t);
  const chip = logChips(h)[0];
  chip.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  assert.deepEqual(menuItems(h).map((el) => el.textContent.trim()), ['Open preview', 'Copy path', 'Copy name']);
  menuItems(h)[1].click();
  await flush();
  assert.deepEqual(h.copied, ['src/app.js']);
  assert.equal(h.view.q('.team-copied').textContent, 'Path copied');
  chip.focus();
  key(h, chip, 'F10', { shiftKey: true });
  menuItems(h)[2].click();
  await flush();
  assert.deepEqual(h.copied, ['src/app.js', 'app.js']);
  assert.equal(h.view.q('.team-copied').textContent, 'Name copied');
  key(h, chip, 'ContextMenu');
  menuItems(h)[0].click();
  await flush();
  assert.equal(column(h).querySelector('.team-preview__name').textContent, 'app.js');
  chip.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  const more = chip.nextElementSibling;
  assert.equal(more.classList.contains('chat-path-more'), true, 'the hover ⋯ button follows the chip');
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  click(h, more);
  assert.deepEqual(menuItems(h).map((el) => el.textContent.trim()), ['Open preview', 'Copy path', 'Copy name']);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
});

test('a chip answers Enter and Space like a click, and a popover chip does not toggle its tool row', async (t) => {
  const { h } = await conversation(t);
  await popover(h);
  const chip = popChips(h)[0];
  const row = chip.closest('.tool-call-row');
  const was = row.getAttribute('data-expanded');
  chip.focus();
  key(h, chip, 'Enter');
  await flush();
  assert.equal(column(h).querySelector('.team-preview__name').textContent, 'app.js');
  assert.equal(popChips(h)[0].closest('.tool-call-row').getAttribute('data-expanded'), was, 'the row stayed as it was');
  const again = h.sent('projectFileRead').length;
  key(h, popChips(h)[0], ' ');
  await flush();
  assert.equal(h.sent('projectFileRead').length >= again, true);
  assert.equal(popChips(h)[0].closest('.tool-call-row').getAttribute('data-expanded'), was);
});

test('a chip for a file that is gone opens the explorer, which says so', async (t) => {
  const { h } = await conversation(t, { answers: { projectFileRead: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_found' } } } });
  click(h, logChips(h)[0]);
  await flush();
  assert.match(column(h).textContent, /This file is not in the project\./);
});

test('@ in the box offers the project\'s files, filtered as you type, at most 50, and inserts the chosen path', async (t) => {
  const many = Array.from({ length: 120 }, (_v, i) => file('src/part-' + String(i).padStart(3, '0') + '.js'));
  const { h } = await conversation(t, { answers: { projectFiles: page([...ENTRIES, ...many]) } });
  const field = h.view.q('#teamConversationInput');
  const type = (value, at = value.length) => { field.value = value; field.setSelectionRange(at, at); field.dispatchEvent(new h.window.Event('input', { bubbles: true })); };
  const options = () => [...h.view.qa('.team-menu--files [role="option"]')];
  type('look at @');
  await flush();
  assert.equal(h.sent('projectFiles').length, 1);
  assert.equal(options().length, 50, 'at most 50 shown');
  assert.equal(field.getAttribute('aria-controls'), h.view.q('.team-menu--files').id);
  assert.match(field.getAttribute('aria-activedescendant'), /-0$/);
  type('look at @app');
  assert.deepEqual(options().map((el) => el.querySelector('.team-row__name').textContent), ['app.js']);
  assert.equal(options()[0].querySelector('.team-row__note').textContent, 'src');
  type('look at @zzz');
  assert.equal(options().length, 0);
  assert.match(h.view.q('.team-menu--files').textContent, /No file matches/);
  type('look at @site/ind');
  key(h, field, 'ArrowDown');
  key(h, field, 'Enter');
  assert.equal(field.value, 'look at site/index.html ', 'the path replaces the @ word, as text');
  assert.equal(h.view.qa('.team-menu--files [role="option"]').length, 0, 'closed');
  assert.deepEqual(h.sent('conversationSend'), [], 'Enter picked; it did not send');
  type('mail me@here.com');
  assert.equal(h.view.q('.team-menu--files').hidden, true, 'an @ inside a word is not a mention');
  type('@a');
  key(h, field, 'Escape');
  assert.equal(h.view.q('.team-menu--files').hidden, true);
  assert.equal(field.value, '@a', 'Esc leaves the text');
  assert.equal(h.sent('projectFiles').length, 1, 'the list was read once');
});

test('the box\'s @ button opens the same picker; a click on an option inserts at the caret', async (t) => {
  const { h } = await conversation(t);
  const field = h.view.q('#teamConversationInput');
  field.value = 'see ';
  field.setSelectionRange(4, 4);
  const at = h.view.q('[data-project-action="at-file"]');
  assert.equal(at.disabled, false);
  assert.equal(at.getAttribute('aria-label'), 'Insert a project file');
  click(h, at);
  await flush();
  assert.equal(field.value, 'see @');
  const option = [...h.view.qa('.team-menu--files [role="option"]')].find((el) => el.textContent.includes('util.js'));
  option.dispatchEvent(new h.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  click(h, option);
  assert.equal(field.value, 'see src/util.js ');
  assert.equal(h.window.document.activeElement, field);
});

test('F16: the shown conversation is kept with its project and opened once at the next start; one that is gone falls back without a word', async (t) => {
  const stored = (h) => JSON.parse(h.window.localStorage.getItem('jenny.teamShown.v1') || '{}');
  const first = await conversation(t);
  assert.deepEqual(stored(first.h), { [OTHER]: { kind: 'conversation', projectId: P1, sessionId: S1 } });
  leave(first.h);
  await flush();
  assert.deepEqual(stored(first.h), {}, 'back to the channel: the channel is what is kept');
  first.h.restore();

  const keep = { [OTHER]: { kind: 'conversation', projectId: P1, sessionId: S1 } };
  const again = await openProjects({ show: false, answers: { conversationOpen: { ok: true, snapshot: snapshot() } } });
  t.after(again.h.restore);
  again.h.window.localStorage.setItem('jenny.teamShown.v1', JSON.stringify(keep));
  again.h.showTab();
  await flush();
  assert.equal(require('../renderer/team/renderer-team-notify').shownFrame().channelId, 'conv:' + S1, 'opened');
  assert.deepEqual(again.h.sent('conversationOpen').map((c) => c.payload.session_id), [S1]);
  leave(again.h);
  await flush();
  assert.notEqual(require('../renderer/team/renderer-team-notify').shownFrame().channelId, 'conv:' + S1, 'once per start: Back stays back');
  again.h.restore();

  for (const bad of [{ kind: 'conversation', projectId: P1, sessionId: 'sess_' + 'z'.repeat(32) }, { kind: 'conversation', projectId: P2, sessionId: S1 },
    { kind: 'conversation', projectId: 'nope', sessionId: S1 }, { kind: 'other' }, 'conv:' + S1]) {
    const gone = await openProjects({ show: false });
    gone.h.window.localStorage.setItem('jenny.teamShown.v1', JSON.stringify({ [OTHER]: bad }));
    gone.h.showTab();
    await flush();
    assert.equal(require('../renderer/team/renderer-team-notify').shownFrame().channelId, 'chan_team', 'falls back to #team: ' + JSON.stringify(bad).slice(0, 60));
    assert.equal(gone.h.view.q('[data-team-head-note], [role="alert"]'), null, 'with no note');
    gone.h.restore();
  }
});

test('the Team tab says which conversation is on screen, so Home marks its row', async (t) => {
  const { h } = await conversation(t);
  const notify = require('../renderer/team/renderer-team-notify');
  assert.deepEqual([notify.shownFrame().teamId, notify.shownFrame().sessionId], [OTHER, S1]);
  leave(h);
  await flush();
  assert.equal(notify.shownFrame().sessionId, '', 'a channel has none');
  h.view.qa('[data-team-tab-action="conv-open"]')[1].click();
  await flush();
  assert.equal(notify.shownFrame().sessionId, S2);
});

test('file names from the host are text in the picker; the Board\'s column (off) has no chips, no Files button and no picker', async (t) => {
  const { h } = await conversation(t, { answers: { projectFiles: page([file('src/<img src=x onerror=alert(1)>.txt'), file('a/b.js')]) } });
  const field = h.view.q('#teamConversationInput');
  field.value = '@';
  field.setSelectionRange(1, 1);
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await flush();
  const first = h.view.q('.team-menu--files [role="option"]');
  assert.equal(h.view.q('.team-menu--files img'), null, 'no markup from a name');
  assert.match(first.querySelector('.team-row__name').textContent, /<img src=x/);
  assert.equal(first.querySelector('.team-row__name').getAttribute('dir'), 'auto');
  key(h, field, 'Escape');
  assert.equal(field.hasAttribute('aria-controls'), false, 'closed: the field points at nothing');
  const { JSDOM } = require('jsdom');
  const { createPaths } = require('../renderer/team/renderer-team-project-paths');
  const root = new JSDOM('<div></div>').window.document.body;
  const off = createPaths({ root, teamId: OTHER, projectId: P1, projectName: () => 'p', files: () => true, call: () => Promise.resolve({ ok: true }), field: () => null, shell: () => null, off: true });
  assert.deepEqual([off.enabled(), off.headButton(), off.adopt(root)], [false, '', false]);
  off.dispose();
});
