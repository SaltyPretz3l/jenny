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

function mountControl(t) {
  const dom = new JSDOM('<!doctype html><body><div class="cluster"></div><div id="chatTimeline"></div></body>');
  const { window } = dom;
  const saved = { build: globalThis.inventoryActionButton, menu: globalThis.inventoryContextMenu, controller: globalThis.rendererTranscriptViewController };
  globalThis.inventoryActionButton = require('../renderer/inventory/action-button.js');
  globalThis.inventoryContextMenu = require('../renderer/inventory/context-menu.js');
  globalThis.rendererTranscriptViewController = { getView: () => 'thinking', setView() {} };
  t.after(() => {
    globalThis.inventoryContextMenu.hide({ restoreFocus: false });
    globalThis.inventoryActionButton = saved.build;
    globalThis.inventoryContextMenu = saved.menu;
    globalThis.rendererTranscriptViewController = saved.controller;
    window.close();
  });
  const { mountTranscriptViewControl } = require('../renderer/chat/renderer-transcript-view-utils.js');
  const control = mountTranscriptViewControl({
    cluster: window.document.querySelector('.cluster'),
    chatTimeline: window.document.getElementById('chatTimeline'),
    getSessionId: () => 's1',
    registerListener: (target, name, handler, options) => target.addEventListener(name, handler, options),
  });
  const menuEl = () => window.document.querySelector('.inv-context-menu');
  return { window, button: control.button, menuEl };
}

test('the view control keeps aria-expanded true across repeated keyboard activation', (t) => {
  const { button, menuEl } = mountControl(t);
  button.click(); // Enter/Space activation: a click with detail 0
  assert.ok(menuEl());
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  button.click();
  assert.ok(menuEl(), 'keyboard activation (re)opens the menu');
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'the replaced menu\'s onHide does not win');
});

test('a pointer click on the open view control closes its menu', (t) => {
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

test('the view control names itself once, from the current view', (t) => {
  const { button } = mountControl(t);
  assert.equal(button.getAttribute('aria-label'), 'Transcript view: Thinking');
  assert.equal(button.title, 'Transcript view: Thinking');
  assert.equal(button.dataset.transcriptView, 'thinking');
});

test('the view control refreshes its visible tooltip when the rendered view changes', (t) => {
  const { window, button } = mountControl(t);
  const savedTooltip = globalThis.inventoryTooltip;
  const Tooltip = require('../renderer/inventory/tooltip.js');
  globalThis.inventoryTooltip = Tooltip;
  t.after(() => {
    Tooltip.hide({ force: true });
    globalThis.inventoryTooltip = savedTooltip;
  });

  button.setAttribute('data-tooltip', 'Transcript view: Thinking');
  Tooltip.show(button, 'Transcript view: Thinking');
  globalThis.rendererTranscriptViewController.getView = () => 'answers';
  window.document.getElementById('chatTimeline').dispatchEvent(new window.Event('transcript-view-rendered'));

  assert.equal(button.getAttribute('data-tooltip'), 'Transcript view: Answers');
  const tooltip = window.document.querySelector('[role="tooltip"]');
  assert.equal(tooltip.textContent, 'Transcript view: Answers');
  assert.equal(tooltip.getAttribute('aria-hidden'), 'false');
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

/* Two panes' clusters, one global width; applyAppearance mimics applyAppearancePreferences
   (writes <html data-chat-width> and returns the preferences now in effect). refuse: the store
   refuses the write, so the old preferences come back. */
function mountWideToggle(t, { initial = 'narrow', refuse = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="cluster"><button data-transcript-view-toggle="true"></button></div><div class="cluster"></div></body></html>');
  const { window } = dom;
  const doc = window.document;
  doc.documentElement.dataset.chatWidth = initial;
  const saved = globalThis.inventoryActionButton;
  globalThis.inventoryActionButton = require('../renderer/inventory/action-button.js');
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
  const register = (target, name, handler, options) => target.addEventListener(name, handler, options);
  const buttons = [...doc.querySelectorAll('.cluster')].map((cluster) => utils.mountChatWidthToggle({ cluster, registerListener: register }).button);
  t.after(() => { toggle.dispose(); globalThis.inventoryActionButton = saved; window.close(); });
  // What a Settings or relay change does: the preferences and the root attribute together.
  const setWidth = (id) => { appearance = { ...appearance, chatWidthId: id }; doc.documentElement.dataset.chatWidth = id; };
  return { window, doc, toggle, buttons, applied, getAppearance: () => appearance, setWidth };
}

test('the Wide button sits after the view control, names its shortcut and toggles through the shell controller', (t) => {
  const { doc, buttons, applied, getAppearance } = mountWideToggle(t);
  const [first, second] = buttons;
  assert.equal(first.previousElementSibling.hasAttribute('data-transcript-view-toggle'), true);
  assert.equal(first.getAttribute('aria-label'), 'Wide transcript');
  assert.equal(first.title, 'Wide transcript (Ctrl+Alt+W)');
  assert.equal(first.getAttribute('aria-pressed'), 'false');

  first.click();
  assert.equal(getAppearance().chatWidthId, 'full');
  assert.equal(getAppearance().paletteId, 'slate', 'the other appearance axes ride along unchanged');
  assert.deepEqual(applied, ['full', 'repaint']);
  assert.equal(first.getAttribute('aria-pressed'), 'true');
  assert.equal(second.getAttribute('aria-pressed'), 'true', 'every pane shows the one global state');

  second.click();
  assert.equal(getAppearance().chatWidthId, 'narrow', 'off returns to the width chosen before');
  assert.equal(doc.querySelectorAll('[data-chat-width-toggle]').length, 2);
});

test('a width change from Settings or the relay repaints every Wide button, and dispose detaches', async (t) => {
  const { window, doc, toggle, buttons, applied } = mountWideToggle(t, { initial: 'standard' });
  doc.documentElement.dataset.chatWidth = 'full';
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-pressed')), ['true', 'true']);

  toggle.dispose();
  buttons[0].click();
  assert.deepEqual(applied, [], 'a disposed controller ignores the button');
});

test('off returns to the last non-Wide width chosen anywhere, not a stale one', async (t) => {
  const { window, toggle, getAppearance, setWidth } = mountWideToggle(t, { initial: 'narrow' });
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

test('a refused save reports the width in effect and keeps the button unpressed', (t) => {
  const { toggle, buttons, getAppearance } = mountWideToggle(t, { refuse: true });
  assert.equal(toggle.toggle('shortcut'), 'narrow');
  assert.equal(getAppearance().chatWidthId, 'narrow');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
});
