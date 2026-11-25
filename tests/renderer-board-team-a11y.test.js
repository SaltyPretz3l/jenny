'use strict';

// new-test-file: a new lane (row 151 hardening, slice P5-B, pass 2): the team half of the Board page by keyboard and screen reader
// (the project button and menu, the conversation picker, the viewers and typing announcements, disabled controls with their reason,
// reduced motion, and where focus goes when what it was on is gone). Same page and scripted bridge as renderer-board-team-hostile.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const K = require('./helpers/board-team-page-kit');

const { host, TEAM, PROJECT, DOT, MAYA, mount, items, heads, uid, teamBoard } = K;
const key = (m, target, k, init) => {
  const event = new m.window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, init));
  target.dispatchEvent(event);
  return event;
};
const active = (m) => m.doc.activeElement;
const onBody = (m) => !active(m) || active(m) === m.doc.body;
const hide = (m) => m.window.inventoryContextMenu.hide({ restoreFocus: false });
// Counts the changes of an element's text: what a screen reader would be told.
function watch(m, el) {
  const observer = new m.window.MutationObserver(() => {});
  observer.observe(el, { childList: true, characterData: true, subtree: true });
  return () => observer.takeRecords().length;
}
const live = (m) => m.q('[data-board-team-conv="live"]');
const isolated = (name) => `⁨${name}⁩`;

test('the project heading button: named for the project shown, a menu button, and opened by Enter, Space and ArrowDown', async (t) => {
  const m = await mount(t);
  const button = m.button();
  assert.equal(button.tagName, 'BUTTON', 'a real button: Enter and Space click it');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.textContent.includes('Alpha'), true, 'its name holds the project shown');
  assert.deepEqual([button.getAttribute('aria-haspopup'), button.getAttribute('aria-expanded')], ['menu', 'false']);
  button.focus();
  assert.equal(key(m, button, 'ArrowDown').defaultPrevented, true);
  await m.flush();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([active(m).getAttribute('aria-checked'), active(m).textContent.trim()], ['true', 'Alpha'], 'focus is on the row of the project shown');
  key(m, active(m), 'Escape');
  assert.deepEqual([m.menu(), button.getAttribute('aria-expanded'), active(m)], [null, 'false', button]);
  button.click();
  await m.flush();
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'Enter and Space are a click');
  button.click();
  await m.flush();
  assert.deepEqual([m.menu(), button.getAttribute('aria-expanded')], [null, 'false'], 'a second activation closes it');
  button.focus();
  key(m, button, 'ArrowDown');
  await m.flush();
  key(m, active(m), 'ArrowDown');
  assert.equal(active(m).textContent.trim(), 'General', 'arrow keys move between rows');
  hide(m);
});

test('the project menu: the project shown is the checked row of one closed set, and a project that cannot be opened carries its reason', async (t) => {
  const list = host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader'), host.project(K.P2, 'palette-tools', 'writer')] });
  const own = await mount(t, { ownBoard: true, answers: { projectList: list } });
  await K.openMenu(own);
  assert.deepEqual(items(own).map((el) => [el.getAttribute('role'), el.getAttribute('aria-checked')]), [['menuitemradio', 'true'], ['menuitemradio', 'false'], ['menuitemradio', 'false'], ['menuitemradio', 'false']]);
  assert.equal(own.menu().getAttribute('role'), 'menu');
  assert.ok(own.menu().getAttribute('aria-label'), 'the menu is named');
  hide(own);
  own.q('[data-board-id] [data-board-action="export"]').click();
  await own.flush();
  items(own).find((el) => el.textContent.trim() === 'Copy to a team project…').click();
  await own.flush();
  const reader = items(own).find((el) => el.textContent.includes('jenny-site'));
  const said = own.doc.getElementById(reader.getAttribute('aria-describedby'));
  assert.deepEqual([reader.disabled, said && said.textContent], [true, 'You can look at this project. Its writers and admins can add boards.'], 'a row that is off says why to a reader');
});

test('the conversation picker: a menu button with its rows, the conversation shown checked, New conversation a row, opened by ArrowDown, closed by Escape', async (t) => {
  const m = await K.teamChat(t);
  const trigger = K.picker(m);
  assert.deepEqual([trigger.tagName, trigger.getAttribute('aria-haspopup'), trigger.getAttribute('aria-expanded'), trigger.textContent.trim()], ['BUTTON', 'menu', 'false', 'Palette loader cleanup']);
  trigger.focus();
  assert.equal(key(m, trigger, 'ArrowDown').defaultPrevented, true);
  await m.flush();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([active(m).textContent.trim(), active(m).getAttribute('aria-checked')], ['Palette loader cleanup', 'true']);
  assert.deepEqual(items(m).map((el) => [el.textContent.trim(), el.getAttribute('role')]), [['Palette loader cleanup', 'menuitemradio'], ['Blog post draft', 'menuitemradio'], ['New conversation', 'menuitem']]);
  assert.equal(m.menu().getAttribute('aria-label') !== null, true);
  assert.equal(heads(m)[0], `Conversations in ${isolated('jenny-site')}`);
  key(m, active(m), 'Escape');
  assert.deepEqual([m.menu(), trigger.getAttribute('aria-expanded'), active(m)], [null, 'false', trigger]);
  trigger.click();
  await m.flush();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'Enter and Space are a click');
  hide(m);
});

test('a reader has New conversation off in the picker and in the empty column, each with the sentence', async (t) => {
  const list = host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader')], conversations: [] });
  const m = await K.teamChat(t, { answers: { projectList: list } });
  const why = m.page.getTeamSource().whyNot('create');
  assert.notEqual(why, '');
  const button = m.q('[data-board-team-conv="new"]');
  assert.deepEqual([button.disabled, button.title, button.getAttribute('aria-label'), button.textContent.trim()], [true, why, null, 'New conversation'], 'named by its text, described by the sentence');
  K.picker(m).click();
  await m.flush();
  const row = items(m)[0];
  assert.deepEqual([row.textContent.includes('New conversation'), row.disabled, m.doc.getElementById(row.getAttribute('aria-describedby')).textContent], [true, true, why]);
  hide(m);
});

test('the chat column: labelled, the viewers announced politely once per change, and the sentence above the box tied to the box', async (t) => {
  const board = teamBoard(1, 'Plan', K.note(1, 'hello'));
  const m = await K.teamChat(t, { boards: [board] });
  const aside = m.q('[data-board-chat-host] > aside');
  assert.equal(aside.getAttribute('aria-label'), 'Conversation with Jenny');
  const region = live(m);
  assert.ok(region, 'a live region of the column');
  assert.deepEqual([region.getAttribute('aria-live'), region.getAttribute('role')], ['polite', 'status']);
  const changes = watch(m, region);
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [], locks: [] });
  assert.equal(region.textContent, `${isolated('Maya')} and you are viewing`);
  assert.equal(changes() > 0, true, 'a new viewer is announced');
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA, x: 4, y: 4, selected: [] }], locks: [] });
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [], locks: [] });
  m.window.rendererTeamStore.getTeamStore().seed({ teams: [host.memberTeam()] });
  assert.equal(changes(), 0, 'the same viewers again say nothing');
  K.pushPresence(m, { viewers: [DOT], cursors: [], locks: [] });
  assert.equal(changes() > 0 && region.textContent === '', true, 'someone leaving is one change');
  const input = m.q('[data-board-chat-host] .team-composer__input');
  const hint = m.q('.team-composer__hint');
  assert.ok(input && hint, 'the box and its sentence');
  assert.ok(hint.id, 'the sentence has an id the box points at');
  assert.ok(input.getAttribute('aria-describedby').split(/\s+/).includes(hint.id), 'the box is described by the sentence');
  await m.captured.part.openConversation(K.S2);
  await m.flush();
  assert.ok(m.q('[data-board-chat-host] .team-composer__input').getAttribute('aria-describedby').split(/\s+/).includes(m.q('.team-composer__hint').id), 'still tied after another conversation is shown');
});

test('presence for someone who cannot see pointers: pointers are hidden, and a note being held or let go is announced once with its short name', async (t) => {
  const m = await K.presenceMount(t);
  await K.pickTeam(m);
  await m.flush();
  assert.equal(m.qa('.board-team-cursor').every((el) => el.getAttribute('aria-hidden') === 'true') && m.qa('.board-team-cursor').length > 0, true);
  const region = m.q('[data-board-team-live]');
  assert.ok(region, 'a live region of the page');
  assert.deepEqual([region.getAttribute('aria-live'), region.getAttribute('role'), region.classList.contains('sr-only')], ['polite', 'status', true]);
  const alias = m.captured.ctx.editor.getBoard().cards[uid(101)].alias || 'note'; // a card with no alias is named by its kind
  const changes = watch(m, region);
  assert.equal(region.textContent, '', 'a hold that was there when the board opened is not announced');
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [], locks: [] });
  assert.equal(changes() > 0 && /stopped|done|no longer/i.test(region.textContent), true, `released: ${region.textContent}`);
  assert.ok(region.textContent.includes(alias) && region.textContent.includes('Maya'));
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [], locks: [] });
  assert.equal(changes(), 0, 'a repeat says nothing');
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [], locks: [{ card_id: uid(101), member_id: MAYA }] });
  assert.equal(region.textContent, `${isolated('Maya')} is typing in ${alias}`);
  assert.equal(changes() > 0, true);
  K.pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA, x: 9, y: 9, selected: [] }], locks: [{ card_id: uid(101), member_id: MAYA }] });
  assert.equal(changes(), 0, 'a pointer move is not an announcement');
  // The refused edit goes to the app's toast, a warning, which the toast layer gives role=alert.
  m.captured.ctx.canvas.startEdit(uid(101));
  await m.flush();
  assert.deepEqual([m.toasts.at(-1).message, m.toasts.at(-1).tone], [`${isolated('Maya')} is editing this note.`, 'warning']);
});

test('a control the role does not allow is off with its reason as the title, the way the Board own controls are', async (t) => {
  const reader = host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader')] });
  const m = await mount(t, { boards: [teamBoard(1, 'Plan')], answers: { projectList: reader } });
  await K.pickTeam(m);
  await m.flush();
  const why = m.page.getTeamSource().whyNot('create');
  const create = m.q('[data-board-action="new"]');
  assert.deepEqual([create.disabled, create.title, create.textContent.trim()], [true, why, 'New board']);
  const rename = m.q('[data-board-id] [data-board-action="rename"]');
  assert.deepEqual([rename.disabled, rename.title], [true, m.page.getTeamSource().whyNot('rename')]);
});

test('the stylesheet of the team half has nothing that animates or transitions under reduced motion', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'board-team.css'), 'utf8');
  const { window } = new JSDOM(`<!doctype html><style>${css}</style>`);
  const sheet = window.document.styleSheets[0];
  assert.ok(sheet.cssRules.length > 10, 'the stylesheet parsed');
  const MOVING = ['transition', 'transition-property', 'transition-duration', 'animation', 'animation-name', 'animation-duration', 'scroll-behavior'];
  const moving = [];
  const scan = (rules, reduced) => [...rules].forEach((rule) => {
    // A style rule has cssRules too in this CSSOM: only a media rule is entered, or no style rule would ever be read.
    if (rule.media) { scan(rule.cssRules, reduced || /prefers-reduced-motion:\s*reduce/.test(String(rule.conditionText || rule.media.mediaText || ''))); return; }
    if (rule.type === 7 || rule.type === 8) moving.push(`${rule.cssText.slice(0, 30)} (keyframes)`);
    if (!rule.style || reduced) return;
    MOVING.forEach((prop) => { const value = rule.style.getPropertyValue(prop); if (value && value !== 'none' && !/^0s?$/.test(value) && value !== 'auto') moving.push(`${rule.selectorText} ${prop}: ${value}`); });
  });
  scan(sheet.cssRules, false);
  assert.deepEqual(moving, [], 'nothing moves unless a reduced-motion rule turns it off');
  window.close();
});

const CONV_FIRST = host.conversation(K.S1, PROJECT, 'Palette loader cleanup');

test('focus is not lost to the page when the project shown changes', async (t) => {
  const m = await mount(t, { boards: [teamBoard(1, 'Plan')] });
  m.button().focus();
  await K.openMenu(m);
  await K.choose(m, 'jenny-site');
  assert.equal(onBody(m), false, 'after choosing a team project');
  assert.equal(active(m), m.button());
  await K.openMenu(m);
  await K.choose(m, 'General');
  assert.equal(onBody(m), false, 'after choosing an own project');
  assert.equal(active(m), m.button());
});

test('focus is not lost when the member role changes while the menu is open, nor in the box when the role changes', async (t) => {
  const m = await K.teamChat(t, { boards: [teamBoard(1, 'Plan')] });
  m.button().focus();
  await K.openMenu(m);
  m.bridge.push('onProject', { team_id: TEAM, kind: 'projects', ...host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader'), host.project(K.P2, 'palette-tools', 'admin')] }) });
  await K.settle(m);
  assert.equal(onBody(m), false, 'with the menu open');
  assert.equal(m.menu() !== null && m.menu().contains(active(m)), true);
  key(m, active(m), 'Escape');
  assert.equal(active(m), m.button());
  m.q('[data-board-chat-host] .team-composer__input').focus();
  m.bridge.push('onProject', { team_id: TEAM, kind: 'projects', ...host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'writer'), host.project(K.P2, 'palette-tools', 'admin')] }) });
  await K.settle(m);
  assert.equal(onBody(m), false, 'with the cursor in the box');
});

test('focus is not lost when the conversation shown is deleted by someone else, with the cursor in its box or with the picker open', async (t) => {
  const rows = { list: host.listAnswer().conversations };
  const m = await K.teamChat(t, { answers: { projectList: () => host.listAnswer({ conversations: rows.list }) } });
  m.q('[data-board-chat-host] .team-composer__input').focus();
  rows.list = rows.list.filter((row) => row.session_id !== K.S1);
  m.window.rendererTeamProjectStore.getProjectStore().reread(TEAM);
  await K.settle(m);
  assert.equal(K.picker(m).textContent.trim(), 'Blog post draft');
  assert.equal(onBody(m), false, 'the box that was typed in is gone');
  rows.list = [CONV_FIRST, ...rows.list];
  m.window.rendererTeamProjectStore.getProjectStore().reread(TEAM);
  await K.settle(m);
  K.picker(m).click();
  await m.flush();
  assert.equal(m.menu().contains(active(m)), true);
  rows.list = rows.list.filter((row) => row.session_id !== K.S2);
  m.window.rendererTeamProjectStore.getProjectStore().reread(TEAM);
  await K.settle(m);
  assert.equal(onBody(m), false, 'with the picker open');
  hide(m);
});

test('focus is not lost when the team is left with the picker open, nor when the column is collapsed with focus on its button', async (t) => {
  const m = await K.teamChat(t);
  K.picker(m).focus();
  K.picker(m).click();
  await m.flush();
  assert.equal(m.menu().contains(active(m)), true);
  m.window.rendererTeamStore.getTeamStore().seed({ teams: [] });
  await K.settle(m);
  assert.equal(onBody(m), false, 'the picker, the column and the team are gone');
  assert.equal(m.doc.contains(active(m)) && m.q('[data-board-workbench]').contains(active(m)), true, 'focus is on a control of the page');
  const c = await K.teamChat(t);
  const collapse = c.q('[data-board-team-conv="collapse"]');
  collapse.focus();
  collapse.click();
  await K.settle(c);
  assert.equal(onBody(c), false, 'after Collapse chat');
});

test('dispose leaves the live regions and the key listeners no node', async (t) => {
  const m = await K.presenceMount(t);
  await K.pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await m.flush();
  m.page.dispose();
  assert.equal(m.qa('[data-board-team-live], [data-board-team-conv="live"], .board-team-conv, [data-board-team-presence]').length, 0);
});
