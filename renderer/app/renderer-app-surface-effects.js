(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppSurfaceEffects = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SURFACE_EFFECT_STAGES = Object.freeze({
    FACTORY: 'factory',
    BIND: 'bind',
    REFRESH: 'refresh',
    STATUS: 'status',
    DISPOSE: 'dispose',
    ACTIVATE: 'activate',
    FRAME: 'frame',
    INPUT: 'input',
    ACTIVITY: 'activity',
  });

  const FAILURE_POLICY = Object.freeze({
    bindFailuresBeforeDisable: 2,
    frameFailuresBeforeDisable: 5,
    frameFailureWindowMs: 10000,
    inputFailuresBeforeDisable: 3,
    activityFailuresBeforeDisable: 3,
  });

  const ACTIVITY_PHASES = Object.freeze([
    'idle', 'preflight', 'streaming', 'awaiting-user', 'settling', 'failed',
  ]);

  const PHASE_TARGET_ENERGY = Object.freeze({
    idle: 0.08,
    preflight: 0.28,
    streaming: 0.46,
    'awaiting-user': 0.14,
    settling: 0.18,
    failed: 0.04,
  });

  const IMPULSE_PRIORITY = Object.freeze({
    cancel: 5,
    'first-token': 4,
    complete: 3,
    'tool-start': 2,
  });

  const IMPULSE_MERGE_WINDOW_MS = 240;
  const APPROVAL_CARD_SELECTOR = '.approval-gap-row[data-approval-status="pending"]:not([data-approval-resolved="true"])';
  const MODEL_HEARTBEAT = Object.freeze({
    sampleIntervalMs: 100,
    longGapMs: 500,
    streamingFloor: 0.03,
    maxBoost: 0.16,
    lowPassAlpha: 0.2,
    chunkGain: 0.02,
  });

  function createSurfaceEffectManager({
    state,
    windowRef,
    documentRef = null,
    factories = {},
    options = {},
    dom = {},
    callbacks = {},
  }) {
    const {
      appendClientLog = () => {},
      isDisposed = () => false,
      registerCleanup = () => {},
      getEffectRegistry = () => [],
      resolveActivityPhase = null,
    } = callbacks;

    let desiredEffectId = 'none';
    let activeEffectId = 'none';
    let activeController = null;
    let activationGeneration = 0;
    let pendingCandidate = null;
    let pendingRecoveryEffectId = '';
    let managerDisposed = false;
    let bindRafId = 0;
    let refreshRafId = 0;
    let layoutPublisher = null;
    let inputRouter = null;

    const runtimeStateByEffectId = {};
    const failureLogKeys = new Set();
    const diagnosticsCounters = {
      supersededCandidates: 0,
      droppedImpulses: 0,
      suppressedImpulses: 0,
      dedupedFailureLogs: 0,
    };

    const activity = {
      scope: { sessionId: '', streamId: '' },
      scopeEpoch: 0,
      phase: 'idle',
      phaseRevision: 0,
      targetEnergy: PHASE_TARGET_ENERGY.idle,
      attentionScale: 1,
      impulseSequence: 0,
      lastImpulseAt: Number.NEGATIVE_INFINITY,
      lastImpulsePriority: 0,
      heartbeatBoost: 0,
      heartbeatPendingChunks: 0,
      heartbeatLastSampleAt: null,
    };

    function nowMs() {
      if (windowRef.performance && typeof windowRef.performance.now === 'function') {
        return windowRef.performance.now();
      }
      return Date.now();
    }

    function isManagerDisposed() {
      return managerDisposed || isDisposed();
    }

    function getRuntimeState(effectId) {
      if (!runtimeStateByEffectId[effectId]) {
        runtimeStateByEffectId[effectId] = {
          effectDisabled: false,
          inputDisabled: false,
          activityDisabled: false,
          disableReason: '',
          bindFailures: 0,
          frameFailureTimestamps: [],
          inputFailures: 0,
          activityFailures: 0,
        };
      }
      return runtimeStateByEffectId[effectId];
    }

    function getEffectMetadata(effectId) {
      let registry;
      try {
        registry = getEffectRegistry() || [];
      } catch (_registryErr) {
        registry = [];
      }
      const list = Array.isArray(registry) ? registry : Object.values(registry);
      for (const entry of list) {
        if (entry && entry.id === effectId) {
          return entry;
        }
      }
      return null;
    }

    function emitEvent(level, event, payload) {
      appendClientLog(level, event, payload);
    }

    // Failure logs dedupe on (stage, effectId, message): the first occurrence
    // logs, repeats only bump a diagnostics counter — a wedged frame loop must
    // not flood the client log.
    function logFailure(stage, effectId, err) {
      const message = String((err && err.message) || err);
      const dedupeKey = stage + '|' + (effectId || 'none') + '|' + message;
      if (failureLogKeys.has(dedupeKey)) {
        diagnosticsCounters.dedupedFailureLogs += 1;
        return;
      }
      failureLogKeys.add(dedupeKey);
      emitEvent('WARN', 'surface_effect.failed', {
        stage,
        effectId: effectId || 'none',
        message,
      });
    }

    function disposeControllerQuietly(effectId, controller) {
      try {
        controller.dispose();
      } catch (err) {
        logFailure(SURFACE_EFFECT_STAGES.DISPOSE, effectId, err);
      }
    }

    function applyCapabilityDisable(effectId, capability, reason) {
      const runtimeState = getRuntimeState(effectId);
      if (capability === 'effect') {
        runtimeState.effectDisabled = true;
      } else if (capability === 'input') {
        runtimeState.inputDisabled = true;
      } else if (capability === 'activity') {
        runtimeState.activityDisabled = true;
      }
      runtimeState.disableReason = reason;
      emitEvent('WARN', 'surface_effect.disabled', {
        effectId,
        capability,
        reason,
      });
      if (capability === 'effect' && activeEffectId === effectId && activeController) {
        clearSurfaceInputState('effect-disabled');
        const controller = activeController;
        activeController = null;
        activeEffectId = 'none';
        disposeControllerQuietly(effectId, controller);
      }
    }

    function recordFailure(stage, effectId, err) {
      logFailure(stage, effectId, err);
      if (!effectId || effectId === 'none') {
        return;
      }
      const runtimeState = getRuntimeState(effectId);
      if (stage === SURFACE_EFFECT_STAGES.FACTORY || stage === SURFACE_EFFECT_STAGES.BIND) {
        runtimeState.bindFailures += 1;
        if (runtimeState.bindFailures >= FAILURE_POLICY.bindFailuresBeforeDisable) {
          applyCapabilityDisable(effectId, 'effect', stage + ' failures reached policy threshold');
        }
        return;
      }
      if (stage === SURFACE_EFFECT_STAGES.FRAME || stage === SURFACE_EFFECT_STAGES.REFRESH) {
        const now = nowMs();
        const windowStart = now - FAILURE_POLICY.frameFailureWindowMs;
        runtimeState.frameFailureTimestamps = runtimeState.frameFailureTimestamps
          .filter((timestamp) => timestamp >= windowStart);
        runtimeState.frameFailureTimestamps.push(now);
        if (runtimeState.frameFailureTimestamps.length >= FAILURE_POLICY.frameFailuresBeforeDisable) {
          applyCapabilityDisable(effectId, 'effect', stage + ' failures reached policy threshold');
        }
        return;
      }
      if (stage === SURFACE_EFFECT_STAGES.INPUT) {
        runtimeState.inputFailures += 1;
        if (runtimeState.inputFailures >= FAILURE_POLICY.inputFailuresBeforeDisable) {
          applyCapabilityDisable(effectId, 'input', 'input failures reached policy threshold');
        }
        return;
      }
      if (stage === SURFACE_EFFECT_STAGES.ACTIVITY) {
        runtimeState.activityFailures += 1;
        if (runtimeState.activityFailures >= FAILURE_POLICY.activityFailuresBeforeDisable) {
          applyCapabilityDisable(effectId, 'activity', 'activity failures reached policy threshold');
        }
      }
    }

    function reportFault({ effectId, stage, recoverable = true, error } = {}) {
      const faultStage = stage || SURFACE_EFFECT_STAGES.FRAME;
      if (recoverable === false) {
        logFailure(faultStage, effectId, error);
        applyCapabilityDisable(effectId, 'effect', 'unrecoverable ' + faultStage + ' fault');
        return;
      }
      recordFailure(faultStage, effectId, error);
    }

    function readFallbackRect(element) {
      if (element && typeof element.getBoundingClientRect === 'function') {
        try {
          const rect = element.getBoundingClientRect();
          const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
          return Object.freeze({
            left: finite(rect.left), top: finite(rect.top),
            width: Math.max(finite(rect.width), 0), height: Math.max(finite(rect.height), 0),
          });
        } catch (_error) {
          logFailure(SURFACE_EFFECT_STAGES.REFRESH, activeEffectId, 'surface layout fallback read failed');
        }
      }
      return Object.freeze({ left: 0, top: 0, width: 0, height: 0 });
    }

    function buildFallbackLayoutSnapshot() {
      const surface = state && state.ui && state.ui.activeView === 'home' ? 'home' : 'chat';
      const hosts = [];
      if (surface === 'home' && dom.homeView) {
        hosts.push({ element: dom.homeView, role: 'home' });
      } else if (surface === 'chat') {
        // One full-bleed chat host. The former right gutter was `display: none`
        // and still published, so every effect allocated and repainted a second
        // permanently invisible canvas every frame (F1, 2026-08-21).
        if (dom.chatSurfaceEffectLeft) hosts.push({ element: dom.chatSurfaceEffectLeft, role: 'chat-left' });
      }
      const sceneElement = surface === 'home' ? dom.homeView : (dom.chatSurfaceEffects || dom.chatView);
      const frozenHosts = Object.freeze(hosts.map((host) => Object.freeze(host)));
      const emptyRects = Object.freeze([]);
      return Object.freeze({
        surface,
        hosts: frozenHosts,
        layout: Object.freeze({
          revision: 1,
          sceneRect: readFallbackRect(sceneElement),
          hostRects: Object.freeze(hosts.map((host) => readFallbackRect(host.element))),
          interactionBlockRects: emptyRects,
          paintOcclusionRects: emptyRects,
          spawnAvoidanceRects: emptyRects,
        }),
      });
    }

    function currentLayoutSnapshot({ measure = false } = {}) {
      if (layoutPublisher) {
        const snapshot = measure
          ? layoutPublisher.getSnapshot()
          : layoutPublisher.getCurrentSnapshot();
        if (snapshot) return snapshot;
      }
      return buildFallbackLayoutSnapshot();
    }

    function buildContext({ staged, generation, layoutSnapshot = null }) {
      const snapshot = (layoutSnapshot && layoutSnapshot.layout)
        ? layoutSnapshot
        : currentLayoutSnapshot({ measure: true });
      return Object.freeze({
        generation,
        staged: Boolean(staged),
        surface: snapshot.surface,
        hosts: snapshot.hosts,
        layout: snapshot.layout,
      });
    }

    // Per-launch entropy source for §3.7 scene seeds: effects derive their
    // deterministic per-scene seeds FROM this one value, so this is the single
    // sanctioned Math.random in the surface-effect pipeline. Tests and the
    // gallery override it via options.rendererLaunchSeed.
    const managerLaunchSeed = Number.isFinite(options.rendererLaunchSeed)
      ? options.rendererLaunchSeed
      : (Math.random() * 0xffffffff) >>> 0;

    // All shipped effects use the v3 option/context contract. Defaults sit
    // under caller options so tests and the gallery can inject seams.
    function buildFactoryOptions(effectId) {
      return Object.assign({
        effectId,
        documentRef,
        runtime: (windowRef && windowRef.rendererSurfaceEffectRuntime) || null,
        rendererLaunchSeed: managerLaunchSeed,
        report: reportFault,
      }, options);
    }

    function disposePendingCandidate() {
      if (!pendingCandidate) {
        return;
      }
      const candidate = pendingCandidate;
      pendingCandidate = null;
      diagnosticsCounters.supersededCandidates += 1;
      disposeControllerQuietly(candidate.effectId, candidate.controller);
    }

    function isHeartbeatEnabled() {
      return Boolean(state && state.features && state.features.featureFlags
        && state.features.featureFlags.surface_effect_heartbeat === true);
    }

    function resetHeartbeat() {
      const changed = activity.heartbeatBoost !== 0;
      activity.heartbeatBoost = 0;
      activity.heartbeatPendingChunks = 0;
      activity.heartbeatLastSampleAt = null;
      return changed;
    }

    // syncStableChatSurfaceState runs as streamed chunks paint. Aggregate that
    // cadence at 10 Hz rather than forwarding per-token motion; the additive
    // term is strongly low-passed and bounded independently of phase energy.
    function sampleHeartbeatCadence() {
      if (!isHeartbeatEnabled()) {
        return resetHeartbeat();
      }
      const now = nowMs();
      activity.heartbeatPendingChunks += 1;
      if (activity.heartbeatLastSampleAt === null) {
        activity.heartbeatLastSampleAt = now;
        activity.heartbeatPendingChunks = 0;
        const changed = activity.heartbeatBoost !== MODEL_HEARTBEAT.streamingFloor;
        activity.heartbeatBoost = MODEL_HEARTBEAT.streamingFloor;
        return changed;
      }
      const elapsed = now - activity.heartbeatLastSampleAt;
      if (elapsed > MODEL_HEARTBEAT.longGapMs) {
        activity.heartbeatPendingChunks = 0;
        activity.heartbeatLastSampleAt = now;
        const changed = activity.heartbeatBoost !== MODEL_HEARTBEAT.streamingFloor;
        activity.heartbeatBoost = MODEL_HEARTBEAT.streamingFloor;
        return changed;
      }
      if (elapsed < MODEL_HEARTBEAT.sampleIntervalMs) {
        return false;
      }
      const windows = Math.max(1, Math.floor(elapsed / MODEL_HEARTBEAT.sampleIntervalMs));
      const chunksPerWindow = activity.heartbeatPendingChunks / windows;
      const rawBoost = Math.min(
        MODEL_HEARTBEAT.maxBoost,
        MODEL_HEARTBEAT.streamingFloor
          + Math.max(chunksPerWindow - 1, 0) * MODEL_HEARTBEAT.chunkGain,
      );
      const nextBoost = activity.heartbeatBoost
        + (rawBoost - activity.heartbeatBoost) * MODEL_HEARTBEAT.lowPassAlpha;
      activity.heartbeatPendingChunks = 0;
      activity.heartbeatLastSampleAt = now;
      if (Math.abs(nextBoost - activity.heartbeatBoost) < 0.001) {
        return false;
      }
      activity.heartbeatBoost = Math.min(MODEL_HEARTBEAT.maxBoost, Math.max(0, nextBoost));
      return true;
    }

    function buildActivitySnapshot() {
      const heartbeatBoost = activity.phase === 'streaming' && isHeartbeatEnabled()
        ? activity.heartbeatBoost
        : 0;
      return {
        scopeEpoch: activity.scopeEpoch,
        phase: activity.phase,
        phaseRevision: activity.phaseRevision,
        targetEnergy: Math.min(1, activity.targetEnergy + heartbeatBoost),
        attentionScale: activity.attentionScale,
      };
    }

    function publishSnapshotToActiveController() {
      if (!activeController || typeof activeController.setActivity !== 'function') {
        return;
      }
      if (getRuntimeState(activeEffectId).activityDisabled) {
        return;
      }
      try {
        activeController.setActivity(buildActivitySnapshot());
      } catch (err) {
        recordFailure(SURFACE_EFFECT_STAGES.ACTIVITY, activeEffectId, err);
      }
    }

    function normalizeActivityPhase(value) {
      const token = String(value || '').trim().toLowerCase();
      return ACTIVITY_PHASES.indexOf(token) === -1 ? 'idle' : token;
    }

    function applyActivityPhase(phase) {
      const normalized = normalizeActivityPhase(phase);
      if (normalized === activity.phase) {
        return false;
      }
      activity.phase = normalized;
      activity.phaseRevision += 1;
      activity.targetEnergy = PHASE_TARGET_ENERGY[normalized];
      return true;
    }

    function publishActivityPhase(phase) {
      if (isManagerDisposed()) {
        return;
      }
      const previousPhase = activity.phase;
      const normalized = normalizeActivityPhase(phase);
      const phaseChanged = applyActivityPhase(normalized);
      const heartbeatChanged = normalized === 'streaming'
        ? sampleHeartbeatCadence()
        : resetHeartbeat();
      if (phaseChanged || heartbeatChanged) {
        publishSnapshotToActiveController();
      }
      if (phaseChanged && (normalized === 'awaiting-user' || previousPhase === 'awaiting-user')) {
        refreshActiveSurfaceEffect();
      }
    }

    function setVisibleActivityScope({ sessionId, streamId } = {}) {
      if (isManagerDisposed()) {
        return;
      }
      const nextSessionId = String(sessionId || '').trim();
      const nextStreamId = String(streamId || '').trim();
      if (nextSessionId === activity.scope.sessionId && nextStreamId === activity.scope.streamId) {
        return;
      }
      activity.scope = { sessionId: nextSessionId, streamId: nextStreamId };
      activity.scopeEpoch += 1;
      resetHeartbeat();
      // Session switches must not carry charges/tension/paint drags across.
      clearSurfaceInputState('session-switch');
      // Impulses are scope-bound: a scope change resets the arbiter window so
      // the new scene never inherits the old scene's attention budget.
      activity.lastImpulseAt = Number.NEGATIVE_INFINITY;
      activity.lastImpulsePriority = 0;
      if (typeof resolveActivityPhase === 'function') {
        try {
          applyActivityPhase(resolveActivityPhase(nextSessionId));
        } catch (err) {
          recordFailure(SURFACE_EFFECT_STAGES.ACTIVITY, activeEffectId, err);
        }
      }
      // Epoch moved, so the snapshot republishes even when the phase held.
      publishSnapshotToActiveController();
    }

    function publishStreamImpulse({ sessionId, streamId, kind, timeStamp } = {}) {
      if (isManagerDisposed()) {
        return false;
      }
      const priority = IMPULSE_PRIORITY[kind];
      if (!priority) {
        diagnosticsCounters.droppedImpulses += 1;
        return false;
      }
      const impulseSessionId = String(sessionId || '').trim();
      const impulseStreamId = String(streamId || '').trim();
      if (impulseSessionId !== activity.scope.sessionId) {
        diagnosticsCounters.droppedImpulses += 1;
        return false;
      }
      if (activity.scope.streamId && impulseStreamId && impulseStreamId !== activity.scope.streamId) {
        diagnosticsCounters.droppedImpulses += 1;
        return false;
      }
      const now = nowMs();
      const withinMergeWindow = now - activity.lastImpulseAt < IMPULSE_MERGE_WINDOW_MS;
      if (withinMergeWindow && priority <= activity.lastImpulsePriority) {
        diagnosticsCounters.suppressedImpulses += 1;
        return false;
      }
      activity.lastImpulseAt = now;
      activity.lastImpulsePriority = priority;
      activity.impulseSequence += 1;
      if (!activeController || typeof activeController.handleActivityImpulse !== 'function') {
        return true;
      }
      if (getRuntimeState(activeEffectId).activityDisabled) {
        return true;
      }
      try {
        activeController.handleActivityImpulse({
          scopeEpoch: activity.scopeEpoch,
          sequence: activity.impulseSequence,
          kind,
          timeStamp: Number.isFinite(timeStamp) ? timeStamp : now,
        });
      } catch (err) {
        recordFailure(SURFACE_EFFECT_STAGES.ACTIVITY, activeEffectId, err);
      }
      return true;
    }

    function normalizeStatusState(value) {
      const token = String(value || '').trim().toLowerCase();
      if (token === 'ready' || token === 'dormant' || token === 'unsupported' || token === 'failed') {
        return token;
      }
      return 'ready';
    }

    function commitCandidate(candidate, statusState) {
      // Clear while the incumbent is still the input target: stuck charges or
      // paint drags must resolve against the controller that owns them.
      clearSurfaceInputState('effect-switch');
      const previousEffectId = activeEffectId;
      const previousController = activeController;
      activeEffectId = candidate.effectId;
      activeController = candidate.controller;
      try {
        if (typeof candidate.controller.refresh === 'function') {
          candidate.controller.refresh(buildContext({ staged: false, generation: candidate.generation }));
        }
      } catch (err) {
        recordFailure(SURFACE_EFFECT_STAGES.REFRESH, candidate.effectId, err);
      }
      // Replay is snapshot-only by contract — impulses are never stored, so
      // there is nothing impulse-shaped to replay here.
      publishSnapshotToActiveController();
      if (previousController) {
        disposeControllerQuietly(previousEffectId, previousController);
      }
      emitEvent('INFO', 'surface_effect.activated', {
        effectId: candidate.effectId,
        generation: candidate.generation,
        state: statusState,
        hostCount: candidate.hostCount,
      });
      if (statusState === 'ready') {
        emitEvent('INFO', 'surface_effect.ready', {
          effectId: candidate.effectId,
          generation: candidate.generation,
        });
      }
      if (pendingRecoveryEffectId === candidate.effectId) {
        pendingRecoveryEffectId = '';
        emitEvent('INFO', 'surface_effect.recovered', {
          effectId: candidate.effectId,
          generation: candidate.generation,
        });
      }
    }

    function bindPendingCandidate() {
      bindRafId = 0;
      if (isManagerDisposed()) {
        disposePendingCandidate();
        return;
      }
      const candidate = pendingCandidate;
      pendingCandidate = null;
      if (!candidate) {
        return;
      }
      if (candidate.generation !== activationGeneration) {
        diagnosticsCounters.supersededCandidates += 1;
        disposeControllerQuietly(candidate.effectId, candidate.controller);
        return;
      }
      const stagedContext = buildContext({ staged: true, generation: candidate.generation });
      candidate.hostCount = stagedContext.hosts.length;
      try {
        candidate.controller.bind(stagedContext);
      } catch (err) {
        recordFailure(SURFACE_EFFECT_STAGES.BIND, candidate.effectId, err);
        disposeControllerQuietly(candidate.effectId, candidate.controller);
        return;
      }
      let statusState = 'ready';
      if (typeof candidate.controller.getStatus === 'function') {
        try {
          const status = candidate.controller.getStatus();
          statusState = normalizeStatusState(status && status.state);
        } catch (err) {
          recordFailure(SURFACE_EFFECT_STAGES.STATUS, candidate.effectId, err);
          statusState = 'failed';
        }
      }
      if (statusState === 'unsupported' || statusState === 'failed') {
        // An unsupported candidate is a legitimate rejection, not a fault —
        // only an explicit failed status counts toward the disable policy.
        if (statusState === 'failed') {
          recordFailure(SURFACE_EFFECT_STAGES.BIND, candidate.effectId,
            new Error('candidate reported status ' + statusState));
        } else {
          logFailure(SURFACE_EFFECT_STAGES.STATUS, candidate.effectId,
            'candidate reported status ' + statusState);
        }
        disposeControllerQuietly(candidate.effectId, candidate.controller);
        return;
      }
      commitCandidate(candidate, statusState);
    }

    function activateSurfaceEffect(rawEffectId) {
      const effectId = typeof rawEffectId === 'string' && rawEffectId.trim() ? rawEffectId.trim() : 'none';
      desiredEffectId = effectId;
      const generation = ++activationGeneration;
      disposePendingCandidate();
      if (bindRafId) {
        windowRef.cancelAnimationFrame(bindRafId);
        bindRafId = 0;
      }
      if (isManagerDisposed()) {
        return;
      }
      if (effectId === 'none') {
        clearSurfaceInputState('effect-switch');
        const previousEffectId = activeEffectId;
        const previousController = activeController;
        activeEffectId = 'none';
        activeController = null;
        if (previousController) {
          disposeControllerQuietly(previousEffectId, previousController);
        }
        return;
      }
      if (effectId === activeEffectId && activeController) {
        // Re-selecting the active effect (theme bundle apply, appearance
        // reset) is a refresh, not a rebuild — matches the pre-v3 manager and
        // avoids reshuffling the visual field.
        refreshActiveSurfaceEffect();
        return;
      }
      if (getRuntimeState(effectId).effectDisabled) {
        logFailure(SURFACE_EFFECT_STAGES.ACTIVATE, effectId,
          'activation refused: effect is runtime-disabled (' + getRuntimeState(effectId).disableReason + ')');
        return;
      }
      const factoryFn = factories[effectId];
      if (typeof factoryFn !== 'function') {
        logFailure(SURFACE_EFFECT_STAGES.FACTORY, effectId, 'unknown surface effect id');
        return;
      }
      let controller;
      try {
        controller = factoryFn(buildFactoryOptions(effectId)) || null;
      } catch (err) {
        recordFailure(SURFACE_EFFECT_STAGES.FACTORY, effectId, err);
        return;
      }
      if (!controller) {
        recordFailure(SURFACE_EFFECT_STAGES.FACTORY, effectId, new Error('factory returned no controller'));
        return;
      }
      pendingCandidate = {
        effectId,
        controller,
        generation,
        hostCount: 0,
      };
      bindRafId = windowRef.requestAnimationFrame(bindPendingCandidate);
    }

    function refreshActiveSurfaceEffect(layoutSnapshot) {
      if (refreshRafId) {
        windowRef.cancelAnimationFrame(refreshRafId);
        refreshRafId = 0;
      }
      if (isManagerDisposed() || !activeController) {
        return;
      }
      // A snapshot handed in by the layout publisher was measured this frame;
      // reusing it keeps one layout change at one measure() instead of two.
      // A newer publish cancels this rAF and re-arms with its own snapshot.
      const publishedSnapshot = (layoutSnapshot && layoutSnapshot.layout) ? layoutSnapshot : null;
      refreshRafId = windowRef.requestAnimationFrame(() => {
        refreshRafId = 0;
        if (isManagerDisposed() || !activeController) {
          return;
        }
        const effectId = activeEffectId;
        const controller = activeController;
        try {
          if (typeof controller.refresh === 'function') {
            controller.refresh(buildContext({
              staged: false, generation: activationGeneration, layoutSnapshot: publishedSnapshot,
            }));
          }
        } catch (err) {
          // Refresh failures are isolated: the effect stays live until the
          // frame-class failure window reaches the disable threshold.
          recordFailure(SURFACE_EFFECT_STAGES.REFRESH, effectId, err);
        }
      });
    }

    function getStatus() {
      const runtimeStateSnapshot = {};
      for (const [effectId, runtimeState] of Object.entries(runtimeStateByEffectId)) {
        runtimeStateSnapshot[effectId] = {
          effectDisabled: runtimeState.effectDisabled,
          inputDisabled: runtimeState.inputDisabled,
          activityDisabled: runtimeState.activityDisabled,
          disableReason: runtimeState.disableReason,
          bindFailures: runtimeState.bindFailures,
          frameFailures: runtimeState.frameFailureTimestamps.length,
          inputFailures: runtimeState.inputFailures,
          activityFailures: runtimeState.activityFailures,
        };
      }
      return {
        desiredEffectId,
        activeEffectId,
        activationGeneration,
        hasPendingCandidate: Boolean(pendingCandidate),
        activity: buildActivitySnapshot(),
        heartbeat: {
          enabled: isHeartbeatEnabled(),
          boost: activity.heartbeatBoost,
          pendingChunks: activity.heartbeatPendingChunks,
          lastSampleAt: activity.heartbeatLastSampleAt,
        },
        runtimeStateByEffectId: runtimeStateSnapshot,
        counters: Object.assign({}, diagnosticsCounters),
      };
    }

    // The router queries this per event/flush: capture-time generations let it
    // drop input that raced an activation, without the manager pushing state.
    function getInputTarget() {
      if (isManagerDisposed() || !activeController || activeEffectId === 'none') {
        return null;
      }
      const metadata = getEffectMetadata(activeEffectId);
      const layoutSnapshot = currentLayoutSnapshot();
      return {
        controller: activeController,
        effectId: activeEffectId,
        captureOnPress: Boolean(metadata && metadata.interaction && metadata.interaction.captureOnPress),
        generation: activationGeneration,
        inputDisabled: getRuntimeState(activeEffectId).inputDisabled,
        hosts: layoutSnapshot.hosts,
        layout: layoutSnapshot.layout,
      };
    }

    function clearSurfaceInputState(reason) {
      if (inputRouter) {
        inputRouter.clearPointerState(reason);
      }
    }

    function dispose() {
      if (managerDisposed) {
        return;
      }
      if (inputRouter) {
        // Cancel/clear reaches the outgoing controller before it is disposed.
        inputRouter.dispose();
      }
      if (layoutPublisher) {
        layoutPublisher.dispose();
        layoutPublisher = null;
      }
      managerDisposed = true;
      for (const rafId of [bindRafId, refreshRafId]) {
        if (rafId) {
          windowRef.cancelAnimationFrame(rafId);
        }
      }
      bindRafId = 0;
      refreshRafId = 0;
      disposePendingCandidate();
      if (activeController) {
        const controller = activeController;
        const effectId = activeEffectId;
        activeController = null;
        activeEffectId = 'none';
        disposeControllerQuietly(effectId, controller);
      }
    }

    registerCleanup(dispose);
    const inputModule = windowRef.rendererAppSurfaceInput || null;
    const layoutModule = windowRef.rendererAppSurfaceLayout || null;
    if (layoutModule && typeof layoutModule.createSurfaceLayoutPublisher === 'function') {
      layoutPublisher = layoutModule.createSurfaceLayoutPublisher({
        state,
        windowRef,
        documentRef,
        dom,
        interactionSelector: (inputModule && inputModule.SURFACE_INPUT_BLOCKER_SELECTOR)
          || layoutModule.DEFAULT_INTERACTION_SELECTOR,
        priorityRegionSelector: APPROVAL_CARD_SELECTOR,
        onWarning: (message) => logFailure(SURFACE_EFFECT_STAGES.REFRESH, activeEffectId, message),
        onLayoutChange: (snapshot) => {
          if (isManagerDisposed()) return;
          clearSurfaceInputState('layout-change');
          refreshActiveSurfaceEffect(snapshot);
        },
      });
    }
    if (inputModule && typeof inputModule.createSurfaceInputRouter === 'function') {
      inputRouter = inputModule.createSurfaceInputRouter({
        windowRef,
        documentRef,
        dom,
        registerCleanup,
        getInputTarget,
        onInputFailure: (effectId, err) => recordFailure(SURFACE_EFFECT_STAGES.INPUT, effectId, err),
      });
    }

    return {
      SURFACE_EFFECT_STAGES,
      FAILURE_POLICY,
      activateSurfaceEffect,
      refreshActiveSurfaceEffect,
      logSurfaceEffectFailure: logFailure,
      reportFault,
      clearSurfaceInputState,
      setVisibleActivityScope,
      publishActivityPhase,
      publishStreamImpulse,
      getStatus,
      dispose,
    };
  }

  return {
    SURFACE_EFFECT_STAGES,
    FAILURE_POLICY,
    ACTIVITY_PHASES,
    PHASE_TARGET_ENERGY,
    IMPULSE_PRIORITY,
    IMPULSE_MERGE_WINDOW_MS,
    APPROVAL_CARD_SELECTOR,
    MODEL_HEARTBEAT,
    createSurfaceEffectManager,
  };
});
