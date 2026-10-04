'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const autocompleteUtils = require('../renderer/chat/renderer-slash-autocomplete');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const { createSendSlashDispatch } = require('../renderer/chat/renderer-skill-slash-commands');
const composerState = require('../renderer/chat/renderer-composer-v2-state');

function harness(t) {
  const dom = new JSDOM('<textarea id="chatInput"></textarea><button id="composerTerminalShortcut">/commands</button>');
  const doc = dom.window.document;
  const input = doc.getElementById('chatInput');
  const button = doc.getElementById('composerTerminalShortcut');
  const state = { currentSessionId: 's1', ui: { activeView: 'chat' }, composerSessionState: new Map([['s1', { generation: 1 }]]) };
  let runs = 0, selections = 0, submits = 0, inputEvents = 0;
  const registry = createSlashCommandRegistry({ state });
  registry.register('/help', 'List commands', () => { runs++; }, { requiresSession: false });
  registry.register('/context', 'Show context', () => { runs++; });
  registry.register('/verify', 'Check context evidence', null, { action: 'attach', skill: { id: 'bundled/verify', name: 'Verifier', command: 'verify', scope: 'bundled' } });
  let controller;
  const dispatch = createSendSlashDispatch({ state, registry, chatInput: input,
    autocompleteUtils: { createSlashAutocomplete(options) { controller = autocompleteUtils.createSlashAutocomplete(options); return controller; } },
    selectSlashCommand() { selections++; }, submitPrompt() { submits++; }
  });
  let sends = 0;
  input.addEventListener('input', () => { inputEvents++; });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.defaultPrevented && !event.shiftKey && !event.isComposing) { sends++; dispatch.dispatch(input.value, {}); }
  });
  function type(value, target = input, caret = value.length) {
    target.value = value;
    if (target === input) target.setSelectionRange(caret, caret);
    target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  function key(key, target = input, extra = {}) {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  }
  t.after(() => { dispatch.dispose(); dom.window.close(); });
  return { dom, doc, input, button, state, registry, controller, dispatch, type, key,
    counts: () => ({ runs, selections, submits, sends, inputEvents }) };
}

test('bare slash includes full live catalog and exact/prefix names outrank descriptions', (t) => {
  const h = harness(t);
  for (let i = 0; i < 14; i++) h.registry.register('/skill' + i, 'context helper', null, { action: 'attach' });
  h.type('/');
  assert.equal(h.doc.querySelectorAll('[role="option"]').length, 17);
  h.type('/CONTEXT');
  assert.match(h.doc.querySelector('[role="option"]').textContent, /^\/context/);
  h.type('/con');
  assert.match(h.doc.querySelector('[role="option"]').textContent, /^\/context/);
  h.type('/Verifier');
  assert.match(h.doc.querySelector('[role="option"]').textContent, /^\/verify/);
});

for (const entryPoint of ['inline', 'button']) {
  for (const acceptance of ['Enter', 'Tab', 'mouse']) {
    test(`${entryPoint} ${acceptance} completes only; subsequent explicit Enter executes once`, async (t) => {
      const h = harness(t);
      let target = h.input;
      if (entryPoint === 'button') {
        h.type('draft arguments');
        let legacy = 0;
        h.button.addEventListener('click', () => { legacy++; });
        h.button.click();
        assert.equal(legacy, 0);
        assert.equal(h.input.value, 'draft arguments');
        target = h.doc.querySelector('.slash-autocomplete-search');
        assert.equal(h.doc.activeElement, target);
        h.type('context', target);
      } else h.type('/con');
      if (acceptance === 'mouse') h.doc.querySelector('[role="option"]').click();
      else h.key(acceptance, target);
      assert.equal(h.input.value, entryPoint === 'button' ? '/context draft arguments' : '/context ');
      assert.equal(h.controller.isOpen(), false);
      assert.equal(h.doc.activeElement, h.input);
      assert.equal(h.counts().runs + h.counts().selections + h.counts().submits + h.counts().sends, 0);
      assert.ok(h.counts().inputEvents >= 2, 'completion emits input for persistence/layout');
      h.key('Enter');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.counts().runs, 1);
      assert.equal(h.counts().sends, 1);
    });
  }
}

test('skill selection neither attaches nor submits until explicit send', (t) => {
  const h = harness(t);
  h.type('/ver'); h.key('Tab');
  assert.equal(h.input.value, '/verify ');
  assert.equal(composerState.getPendingSkillInvocation(h.state), null);
  assert.equal(h.counts().submits, 0);
  h.key('Enter');
  assert.equal(composerState.getPendingSkillInvocation(h.state).command, 'verify');
});

test('caret completion preserves arguments and does not trigger in prose or arguments', (t) => {
  const h = harness(t);
  for (const value of ['hello /ver', ' /ver', '/verify arguments', '@file']) {
    h.type(value); assert.equal(h.controller.isOpen(), false);
  }
  h.type('/con  argument\nnext', h.input, 4);
  assert.equal(h.controller.isOpen(), true);
  h.key('Tab');
  assert.equal(h.input.value, '/context  argument\nnext');
  assert.equal(h.input.selectionStart, 8);
});

test('empty and unavailable results cannot send or complete; Escape restores button focus', (t) => {
  const h = harness(t);
  h.type('/zzzz');
  assert.equal(h.doc.querySelectorAll('[role="option"]').length, 0);
  assert.equal(h.key('Enter').defaultPrevented, true);
  assert.equal(h.counts().sends, 0);
  h.key('Escape');
  h.state.currentSessionId = '';
  h.button.click();
  const search = h.doc.querySelector('input[type="search"]');
  h.type('context', search);
  assert.equal(h.doc.querySelector('[role="option"]').getAttribute('aria-disabled'), 'true');
  assert.match(h.doc.querySelector('[role="option"]').textContent, /Start a conversation/);
  h.key('Tab', search);
  assert.equal(h.input.value, '/zzzz');
  h.key('Escape', search);
  assert.equal(h.doc.activeElement, h.button);
});

test('modifiers, Shift+Enter and IME are not captured by menu', (t) => {
  const h = harness(t); h.type('/con');
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    // Target-level sender is excluded here; verify the controller key policy alone.
    assert.equal(h.key('Tab', h.input, extra).defaultPrevented, false);
  }
  assert.equal(h.key('Enter', h.input, { shiftKey: true }).defaultPrevented, false);
  assert.equal(h.input.value, '/con');
});

test('open button menu refreshes skills and closes on view changes without reopening', async (t) => {
  const h = harness(t);
  h.type('keep my draft'); h.button.click();
  await h.dispatch.refreshSkills({ scopes: [{ scope: 'bundled', enabled: true, entries: [
    { id: 'bundled/live', name: 'Live Skill', command: 'live', description: 'Live update', enabled: true }
  ] }] });
  assert.match(h.doc.querySelector('[role="listbox"]').textContent, /Live Skill/);
  h.state.ui.activeView = 'settings';
  await new Promise((resolve) => h.dom.window.setTimeout(resolve, 200));
  assert.equal(h.controller.isOpen(), false);
  assert.equal(h.input.value, 'keep my draft');
});

test('returning focus to the draft dismisses button search without changing text', (t) => {
  const h = harness(t); h.type('keep this'); h.button.click();
  assert.equal(h.controller.isOpen(), true);
  h.input.focus();
  assert.equal(h.controller.isOpen(), false);
  assert.equal(h.input.value, 'keep this');
});

test('small viewport clamps menu width and duplicate disposal restores attributes', (t) => {
  const h = harness(t);
  Object.defineProperty(h.dom.window, 'innerWidth', { value: 300 });
  Object.defineProperty(h.dom.window, 'innerHeight', { value: 240 });
  h.input.getBoundingClientRect = () => ({ top: 200, bottom: 225, left: 280, width: 500 });
  h.type('/');
  const menu = h.doc.querySelector('.slash-autocomplete-popover');
  assert.equal(menu.style.width, '284px');
  assert.equal(menu.style.left, '8px');
  assert.equal(menu.style.maxHeight, '186px');
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.input.getAttribute('aria-expanded'), null);
});

test('live registry updates, session fencing, ARIA and teardown', (t) => {
  const h = harness(t); h.type('/');
  h.registry.register('/new', 'New command', () => {});
  assert.equal(h.doc.querySelectorAll('[role="option"]').length, 4);
  h.registry.unregister('/new');
  assert.equal(h.doc.querySelectorAll('[role="option"]').length, 3);
  assert.equal(h.input.getAttribute('aria-expanded'), 'true');
  assert.ok(h.doc.getElementById(h.input.getAttribute('aria-activedescendant')));
  h.state.currentSessionId = 's2'; h.key('Tab');
  assert.equal(h.controller.isOpen(), false);
  assert.equal(h.input.value, '/');
  h.controller.dispose();
  assert.equal(h.doc.querySelector('.slash-autocomplete-popover'), null);
  assert.equal(h.input.getAttribute('role'), null);
});

// Split view gate §D side finding: typing "/" in pane 1 showed no menu (the
// command still ran on Enter). Each pane's send dispatch builds a menu; pane
// 1's bound #chatInput (pane 0's) instead of its own textarea. It now binds
// its own composer and session, anchors there, and leaves pane 0's alone.
test('split view: a second pane gets its own menu on its textarea, keyed to its session, disposed with it', (t) => {
  const dom = new JSDOM('<textarea id="chatInput"></textarea><button id="composerTerminalShortcut">/commands</button>'
    + '<section class="chat-pane" data-pane-id="1"><textarea class="composer-input" data-chat-node="chatInput"></textarea></section>');
  const doc = dom.window.document;
  const input0 = doc.getElementById('chatInput');
  const input1 = doc.querySelector('[data-chat-node="chatInput"]');
  const state = { currentSessionId: 's2', ui: { activeView: 'chat' }, composerSessionState: new Map() };
  const registry0 = createSlashCommandRegistry({ state });
  registry0.register('/help', 'List commands', () => {}, { requiresSession: false });
  const registry1 = createSlashCommandRegistry({ state });
  registry1.register('/help', 'List commands', () => {}, { requiresSession: false });
  registry1.register('/context', 'Show context', () => {}, { requiresSession: false });
  const menus = [];
  const autocomplete = { createSlashAutocomplete(options) { const menu = autocompleteUtils.createSlashAutocomplete(options); menus.push(menu); return menu; } };
  const pane0 = createSendSlashDispatch({ state, registry: registry0, chatInput: input0, autocompleteUtils: autocomplete });
  const pane1 = createSendSlashDispatch({ state, registry: registry1, chatInput: input1, autocompleteUtils: autocomplete,
    sessionContext: { paneId: 1, getSessionId: () => 's2' } });
  t.after(() => { pane0.dispose(); dom.window.close(); });
  input1.getBoundingClientRect = () => ({ left: 500, top: 400, bottom: 440, right: 800, width: 300, height: 40 });
  const type = (target, value) => {
    target.value = value;
    target.setSelectionRange(value.length, value.length);
    target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  type(input1, '/');
  assert.equal(input1.getAttribute('role'), 'combobox', 'pane 1 textarea is the combobox');
  assert.equal(input1.getAttribute('aria-expanded'), 'true', 'typing "/" in pane 1 opens its menu');
  assert.equal(input0.getAttribute('aria-expanded'), 'false', 'pane 0 menu stays closed');
  assert.notEqual(input1.getAttribute('aria-controls'), input0.getAttribute('aria-controls'), 'each pane has its own listbox');
  const listbox1 = doc.getElementById(input1.getAttribute('aria-controls'));
  assert.deepEqual([...listbox1.querySelectorAll('[role="option"] .slash-autocomplete-command')].map((node) => node.textContent), ['/help', '/context'],
    'pane 1 lists its own registry');
  const popover1 = listbox1.closest('.slash-autocomplete-popover');
  assert.equal(popover1.style.left, '500px', 'anchored to pane 1\'s composer');

  state.currentSessionId = 's1'; // focus moved to pane 0 while pane 1's menu is open
  type(input1, '/c');
  assert.equal(input1.getAttribute('aria-expanded'), 'true', 'pane 1 fences on its own session, not the focused mirror');

  let legacy = 0;
  doc.getElementById('composerTerminalShortcut').addEventListener('click', () => { legacy += 1; });
  input1.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  doc.getElementById('composerTerminalShortcut').click();
  assert.equal(legacy, 0, 'the Commands button is claimed once, by pane 0');
  assert.equal(input0.getAttribute('aria-expanded'), 'false');
  assert.equal(input1.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.querySelectorAll('.slash-autocomplete-popover:not(.hidden)').length, 1, 'one menu open: pane 0\'s button menu');

  pane1.dispose();
  assert.equal(input1.hasAttribute('role'), false, 'pane 1 close restores its textarea');
  assert.equal(popover1.isConnected, false, 'and removes its menu');
  assert.equal(input0.getAttribute('role'), 'combobox', 'pane 0 keeps its menu');
});

// Gate §D follow-up: the popover's surface named an undefined token (--bg-elevated), so it
// rendered see-through over the transcript in either pane. Every var() without a fallback in
// the composer v2 sheet must name a custom property some stylesheet defines.
test('slash popover: an opaque popover surface, and no undefined tokens in the composer v2 sheet', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const stylesDir = path.join(__dirname, '..', 'styles');
  const all = fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(stylesDir, f), 'utf8')).join('\n');
  const defined = new Set([...all.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const sheet = fs.readFileSync(path.join(stylesDir, 'chat-composer-v2.css'), 'utf8');
  const undefinedTokens = [...new Set([...sheet.matchAll(/var\((--[\w-]+)\s*\)/g)].map((m) => m[1]))].filter((name) => !defined.has(name));
  assert.deepEqual(undefinedTokens, []);
  const popoverRule = sheet.match(/\.slash-autocomplete-popover\s*\{([^}]*)\}/)[1];
  assert.match(popoverRule, /background:\s*var\(--surface-popover-background\)/);
});
