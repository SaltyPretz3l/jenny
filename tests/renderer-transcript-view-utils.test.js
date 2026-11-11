'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const selectField = require('../renderer/inventory/select-field.js');
const {
  TRANSCRIPT_VIEWS,
  DEFAULT_TRANSCRIPT_VIEW,
  normalizeTranscriptView,
  resolveTranscriptView,
  cycleTranscriptView,
} = require('../renderer/chat/renderer-transcript-view-utils.js');

test('the view vocabulary is frozen with thinking as the default', () => {
  assert.deepEqual([...TRANSCRIPT_VIEWS], ['answers', 'thinking', 'everything']);
  assert.equal(Object.isFrozen(TRANSCRIPT_VIEWS), true);
  assert.equal(DEFAULT_TRANSCRIPT_VIEW, 'thinking');
});

test('normalizeTranscriptView trims, lower-cases, and falls back', () => {
  assert.equal(normalizeTranscriptView(' Answers '), 'answers');
  assert.equal(normalizeTranscriptView('EVERYTHING'), 'everything');
  assert.equal(normalizeTranscriptView('thinking'), 'thinking');
  assert.equal(normalizeTranscriptView('verbose'), 'thinking');
  assert.equal(normalizeTranscriptView(undefined), 'thinking');
  assert.equal(normalizeTranscriptView(null, 'answers'), 'answers');
  assert.equal(normalizeTranscriptView(42, ''), '');
});

test('resolveTranscriptView prefers an explicit entry, then the default, then thinking', () => {
  const state = {
    transcriptViewDefault: 'answers',
    ui: { transcriptViewBySession: new Map([['s1', 'everything'], ['s2', 'bogus'], ['7', 'answers']]) },
  };
  assert.equal(resolveTranscriptView(state, 's1'), 'everything', 'explicit beats default');
  assert.equal(resolveTranscriptView(state, 's2'), 'answers', 'invalid explicit falls through to the default');
  assert.equal(resolveTranscriptView(state, 's3'), 'answers', 'missing explicit follows the default');
  assert.equal(resolveTranscriptView(state, 7), 'answers', 'session ids are compared as strings');
  assert.equal(resolveTranscriptView({ ...state, transcriptViewDefault: 'nope' }, 's3'), 'thinking');
  assert.equal(resolveTranscriptView({ transcriptViewDefault: 'everything' }, 's1'), 'everything', 'absent map');
  assert.equal(resolveTranscriptView({}, 's1'), 'thinking');
  assert.equal(resolveTranscriptView(null, 's1'), 'thinking');
  assert.equal(resolveTranscriptView(undefined), 'thinking');
});

test('cycleTranscriptView walks answers -> thinking -> everything and wraps', () => {
  assert.equal(cycleTranscriptView('answers'), 'thinking');
  assert.equal(cycleTranscriptView('thinking'), 'everything');
  assert.equal(cycleTranscriptView('everything'), 'answers');
  assert.equal(cycleTranscriptView('garbage'), 'everything', 'invalid input cycles from thinking');
  assert.equal(cycleTranscriptView(undefined), 'everything');
});

test('the Electron chatUi normalizer keeps the same vocabulary and default', () => {
  const { normalizeChatUiSettings } = require('../services/shell-config-zoom-state.js');
  assert.equal(normalizeChatUiSettings({}).transcriptViewDefault, DEFAULT_TRANSCRIPT_VIEW);
  for (const view of TRANSCRIPT_VIEWS) {
    assert.equal(normalizeChatUiSettings({ transcriptViewDefault: ` ${view.toUpperCase()} ` }).transcriptViewDefault, view);
  }
  assert.equal(normalizeChatUiSettings({ transcript_view_default: 'answers' }).transcriptViewDefault, 'answers');
  assert.equal(normalizeChatUiSettings({ transcriptViewDefault: 'loud' }).transcriptViewDefault, 'thinking');
  assert.equal(normalizeChatUiSettings({ zoomPercent: 110, transcriptViewDefault: 'everything' }).zoomPercent, 110);
});


/* Row 115 slice 2a: the More (three dots) button. Its menu holds the three views, Wide transcript,
   Activity, and (while the bar is compact) Tasks and Notes. */

const CLUSTER_MARKUP = '<div class="chat-view"><div class="chat-pane" id="pane"><div class="cluster" id="cluster" data-chat-node="chatTimelineUtilityCluster">'
  + '<button id="chatTimelineTasksToggle">Tasks</button><button id="chatTimelineNotesToggle">Notes</button>'
  + '<button data-activity-open id="activity" aria-pressed="false" hidden></button>'
  + '</div><div id="chatTimeline"></div></div></div>';

/* A pane whose width the test controls; ResizeObserver is a recorder the test fires by hand. */
function mountControl(t, { markup = CLUSTER_MARKUP, paneClass = '', width = 900, signal, chatWidth, promptJump } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`);
  const { window } = dom;
  const doc = window.document;
  if (chatWidth) doc.documentElement.dataset.chatWidth = chatWidth;
  const pane = doc.getElementById('pane');
  if (paneClass) pane.className += ` ${paneClass}`;
  const size = { width };
  pane.getBoundingClientRect = () => ({ width: size.width });
  const observers = [];
  window.ResizeObserver = class { constructor(callback) { this.callback = callback; this.observed = []; this.disconnected = false; observers.push(this); } observe(node) { this.observed.push(node); } disconnect() { this.disconnected = true; } };
  const saved = { build: globalThis.inventoryActionButton, menu: globalThis.inventoryContextMenu, controller: globalThis.rendererTranscriptViewController };
  globalThis.inventoryActionButton = require('../renderer/inventory/action-button.js');
  globalThis.inventoryContextMenu = require('../renderer/inventory/context-menu.js');
  const setViewCalls = [];
  globalThis.rendererTranscriptViewController = { getView: () => 'thinking', setView: (...args) => setViewCalls.push(args) };
  t.after(() => {
    globalThis.inventoryContextMenu.hide({ restoreFocus: false });
    globalThis.inventoryActionButton = saved.build;
    globalThis.inventoryContextMenu = saved.menu;
    globalThis.rendererTranscriptViewController = saved.controller;
    window.close();
  });
  const { mountTranscriptViewControl } = require('../renderer/chat/renderer-transcript-view-utils.js');
  const cluster = doc.getElementById('cluster');
  const control = mountTranscriptViewControl({
    cluster, getSessionId: () => 's1', signal, promptJump,
    registerListener: (target, name, handler, options) => target.addEventListener(name, handler, options),
  });
  const menuEl = () => doc.querySelector('.inv-context-menu');
  const rows = () => [...(menuEl()?.children || [])].map((row) => (row.getAttribute('role') === 'separator' ? '---'
    : (row.querySelector('.inv-context-menu-text > span') || row.querySelector('span')).textContent));
  const fit = (next) => { size.width = next; observers.forEach((observer) => observer.callback()); };
  return { window, doc, cluster, button: control.button, control, menuEl, rows, setViewCalls, observers, fit };
}

test('Back to prompt leads the More menu and jumps to this pane\'s latest prompt', (t) => {
  const jumps = [];
  const { button, menuEl, rows } = mountControl(t, { promptJump: { targetId: () => 'u7', jump: (id) => jumps.push(id) } });
  button.click();
  assert.deepEqual(rows().slice(0, 2), ['Back to prompt', '---']);
  menuEl().querySelector('.inv-context-menu-item').click();
  assert.deepEqual(jumps, ['u7']);
});

test('with no prompt yet, Back to prompt stays listed but cannot be pressed', (t) => {
  const jumps = [];
  const { button, menuEl, rows } = mountControl(t, { promptJump: { targetId: () => '', jump: (id) => jumps.push(id) } });
  button.click();
  assert.equal(rows()[0], 'Back to prompt');
  assert.equal(menuEl().querySelector('.inv-context-menu-item').disabled, true);
  assert.deepEqual(jumps, []);
});

test('More is one three-dot menu button that names itself once', (t) => {
  const { button, cluster } = mountControl(t);
  assert.equal(button.getAttribute('aria-label'), 'More');
  assert.equal(button.title, 'More');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.querySelectorAll('svg').length, 1, 'one static glyph, whatever the view');
  assert.equal(cluster.querySelectorAll('[data-transcript-view-toggle]').length, 1);
});

test('More keeps aria-expanded true across repeated keyboard activation', (t) => {
  const { button, menuEl } = mountControl(t);
  button.click(); // Enter/Space activation: a click with detail 0
  assert.ok(menuEl());
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  button.click();
  assert.ok(menuEl(), 'keyboard activation (re)opens the menu');
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'the replaced menu\'s onHide does not win');
});

test('a pointer click on the open More closes its menu and focus returns to it', (t) => {
  const { window, button, menuEl } = mountControl(t);
  const pointer = (type) => button.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 }));
  pointer('mousedown'); pointer('click');
  assert.ok(menuEl(), 'opened');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  pointer('mousedown'); pointer('click');
  assert.equal(menuEl(), null, 'the trigger closes its own menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(window.document.activeElement, button, 'focus returns to the trigger');
  pointer('mousedown'); pointer('click');
  assert.ok(menuEl(), 'and opens it again');
});

test('Escape and an outside click close the menu and return focus to More', (t) => {
  const { window, doc, button, menuEl } = mountControl(t);
  button.click();
  doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.click();
  doc.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, button);
});

test('the menu lists the three views, a separator, then Wide transcript with its shortcut', (t) => {
  const { button, doc, rows, menuEl, setViewCalls } = mountControl(t);
  button.click();
  assert.deepEqual(rows(), ['Answers', 'Thinking', 'Everything', '---', 'Wide transcript'], 'Activity is hidden, Tasks and Notes stay on the roomy bar');
  const radios = [...menuEl().querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(radios.map((item) => item.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.deepEqual(radios.map((item) => item.getAttribute('data-access-key')), ['1', '2', '3']);
  assert.ok(radios[0].querySelector('.inv-context-menu-description')?.textContent.length > 0, 'each view explains itself');
  const wide = menuEl().querySelector('[role="menuitemcheckbox"]');
  assert.equal(wide.getAttribute('aria-checked'), 'false');
  assert.equal(wide.querySelector('.inv-context-menu-shortcut').textContent, 'Ctrl+Alt+W');
  radios[2].click();
  assert.deepEqual(setViewCalls, [['s1', 'everything', { source: 'control' }]]);
  assert.equal(menuEl(), null, 'picking closes the menu');
  assert.equal(doc.activeElement, button);
});

test('a number key picks a view while the menu is open', (t) => {
  const { window, button, setViewCalls } = mountControl(t);
  button.click();
  button.ownerDocument.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
  assert.deepEqual(setViewCalls.map((call) => call[1]), ['answers']);
});

test('the Wide item reads <html data-chat-width> and toggles the width through the shell controller', (t) => {
  const { window, doc, button, menuEl } = mountControl(t, { chatWidth: 'narrow' });
  const utils = require('../renderer/chat/renderer-transcript-view-utils.js');
  let appearance = { paletteId: 'slate', chatWidthId: 'narrow' };
  const toggle = utils.createChatWidthToggle({
    documentRef: doc,
    getAppearance: () => appearance,
    applyAppearance: (next) => { appearance = { ...next }; doc.documentElement.dataset.chatWidth = next.chatWidthId; return appearance; },
  });
  t.after(() => toggle.dispose());
  const open = () => { button.click(); return menuEl().querySelector('[role="menuitemcheckbox"]'); };
  const item = open();
  assert.equal(item.getAttribute('aria-checked'), 'false');
  item.click();
  assert.equal(appearance.chatWidthId, 'full', 'the Wide item turned Wide on');
  assert.equal(appearance.paletteId, 'slate', 'the other appearance axes ride along');
  assert.equal(open().getAttribute('aria-checked'), 'true', 'checked follows <html data-chat-width>');
  menuEl().querySelector('[role="menuitemcheckbox"]').click();
  assert.equal(appearance.chatWidthId, 'narrow', 'off returns to the width chosen before');
  assert.equal(window.document.activeElement, button);
});

test('Activity joins the menu only while its button is shown, and the row clicks that button', (t) => {
  const { doc, button, rows, menuEl } = mountControl(t);
  const activity = doc.getElementById('activity');
  const clicks = [];
  activity.addEventListener('click', () => clicks.push('activity'));
  button.click();
  assert.ok(!rows().includes('Activity'), 'hidden (the feature flag is off)');
  activity.hidden = false;
  button.click();
  assert.deepEqual(rows(), ['Answers', 'Thinking', 'Everything', '---', 'Wide transcript', 'Activity']);
  [...menuEl().querySelectorAll('[role="menuitem"]')].find((row) => row.textContent === 'Activity').click();
  assert.deepEqual(clicks, ['activity']);
});

test('a short bar moves Tasks and Notes into More, above the views, and each row clicks the real button', (t) => {
  const { doc, cluster, button, rows, menuEl, fit, observers } = mountControl(t, { width: 900 });
  assert.equal(cluster.hasAttribute('data-session-bar-compact'), false);
  assert.deepEqual(observers[0].observed.map((node) => node.id), ['pane', 'cluster'], 'the pane (split view) and the cluster (one pane) are watched');
  fit(559);
  assert.equal(cluster.getAttribute('data-session-bar-compact'), 'true', 'under 560px of room');
  button.click();
  assert.deepEqual(rows().slice(0, 5), ['Tasks', 'Notes', '---', 'Answers', 'Thinking']);
  const clicks = [];
  doc.getElementById('chatTimelineNotesToggle').addEventListener('click', () => clicks.push('notes'));
  doc.getElementById('chatTimelineTasksToggle').addEventListener('click', () => clicks.push('tasks'));
  menuEl().querySelectorAll('[role="menuitem"]')[1].click();
  assert.deepEqual(clicks, ['notes']);
  fit(560);
  assert.equal(cluster.hasAttribute('data-session-bar-compact'), false, '560px and up is roomy');
  button.click();
  assert.deepEqual(rows().slice(0, 2), ['Answers', 'Thinking']);
});

test('a button that is absent or hidden is not listed when compact (pane 1 has neither)', (t) => {
  const { doc, button, rows, fit } = mountControl(t);
  doc.getElementById('chatTimelineNotesToggle').hidden = true;
  fit(400);
  button.click();
  assert.deepEqual(rows().slice(0, 2), ['Tasks', '---']);
  doc.getElementById('chatTimelineTasksToggle').remove();
  button.click();
  assert.equal(rows()[0], 'Answers');
  assert.ok(!rows().includes('Tasks') && !rows().includes('Notes'));
});

test('opening the menu re-measures, so a missed resize cannot show a stale list', (t) => {
  const { cluster, button, rows, observers } = mountControl(t, { width: 900 });
  // Move the pane without the observer firing.
  cluster.closest('.chat-pane').getBoundingClientRect = () => ({ width: 300 });
  button.click();
  assert.equal(cluster.getAttribute('data-session-bar-compact'), 'true');
  assert.deepEqual(rows().slice(0, 2), ['Tasks', 'Notes']);
  assert.equal(observers.length, 1);
});

test('an unlaid-out pane (zero width) keeps the last answer instead of flipping to compact', (t) => {
  const { cluster, fit } = mountControl(t, { width: 900 });
  fit(0);
  assert.equal(cluster.hasAttribute('data-session-bar-compact'), false);
});

test('the width observer disposes with the bind signal and a rebind retires the old one', (t) => {
  const controller = new AbortController();
  const { observers, doc, cluster, button, rows } = mountControl(t, { signal: controller.signal });
  assert.equal(observers[0].disconnected, false);
  controller.abort();
  assert.equal(observers[0].disconnected, true);
  // A rebind mounts again on the same cluster: one More button, and the earlier observer stays retired.
  const { mountTranscriptViewControl } = require('../renderer/chat/renderer-transcript-view-utils.js');
  const second = mountTranscriptViewControl({ cluster, getSessionId: () => 's1', registerListener: (target, name, handler, options) => target.addEventListener(name, handler, options) });
  assert.equal(second.button, button);
  assert.equal(cluster.querySelectorAll('[data-transcript-view-toggle]').length, 1);
  assert.equal(observers.length, 2);
  second.dispose();
  assert.equal(observers[1].disconnected, true);
  assert.ok(doc.getElementById('pane') && rows);
});

test('the IDE dock pane keeps its floating column: no Wide item and no compact mode', (t) => {
  const { cluster, button, rows, fit, observers } = mountControl(t, { paneClass: 'ide-chat-dock-body', width: 300 });
  assert.equal(observers.length, 0, 'nothing to watch in the dock');
  fit(300);
  assert.equal(cluster.hasAttribute('data-session-bar-compact'), false);
  button.click();
  assert.deepEqual(rows(), ['Answers', 'Thinking', 'Everything']);
});

/* Row 92: the Wide transcript toggle (Chat width `full`). */

test('nextChatWidth turns Wide on from any width and returns to the remembered one', () => {
  const { nextChatWidth } = require('../renderer/chat/renderer-transcript-view-utils.js');
  assert.deepEqual(nextChatWidth('narrow', ''), { next: 'full', previous: 'narrow' });
  assert.deepEqual(nextChatWidth('standard', 'narrow'), { next: 'full', previous: 'standard' });
  assert.deepEqual(nextChatWidth('full', 'narrow'), { next: 'narrow', previous: 'narrow' });
  assert.deepEqual(nextChatWidth('full', ''), { next: 'standard', previous: 'standard' }, 'Wide at startup falls back to Standard');
  assert.deepEqual(nextChatWidth('full', 'full'), { next: 'standard', previous: 'standard' });
});

/* One global width; applyAppearance mimics applyAppearancePreferences (writes <html data-chat-width>
   and returns the preferences now in effect). refuse: the store refuses the write, so the old
   preferences come back. */
function mountWideController(t, { initial = 'narrow', refuse = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { window } = dom;
  const doc = window.document;
  doc.documentElement.dataset.chatWidth = initial;
  const utils = require('../renderer/chat/renderer-transcript-view-utils.js');
  let appearance = { paletteId: 'slate', chatWidthId: initial };
  const applied = [];
  const toggle = utils.createChatWidthToggle({
    documentRef: doc,
    getAppearance: () => appearance,
    applyAppearance: (next) => {
      applied.push(next.chatWidthId);
      if (refuse) return appearance;
      appearance = { ...next };
      doc.documentElement.dataset.chatWidth = next.chatWidthId;
      return appearance;
    },
    onApplied: () => applied.push('repaint'),
  });
  t.after(() => { toggle.dispose(); window.close(); });
  // What a Settings or relay change does: the preferences and the root attribute together.
  const setWidth = (id) => { appearance = { ...appearance, chatWidthId: id }; doc.documentElement.dataset.chatWidth = id; };
  const fire = () => doc.dispatchEvent(new window.CustomEvent(utils.CHAT_WIDTH_TOGGLE_EVENT, { bubbles: true, detail: { source: 'button' } }));
  return { window, doc, toggle, applied, getAppearance: () => appearance, setWidth, fire };
}

test('the width event toggles through the shell controller, and dispose detaches it', (t) => {
  const { toggle, applied, getAppearance, fire } = mountWideController(t);
  fire();
  assert.equal(getAppearance().chatWidthId, 'full');
  assert.equal(getAppearance().paletteId, 'slate', 'the other appearance axes ride along unchanged');
  assert.deepEqual(applied, ['full', 'repaint']);
  fire();
  assert.equal(getAppearance().chatWidthId, 'narrow', 'off returns to the width chosen before');
  toggle.dispose();
  applied.length = 0;
  fire();
  assert.deepEqual(applied, [], 'a disposed controller ignores the event');
});

test('off returns to the last non-Wide width chosen anywhere, not a stale one', async (t) => {
  const { window, toggle, getAppearance, setWidth } = mountWideController(t, { initial: 'narrow' });
  toggle.toggle('shortcut');
  assert.equal(getAppearance().chatWidthId, 'full');
  toggle.toggle('shortcut');
  assert.equal(getAppearance().chatWidthId, 'narrow');
  // Settings picks Standard, then Wide; the toggle then returns to Standard.
  setWidth('standard');
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  setWidth('full');
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.equal(toggle.toggle('shortcut'), 'standard');
});

test('a refused save reports the width in effect', (t) => {
  const { toggle, getAppearance } = mountWideController(t, { refuse: true });
  assert.equal(toggle.toggle('shortcut'), 'narrow');
  assert.equal(getAppearance().chatWidthId, 'narrow');
});
