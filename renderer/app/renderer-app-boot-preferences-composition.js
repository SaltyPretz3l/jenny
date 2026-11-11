/* renderer/app/renderer-app-boot-preferences-composition.js -- boot preferences: chat-timeline rollout prefs and the persisted UI state, seeded into state */
/* eslint no-with: "off", no-undef: "off", no-useless-assignment: "off" -- a with(ctx) section: names resolve through the scope the root hands it */
/**
 * Extracted from renderer-app-lifecycle-composition.js (a with(ctx) section). It builds the
 * chat-timeline preference controller, reads the persisted chatUi / windowUi state and the
 * first feature flags in one concurrent round trip, seeds `state` from them and applies
 * appearance and chat zoom to the document. Resolves `{ disposed: true }` when the renderer
 * was disposed during the round trip (the root then returns `{}`).
 *
 * The root passes `{ __proto__: ctx, ...its locals }`: shorthand values for root
 * locals already initialized, accessors for the ones bound later (so a call
 * before they exist throws exactly as the inline code did).
 */
(function (root) {
  async function createBootPreferencesComposition(ctx) {
    with (ctx) {
  const chatTimelinePreferenceController = appLifecyclePreferenceUtils.createChatTimelinePreferenceController({
    state,
    storage: window.localStorage,
    storageKeys: {
      batch4: CHAT_TIMELINE_BATCH4_STORAGE_KEY,
    },
    callbacks: {
      appendClientLog: (...a) => appendClientLog(...a),
      clearProjectionContextCacheForSession: (...a) => clearProjectionContextCacheForSession(...a),
      renderMessages: (...a) => renderMessages(...a),
    },
  });
  const {
    getChatTimelineRowModelEnabled,
    loadChatTimelineBatch4Preference,
    recordChatTimelineRolloutSignal,
    refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel,
    setChatTimelineRowModelEnabled,
  } = chatTimelinePreferenceController;
  // Both are best-effort preload-backed preferences with no dependency on each
  // other, so issue the IPC round-trips concurrently rather than serially on
  // boot. Overall app zoom is applied natively by the main process
  // (webContents.setZoomFactor); the renderer only needs the value to seed the
  // Settings select.
  // Feature flags ride the same round trip (row 62), so the first render, the
  // controller binds and math rendering see real flags instead of placeholders.
  // Bounded: a slow features call must never hold boot; the post-bootstrap
  // refresh still applies the flags when it lands.
  const [persistedChatZoomState, persistedWindowUiState, prefetchedFeatureState] = await Promise.all([
    (async () => { try { return await window.jennyShell?.chatUi?.getState?.(); } catch (_error) { return null; } })(),
    (async () => { try { return await window.jennyShell?.windowUi?.getState?.(); } catch (_error) { return null; } })(),
    (async () => {
      try {
        return await Promise.race([
          window.jennyShell?.features?.getState?.(),
          new Promise((resolve) => { setTimeout(() => resolve(null), 250); }),
        ]);
      } catch (_error) { return null; }
    })(),
  ]);
  if (ctx.isDisposed?.() === true) return { disposed: true };
  const savedAppearancePreferences = loadAppearancePreferences(); // Restore saved preferences.
  state.ui.appearance = normalizeAppearancePreferences(savedAppearancePreferences);
  state.ui.chatZoomPercent = normalizeChatZoomPercent(
    persistedChatZoomState?.zoomPercent ?? state.ui.chatZoomPercent ?? DEFAULT_CHAT_ZOOM_PERCENT
  );
  const chatUiNormalizers = window.rendererSettingsSupport || {};
  state.use24HourTime = persistedChatZoomState?.use24HourTime === true;
  state.transcriptViewDefault = globalThis.rendererTranscriptViewUtils?.normalizeTranscriptView?.(persistedChatZoomState?.transcriptViewDefault) || 'thinking';
  globalThis.jennyI18n?.setTimeFormat?.(state.use24HourTime);
  state.uiLanguage = chatUiNormalizers.normalizeUiLanguageTag?.(persistedChatZoomState?.uiLanguage) || state.uiLanguage || 'en';
  state.safetyMode = chatUiNormalizers.normalizeSafetyMode?.(persistedChatZoomState?.safetyMode) || state.safetyMode || 'normal';
  state.unattendedGuardMinutes = chatUiNormalizers.normalizeUnattendedGuardMinutes?.(persistedChatZoomState?.unattendedGuardMinutes) ?? state.unattendedGuardMinutes ?? 0;
  state.autoApproveStreakCap = chatUiNormalizers.normalizeAutoApproveStreakCap?.(persistedChatZoomState?.autoApproveStreakCap) ?? state.autoApproveStreakCap ?? 50;
  state.digestQuietStart = chatUiNormalizers.normalizeDigestQuietStart?.(persistedChatZoomState?.digestQuietStart) ?? state.digestQuietStart ?? '22:00';
  state.digestQuietEnd = chatUiNormalizers.normalizeDigestQuietEnd?.(persistedChatZoomState?.digestQuietEnd) ?? state.digestQuietEnd ?? '07:00';
  // Fallback mirrors services/shell-config-zoom-state.js APP_ZOOM_DEFAULT.
  state.ui.appZoomPercent = Number(
    persistedWindowUiState?.appZoomPercent ?? state.ui.appZoomPercent ?? 110
  ) || 110;
  // Desktop notification preferences (windowUi.notifications), defaults filled when absent.
  state.ui.notifications = window.rendererDesktopNotifications?.normalizeNotificationSettings?.(persistedWindowUiState?.notifications) || null;
  // Dictation microphone (windowUi.dictation, row 84); '' is the system default.
  state.ui.dictation = { deviceId: typeof persistedWindowUiState?.dictation?.deviceId === 'string' ? persistedWindowUiState.dictation.deviceId : '' };
  state.ui.chatTimelineBatch4FastPathEnabled = loadChatTimelineBatch4Preference();
  setChatTimelineRowModelEnabled(state.currentSessionId, getChatTimelineRowModelEnabled(state.currentSessionId), {
    source: 'bootstrap',
  });
  applyAppearanceToDocument(document, state.ui.appearance);
  applyChatZoomToDocument(document, state.ui.chatZoomPercent);
  return {
    getChatTimelineRowModelEnabled, recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel, prefetchedFeatureState,
  };
    }
  }

  root.rendererAppBootPreferencesComposition = {
    createBootPreferencesComposition,
  };
})(window);
