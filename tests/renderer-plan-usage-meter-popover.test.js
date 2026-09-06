/* ChatGPT plan-usage meter inside the real renderer app: the plan ring mounts
 * beside the context ring, each chip opens only its own popover, the plan
 * popover survives a context-usage repaint, and install() tears down with the app. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function planPayload(overrides = {}) {
  return {
    ok: true,
    provider_id: 'chatgpt',
    engine_active: true,
    account: { email: 'owner@example.test', plan_type: 'plus' },
    snapshot: {
      version: 1,
      primary: { used_percent: 62, window_minutes: 300, reset_at: NOW_SECONDS + 3600 },
      secondary: { used_percent: 18, window_minutes: 10080, reset_at: NOW_SECONDS + 3 * 86400 },
      rate_limit_reached_type: '',
      captured_at_ms: Date.now() - 120000,
      source: 'chat_done',
    },
    ...overrides,
  };
}

// waitForUi(window, ms) is a fixed tick; poll a predicate on top of it so a
// slow seed never turns into a null dereference further down the test.
async function waitUntil(window, predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await waitForUi(window, 20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function loadChatGptApp(t) {
  const app = await loadRendererApp({
    shell: {
      chatgptPlanUsage: { getSnapshot: async () => planPayload() },
      status: {
        get: async () => ({ ok: true, engine: 'chatgpt', engine_type: 'chatgpt', model: 'gpt-5', backend_ready: true }),
      },
    },
  });
  t.after(() => app.dispose());
  const { window } = app;
  const document = window.document;
  await waitUntil(window, () => document.getElementById('composerPlanRing'), 'plan ring mounted');
  return { app, window, document, planListeners: () => window.jennyShell.__getListenerCounts().planUsage };
}

function clickChip(window, chip) {
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

test('plan ring mounts beside the context ring only while ChatGPT is the engine', async (t) => {
  const { document } = await loadChatGptApp(t);
  const slot = document.getElementById('composerPlanUsageSlot');
  const chip = document.getElementById('composerPlanRing');
  assert.ok(slot.contains(chip));
  assert.equal(chip.getAttribute('data-inv-chip'), 'composer-plan-ring');
  assert.equal(chip.querySelector('.inv-chip-label').textContent, '62%');
  assert.equal(document.getElementById('composerPlanDetailsPopover').hidden, true);
  const contextSlot = document.getElementById('composerContextUsageSlot');
  assert.equal(contextSlot.nextElementSibling, slot, 'plan slot sits right after the context slot');
});

test('plan ring hides when the engine is not chatgpt', async (t) => {
  const app = await loadRendererApp({
    shell: {
      chatgptPlanUsage: { getSnapshot: async () => planPayload({ engine_active: false }) },
      status: { get: async () => ({ ok: true, engine: 'ollama', engine_type: 'ollama', model: 'llama', backend_ready: true }) },
    },
  });
  t.after(() => app.dispose());
  const { window } = app;
  await waitUntil(window, () => window.jennyShell.__getListenerCounts().planUsage === 1, 'meter installed');
  await waitForUi(window, 60);
  assert.equal(window.document.getElementById('composerPlanRing'), null);
  assert.equal(window.document.getElementById('composerPlanUsageSlot').innerHTML, '');
});

test('each ring opens only its own popover', async (t) => {
  const { window, document } = await loadChatGptApp(t);
  const planChip = document.getElementById('composerPlanRing');
  clickChip(window, planChip);
  const planPopover = document.getElementById('composerPlanDetailsPopover');
  assert.equal(planPopover.hidden, false, 'plan popover opened');
  assert.equal(planPopover.querySelector('h3').textContent, 'ChatGPT plan usage');
  assert.equal(planPopover.querySelectorAll('.inv-plan-window').length, 2);
  const contextPopover = document.getElementById('composerContextDetailsPopover');
  if (contextPopover) assert.equal(contextPopover.hidden, true, 'context popover untouched');
  clickChip(window, planChip);
  assert.equal(document.getElementById('composerPlanDetailsPopover').hidden, true, 'second click closes it');

  const contextChip = document.getElementById('composerContextRing');
  if (contextChip) {
    clickChip(window, contextChip);
    assert.equal(document.getElementById('composerContextDetailsPopover').hidden, false);
    assert.equal(document.getElementById('composerPlanDetailsPopover').hidden, true, 'context click leaves the plan popover closed');
  }
});

test('an open plan popover survives a pushed snapshot and a context repaint', async (t) => {
  const { window, document } = await loadChatGptApp(t);
  clickChip(window, document.getElementById('composerPlanRing'));
  assert.equal(document.getElementById('composerPlanDetailsPopover').hidden, false);

  await window.jennyShell.__emitPlanUsage(planPayload({
    snapshot: { ...planPayload().snapshot, primary: { used_percent: 91, window_minutes: 300, reset_at: NOW_SECONDS + 3600 } },
  }));
  await waitUntil(window, () => document.getElementById('composerPlanRing')?.querySelector('.inv-chip-label')?.textContent === '91%', 'pushed snapshot rendered');
  const chip = document.getElementById('composerPlanRing');
  assert.ok(chip.className.includes('inv-plan-ring--danger'));
  assert.equal(document.getElementById('composerPlanDetailsPopover').hidden, false, 'popover stayed open across the repaint');

  await window.jennyShell.__emitBackendStatus({ ok: true, engine: 'chatgpt', engine_type: 'chatgpt', model: 'gpt-5', backend_ready: true, context_usage: { used_tokens: 4000, context_window: 32000 } });
  await waitForUi(window, 40);
  assert.equal(document.getElementById('composerPlanDetailsPopover').hidden, false, 'popover stayed open across a status repaint');
  assert.equal(document.getElementById('composerPlanRing').querySelector('.inv-chip-label').textContent, '91%');
});

test('install() unsubscribes when the app is disposed', async (t) => {
  const { app, planListeners } = await loadChatGptApp(t);
  assert.equal(planListeners(), 1, 'install() subscribed once');
  await app.dispose();
  assert.equal(planListeners(), 0, 'teardown ran through the bind cleanup list');
});
