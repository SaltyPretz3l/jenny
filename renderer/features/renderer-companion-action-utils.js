/* renderer/features/renderer-companion-action-utils.js - Companion Home actions/forms (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCompanionActionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const windowRefDefault = typeof globalThis !== 'undefined' ? globalThis : {};
  const documentRefDefault = windowRefDefault.document || null;
  const openLoopRow = windowRefDefault.rendererOpenLoopRow
    || (typeof require === 'function' ? require('./renderer-open-loop-row') : null);
  const openLoopForm = windowRefDefault.rendererOpenLoopForm
    || (typeof require === 'function' ? require('./renderer-open-loop-form') : null);
  const companionStateUtils = windowRefDefault.rendererCompanionStateUtils
    || (typeof require === 'function' ? require('./renderer-companion-state-utils') : null);
  const taskBriefUtils = windowRefDefault.rendererTaskBriefUtils
    || (typeof require === 'function' ? require('../shared/task-brief-utils') : null);
  if (!openLoopRow || !openLoopForm || !companionStateUtils || !taskBriefUtils) {
    throw new Error('rendererCompanionActionUtils: open-loop row/form, companion state utils and task-brief utils must load first');
  }
  const { getAllLoops } = companionStateUtils;
  const { deferPresetLabel, getAvailableDeferPresets } = openLoopForm;
  const actionLabel = openLoopRow.openLoopActionLabel;

  const LOOP_UNDO_WINDOW_MS = 6000;
  /* The main process refuses a mutation on a loop that no longer exists
   * (0002) or whose state no longer allows it (0003); IPC keeps only the
   * message text, which starts with the code. */
  const STALE_LOOP_CODES = Object.freeze(['CMP-COMPANION-0002', 'CMP-COMPANION-0003']);
  const CODED_ERROR_PATTERN = /\b(CMP-[A-Z]+-\d{4}):\s*/;

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
      ...getAllLoops(companionState?.openLoopsBoard).flatMap((loop) => (Array.isArray(loop?.actions) ? loop.actions : [])),
    ]);
  }

  function isStaleLoopError(error) {
    const match = CODED_ERROR_PATTERN.exec(String(error?.message || error || ''));
    return Boolean(match) && STALE_LOOP_CODES.includes(match[1]);
  }

  function formatCompanionOriginLabel(action) {
    const rawLabel = String(action?.label || action?.section || 'Home').trim();
    if (!rawLabel) {
      return 'Home';
    }
    if (/^start fresh session$/i.test(rawLabel)) {
      return jt('companion.origin.newSession', 'Home / New session');
    }
    if (/^resume current session$/i.test(rawLabel)) {
      return 'Home / Resume';
    }
    return jt('companion.origin.custom', 'Home / {label}', { label: rawLabel });
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
      homeView = null,
      chatInput = null,
    } = dom;
    const {
      getCompanionState = noopObj,
      applyCompanionPayload = noopObj,
      refreshCompanionState = noopAsync,
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
      dismissToast = noop,
      toErrorMessage = noopString,
      toggleArchivedSection = noop,
      toggleResolvedSection = noop,
      toggleLoopHistory = noop,
      toggleLoopBody = noop,
      forgetLoop = noop,
    } = callbacks;

    let taskSessionStarting = false;
    let disposed = false;
    /* The loop whose overflow menu is open; a re-render swaps its trigger. */
    let openOverflowFollowUpId = '';
    /* followUpId -> { timer, toastId, committing }. Deletes wait out the undo
     * window before the IPC call; rows in this map are hidden from every render. */
    const pendingDeletes = new Map();

    const form = openLoopForm.createOpenLoopFormController({
      state,
      windowRef,
      documentRef,
      dom: {
        homeOpenLoopAddButton,
        homeOpenLoopForm,
        homeOpenLoopFormHeading,
        homeOpenLoopFormNote,
        homeOpenLoopTitleInput,
        homeOpenLoopNotesInput,
        homeOpenLoopDeferSelect,
        homeOpenLoopSaveButton,
        homeOpenLoopCancelButton,
      },
      getCompanionState,
      applyCompanionPayload,
      renderHomePanel,
      renderAll,
      loopToast,
      findOverflowTrigger,
    });

    function loopToast(message, { tone = 'success', dedupeKey, ...extra } = {}) {
      return showToastMessage(message, {
        title: jt('companion.openLoops.title', 'Open Loops'),
        tone,
        source: 'shell.companion',
        dedupeKey,
        ...extra,
      });
    }

    /* A coded backend error shows its localized sentence, never the raw
     * "Error invoking remote method … CMP-…" text. */
    function describeError(error, fallback) {
      const raw = String(error?.message || error || '');
      const match = CODED_ERROR_PATTERN.exec(raw);
      if (!match) {
        return toErrorMessage(error, fallback);
      }
      const backendText = raw.slice(match.index + match[0].length).trim() || String(fallback || '');
      const translate = windowRef.jennyBackendStrings?.errorText;
      return (typeof translate === 'function' && translate(match[1], backendText)) || backendText;
    }

    function loopErrorToast(error, fallback, dedupeKey) {
      showShellErrorToast(describeError(error, fallback), {
        title: jt('companion.titles.openLoopFailed', 'Open Loop Failed'),
        dedupeKey,
        source: 'shell.companion',
      });
    }

    function findLoopByFollowUpId(followUpId) {
      const normalizedFollowUpId = String(followUpId || '').trim();
      if (!normalizedFollowUpId) {
        return null;
      }
      return getAllLoops(getCompanionState().openLoopsBoard)
        .find((entry) => String(entry?.followUpId || '').trim() === normalizedFollowUpId) || null;
    }

    function isLoopPendingDelete(followUpId) {
      return pendingDeletes.has(String(followUpId || ''));
    }

    /* Other surfaces (the task rail) read the pending ids from shared UI
     * state so a row being deleted disappears everywhere at once. */
    function publishPendingDeletes() {
      if (state.ui && typeof state.ui === 'object') {
        state.ui.pendingLoopDeleteIds = [...pendingDeletes.keys()];
      }
    }

    function resolveAction(actionId) {
      const companionState = getCompanionState();
      const normalizedActionId = String(actionId || '').trim();
      return getResolvableActions(companionState)
        .find((action) => String(action?.id || '').trim() === normalizedActionId) || null;
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
      const host = homeView || homeOpenLoopList;
      if (!followUpId || !host || typeof host.querySelector !== 'function') {
        return null;
      }
      return host.querySelector(openLoopRow.loopRowSelector(followUpId));
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

    /* One mutation path: optional fade-out first, then the IPC call, the
     * state swap, the toast (with Undo when undoFollowUpId is set) and a
     * render. */
    async function runFollowUpMutation(promiseFactory, successMessage, dedupeKey, { undoFollowUpId = '' } = {}) {
      const fadingNode = undoFollowUpId ? findLoopCardNode(undoFollowUpId) : null;
      if (fadingNode) {
        await animateLoopResolve(fadingNode);
      }
      let payload;
      try {
        payload = await promiseFactory();
      } catch (error) {
        fadingNode?.removeAttribute?.('data-loop-resolving');
        throw error;
      }
      applyCompanionPayload(payload);
      if (successMessage) {
        loopToast(successMessage, undoFollowUpId
          ? {
              tone: 'info',
              dedupeKey,
              durationMs: LOOP_UNDO_WINDOW_MS,
              actions: [{
                id: 'undo',
                label: jt('companion.actions.undo', 'Undo'),
                kind: 'primary',
                onClick: async () => {
                  try {
                    const restored = await windowRef.jennyShell.companion.activateFollowUp(undoFollowUpId);
                    applyCompanionPayload(restored);
                    renderAll();
                  } catch (error) {
                    showShellErrorToast(
                      describeError(error, jt('companion.errors.restoreOpenLoop', 'Could not restore that open loop.')),
                      {
                        title: jt('companion.titles.undoFailed', 'Undo Failed'),
                        source: 'shell.companion',
                        dedupeKey: `shell.companion:undo:${undoFollowUpId}`,
                      }
                    );
                  }
                },
              }],
            }
          : { dedupeKey });
      }
      renderAll();
      return payload;
    }

    async function commitLoopDelete(followUpId) {
      const pending = pendingDeletes.get(followUpId);
      if (!pending || pending.committing) {
        return;
      }
      pending.committing = true;
      // The toast pauses while hovered, but this clock does not: once the
      // delete is committed, Undo must not stay on screen.
      if (pending.toastId) {
        dismissToast(pending.toastId);
      }
      try {
        const payload = await windowRef.jennyShell.companion.deleteFollowUp(followUpId);
        pendingDeletes.delete(followUpId);
        publishPendingDeletes();
        if (disposed) {
          return;
        }
        applyCompanionPayload(payload);
        forgetLoop(followUpId);
      } catch (error) {
        pendingDeletes.delete(followUpId);
        publishPendingDeletes();
        if (disposed) {
          return;
        }
        loopErrorToast(error, jt('companion.errors.deleteOpenLoop', 'Could not delete that open loop.'), `shell.companion:delete:error:${followUpId}`);
      }
      renderAll();
    }

    /* Delete is permanent on the main side, so the renderer holds it for the
     * undo window: the row hides now, the IPC call runs when the window
     * closes, and Undo simply cancels the timer. */
    async function scheduleLoopDelete(followUpId) {
      if (!followUpId || pendingDeletes.has(followUpId)) {
        return;
      }
      await animateLoopResolve(findLoopCardNode(followUpId));
      if (disposed || pendingDeletes.has(followUpId)) {
        return;
      }
      const pending = {
        timer: setTimeout(() => { void commitLoopDelete(followUpId); }, LOOP_UNDO_WINDOW_MS),
        toastId: '',
        committing: false,
      };
      pendingDeletes.set(followUpId, pending);
      publishPendingDeletes();
      /* An edit of the loop being deleted would be lost at commit. */
      form.closeIfEditing(followUpId);
      pending.toastId = loopToast(jt('companion.toasts.loopDeleted', 'Loop deleted.'), {
        tone: 'info',
        dedupeKey: `shell.companion:delete:${followUpId}`,
        durationMs: LOOP_UNDO_WINDOW_MS,
        actions: [{
          id: 'undo',
          label: jt('companion.actions.undo', 'Undo'),
          kind: 'primary',
          onClick: () => {
            const pending = pendingDeletes.get(followUpId);
            if (!pending || pending.committing) {
              return;
            }
            clearTimeout(pending.timer);
            pendingDeletes.delete(followUpId);
            publishPendingDeletes();
            dismissToast(pending.toastId);
            renderAll();
          },
        }],
      });
      renderAll();
    }

    function findLoopDeferredUntil(followUpId) {
      const parsed = new Date(findLoopByFollowUpId(followUpId)?.deferredUntil || '');
      return Number.isNaN(parsed.valueOf()) ? null : parsed;
    }

    async function showDeferPresetPicker(action) {
      const companionState = getCompanionState();
      const presets = getAvailableDeferPresets(companionState);
      if (!presets.length) {
        loopToast(jt('companion.toasts.noDeferPresets', 'No defer presets are available right now.'), {
          tone: 'warning',
          dedupeKey: 'shell.companion:defer:none',
        });
        return;
      }
      /* Sticky, and toast actions do not dismiss it: the picker closes itself
       * once the defer lands or the loop turns out to be stale. */
      let pickerToastId = '';
      pickerToastId = showToastMessage(jt('companion.toasts.chooseResurfaceTime', 'Choose when this should resurface.'), {
        title: jt('companion.titles.deferOpenLoop', 'Defer Open Loop'),
        tone: 'info',
        sticky: true,
        source: 'shell.companion',
        dedupeKey: `shell.companion:defer:${action.followUpId}`,
        actions: presets.map((preset, index) => ({
          id: `defer:${action.followUpId}:${preset.preset}`,
          label: deferPresetLabel(preset),
          kind: index === 0 ? 'primary' : 'secondary',
          onClick: async () => {
            try {
              const payload = await windowRef.jennyShell.companion.deferFollowUp(action.followUpId, preset.preset);
              dismissToast(pickerToastId);
              applyCompanionPayload(payload);
              const until = findLoopDeferredUntil(action.followUpId);
              loopToast(until && openLoopRow
                ? openLoopRow.formatDeferredUntil(until)
                : jt('companion.toasts.deferredOpenLoop', 'Deferred open loop.'), {
                dedupeKey: `shell.companion:defer:saved:${action.followUpId}:${preset.preset}`,
              });
              renderAll();
            } catch (error) {
              if (isStaleLoopError(error)) {
                dismissToast(pickerToastId);
              }
              await handleMutationError(error, jt('companion.errors.deferOpenLoop', 'Could not defer that open loop.'), `shell.companion:defer:error:${action.followUpId}:${preset.preset}`);
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
        showShellErrorToast(jt('companion.toasts.reminderUnavailable', 'That reminder is no longer available.'), {
          title: jt('companion.titles.openLoopFailed', 'Open Loop Failed'),
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
        jt('companion.toasts.promotedReminder', 'Promoted reminder to an open loop.'),
        `shell.companion:promote-reminder:${reminder.id}`
      );
    }

    async function startTaskSession(action) {
      if (taskSessionStarting) {
        return;
      }
      const loop = findLoopByFollowUpId(action.followUpId);
      const start = windowRef.rendererTaskSessionActions?.start;
      if (!loop || typeof start !== 'function') {
        loopErrorToast(null, jt('companion.errors.taskSessionUnavailable', 'Could not start a session for that task.'), `shell.companion:task-session:${action.followUpId}`);
        return;
      }
      taskSessionStarting = true;
      clearPendingOrigin();
      try {
        await start({
          title: loop.title,
          initialPrompt: taskBriefUtils.buildTaskBrief(loop, { linkedTaskId: loop.followUpId }),
          linkedTaskId: loop.followUpId,
        });
      } finally {
        taskSessionStarting = false;
      }
    }

    /* Plain loop mutations: one IPC call and a toast. Activate words its
     * toast from the loop's status, not from the (translatable) label. */
    const LOOP_MUTATIONS = Object.freeze({
      archive_follow_up: {
        method: 'archiveFollowUp',
        dedupe: 'archive',
        message: () => jt('companion.toasts.archivedOpenLoop', 'Archived open loop.'),
      },
      unarchive_follow_up: {
        method: 'unarchiveFollowUp',
        dedupe: 'unarchive',
        message: () => jt('companion.toasts.restoredOpenLoop', 'Restored open loop.'),
      },
      activate_follow_up: {
        method: 'activateFollowUp',
        dedupe: 'activate',
        message: (loop) => (loop?.status === 'resolved'
          ? jt('companion.toasts.reopenedOpenLoop', 'Reopened open loop.')
          : jt('companion.toasts.movedOpenLoopActive', 'Moved open loop back to active.')),
      },
    });

    async function handleCompanionAction(action) {
      if (!action) {
        return;
      }
      if (action.type === 'prefill_chat') {
        setPendingOrigin(formatCompanionOriginLabel(action));
        chatInput.value = action.prompt || '';
        syncComposerInputHeight();
        setActiveView('chat');
        renderComposerState();
        chatInput.focus();
        renderAll();
        return;
      }
      if (action.type === 'open_settings') {
        clearPendingOrigin();
        openSettingsSection(action.section || 'models');
        return;
      }
      if (action.type === 'open_setup_help') {
        clearPendingOrigin();
        showSetupHelp();
        return;
      }
      if (action.type === 'open_view' && action.viewId) {
        clearPendingOrigin();
        setActiveView(action.viewId);
        renderAll();
        return;
      }
      if (action.type === 'continue_session' && action.sessionId) {
        clearPendingOrigin();
        const workspace = await activateWorkspaceSession(action.sessionId);
        /* Activation can refuse (session rail full) and says so in its own
         * toast; only a confirmed switch to this session leaves Home. */
        if (String(workspace?.activeSessionId || '').trim() === action.sessionId) {
          setActiveView('chat');
        }
        renderAll();
        return;
      }
      if (action.type === 'new_session') {
        clearPendingOrigin();
        const createdSessionId = String(await handleCreateSession() || '').trim();
        if (createdSessionId) {
          setSessionOrigin(createdSessionId, formatCompanionOriginLabel(action));
          setActiveView('chat');
        }
        renderAll();
        return;
      }
      if (action.type === 'start_task_session' && action.followUpId) {
        await startTaskSession(action);
        return;
      }
      if (action.type === 'resolve_follow_up' && action.followUpId) {
        await runFollowUpMutation(
          () => windowRef.jennyShell.companion.resolveFollowUp(action.followUpId),
          jt('companion.toasts.loopClosed', 'Loop closed.'),
          `shell.companion:resolve:${action.followUpId}`,
          { undoFollowUpId: action.followUpId }
        );
        return;
      }
      if (action.type === 'delete_follow_up' && action.followUpId) {
        await scheduleLoopDelete(action.followUpId);
        return;
      }
      const mutation = LOOP_MUTATIONS[action.type];
      if (mutation && action.followUpId) {
        const loop = findLoopByFollowUpId(action.followUpId);
        await runFollowUpMutation(
          () => windowRef.jennyShell.companion[mutation.method](action.followUpId),
          mutation.message(loop),
          `shell.companion:${mutation.dedupe}:${action.followUpId}`
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
          form.open(loop);
        }
      }
    }

    /* A loop deleted or changed elsewhere (another window, an agent task) is
     * refused by the main process: resync the board, drop a stale edit form,
     * and say what happened instead of a generic failure. */
    async function handleMutationError(error, fallbackMessage, dedupeKey) {
      if (!isStaleLoopError(error)) {
        loopErrorToast(error, fallbackMessage, dedupeKey);
        return;
      }
      try {
        await refreshCompanionState();
      } catch (_refreshError) {
        // The toast below still explains the failure.
      }
      const editingId = form.editingFollowUpId();
      if (editingId && !findLoopByFollowUpId(editingId)) {
        form.close();
      }
      renderAll();
      showShellErrorToast(describeError(error, fallbackMessage), {
        title: jt('companion.titles.openLoopFailed', 'Open Loop Failed'),
        dedupeKey: 'shell.companion:loop-stale',
        source: 'shell.companion',
      });
    }

    async function runActionWithFeedback(action) {
      try {
        await handleCompanionAction(action);
      } catch (error) {
        if (isStaleLoopError(error)) {
          await handleMutationError(error, '', '');
          return;
        }
        showShellErrorToast(describeError(error, jt('companion.errors.actionFailed', 'Could not complete that companion action.')), {
          title: jt('companion.titles.actionFailed', 'Companion Action Failed'),
          dedupeKey: 'shell.companion:action:error',
          source: 'shell.companion',
        });
      }
    }

    /* Overflow actions live in the shared context menu, which mounts on
     * <body> outside #homeView, so items dispatch through closures rather
     * than the delegated click handler. */
    function openLoopOverflowMenu(trigger) {
      const loop = findLoopByFollowUpId(trigger.dataset.loopOverflow);
      const overflow = (Array.isArray(loop?.actions) ? loop.actions : []).filter((action) => action.slot === 'overflow');
      const contextMenu = windowRef.inventoryContextMenu;
      if (!overflow.length || typeof contextMenu?.show !== 'function') {
        return;
      }
      const items = [];
      for (const action of overflow) {
        const danger = action.type === 'delete_follow_up';
        if (danger && items.length) {
          items.push({ separator: true });
        }
        items.push({ label: actionLabel(action), danger, action: () => runActionWithFeedback(action) });
      }
      const followUpId = String(loop.followUpId || '');
      trigger.setAttribute('aria-expanded', 'true');
      contextMenu.show({
        rootEl: trigger,
        anchorEl: trigger,
        restoreFocusTo: trigger,
        onHide: () => {
          if (openOverflowFollowUpId === followUpId) {
            openOverflowFollowUpId = '';
          }
          // A re-render while the menu was open replaced the trigger; the
          // context menu can only restore focus to the one it was given.
          const current = trigger.isConnected !== false ? trigger : findOverflowTrigger(followUpId);
          current?.setAttribute?.('aria-expanded', 'false');
          const active = documentRef?.activeElement;
          if (current && current !== trigger && (!active || active === documentRef.body)) {
            current.focus?.({ preventScroll: true });
          }
        },
        items,
      });
      openOverflowFollowUpId = followUpId;
    }

    function findOverflowTrigger(followUpId) {
      return findLoopCardNode(followUpId)?.querySelector?.('[data-loop-overflow]') || null;
    }

    /* Called after each board render: the rebuilt trigger of an open menu
     * must still report it as expanded. */
    function syncOpenOverflowTrigger() {
      if (openOverflowFollowUpId) {
        findOverflowTrigger(openOverflowFollowUpId)?.setAttribute?.('aria-expanded', 'true');
      }
    }

    /* Pending deletes are cancelled, not committed: the row returns on the
     * next board, and nothing irreversible runs after teardown. */
    function dispose() {
      disposed = true;
      for (const pending of pendingDeletes.values()) {
        if (!pending.committing) {
          clearTimeout(pending.timer);
          if (pending.toastId) {
            dismissToast(pending.toastId);
          }
        }
      }
      pendingDeletes.clear();
      publishPendingDeletes();
      if (openOverflowFollowUpId) {
        openOverflowFollowUpId = '';
        windowRef.inventoryContextMenu?.hide?.({ restoreFocus: false });
      }
    }

    /* Row-level toggles and the add/cancel buttons; anything else with an
     * action id dispatches through the resolvable action list. */
    const CLICK_TOGGLES = Object.freeze([
      ['[data-home-open-loop-add]', () => form.open()],
      ['[data-home-open-loop-cancel]', () => form.close()],
      ['[data-home-archived-toggle]', () => toggleArchivedSection()],
      ['[data-home-resolved-toggle]', () => toggleResolvedSection()],
      ['[data-loop-history-toggle]', (node) => toggleLoopHistory(node.dataset.loopHistoryToggle)],
      ['[data-loop-body-toggle]', (node) => toggleLoopBody(node.dataset.loopBodyToggle)],
      ['[data-loop-overflow]', (node) => openLoopOverflowMenu(node)],
    ]);

    async function handleHomeClick(event) {
      for (const [selector, run] of CLICK_TOGGLES) {
        const node = event.target.closest(selector);
        if (node) {
          event.preventDefault();
          run(node);
          return;
        }
      }
      const actionButton = event.target.closest('[data-companion-action-id]');
      if (!actionButton) {
        return;
      }
      event.preventDefault();
      await runActionWithFeedback(resolveAction(actionButton.dataset.companionActionId));
    }

    /* The Save button is type="submit", so this is the only save path. */
    async function handleHomeSubmit(event) {
      if (!event.target.closest('#homeOpenLoopForm')) {
        return;
      }
      event.preventDefault();
      try {
        await form.submit();
      } catch (error) {
        await handleMutationError(error, jt('companion.errors.saveOpenLoop', 'Could not save that open loop.'), 'shell.companion:add:error');
      }
    }

    return {
      formatCompanionOriginLabel,
      getAvailableDeferPresets,
      getResolvableActions,
      isLoopPendingDelete,
      renderManualAddForm: form.render,
      syncOpenOverflowTrigger,
      handleHomeClick,
      handleHomeSubmit,
      dispose,
    };
  }

  return {
    createCompanionActionUtils,
  };
});
