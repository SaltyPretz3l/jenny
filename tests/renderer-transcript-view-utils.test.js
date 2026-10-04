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
