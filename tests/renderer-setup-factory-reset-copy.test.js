/**
 * The reset-onboarding confirmation must describe what resetOnboarding does:
 * setup progress and the assistant name are reset; personality text lives in
 * PERSONALITY.md and is untouched (B4).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScene } = require('../renderer/features/setup-scenes/scene-factory-reset');

test('reset onboarding copy names the assistant name as cleared and the personality note as preserved', () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const scene = createScene({});
  scene.mount(rootEl);
  const text = rootEl.textContent;
  assert.match(text, /Assistant name \(reset to Jenny\)\./);
  assert.match(text, /Your personality note \(PERSONALITY\.md\)\./);
  assert.doesNotMatch(text, /custom personality text/);
  const headings = Array.from(rootEl.querySelectorAll('h3')).map((el) => el.textContent);
  assert.deepEqual(headings, ['Cleared', 'Preserved']);
  scene.dispose();
});
