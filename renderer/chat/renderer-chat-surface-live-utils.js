/* renderer/chat/renderer-chat-surface-live-utils.js
 * The one shared "is a chat surface live?" predicate (Workspace Chat Dock).
 *
 * Chat is live in the Chat view or in an open, enabled Workspace dock.
 *
 * Pure state → boolean; no DOM, no deps (unit-testable, not c8-excluded).
 * Reads the renderer state shape: `state.ui.activeView`,
 * `state.features.featureFlags.ide_chat_dock`, and the renderer-only UI
 * mirror `state.ui.ideChatDockOpen` (set by renderer-ide-chat-dock.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatSurfaceLiveUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isChatSurfaceLive(state) {
    var view = state && state.ui && state.ui.activeView;
    if (view === 'chat') return true;
    if (view !== 'ide') return false;
    var features = (state && state.features) || {};
    var flags = features.featureFlags || {};
    return flags.ide_chat_dock === true && state.ui.ideChatDockOpen === true;
  }

  return {
    isChatSurfaceLive: isChatSurfaceLive,
  };
});
