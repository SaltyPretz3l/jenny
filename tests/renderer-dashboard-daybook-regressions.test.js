const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createDaybookController } = require('../renderer/features/renderer-dashboard-daybook.js');

test('HOM-03 Scratchpad resize sends settings without stale note content', async () => {
  const dom = new JSDOM('<div id="book"><div id="rail"><textarea id="homeScratchpadInput" rows="6"></textarea></div><div id="grip"></div></div>');
  const doc = dom.window.document;
  const patches = [];
  const controller = createDaybookController({
    dom: { homeDaybook: doc.getElementById('book'), homeDashboardRail: doc.getElementById('rail'), homeRailGrip: doc.getElementById('grip') },
    getHomeConfig: () => ({ scratchpad: { notes: [{ id: 'note-1', text: 'Stale' }], activeNoteId: 'note-1', settings: { rows: 6, font: 'mono' } } }),
    shell: { home: { updateConfig: async (patch) => { patches.push(patch); return null; } } },
  });
  doc.getElementById('grip').dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 0, clientY: 44 }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(patches, [{ scratchpad: { settings: { rows: 8, font: 'mono' } } }]);
  controller.dispose();
});

test('dispose clears a pending ask and fences its settlement from replacement controls', async () => {
  const dom = new JSDOM('<div id="strip"><div class="home-info-strip__ask"><textarea data-home-ask-input="1"></textarea></div></div>');
  const strip = dom.window.document.getElementById('strip');
  const input = strip.querySelector('textarea');
  let resolveOld;
  const oldController = createDaybookController({
    dom: { homeInfoStrip: strip },
    onAsk: () => new Promise((resolve) => { resolveOld = resolve; }),
  });
  input.value = 'old question';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(input.readOnly, true);
  assert.equal(input.closest('.home-info-strip__ask').dataset.askBusy, '1');

  oldController.dispose();
  assert.equal(input.readOnly, false);
  assert.equal(input.closest('.home-info-strip__ask').hasAttribute('data-ask-busy'), false);

  const replacement = createDaybookController({
    dom: { homeInfoStrip: strip },
    onAsk: () => new Promise(() => {}),
  });
  input.value = 'replacement question';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  resolveOld(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(input.value, 'replacement question');
  assert.equal(input.readOnly, true);
  assert.equal(input.closest('.home-info-strip__ask').dataset.askBusy, '1');
  replacement.dispose();
});
