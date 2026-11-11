'use strict';

/* The IDE controller hands its extracted wiring + lifecycle modules a lazy `parts` accessor.
 * A name those modules read that the controller does not expose would be a silent undefined, so
 * pin: every `p.<name>` (and every `const { ... } = p;` name) is a getter on `parts`. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createIdeViewLifecycle } = require('../renderer/features/renderer-ide-view-lifecycle.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', name), 'utf8');

test('a panel opened during the first load waits for the hydrate that restores the saved layout', async () => {
  let finishHydrate;
  const log = [];
  const parts = {
    hydratePersistedState: () => new Promise((resolve) => { finishHydrate = resolve; }),
    renderTabs: () => log.push('rendered'),
  };
  const lifecycle = createIdeViewLifecycle({
    getDom: () => ({}), registerCleanup: () => {}, appendClientLog: () => {}, getIde: () => ({}), parts,
  });
  const waited = lifecycle.whenActivated().then(() => log.push('activated'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, [], 'still hydrating');
  finishHydrate();
  await waited;
  assert.deepEqual(log, ['rendered', 'activated']);
  await lifecycle.whenActivated();
  assert.equal(log.length, 2, 'a later wait does not activate again');
});

test('every parts name the wiring and lifecycle modules read is exposed by the controller', () => {
  const controller = read('renderer-ide-controller.js');
  const block = controller.slice(controller.indexOf('const parts = {'), controller.indexOf('const lifecycle ='));
  const exposed = new Set([...block.matchAll(/get (\w+)\(\)/g)].map((match) => match[1]));
  assert.ok(exposed.size > 60, 'the parts block was found');
  for (const file of ['renderer-ide-controller-wiring.js', 'renderer-ide-view-lifecycle.js']) {
    const source = read(file);
    const used = new Set([...source.matchAll(/\bp\.(\w+)/g)].map((match) => match[1]));
    for (const match of source.matchAll(/const \{([^}]*)\} = p;/g)) {
      for (const name of match[1].split(',').map((entry) => entry.trim()).filter(Boolean)) used.add(name);
    }
    for (const name of used) assert.ok(exposed.has(name), `${file} reads parts.${name}, which the controller does not expose`);
  }
});
