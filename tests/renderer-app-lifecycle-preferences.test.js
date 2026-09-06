'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

delete global.rendererAppLifecyclePreferences;
require('../renderer/app/renderer-app-lifecycle-preferences');

const {
  createChatTimelinePreferenceController,
  createStartupAuditRuntime,
} = global.rendererAppLifecyclePreferences;

test('startup-audit auto-send claims the attempt before awaiting configuration', async () => {
  const configResolvers = [];
  const sendCalls = [];
  const runtime = createStartupAuditRuntime({
    windowRef: {
      jennyShell: {
        diagnostics: {
          getStartupAuditConfig() {
            return new Promise((resolve) => {
              configResolvers.push(resolve);
            });
          },
        },
      },
    },
    state: {
      backend: { phase: 'ready' },
      auth: { authenticated: true },
      runtimeDraft: {},
    },
    dom: { chatInput: { value: '' } },
    callbacks: {
      startPromptSend(prompt, options) {
        sendCalls.push({ prompt, options });
      },
    },
  });

  const first = runtime.runStartupAuditAutoSend();
  const second = runtime.runStartupAuditAutoSend();

  assert.equal(configResolvers.length, 1, 'concurrent calls share one configuration lookup');
  configResolvers[0]({ enabled: true, prompt: 'Audit once' });
  await Promise.all([first, second]);
  assert.deepEqual(sendCalls, [{ prompt: 'Audit once', options: { startupAudit: true } }]);
});

test('chat-timeline rollout signal keys evict the oldest entry without capping counters', () => {
  const state = {
    currentSessionId: 'rollout-session',
    ui: {
      chatTimelineRowModelBySession: new Map(),
      chatTimelineRowModelMetaBySession: new Map(),
    },
  };
  const controller = createChatTimelinePreferenceController({
    state,
    storage: null,
    storageKeys: {},
    callbacks: {},
  });

  for (let index = 0; index < 513; index += 1) {
    controller.recordChatTimelineRolloutSignal(
      'rollout-session',
      'stale_row_deletion',
      { turnId: `turn-${index}` },
    );
  }

  const meta = controller.getChatTimelineRowModelMeta('rollout-session');
  const signalKeyCount = meta.signal_keys instanceof Map
    ? meta.signal_keys.size
    : Object.keys(meta.signal_keys).length;
  const hasSignalKey = (key) => meta.signal_keys instanceof Map
    ? meta.signal_keys.has(key)
    : meta.signal_keys[key] === true;
  assert.equal(meta.telemetry_counters.stale_row_deletion, 513);
  assert.equal(signalKeyCount, 512, 'per-session dedupe retention stays bounded');
  assert.equal(hasSignalKey('stale_row_deletion:turn-0'), false, 'the oldest key is evicted');
  assert.equal(hasSignalKey('stale_row_deletion:turn-512'), true, 'the newest key is retained');
});

// One owner session logged 256 timeline_dom_write records, 217 of them from a
// single lane, every one at WARN. A routine success is not a warning, and at
// that volume it hides the fallbacks the lane-merge decisions actually ride on.
// So: successes collapse to one INFO line per lane, and anything that did NOT
// morph stays WARN and is counted every time.
test('timeline_dom_write: successes collapse to one INFO per lane, failures always log at WARN', () => {
  const logged = [];
  const state = {
    currentSessionId: 'dom-write-session',
    ui: {
      chatTimelineRowModelBySession: new Map(),
      chatTimelineRowModelMetaBySession: new Map(),
    },
  };
  const controller = createChatTimelinePreferenceController({
    state,
    storage: null,
    storageKeys: {},
    callbacks: {
      appendClientLog(level, event, details) {
        logged.push({ level, event, details });
      },
    },
  });
  const record = (lane, outcome) => controller.recordChatTimelineRolloutSignal(
    'dom-write-session',
    'timeline_dom_write',
    { lane, outcome },
  );

  for (let index = 0; index < 50; index += 1) {
    record('turn_row_list', 'morph_applied');
  }
  record('full_render', 'morph_applied');
  for (let index = 0; index < 3; index += 1) {
    record('full_render', 'raw_innerhtml');
  }

  const domWrites = logged.filter((entry) => entry.details.signal === 'timeline_dom_write');
  assert.deepEqual(
    domWrites.map((entry) => `${entry.level}:${entry.details.lane}:${entry.details.outcome}`),
    [
      'INFO:turn_row_list:morph_applied',
      'INFO:full_render:morph_applied',
      'WARN:full_render:raw_innerhtml',
      'WARN:full_render:raw_innerhtml',
      'WARN:full_render:raw_innerhtml',
    ],
    '50 identical successes collapse to one line per lane; every failure is kept'
  );
  assert.equal(
    controller.getChatTimelineRowModelMeta('dom-write-session')
      .telemetry_counters.timeline_dom_write,
    54,
    'the aggregate counter still sees every write, including the deduped ones'
  );
});

test('healthy rebuild and evidence rollout signals resolve to INFO without hiding anomalies', () => {
  const logged = [];
  const controller = createChatTimelinePreferenceController({
    state: {
      currentSessionId: 'level-session',
      ui: {
        chatTimelineRowModelBySession: new Map(),
        chatTimelineRowModelMetaBySession: new Map(),
      },
    },
    storage: null,
    storageKeys: {},
    callbacks: {
      appendClientLog(level, event, details) {
        logged.push({ level, event, details });
      },
    },
  });
  const resolveLevel = controller.resolveChatTimelineRolloutSignalLevel;
  const buildKey = controller.buildChatTimelineSignalKey;

  for (const signal of ['active_turn_root_rebuild', 'streaming_article_rebuild']) {
    assert.equal(resolveLevel(signal, { outcome: ' morph_applied ' }), 'INFO');
    assert.equal(resolveLevel(signal, { outcome: 'fallback_rebuild' }), 'WARN');
  }
  for (const signal of [
    'canonical_projection_applied',
    'terminal_reconcile_clean',
    'terminal_canonical_parity',
  ]) {
    assert.equal(resolveLevel(signal), 'INFO');
    assert.equal(buildKey(signal), '');
  }

  assert.equal(
    buildKey('active_turn_root_rebuild', { reason: ' tail_fingerprint ', outcome: ' morph_applied ' }),
    'active_turn_root_rebuild:tail_fingerprint:morph_applied'
  );
  assert.equal(buildKey('active_turn_root_rebuild', { outcome: 'fallback_rebuild' }), '');
  assert.equal(
    buildKey('streaming_article_rebuild', { outcome: ' morph_applied ' }),
    'streaming_article_rebuild:morph_applied'
  );
  assert.equal(buildKey('streaming_article_rebuild', { outcome: 'fallback_rebuild' }), '');
  assert.equal(resolveLevel('unknown_signal'), 'WARN');
  assert.equal(buildKey('unknown_signal'), '');
  const record = (signal, outcome) => controller.recordChatTimelineRolloutSignal(
    'level-session',
    signal,
    { outcome },
  );

  assert.deepEqual(record('streaming_article_rebuild', 'morph_applied'), { logged: true, count: 1 });
  assert.deepEqual(record('streaming_article_rebuild', 'morph_applied'), { logged: false, count: 2 });
  assert.deepEqual(record('streaming_article_rebuild', 'fallback_rebuild'), { logged: true, count: 3 });
  assert.deepEqual(record('streaming_article_rebuild', 'fallback_rebuild'), { logged: true, count: 4 });
  assert.deepEqual(record('unknown_signal', 'morph_applied'), { logged: true, count: 1 });

  assert.deepEqual(
    logged.map((entry) => `${entry.level}:${entry.details.signal}:${entry.details.outcome}`),
    [
      'INFO:streaming_article_rebuild:morph_applied',
      'WARN:streaming_article_rebuild:fallback_rebuild',
      'WARN:streaming_article_rebuild:fallback_rebuild',
      'WARN:unknown_signal:morph_applied',
    ]
  );
});
