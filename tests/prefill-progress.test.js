"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { acceptPrefillProgress } = require('../services/backend/prefill-progress');
const { supportsPrefillProgress } = require('../services/backend/llama-server-capabilities');
const { createStreamActivityRow } = require('../renderer/chat/renderer-stream-activity-row');

const attempt = 'a'.repeat(32);
const params = (state = 'sample', sequence = 2, patch = {}) => ({
  request_id: 'request', session_id: 'session', kind: 'status', persist: false,
  progress: { state, attempt_id: attempt, sequence, total_tokens: 10000, cached_tokens: 1000,
    processed_tokens: 2000, elapsed_ms: 200, ...patch },
});
const context = () => ({ streamId: 'request', resolvedSessionId: 'session', turnId: 'turn' });

test('only the frozen build and exact commit prefix qualify', () => {
  assert.equal(supportsPrefillProgress({ ok: true, build: 11513, commit: '71ad0590f' }), true);
  for (const bad of [{ ok: false }, { build: 11514 }, { commit: '71ad0590e' }, { commit: '' }, { commit: '71ad0590ffff' }]) {
    assert.equal(supportsPrefillProgress({ ok: true, build: 11513, commit: '71ad0590f', ...bad }), false);
  }
});

test('scopes every sample and rejects stale attempts, duplicates and regression', () => {
  const ctx = context();
  assert.equal(acceptPrefillProgress(ctx, params()), null, 'sample without start');
  assert.equal(acceptPrefillProgress(ctx, { ...params('start', 1), session_id: 'other' }), null);
  const started = acceptPrefillProgress(ctx, params('start', 1));
  assert.equal(started.moved, false);
  assert.equal(started.progress.turnId, 'turn');
  const sample = acceptPrefillProgress(ctx, params());
  assert.equal(sample.moved, true);
  assert.equal(sample.progress.processed - sample.progress.cached, 1000);
  assert.equal(acceptPrefillProgress(ctx, params()), null);
  assert.equal(acceptPrefillProgress(ctx, params('sample', 3, { processed_tokens: 1999 })).progress.state, 'unavailable');
  assert.equal(acceptPrefillProgress(ctx, params('sample', 4)), null);
  acceptPrefillProgress(ctx, params('start', 1, { attempt_id: 'b'.repeat(32) }));
  assert.equal(acceptPrefillProgress(ctx, params('start', 1)), null, 'retired start cannot reactivate');
  assert.equal(acceptPrefillProgress(ctx, params('sample', 5)), null, 'old sample');
});

test('invalid wire counts degrade to indeterminate without touching liveness', () => {
  for (const patch of [{ total_tokens: true }, { total_tokens: 1048577 }, { cached_tokens: 3000 },
    { processed_tokens: 1.2 }, { elapsed_ms: Infinity }, { elapsed_ms: '10' }, { total_tokens: 0 }]) {
    const ctx = context(); acceptPrefillProgress(ctx, params('start', 1));
    const result = acceptPrefillProgress(ctx, params('sample', 2, patch));
    assert.equal(result.progress.state, 'unavailable'); assert.equal(result.moved, false);
  }
});

test('existing activity row advances, clears on output, ignores late samples and disposes', t => {
  const dom = new JSDOM('<div id="timeline"><article class="chat-entry assistant"><div class="chat-message-content">old answer</div></article><article class="chat-entry user">new question</article></div>');
  const timeline = dom.window.document.getElementById('timeline');
  let clock = 0;
  const row = createStreamActivityRow({ getChatTimeline: () => timeline, isStreamLive: () => true,
    isSessionVisible: () => true, now: () => clock, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  t.after(() => { row.dispose(); dom.window.close(); });
  const ctx = context();
  const deliver = p => { const result = acceptPrefillProgress(ctx, p); if (result) row.noteStreamEvent({
    type: 'thinking_status', streamId: 'request', sessionId: 'session', turnId: 'turn', progress: result.progress }); };
  deliver(params('start', 1)); assert.equal(timeline.querySelectorAll('.turn-activity-row').length, 0);
  clock = 500; deliver(params());
  let node = timeline.querySelector('[data-turn-activity-kind="prefill"]');
  assert.ok(node); assert.equal(node.parentElement, timeline, 'prefill stays after current user'); assert.match(node.textContent, /1,000 of 9,000 new tokens/);
  assert.equal(node.style.getPropertyValue('--prefill-cache'), '0.1');
  assert.equal(node.querySelector('.turn-activity-label').getAttribute('aria-live'), 'off');
  clock = 750; deliver(params('sample', 3, { processed_tokens: 5000, elapsed_ms: 400 }));
  assert.equal(timeline.querySelector('[data-turn-activity-kind="prefill"]'), node);
  assert.match(node.textContent, /4,000 of 9,000 new tokens/);
  row.noteStreamEvent({ type: 'delta', streamId: 'request', sessionId: 'session' });
  deliver(params('sample', 4, { processed_tokens: 6000, elapsed_ms: 500 }));
  assert.equal(timeline.querySelectorAll('.turn-activity-row').length, 0, 'late sample never resurrects row');
  deliver(params('start', 1, { attempt_id: 'b'.repeat(32) }));
  deliver(params('sample', 2, { attempt_id: 'b'.repeat(32) }));
  assert.ok(timeline.querySelector('.turn-activity-row'));
  row.noteStreamEvent({ type: 'complete', streamId: 'request', sessionId: 'session' });
  assert.equal(timeline.querySelectorAll('.turn-activity-row').length, 0);
});


test('managed prefill opt-in is confined to the actual managed endpoint and flag', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { BackendService } = require('../services/backend/backend-service');
  const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-prefill-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = { supportsPrefillProgress: () => true, getBaseUrl: () => 'http://127.0.0.1:8048/v1' };
  const service = new BackendService({ userDataPath: root, repoRoot: process.cwd(),
    getLlamaServerManager: () => manager });
  service.currentEngineType = 'openai-compatible';
  service.featureFlags = { prefill_progress: true };
  let apiUrl = 'http://127.0.0.1:8048/v1';
  service.configService = { getState: () => ({ localEngines: { openaiCompatible: { apiUrl, port: 8048 } } }) };
  assert.equal(buildManagedSidecarConfig(service).managed_prefill_progress, true);
  apiUrl = 'http://127.0.0.1:9000/v1';
  assert.equal(buildManagedSidecarConfig(service).managed_prefill_progress, false);
  apiUrl = 'http://127.0.0.1:8048/v1';
  service.featureFlags.prefill_progress = false;
  assert.equal(buildManagedSidecarConfig(service).managed_prefill_progress, false);
});

test('every tool-loop attempt in one stream can show progress; percent follows the locale', t => {
  const ctx = context();
  for (let index = 0; index < 70; index += 1) {
    const id = index.toString(16).padStart(32, '0');
    assert.ok(acceptPrefillProgress(ctx, params('start', 1, { attempt_id: id })), `attempt ${index}`);
  }
  const dom = new JSDOM('<html lang="fr"><body><div id="timeline"><article class="chat-entry user">q</article></div></body></html>');
  const timeline = dom.window.document.getElementById('timeline');
  const row = createStreamActivityRow({ getChatTimeline: () => timeline, isStreamLive: () => true,
    isSessionVisible: () => true, now: () => 500, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  t.after(() => { row.dispose(); dom.window.close(); });
  const fresh = context();
  for (const p of [params('start', 1), params()]) {
    const result = acceptPrefillProgress(fresh, p);
    row.noteStreamEvent({ type: 'thinking_status', streamId: 'request', sessionId: 'session', turnId: 'turn', progress: result.progress });
  }
  const percent = new Intl.NumberFormat('fr', { style: 'percent', maximumFractionDigits: 0 }).format(0.11);
  assert.ok(timeline.textContent.includes(percent), timeline.textContent);
});
