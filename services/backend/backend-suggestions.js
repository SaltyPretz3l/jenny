const { API_VERSION } = require('./sidecar-client');
const { SIDECAR_ERROR_CODES } = require('./error-codes');

const SUGGESTION_CACHE_TTL_MS = 30 * 60 * 1_000;
const SUGGESTION_FAILURE_COOLDOWN_MS = 5 * 60 * 1_000;

function isTimeoutError(error) {
  return String(error?.error_code || '').trim() === SIDECAR_ERROR_CODES.TIMEOUT
    || String(error?.category || '').trim().toLowerCase() === 'timeout';
}

function _timeBucket() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  if (hour >= 21) return 'night';
  return 'late_night';
}

function suggestionSkipDetails(service) {
  const phase = typeof service.sidecarManager?.getStatus === 'function'
    ? String(service.sidecarManager.getStatus()?.phase || '').trim().toLowerCase()
    : 'ready';
  if (phase !== 'ready') {
    return { reason: 'sidecar_not_ready', phase };
  }
  if (service.activeStreams && typeof service.activeStreams.size === 'number' && service.activeStreams.size > 0) {
    return { reason: 'chat_stream_active', active_streams: service.activeStreams.size };
  }
  return null;
}

async function generateSuggestions(service, companionState) {
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'suggestions.generate_skipped', {
      reason: 'sidecar_unavailable',
    });
    return { suggestions: [] };
  }
  const initialSkip = suggestionSkipDetails(service);
  if (initialSkip) {
    service._emitServiceLog('INFO', 'suggestions.generate_skipped', initialSkip);
    return { suggestions: [] };
  }
  const modelLoaded = service.currentStatus?.model_loaded === true
    || Boolean(String(service.currentModel || '').trim());
  if (!modelLoaded) {
    service._emitServiceLog('INFO', 'suggestions.generate_skipped', {
      reason: 'model_not_loaded',
    });
    return { suggestions: [] };
  }

  const mode = String(companionState?.mode || '').trim();
  const modeMeta = companionState?.modeMeta || {};
  const briefingItems = Array.isArray(companionState?.briefing?.items) ? companionState.briefing.items : [];
  const briefingSummary = briefingItems
    .filter((item) => item?.value && item.id !== 'mode')
    .slice(0, 3)
    .map((item) => `${item.label}: ${item.value}`)
    .join('. ');

  const sessionTitles = Array.isArray(companionState?.todayCards)
    ? companionState.todayCards
        .flatMap((card) => Array.isArray(card?.items) ? card.items : [])
        .filter((item) => item?.title)
        .slice(0, 3)
        .map((item) => String(item.title).trim())
    : [];

  let memoryTitles = [];
  try {
    const memoryResult = await service.listApprovedMemories();
    memoryTitles = (memoryResult?.memories || [])
      .slice(0, 3)
      .map((m) => String(m?.title || '').trim())
      .filter(Boolean);
  } catch (_error) {
    /* best effort */
  }

  const postMemorySkip = suggestionSkipDetails(service);
  if (postMemorySkip) {
    service._emitServiceLog('INFO', 'suggestions.generate_skipped', postMemorySkip);
    return { suggestions: [] };
  }

  const context = {
    time_of_day: _timeBucket(),
    companion_mode: String(modeMeta.label || mode),
    framing_hint: String(modeMeta.description || ''),
    briefing_summary: briefingSummary,
    recent_memory_titles: memoryTitles,
    recent_session_titles: sessionTitles,
    personality_name: String(companionState?.modeMeta?.label || 'Jenny'),
  };

  try {
    const payload = await service.sidecarClient.request('suggestions.generate', {
      accept_version: API_VERSION,
      ...context,
    });

    const suggestions = Array.isArray(payload?.suggestions)
      ? payload.suggestions.filter((s) => typeof s === 'string' && s.trim().length > 0)
      : [];

    return { suggestions };
  } catch (error) {
    service._emitServiceLog(isTimeoutError(error) ? 'INFO' : 'WARN', 'suggestions.generate_failed', {
      message: error?.message || String(error),
      timeout: isTimeoutError(error),
    });
    return { suggestions: [] };
  }
}

function createSuggestionCache() {
  return {
    key: '', suggestions: [], generatedAt: 0, failedAt: 0,
    _inflight: null, _inflightKey: '', _inflightByKey: new Map(), _latestRequestedKey: '',
  };
}

function clearSuggestionCache(cache) {
  cache.key = '';
  cache.suggestions = [];
  cache.generatedAt = 0;
  cache.failedAt = 0;
  cache._inflight = null;
  cache._inflightKey = '';
  cache._inflightByKey.clear();
  cache._latestRequestedKey = '';
}

async function getCachedOrGenerateSuggestions(service, companionState, cache) {
  const mode = String(companionState?.mode || '').trim();
  const dateKey = String(companionState?.briefing?.dateKey || '').trim();
  const cacheKey = `${mode}:${dateKey}`;
  cache._latestRequestedKey = cacheKey;

  const now = Date.now();
  if (cache.key === cacheKey && cache.suggestions.length > 0 && (now - cache.generatedAt) < SUGGESTION_CACHE_TTL_MS) {
    return { suggestions: cache.suggestions };
  }

  if (cache.failedAt > 0 && (now - cache.failedAt) < SUGGESTION_FAILURE_COOLDOWN_MS) {
    return { suggestions: [] };
  }

  const inflightByKey = cache._inflightByKey;
  if (inflightByKey.has(cacheKey)) {
    cache._inflight = inflightByKey.get(cacheKey);
    cache._inflightKey = cacheKey;
    return cache._inflight;
  }

  const promise = generateSuggestions(service, companionState).then((result) => {
    if (cache._latestRequestedKey !== cacheKey) {
      return result;
    }
    if (result.suggestions.length > 0) {
      cache.key = cacheKey;
      cache.suggestions = result.suggestions;
      cache.generatedAt = Date.now();
      cache.failedAt = 0;
    } else {
      cache.failedAt = Date.now();
    }
    return result;
  }).catch(() => {
    if (cache._latestRequestedKey === cacheKey) {
      cache.failedAt = Date.now();
    }
    return { suggestions: [] };
  }).finally(() => {
    if (inflightByKey.get(cacheKey) === promise) {
      inflightByKey.delete(cacheKey);
    }
    if (cache._inflight === promise) {
      cache._inflight = null;
      cache._inflightKey = '';
    }
  });

  inflightByKey.set(cacheKey, promise);
  cache._inflight = promise;
  cache._inflightKey = cacheKey;
  return promise;
}

module.exports = {
  generateSuggestions,
  createSuggestionCache,
  clearSuggestionCache,
  getCachedOrGenerateSuggestions,
};
