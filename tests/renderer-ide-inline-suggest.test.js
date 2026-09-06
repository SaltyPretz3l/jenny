'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeInlineSuggest } = require('../renderer/features/renderer-ide-inline-suggest');
const { createIdeStatusBar } = require('../renderer/features/renderer-ide-statusbar');

function makeMonaco() {
  let provider = null;
  const monacoApi = {
    Range: class {
      constructor(sl, sc, el, ec) {
        this.startLineNumber = sl;
        this.startColumn = sc;
        this.endLineNumber = el;
        this.endColumn = ec;
      }
    },
    languages: {
      registerInlineCompletionsProvider(_selector, p) {
        provider = p;
        return { dispose() { provider = null; } };
      },
    },
  };
  return { monacoApi, getProvider: () => provider };
}

// Single-line fake model faithful to the Monaco surface boundedPrefixSuffix uses:
// getOffsetAt (fixed cursor offset), getPositionAt (offset->1-based column,
// clamped like Monaco), and getValueInRange (range->substring).
function makeModel(text, offset) {
  return {
    getValue: () => text,
    getOffsetAt: () => offset,
    getPositionAt: (off) => ({ lineNumber: 1, column: Math.min(text.length, Math.max(0, off)) + 1 }),
    getValueInRange: (range) => text.slice(range.startColumn - 1, range.endColumn - 1),
  };
}

const POS = { lineNumber: 1, column: 3 };
const TOKEN = { isCancellationRequested: false, onCancellationRequested() {} };

function renderInlineStatus(callbacks) {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div></body>');
  const statusBar = createIdeStatusBar({
    getDom: () => ({ ideStatusBar: dom.window.document.getElementById('sb'), ideBreadcrumbs: null }),
    getIde: () => ({ activeTabPath: 'src/app.js', wordWrap: 'off' }),
    callbacks: {
      getDocumentKind: () => 'file',
      getInlineSuggestVisible: () => true,
      getInlineSuggestEnabled: () => true,
      ...callbacks,
    },
  });
  statusBar.render();
  return dom.window.document.querySelector('.ide-statusbar-inline-suggest-warn');
}

function setup(overrides = {}) {
  const ide = {
    inlineSuggestEnabled: true,
    inlineSuggestModel: 'qwen2.5-coder:1.5b-base',
    ...(overrides.ide || {}),
  };
  const completeCalls = [];
  const windowRef = {
    jennyShell: {
      inline: {
        complete: async (payload) => {
          completeCalls.push(payload);
          return Object.prototype.hasOwnProperty.call(overrides, 'completeResult')
            ? overrides.completeResult
            : { ok: true, completion: 'X()' };
        },
      },
    },
    rendererIdeActiveEditorReader: { isLargeFile: () => overrides.largeFile === true },
  };
  const hookCalls = [];
  if (overrides.testHook) {
    windowRef.__jennyIdeInlineCompleteTestHook = async (payload) => {
      hookCalls.push(payload);
      return overrides.testHookResult || { ok: true, completion: 'HOOK()' };
    };
  }
  const editorHost = {
    getActivePath: () => (overrides.activePath !== undefined ? overrides.activePath : 'src/app.js'),
    getDocumentKind: () => (overrides.documentKind !== undefined ? overrides.documentKind : 'file'),
  };
  const { monacoApi, getProvider } = makeMonaco();
  const mod = createIdeInlineSuggest({
    editorHost,
    getIde: () => ide,
    isFeatureEnabled: () => overrides.flagOn !== false,
    isTestHookEnabled: () => overrides.testHookEnabled === true,
    windowRef,
    commitPreference: async (key, value) => {
      ide[key] = value;
      return { updated: true, value };
    },
  });
  return { mod, monacoApi, getProvider, completeCalls, hookCalls, ide };
}

test('does not register the provider when the feature flag is off', () => {
  const { mod, monacoApi, getProvider } = setup({ flagOn: false });
  mod.handleMonacoReady(monacoApi);
  assert.equal(getProvider(), null, 'no provider registered while the flag is off');
});

test('registers the provider and returns ghost text on the happy path', async () => {
  const { mod, monacoApi, getProvider, completeCalls } = setup();
  mod.handleMonacoReady(monacoApi);
  const provider = getProvider();
  assert.ok(provider, 'provider registered when the flag is on');
  completeCalls.length = 0; // drop the warm-on-ready call

  const result = await provider.provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items.map((i) => i.insertText), ['X()']);
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].model, 'qwen2.5-coder:1.5b-base');
  assert.equal(completeCalls[0].prefix, 'ab');
  assert.equal(completeCalls[0].suffix, 'XYZ');
  assert.equal('useGpu' in completeCalls[0], false);
});

test('returns no items when the quick toggle is off', async () => {
  const { mod, monacoApi, getProvider, completeCalls } = setup({ ide: { inlineSuggestEnabled: false } });
  mod.handleMonacoReady(monacoApi);
  completeCalls.length = 0;
  const result = await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items, []);
  assert.equal(completeCalls.length, 0, 'no backend call when disabled');
});

test('returns no items when no completion model is selected', async () => {
  const { mod, monacoApi, getProvider, completeCalls } = setup({ ide: { inlineSuggestModel: '' } });
  mod.handleMonacoReady(monacoApi);
  completeCalls.length = 0;
  const result = await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items, []);
  assert.equal(completeCalls.length, 0);
});

test('returns no items for a non-file document kind (diff/preview/image)', async () => {
  const { mod, monacoApi, getProvider, completeCalls } = setup({ documentKind: 'diff' });
  mod.handleMonacoReady(monacoApi);
  completeCalls.length = 0;
  const result = await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items, []);
  assert.equal(completeCalls.length, 0);
});

test('returns no items for a large file', async () => {
  const { mod, monacoApi, getProvider, completeCalls } = setup({ largeFile: true });
  mod.handleMonacoReady(monacoApi);
  completeCalls.length = 0;
  const result = await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items, []);
  assert.equal(completeCalls.length, 0);
});

test('returns no items when the backend reports a non-ok shape', async () => {
  const { mod, monacoApi, getProvider } = setup({ completeResult: { ok: false, reason: 'chat_stream_active' } });
  mod.handleMonacoReady(monacoApi);
  const result = await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items, []);
});

test('chat_stream_active pauses inline suggestions without marking the backend degraded', async () => {
  const { mod, monacoApi, getProvider } = setup({
    completeResult: { ok: false, reason: 'chat_stream_active' },
  });
  mod.handleMonacoReady(monacoApi);

  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);

  const callbacks = mod.statusCallbacks();
  assert.equal(callbacks.getInlineSuggestPaused(), true);
  assert.equal(callbacks.getInlineSuggestDegraded(), false);
});

test('a genuine ok completion clears both paused and degraded health flags', async () => {
  const result = { ok: false, reason: 'model_not_loaded' };
  const { mod, monacoApi, getProvider } = setup({ completeResult: result });
  mod.handleMonacoReady(monacoApi);
  const callbacks = mod.statusCallbacks();

  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  result.reason = 'chat_stream_active';
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(callbacks.getInlineSuggestDegraded(), true);
  assert.equal(callbacks.getInlineSuggestPaused(), true);

  result.ok = true;
  result.completion = '';
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(callbacks.getInlineSuggestDegraded(), false);
  assert.equal(callbacks.getInlineSuggestPaused(), false);
});

test('a paused round preserves a pre-existing degraded flag and the statusbar shows degraded', async () => {
  const result = { ok: false, reason: 'model_not_loaded' };
  const { mod, monacoApi, getProvider } = setup({ completeResult: result });
  mod.handleMonacoReady(monacoApi);
  const callbacks = mod.statusCallbacks();

  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(callbacks.getInlineSuggestDegraded(), true);
  result.reason = 'chat_stream_active';
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);

  assert.equal(callbacks.getInlineSuggestPaused(), true);
  assert.equal(callbacks.getInlineSuggestDegraded(), true);
  const marker = renderInlineStatus(callbacks);
  assert.equal(marker.dataset.diagSeverity, 'warning');
  assert.match(marker.title, /unavailable/i);
});

test('routes through the agent_test_hooks window seam when it is enabled and installed', async () => {
  const { mod, monacoApi, getProvider, completeCalls, hookCalls } = setup({
    testHookEnabled: true,
    testHook: true,
  });
  mod.handleMonacoReady(monacoApi);
  completeCalls.length = 0;
  hookCalls.length = 0; // drop the warm-on-ready call

  const result = await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items.map((i) => i.insertText), ['HOOK()']);
  assert.equal(hookCalls.length, 1, 'completion came from the test hook');
  assert.equal(hookCalls[0].prefix, 'ab');
  assert.equal(completeCalls.length, 0, 'the real frozen-bridge IPC is bypassed');
});

test('ignores the window seam when agent_test_hooks is off (inert in production)', async () => {
  const { mod, monacoApi, getProvider, completeCalls, hookCalls } = setup({
    testHookEnabled: false,
    testHook: true,
  });
  mod.handleMonacoReady(monacoApi);
  completeCalls.length = 0;
  hookCalls.length = 0;

  const result = await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.deepEqual(result.items.map((i) => i.insertText), ['X()'], 'real IPC served the completion');
  assert.equal(hookCalls.length, 0, 'the hook is never consulted while the gate is off');
  assert.equal(completeCalls.length, 1, 'fell through to the real IPC');
});

test('dispose unregisters the provider', () => {
  const { mod, monacoApi, getProvider } = setup();
  mod.handleMonacoReady(monacoApi);
  assert.ok(getProvider());
  mod.dispose();
  assert.equal(getProvider(), null);
});

test('warm() never fires the backend after dispose()', async () => {
  const { mod, monacoApi, completeCalls } = setup();
  mod.handleMonacoReady(monacoApi);
  await Promise.resolve();
  mod.dispose();
  completeCalls.length = 0;
  mod.warm();
  await Promise.resolve();
  assert.equal(completeCalls.length, 0, 'warm() is a no-op once disposed');
});

test('a non-ok / thrown completion flips the degraded warn state and repaints; an ok response clears it', async () => {
  let renders = 0;
  let result = { ok: false, reason: 'model_not_loaded' };
  const ide = { inlineSuggestEnabled: true, inlineSuggestModel: 'qwen2.5-coder:1.5b-base' };
  const windowRef = {
    jennyShell: { inline: { complete: async () => result } },
    rendererIdeActiveEditorReader: { isLargeFile: () => false },
  };
  const editorHost = { getActivePath: () => 'src/app.js', getDocumentKind: () => 'file' };
  const { monacoApi, getProvider } = makeMonaco();
  const mod = createIdeInlineSuggest({
    editorHost,
    getIde: () => ide,
    isFeatureEnabled: () => true,
    windowRef,
    requestStatusRender: () => { renders += 1; },
  });
  mod.handleMonacoReady(monacoApi);
  const cb = mod.statusCallbacks();
  assert.equal(cb.getInlineSuggestDegraded(), false, 'starts healthy');

  // Non-ok shape (model not loaded / sidecar down) -> degraded + one repaint.
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(cb.getInlineSuggestDegraded(), true, 'non-ok flips degraded');
  const rendersAfterFail = renders;
  assert.ok(rendersAfterFail >= 1, 'repainted the status bar on the state change');

  // Still degraded -> no extra repaint (only state CHANGES repaint).
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(renders, rendersAfterFail, 'no extra repaint while still degraded');

  // A genuine ok response clears it with exactly one repaint.
  result = { ok: true, completion: 'Z()' };
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(cb.getInlineSuggestDegraded(), false, 'ok response clears degraded');
  assert.equal(renders, rendersAfterFail + 1, 'cleared with exactly one repaint');
});

test('a thrown completion request also marks FIM degraded', async () => {
  const ide = { inlineSuggestEnabled: true, inlineSuggestModel: 'qwen2.5-coder:1.5b-base' };
  const windowRef = {
    jennyShell: { inline: { complete: async () => { throw new Error('sidecar down'); } } },
    rendererIdeActiveEditorReader: { isLargeFile: () => false },
  };
  const editorHost = { getActivePath: () => 'src/app.js', getDocumentKind: () => 'file' };
  const { monacoApi, getProvider } = makeMonaco();
  const mod = createIdeInlineSuggest({
    editorHost,
    getIde: () => ide,
    isFeatureEnabled: () => true,
    windowRef,
  });
  mod.handleMonacoReady(monacoApi);
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(mod.statusCallbacks().getInlineSuggestDegraded(), true, 'a thrown request degrades');
});

test('re-enabling suggestions clears stale degraded and paused status', async () => {
  let result = { ok: false, reason: 'model_not_loaded' };
  const ide = { inlineSuggestEnabled: true, inlineSuggestModel: 'qwen2.5-coder:1.5b-base' };
  const windowRef = {
    jennyShell: { inline: { complete: async () => result } },
    rendererIdeActiveEditorReader: { isLargeFile: () => false },
  };
  const editorHost = { getActivePath: () => 'src/app.js', getDocumentKind: () => 'file' };
  const { monacoApi, getProvider } = makeMonaco();
  const mod = createIdeInlineSuggest({
    editorHost,
    getIde: () => ide,
    isFeatureEnabled: () => true,
    windowRef,
    commitPreference: async (key, value) => { ide[key] = value; return { updated: true, value }; },
    requestStatusRender: () => {},
  });
  mod.handleMonacoReady(monacoApi);
  const cb = mod.statusCallbacks();
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(cb.getInlineSuggestDegraded(), true, 'degraded after a non-ok request');
  result = { ok: false, reason: 'chat_stream_active' };
  await getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  assert.equal(cb.getInlineSuggestPaused(), true, 'paused during an active chat stream');

  await cb.onToggleInlineSuggest(); // turn suggestions off
  assert.equal(ide.inlineSuggestEnabled, false);
  await cb.onToggleInlineSuggest(); // turn back on -> clears the stale warn
  assert.equal(ide.inlineSuggestEnabled, true);
  assert.equal(cb.getInlineSuggestDegraded(), false, 're-enabling starts from a clean slate');
  assert.equal(cb.getInlineSuggestPaused(), false, 're-enabling clears paused status too');
});

test('a completion that resolves after dispose neither sets degraded nor repaints', async () => {
  let resolveComplete = null;
  let renders = 0;
  const ide = { inlineSuggestEnabled: true, inlineSuggestModel: 'qwen2.5-coder:1.5b-base' };
  const windowRef = {
    jennyShell: { inline: { complete: () => new Promise((res) => { resolveComplete = res; }) } },
    rendererIdeActiveEditorReader: { isLargeFile: () => false },
  };
  const editorHost = { getActivePath: () => 'src/app.js', getDocumentKind: () => 'file' };
  const { monacoApi, getProvider } = makeMonaco();
  const mod = createIdeInlineSuggest({
    editorHost,
    getIde: () => ide,
    isFeatureEnabled: () => true,
    windowRef,
    requestStatusRender: () => { renders += 1; },
  });
  mod.handleMonacoReady(monacoApi);
  const cb = mod.statusCallbacks();
  // Kick off a real request and let the debounce + prefix/suffix read run so it
  // parks on the (deferred) backend call. A fixed wait (not a poll) is used on
  // purpose: warm() shares the same windowRef.inline.complete() resolver, so
  // `resolveComplete` cannot distinguish the provider's call from the warm call —
  // disposing as soon as it is set would race the provider's debounce into a
  // post-dispose (null-monaco) repaint. The wait must exceed the 250ms debounce.
  const pending = getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(typeof resolveComplete, 'function', 'request reached the backend call');

  // Dispose mid-flight, then let the request resolve with a non-ok shape.
  mod.dispose();
  const rendersAtDispose = renders;
  resolveComplete({ ok: false });
  await pending;
  assert.equal(renders, rendersAtDispose, 'no status-bar repaint after dispose');
  assert.equal(cb.getInlineSuggestDegraded(), false, 'no degraded mutation after dispose');
});

test('a successful completion resolving after dispose returns empty without repainting', async () => {
  let resolveComplete = null;
  let renders = 0;
  const ide = { inlineSuggestEnabled: true, inlineSuggestModel: 'qwen2.5-coder:1.5b-base' };
  const windowRef = {
    jennyShell: { inline: { complete: () => new Promise((resolve) => { resolveComplete = resolve; }) } },
    rendererIdeActiveEditorReader: { isLargeFile: () => false },
  };
  const editorHost = { getActivePath: () => 'src/app.js', getDocumentKind: () => 'file' };
  const { monacoApi, getProvider } = makeMonaco();
  const mod = createIdeInlineSuggest({
    editorHost,
    getIde: () => ide,
    isFeatureEnabled: () => true,
    windowRef,
    requestStatusRender: () => { renders += 1; },
  });
  mod.handleMonacoReady(monacoApi);
  const pending = getProvider().provideInlineCompletions(makeModel('abXYZ', 2), POS, {}, TOKEN);
  await new Promise((resolve) => setTimeout(resolve, 300));
  mod.dispose();
  const rendersAtDispose = renders;
  resolveComplete({ ok: true, completion: 'Y', computeTarget: 'cpu' });

  assert.deepEqual(await pending, { items: [] });
  assert.equal(renders, rendersAtDispose);
});

test('statusCallbacks expose visibility/enabled and apply the toggle after acknowledgement', async () => {
  const ide = { inlineSuggestEnabled: true };
  let persists = 0;
  let renders = 0;
  const mod = createIdeInlineSuggest({
    getIde: () => ide,
    isFeatureEnabled: () => true,
    commitPreference: async (key, value) => {
      persists += 1; ide[key] = value; return { updated: true, value };
    },
    requestStatusRender: () => { renders += 1; },
  });
  const cb = mod.statusCallbacks();
  assert.equal(cb.getInlineSuggestVisible(), true);
  assert.equal(cb.getInlineSuggestEnabled(), true);
  await cb.onToggleInlineSuggest();
  assert.equal(ide.inlineSuggestEnabled, false, 'toggle disables');
  assert.equal(cb.getInlineSuggestEnabled(), false);
  assert.equal(persists, 1, 'persisted the change');
  assert.equal(renders, 1, 're-rendered the status bar');
  await cb.onToggleInlineSuggest();
  assert.equal(ide.inlineSuggestEnabled, true, 'toggle re-enables');
});

test('statusCallbacks.getInlineSuggestVisible is false when the flag is off', () => {
  const mod = createIdeInlineSuggest({ getIde: () => ({}), isFeatureEnabled: () => false });
  assert.equal(mod.statusCallbacks().getInlineSuggestVisible(), false);
});

// The model-tag sanitizer must stay byte-identical across the schema (Node) and
// renderer-state (UMD) copies — UMD can't import services, so the duplication is
// structural. This guard fails loudly if the security-relevant whitelist drifts;
// renderer/shell/renderer-settings-editor-section.js delegates to the
// renderer-state copy, so covering these two covers all three call sites.
test('model-tag sanitizer agrees across the schema and renderer-state copies', () => {
  const { normalizeInlineSuggestModel } = require('../services/workspace-ide-config-schema');
  const { sanitizeInlineSuggestModel } = require('../renderer/features/renderer-ide-state');
  const cases = [
    'qwen2.5-coder:1.5b-base', 'granite-code:3b', 'registry.example.com/ns/model:tag',
    'UPPER_and.lower-123', '', '   spaced  ', 'has space', 'semi;colon', 'pipe|cmd',
    '$(whoami)', 'back`tick`', '../traversal', '-leading-dash', '.leading-dot',
    'a'.repeat(200), 'a'.repeat(201),
  ];
  for (const input of cases) {
    assert.equal(
      sanitizeInlineSuggestModel(input),
      normalizeInlineSuggestModel(input),
      `sanitizers diverge for input ${JSON.stringify(input)}`
    );
  }
});
