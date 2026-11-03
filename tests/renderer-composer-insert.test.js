'use strict';

// Coverage for renderer/chat/renderer-composer-insert.js - the seam that puts
// text at the caret of the chat composer without sending it.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const composerInsert = require('../renderer/chat/renderer-composer-insert');

// The default target is pane 0's composer through the shared pane-node seam.
globalThis.rendererBootstrapDom = require('../renderer/shell/renderer-bootstrap-dom');

function makeDom(value, attrs) {
  const dom = new JSDOM('<!doctype html><body><textarea id="chatInput"' + (attrs || '') + '></textarea></body>');
  const doc = dom.window.document;
  const input = doc.getElementById('chatInput');
  input.value = value || '';
  return { dom, doc, input };
}

function atEnd(input) {
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

describe('createComposerInsert', () => {
  test('inserts at the caret through setRangeText and fires an input event', () => {
    const { doc, input } = makeDom('hello world');
    input.setSelectionRange(5, 5);
    let inputEvents = 0;
    input.addEventListener('input', () => { inputEvents += 1; });
    const result = composerInsert.createComposerInsert({ documentRef: doc }).insertIntoComposer({ text: 'XY' });
    assert.equal(result, true);
    assert.equal(input.value, 'hello\n\nXY world');
    assert.equal(inputEvents, 1);
    assert.equal(doc.activeElement, input);
    assert.equal(input.selectionStart, 'hello\n\nXY'.length);
  });

  test('replaces a selected range', () => {
    const { doc, input } = makeDom('abc');
    input.setSelectionRange(0, 3);
    composerInsert.createComposerInsert({ documentRef: doc }).insertIntoComposer({ text: 'Z' });
    assert.equal(input.value, 'Z');
  });

  test('empty composer gets no separator', () => {
    const { doc, input } = makeDom('');
    composerInsert.createComposerInsert({ documentRef: doc }).insertIntoComposer({ text: 'first' });
    assert.equal(input.value, 'first');
  });

  test('separator rules: none after a blank line, one newline after a single newline, a blank line otherwise', () => {
    const cases = [
      ['text\n\n', 'text\n\nNEW'],
      ['text\n', 'text\n\nNEW'],
      ['text', 'text\n\nNEW'],
    ];
    for (const [before, expected] of cases) {
      const { doc, input } = makeDom(before);
      atEnd(input);
      composerInsert.createComposerInsert({ documentRef: doc }).insertIntoComposer({ text: 'NEW' });
      assert.equal(input.value, expected, JSON.stringify(before));
    }
  });

  test('uses execCommand insertText when it succeeds and skips the fallback', () => {
    const { doc, input } = makeDom('abc');
    atEnd(input);
    const calls = [];
    doc.execCommand = (...args) => { calls.push(args); return true; };
    const result = composerInsert.createComposerInsert({ documentRef: doc }).insertIntoComposer({ text: 'Q' });
    assert.equal(result, true);
    assert.deepEqual(calls, [['insertText', false, '\n\nQ']]);
    assert.equal(input.value, 'abc');
  });

  test('falls back to setRangeText when execCommand returns false or throws', () => {
    for (const impl of [() => false, () => { throw new Error('unsupported'); }]) {
      const { doc, input } = makeDom('abc');
      atEnd(input);
      doc.execCommand = impl;
      composerInsert.createComposerInsert({ documentRef: doc }).insertIntoComposer({ text: 'Q' });
      assert.equal(input.value, 'abc\n\nQ');
    }
  });

  test('returns false when there is no composer, or it is disabled or read-only', () => {
    const empty = new JSDOM('<!doctype html><body></body>').window.document;
    assert.equal(composerInsert.createComposerInsert({ documentRef: empty }).insertIntoComposer({ text: 'x' }), false);
    for (const attr of [' disabled', ' readonly']) {
      const { doc, input } = makeDom('keep', attr);
      assert.equal(composerInsert.createComposerInsert({ documentRef: doc }).insertIntoComposer({ text: 'x' }), false);
      assert.equal(input.value, 'keep');
    }
  });

  test('getInput overrides the default composer lookup', () => {
    const { doc, input } = makeDom('default');
    const other = doc.createElement('textarea');
    doc.body.appendChild(other);
    const result = composerInsert.createComposerInsert({ documentRef: doc, getInput: () => other }).insertIntoComposer({ text: 'here' });
    assert.equal(result, true);
    assert.equal(other.value, 'here');
    assert.equal(input.value, 'default');
  });

  test('exports a default helper bound to the global document', () => {
    assert.equal(typeof composerInsert.insertIntoComposer, 'function');
    const { doc } = makeDom('');
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
    try {
      assert.equal(composerInsert.insertIntoComposer({ text: 'g' }), true);
      assert.equal(doc.getElementById('chatInput').value, 'g');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'document', saved);
      else delete globalThis.document;
    }
  });
});
