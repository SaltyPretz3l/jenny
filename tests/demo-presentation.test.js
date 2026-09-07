const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const presentation = require('../scripts/demo/demo-presentation');

test('the overlay script installs the cursor, caption, and crossfade API into a page', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, runScripts: 'outside-only' });
  const context = dom.getInternalVMContext();
  const installed = vm.runInContext(presentation.OVERLAY_INSTALL_SCRIPT, context);
  assert.equal(installed, true);
  const api = dom.window.__demoPresentation;
  for (const name of ['show', 'moveTo', 'press', 'setCaption', 'setCrossfade', 'position']) {
    assert.equal(typeof api[name], 'function', `${name} is exposed`);
  }
  assert.ok(dom.window.document.getElementById('demoCursor'), 'cursor element mounted');
  assert.ok(dom.window.document.getElementById('demoCaption'), 'caption element mounted');

  api.setCaption('Palette · Midnight');
  const caption = dom.window.document.getElementById('demoCaption');
  assert.equal(caption.textContent, 'Palette · Midnight');
  assert.ok(caption.classList.contains('demo-caption-visible'));
  api.setCaption('');
  assert.ok(!caption.classList.contains('demo-caption-visible'));

  api.setCrossfade(true);
  assert.ok(dom.window.document.documentElement.classList.contains(presentation.CROSSFADE_CLASS));
  api.setCrossfade(false);
  assert.ok(!dom.window.document.documentElement.classList.contains(presentation.CROSSFADE_CLASS));

  assert.equal(vm.runInContext(presentation.OVERLAY_INSTALL_SCRIPT, context), true, 'idempotent');
  assert.equal(dom.window.document.querySelectorAll('#demoCursor').length, 1);
  dom.window.close();
});

test('the demo stylesheet hides exactly the replay-only chrome and defines the crossfade', () => {
  const css = presentation.DEMO_STYLE_CSS;
  for (const selector of presentation.HIDDEN_CHROME_SELECTORS) {
    assert.ok(css.includes(selector), `${selector} is hidden by the demo stylesheet`);
  }
  assert.deepEqual(presentation.HIDDEN_CHROME_SELECTORS, ['#workbenchHealthPillSlot', '#composerModelPillSlot']);
  assert.match(css, /visibility: hidden !important/);
  assert.ok(css.includes(`html.${presentation.CROSSFADE_CLASS}`));
  assert.ok(css.includes(`${presentation.CROSSFADE_MS}ms`));
  assert.doesNotMatch(css, /display:\s*none/, 'hiding must not reflow the layout');
});

test('typingDelays is seeded, jittered around the base, and slower after spaces and punctuation', () => {
  const text = 'What does this project do? Check the README.';
  const first = presentation.typingDelays(text, 40, 7);
  const second = presentation.typingDelays(text, 40, 7);
  assert.deepEqual(first, second, 'same seed, same cadence');
  assert.notDeepEqual(first, presentation.typingDelays(text, 40, 8), 'a different seed changes the cadence');
  assert.equal(first.length, Array.from(text).length);
  const chars = Array.from(text);
  chars.forEach((char, index) => {
    const delay = first[index];
    if (/[,.?!;:]/.test(char)) {
      assert.ok(delay >= 40 * 0.55 + 40 * 2.2 - 1, `punctuation "${char}" gets a long beat (${delay})`);
    } else if (char === ' ') {
      assert.ok(delay >= 40 * 0.55 + 40 * 0.5 - 1 && delay <= 40 * 1.45 + 40 * 0.5 + 1, `space beat ${delay}`);
    } else {
      assert.ok(delay >= 21 && delay <= 59, `letter delay ${delay} stays within 0.55x-1.45x of the base`);
    }
  });
  assert.deepEqual(presentation.typingDelays('', 40, 1), []);
  assert.ok(presentation.typingDelays('ab', 0, 1).every((delay) => delay === 0));
});
