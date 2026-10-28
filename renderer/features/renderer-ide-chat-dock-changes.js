/* renderer/features/renderer-ide-chat-dock-changes.js
 * The Workspace chat dock's link to the Changes view (row 34 S5; row 40 W3/W6).
 *
 * Inside the workbench, Chat and Changes are two views and the workbench owns
 * which is shown (they may even sit in different stacks). This module mounts
 * the Changes view into the workbench's own host while that view is visible,
 * reveals it on request, counts suggested changes waiting for a decision, and
 * keeps the chat's unread signal: new chat activity while the chat view is not
 * visible sets hasUnread() until the chat view is shown again (the workbench
 * paints the cue on the chat tab).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeChatDockChanges = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  /**
   * @param {object} deps
   * @param {object} deps.workbench the workbench stub (getChangesHost, isVisible, reveal, onCountChange)
   * @param {() => Promise<object|null>} deps.loadChangesView resolves rendererChangesView
   * @param {object} deps.viewDeps createChangesView deps (host is forced to 'dock')
   * @param {() => void} [deps.focusChatInput] focuses the composer when Chat is chosen
   * @param {() => boolean} deps.isChatOnScreen whether the chat's transcript is on screen
   * @param {() => boolean} [deps.isActive] whether the Workspace is the active view (default true)
   */
  function createChatDockChanges(deps = {}) {
    const loadChangesView = typeof deps.loadChangesView === 'function' ? deps.loadChangesView : async () => null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const focusChatInput = typeof deps.focusChatInput === 'function' ? deps.focusChatInput : noop;
    const onSync = typeof deps.onSync === 'function' ? deps.onSync : noop;
    const isActive = typeof deps.isActive === 'function' ? deps.isActive : () => true;
    const viewDeps = deps.viewDeps || {};
    const workbench = deps.workbench && typeof deps.workbench.getChangesHost === 'function' ? deps.workbench : null;
    // Suggested changes (row 35): the Changes tab counts the ones waiting for a decision.
    const getSuggestedClient = typeof deps.getSuggestedClient === 'function'
      ? deps.getSuggestedClient
      : () => globalThis.rendererSuggestedChangesClient?.getSharedClient?.() || null;
    let unsubscribeSuggested = null;

    let mounted = false;
    let unread = false;
    let seen = null; // { sessionId, key } of the last observation; null until the first one
    let view = null;
    let viewLoad = null;
    let disposed = false;
    // What the mounted view last painted: its session and turn view models
    // (a copy, compared by identity). null forces the next repaint.
    let painted = null;

    function ensureView() {
      if (view) return Promise.resolve(view);
      if (!viewLoad) {
        viewLoad = Promise.resolve()
          .then(() => loadChangesView())
          .then((module) => {
            if (disposed || !module || typeof module.createChangesView !== 'function') {
              viewLoad = null;
              return null;
            }
            const getTurnTime = typeof module.createTurnTimeLookup === 'function' && typeof viewDeps.getSessionMessages === 'function'
              ? module.createTurnTimeLookup(viewDeps.getSessionMessages)
              : null;
            view = module.createChangesView({ getTurnTime, ...viewDeps, onBackToChat: () => select('chat', { focus: true }), host: 'dock' });
            return view;
          })
          .catch((error) => {
            viewLoad = null;
            appendClientLog('ERROR', 'ide_chat_dock.changes_view_load_failed', { message: String(error && error.message || error) });
            return null;
          });
      }
      return viewLoad;
    }

    function setUnread(next) {
      if (unread === next) return;
      unread = next;
      workbench?.onCountChange?.(); // the chat tab's cue; chrome only
    }

    // The chat's activity key: the turn count and the newest reply's id. New activity
    // while the chat view is hidden is unread; showing the chat view clears it. The first
    // observation and a session switch only reset the key.
    function chatSnapshot() {
      return {
        turns: typeof viewDeps.getTurnViewModels === 'function' ? viewDeps.getTurnViewModels() || [] : [],
        sessionId: String(typeof viewDeps.getSessionId === 'function' ? viewDeps.getSessionId() || '' : ''),
      };
    }

    function noteChatActivity({ turns, sessionId }) {
      const last = turns[turns.length - 1];
      const key = `${turns.length}:${last && last.rootMessageIds ? last.rootMessageIds.assistant || '' : ''}`;
      const chatVisible = isChatOnScreen();
      const changed = seen !== null && sessionId === seen.sessionId && key !== seen.key;
      const switched = seen !== null && sessionId !== seen.sessionId;
      seen = { sessionId, key };
      if (chatVisible || switched) setUnread(false); // another chat's news is not this one's
      else if (changed) setUnread(true);
    }

    function isChatOnScreen() {
      return deps.isChatOnScreen?.() === true;
    }

    // The view rebuilds its ledger and markup on render: only a changed
    // session or turn list (view models are replaced, never edited) repaints.
    function chatChangedSincePaint({ turns, sessionId }) {
      const same = painted && painted.sessionId === sessionId && painted.turns.length === turns.length
        && turns.every((vm, index) => vm === painted.turns[index]);
      if (!same) painted = { sessionId, turns: turns.slice() };
      return !same;
    }

    function waitingCount() {
      const client = getSuggestedClient();
      const sessionId = String(typeof viewDeps.getSessionId === 'function' ? viewDeps.getSessionId() || '' : '');
      if (!client || !sessionId) return 0;
      if (!unsubscribeSuggested) unsubscribeSuggested = client.subscribe(() => { if (disposed) return; workbench?.onCountChange?.(); });
      return Number(client.get(sessionId)?.pending_count) || 0;
    }

    function isChangesShown() {
      return workbench ? workbench.isVisible('changes') === true : false;
    }

    /** Called on every dock reconcile: mount while the Changes view is visible, unmount when it hides. */
    function sync() {
      if (disposed) return;
      const chat = chatSnapshot();
      noteChatActivity(chat);
      onSync();
      if (!isChangesShown()) {
        if (mounted && view) view.unmount();
        mounted = false;
        return;
      }
      if (mounted) {
        // A session switch or a new turn shows without waiting for another
        // event; a hidden Workspace catches up on its first sync back.
        if (isActive() && chatChangedSincePaint(chat)) view?.render?.();
        return;
      }
      ensureView().then((ready) => {
        if (!ready || disposed || !isChangesShown()) return;
        const host = workbench.getChangesHost() || null;
        if (!host || mounted) return;
        ready.mount(host);
        mounted = true;
        painted = null;
        chatChangedSincePaint(chatSnapshot()); // mount painted the current chat
      });
    }

    function select(tab, options = {}) {
      if (disposed || !workbench || (tab !== 'chat' && tab !== 'changes')) return false;
      workbench.reveal(tab);
      if (tab === 'chat') {
        if (options.focus) focusChatInput();
        return true;
      }
      ensureView().then((ready) => {
        if (!ready || disposed || !isChangesShown()) return;
        sync();
        if (options.focus) ready.focus();
      });
      return true;
    }

    function toggle() {
      return select(isChangesShown() ? 'chat' : 'changes', { focus: true });
    }

    // Reveal a turn (and file) from a transcript affordance.
    function reveal(target) {
      if (!select('changes')) return false;
      ensureView().then((ready) => {
        if (!ready || !isChangesShown()) return;
        if (target && target.scope === 'suggested') ready.revealSuggested({ toolCallId: target.toolCallId || '' });
        else ready.reveal(target || {});
      });
      return true;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof unsubscribeSuggested === 'function') unsubscribeSuggested();
      unsubscribeSuggested = null;
      if (view) view.dispose();
      view = null;
      mounted = false;
    }

    return {
      dispose,
      // Cleared as soon as the chat shows, even before the next sync (a workbench-only render).
      hasUnread: () => unread && !isChatOnScreen(),
      reveal,
      select,
      sync,
      toggle,
      waitingCount,
    };
  }

  return { createChatDockChanges };
});
