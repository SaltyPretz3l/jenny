'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSlashAutocomplete } = require('../renderer/chat/renderer-slash-autocomplete');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const composerState = require('../renderer/chat/renderer-composer-v2-state');

function buildHarness() {
  const dom = new JSDOM('<!doctype html><html><body><div id="composerWrap"><textarea id="chatInput"></textarea></div></body></html>');
  const doc = dom.window.document;
  const input = doc.getElementById('chatInput');
  const state = { currentSessionId: 's1', ui: {}, composerSessionState: new Map([['s1', { generation: 1 }]]) };
  const registry = createSlashCommandRegistry({ state });
  registry.register('/help', 'List commands', () => {}, { requiresSession: false });
  registry.register('/context', 'Show context', () => {});
  registry.register('/verify', 'Check evidence', null, {
    action: 'attach', skill: { id: 'bundled/verify', name: 'Verifier', scope: 'bundled', command: 'verify' },
  });
  registry.register('/mermaid', 'Draw a diagram', null, {
    action: 'attach', skill: { id: 'bundled/mermaid', name: 'Mermaid', scope: 'bundled', command: 'mermaid' },
  });
  const accepted = [];
  const controller = createSlashAutocomplete({
    document: doc,
    registry,
    getMountEl: () => doc.getElementById('composerWrap'),
    onAccept(entry, prompt) {
      const receipt = registry.execute(prompt);
      if (receipt.status === 'attached') {
        composerState.setPendingSkillInvocation(state, receipt.skill);
        input.value = receipt.prompt;
      }
      accepted.push({ entry, prompt });
    },
  });
  controller.attach();
  return { dom, doc, input, state, registry, accepted, controller };
}

function type(harness, value) {
  harness.input.value = value;
  harness.input.selectionStart = value.length;
  harness.input.selectionEnd = value.length;
  harness.input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

function key(harness, value) {
  harness.input.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: value, bubbles: true, cancelable: true,
  }));
}

test('slash autocomplete triggers only when slash is the first input character', () => {
  const harness = buildHarness();
  type(harness, 'hello /ver');
  assert.equal(harness.controller.isOpen(), false);
  type(harness, ' /ver');
  assert.equal(harness.controller.isOpen(), false);
  type(harness, '/ver');
  assert.equal(harness.controller.isOpen(), true);
  assert.equal(harness.doc.querySelectorAll('[role="option"]').length, 1);
  harness.controller.dispose();
});

test('keyboard navigation accepts a skill, strips the slash token, and sets pending invocation', () => {
  const harness = buildHarness();
  type(harness, '/');
  const options = [...harness.doc.querySelectorAll('[role="option"]')];
  assert.match(options[0].textContent, /\/verify/);
  assert.match(options[1].textContent, /\/mermaid/);
  key(harness, 'ArrowDown');
  key(harness, 'Enter');
  assert.equal(harness.accepted[0].entry.name, '/mermaid');
  assert.equal(harness.input.value, '');
  assert.deepEqual(composerState.getPendingSkillInvocation(harness.state), {
    id: 'bundled/mermaid', name: 'Mermaid', scope: 'bundled', command: 'mermaid',
  });
  assert.equal(harness.controller.isOpen(), false);
  harness.controller.dispose();
});

test('no matches render one non-interactive status row and Escape dismisses results', () => {
  const harness = buildHarness();
  type(harness, '/zzzz');
  assert.equal(harness.doc.querySelectorAll('[role="option"]').length, 0);
  assert.equal(harness.doc.querySelector('.slash-autocomplete-empty').textContent, 'No matching command or skill');
  key(harness, 'Escape');
  assert.equal(harness.controller.isOpen(), false);
  harness.controller.dispose();
});

test('a mouse click on a row accepts it even though mousedown blurred the input first', () => {
  const harness = buildHarness();
  type(harness, '/mer');
  assert.equal(harness.controller.isOpen(), true);
  const row = harness.doc.querySelector('[data-slash-index]');
  assert.ok(row, 'a row rendered');
  // Real browsers: pointerdown (capture) → default action blurs the textarea → click.
  row.dispatchEvent(new harness.dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  harness.input.dispatchEvent(new harness.dom.window.Event('blur'));
  assert.equal(harness.controller.isOpen(), true, 'blur alone must not hide the popover');
  row.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(harness.accepted.length, 1);
  assert.equal(harness.accepted[0].entry.name, '/mermaid');
  assert.equal(harness.controller.isOpen(), false);
});

test('Enter and Tab pass through to the composer when nothing is acceptable', () => {
  const harness = buildHarness();
  type(harness, '/deploy');
  assert.equal(harness.controller.isOpen(), true);
  const enter = new harness.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  harness.input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false, 'the composer Enter-to-send handler must still see the key');
  assert.equal(harness.controller.isOpen(), false);
  assert.equal(harness.accepted.length, 0);
});

test('the scorer is resolved at create time from the palette utils global', () => {
  const dom = new JSDOM('<!doctype html><html><body><textarea id="chatInput"></textarea></body></html>');
  const doc = dom.window.document;
  const calls = [];
  const previous = globalThis.rendererCommandPaletteUtils;
  globalThis.rendererCommandPaletteUtils = { scoreMatch: (value, query) => { calls.push(query); return { score: 1 }; } };
  try {
    const registry = createSlashCommandRegistry({ state: { currentSessionId: 's1' } });
    registry.register('/help', 'List commands', () => {}, { requiresSession: false });
    const controller = createSlashAutocomplete({ document: doc, registry, getMountEl: () => doc.body });
    controller.attach();
    const input = doc.getElementById('chatInput');
    input.value = '/he';
    input.selectionStart = input.selectionEnd = 3;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.deepEqual(calls, ['he']);
    controller.dispose();
  } finally {
    if (previous === undefined) delete globalThis.rendererCommandPaletteUtils;
    else globalThis.rendererCommandPaletteUtils = previous;
  }
});
