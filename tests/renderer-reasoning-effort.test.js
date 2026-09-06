const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('renderer disables Composer reasoning effort when the current session model is unsupported', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      status: {
        async get() {
          return {
            engine: 'mock',
            reasoning_effort_support: 'unsupported',
            provider_capabilities: {
              mock: { reasoning_effort_support: 'unsupported' },
              vllm: { reasoning_effort_support: 'supported' },
            },
          };
        },
      },
    },
  });

  const composerEffortSelect = window.document.getElementById('composerEffortSelect');

  assert.equal(composerEffortSelect.value, 'default');
  assert.equal(composerEffortSelect.disabled, true);
  assert.equal(composerEffortSelect.closest('.composer-select-shell').hidden, true);
  assert.equal(composerEffortSelect.dataset.reasoningSupported, 'false');
  // The popover's picker (not a caption) is what the user sees: opening it
  // must render the model list without a Thinking row for this model.
  const popover = window.document.getElementById('composerModelPopover');
  window.inventory.popover.open(popover, {
    trigger: window.document.getElementById('composerModelPill'),
  });
  assert.ok(popover.querySelector('.composer-model-picker-option'));
  assert.equal(popover.querySelector('.composer-model-picker-thinking'), null);
});
