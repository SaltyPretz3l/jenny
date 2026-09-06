/* renderer/features/renderer-companion-action-utils.js - Companion Home actions/forms (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCompanionActionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRefDefault = typeof globalThis !== 'undefined' ? globalThis : {};
  const documentRefDefault = windowRefDefault.document || null;
  const DEFAULT_DEFER_PRESETS = Object.freeze([
    { preset: 'later_today', label: 'Later today', deferredUntil: '' },
    { preset: 'tomorrow', label: 'Tomorrow', deferredUntil: '' },
    { preset: 'next_week', label: 'Next week', deferredUntil: '' },
  ]);

  function noop() {}
  function noopObj() { return {}; }
  function noopString(value) { return String(value || ''); }
  function noopAsync() { return Promise.resolve(); }

  function getFocusActions(companionState) {
    return [
      companionState?.homeFocus?.primaryAction,
      ...(Array.isArray(companionState?.homeFocus?.secondaryActions)
        ? companionState.homeFocus.secondaryActions
        : []),
    ].filter(Boolean);
  }

  function getTodayCardActions(companionState) {
    return Array.isArray(companionState?.todayCards)
      ? companionState.todayCards.flatMap((card) =>
          Array.isArray(card?.items)
            ? card.items.map((item) => item?.action).filter(Boolean)
            : []
        )
      : [];
  }

  function getReminderActions(companionState) {
    return Array.isArray(companionState?.reminders)
      ? companionState.reminders.map((reminder) => reminder?.action).filter(Boolean)
      : [];
  }

  function getLoopActions(section) {
    return Array.isArray(section)
      ? section.flatMap((loop) => Array.isArray(loop.actions) ? loop.actions : [])
      : [];
  }

  function uniqueActions(actions) {
    const seenActionIds = new Set();
    const actionList = [];
    for (const action of Array.isArray(actions) ? actions : []) {
      const actionId = String(action?.id || '').trim();
      if (!actionId || seenActionIds.has(actionId)) {
        continue;
      }
      seenActionIds.add(actionId);
      actionList.push(action);
    }
    return actionList;
  }

  function getResolvableActions(companionState) {
    return uniqueActions([
      ...getFocusActions(companionState),
      ...(Array.isArray(companionState?.suggestedActions) ? companionState.suggestedActions : []),
      ...getTodayCardActions(companionState),
      ...getReminderActions(companionState),
      ...getLoopActions(companionState?.openLoopsBoard?.active),
      ...getLoopActions(companionState?.openLoopsBoard?.deferred),
      ...getLoopActions(companionState?.openLoopsBoard?.recentResolved),
      ...getLoopActions(companionState?.openLoopsBoard?.archived),
    ]);
  }

  function getAvailableDeferPresets(companionState) {
    const presets = Array.isArray(companionState?.availableDeferPresets)
      ? companionState.availableDeferPresets
      : [];
    return presets.length ? presets : DEFAULT_DEFER_PRESETS.slice();
  }

  function formatCompanionOriginLabel(action) {
    const rawLabel = String(action?.label || action?.section || 'Home').trim();
    if (!rawLabel) {
      return 'Home';
    }
    if (/^start fresh session$/i.test(rawLabel)) {
      return 'Home / New session';
    }
    if (/^resume current session$/i.test(rawLabel)) {
      return 'Home / Resume';
    }
    return `Home / ${rawLabel}`;
  }

  function createCompanionActionUtils(deps = {}) {
    const {
      state = {},
      windowRef = windowRefDefault,
      documentRef = documentRefDefault,
      dom = {},
      callbacks = {},
    } = deps || {};
    const {
      homeOpenLoopAddButton = null,
      homeOpenLoopForm = null,
      homeOpenLoopFormHeading = null,
      homeOpenLoopFormNote = null,
      homeOpenLoopTitleInput = null,
      homeOpenLoopNotesInput = null,
      homeOpenLoopDeferSelect = null,
      homeOpenLoopSaveButton = null,
      homeOpenLoopCancelButton = null,
      homeOpenLoopList = null,
      chatInput = null,
    } = dom;
    const {
      getCompanionState = noopObj,
      applyCompanionPayload = noopObj,
      renderHomePanel = noop,
      renderAll = noop,
      renderComposerState = noop,
      syncComposerInputHeight = noop,
      setActiveView = noop,
      openSettingsSection = noop,
      activateWorkspaceSession = noopAsync,
      handleCreateSession = noopAsync,
      setSessionOrigin = noop,
      setPendingOrigin = noop,
      clearPendingOrigin = noop,
      showSetupHelp = noop,
      showToastMessage = noop,
      showShellErrorToast = noop,
      toErrorMessage = noopString,
      toggleArchivedSection = noop,
    } = callbacks;

    let addFormOpen = false;
    let formState = {
      mode: 'add',
      followUpId: '',
      loopStatus: 'active',
      title: '',
      body: '',
      timing: '',
    };

    function findLoopByFollowUpId(followUpId) {
      const normalizedFollowUpId = String(followUpId || '').trim();
      if (!normalizedFollowUpId) {
        return null;
      }
      const companionState = getCompanionState();
      const sections = [
        companionState.openLoopsBoard?.active,
        companionState.openLoopsBoard?.deferred,
        companionState.openLoopsBoard?.recentResolved,
        companionState.openLoopsBoard?.archived,
      ];
      for (const section of sections) {
        const loop = Array.isArray(section)
          ? section.find((entry) => String(entry?.followUpId || '').trim() === normalizedFollowUpId)
          : null;
        if (loop) {
          return loop;
        }
      }
      return null;
    }

    function renderManualAddForm(companionState) {
      if (!homeOpenLoopForm) {
        return;
      }
      homeOpenLoopForm.hidden = !addFormOpen;
      homeOpenLoopForm.setAttribute('aria-hidden', addFormOpen ? 'false' : 'true');
      if (homeOpenLoopAddButton) {
        homeOpenLoopAddButton.hidden = addFormOpen;
      }
      const isEditing = formState.mode === 'edit';
      const isResolvedOnly = formState.loopStatus === 'resolved' || formState.loopStatus === 'archived';
      if (homeOpenLoopFormHeading) {
        homeOpenLoopFormHeading.textContent = isEditing ? 'Edit Open Loop' : 'Add Open Loop';
      }
      if (homeOpenLoopFormNote) {
        homeOpenLoopFormNote.textContent = isEditing
          ? isResolvedOnly
            ? 'Edit the title or notes. Archived and completed loops keep their current status.'
            : 'Adjust details or timing without leaving Home.'
          : 'Create an active loop now or defer it to a later preset.';
      }
      if (!homeOpenLoopDeferSelect) {
        return;
      }
      const previousValue = String(formState.timing || homeOpenLoopDeferSelect.value || '').trim();
      const presets = getAvailableDeferPresets(companionState);
      homeOpenLoopDeferSelect.textContent = '';
      const nowOption = documentRef.createElement('option');
      nowOption.value = '';
      nowOption.textContent = 'Active now';
      homeOpenLoopDeferSelect.append(nowOption);
      presets.forEach((preset) => {
        const option = documentRef.createElement('option');
        option.value = preset.preset;
        option.textContent = preset.label;
        homeOpenLoopDeferSelect.append(option);
      });
      if ([...homeOpenLoopDeferSelect.options].some((option) => option.value === previousValue)) {
        homeOpenLoopDeferSelect.value = previousValue;
      } else {
        homeOpenLoopDeferSelect.value = '';
      }
      homeOpenLoopDeferSelect.disabled = isResolvedOnly;
      if (homeOpenLoopTitleInput) {
        homeOpenLoopTitleInput.value = String(formState.title || '');
      }
      if (homeOpenLoopNotesInput) {
        homeOpenLoopNotesInput.value = String(formState.body || '');
      }
      if (homeOpenLoopSaveButton) {
        homeOpenLoopSaveButton.disabled = !companionState.loaded;
        homeOpenLoopSaveButton.textContent = isEditing ? 'Save Changes' : 'Save Open Loop';
      }
      if (homeOpenLoopCancelButton) {
        homeOpenLoopCancelButton.textContent = isEditing ? 'Cancel Edit' : 'Cancel';
      }
    }

    function resolveAction(actionId) {
      const companionState = getCompanionState();
      const normalizedActionId = String(actionId || '').trim();
      return getResolvableActions(companionState)
        .find((action) => String(action?.id || '').trim() === normalizedActionId) || null;
    }

    async function runFollowUpMutation(promiseFactory, successMessage, dedupeKey) {
      const payload = await promiseFactory();
      applyCompanionPayload(payload);
      if (successMessage) {
        showToastMessage(successMessage, {
          title: 'Open Loops',
          tone: 'success',
          source: 'shell.companion',
          dedupeKey,
        });
      }
      renderAll();
      return payload;
    }

    function prefersReducedMotion() {
      try {
        return Boolean(
          windowRef.matchMedia
          && windowRef.matchMedia('(prefers-reduced-motion: reduce)').matches
        );
      } catch (_error) {
        return false;
      }
    }

    const LOOP_UNDO_WINDOW_MS = 6000;

    let cachedEmphasisFallbackMs = null;
    function getAnimationFallbackMs() {
      if (cachedEmphasisFallbackMs !== null) {
        return cachedEmphasisFallbackMs;
      }
      let durationMs = 360;
      try {
        if (documentRef && windowRef.getComputedStyle) {
          const raw = String(
            windowRef.getComputedStyle(documentRef.documentElement)
              .getPropertyValue('--motion-duration-emphasis') || ''
          ).trim();
          const parsed = parseFloat(raw);
          if (Number.isFinite(parsed) && parsed > 0) {
            durationMs = parsed;
          }
        }
      } catch (_error) {
        // fall through to default
      }
      cachedEmphasisFallbackMs = durationMs + 120;
      return cachedEmphasisFallbackMs;
    }

    function findLoopCardNode(followUpId) {
      if (!followUpId || !homeOpenLoopList || typeof homeOpenLoopList.querySelector !== 'function') {
        return null;
      }
      const selector = `.memory-commitment-item[data-follow-up-id="${String(followUpId).replace(/"/g, '\\"')}"]`;
      return homeOpenLoopList.querySelector(selector);
    }

    function animateLoopResolve(node) {
      return new Promise((resolve) => {
        if (!node || prefersReducedMotion()) {
          resolve();
          return;
        }
        try {
          node.dataset.loopResolving = 'true';
        } catch (_error) {
          resolve();
          return;
        }
        const hasAnimation = (() => {
          try {
            if (!windowRef.getComputedStyle) return false;
            const name = String(windowRef.getComputedStyle(node).animationName || '').trim();
            return Boolean(name) && name !== 'none';
          } catch (_error) {
            return false;
          }
        })();
        if (!hasAnimation) {
          resolve();
          return;
        }
        let done = false;
        let fallbackTimer = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (fallbackTimer !== null) {
            clearTimeout(fallbackTimer);
          }
          resolve();
        };
        if (typeof node.addEventListener === 'function') {
          node.addEventListener('animationend', finish, { once: true });
        }
        fallbackTimer = setTimeout(finish, getAnimationFallbackMs());
      });
    }

    async function runFollowUpMutationWithUndo({
      followUpId,
      mutate,
      toastMessage,
      dedupeKey,
    }) {
      if (!followUpId || typeof mutate !== 'function') {
        return null;
      }
      const resolvingNode = findLoopCardNode(followUpId);
      await animateLoopResolve(resolvingNode);
      let payload;
      try {
        payload = await mutate();
      } catch (error) {
        resolvingNode?.removeAttribute?.('data-loop-resolving');
        throw error;
      }
      applyCompanionPayload(payload);
      if (toastMessage) {
        showToastMessage(toastMessage, {
          title: 'Open Loops',
          tone: 'info',
          source: 'shell.companion',
          dedupeKey,
          durationMs: LOOP_UNDO_WINDOW_MS,
          actions: [
            {
              id: 'undo',
              label: 'Undo',
              kind: 'primary',
              onClick: async () => {
                try {
                  const restored = await windowRef.jennyShell.companion.activateFollowUp(followUpId);
                  applyCompanionPayload(restored);
                  renderAll();
                } catch (error) {
                  showShellErrorToast(
                    toErrorMessage(error, 'Could not restore that open loop.'),
                    {
                      title: 'Undo Failed',
                      source: 'shell.companion',
                      dedupeKey: `shell.companion:undo:${followUpId}`,
                    }
                  );
                }
              },
            },
          ],
        });
      }
      renderAll();
      return payload;
    }

    async function showDeferPresetPicker(action) {
      const companionState = getCompanionState();
      const presets = getAvailableDeferPresets(companionState);
      if (!presets.length) {
        showToastMessage('No defer presets are available right now.', {
          title: 'Open Loops',
          tone: 'warning',
          source: 'shell.companion',
          dedupeKey: 'shell.companion:defer:none',
        });
        return;
      }
      showToastMessage('Choose when this should resurface.', {
        title: 'Defer Open Loop',
        tone: 'info',
        sticky: true,
        source: 'shell.companion',
        dedupeKey: `shell.companion:defer:${action.followUpId}`,
        actions: presets.map((preset, index) => ({
          id: `defer:${action.followUpId}:${preset.preset}`,
          label: preset.label,
          kind: index === 0 ? 'primary' : 'secondary',
          onClick: async () => {
            try {
              await runFollowUpMutation(
                () => windowRef.jennyShell.companion.deferFollowUp(action.followUpId, preset.preset),
                `Deferred until ${preset.label.toLowerCase()}.`,
                `shell.companion:defer:saved:${action.followUpId}:${preset.preset}`
              );
            } catch (error) {
              showShellErrorToast(toErrorMessage(error, 'Could not defer that open loop.'), {
                title: 'Open Loop Failed',
                dedupeKey: `shell.companion:defer:error:${action.followUpId}:${preset.preset}`,
                source: 'shell.companion',
              });
            }
          },
        })),
      });
    }

    async function promoteReminderToOpenLoop(action) {
      const companionState = getCompanionState();
      const reminderId = String(action?.reminderId || '').trim();
      const reminder = (Array.isArray(companionState.reminders) ? companionState.reminders : [])
        .find((entry) => String(entry?.id || '').trim() === reminderId);
      if (!reminder) {
        showShellErrorToast('That reminder is no longer available.', {
          title: 'Open Loop Failed',
          dedupeKey: `shell.companion:promote-reminder:missing:${reminderId || 'unknown'}`,
          source: 'shell.companion',
        });
        return null;
      }
      return runFollowUpMutation(
        () => windowRef.jennyShell.companion.addFollowUp({
          id: `reminder:${reminder.id}`,
          label: reminder.label || 'Reminder',
          body: reminder.prompt || '',
          status: 'active',
          sourceKind: 'reminder',
          sourceId: reminder.id,
          sourceMeta: {
            reminderId: reminder.id,
          },
        }),
        'Promoted reminder to an open loop.',
        `shell.companion:promote-reminder:${reminder.id}`
      );
    }

    async function handleCompanionAction(action) {
      if (!action) {
        return;
      }
      if (action.type === 'prefill_chat') {
        if (typeof setPendingOrigin === 'function') {
          setPendingOrigin(formatCompanionOriginLabel(action));
        }
        chatInput.value = action.prompt || '';
        syncComposerInputHeight();
        setActiveView('chat');
        renderComposerState();
        chatInput.focus();
        renderAll();
        return;
      }
      if (action.type === 'open_settings') {
        if (typeof clearPendingOrigin === 'function') {
          clearPendingOrigin();
        }
        openSettingsSection(action.section || 'models');
        return;
      }
      if (action.type === 'open_setup_help') {
        if (typeof clearPendingOrigin === 'function') {
          clearPendingOrigin();
        }
        showSetupHelp();
        return;
      }
      if (action.type === 'open_view' && action.viewId) {
        if (typeof clearPendingOrigin === 'function') {
          clearPendingOrigin();
        }
        setActiveView(action.viewId);
        renderAll();
        return;
      }
      if (action.type === 'continue_session' && action.sessionId) {
        if (typeof clearPendingOrigin === 'function') {
          clearPendingOrigin();
        }
        await activateWorkspaceSession(action.sessionId);
        setActiveView('chat');
        renderAll();
        return;
      }
      if (action.type === 'new_session') {
        if (typeof clearPendingOrigin === 'function') {
          clearPendingOrigin();
        }
        const createdSessionId = String(await handleCreateSession() || '').trim();
        if (createdSessionId && typeof setSessionOrigin === 'function') {
          setSessionOrigin(createdSessionId, formatCompanionOriginLabel(action));
        }
        if (createdSessionId) {
          setActiveView('chat');
        }
        renderAll();
        return;
      }
      if (action.type === 'resolve_follow_up' && action.followUpId) {
        await runFollowUpMutationWithUndo({
          followUpId: action.followUpId,
          mutate: () => windowRef.jennyShell.companion.resolveFollowUp(action.followUpId),
          toastMessage: 'Loop closed.',
          dedupeKey: `shell.companion:resolve:${action.followUpId}`,
        });
        return;
      }
      if (action.type === 'archive_follow_up' && action.followUpId) {
        await runFollowUpMutation(
          () => windowRef.jennyShell.companion.archiveFollowUp(action.followUpId),
          'Archived open loop.',
          `shell.companion:archive:${action.followUpId}`
        );
        return;
      }
      if (action.type === 'delete_follow_up' && action.followUpId) {
        await runFollowUpMutation(
          () => windowRef.jennyShell.companion.deleteFollowUp(action.followUpId),
          'Loop deleted.',
          `shell.companion:delete:${action.followUpId}`
        );
        return;
      }
      if (action.type === 'unarchive_follow_up' && action.followUpId) {
        await runFollowUpMutation(
          () => windowRef.jennyShell.companion.unarchiveFollowUp(action.followUpId),
          'Restored open loop.',
          `shell.companion:unarchive:${action.followUpId}`
        );
        return;
      }
      if (action.type === 'activate_follow_up' && action.followUpId) {
        await runFollowUpMutation(
          () => windowRef.jennyShell.companion.activateFollowUp(action.followUpId),
          /^reopen$/i.test(String(action.label || '').trim())
            ? 'Reopened open loop.'
            : 'Moved open loop back to active.',
          `shell.companion:activate:${action.followUpId}`
        );
        return;
      }
      if (action.type === 'defer_follow_up' && action.followUpId) {
        await showDeferPresetPicker(action);
        return;
      }
      if (action.type === 'promote_reminder' && action.reminderId) {
        await promoteReminderToOpenLoop(action);
        return;
      }
      if (action.type === 'edit_follow_up' && action.followUpId) {
        const loop = findLoopByFollowUpId(action.followUpId);
        if (loop) {
          openManualAddForm(loop);
        }
      }
    }

    function resetManualAddForm() {
      formState = {
        mode: 'add',
        followUpId: '',
        loopStatus: 'active',
        title: '',
        body: '',
        timing: '',
      };
      if (homeOpenLoopTitleInput) {
        homeOpenLoopTitleInput.value = '';
      }
      if (homeOpenLoopNotesInput) {
        homeOpenLoopNotesInput.value = '';
      }
      if (homeOpenLoopDeferSelect) {
        homeOpenLoopDeferSelect.value = '';
      }
    }

    function openManualAddForm(loop = null) {
      const resolvedLoop = loop && typeof loop === 'object' ? loop : null;
      formState = {
        mode: resolvedLoop ? 'edit' : 'add',
        followUpId: String(resolvedLoop?.followUpId || '').trim(),
        loopStatus: String(resolvedLoop?.status || 'active').trim() || 'active',
        title: String(resolvedLoop?.title || '').trim(),
        body: String(resolvedLoop?.body || '').trim(),
        timing: resolvedLoop?.status === 'deferred'
          ? String(resolvedLoop?.deferPreset || '').trim()
          : '',
      };
      addFormOpen = true;
      renderHomePanel();
      homeOpenLoopTitleInput?.focus();
    }

    function closeManualAddForm() {
      addFormOpen = false;
      resetManualAddForm();
      renderHomePanel();
    }

    async function handleManualAddSubmit() {
      const title = String(homeOpenLoopTitleInput?.value || '').trim();
      const body = String(homeOpenLoopNotesInput?.value || '').trim();
      const deferPreset = String(homeOpenLoopDeferSelect?.value || '').trim();
      const editingFollowUpId = String(formState.followUpId || '').trim();
      if (!title) {
        showToastMessage('Add a title before saving this open loop.', {
          title: 'Open Loops',
          tone: 'warning',
          source: 'shell.companion',
          dedupeKey: 'shell.companion:add:title-required',
        });
        homeOpenLoopTitleInput?.focus();
        return;
      }
      const isEditing = formState.mode === 'edit' && formState.followUpId;
      const isResolvedOnly = formState.loopStatus === 'resolved' || formState.loopStatus === 'archived';
      const payload = isEditing
        ? await windowRef.jennyShell.companion.updateFollowUp(editingFollowUpId, {
            label: title,
            body,
            ...(isResolvedOnly
              ? {}
              : {
                  status: deferPreset ? 'deferred' : 'active',
                  deferPreset,
                }),
          })
        : await windowRef.jennyShell.companion.addFollowUp({
            label: title,
            body,
            sessionId: String(state.currentSessionId || state.activeSessionId || '').trim(),
            status: deferPreset ? 'deferred' : 'active',
            deferPreset,
            sourceKind: 'manual',
          });
      applyCompanionPayload(payload);
      closeManualAddForm();
      showToastMessage(
        isEditing
          ? 'Saved open loop changes.'
          : deferPreset
            ? 'Saved to deferred open loops.'
            : 'Saved to open loops.',
        {
          title: 'Open Loops',
          tone: 'success',
          source: 'shell.companion',
          dedupeKey: isEditing
            ? `shell.companion:edit:${editingFollowUpId}`
            : `shell.companion:add:${deferPreset || 'active'}`,
        }
      );
      renderAll();
    }

    async function handleHomeClick(event) {
      const addButton = event.target.closest('[data-home-open-loop-add]');
      if (addButton) {
        event.preventDefault();
        openManualAddForm();
        return;
      }

      const cancelButton = event.target.closest('[data-home-open-loop-cancel]');
      if (cancelButton) {
        event.preventDefault();
        closeManualAddForm();
        return;
      }

      const archivedToggleButton = event.target.closest('[data-home-archived-toggle]');
      if (archivedToggleButton) {
        event.preventDefault();
        toggleArchivedSection();
        return;
      }

      const saveButton = event.target.closest('[data-home-open-loop-save]');
      if (saveButton) {
        event.preventDefault();
        try {
          await handleManualAddSubmit();
        } catch (error) {
          showShellErrorToast(toErrorMessage(error, 'Could not save that open loop.'), {
            title: 'Open Loop Failed',
            dedupeKey: 'shell.companion:add:error',
            source: 'shell.companion',
          });
        }
        return;
      }

      const actionButton = event.target.closest('[data-companion-action-id]');
      if (!actionButton) {
        return;
      }
      event.preventDefault();
      const action = resolveAction(actionButton.dataset.companionActionId);
      try {
        await handleCompanionAction(action);
      } catch (error) {
        showShellErrorToast(toErrorMessage(error, 'Could not complete that companion action.'), {
          title: 'Companion Action Failed',
          dedupeKey: 'shell.companion:action:error',
          source: 'shell.companion',
        });
      }
    }

    async function handleHomeSubmit(event) {
      const form = event.target.closest('#homeOpenLoopForm');
      if (!form) {
        return;
      }
      event.preventDefault();
      try {
        await handleManualAddSubmit();
      } catch (error) {
        showShellErrorToast(toErrorMessage(error, 'Could not save that open loop.'), {
          title: 'Open Loop Failed',
          dedupeKey: 'shell.companion:add:error',
          source: 'shell.companion',
        });
      }
    }

    return {
      formatCompanionOriginLabel,
      getAvailableDeferPresets,
      getResolvableActions,
      renderManualAddForm,
      handleHomeClick,
      handleHomeSubmit,
    };
  }

  return {
    createCompanionActionUtils,
  };
});
