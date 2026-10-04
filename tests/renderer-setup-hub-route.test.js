const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScene: createSetupHubScene } = require('../renderer/features/setup-scenes/scene-setup-hub');
const { DEFAULT_STEPS, settle, buildHarness, MODEL_LOADED_PROBE } = require('./helpers/setup-hub-harness');

test('Option A renders one model-route decision and folder actions without required badges', async (t) => {
  const h = buildHarness(t);
  await h.controller.init();
  assert.equal(h.root.querySelectorAll('[data-setup-model-route]').length, 1);
  const row = h.root.querySelector('[data-setup-model-route]');
  const radios = [...row.querySelectorAll('input[type="radio"]')];
  assert.equal(radios.length, 2);
  assert.equal(radios[0].name, radios[1].name);
  assert.deepEqual(radios.map(input => input.closest('label').textContent.trim()),
    ['Ollama on this computerNot installed', 'An existing server (local or private network)']);
  assert.equal(radios[0].checked, true);
  assert.equal(row.querySelectorAll('[data-action="openStep"]').length, 1);
  assert.equal(row.querySelector('[data-action="skipStep"]'), null);
  assert.doesNotMatch(h.root.textContent, /Choose one model route|Required|of 2 required steps/);
  assert.equal(h.root.querySelectorAll('[data-setup-derived]').length, 0);
  const folder = h.root.querySelector('[data-setup-step-id="workspaceRoot"]');
  assert.equal(folder.querySelector('.setup-hub-row-title').textContent, 'Workspace folder \u00b7 for file tools');
  assert.equal(folder.querySelector('[data-action="openStep"]').textContent.trim(), 'Choose');
  assert.equal(folder.querySelector('[data-action="skipStep"]').textContent.trim(), 'Later');
  assert.match(h.root.textContent, /Pick how Jenny runs models\. A folder is only needed for file work\./);
  assert.match(h.root.querySelector('[data-setup-step-id="skills"] .setup-hub-row-title').textContent, / \u00b7 optional$/);
});

test('route choice persists only in hub UI across refresh, skip and warning rerenders', async (t) => {
  const h = buildHarness(t, { steps: { ...DEFAULT_STEPS, workspace_root: 'done' },
    freshProbe: MODEL_LOADED_PROBE, holdFreshProbe: true });
  await h.controller.init();
  await new Promise(resolve => setTimeout(resolve, 5));
  h.root.querySelector('input[value="endpoint"]').click();
  assert.equal(h.document.activeElement.value, 'endpoint');
  assert.equal(h.root.querySelector('[data-setup-model-route] [data-action="openStep"]').dataset.stepId, 'endpoint');
  assert.deepEqual(h.patches, []);
  h.releaseFreshProbe();
  await settle();
  assert.equal(h.root.querySelector('input[value="endpoint"]').checked, true);
  assert.equal(h.document.activeElement.value, 'endpoint');
  h.root.querySelector('[data-action="skipStep"][data-step-id="skills"]').click();
  await settle();
  assert.equal(h.root.querySelector('input[value="endpoint"]').checked, true);
  assert.deepEqual(h.patches, [{ steps: { skills: 'skipped' } }]);
});

test('footer and model glyph follow model health, folder health and the selected engine', async (t) => {
  for (const modelDone of [false, true]) {
    for (const workspaceDone of [false, true]) {
      for (const engineState of ['checking', 'running', 'missing', 'absent', 'upgrade', 'unknown']) {
        const dom = new JSDOM('<main></main>');
        const host = dom.window.document.querySelector('main');
        const scene = createSetupHubScene({
          state: { steps: { workspaceRoot: workspaceDone ? 'done' : 'skipped',
            localModel: modelDone ? 'done' : 'pending' } },
          setupService: { detectOllama: () => engineState === 'checking' ? new Promise(() => {})
            : engineState === 'unknown' ? Promise.reject(new Error('offline'))
              : Promise.resolve({ installed: engineState !== 'absent', running: engineState === 'running',
                upgradeRequired: engineState === 'upgrade' }) },
        });
        scene.mount(host);
        await settle();
        // Readiness is claimed only once the engine is known to run; checking
        // and unknown never say "Ready".
        const prefix = !modelDone ? 'Choose a model route to start chatting'
          : ['missing', 'absent', 'upgrade'].includes(engineState) ? 'Start Ollama to chat'
            : engineState === 'running' ? 'Ready to chat' : 'Model route set';
        const expected = modelDone && engineState === 'checking' ? 'Checking Ollama\u2026'
          : workspaceDone ? (prefix === 'Ready to chat' ? 'Ready to chat and use file tools' : prefix)
            : prefix + ' \u00b7 file tools need a folder';
        assert.equal(host.querySelector('.setup-hub-health').textContent, expected, engineState);
        const row = host.querySelector('[data-setup-model-route]');
        assert.equal(row.querySelector('.setup-hub-glyph').getAttribute('aria-label'), modelDone ? 'Done' : 'Pending');
        assert.equal(row.querySelector('[data-action="openStep"]').dataset.stepId,
          ['missing', 'absent', 'upgrade'].includes(engineState) ? 'localEngine' : 'localModel');
        assert.equal(row.querySelector('[data-action="openStep"]').textContent.trim(), modelDone ? 'Change' : 'Set up');
        host.querySelector('input[value="endpoint"]').click();
        assert.equal(host.querySelector('.setup-hub-health').textContent,
          workspaceDone ? (modelDone ? 'Ready to chat and use file tools' : 'Choose a model route to start chatting')
            : (modelDone ? 'Ready to chat' : 'Choose a model route to start chatting') + ' \u00b7 file tools need a folder');
        scene.dispose();
        dom.window.close();
      }
    }
  }
});

test('route switching ignores stale engine probes and stops detection after disposal', async (t) => {
  const dom = new JSDOM('<main></main>');
  const host = dom.window.document.querySelector('main');
  const probes = [];
  const opened = [];
  const scene = createSetupHubScene({ state: { steps: { workspaceRoot: 'done' } },
    openStep: id => opened.push(id),
    setupService: { detectOllama: () => new Promise(resolve => probes.push(resolve)) } });
  t.after(() => { scene.dispose(); dom.window.close(); });
  scene.mount(host);
  assert.equal(dom.window.document.activeElement.dataset.stepId, 'localModel');
  host.querySelector('input[value="endpoint"]').click();
  host.querySelector('[data-step-modal-action="finishSetup"]').click();
  await settle();
  assert.equal(host.querySelector('[data-action="fixRequired"]').dataset.stepId, 'endpoint');
  host.querySelector('[data-action="fixRequired"]').click();
  assert.deepEqual(opened, ['endpoint']);
  host.querySelector('input[value="ollama"]').click();
  assert.equal(probes.length, 2);
  assert.match(host.querySelector('.setup-hub-engine-status').textContent, /Checking/);
  probes[0]({ installed: false });
  await settle();
  assert.match(host.querySelector('.setup-hub-engine-status').textContent, /Checking/);
  probes[1]({ installed: true, running: false });
  await settle();
  assert.equal(host.querySelector('[data-action="fixRequired"]').dataset.stepId, 'localEngine');
  host.querySelector('input[value="endpoint"]').click();
  host.querySelector('input[value="ollama"]').click();
  scene.dispose();
  const frozen = host.innerHTML;
  probes[2]({ installed: true, running: true });
  await settle();
  assert.equal(host.innerHTML, frozen);
});
