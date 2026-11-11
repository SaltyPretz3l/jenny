/* renderer/shell/renderer-shell-recovery-actions.js - error-recovery and artifact actions of the shell runtime controller.
 *
 * Split out of renderer-shell-runtime-utils.js (which creates one per controller and exports the same
 * handlers): the chat error card actions (retry, resume / rerun an interrupted reply, restart the sidecar,
 * open Logs / Settings, offline lockdown off, skip a tool), the logs deep link, and the inline artifact actions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellRecoveryActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noopAsync() { return Promise.resolve(); }

  function createShellRecoveryActions(deps) {
    const {
      state,
      windowRef,
      TOAST_SOURCE,
      diagnosticsViewStateUtils,
      appendClientLog,
      renderAll,
      showToastMessage,
      showComposerActionError,
      openSettingsSection,
      setActiveView,
      openArtifactTarget,
      getLatestReplyAssistantMessageId,
      getCurrentVisibleMessages,
    } = deps;

    function resolveActionMessageId(contextNode, preferredMessageId) {
      const directMessageId = String(preferredMessageId || '').trim();
      if (directMessageId) {
        return directMessageId;
      }
      const ownerMessageId = String(
        contextNode?.closest?.('[data-message-id]')?.dataset?.messageId || ''
      ).trim();
      if (ownerMessageId) {
        return ownerMessageId;
      }
      return getLatestReplyAssistantMessageId(getCurrentVisibleMessages());
    }

    function resolvePendingApprovalKey(approvalRef) {
      const normalizedRef = String(approvalRef || '').trim();
      if (!normalizedRef || !(state.pendingToolApprovals instanceof Map)) {
        return '';
      }
      if (state.pendingToolApprovals.has(normalizedRef)) {
        return normalizedRef;
      }
      const matches = [];
      for (const [key, approval] of state.pendingToolApprovals.entries()) {
        if (String(approval?.approvalId || '').trim() === normalizedRef || String(approval?.callId || '').trim() === normalizedRef) {
          matches.push(String(key || '').trim());
        }
      }
      return matches.length === 1 ? matches[0] : '';
    }

    /* ── Logs deep link (chat error chip / "View in logs" -> Activity) ──
     * The error affordances carry the turn's streamId; the matching
     * diagnostic activity event is resolved out of the already-loaded
     * state.logs buffer (the same array renderer-diagnostics-render-utils
     * reads), so this needs no new bridge call or renderer plumbing. DOM
     * focus is delegated to the diagnostics event bindings, which own
     * focusRow/ensureLogRowMounted, via the LOGS_FOCUS_EVENT below. */
    const LOGS_FOCUS_EVENT = 'diagnostics:focus-log-entry';
    const TURN_DIAGNOSTIC_EVENT = 'chat.turn_diagnostic_dumped';

    function logEntryData(entry) {
      if (!entry || typeof entry !== 'object') return {};
      if (entry.data && typeof entry.data === 'object') return entry.data;
      if (entry.details && typeof entry.details === 'object') return entry.details;
      return {};
    }

    function logEntryStreamId(entry) {
      const data = logEntryData(entry);
      return String(
        data.streamId || data.stream_id || entry?.stream_id || entry?.streamId || ''
      ).trim();
    }

    /* Mirrors entryId() in renderer-diagnostics-render-utils.js — the id the
     * activity rows are keyed by. */
    function logEntryId(entry) {
      return String(entry?.entry_id || entry?.origin_entry_id || entry?.sequence || '').trim();
    }

    function findLogEntryForStream(streamId) {
      const entries = Array.isArray(state.logs) ? state.logs : [];
      let fallback = null;
      for (const entry of entries) {
        if (logEntryStreamId(entry) !== streamId || !logEntryId(entry)) continue;
        if (String(entry?.event || '').trim() === TURN_DIAGNOSTIC_EVENT) return entry;
        if (!fallback) fallback = entry;
      }
      return fallback;
    }

    /* Open the Logs view on Activity, selecting the diagnostic event for this
     * turn when one is loaded. No match (diagnostics never loaded, older
     * session, retention drop) is not an error: the tab still opens plainly. */
    function openLogsForStream(streamId) {
      const normalizedStreamId = String(streamId || '').trim();
      const entry = normalizedStreamId ? findLogEntryForStream(normalizedStreamId) : null;
      const entryId = entry ? logEntryId(entry) : '';
      if (entryId) {
        diagnosticsViewStateUtils.focusDiagnosticsTarget(state, {
          tab: 'activity', entryId,
          // Empty resolves to the active run for renderer-local entries.
          runId: String(entry.run_id || ''),
        });
      } else {
        // Nothing to reveal: keep the user's filters and just open Activity.
        diagnosticsViewStateUtils.ensureDiagnosticsViewState(state).activeTab = 'activity';
      }
      setActiveView('logs');
      appendClientLog('INFO', 'error_recovery.logs_deeplink', {
        streamId: normalizedStreamId,
        matched: Boolean(entryId),
      });
      /* Always announced, match or not: when the Logs view is already active,
       * setActiveView is a no-op and the Activity tab flip would never paint. */
      const CustomEventCtor = windowRef.CustomEvent || globalRef.CustomEvent;
      if (typeof CustomEventCtor !== 'function' || typeof windowRef.dispatchEvent !== 'function') return;
      windowRef.dispatchEvent(new CustomEventCtor(LOGS_FOCUS_EVENT, { detail: { entryId } }));
    }

    function isRetryRecoveryAction(action) {
      return action === 'retry' || action === 'retry-tool' || action === 'retry_turn';
    }

    function isSettingsRecoveryAction(action) {
      return action === 'settings' || action === 'open_settings';
    }

    function isNewSessionRecoveryAction(action) {
      return action === 'new-session' || action === 'start_new_session';
    }

    async function restartSidecarForRecovery() {
      const backend = windowRef.jennyShell?.backend;
      if (!backend || typeof backend.retryStart !== 'function') {
        showComposerActionError(new Error('Sidecar restart is unavailable.'), jt('shell.runtime.restartUnavailable', 'Restart Unavailable'));
        return;
      }
      try {
        await backend.retryStart();
        showToastMessage(jt('shell.runtime.restartRequestedMessage', 'Restart requested for the local sidecar.'), {
          title: jt('shell.runtime.restartRequestedTitle', 'Restart Requested'),
          tone: 'info',
          source: TOAST_SOURCE.chatStream,
          dedupeKey: `${TOAST_SOURCE.chatStream}:restart-sidecar`,
        });
      } catch (error) {
        showComposerActionError(error, jt('shell.runtime.restartFailed', 'Restart Failed'));
      }
    }

    async function handleErrorRecoveryAction(payload, handlers = {}) {
      const {
        handleRegenerateMessage = noopAsync,
        handleCreateSessionWithWorkspace = noopAsync,
      } = handlers;
      const action = String(payload?.action || '').trim();
      if (!action) {
        return;
      }
      if (isRetryRecoveryAction(action)) {
        const targetMessageId = resolveActionMessageId(payload?.contextNode, payload?.messageId);
        if (!targetMessageId) {
          showComposerActionError(new Error('No assistant response is available to retry.'), jt('shell.runtime.retryUnavailable', 'Retry Unavailable'));
          return;
        }
        await handleRegenerateMessage(targetMessageId, { failureRetry: true });
        return;
      }
      if (action === 'restart_sidecar') {
        await restartSidecarForRecovery();
        return;
      }
      if (action === 'resume_paused_reply' || action === 'rerun_interrupted_reply') {
        // Gate F9: one copy of an interrupted reply. Resume moves the run the
        // restart paused; a run with no checkpoint cannot resume, so Run again
        // discards it first and then regenerates. A refused resume or discard
        // is already named in the composer.
        const controller = state.runtimeSendController;
        const key = await controller?.interruptedReplyKey?.(
          String(payload?.sessionId || '').trim() || state.currentSessionId, payload?.streamId) || '';
        if (action === 'rerun_interrupted_reply') {
          if (key && !await controller.withdraw(key)) return;
          const targetMessageId = resolveActionMessageId(payload?.contextNode, payload?.messageId);
          if (!targetMessageId) {
            showComposerActionError(new Error('No assistant response is available to retry.'), jt('shell.runtime.retryUnavailable', 'Retry Unavailable'));
            return;
          }
          await handleRegenerateMessage(targetMessageId, { failureRetry: true });
          return;
        }
        if (key) {
          await controller.resume(key);
        } else {
          showToastMessage(jt('shell.runtime.resumeUnavailableMessage', 'This reply can no longer be resumed. Send the message again to rerun it.'), {
            title: jt('shell.runtime.resumeUnavailableTitle', 'Resume unavailable'),
            tone: 'info',
            source: TOAST_SOURCE.chatStream,
            dedupeKey: `${TOAST_SOURCE.chatStream}:resume-unavailable`,
          });
        }
        return;
      }
      if (action === 'open_diagnostics' || action === 'open_logs') {
        openLogsForStream(payload?.streamId);
        return;
      }
      if (isSettingsRecoveryAction(action)) {
        openSettingsSection('models', { source: 'error_recovery' });
        return;
      }
      if (action === 'open_pdf_addon_settings') {
        openSettingsSection('tools', { source: 'pdf_addon_tool_row', focusId: 'toolsPdfAddonHost' });
        return;
      }
      if (isNewSessionRecoveryAction(action)) {
        await handleCreateSessionWithWorkspace();
        return;
      }
      if (action === 'lockdown_off') {
        const lockdownSessionId = String(payload?.sessionId || '').trim();
        if (!lockdownSessionId) {
          showComposerActionError(new Error('No session was found to turn offline lockdown off for.'), jt('shell.runtime.lockdownOffFailed', 'Lockdown Off Failed'));
          return;
        }
        try {
          const persisted = await windowRef.jennyShell.sessions.setPreferences(lockdownSessionId, { lockdown: false });
          if (String(persisted?.id || '').trim() !== lockdownSessionId || persisted?.lockdown !== false) {
            throw new Error('Offline lockdown persistence acknowledgement did not match the requested change.');
          }
          state.sessions = (Array.isArray(state.sessions) ? state.sessions : []).map((session) =>
            (String(session?.id || '').trim() === lockdownSessionId ? { ...session, lockdown: false } : session));
          renderAll();
          appendClientLog('INFO', 'sessions.offline_lockdown_updated', {
            sessionId: lockdownSessionId,
            lockdown: false,
          });
        } catch (error) {
          showComposerActionError(error, jt('shell.runtime.lockdownOffFailed', 'Lockdown Off Failed'));
        }
        return;
      }
      if (action === 'switch_local_model') {
        openSettingsSection('models', { source: 'lockdown_recovery' });
        return;
      }
      if (action === 'skip-tool') {
        const approvalRef = String(payload?.approvalId || payload?.approval_id || payload?.callId || '').trim();
        const approvalKey = resolvePendingApprovalKey(approvalRef);
        if (!approvalKey) {
          showToastMessage(jt('shell.runtime.skipUnavailableMessage', 'No pending tool approval found to skip.'), {
            title: jt('shell.runtime.skipUnavailableTitle', 'Skip Unavailable'),
            tone: 'info',
            source: TOAST_SOURCE.chatStream,
            dedupeKey: `${TOAST_SOURCE.chatStream}:skip-tool-unavailable`,
          });
          return;
        }
        await windowRef.jennyShell.tools.deny(approvalKey);
      }
    }

    async function handleArtifactAction(payload) {
      const action = String(payload?.action || '').trim();
      const artifactId = String(payload?.artifactId || '').trim();
      if (!action) {
        return;
      }
      const showArtifactActionUnavailable = () => showToastMessage(jt('shell.runtime.artifactActionUnavailableMessage', 'This artifact action is unavailable for the selected entry.'), {
        title: jt('shell.runtime.artifactActionUnavailableTitle', 'Artifact Action Unavailable'),
        tone: 'info',
        source: TOAST_SOURCE.chatStream,
        dedupeKey: `${TOAST_SOURCE.chatStream}:artifact-action-unavailable`,
      });
      if (!artifactId) {
        showArtifactActionUnavailable();
        return;
      }
      const currentSessionId = String(payload?.sessionId || state.currentSessionId || '').trim();
      if (!currentSessionId) {
        showToastMessage(jt('shell.runtime.noActiveSessionMessage', 'Open a session before using artifact actions.'), {
          title: jt('shell.runtime.noActiveSessionTitle', 'No Active Session'),
          tone: 'info',
          source: TOAST_SOURCE.chatStream,
          dedupeKey: `${TOAST_SOURCE.chatStream}:artifact-action-no-session`,
        });
        return;
      }
      if (action === 'open') {
        const result = await windowRef.jennyShell.artifacts.openExternal(currentSessionId, artifactId);
        if (result && result.ok === false) {
          showToastMessage(String(result.result || result.message || jt('shell.runtime.openExternallyFailed', 'Open externally failed.')), {
            title: jt('shell.runtime.openExternalFailedTitle', 'Open External Failed'),
            tone: 'danger',
            source: TOAST_SOURCE.chatStream,
            dedupeKey: `${TOAST_SOURCE.chatStream}:artifact-open-external-failed:${artifactId}`,
          });
        }
        return;
      }
      if (action === 'reveal') {
        await windowRef.jennyShell.artifacts.reveal(currentSessionId, artifactId);
        return;
      }
      if (action === 'save-as' || action === 'copy') {
        const saving = action === 'save-as';
        const result = await windowRef.jennyShell.artifacts[saving ? 'saveAs' : 'copyImage'](currentSessionId, artifactId);
        if (saving && (result?.ok || result?.canceled)) return;
        showToastMessage(saving ? jt('shell.runtime.artifactSaveFailed', 'Could not save the image.')
          : result?.ok ? jt('shell.runtime.artifactImageCopied', 'Image copied.') : jt('shell.runtime.artifactCopyFailed', 'Could not copy the image.'), {
          tone: !saving && result?.ok ? 'info' : 'danger', source: TOAST_SOURCE.chatStream,
          dedupeKey: `${TOAST_SOURCE.chatStream}:artifact-${action}:${artifactId}`,
        });
        return;
      }
      if (action === 'panel' && (await openArtifactTarget(artifactId, { source: 'inline-open-panel' })) === false) {
        showArtifactActionUnavailable();
      }
    }

    return { resolveActionMessageId, openLogsForStream, handleErrorRecoveryAction, handleArtifactAction };
  }

  return { createShellRecoveryActions };
});
