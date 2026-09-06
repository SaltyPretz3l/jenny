/* renderer/shell/renderer-runtime-health-utils.js - Phase 7 Runtime Health severity ladder. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRuntimeHealthUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PARSE_FAILURE_MIN_SAMPLES = 5;
  const RECENT_OBSERVATION_WINDOW = 10;

  const PENDING_STATE = Object.freeze({
    tone: 'pending',
    label: 'Pending',
    summary: 'Pending: waiting for first turn',
  });

  const HEALTHY_STATE = Object.freeze({
    tone: 'success',
    label: 'Healthy',
    summary: 'Healthy',
  });

  function readRuntime(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return null;
    }
    const runtime = snapshot.runtime;
    return runtime && typeof runtime === 'object' && !Array.isArray(runtime) ? runtime : null;
  }

  function readProfiles(runtime) {
    const profiles = runtime?.provider_capability_profiles;
    return Array.isArray(profiles) ? profiles.filter((entry) => entry && typeof entry === 'object') : [];
  }

  function readObservations(runtime) {
    const observations = runtime?.recent_tool_observations;
    return Array.isArray(observations) ? observations.filter((entry) => entry && typeof entry === 'object') : [];
  }

  function readModelLabel(profile) {
    const value = profile && typeof profile.model_id === 'string' ? profile.model_id.trim() : '';
    return value || 'unknown model';
  }

  function findProfile(profiles, predicate) {
    for (const profile of profiles) {
      try {
        if (predicate(profile)) {
          return profile;
        }
      } catch (_error) {
        // empty
      }
    }
    return null;
  }

  function aggregateParseCounts(profiles) {
    let success = 0;
    let failure = 0;
    for (const profile of profiles) {
      const counters = profile?.reliability_counters;
      if (!counters || typeof counters !== 'object') {
        continue;
      }
      const successValue = Number(counters.tool_call_parse_success_count);
      const failureValue = Number(counters.tool_call_parse_failure_count);
      if (Number.isFinite(successValue) && successValue > 0) {
        success += successValue;
      }
      if (Number.isFinite(failureValue) && failureValue > 0) {
        failure += failureValue;
      }
    }
    return { success, failure };
  }

  function recentTurnFailure(observations) {
    const slice = observations.slice(-RECENT_OBSERVATION_WINDOW);
    for (let index = slice.length - 1; index >= 0; index -= 1) {
      const event = slice[index];
      if (event && event.kind === 'turn_failed') {
        return event;
      }
    }
    return null;
  }

  function deriveRuntimeHealthState(snapshot) {
    let runtime;
    try {
      runtime = readRuntime(snapshot);
    } catch (_error) {
      return PENDING_STATE;
    }
    if (!runtime) {
      return PENDING_STATE;
    }

    const profiles = readProfiles(runtime);
    const observations = readObservations(runtime);

    const failClosedProfile = findProfile(profiles, (profile) => profile.selected_route === 'fail_closed');
    if (failClosedProfile) {
      return {
        tone: 'danger',
        label: 'Blocked',
        summary: `Blocked: route is fail-closed for ${readModelLabel(failClosedProfile)}`,
      };
    }

    const probeFailedProfile = findProfile(profiles, (profile) => profile.probe_status === 'failed');
    if (probeFailedProfile) {
      return {
        tone: 'danger',
        label: 'Blocked',
        summary: `Blocked: capability probe failed for ${readModelLabel(probeFailedProfile)}`,
      };
    }

    const llamaServer = runtime.llama_server;
    if (llamaServer && typeof llamaServer === 'object' && !Array.isArray(llamaServer)) {
      const alias = typeof llamaServer.alias === 'string' ? llamaServer.alias.trim() : '';
      const lastError = typeof llamaServer.last_error === 'string' ? llamaServer.last_error.trim() : '';
      if (llamaServer.state === 'crashed') {
        return {
          tone: 'danger',
          label: 'Blocked',
          summary: `Blocked: local llama-server stopped unexpectedly; it restarts on your next message${alias ? ` (${alias})` : ''}`,
        };
      }
      // A failed (re)launch parks the manager in 'stopped' with the error.
      if (llamaServer.state === 'stopped' && lastError) {
        return {
          tone: 'danger',
          label: 'Blocked',
          summary: `Blocked: local llama-server failed to start${alias ? ` (${alias})` : ''}: ${lastError}`,
        };
      }
    }

    const roundtripFailedProfile = findProfile(profiles, (profile) => {
      const roundtrip = profile.roundtrip;
      return roundtrip && typeof roundtrip === 'object' && roundtrip.passed === false;
    });
    if (roundtripFailedProfile) {
      return {
        tone: 'warning',
        label: 'Degraded',
        summary: `Degraded: schema roundtrip failed for ${readModelLabel(roundtripFailedProfile)}`,
      };
    }

    const expiredProfile = findProfile(profiles, (profile) => profile.probe_status === 'expired');
    if (expiredProfile) {
      return {
        tone: 'warning',
        label: 'Degraded',
        summary: `Degraded: profile expired for ${readModelLabel(expiredProfile)}; re-probe pending`,
      };
    }

    const toolDisabledProfile = findProfile(profiles, (profile) => profile.selected_route === 'tool_disabled');
    if (toolDisabledProfile) {
      return {
        tone: 'warning',
        label: 'Degraded',
        summary: `Degraded: tools disabled for ${readModelLabel(toolDisabledProfile)}`,
      };
    }

    const parseCounts = aggregateParseCounts(profiles);
    const parseTotal = parseCounts.success + parseCounts.failure;
    if (parseTotal >= PARSE_FAILURE_MIN_SAMPLES && parseCounts.failure > parseCounts.success) {
      return {
        tone: 'warning',
        label: 'Degraded',
        summary: 'Degraded: tool-call parse failure rate is high',
      };
    }

    const failedTurn = recentTurnFailure(observations);
    if (failedTurn) {
      const code = String(failedTurn.error_code || '').trim();
      const detail = code ? code : 'no error code';
      return {
        tone: 'warning',
        label: 'Degraded',
        summary: `Degraded: recent turn failed (${detail})`,
      };
    }

    const readyProfile = findProfile(profiles, (profile) => profile.probe_status === 'ready');
    if (readyProfile) {
      return HEALTHY_STATE;
    }

    return PENDING_STATE;
  }

  return {
    deriveRuntimeHealthState,
  };
});
