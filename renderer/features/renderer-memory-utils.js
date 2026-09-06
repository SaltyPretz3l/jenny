(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMemoryUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const sharedUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMemorySharedUtils)
    || (typeof require === 'function' ? require('./renderer-memory-shared-utils') : null)
    || {};
  const memorySettingsUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMemorySettingsUtils)
    || (typeof require === 'function' ? require('./renderer-memory-settings-utils') : null)
    || {};
  const memoryActionUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMemoryActionsUtils)
    || (typeof require === 'function' ? require('./renderer-memory-actions-utils') : null)
    || {};

  const {
    getApprovedMemoryKindOptions,
    getApprovedMemoryKindLabel,
    normalizeApprovedMemoryKindFilter,
    normalizePendingMemorySort,
    normalizeMemoryConfidence,
    normalizeApprovedMemory,
    normalizePendingMemoryCandidate,
    sortMemoriesNewestFirst,
    sortPendingMemoryCandidates,
    buildApprovedMemorySearchText,
    buildPendingMemoryKey,
  } = sharedUtils;

  function noop() {}
  function noopAsync() { return Promise.resolve(); }
  function noopNull() { return null; }
  function noopFalse() { return false; }

  function createMemoryManager(deps) {
    const { state } = deps || {};
    const registerCleanup = typeof deps?.registerCleanup === 'function' ? deps.registerCleanup : noop;
    const { TOAST_SOURCE = {} } = deps?.constants || {};
    const callbacks = deps?.callbacks || {};
    const {
      escapeHtml = function fallbackEscapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
      appendClientLog = noop,
      showToastMessage = noop,
      showShellErrorToast = noop,
      toErrorMessage = function fallbackToErrorMessage(error) {
        return String(error?.message || error || '');
      },
      dismissToast = noop,
      openSettingsSection = noop,
    } = callbacks;

    const MAX_HANDLED_MEMORY_SUGGESTION_STREAMS = 200;
    const MAX_DISMISSED_MEMORY_FINGERPRINTS_PER_SESSION = 32;
    const MAX_DISMISSED_MEMORY_SESSIONS = 200;
    const handledMemorySuggestionStreams = new Set();
    const handledMemorySuggestionStreamOrder = [];
    const dismissedMemoryFingerprintsBySession = new Map();
    let approvedMemoryLoadPromise = null;
    let pendingMemoryLoadPromise = null;
    let memoryStatusLoadPromise = null;
    let approvedMemoryForceQueued = false;
    let pendingMemoryForceQueued = false;
    let memoryStatusForceQueued = false;
    let disposed = false;
    let approvedLoadGeneration = 0;
    let pendingLoadGeneration = 0;
    let memoryStatusLoadGeneration = 0;
    registerCleanup(function disposeMemoryManager() {
      disposed = true;
      approvedLoadGeneration += 1;
      pendingLoadGeneration += 1;
      memoryStatusLoadGeneration += 1;
      approvedMemoryForceQueued = false;
      pendingMemoryForceQueued = false;
      memoryStatusForceQueued = false;
    });

    function getMemoryDom() {
      const source = typeof deps?.getDom === 'function' ? deps.getDom() : deps?.dom;
      return source && typeof source === 'object' && !Array.isArray(source)
        ? source
        : {};
    }

    function getHubDom() {
      const dom = getMemoryDom();
      return dom.hub && typeof dom.hub === 'object' ? dom.hub : {};
    }

    function renderMemorySurfaces() {
      if (disposed) return;
      if (state.ui?.activeView === 'settings' && state.ui?.activeSettingsSection === 'memories') renderApprovedMemoryManager();
    }

    function rememberHandledMemorySuggestionStream(streamId) {
      const normalizedStreamId = String(streamId || '').trim();
      if (!normalizedStreamId || handledMemorySuggestionStreams.has(normalizedStreamId)) {
        return false;
      }
      handledMemorySuggestionStreams.add(normalizedStreamId);
      handledMemorySuggestionStreamOrder.push(normalizedStreamId);
      while (handledMemorySuggestionStreamOrder.length > MAX_HANDLED_MEMORY_SUGGESTION_STREAMS) {
        const oldestStreamId = handledMemorySuggestionStreamOrder.shift();
        if (oldestStreamId) {
          handledMemorySuggestionStreams.delete(oldestStreamId);
        }
      }
      return true;
    }

    function getDismissedMemoryFingerprints(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const sessionFingerprints = dismissedMemoryFingerprintsBySession.get(normalizedSessionId) || null;
      if (sessionFingerprints) rememberDismissedMemorySession(normalizedSessionId, sessionFingerprints);
      return sessionFingerprints;
    }

    function trimDismissedMemoryFingerprints(sessionFingerprints) {
      while (sessionFingerprints.size > MAX_DISMISSED_MEMORY_FINGERPRINTS_PER_SESSION) {
        const oldestFingerprint = sessionFingerprints.values().next().value;
        if (!oldestFingerprint) break;
        sessionFingerprints.delete(oldestFingerprint);
      }
    }

    function rememberDismissedMemorySession(sessionId, sessionFingerprints) {
      dismissedMemoryFingerprintsBySession.delete(sessionId);
      dismissedMemoryFingerprintsBySession.set(sessionId, sessionFingerprints);
      while (dismissedMemoryFingerprintsBySession.size > MAX_DISMISSED_MEMORY_SESSIONS) {
        dismissedMemoryFingerprintsBySession.delete(dismissedMemoryFingerprintsBySession.keys().next().value);
      }
    }

    function rememberDismissedMemoryFingerprint(sessionId, fingerprint) {
      const normalizedSessionId = String(sessionId || '').trim();
      const normalizedFingerprint = String(fingerprint || '').trim().toLowerCase();
      if (!normalizedSessionId || !normalizedFingerprint) {
        return;
      }
      let sessionFingerprints = dismissedMemoryFingerprintsBySession.get(normalizedSessionId);
      if (!sessionFingerprints) {
        sessionFingerprints = new Set();
      }
      sessionFingerprints.delete(normalizedFingerprint);
      sessionFingerprints.add(normalizedFingerprint);
      trimDismissedMemoryFingerprints(sessionFingerprints);
      rememberDismissedMemorySession(normalizedSessionId, sessionFingerprints);
    }

    function clearDismissedMemoryFingerprint(sessionId, fingerprint) {
      const normalizedSessionId = String(sessionId || '').trim();
      const normalizedFingerprint = String(fingerprint || '').trim().toLowerCase();
      if (!normalizedSessionId || !normalizedFingerprint) {
        return;
      }
      const sessionFingerprints = dismissedMemoryFingerprintsBySession.get(normalizedSessionId);
      if (!sessionFingerprints) {
        return;
      }
      sessionFingerprints.delete(normalizedFingerprint);
      if (!sessionFingerprints.size) {
        dismissedMemoryFingerprintsBySession.delete(normalizedSessionId);
      } else {
        rememberDismissedMemorySession(normalizedSessionId, sessionFingerprints);
      }
    }

    function clearDismissedMemorySession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return;
      }
      dismissedMemoryFingerprintsBySession.delete(normalizedSessionId);
    }

    function rekeyDismissedMemorySession(oldSessionId, newSessionId) {
      const sourceSessionId = String(oldSessionId || '').trim();
      const targetSessionId = String(newSessionId || '').trim();
      if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) {
        return targetSessionId || sourceSessionId;
      }
      const sourceFingerprints = dismissedMemoryFingerprintsBySession.get(sourceSessionId);
      if (!sourceFingerprints) {
        return targetSessionId;
      }
      const targetFingerprints = dismissedMemoryFingerprintsBySession.get(targetSessionId) || new Set();
      for (const fingerprint of sourceFingerprints) {
        targetFingerprints.add(fingerprint);
      }
      dismissedMemoryFingerprintsBySession.delete(sourceSessionId);
      trimDismissedMemoryFingerprints(targetFingerprints);
      rememberDismissedMemorySession(targetSessionId, targetFingerprints);
      return targetSessionId;
    }

    function resetMemorySuggestionState() {
      handledMemorySuggestionStreams.clear();
      handledMemorySuggestionStreamOrder.length = 0;
      dismissedMemoryFingerprintsBySession.clear();
    }

    function isMemoryManagerUnavailable() {
      return String(state.backend?.mode || '').trim().toLowerCase() === 'external';
    }

    function getApprovedMemoryById(memoryId) {
      const resolvedMemoryId = Number(memoryId);
      if (!Number.isInteger(resolvedMemoryId) || resolvedMemoryId <= 0) {
        return null;
      }
      return state.memoryManager.memories.find((memory) => memory.id === resolvedMemoryId) || null;
    }

    function getApprovedMemoryDraft(memory) {
      if (!memory || !Number.isInteger(Number(memory.id))) {
        return null;
      }
      return state.memoryManager.draftsById.get(Number(memory.id)) || null;
    }

    function getApprovedMemoryFieldValue(memory, fieldName) {
      const draft = getApprovedMemoryDraft(memory);
      if (draft && Object.prototype.hasOwnProperty.call(draft, fieldName)) {
        return String(draft[fieldName] || '');
      }
      return String(memory?.[fieldName] || '');
    }

    function hasApprovedMemoryDraftChanges(memory) {
      if (!memory) {
        return false;
      }
      return (
        getApprovedMemoryFieldValue(memory, 'title') !== String(memory.title || '')
        || getApprovedMemoryFieldValue(memory, 'lesson_text') !== String(memory.lesson_text || '')
      );
    }

    function upsertApprovedMemoryDraft(memoryId, patch) {
      const resolvedMemoryId = Number(memoryId);
      if (!Number.isInteger(resolvedMemoryId) || resolvedMemoryId <= 0) {
        return;
      }
      const current = state.memoryManager.draftsById.get(resolvedMemoryId) || {};
      state.memoryManager.draftsById.set(resolvedMemoryId, {
        ...current,
        ...(patch || {}),
      });
    }

    function clearApprovedMemoryDraft(memoryId) {
      const resolvedMemoryId = Number(memoryId);
      if (!Number.isInteger(resolvedMemoryId) || resolvedMemoryId <= 0) {
        return;
      }
      state.memoryManager.draftsById.delete(resolvedMemoryId);
    }

    function setApprovedMemoryPendingAction(memoryId, action) {
      const resolvedMemoryId = Number(memoryId);
      if (!Number.isInteger(resolvedMemoryId) || resolvedMemoryId <= 0) {
        return;
      }
      if (action) {
        state.memoryManager.pendingActionById.set(resolvedMemoryId, String(action));
        return;
      }
      state.memoryManager.pendingActionById.delete(resolvedMemoryId);
    }

    function getPendingMemoryCandidate(sessionId, contentFingerprint) {
      const pendingKey = buildPendingMemoryKey(sessionId, contentFingerprint);
      return (Array.isArray(state.memoryManager.pendingCandidates) ? state.memoryManager.pendingCandidates : []).find(
        (candidate) => buildPendingMemoryKey(candidate.session_id, candidate.content_fingerprint) === pendingKey
      ) || null;
    }

    function setPendingMemoryReviewAction(sessionId, contentFingerprint, action) {
      const pendingKey = buildPendingMemoryKey(sessionId, contentFingerprint);
      if (!pendingKey) {
        return;
      }
      if (action) {
        state.memoryManager.pendingReviewActionByKey.set(pendingKey, String(action));
        return;
      }
      state.memoryManager.pendingReviewActionByKey.delete(pendingKey);
    }

    function memoryReadFailureStatus(error, resourceLabel) {
      const detail = toErrorMessage(error, 'Memory read failed.');
      return /malformed response/i.test(detail)
        ? `${resourceLabel} returned a malformed response.`
        : `${resourceLabel} are unavailable right now.`;
    }

    async function refreshMemoryStatus(options) {
      if (disposed) return { status: state.memoryManager.statusSnapshot };
      const force = options?.force === true;
      const memoryApi = window.jennyShell?.memory || null;
      if (!memoryApi || typeof memoryApi.status !== 'function') {
        state.memoryManager.statusLoaded = true;
        state.memoryManager.statusLoading = false;
        state.memoryManager.statusUnavailable = true;
        appendClientLog('WARN', 'memory.status_failed', { reason: 'bridge_unavailable' });
        renderMemorySurfaces();
        return { status: state.memoryManager.statusSnapshot };
      }
      if (state.memoryManager.statusLoading && memoryStatusLoadPromise) {
        if (force) memoryStatusForceQueued = true;
        return memoryStatusLoadPromise;
      }
      if (!force && state.memoryManager.statusLoaded) {
        return { status: state.memoryManager.statusSnapshot };
      }

      state.memoryManager.statusLoading = true;
      state.memoryManager.statusUnavailable = false;
      renderMemorySurfaces();
      const generation = ++memoryStatusLoadGeneration;
      memoryStatusLoadPromise = Promise.resolve()
        .then(() => memoryApi.status())
        .then((result) => {
          if (disposed || generation !== memoryStatusLoadGeneration) {
            return { status: state.memoryManager.statusSnapshot };
          }
          const status = memorySettingsUtils.normalizeMemoryStatus?.(result) || null;
          if (!status) throw new Error('Memory status returned a malformed response.');
          state.memoryManager.statusSnapshot = status;
          state.memoryManager.statusLoaded = true;
          state.memoryManager.statusUnavailable = !status.available;
          appendClientLog(status.available ? 'INFO' : 'WARN', 'memory.status_loaded', {
            available: status.available,
            degradedReasonCount: status.degradedReasons.length,
          });
          return { status };
        })
        .catch((error) => {
          if (disposed || generation !== memoryStatusLoadGeneration) {
            return { status: state.memoryManager.statusSnapshot };
          }
          state.memoryManager.statusLoaded = true;
          state.memoryManager.statusUnavailable = true;
          appendClientLog('WARN', 'memory.status_failed', {
            message: memoryReadFailureStatus(error, 'Memory health details'),
          });
          return { status: state.memoryManager.statusSnapshot };
        })
        .finally(() => {
          if (disposed || generation !== memoryStatusLoadGeneration) return;
          state.memoryManager.statusLoading = false;
          memoryStatusLoadPromise = null;
          renderMemorySurfaces();
          if (memoryStatusForceQueued) {
            memoryStatusForceQueued = false;
            refreshMemoryStatus({ force: true });
          }
        });
      return memoryStatusLoadPromise;
    }

    async function refreshApprovedMemories(options) {
      if (disposed) return { memories: [] };
      const force = options?.force === true;
      const memoryApi = window.jennyShell?.memory || null;
      if (!memoryApi || typeof memoryApi.listApproved !== 'function') {
        state.memoryManager.memories = [];
        state.memoryManager.loaded = true;
        state.memoryManager.loading = false;
        state.memoryManager.unavailable = true;
        state.memoryManager.status = 'Approved memory management is unavailable in this shell build.';
        renderMemorySurfaces();
        return { memories: [] };
      }
      if (isMemoryManagerUnavailable()) {
        state.memoryManager.memories = [];
        state.memoryManager.loaded = true;
        state.memoryManager.loading = false;
        state.memoryManager.unavailable = true;
        state.memoryManager.status = 'Approved memory management is available only in managed sidecar mode.';
        renderMemorySurfaces();
        return { memories: [] };
      }
      if (state.memoryManager.loading && approvedMemoryLoadPromise) {
        if (force) {
          approvedMemoryForceQueued = true;
        }
        return approvedMemoryLoadPromise;
      }
      if (!force && state.memoryManager.loaded) {
        return { memories: [...state.memoryManager.memories] };
      }

      state.memoryManager.loading = true;
      state.memoryManager.unavailable = false;
      state.memoryManager.status = 'Loading approved memories...';
      renderMemorySurfaces();
      const generation = ++approvedLoadGeneration;

      approvedMemoryLoadPromise = memoryApi.listApproved()
        .then((result) => {
          if (disposed || generation !== approvedLoadGeneration) return { memories: [] };
          if (!result || typeof result !== 'object' || !Array.isArray(result.memories)) {
            throw new Error('Approved memory returned a malformed response.');
          }
          const memories = sortMemoriesNewestFirst(
            result.memories
              .map((memory) => normalizeApprovedMemory(memory))
              .filter(Boolean)
          );
          state.memoryManager.memories = memories;
          state.memoryManager.loaded = true;
          state.memoryManager.status = memories.length
            ? `${memories.length} approved memories available.`
            : 'No approved memories saved yet.';
          appendClientLog('INFO', 'memory.listed', { count: memories.length });
          return { memories };
        })
        .catch((error) => {
          if (disposed || generation !== approvedLoadGeneration) return { memories: [] };
          state.memoryManager.memories = [];
          state.memoryManager.loaded = true;
          state.memoryManager.unavailable = true;
          state.memoryManager.status = memoryReadFailureStatus(error, 'Approved memories');
          appendClientLog('WARN', 'memory.list_failed', {
            message: state.memoryManager.status,
          });
          return { memories: [] };
        })
        .finally(() => {
          if (disposed || generation !== approvedLoadGeneration) return;
          state.memoryManager.loading = false;
          approvedMemoryLoadPromise = null;
          renderMemorySurfaces();
          if (approvedMemoryForceQueued) {
            approvedMemoryForceQueued = false;
            refreshApprovedMemories({ force: true });
          }
        });
      return approvedMemoryLoadPromise;
    }

    async function refreshPendingMemories(options) {
      if (disposed) return { candidates: [] };
      const force = options?.force === true;
      const memoryApi = window.jennyShell?.memory || null;
      if (!memoryApi || typeof memoryApi.listPending !== 'function') {
        state.memoryManager.pendingCandidates = [];
        state.memoryManager.pendingLoaded = true;
        state.memoryManager.pendingLoading = false;
        state.memoryManager.pendingUnavailable = true;
        state.memoryManager.pendingStatus = 'Pending memory review is unavailable in this shell build.';
        renderMemorySurfaces();
        return { candidates: [] };
      }
      if (isMemoryManagerUnavailable()) {
        state.memoryManager.pendingCandidates = [];
        state.memoryManager.pendingLoaded = true;
        state.memoryManager.pendingLoading = false;
        state.memoryManager.pendingUnavailable = true;
        state.memoryManager.pendingStatus = 'Pending memory review is available only in managed sidecar mode.';
        renderMemorySurfaces();
        return { candidates: [] };
      }
      if (state.memoryManager.pendingLoading && pendingMemoryLoadPromise) {
        if (force) {
          pendingMemoryForceQueued = true;
        }
        return pendingMemoryLoadPromise;
      }
      if (!force && state.memoryManager.pendingLoaded) {
        return { candidates: [...state.memoryManager.pendingCandidates] };
      }

      state.memoryManager.pendingLoading = true;
      state.memoryManager.pendingUnavailable = false;
      state.memoryManager.pendingStatus = 'Loading pending memory candidates...';
      renderMemorySurfaces();
      const generation = ++pendingLoadGeneration;

      pendingMemoryLoadPromise = memoryApi.listPending()
        .then((result) => {
          if (disposed || generation !== pendingLoadGeneration) return { candidates: [] };
          if (!result || typeof result !== 'object' || !Array.isArray(result.candidates)) {
            throw new Error('Pending memory review returned a malformed response.');
          }
          const candidates = sortMemoriesNewestFirst(
            result.candidates
              .map((candidate) => normalizePendingMemoryCandidate(candidate))
              .filter(Boolean)
          );
          state.memoryManager.pendingCandidates = candidates;
          state.memoryManager.pendingLoaded = true;
          state.memoryManager.pendingStatus = candidates.length
            ? `${candidates.length} pending memory candidates are waiting for review.`
            : 'No pending memory candidates are waiting right now.';
          appendClientLog('INFO', 'memory.pending_listed', { count: candidates.length });
          return { candidates };
        })
        .catch((error) => {
          if (disposed || generation !== pendingLoadGeneration) return { candidates: [] };
          state.memoryManager.pendingCandidates = [];
          state.memoryManager.pendingLoaded = true;
          state.memoryManager.pendingUnavailable = true;
          state.memoryManager.pendingStatus = memoryReadFailureStatus(error, 'Pending memory candidates');
          appendClientLog('WARN', 'memory.pending_list_failed', {
            message: state.memoryManager.pendingStatus,
          });
          return { candidates: [] };
        })
        .finally(() => {
          if (disposed || generation !== pendingLoadGeneration) return;
          state.memoryManager.pendingLoading = false;
          pendingMemoryLoadPromise = null;
          renderMemorySurfaces();
          if (pendingMemoryForceQueued) {
            pendingMemoryForceQueued = false;
            refreshPendingMemories({ force: true });
          }
        });
      return pendingMemoryLoadPromise;
    }

    const memoryPageRenderer = memorySettingsUtils.createMemorySettingsRenderer?.({
      state,
      getDom: getHubDom,
      escapeHtml,
      kindOptions: getApprovedMemoryKindOptions(),
      getKindLabel: getApprovedMemoryKindLabel,
      getFieldValue: getApprovedMemoryFieldValue,
      hasDraftChanges: hasApprovedMemoryDraftChanges,
      searchText: buildApprovedMemorySearchText,
      sortPending: sortPendingMemoryCandidates,
      buildPendingKey: buildPendingMemoryKey,
      canFocus: () => !disposed,
    }) || null;
    let actionController;

    function renderApprovedMemoryManager() {
      memoryPageRenderer?.renderMemoryPage?.();
    }

    actionController = memoryActionUtils.createMemoryActionController?.({
      state,
      registerCleanup,
      constants: {
        TOAST_SOURCE,
      },
      callbacks: {
        escapeHtml,
        appendClientLog,
        showToastMessage,
        showShellErrorToast,
        toErrorMessage,
        dismissToast,
        openSettingsSection,
        normalizeApprovedMemoryKindFilter,
      },
      getHubDom,
      helpers: {
        getApprovedMemoryById,
        getApprovedMemoryFieldValue,
        hasApprovedMemoryDraftChanges,
        clearApprovedMemoryDraft,
        upsertApprovedMemoryDraft,
        setApprovedMemoryPendingAction,
        renderMemorySurfaces,
        refreshApprovedMemories,
        refreshPendingMemories,
        refreshMemoryStatus,
        getPendingMemoryCandidate,
        setPendingMemoryReviewAction,
        clearDismissedMemoryFingerprint,
        rememberDismissedMemoryFingerprint,
        rememberHandledMemorySuggestionStream,
        getDismissedMemoryFingerprints,
        buildPendingMemoryKey,
      },
    }) || null;

    const openMemoryHub = typeof actionController?.openMemoryHub === 'function'
      ? actionController.openMemoryHub
      : function fallbackOpenMemoryHub() {
        openSettingsSection('memories', { source: 'memory' });
      };
    const handleApprovedMemorySave = actionController?.handleApprovedMemorySave || noopAsync;
    const handleApprovedMemoryDelete = actionController?.handleApprovedMemoryDelete || noop;
    const maybeSuggestMemoryCapture = actionController?.maybeSuggestMemoryCapture || noopAsync;
    actionController?.bindMemoryPageEvents?.();

    return {
      refreshApprovedMemories,
      refreshPendingMemories,
      refreshMemoryStatus,
      renderApprovedMemoryManager,
      handleApprovedMemorySave,
      handleApprovedMemoryDelete,
      maybeSuggestMemoryCapture,
      openMemoryHub,
      isMemoryManagerUnavailable,
      clearDismissedMemorySession,
      rekeyDismissedMemorySession,
      resetMemorySuggestionState,
      getApprovedMemoryById,
      hasApprovedMemoryDraftChanges,
      upsertApprovedMemoryDraft,
      clearApprovedMemoryDraft,
    };
  }

  return {
    createMemoryManager,
    getApprovedMemoryKindLabel,
    getApprovedMemoryKindOptions,
  };
});
