const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const inventoryChip = require('../renderer/inventory/chip');
const inventoryPopover = require('../renderer/inventory/popover');
const inventoryActionButton = require('../renderer/inventory/action-button');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('context usage renders sent-context estimates when available', () => {
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    contextUsageUtils.updateUsage('session-context-estimate', {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        context_tokens_estimate: 1200,
        context_window: 131072,
        compact_threshold_tokens: 95846,
        model: 'qwen3.6:35b',
      },
    });

    const html = contextUsageUtils.renderContextUsage('session-context-estimate');
    assert.match(html, /1\.2k \/ 95\.8k est\. last request/);
    assert.match(html, /Context usage: 1\.2k \/ 95\.8k est\. last request/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('context detail trusted HTML escapes activity content', () => {
  global.inventory = {
    chip: inventoryChip, popover: inventoryPopover, actionButton: inventoryActionButton,
  };
  try {
    contextUsageUtils.clearAllUsage();
    contextUsageUtils.updateUsage('session-escaped-activity', {
      usage: { context_tokens_estimate: 1200, context_window: 8192 },
    });
    const html = contextUsageUtils.renderContextUsage('session-escaped-activity', {
      manualCompactionEnabled: true,
      compactionActivity: { message: '<img src=x onerror=alert(1)>' },
    });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('context usage does not guess a window from model names', () => {
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    contextUsageUtils.updateUsage('session-gemma3', {
      usage: { total_tokens: 15, context_tokens_estimate: 1200, model: 'gemma3:4b' },
    });
    assert.equal(contextUsageUtils.renderContextUsage('session-gemma3'), '');
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('updateUsage uses the sidecar-reported context window without inventing a trigger', () => {
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    contextUsageUtils.updateUsage('session-reported-window', {
      usage: {
        total_tokens: 15,
        context_tokens_estimate: 1200,
        context_window: 256000,
        model: 'gemma3:4b',
      },
    });
    assert.strictEqual(contextUsageUtils.getUsage('session-reported-window').contextLimit, 256000);
    const html = contextUsageUtils.renderContextUsage('session-reported-window');
    assert.match(html, /1\.2k \/ 256\.0k est\. last request/);
    assert.match(html, /token context window/);
    assert.doesNotMatch(html, /auto-compact/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('context usage appears for a table-unknown model once the window is reported', () => {
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    // Unknown model with no reported window stays hidden rather than guessing.
    contextUsageUtils.updateUsage('session-unknown-model', {
      usage: { total_tokens: 15, context_tokens_estimate: 1200, model: 'some-exotic-model:latest' },
    });
    assert.strictEqual(contextUsageUtils.renderContextUsage('session-unknown-model'), '');

    // With the sidecar-forwarded window, the same model now renders a meter.
    contextUsageUtils.updateUsage('session-unknown-model', {
      usage: {
        total_tokens: 15,
        context_tokens_estimate: 1200,
        context_window: 200000,
        model: 'some-exotic-model:latest',
      },
    });
    assert.match(
      contextUsageUtils.renderContextUsage('session-unknown-model'),
      /1\.2k \/ 200\.0k est\. last request/
    );
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('F8: context usage renders visible transcript estimates when sent context is unavailable', () => {
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    const fallbackEstimate = contextUsageUtils.buildContextUsageEstimate([
      { id: 'user_estimate', role: 'user', content: '12345678' },
      { id: 'assistant_estimate', role: 'assistant', content: '123456789' },
    ], {
      contextLimit: 8000,
      model: 'qwen3.6:35b',
    });

    const html = contextUsageUtils.renderContextUsage('session-visible-estimate', {
      fallbackEstimate,
    });

    assert.match(html, /5 \/ 8\.0k est\. context/);
    assert.match(html, /Context usage: 5 \/ 8\.0k est\. context/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('F8: context usage prefers sent context over visible transcript fallback', () => {
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    contextUsageUtils.updateUsage('session-prefers-sent', {
      usage: {
        total_tokens: 15,
        context_tokens_estimate: 1200,
        context_window: 131072,
        compact_threshold_tokens: 95846,
        model: 'qwen3.6:35b',
      },
    });
    const fallbackEstimate = contextUsageUtils.buildContextUsageEstimate([
      { id: 'user_large_estimate', role: 'user', content: 'x'.repeat(8000) },
    ], {
      contextLimit: 100000,
      model: 'llama-3',
    });

    const html = contextUsageUtils.renderContextUsage('session-prefers-sent', {
      fallbackEstimate,
    });

    assert.match(html, /1\.2k \/ 95\.8k est\. last request/);
    assert.doesNotMatch(html, /est\. context/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('F8: composer context meter supplies a visible-message fallback estimate', () => {
  const dom = new JSDOM('<div id="composerContextUsageSlot"></div>', { pretendToBeVisual: true });
  const slot = dom.window.document.getElementById('composerContextUsageSlot');
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    const controller = createShellRuntimeController({
      state: {
        currentSessionId: 'session-composer-estimate',
        status: { effective_context_length: 8000 },
        features: { featureFlags: { token_budget: true, context_compaction: true } },
        sessions: [{ id: 'session-composer-estimate', preferred_model: 'qwen3.6:35b' }],
      },
      dom: { composerContextUsageSlot: slot },
      modules: { contextUsageModule: contextUsageUtils },
      callbacks: {
        getCurrentVisibleMessages() {
          return [
            { id: 'user_composer', role: 'user', content: '12345678' },
            { id: 'assistant_composer', role: 'assistant', content: '123456789' },
          ];
        },
        getCurrentRuntimePreferences() {
          return { preferredModel: 'qwen3.6:35b' };
        },
      },
    });

    controller.renderComposerEnhancements();

    const ring = slot.querySelector('#composerContextRing');
    assert.ok(ring, 'ambient ring renders into the composer slot');
    assert.match(ring.getAttribute('title'), /5 of 8\.0k token context window \(est\. context\)/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('F8: unchanged composer repaints reuse the canonical session message array', () => {
  const dom = new JSDOM('<div id="composerContextUsageSlot"></div>', { pretendToBeVisual: true });
  const slot = dom.window.document.getElementById('composerContextUsageSlot');
  const canonicalMessages = [{ id: 'u1', role: 'user', content: 'x'.repeat(400) }];
  let visibleMessageReads = 0;
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    const controller = createShellRuntimeController({
      state: {
        currentSessionId: 'session-stable-estimate',
        status: { effective_context_length: 8000 },
        features: { featureFlags: { token_budget: true, context_compaction: true } },
        sessions: [{ id: 'session-stable-estimate', preferred_model: 'model-a' }],
        messagesBySession: new Map([['session-stable-estimate', canonicalMessages]]),
      },
      dom: { composerContextUsageSlot: slot },
      modules: { contextUsageModule: contextUsageUtils },
      callbacks: {
        getCurrentVisibleMessages() {
          visibleMessageReads += 1;
          return [...canonicalMessages];
        },
        getCurrentRuntimePreferences() {
          return { preferredModel: 'model-a' };
        },
      },
    });

    controller.renderComposerEnhancements();
    controller.renderComposerEnhancements();

    assert.equal(visibleMessageReads, 0, 'canonical storage avoids fresh-array history walks');
    assert.ok(slot.querySelector('#composerContextRing'));
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('F8: composer context meter rehydrates compacted history and counts only its appended suffix', () => {
  const dom = new JSDOM('<div id="composerContextUsageSlot"></div>', { pretendToBeVisual: true });
  const slot = dom.window.document.getElementById('composerContextUsageSlot');
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    const controller = createShellRuntimeController({
      state: {
        currentSessionId: 'session-compacted-reload',
        status: { effective_context_length: 8000 },
        ui: { contextOverheadTokens: 25 },
        features: { featureFlags: { token_budget: true, context_compaction: true } },
        sessions: [{
          id: 'session-compacted-reload',
          preferred_model: 'qwen3.6:35b',
          compaction_context: {
            version: 1,
            created_at: '2026-08-14T12:00:00.000Z',
            strategy: 'full',
            tokens_before: 4000,
            tokens_after: 800,
            boundary_message_count: 2,
          },
        }],
      },
      dom: { composerContextUsageSlot: slot },
      modules: { contextUsageModule: contextUsageUtils },
      callbacks: {
        getCurrentVisibleMessages() {
          return [
            { id: 'u1', role: 'user', content: 'old question' },
            { id: 'a1', role: 'assistant', content: 'old answer' },
            { id: 'u2', role: 'user', content: 'x'.repeat(40) },
          ];
        },
        getCurrentRuntimePreferences() {
          return {
            preferredModel: 'qwen3.6:35b',
            contextPreferences: { historyScope: 'session' },
          };
        },
      },
    });

    controller.renderComposerEnhancements();

    const ring = slot.querySelector('#composerContextRing');
    assert.ok(ring);
    assert.match(ring.getAttribute('title'), /835 of 8\.0k token context window \(est\. compacted history\)/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('F8: composer context meter skips visible-message scan when sent context is renderable', () => {
  const dom = new JSDOM('<div id="composerContextUsageSlot"></div>', { pretendToBeVisual: true });
  const slot = dom.window.document.getElementById('composerContextUsageSlot');
  global.inventory = { chip: inventoryChip };
  try {
    contextUsageUtils.clearAllUsage();
    contextUsageUtils.updateUsage('session-composer-sent-context', {
      usage: {
        total_tokens: 15,
        context_tokens_estimate: 1200,
        context_window: 131072,
        compact_threshold_tokens: 95846,
        model: 'qwen3.6:35b',
      },
    });
    let visibleMessageReadCount = 0;
    const controller = createShellRuntimeController({
      state: {
        currentSessionId: 'session-composer-sent-context',
        status: { effective_context_length: 8000 },
        features: { featureFlags: { token_budget: true, context_compaction: true } },
        sessions: [{ id: 'session-composer-sent-context', preferred_model: 'qwen3.6:35b' }],
      },
      dom: { composerContextUsageSlot: slot },
      modules: { contextUsageModule: contextUsageUtils },
      callbacks: {
        getCurrentVisibleMessages() {
          visibleMessageReadCount += 1;
          return [{ id: 'user_composer', role: 'user', content: '12345678' }];
        },
        getCurrentRuntimePreferences() {
          return { preferredModel: 'qwen3.6:35b' };
        },
      },
    });

    controller.renderComposerEnhancements();

    assert.equal(visibleMessageReadCount, 0);
    const ring = slot.querySelector('#composerContextRing');
    assert.ok(ring, 'ambient ring renders into the composer slot');
    assert.match(ring.getAttribute('title'), /1\.2k of 95\.8k tokens before auto-compact \(est\. last request\)/);
  } finally {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  }
});

test('renderer persists context settings on the active session without a static preview', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const newChatButton = window.document.getElementById('newChatButton');
  const scopeSelect = window.document.getElementById('contextHistoryScopeSelect');
  // Context toggles are inventory switches: dispatch inv-toggle-change on the
  // stable container (its innerHTML is rebuilt each render, so child nodes go stale).
  const sourcesList = window.document.getElementById('contextSourcesList');

  newChatButton.click();
  await waitForUi(window, 30);

  scopeSelect.value = 'recent';
  scopeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 20);

  sourcesList.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true,
    detail: { id: 'contextIncludePersonalityToggle', checked: false },
  }));
  await waitForUi(window, 20);

  sourcesList.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true,
    detail: { id: 'contextIncludeMemoryToggle', checked: false },
  }));
  await waitForUi(window, 20);

  assert.equal(shell.__state.setPreferenceCalls.length, 3);
  assert.equal(
    JSON.stringify(shell.__state.setPreferenceCalls.at(-1).preferences.context_preferences),
    JSON.stringify({
      history_scope: 'recent',
      include_personality: false,
      include_memory: false,
    })
  );
  assert.equal(window.document.getElementById('contextPreview'), null);
});

test('context source links route to the owning Personality and Memory pages', async (t) => {
  for (const [action, section] of [
    ['open-personality-page', 'personality'],
    ['open-memory-page', 'memories'],
  ]) {
    const { window } = await loadRendererTestApp(t);
    const link = window.document.querySelector(`[data-action="${action}"]`);
    assert.ok(link, `${action} link renders`);
    link.click();
    await waitForUi(window, 20);
    assert.equal(window.__rendererState.ui.activeView, 'settings');
    assert.equal(window.__rendererState.ui.activeSettingsSection, section);
  }
});

test('renderer disables context controls when the backend is external', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      backend: {
        async getStatus() {
          return { phase: 'ready', detail: '', mode: 'external' };
        },
      },
    },
  });

  const badge = window.document.getElementById('contextBadge');
  const status = window.document.getElementById('contextStatus');
  const scopeSelect = window.document.getElementById('contextHistoryScopeSelect');
  const personalityToggle = window.document.querySelector('[data-inv-toggle="contextIncludePersonalityToggle"]');
  const memoryToggle = window.document.querySelector('[data-inv-toggle="contextIncludeMemoryToggle"]');

  assert.equal(badge.textContent, 'Unavailable');
  assert.equal(scopeSelect.disabled, true);
  assert.equal(personalityToggle.disabled, true);
  assert.equal(memoryToggle.disabled, true);
  assert.match(status.textContent, /managed sidecar backend is active/i);
  assert.equal(window.document.getElementById('contextPreview'), null);
});

test('context card groups its controls into labelled scopes with inventory switches', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const card = doc.querySelector('section.settings-card[data-settings-section="context"]');

  // Three ruled, labelled groups: sources / managed runtime / advanced context (T1/T9).
  const groups = card.querySelectorAll('.settings-group');
  assert.equal(groups.length, 3);
  for (const group of groups) {
    assert.equal(group.getAttribute('role'), 'group');
    const headingId = group.getAttribute('aria-labelledby');
    assert.ok(headingId && doc.getElementById(headingId), `group heading ${headingId} resolves`);
  }

  // History scope select is programmatically labelled (T9).
  assert.ok(card.querySelector('label.settings-field-label[for="contextHistoryScopeSelect"]'));

  // Every context toggle is now an inventory switch — no raw checkboxes remain (T4).
  assert.equal(card.querySelectorAll('input[type="checkbox"]').length, 0);
  const switchIds = [
    'contextIncludePersonalityToggle', 'contextIncludeMemoryToggle',
    'contextTokenBudgetToggle', 'contextCompactionToggle',
  ];
  for (const id of switchIds) {
    const sw = card.querySelector(`[data-inv-toggle="${id}"]`);
    assert.ok(sw, `${id} renders as a switch`);
    assert.equal(sw.getAttribute('role'), 'switch');
  }

  // Switches land in the right persistence-keyed container.
  assert.equal(doc.getElementById('contextSourcesList').querySelectorAll('[data-inv-toggle]').length, 2);
  assert.equal(doc.getElementById('contextRuntimeList').querySelectorAll('[data-inv-toggle]').length, 2);
});

test('Settings keeps only additive custom summarization guidance', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      compaction: {
        async getTuning() {
          return {
            ratioByModel: { 'gpt-test': 0.6 },
            contextLengthByModel: { 'gpt-test': 65536 },
            contextLengthSteps: [4096, 8192, 16384, 32768, 65536, 131072, 262144],
            customPrompt: 'Existing prompt.',
          };
        },
      },
    },
  });
  // A session is required so getCurrentRuntimePreferences resolves an active
  // model (gpt-test, the harness default) instead of the empty draft.
  window.document.getElementById('newChatButton').click();
  await waitForUi(window, 30);

  let promptField = window.document.getElementById('compactionPromptField');
  assert.ok(promptField, 'compactionPromptField renders');
  assert.equal(window.document.getElementById('compactionRatioField'), null);
  assert.equal(window.document.getElementById('contextWindowSlider'), null);
  assert.equal(window.document.getElementById('compactionCompactNowButton'), null);

  // Hydration keeps the bounded optional guidance but does not reintroduce model tuning here.
  await waitForUi(window, 20);
  promptField = window.document.getElementById('compactionPromptField');
  assert.equal(promptField.value, 'Existing prompt.');

  promptField.value = 'Preserve API decisions.';
  promptField.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 20);

  assert.equal(shell.__state.compactionSetTuningCalls.length, 1);
  assert.equal(JSON.stringify(shell.__state.compactionSetTuningCalls[0]),
    JSON.stringify({ customPrompt: 'Preserve API decisions.' }));
  assert.match(window.document.getElementById('compactionTuningStatus').textContent,
    /Summarization guidance applied/i);

  window.document.querySelector('[data-action="reset-compaction-prompt"]').click();
  await waitForUi(window, 20);
  assert.equal(JSON.stringify(shell.__state.compactionSetTuningCalls[1]), JSON.stringify({ customPrompt: '' }));
});

test('Settings clears pending summarization guidance after an IPC failure', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      compaction: {
        async getTuning() {
          return { ratioByModel: {}, contextLengthByModel: {}, contextLengthSteps: [], customPrompt: '' };
        },
        setTuning() { throw new Error('bridge unavailable'); },
      },
    },
  });
  window.document.getElementById('newChatButton').click();
  await waitForUi(window, 30);
  const promptField = window.document.getElementById('compactionPromptField');
  promptField.value = 'Preserve decisions.';
  promptField.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);
  assert.equal(window.document.getElementById('compactionPromptField').disabled, false);
  assert.doesNotMatch(window.document.getElementById('compactionTuningStatus').textContent, /Applying/i);
});

test('Settings never owns Compact now, including when the manual feature flag is on', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: { features: { state: { featureFlags: { compaction_manual: true } } } },
  });
  window.document.getElementById('newChatButton').click();
  await waitForUi(window, 30);

  assert.equal(window.document.getElementById('compactionCompactNowButton'), null);
});

test('/compact invokes the shared coordinator without sending or adding a transcript prompt', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async compactNow() {
          return { status: 'ok', compacted: true, tokens_before: 400, tokens_after: 120, snapshot_persisted: true };
        },
      },
    },
  });
  window.document.getElementById('newChatButton').click();
  await waitForUi(window, 30);

  const input = window.document.getElementById('chatInput');
  input.value = '/compact';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 40);

  assert.equal(shell.__state.compactNowCalls.length, 1);
  assert.equal(shell.__state.chatCalls.length, 0);
  assert.doesNotMatch(window.document.getElementById('chatTimeline').textContent, /\/compact/);
  assert.match(window.document.getElementById('composerStatusNotice').textContent, /Future turns use the compact context/i);
});

test('/help lists /compact as a runnable command', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  window.document.getElementById('newChatButton').click();
  await waitForUi(window, 30);
  const input = window.document.getElementById('chatInput');
  input.value = '/help';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 40);

  assert.equal(shell.__state.chatCalls.length, 0);
  assert.match(window.document.getElementById('chatTimeline').textContent, /\/compact/);
});
