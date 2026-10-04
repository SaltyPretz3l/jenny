/* renderer/chat/renderer-stuck-send.js -- why a sent message has not started (UMD) */
/**
 * HB-009: the runtime names why pending work has not been admitted
 * (`admission_wait` on its summary: another chat's reply holds the model, or
 * the last reply's cleanup is unconfirmed). The queue strip and the Needs-you
 * inbox both read the two decisions made here -- when a wait is worth showing,
 * and what Restart engine asks first -- so neither surface re-derives them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rendererStuckSend = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // A normal wait is shown only past a short hand-off so a quick turn never
  // flashes a row; unconfirmed cleanup waits out the runtime's own attention
  // grace (TR-003), since most unproven settlements confirm within it.
  const GRACE_MS = Object.freeze({ model_busy: 2000, cleanup_unconfirmed: 5000 });
  const NOTICE_OWNER = 'runtime:restart-engine';

  // `wait` is the runtime's `admission_wait`; only pending work is waiting.
  function visibleWait(wait, status, now = Date.now()) {
    if (!wait || typeof wait !== 'object' || status !== 'pending') return null;
    const grace = GRACE_MS[wait.reason];
    const since = Date.parse(wait.since);
    if (!grace || !Number.isFinite(since) || now - since < grace) return null;
    return Object.freeze({ reason: wait.reason, blockingSessionId: String(wait.blocking_session_id || '').trim() });
  }

  function sessionTitle(state, sessionId) {
    const session = (Array.isArray(state?.sessions) ? state.sessions : []).find((entry) => entry?.id === sessionId);
    return String(session?.title || '').trim() || jt('chat.attentionInbox.untitledSession', 'Untitled chat');
  }

  function confirmRestart(documentRef, title) {
    const factory = globalThis.rendererIdeConfirmDialog?.createIdeConfirmDialog;
    const helpOverlayFactory = globalThis.inventoryHelpOverlay?.createHelpOverlay;
    // No dialog to ask with means no restart: it would stop a running reply unasked.
    if (typeof factory !== 'function' || typeof helpOverlayFactory !== 'function') return Promise.resolve(false);
    const dialog = factory({ document: documentRef, actionButton: globalThis.inventoryActionButton,
      helpOverlayFactory, hostId: 'engineRestartConfirmOverlay' });
    return Promise.resolve(dialog.confirm({
      title: jt('chat.stuckSend.restartConfirmTitle', 'Restart the engine?'),
      message: jt('chat.stuckSend.restartConfirmBody', 'The reply running in "{title}" will stop too. Your waiting message starts after the restart.', { title }),
      confirmLabel: jt('chat.stuckSend.restartEngine', 'Restart engine'),
      cancelLabel: jt('common.cancel', 'Cancel'),
      variant: 'danger',
    })).then((confirmed) => confirmed === true, () => false).finally(() => dialog.dispose?.());
  }

  // The sidecar restart is the proof that frees a lane whose cleanup is
  // unconfirmed: the backend reclaims what the old process ran, and the waiting
  // message starts by itself. It also stops a reply running in another chat, so
  // only that case asks first; otherwise all it interrupts is already stuck.
  // A reply counts as running when the stream index has it OR its send
  // lifecycle says streaming: a missed `started` event leaves only the latter.
  function streamingSessions(state, indexed) {
    const lifecycle = state?.ui?.chatSendLifecycleBySession;
    const live = typeof lifecycle?.entries === 'function'
      ? [...lifecycle.entries()].filter(([, phase]) => phase === 'streaming').map(([id]) => id) : [];
    return [...indexed, ...live].map((id) => String(id || '').trim()).filter(Boolean);
  }

  async function restartEngine({ state, shell, sessionId, streamingSessionIds = [], documentRef, notices = {}, isClosed = () => false }) {
    const retryStart = shell?.backend?.retryStart;
    if (typeof retryStart !== 'function') return false;
    const other = streamingSessions(state, streamingSessionIds).find((id) => id !== sessionId);
    if (other && !await confirmRestart(documentRef || globalThis.document, sessionTitle(state, other))) return false;
    // The window that asked may have gone while the dialog was open.
    if (isClosed()) return false;
    notices.set?.(jt('chat.stuckSend.restarting', 'Restarting the engine…'), { owner: NOTICE_OWNER, tone: 'pending', spinner: true });
    try {
      // The bridge answers a start that did not come up with its status, not a throw.
      const status = await retryStart();
      if (status?.phase && status.phase !== 'ready') throw new Error(String(status.phase));
      if (!isClosed()) notices.clear?.({ owner: NOTICE_OWNER });
      return true;
    } catch (error) {
      if (isClosed()) return false;
      notices.set?.(jt('chat.stuckSend.restartFailed', 'Could not restart the engine: {reason}',
        { reason: String(error?.message || error || '').slice(0, 200) }), { owner: NOTICE_OWNER, tone: 'warning' });
      return false;
    }
  }

  return { GRACE_MS, visibleWait, sessionTitle, restartEngine };
});
