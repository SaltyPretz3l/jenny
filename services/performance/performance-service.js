'use strict';

/* services/performance/performance-service.js - the performance.* bridge
 * operations (row 59 checkpoint 6). Owns closed request validation and the
 * snapshot `{ok, settings, inference, gpu}`; it composes the settings store, the
 * per-session inference intake and the GPU sampler + warning tracker, and tells
 * the sampler what is demanded.
 *
 * Sampler demand rule (kept simple on purpose):
 *   counter      - performanceTelemetry.showCounter
 *   warnings     - performanceTelemetry.gpuWarningsEnabled
 *   subscribers  - 1 while a renderer lease is live: every getSnapshot call renews
 *                  a SUBSCRIBER_LEASE_MS lease (a renderer with an onChanged
 *                  listener refetches on each invalidation, so an attached view
 *                  keeps renewing it; a closed one lets it lapse)
 *   active       - a managed NInfer chat stream is live (setActiveGeneration)
 *   identity     - the managed NInfer {pid, createdAt} (setRuntimeIdentity)
 * With none of counter/warnings/subscribers set, or no identity, nothing samples.
 */

const { createChangeNotifier } = require('../chat-workspace-change-notifier');
const {
  fail, succeed, validateDismissWarningRequest, validateGetSnapshotRequest, validateUpdateSettingsRequest,
} = require('./performance-contract');
const {
  DEFAULT_PERFORMANCE_TELEMETRY, isReadOnlyPerformanceTelemetry, normalizePerformanceTelemetry,
} = require('../shell-config-performance');

const SUBSCRIBER_LEASE_MS = 20_000;

// Wire settings (snake_case). A block from a newer schema is not interpreted: defaults.
function settingsView(telemetry) {
  const effective = isReadOnlyPerformanceTelemetry(telemetry)
    ? DEFAULT_PERFORMANCE_TELEMETRY : normalizePerformanceTelemetry(telemetry);
  return { schema_version: 1, show_counter: effective.showCounter, gpu_warnings_enabled: effective.gpuWarningsEnabled };
}

function createPerformanceService({
  shellConfig, intake, sampler, tracker, emitChanged = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let active = false;
  let identity = null;
  let leaseUntil = 0;
  let leaseTimer = null;
  let disposed = false;
  let lastGpuSignature = '';
  // Invalidations only: `{session_id, terminal, scope}`. Throttled ones (inference
  // progress, plain GPU state) share the <= 4/s/session notifier, keyed `scope:session`;
  // terminal, settings and warning transitions bypass it.
  const send = (scope, sessionId, terminal = false) => {
    try { emitChanged({ session_id: sessionId, terminal, scope }); } catch (_error) { /* a closing window */ }
  };
  const throttled = createChangeNotifier({
    emit: ({ session_id: key }) => {
      const split = key.indexOf(':');
      send(key.slice(0, split), key.slice(split + 1) || null);
    },
    now, setTimer, clearTimer,
  });
  const notifier = {
    inferenceChanged: (sessionId) => throttled.notify(`inference:${sessionId}`),
    gpuChanged: () => throttled.notify('gpu:'),
    terminalInference: (sessionId) => send('inference', sessionId, true),
    settingsChanged: () => send('settings', null),
    warningChanged: () => send('gpu', null),
    dispose: () => throttled.dispose(),
  };

  const readTelemetry = () => shellConfig?.getState?.()?.performanceTelemetry;

  const settings = () => settingsView(readTelemetry());

  function applyDemand() {
    if (disposed || !sampler) return;
    try {
      const view = settings();
      sampler.setDemand({
        counter: view.show_counter,
        warnings: view.gpu_warnings_enabled,
        subscribers: now() < leaseUntil ? 1 : 0,
        active,
        identity,
      });
    } catch (_error) { /* sampling is advisory; it never breaks the bridge */ }
  }

  function renewLease() {
    leaseUntil = now() + SUBSCRIBER_LEASE_MS;
    clearTimer(leaseTimer);
    leaseTimer = setTimer(() => { leaseTimer = null; applyDemand(); }, SUBSCRIBER_LEASE_MS);
    leaseTimer?.unref?.();
  }

  function gpu() {
    try { return sampler ? sampler.latest() : null; } catch (_error) { return null; }
  }

  function getSnapshot(raw) {
    const request = validateGetSnapshotRequest(raw);
    if (!request.ok) return fail(request.reason);
    try {
      // No hardware sampling for a reader while both settings are off.
      const current = settings();
      if (current.show_counter || current.gpu_warnings_enabled) renewLease();
      applyDemand();
      const sampled = gpu();
      return succeed({
        settings: settings(),
        inference: request.value.session_id === null ? null
          : intake?.snapshotForSession(request.value.session_id, now()) ?? null,
        gpu: sampled,
      });
    } catch (_error) {
      return fail('collection_unavailable');
    }
  }

  function updateSettings(raw) {
    const request = validateUpdateSettingsRequest(raw);
    if (!request.ok) return fail(request.reason);
    try {
      if (isReadOnlyPerformanceTelemetry(readTelemetry())) return fail('settings_read_only');
      shellConfig.updatePerformanceTelemetry(request.value);
      applyDemand();
      notifier.settingsChanged();
      return succeed({ settings: settings() });
    } catch (_error) {
      return fail('collection_unavailable');
    }
  }

  function dismissWarning(raw) {
    const request = validateDismissWarningRequest(raw);
    if (!request.ok) return fail(request.reason);
    try {
      const result = tracker.dismiss(request.value.warning_id);
      if (result?.ok !== true) return fail('stale_warning');
      notifier.warningChanged();
      return succeed({ gpu: gpu() });
    } catch (_error) {
      return fail('collection_unavailable');
    }
  }

  // The sampler reports every sample; only a changed state or warning is news.
  function noteGpuSample() {
    if (disposed) return;
    const sampled = gpu();
    const signature = JSON.stringify([sampled?.state, sampled?.reason, sampled?.warning]);
    if (signature === lastGpuSignature) return;
    const previous = lastGpuSignature ? JSON.parse(lastGpuSignature) : null;
    lastGpuSignature = signature;
    // Warning transitions bypass the rate limit; plain state changes go through it.
    const warningMoved = JSON.stringify(previous?.[2]) !== JSON.stringify(sampled?.warning);
    if (warningMoved) notifier.warningChanged(); else notifier.gpuChanged();
  }

  function setActiveGeneration(value) {
    const next = value === true;
    if (next === active) return;
    active = next;
    applyDemand();
  }

  function setRuntimeIdentity(next) {
    const valid = next && Number.isSafeInteger(next.pid) && next.pid > 0 && typeof next.createdAt === 'string'
      && next.createdAt ? { pid: next.pid, createdAt: next.createdAt } : null;
    if (JSON.stringify(valid) === JSON.stringify(identity)) return;
    identity = valid;
    applyDemand();
  }

  const unsubscribe = intake?.onChange?.((sessionId, detail) => {
    if (disposed) return;
    if (detail?.terminal === true) notifier.terminalInference(sessionId); else notifier.inferenceChanged(sessionId);
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer(leaseTimer);
    leaseTimer = null;
    try { unsubscribe?.(); } catch (_error) { /* already gone */ }
    notifier.dispose();
    try { sampler?.dispose?.(); } catch (_error) { /* best effort at quit */ }
  }

  applyDemand();
  return {
    getSnapshot, updateSettings, dismissWarning, setActiveGeneration, setRuntimeIdentity,
    noteGpuSample, refreshDemand: applyDemand, notifySettingsChanged: () => notifier.settingsChanged(), dispose,
  };
}

module.exports = { SUBSCRIBER_LEASE_MS, createPerformanceService };
