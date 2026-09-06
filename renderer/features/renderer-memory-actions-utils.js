(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMemoryActionsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const windowRef = globalRef.window || globalRef;
  const MEMORY_RENDER_BATCH_SIZE = 200;
  const sharedMemoryUtils = globalRef.rendererMemorySharedUtils || {};
  const memoryActionsV2Utils = globalRef.rendererMemoryActionsV2Utils
    || (typeof require === 'function' ? require('./renderer-memory-actions-v2-utils') : {});
  const defaultNormalizeApprovedMemoryKindFilter = typeof sharedMemoryUtils.normalizeApprovedMemoryKindFilter === 'function'
    ? sharedMemoryUtils.normalizeApprovedMemoryKindFilter
    : function fallbackNormalizeFilter(value) { return String(value || 'all'); };

  function createMemoryActionController(deps) {
    const {
      state,
      registerCleanup = function noop() {},
      constants = {},
      callbacks = {},
      getHubDom = function fallbackGetHubDom() { return {}; },
      helpers = {},
    } = deps || {};

    const { TOAST_SOURCE = {} } = constants;
    const CAPTURE_PREFERENCE_KEY = 'jenny.memory.captureSuggestions';
    let disposed = false;
    let searchTimer = null;
    let capturePreferenceWriteSequence = 0;
    let capturePreferenceWritePromise = Promise.resolve();
    let confirmedCapturePreference = state.features?.memory?.captureSuggestions !== false;
    let capturePreferenceWriteStarted = false;
    registerCleanup(function disposeMemoryActions() {
      disposed = true;
      if (searchTimer) windowRef.clearTimeout(searchTimer);
      searchTimer = null;
    });

    const {
      appendClientLog = function noop() {},
      showToastMessage = function noop() {},
      showShellErrorToast = function noop() {},
      toErrorMessage = function fallbackToErrorMessage(error) { return String(error?.message || error || ''); },
      dismissToast = function noop() {},
      openSettingsSection = function noop() {},
      normalizeApprovedMemoryKindFilter = defaultNormalizeApprovedMemoryKindFilter,
    } = callbacks;
    const {
      getApprovedMemoryById = function noopNull() { return null; },
      getApprovedMemoryFieldValue = function fallbackApprovedMemoryFieldValue(memory, fieldName) {
        return String(memory?.[fieldName] || '');
      },
      hasApprovedMemoryDraftChanges = function noopFalse() { return false; },
      clearApprovedMemoryDraft = function noop() {},
      upsertApprovedMemoryDraft = function noop() {},
      setApprovedMemoryPendingAction = function noop() {},
      renderMemorySurfaces = function noop() {},
      refreshApprovedMemories = async function noopAsync() { return { memories: [] }; },
      refreshPendingMemories = async function noopAsync() { return { candidates: [] }; },
      refreshMemoryStatus = async function noopAsync() { return { status: null }; },
      getPendingMemoryCandidate = function noopNull() { return null; },
      setPendingMemoryReviewAction = function noop() {},
      clearDismissedMemoryFingerprint = function noop() {},
      rememberDismissedMemoryFingerprint = function noop() {},
      rememberHandledMemorySuggestionStream = function noopFalse() { return false; },
      getDismissedMemoryFingerprints = function noopNull() { return null; },
      buildPendingMemoryKey = function fallbackBuildPendingMemoryKey(sessionId, contentFingerprint) {
        return `${String(sessionId || '')}::${String(contentFingerprint || '')}`;
      },
    } = helpers;

    function getMemoryApi() {
      return windowRef.jennyShell?.memory || null;
    }

    function setCaptureSuggestionsEnabled(enabled) {
      state.features = state.features && typeof state.features === 'object' ? state.features : {};
      state.features.memory = {
        ...(state.features.memory && typeof state.features.memory === 'object' ? state.features.memory : {}),
        captureSuggestions: enabled === true,
      };
    }

    function readLegacyCapturePreference() {
      try {
        const value = windowRef.localStorage?.getItem(CAPTURE_PREFERENCE_KEY);
        return value === null || value === undefined ? null : value !== '0';
      } catch (_error) {
        return null;
      }
    }

    function removeLegacyCapturePreference() {
      try { windowRef.localStorage?.removeItem(CAPTURE_PREFERENCE_KEY); } catch (_error) { /* retry next launch */ }
    }

    function persistCapturePreference(enabled, { legacyAdoption = false } = {}) {
      if (!capturePreferenceWriteStarted && !legacyAdoption) {
        confirmedCapturePreference = state.features?.memory?.captureSuggestions !== false;
      }
      capturePreferenceWriteStarted = true;
      const sequence = ++capturePreferenceWriteSequence;
      setCaptureSuggestionsEnabled(enabled);
      renderMemorySurfaces();
      capturePreferenceWritePromise = capturePreferenceWritePromise
        .catch(() => undefined)
        .then(async () => {
          const updateSettings = windowRef.jennyShell?.features?.updateSettings;
          if (typeof updateSettings !== 'function') throw new Error('Feature settings are unavailable.');
          const payload = await updateSettings({ memory: { captureSuggestions: enabled === true } });
          const persisted = payload?.memory?.captureSuggestions;
          if (typeof persisted !== 'boolean' || persisted !== (enabled === true)) {
            throw new Error('Feature settings returned an invalid memory preference acknowledgement.');
          }
          if (disposed) return;
          confirmedCapturePreference = persisted;
          removeLegacyCapturePreference();
          if (sequence === capturePreferenceWriteSequence) {
            setCaptureSuggestionsEnabled(persisted);
            renderMemorySurfaces();
          }
        })
        .catch((error) => {
          if (legacyAdoption) confirmedCapturePreference = enabled === true;
          if (disposed || sequence !== capturePreferenceWriteSequence) return;
          setCaptureSuggestionsEnabled(confirmedCapturePreference);
          appendClientLog('WARN', legacyAdoption ? 'memory.capture_preference_adoption_failed' : 'memory.capture_preference_update_failed', {
            message: toErrorMessage(error, 'Could not save memory capture preference.'),
          });
          if (!legacyAdoption) {
            showShellErrorToast('Could not save the memory capture preference.', {
              title: 'Memory Preference Not Saved',
              source: TOAST_SOURCE.memory,
              dedupeKey: `${TOAST_SOURCE.memory}:capture-preference:error`,
            });
          }
          renderMemorySurfaces();
        });
      return capturePreferenceWritePromise;
    }

    const legacyCapturePreference = readLegacyCapturePreference();
    if (legacyCapturePreference !== null) {
      setCaptureSuggestionsEnabled(legacyCapturePreference);
      persistCapturePreference(legacyCapturePreference, { legacyAdoption: true });
    }

    function isSuccessfulMemorySave(result) {
      return result?.created === true
        || Boolean(result?.memory && typeof result.memory === 'object' && !Array.isArray(result.memory));
    }

    function focusElement(control) {
      if (!control || typeof control.focus !== 'function') return;
      try { control.focus({ preventScroll: true }); } catch (_error) { control.focus(); }
    }

    function focusMemoryControl(selector) {
      focusElement(getHubDom().memorySection?.querySelector?.(selector));
    }

    function focusPendingAction(action, sessionId, fingerprint) {
      const buttons = getHubDom().memorySection?.querySelectorAll?.('[data-pending-memory-action]') || [];
      const control = [...buttons].find((button) => (
        button.dataset.pendingMemoryAction === action
        && button.dataset.sessionId === sessionId
        && button.dataset.fingerprint === fingerprint
      ));
      if (control) focusElement(control);
      else focusMemoryControl('#pendingMemorySort');
    }

    function reportUnavailableAction(title, message, key) {
      if (disposed) return;
      showShellErrorToast(message, {
        title,
        source: TOAST_SOURCE.memory,
        dedupeKey: `${TOAST_SOURCE.memory}:unavailable:${key}`,
      });
    }

    function normalizeEditingMemoryId(memoryId) {
      if (typeof memoryActionsV2Utils.normalizeEditingMemoryId === 'function') {
        return memoryActionsV2Utils.normalizeEditingMemoryId(memoryId);
      }
      const resolvedMemoryId = Number(memoryId);
      return Number.isInteger(resolvedMemoryId) && resolvedMemoryId > 0 ? resolvedMemoryId : null;
    }

    function setEditingMemoryId(memoryId) {
      state.memoryManager.editingMemoryId = normalizeEditingMemoryId(memoryId);
    }

    function openMemoryHub(options = {}) {
      if (disposed) return;
      const focusTarget = typeof memoryActionsV2Utils.resolvePendingFocusTarget === 'function'
        ? memoryActionsV2Utils.resolvePendingFocusTarget(options, buildPendingMemoryKey)
        : { key: '', target: null };
      state.memoryManager.pendingFocusKey = focusTarget.key;
      state.memoryManager.pendingFocusAppliedKey = '';
      if (focusTarget.key) {
        state.memoryManager.pendingFilter = 'all';
      }
      openSettingsSection('memories', { refresh: true, source: 'memory' });
    }

    async function handleApprovedMemorySave(memoryId) {
      if (disposed) return;
      const memoryApi = getMemoryApi();
      const memory = getApprovedMemoryById(memoryId);
      if (!memory) return;
      if (!memoryApi || typeof memoryApi.update !== 'function') {
        reportUnavailableAction('Memory Update Unavailable', 'Approved memory editing is unavailable.', 'update');
        return;
      }
      const patch = {
        title: getApprovedMemoryFieldValue(memory, 'title'),
        lesson_text: getApprovedMemoryFieldValue(memory, 'lesson_text'),
      };
      setApprovedMemoryPendingAction(memory.id, 'save');
      renderMemorySurfaces();
      let saveSucceeded = false;
      try {
        const updated = await memoryApi.update(memory.id, patch);
        if (disposed) return;
        if (updated?.updated !== true) {
          throw new Error('Could not update approved memory.');
        }
        clearApprovedMemoryDraft(memory.id);
        setEditingMemoryId(null);
        saveSucceeded = true;
        showToastMessage('I updated that memory.', {
          title: 'Memory Updated',
          tone: 'success',
          source: TOAST_SOURCE.memory,
          dedupeKey: `${TOAST_SOURCE.memory}:updated:${memory.id}`,
        });
        await refreshApprovedMemories({ force: true });
      } catch (error) {
        if (disposed) return;
        showShellErrorToast(toErrorMessage(error, 'Could not update approved memory.'), {
          title: 'Memory Update Failed',
          source: TOAST_SOURCE.memory,
          dedupeKey: `${TOAST_SOURCE.memory}:update:error:${memory.id}`,
        });
      } finally {
        if (!disposed) {
          setApprovedMemoryPendingAction(memory.id, '');
          renderMemorySurfaces();
          focusMemoryControl(saveSucceeded
            ? `[data-memory-action="edit"][data-memory-id="${memory.id}"]`
            : `[data-memory-action="save"][data-memory-id="${memory.id}"]`);
        }
      }
    }

    async function executeApprovedMemoryDelete(memory) {
      if (disposed) return;
      const memoryApi = getMemoryApi();
      if (!memory) return;
      if (!memoryApi || typeof memoryApi.delete !== 'function') {
        reportUnavailableAction('Memory Delete Unavailable', 'Approved memory deletion is unavailable.', 'delete');
        return;
      }
      const deletedSnapshot = { ...memory };
      setApprovedMemoryPendingAction(memory.id, 'delete');
      renderMemorySurfaces();
      try {
        const deleted = await memoryApi.delete(memory.id);
        if (disposed) return;
        if (deleted?.deleted !== true) {
          throw new Error('Could not delete approved memory.');
        }
        clearApprovedMemoryDraft(memory.id);
        if (Number(state.memoryManager.editingMemoryId) === Number(memory.id)) {
          setEditingMemoryId(null);
        }
        const undoDedupeKey = `${TOAST_SOURCE.memory}:deleted:${memory.id}`;
        showToastMessage('I removed that memory.', {
          title: 'Memory Deleted',
          tone: 'success',
          source: TOAST_SOURCE.memory,
          dedupeKey: undoDedupeKey,
          actions: [
            {
              id: 'undo-delete',
              label: 'Undo',
              kind: 'secondary',
              onClick: async () => {
                dismissToast(undoDedupeKey);
                try {
                  if (typeof memoryApi.save !== 'function') throw new Error('Memory restore is unavailable.');
                  const restored = await memoryApi.save(deletedSnapshot.session_id || '', {
                    title: deletedSnapshot.title,
                    lesson_text: deletedSnapshot.lesson_text,
                    lesson_kind: deletedSnapshot.lesson_kind,
                    confidence: deletedSnapshot.confidence,
                    source_excerpt: deletedSnapshot.source_excerpt,
                    content_fingerprint: deletedSnapshot.content_fingerprint,
                  });
                  if (disposed) return;
                  if (!isSuccessfulMemorySave(restored)) throw new Error('Could not restore memory.');
                  showToastMessage('Memory restored.', {
                    title: 'Undo Successful',
                    tone: 'success',
                    source: TOAST_SOURCE.memory,
                    dedupeKey: `${TOAST_SOURCE.memory}:undo:${memory.id}`,
                  });
                  await Promise.all([
                    refreshApprovedMemories({ force: true }),
                    refreshPendingMemories({ force: true }),
                    refreshMemoryStatus({ force: true }),
                  ]);
                } catch (undoError) {
                  if (disposed) return;
                  showShellErrorToast(toErrorMessage(undoError, 'Could not restore memory.'), {
                    title: 'Undo Failed',
                    source: TOAST_SOURCE.memory,
                    dedupeKey: `${TOAST_SOURCE.memory}:undo:error:${memory.id}`,
                  });
                }
              },
            },
          ],
        });
        await Promise.all([
          refreshApprovedMemories({ force: true }),
          refreshPendingMemories({ force: true }),
          refreshMemoryStatus({ force: true }),
        ]);
      } catch (error) {
        if (disposed) return;
        showShellErrorToast(toErrorMessage(error, 'Could not delete approved memory.'), {
          title: 'Memory Delete Failed',
          source: TOAST_SOURCE.memory,
          dedupeKey: `${TOAST_SOURCE.memory}:delete:error:${memory.id}`,
        });
      } finally {
        if (!disposed) {
          setApprovedMemoryPendingAction(memory.id, '');
          renderMemorySurfaces();
        }
      }
    }

    function handleApprovedMemoryDelete(memoryId) {
      if (disposed) return;
      const memory = getApprovedMemoryById(memoryId);
      if (!memory) {
        return;
      }
      const deleteDedupeKey = `${TOAST_SOURCE.memory}:confirm-delete:${memory.id}`;
      showToastMessage(
        `Delete "${memory.title}"? You can undo this for a short time.`,
        {
          title: 'Confirm Delete',
          tone: 'warning',
          sticky: true,
          source: TOAST_SOURCE.memory,
          dedupeKey: deleteDedupeKey,
          actions: [
            {
              id: 'confirm-delete',
              label: 'Delete',
              kind: 'danger',
              onClick: () => {
                dismissToast(deleteDedupeKey);
                executeApprovedMemoryDelete(memory);
              },
            },
            {
              id: 'cancel-delete',
              label: 'Cancel',
              kind: 'secondary',
              onClick: () => {
                dismissToast(deleteDedupeKey);
              },
            },
          ],
        }
      );
    }

    async function handleRemoveProvenance(memoryId) {
      if (disposed) return;
      const memory = getApprovedMemoryById(memoryId);
      const memoryApi = getMemoryApi();
      if (!memory) return;
      if (!memoryApi || typeof memoryApi.update !== 'function') {
        reportUnavailableAction('Source Removal Unavailable', 'Memory source removal is unavailable.', 'source');
        return;
      }
      setApprovedMemoryPendingAction(memory.id, 'source');
      renderMemorySurfaces();
      let removalSucceeded = false;
      try {
        const result = await memoryApi.update(memory.id, {
          title: memory.title,
          lesson_text: memory.lesson_text,
          remove_provenance: true,
        });
        if (disposed) return;
        if (result?.updated !== true) throw new Error('Could not remove memory source.');
        removalSucceeded = true;
        await refreshApprovedMemories({ force: true });
      } catch (error) {
        if (disposed) return;
        showShellErrorToast(toErrorMessage(error, 'Could not remove memory source.'), {
          title: 'Source Removal Failed', source: TOAST_SOURCE.memory,
          dedupeKey: `${TOAST_SOURCE.memory}:source:error:${memory.id}`,
        });
      } finally {
        if (!disposed) {
          setApprovedMemoryPendingAction(memory.id, '');
          renderMemorySurfaces();
          focusMemoryControl(removalSucceeded
            ? `[data-memory-action="edit"][data-memory-id="${memory.id}"]`
            : `[data-memory-action="remove-provenance"][data-memory-id="${memory.id}"]`);
        }
      }
    }

    async function handlePendingReview(action, sessionId, fingerprint) {
      if (disposed) return;
      if (action !== 'approve' && action !== 'discard') return;
      const memoryApi = getMemoryApi();
      const candidate = getPendingMemoryCandidate(sessionId, fingerprint);
      if (!candidate) return;
      if (!memoryApi) {
        reportUnavailableAction('Memory Review Unavailable', 'Pending memory review is unavailable.', 'review');
        return;
      }
      setPendingMemoryReviewAction(sessionId, fingerprint, action);
      renderMemorySurfaces();
      try {
        if (action === 'approve') {
          if (typeof memoryApi.save !== 'function') throw new Error('Memory approval is unavailable.');
          const saved = await memoryApi.save(sessionId, candidate);
          if (disposed) return;
          if (!isSuccessfulMemorySave(saved)) throw new Error('Memory approval is unavailable.');
        } else {
          if (typeof memoryApi.deletePending !== 'function') throw new Error('Pending memory dismissal is unavailable.');
          const deleted = await memoryApi.deletePending(sessionId, fingerprint);
          if (disposed) return;
          if (deleted?.deleted !== true) throw new Error('Pending memory dismissal is unavailable.');
          if (typeof memoryApi.dismiss === 'function') await memoryApi.dismiss(fingerprint);
          if (disposed) return;
        }
        await Promise.all([
          refreshApprovedMemories({ force: true }),
          refreshPendingMemories({ force: true }),
          refreshMemoryStatus({ force: true }),
        ]);
      } catch (error) {
        if (disposed) return;
        showShellErrorToast(toErrorMessage(error, 'Could not update pending memory.'), {
          title: 'Memory Review Failed', source: TOAST_SOURCE.memory,
          dedupeKey: `${TOAST_SOURCE.memory}:review:error:${fingerprint}`,
        });
      } finally {
        if (!disposed) {
          setPendingMemoryReviewAction(sessionId, fingerprint, '');
          renderMemorySurfaces();
          focusPendingAction(action, sessionId, fingerprint);
        }
      }
    }

    async function maybeSuggestMemoryCapture(payload, options = {}) {
      if (disposed) return;
      const streamId = String(payload?.streamId || '').trim();
      const sessionId = String(payload?.sessionId || '').trim();
      const memoryApi = getMemoryApi();
      if (state.features?.memory?.captureSuggestions === false
        || !streamId || !sessionId || !rememberHandledMemorySuggestionStream(streamId)) {
        return;
      }
      if (!memoryApi || typeof memoryApi.suggestForSession !== 'function') {
        return;
      }

      try {
        const result = await memoryApi.suggestForSession(sessionId);
        if (disposed) return;
        if (options.signal?.aborted === true) return;
        if (options.guard && typeof options.guard.isCurrent === 'function'
          && options.guard.isCurrent() !== true) return;
        const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
        const candidate = suggestions[0];
        if (!candidate || typeof candidate !== 'object') {
          return;
        }
        const candidateFingerprint = String(candidate.content_fingerprint || '').trim().toLowerCase();
        if (candidateFingerprint && getDismissedMemoryFingerprints(sessionId)?.has(candidateFingerprint)) {
          return;
        }

        appendClientLog('INFO', 'memory.suggested', {
          sessionId,
          streamId,
          lessonKind: String(candidate.lesson_kind || ''),
          fingerprint: candidateFingerprint,
        });

        let toastId = '';
        const dedupeKey = `${TOAST_SOURCE.memory}:${sessionId}`;
        toastId = showToastMessage(
          String(candidate.lesson_text || 'I noticed something worth remembering.'),
          {
            title: 'Remember this?',
            tone: 'warning',
            sticky: true,
            source: TOAST_SOURCE.memory,
            dedupeKey,
            actions: [
              {
                id: 'remember',
                label: 'Remember',
                kind: 'primary',
                onClick: async () => {
                  try {
                    const saved = await memoryApi.save(sessionId, candidate);
                    if (disposed) return;
                    if (!isSuccessfulMemorySave(saved)) throw new Error('Memory save is unavailable.');
                    clearDismissedMemoryFingerprint(sessionId, candidateFingerprint);
                    dismissToast(toastId);
                    await Promise.all([
                      refreshApprovedMemories({ force: true }),
                      refreshPendingMemories({ force: true }),
                      refreshMemoryStatus({ force: true }),
                    ]);
                    showToastMessage(
                      saved?.created === false ? 'I already had that saved.' : "I'll remember that.",
                      {
                        title: 'Memory Saved',
                        tone: 'success',
                        source: TOAST_SOURCE.memory,
                        dedupeKey: `${dedupeKey}:saved`,
                      }
                    );
                    appendClientLog('INFO', 'memory.saved', {
                      sessionId,
                      streamId,
                      created: saved?.created === true,
                      fingerprint: candidateFingerprint,
                    });
                  } catch (error) {
                    if (disposed) return;
                    appendClientLog('ERROR', 'memory.save_failed', {
                      sessionId,
                      streamId,
                      message: toErrorMessage(error, 'Could not save memory.'),
                    });
                    showShellErrorToast(toErrorMessage(error, 'Could not save memory.'), {
                      title: 'Memory Save Failed',
                      source: TOAST_SOURCE.memory,
                      dedupeKey: `${dedupeKey}:error`,
                    });
                  }
                },
              },
              {
                id: 'open-memory-hub',
                label: 'Review in Memory',
                kind: 'secondary',
                onClick: () => {
                  dismissToast(toastId);
                  openMemoryHub({
                    pendingTarget: {
                      sessionId,
                      contentFingerprint: candidateFingerprint,
                    },
                  });
                },
              },
              {
                id: 'dismiss',
                label: 'Not now',
                kind: 'secondary',
                onClick: () => {
                  if (disposed) return;
                  rememberDismissedMemoryFingerprint(sessionId, candidateFingerprint);
                  if (typeof memoryApi.dismiss === 'function') {
                    memoryApi.dismiss(candidateFingerprint).catch((error) => {
                      appendClientLog('WARN', 'memory.dismiss_failed', {
                        fingerprint: candidateFingerprint,
                        message: String(error?.message || error),
                      });
                    });
                  }
                  dismissToast(toastId);
                  appendClientLog('INFO', 'memory.dismissed', {
                    sessionId,
                    streamId,
                    fingerprint: candidateFingerprint,
                  });
                },
              },
            ],
          }
        );
      } catch (error) {
        appendClientLog('WARN', 'memory.suggest_failed', {
          sessionId,
          streamId,
          message: toErrorMessage(error, 'Could not suggest memory.'),
        });
      }
    }

    function bindMemoryPageEvents() {
      const memorySection = getHubDom().memorySection;
      if (!memorySection || memorySection.__jennyMemoryPageBound) {
        return;
      }
      memorySection.__jennyMemoryPageBound = true;
      function handleInput(event) {
        const draftField = event.target.closest('[data-memory-draft-field]');
        if (draftField) {
          const memoryId = Number(draftField.dataset.memoryId);
          upsertApprovedMemoryDraft(memoryId, { [draftField.dataset.memoryDraftField]: String(draftField.value || '') });
          const memory = getApprovedMemoryById(memoryId);
          const saveButton = draftField.closest('article[data-memory-id]')?.querySelector('[data-memory-action="save"]');
          if (saveButton) {
            saveButton.disabled = !memory || !hasApprovedMemoryDraftChanges(memory);
          }
          return;
        }
        if (event.target.id !== 'memoryManagerSearchInput') return;
        if (searchTimer) windowRef.clearTimeout(searchTimer);
        const query = String(event.target.value || '').slice(0, 120);
        searchTimer = windowRef.setTimeout(() => {
          searchTimer = null;
          if (disposed) return;
          state.memoryManager.searchQuery = query;
          state.memoryManager.approvedVisibleLimit = MEMORY_RENDER_BATCH_SIZE;
          renderMemorySurfaces();
        }, 150);
      }
      function handleChange(event) {
        if (event.target.id === 'memoryManagerKindFilter') {
          state.memoryManager.filter = normalizeApprovedMemoryKindFilter(event.target.value);
          state.memoryManager.approvedVisibleLimit = MEMORY_RENDER_BATCH_SIZE;
        } else if (event.target.id === 'pendingMemorySort') {
          state.memoryManager.pendingSort = String(event.target.value || 'newest');
          state.memoryManager.pendingVisibleLimit = MEMORY_RENDER_BATCH_SIZE;
        }
        else return;
        renderMemorySurfaces();
      }
      function handleToggle(event) {
        if (event.detail?.id !== 'memoryCaptureSuggestions') return;
        persistCapturePreference(event.detail.checked === true);
      }
      function handleClick(event) {
        const pageAction = event.target.closest('[data-memory-page-action]');
        if (pageAction) {
          if (pageAction.dataset.memoryPageAction === 'show-more-approved') {
            state.memoryManager.approvedVisibleLimit = (Number(state.memoryManager.approvedVisibleLimit) || MEMORY_RENDER_BATCH_SIZE) + MEMORY_RENDER_BATCH_SIZE;
          } else if (pageAction.dataset.memoryPageAction === 'show-more-pending') {
            state.memoryManager.pendingVisibleLimit = (Number(state.memoryManager.pendingVisibleLimit) || MEMORY_RENDER_BATCH_SIZE) + MEMORY_RENDER_BATCH_SIZE;
          }
          renderMemorySurfaces();
          return;
        }
        const actionButton = event.target.closest('[data-memory-action]');
        if (actionButton) {
          const memoryId = Number(actionButton.dataset.memoryId);
          const action = String(actionButton.dataset.memoryAction || '');
          if (!Number.isInteger(memoryId) || memoryId <= 0) return;
          if (action === 'edit') {
            setEditingMemoryId(memoryId);
            renderMemorySurfaces();
            focusMemoryControl(`[data-memory-draft-field="title"][data-memory-id="${memoryId}"]`);
          }
          else if (action === 'cancel') {
            clearApprovedMemoryDraft(memoryId);
            setEditingMemoryId(null);
            renderMemorySurfaces();
            focusMemoryControl(`[data-memory-action="edit"][data-memory-id="${memoryId}"]`);
          }
          else if (action === 'save') handleApprovedMemorySave(memoryId);
          else if (action === 'delete') handleApprovedMemoryDelete(memoryId);
          else if (action === 'remove-provenance') handleRemoveProvenance(memoryId);
          return;
        }
        const pendingButton = event.target.closest('[data-pending-memory-action]');
        if (pendingButton) handlePendingReview(String(pendingButton.dataset.pendingMemoryAction || ''), String(pendingButton.dataset.sessionId || ''), String(pendingButton.dataset.fingerprint || ''));
      }
      memorySection.addEventListener('input', handleInput);
      memorySection.addEventListener('change', handleChange);
      memorySection.addEventListener('inv-toggle-change', handleToggle);
      memorySection.addEventListener('click', handleClick);
      registerCleanup(function disposeMemoryPageBindings() {
        memorySection.__jennyMemoryPageBound = false;
        memorySection.removeEventListener('input', handleInput);
        memorySection.removeEventListener('change', handleChange);
        memorySection.removeEventListener('inv-toggle-change', handleToggle);
        memorySection.removeEventListener('click', handleClick);
      });
    }

    return {
      bindMemoryPageEvents,
      openMemoryHub,
      handleApprovedMemorySave,
      handleApprovedMemoryDelete,
      maybeSuggestMemoryCapture,
    };
  }

  return {
    createMemoryActionController,
  };
});
