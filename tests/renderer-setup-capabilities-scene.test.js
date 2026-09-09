const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const toggles = require('../renderer/inventory/toggle-switch');
const { createScene, FIELDS } = require('../renderer/features/setup-scenes/scene-capabilities');
const settle = () => new Promise(resolve => setImmediate(resolve));
const settings = (overrides = {}) => ({ tools: Object.fromEntries(FIELDS.map(f => [f.key, f.defaultChecked])), ...overrides });

function harness(t, deps = {}) {
  const dom = new JSDOM('<main></main>');
  const doc = dom.window.document;
  const host = doc.querySelector('main');
  const saved = [], steps = [], closed = [], logs = [];
  toggles.initToggleHandlers(doc);
  const scene = createScene({
    persistFeatureSettings: async patch => { saved.push(patch); return patch; },
    markStep: async (...args) => steps.push(args), closeModal: () => closed.push(true),
    appendClientLog: (...args) => logs.push(args), ...deps,
  });
  scene.mount(host);
  t.after(() => { scene.dispose(); dom.window.close(); });
  return { doc, host, scene, saved, steps, closed, logs,
    toggle: key => host.querySelector(`[data-inv-toggle="${key}"]`),
    click: key => host.querySelector(`[data-step-modal-action="${key}"]`).click() };
}

test('production document handler changes a switch once, including label activation, and saves exact choices', async t => {
  const h = harness(t);
  const events = [];
  h.doc.addEventListener('inv-toggle-change', e => events.push(e.detail.checked));
  h.toggle('capWebToggle').click();
  assert.deepEqual(events, [true]);
  h.toggle('capBrowserToggle').closest('label').querySelector('.inv-toggle-label').click();
  assert.equal(h.toggle('capBrowserToggle').getAttribute('aria-checked'), 'true');
  h.click('save'); await settle();
  assert.deepEqual(h.saved, [{ tools: { pythonRuntime: true, imageRead: true, todo: true, web: true, browser: true }, featureOverrides: {} }]);
  assert.deepEqual(h.steps, [['capabilities', 'done']]);
  assert.equal(h.closed.length, 1);
});

test('revisit loads saved permissions and disables controls until ready', async t => {
  let resolve;
  const h = harness(t, { state: { steps: { capabilities: 'done' } }, getFeatureSettings: () => new Promise(r => { resolve = r; }) });
  assert.equal(h.toggle('capWebToggle').disabled, true);
  resolve(settings({ tools: { pythonRuntime: false, imageRead: true, todo: false, web: true, browser: false } }));
  await settle();
  assert.equal(h.toggle('capWebToggle').disabled, false);
  assert.equal(h.toggle('capWebToggle').getAttribute('aria-checked'), 'true');
  assert.equal(h.toggle('capPythonToggle').getAttribute('aria-checked'), 'false');
});

test('failed reads require retry and never save guessed settings', async t => {
  let attempts = 0;
  const h = harness(t, { state: { steps: { capabilities: 'done' } }, getFeatureSettings: async () => ++attempts === 1 ? null : settings() });
  await settle(); h.click('save');
  assert.equal(h.saved.length, 0);
  assert.match(h.host.textContent, /Could not load/);
  h.click('retry'); await settle();
  assert.equal(h.toggle('capWebToggle').disabled, false);
});

test('failed save retains draft and allows retry without false completion', async t => {
  let attempts = 0;
  const h = harness(t, { persistFeatureSettings: async patch => ++attempts === 1 ? null : patch });
  h.toggle('capWebToggle').click(); h.click('save'); await settle();
  assert.equal(h.steps.length, 0); assert.equal(h.closed.length, 0);
  assert.equal(h.toggle('capWebToggle').getAttribute('aria-checked'), 'true');
  h.click('save'); await settle(); assert.equal(h.steps.length, 1);
});

test('in-flight Save is exclusive and disposal prevents late completion', async t => {
  let resolve, calls = 0;
  const h = harness(t, { persistFeatureSettings: patch => { calls++; return new Promise(r => { resolve = () => r(patch); }); } });
  h.click('save'); h.click('save'); assert.equal(calls, 1);
  assert.equal(h.toggle('capWebToggle').disabled, true);
  h.scene.dispose(); resolve(); await settle();
  assert.equal(h.steps.length, 0); assert.equal(h.closed.length, 0);
});

test('Cancel and Skip do not persist permission changes', async t => {
  for (const action of ['cancel', 'skip']) {
    const h = harness(t); h.toggle('capWebToggle').click(); h.click(action); await settle();
    assert.equal(h.saved.length, 0);
    assert.equal(h.closed.length, 1);
  }
});

test('missing read or write bridges fail closed', async t => {
  const read = harness(t, { state: { steps: { capabilities: 'done' } } });
  await settle();
  assert.equal(read.toggle('capWebToggle').disabled, true);
  assert.equal(read.steps.length, 0);
  const write = harness(t, { persistFeatureSettings: undefined });
  write.click('save'); await settle();
  assert.equal(write.steps.length, 0);
  assert.equal(write.closed.length, 0);
});

test('disposing during a saved-state read prevents late rendering', async t => {
  let resolve;
  const h = harness(t, { state: { steps: { capabilities: 'done' } }, getFeatureSettings: () => new Promise(r => { resolve = r; }) });
  h.scene.dispose();
  h.host.textContent = 'Replacement scene';
  resolve(settings()); await settle();
  assert.equal(h.host.textContent, 'Replacement scene');
});

test('step persistence failure retains draft and reports no successful completion', async t => {
  const h = harness(t, { markStep: async () => { throw new Error('step write failed'); } });
  h.toggle('capWebToggle').click(); h.click('save'); await settle();
  assert.equal(h.closed.length, 0);
  assert.equal(h.toggle('capWebToggle').getAttribute('aria-checked'), 'true');
  assert.ok(h.logs.some(row => row[1] === 'setup.capabilities_save_failed'));
});
