/**
 * Unit tests for the first-run "Tools & capabilities" setup scene
 * (renderer/features/setup-scenes/scene-capabilities.js).
 *
 * Mirrors the focused jsdom scene tests in tests/renderer-setup.test.js. Uses
 * t.after() for cleanup and never calls dom.window.close() (orphans node procs
 * on Windows, per AGENTS.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScene, FIELDS } = require('../renderer/features/setup-scenes/scene-capabilities');

function mountScene(deps) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const rootEl = dom.window.document.getElementById('root');
  const scene = createScene(deps || {});
  scene.mount(rootEl);
  return { dom, rootEl, scene };
}

test('capabilities scene defaults only local non-mutating tools on', (t) => {
  const { rootEl, scene } = mountScene();
  t.after(() => scene.dispose());

  assert.equal(FIELDS.length, 5, 'expected the supported tool capability field set');
  FIELDS.forEach((f) => {
    const el = rootEl.querySelector('[data-inv-toggle="' + f.id + '"]');
    assert.ok(el, 'toggle rendered for ' + f.id);
    assert.equal(el.getAttribute('aria-checked'), String(f.defaultChecked === true), f.id + ' follows its consequence default');
  });
  // Policy contract: the rendered controls are inventory toggles, not raw inputs.
  assert.equal(rootEl.querySelector('input'), null, 'no raw <input> elements');
  assert.equal(rootEl.querySelector('select'), null, 'no raw <select> elements');
  // Grouped by consequence so consent does not collapse unlike risks.
  const groupTitles = Array.from(rootEl.querySelectorAll('.setup-cap-group-title')).map((el) => el.textContent);
  assert.deepEqual(groupTitles, ['Local computation', 'Network access']);
});

test('capabilities scene Save persists a batched patch, marks the step done, and closes', async (t) => {
  const calls = { patch: null, marks: [], closed: 0 };
  const { rootEl, scene } = mountScene({
    persistFeatureSettings: async (patch) => { calls.patch = patch; return { ok: true }; },
    markStep: async (step, status) => { calls.marks.push([step, status]); },
    closeModal: () => { calls.closed += 1; },
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });
  t.after(() => scene.dispose());

  // Explicitly opt into web search; other consequence-bearing choices stay off.
  rootEl.querySelector('[data-inv-toggle="capWebToggle"]').click();

  rootEl.querySelector('[data-step-modal-action="save"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(calls.patch, 'persistFeatureSettings received a patch');
  // tools bucket
  assert.equal(calls.patch.tools.web, true, 'explicit opt-in is reflected');
  assert.equal(calls.patch.tools.browser, false);
  assert.equal(calls.patch.tools.pythonRuntime, true);
  assert.equal(calls.patch.tools.imageRead, true);
  assert.equal(calls.patch.tools.todo, true);
  // featureOverrides bucket
  assert.deepEqual(calls.patch.featureOverrides, {});
  // step + close
  assert.deepEqual(calls.marks, [['capabilities', 'done']]);
  assert.equal(calls.closed, 1, 'Save closes the modal after a successful save');
});

test('capabilities scene claims Save synchronously and ignores rapid duplicate clicks', async (t) => {
  let releasePersist;
  const calls = { persisted: 0, marked: 0, closed: 0 };
  const { rootEl, scene } = mountScene({
    persistFeatureSettings: () => {
      calls.persisted += 1;
      return new Promise((resolve) => { releasePersist = resolve; });
    },
    markStep: async () => { calls.marked += 1; },
    closeModal: () => { calls.closed += 1; },
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });
  t.after(() => scene.dispose());

  rootEl.querySelector('[data-step-modal-action="save"]').click();

  const actions = Array.from(rootEl.querySelectorAll('[data-step-modal-action]'));
  assert.equal(actions.length > 0, true);
  assert.equal(actions.every((button) => button.disabled), true);
  rootEl.querySelector('[data-step-modal-action="save"]').click();
  assert.equal(calls.persisted, 1);

  releasePersist({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.marked, 1);
  assert.equal(calls.closed, 1);
});

test('capabilities scene Skip marks skipped and closes without persisting', async (t) => {
  const calls = { persisted: 0, marks: [], closed: 0 };
  const { rootEl, scene } = mountScene({
    persistFeatureSettings: async () => { calls.persisted += 1; return { ok: true }; },
    markStep: async (step, status) => { calls.marks.push([step, status]); },
    closeModal: () => { calls.closed += 1; },
  });
  t.after(() => scene.dispose());

  const skipBtn = rootEl.querySelector('[data-step-modal-action="skip"]');
  assert.ok(skipBtn, 'skip action present');
  skipBtn.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.persisted, 0, 'skip never persists capability choices');
  assert.deepEqual(calls.marks, [['capabilities', 'skipped']]);
  assert.equal(calls.closed, 1, 'Skip closes the modal');
});
