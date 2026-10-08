'use strict';

/* Suggested changes W3 in the renderer (row 35; UI spec §3.3-3.5, §4.2):
 * grouped trays, dependency facts and their labelled assumptions, Needs
 * attention with a confirmed "Apply anyway", the re-anchored note, the row
 * and overflow menus, and History of applied suggestions. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../renderer/features/renderer-suggested-changes-model');
const { buildBarHtml } = require('../renderer/features/renderer-suggestion-bar-render');
const { createSuggestionBarController } = require('../renderer/features/renderer-suggestion-bar-controller');
const { createSuggestedActions } = require('../renderer/features/renderer-changes-suggested-actions');
const { createChangesView } = require('../renderer/features/renderer-changes-view');
const { click, entry, listOf, makeClient, settle } = require('./helpers/suggested-changes-fixtures');

const HASH = `sha256:${'a'.repeat(64)}`;

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
}

function fakeMenu() {
  const shown = [];
  return { shown, show: (options) => shown.push(options), hide: () => {} };
}

/* ── Model ── */

test('model: group members sit together in one tray; rows carry their menu', () => {
  const list = listOf([
    entry('a', { group_id: 'grp:t:x' }),
    entry('b'),
    entry('c', { group_id: 'grp:t:x', status: 'accepted' }),
    entry('d', { status: 'later' }),
  ]);
  const view = model.buildSuggestedView(list);
  assert.deepEqual(view.rows.map((row) => row.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(view.rows.map((row) => row.group), ['grp:t:x', 'grp:t:x', '', '']);
  assert.equal(view.rows[1].secondLine.text, 'Accepted, waits for the rest of the group');
  assert.deepEqual(view.rows[0].menu, { later: true, restore: false, ungroup: true });
  assert.deepEqual(view.rows[3].menu, { later: false, restore: true, ungroup: false });
  assert.equal(model.stepFrom(model.currentBatch(list), 'a', 1), 'c', 'Alt+] follows the tray order');
});

test('model: needs attention names the rejected change; a revising dependency makes a change wait', () => {
  const list = listOf([
    entry('a', { status: 'rejected', updated_at: '2026-10-05T00:00:30Z' }),
    entry('b', { status: 'needs_attention', depends_on: ['a'] }),
    entry('c', { status: 'revising' }),
    entry('d', { depends_on: ['c'] }),
  ]);
  const view = model.buildSuggestedView(list);
  const second = Object.fromEntries(view.rows.map((row) => [row.id, row.secondLine && row.secondLine.text]));
  assert.equal(second.b, 'Needs attention: depends on rejected change 1');
  assert.equal(second.d, 'Waits for the revision of change 3');

  const held = model.buildBarModel(list, 'b');
  assert.equal(held.canAccept, true);
  assert.equal(held.statusNote, 'This depends on change 1, which you rejected. It is skipped unless you apply it anyway.');
  assert.equal(held.confirmApply.confirmLabel, 'Apply anyway');
  assert.match(held.confirmApply.message, /change 1, which you rejected/);
  const later = model.buildBarModel(listOf([
    entry('a', { status: 'rejected' }),
    entry('b', { status: 'later', depends_on: ['a'] }),
  ]), 'b');
  assert.equal(later.confirmApply.confirmLabel, 'Apply anyway', 'Later keeps the confirm');

  const waiting = model.buildBarModel(list, 'd');
  assert.equal(waiting.canAccept, false);
  assert.equal(waiting.acceptReason, 'Accept change 3 first.');
});

test('model: facts are derived or labelled as Jenny’s assumption; satisfied ones drop', () => {
  const list = listOf([
    entry('a', { kind: 'create', path: 'src/util.py' }),
    entry('b'),
    entry('c', { status: 'applied', applied: { at: '2026-10-05T00:00:40Z', change_set_id: 'cs' } }),
    entry('d', {
      depends_on: ['a', 'b', 'c'],
      relations: [
        { id: 'a', kind: 'import', name: 'util.py' },
        { id: 'b', kind: 'declared', name: '' },
        { id: 'c', kind: 'defines', name: 'parse_day' },
      ],
    }),
  ]);
  const bar = model.buildBarModel(list, 'd');
  assert.deepEqual(bar.facts, [
    { kind: 'import', text: 'Imports util.py, which change 1 creates.' },
    { kind: 'declared', text: 'Jenny says this needs change 2.', assumption: true },
  ]);
  const html = buildBarHtml(bar);
  assert.match(html, /suggestion-bar-fact--assumption/);
  assert.match(html, />Assumption</);
});

test('model: group notes, the re-anchored note and the group member accept state', () => {
  const g = 'grp:t:x';
  const list = listOf([
    entry('a', { group_id: g, status: 'accepted' }),
    entry('b', { group_id: g }),
    entry('c', { group_id: g, reanchored: true }),
    entry('d', { reanchored: true }),
  ]);
  assert.equal(model.buildBarModel(list, 'a').statusNote, 'Accepted. Waiting for the other 2 changes in this group.');
  assert.equal(model.buildBarModel(list, 'b').statusNote, 'Grouped: applies together with 2 other changes once all are accepted.');
  assert.match(model.buildBarModel(list, 'c').statusNote, /^Your file changed since Jenny suggested this/);
  assert.match(model.buildBarModel(list, 'd').statusNote, /Check it again before accepting\.$/);
  assert.equal(model.buildBarModel(list, 'a').canAccept, false);
});

test('model: History lists applied suggestions, one block per apply, newest first', () => {
  const list = listOf([
    entry('a', { status: 'applied', applied: { at: '2026-10-05T02:00:00Z', change_set_id: 'CS1', before_hash: HASH, after_hash: HASH, diff: { hunks: [{ lines: ['+x'] }] } } }),
    entry('b', { status: 'applied', kind: 'create', path: 'src/new.py', applied: { at: '2026-10-05T02:00:00Z', change_set_id: 'cs1' } }),
    entry('c', { status: 'applied', applied: { at: '2026-10-05T03:00:00Z', change_set_id: 'cs2', before_hash: HASH } }),
    entry('d', { status: 'rejected' }),
  ]);
  const history = model.buildAppliedHistory(list, { workspaceId: 'ws1' });
  assert.deepEqual(history.turns.map((turn) => [turn.turnId, turn.title, turn.changeSetIds]), [
    ['suggested:cs2', 'Accepted: Title c', ['cs2']],
    ['suggested:cs1', 'Accepted 2 suggested changes', ['cs1']],
  ]);
  assert.deepEqual(history.turns[1].files.map((file) => [file.path, file.created]), [['src/a.py', false], ['src/new.py', true]]);
  const opened = history.changes.find((change) => change.path === 'src/a.py');
  assert.deepEqual(opened, {
    changeId: 'suggested:a', turnId: 'suggested:cs1', fileKey: 'src/a.py', path: 'src/a.py', status: 'modified',
    beforeHash: HASH, hunks: [{ lines: ['+x'] }], workspaceId: 'ws1',
  });
  assert.equal(history.changes.find((change) => change.path === 'src/new.py').status, 'created');
});

/* ── Bar: Apply anyway ── */

test('bar: Apply anyway asks first and sends force only when confirmed', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="bar"></div></body>');
  const el = dom.window.document.getElementById('bar');
  const made = makeClient([entry('a', { status: 'rejected' }), entry('b', { status: 'needs_attention', depends_on: ['a'] })]);
  await made.client.refresh('s1');
  const answers = [false, true];
  const asked = [];
  const controller = createSuggestionBarController({
    client: made.client, storage: null, confirm: async (options) => { asked.push(options); return answers.shift(); },
  });
  controller.render(el, { sessionId: 's1', id: 'b', revision: 1 });
  el.addEventListener('click', (event) => controller.handleClick(event, el));
  const acceptButton = () => el.querySelector('[data-suggestion-action="accept"]');
  assert.equal(acceptButton().textContent.trim(), 'Apply anyway…');
  click(dom, acceptButton());
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].confirmLabel, 'Apply anyway');
  assert.equal(asked[0].variant, 'danger');
  assert.deepEqual(made.bridge.calls.filter((call) => call[0] === 'accept'), [], 'declined: nothing is sent');
  click(dom, acceptButton());
  await settle();
  await settle();
  assert.deepEqual(made.bridge.calls.filter((call) => call[0] === 'accept'), [['accept', 's1', 'b', 1, 'force']]);
});

test('client: a group member accepted early advances; Ungroup does not', async () => {
  const made = makeClient([entry('a', { group_id: 'g' }), entry('b', { group_id: 'g' }), entry('c')]);
  await made.client.refresh('s1');
  made.client.setCurrent('s1', 'a');
  made.bridge.acceptResult = { ok: true, status: 'accepted', outcome: 'accepted', waiting: 1 };
  const result = await made.client.accept('s1', 'a', 1);
  assert.deepEqual(result, { ok: true, applied: false });
  assert.equal(made.client.getCurrent('s1'), 'b');
  await made.client.decide('s1', 'b', 'ungroup');
  assert.equal(made.client.getCurrent('s1'), 'b');
});

/* ── Menus ── */

test('actions: the row menu offers Review later, Back to review and Ungroup by state', async () => {
  const made = makeClient([entry('a', { group_id: 'g' }), entry('b', { group_id: 'g' }), entry('c', { status: 'later' })]);
  await made.client.refresh('s1');
  const view = model.buildSuggestedView(made.client.get('s1'));
  const menu = fakeMenu();
  const actions = createSuggestedActions({
    getClient: () => made.client, getSessionId: () => 's1', contextMenu: menu, storage: memoryStorage(),
    getRow: (id) => view.rows.find((row) => row.id === id) || null,
  });
  const labels = (id) => actions.rowMenuItems(view.rows.find((row) => row.id === id)).map((item) => item.label);
  assert.deepEqual(labels('a'), ['Review later', 'Ungroup']);
  assert.deepEqual(labels('c'), ['Back to review']);

  const dom = new JSDOM('<!doctype html><body><ul><li data-changes-item="s:a"><span id="t">A</span></li></ul></body>');
  const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 9 });
  dom.window.document.getElementById('t').dispatchEvent(event);
  assert.equal(actions.handleContextMenu(event), true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.shown[0].anchorX, 5);
  await menu.shown[0].items[1].action();
  assert.deepEqual(made.bridge.calls.at(-1), ['decide', 'a', 'ungroup', '']);
});

test('actions: the overflow menu hides explanations for every bar and says so', async () => {
  const storage = memoryStorage();
  const made = makeClient([entry('a')]);
  await made.client.refresh('s1');
  let notified = 0;
  made.client.subscribe(() => { notified += 1; });
  const menu = fakeMenu();
  const actions = createSuggestedActions({ getClient: () => made.client, getSessionId: () => 's1', contextMenu: menu, storage });
  const dom = new JSDOM('<!doctype html><body><button data-changes-overflow="true">⋯</button><div id="bar"></div></body>');
  assert.equal(actions.handleClick(dom.window.document.querySelector('button')), true);
  assert.equal(menu.shown[0].items[0].label, 'Hide explanations');
  menu.shown[0].items[0].action();
  assert.equal(actions.explanationsHidden(), true);
  assert.ok(notified >= 1, 'every host re-renders');
  const controller = createSuggestionBarController({ client: made.client, storage });
  const el = dom.window.document.getElementById('bar');
  controller.render(el, { sessionId: 's1', id: 'a', revision: 1 });
  assert.equal(el.querySelector('.suggestion-bar-explain'), null);
  actions.handleClick(dom.window.document.querySelector('button'));
  assert.equal(menu.shown[1].items[0].label, 'Show explanations');
});

/* ── View: trays, row menu, History of applied suggestions ── */

test('view: grouped rows render in a tray, right click opens the row menu, History lists applied suggestions', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>');
  const mountEl = dom.window.document.getElementById('mount');
  const made = makeClient([
    entry('old', { status: 'applied', applied: { at: '2026-10-05T00:00:01Z', change_set_id: 'cs9', before_hash: HASH } }),
    entry('a', { group_id: 'g' }),
    entry('b', { group_id: 'g' }),
    entry('c'),
  ]);
  await made.client.refresh('s1');
  const menu = fakeMenu();
  const openedDiffs = [];
  const view = createChangesView({
    host: 'dock',
    getSessionId: () => 's1',
    getWorkspaceId: () => 'ws1',
    getTurnViewModels: () => [],
    buildLedger: () => ({ changes: [], notices: [] }),
    getSuggestedClient: () => made.client,
    createBarController: (options) => createSuggestionBarController({ ...options, storage: null }),
    openChangeDiff: (change) => openedDiffs.push(change),
    contextMenu: menu,
    storage: memoryStorage(),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  view.mount(mountEl);
  const tray = mountEl.querySelector('.changes-group-tray');
  assert.ok(tray, 'a tray holds the group');
  assert.equal(tray.querySelector('.changes-group-caption').textContent, 'Grouped');
  assert.deepEqual(Array.from(tray.querySelectorAll('[data-changes-item]')).map((row) => row.getAttribute('data-changes-item')), ['s:a', 's:b']);
  assert.ok(mountEl.querySelector('[data-changes-overflow]'));

  const row = mountEl.querySelector('[data-changes-item="s:a"]');
  row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.deepEqual(menu.shown[0].items.map((item) => item.label), ['Review later', 'Ungroup']);
  row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
  assert.equal(menu.shown.length, 2, 'Shift+F10 opens it from the keyboard');

  click(dom, mountEl.querySelector('[data-changes-show-history]'));
  const block = mountEl.querySelector('[data-changes-turn-block="suggested:cs9"]');
  assert.ok(block, 'the applied suggestion has a History block');
  assert.match(block.textContent, /Accepted: Title old/);
  click(dom, block.querySelector('[data-changes-item]'));
  assert.equal(openedDiffs[0].changeId, 'suggested:old');
  assert.equal(openedDiffs[0].beforeHash, HASH);
  view.dispose();
});

test('model: the sidecar’s import facts show, and a suggested new file answers a missing import', () => {
  const facts = [{ kind: 'import_missing', name: '.util.money', target: 'src/util/money' }, { kind: 'import_removed', name: '.legacy', target: '' }];
  const alone = model.buildBarModel(listOf([entry('a', { facts })]), 'a');
  assert.deepEqual(alone.facts.map((fact) => [fact.kind, fact.warn === true]), [['import_missing', true], ['import_removed', false]]);
  assert.match(buildBarHtml(alone), /suggestion-bar-fact--warn/);
  const answered = model.buildBarModel(listOf([entry('c', { kind: 'create', path: 'src/util/money.py' }), entry('a', { facts })]), 'a');
  assert.deepEqual(answered.facts.map((fact) => fact.text), ['Removes the import of .legacy.']);
});
