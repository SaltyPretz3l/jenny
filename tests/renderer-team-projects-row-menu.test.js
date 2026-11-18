'use strict';

// new-test-file: the conversation row menu (row 169); tests/renderer-team-projects-column.test.js is at its line cap
// The Projects section's conversation rows: the menu button, right-click and Shift+F10, the inline rename field, the
// delete confirm, the running dot, and the row state it keeps across redraws. Driven through the real Team tab.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, P2, S1, S2, S3, OTHER, project, conversation, listAnswer, openProjects, flush, memberTeam } = require('./helpers/team-project-renderer-host');

const label = (el) => el.getAttribute('aria-label');

// ------------------------------------------------------------------ the conversation row's menu (row 169)

// openProjects loads a fresh copy of the project modules, so the column is read after it, never at the top.
const column = new Proxy({}, { get: (_target, name) => require('../renderer/team/renderer-team-project-column')[name] });
const { validatePayload } = require('../services/team/ipc-methods');

const convRow = (h, id) => h.view.q(`[data-conv-row="${id}"]`);
const convLink = (h, id) => convRow(h, id).querySelector('[data-team-tab-action="conv-open"]');
const menuButton = (h, id) => convRow(h, id).querySelector('[data-team-tab-action="conv-menu"]');
const menuItems = (h) => [...h.window.document.querySelectorAll('.inv-context-menu-item')];
const menuEl = (h) => h.window.document.querySelector('.inv-context-menu');
const field = (h) => h.view.q('#teamConversationRename');
const note = (h, id) => convRow(h, id).nextElementSibling;
const typeInto = (h, el, value) => { el.value = value; el.dispatchEvent(new h.window.Event('input', { bubbles: true })); };
const press = (h, el, key, init = {}) => {
  const event = new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};
const escapeMenu = (h) => h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const pick = (h, text) => menuItems(h).find((el) => el.textContent.startsWith(text)).click();
const openRename = (h, id) => { menuButton(h, id).click(); pick(h, 'Rename'); };
const openConfirm = (h, id) => { menuButton(h, id).click(); pick(h, 'Delete'); };
const foldOpen = (h, id) => h.view.q(`[data-team-tab-action="project-fold"][data-project-id="${id}"]`).click();

test('row 169: a conversation row is a link and a menu button; a running turn is a dot with a name, not a word; New conversation has its plus', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  const row = convRow(h, S1);
  assert.equal(row.tagName, 'DIV');
  assert.ok(row.classList.contains('team-row--conv'));
  assert.equal(convLink(h, S1).textContent, 'Palette loader cleanup');
  const button = menuButton(h, S1);
  assert.deepEqual([button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('aria-haspopup'), button.getAttribute('aria-expanded')],
    ['Actions for Palette loader cleanup', 'Actions for Palette loader cleanup', 'menu', 'false']);
  assert.equal(row.querySelector('.team-row__trail'), null, 'no facts, no trail');
  push({ kind: 'activity', session_id: S1, running: true, approvals: 2 });
  const dot = convRow(h, S1).querySelector('.status-dot--active');
  assert.deepEqual([dot.getAttribute('role'), dot.getAttribute('aria-label')], ['img', 'running']);
  assert.equal(convRow(h, S1).querySelector('.team-row__role'), null, 'the word is gone');
  assert.ok(!convLink(h, S1).textContent.includes('running'));
  assert.equal(label(convLink(h, S1)), 'Palette loader cleanup, running, 2 approvals waiting');
  assert.equal(convRow(h, S1).querySelector('.team-row__trail .team-count').textContent, '2');
  const fresh = h.view.q('[data-team-tab-action="conv-new"]');
  assert.equal(fresh.textContent.trim(), '+ New conversation');
  assert.equal(label(fresh), 'New conversation in jenny-site');
  assert.equal(fresh.querySelector('[aria-hidden="true"]').textContent, '+');
});

test('row 169: rowMenu by role, running and the team owner', () => {
  const read = (over) => column.rowMenu({ role: 'writer', owner: false, running: false, ...over }).map((item) => [item.id, item.disabled, item.description]);
  const ADMINS = 'Only the project’s admins can delete';
  const RENAMERS = 'Only writers and admins can rename';
  assert.deepEqual(read({ role: 'reader' }), [['rename', true, RENAMERS], ['delete', true, ADMINS]]);
  assert.deepEqual(read({ role: 'writer' }), [['rename', false, ''], ['delete', true, ADMINS]]);
  assert.deepEqual(read({ role: 'admin' }), [['rename', false, ''], ['delete', false, '']]);
  assert.deepEqual(read({ role: 'owner' }), [['rename', false, ''], ['delete', false, '']]);
  assert.deepEqual(read({ role: 'admin', running: true }), [['rename', false, ''], ['delete', true, 'A turn is running. Stop it first']]);
  assert.deepEqual(read({ role: 'reader', owner: true }), [['rename', false, ''], ['delete', false, '']], 'the team owner may do what an admin may');
  assert.deepEqual(read({ role: 'writer', owner: true, running: true })[1], ['delete', true, 'A turn is running. Stop it first']);
  assert.deepEqual(column.rowMenu({ role: 'admin' }).map((item) => [item.label, item.danger]), [['Rename', false], ['Delete', true]]);
});

test('row 169: the menu button opens the menu; a reader finds both choices disabled with their reasons', async (t) => {
  const { h } = await openProjects({ team: memberTeam({ role: 'read_only' }), list: listAnswer({ projects: [project(P1, 'jenny-site', 'reader')] }) });
  t.after(h.restore);
  assert.ok(menuButton(h, S1), 'a reader gets the button');
  menuButton(h, S1).click();
  assert.equal(menuButton(h, S1).getAttribute('aria-expanded'), 'true');
  assert.equal(menuEl(h).getAttribute('aria-label'), 'Actions for Palette loader cleanup');
  assert.deepEqual(menuItems(h).map((el) => [el.querySelector('.inv-context-menu-text > span:first-child').textContent, el.disabled]), [['Rename', true], ['Delete', true]]);
  assert.deepEqual([...menuEl(h).querySelectorAll('.inv-context-menu-description')].map((el) => el.textContent), ['Only writers and admins can rename', 'Only the project’s admins can delete']);
  menuButton(h, S1).click();
  assert.equal(menuEl(h), null, 'the button closes its own menu');
  assert.equal(menuButton(h, S1).getAttribute('aria-expanded'), 'false');
});

test('row 169: Rename opens the field on the title; Enter sends the trimmed title, the field goes and the focus returns to the row', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  const listReads = h.sent('projectList').length;
  openRename(h, S1);
  assert.equal(menuEl(h), null);
  assert.equal(field(h).value, 'Palette loader cleanup');
  assert.equal(h.window.document.activeElement, field(h), 'the field has the focus');
  assert.equal(field(h).getAttribute('aria-label'), 'Conversation name');
  assert.ok(convRow(h, S1).classList.contains('team-inline-name') && convRow(h, S1).querySelector('.inv-text-field #teamConversationRename'), 'inside the row, in place of its link');
  assert.equal(convLink(h, S1), null);
  typeInto(h, field(h), '  Palette loader tidy-up  ');
  assert.equal(press(h, field(h), 'Enter').defaultPrevented, true);
  await flush();
  const payload = { team_id: OTHER, session_id: S1, title: 'Palette loader tidy-up' };
  assert.deepEqual(h.sent('conversationRename').map((c) => c.payload), [payload]);
  assert.equal(validatePayload('conversationRename', payload).ok, true);
  assert.equal(field(h), null, 'the field went');
  assert.equal(column.rowOf(OTHER), null);
  assert.equal(h.window.document.activeElement, convLink(h, S1));
  assert.ok(h.sent('projectList').length > listReads, 'the list is read again');
});

test('row 169: Escape closes the field with no call; an unchanged or empty title sends nothing; leaving the field saves a changed name', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  openRename(h, S1);
  typeInto(h, field(h), 'Something else');
  press(h, field(h), 'Escape');
  assert.equal(field(h), null);
  assert.equal(h.window.document.activeElement, convLink(h, S1));
  openRename(h, S1);
  press(h, field(h), 'Enter');
  await flush();
  assert.equal(field(h), null, 'unchanged closes');
  openRename(h, S1);
  typeInto(h, field(h), '   ');
  press(h, field(h), 'Enter');
  await flush();
  assert.equal(field(h), null, 'empty closes');
  openRename(h, S1);
  typeInto(h, field(h), '   ');
  h.view.q('[data-team-tab-action="project-new"]').focus();
  await flush();
  assert.equal(field(h), null, 'leaving it empty closes it');
  assert.equal(h.sent('conversationRename').length, 0, 'nothing was sent');
  openRename(h, S2);
  typeInto(h, field(h), 'Blog post, second draft');
  h.view.q('[data-team-tab-action="project-new"]').focus();
  await flush();
  assert.deepEqual(h.sent('conversationRename').map((c) => c.payload.title), ['Blog post, second draft'], 'leaving a changed name saves it');
  assert.equal(h.window.document.activeElement, h.view.q('[data-team-tab-action="project-new"]'), 'the focus stays where the person put it');
});

test('row 169: a refused rename keeps the field and the typed text and says why', async (t) => {
  const { h } = await openProjects({ answers: { conversationRename: { ok: false, error: { reason: 'revision_conflict' } } } });
  t.after(h.restore);
  openRename(h, S1);
  typeInto(h, field(h), 'A better name');
  press(h, field(h), 'Enter');
  await flush();
  assert.equal(field(h).value, 'A better name');
  assert.equal(field(h).disabled, false);
  assert.equal(h.window.document.activeElement, field(h));
  assert.equal(note(h, S1).textContent, 'This conversation changed meanwhile. Try again.');
  assert.equal(note(h, S1).getAttribute('role'), 'status');
});

test('row 169: the rename field and its text survive a list redraw under it', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  openRename(h, S1);
  typeInto(h, field(h), 'Half typed');
  push({ kind: 'activity', session_id: S2, running: true, approvals: 0 });
  push({ kind: 'projects', ...listAnswer() });
  await flush();
  assert.equal(field(h).value, 'Half typed');
  assert.equal(h.window.document.activeElement, field(h), 'the new field has the focus');
  assert.equal(h.sent('conversationRename').length, 0, 'the redraw did not save it');
  push({ kind: 'projects', ...listAnswer({ conversations: [] }) });
  await flush();
  assert.equal(field(h), null, 'the conversation left the list: its field goes');
  assert.equal(column.rowOf(OTHER), null);
});

test('row 169: Delete asks first, in the row; Cancel puts it back; Delete deletes and the row state clears', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  foldOpen(h, P2);
  openConfirm(h, S3);
  const confirm = h.view.q('.team-row__confirm');
  assert.equal(confirm.getAttribute('role'), 'group');
  assert.equal(confirm.getAttribute('aria-label'), 'Delete conversation');
  assert.equal(confirm.querySelector('p').textContent, 'Delete “Contrast checker” for everyone in palette-tools? This cannot be undone.');
  assert.equal(note(h, S3), confirm, 'under its row');
  const cancel = confirm.querySelector('[data-team-tab-action="conv-delete-no"]');
  assert.equal(h.window.document.activeElement, cancel, 'Cancel has the focus');
  cancel.click();
  assert.equal(h.view.q('.team-row__confirm'), null);
  assert.equal(h.window.document.activeElement, convLink(h, S3));
  assert.equal(h.sent('conversationDelete').length, 0);
  openConfirm(h, S3);
  h.view.q('[data-team-tab-action="conv-delete-yes"]').click();
  await flush();
  const payload = { team_id: OTHER, session_id: S3 };
  assert.deepEqual(h.sent('conversationDelete').map((c) => c.payload), [payload]);
  assert.equal(validatePayload('conversationDelete', payload).ok, true);
  assert.equal(h.view.q('.team-row__confirm'), null);
  assert.equal(column.rowOf(OTHER), null);
});

test('row 169: deleting the conversation that is shown closes its page', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  foldOpen(h, P2);
  convLink(h, S3).click();
  await flush();
  assert.equal(column.viewOf(OTHER), column.conversationPage(S3));
  openConfirm(h, S3);
  h.view.q('[data-team-tab-action="conv-delete-yes"]').click();
  await flush();
  assert.equal(column.viewOf(OTHER), '', 'the page closed');
});

test('row 169: a refused delete keeps the conversation and shows the sentence under the row, cleared by the next menu', async (t) => {
  const { h } = await openProjects({ answers: { conversationDelete: { ok: false, error: { reason: 'revision_conflict' } } } });
  t.after(h.restore);
  foldOpen(h, P2);
  openConfirm(h, S3);
  h.view.q('[data-team-tab-action="conv-delete-yes"]').click();
  await flush();
  assert.equal(h.view.q('.team-row__confirm'), null);
  assert.equal(note(h, S3).textContent, 'This conversation changed meanwhile. Try again.');
  assert.equal(h.window.document.activeElement, convLink(h, S3));
  menuButton(h, S3).click();
  assert.equal(note(h, S3).className.includes('team-proj__note'), false, 'the note went with the next action');
  assert.ok(menuEl(h));
});

test('row 169: a turn running in the conversation disables Delete with the reason', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  foldOpen(h, P2);
  push({ kind: 'activity', session_id: S3, running: true, approvals: 0 });
  menuButton(h, S3).click();
  const del = menuItems(h).find((el) => el.textContent.startsWith('Delete'));
  assert.equal(del.disabled, true);
  assert.ok(del.textContent.includes('A turn is running. Stop it first'));
});

test('row 169: right-click on a row, Shift+F10 and the Menu key on its link open the menu and stop the browser\'s own', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  const right = new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 14 });
  convLink(h, S1).dispatchEvent(right);
  assert.equal(right.defaultPrevented, true);
  assert.ok(menuEl(h), 'right-click opened it');
  assert.equal(menuEl(h).getAttribute('aria-label'), 'Actions for Palette loader cleanup');
  escapeMenu(h);
  assert.equal(menuEl(h), null);
  convLink(h, S2).focus();
  assert.equal(press(h, convLink(h, S2), 'F10', { shiftKey: true }).defaultPrevented, true);
  assert.equal(menuButton(h, S2).getAttribute('aria-expanded'), 'true', 'Shift+F10 opened the menu of the row it was on');
  escapeMenu(h);
  assert.equal(menuEl(h), null);
  assert.equal(h.window.document.activeElement, menuButton(h, S2), 'the focus returns to the row');
  assert.equal(press(h, convLink(h, S1), 'ContextMenu').defaultPrevented, true);
  assert.ok(menuEl(h));
  escapeMenu(h);
  assert.equal(press(h, convLink(h, S1), 'F10').defaultPrevented, false, 'F10 alone is not the menu key');
  openRename(h, S1);
  const inField = new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  field(h).dispatchEvent(inField);
  assert.equal(inField.defaultPrevented, false, 'the field keeps the browser\'s own menu');
});

test('row 169: hostile titles and project names are text in the row, the menu label, the field and the confirm sentence', async (t) => {
  const evil = '<img src=x onerror=1>‮evil';
  const { h } = await openProjects({ list: listAnswer({ projects: [project(P1, '<b>x</b>‮p', 'admin')], conversations: [conversation(S1, P1, evil)] }) });
  t.after(h.restore);
  const bare = () => h.view.q('.team-projects').querySelector('img, b, [onerror], [src]');
  assert.equal(bare(), null);
  assert.equal(label(menuButton(h, S1)), 'Actions for <img src=x onerror=1>evil');
  menuButton(h, S1).click();
  assert.equal(menuEl(h).getAttribute('aria-label'), 'Actions for <img src=x onerror=1>evil');
  assert.equal(menuEl(h).querySelector('img, [onerror]'), null);
  pick(h, 'Rename');
  assert.equal(field(h).value, '<img src=x onerror=1>evil');
  assert.equal(bare(), null);
  press(h, field(h), 'Escape');
  openConfirm(h, S1);
  assert.equal(h.view.q('.team-row__confirm p').textContent, 'Delete “<img src=x onerror=1>evil” for everyone in <b>x</b>p? This cannot be undone.');
  assert.equal(h.view.q('.team-row__confirm p').getAttribute('dir'), 'auto');
  assert.equal(bare(), null);
  assert.equal(globalThis.pwned, undefined);
});

test('row 169: leaving the team clears the row state; so does forgetTeam', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  openRename(h, S1);
  assert.equal(column.rowOf(OTHER).mode, 'rename');
  push({ kind: 'team_gone' });
  await flush();
  assert.equal(column.rowOf(OTHER), null);
  column.openRow('team_other', S2, 'confirm');
  column.forgetTeam('team_other');
  assert.equal(column.rowOf('team_other'), null);
});
