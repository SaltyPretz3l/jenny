'use strict';

// Helpers for tests/sketch-check.test.js.
const fs = require('node:fs');
const assert = require('node:assert/strict');

// The Mermaid header pattern the app already has (START_RE in renderer/shared/markdown-mermaid-text.js), read
// through its public looksLikeSource so the test does not match against source text.
function rendererHeaderPattern() {
  const { looksLikeSource } = require('../../../renderer/shared/markdown-mermaid-text.js');
  const original = RegExp.prototype.test;
  let captured;
  RegExp.prototype.test = function capture(value) {
    if (captured === undefined && String(this.source).includes('sequenceDiagram')) captured = this;
    return original.call(this, value);
  };
  try {
    looksLikeSource('anything');
  } finally {
    RegExp.prototype.test = original;
  }
  assert.ok(captured, 'the renderer exposes its header pattern through looksLikeSource');
  return captured;
}

// The frame bundle in a jsdom window, with the two measuring APIs jsdom lacks.
function loadFrame(t, frameBundlePath) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
  dom.window.document.fonts = { ready: Promise.resolve() };
  dom.window.eval(fs.readFileSync(frameBundlePath, 'utf8'));
  return { api: dom.window.jennySketch, root: dom.window.document.getElementById('root'), dom };
}

module.exports = { rendererHeaderPattern, loadFrame };
