const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createScene } = require('../renderer/features/setup-scenes/scene-setup-hub');
const { computeSetupHealth } = require('../renderer/features/setup-scenes/scene-utils');
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(t, state, result) {
  const dom = new JSDOM('<main></main>');
  const host = dom.window.document.querySelector('main');
  const calls = { detect: 0, finish: 0, opened: [] };
  const scene = createScene({ state,
    setupService: { detectOllama: async () => { calls.detect++; return { installed: false }; } },
    attemptComplete: async () => result,
    finish: () => { calls.finish++; }, openStep: id => calls.opened.push(id),
  });
  scene.mount(host);
  t.after(() => { scene.dispose(); dom.window.close(); });
  return { host, calls };
}
const connected = { steps: { workspaceRoot: 'done', localModel: 'pending', endpoint: 'done' },
  readiness: { endpoint: { ready: true, engineType: 'openai-compatible' } } };

test('workspace and existing endpoint satisfy model access without Ollama detection', async t => {
  const h = harness(t, connected, { ...connected, setupComplete: true });
  assert.equal(computeSetupHealth(connected).state, 'complete');
  assert.equal(h.host.querySelector('[data-setup-derived="local-engine"]'), null);
  assert.match(h.host.textContent, /Connect an existing server/);
  assert.equal(h.calls.detect, 0);
  h.host.querySelector('[data-step-modal-action="finishSetup"]').click(); await settle();
  assert.equal(h.calls.finish, 1);
});

test('failed live readiness recovers through endpoint setup and cannot complete locally', async t => {
  const refused = { ...connected, setupComplete: false, readiness: { endpoint: { ready: false, engineType: 'openai-compatible' } } };
  const h = harness(t, connected, refused);
  h.host.querySelector('[data-step-modal-action="finishSetup"]').click(); await settle();
  assert.equal(h.calls.finish, 0);
  h.host.querySelector('[data-action="fixRequired"]').click();
  assert.deepEqual(h.calls.opened, ['endpoint']);
});

test('choosing or skipping routes without a ready model never satisfies setup health', () => {
  for (const status of ['pending', 'skipped', 'error']) {
    assert.notEqual(computeSetupHealth({ steps: { workspaceRoot: 'done', localModel: 'skipped', endpoint: status } }).state, 'complete');
  }
});

test('PowerShell forwards ExistingServer and shell wrappers retain user arguments', () => {
  const root = path.resolve(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'setup.ps1'), 'utf8'), /if \(\$ExistingServer\) \{ \$userForward \+= '--existing-server' \}/);
  assert.match(fs.readFileSync(path.join(root, 'setup.sh'), 'utf8'), /setup\.js --bootstrapped-npm "\$\{USER_ARGS\[@\]\}"/);
});
