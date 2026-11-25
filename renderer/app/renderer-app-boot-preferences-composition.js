/* renderer/app/renderer-app-boot-preferences-composition.js -- boot preferences: chat-timeline rollout prefs and the persisted UI state, seeded into state */
/**
 * Extracted from renderer-app-lifecycle-composition.js. It builds the
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
  const chatTimelinePreferenceController = ctx.appLifecyclePreferenceUtils.createChatTimelinePreferenceController({
    state: ctx.state,
    storage: ctx.window.localStorage,
    storageKeys: {
      batch4: ctx.CHAT_TIMELINE_BATCH4_STORAGE_KEY,
    },
    callbacks: {
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      clearProjectionContextCacheForSession: (...a) => ctx.clearProjectionContextCacheForSession(...a),
      renderMessages: (...a) => ctx.renderMessages(...a),
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
    (async () => { try { return await ctx.window.jennyShell?.chatUi?.getState?.(); } catch (_error) { return null; } })(),
    (async () => { try { return await ctx.window.jennyShell?.windowUi?.getState?.(); } catch (_error) { return null; } })(),
    (async () => {
      try {
        return await Promise.race([
          ctx.window.jennyShell?.features?.getState?.(),
          new Promise((resolve) => { setTimeout(() => resolve(null), 250); }),
        ]);
      } catch (_error) { return null; }
    })(),
  ]);
  if (ctx.isDisposed?.() === true) return { disposed: true };
  const savedAppearancePreferences = ctx.loadAppearancePreferences(); // Restore saved preferences.
  ctx.state.ui.appearance = ctx.normalizeAppearancePreferences(savedAppearancePreferences);
  ctx.state.ui.chatZoomPercent = ctx.normalizeChatZoomPercent(
    persistedChatZoomState?.zoomPercent ?? ctx.state.ui.chatZoomPercent ?? ctx.DEFAULT_CHAT_ZOOM_PERCENT
  );
  const chatUiNormalizers = ctx.window.rendererSettingsSupport || {};
  ctx.state.use24HourTime = persistedChatZoomState?.use24HourTime === true;
  ctx.state.drawingInstructions = persistedChatZoomState?.drawingInstructions === 'full' || persistedChatZoomState?.drawingInstructions === 'mermaid' ? persistedChatZoomState.drawingInstructions : 'short';
  ctx.state.transcriptViewDefault = ctx.globalThis.rendererTranscriptViewUtils?.normalizeTranscriptView?.(persistedChatZoomState?.transcriptViewDefault) || 'thinking';
  ctx.globalThis.jennyI18n?.setTimeFormat?.(ctx.state.use24HourTime);
  ctx.state.uiLanguage = chatUiNormalizers.normalizeUiLanguageTag?.(persistedChatZoomState?.uiLanguage) || ctx.state.uiLanguage || 'en';
  ctx.state.safetyMode = chatUiNormalizers.normalizeSafetyMode?.(persistedChatZoomState?.safetyMode) || ctx.state.safetyMode || 'normal';
  ctx.state.unattendedGuardMinutes = chatUiNormalizers.normalizeUnattendedGuardMinutes?.(persistedChatZoomState?.unattendedGuardMinutes) ?? ctx.state.unattendedGuardMinutes ?? 0;
  ctx.state.autoApproveStreakCap = chatUiNormalizers.normalizeAutoApproveStreakCap?.(persistedChatZoomState?.autoApproveStreakCap) ?? ctx.state.autoApproveStreakCap ?? 250;
  ctx.state.digestQuietStart = chatUiNormalizers.normalizeDigestQuietStart?.(persistedChatZoomState?.digestQuietStart) ?? ctx.state.digestQuietStart ?? '22:00';
  ctx.state.digestQuietEnd = chatUiNormalizers.normalizeDigestQuietEnd?.(persistedChatZoomState?.digestQuietEnd) ?? ctx.state.digestQuietEnd ?? '07:00';
  // The one boot read of chatUi state: the default run mode seeds the empty-chat draft too.
  ctx.state.defaultRunMode = chatUiNormalizers.normalizeRunMode?.(persistedChatZoomState?.defaultRunMode) || ctx.state.defaultRunMode || 'ask';
  if (!ctx.state.currentSessionId && ctx.state.runtimeDraft) ctx.state.runtimeDraft.runMode = ctx.state.defaultRunMode;
  // Fallback mirrors services/shell-config-zoom-state.js APP_ZOOM_DEFAULT.
  ctx.state.ui.appZoomPercent = Number(
    persistedWindowUiState?.appZoomPercent ?? ctx.state.ui.appZoomPercent ?? 110
  ) || 110;
  // Desktop notification preferences (windowUi.notifications), defaults filled when absent.
  ctx.state.ui.notifications = ctx.window.rendererDesktopNotifications?.normalizeNotificationSettings?.(persistedWindowUiState?.notifications) || null;
  // Dictation microphone (windowUi.dictation, row 84); '' is the system default.
  ctx.state.ui.dictation = { deviceId: typeof persistedWindowUiState?.dictation?.deviceId === 'string' ? persistedWindowUiState.dictation.deviceId : '' };
  ctx.state.ui.chatTimelineBatch4FastPathEnabled = loadChatTimelineBatch4Preference();
  setChatTimelineRowModelEnabled(ctx.state.currentSessionId, getChatTimelineRowModelEnabled(ctx.state.currentSessionId), {
    source: 'bootstrap',
  });
  ctx.applyAppearanceToDocument(ctx.document, ctx.state.ui.appearance);
  ctx.applyChatZoomToDocument(ctx.document, ctx.state.ui.chatZoomPercent);
  return {
    getChatTimelineRowModelEnabled, recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel, prefetchedFeatureState,
  };
  }

  root.rendererAppBootPreferencesComposition = {
    createBootPreferencesComposition,
  };
})(window);
