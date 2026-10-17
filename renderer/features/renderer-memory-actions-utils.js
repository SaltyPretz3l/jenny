(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMemoryActionsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const windowRef = globalRef.window || globalRef;
  const MEMORY_RENDER_BATCH_SIZE = 200;
  const sharedMemoryUtils = globalRef.rendererMemorySharedUtils || {};
  const pageActionsUtils = globalRef.rendererMemoryPageActionsUtils
    || (typeof require === 'function' ? require('./renderer-memory-page-actions-utils') : {});
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
    let disposed = false;
    let pageActions = null;
    let searchTimer = null;
    registerCleanup(function disposeMemoryActions() {
      disposed = true;
      if (searchTimer) windowRef.clearTimeout(searchTimer);
      searchTimer = null;
    });

    const {
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
      buildPendingMemoryKey = function fallbackBuildPendingMemoryKey(sessionId, contentFingerprint) {
        return `${String(sessionId || '')}::${String(contentFingerprint || '')}`;
      },
    } = helpers;

    function getMemoryApi() {
      return windowRef.jennyShell?.memory || null;
    }

    /* The four memory v2 switches persist through the shared Settings
     * coordinator: written to the features bridge, adopted only from the
     * echoed `memory` section. */
    const POLICY_KEYS = ['takeNotes', 'askBeforeSaving', 'pauseSaving', 'useInChats'];
    const load = (path) => (typeof require === 'function' ? require(path) : null);
    const fieldBinding = globalRef.rendererSettingsFieldBinding || load('../shell/renderer-settings-field-binding');
    const descriptorSource = globalRef.rendererSettingsFieldDescriptors || load('../shell/renderer-settings-field-descriptors');
    const policyDescriptors = ['memoryTakeNotes', 'memoryAskBeforeSaving', 'memoryPauseSaving', 'memoryUseInChats']
      .map((id) => descriptorSource?.getSettingDescriptor?.(id)).filter(Boolean);
    const policyRegistry = fieldBinding && policyDescriptors.length ? fieldBinding.createSettingsAdapterRegistry() : null;
    const readPolicy = (source) => ({
      takeNotes: source?.takeNotes !== false,
      askBeforeSaving: source?.askBeforeSaving === true,
      pauseSaving: source?.pauseSaving === true,
      useInChats: source?.useInChats !== false,
    });
    policyRegistry?.register({
      id: 'memory',
      mode: 'patch',
      optimistic: false,
      read: () => readPolicy(state.features?.memory),
      normalize: readPolicy,
      write: (payload) => {
        const updateSettings = windowRef.jennyShell?.features?.updateSettings;
        if (typeof updateSettings !== 'function') throw new Error('Feature settings are unavailable.');
        const patch = {};
        POLICY_KEYS.forEach((key) => { if (typeof payload?.[key] === 'boolean') patch[key] = payload[key]; });
        return updateSettings({ memory: patch });
      },
      ack: (result, payload) => {
        const persisted = result?.memory;
        POLICY_KEYS.forEach((key) => {
          if (typeof payload?.[key] === 'boolean' && persisted?.[key] !== payload[key]) {
            throw new Error('Feature settings returned an invalid memory preference acknowledgement.');
          }
        });
        return readPolicy(persisted);
      },
      apply: (next) => {
        if (disposed) return;
        state.features = state.features && typeof state.features === 'object' ? state.features : {};
        state.features.memory = readPolicy(next);
        renderMemorySurfaces();
      },
    });

    // A write names the revision the user saw; the sidecar answers `conflict` when it moved on.
    function revisionOptions(memory) {
      return Number.isSafeInteger(memory?.revision) && memory.revision > 0 ? { expectedRevision: memory.revision } : {};
    }

    // The draft and the editor stay as they are; the list refresh brings in the current row.
    async function reportMemoryConflict(memory, message) {
      showToastMessage(message, {
        title: jt('memory.titles.changed', 'Memory Changed'),
        tone: 'warning',
        source: TOAST_SOURCE.memory,
        dedupeKey: `${TOAST_SOURCE.memory}:conflict:${memory.id}`,
      });
      await refreshApprovedMemories({ force: true });
    }

    const editConflictMessage = () => jt('memory.toasts.editConflict', 'This memory changed somewhere else, so your edit wasn\'t saved. Check the latest version and save again.');

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
      openSettingsSection('memories', { refresh: true, source: 'memory' });
    }

    async function handleApprovedMemorySave(memoryId) {
      if (disposed) return;
      const memoryApi = getMemoryApi();
      const memory = getApprovedMemoryById(memoryId);
      if (!memory) return;
      if (!memoryApi || typeof memoryApi.update !== 'function') {
        reportUnavailableAction(jt('memory.titles.updateUnavailable', 'Memory Update Unavailable'), jt('memory.errors.editingUnavailable', 'Approved memory editing is unavailable.'), 'update');
        return;
      }
      // The sidecar re-derives the title from changed text; a user edit marks the row protected.
      const patch = { lesson_text: getApprovedMemoryFieldValue(memory, 'lesson_text') };
      setApprovedMemoryPendingAction(memory.id, 'save');
      renderMemorySurfaces();
      let saveSucceeded = false;
      try {
        const updated = await memoryApi.update(memory.id, patch, memory.project_id || undefined, revisionOptions(memory));
        if (disposed) return;
        if (updated?.status === 'conflict') {
          await reportMemoryConflict(memory, editConflictMessage());
          return;
        }
        if (updated?.updated !== true) {
          throw new Error('Could not update approved memory.');
        }
        clearApprovedMemoryDraft(memory.id);
        setEditingMemoryId(null);
        saveSucceeded = true;
        showToastMessage(jt('memory.toasts.updated', 'I updated that memory.'), {
          title: jt('memory.titles.updated', 'Memory Updated'),
          tone: 'success',
          source: TOAST_SOURCE.memory,
          dedupeKey: `${TOAST_SOURCE.memory}:updated:${memory.id}`,
        });
        await refreshApprovedMemories({ force: true });
      } catch (error) {
        if (disposed) return;
        showShellErrorToast(toErrorMessage(error, jt('memory.errors.updateApproved', 'Could not update approved memory.')), {
          title: jt('memory.titles.updateFailed', 'Memory Update Failed'),
          source: TOAST_SOURCE.memory,
          dedupeKey: `${TOAST_SOURCE.memory}:update:error:${memory.id}`,
        });
      } finally {
        if (!disposed) {
          setApprovedMemoryPendingAction(memory.id, '');
          renderMemorySurfaces();
          focusMemoryControl(saveSucceeded
            ? `[data-memory-page-action="menu"][data-memory-id="${memory.id}"]`
            : `[data-memory-action="save"][data-memory-id="${memory.id}"]`);
        }
      }
    }

    async function executeApprovedMemoryDelete(memory) {
      if (disposed) return;
      const memoryApi = getMemoryApi();
      if (!memory) return;
      if (!memoryApi || typeof memoryApi.delete !== 'function') {
        reportUnavailableAction(jt('memory.titles.deleteUnavailable', 'Memory Delete Unavailable'), jt('memory.errors.deletionUnavailable', 'Approved memory deletion is unavailable.'), 'delete');
        return;
      }
      setApprovedMemoryPendingAction(memory.id, 'delete');
      renderMemorySurfaces();
      try {
        const deleted = await memoryApi.delete(memory.id, memory.project_id || undefined, revisionOptions(memory));
        if (disposed) return;
        if (deleted?.status === 'conflict') {
          await reportMemoryConflict(memory, jt('memory.toasts.deleteConflict', 'This memory changed somewhere else, so it wasn\'t deleted. Check the latest version and try again.'));
          return;
        }
        if (deleted?.deleted !== true) {
          throw new Error('Could not delete approved memory.');
        }
        clearApprovedMemoryDraft(memory.id);
        if (Number(state.memoryManager.editingMemoryId) === Number(memory.id)) {
          setEditingMemoryId(null);
        }
        const undoDedupeKey = `${TOAST_SOURCE.memory}:deleted:${memory.id}`;
        // Undo inverts the recorded delete in the row's own project; no operation, no Undo.
        const deleteOperationId = deleted.undoable === true && typeof deleted.operation_id === 'string'
          ? deleted.operation_id
          : '';
        // dismissToast takes the id showToastMessage returns, not the dedupeKey.
        let undoToastId = '';
        undoToastId = showToastMessage(jt('memory.page.forgotToast', 'Jenny will forget that. Undo, or restore it later from Forgotten.'), {
          title: jt('memory.page.forgotTitle', 'Memory Forgotten'),
          tone: 'success',
          source: TOAST_SOURCE.memory,
          dedupeKey: undoDedupeKey,
          actions: !deleteOperationId ? [] : [
            {
              id: 'undo-delete',
              label: jt('memory.actions.undo', 'Undo'),
              kind: 'secondary',
              onClick: async () => {
                dismissToast(undoToastId);
                try {
                  if (typeof memoryApi.undoChange !== 'function') throw new Error('Memory restore is unavailable.');
                  const restored = await memoryApi.undoChange(deleteOperationId, memory.project_id || undefined);
                  if (disposed) return;
                  if (restored?.status !== 'saved') throw new Error('Could not restore memory.');
                  showToastMessage(jt('memory.toasts.restored', 'Memory restored.'), {
                    title: jt('memory.titles.undoSuccessful', 'Undo Successful'),
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
                  showShellErrorToast(toErrorMessage(undoError, jt('memory.errors.restore', 'Could not restore memory.')), {
                    title: jt('memory.titles.undoFailed', 'Undo Failed'),
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
          pageActions?.refreshFolds(),
        ]);
      } catch (error) {
        if (disposed) return;
        showShellErrorToast(toErrorMessage(error, jt('memory.errors.deleteApproved', 'Could not delete approved memory.')), {
          title: jt('memory.titles.deleteFailed', 'Memory Delete Failed'),
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

    // Forget archives the row (with its suppression); Undo and the Forgotten
    // fold bring it back, so it needs no confirmation step.
    function handleApprovedMemoryDelete(memoryId) {
      if (disposed) return;
      const memory = getApprovedMemoryById(memoryId);
      if (memory) executeApprovedMemoryDelete(memory);
    }

    // projectId: the project the proposal was queued in (its chat may have moved since).
    async function handlePendingReview(action, sessionId, fingerprint, projectId) {
      if (disposed) return;
      if (action !== 'approve' && action !== 'discard') return;
      const memoryApi = getMemoryApi();
      const candidate = getPendingMemoryCandidate(sessionId, fingerprint);
      if (!candidate) return;
      if (!memoryApi) {
        reportUnavailableAction(jt('memory.titles.reviewUnavailable', 'Memory Review Unavailable'), jt('memory.errors.reviewUnavailable', 'Pending memory review is unavailable.'), 'review');
        return;
      }
      setPendingMemoryReviewAction(sessionId, fingerprint, action);
      renderMemorySurfaces();
      try {
        if (action === 'approve') {
          if (typeof memoryApi.acceptPending !== 'function') throw new Error('Memory approval is unavailable.');
          // The sidecar resolves the queued row and writes it into its own project.
          const accepted = await memoryApi.acceptPending(sessionId, fingerprint, projectId || undefined);
          if (disposed) return;
          if (accepted?.status === 'refused') {
            const refusal = accepted.reason === 'suppressed'
              ? jt('memory.toasts.pendingSuppressed', 'You asked me to forget this, so I didn\'t save it.')
              : jt('memory.toasts.pendingUnavailable', 'This memory can no longer be saved.');
            showToastMessage(refusal, {
              title: jt('memory.titles.reviewUnavailable', 'Memory Review Unavailable'),
              tone: 'warning',
              source: TOAST_SOURCE.memory,
              dedupeKey: `${TOAST_SOURCE.memory}:review:refused:${fingerprint}`,
            });
          } else if (accepted?.status !== 'saved') {
            throw new Error('Memory approval is unavailable.');
          }
        } else {
          if (typeof memoryApi.deletePending !== 'function') throw new Error('Pending memory dismissal is unavailable.');
          const deleted = await memoryApi.deletePending(sessionId, fingerprint, projectId || undefined);
          if (disposed) return;
          if (deleted?.deleted !== true) throw new Error('Pending memory dismissal is unavailable.');
        }
        await Promise.all([
          refreshApprovedMemories({ force: true }),
          refreshPendingMemories({ force: true }),
          refreshMemoryStatus({ force: true }),
        ]);
      } catch (error) {
        if (disposed) return;
        showShellErrorToast(toErrorMessage(error, jt('memory.errors.updatePending', 'Could not update pending memory.')), {
          title: jt('memory.titles.reviewFailed', 'Memory Review Failed'), source: TOAST_SOURCE.memory,
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

    function startEditing(memoryId) {
      if (disposed || !getApprovedMemoryById(memoryId)) return;
      setEditingMemoryId(memoryId);
      renderMemorySurfaces();
      focusMemoryControl(`[data-memory-draft-field="lesson_text"][data-memory-id="${memoryId}"]`);
    }

    pageActions = pageActionsUtils.createMemoryPageActions?.({
      state,
      getHubDom,
      constants: { TOAST_SOURCE },
      callbacks: { ...callbacks, showToastMessage, showShellErrorToast, dismissToast, toErrorMessage },
      helpers: {
        getApprovedMemoryById,
        renderMemorySurfaces,
        refreshApprovedMemories,
        refreshMemoryStatus,
        startEditing,
        forgetMemory: handleApprovedMemoryDelete,
        revisionOptions,
      },
    }) || null;
    registerCleanup(() => pageActions?.dispose());

    function handleListClick(event) {
      if (event.target.closest('[data-memory-list-action]')) {
        state.memoryManager.approvedVisibleLimit = (Number(state.memoryManager.approvedVisibleLimit) || MEMORY_RENDER_BATCH_SIZE) + MEMORY_RENDER_BATCH_SIZE;
        renderMemorySurfaces();
        return;
      }
      const actionButton = event.target.closest('[data-memory-action]');
      if (actionButton) {
        const memoryId = Number(actionButton.dataset.memoryId);
        const action = String(actionButton.dataset.memoryAction || '');
        if (!Number.isInteger(memoryId) || memoryId <= 0) return;
        if (action === 'cancel') {
          clearApprovedMemoryDraft(memoryId);
          setEditingMemoryId(null);
          renderMemorySurfaces();
          focusMemoryControl(`[data-memory-page-action="menu"][data-memory-id="${memoryId}"]`);
        } else if (action === 'save') handleApprovedMemorySave(memoryId);
        return;
      }
      const pendingButton = event.target.closest('[data-pending-memory-action]');
      if (!pendingButton) return;
      const data = pendingButton.dataset;
      handlePendingReview(String(data.pendingMemoryAction || ''), String(data.sessionId || ''), String(data.fingerprint || ''), String(data.projectId || ''));
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
            saveButton.disabled = !memory || !hasApprovedMemoryDraftChanges(memory) || !String(draftField.value || '').trim();
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
        if (event.target.id !== 'memoryManagerKindFilter') return;
        state.memoryManager.filter = normalizeApprovedMemoryKindFilter(event.target.value);
        state.memoryManager.approvedVisibleLimit = MEMORY_RENDER_BATCH_SIZE;
        renderMemorySurfaces();
      }
      function handleClick(event) {
        if (pageActions?.handleClick(event)) return;
        handleListClick(event);
      }
      function handleKeydown(event) {
        pageActions?.handleKeydown(event);
      }
      memorySection.addEventListener('input', handleInput);
      memorySection.addEventListener('change', handleChange);
      memorySection.addEventListener('click', handleClick);
      memorySection.addEventListener('keydown', handleKeydown);
      const fieldListeners = [];
      if (policyRegistry) {
        fieldBinding.bindSettingFields({
          container: memorySection,
          descriptors: policyDescriptors,
          registry: policyRegistry,
          registerListener: (target, type, handler) => {
            target.addEventListener(type, handler);
            fieldListeners.push([type, handler]);
          },
          onError: (_descriptor, _error, shown) => {
            if (disposed || shown?.inline) return;
            showShellErrorToast(jt('memory.toasts.policyNotSaved', 'Could not save the memory setting.'), {
              source: TOAST_SOURCE.memory,
              dedupeKey: `${TOAST_SOURCE.memory}:policy:error`,
            });
          },
        });
      }
      registerCleanup(function disposeMemoryPageBindings() {
        memorySection.__jennyMemoryPageBound = false;
        memorySection.removeEventListener('input', handleInput);
        memorySection.removeEventListener('change', handleChange);
        memorySection.removeEventListener('click', handleClick);
        memorySection.removeEventListener('keydown', handleKeydown);
        fieldListeners.forEach(([type, handler]) => memorySection.removeEventListener(type, handler));
      });
    }

    return {
      bindMemoryPageEvents,
      pageBusy: () => ({
        archived: new Set((state.memoryManager.archivedByScope.get(state.memoryManager.scopeTab) || [])
          .map((row) => row.id).filter((id) => pageActions?.isArchivedBusy(id))),
        operations: pageActions?.busyOperationIds() || new Set(),
      }),
      openMemoryHub,
      handleApprovedMemorySave,
      handleApprovedMemoryDelete,
    };
  }

  return {
    createMemoryActionController,
  };
});
