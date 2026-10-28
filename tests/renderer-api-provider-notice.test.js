'use strict';

// Row 78 renderer seams outside Settings: Composer's picker groups each
// API-key provider under its own label (variant P1), and the first send to a
// provider waits for the one-time notice (variant N1).

const test = require('node:test');
const assert = require('node:assert/strict');

const { groupCatalogEntries } = require('../renderer/chat/renderer-composer-model-picker-utils.js');
const { createApiProviderNotice, instanceIdOf } = require('../renderer/chat/renderer-api-provider-notice.js');

function providerEntry(instanceId, provider, modelId, extra = {}) {
  return {
    id: `api-provider/${instanceId}/${modelId}`, label: modelId, provider, engine_type: 'api-provider',
    available: true, apiProviderInstanceId: instanceId, apiProviderModelId: modelId, hasKey: true, limitsUnknown: false,
    capabilities: { vision: true, thinking: true }, ...extra,
  };
}

test('each provider is its own group after the local engines and ChatGPT, named by its label', () => {
  const groups = groupCatalogEntries([
    providerEntry('lab-box', 'Lab box', 'my-finetune-q8', { limitsUnknown: true }),
    { id: 'qwen3.8:27b', engine_type: 'ollama' },
    providerEntry('openrouter', 'OpenRouter', 'openai/gpt-6-luna'),
    { id: 'gpt-6-luna', engine_type: 'chatgpt' },
    providerEntry('openrouter', 'OpenRouter', 'qwen/qwen4', { hasKey: false }),
  ]);
  assert.deepEqual(groups.map((group) => group.label), ['Ollama', 'ChatGPT', 'Lab box', 'OpenRouter']);
  const openrouter = groups.find((group) => group.key === 'api-provider:openrouter');
  // The row shows the provider's own id, never the namespaced one split on ':'.
  assert.deepEqual(openrouter.entries.map((entry) => [entry.family, entry.tag]), [['openai/gpt-6-luna', ''], ['qwen/qwen4', '']]);
  assert.equal(openrouter.entries[0].hint, '');
  assert.match(openrouter.entries[1].hint, /Add a key/);
  assert.match(groups.find((group) => group.label === 'Lab box').entries[0].hint, /Limits unknown/);
  assert.equal(groups[0].entries[0].hint, '');
});

test('instanceIdOf reads only namespaced provider ids', () => {
  assert.equal(instanceIdOf('api-provider/openrouter/openai/gpt-6-luna'), 'openrouter');
  assert.equal(instanceIdOf('qwen3.8:27b'), '');
  assert.equal(instanceIdOf('api-provider/'), '');
  assert.equal(instanceIdOf(null), '');
});

function noticeHarness({ acknowledged = false, confirm = true, ack = { ok: true } } = {}) {
  const calls = [];
  const dialogs = [];
  const bridge = {
    async getState() {
      return { instances: [{ id: 'openrouter', label: 'OpenRouter', noticeAcknowledgedAt: acknowledged ? '2026-10-25T00:00:00Z' : null }] };
    },
    onChanged() { return () => {}; },
    async acknowledgeNotice(payload) { calls.push(payload); return ack; },
  };
  const notice = createApiProviderNotice({
    getBridge: () => bridge,
    createDialog: () => ({ async confirm(payload) { dialogs.push(payload); return confirm; } }),
  });
  return { notice, calls, dialogs };
}

test('a local model or an acknowledged provider passes synchronously', async () => {
  const { notice, dialogs } = noticeHarness({ acknowledged: true });
  assert.equal(notice.confirmFirstSend('qwen3.8:27b'), true);
  await notice.load();
  assert.equal(notice.confirmFirstSend('api-provider/openrouter/openai/gpt-6-luna'), true);
  assert.equal(dialogs.length, 0);
});

test('the first send asks once; Send records the acknowledgement and later sends pass', async () => {
  const { notice, calls, dialogs } = noticeHarness();
  await notice.load();
  const first = notice.confirmFirstSend('api-provider/openrouter/openai/gpt-6-luna');
  assert.equal(typeof first.then, 'function');
  assert.equal(await first, true);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].title, /OpenRouter/);
  assert.match(dialogs[0].message, /receives your messages/);
  assert.deepEqual(calls, [{ instanceId: 'openrouter' }]);
  assert.equal(notice.confirmFirstSend('api-provider/openrouter/qwen/qwen4'), true);
});

test('Cancel, a failed acknowledgement or a missing dialog keeps the message here', async () => {
  const cancelled = noticeHarness({ confirm: false });
  assert.equal(await cancelled.notice.confirmFirstSend('api-provider/openrouter/x'), false);
  assert.deepEqual(cancelled.calls, []);
  const refused = noticeHarness({ ack: { ok: false, code: 'write_failed' } });
  assert.equal(await refused.notice.confirmFirstSend('api-provider/openrouter/x'), false);
  const noDialog = createApiProviderNotice({
    getBridge: () => ({ async getState() { return { instances: [{ id: 'openrouter', label: 'OpenRouter', noticeAcknowledgedAt: null }] }; } }),
    createDialog: () => null,
  });
  assert.equal(await noDialog.confirmFirstSend('api-provider/openrouter/x'), false);
});

test('a provider the state cannot answer for still asks, under its instance id', async () => {
  const dialogs = [];
  const notice = createApiProviderNotice({
    getBridge: () => ({
      async getState() { throw new Error('ipc down'); },
      async acknowledgeNotice() { return { ok: false, code: 'unknown_instance' }; },
    }),
    createDialog: () => ({ async confirm(payload) { dialogs.push(payload); return true; } }),
  });
  assert.equal(await notice.confirmFirstSend('api-provider/openrouter/x'), false);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].title, /openrouter/);
});

test('two sends while the dialog is open share it', async () => {
  const { notice, dialogs } = noticeHarness();
  const [a, b] = [notice.confirmFirstSend('api-provider/openrouter/x'), notice.confirmFirstSend('api-provider/openrouter/y')];
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(dialogs.length, 1);
});

test('the send boundary asks the notice right after the Auto-run gate', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'chat', 'renderer-send-utils.js'), 'utf8');
  const auto = source.indexOf('confirmAutoSend');
  const notice = source.indexOf('rendererApiProviderNotice?.confirmFirstSend?.(runtimePreferences.preferredModel || state.status?.model)');
  const outbox = source.indexOf('Legacy outbox capture and draft consumption must precede any await');
  assert.ok(auto > 0 && notice > auto && outbox > notice);
  assert.match(source.slice(notice, notice + 200), /if \(providerNotice !== true && await providerNotice !== true\) return null;/);
});
