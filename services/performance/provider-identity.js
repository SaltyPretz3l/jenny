'use strict';
const { isReadOnlyPerformanceTelemetry } = require('../shell-config-performance');

/* services/performance/provider-identity.js - Electron decides which provider
 * serves a request; the sidecar only carries the label (row 59 checkpoint 6).
 *
 * `live_capable` is true only for the managed NInfer whose runtime label names
 * v0.9.1: the one build whose `timings_per_token` / `return_progress` options are
 * pinned. A user-run server, another managed server or an unknown version never
 * receives those options. Also builds the additive `chat.send`
 * `inference_performance` field (omitted when the protocol is not negotiated).
 */

const { resolveManagedServerOwner } = require('../backend/managed-server-owner');
const { supportsInferencePerformanceProtocol } = require('../session-runtime/inference-protocol');

const NINFER_LIVE_VERSION = /^v?0\.9\.1$/u;

function runtimeIsLiveCapable(status) {
  return status?.state === 'ready' && NINFER_LIVE_VERSION.test(String(status.runtimeLabel || '').trim());
}

// -> { provider_kind: 'ninfer'|'llama-server'|'ollama'|'other', live_capable: boolean }
function resolveProviderIdentity({ service, apiUrl, ninferManager, engineType } = {}) {
  try {
    if (String(engineType || '').trim().toLowerCase() === 'ollama') return { provider_kind: 'ollama', live_capable: false };
    const owner = apiUrl ? resolveManagedServerOwner(service, apiUrl) : null;
    if (owner?.kind === 'ninfer') {
      const manager = ninferManager || owner.manager;
      return { provider_kind: 'ninfer', live_capable: runtimeIsLiveCapable(manager?.getStatus?.() || owner.status) };
    }
    if (owner?.kind === 'llama-server') return { provider_kind: 'llama-server', live_capable: false };
  } catch (_error) { /* an unreadable manager is an unknown provider */ }
  return { provider_kind: 'other', live_capable: false };
}

// The additive `chat.send` field and the intake mark for one request. `live` is
// decided here, once, at request creation: the counter setting plus a live-capable
// provider. Returns {} when the sidecar did not negotiate the protocol.
function inferencePerformanceRequestField(service, { engineType, apiUrl, sessionId, requestId } = {}) {
  try {
    if (!supportsInferencePerformanceProtocol(service?.sidecarClient)) return {};
    const endpoint = apiUrl || (String(engineType || '').trim().toLowerCase() === 'openai-compatible'
      // Lazy: the config module is large and already loaded by the time a chat is sent.
      ? require('../backend/managed-sidecar-config').resolveOpenAICompatibleApiUrl(service) : '');
    const identity = resolveProviderIdentity({
      service, apiUrl: endpoint, engineType, ninferManager: service?.options?.getNinferManager?.() || null,
    });
    // A block written by a newer build is not interpreted (the same rule the settings view uses).
    const telemetry = service?.configService?.getState?.()?.performanceTelemetry;
    const showCounter = !isReadOnlyPerformanceTelemetry(telemetry) && telemetry?.showCounter === true;
    const live = showCounter && identity.live_capable;
    service?.inferenceIntake?.markRequest?.(sessionId, {
      live_requested: live, live_capable: identity.live_capable, request_id: requestId,
    });
    return { inference_performance: { live, provider_kind: identity.provider_kind } };
  } catch (_error) {
    return {};
  }
}

module.exports = { NINFER_LIVE_VERSION, inferencePerformanceRequestField, resolveProviderIdentity };
