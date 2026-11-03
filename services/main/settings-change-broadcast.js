'use strict';

/* services/main/settings-change-broadcast.js - row 88 D6: push committed chatUi / windowUi /
 * workspace-IDE preference changes to the renderer, whoever wrote them (Settings, the Jenny
 * chat's settings tool, its Undo). ShellConfigService emits 'changed' with a reason (and, for a
 * multi-field chat-UI commit, `reasons`); this maps the reasons to the bridge events and applies
 * an app-zoom change the windowUi IPC handler would have applied only for its own sender.
 * Payloads are the same getState shapes the invoke handlers return; these sections hold no
 * secrets. Every send is best-effort: a gone window never breaks the commit that triggered it. */

// Reasons updateChatUiSettings can commit under (CHAT_UI_TOP_LEVEL_FIELDS in
// shell-config-service.js plus the nested-block reason); tests pin this list to the source.
const CHAT_UI_REASONS = new Set([
  'time_format_updated',
  'default_run_mode_updated',
  'ui_language_updated',
  'safety_mode_updated',
  'unattended_guard_minutes_updated',
  'auto_approve_streak_cap_updated',
  'chat_ui_settings_updated',
]);
const WINDOW_UI_REASONS = new Set(['window_ui_settings_updated']);
const IDE_PREFERENCES_REASONS = new Set(['workspace_ide_preferences_updated']);
const ZOOM_EPSILON = 0.001;

function matches(set, context) {
  const reasons = Array.isArray(context?.reasons) ? context.reasons : [];
  return set.has(context?.reason) || reasons.some((reason) => set.has(reason));
}

function createSettingsChangeBroadcast({
  shellConfigService,
  sendBridgeEvent = () => {},
  getWindow = () => null,
  log = () => {},
} = {}) {
  if (!shellConfigService || typeof shellConfigService.on !== 'function') {
    return { dispose() {} };
  }

  const warn = (event, error) => {
    try {
      log('WARN', event, { message: String((error && error.message) || error).slice(0, 256) });
    } catch (_logError) {
      // Logging must never throw out of a config commit.
    }
  };

  // Idempotent: a window already at the stored percent (the common echo of the
  // Settings select or a Ctrl +/- step) is left alone.
  function applyAppZoom(windowUi) {
    try {
      const percent = Number(windowUi?.appZoomPercent);
      if (!Number.isFinite(percent) || percent <= 0) return;
      const win = getWindow();
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
      const contents = win.webContents;
      if (!contents || typeof contents.setZoomFactor !== 'function') return;
      const factor = percent / 100;
      const current = typeof contents.getZoomFactor === 'function' ? Number(contents.getZoomFactor()) : NaN;
      if (Number.isFinite(current) && Math.abs(current - factor) < ZOOM_EPSILON) return;
      contents.setZoomFactor(factor);
    } catch (error) {
      warn('settings_change_broadcast.zoom_failed', error);
    }
  }

  function send(path, build) {
    try {
      sendBridgeEvent(path, build());
    } catch (error) {
      warn('settings_change_broadcast.send_failed', error);
    }
  }

  function onChanged(_snapshot, context) {
    if (matches(CHAT_UI_REASONS, context)) {
      send('chatUi.onChanged', () => shellConfigService.getChatUiState());
    }
    if (matches(WINDOW_UI_REASONS, context)) {
      let windowUi = null;
      send('windowUi.onChanged', () => {
        windowUi = shellConfigService.getWindowUiState();
        return windowUi;
      });
      if (windowUi) applyAppZoom(windowUi);
    }
    if (matches(IDE_PREFERENCES_REASONS, context)) {
      // Preferences only: per-root state (tabs, rail layout) stays out of the event.
      send('workspaceIde.onPreferencesChanged', () => shellConfigService.getWorkspaceIdeStore().preferences);
    }
  }

  shellConfigService.on('changed', onChanged);
  return {
    dispose() {
      if (typeof shellConfigService.off === 'function') shellConfigService.off('changed', onChanged);
      else shellConfigService.removeListener?.('changed', onChanged);
    },
  };
}

module.exports = {
  createSettingsChangeBroadcast,
  CHAT_UI_REASONS,
  WINDOW_UI_REASONS,
  IDE_PREFERENCES_REASONS,
};
